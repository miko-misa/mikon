from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any

import httpx
import typer
import uvicorn

from mikon.server.app import create_app
from mikon.server.resources import ResourceMonitor
from mikon.server.settings import load_settings


app = typer.Typer(no_args_is_help=True)
dataset_app = typer.Typer(no_args_is_help=True)
app.add_typer(dataset_app, name="dataset")


@app.command()
def init(
    force: Annotated[bool, typer.Option("--force", help="Overwrite existing files.")] = False,
) -> None:
    root = Path.cwd()
    _write_template(root / "mikon.toml", MIKON_TOML, force)
    _write_template(root / "src" / "example.py", EXAMPLE_JOB, force)
    typer.echo("Initialized mikon project.")


@app.command()
def serve(
    host: Annotated[str, typer.Option()] = "127.0.0.1",
    port: Annotated[int, typer.Option()] = 8000,
    token: Annotated[str | None, typer.Option()] = None,
) -> None:
    if host not in {"127.0.0.1", "localhost"} and not token:
        raise typer.BadParameter("--token is required when binding outside localhost")
    uvicorn.run(create_app(token=token), host=host, port=port)


@app.command("run")
def run_job(
    job: str,
    gpu: Annotated[str, typer.Option("--gpu", help="Comma-separated unified GPU ids.")],
    config: Annotated[Path | None, typer.Option("--config", exists=True, dir_okay=False)] = None,
    set_values: Annotated[list[str] | None, typer.Option("--set", help="Override config value as key=value. Dotted keys are supported.")] = None,
    force: Annotated[bool, typer.Option("--force")] = False,
    server: Annotated[str, typer.Option("--server")] = "http://127.0.0.1:8000",
) -> None:
    config_data = _load_config(config, set_values)
    response = httpx.post(
        f"{server.rstrip('/')}/api/runs",
        json={"job": job, "config": config_data, "gpus": _split_csv(gpu), "force": force},
        timeout=30,
    )
    _raise_for_problem(response)
    typer.echo(response.text)


@app.command()
def stop(
    run_id: str,
    server: Annotated[str, typer.Option("--server")] = "http://127.0.0.1:8000",
) -> None:
    response = httpx.post(f"{server.rstrip('/')}/api/runs/{run_id}/stop", timeout=30)
    _raise_for_problem(response)
    typer.echo(response.text)


@app.command()
def doctor() -> None:
    settings = load_settings()
    diagnostics = ResourceMonitor(settings).diagnostics()
    typer.echo(diagnostics.model_dump_json(indent=2))


@dataset_app.command("register")
def dataset_register(
    name: str,
    path: Path,
    description: Annotated[str | None, typer.Option("--description")] = None,
    server: Annotated[str, typer.Option("--server")] = "http://127.0.0.1:8000",
) -> None:
    response = httpx.post(
        f"{server.rstrip('/')}/api/datasets",
        json={"name": name, "path": str(path), "description": description},
        timeout=30,
    )
    _raise_for_problem(response)
    typer.echo(response.text)


@dataset_app.command("build")
def dataset_build(
    name: str,
    config: Annotated[Path | None, typer.Option("--config", exists=True, dir_okay=False)] = None,
    set_values: Annotated[list[str] | None, typer.Option("--set", help="Override config value as key=value. Dotted keys are supported.")] = None,
    gpu: Annotated[str | None, typer.Option("--gpu", help="Comma-separated unified GPU ids.")] = None,
    force: Annotated[bool, typer.Option("--force")] = False,
    server: Annotated[str, typer.Option("--server")] = "http://127.0.0.1:8000",
) -> None:
    response = httpx.post(
        f"{server.rstrip('/')}/api/datasets/{name}/build",
        json={"config": _load_config(config, set_values), "gpus": _split_csv(gpu or ""), "force": force},
        timeout=30,
    )
    _raise_for_problem(response)
    typer.echo(response.text)


def _write_template(path: Path, content: str, force: bool) -> None:
    if path.exists() and not force:
        typer.echo(f"Skipped existing {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    typer.echo(f"Wrote {path}")


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _load_config(config: Path | None, set_values: list[str] | None) -> dict[str, Any]:
    config_data = json.loads(config.read_text(encoding="utf-8")) if config else {}
    if not isinstance(config_data, dict):
        raise typer.BadParameter("--config must contain a JSON object")
    for item in set_values or []:
        _apply_override(config_data, item)
    return config_data


def _apply_override(config: dict[str, Any], item: str) -> None:
    if "=" not in item:
        raise typer.BadParameter("--set values must use key=value")
    key, raw_value = item.split("=", 1)
    if not key:
        raise typer.BadParameter("--set key must not be empty")
    try:
        value: Any = json.loads(raw_value)
    except json.JSONDecodeError:
        value = raw_value
    target = config
    parts = key.split(".")
    for part in parts[:-1]:
        if not part:
            raise typer.BadParameter("--set dotted keys must not contain empty segments")
        existing = target.get(part)
        if existing is None:
            existing = {}
            target[part] = existing
        if not isinstance(existing, dict):
            raise typer.BadParameter(f"--set cannot assign nested key under non-object: {part}")
        target = existing
    if not parts[-1]:
        raise typer.BadParameter("--set key must not end with dot")
    target[parts[-1]] = value


def _raise_for_problem(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    try:
        problem = response.json()
        detail = problem.get("detail") or problem.get("title") or response.text
    except Exception:
        detail = response.text
    typer.echo(f"Request failed ({response.status_code}): {detail}", err=True)
    raise typer.Exit(1)


MIKON_TOML = """[mikon]
watch = ["src"]
store = ".mikon"

[gpu]
occupancy_mem_mb = 500
occupancy_util = 5

[modules]
max_nest_depth = 8

[docs]
root = "docs"
"""


EXAMPLE_JOB = '''import time
from typing import Literal

import mikon
from mikon import Config, RunContext
from pydantic import Field


class ExampleConfig(Config):
    lr: float = Field(1e-3, gt=0, le=1)
    epochs: int = Field(5, ge=1, le=100)
    optimizer: Literal["adam", "sgd"] = "adam"


@mikon.job
def example(config: ExampleConfig, ctx: RunContext) -> None:
    for epoch in range(config.epochs):
        loss = 1.0 / (epoch + 1)
        print(f"epoch={epoch} loss={loss}", flush=True)
        ctx.log_metric("loss", loss, step=epoch)
        time.sleep(0.5)

    artifact = ctx.artifacts_dir / "result.txt"
    artifact.write_text(f"optimizer={config.optimizer}\\n", encoding="utf-8")
    ctx.log_artifact("result.txt", artifact)
'''
