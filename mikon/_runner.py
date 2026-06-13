from __future__ import annotations

import argparse
import json
import signal
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import TextIO

from mikon.sdk.datasets import DatasetContext, get_dataset_registry
from mikon.sdk.context import RunContext
from mikon.sdk.job import get_registry
from mikon.sdk.module import instantiate_config_modules, validate_module_nest_depth
from mikon.server.discovery import import_project
from mikon.server.models import RunStatus
from mikon.server.settings import load_settings
from mikon.server.store import Store


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    args = parser.parse_args(argv)
    run_dir = Path(args.run_dir).resolve()
    store = Store(run_dir.parents[1])
    meta = store.read_json(run_dir / "meta.json")
    run_id = meta["run_id"]

    stop_event = threading.Event()
    heartbeat = threading.Thread(
        target=_heartbeat_loop, args=(run_dir, stop_event), name="mikon-heartbeat", daemon=True
    )
    heartbeat.start()

    def _handle_signal(signum: int, frame: object) -> None:
        raise KeyboardInterrupt(f"received signal {signum}")

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    status = RunStatus.completed
    exit_code = 0
    error: str | None = None
    event_logger = _LogEventWriter(run_dir / "logs" / "events.jsonl")
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    sys.stdout = _TeeLineWriter(original_stdout, event_logger, "stdout")
    sys.stderr = _TeeLineWriter(original_stderr, event_logger, "stderr")
    try:
        project_root = Path(meta["project_root"]).resolve()
        watch_paths = [Path(item).resolve() for item in meta["watch"]]
        import_project(project_root, watch_paths)
        kind = meta.get("kind", "job")
        if kind == "dataset":
            definition = get_dataset_registry().get(meta["job"])
        else:
            definition = get_registry().get(meta["job"])
        if definition is None:
            raise RuntimeError(f"{kind} not found during run: {meta['job']}")
        config_data = store.read_json(run_dir / "config.json")
        settings = load_settings(project_root)
        validate_module_nest_depth(config_data, settings.max_module_nest_depth)
        config = definition.config_type.model_validate(config_data)
        validate_module_nest_depth(config.model_dump(mode="json"), settings.max_module_nest_depth)
        instantiate_config_modules(config, max_depth=settings.max_module_nest_depth)
        ctx = DatasetContext(run_dir, meta["job"]) if kind == "dataset" else RunContext(run_dir)
        definition.func(config, ctx)
    except KeyboardInterrupt as exc:
        status = RunStatus.stopped
        exit_code = 143
        error = str(exc)
    except BaseException:
        status = RunStatus.failed
        exit_code = 1
        error = traceback.format_exc()
    finally:
        sys.stdout = original_stdout
        sys.stderr = original_stderr
        event_logger.flush()
        stop_event.set()
        heartbeat.join(timeout=1)
        store.write_status(run_id, status, exit_code, error)
    return exit_code


def _heartbeat_loop(run_dir: Path, stop_event: threading.Event) -> None:
    heartbeat = run_dir / "heartbeat"
    while not stop_event.is_set():
        heartbeat.write_text(str(time.time()), encoding="utf-8")
        stop_event.wait(2)


class _LogEventWriter:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._seq = 0

    def write_line(self, stream: str, line: str) -> None:
        with self._lock:
            record = {"seq": self._seq, "t": time.time(), "stream": stream, "line": line}
            self._seq += 1
            with self.path.open("a", encoding="utf-8") as fp:
                fp.write(json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n")
                fp.flush()

    def flush(self) -> None:
        return


class _TeeLineWriter:
    def __init__(self, target: TextIO, event_logger: _LogEventWriter, stream: str) -> None:
        self.target = target
        self.event_logger = event_logger
        self.stream = stream
        self._buffer = ""

    def write(self, text: str) -> int:
        written = self.target.write(text)
        self.target.flush()
        self._buffer += text
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            self.event_logger.write_line(self.stream, line)
        return written

    def flush(self) -> None:
        self.target.flush()
        if self._buffer:
            self.event_logger.write_line(self.stream, self._buffer)
            self._buffer = ""

    def isatty(self) -> bool:
        return self.target.isatty()

    @property
    def encoding(self) -> str | None:
        return self.target.encoding


if __name__ == "__main__":
    raise SystemExit(main())
