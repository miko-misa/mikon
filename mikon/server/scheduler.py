from __future__ import annotations

import asyncio

from mikon.server.models import RunStatus
from mikon.server.runner import Runner
from mikon.server.store import TERMINAL_STATUSES, UPSTREAM_FAILURE_STATUSES, Store


class ChainScheduler:
    """Background driver that advances pending job-chain steps.

    The server has no other resident loop, so this periodically scans pending
    runs and, when their upstream dependencies have completed, launches them via
    the runner. Failures are propagated according to each step's
    ``on_upstream_failure`` policy.
    """

    def __init__(self, store: Store, runner: Runner, *, interval: float = 1.0) -> None:
        self.store = store
        self.runner = runner
        self.interval = interval
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()

    def start(self) -> None:
        if self._task is None:
            self._stop.clear()
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.get_running_loop().run_in_executor(None, self._safe_tick)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.interval)
            except asyncio.TimeoutError:
                pass

    def _safe_tick(self) -> None:
        try:
            self.tick()
        except Exception:
            pass

    def tick(self) -> None:
        """Evaluate every pending run once (safe to call directly in tests)."""
        for run_id in self.store.list_pending_run_ids():
            try:
                self._evaluate(run_id)
            except Exception:
                pass

    def _evaluate(self, run_id: str) -> None:
        meta = self.store.read_meta(run_id)
        if not meta.get("pending"):
            return
        depends_on = list(meta.get("depends_on", []))
        statuses = {dep: self.store.run_status(dep) for dep in depends_on}

        failed = [dep for dep, status in statuses.items() if status in UPSTREAM_FAILURE_STATUSES]
        if failed:
            if meta.get("on_upstream_failure", "cancel") == "cancel":
                self.store.cancel_chain(
                    run_id, f"Upstream {failed[0]} ended as {statuses[failed[0]].value}."
                )
                return
            # "continue" policy: fall through and launch once all upstreams settle.

        not_settled = [dep for dep, status in statuses.items() if status not in TERMINAL_STATUSES]
        if not_settled:
            self.store.set_pending_reason(run_id, "waiting-for-upstream")
            return

        self.runner.launch_pending_run(run_id)
