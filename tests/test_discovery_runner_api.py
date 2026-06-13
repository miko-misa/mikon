from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from types import SimpleNamespace
from pathlib import Path

import pytest
import psutil
from fastapi.testclient import TestClient
from typer import BadParameter
from typer.testing import CliRunner

import mikon.server.discovery as discovery_module
import mikon.server.docs as docs_module
import mikon.server.runner as runner_module
from mikon.cli import _apply_override, app as cli_app
from mikon.server import resources as resources_module
from mikon.server.app import create_app
from mikon.server.api import _metric_stream
from mikon.server.discovery import _run_json_command, discover_subprocess
from mikon.server.models import RunStatus
from mikon.server.problems import ProblemException
from mikon.server.settings import load_settings
from mikon.server.store import Store


def make_project(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "mikon.toml").write_text(
        """
[mikon]
watch = ["src"]
store = ".mikon"

[gpu]
occupancy_mem_mb = 500
occupancy_util = 5
""",
        encoding="utf-8",
    )
    (tmp_path / "src" / "train.py").write_text(
        """
import mikon
from mikon import Config, RunContext
from pydantic import Field

class TrainConfig(Config):
    epochs: int = Field(2, ge=1, le=5)

@mikon.job
def train(config: TrainConfig, ctx: RunContext) -> None:
    for step in range(config.epochs):
        print(f"step={step}", flush=True)
        ctx.log_metric("loss", 1.0 / (step + 1), step=step)
    artifact = ctx.artifacts_dir / "done.txt"
    artifact.write_text("ok", encoding="utf-8")
    ctx.log_artifact("done.txt", artifact)
""",
        encoding="utf-8",
    )
    return tmp_path


def make_module_project(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "mikon.toml").write_text(
        """
[mikon]
watch = ["src"]
store = ".mikon"

[modules]
max_nest_depth = 8
""",
        encoding="utf-8",
    )
    (tmp_path / "src" / "train.py").write_text(
        """
from typing import Protocol, runtime_checkable

import mikon
from mikon import Config, RunContext
from pydantic import Field

@runtime_checkable
class Block(Protocol):
    def forward(self, value: int) -> int: ...

class BlockConfig(Config):
    width: int = Field(3, ge=1)

@mikon.module(implements=Block)
class Linear:
    def __init__(self, config: BlockConfig) -> None:
        self.config = config

    def forward(self, value: int) -> int:
        return value + self.config.width

class TrainConfig(Config):
    block: mikon.ModuleRef[Block]

@mikon.job
def train(config: TrainConfig, ctx: RunContext) -> None:
    ctx.log_metric("out", config.block.forward(2))
""",
        encoding="utf-8",
    )
    return tmp_path


def make_nested_module_project(tmp_path: Path, max_depth: int = 1) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "mikon.toml").write_text(
        f"""
[mikon]
watch = ["src"]
store = ".mikon"

[modules]
max_nest_depth = {max_depth}
""",
        encoding="utf-8",
    )
    (tmp_path / "src" / "train.py").write_text(
        """
from typing import Protocol

import mikon
from mikon import Config, RunContext

class Block(Protocol):
    def forward(self, value: int) -> int: ...

class InnerBlock(Protocol):
    def forward(self, value: int) -> int: ...

class LeafConfig(Config):
    bias: int = 1

@mikon.module(implements=InnerBlock)
class Leaf:
    def __init__(self, config: LeafConfig) -> None:
        self.config = config

    def forward(self, value: int) -> int:
        return value + self.config.bias

class OuterConfig(Config):
    inner: mikon.ModuleRef[InnerBlock]

@mikon.module(implements=Block)
class Outer:
    def __init__(self, config: OuterConfig) -> None:
        self.config = config

    def forward(self, value: int) -> int:
        return self.config.inner.forward(value)

class TrainConfig(Config):
    block: mikon.ModuleRef[Block]

@mikon.job
def train(config: TrainConfig, ctx: RunContext) -> None:
    ctx.log_metric("out", config.block.forward(1))
""",
        encoding="utf-8",
    )
    return tmp_path


def make_dataset_project(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "mikon.toml").write_text(
        """
[mikon]
watch = ["src"]
store = ".mikon"
""",
        encoding="utf-8",
    )
    (tmp_path / "src" / "datasets.py").write_text(
        """
import mikon
from mikon import Config, DatasetContext

class BuildConfig(Config):
    split: str = "train"

@mikon.dataset(name="mnist")
def build_mnist(config: BuildConfig, ctx: DatasetContext) -> None:
    out = ctx.staging_dir / config.split
    out.mkdir(parents=True, exist_ok=True)
    (out / "data.txt").write_text(config.split, encoding="utf-8")
    print(f"built {config.split}", flush=True)
    ctx.add_dir(out, description="digits")
""",
        encoding="utf-8",
    )
    return tmp_path


def nested_module_config() -> dict:
    return {
        "block": {
            "__module__": "Outer",
            "inner": {"__module__": "Leaf"},
        }
    }


