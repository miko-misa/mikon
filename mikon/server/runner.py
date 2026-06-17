from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import psutil

from mikon.server.discovery import validate_config_subprocess, validate_dataset_config_subprocess
from mikon.server.models import (
    BuildDatasetRequest,
    CreateChainRequest,
    CreateChainResponse,
    CreateRunRequest,
    CreateRunResponse,
    RunDetail,
    RunStatus,
)
from mikon.server.problems import ProblemException
from mikon.server.registry import Registry
from mikon.server.resources import ResourceMonitor, visible_env_for_vendor
from mikon.server.store import (
    ArtifactResolutionError,
    Store,
    TERMINAL_STATUSES,
    rewrite_chain_step_refs,
)


class Runner:
    def __init__(
        self,
        *,
        store: Store,
        registry: Registry,
        resources: ResourceMonitor,
    ) -> None:
        self.store = store
        self.registry = registry
        self.resources = resources

    def create_run(self, request: CreateRunRequest) -> CreateRunResponse:
        job = self.registry.get_job(request.job)
        if job is None:
            raise ProblemException(
                type="/problems/job-not-found",
                title="Job not found",
                status=404,
                detail=f"Unknown job: {request.job}",
                name=request.job,
            )
        snapshot = self.resources.snapshot()
        selected = _selected_gpus(snapshot.gpus, request.gpus)
        vendors = {gpu.vendor for gpu in selected}
        if len(vendors) != 1:
            raise ProblemException(
                type="/problems/gpus-mixed-vendor",
                title="Selected GPUs mix vendors",
                status=422,
                detail="A run can use GPUs from only one vendor.",
                gpus=request.gpus,
            )
        occupied = [gpu for gpu in selected if gpu.occupied]
        if occupied and not request.force:
            raise ProblemException(
                type="/problems/gpu-occupied",
                title="Selected GPU is occupied",
                status=409,
                detail="One or more selected GPUs are occupied.",
                gpus=[gpu.id for gpu in occupied],
                occupied_by=[
                    process.model_dump() for gpu in occupied for process in gpu.processes
                ],
            )

        resolved_config = validate_config_subprocess(
            self.registry.settings, request.job, request.config
        )
        if request.save_config_as:
            self.store.ensure_config_name_available(request.save_config_as, request.job)
        run_id = self.store.new_run_id(request.job)
        _python = self.registry.settings.python or sys.executable
        command = [_python, "-m", "mikon._runner", "--run-dir", str(self.store.run_dir(run_id))]
        self.store.create_run(
            run_id=run_id,
            job=request.job,
            config=resolved_config,
            gpus=request.gpus,
            schema_hash=job["schema_hash"],
            command=command,
            project_root=self.registry.settings.project_root,
            watch=list(self.registry.settings.watch),
            annotations=request.annotations,
            force=request.force,
        )
        self._spawn(run_id, selected)
        if request.save_config_as:
            self.store.save_config(
                request.save_config_as,
                request.job,
                resolved_config,
                job["schema_hash"],
            )
        return CreateRunResponse(run_id=run_id, status=RunStatus.running)

    def create_chain(self, request: CreateChainRequest) -> CreateChainResponse:
        resolved: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for step in request.steps:
            job = self.registry.get_job(step.job)
            if job is None:
                raise ProblemException(
                    type="/problems/job-not-found",
                    title="Job not found",
                    status=404,
                    detail=f"Unknown job: {step.job}",
                    name=step.job,
                )
            resolved_config = validate_config_subprocess(
                self.registry.settings, step.job, step.config
            )
            resolved.append((job, resolved_config))

        run_ids: list[str] = []
        for step in request.steps:
            run_id = self.store.new_run_id(step.job)
            while run_id in run_ids or self.store.run_dir(run_id).exists():
                run_id = self.store.new_run_id(step.job)
            run_ids.append(run_id)

        _python = self.registry.settings.python or sys.executable
        created: list[str] = []
        try:
            for index, step in enumerate(request.steps):
                job, resolved_config = resolved[index]
                try:
                    rewritten, depends_on = rewrite_chain_step_refs(resolved_config, run_ids, index)
                except ValueError as exc:
                    raise ProblemException(
                        type="/problems/chain-invalid-reference",
                        title="Invalid chain reference",
                        status=422,
                        detail=str(exc),
                    ) from exc
                command = [
                    _python,
                    "-m",
                    "mikon._runner",
                    "--run-dir",
                    str(self.store.run_dir(run_ids[index])),
                ]
                self.store.create_run(
                    run_id=run_ids[index],
                    job=step.job,
                    config=rewritten,
                    gpus=step.gpus,
                    schema_hash=job["schema_hash"],
                    command=command,
                    project_root=self.registry.settings.project_root,
                    watch=list(self.registry.settings.watch),
                    annotations=step.annotations,
                    pending=True,
                    depends_on=depends_on,
                    on_upstream_failure=request.on_upstream_failure,
                    force=step.force,
                )
                created.append(run_ids[index])
        except Exception:
            for run_id in created:
                shutil.rmtree(self.store.run_dir(run_id), ignore_errors=True)
            raise
        return CreateChainResponse(run_ids=run_ids)

    def launch_pending_run(self, run_id: str) -> None:
        """Resolve inputs, reserve GPUs, and start a pending chain step.

        Leaves the run pending (with ``pending_reason=waiting-for-gpu``) when the
        requested GPUs are occupied and ``force`` is not set. Marks the run failed
        on unresolved references or unusable GPU selection.
        """
        try:
            self.store.resolve_artifact_refs(run_id)
        except ArtifactResolutionError as exc:
            self.store.write_status(run_id, RunStatus.failed, 1, str(exc))
            return

        meta = self.store.read_meta(run_id)
        requested = list(meta.get("gpus", []))
        snapshot = self.resources.snapshot()
        try:
            selected = _selected_gpus(snapshot.gpus, requested)
        except ProblemException as exc:
            self.store.write_status(run_id, RunStatus.failed, 1, exc.detail or "GPU not found.")
            return
        vendors = {gpu.vendor for gpu in selected}
        if requested and len(vendors) != 1:
            self.store.write_status(
                run_id, RunStatus.failed, 1, "A run can use GPUs from only one vendor."
            )
            return
        occupied = [gpu for gpu in selected if gpu.occupied]
        if occupied and not meta.get("force", False):
            self.store.set_pending_reason(run_id, "waiting-for-gpu")
            return
        self.store.mark_launched(run_id)
        try:
            self._spawn(run_id, selected)
        except ProblemException:
            pass  # _spawn already recorded the failed status

    def _spawn(self, run_id: str, selected: list[Any]) -> None:
        run_dir = self.store.run_dir(run_id)
        meta = self.store.read_json(run_dir / "meta.json")
        command = meta["cmd"]
        env = os.environ.copy()
        env["MIKON_RUN_DIR"] = str(run_dir)
        env["MIKON_PROJECT_ROOT"] = str(self.registry.settings.project_root)
        env["MIKON_STORE"] = str(self.store.root)
        if meta.get("kind") == "dataset":
            env["MIKON_DATASET_NAME"] = meta["job"]
        else:
            env["MIKON_JOB"] = meta["job"]
        if selected:
            vendor = {gpu.vendor for gpu in selected}.pop()
            env[visible_env_for_vendor(vendor)] = ",".join(str(gpu.index) for gpu in selected)

        stdout = (run_dir / "logs" / "stdout.log").open("ab")
        stderr = (run_dir / "logs" / "stderr.log").open("ab")
        try:
            try:
                process = subprocess.Popen(
                    command,
                    cwd=self.registry.settings.project_root,
                    env=env,
                    stdout=stdout,
                    stderr=stderr,
                    start_new_session=True,
                    close_fds=True,
                )
            except OSError as exc:
                self.store.write_status(run_id, RunStatus.failed, 1, str(exc))
                raise ProblemException(
                    type="/problems/run-start-failed",
                    title="Run failed to start",
                    status=500,
                    detail=str(exc),
                    run_id=run_id,
                ) from exc
        finally:
            stdout.close()
            stderr.close()
        create_time = None
        try:
            create_time = psutil.Process(process.pid).create_time()
        except psutil.Error:
            pass
        self.store.attach_process(run_id, process.pid, create_time)

    def create_dataset_build(self, name: str, request: BuildDatasetRequest) -> CreateRunResponse:
        builder = self.registry.get_dataset_builder(name)
        if builder is None:
            raise ProblemException(
                type="/problems/dataset-builder-not-found",
                title="Dataset builder not found",
                status=404,
                detail=f"Unknown dataset builder: {name}",
                name=name,
            )
        selected: list[Any] = []
        vendors: set[str] = set()
        if request.gpus:
            snapshot = self.resources.snapshot()
            selected = _selected_gpus(snapshot.gpus, request.gpus)
            vendors = {gpu.vendor for gpu in selected}
            if len(vendors) != 1:
                raise ProblemException(
                    type="/problems/gpus-mixed-vendor",
                    title="Selected GPUs mix vendors",
                    status=422,
                    detail="A run can use GPUs from only one vendor.",
                    gpus=request.gpus,
                )
            occupied = [gpu for gpu in selected if gpu.occupied]
            if occupied and not request.force:
                raise ProblemException(
                    type="/problems/gpu-occupied",
                    title="Selected GPU is occupied",
                    status=409,
                    detail="One or more selected GPUs are occupied.",
                    gpus=[gpu.id for gpu in occupied],
                    occupied_by=[
                        process.model_dump() for gpu in occupied for process in gpu.processes
                    ],
                )

        resolved_config = validate_dataset_config_subprocess(
            self.registry.settings, name, request.config
        )
        run_id = self.store.new_run_id(f"dataset_{name}")
        _python = self.registry.settings.python or sys.executable
        command = [_python, "-m", "mikon._runner", "--run-dir", str(self.store.run_dir(run_id))]
        self.store.create_run(
            run_id=run_id,
            kind="dataset",
            job=name,
            config=resolved_config,
            gpus=request.gpus,
            schema_hash=builder["schema_hash"],
            command=command,
            project_root=self.registry.settings.project_root,
            watch=list(self.registry.settings.watch),
        )
        self._spawn(run_id, selected)
        return CreateRunResponse(run_id=run_id, status=RunStatus.running)

    def stop_run(self, run_id: str) -> RunDetail:
        detail = self.store.get_run(run_id)
        if detail.status == RunStatus.pending:
            self.store.cancel_chain(run_id, "Cancelled by user.")
            return self.store.get_run(run_id)
        if detail.status in TERMINAL_STATUSES:
            raise ProblemException(
                type="/problems/run-not-stoppable",
                title="Run is not stoppable",
                status=409,
                detail=f"Run {run_id} is already {detail.status.value}.",
                run_id=run_id,
                run_status=detail.status.value,
            )
        if detail.pid is None:
            self.store.write_status(run_id, RunStatus.unknown, None, "Run has no PID.")
            return self.store.get_run(run_id)
        try:
            os.killpg(detail.pid, signal.SIGTERM)
        except ProcessLookupError:
            self.store.write_status(run_id, RunStatus.unknown, None, "Process not found.")
            return self.store.get_run(run_id)
        except PermissionError as exc:
            raise ProblemException(
                type="/problems/run-not-stoppable",
                title="Run is not stoppable",
                status=409,
                detail=str(exc),
                run_id=run_id,
                run_status=detail.status.value,
            )
        deadline = time.time() + 5
        while time.time() < deadline:
            if self.store.run_dir(run_id).joinpath("status.json").exists():
                return self.store.get_run(run_id)
            if not psutil.pid_exists(detail.pid):
                break
            time.sleep(0.1)
        if psutil.pid_exists(detail.pid):
            try:
                os.killpg(detail.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if not self.store.run_dir(run_id).joinpath("status.json").exists():
            self.store.write_status(run_id, RunStatus.stopped, 143, "Stopped by mikon.")
        return self.store.get_run(run_id)


def _selected_gpus(gpus: list[Any], ids: list[str]) -> list[Any]:
    by_id = {gpu.id: gpu for gpu in gpus}
    missing = [gpu_id for gpu_id in ids if gpu_id not in by_id]
    if missing:
        raise ProblemException(
            type="/problems/gpu-not-found",
            title="GPU not found",
            status=422,
            detail=f"Unknown GPU id(s): {', '.join(missing)}",
            gpus=missing,
        )
    return [by_id[gpu_id] for gpu_id in ids]
