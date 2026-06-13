from __future__ import annotations

import json
import os
import secrets
import re
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import psutil

from mikon.server.models import (
    Annotations,
    AnnotationsPatch,
    ArtifactEntry,
    CompareConfigDiff,
    CompareMetricStats,
    CompareRunEntry,
    CompareRunsResponse,
    ConfigDiff,
    ConfigDiffChange,
    ConfigInstance,
    DatasetInfo,
    Group,
    LineageEdge,
    LineageGraph,
    LineageNode,
    LogRecord,
    ManualLink,
    MetricRecord,
    MetricsResponse,
    RunDetail,
    RunStatus,
    RunSummary,
)
from mikon.server.problems import ProblemException
from mikon.server.schema import config_hash


TERMINAL_STATUSES = {
    RunStatus.completed,
    RunStatus.failed,
    RunStatus.stopped,
    RunStatus.unknown,
}


class Store:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.runs_root = root / "runs"
        self.groups_root = root / "groups"
        self.configs_root = root / "configs"
        self.datasets_root = root / "datasets"
        self.links_path = root / "links.jsonl"
        self.runs_root.mkdir(parents=True, exist_ok=True)
        self.groups_root.mkdir(parents=True, exist_ok=True)
        self.configs_root.mkdir(parents=True, exist_ok=True)
        self.datasets_root.mkdir(parents=True, exist_ok=True)

    def new_run_id(self, job: str) -> str:
        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        suffix = secrets.token_hex(2)
        safe_job = "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in job)
        return f"{safe_job}__{timestamp}__{suffix}"

    def create_run(
        self,
        *,
        run_id: str,
        job: str,
        config: dict[str, Any],
        gpus: list[str],
        schema_hash: str,
        command: list[str],
        project_root: Path,
        watch: list[Path],
        annotations: Annotations | None = None,
        kind: Literal["job", "dataset"] = "job",
    ) -> Path:
        annotations = annotations or Annotations()
        self._ensure_groups_exist(annotations.group_ids)
        run_dir = self.run_dir(run_id)
        created = False
        try:
            run_dir.mkdir(parents=True, exist_ok=False)
            created = True
            (run_dir / "logs").mkdir()
            (run_dir / "artifacts").mkdir()
            now = datetime.now(UTC).isoformat()
            self.write_json(run_dir / "config.json", config)
            self.write_json(
                run_dir / "meta.json",
                {
                    "run_id": run_id,
                    "kind": kind,
                    "job": job,
                    "gpus": gpus,
                    "pid": None,
                    "create_time": None,
                    "config_hash": config_hash(config),
                    "schema_hash": schema_hash,
                    "cmd": command,
                    "project_root": str(project_root),
                    "watch": [str(item) for item in watch],
                    "created_at": now,
                    "started_at": now,
                },
            )
            self.write_json(run_dir / "annotations.json", annotations.model_dump(mode="json"))
        except Exception:
            if created:
                shutil.rmtree(run_dir, ignore_errors=True)
            raise
        return run_dir

    def attach_process(self, run_id: str, pid: int, create_time: float | None) -> None:
        path = self.run_dir(run_id) / "meta.json"
        meta = self.read_json(path)
        meta["pid"] = pid
        meta["create_time"] = create_time
        self.write_json(path, meta)

    def write_status(
        self,
        run_id: str,
        status: RunStatus,
        exit_code: int | None = None,
        error: str | None = None,
    ) -> None:
        self.write_json(
            self.run_dir(run_id) / "status.json",
            {
                "status": status.value,
                "exit_code": exit_code,
                "ended_at": datetime.now(UTC).isoformat(),
                "error": error,
            },
        )

    def list_runs(
        self,
        limit: int = 50,
        before: datetime | None = None,
        *,
        tag: str | None = None,
        star: bool | None = None,
        group: str | None = None,
        job: str | None = None,
        status: RunStatus | None = None,
    ) -> list[RunSummary]:
        summaries: list[RunSummary] = []
        for summary in self._iter_run_summaries():
            if before and summary.created_at >= before:
                continue
            if job and summary.job != job:
                continue
            if status and summary.status != status:
                continue
            if tag and tag not in summary.annotations.tags:
                continue
            if star is not None and summary.annotations.star is not star:
                continue
            if group and group not in summary.annotations.group_ids:
                continue
            summaries.append(summary)
        summaries.sort(key=lambda item: item.created_at, reverse=True)
        return summaries[:limit]

    def get_run(self, run_id: str) -> RunDetail:
        run_dir = self.require_run_dir(run_id)
        summary = self._summary_from_dir(run_dir)
        meta = self.read_json(run_dir / "meta.json")
        status_data = self._status_data(run_dir)
        config = self.read_json(run_dir / "config.json")
        return RunDetail(
            **summary.model_dump(),
            pid=meta.get("pid"),
            exit_code=status_data.get("exit_code"),
            config_hash=meta["config_hash"],
            schema_hash=meta["schema_hash"],
            config=config,
            error=status_data.get("error"),
            metric_names=self.metric_names(run_id),
            artifact_count=sum(1 for item in self.list_artifacts(run_id) if item["kind"] == "file"),
        )

    def read_annotations(self, run_id: str) -> Annotations:
        path = self.require_run_dir(run_id) / "annotations.json"
        if not path.exists():
            return Annotations()
        return Annotations.model_validate(self.read_json(path))

    def write_annotations(self, run_id: str, annotations: Annotations) -> None:
        self._ensure_groups_exist(annotations.group_ids)
        self.write_json(
            self.require_run_dir(run_id) / "annotations.json",
            annotations.model_dump(mode="json"),
        )

    def patch_annotations(self, run_id: str, patch: AnnotationsPatch) -> RunDetail:
        current = self.read_annotations(run_id).model_dump()
        updates = patch.model_dump(exclude_unset=True)
        for key, value in updates.items():
            if key in {"tags", "star", "group_ids"} and value is None:
                continue
            current[key] = value
        annotations = Annotations.model_validate(current)
        self._ensure_groups_exist(annotations.group_ids)
        self.write_annotations(run_id, annotations)
        return self.get_run(run_id)

    def delete_run(self, run_id: str) -> None:
        run_dir = self.require_run_dir(run_id)
        status_data = self._status_data(run_dir)
        if status_data.get("status") == "running":
            raise ProblemException(
                type="/problems/run-is-running",
                title="Run is still running",
                status=409,
                detail=f"Run {run_id} is currently running. Stop it before deleting.",
                run_id=run_id,
            )
        shutil.rmtree(run_dir)

    def run_dir(self, run_id: str) -> Path:
        return self.runs_root / run_id

    def require_run_dir(self, run_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", run_id) or run_id in {".", ".."}:
            raise ProblemException(
                type="/problems/run-not-found",
                title="Run not found",
                status=404,
                detail=f"Unknown run: {run_id}",
                run_id=run_id,
            )
        run_dir = self.run_dir(run_id)
        if not run_dir.is_dir():
            raise ProblemException(
                type="/problems/run-not-found",
                title="Run not found",
                status=404,
                detail=f"Unknown run: {run_id}",
                run_id=run_id,
            )
        return run_dir

    def read_json(self, path: Path) -> dict[str, Any]:
        return json.loads(path.read_text(encoding="utf-8"))

    def write_json(self, path: Path, data: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temp, path)

    def metrics(self, run_id: str, since: int = -1, name: str | None = None) -> MetricsResponse:
        path = self.require_run_dir(run_id) / "metrics.jsonl"
        records: list[MetricRecord] = []
        next_since = since
        if path.exists():
            for seq, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
                if seq <= since or not line.strip():
                    continue
                try:
                    raw = json.loads(line)
                    if name and raw.get("name") != name:
                        next_since = seq
                        continue
                    records.append(
                        MetricRecord(
                            seq=seq,
                            t=datetime.fromtimestamp(float(raw["t"]), UTC),
                            step=raw.get("step"),
                            name=raw["name"],
                            value=float(raw["value"]),
                        )
                    )
                    next_since = seq
                except Exception:
                    continue
        return MetricsResponse(run_id=run_id, records=records, next_since=next_since)

    def metric_names(self, run_id: str) -> list[str]:
        path = self.run_dir(run_id) / "metrics.jsonl"
        names: set[str] = set()
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    names.add(json.loads(line)["name"])
                except Exception:
                    continue
        return sorted(names)

    def log_text(self, run_id: str, stream: Literal["stdout", "stderr"] = "stdout", tail: int = 200) -> str:
        path = self.require_run_dir(run_id) / "logs" / f"{stream}.log"
        if not path.exists():
            return ""
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[-tail:]) + ("\n" if lines else "")

    def log_line_count(self, run_id: str, stream: Literal["stdout", "stderr"]) -> int:
        path = self.require_run_dir(run_id) / "logs" / f"{stream}.log"
        if not path.exists():
            return 0
        return len(path.read_text(encoding="utf-8", errors="replace").splitlines())

    def log_records(
        self, run_id: str, stream: Literal["stdout", "stderr", "all"] = "all", since: int = -1
    ) -> list[LogRecord]:
        records: list[LogRecord] = []
        if stream == "all":
            events_path = self.require_run_dir(run_id) / "logs" / "events.jsonl"
            if events_path.exists():
                for line in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
                    if not line.strip():
                        continue
                    try:
                        raw = json.loads(line)
                        idx = int(raw.get("seq", -1))
                        item_stream = raw.get("stream")
                        if idx > since and item_stream in {"stdout", "stderr"}:
                            records.append(LogRecord(idx=idx, stream=item_stream, line=str(raw.get("line", ""))))
                    except Exception:
                        continue
                return records
        streams: list[Literal["stdout", "stderr"]] = ["stdout", "stderr"] if stream == "all" else [stream]
        for item in streams:
            path = self.require_run_dir(run_id) / "logs" / f"{item}.log"
            if not path.exists():
                continue
            for idx, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines()):
                if idx > since:
                    records.append(LogRecord(idx=idx, stream=item, line=line))
        return records

    def list_artifacts(self, run_id: str) -> list[dict[str, Any]]:
        artifacts_root = self.require_run_dir(run_id) / "artifacts"
        if not artifacts_root.exists():
            return []
        result: list[ArtifactEntry] = []
        for path in sorted(item for item in artifacts_root.rglob("*") if item != artifacts_root):
            stat = path.stat()
            result.append(
                ArtifactEntry(
                    path=str(path.relative_to(artifacts_root)),
                    size=_path_size(path),
                    mtime=datetime.fromtimestamp(stat.st_mtime, UTC),
                    kind="dir" if path.is_dir() else "file",
                )
            )
        return [item.model_dump(mode="json") for item in result]

    def list_datasets(self) -> list[DatasetInfo]:
        datasets: list[DatasetInfo] = []
        for path in sorted(self.datasets_root.glob("*/meta.json")):
            try:
                datasets.append(DatasetInfo.model_validate(self.read_json(path)))
            except Exception:
                continue
        datasets.sort(key=lambda dataset: dataset.created_at, reverse=True)
        return datasets

    def get_dataset(self, name: str) -> DatasetInfo:
        dataset_name = _safe_name(name)
        path = self.datasets_root / dataset_name / "meta.json"
        if not path.exists():
            raise _problem("/problems/dataset-not-found", "Dataset not found", 404, f"Unknown dataset: {name}", name=name)
        return DatasetInfo.model_validate(self.read_json(path))

    def register_dataset(
        self,
        name: str,
        path: str | os.PathLike[str],
        description: str | None = None,
        *,
        source: Literal["register", "builder"] = "register",
        builder_run_id: str | None = None,
    ) -> DatasetInfo:
        dataset_name = _safe_name(name)
        dataset_path = Path(path).expanduser().resolve()
        if not dataset_path.exists():
            raise _problem(
                "/problems/dataset-validation-failed",
                "Dataset validation failed",
                422,
                f"Dataset path does not exist: {dataset_path}",
                path=str(dataset_path),
            )
        info = DatasetInfo(
            name=dataset_name,
            description=description,
            path=str(dataset_path),
            source=source,
            builder_run_id=builder_run_id,
            created_at=datetime.now(UTC),
        )
        self.write_json(self.datasets_root / dataset_name / "meta.json", info.model_dump(mode="json"))
        return info

    def delete_dataset(self, name: str) -> None:
        dataset = self.get_dataset(name)
        path = self.datasets_root / dataset.name / "meta.json"
        path.unlink()
        try:
            path.parent.rmdir()
        except OSError:
            pass

    def list_groups(self) -> list[Group]:
        groups: list[Group] = []
        for path in sorted(self.groups_root.glob("*.json")):
            try:
                groups.append(Group.model_validate(self.read_json(path)))
            except Exception:
                continue
        groups.sort(key=lambda group: group.created_at, reverse=True)
        return groups

    def create_group(self, name: str, description: str | None = None) -> Group:
        if not name.strip():
            raise _problem("/problems/group-validation-failed", "Group validation failed", 422, "Group name is required.")
        group_id = f"{_slugify(name)}__{secrets.token_hex(2)}"
        group = Group(id=group_id, name=name.strip(), description=description, created_at=datetime.now(UTC))
        self.write_json(self.groups_root / f"{group.id}.json", group.model_dump(mode="json"))
        return group

    def get_group(self, group_id: str) -> Group:
        path = self.groups_root / f"{_safe_name(group_id)}.json"
        if not path.exists():
            raise _problem("/problems/group-not-found", "Group not found", 404, f"Unknown group: {group_id}", group_id=group_id)
        return Group.model_validate(self.read_json(path))

    def update_group(self, group_id: str, name: str | None = None, description: str | None = None) -> Group:
        group = self.get_group(group_id)
        data = group.model_dump()
        if name is not None:
            if not name.strip():
                raise _problem("/problems/group-validation-failed", "Group validation failed", 422, "Group name is required.")
            data["name"] = name.strip()
        if description is not None:
            data["description"] = description
        updated = Group.model_validate(data)
        self.write_json(self.groups_root / f"{updated.id}.json", updated.model_dump(mode="json"))
        return updated

    def delete_group(self, group_id: str) -> None:
        group = self.get_group(group_id)
        path = self.groups_root / f"{group.id}.json"
        path.unlink()
        for summary in self._iter_run_summaries():
            annotations = summary.annotations
            if group.id in annotations.group_ids:
                annotations.group_ids = [item for item in annotations.group_ids if item != group.id]
                self.write_annotations(summary.run_id, annotations)

    def group_runs(self, group_id: str, limit: int = 500) -> list[RunSummary]:
        group = self.get_group(group_id)
        return self.list_runs(limit=limit, group=group.id)

    def list_configs(self) -> list[ConfigInstance]:
        configs: list[ConfigInstance] = []
        for path in sorted(self.configs_root.glob("*.json")):
            try:
                configs.append(ConfigInstance.model_validate(self.read_json(path)))
            except Exception:
                continue
        configs.sort(key=lambda config: config.updated_at, reverse=True)
        return configs

    def get_config(self, name: str) -> ConfigInstance:
        path = self.configs_root / f"{_safe_name(name)}.json"
        if not path.exists():
            raise _problem("/problems/config-not-found", "Config not found", 404, f"Unknown config: {name}", name=name)
        return ConfigInstance.model_validate(self.read_json(path))

    def ensure_config_name_available(self, name: str, job: str) -> None:
        path = self.configs_root / f"{_safe_name(name)}.json"
        if not path.exists():
            return
        existing = ConfigInstance.model_validate(self.read_json(path))
        if existing.job != job:
            raise _problem(
                "/problems/config-name-conflict",
                "Config name conflict",
                409,
                f"Config {name} already belongs to job {existing.job}.",
                name=name,
                job=existing.job,
            )

    def save_config(self, name: str, job: str, values: dict[str, Any], schema_hash: str) -> ConfigInstance:
        safe_name = _safe_name(name)
        path = self.configs_root / f"{safe_name}.json"
        now = datetime.now(UTC)
        if path.exists():
            existing = ConfigInstance.model_validate(self.read_json(path))
            self.ensure_config_name_available(name, job)
            instance = ConfigInstance(
                name=existing.name,
                job=job,
                values=values,
                schema_hash=schema_hash,
                created_at=existing.created_at,
                updated_at=now,
            )
        else:
            instance = ConfigInstance(
                name=safe_name,
                job=job,
                values=values,
                schema_hash=schema_hash,
                created_at=now,
                updated_at=now,
            )
        self.write_json(path, instance.model_dump(mode="json"))
        return instance

    def delete_config(self, name: str) -> None:
        path = self.configs_root / f"{_safe_name(name)}.json"
        if not path.exists():
            raise _problem("/problems/config-not-found", "Config not found", 404, f"Unknown config: {name}", name=name)
        path.unlink()

    def diff_config(self, name: str, job_schema: dict[str, Any], schema_hash: str, job: str | None = None) -> ConfigDiff:
        instance = self.get_config(name)
        target_job = job or instance.job
        properties = job_schema.get("properties", {})
        migrated_values = dict(instance.values)
        changes: list[ConfigDiffChange] = []
        compatible = True

        for field, schema in properties.items():
            if field not in instance.values:
                if "default" in schema:
                    migrated_values[field] = schema["default"]
                changes.append(ConfigDiffChange(field=field, kind="added", detail="Field exists in current schema but not in saved config."))

        for field in sorted(set(instance.values) - set(properties)):
            migrated_values.pop(field, None)
            changes.append(ConfigDiffChange(field=field, kind="removed", detail="Field no longer exists in current schema."))

        for field, value in instance.values.items():
            schema = properties.get(field)
            if not schema:
                continue
            expected = schema.get("type")
            if expected and not _matches_json_type(value, expected):
                compatible = False
                changes.append(ConfigDiffChange(field=field, kind="type_changed", detail=f"Value no longer matches type {expected}."))
                continue
            if _violates_number_constraints(value, schema):
                compatible = False
                changes.append(ConfigDiffChange(field=field, kind="constraint_changed", detail="Value violates current numeric constraints."))

        if instance.job != target_job:
            compatible = False
        if instance.schema_hash != schema_hash and not changes:
            changes.append(ConfigDiffChange(field="*", kind="constraint_changed", detail="Schema hash changed; no top-level field difference was detected."))
        return ConfigDiff(
            name=instance.name,
            job=target_job,
            compatible=compatible,
            changes=changes,
            migrated_values=migrated_values,
        )

    def compare_runs(self, run_ids: list[str]) -> CompareRunsResponse:
        entries: list[CompareRunEntry] = []
        config_fields: set[str] = set()
        metric_names: set[str] = set()
        for run_id in run_ids:
            detail = self.get_run(run_id)
            config_fields.update(detail.config.keys())
            metrics: dict[str, list[float]] = {}
            for record in self.metrics(run_id, since=-1).records:
                metrics.setdefault(record.name, []).append(record.value)
            metric_names.update(metrics.keys())
            entries.append(
                CompareRunEntry(
                    run_id=run_id,
                    job=detail.job,
                    status=detail.status,
                    config=detail.config,
                    metrics={
                        name: CompareMetricStats(
                            count=len(values),
                            latest=values[-1] if values else None,
                            min=min(values) if values else None,
                            max=max(values) if values else None,
                        )
                        for name, values in metrics.items()
                    },
                )
            )
        config_diffs: list[CompareConfigDiff] = []
        for field in sorted(config_fields):
            values = {
                entry.run_id: entry.config[field]
                for entry in entries
                if field in entry.config
            }
            missing_run_ids = [entry.run_id for entry in entries if field not in entry.config]
            distinct_values = {_stable_json_key(value) for value in values.values()}
            if missing_run_ids or len(distinct_values) > 1:
                config_diffs.append(
                    CompareConfigDiff(
                        field=field,
                        values=values,
                        missing_run_ids=missing_run_ids,
                    )
                )
        return CompareRunsResponse(
            runs=entries,
            config_fields=sorted(config_fields),
            metric_names=sorted(metric_names),
            config_diffs=config_diffs,
        )

    def create_manual_link(self, src: str, dst: str, note: str | None = None) -> ManualLink:
        self._validate_manual_link_node(src)
        self._validate_manual_link_node(dst)
        link = ManualLink(id=secrets.token_hex(8), src=src, dst=dst, note=note)
        with self.links_path.open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(link.model_dump(mode="json"), separators=(",", ":")) + "\n")
            fp.flush()
        return link

    def delete_manual_link(self, link_id: str) -> None:
        links = self.list_manual_links()
        remaining = [link for link in links if link.id != link_id]
        if len(remaining) == len(links):
            raise _problem("/problems/link-not-found", "Link not found", 404, f"Unknown link: {link_id}", link_id=link_id)
        temp = self.links_path.with_suffix(".jsonl.tmp")
        if remaining:
            temp.write_text(
                "".join(json.dumps(link.model_dump(mode="json"), separators=(",", ":")) + "\n" for link in remaining),
                encoding="utf-8",
            )
            os.replace(temp, self.links_path)
        else:
            if self.links_path.exists():
                self.links_path.unlink()
            if temp.exists():
                temp.unlink()

    def list_manual_links(self) -> list[ManualLink]:
        if not self.links_path.exists():
            return []
        links: list[ManualLink] = []
        for line in self.links_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                links.append(ManualLink.model_validate(json.loads(line)))
            except Exception:
                continue
        return links

    def lineage(
        self,
        run_id: str,
        *,
        direction: Literal["ancestors", "descendants", "both"] = "both",
        depth: int = 2,
        include_modules: bool = False,
    ) -> LineageGraph:
        self.require_run_dir(run_id)
        center = f"run:{run_id}"
        node_map: dict[str, LineageNode] = {}
        edges: list[LineageEdge] = []

        def add_node(node_id: str, node_type: Literal["run", "dataset", "module"], label: str, collapsed_into: str | None = None) -> None:
            node_map.setdefault(node_id, LineageNode(id=node_id, type=node_type, label=label, collapsed_into=collapsed_into))

        for summary in self._iter_run_summaries():
            run_node = f"run:{summary.run_id}"
            add_node(run_node, "run", summary.annotations.title or summary.run_id)
            run_dir = self.run_dir(summary.run_id)
            for record in _read_jsonl(run_dir / "inputs.jsonl"):
                if record.get("type") == "uses-dataset" and isinstance(record.get("dataset"), str):
                    dataset_node = f"dataset:{record['dataset']}"
                    add_node(dataset_node, "dataset", record["dataset"])
                    edges.append(LineageEdge(src=dataset_node, dst=run_node, type="uses-dataset"))
                elif record.get("type") == "consumes-artifact" and isinstance(record.get("run_id"), str):
                    source_node = f"run:{record['run_id']}"
                    add_node(source_node, "run", record["run_id"])
                    edges.append(
                        LineageEdge(
                            src=source_node,
                            dst=run_node,
                            type="consumes-artifact",
                            artifact=record.get("artifact"),
                        )
                    )
            if include_modules:
                for node, edge in self._module_lineage(summary.run_id):
                    node_map.setdefault(node.id, node)
                    edges.append(edge)

        for dataset in self.list_datasets():
            add_node(f"dataset:{dataset.name}", "dataset", dataset.name)
            if dataset.source == "builder" and dataset.builder_run_id:
                source_node = f"run:{dataset.builder_run_id}"
                add_node(source_node, "run", dataset.builder_run_id)
                edges.append(LineageEdge(src=source_node, dst=f"dataset:{dataset.name}", type="produces-dataset"))

        for link in self.list_manual_links():
            if not self._is_valid_manual_link(link):
                continue
            if not include_modules and (_is_module_node_id(link.src) or _is_module_node_id(link.dst)):
                continue
            self._add_inferred_node(link.src, node_map)
            self._add_inferred_node(link.dst, node_map)
            edges.append(LineageEdge(src=link.src, dst=link.dst, type="manual", note=link.note, link_id=link.id))

        included_nodes = _lineage_node_ids(center, edges, direction=direction, depth=depth)
        included_nodes.add(center)
        filtered_edges = [edge for edge in edges if edge.src in included_nodes and edge.dst in included_nodes]
        filtered_nodes = [node for node_id, node in node_map.items() if node_id in included_nodes]
        filtered_nodes.sort(key=lambda node: (node.type, node.id))
        return LineageGraph(center=center, nodes=filtered_nodes, edges=filtered_edges)

    def _module_lineage(self, run_id: str) -> list[tuple[LineageNode, LineageEdge]]:
        config = self.read_json(self.run_dir(run_id) / "config.json")
        result: list[tuple[LineageNode, LineageEdge]] = []

        def walk(value: Any, field_path: str) -> None:
            if isinstance(value, dict):
                module_name = value.get("__module__")
                if isinstance(module_name, str):
                    node_id = f"module:{run_id}:{field_path}:{module_name}"
                    result.append(
                        (
                            LineageNode(id=node_id, type="module", label=module_name, collapsed_into=f"run:{run_id}"),
                            LineageEdge(src=node_id, dst=f"run:{run_id}", type="composed-of-module"),
                        )
                    )
                for key, item in value.items():
                    if key == "__module__":
                        continue
                    next_path = f"{field_path}.{key}" if field_path else str(key)
                    walk(item, next_path)
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    walk(item, f"{field_path}[{index}]")

        walk(config, "")
        return result

    def pid_run_map(self) -> dict[int, str]:
        mapping: dict[int, str] = {}
        for summary in self._iter_run_summaries():
            if summary.status != RunStatus.running:
                continue
            meta = self.read_json(self.run_dir(summary.run_id) / "meta.json")
            pid = meta.get("pid")
            if pid is not None:
                mapping[int(pid)] = summary.run_id
        return mapping

    def _iter_run_summaries(self) -> list[RunSummary]:
        summaries: list[RunSummary] = []
        for run_dir in self.runs_root.iterdir():
            if not run_dir.is_dir():
                continue
            try:
                summaries.append(self._summary_from_dir(run_dir))
            except Exception:
                continue
        return summaries

    def _validate_manual_link_node(self, node_id: str) -> None:
        try:
            node_type, label = node_id.split(":", 1)
        except ValueError:
            raise _link_problem(node_id, "Manual link node id must start with run:, dataset:, module:, or artifact:.")

        if node_type == "run":
            if not label or not self.run_dir(label).is_dir():
                raise _link_problem(node_id, f"Unknown run node: {node_id}")
            return
        if node_type == "dataset":
            try:
                dataset_name = _safe_name(label)
            except ProblemException:
                raise _link_problem(node_id, f"Invalid dataset node: {node_id}")
            if not (self.datasets_root / dataset_name / "meta.json").exists():
                raise _link_problem(node_id, f"Unknown dataset node: {node_id}")
            return
        if node_type == "module":
            parts = node_id.split(":")
            if len(parts) < 4:
                raise _link_problem(node_id, f"Invalid module node: {node_id}")
            run_id = parts[1]
            if not run_id or not self.run_dir(run_id).is_dir():
                raise _link_problem(node_id, f"Unknown module run: {node_id}")
            try:
                module_node_ids = {node.id for node, _edge in self._module_lineage(run_id)}
            except Exception:
                raise _link_problem(node_id, f"Unable to inspect module node: {node_id}")
            if node_id not in module_node_ids:
                raise _link_problem(node_id, f"Unknown module node: {node_id}")
            return
        if node_type == "artifact":
            run_id, artifact_path = _parse_artifact_node(node_id)
            artifact_root = self.run_dir(run_id) / "artifacts"
            path = (artifact_root / artifact_path).resolve()
            if not self.run_dir(run_id).is_dir():
                raise _link_problem(node_id, f"Unknown artifact run: {node_id}")
            if not _is_relative_to(path, artifact_root.resolve()) or not path.exists():
                raise _link_problem(node_id, f"Unknown artifact node: {node_id}")
            return

        raise _link_problem(node_id, "Manual link node id must start with run:, dataset:, module:, or artifact:.")

    def _is_valid_manual_link(self, link: ManualLink) -> bool:
        try:
            self._validate_manual_link_node(link.src)
            self._validate_manual_link_node(link.dst)
            return True
        except Exception:
            return False

    def _add_inferred_node(self, node_id: str, node_map: dict[str, LineageNode]) -> None:
        if node_id in node_map:
            return
        try:
            node_type, label = node_id.split(":", 1)
        except ValueError:
            return
        if node_type == "artifact":
            try:
                run_id, artifact_path = _parse_artifact_node(node_id)
            except ProblemException:
                return
            node_map[node_id] = LineageNode(
                id=node_id,
                type="artifact",
                label=str(artifact_path),
                collapsed_into=f"run:{run_id}",
            )
        elif node_type in {"run", "dataset", "module"}:
            node_map[node_id] = LineageNode(id=node_id, type=node_type, label=label)

    def _summary_from_dir(self, run_dir: Path) -> RunSummary:
        meta = self.read_json(run_dir / "meta.json")
        status_data = self._status_data(run_dir)
        status = RunStatus(status_data["status"])
        return RunSummary(
            run_id=meta["run_id"],
            kind=meta.get("kind", "job"),
            job=meta["job"],
            status=status,
            gpus=list(meta.get("gpus", [])),
            created_at=datetime.fromisoformat(meta["created_at"]),
            started_at=_parse_dt(meta.get("started_at")),
            ended_at=_parse_dt(status_data.get("ended_at")),
            annotations=self.read_annotations(meta["run_id"]),
        )

    def _ensure_groups_exist(self, group_ids: list[str]) -> None:
        for group_id in group_ids:
            self.get_group(group_id)

    def _status_data(self, run_dir: Path) -> dict[str, Any]:
        status_path = run_dir / "status.json"
        if status_path.exists():
            return self.read_json(status_path)
        meta = self.read_json(run_dir / "meta.json")
        pid = meta.get("pid")
        create_time = meta.get("create_time")
        if pid and _pid_matches(int(pid), create_time):
            heartbeat = run_dir / "heartbeat"
            if heartbeat.exists() and time.time() - heartbeat.stat().st_mtime > 30:
                return {"status": RunStatus.unknown.value, "ended_at": None, "exit_code": None, "error": "Heartbeat is stale."}
            return {"status": RunStatus.running.value, "ended_at": None, "exit_code": None, "error": None}
        if pid is None:
            return {"status": RunStatus.unknown.value, "ended_at": None, "exit_code": None, "error": None}
        return {"status": RunStatus.unknown.value, "ended_at": None, "exit_code": None, "error": None}


