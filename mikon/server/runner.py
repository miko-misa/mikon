from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import psutil

from mikon.server.discovery import validate_config_subprocess, validate_dataset_config_subprocess
from mikon.server.models import BuildDatasetRequest, CreateRunRequest, CreateRunResponse, RunDetail, RunStatus
from mikon.server.problems import ProblemException
from mikon.server.registry import Registry
from mikon.server.resources import ResourceMonitor, visible_env_for_vendor
from mikon.server.store import Store, TERMINAL_STATUSES


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
        command = [sys.executable, "-m", "mikon._runner", "--run-dir", str(self.store.run_dir(run_id))]
        run_dir = self.store.create_run(
            run_id=run_id,
            job=request.job,
            config=resolved_config,
            gpus=request.gpus,
            schema_hash=job["schema_hash"],
            command=command,
            project_root=self.registry.settings.project_root,
            watch=list(self.registry.settings.watch),
            annotations=request.annotations,
        )
        env = os.environ.copy()
        env["MIKON_RUN_DIR"] = str(run_dir)
        env["MIKON_JOB"] = request.job
        env["MIKON_PROJECT_ROOT"] = str(self.registry.settings.project_root)
        env["MIKON_STORE"] = str(self.store.root)
        vendor = vendors.pop()
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
        if request.save_config_as:
            self.store.save_config(
                request.save_config_as,
                request.job,
                resolved_config,
                job["schema_hash"],
            )
        return CreateRunResponse(run_id=run_id, status=RunStatus.running)

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
        command = [sys.executable, "-m", "mikon._runner", "--run-dir", str(self.store.run_dir(run_id))]
        run_dir = self.store.create_run(
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
        env = os.environ.copy()
        env["MIKON_RUN_DIR"] = str(run_dir)
        env["MIKON_DATASET_NAME"] = name
        env["MIKON_PROJECT_ROOT"] = str(self.registry.settings.project_root)
        env["MIKON_STORE"] = str(self.store.root)
        if selected:
            vendor = vendors.pop()
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
        return CreateRunResponse(run_id=run_id, status=RunStatus.running)

    def stop_run(self, run_id: str) -> RunDetail:
        detail = self.store.get_run(run_id)
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
