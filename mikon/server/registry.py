from __future__ import annotations

import threading
from typing import Any

from watchfiles import watch

from mikon.server.discovery import discover_subprocess
from mikon.server.settings import Settings


class Registry:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.RLock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._modules: dict[str, dict[str, Any]] = {}
        self._dataset_builders: dict[str, dict[str, Any]] = {}
        self.stale = False
        self.error: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def refresh(self) -> None:
        result = discover_subprocess(self.settings)
        with self._lock:
            if result.ok:
                self._jobs = result.jobs
                self._modules = result.modules
                self._dataset_builders = result.dataset_builders
                self.stale = False
                self.error = None
            else:
                self.stale = bool(self._jobs)
                self.error = result.error

    def list_jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {key: value for key, value in job.items() if key not in {"json_schema", "ui_schema"}}
                for job in sorted(self._jobs.values(), key=lambda item: item["name"])
            ]

    def get_job(self, name: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(name)
            return dict(job) if job is not None else None

    def list_modules(self, implements: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            modules = self._modules.values()
            if implements:
                modules = [module for module in modules if module["implements"] == implements]
            return [
                {key: value for key, value in module.items() if key not in {"json_schema", "ui_schema"}}
                for module in sorted(modules, key=lambda item: item["name"])
            ]

    def get_module(self, name: str) -> dict[str, Any] | None:
        with self._lock:
            module = self._modules.get(name)
            return dict(module) if module is not None else None

    def list_dataset_builders(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {key: value for key, value in builder.items() if key not in {"json_schema", "ui_schema"}}
                for builder in sorted(self._dataset_builders.values(), key=lambda item: item["name"])
            ]

    def get_dataset_builder(self, name: str) -> dict[str, Any] | None:
        with self._lock:
            builder = self._dataset_builders.get(name)
            return dict(builder) if builder is not None else None

    def has_any_entries(self) -> bool:
        with self._lock:
            return bool(self._jobs or self._modules or self._dataset_builders)

    def start_watching(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._watch_loop, name="mikon-discovery", daemon=True)
        self._thread.start()

    def stop_watching(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    def _watch_loop(self) -> None:
        watch_paths = [str(path) for path in self.settings.watch if path.exists()]
        if not watch_paths:
            return
        for _changes in watch(*watch_paths, stop_event=self._stop, debounce=500):
            self.refresh()