def _pid_matches(pid: int, create_time: float | None) -> bool:
    try:
        process = psutil.Process(pid)
        if create_time is None:
            return process.is_running()
        return abs(process.create_time() - float(create_time)) < 0.01
    except psutil.Error:
        return False


def _parse_dt(value: str | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(value)


def _path_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(child.stat().st_size for child in path.rglob("*") if child.is_file())


def _stable_json_key(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    except TypeError:
        return repr(value)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def _is_module_node_id(node_id: str) -> bool:
    return node_id.startswith("module:")


def _parse_artifact_node(node_id: str) -> tuple[str, Path]:
    parts = node_id.split(":", 2)
    if len(parts) != 3 or parts[0] != "artifact" or not parts[1] or not parts[2]:
        raise _link_problem(node_id, f"Invalid artifact node: {node_id}")
    artifact_path = Path(parts[2])
    if artifact_path.is_absolute() or any(part in {"", ".", ".."} for part in artifact_path.parts):
        raise _link_problem(node_id, f"Invalid artifact path: {node_id}")
    return parts[1], artifact_path


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _lineage_node_ids(
    center: str,
    edges: list[LineageEdge],
    *,
    direction: Literal["ancestors", "descendants", "both"],
    depth: int,
) -> set[str]:
    incoming: dict[str, set[str]] = {}
    outgoing: dict[str, set[str]] = {}
    for edge in edges:
        outgoing.setdefault(edge.src, set()).add(edge.dst)
        incoming.setdefault(edge.dst, set()).add(edge.src)
    visited = {center}
    frontier = {center}
    for _ in range(max(depth, 0)):
        next_frontier: set[str] = set()
        for node_id in frontier:
            if direction in {"ancestors", "both"}:
                next_frontier.update(incoming.get(node_id, set()))
            if direction in {"descendants", "both"}:
                next_frontier.update(outgoing.get(node_id, set()))
        next_frontier -= visited
        if not next_frontier:
            break
        visited.update(next_frontier)
        frontier = next_frontier
    return visited


def _safe_name(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise _problem(
            "/problems/invalid-name",
            "Invalid name",
            422,
            "Name must contain only letters, digits, underscore, dot, and hyphen.",
            name=name,
        )
    return name


def _slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", value.strip()).strip("-").lower()
    return slug or "group"


def _matches_json_type(value: Any, expected: str | list[str]) -> bool:
    expected_types = expected if isinstance(expected, list) else [expected]
    for item in expected_types:
        if item == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
            return True
        if item == "integer" and isinstance(value, int) and not isinstance(value, bool):
            return True
        if item == "string" and isinstance(value, str):
            return True
        if item == "boolean" and isinstance(value, bool):
            return True
        if item == "array" and isinstance(value, list):
            return True
        if item == "object" and isinstance(value, dict):
            return True
        if item == "null" and value is None:
            return True
    return False


def _violates_number_constraints(value: Any, schema: dict[str, Any]) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    if "minimum" in schema and value < schema["minimum"]:
        return True
    if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
        return True
    if "maximum" in schema and value > schema["maximum"]:
        return True
    if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
        return True
    return False


def _problem(type: str, title: str, status: int, detail: str, **extensions: Any) -> ProblemException:
    return ProblemException(type=type, title=title, status=status, detail=detail, **extensions)


def _link_problem(node_id: str, detail: str) -> ProblemException:
    return _problem(
        "/problems/link-validation-failed",
        "Link validation failed",
        422,
        detail,
        node_id=node_id,
    )
