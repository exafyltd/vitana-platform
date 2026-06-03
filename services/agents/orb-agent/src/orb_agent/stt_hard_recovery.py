"""STT hard-recovery escalation helpers.

The live session wiring lives in ``session.py`` because it closes over the
LiveKit room/session objects. This module keeps the escalation policy tiny and
unit-testable: soft-reset churn is allowed, but if transcripts do not resume
after a short streak, the caller must switch to hard recovery.
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

HARD_RECOVERY_AFTER = 2


class SttHardRecoveryEscalator:
    """Tracks consecutive soft STT resets and decides when to escalate."""

    def __init__(self, *, threshold: int = HARD_RECOVERY_AFTER) -> None:
        if threshold < 1:
            raise ValueError("threshold must be >= 1")
        self.threshold = threshold
        self.consecutive_soft_resets = 0
        self._streak_transcript_at: float | None = None
        self._triggered_for_streak = False

    def record_transcript(self, transcript_at: float) -> None:
        """A real transcript proves STT recovered; reset the streak."""
        self.consecutive_soft_resets = 0
        self._streak_transcript_at = transcript_at
        self._triggered_for_streak = False

    def record_soft_reset(self, transcript_at: float | None) -> bool:
        """Record one soft reset.

        Returns True exactly once per no-transcript streak when the caller
        should run hard recovery.
        """
        if self.consecutive_soft_resets == 0:
            self._streak_transcript_at = transcript_at
            self._triggered_for_streak = False

        self.consecutive_soft_resets += 1
        transcript_unchanged = transcript_at == self._streak_transcript_at
        should_escalate = (
            self.consecutive_soft_resets >= self.threshold
            and transcript_unchanged
            and not self._triggered_for_streak
        )
        if should_escalate:
            self._triggered_for_streak = True
        return should_escalate


class HardRecoveryGate:
    """Runs at most one hard recovery at a time."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._running = False

    async def run(self, recovery: Callable[[], Awaitable[None]]) -> bool:
        """Run ``recovery`` unless another hard recovery is already active.

        Returns True when this call ran the recovery, False when it was skipped
        because another call was already in progress.
        """
        async with self._lock:
            if self._running:
                return False
            self._running = True
        try:
            await recovery()
            return True
        finally:
            async with self._lock:
                self._running = False
