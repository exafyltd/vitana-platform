"""BOOTSTRAP-ORB-STT-HARD-RECOVERY policy tests."""
from __future__ import annotations

import asyncio

import pytest

from src.orb_agent.stt_hard_recovery import (
    HARD_RECOVERY_AFTER,
    HardRecoveryGate,
    SttHardRecoveryEscalator,
)


def test_two_consecutive_soft_resets_without_transcript_escalates_once() -> None:
    escalator = SttHardRecoveryEscalator(threshold=HARD_RECOVERY_AFTER)

    assert escalator.record_soft_reset(None) is False
    assert escalator.record_soft_reset(None) is True
    assert escalator.record_soft_reset(None) is False


def test_transcript_between_stalls_resets_streak() -> None:
    escalator = SttHardRecoveryEscalator(threshold=HARD_RECOVERY_AFTER)

    assert escalator.record_soft_reset(None) is False
    escalator.record_transcript(10.0)

    assert escalator.record_soft_reset(10.0) is False
    assert escalator.consecutive_soft_resets == 1


@pytest.mark.asyncio
async def test_hard_recovery_gate_skips_concurrent_invocations() -> None:
    gate = HardRecoveryGate()
    calls = 0
    entered = asyncio.Event()
    release = asyncio.Event()

    async def recovery() -> None:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()

    first = asyncio.create_task(gate.run(recovery))
    await entered.wait()
    second_ran = await gate.run(recovery)
    release.set()

    assert second_ran is False
    assert await first is True
    assert calls == 1
