from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

import psutil
import pytest
from fastapi.testclient import TestClient

from mikon.server.app import create_app
from mikon.server.models import GpuInfo, GpuProcess, MachineInfo, ResourceSnapshot, RunStatus
from mikon.server.registry import Registry
from mikon.server.runner import Runner
from mikon.server.settings import load_settings
from mikon.server.models import LineageEdge
from mikon.server.store import (
    ArtifactResolutionError,
    Store,
    _lineage_node_ids,
    rewrite_chain_step_refs,
)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def make_chain_project(tmp_path: Path) -> Path:
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
    (tmp_path / "src" / "chain.py").write_text(
        '''
import mikon
from mikon import ArtifactRef, Config, RunContext
from pydantic import Field


class TrainConfig(Config):
    epochs: int = Field(1, ge=1, le=5)


@mikon.job
def train(config: TrainConfig, ctx: RunContext) -> None:
    weights = ctx.artifacts_dir / "model.pt"
    weights.write_text("WEIGHTS", encoding="utf-8")
    ctx.log_artifact("model.pt", weights)


class InferConfig(Config):
    weights: ArtifactRef


@mikon.job
def infer(config: InferConfig, ctx: RunContext) -> None:
    text = config.weights.path.read_text(encoding="utf-8")
    ctx.log_metric("weight_len", float(len(text)))


@mikon.job
def boom(config: TrainConfig, ctx: RunContext) -> None:
    raise RuntimeError("boom")
''',
        encoding="utf-8",
    )
    return tmp_path


