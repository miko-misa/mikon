from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

from watchfiles import awatch

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import FileResponse, PlainTextResponse, Response as FastAPIResponse
from sse_starlette.sse import EventSourceResponse

from mikon.server.discovery import validate_config_subprocess
from mikon.server.docs import ASSET_EXTENSIONS, DOC_EXTENSIONS, DocsService
from mikon.server.models import (
    AnnotationsPatch,
    BuildDatasetRequest,
    ConfigDiffRequest,
    ConfigSaveRequest,
    CreateChainRequest,
    CreateRunRequest,
    DatasetCreate,
    GroupCreate,
    GroupUpdate,
    ManualLinkCreate,
    RunDetail,
    RunStatus,
)
from mikon.server.problems import ProblemException


def _with_config_schema(detail: RunDetail, request: Request) -> RunDetail:
    registry = request.app.state.registry
    if detail.kind == "dataset":
        definition = registry.get_dataset_builder(detail.job)
    else:
        definition = registry.get_job(detail.job)
    if definition is None:
        return detail.model_copy(update={"json_schema": {}, "ui_schema": {}})
    return detail.model_copy(
        update={
            "json_schema": definition.get("json_schema", {}),
            "ui_schema": definition.get("ui_schema", {}),
        }
    )


def create_api_router() -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/jobs")
    def list_jobs(request: Request, response: Response):
        registry = request.app.state.registry
        if registry.stale:
            response.headers["X-Registry-Stale"] = "1"
            if registry.error:
                response.headers["X-Registry-Error"] = registry.error[:4000]
        elif registry.error and not registry.has_any_entries():
            raise ProblemException(
                type="/problems/registry-stale",
                title="Registry stale",
                status=503,
                detail="Discovery failed and no previous registry is available.",
                error=registry.error,
            )
        return registry.list_jobs()

    @router.get("/jobs/{name}")
    def get_job(name: str, request: Request):
        job = request.app.state.registry.get_job(name)
        if job is None:
            raise ProblemException(
                type="/problems/job-not-found",
                title="Job not found",
                status=404,
                detail=f"Unknown job: {name}",
                name=name,
            )
        return job

    @router.post("/runs", status_code=201)
    def create_run(body: CreateRunRequest, request: Request):
        return request.app.state.runner.create_run(body)

    @router.post("/chains", status_code=201)
    def create_chain(body: CreateChainRequest, request: Request):
        return request.app.state.runner.create_chain(body)

    @router.get("/runs")
    def list_runs(
        request: Request,
        limit: Annotated[int, Query(ge=1, le=500)] = 50,
        before: datetime | None = None,
        tag: str | None = None,
        star: bool | None = None,
        group: str | None = None,
        job: str | None = None,
        status: RunStatus | None = None,
    ):
        return request.app.state.store.list_runs(
            limit=limit,
            before=before,
            tag=tag,
            star=star,
            group=group,
            job=job,
            status=status,
        )

    @router.get("/runs/{run_id}")
    def get_run(run_id: str, request: Request):
        return _with_config_schema(request.app.state.store.get_run(run_id), request)

    @router.post("/runs/{run_id}/stop")
    def stop_run(run_id: str, request: Request):
        return _with_config_schema(request.app.state.runner.stop_run(run_id), request)

    @router.patch("/runs/{run_id}")
    def patch_run(run_id: str, body: AnnotationsPatch, request: Request):
        return _with_config_schema(request.app.state.store.patch_annotations(run_id, body), request)

    @router.delete("/runs/{run_id}", status_code=204)
    def delete_run(run_id: str, request: Request):
        request.app.state.store.delete_run(run_id)

    @router.get("/runs/{run_id}/metrics")
    def get_metrics(
        run_id: str,
        request: Request,
        since: int = -1,
        name: str | None = None,
    ):
        return request.app.state.store.metrics(run_id, since=since, name=name)

    @router.get("/runs/{run_id}/logs")
    def get_logs(
        run_id: str,
        request: Request,
        stream: Literal["stdout", "stderr"] = "stdout",
        tail: Annotated[int, Query(ge=1, le=5000)] = 200,
    ):
        store = request.app.state.store
        text = store.log_text(run_id, stream=stream, tail=tail)
        result = PlainTextResponse(text)
        result.headers["X-Log-Next-Since"] = str(store.log_line_count(run_id, stream) - 1)
        return result

    @router.get("/runs/{run_id}/artifacts")
    def list_artifacts(run_id: str, request: Request):
        return request.app.state.store.list_artifacts(run_id)

    @router.get("/runs/{run_id}/artifacts/{artifact_path:path}")
    def get_artifact(run_id: str, artifact_path: str, request: Request):
        run_dir = request.app.state.store.require_run_dir(run_id)
        root = run_dir / "artifacts"
        path = (root / artifact_path).resolve()
        if not _is_relative_to(path, root.resolve()) or not path.is_file():
            raise ProblemException(
                type="/problems/artifact-not-found",
                title="Artifact not found",
                status=404,
                detail=f"Unknown artifact: {artifact_path}",
                run_id=run_id,
            )
        return FileResponse(path)

    @router.get("/resources")
    def get_resources(request: Request):
        return request.app.state.resources.snapshot()

    @router.get("/doctor")
    def get_doctor(request: Request):
        return request.app.state.resources.diagnostics()

    @router.get("/docs")
    def get_docs_tree(request: Request):
        return DocsService(request.app.state.settings).tree()

    @router.get("/docs/stream")
    async def stream_docs(request: Request):
        return EventSourceResponse(_docs_stream(request))

    @router.get("/docs/{doc_path:path}")
    def get_doc(doc_path: str, request: Request):
        service = DocsService(request.app.state.settings)
        asset_prefix = "assets/"
        if doc_path.startswith(asset_prefix):
            asset_path = doc_path.removeprefix(asset_prefix)
            suffix = Path(asset_path).suffix.lower()
            if suffix in ASSET_EXTENSIONS:
                path, media_type = service.asset(asset_path)
                return FileResponse(path, media_type=media_type)
            if suffix in DOC_EXTENSIONS:
                try:
                    return service.document(doc_path)
                except ProblemException as exc:
                    if exc.type != "/problems/doc-not-found":
                        raise
                return service.document(asset_path)
            raise ProblemException(
                type="/problems/doc-unsupported",
                title="Unsupported document type",
                status=415,
                detail=f"Unsupported file extension: {suffix or '(none)'}",
                path=asset_path,
            )
        return service.document(doc_path)

    @router.get("/groups")
    def list_groups(request: Request):
        return request.app.state.store.list_groups()

    @router.post("/groups", status_code=201)
    def create_group(body: GroupCreate, request: Request):
        return request.app.state.store.create_group(body.name, body.description)

    @router.get("/groups/{group_id}")
    def get_group(group_id: str, request: Request):
        return request.app.state.store.get_group(group_id)

    @router.patch("/groups/{group_id}")
    def update_group(group_id: str, body: GroupUpdate, request: Request):
        return request.app.state.store.update_group(group_id, body.name, body.description)

    @router.delete("/groups/{group_id}", status_code=204)
    def delete_group(group_id: str, request: Request):
        request.app.state.store.delete_group(group_id)
        return FastAPIResponse(status_code=204)

    @router.get("/groups/{group_id}/runs")
    def group_runs(group_id: str, request: Request):
        return request.app.state.store.group_runs(group_id)

    @router.get("/datasets")
    def list_datasets(request: Request):
        return request.app.state.store.list_datasets()

    @router.post("/datasets", status_code=201)
    def create_dataset(body: DatasetCreate, request: Request):
        return request.app.state.store.register_dataset(body.name, body.path, body.description)

    @router.get("/datasets/{name}")
    def get_dataset(name: str, request: Request):
        return request.app.state.store.get_dataset(name)

    @router.delete("/datasets/{name}", status_code=204)
    def delete_dataset(name: str, request: Request):
        request.app.state.store.delete_dataset(name)
        return FastAPIResponse(status_code=204)

    @router.get("/dataset-builders")
    def list_dataset_builders(request: Request):
        return request.app.state.registry.list_dataset_builders()

    @router.get("/dataset-builders/{name}")
    def get_dataset_builder(name: str, request: Request):
        builder = request.app.state.registry.get_dataset_builder(name)
        if builder is None:
            raise ProblemException(
                type="/problems/dataset-builder-not-found",
                title="Dataset builder not found",
                status=404,
                detail=f"Unknown dataset builder: {name}",
                name=name,
            )
        return builder

    @router.post("/datasets/{name}/build", status_code=201)
    def build_dataset(name: str, body: BuildDatasetRequest, request: Request):
        return request.app.state.runner.create_dataset_build(name, body)

    @router.get("/modules")
    def list_modules(request: Request, implements: str | None = None):
        return request.app.state.registry.list_modules(implements=implements)

    @router.get("/modules/{name}")
    def get_module(name: str, request: Request):
        module = request.app.state.registry.get_module(name)
        if module is None:
            raise ProblemException(
                type="/problems/module-not-found",
                title="Module not found",
                status=404,
                detail=f"Unknown module: {name}",
                name=name,
            )
        return module

    @router.get("/configs")
    def list_configs(request: Request):
        return request.app.state.store.list_configs()

    @router.get("/configs/{name}")
    def get_config(name: str, request: Request):
        return request.app.state.store.get_config(name)

    @router.put("/configs/{name}")
    def save_config(name: str, body: ConfigSaveRequest, request: Request):
        request.app.state.store.ensure_config_name_available(name, body.job)
        job = request.app.state.registry.get_job(body.job)
        if job is None:
            raise ProblemException(
                type="/problems/job-not-found",
                title="Job not found",
                status=404,
                detail=f"Unknown job: {body.job}",
                name=body.job,
            )
        resolved_values = validate_config_subprocess(
            request.app.state.registry.settings,
            body.job,
            body.values,
        )
        return request.app.state.store.save_config(name, body.job, resolved_values, job["schema_hash"])

    @router.delete("/configs/{name}", status_code=204)
    def delete_config(name: str, request: Request):
        request.app.state.store.delete_config(name)
        return FastAPIResponse(status_code=204)

    @router.post("/configs/{name}/diff")
    def diff_config(name: str, request: Request, body: ConfigDiffRequest | None = None):
        instance = request.app.state.store.get_config(name)
        job_name = body.job if body and body.job else instance.job
        job = request.app.state.registry.get_job(job_name)
        if job is None:
            raise ProblemException(
                type="/problems/job-not-found",
                title="Job not found",
                status=404,
                detail=f"Unknown job: {job_name}",
                name=job_name,
            )
        return request.app.state.store.diff_config(name, job["json_schema"], job["schema_hash"], job_name)

    @router.get("/compare/runs")
    def compare_runs(request: Request, run_id: Annotated[list[str], Query(min_length=2)]):
        return request.app.state.store.compare_runs(run_id)

    @router.get("/runs/{run_id}/lineage")
    def get_lineage(
        run_id: str,
        request: Request,
        direction: Literal["ancestors", "descendants", "both"] = "both",
        depth: Annotated[int, Query(ge=0, le=20)] = 2,
        include_modules: bool = False,
    ):
        return request.app.state.store.lineage(run_id, direction=direction, depth=depth, include_modules=include_modules)

    @router.post("/links", status_code=201)
    def create_link(body: ManualLinkCreate, request: Request):
        return request.app.state.store.create_manual_link(body.src, body.dst, body.note)

    @router.delete("/links/{link_id}", status_code=204)
    def delete_link(link_id: str, request: Request):
        request.app.state.store.delete_manual_link(link_id)
        return FastAPIResponse(status_code=204)

    @router.get("/runs/{run_id}/stream")
    async def stream_run(run_id: str, request: Request):
        last_id = _last_event_id(request)
        return EventSourceResponse(_metric_stream(request, run_id, last_id))

    @router.get("/runs/{run_id}/logs/stream")
    async def stream_logs(
        run_id: str,
        request: Request,
        stream: Literal["stdout", "stderr", "all"] = "all",
        since: int | None = None,
    ):
        last_id = _last_event_id(request) if since is None else since
        return EventSourceResponse(_log_stream(request, run_id, stream, last_id))

    @router.get("/resources/stream")
    async def stream_resources(request: Request):
        return EventSourceResponse(_resources_stream(request))

    return router


