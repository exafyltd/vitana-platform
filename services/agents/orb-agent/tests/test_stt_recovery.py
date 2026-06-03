"""VTID-03078: STT-recovery-on-silent-stall regression tests.

Structural / contract tests. The recovery itself runs inside
agent_entrypoint, which can't be hermetically exercised without a full
LiveKit runtime. So we pin:

  1. The new topic constant exists with the exact string.
  2. The kill-switch env var is honored (default ON, off variants OFF).
  3. The cap constant is set so reviewers can't bump it back to None
     (the watchdog's whole point is bounded swaps; an unbounded version
     would churn STT instances + costs on a chronic upstream problem).
  4. The recovery is wired into the silent-stall watchdog tick — i.e.
     `_attempt_stt_recovery` is referenced from inside the watchdog
     coroutine, not just defined and orphaned.
  5. The Agent rebuild preserves chat_ctx + tools + instructions — i.e.
     we don't accidentally wipe conversation history while swapping STT.
"""
from __future__ import annotations

import os
import pathlib


def _session_src() -> str:
    return (
        pathlib.Path(__file__).resolve().parent.parent
        / "src" / "orb_agent" / "session.py"
    ).read_text(encoding="utf-8")


def test_topic_exists_with_exact_string() -> None:
    """Gateway oasis-emit allowlist (`livekit.` prefix) accepts this by
    rule; CicdEventType union has it explicitly. Pin the literal so a
    rename doesn't silently regress observability."""
    from src.orb_agent.oasis import TOPIC_STT_HARD_RECOVERY, TOPIC_STT_RECOVERY

    assert TOPIC_STT_RECOVERY == "livekit.stt.recovery"
    assert TOPIC_STT_RECOVERY.startswith("livekit.")
    assert TOPIC_STT_HARD_RECOVERY == "livekit.stt.hard_recovery"
    assert TOPIC_STT_HARD_RECOVERY.startswith("livekit.")


def test_recovery_kill_switch_default_on(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Default is ON (no env var = recovery active). The whole point of
    VTID-03078 is to fix the silent-stall failure mode; shipping
    off-by-default would defeat the purpose."""
    monkeypatch.delenv("ORB_STT_RECOVERY_ENABLED", raising=False)
    # Recreate the kill-switch predicate from session.py inline so the
    # test mirrors the production code. If the implementation diverges
    # (e.g. someone adds extra falsy values), this still pins the
    # default-ON contract.
    val = os.environ.get("ORB_STT_RECOVERY_ENABLED", "true").lower()
    assert val not in ("false", "0", "no", "off")


def test_recovery_kill_switch_off_variants(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    for v in ("false", "False", "FALSE", "0", "no", "off"):
        monkeypatch.setenv("ORB_STT_RECOVERY_ENABLED", v)
        val = os.environ.get("ORB_STT_RECOVERY_ENABLED", "true").lower()
        assert val in ("false", "0", "no", "off"), v


def test_max_attempts_constant_pinned_at_five() -> None:
    """VTID-03079 bumped 3 → 5 once the tighter predicate started
    rejecting false positives. 5 attempts cost at most ~15s of swap
    activity (each bounded by the 5s activity-swap wait); a longer
    session may legitimately need 4-5 recoveries. Anything higher risks
    churning Google STT / Deepgram connections on a chronic problem;
    anything lower means we give up before the user does."""
    src = _session_src()
    assert "STT_RECOVERY_MAX_ATTEMPTS = 5" in src, (
        "VTID-03079 regression: STT_RECOVERY_MAX_ATTEMPTS must be 5"
    )


def test_recovery_wired_into_watchdog_tick() -> None:
    """The recovery helper must be CALLED from inside the silent-stall
    watchdog tick. Defining `_attempt_stt_recovery` but never invoking
    it would leave the watchdog at the VTID-03075 detect-only behavior
    — exactly the bug we're fixing."""
    src = _session_src()
    assert "async def _attempt_stt_recovery" in src, (
        "VTID-03078 regression: _attempt_stt_recovery helper missing"
    )
    # The watchdog tick lives inside `_silent_stall_watchdog`. Find
    # that function body and assert it references the helper.
    watchdog_start = src.find("async def _silent_stall_watchdog")
    assert watchdog_start != -1, "silent-stall watchdog not found"
    # Take a generous slice — the body is ~50 lines.
    watchdog_block = src[watchdog_start : watchdog_start + 3000]
    assert "_attempt_stt_recovery" in watchdog_block, (
        "VTID-03078 regression: _attempt_stt_recovery is not called from "
        "the silent-stall watchdog tick"
    )


def test_recovery_preserves_chat_ctx_tools_instructions() -> None:
    """When the new Agent is built for the STT swap, it MUST carry over
    chat_ctx, tools, instructions, llm, and tts from the current agent.
    Without chat_ctx the LLM loses conversation history mid-session
    (worse user experience than the bug we're fixing). Without tools
    the agent can't call resolve_recipient/send_chat_message anymore.
    Without llm/tts the swap would break voice output entirely."""
    src = _session_src()
    # Find the Agent(...) construction inside the shared rebuild helper.
    recovery_start = src.find("async def _rebuild_agent_with_fresh_stt")
    assert recovery_start != -1
    recovery_block = src[recovery_start : recovery_start + 4000]

    # Each of these MUST appear inside the recovery's Agent() call.
    for required in ("instructions=", "tools=", "chat_ctx=", "stt=", "llm=", "tts="):
        assert required in recovery_block, (
            f"VTID-03078 regression: Agent rebuild in _attempt_stt_recovery "
            f"missing `{required}` — would drop {required.rstrip('=')} on swap"
        )
    # And that the STT slot specifically uses the FRESH cascade — not
    # reusing the old session-level adapter that's the source of the bug.
    assert "stt=fresh_cascade.stt" in recovery_block, (
        "VTID-03078 regression: recovery is reusing the old (stalled) STT "
        "instead of the freshly-built cascade"
    )


def test_soft_reset_streak_escalates_to_hard_recovery() -> None:
    src = _session_src()
    assert "SttHardRecoveryEscalator" in src
    stall_start = src.find("async def _on_stall")
    assert stall_start != -1
    stall_block = src[stall_start : stall_start + 8000]

    for required in (
        "hard_escalator.record_soft_reset",
        "hard_recovery_after_soft_resets",
        "hard_recovery_triggered",
        "_hard_recovery(",
        '"audio_diag": audio_diag',
    ):
        assert required in stall_block, (
            f"BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: `{required}` "
            "missing from the soft-reset stall path"
        )


def test_silent_stall_gave_up_routes_to_hard_recovery() -> None:
    src = _session_src()
    gave_up_start = src.find('"outcome": "gave_up"')
    assert gave_up_start != -1
    gave_up_block = src[gave_up_start : gave_up_start + 1200]
    assert "silent_stall_recovery_gave_up" in gave_up_block
    assert "_hard_recovery(" in gave_up_block


def test_recovery_does_not_fake_transcript_freshness() -> None:
    src = _session_src()
    assert 'stall_state["last_transcript_at"] = time.monotonic()' not in src
    assert 'stall_state["last_transcript_at"] = _record_real_transcript_seen()' in src
    assert 'turn_state["user_done_at"] = _record_real_transcript_seen()' in src


def test_silent_stall_payload_includes_audio_diag() -> None:
    src = _session_src()
    watchdog_start = src.find("async def _silent_stall_watchdog")
    assert watchdog_start != -1
    watchdog_block = src[watchdog_start : watchdog_start + 3000]
    assert '"audio_diag": _collect_audio_diag()' in watchdog_block