def test_discovery_subprocess_finds_job(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    settings = load_settings(project)
    result = discover_subprocess(settings)
    assert result.ok, result.error
    assert result.jobs["train"]["schema_hash"]


def test_discovery_subprocess_finds_modules_and_module_ref_schema(tmp_path: Path) -> None:
    project = make_module_project(tmp_path)
    result = discover_subprocess(load_settings(project))

    assert result.ok, result.error
    assert result.modules["Linear"]["implements"].endswith(".Block")
    block_schema = result.jobs["train"]["json_schema"]["properties"]["block"]
    assert block_schema["oneOf"][0]["properties"]["__module__"]["const"] == "Linear"


def test_discovery_subprocess_finds_dataset_builders(tmp_path: Path) -> None:
    project = make_dataset_project(tmp_path)
    result = discover_subprocess(load_settings(project))

    assert result.ok, result.error
    assert result.dataset_builders["mnist"]["schema_hash"]
    assert "split" in result.dataset_builders["mnist"]["json_schema"]["properties"]


def test_discovery_imports_package_modules_with_relative_imports(tmp_path: Path) -> None:
    (tmp_path / "src" / "pkg").mkdir(parents=True)
    (tmp_path / "mikon.toml").write_text(
        """
[mikon]
watch = ["src"]
store = ".mikon"
""",
        encoding="utf-8",
    )
    (tmp_path / "src" / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (tmp_path / "src" / "pkg" / "helper.py").write_text("DEFAULT_EPOCHS = 3\n", encoding="utf-8")
    (tmp_path / "src" / "pkg" / "jobs.py").write_text(
        """
import mikon
from mikon import Config, RunContext
from pydantic import Field
from .helper import DEFAULT_EPOCHS

class TrainConfig(Config):
    epochs: int = Field(DEFAULT_EPOCHS, ge=1)

@mikon.job(name="packaged")
def train(config: TrainConfig, ctx: RunContext) -> None:
    ctx.log_metric("epochs", config.epochs)
""",
        encoding="utf-8",
    )
    result = discover_subprocess(load_settings(tmp_path))
    assert result.ok, result.error
    assert result.jobs["packaged"]["json_schema"]["properties"]["epochs"]["default"] == 3


def test_discovery_subprocess_timeout_reports_error(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(discovery_module, "DISCOVERY_TIMEOUT_SECONDS", 0.01)
    result = _run_json_command(
        ["python3", "-c", "import time; time.sleep(1)"],
        tmp_path,
    )
    assert result["ok"] is False
    assert result["type"] == "timeout"


def test_api_problem_json_for_missing_job(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)
    with TestClient(app) as client:
        response = client.get("/api/jobs/missing")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")


def test_jobs_endpoint_exposes_registry_stale_header(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)
    with TestClient(app) as client:
        app.state.registry.stale = True
        app.state.registry.error = "import failed"
        response = client.get("/api/jobs")
    assert response.status_code == 200
    assert response.headers["X-Registry-Stale"] == "1"
    assert response.headers["X-Registry-Error"] == "import failed"


def test_jobs_endpoint_returns_503_when_initial_registry_failed(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)
    with TestClient(app) as client:
        app.state.registry._jobs = {}
        app.state.registry._modules = {}
        app.state.registry._dataset_builders = {}
        app.state.registry.stale = False
        app.state.registry.error = "initial import failed"
        response = client.get("/api/jobs")

    assert response.status_code == 503
    assert response.json()["type"] == "/problems/registry-stale"


def test_missing_run_logs_and_artifacts_return_404(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)
    with TestClient(app) as client:
        logs = client.get("/api/runs/missing/logs")
        artifacts = client.get("/api/runs/missing/artifacts")
    assert logs.status_code == 404
    assert artifacts.status_code == 404


def test_docs_tree_returns_empty_when_root_is_missing(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs")

    assert response.status_code == 200
    assert response.json()["exists"] is False
    assert response.json()["nodes"] == []


def test_docs_tree_returns_empty_when_root_has_no_documents(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    (project / "docs").mkdir()
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs")

    assert response.status_code == 200
    assert response.json()["exists"] is True
    assert response.json()["nodes"] == []


def test_docs_tree_lists_nested_supported_documents_in_stable_order(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    (docs / "guide").mkdir(parents=True)
    (docs / "loop").symlink_to(docs, target_is_directory=True)
    (docs / ".hidden.md").write_text("# hidden", encoding="utf-8")
    (docs / "zeta.md").write_text("# Zeta", encoding="utf-8")
    (docs / "guide" / "intro.md").write_text("# Intro", encoding="utf-8")
    (docs / "guide" / "paper.typ").write_text("= Paper", encoding="utf-8")
    (docs / "notes.txt").write_text("ignore", encoding="utf-8")
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs")

    assert response.status_code == 200
    data = response.json()
    assert data["exists"] is True
    assert [node["path"] for node in data["nodes"]] == ["guide", "zeta.md"]
    assert "loop" not in [node["path"] for node in data["nodes"]]
    assert [node["path"] for node in data["nodes"][0]["children"]] == ["guide/intro.md", "guide/paper.typ"]
    assert data["nodes"][0]["children"][0]["format"] == "markdown"
    assert data["nodes"][0]["children"][1]["format"] == "typst"


def test_docs_rejects_path_traversal_hidden_unsupported_and_missing(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    docs.mkdir()
    (docs / ".hidden.md").write_text("# hidden", encoding="utf-8")
    (docs / "notes.txt").write_text("notes", encoding="utf-8")
    app = create_app(project_root=project)

    with TestClient(app) as client:
        traversal = client.get("/api/docs/%2E%2E/README.md")
        hidden = client.get("/api/docs/.hidden.md")
        unsupported = client.get("/api/docs/notes.txt")
        missing = client.get("/api/docs/missing.md")

    assert traversal.status_code == 404
    assert traversal.headers["content-type"].startswith("application/problem+json")
    assert hidden.status_code == 404
    assert unsupported.status_code == 415
    assert unsupported.json()["type"] == "/problems/doc-unsupported"
    assert missing.status_code == 404


def test_docs_rejects_oversized_documents(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    docs.mkdir()
    (docs / "huge.md").write_text("x" * (docs_module.MAX_DOC_BYTES + 1), encoding="utf-8")
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs/huge.md")

    assert response.status_code == 413
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == "/problems/doc-too-large"


def test_docs_asset_endpoint_serves_only_safe_supported_images(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    (docs / "images").mkdir(parents=True)
    (docs / "assets").mkdir()
    (docs / "README.md").write_text("# Root Readme", encoding="utf-8")
    (docs / "assets" / "guide.md").write_text("# Asset Guide", encoding="utf-8")
    (docs / "images" / "pic.png").write_bytes(b"\x89PNG\r\n")
    (docs / ".hidden.png").write_bytes(b"hidden")
    (docs / "notes.txt").write_text("notes", encoding="utf-8")
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"outside")
    (docs / "outside.png").symlink_to(outside)
    app = create_app(project_root=project)

    with TestClient(app) as client:
        ok = client.get("/api/docs/assets/images/pic.png")
        hidden = client.get("/api/docs/assets/.hidden.png")
        unsupported = client.get("/api/docs/assets/notes.txt")
        missing = client.get("/api/docs/assets/missing.png")
        symlink = client.get("/api/docs/assets/outside.png")
        asset_named_doc = client.get("/api/docs/assets/guide.md")
        root_doc_fallback = client.get("/api/docs/assets/README.md")

    assert ok.status_code == 200
    assert ok.headers["content-type"].startswith("image/png")
    assert ok.content == b"\x89PNG\r\n"
    assert hidden.status_code == 404
    assert unsupported.status_code == 415
    assert missing.status_code == 404
    assert symlink.status_code == 404
    assert asset_named_doc.status_code == 200
    assert asset_named_doc.json()["path"] == "assets/guide.md"
    assert root_doc_fallback.status_code == 200
    assert root_doc_fallback.json()["path"] == "README.md"


def test_docs_asset_endpoint_rejects_oversized_images(tmp_path: Path, monkeypatch) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    docs.mkdir()
    (docs / "large.png").write_bytes(b"x" * 12)
    monkeypatch.setattr(docs_module, "MAX_DOC_ASSET_BYTES", 8)
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs/assets/large.png")

    assert response.status_code == 413
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == "/problems/doc-too-large"


def test_docs_markdown_rendering_sanitizes_html_and_supports_tables_and_code(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    docs.mkdir()
    (docs / "readme.md").write_text(
        """
# Title

<script>alert("x")</script>

| a | b |
| - | - |
| 1 | 2 |

```python
print("ok")
```
""",
        encoding="utf-8",
    )
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs/readme.md")

    assert response.status_code == 200
    data = response.json()
    assert data["format"] == "markdown"
    assert data["rendered_kind"] == "html"
    assert "<script" not in data["content"]
    assert "<table>" in data["content"]
    assert "print" in data["content"]
    assert data["title"] == "Title"


def test_docs_markdown_rewrites_only_safe_relative_images(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    (docs / "guide" / "images").mkdir(parents=True)
    (docs / "guide" / "images" / "pic.png").write_bytes(b"png")
    (docs / "guide" / "readme.md").write_text(
        """
# Images

![Local](images/pic.png)
![External](https://example.com/pic.png)
![Data](data:image/png;base64,aaaa)
![Escape](../../outside.png)
<img src="https://example.com/raw.png" alt="raw">
""",
        encoding="utf-8",
    )
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs/guide/readme.md")

    assert response.status_code == 200
    content = response.json()["content"]
    assert "/api/docs/assets/guide/images/pic.png" in content
    assert "https://example.com" not in content
    assert "data:image" not in content
    assert "outside.png" not in content


def test_docs_typst_falls_back_to_source_when_cli_is_missing(tmp_path: Path, monkeypatch) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    docs.mkdir()
    (docs / "paper.typ").write_text("= Paper", encoding="utf-8")
    monkeypatch.setattr(docs_module.shutil, "which", lambda name: None)
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs/paper.typ")

    assert response.status_code == 200
    data = response.json()
    assert data["format"] == "typst"
    assert data["rendered_kind"] == "source"
    assert data["title"] == "Paper"
    assert data["content"] == "= Paper"
    assert "typst CLI" in data["diagnostics"][0]


def test_docs_typst_uses_cli_when_available(tmp_path: Path, monkeypatch) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    docs.mkdir()
    (docs / "paper.typ").write_text("= Paper", encoding="utf-8")
    fake_typst = tmp_path / "typst"
    fake_typst.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        "pathlib.Path(sys.argv[-1]).write_text('<svg><text>ok</text></svg>', encoding='utf-8')\n",
        encoding="utf-8",
    )
    fake_typst.chmod(0o755)
    monkeypatch.setattr(docs_module.shutil, "which", lambda name: str(fake_typst))
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs/paper.typ")

    assert response.status_code == 200
    data = response.json()
    assert data["rendered_kind"] == "svg"
    assert "<svg>" in data["content"]
    assert data["diagnostics"] == []


def test_docs_typst_large_svg_output_falls_back_to_source(tmp_path: Path, monkeypatch) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    docs.mkdir()
    (docs / "paper.typ").write_text("= Paper", encoding="utf-8")
    fake_typst = tmp_path / "typst"
    fake_typst.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        "pathlib.Path(sys.argv[-1]).write_text('<svg>too big</svg>', encoding='utf-8')\n",
        encoding="utf-8",
    )
    fake_typst.chmod(0o755)
    monkeypatch.setattr(docs_module.shutil, "which", lambda name: str(fake_typst))
    monkeypatch.setattr(docs_module, "MAX_TYPST_SVG_BYTES", 8)
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs/paper.typ")

    assert response.status_code == 200
    data = response.json()
    assert data["rendered_kind"] == "source"
    assert data["content"] == "= Paper"
    assert "exceeded" in data["diagnostics"][0]


def test_docs_typst_timeout_falls_back_to_source(tmp_path: Path, monkeypatch) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    docs.mkdir()
    (docs / "paper.typ").write_text("= Paper", encoding="utf-8")

    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr(docs_module.shutil, "which", lambda name: "/usr/bin/typst")
    monkeypatch.setattr(docs_module.subprocess, "run", fake_run)
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs/paper.typ")

    assert response.status_code == 200
    data = response.json()
    assert data["rendered_kind"] == "source"
    assert data["content"] == "= Paper"
    assert "timed out" in data["diagnostics"][0]


def test_docs_typst_failure_falls_back_to_source(tmp_path: Path, monkeypatch) -> None:
    project = make_project(tmp_path)
    docs = project / "docs"
    docs.mkdir()
    (docs / "paper.typ").write_text("= Paper", encoding="utf-8")
    fake_typst = tmp_path / "typst"
    fake_typst.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "sys.stderr.write('bad typst')\n"
        "raise SystemExit(2)\n",
        encoding="utf-8",
    )
    fake_typst.chmod(0o755)
    monkeypatch.setattr(docs_module.shutil, "which", lambda name: str(fake_typst))
    app = create_app(project_root=project)

    with TestClient(app) as client:
        response = client.get("/api/docs/paper.typ")

    assert response.status_code == 200
    data = response.json()
    assert data["rendered_kind"] == "source"
    assert data["content"] == "= Paper"
    assert data["diagnostics"] == ["bad typst"]


def test_runner_detached_run_lifecycle_without_gpu_backend(tmp_path: Path, monkeypatch) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)
    with TestClient(app) as client:
        class FakeResources:
            def snapshot(self):
                from datetime import UTC, datetime

                from mikon.server.models import GpuInfo, MachineInfo, ResourceSnapshot

                return ResourceSnapshot(
                    t=datetime.now(UTC),
                    gpu_available=True,
                    gpus=[
                        GpuInfo(
                            id="nvidia:0",
                            vendor="nvidia",
                            index=0,
                            name="fake",
                            util_pct=0,
                            mem_used_mib=0,
                            mem_total_mib=1000,
                            occupied=False,
                            processes=[],
                        )
                    ],
                    machine=MachineInfo(
                        cpu_pct=0,
                        cpu_count=1,
                        mem_used_mib=1,
                        mem_total_mib=2,
                        disk_used_gb=1,
                        disk_total_gb=2,
                    ),
                )

            def diagnostics(self):
                raise AssertionError("not used")

        app.state.resources = FakeResources()
        app.state.runner.resources = app.state.resources
        response = client.post(
            "/api/runs",
            json={"job": "train", "config": {"epochs": 2}, "gpus": ["nvidia:0"]},
        )
        assert response.status_code == 201, response.text
        run_id = response.json()["run_id"]

        deadline = time.time() + 10
        detail = None
        while time.time() < deadline:
            detail_response = client.get(f"/api/runs/{run_id}")
            detail = detail_response.json()
            if detail["status"] in {"completed", "failed"}:
                break
            time.sleep(0.2)
        assert detail is not None
        assert detail["status"] == "completed", detail
        metrics = client.get(f"/api/runs/{run_id}/metrics?since=-1").json()
        assert [record["name"] for record in metrics["records"]] == ["loss", "loss"]
        artifacts = client.get(f"/api/runs/{run_id}/artifacts").json()
        assert artifacts[0]["path"] == "done.txt"


def test_module_api_and_runner_instantiates_module_ref(tmp_path: Path) -> None:
    project = make_module_project(tmp_path)
    app = create_app(project_root=project)
    with TestClient(app) as client:
        class FakeResources:
            def snapshot(self):
                from datetime import UTC, datetime

                from mikon.server.models import GpuInfo, MachineInfo, ResourceSnapshot

                return ResourceSnapshot(
                    t=datetime.now(UTC),
                    gpu_available=True,
                    gpus=[
                        GpuInfo(
                            id="nvidia:0",
                            vendor="nvidia",
                            index=0,
                            name="fake",
                            util_pct=0,
                            mem_used_mib=0,
                            mem_total_mib=1000,
                            occupied=False,
                            processes=[],
                        )
                    ],
                    machine=MachineInfo(
                        cpu_pct=0,
                        cpu_count=1,
                        mem_used_mib=1,
                        mem_total_mib=2,
                        disk_used_gb=1,
                        disk_total_gb=2,
                    ),
                )

            def diagnostics(self):
                raise AssertionError("not used")

        app.state.resources = FakeResources()
        app.state.runner.resources = app.state.resources
        modules = client.get("/api/modules").json()
        response = client.post(
            "/api/runs",
            json={"job": "train", "config": {"block": {"__module__": "Linear"}}, "gpus": ["nvidia:0"]},
        )
        assert response.status_code == 201, response.text
        run_id = response.json()["run_id"]

        deadline = time.time() + 10
        detail = None
        while time.time() < deadline:
            detail = client.get(f"/api/runs/{run_id}").json()
            if detail["status"] in {"completed", "failed"}:
                break
            time.sleep(0.2)
        metrics = client.get(f"/api/runs/{run_id}/metrics?since=-1").json()

    assert modules[0]["name"] == "Linear"
    assert detail is not None
    assert detail["status"] == "completed", detail
    assert metrics["records"][0]["value"] == 5.0


def test_dataset_builder_api_runs_cpu_only_and_records_lineage(tmp_path: Path) -> None:
    project = make_dataset_project(tmp_path)
    app = create_app(project_root=project)
    with TestClient(app) as client:
        builders = client.get("/api/dataset-builders").json()
        detail_response = client.get("/api/dataset-builders/mnist")
        response = client.post(
            "/api/datasets/mnist/build",
            json={"config": {"split": "valid"}},
        )
        assert response.status_code == 201, response.text
        run_id = response.json()["run_id"]

        deadline = time.time() + 10
        detail = None
        while time.time() < deadline:
            detail = client.get(f"/api/runs/{run_id}").json()
            if detail["status"] in {"completed", "failed"}:
                break
            time.sleep(0.2)
        dataset = client.get("/api/datasets/mnist").json()
        lineage = client.get(f"/api/runs/{run_id}/lineage?direction=both&depth=2").json()

    assert builders[0]["name"] == "mnist"
    assert detail_response.status_code == 200
    assert detail is not None
    assert detail["kind"] == "dataset"
    assert detail["status"] == "completed", detail
    assert dataset["source"] == "builder"
    assert dataset["builder_run_id"] == run_id
    assert {node["id"] for node in lineage["nodes"]} >= {f"run:{run_id}", "dataset:mnist"}
    assert ("run:" + run_id, "dataset:mnist", "produces-dataset") in {
        (edge["src"], edge["dst"], edge["type"]) for edge in lineage["edges"]
    }
    events = [json.loads(line) for line in (project / ".mikon" / "runs" / run_id / "logs" / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    assert events[0]["stream"] == "stdout"
    assert events[0]["line"] == "built valid"


def test_normal_job_still_requires_gpu_selection(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)
    with TestClient(app) as client:
        response = client.post("/api/runs", json={"job": "train", "config": {"epochs": 1}, "gpus": []})

    assert response.status_code == 422


def test_gpu_occupied_and_mixed_vendor_errors(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)

    class FakeResources:
        def snapshot(self):
            from datetime import UTC, datetime

            from mikon.server.models import GpuInfo, GpuProcess, MachineInfo, ResourceSnapshot

            return ResourceSnapshot(
                t=datetime.now(UTC),
                gpu_available=True,
                gpus=[
                    GpuInfo(
                        id="nvidia:0",
                        vendor="nvidia",
                        index=0,
                        name="fake-nvidia",
                        util_pct=99,
                        mem_used_mib=900,
                        mem_total_mib=1000,
                        occupied=True,
                        processes=[GpuProcess(pid=123, user="alice", name="python", used_mib=900, owned_by_mikon=False)],
                    ),
                    GpuInfo(
                        id="amd:0",
                        vendor="amd",
                        index=0,
                        name="fake-amd",
                        util_pct=0,
                        mem_used_mib=0,
                        mem_total_mib=1000,
                        occupied=False,
                        processes=[],
                    ),
                ],
                machine=MachineInfo(
                    cpu_pct=0,
                    cpu_count=1,
                    mem_used_mib=1,
                    mem_total_mib=2,
                    disk_used_gb=1,
                    disk_total_gb=2,
                ),
            )

    with TestClient(app) as client:
        app.state.resources = FakeResources()
        app.state.runner.resources = app.state.resources
        occupied = client.post(
            "/api/runs",
            json={"job": "train", "config": {"epochs": 1}, "gpus": ["nvidia:0"]},
        )
        mixed = client.post(
            "/api/runs",
            json={"job": "train", "config": {"epochs": 1}, "gpus": ["nvidia:0", "amd:0"], "force": True},
        )

    assert occupied.status_code == 409
    assert occupied.json()["type"] == "/problems/gpu-occupied"
    assert mixed.status_code == 422
    assert mixed.json()["type"] == "/problems/gpus-mixed-vendor"


def test_create_run_rejects_module_depth_before_run_dir(tmp_path: Path) -> None:
    project = make_nested_module_project(tmp_path, max_depth=1)
    app = create_app(project_root=project)

    class FakeResources:
        def snapshot(self):
            from datetime import UTC, datetime

            from mikon.server.models import GpuInfo, MachineInfo, ResourceSnapshot

            return ResourceSnapshot(
                t=datetime.now(UTC),
                gpu_available=True,
                gpus=[
                    GpuInfo(
                        id="nvidia:0",
                        vendor="nvidia",
                        index=0,
                        name="fake",
                        util_pct=0,
                        mem_used_mib=0,
                        mem_total_mib=1000,
                        occupied=False,
                        processes=[],
                    )
                ],
                machine=MachineInfo(
                    cpu_pct=0,
                    cpu_count=1,
                    mem_used_mib=1,
                    mem_total_mib=2,
                    disk_used_gb=1,
                    disk_total_gb=2,
                ),
            )

    with TestClient(app) as client:
        app.state.resources = FakeResources()
        app.state.runner.resources = app.state.resources
        response = client.post(
            "/api/runs",
            json={"job": "train", "config": nested_module_config(), "gpus": ["nvidia:0"]},
        )

    assert response.status_code == 422
    assert [path for path in (project / ".mikon" / "runs").iterdir()] == []


def test_runner_records_failed_status_for_module_depth_violation(tmp_path: Path) -> None:
    project = make_nested_module_project(tmp_path, max_depth=1)
    settings = load_settings(project)
    store = Store(settings.store)
    run_dir = store.create_run(
        run_id="too-deep",
        job="train",
        config=nested_module_config(),
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=project,
        watch=list(settings.watch),
    )

    completed = subprocess.run(
        [sys.executable, "-m", "mikon._runner", "--run-dir", str(run_dir)],
        cwd=project,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    status = store.read_json(run_dir / "status.json")

    assert completed.returncode == 1
    assert status["status"] == "failed"
    assert "module nesting exceeds max depth 1" in status["error"]


def test_run_list_is_created_at_descending(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    _write_manual_run(store, "z_run", "2026-01-01T00:00:00+00:00", pid=123)
    _write_manual_run(store, "a_run", "2026-01-02T00:00:00+00:00", pid=123)

    assert [run.run_id for run in store.list_runs()] == ["a_run", "z_run"]


def test_pid_none_without_status_is_unknown(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    _write_manual_run(store, "pending", "2026-01-01T00:00:00+00:00", pid=None)

    assert store.get_run("pending").status == RunStatus.unknown


def test_stale_heartbeat_marks_running_run_unknown(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    run_dir = store.create_run(
        run_id="run1",
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    store.attach_process("run1", os.getpid(), psutil.Process(os.getpid()).create_time())
    heartbeat = run_dir / "heartbeat"
    heartbeat.write_text("old", encoding="utf-8")
    old = time.time() - 60
    os.utime(heartbeat, (old, old))

    detail = store.get_run("run1")

    assert detail.status == RunStatus.unknown
    assert detail.error == "Heartbeat is stale."


def test_runner_records_failed_status_when_process_start_fails(tmp_path: Path, monkeypatch) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)

    class FakeResources:
        def snapshot(self):
            from datetime import UTC, datetime

            from mikon.server.models import GpuInfo, MachineInfo, ResourceSnapshot

            return ResourceSnapshot(
                t=datetime.now(UTC),
                gpu_available=True,
                gpus=[
                    GpuInfo(
                        id="nvidia:0",
                        vendor="nvidia",
                        index=0,
                        name="fake",
                        util_pct=0,
                        mem_used_mib=0,
                        mem_total_mib=1000,
                        occupied=False,
                        processes=[],
                    )
                ],
                machine=MachineInfo(
                    cpu_pct=0,
                    cpu_count=1,
                    mem_used_mib=1,
                    mem_total_mib=2,
                    disk_used_gb=1,
                    disk_total_gb=2,
                ),
            )

    class FailingSubprocess:
        @staticmethod
        def Popen(*args, **kwargs):
            raise OSError("boom")

    with TestClient(app) as client:
        app.state.resources = FakeResources()
        app.state.runner.resources = app.state.resources
        monkeypatch.setattr(runner_module, "subprocess", FailingSubprocess)
        response = client.post(
            "/api/runs",
            json={"job": "train", "config": {"epochs": 2}, "gpus": ["nvidia:0"], "save_config_as": "failed-start"},
        )

    assert response.status_code == 500
    run_id = response.json()["run_id"]
    status = json.loads((project / ".mikon" / "runs" / run_id / "status.json").read_text())
    assert status["status"] == "failed"
    assert status["error"] == "boom"
    assert not (project / ".mikon" / "configs" / "failed-start.json").exists()


def test_log_records_use_per_stream_stable_cursor(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    run_dir = store.create_run(
        run_id="logs",
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    (run_dir / "logs" / "stdout.log").write_text("out1\nout2\n", encoding="utf-8")
    (run_dir / "logs" / "stderr.log").write_text("err1\nerr2\n", encoding="utf-8")

    stdout = store.log_records("logs", stream="stdout", since=0)
    stderr = store.log_records("logs", stream="stderr", since=0)
    assert [(record.idx, record.line) for record in stdout] == [(1, "out2")]
    assert [(record.idx, record.line) for record in stderr] == [(1, "err2")]


def test_annotations_group_crud_and_run_filtering(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)
    store = app.state.store
    _write_manual_run(store, "run-a", "2026-01-01T00:00:00+00:00", pid=123)
    _write_manual_run(store, "run-b", "2026-01-02T00:00:00+00:00", pid=123)

    with TestClient(app) as client:
        group = client.post("/api/groups", json={"name": "sweep", "description": "lr"}).json()
        patched = client.patch(
            "/api/runs/run-a",
            json={
                "title": "best",
                "memo": "good run",
                "tags": ["baseline", "fast"],
                "star": True,
                "group_ids": [group["id"]],
            },
        )
        assert patched.status_code == 200, patched.text
        filtered = client.get(f"/api/runs?tag=baseline&star=true&group={group['id']}").json()
        group_runs = client.get(f"/api/groups/{group['id']}/runs").json()
        cleared = client.patch(
            "/api/runs/run-a",
            json={"title": None, "memo": None},
        ).json()
        updated = client.patch(f"/api/groups/{group['id']}", json={"description": "updated"}).json()
        deleted = client.delete(f"/api/groups/{group['id']}")

    assert filtered[0]["run_id"] == "run-a"
    assert group_runs[0]["run_id"] == "run-a"
    assert cleared["annotations"]["title"] is None
    assert cleared["annotations"]["memo"] is None
    assert cleared["annotations"]["tags"] == ["baseline", "fast"]
    assert updated["description"] == "updated"
    assert deleted.status_code == 204
    assert store.get_run("run-a").annotations.group_ids == []


def test_config_save_diff_delete_and_conflict(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)
    with TestClient(app) as client:
        schema_hash = client.get("/api/jobs/train").json()["schema_hash"]
        saved = client.put(
            "/api/configs/base",
            json={"job": "train", "values": {"epochs": 3}, "schema_hash": "client-supplied-wrong-hash"},
        )
        listed = client.get("/api/configs").json()
        diff = client.post("/api/configs/base/diff", json={"job": "train"}).json()
        conflict = client.put(
            "/api/configs/base",
            json={"job": "other", "values": {"epochs": 3}, "schema_hash": schema_hash},
        )
        invalid = client.put(
            "/api/configs/invalid",
            json={"job": "train", "values": {"epochs": 99}},
        )
        deleted = client.delete("/api/configs/base")

    assert saved.status_code == 200, saved.text
    assert saved.json()["schema_hash"] == schema_hash
    assert saved.json()["values"] == {"epochs": 3}
    assert listed[0]["name"] == "base"
    assert diff["compatible"] is True
    assert diff["changes"] == []
    assert conflict.status_code == 409
    assert invalid.status_code == 422
    assert deleted.status_code == 204


def test_config_diff_reports_added_removed_and_constraint_changes(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    store.save_config("old", "train", {"epochs": 10, "removed": 1}, "oldhash")
    diff = store.diff_config(
        "old",
        {
            "properties": {
                "epochs": {"type": "integer", "maximum": 5},
                "lr": {"type": "number", "default": 0.1},
            }
        },
        "newhash",
    )

    assert diff.compatible is False
    assert diff.migrated_values == {"epochs": 10, "lr": 0.1}
    assert {(change.field, change.kind) for change in diff.changes} >= {
        ("lr", "added"),
        ("removed", "removed"),
        ("epochs", "constraint_changed"),
    }


def test_create_run_can_save_annotations_and_config(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)

    class FakeResources:
        def snapshot(self):
            from datetime import UTC, datetime

            from mikon.server.models import GpuInfo, MachineInfo, ResourceSnapshot

            return ResourceSnapshot(
                t=datetime.now(UTC),
                gpu_available=True,
                gpus=[
                    GpuInfo(
                        id="nvidia:0",
                        vendor="nvidia",
                        index=0,
                        name="fake",
                        util_pct=0,
                        mem_used_mib=0,
                        mem_total_mib=1000,
                        occupied=False,
                        processes=[],
                    )
                ],
                machine=MachineInfo(
                    cpu_pct=0,
                    cpu_count=1,
                    mem_used_mib=1,
                    mem_total_mib=2,
                    disk_used_gb=1,
                    disk_total_gb=2,
                ),
            )

    with TestClient(app) as client:
        app.state.resources = FakeResources()
        app.state.runner.resources = app.state.resources
        response = client.post(
            "/api/runs",
            json={
                "job": "train",
                "config": {"epochs": 1},
                "gpus": ["nvidia:0"],
                "annotations": {"title": "one", "memo": "", "tags": ["smoke"], "star": True, "group_ids": []},
                "save_config_as": "smoke",
            },
        )
        run_id = response.json()["run_id"]

        deadline = time.time() + 10
        while time.time() < deadline:
            detail = client.get(f"/api/runs/{run_id}").json()
            if detail["status"] in {"completed", "failed"}:
                break
            time.sleep(0.2)
        config = client.get("/api/configs/smoke").json()
        saved_from_run = client.put(
            "/api/configs/from-run",
            json={"job": detail["job"], "values": detail["config"], "schema_hash": detail["config_hash"]},
        )
        from_run_diff = client.post("/api/configs/from-run/diff", json={"job": detail["job"]}).json()

    assert detail["annotations"]["title"] == "one"
    assert detail["annotations"]["star"] is True
    assert detail["schema_hash"] == config["schema_hash"]
    assert config["values"] == {"epochs": 1}
    assert saved_from_run.status_code == 200
    assert saved_from_run.json()["schema_hash"] == detail["schema_hash"]
    assert from_run_diff["changes"] == []


def test_create_run_with_invalid_annotation_group_leaves_no_run_dir(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    app = create_app(project_root=project)

    class FakeResources:
        def snapshot(self):
            from datetime import UTC, datetime

            from mikon.server.models import GpuInfo, MachineInfo, ResourceSnapshot

            return ResourceSnapshot(
                t=datetime.now(UTC),
                gpu_available=True,
                gpus=[
                    GpuInfo(
                        id="nvidia:0",
                        vendor="nvidia",
                        index=0,
                        name="fake",
                        util_pct=0,
                        mem_used_mib=0,
                        mem_total_mib=1000,
                        occupied=False,
                        processes=[],
                    )
                ],
                machine=MachineInfo(
                    cpu_pct=0,
                    cpu_count=1,
                    mem_used_mib=1,
                    mem_total_mib=2,
                    disk_used_gb=1,
                    disk_total_gb=2,
                ),
            )

    with TestClient(app) as client:
        app.state.resources = FakeResources()
        app.state.runner.resources = app.state.resources
        response = client.post(
            "/api/runs",
            json={
                "job": "train",
                "config": {"epochs": 1},
                "gpus": ["nvidia:0"],
                "annotations": {"title": "bad", "memo": None, "tags": [], "star": False, "group_ids": ["missing"]},
            },
        )

    assert response.status_code == 404
    assert [path for path in (project / ".mikon" / "runs").iterdir()] == []


def test_dataset_api_registers_lists_and_deletes_metadata(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    data_dir = project / "data"
    data_dir.mkdir()
    app = create_app(project_root=project)

    with TestClient(app) as client:
        invalid = client.post("/api/datasets", json={"name": "missing", "path": str(project / "missing")})
        created = client.post("/api/datasets", json={"name": "mnist", "path": str(data_dir), "description": "digits"})
        listed = client.get("/api/datasets").json()
        fetched = client.get("/api/datasets/mnist").json()
        deleted = client.delete("/api/datasets/mnist")
        missing = client.get("/api/datasets/mnist")

    assert invalid.status_code == 422
    assert created.status_code == 201, created.text
    assert created.json()["path"] == str(data_dir.resolve())
    assert listed[0]["name"] == "mnist"
    assert fetched["description"] == "digits"
    assert deleted.status_code == 204
    assert missing.status_code == 404


def test_amd_backend_uses_amdsmi_process_information(tmp_path: Path, monkeypatch) -> None:
    project = make_project(tmp_path)
    settings = load_settings(project)

    fake_amdsmi = SimpleNamespace(
        amdsmi_init=lambda: None,
        amdsmi_shut_down=lambda: None,
        amdsmi_get_processor_handles=lambda: ["handle0"],
        amdsmi_get_gpu_asic_info=lambda handle: {"market_name": "MI250"},
        amdsmi_get_gpu_activity=lambda handle: {"gfx_activity": 12},
        amdsmi_get_gpu_vram_usage=lambda handle: {"vram_used": 2 * 1024 * 1024, "vram_total": 16 * 1024 * 1024},
        amdsmi_get_gpu_process_list=lambda handle: [{"pid": 42, "used_memory": 512, "name": "python"}],
    )
    monkeypatch.setitem(sys.modules, "amdsmi", fake_amdsmi)

    gpus = resources_module.AmdBackend(settings).gpus({42: "run-42"})

    assert gpus[0].id == "amd:0"
    assert gpus[0].name == "MI250"
    assert gpus[0].processes[0].pid == 42
    assert gpus[0].processes[0].owned_by_mikon is True
    assert gpus[0].processes[0].run_id == "run-42"


def test_amd_backend_cli_process_fallback(tmp_path: Path, monkeypatch) -> None:
    project = make_project(tmp_path)
    settings = load_settings(project)
    monkeypatch.setattr(resources_module.AmdBackend, "_amdsmi_gpus", lambda self, pid_run_map: (_ for _ in ()).throw(RuntimeError("no amdsmi")))
    monkeypatch.setattr(resources_module.shutil, "which", lambda name: "/usr/bin/amd-smi" if name == "amd-smi" else None)

    class Completed:
        def __init__(self, stdout: str) -> None:
            self.returncode = 0
            self.stdout = stdout
            self.stderr = ""

    def fake_run(command, check, text, stdout, stderr):
        if command[1] == "process":
            return Completed('{"GPU 0":{"processes":[{"pid":99,"VRAM_MEM":"256 MB","name":"worker"}]}}')
        return Completed('{"card0":{"GPU use (%)":"3","GPU Memory Allocated (VRAM%)":"20","Card series":"Radeon"}}')

    monkeypatch.setattr(resources_module.subprocess, "run", fake_run)

    gpus = resources_module.AmdBackend(settings).gpus({99: "run-99"})

    assert gpus[0].id == "amd:0"
    assert gpus[0].processes[0].pid == 99
    assert gpus[0].processes[0].used_mib == 256
    assert gpus[0].processes[0].run_id == "run-99"


def test_cli_set_overrides_and_dataset_commands(monkeypatch, tmp_path: Path) -> None:
    calls: list[tuple[str, dict]] = []

    class FakeResponse:
        status_code = 200
        text = '{"ok": true}'

    def fake_post(url: str, json: dict, timeout: int):
        calls.append((url, json))
        return FakeResponse()

    monkeypatch.setattr("mikon.cli.httpx.post", fake_post)
    runner = CliRunner()
    config = tmp_path / "config.json"
    config.write_text('{"lr": 0.1, "model": {"depth": 18}}', encoding="utf-8")

    run_result = runner.invoke(
        cli_app,
        ["run", "train", "--gpu", "nvidia:0", "--config", str(config), "--set", "lr=0.01", "--set", "model.depth=50", "--set", "name=adam"],
    )
    register_result = runner.invoke(
        cli_app,
        ["dataset", "register", "mnist", str(tmp_path), "--description", "digits"],
    )
    build_result = runner.invoke(
        cli_app,
        ["dataset", "build", "mnist", "--set", "split=\"valid\"", "--gpu", "nvidia:0"],
    )

    assert run_result.exit_code == 0, run_result.output
    assert register_result.exit_code == 0, register_result.output
    assert build_result.exit_code == 0, build_result.output
    assert calls[0][1]["config"] == {"lr": 0.01, "model": {"depth": 50}, "name": "adam"}
    assert calls[1][1] == {"name": "mnist", "path": str(tmp_path), "description": "digits"}
    assert calls[2][1] == {"config": {"split": "valid"}, "gpus": ["nvidia:0"], "force": False}


def test_cli_apply_override_parses_json_and_rejects_invalid_paths() -> None:
    config = {"model": {"depth": 18}, "name": "sgd"}

    _apply_override(config, "lr=0.01")
    _apply_override(config, "model.enabled=true")
    _apply_override(config, "model.name=resnet")

    assert config == {
        "model": {"depth": 18, "enabled": True, "name": "resnet"},
        "name": "sgd",
        "lr": 0.01,
    }

    with pytest.raises(BadParameter):
        _apply_override(config, "missing-equals")
    with pytest.raises(BadParameter):
        _apply_override(config, ".bad=1")
    with pytest.raises(BadParameter):
        _apply_override(config, "bad.=1")
    with pytest.raises(BadParameter):
        _apply_override(config, "name.first=adam")


def test_discovery_iter_python_files_deduplicates_nested_watch_paths(tmp_path: Path) -> None:
    src = tmp_path / "src"
    nested = src / "pkg"
    nested.mkdir(parents=True)
    root_file = src / "train.py"
    nested_file = nested / "jobs.py"
    root_file.write_text("", encoding="utf-8")
    nested_file.write_text("", encoding="utf-8")

    files = discovery_module._iter_python_files([src, nested, nested_file])

    assert files == [nested_file, root_file]


def test_init_template_includes_modules_and_docs_sections(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(cli_app, ["init"])

    assert result.exit_code == 0, result.output
    text = (tmp_path / "mikon.toml").read_text(encoding="utf-8")
    assert "[modules]" in text
    assert "max_nest_depth = 8" in text
    assert "[docs]" in text
    assert 'root = "docs"' in text


def test_lineage_includes_dataset_artifact_module_and_manual_edges(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    store.register_dataset("mnist", data_dir, "digits")
    source = store.create_run(
        run_id="source",
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    consumer = store.create_run(
        run_id="consumer",
        job="train",
        config={"block": {"__module__": "Linear", "width": 3}},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    (source / "artifacts" / "model.pt").write_text("weights", encoding="utf-8")
    (consumer / "inputs.jsonl").write_text(
        '{"type":"uses-dataset","dataset":"mnist","path":"/data/mnist"}\n'
        '{"type":"consumes-artifact","run_id":"source","artifact":"model.pt","path":"/tmp/model.pt"}\n',
        encoding="utf-8",
    )
    with pytest.raises(ProblemException) as invalid_link:
        store.create_manual_link("bad", "run:consumer", "invalid")
    assert invalid_link.value.status == 422
    link = store.create_manual_link("run:source", "run:consumer", "inspired")
    dataset_link = store.create_manual_link("dataset:mnist", "run:source", "dataset source")
    module_link = store.create_manual_link("module:consumer:block:Linear", "run:source", "module source")
    artifact_link = store.create_manual_link("artifact:source:model.pt", "run:consumer", "picked weights")
    (store.links_path).write_text(
        store.links_path.read_text(encoding="utf-8") + '{"id":"legacy","src":"bad","dst":"also-bad","note":null}\n',
        encoding="utf-8",
    )

    graph_without_modules = store.lineage("consumer", direction="both", depth=3, include_modules=False)
    graph = store.lineage("consumer", direction="both", depth=3, include_modules=True)
    store.delete_manual_link(link.id)
    store.delete_manual_link(dataset_link.id)
    store.delete_manual_link(module_link.id)
    store.delete_manual_link(artifact_link.id)
    graph_without_link = store.lineage("consumer", direction="both", depth=3, include_modules=True)

    assert all(node.type != "module" for node in graph_without_modules.nodes)
    assert all(not edge.src.startswith("module:") and not edge.dst.startswith("module:") for edge in graph_without_modules.edges)
    assert {node.id for node in graph.nodes} >= {
        "run:consumer",
        "run:source",
        "dataset:mnist",
        "module:consumer:block:Linear",
        "artifact:source:model.pt",
    }
    assert {(edge.src, edge.dst, edge.type) for edge in graph.edges} >= {
        ("dataset:mnist", "run:consumer", "uses-dataset"),
        ("run:source", "run:consumer", "consumes-artifact"),
        ("module:consumer:block:Linear", "run:consumer", "composed-of-module"),
        ("run:source", "run:consumer", "manual"),
        ("dataset:mnist", "run:source", "manual"),
        ("module:consumer:block:Linear", "run:source", "manual"),
        ("artifact:source:model.pt", "run:consumer", "manual"),
    }
    assert any(edge.link_id == artifact_link.id for edge in graph.edges)
    assert all(edge.type != "manual" for edge in graph_without_link.edges)


def test_lineage_does_not_depend_on_list_runs_limit(tmp_path: Path, monkeypatch) -> None:
    store = Store(tmp_path / ".mikon")
    source = store.create_run(
        run_id="source",
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    consumer = store.create_run(
        run_id="consumer",
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    (source / "artifacts" / "model.pt").write_text("weights", encoding="utf-8")
    (consumer / "inputs.jsonl").write_text(
        '{"type":"consumes-artifact","run_id":"source","artifact":"model.pt","path":"/tmp/model.pt"}\n',
        encoding="utf-8",
    )

    def fail_list_runs(*args, **kwargs):
        raise AssertionError("lineage should scan all run dirs directly")

    monkeypatch.setattr(store, "list_runs", fail_list_runs)
    graph = store.lineage("consumer", direction="both", depth=2)

    assert ("run:source", "run:consumer", "consumes-artifact") in {
        (edge.src, edge.dst, edge.type) for edge in graph.edges
    }


def test_log_records_all_uses_event_order_and_status_sse_payload(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    run_dir = store.create_run(
        run_id="run1",
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    (run_dir / "logs" / "stdout.log").write_text("out1\nout2\n", encoding="utf-8")
    (run_dir / "logs" / "stderr.log").write_text("err1\n", encoding="utf-8")
    (run_dir / "logs" / "events.jsonl").write_text(
        '{"seq":0,"stream":"stdout","line":"out1"}\n'
        '{"seq":1,"stream":"stderr","line":"err1"}\n'
        '{"seq":2,"stream":"stdout","line":"out2"}\n',
        encoding="utf-8",
    )

    records = store.log_records("run1", stream="all", since=-1)

    assert [(record.stream, record.line) for record in records] == [
        ("stdout", "out1"),
        ("stderr", "err1"),
        ("stdout", "out2"),
    ]


@pytest.mark.asyncio
async def test_metric_stream_status_payload_is_status_object(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    store.create_run(
        run_id="run1",
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )

    class FakeRequest:
        def __init__(self) -> None:
            self.app = SimpleNamespace(state=SimpleNamespace(store=store))

        async def is_disconnected(self) -> bool:
            return False

    event = await anext(_metric_stream(FakeRequest(), "run1", -1))

    assert event["event"] == "status"
    assert json.loads(event["data"]) == {"status": "unknown"}


def test_artifact_listing_includes_directories_and_compare_summarizes_metrics(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    run1 = store.create_run(
        run_id="run1",
        job="train",
        config={"epochs": 1},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    run2 = store.create_run(
        run_id="run2",
        job="train",
        config={"epochs": 2},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    (run1 / "artifacts" / "nested").mkdir()
    (run1 / "artifacts" / "nested" / "result.txt").write_text("ok", encoding="utf-8")
    (run1 / "metrics.jsonl").write_text(
        '{"t": 1760000000, "step": 0, "name": "loss", "value": 3.0}\n'
        '{"t": 1760000001, "step": 1, "name": "loss", "value": 1.0}\n',
        encoding="utf-8",
    )
    (run2 / "metrics.jsonl").write_text(
        '{"t": 1760000000, "step": 0, "name": "loss", "value": 2.0}\n',
        encoding="utf-8",
    )

    artifacts = store.list_artifacts("run1")
    detail = store.get_run("run1")
    compare = store.compare_runs(["run1", "run2"])

    assert any(item["path"] == "nested" and item["kind"] == "dir" for item in artifacts)
    assert any(item["path"] == "nested/result.txt" and item["kind"] == "file" for item in artifacts)
    assert detail.artifact_count == 1
    assert compare.metric_names == ["loss"]
    assert compare.config_diffs[0].field == "epochs"
    assert compare.config_diffs[0].values == {"run1": 1, "run2": 2}
    assert compare.runs[0].metrics["loss"].latest == 1.0
    assert compare.runs[0].metrics["loss"].min == 1.0


def _write_manual_run(store: Store, run_id: str, created_at: str, pid: int | None) -> None:
    run_dir = store.run_dir(run_id)
    (run_dir / "logs").mkdir(parents=True)
    (run_dir / "artifacts").mkdir()
    store.write_json(run_dir / "config.json", {})
    store.write_json(
        run_dir / "meta.json",
        {
            "run_id": run_id,
            "job": "train",
            "gpus": ["nvidia:0"],
            "pid": pid,
            "create_time": None,
            "config_hash": "config",
            "schema_hash": "schema",
            "cmd": [],
            "project_root": str(store.root),
            "watch": [],
            "created_at": created_at,
            "started_at": created_at,
        },
    )