async def _metric_stream(request: Request, run_id: str, since: int):
    store = request.app.state.store
    sent_status: str | None = None
    while not await request.is_disconnected():
        detail = store.get_run(run_id)
        if detail.status.value != sent_status:
            sent_status = detail.status.value
            yield {"event": "status", "data": f'{{"status":"{detail.status.value}"}}'}
        response = store.metrics(run_id, since=since)
        for record in response.records:
            since = record.seq
            yield {"event": "metric", "id": str(record.seq), "data": record.model_dump_json()}
        await asyncio.sleep(1)


async def _log_stream(request: Request, run_id: str, stream: str, since: int):
    store = request.app.state.store
    while not await request.is_disconnected():
        records = store.log_records(run_id, stream=stream, since=since)
        for record in records:
            since = record.idx
            yield {"event": "log", "id": str(record.idx), "data": record.model_dump_json()}
        await asyncio.sleep(1)


async def _resources_stream(request: Request):
    resources = request.app.state.resources
    while not await request.is_disconnected():
        snapshot = resources.snapshot()
        yield {"event": "resources", "data": snapshot.model_dump_json()}
        await asyncio.sleep(2)


async def _docs_stream(request: Request):
    docs_root = DocsService(request.app.state.settings).root
    doc_suffixes = set(DOC_EXTENSIONS.keys())

    if not docs_root.exists():
        while not await request.is_disconnected():
            await asyncio.sleep(10)
        return

    try:
        async for changes in awatch(docs_root):
            if await request.is_disconnected():
                break
            relevant = [
                str(Path(p).relative_to(docs_root).as_posix())
                for _, p in changes
                if Path(p).suffix.lower() in doc_suffixes
            ]
            if relevant:
                yield {"event": "change", "data": json.dumps(relevant)}
    except asyncio.CancelledError:
        pass


def _last_event_id(request: Request) -> int:
    value = request.headers.get("last-event-id")
    if value is None:
        return -1
    try:
        return int(value)
    except ValueError:
        return -1


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
