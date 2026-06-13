from __future__ import annotations

import json
import math
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any


class RunContext:
    """Runtime handle injected into mikon jobs."""

    def __init__(self, run_dir: str | os.PathLike[str] | None = None) -> None:
        raw_run_dir = run_dir or os.environ.get("MIKON_RUN_DIR")
        if not raw_run_dir:
            raise RuntimeError("RunContext requires run_dir or MIKON_RUN_DIR")
        self.run_dir = Path(raw_run_dir)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.artifacts_dir = self.run_dir / "artifacts"
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self._metric_lock = threading.Lock()
        self._artifact_lock = threading.Lock()
        self._input_lock = threading.Lock()

    def log_metric(self, name: str, value: int | float, step: int | None = None) -> None:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("metric name must be a non-empty string")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError("metric value must be int or float, but not bool")
        if not math.isfinite(float(value)):
            raise ValueError("metric value must be finite")
        record: dict[str, Any] = {
            "t": time.time(),
            "step": step,
            "name": name,
            "value": float(value),
        }
        metrics_path = self.run_dir / "metrics.jsonl"
        with self._metric_lock:
            with metrics_path.open("a", encoding="utf-8") as fp:
                fp.write(json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n")
                fp.flush()

    def log_artifact(self, name: str, path: str | os.PathLike[str]) -> Path:
        source = Path(path)
        if not source.exists():
            raise FileNotFoundError(source)

        artifact_path = _validate_artifact_name(name)
        destination = (self.artifacts_dir / artifact_path).resolve()
        artifacts_root = self.artifacts_dir.resolve()
        if not _is_relative_to(destination, artifacts_root):
            raise ValueError("artifact name must stay within artifacts_dir")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.resolve() != destination.resolve():
            if source.is_dir():
                if destination.exists():
                    shutil.rmtree(destination)
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)

        record = {
            "t": time.time(),
            "name": name,
            "path": str(destination.relative_to(self.artifacts_dir)),
            "size": _path_size(destination),
        }
        with self._artifact_lock:
            with (self.run_dir / "artifacts.jsonl").open("a", encoding="utf-8") as fp:
                fp.write(json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n")
                fp.flush()
        return destination

    def use_dataset(self, name: str) -> Path:
        dataset_name = _validate_name(name, "dataset")
        meta_path = _store_root(self.run_dir) / "datasets" / dataset_name / "meta.json"
        if not meta_path.exists():
            raise FileNotFoundError(f"dataset not registered: {dataset_name}")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        path = Path(meta["path"]).resolve()
        if not path.exists():
            raise FileNotFoundError(path)
        self._log_input(
            {
                "type": "uses-dataset",
                "dataset": dataset_name,
                "path": str(path),
            }
        )
        return path

    def use_artifact(self, run_id: str, name: str) -> Path:
        source_run_id = _validate_run_id(run_id)
        artifact_path = _validate_artifact_name(name)
        store_root = _store_root(self.run_dir)
        artifacts_root = (store_root / "runs" / source_run_id / "artifacts").resolve()
        path = (artifacts_root / artifact_path).resolve()
        if not _is_relative_to(path, artifacts_root) or not path.exists():
            raise FileNotFoundError(path)
        self._log_input(
            {
                "type": "consumes-artifact",
                "run_id": source_run_id,
                "artifact": str(artifact_path),
                "path": str(path),
            }
        )
        return path

    def _log_input(self, record: dict[str, Any]) -> None:
        payload = {"t": time.time(), **record}
        with self._input_lock:
            with (self.run_dir / "inputs.jsonl").open("a", encoding="utf-8") as fp:
                fp.write(json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n")
                fp.flush()


def _path_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(child.stat().st_size for child in path.rglob("*") if child.is_file())


def _validate_artifact_name(name: str) -> Path:
    if not isinstance(name, str) or not name.strip():
        raise ValueError("artifact name must be a non-empty relative path")
    path = Path(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("artifact name must be a safe relative path")
    return path


def _validate_name(name: str, label: str) -> str:
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise ValueError(f"{label} name must contain only letters, digits, underscore, dot, and hyphen")
    return name


def _validate_run_id(run_id: str) -> str:
    if not isinstance(run_id, str) or run_id in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9_.-]+", run_id):
        raise ValueError("run_id must be a safe path segment")
    return run_id


def _store_root(run_dir: Path) -> Path:
    if os.environ.get("MIKON_STORE"):
        return Path(os.environ["MIKON_STORE"]).resolve()
    if run_dir.parent.name == "runs":
        return run_dir.parent.parent
    return run_dir


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
