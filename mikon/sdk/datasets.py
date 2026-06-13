from __future__ import annotations

import inspect
import json
import os
import re
import tomllib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, get_type_hints

from mikon.sdk.config import Config


@dataclass(frozen=True)
class DatasetDefinition:
    name: str
    func: Callable[..., Any]
    config_type: type[Config]
    source_file: str
    lineno: int
    doc: str | None


_REGISTRY: dict[str, DatasetDefinition] = {}


class DatasetContext:
    """Runtime handle injected into mikon dataset builders."""

    def __init__(
        self,
        run_dir: str | os.PathLike[str] | None = None,
        dataset_name: str | None = None,
    ) -> None:
        raw_run_dir = run_dir or os.environ.get("MIKON_RUN_DIR")
        if not raw_run_dir:
            raise RuntimeError("DatasetContext requires run_dir or MIKON_RUN_DIR")
        self.run_dir = Path(raw_run_dir)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.dataset_name = _safe_name(dataset_name or os.environ.get("MIKON_DATASET_NAME") or "")
        self.staging_dir = self.run_dir / "staging"
        self.staging_dir.mkdir(parents=True, exist_ok=True)

    def add_dir(self, path: str | os.PathLike[str], description: str | None = None) -> Path:
        dataset_path = Path(path).expanduser().resolve()
        if not dataset_path.is_dir():
            raise FileNotFoundError(dataset_path)
        meta = _write_dataset_meta(
            self.dataset_name,
            dataset_path,
            description,
            source="builder",
            builder_run_id=self.run_dir.name,
        )
        with (self.run_dir / "outputs.jsonl").open("a", encoding="utf-8") as fp:
            fp.write(json.dumps({"t": datetime.now(UTC).timestamp(), "type": "produces-dataset", "dataset": meta["name"], "path": meta["path"]}, separators=(",", ":")) + "\n")
            fp.flush()
        return dataset_path


def dataset(func: Callable[..., Any] | None = None, *, name: str | None = None):
    """Mark a function as a mikon dataset builder."""

    def decorate(target: Callable[..., Any]) -> Callable[..., Any]:
        dataset_name = _safe_name(name or target.__name__)
        config_type = _extract_config_type(target)
        source_file = inspect.getsourcefile(target) or "<unknown>"
        try:
            _, lineno = inspect.getsourcelines(target)
        except OSError:
            lineno = 0
        definition = DatasetDefinition(
            name=dataset_name,
            func=target,
            config_type=config_type,
            source_file=source_file,
            lineno=lineno,
            doc=inspect.getdoc(target),
        )
        existing = _REGISTRY.get(dataset_name)
        if existing is not None and existing.func is not target:
            raise ValueError(f"duplicate mikon dataset name: {dataset_name}")
        _REGISTRY[dataset_name] = definition
        return target

    if func is None:
        return decorate
    return decorate(func)


def get_dataset_registry() -> dict[str, DatasetDefinition]:
    return dict(_REGISTRY)


def clear_dataset_registry() -> None:
    _REGISTRY.clear()


def register(name: str, path: str | os.PathLike[str], description: str | None = None) -> dict[str, Any]:
    dataset_name = _safe_name(name)
    dataset_path = Path(path).expanduser().resolve()
    if not dataset_path.exists():
        raise FileNotFoundError(dataset_path)
    return _write_dataset_meta(
        dataset_name,
        dataset_path,
        description,
        source="register",
        builder_run_id=None,
    )


def _extract_config_type(func: Callable[..., Any]) -> type[Config]:
    signature = inspect.signature(func)
    try:
        hints = get_type_hints(func)
    except Exception:
        hints = {}
    config_candidates: list[type[Config]] = []
    has_context = False
    for parameter in signature.parameters.values():
        annotation = hints.get(parameter.name, parameter.annotation)
        if annotation is inspect.Signature.empty:
            continue
        if isinstance(annotation, type) and issubclass(annotation, Config):
            config_candidates.append(annotation)
        if isinstance(annotation, type) and issubclass(annotation, DatasetContext):
            has_context = True
    if len(config_candidates) != 1:
        raise TypeError(f"mikon dataset {func.__name__!r} must declare exactly one Config parameter")
    if not has_context:
        raise TypeError(f"mikon dataset {func.__name__!r} must declare a DatasetContext parameter")
    return config_candidates[0]


def _write_dataset_meta(
    name: str,
    path: Path,
    description: str | None,
    *,
    source: str,
    builder_run_id: str | None,
) -> dict[str, Any]:
    meta = {
        "name": _safe_name(name),
        "description": description,
        "path": str(path.resolve()),
        "source": source,
        "builder_run_id": builder_run_id,
        "created_at": datetime.now(UTC).isoformat(),
    }
    target = _store_root() / "datasets" / meta["name"] / "meta.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(".json.tmp")
    temp.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temp, target)
    return meta


def _store_root() -> Path:
    if os.environ.get("MIKON_STORE"):
        return Path(os.environ["MIKON_STORE"]).expanduser().resolve()
    root = Path.cwd().resolve()
    config_path = root / "mikon.toml"
    if not config_path.exists():
        return root / ".mikon"
    data = tomllib.loads(config_path.read_text(encoding="utf-8"))
    store = data.get("mikon", {}).get("store", ".mikon")
    return (root / store).resolve()


def _safe_name(name: str) -> str:
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise ValueError("dataset name must contain only letters, digits, underscore, dot, and hyphen")
    return name
