from __future__ import annotations

import argparse
import ast
import importlib
import importlib.util
import inspect
import json
import os
import subprocess
import sys
import textwrap
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from pydantic import ValidationError

from mikon.sdk.datasets import clear_dataset_registry, get_dataset_registry
from mikon.sdk.job import clear_registry, get_registry
from mikon.sdk.module import (
    ModuleValidationError,
    clear_module_registry,
    get_module_registry,
    interface_key,
    validate_module_nest_depth,
)
from mikon.server.schema import derive_ui_schema, schema_hash
from mikon.server.settings import Settings, load_settings

DISCOVERY_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class DiscoveryOutput:
    ok: bool
    jobs: dict[str, dict[str, Any]]
    modules: dict[str, dict[str, Any]]
    dataset_builders: dict[str, dict[str, Any]]
    error: str | None = None


def discover_subprocess(settings: Settings) -> DiscoveryOutput:
    _python = settings.python or sys.executable
    command = [
        _python,
        "-m",
        "mikon.server.discovery",
        "discover",
        "--project-root",
        str(settings.project_root),
    ]
    for watch_path in settings.watch:
        command.extend(["--watch", str(watch_path)])
    completed = _run_json_command(command, settings.project_root)
    if completed.get("ok"):
        return DiscoveryOutput(
            ok=True,
            jobs=completed["jobs"],
            modules=completed.get("modules", {}),
            dataset_builders=completed.get("dataset_builders", {}),
        )
    return DiscoveryOutput(ok=False, jobs={}, modules={}, dataset_builders={}, error=completed.get("error", "discovery failed"))


def validate_config_subprocess(
    settings: Settings, job_name: str, config: dict[str, Any]
) -> dict[str, Any]:
    _python = settings.python or sys.executable
    command = [
        _python,
        "-m",
        "mikon.server.discovery",
        "validate",
        "--project-root",
        str(settings.project_root),
        "--job",
        job_name,
        "--config-json",
        json.dumps(config),
    ]
    for watch_path in settings.watch:
        command.extend(["--watch", str(watch_path)])
    completed = _run_json_command(command, settings.project_root)
    if completed.get("ok"):
        return completed["config"]
    error_type = completed.get("type", "validation")
    if error_type == "job-not-found":
        from mikon.server.problems import ProblemException

        raise ProblemException(
            type="/problems/job-not-found",
            title="Job not found",
            status=404,
            detail=f"Unknown job: {job_name}",
            name=job_name,
        )
    if error_type == "config-validation":
        from mikon.server.problems import ProblemException

        raise ProblemException(
            type="/problems/config-validation-failed",
            title="Config validation failed",
            status=422,
            detail="Config does not match the job schema.",
            errors=completed.get("errors", []),
        )
    raise RuntimeError(completed.get("error", "config validation failed"))


def validate_dataset_config_subprocess(
    settings: Settings, dataset_name: str, config: dict[str, Any]
) -> dict[str, Any]:
    _python = settings.python or sys.executable
    command = [
        _python,
        "-m",
        "mikon.server.discovery",
        "validate-dataset",
        "--project-root",
        str(settings.project_root),
        "--dataset",
        dataset_name,
        "--config-json",
        json.dumps(config),
    ]
    for watch_path in settings.watch:
        command.extend(["--watch", str(watch_path)])
    completed = _run_json_command(command, settings.project_root)
    if completed.get("ok"):
        return completed["config"]
    error_type = completed.get("type", "validation")
    from mikon.server.problems import ProblemException

    if error_type == "dataset-builder-not-found":
        raise ProblemException(
            type="/problems/dataset-builder-not-found",
            title="Dataset builder not found",
            status=404,
            detail=f"Unknown dataset builder: {dataset_name}",
            name=dataset_name,
        )
    if error_type == "config-validation":
        raise ProblemException(
            type="/problems/config-validation-failed",
            title="Config validation failed",
            status=422,
            detail="Config does not match the dataset builder schema.",
            errors=completed.get("errors", []),
        )
    raise RuntimeError(completed.get("error", "dataset config validation failed"))


def import_project(project_root: Path, watch_paths: list[Path]) -> None:
    os.chdir(project_root)
    _prepend_sys_path(project_root)
    for watch_path in reversed(watch_paths):
        if watch_path.is_dir():
            _prepend_sys_path(watch_path)
            _prepend_sys_path(watch_path.parent)
    clear_registry()
    clear_module_registry()
    clear_dataset_registry()
    for path in _iter_python_files(watch_paths):
        module_name = _module_name_for_path(path, watch_paths)
        if module_name is not None:
            importlib.import_module(module_name)
        else:
            _import_file(path)