def _snapshot(*, occupied: bool) -> ResourceSnapshot:
    return ResourceSnapshot(
        t=datetime.now(UTC),
        gpu_available=True,
        gpus=[
            GpuInfo(
                id="nvidia:0",
                vendor="nvidia",
                index=0,
                name="fake",
                util_pct=99 if occupied else 0,
                mem_used_mib=900 if occupied else 0,
                mem_total_mib=1000,
                occupied=occupied,
                processes=[GpuProcess(pid=1, used_mib=900, owned_by_mikon=False)] if occupied else [],
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


class FakeResources:
    def __init__(self, *, occupied: bool = False) -> None:
        self._occupied = occupied

    def snapshot(self) -> ResourceSnapshot:
        return _snapshot(occupied=self._occupied)


class RecordingRunner:
    """Stand-in runner that records launches instead of spawning subprocesses."""

    def __init__(self, store: Store) -> None:
        self.store = store
        self.launched: list[str] = []

    def launch_pending_run(self, run_id: str) -> None:
        self.launched.append(run_id)
        self.store.mark_launched(run_id)


def _make_pending(
    store: Store,
    run_id: str,
    *,
    depends_on: list[str],
    config: dict | None = None,
    on_upstream_failure: str = "cancel",
    gpus: list[str] | None = None,
) -> None:
    store.create_run(
        run_id=run_id,
        job="infer",
        config=config or {},
        gpus=gpus or ["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=store.root,
        watch=[],
        pending=True,
        depends_on=depends_on,
        on_upstream_failure=on_upstream_failure,
    )


def _make_completed(store: Store, run_id: str, status: RunStatus) -> None:
    store.create_run(
        run_id=run_id,
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=store.root,
        watch=[],
    )
    store.write_status(run_id, status)


def _make_running(store: Store, run_id: str) -> None:
    store.create_run(
        run_id=run_id,
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=store.root,
        watch=[],
    )
    store.attach_process(run_id, os.getpid(), psutil.Process(os.getpid()).create_time())


def _poll(client: TestClient, run_id: str, *, until: set[str], timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    detail: dict = {}
    while time.time() < deadline:
        detail = client.get(f"/api/runs/{run_id}").json()
        if detail.get("status") in until:
            return detail
        time.sleep(0.2)
    return detail


# --------------------------------------------------------------------------- #
# store-level
# --------------------------------------------------------------------------- #


def test_pending_run_reports_pending_status(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    _make_pending(store, "down", depends_on=["up"])

    detail = store.get_run("down")
    assert detail.status == RunStatus.pending
    assert detail.depends_on == ["up"]
    assert detail.pending_reason == "waiting-for-upstream"
    assert detail.started_at is None


def test_resolve_artifact_refs_injects_path_and_records_input(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    upstream = store.create_run(
        run_id="train1",
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    (upstream / "artifacts" / "model.pt").write_text("WEIGHTS", encoding="utf-8")
    _make_pending(
        store,
        "infer1",
        depends_on=["train1"],
        config={"weights": {"__artifact_ref__": {"run_id": "train1", "artifact": "model.pt"}}},
    )

    store.resolve_artifact_refs("infer1")

    config = store.read_json(store.run_dir("infer1") / "config.json")
    resolved = config["weights"]["__artifact_ref__"]["resolved_path"]
    assert resolved.endswith("train1/artifacts/model.pt")
    records = [
        json.loads(line)
        for line in (store.run_dir("infer1") / "inputs.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert records[0]["type"] == "consumes-artifact"
    assert records[0]["run_id"] == "train1"
    assert records[0]["artifact"] == "model.pt"


def test_resolve_artifact_refs_raises_when_missing(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    store.create_run(
        run_id="train1",
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=tmp_path,
        watch=[],
    )
    _make_pending(
        store,
        "infer1",
        depends_on=["train1"],
        config={"weights": {"__artifact_ref__": {"run_id": "train1", "artifact": "missing.pt"}}},
    )

    with pytest.raises(ArtifactResolutionError):
        store.resolve_artifact_refs("infer1")


def test_rewrite_chain_step_refs_maps_steps_and_collects_deps() -> None:
    run_ids = ["train__a", "eval__b", "report__c"]
    config = {
        "weights": {"__artifact_ref__": {"step": 0, "artifact": "model.pt"}},
        "scores": {"__artifact_ref__": {"step": 1, "artifact": "scores.json"}},
    }
    rewritten, deps = rewrite_chain_step_refs(config, run_ids, current_index=2)

    assert deps == ["eval__b", "train__a"]
    assert rewritten["weights"]["__artifact_ref__"] == {"artifact": "model.pt", "run_id": "train__a"}
    assert "step" not in rewritten["weights"]["__artifact_ref__"]


def test_rewrite_chain_step_refs_rejects_forward_reference() -> None:
    run_ids = ["train__a", "infer__b"]
    config = {"weights": {"__artifact_ref__": {"step": 1, "artifact": "model.pt"}}}
    with pytest.raises(ValueError):
        rewrite_chain_step_refs(config, run_ids, current_index=0)


def test_cancel_chain_cascades_to_dependents(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    _make_pending(store, "a", depends_on=[])
    _make_pending(store, "b", depends_on=["a"])
    _make_pending(store, "c", depends_on=["b"])

    store.cancel_chain("a", "stopped by user")

    assert store.run_status("a") == RunStatus.cancelled
    assert store.run_status("b") == RunStatus.cancelled
    assert store.run_status("c") == RunStatus.cancelled


# --------------------------------------------------------------------------- #
# scheduler-level (RecordingRunner, deterministic tick)
# --------------------------------------------------------------------------- #


def _scheduler(store: Store, runner: object):
    from mikon.server.scheduler import ChainScheduler

    return ChainScheduler(store, runner)  # type: ignore[arg-type]


def test_scheduler_waits_for_running_upstream(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    _make_running(store, "up")
    _make_pending(store, "down", depends_on=["up"])
    runner = RecordingRunner(store)

    _scheduler(store, runner).tick()

    assert runner.launched == []
    assert store.run_status("down") == RunStatus.pending
    assert store.read_meta("down")["pending_reason"] == "waiting-for-upstream"


def test_scheduler_launches_when_upstream_completed(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    _make_completed(store, "up", RunStatus.completed)
    _make_pending(store, "down", depends_on=["up"])
    runner = RecordingRunner(store)

    _scheduler(store, runner).tick()

    assert runner.launched == ["down"]


def test_scheduler_launches_root_step_with_no_dependencies(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    _make_pending(store, "root", depends_on=[])
    runner = RecordingRunner(store)

    _scheduler(store, runner).tick()

    assert runner.launched == ["root"]


def test_scheduler_cancels_downstream_on_failure_with_cancel_policy(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    _make_completed(store, "up", RunStatus.failed)
    _make_pending(store, "down", depends_on=["up"], on_upstream_failure="cancel")
    _make_pending(store, "down2", depends_on=["down"], on_upstream_failure="cancel")
    runner = RecordingRunner(store)

    _scheduler(store, runner).tick()

    assert runner.launched == []
    assert store.run_status("down") == RunStatus.cancelled
    assert store.run_status("down2") == RunStatus.cancelled


def test_scheduler_continue_policy_launches_despite_failure(tmp_path: Path) -> None:
    store = Store(tmp_path / ".mikon")
    _make_completed(store, "up", RunStatus.failed)
    _make_pending(store, "down", depends_on=["up"], on_upstream_failure="continue")
    runner = RecordingRunner(store)

    _scheduler(store, runner).tick()

    assert runner.launched == ["down"]


# --------------------------------------------------------------------------- #
# runner.launch_pending_run (real runner, no subprocess reached)
# --------------------------------------------------------------------------- #


def _runner(project: Path, *, occupied: bool) -> Runner:
    settings = load_settings(project)
    store = Store(settings.store)
    registry = Registry(settings)
    return Runner(store=store, registry=registry, resources=FakeResources(occupied=occupied))


def test_launch_pending_run_waits_for_gpu_when_occupied(tmp_path: Path) -> None:
    project = make_chain_project(tmp_path)
    runner = _runner(project, occupied=True)
    _make_pending(runner.store, "down", depends_on=[], gpus=["nvidia:0"])

    runner.launch_pending_run("down")

    assert runner.store.run_status("down") == RunStatus.pending
    assert runner.store.read_meta("down")["pending_reason"] == "waiting-for-gpu"


def test_launch_pending_run_fails_on_missing_artifact(tmp_path: Path) -> None:
    project = make_chain_project(tmp_path)
    runner = _runner(project, occupied=False)
    runner.store.create_run(
        run_id="train1",
        job="train",
        config={},
        gpus=["nvidia:0"],
        schema_hash="schema",
        command=[],
        project_root=project,
        watch=[],
    )
    _make_pending(
        runner.store,
        "infer1",
        depends_on=["train1"],
        config={"weights": {"__artifact_ref__": {"run_id": "train1", "artifact": "missing.pt"}}},
    )

    runner.launch_pending_run("infer1")

    detail = runner.store.get_run("infer1")
    assert detail.status == RunStatus.failed
    assert "missing.pt" in (detail.error or "")


# --------------------------------------------------------------------------- #
# API end-to-end (background scheduler running)
# --------------------------------------------------------------------------- #


def test_chain_runs_train_then_infer_and_records_lineage(tmp_path: Path) -> None:
    project = make_chain_project(tmp_path)
    app = create_app(project_root=project)

    with TestClient(app) as client:
        app.state.runner.resources = FakeResources(occupied=False)
        response = client.post(
            "/api/chains",
            json={
                "steps": [
                    {"job": "train", "config": {"epochs": 1}, "gpus": ["nvidia:0"]},
                    {
                        "job": "infer",
                        "config": {"weights": {"__artifact_ref__": {"step": 0, "artifact": "model.pt"}}},
                        "gpus": ["nvidia:0"],
                    },
                ],
                "on_upstream_failure": "cancel",
            },
        )
        assert response.status_code == 201, response.text
        run_ids = response.json()["run_ids"]
        assert len(run_ids) == 2
        train_id, infer_id = run_ids

        train_detail = _poll(client, train_id, until={"completed", "failed"})
        assert train_detail["status"] == "completed", train_detail

        infer_detail = _poll(client, infer_id, until={"completed", "failed", "cancelled"})
        assert infer_detail["status"] == "completed", infer_detail
        assert infer_detail["depends_on"] == [train_id]

        metrics = client.get(f"/api/runs/{infer_id}/metrics?since=-1").json()
        assert metrics["records"][0]["name"] == "weight_len"
        assert metrics["records"][0]["value"] == 7.0

        resolved = infer_detail["config"]["weights"]["__artifact_ref__"]["resolved_path"]
        assert resolved.endswith(f"{train_id}/artifacts/model.pt")

        lineage = client.get(f"/api/runs/{infer_id}/lineage?direction=both&depth=2").json()
        assert (f"run:{train_id}", f"run:{infer_id}", "consumes-artifact") in {
            (edge["src"], edge["dst"], edge["type"]) for edge in lineage["edges"]
        }


def test_chain_cancels_downstream_when_upstream_fails(tmp_path: Path) -> None:
    project = make_chain_project(tmp_path)
    app = create_app(project_root=project)

    with TestClient(app) as client:
        app.state.runner.resources = FakeResources(occupied=False)
        response = client.post(
            "/api/chains",
            json={
                "steps": [
                    {"job": "boom", "config": {"epochs": 1}, "gpus": ["nvidia:0"]},
                    {
                        "job": "infer",
                        "config": {"weights": {"__artifact_ref__": {"step": 0, "artifact": "model.pt"}}},
                        "gpus": ["nvidia:0"],
                    },
                ],
                "on_upstream_failure": "cancel",
            },
        )
        assert response.status_code == 201, response.text
        boom_id, infer_id = response.json()["run_ids"]

        boom_detail = _poll(client, boom_id, until={"completed", "failed"})
        assert boom_detail["status"] == "failed", boom_detail

        infer_detail = _poll(client, infer_id, until={"cancelled", "completed", "failed"})
        assert infer_detail["status"] == "cancelled", infer_detail


def test_chain_rejects_forward_reference(tmp_path: Path) -> None:
    project = make_chain_project(tmp_path)
    app = create_app(project_root=project)

    with TestClient(app) as client:
        app.state.runner.resources = FakeResources(occupied=False)
        response = client.post(
            "/api/chains",
            json={
                "steps": [
                    {
                        "job": "infer",
                        "config": {"weights": {"__artifact_ref__": {"step": 1, "artifact": "model.pt"}}},
                        "gpus": ["nvidia:0"],
                    },
                    {"job": "train", "config": {"epochs": 1}, "gpus": ["nvidia:0"]},
                ],
            },
        )

    assert response.status_code == 422
    assert response.json()["type"] == "/problems/chain-invalid-reference"
    assert list((project / ".mikon" / "runs").iterdir()) == []


def test_stop_pending_chain_step_cancels_it(tmp_path: Path) -> None:
    project = make_chain_project(tmp_path)
    app = create_app(project_root=project)

    with TestClient(app) as client:
        _make_running(app.state.store, "up")
        _make_pending(app.state.store, "down", depends_on=["up"])
        stopped = client.post("/api/runs/down/stop")

    assert stopped.status_code == 200
    assert stopped.json()["status"] == "cancelled"


# --------------------------------------------------------------------------- #
# static output-artifact extraction
# --------------------------------------------------------------------------- #


def test_extract_output_artifacts_reads_literals_and_skips_dynamic() -> None:
    from mikon.server.discovery import extract_output_artifacts

    def job(config, ctx):
        a = ctx.artifacts_dir / "model.npz"
        ctx.log_artifact("model.npz", a)
        b = ctx.artifacts_dir / "summary.txt"
        ctx.log_artifact("summary.txt", b)
        ctx.log_artifact(name="report.json", path=b)
        dynamic = ctx.artifacts_dir / f"epoch_{1}.pt"  # f-string: not extractable
        ctx.log_artifact(f"epoch_{1}.pt", dynamic)

    assert extract_output_artifacts(job) == ["model.npz", "report.json", "summary.txt"]


def test_extract_output_artifacts_returns_empty_for_no_artifacts() -> None:
    from mikon.server.discovery import extract_output_artifacts

    def job(config, ctx):
        ctx.log_metric("loss", 0.1)

    assert extract_output_artifacts(job) == []


def test_jobs_api_exposes_output_artifacts(tmp_path: Path) -> None:
    project = make_chain_project(tmp_path)
    app = create_app(project_root=project)
    with TestClient(app) as client:
        detail = client.get("/api/jobs/train").json()
        listed = client.get("/api/jobs").json()

    assert detail["output_artifacts"] == ["model.pt"]
    train_entry = next(job for job in listed if job["name"] == "train")
    assert train_entry["output_artifacts"] == ["model.pt"]


# --------------------------------------------------------------------------- #
# lineage traversal — "both" must not leak siblings
# --------------------------------------------------------------------------- #


def _diamond_edges() -> list[LineageEdge]:
    # A -> C, B -> C, C -> D, C -> E  (src = upstream/producer, dst = downstream)
    return [
        LineageEdge(src="A", dst="C", type="consumes-artifact"),
        LineageEdge(src="B", dst="C", type="consumes-artifact"),
        LineageEdge(src="C", dst="D", type="consumes-artifact"),
        LineageEdge(src="C", dst="E", type="consumes-artifact"),
    ]


def test_lineage_both_excludes_siblings() -> None:
    # Centered on the leaf E, "both" must not pull in its sibling D via shared parent C.
    got = _lineage_node_ids("E", _diamond_edges(), direction="both", depth=3)
    assert got == {"A", "B", "C", "E"}
    assert "D" not in got


def test_lineage_both_from_middle_shows_ancestors_and_descendants() -> None:
    # Centered on C, "both" is the union of ancestors {A,B} and descendants {D,E}.
    got = _lineage_node_ids("C", _diamond_edges(), direction="both", depth=3)
    assert got == {"A", "B", "C", "D", "E"}


def test_lineage_ancestors_only() -> None:
    got = _lineage_node_ids("E", _diamond_edges(), direction="ancestors", depth=3)
    assert got == {"A", "B", "C", "E"}


def test_lineage_descendants_only() -> None:
    # E is a leaf — it produced nothing downstream.
    got = _lineage_node_ids("E", _diamond_edges(), direction="descendants", depth=3)
    assert got == {"E"}


# --------------------------------------------------------------------------- #
# lineage traversal — complex DAG
#
# Edges are producer(src) -> consumer(dst), i.e. src is the ancestor of dst.
#
#            A            B
#           / \          / \
#          v   v        v   v
#          C   H        C   D        (A->C, A->H, B->C, B->D)
#          |    \      /   /
#          |     v    v   v
#          |      D<--'   (H->D)     D has parents B and H
#          |      |
#          v      v
#     C-->{E, F}  D-->E              (C->E, C->F, D->E)
#          \  |  /
#           v v v
#            E   F
#            \   /
#             v v
#              G                     (E->G, F->G)
#
# Full edge list:
#   A->C, A->H, B->C, B->D, H->D, C->E, C->F, D->E, E->G, F->G
#
# The subtle node is F relative to E: F shares a PARENT with E (both children of C)
# AND shares a CHILD with E (both feed G). Yet F is neither an ancestor nor a
# descendant of E, so a correct "both" traversal from E must exclude it.
# --------------------------------------------------------------------------- #


def _complex_edges() -> list[LineageEdge]:
    pairs = [
        ("A", "C"), ("A", "H"),
        ("B", "C"), ("B", "D"),
        ("H", "D"),
        ("C", "E"), ("C", "F"),
        ("D", "E"),
        ("E", "G"), ("F", "G"),
    ]
    return [LineageEdge(src=s, dst=d, type="consumes-artifact") for s, d in pairs]


def test_complex_e_ancestors() -> None:
    got = _lineage_node_ids("E", _complex_edges(), direction="ancestors", depth=5)
    assert got == {"A", "B", "C", "D", "E", "H"}


def test_complex_e_ancestors_depth_1() -> None:
    got = _lineage_node_ids("E", _complex_edges(), direction="ancestors", depth=1)
    assert got == {"C", "D", "E"}


def test_complex_e_descendants() -> None:
    got = _lineage_node_ids("E", _complex_edges(), direction="descendants", depth=5)
    assert got == {"E", "G"}


def test_complex_e_both_excludes_F() -> None:
    # F shares parent C and child G with E, but is neither ancestor nor descendant.
    got = _lineage_node_ids("E", _complex_edges(), direction="both", depth=5)
    assert got == {"A", "B", "C", "D", "E", "G", "H"}
    assert "F" not in got


def test_complex_c_both_excludes_D_and_H() -> None:
    got = _lineage_node_ids("C", _complex_edges(), direction="both", depth=5)
    assert got == {"A", "B", "C", "E", "F", "G"}


def test_complex_d_both_excludes_C_and_F() -> None:
    got = _lineage_node_ids("D", _complex_edges(), direction="both", depth=5)
    assert got == {"A", "B", "D", "E", "G", "H"}


def test_complex_g_ancestors_full() -> None:
    got = _lineage_node_ids("G", _complex_edges(), direction="ancestors", depth=5)
    assert got == {"A", "B", "C", "D", "E", "F", "G", "H"}


def test_complex_g_ancestors_depth_2() -> None:
    got = _lineage_node_ids("G", _complex_edges(), direction="ancestors", depth=2)
    assert got == {"C", "D", "E", "F", "G"}


def test_complex_a_descendants_excludes_B() -> None:
    got = _lineage_node_ids("A", _complex_edges(), direction="descendants", depth=5)
    assert got == {"A", "C", "D", "E", "F", "G", "H"}
