"""BOOTSTRAP-VOICE-DATASET-EMITTER (LiveKit parity) — orb.turn.responded emit.

The LiveKit agent previously contributed ZERO rows to the voice-tool-routing
dataset because it never emitted `orb.turn.responded` (only the Vertex path
did). These structural tests pin the wiring that closes that gap. The emit
itself runs inside agent_entrypoint, which can't be exercised without a full
LiveKit runtime, so we pin the contract on the source + topic constant:

  1. The topic constant exists with the exact string the extractor queries.
  2. The agent emits a RAW payload carrying the fields the gateway gate +
     extractor need (reply_text, transcript/input_text, user/tenant ids,
     tool_name, tool_call) — the gateway re-runs the consent/PII gate.
  3. The emit is gated on a pending user transcript, which skips the greeting
     (no preceding user turn), and clears per-turn signal so a tool-loop's
     extra assistant items don't double-emit.
  4. The dispatched tool is recorded per turn in tools.py so the routing
     signal is available at emit time.
"""
from __future__ import annotations

import pathlib


def _src(name: str) -> str:
    return (
        pathlib.Path(__file__).resolve().parent.parent / "src" / "orb_agent" / name
    ).read_text(encoding="utf-8")


def test_topic_exists_with_exact_string() -> None:
    """The extractor reads oasis_events WHERE topic = 'orb.turn.responded'.
    Pin the literal so a rename can't silently zero the dataset again."""
    from src.orb_agent.oasis import TOPIC_TURN_RESPONDED

    assert TOPIC_TURN_RESPONDED == "orb.turn.responded"


def test_emitter_sends_raw_dataset_fields() -> None:
    """The agent can't read tenant policy, so it emits a RAW payload and lets
    the gateway gate it. The payload MUST carry every field the gateway's
    buildOrbTurnRespondedPayload + the extractor depend on."""
    src = _src("session.py")
    start = src.find("async def _emit_turn_responded")
    assert start != -1, "regression: _emit_turn_responded helper missing"
    block = src[start : start + 1600]
    for required in (
        '"orb_session_id"',
        '"reply_text"',
        '"user_id"',
        '"tenant_id"',
        '"input_text"',
        '"transcript"',
        '"tool_name"',
        '"tool_call"',
        '"provider": "livekit"',
        "TOPIC_TURN_RESPONDED",
    ):
        assert required in block, (
            f"regression: orb.turn.responded payload missing {required}"
        )


def test_emit_gated_on_user_turn_and_clears_signal() -> None:
    """Fire only on an assistant reply that answers a real user turn (skips the
    greeting), and clear the per-turn signal on read so tool-loop assistant
    items don't double-emit the same turn."""
    src = _src("session.py")
    hook = src.find("def _on_conversation_item")
    assert hook != -1
    block = src[hook : hook + 2500]
    assert 'str(role) == "assistant"' in block, "must gate on assistant role"
    assert 'turn_state.get("user_text")' in block, (
        "must require a pending user transcript (skips greeting)"
    )
    assert 'turn_state["user_text"] = None' in block, (
        "must clear user_text on read to prevent double-emit"
    )
    assert "gw.last_tool_name = None" in block, "must clear the tool signal on read"
    assert "_emit_turn_responded(" in block, "hook must call the emitter"


def test_dispatch_records_tool_signal() -> None:
    """tools._dispatch / _dispatch_with_directive must record the dispatched
    tool on the GatewayClient so session.py can read it at emit time."""
    src = _src("tools.py")
    assert src.count("gw.last_tool_name = name") >= 2, (
        "both _dispatch and _dispatch_with_directive must record the tool"
    )
    assert "gw.last_tool_args = args or None" in src
