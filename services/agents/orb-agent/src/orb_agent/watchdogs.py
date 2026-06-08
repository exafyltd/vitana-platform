"""Stall watchdog + reconnect-bucket counter.

Mirrors VTID-WATCHDOG (orb-live.ts:7320) and VTID-STREAM-RECONNECT
(orb-live.ts:9280). The tool-loop guard is **NOT** custom-coded here — we
use livekit-agents' built-in `AgentSession(max_tool_steps=N)` which
auto-enforces tool_choice='none' at the threshold.

Constants below are walked by the parity scanner — names match
voice-pipeline-spec/spec.json.watchdogs.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Parity-spec watchdogs (names mirror voice-pipeline-spec/spec.json)
SESSION_TIMEOUT_MS = 30 * 60 * 1000  # 30 min
MAX_SESSION_AGE_MS = 30 * 60 * 1000  # 30 min — same as SESSION_TIMEOUT_MS
CONVERSATION_TIMEOUT_MS = 24 * 60 * 60 * 1000  # 24 h
TRANSCRIPT_RETENTION_MS = 60 * 60 * 1000  # 1 h
IP_GEO_CACHE_TTL_MS = 60 * 60 * 1000  # 1 h
MAX_CONNECTIONS_PER_IP = 5
MAX_RECONNECTS = 10
MAX_TOOL_RESPONSE_CHARS = 4000
MAX_HISTORY_CHARS = 4000
EXTRACTION_THROTTLE_MS = 60_000
BOOTSTRAP_REBUILD_MIN_AGE_MS = 60_000

# Stall watchdog: no agent OR user activity (speech_created, agent state
# transition, user state transition) for this long → emit OASIS event +
# soft-reset STT (VTID-03004 / VTID-03005).
# History:
#  - originally 8s (false-fired on conversational pauses)
#  - bumped 8s → 30s by PR-VTID-02854 to avoid false-fires
#  - lowered 30s → 10s by VTID-03005 once the watchdog could recover via
#    soft STT swap instead of just being telemetry. Faster detection +
#    cheap recovery beats slow detection + dead air for the user.
STALL_THRESHOLD_MS = 10_000


@dataclass
class ReconnectBucket:
    """Tracks reconnect attempts within a session. Caps at MAX_RECONNECTS."""

    count: int = 0

    def record_attempt(self) -> bool:
        """Returns True if reconnect is allowed, False if cap reached."""
        if self.count >= MAX_RECONNECTS:
            return False
        self.count += 1
        return True


class StallWatchdog:
    """Async watchdog that fires a callback if no `feed()` arrives within
    `threshold_ms` of the last one. Reset on every `feed()`."""

    def __init__(self, threshold_ms: int = STALL_THRESHOLD_MS) -> None:
        self._threshold_s = threshold_ms / 1000.0
        self._task: asyncio.Task[None] | None = None
        self._fed = asyncio.Event()
        self._cb: callable | None = None  # type: ignore[type-arg]
        self._stopped = False

    def start(self, on_stall: callable) -> None:  # type: ignore[type-arg]
        self._cb = on_stall
        self._stopped = False
        self._task = asyncio.create_task(self._loop())

    def feed(self) -> None:
        self._fed.set()

    async def stop(self) -> None:
        self._stopped = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        while not self._stopped:
            self._fed.clear()
            try:
                await asyncio.wait_for(self._fed.wait(), timeout=self._threshold_s)
            except TimeoutError:
                logger.warning("StallWatchdog fired (no feed in %ss)", self._threshold_s)
                if self._cb is not None:
                    try:
                        await self._cb()
                    except Exception as exc:  # noqa: BLE001
                        logger.exception("StallWatchdog callback failed: %s", exc)
                # After firing, wait for the next feed before re-arming, to
                # avoid a tight loop if the callback can't unblock immediately.
                await self._fed.wait()