def discover_in_process(project_root: Path, watch_paths: list[Path]) -> dict[str, Any]:
    import_project(project_root, watch_paths)
    jobs: dict[str, Any] = {}
    for name, definition in get_registry().items():
        json_schema = definition.config_type.model_json_schema()
        jobs[name] = {
            "name": name,
            "doc": definition.doc,
            "source_file": str(Path(definition.source_file).resolve()),
            "lineno": definition.lineno,
            "schema_hash": schema_hash(json_schema),
            "json_schema": json_schema,
            "ui_schema": derive_ui_schema(json_schema),
            "output_artifacts": extract_output_artifacts(definition.func),
        }
    return jobs


def extract_output_artifacts(func: Callable[..., Any]) -> list[str]:
    """Best-effort static scan of a job for the artifact filenames it produces.

    Collects string literals from ``ctx.log_artifact("name", ...)`` calls and
    ``ctx.artifacts_dir / "name"`` expressions in the job's source. Dynamic names
    (f-strings, variables) cannot be resolved and are simply omitted; the UI
    keeps a free-text fallback for those.
    """
    try:
        source = textwrap.dedent(inspect.getsource(func))
        tree = ast.parse(source)
    except (OSError, TypeError, SyntaxError):
        return []

    names: set[str] = set()

    def literal(node: ast.AST | None) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        return None

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in {"log_artifact", "log_dir"}:
                found = literal(node.args[0]) if node.args else None
                if found is None:
                    for keyword in node.keywords:
                        if keyword.arg == "name":
                            found = literal(keyword.value)
                            break
                if found:
                    names.add(found)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            if isinstance(node.left, ast.Attribute) and node.left.attr == "artifacts_dir":
                found = literal(node.right)
                if found:
                    names.add(found)

    return sorted(names)


def discover_modules_in_process(project_root: Path, watch_paths: list[Path]) -> dict[str, Any]:
    modules: dict[str, Any] = {}
    for name, definition in get_module_registry().items():
        json_schema = definition.config_type.model_json_schema()
        modules[name] = {
            "name": name,
            "implements": interface_key(definition.implements),
            "doc": definition.doc,
            "source_file": str(Path(definition.source_file).resolve()),
            "lineno": definition.lineno,
            "schema_hash": schema_hash(json_schema),
            "json_schema": json_schema,
            "ui_schema": derive_ui_schema(json_schema),
        }
    return modules


def discover_dataset_builders_in_process(project_root: Path, watch_paths: list[Path]) -> dict[str, Any]:
    builders: dict[str, Any] = {}
    for name, definition in get_dataset_registry().items():
        json_schema = definition.config_type.model_json_schema()
        builders[name] = {
            "name": name,
            "doc": definition.doc,
            "source_file": str(Path(definition.source_file).resolve()),
            "lineno": definition.lineno,
            "schema_hash": schema_hash(json_schema),
            "json_schema": json_schema,
            "ui_schema": derive_ui_schema(json_schema),
        }
    return builders


def validate_in_process(
    project_root: Path, watch_paths: list[Path], job_name: str, config: dict[str, Any]
) -> dict[str, Any]:
    import_project(project_root, watch_paths)
    definition = get_registry().get(job_name)
    if definition is None:
        raise KeyError(job_name)
    settings = load_settings(project_root)
    validate_module_nest_depth(config, settings.max_module_nest_depth)
    model = definition.config_type.model_validate(config)
    resolved = model.model_dump(mode="json")
    validate_module_nest_depth(resolved, settings.max_module_nest_depth)
    return resolved


