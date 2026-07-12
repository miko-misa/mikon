from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class RunStatus(str, Enum):
    running = "running"
    completed = "completed"
    failed = "failed"
    stopped = "stopped"
    unknown = "unknown"
    pending = "pending"
    cancelled = "cancelled"


class ProblemDetails(BaseModel):
    type: str = "about:blank"
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None


class JobInfo(BaseModel):
    name: str
    doc: str | None = None
    source_file: str
    lineno: int
    schema_hash: str
    output_artifacts: list[str] = Field(default_factory=list)


class JobDetail(JobInfo):
    json_schema: dict[str, Any]
    ui_schema: dict[str, Any]


class ModuleInfo(BaseModel):
    name: str
    implements: str
    doc: str | None = None
    source_file: str
    lineno: int
    schema_hash: str


class ModuleDetail(ModuleInfo):
    json_schema: dict[str, Any]
    ui_schema: dict[str, Any]


class Annotations(BaseModel):
    title: str | None = None
    memo: str | None = None
    tags: list[str] = Field(default_factory=list)
    star: bool = False
    group_ids: list[str] = Field(default_factory=list)


class AnnotationsPatch(BaseModel):
    title: str | None = None
    memo: str | None = None
    tags: list[str] | None = None
    star: bool | None = None
    group_ids: list[str] | None = None


class RunSummary(BaseModel):
    run_id: str
    kind: Literal["job", "dataset"] = "job"
    job: str
    status: RunStatus
    gpus: list[str]
    created_at: datetime
    started_at: datetime | None = None
    ended_at: datetime | None = None
    annotations: Annotations = Field(default_factory=Annotations)


class RunDetail(RunSummary):
    pid: int | None = None
    exit_code: int | None = None
    config_hash: str
    schema_hash: str
    config: dict[str, Any]
    json_schema: dict[str, Any] = Field(default_factory=dict)
    ui_schema: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    metric_names: list[str] = Field(default_factory=list)
    artifact_count: int = 0
    depends_on: list[str] = Field(default_factory=list)
    pending_reason: str | None = None


class MetricRecord(BaseModel):
    seq: int
    t: datetime
    step: int | None = None
    name: str
    value: float


class MetricsResponse(BaseModel):
    run_id: str
    records: list[MetricRecord]
    next_since: int


class LogRecord(BaseModel):
    idx: int
    stream: Literal["stdout", "stderr"]
    line: str


class GpuProcess(BaseModel):
    pid: int
    user: str | None = None
    name: str | None = None
    used_mib: int
    owned_by_mikon: bool
    run_id: str | None = None


class GpuInfo(BaseModel):
    id: str
    vendor: Literal["nvidia", "amd"]
    index: int
    name: str
    util_pct: float
    mem_used_mib: int
    mem_total_mib: int
    temp_c: float | None = None
    power_w: float | None = None
    occupied: bool
    processes: list[GpuProcess] = Field(default_factory=list)


class MachineInfo(BaseModel):
    cpu_pct: float
    cpu_count: int
    mem_used_mib: int
    mem_total_mib: int
    disk_used_gb: float
    disk_total_gb: float


class ResourceSnapshot(BaseModel):
    t: datetime
    gpus: list[GpuInfo] = Field(default_factory=list)
    machine: MachineInfo
    gpu_available: bool


class CreateRunRequest(BaseModel):
    job: str
    config: dict[str, Any]
    gpus: list[str] = Field(min_length=1)
    force: bool = False
    annotations: Annotations | None = None
    save_config_as: str | None = None


class CreateRunResponse(BaseModel):
    run_id: str
    status: RunStatus


class ChainStep(BaseModel):
    job: str
    config: dict[str, Any]
    gpus: list[str] = Field(min_length=1)
    force: bool = False
    annotations: Annotations | None = None


class CreateChainRequest(BaseModel):
    steps: list[ChainStep] = Field(min_length=1)
    on_upstream_failure: Literal["cancel", "continue"] = "cancel"


class CreateChainResponse(BaseModel):
    run_ids: list[str]


class FrameworkCheck(BaseModel):
    name: str
    installed: bool
    build: str | None = None
    sees_gpu: bool | None = None
    device_count: int | None = None
    warning: str | None = None


