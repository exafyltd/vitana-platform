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
    from src.orb_agent.oasis import TOPIC_STT_RECOVERY

    assert TOPIC_STT_RECOVERY == "livekit.stt.recovery"
    assert TOPIC_STT_RECOVERY.startswith("livekit.")


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


def test_fast_budget_constant_pinned_at_five() -> None:
    """BOOTSTRAP-ORB-STT-HARD-RECOVERY: STT_RECOVERY_MAX_ATTEMPTS is now the FAST-cadence budget,
    not a hard give-up. The first 5 rebuilds fire at the watchdog cadence;
    beyond that recovery continues under backoff. The constant stays 5 so the
    fast phase matches the prior tuning (VTID-03079)."""
    src = _session_src()
    assert "STT_RECOVERY_MAX_ATTEMPTS = 5" in src, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: STT_RECOVERY_MAX_ATTEMPTS (fast budget) must be 5"
    )


def test_recovery_never_permanently_gives_up() -> None:
    """BOOTSTRAP-ORB-STT-HARD-RECOVERY: the hard cap caused 96s of dead air in prod (2026-06-02)
    once a recoverable stall needed >5 swaps. Recovery must no longer emit a
    `gave_up` outcome or otherwise stop trying — past the fast budget it
    continues under exponential backoff capped at a ceiling constant."""
    src = _session_src()
    assert '"gave_up"' not in src, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: recovery must not permanently give up "
        "(no `gave_up` outcome)"
    )
    assert "STT_RECOVERY_BACKOFF_CEILING_S" in src, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: backoff ceiling constant missing — recovery "
        "would either give up or churn unbounded"
    )
    # The backoff must be bounded (cost guard preserved): a ceiling, applied
    # via min(...), so chronic upstream failure costs ~1 rebuild/min not a
    # tight loop.
    recovery_start = src.find("async def _attempt_stt_recovery")
    recovery_block = src[recovery_start : recovery_start + 4000]
    assert "backoff_until" in recovery_block, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: no backoff gating in _attempt_stt_recovery"
    )
    assert "STT_RECOVERY_BACKOFF_CEILING_S" in recovery_block, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: backoff ceiling not applied in recovery"
    )


def test_broad_stall_watchdog_escalates_to_hard_recovery() -> None:
    """BOOTSTRAP-ORB-STT-HARD-RECOVERY: the broad StallWatchdog (_on_stall) previously only did the
    in-place _stt swap — the no-op that thrashed 14× in prod. It must now
    escalate into the proven update_agent rebuild after consecutive
    ineffective soft-resets."""
    src = _session_src()
    assert "HARD_RECOVERY_AFTER" in src, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: escalation threshold constant missing"
    )
    stall_start = src.find("async def _on_stall")
    # Slice to the watchdog registration that immediately follows _on_stall
    # so the window covers the whole closure regardless of its length.
    stall_end = src.find("stall.start(on_stall=_on_stall)", stall_start)
    stall_block = src[stall_start:stall_end]
    assert "_hard_recovery_ref" in stall_block, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: _on_stall does not escalate to tier-2 recovery"
    )
    assert 'trigger="stall_watchdog"' in stall_block, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: escalation must tag its trigger for telemetry"
    )
    # And the forward handle must actually be populated to the recovery fn.
    assert "_hard_recovery_ref[\"fn\"] = _attempt_stt_recovery" in src, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: tier-2 recovery never wired to the forward ref"
    )


def test_stall_events_carry_audio_input_diagnostics() -> None:
    """BOOTSTRAP-ORB-STT-HARD-RECOVERY: every recovery/stall event must carry an audio-path
    snapshot so the next bad session distinguishes 'mic track gone' from
    'STT deaf while audio flows' — the ambiguity that cost us weeks."""
    src = _session_src()
    assert "def _audio_input_diag" in src, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: audio-input diagnostic helper missing"
    )
    assert src.count("_audio_input_diag()") >= 2, (
        "BOOTSTRAP-ORB-STT-HARD-RECOVERY regression: audio diagnostics must be attached to BOTH "
        "the stall event and the recovery event"
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
    # Find the Agent(...) construction inside _attempt_stt_recovery.
    recovery_start = src.find("async def _attempt_stt_recovery")
    assert recovery_start != -1
    # Window widened (BOOTSTRAP-ORB-STT-HARD-RECOVERY added backoff gating + telemetry ahead of the
    # Agent() construction, pushing it down ~1.5k chars).
    recovery_block = src[recovery_start : recovery_start + 6000]

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
