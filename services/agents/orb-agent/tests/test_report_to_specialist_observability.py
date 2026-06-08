"""VTID-03033: report_to_specialist observability + fail-loud.

The wrapper around the gateway tool must:
  1. Emit `orb.livekit.tool.report_to_specialist.called` BEFORE dispatch.
  2. Emit `orb.livekit.tool.report_to_specialist.result` AFTER dispatch
     with a machine-readable `status` field.
  3. Return text to the LLM that STARTS with `STATUS: <status>.` and
     forbids "Devon joined / connecting you" claims on any branch
     except `handoff_created`.
  4. Signal `gw.handoff_event` ONLY on `handoff_created`.

These tests stub the gateway _dispatch + the OasisEmitter so they are
hermetic — no network, no livekit-agents SDK required.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch


class _StubOasis:
    """Captures every emit so the test can assert the topic+payload shape."""

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
    """Minimal stand-in for GatewayClient — only fields the wrapper reads."""

    def __init__(self, oasis: _StubOasis) -> None:
        import asyncio as _asyncio

        self.oasis_emitter = oasis
        self.orb_session_id = "test-session-id"
        self.user_id = "test-user-id"
        self.handoff_event = _asyncio.Event()
        self.handoff_target: str | None = None
        self.handoff_summary: str | None = None
        self.handoff_reason: str | None = None


class _StubCtx:
    """Stand-in for RunContext — only `userdata` is read by `_gw`."""

    def __init__(self, gw: _StubGateway) -> None:
        self.userdata = gw


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _invoke_wrapper(
    body: dict[str, Any] | None = None,
    summary: str = (
        "When I open the diary screen on iOS and tap the new-entry plus button "
        "the keyboard appears but the text input never gets focus so I cannot type."
    ),
) -> tuple[str, _StubOasis, _StubGateway]:
    """Call the wrapper with a stubbed `_dispatch` returning `body`."""
    from src.orb_agent import tools as tools_mod

    async def fake_dispatch(ctx: Any, name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        assert name == "report_to_specialist", name
        return body or {}

    # The @function_tool decorator may wrap the function — call the
    # underlying callable. For the in-test ImportError branch in
    # tools.py the decorator is a no-op so the bare function is fine.
    rts = tools_mod.report_to_specialist
    if hasattr(rts, "__wrapped__"):
        rts = rts.__wrapped__  # type: ignore[assignment]

    oasis = _StubOasis()
    gw = _StubGateway(oasis)
    ctx = _StubCtx(gw)

    with patch.object(tools_mod, "_dispatch", new=fake_dispatch):
        result_text = _run(
            rts(ctx, kind="bug", summary=summary, specialist_hint=None)
        )
    return result_text, oasis, gw


# -------------------------------------------------------------------------
# Acceptance tests — one per outcome.
# -------------------------------------------------------------------------


def test_handoff_created_returns_status_token_and_signals_handoff() -> None:
    """Gateway decision='created' + persona='devon' MUST:
       - return text starting with `STATUS: handoff_created.`
       - mention the role label (`tech support`)
       - set gw.handoff_event with the persona target
       - emit BOTH .called and .result OASIS events
       - .result payload carries status='handoff_created', persona='devon'
    """
    body = {
        "ok": True,
        "_status": 200,
        "result": {
            "decision": "created",
            "persona": "devon",
            "ticket_id": "tk-1",
            "ticket_number": "T-42",
            "rpc_gate": "forward",
            "rpc_decision": "forward",
        },
        "text": "(ignored by wrapper — wrapper renders deterministic text)",
    }
    text, oasis, gw = _invoke_wrapper(body)

    # 1. Status token at the head of the LLM message.
    assert text.startswith("STATUS: handoff_created."), text[:80]
    # 2. Tells LLM to speak ONE bridge sentence as the role, not the persona name.
    assert "tech support" in text
    assert "internal name" in text.lower()
    # 3. Handoff signal fired.
    assert gw.handoff_event.is_set(), "handoff_event must be set on handoff_created"
    assert gw.handoff_target == "devon"
    assert gw.handoff_summary  # non-empty
    # 4 + 5. OASIS events.
    topics = [e["topic"] for e in oasis.emits]
    assert "orb.livekit.tool.report_to_specialist.called" in topics
    assert "orb.livekit.tool.report_to_specialist.result" in topics
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.report_to_specialist.result"
    )
    assert result_event["payload"]["status"] == "handoff_created"
    assert result_event["payload"]["persona"] == "devon"
    assert result_event["payload"]["handoff_signaled"] is True


def test_stay_inline_returns_status_and_forbids_connecting_claim() -> None:
    """Gate returns STAY_INLINE → no handoff. Text MUST:
       - start with `STATUS: stay_inline.`
       - forbid 'connecting / has joined' claims
       - NOT signal handoff_event
       - emit .result with status='stay_inline'
    """
    body = {
        "ok": True,
        "_status": 200,
        "result": {
            "decision": "stay_inline",
            "rpc_gate": "answer_inline",
        },
        "text": "(ignored)",
    }
    text, oasis, gw = _invoke_wrapper(body)

    assert text.startswith("STATUS: stay_inline."), text[:80]
    # No handoff event.
    assert not gw.handoff_event.is_set(), (
        "handoff_event MUST NOT fire on stay_inline"
    )
    # Truthfulness — no false-handoff claim, but the LLM may need to talk
    # generically. We assert on the explicit forbidding sentence.
    lowered = text.lower()
    assert "do not claim that devon" in lowered or "have not" in lowered, text
    # OASIS bookkeeping.
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.report_to_specialist.result"
    )
    assert result_event["payload"]["status"] == "stay_inline"
    assert result_event["payload"]["handoff_signaled"] is False


def test_failed_returns_status_failed_and_no_handoff_claim() -> None:
    """Gateway ok:false MUST produce status='failed' text + .result event.
       Must NOT signal handoff. Must NOT instruct the LLM to claim a handoff.
    """
    body = {
        "ok": False,
        "_status": 500,
        "error": "feedback_tickets insert failed: connection refused",
    }
    text, oasis, gw = _invoke_wrapper(body)

    assert text.startswith("STATUS: failed."), text[:80]
    assert not gw.handoff_event.is_set()
    lowered = text.lower()
    assert "did not go through" in lowered
    assert "do not claim" in lowered
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.report_to_specialist.result"
    )
    assert result_event["payload"]["status"] == "failed"
    assert result_event["payload"]["gateway_ok"] is False
    assert result_event["payload"]["error"] == body["error"]


def test_network_exception_returns_failed_network() -> None:
    """transport='exception' (httpx threw) MUST map to status='failed_network'."""
    body = {
        "ok": False,
        "error": "ConnectError: All connection attempts failed",
        "transport": "exception",
    }
    text, oasis, gw = _invoke_wrapper(body)

    assert text.startswith("STATUS: failed_network."), text[:80]
    assert not gw.handoff_event.is_set()
    assert "do not claim" in text.lower()
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.report_to_specialist.result"
    )
    assert result_event["payload"]["status"] == "failed_network"
    assert result_event["payload"]["transport"] == "exception"


def test_vague_decision_returns_status_vague() -> None:
    """Gateway VAGUE_PATTERNS hit → status='vague' branch."""
    body = {
        "ok": True,
        "_status": 200,
        "result": {"decision": "vague", "word_count": 4},
    }
    text, oasis, gw = _invoke_wrapper(body, summary="bug report.")
    assert text.startswith("STATUS: vague."), text[:80]
    assert not gw.handoff_event.is_set()
    assert "do not retry" in text.lower() or "do not retry this tool" in text.lower()
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.report_to_specialist.result"
    )
    assert result_event["payload"]["status"] == "vague"


def test_created_but_unrouted_returns_ticket_filed_no_handoff() -> None:
    """decision='created' but persona is None — a ticket exists but no
    specialist was routed. MUST distinguish from handoff_created.
    """
    body = {
        "ok": True,
        "_status": 200,
        "result": {
            "decision": "created",
            "persona": None,
            "ticket_number": "T-99",
        },
    }
    text, oasis, gw = _invoke_wrapper(body)

    assert text.startswith("STATUS: ticket_filed_no_handoff."), text[:80]
    assert not gw.handoff_event.is_set(), (
        "Unrouted ticket MUST NOT trigger persona rebuild"
    )
    assert "do not say you are connecting" in text.lower()
    result_event = next(
        e for e in oasis.emits
        if e["topic"] == "orb.livekit.tool.report_to_specialist.result"
    )
    assert result_event["payload"]["status"] == "ticket_filed_no_handoff"


def test_called_event_fires_BEFORE_result_even_on_failure() -> None:
    """`.called` MUST be emitted before dispatch, so an LLM that does call
    the tool can be told apart from one that doesn't — even when the
    gateway later errors out.
    """
    body = {"ok": False, "error": "boom", "transport": "exception"}
    _, oasis, _ = _invoke_wrapper(body)

    topics_in_order = [e["topic"] for e in oasis.emits]
    assert topics_in_order[0] == "orb.livekit.tool.report_to_specialist.called"
    assert topics_in_order[-1] == "orb.livekit.tool.report_to_specialist.result"


def test_no_branch_claims_devon_joined_unless_handoff_created() -> None:
    """Belt-and-braces: scan every non-handoff branch's text and assert
    the LLM is NEVER told to say a colleague has joined or that a connection
    is being made.
    """
    bodies: dict[str, dict[str, Any]] = {
        "stay_inline": {
            "ok": True, "_status": 200,
            "result": {"decision": "stay_inline", "rpc_gate": "answer_inline"},
        },
        "vague": {
            "ok": True, "_status": 200,
            "result": {"decision": "vague", "word_count": 3},
        },
        "failed": {
            "ok": False, "_status": 500,
            "error": "boom",
        },
        "failed_network": {
            "ok": False, "error": "boom", "transport": "exception",
        },
        "ticket_filed_no_handoff": {
            "ok": True, "_status": 200,
            "result": {"decision": "created", "persona": None, "ticket_number": "T-1"},
        },
    }
    forbidden_phrases = [
        # English
        "specialist has joined",
        "connecting you",
        "i'll connect you",
        "ill connect you",
        "let me bring",
        "bringing you to",
        # German
        "ich verbinde dich",
        "wird übernehmen",
        "ich übergebe dich",
    ]
    for name, body in bodies.items():
        text, _, _ = _invoke_wrapper(body, summary="placeholder summary " * 5)
        lowered = text.lower()
        for phrase in forbidden_phrases:
            assert phrase not in lowered, (
                f"branch {name!r} text contains forbidden phrase {phrase!r}: {text}"
            )


def test_prompt_invariant_present_in_system_instruction() -> None:
    """The Vitana system prompt MUST carry the VTID-03033 handoff-truthfulness
    rule. Structural check — grep the rendered prompt for the unique signature.
    """
    import pathlib

    prompt_src = (
        pathlib.Path(__file__).resolve().parent.parent.parent.parent
        / "gateway" / "src" / "orb" / "live" / "instruction"
        / "live-system-instruction.ts"
    )
    if not prompt_src.exists():
        # Different repo layout — try the workspace-level path.
        prompt_src = (
            pathlib.Path(__file__).resolve()
            .parent.parent.parent.parent.parent
            / "services" / "gateway" / "src" / "orb" / "live" / "instruction"
            / "live-system-instruction.ts"
        )
    text = prompt_src.read_text(encoding="utf-8")
    assert "VTID-03033" in text, "prompt missing VTID-03033 reference"
    assert "STATUS: handoff_created" in text, (
        "prompt missing STATUS: handoff_created handshake"
    )
