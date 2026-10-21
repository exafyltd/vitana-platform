"""VTID-03043: resolve_recipient + send_chat_message observability + fail-loud.

The L2.2b.7 German real-mic test (check #6) failed because:
  1. resolve_recipient returned `summarize(body)` which only emits the
     human-readable `text` line ("Best match: Maja (95%)") — the
     structured `result.candidates` array containing UUIDs was dropped.
     The LLM therefore had no UUID to pass to send_chat_message.
  2. send_chat_message's agent signature was (recipient_id, body_text)
     while the Vertex catalog declares (recipient_user_id, recipient_label,
     body). Schema drift between pipelines.

This module pins:
  - The .called event always fires (proves the LLM invoked the tool).
  - The .result event carries a machine-readable status.
  - The LLM-facing text starts with `STATUS: <status>.`
  - Candidate UUIDs ARE present in the resolved-status text.
  - No non-`sent` send branch ever instructs the LLM to claim the message
    went through.

All tests are hermetic — stub _dispatch and the OasisEmitter; no network,
no livekit-agents SDK required.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch


class _StubOasis:
    def __init__(self) -> None:
        self.emits: list[dict[str, Any]] = []

    async def emit(
        self,
        *,
        topic: str,
        payload: dict[str, Any] | None = None,
        vtid: str | None = None,
    ) -> None:
        self.emits.append({"topic": topic, "payload": payload or {}, "vtid": vtid})


class _StubGateway:
    def __init__(self, oasis: _StubOasis) -> None:
        self.oasis_emitter = oasis
        self.orb_session_id = "test-session-id"
        self.user_id = "test-user-id"


class _StubCtx:
    def __init__(self, gw: _StubGateway) -> None:
        self.userdata = gw


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _invoke_resolve(body: dict[str, Any]) -> tuple[str, _StubOasis]:
    from src.orb_agent import tools as tools_mod

    async def fake_dispatch(ctx: Any, name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        assert name == "resolve_recipient", name
        return body

    rts = tools_mod.resolve_recipient
    if hasattr(rts, "__wrapped__"):
        rts = rts.__wrapped__

    oasis = _StubOasis()
    gw = _StubGateway(oasis)
    ctx = _StubCtx(gw)
    with patch.object(tools_mod, "_dispatch", new=fake_dispatch):
        text = _run(rts(ctx, spoken_name="Maja"))
    return text, oasis


def _invoke_send(
    body: dict[str, Any],
    args: dict[str, str] | None = None,
) -> tuple[str, _StubOasis]:
    from src.orb_agent import tools as tools_mod

    captured: dict[str, Any] = {}

    async def fake_dispatch(ctx: Any, name: str, args_in: dict[str, Any] | None = None) -> dict[str, Any]:
        assert name == "send_chat_message", name
        captured["args"] = args_in
        return body

    rts = tools_mod.send_chat_message
    if hasattr(rts, "__wrapped__"):
        rts = rts.__wrapped__

    oasis = _StubOasis()
    gw = _StubGateway(oasis)
    ctx = _StubCtx(gw)

    call_args = args or {
        "recipient_user_id": "11111111-1111-4111-8111-111111111111",
        "recipient_label": "maja_p",
        "body": "Want to grab a coffee tomorrow afternoon?",
    }
    with patch.object(tools_mod, "_dispatch", new=fake_dispatch):
        text = _run(rts(ctx, **call_args))
    return text, oasis


# -------------------------------------------------------------------------
# resolve_recipient
# -------------------------------------------------------------------------


def test_resolve_resolved_carries_uuid_into_llm_text() -> None:
    """One high-confidence candidate → STATUS: resolved, text contains the user_id
    so the LLM can pass it to send_chat_message."""
    body = {
        "ok": True,
        "_status": 200,
        "result": {
            "candidates": [
                {
                    "user_id": "abc-uuid-123",
                    "vitana_id": "maja_p",
                    "display_name": "Maja Petrović",
                    "score": 0.96,
                    "reason": "vitana_id_exact",
                },
            ],
            "top_confidence": 0.96,
            "ambiguous": False,
        },
        "text": "Best match: Maja Petrović (confidence 96%).",
    }
    text, oasis = _invoke_resolve(body)
    assert text.startswith("STATUS: resolved."), text[:80]
    # The UUID MUST appear in the text so the LLM can read it.
    assert "abc-uuid-123" in text
    assert "maja_p" in text
    # Tells the LLM the canonical send_chat_message arg names.
    assert "recipient_user_id" in text
    assert "recipient_label" in text
    # Forbids passing the wrong thing.
    assert "NEVER pass the display name" in text
    # Both events fired.
    topics = [e["topic"] for e in oasis.emits]
    assert "orb.livekit.tool.resolve_recipient.called" in topics
    assert "orb.livekit.tool.resolve_recipient.result" in topics
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.resolve_recipient.result"
    )
    assert result_event["payload"]["status"] == "resolved"
    assert result_event["payload"]["candidate_count"] == 1


def test_resolve_ambiguous_lists_all_candidates_with_uuids() -> None:
    body = {
        "ok": True,
        "_status": 200,
        "result": {
            "candidates": [
                {"user_id": "uid-A", "vitana_id": "maja_p", "display_name": "Maja Petrović", "score": 0.87, "reason": "fuzzy_name"},
                {"user_id": "uid-B", "vitana_id": "maja_k", "display_name": "Maja Kovač", "score": 0.84, "reason": "fuzzy_name"},
                {"user_id": "uid-C", "vitana_id": "maja_v", "display_name": "Maja Vukić", "score": 0.81, "reason": "fuzzy_name"},
            ],
            "top_confidence": 0.87,
            "ambiguous": True,
        },
    }
    text, oasis = _invoke_resolve(body)
    assert text.startswith("STATUS: ambiguous."), text[:80]
    for uid in ("uid-A", "uid-B", "uid-C"):
        assert uid in text, f"missing {uid} in ambiguous text: {text}"
    # The LLM must read NAMES not UUIDs to the user — assert that guidance is present.
    assert "Read the candidates' names (NOT their user_ids)" in text
    # Forbids early dispatch.
    assert "Do NOT call send_chat_message yet" in text
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.resolve_recipient.result"
    )
    assert result_event["payload"]["status"] == "ambiguous"
    assert result_event["payload"]["candidate_count"] == 3


def test_resolve_no_match_blocks_send() -> None:
    body = {
        "ok": True,
        "_status": 200,
        "result": {"candidates": [], "top_confidence": 0, "ambiguous": True},
    }
    text, oasis = _invoke_resolve(body)
    assert text.startswith("STATUS: no_match."), text[:80]
    assert "Do NOT call send_chat_message" in text
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.resolve_recipient.result"
    )
    assert result_event["payload"]["status"] == "no_match"


def test_resolve_network_exception_maps_to_failed_network() -> None:
    body = {"ok": False, "error": "boom", "transport": "exception"}
    text, oasis = _invoke_resolve(body)
    assert text.startswith("STATUS: failed_network."), text[:80]
    assert "Do NOT call send_chat_message" in text
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.resolve_recipient.result"
    )
    assert result_event["payload"]["status"] == "failed_network"


# -------------------------------------------------------------------------
# send_chat_message
# -------------------------------------------------------------------------


def test_send_sent_acknowledges_and_only_sent_branch_can_claim_success() -> None:
    body = {
        "ok": True,
        "_status": 200,
        "result": {"message_id": "m-1"},
        "text": "Sent to @maja_p.",
    }
    text, oasis = _invoke_send(body)
    assert text.startswith("STATUS: sent."), text[:80]
    assert "Sent to @maja_p" in text
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.send_chat_message.result"
    )
    assert result_event["payload"]["status"] == "sent"


def test_send_recipient_not_uuid_branch_forbids_success_claim() -> None:
    body = {
        "ok": False,
        "_status": 400,
        "error": "I lost track of who you meant — can you say their name again?",
    }
    text, oasis = _invoke_send(body, args={
        "recipient_user_id": "not-a-uuid",
        "recipient_label": "maja",
        "body": "test message body that is long enough",
    })
    assert text.startswith("STATUS: recipient_not_uuid."), text[:80]
    assert "Do NOT claim a message was sent" in text
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.send_chat_message.result"
    )
    assert result_event["payload"]["status"] == "recipient_not_uuid"


def test_send_rate_limited_truthful() -> None:
    body = {"ok": False, "_status": 429, "error": "rate_limited: voice quota exhausted"}
    text, _ = _invoke_send(body)
    assert text.startswith("STATUS: rate_limited."), text[:80]
    assert "did NOT go through" in text


def test_send_missing_body() -> None:
    body = {"ok": False, "_status": 400, "error": "I didn't catch the message — what would you like me to send?"}
    text, _ = _invoke_send(body, args={
        "recipient_user_id": "11111111-1111-4111-8111-111111111111",
        "recipient_label": "maja_p",
        "body": "",
    })
    assert text.startswith("STATUS: missing_body."), text[:80]
    assert "Do NOT claim a message was sent" in text


def test_send_self_message_truthful() -> None:
    body = {"ok": False, "_status": 400, "error": "cannot message yourself"}
    text, _ = _invoke_send(body)
    assert text.startswith("STATUS: self_message."), text[:80]
    assert "Do NOT claim a message was sent" in text


def test_send_failed_network_maps_correctly() -> None:
    body = {"ok": False, "error": "ConnectError", "transport": "exception"}
    text, _ = _invoke_send(body)
    assert text.startswith("STATUS: failed_network."), text[:80]
    assert "did NOT reach the backend" in text


def test_send_args_canonical_names_flow_to_dispatch() -> None:
    """The agent must send canonical Vertex arg names downstream."""
    from src.orb_agent import tools as tools_mod

    captured: dict[str, Any] = {}

    async def fake_dispatch(ctx: Any, name: str, args_in: dict[str, Any] | None = None) -> dict[str, Any]:
        captured["args"] = args_in
        return {"ok": True, "_status": 200, "text": "Sent to @maja_p."}

    rts = tools_mod.send_chat_message
    if hasattr(rts, "__wrapped__"):
        rts = rts.__wrapped__
    oasis = _StubOasis()
    gw = _StubGateway(oasis)
    ctx = _StubCtx(gw)
    with patch.object(tools_mod, "_dispatch", new=fake_dispatch):
        _run(rts(
            ctx,
            recipient_user_id="11111111-1111-4111-8111-111111111111",
            recipient_label="maja_p",
            body="hello there friend",
        ))
    args = captured.get("args") or {}
    # Canonical names go to the gateway.
    assert "recipient_user_id" in args
    assert "recipient_label" in args
    assert "body" in args
    # Legacy names MUST NOT appear (we removed them on the agent side).
    assert "recipient_id" not in args
    assert "body_text" not in args


def test_no_non_sent_branch_claims_message_sent() -> None:
    """Belt-and-braces: scan every non-`sent` branch's text and assert the LLM
    is NEVER told to say the message was sent.
    """
    bodies: dict[str, dict[str, Any]] = {
        "rate_limited": {"ok": False, "_status": 429, "error": "rate_limited"},
        "missing_recipient": {"ok": False, "_status": 400, "error": "Who would you like me to send this to?"},
        "missing_body": {"ok": False, "_status": 400, "error": "I didn't catch the message — what would you like me to send?"},
        "self_message": {"ok": False, "_status": 400, "error": "cannot message yourself"},
        "recipient_not_uuid": {"ok": False, "_status": 400, "error": "I lost track of who you meant — can you say their name again?"},
        "failed_network": {"ok": False, "error": "ConnectError", "transport": "exception"},
        "failed_other": {"ok": False, "_status": 500, "error": "boom"},
    }
    forbidden = [
        "sent to @",
        "the message has been sent",
        "your message is on its way",
        "die nachricht ist raus",
        "ich habe die nachricht abgeschickt",
        "ich habe es gesendet",
    ]
    for name, body in bodies.items():
        text, _ = _invoke_send(body)
        lowered = text.lower()
        for phrase in forbidden:
            assert phrase not in lowered, (
                f"branch {name!r} contains forbidden phrase {phrase!r}: {text}"
            )


def test_prompt_invariant_present_in_system_instruction() -> None:
    """The Vitana system prompt MUST carry the VTID-03043 message-send
    truthfulness rule."""
    import pathlib

    candidates = [
        pathlib.Path(__file__).resolve().parent.parent.parent.parent
        / "gateway" / "src" / "orb" / "live" / "instruction"
        / "live-system-instruction.ts",
        pathlib.Path(__file__).resolve()
        .parent.parent.parent.parent.parent
        / "services" / "gateway" / "src" / "orb" / "live" / "instruction"
        / "live-system-instruction.ts",
    ]
    prompt_src = next((p for p in candidates if p.exists()), None)
    assert prompt_src is not None, "could not locate live-system-instruction.ts"
    text = prompt_src.read_text(encoding="utf-8")
    assert "VTID-03043" in text, "prompt missing VTID-03043 reference"
    assert "STATUS: sent" in text, "prompt missing STATUS: sent handshake"