def validate_dataset_in_process(
    project_root: Path, watch_paths: list[Path], dataset_name: str, config: dict[str, Any]
) -> dict[str, Any]:
    import_project(project_root, watch_paths)
    definition = get_dataset_registry().get(dataset_name)
    if definition is None:
        raise KeyError(dataset_name)
    model = definition.config_type.model_validate(config)
    return model.model_dump(mode="json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    discover_parser = subparsers.add_parser("discover")
    discover_parser.add_argument("--project-root", required=True)
    discover_parser.add_argument("--watch", action="append", default=[])

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--project-root", required=True)
    validate_parser.add_argument("--watch", action="append", default=[])
    validate_parser.add_argument("--job", required=True)
    validate_parser.add_argument("--config-json", required=True)

    validate_dataset_parser = subparsers.add_parser("validate-dataset")
    validate_dataset_parser.add_argument("--project-root", required=True)
    validate_dataset_parser.add_argument("--watch", action="append", default=[])
    validate_dataset_parser.add_argument("--dataset", required=True)
    validate_dataset_parser.add_argument("--config-json", required=True)

    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    watch_paths = [Path(item).resolve() for item in args.watch] or [project_root / "src"]

    try:
        if args.command == "discover":
            jobs = discover_in_process(project_root, watch_paths)
            modules = discover_modules_in_process(project_root, watch_paths)
            dataset_builders = discover_dataset_builders_in_process(project_root, watch_paths)
            print(json.dumps({"ok": True, "jobs": jobs, "modules": modules, "dataset_builders": dataset_builders}, separators=(",", ":")))
        elif args.command == "validate":
            config = json.loads(args.config_json)
            resolved = validate_in_process(project_root, watch_paths, args.job, config)
            print(json.dumps({"ok": True, "config": resolved}, separators=(",", ":")))
        elif args.command == "validate-dataset":
            config = json.loads(args.config_json)
            resolved = validate_dataset_in_process(project_root, watch_paths, args.dataset, config)
            print(json.dumps({"ok": True, "config": resolved}, separators=(",", ":")))
    except ModuleValidationError as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "type": "config-validation",
                    "errors": [{"loc": [], "msg": str(exc), "type": "value_error"}],
                },
                separators=(",", ":"),
            )
        )
        return 1
    except KeyError as exc:
        error_type = "dataset-builder-not-found" if args.command == "validate-dataset" else "job-not-found"
        print(
            json.dumps(
                {"ok": False, "type": error_type, "error": str(exc)},
                separators=(",", ":"),
            )
        )
        return 1
    except ValidationError as exc:
        print(
            json.dumps(
                {"ok": False, "type": "config-validation", "errors": exc.errors()},
                separators=(",", ":"),
            )
        )
        return 1
    except Exception:
        print(
            json.dumps(
                {"ok": False, "type": "import", "error": traceback.format_exc()},
                separators=(",", ":"),
            )
        )
        return 1
    return 0


def _run_json_command(command: list[str], cwd: Path) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=DISCOVERY_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "type": "timeout",
            "error": f"discovery timed out after {DISCOVERY_TIMEOUT_SECONDS}s: {exc}",
        }
    stdout = completed.stdout.strip()
    if stdout:
        try:
            return json.loads(stdout.splitlines()[-1])
        except json.JSONDecodeError:
            pass
    return {
        "ok": False,
        "type": "subprocess",
        "error": completed.stderr or completed.stdout or f"exit code {completed.returncode}",
    }


def _iter_python_files(watch_paths: list[Path]) -> list[Path]:
    files: dict[Path, Path] = {}
    ignored_parts = {".git", ".mikon", ".venv", "venv", "__pycache__", "node_modules"}

    def add(path: Path) -> None:
        try:
            key = path.resolve()
        except OSError:
            return
        files.setdefault(key, path)

    for root in watch_paths:
        if root.is_file() and root.suffix == ".py":
            add(root)
            continue
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.py")):
            if ignored_parts.intersection(path.parts):
                continue
            add(path)
    return [files[key] for key in sorted(files, key=lambda item: item.as_posix())]


def _import_file(path: Path) -> None:
    module_name = "_mikon_discovered_" + str(abs(hash(path.resolve()))).replace("-", "_")
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)


def _module_name_for_path(path: Path, watch_paths: list[Path]) -> str | None:
    for root in watch_paths:
        if not root.is_dir():
            continue
        try:
            relative = path.resolve().relative_to(root.resolve())
        except ValueError:
            continue
        if relative.name == "__init__.py":
            if relative.parent == Path("."):
                return None
            parts = relative.parent.parts
        else:
            parts = relative.with_suffix("").parts
        if not all(part.isidentifier() for part in parts):
            return None
        return ".".join(parts)
    return None


def _prepend_sys_path(path: Path) -> None:
    value = str(path)
    if value not in sys.path:
        sys.path.insert(0, value)


if __name__ == "__main__":
    raise SystemExit(main())