class Diagnostics(BaseModel):
    gpu_vendors: list[Literal["nvidia", "amd"]] = Field(default_factory=list)
    frameworks: list[FrameworkCheck] = Field(default_factory=list)
    ok: bool


class DocNode(BaseModel):
    name: str
    path: str
    type: Literal["dir", "file"]
    format: Literal["markdown", "typst", "typmark"] | None = None
    mtime: datetime | None = None
    size: int | None = None
    children: list["DocNode"] = Field(default_factory=list)


class DocTree(BaseModel):
    root: str
    exists: bool
    nodes: list[DocNode] = Field(default_factory=list)


class DocDocument(BaseModel):
    path: str
    title: str
    format: Literal["markdown", "typst", "typmark"]
    rendered_kind: Literal["html", "svg", "source"]
    content: str
    source: str
    mtime: datetime | None = None
    size: int
    diagnostics: list[str] = Field(default_factory=list)


class ArtifactEntry(BaseModel):
    path: str
    size: int
    mtime: datetime | None = None
    kind: Literal["file", "dir"]


class Group(BaseModel):
    id: str
    name: str
    description: str | None = None
    created_at: datetime


class GroupCreate(BaseModel):
    name: str
    description: str | None = None


class GroupUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class ConfigInstance(BaseModel):
    name: str
    job: str
    values: dict[str, Any]
    schema_hash: str
    created_at: datetime
    updated_at: datetime


class DatasetInfo(BaseModel):
    name: str
    description: str | None = None
    path: str
    source: Literal["register", "builder"]
    builder_run_id: str | None = None
    created_at: datetime


class DatasetCreate(BaseModel):
    name: str
    path: str
    description: str | None = None


class DatasetBuilderInfo(BaseModel):
    name: str
    doc: str | None = None
    source_file: str
    lineno: int
    schema_hash: str


class DatasetBuilderDetail(DatasetBuilderInfo):
    json_schema: dict[str, Any]
    ui_schema: dict[str, Any]


class BuildDatasetRequest(BaseModel):
    config: dict[str, Any] = Field(default_factory=dict)
    gpus: list[str] = Field(default_factory=list)
    force: bool = False


class ConfigSaveRequest(BaseModel):
    job: str
    values: dict[str, Any]
    schema_hash: str | None = None


class ConfigDiffRequest(BaseModel):
    job: str | None = None


class ConfigDiffChange(BaseModel):
    field: str
    kind: Literal["added", "removed", "constraint_changed", "type_changed"]
    detail: str


class ConfigDiff(BaseModel):
    name: str
    job: str
    compatible: bool
    changes: list[ConfigDiffChange] = Field(default_factory=list)
    migrated_values: dict[str, Any] = Field(default_factory=dict)


class CompareRunsRequest(BaseModel):
    run_ids: list[str] = Field(min_length=2)


class CompareMetricStats(BaseModel):
    count: int
    latest: float | None = None
    min: float | None = None
    max: float | None = None


class CompareRunEntry(BaseModel):
    run_id: str
    job: str
    status: RunStatus
    config: dict[str, Any]
    metrics: dict[str, CompareMetricStats] = Field(default_factory=dict)


class CompareConfigDiff(BaseModel):
    field: str
    values: dict[str, Any] = Field(default_factory=dict)
    missing_run_ids: list[str] = Field(default_factory=list)


class CompareRunsResponse(BaseModel):
    runs: list[CompareRunEntry]
    config_fields: list[str] = Field(default_factory=list)
    metric_names: list[str] = Field(default_factory=list)
    config_diffs: list[CompareConfigDiff] = Field(default_factory=list)


class LineageNode(BaseModel):
    id: str
    type: Literal["run", "dataset", "module", "artifact"]
    label: str
    collapsed_into: str | None = None


class LineageEdge(BaseModel):
    src: str
    dst: str
    type: Literal["consumes-artifact", "uses-dataset", "composed-of-module", "produces-dataset", "manual"]
    artifact: str | None = None
    note: str | None = None
    link_id: str | None = None


class LineageGraph(BaseModel):
    center: str
    nodes: list[LineageNode]
    edges: list[LineageEdge]


class ManualLink(BaseModel):
    id: str
    src: str
    dst: str
    note: str | None = None


class ManualLinkCreate(BaseModel):
    src: str
    dst: str
    note: str | None = None
