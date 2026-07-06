"""Tool catalogue — real bodies.

Every tool in voice-pipeline-spec/spec.json.tools is exposed here as a
`@function_tool`-decorated async Python function. Each body is **a single
async call** to the corresponding gateway endpoint via the per-session
`GatewayClient` carried on `RunContext.userdata`.

NOTHING in this file re-implements business logic. The gateway is the
source of truth for tool behaviour; the agent only marshals the call and
serializes the JSON response to a string for the LLM.

Tool-loop guard: livekit-agents' built-in `AgentSession(max_tool_steps=N)`
forces tool_choice='none' at the threshold. We do not custom-code the
guard (see services/agents/orb-agent/src/orb_agent/watchdogs.py docstring).

The libcst extractor in voice-pipeline-spec/tools/extract-py.py walks every
@function_tool decorator here. Tool names MUST match
voice-pipeline-spec/spec.json.tools[].name exactly.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from .gateway_client import GatewayClient, summarize


# VTID-03011: convert agent-side calendar args (when_iso + duration_min) into
# the gateway route shape (start_time + end_time ISO). The agent's
# @function_tool signatures expose `when_iso` + `duration_min` to the LLM
# (clean, simple), but the gateway's `/api/v1/calendar/events` zod schema
# requires `start_time` + `end_time` as ISO 8601 datetimes. Without this
# translator the route always returned 400 "start_time Required" — caught
# during L2.2b.6 smoke. Vertex's path is unaffected (its calendar tool is
# inline in orb-live.ts and writes directly).
#
# Output format: full ISO 8601 with UTC `Z` suffix. Zod's `.datetime()` by
# default requires UTC (no offset), so we normalize to UTC before emitting.
# Naive (no-tz) input is interpreted as UTC — best effort; LLMs commonly
# omit the offset for "tomorrow at 15:00" style asks.
def _to_calendar_payload(
    title: str,
    when_iso: str,
    duration_min: int = 60,
) -> dict[str, Any]:
    try:
        start_dt = datetime.fromisoformat(when_iso)
    except ValueError as exc:
        raise ValueError(
            f"when_iso must be ISO 8601 (e.g. '2026-05-17T15:00:00Z' "
            f"or '2026-05-17T15:00:00+02:00'), got {when_iso!r}"
        ) from exc
    if start_dt.tzinfo is None:
        start_dt = start_dt.replace(tzinfo=timezone.utc)
    end_dt = start_dt + timedelta(minutes=max(1, int(duration_min)))

    def _utc_z(dt: datetime) -> str:
        return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

    return {
        "title": title,
        "start_time": _utc_z(start_dt),
        "end_time": _utc_z(end_dt),
    }

# livekit-agents plumbing — `@function_tool` decorator + RunContext.
# In livekit-agents 1.x, `RunContext` lives at `livekit.agents` (it moved out
# of `livekit.agents.llm` during the 1.0 split). The `function_tool` decorator
# stayed under `livekit.agents.llm`. Importing from the wrong path silently
# falls into the ImportError branch below, which substitutes a no-op decorator
# that returns the raw function — and `Agent(tools=[...])` then rejects the
# raw functions at session start. That was the actual blocker for VTID-LIVEKIT-TOOLS.
try:
    from livekit.agents import RunContext  # type: ignore[import-not-found]
    from livekit.agents.llm import function_tool  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover

    class RunContext:  # type: ignore[no-redef]
        """Stub RunContext for unit tests when livekit-agents isn't installed."""

        userdata: Any = None

    def function_tool(*args: Any, **kwargs: Any):  # type: ignore[no-redef]
        def _wrap(fn: Any) -> Any:
            return fn

        if args and callable(args[0]):
            return args[0]
        return _wrap


logger = logging.getLogger(__name__)


def _gw(ctx: RunContext) -> GatewayClient:
    """Pulls the per-session GatewayClient off the agent's userdata.

    `userdata` is set by session.py at session start (Agent(userdata=...)).
    Returning it as a typed accessor here keeps each tool body to a one-liner.
    """
    gw = getattr(ctx, "userdata", None)
    if not isinstance(gw, GatewayClient):
        # Defensive — should never happen in production. Returning a no-op
        # error string is safer than raising into the agent loop.
        raise RuntimeError("RunContext.userdata is not a GatewayClient")
    return gw


async def _dispatch(ctx: RunContext, name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
    """Forward to the gateway's POST /api/v1/orb/tool dispatcher (VTID-LIVEKIT-TOOLS).

    Used by tools whose Vertex implementation is inline-only in orb-live.ts —
    the dispatcher (services/gateway/src/routes/orb-tool.ts) holds the lifted
    business logic. Tools whose endpoint already exists as a standalone route
    keep calling it directly (calendar, reminders, intents, vitana-index).
    """
    gw = _gw(ctx)
    # BOOTSTRAP-VOICE-DATASET-EMITTER: record the dispatched tool for the turn so
    # session.py's orb.turn.responded emit can carry the voice-tool-routing
    # signal. Read + cleared per turn in the conversation_item hook.
    gw.last_tool_name = name
    gw.last_tool_args = args or None
    return await gw.post("/api/v1/orb/tool", {"name": name, "args": args or {}})


async def _dispatch_with_directive(
    ctx: RunContext,
    name: str,
    args: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """`_dispatch` plus auto-publish any `directive` payload via the data channel.

    Tools whose gateway response includes a structured `result.directive`
    (find_community_member, play_music, navigate, view_intent_matches, etc.)
    use this wrapper instead of `_dispatch`. The directive flows out on the
    LiveKit data channel — the frontend listener applies it (open URL,
    navigate to profile, autoplay track) the same way the Vertex SSE/WS
    branch does today.

    Returns the raw gateway body so the caller can still build the LLM-facing
    voice text via `summarize(body)`.
    """
    from .directives import extract_directive, publish_orb_directive  # local import

    gw = _gw(ctx)
    # BOOTSTRAP-VOICE-DATASET-EMITTER: record the dispatched tool for the turn
    # (same as _dispatch) so the turn.responded emit carries the routing signal.
    gw.last_tool_name = name
    gw.last_tool_args = args or None
    body = await gw.post("/api/v1/orb/tool", {"name": name, "args": args or {}})
    directive = extract_directive(body)
    if directive is not None:
        published = await publish_orb_directive(gw.room, directive)
        if not published:
            logger.warning("tool %s: directive present but data-channel publish failed", name)
    return body


# ---------------------------------------------------------------------------
# Memory / Knowledge / Recall
# ---------------------------------------------------------------------------


@function_tool
async def search_memory(context: RunContext, query: str, limit: int = 5) -> str:
    """Search the user's personal memory garden for entries matching `query`.

    Args:
        query: Free-text search phrase.
        limit: Max number of entries to return (1..20).
    """
    body = await _dispatch(context, "search_memory", {"query": query, "limit": min(20, max(1, limit))})
    return summarize(body)


@function_tool
async def search_knowledge(context: RunContext, query: str) -> str:
    """Search the Vitana Knowledge Hub (longevity, platform docs)."""
    body = await _gw(context).post("/api/v1/assistant/knowledge/search", {"query": query})
    return summarize(body)


@function_tool
async def search_web(context: RunContext, query: str) -> str:
    """Web search via the configured external-search provider."""
    body = await _dispatch(context, "search_web", {"query": query})
    return summarize(body)


@function_tool
async def recall_conversation_at_time(context: RunContext, when: str) -> str:
    """Recall what the user discussed at a given time (VTID-02052).

    Args:
        when: Natural-language time anchor, e.g. "yesterday morning", "two days ago".
    """
    body = await _dispatch(context, "recall_conversation_at_time", {"when": when})
    return summarize(body)


# ---------------------------------------------------------------------------
# Persona / Handoff
# ---------------------------------------------------------------------------


@function_tool
async def switch_persona(context: RunContext, persona: str) -> str:
    """Switch to a different agent persona — used by Devon to hand the user
    back to Vitana once their intake is complete.

    Mirrors Vertex behavior (orb-live.ts: switch_persona case arm).
    Devon calls this with persona='vitana' after he asks "anything else?"
    and the user says no.

    Args:
        persona: Target persona key. The only valid value from Devon is
            'vitana' (returning the user to the receptionist). Lateral
            specialist↔specialist swaps are NOT allowed. Sage/Atlas/Mira
            are disabled in this canary phase (VTID-03044) — never target
            them.
    """
    target = (persona or "").strip().lower()
    gw = _gw(context)
    oasis = getattr(gw, "oasis_emitter", None)
    user_id = getattr(gw, "user_id", "") or ""

    # VTID-03044 telemetry: emit .called before dispatch so we can SEE
    # whether the LLM is invoking this tool at all. Across 2026-05-17 we
    # observed 0 switch_persona.called events even after Devon explicitly
    # asks "anything else?" — silence didn't tell us if the LLM skipped
    # the tool or if we just lacked instrumentation.
    if oasis is not None:
        try:
            await oasis.emit(
                topic="orb.livekit.tool.switch_persona.called",
                payload={
                    "persona": target,
                    "user_id": user_id,
                    "session_id": "",
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("switch_persona: oasis .called emit failed: %s", exc)

    body = await _dispatch(context, "switch_persona", {"persona": persona})

    # VTID-03028: when called with persona='vitana', signal the agent main
    # loop to rebuild the AgentSession back to Vitana — same mechanism
    # report_to_specialist uses to swap TO a specialist. Without this the
    # specialist (Devon) says "I'll hand you back" but the AgentSession
    # never actually rebuilds, leaving Devon's voice still active.
    handoff_signaled = False
    try:
        if target == "vitana":
            handoff_event = getattr(gw, "handoff_event", None)
            if handoff_event is not None:
                gw.handoff_target = "vitana"
                gw.handoff_summary = None  # No new brief on swap-back
                gw.handoff_reason = "specialist returning user to receptionist"
                handoff_event.set()
                handoff_signaled = True
                logger.info(
                    "switch_persona: handoff signal set → vitana "
                    "(main loop will rebuild AgentSession)"
                )
            else:
                logger.warning(
                    "switch_persona: gw.handoff_event missing — no rebuild fired"
                )
    except Exception as exc:  # noqa: BLE001
        logger.warning("switch_persona: handoff signal failed: %s", exc)

    if oasis is not None:
        try:
            await oasis.emit(
                topic="orb.livekit.tool.switch_persona.result",
                payload={
                    "persona": target,
                    "user_id": user_id,
                    "session_id": "",
                    "handoff_signaled": handoff_signaled,
                    "gateway_ok": isinstance(body, dict) and bool(body.get("ok", True)),
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("switch_persona: oasis .result emit failed: %s", exc)

    return summarize(body)


@function_tool
async def report_to_specialist(
    context: RunContext,
    kind: str,
    summary: str,
    specialist_hint: str | None = None,
) -> str:
    """File a customer-support ticket and hand the call to Devon, our
    tech-support colleague (VTID-03044 canary: Devon is the ONLY enabled
    specialist; Sage / Atlas / Mira are disabled). This is RARE —
    typically less than 5% of conversations. You ARE the instruction
    manual; almost every question is yours to answer.

    YOU MUST PROPOSE BEFORE CALLING. Even when forwarding is warranted,
    first say something like "Shall I bring in Devon to file this?" and
    wait for the user to say yes. Implicit consent does NOT count. Vary
    the proposal phrasing every time.

    CALL ONLY WHEN ALL THREE are true:
      (1) the user has described a CONCRETE PROBLEM (bug, broken state,
          refund, account lockout, claim) — not a question about how
          something works,
      (2) the user has EXPLICITLY agreed to be connected to a specialist
          (after you proposed it), and
      (3) you can write a SPECIFIC `summary` (>= 15 words) that describes
          WHAT broke, on WHICH screen/feature, with the user's own words.
          If you cannot — because the user only said "I want to report a
          bug" without details — DO NOT CALL THIS TOOL YET. Instead ask
          ONE follow-up question: "What's breaking — which screen or
          feature?" Get the details, THEN call this tool. A vague summary
          causes the specialist to invent the issue, which is worse than
          not forwarding at all. Generic summaries like "user wants to
          report a bug" are FORBIDDEN.

    NEVER CALL for any of these — answer them yourself inline using
    search_knowledge first:
      - "How does X work?" / "What is X?" / "Explain X"
      - "Show me how to use X" / "How do I X?" / "Teach me"
      - "Tell me about X" / "I want to learn X" / "I am new"
      - "Help me understand X" / "Walk me through X"
      - Any health, longevity, matchmaking, community, business, diary,
        calendar, or general life-companion question
      - Anything that is a learning question, not a broken-state report.
        First-time users asking how to use the diary is a teaching
        moment, NOT a customer-support ticket.

    GATE-A enforcement: the backend re-checks the user's actual recent
    words (not your summary). If the gate returns STAY_INLINE, do NOT
    mention the routing decision out loud — silently answer the question.
    Same if the conversation's forward budget is exhausted (max 1
    forward + 1 return per conversation).

    AFTER A FORWARD FIRES: speak ONE short bridge sentence in your own
    natural words. ANNOUNCE the handoff — never INTRODUCE the specialist
    ("Hi, here is Devon" — that is DEVON'S job in his own voice). Vary
    your phrasing every time, never recite a template. Then STOP — the
    next voice is the specialist's.

    HALLUCINATION GUARD (CRITICAL — VTID-03102): you MUST invoke this
    function via tool call. NEVER say "Ich verbinde dich mit Devon" /
    "I'll connect you to Devon" / "Einen Moment, Devon übernimmt" /
    "In Ordnung, ich hole Devon" / equivalents UNLESS this tool's most
    recent return value began with "STATUS: handoff_created." Speaking
    the bridge sentence WITHOUT first calling this function is a FAILED
    HANDOFF — the user is stranded with you while believing they're
    talking to Devon. The tool call is the PHYSICAL handoff; the bridge
    sentence is just the audible announcement of what already happened.
    Speak ONLY after the call returns.

    Args:
        kind: Best classification of what the user is reporting. One of:
            'bug', 'ux_issue', 'support_question', 'account_issue',
            'marketplace_claim', 'feature_request', 'feedback'.
        summary: CONCRETE one-paragraph summary using the user's OWN
            WORDS. Must include: what broke (the symptom), where (which
            screen/feature/flow), and any specifics the user gave (error
            message, order id, account email, time of day, etc).
            Minimum 15 words. FORBIDDEN: placeholder summaries like
            "user wants to report a bug" or "user has an account issue"
            or "user has a question". If you do not have enough
            specifics, ASK the user one diagnostic question first and
            call this tool only after you have a real description. A
            vague summary causes the specialist to hallucinate the
            issue.
        specialist_hint: Optional. VTID-03044 canary: only 'devon' is
            enabled. The backend re-checks via the keyword router and
            falls back to the kind→handles_kinds match if the hint is
            empty or unknown.

    Observability (VTID-03033): emits orb.livekit.tool.report_to_specialist
    .called BEFORE dispatch and .result AFTER, so OASIS can distinguish
    (1) LLM never called the tool, (2) backend returned stay_inline,
    (3) backend created handoff, (4) gateway/network failed.
    """
    gw = _gw(context)
    oasis = getattr(gw, "oasis_emitter", None)
    orb_session_id = getattr(gw, "orb_session_id", None) or ""
    user_id = getattr(gw, "user_id", None) or ""

    # VTID-03099: extract the user's last 3 RAW transcript turns and ship
    # them with the tool call. The gateway feeds these into the two-gate
    # forwarding RPC as gate_input — same logic Vertex uses (orb-live.ts:
    # buildGateInputFromTranscript). Without this, the gate only sees the
    # LLM-curated `summary` (compressed business language) which rarely
    # contains the forward_request_phrases the RPC looks for ("verbinde
    # mich", "mit dem support sprechen", "fehler melden", etc.) — Gate A
    # returns answer_inline and the handoff is silently vetoed even after
    # the user explicitly consented. Defensive: best-effort, never raises
    # — empty list falls through to the summary fallback on the gateway
    # side, exactly matching Vertex's behaviour when transcriptTurns is
    # empty.
    recent_user_turns: list[str] = []
    try:
        session_obj = (
            getattr(context, "session", None)
            or getattr(getattr(context, "agent", None), "session", None)
        )
        chat_ctx = getattr(session_obj, "chat_ctx", None) if session_obj else None
        # livekit-agents 1.x stores items on chat_ctx.items; older 0.x
        # used .messages. Support both without importing the type.
        items = getattr(chat_ctx, "items", None) or getattr(chat_ctx, "messages", None) or []
        for item in reversed(list(items)):
            role = getattr(item, "role", None)
            if role != "user":
                continue
            content = (
                getattr(item, "content", None)
                or getattr(item, "text_content", None)
            )
            if content is None:
                continue
            if isinstance(content, str):
                text = content.strip()
            else:
                # ChatMessage.content can be list[str | ContentBlock]; join
                # whatever stringifies meaningfully and ignore the rest.
                try:
                    text = " ".join(
                        str(c) for c in content if c is not None
                    ).strip()
                except Exception:  # noqa: BLE001
                    text = ""
            if text:
                recent_user_turns.append(text)
                if len(recent_user_turns) >= 3:
                    break
        recent_user_turns.reverse()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "report_to_specialist: chat_ctx read failed (gate falls back "
            "to summary): %s",
            exc,
        )
        recent_user_turns = []

    args: dict[str, Any] = {"kind": kind, "summary": summary}
    if specialist_hint:
        args["specialist_hint"] = specialist_hint
    if recent_user_turns:
        args["recent_user_turns"] = recent_user_turns

    # --- BEFORE DISPATCH ---------------------------------------------------
    summary_chars = len(summary or "")
    summary_word_count = len((summary or "").split())
    logger.info(
        "report_to_specialist.called: kind=%s summary_chars=%d summary_words=%d "
        "specialist_hint=%r session=%s user=%s",
        kind,
        summary_chars,
        summary_word_count,
        specialist_hint,
        orb_session_id,
        user_id,
    )
    if oasis is not None:
        try:
            await oasis.emit(
                topic="orb.livekit.tool.report_to_specialist.called",
                payload={
                    "session_id": orb_session_id,
                    "user_id": user_id,
                    "kind": kind,
                    "summary_chars": summary_chars,
                    "summary_words": summary_word_count,
                    "specialist_hint": specialist_hint,
                    "recent_user_turns_count": len(recent_user_turns),
                },
                vtid="VTID-03033",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("report_to_specialist: oasis .called emit failed: %s", exc)

    # --- DISPATCH ---------------------------------------------------------
    body = await _dispatch(context, "report_to_specialist", args)

    # Parse machine-readable outcome from the gateway body.
    ok = bool(body.get("ok", False)) if isinstance(body, dict) else False
    transport = (
        body.get("transport") if isinstance(body, dict) else None
    )
    err_msg = body.get("error") if isinstance(body, dict) else None
    gateway_status = body.get("_status") if isinstance(body, dict) else None
    result = body.get("result") if isinstance(body, dict) else None
    decision = (
        result.get("decision") if isinstance(result, dict) else None
    )
    persona = result.get("persona") if isinstance(result, dict) else None
    rpc_gate = result.get("rpc_gate") if isinstance(result, dict) else None
    rpc_decision = (
        result.get("rpc_decision") if isinstance(result, dict) else None
    )
    word_count = (
        result.get("word_count") if isinstance(result, dict) else None
    )
    ticket_number = (
        result.get("ticket_number") if isinstance(result, dict) else None
    )

    # Map the gateway's decision enum to the machine-readable status the
    # LLM sees. `handoff_created` is reserved for the case where a real
    # specialist row was picked — an unrouted ticket is NOT a handoff.
    status: str
    if transport == "exception" or not ok:
        status = "failed_network" if transport == "exception" else "failed"
    elif decision == "created" and persona in {"devon", "sage", "atlas", "mira"}:
        status = "handoff_created"
    elif decision == "created":
        status = "ticket_filed_no_handoff"
    elif decision == "stay_inline":
        status = "stay_inline"
    elif decision == "vague":
        status = "vague"
    elif decision == "failed":
        status = "failed"
    else:
        # Unknown / missing decision shape — treat as failure-loud rather
        # than silently letting the LLM improvise. This is the catch-all
        # for "stub_not_implemented"-class regressions.
        status = "failed"

    handoff_signaled = False

    # --- HANDOFF SIGNAL (only on real handoff_created) --------------------
    if status == "handoff_created":
        try:
            handoff_event = getattr(gw, "handoff_event", None)
            if handoff_event is not None:
                gw.handoff_target = persona
                gw.handoff_summary = summary
                gw.handoff_reason = f"user reported {kind}"
                handoff_event.set()
                handoff_signaled = True
                logger.info(
                    "report_to_specialist: handoff signal set → %s "
                    "(main loop will rebuild AgentSession)",
                    persona,
                )
            else:
                logger.warning(
                    "report_to_specialist: gw.handoff_event missing — "
                    "ticket filed but no persona rebuild will fire",
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "report_to_specialist: handoff signal failed: %s", exc
            )

    # --- AFTER DISPATCH: structured log + OASIS ---------------------------
    logger.info(
        "report_to_specialist.result: status=%s decision=%s persona=%s "
        "gateway_ok=%s gateway_status=%s rpc_gate=%s rpc_decision=%s "
        "ticket_number=%s handoff_signaled=%s error=%r",
        status,
        decision,
        persona,
        ok,
        gateway_status,
        rpc_gate,
        rpc_decision,
        ticket_number,
        handoff_signaled,
        err_msg,
    )
    if oasis is not None:
        try:
            await oasis.emit(
                topic="orb.livekit.tool.report_to_specialist.result",
                payload={
                    "session_id": orb_session_id,
                    "user_id": user_id,
                    "status": status,
                    "decision": decision,
                    "persona": persona,
                    "gateway_ok": ok,
                    "gateway_status": gateway_status,
                    "transport": transport,
                    "rpc_gate": rpc_gate,
                    "rpc_decision": rpc_decision,
                    "ticket_number": ticket_number,
                    "handoff_signaled": handoff_signaled,
                    "error": err_msg if isinstance(err_msg, str) else None,
                    "word_count": word_count,
                },
                vtid="VTID-03033",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "report_to_specialist: oasis .result emit failed: %s", exc
            )

    # --- DETERMINISTIC LLM-FACING TEXT ------------------------------------
    # Every branch starts with `STATUS: <status>.` so the LLM has a single
    # machine-readable token. The action sentence after it tells the LLM
    # what to actually say. Bridge-sentence freedom is preserved ONLY on
    # handoff_created — every other branch forbids claiming a handoff.
    if status == "handoff_created":
        persona_label = {
            "devon": "tech support",
            "sage": "customer support",
            "atlas": "finance / marketplace",
            "mira": "account",
        }.get(persona or "", "a specialist colleague")
        ticket_label = ticket_number or "(pending)"
        return (
            f"STATUS: handoff_created. "
            f"ACTION: Specialist handoff created for {persona_label} (ticket {ticket_label}). "
            "Speak ONE short bridge sentence in the user's language announcing the ROLE "
            f"({persona_label}) — vary phrasing every call. Then STOP. "
            "Do NOT speak the persona's internal name (Devon/Sage/Atlas/Mira) out loud. "
            "Do NOT introduce the colleague yourself — they will speak next in their own voice. "
            "Do NOT promise a timeline."
        )

    if status == "ticket_filed_no_handoff":
        ticket_label = ticket_number or "(pending)"
        return (
            f"STATUS: ticket_filed_no_handoff. "
            f"ACTION: A ticket has been filed (ticket {ticket_label}) but NO specialist "
            "was routed to take this live. Tell the user warmly that you've logged the "
            "report and someone will follow up — vary your phrasing. Do NOT say you are "
            "connecting them to anyone. Do NOT claim a colleague has joined."
        )

    if status == "stay_inline":
        gate_label = rpc_gate or "unspecified"
        return (
            f"STATUS: stay_inline. "
            f"ACTION: No specialist handoff was created (rpc_gate={gate_label}). "
            "Continue helping the user inline yourself. Do NOT claim that Devon, Sage, "
            "Atlas, or Mira has joined or is being connected — they have NOT. "
            "Do NOT mention this routing decision out loud. Answer the user's actual "
            "question or ask the next clarifying question naturally."
        )

    if status == "vague":
        wc = word_count if isinstance(word_count, int) else "unknown"
        return (
            f"STATUS: vague. "
            f"ACTION: Your summary was too vague (word_count={wc}). Do NOT retry this "
            "tool yet. Ask the user ONE follow-up question in their language for "
            "specifics (which screen / feature / error message / what they were doing). "
            "Then wait for their answer and call this tool again with a real description "
            "(>= 12 words). Do NOT claim anyone is being connected."
        )

    if status == "failed_network":
        return (
            "STATUS: failed_network. "
            "ACTION: Specialist handoff request did NOT reach the backend (network "
            "exception). Tell the user honestly that the report did not go through "
            "and that you'll try again in a moment. Do NOT claim a specialist has "
            "joined or is being connected."
        )

    # status == "failed" (gateway returned ok:false, or unknown shape)
    err_label = (
        err_msg if isinstance(err_msg, str) and err_msg
        else f"gateway_status={gateway_status}" if gateway_status
        else "unknown"
    )
    return (
        f"STATUS: failed. "
        f"ACTION: Specialist handoff failed ({err_label}). Tell the user honestly "
        "that the report did not go through. Do NOT claim a specialist has joined "
        "or is being connected. Do NOT promise a timeline."
    )


# ---------------------------------------------------------------------------
# Calendar / Schedule
# ---------------------------------------------------------------------------


@function_tool
async def search_calendar(context: RunContext, query: str, days_ahead: int = 14) -> str:
    """Search the user's calendar for upcoming events matching `query`."""
    body = await _gw(context).get(
        "/api/v1/calendar/events",
        {"q": query, "days_ahead": days_ahead},
    )
    return summarize(body)


@function_tool
async def create_calendar_event(
    context: RunContext, title: str, when_iso: str, duration_min: int = 60
) -> str:
    """Create a calendar event.

    Args:
        title: Event title.
        when_iso: Start time in ISO 8601 (e.g. "2026-05-17T15:00:00+02:00").
        duration_min: Duration in minutes (default 60).
    """
    # VTID-03011: translate to gateway shape (start_time + end_time).
    body = await _gw(context).post(
        "/api/v1/calendar/events",
        _to_calendar_payload(title, when_iso, duration_min),
    )
    return summarize(body)


@function_tool
async def add_to_calendar(context: RunContext, title: str, when_iso: str) -> str:
    """Add an event to the user's calendar (VTID-01943)."""
    # VTID-03011: translate to gateway shape (start_time + end_time, +60min default).
    body = await _gw(context).post(
        "/api/v1/calendar/events",
        _to_calendar_payload(title, when_iso, 60),
    )
    return summarize(body)


@function_tool
async def get_schedule(context: RunContext, date_iso: str | None = None) -> str:
    """Return the user's schedule for a given date (defaults to today)."""
    # Calendar router exposes /events/today and /events/upcoming. Without a
    # specific date we default to /today; with a date we fall back to the
    # generic /events search constrained to that day.
    if date_iso:
        body = await _gw(context).get(
            "/api/v1/calendar/events",
            {"from": date_iso, "to": date_iso},
        )
    else:
        body = await _gw(context).get("/api/v1/calendar/events/today")
    return summarize(body)


# ---------------------------------------------------------------------------
# Community / Events / Recommendations
# ---------------------------------------------------------------------------


@function_tool
async def search_events(context: RunContext, query: str = "") -> str:
    """List upcoming community events, meetups, parties, or workshops.

    CALL THIS whenever the user asks about events, meetups, parties,
    workshops, gatherings, what's happening, what's coming up, or
    anything similar — even when no specific filter is mentioned.
    Pass an empty `query` to list ALL upcoming events.

    Args:
        query: Optional substring to filter on title/description (case-insensitive).
               Pass "" or omit to list all upcoming events.
    """
    # PR 1.B-8: when the result has a single dominant event, auto-redirect
    # the user to the event-drawer overlay via the data channel. Comparable
    # results (live_rooms in the mix, or top score not dominant) → list-only
    # and the LLM lets the user pick.
    body = await _dispatch_with_directive(context, "search_events", {"query": query})
    # No gw.current_route eager update — the event-drawer is an overlay and
    # the underlying screen does not change.
    return summarize(body)


@function_tool
async def search_community(context: RunContext, query: str) -> str:
    """Search community groups / channels.

    PR 1.B-7: when the result is unambiguous (single hit OR exact name
    match) the user is auto-redirected to that group's detail screen via
    the data-channel directive. When several groups are comparable, the
    list is returned and you should ask the user which to open.

    Args:
        query: Free-text search across group name + description + topic.
    """
    body = await _dispatch_with_directive(context, "search_community", {"query": query})
    res = body.get("result") if isinstance(body, dict) else None
    if isinstance(res, dict) and res.get("decision") == "auto_nav":
        directive = res.get("directive") or {}
        new_route = directive.get("route") if isinstance(directive, dict) else None
        if isinstance(new_route, str) and new_route:
            gw = _gw(context)
            previous = gw.current_route
            gw.current_route = new_route
            if previous and previous != new_route:
                trail = [r for r in (gw.recent_routes or []) if r != previous]
                gw.recent_routes = ([previous] + trail)[:5]
    return summarize(body)


@function_tool
async def find_community_member(
    context: RunContext,
    query: str,
    excluded_vitana_ids: list[str] | None = None,
) -> str:
    """Find ONE community member matching a free-text query and auto-redirect.

    Use this whenever the user asks 'who is...' / 'find someone who...' /
    'who can teach me...' / 'who is the best at...'. The 4-tier ranker
    (exact_fact → Vitana Index → 6 affinity lanes → ethics-reroute) plus
    location/tenure modifiers always returns exactly ONE person.

    The tool itself dispatches the redirect to the user's profile via the
    LiveKit data channel — you only read the voice_summary aloud (1–2
    sentences). Do NOT call navigate_to_screen separately and do NOT add
    commentary; the widget is closing and the user is being taken to the
    profile.

    Args:
        query: The user's question, verbatim (e.g. "good at half marathon",
               "the funniest", "newest member").
        excluded_vitana_ids: Optional list of vitana_ids to skip — used by
                             the 'show me someone else' flow to walk past
                             prior matches.
    """
    body = await _dispatch_with_directive(
        context,
        "find_community_member",
        {
            "query": query,
            "excluded_vitana_ids": excluded_vitana_ids or [],
        },
    )
    return summarize(body)


@function_tool
async def get_recommendations(context: RunContext) -> str:
    """Return current Autopilot recommendations for the user (VTID-01180)."""
    body = await _gw(context).get("/api/v1/autopilot/recommendations")
    return summarize(body)


# ---------------------------------------------------------------------------
# Music / Capability preferences
# ---------------------------------------------------------------------------


@function_tool
async def play_music(context: RunContext, query: str, provider: str | None = None) -> str:
    """Play music via Spotify / Apple Music / Google / Vitana Hub (VTID-01941)."""
    args: dict[str, Any] = {"query": query}
    if provider:
        args["provider"] = provider
    body = await _dispatch(context, "play_music", args)
    return summarize(body)


@function_tool
async def set_capability_preference(context: RunContext, capability: str, provider: str) -> str:
    """Set the default provider for a capability (VTID-01942)."""
    body = await _dispatch(
        context, "set_capability_preference", {"capability": capability, "provider": provider}
    )
    return summarize(body)


# ---------------------------------------------------------------------------
# Email / Contacts
# ---------------------------------------------------------------------------


@function_tool
async def read_email(context: RunContext) -> str:
    """Read the user's recent unread emails (VTID-01943)."""
    body = await _dispatch(context, "read_email", {})
    return summarize(body)


@function_tool
async def find_contact(context: RunContext, query: str) -> str:
    """Find a contact in the user's contact book (VTID-01943)."""
    body = await _dispatch(context, "find_contact", {"query": query})
    return summarize(body)


# ---------------------------------------------------------------------------
# External AI bridge
# ---------------------------------------------------------------------------


@function_tool
async def consult_external_ai(
    context: RunContext, prompt: str, provider: str | None = None
) -> str:
    """Forward a prompt to the user's connected external AI account (ChatGPT / Claude / Gemini)."""
    args: dict[str, Any] = {"prompt": prompt}
    if provider:
        args["provider"] = provider
    body = await _dispatch(context, "consult_external_ai", args)
    return summarize(body)


# ---------------------------------------------------------------------------
# Vitana Index
# ---------------------------------------------------------------------------


@function_tool
async def get_life_compass(context: RunContext) -> str:
    """Return the user's active Life Compass — goal, why, target date (VTID-03010).

    Call this when the user asks "what is my Life Compass?", "what am I
    working toward?", "remind me what my goal is", or any variation about
    their long-term direction. The Life Compass is the user-authored
    one-sentence goal anchored in Settings.
    """
    body = await _dispatch(context, "get_life_compass", {})
    return summarize(body)


@function_tool
async def get_vitana_index(context: RunContext) -> str:
    """Return the user's current Vitana Index score + per-pillar breakdown (VTID-01983)."""
    body = await _gw(context).get("/api/v1/vitana-index")
    return summarize(body)


@function_tool
async def get_index_improvement_suggestions(context: RunContext) -> str:
    """Return suggested actions that would lift the user's Vitana Index (VTID-01983)."""
    body = await _gw(context).get("/api/v1/vitana-index/suggestions")
    return summarize(body)


@function_tool
async def create_index_improvement_plan(context: RunContext, target_pillar: str) -> str:
    """Create a multi-step plan to improve a specific pillar (VTID-01983)."""
    body = await _dispatch(context, "create_index_improvement_plan", {"target_pillar": target_pillar})
    return summarize(body)


# ---------------------------------------------------------------------------
# Diary
# ---------------------------------------------------------------------------


@function_tool
async def save_diary_entry(context: RunContext, text: str) -> str:
    """Save a diary entry.

    VTID-03042: switched from the legacy `/memory/diary/sync-index` call —
    which runs the Vitana Index recompute pipeline but does NOT write the
    user-visible `diary_entries` row — to the shared orb-tool dispatcher
    so both pipelines:
      1) insert the diary_entries row the user sees in their daily diary,
      2) extract health features + recompute the Index,
      3) celebrate any diary streak.

    Without this, voice "log a diary entry" silently dropped the visible
    row even though Vitana announced "I've logged it." (parity bug
    surfaced in the L2.2b.7 real-mic German session, check #5.)
    """
    body = await _dispatch(context, "save_diary_entry", {"raw_text": text})
    return summarize(body)


@function_tool
async def record_journey_answer(
    context: RunContext,
    step: str,
    value: str = "",
    target_value: float | None = None,
    target_unit: str = "",
    target_date: str = "",
    category: str = "",
    acknowledged: bool = True,
    teach_mode: bool = False,
) -> str:
    """Record the user's answer to a Journey Foundation step and get the next move (VTID-03255).

    The journey is a goal-gated, guided onboarding path that you lead and the
    My Journey screen mirrors. Call this EVERY time the user answers a journey
    question so the real record is written and the screen updates instantly.

    step = the step being answered:
      - "life_compass"     -> main goal; goal sentence in `value`, plus optional
        `target_value` / `target_unit` / `target_date` (YYYY-MM-DD).
      - "economic_intent"  -> their stance on earning in the longevity economy
        (build a business / passive income / earn from recommendations / just
        curious). "curious" is valid — never pressure them.
      - "weakest_habit"    -> the habit blocking their health most (food / water
        / exercise / sleep / stress) in `value`.
      - "understand_economy", "autopilot", "business_live_media" -> teaching
        moments; call with acknowledged=True once the user understands.

    The return value's text is the next sentence to say. Set teach_mode=True
    when the user wants to learn rather than do a task right now.
    """
    args: dict[str, Any] = {"step": step, "acknowledged": acknowledged, "teach_mode": teach_mode}
    if value:
        args["value"] = value
    if category:
        args["category"] = category
    if target_value is not None:
        args["target_value"] = target_value
    if target_unit:
        args["target_unit"] = target_unit
    if target_date:
        args["target_date"] = target_date
    body = await _dispatch(context, "record_journey_answer", args)
    return summarize(body)


# ---------------------------------------------------------------------------
# Reminders
# ---------------------------------------------------------------------------


@function_tool
async def set_reminder(context: RunContext, text: str, when_iso: str) -> str:
    """Set a reminder (VTID-02601).

    Args:
        text: Short action label, e.g. "take magnesium". <=60 chars.
        when_iso: When to fire, ISO 8601 UTC. Must be 60s..90 days in the future.
    """
    body = await _gw(context).post(
        "/api/v1/reminders",
        {
            "action_text": text,
            "spoken_message": text,
            "scheduled_for_iso": when_iso,
        },
    )
    return summarize(body)


@function_tool
async def find_reminders(context: RunContext, query: str | None = None) -> str:
    """List the user's active reminders (VTID-02601)."""
    body = await _gw(context).get("/api/v1/reminders", {"query": query} if query else None)
    return summarize(body)


@function_tool
async def delete_reminder(context: RunContext, reminder_id: str) -> str:
    """Delete a reminder (VTID-02601)."""
    body = await _gw(context).delete(f"/api/v1/reminders/{reminder_id}")
    return summarize(body)


# ---------------------------------------------------------------------------
# Pillar agents / Feature explanations
# ---------------------------------------------------------------------------


@function_tool
async def ask_pillar_agent(context: RunContext, pillar: str, question: str) -> str:
    """Ask a specific pillar agent (Nutrition / Hydration / Exercise / Sleep / Mental)."""
    body = await _dispatch(context, "ask_pillar_agent", {"pillar": pillar, "question": question})
    return summarize(body)


@function_tool
async def explain_feature(context: RunContext, feature: str) -> str:
    """Explain a Vitana feature in plain language."""
    body = await _dispatch(context, "explain_feature", {"feature": feature})
    return summarize(body)


# ---------------------------------------------------------------------------
# Structured Health Logging (VTID-02753)
#
# Five tools backed by services/voice-tools/health-log.ts via the shared
# dispatcher (PR D-1 lifted them to orb-tools-shared.ts so both pipelines
# write to health_features_daily through the same logHealthSignal()
# service). PR 1.B-2 adds the LiveKit Python wrappers so the LiveKit LLM
# can actually call them; until now they were dispatcher-only and the
# LiveKit Gemini cascade had no schema for them.
# ---------------------------------------------------------------------------


@function_tool
async def log_water(
    context: RunContext,
    amount_ml: int,
    date: str | None = None,
) -> str:
    """Log water intake (in millilitres) to the user's Hydration pillar.

    Use this when the user explicitly states an amount — "I drank 500ml of
    water", "I just had a litre", "log half a litre". For natural-language
    diary entries ("I had a glass of water with breakfast"), prefer
    save_diary_entry which extracts pillar contributions from the
    paragraph.

    Args:
        amount_ml: Volume in millilitres (e.g. 250 = one glass, 500 = half-litre).
        date: ISO YYYY-MM-DD; defaults to today.
    """
    body = await _dispatch(
        context,
        "log_water",
        {"amount_ml": int(amount_ml), "date": date},
    )
    return summarize(body)


@function_tool
async def log_sleep(
    context: RunContext,
    minutes: int,
    date: str | None = None,
) -> str:
    """Log sleep duration (in minutes) to the user's Sleep pillar.

    Args:
        minutes: Total minutes slept (e.g. 480 = 8 hours).
        date: ISO YYYY-MM-DD; defaults to today.
    """
    body = await _dispatch(
        context,
        "log_sleep",
        {"minutes": int(minutes), "date": date},
    )
    return summarize(body)


@function_tool
async def log_exercise(
    context: RunContext,
    minutes: int,
    activity_type: str | None = None,
    date: str | None = None,
) -> str:
    """Log a workout or movement session to the user's Exercise pillar.

    Args:
        minutes: Duration in minutes.
        activity_type: Optional descriptor (e.g. "running", "yoga", "cycling").
        date: ISO YYYY-MM-DD; defaults to today.
    """
    body = await _dispatch(
        context,
        "log_exercise",
        {
            "minutes": int(minutes),
            "activity_type": activity_type,
            "date": date,
        },
    )
    return summarize(body)


@function_tool
async def log_meditation(
    context: RunContext,
    minutes: int,
    date: str | None = None,
) -> str:
    """Log a meditation or mindfulness session (in minutes) to the Mental pillar.

    Args:
        minutes: Duration in minutes.
        date: ISO YYYY-MM-DD; defaults to today.
    """
    body = await _dispatch(
        context,
        "log_meditation",
        {"minutes": int(minutes), "date": date},
    )
    return summarize(body)


@function_tool
async def get_pillar_subscores(context: RunContext, pillar: str) -> str:
    """Return the breakdown that produced the given pillar's score.

    Each pillar score is the sum of four caps (baseline / completions / data /
    streak). When the user asks "why is my Sleep score X?" or "what's
    holding my Hydration back?", call this to surface which cap is the
    bottleneck so the agent can suggest the right next action.

    Args:
        pillar: One of nutrition | hydration | exercise | sleep | mental.
    """
    body = await _dispatch(context, "get_pillar_subscores", {"pillar": pillar})
    return summarize(body)


# ---------------------------------------------------------------------------
# Messaging (3-step send_message flow)
# ---------------------------------------------------------------------------


@function_tool
async def resolve_recipient(context: RunContext, spoken_name: str) -> str:
    """Step 1 of the 3-step send-message flow: resolve a spoken name to
    candidate Vitana users.

    VTID-03043 — Observability + fail-loud:
      - Emits `orb.livekit.tool.resolve_recipient.called` BEFORE dispatch
        (spoken_name length, session, user) and `.result` AFTER with a
        machine-readable status (`resolved` | `ambiguous` | `no_match`
        | `failed` | `failed_network`).
      - Returns a deterministic text to the LLM that ALWAYS starts with
        `STATUS: <status>.` and — critically — surfaces the candidate
        UUIDs the LLM must pass to `send_chat_message`. The legacy
        `summarize(body)` dropped the structured candidates and only
        showed the human-readable "Best match: Maja (95%)" line, so the
        LLM had no UUID to forward and `send_chat_message` always failed
        with "recipient_not_uuid". This is the bug surfaced in the
        L2.2b.7 real-mic German test (check #6: "failed to send,
        couldn't save the receiver").

    The Vertex tool catalog declares this tool as `spoken_name` (not
    `name`); aligning the agent signature with the catalog prevents
    schema drift between pipelines.
    """
    gw = _gw(context)
    oasis = getattr(gw, "oasis_emitter", None)
    orb_session_id = getattr(gw, "orb_session_id", None) or ""
    user_id = getattr(gw, "user_id", None) or ""

    cleaned = (spoken_name or "").strip()
    logger.info(
        "resolve_recipient.called: spoken_name_chars=%d session=%s user=%s",
        len(cleaned),
        orb_session_id,
        user_id,
    )
    if oasis is not None:
        try:
            await oasis.emit(
                topic="orb.livekit.tool.resolve_recipient.called",
                payload={
                    "session_id": orb_session_id,
                    "user_id": user_id,
                    "spoken_name_chars": len(cleaned),
                },
                vtid="VTID-03043",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("resolve_recipient: oasis .called emit failed: %s", exc)

    body = await _dispatch(context, "resolve_recipient", {"spoken_name": cleaned})

    # Parse the structured response.
    ok = bool(body.get("ok", False)) if isinstance(body, dict) else False
    transport = body.get("transport") if isinstance(body, dict) else None
    err_msg = body.get("error") if isinstance(body, dict) else None
    gateway_status = body.get("_status") if isinstance(body, dict) else None
    result = body.get("result") if isinstance(body, dict) else None
    candidates_raw = result.get("candidates") if isinstance(result, dict) else None
    top_confidence = result.get("top_confidence") if isinstance(result, dict) else None
    ambiguous = result.get("ambiguous") if isinstance(result, dict) else None
    candidates: list[dict[str, Any]] = (
        candidates_raw if isinstance(candidates_raw, list) else []
    )

    # Map to machine-readable status.
    if transport == "exception":
        status = "failed_network"
    elif not ok:
        status = "failed"
    elif not candidates:
        status = "no_match"
    elif ambiguous is True or len(candidates) > 1:
        status = "ambiguous"
    else:
        status = "resolved"

    logger.info(
        "resolve_recipient.result: status=%s candidates=%d top_confidence=%s "
        "ambiguous=%s gateway_ok=%s gateway_status=%s error=%r",
        status,
        len(candidates),
        top_confidence,
        ambiguous,
        ok,
        gateway_status,
        err_msg,
    )
    if oasis is not None:
        try:
            await oasis.emit(
                topic="orb.livekit.tool.resolve_recipient.result",
                payload={
                    "session_id": orb_session_id,
                    "user_id": user_id,
                    "status": status,
                    "candidate_count": len(candidates),
                    "top_confidence": top_confidence,
                    "ambiguous": ambiguous,
                    "gateway_ok": ok,
                    "gateway_status": gateway_status,
                    "transport": transport,
                    "error": err_msg if isinstance(err_msg, str) else None,
                },
                vtid="VTID-03043",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("resolve_recipient: oasis .result emit failed: %s", exc)

    # Deterministic LLM-facing text. The whole point of this rewrite: the
    # LLM must SEE the user_id strings to pass them to send_chat_message.
    def _fmt(c: dict[str, Any]) -> str:
        uid = c.get("user_id") or "?"
        vid = c.get("vitana_id") or "(no vitana_id)"
        name = c.get("display_name") or vid
        score = c.get("score")
        score_str = f"{float(score) * 100:.0f}%" if isinstance(score, (int, float)) else "?"
        return f"  - {name} (vitana_id={vid}, user_id={uid}, confidence={score_str})"

    if status == "resolved":
        top = candidates[0]
        uid = top.get("user_id") or ""
        vid = top.get("vitana_id") or "(no vitana_id)"
        name = top.get("display_name") or vid
        return (
            f"STATUS: resolved. "
            f"ACTION: One high-confidence match. To send a message, call "
            f"send_chat_message with recipient_user_id=\"{uid}\", "
            f"recipient_label=\"{vid}\", and the user's body text. "
            f"NEVER pass the display name or any other string as recipient_user_id. "
            f"Best match: {name} (vitana_id={vid}, user_id={uid})."
        )
    if status == "ambiguous":
        listing = "\n".join(_fmt(c) for c in candidates[:3])
        return (
            f"STATUS: ambiguous. "
            f"ACTION: Read the candidates' names (NOT their user_ids) to the user and "
            f"ask which one they meant. Do NOT call send_chat_message yet. "
            f"After the user picks, call send_chat_message with that candidate's "
            f"user_id as recipient_user_id and vitana_id as recipient_label.\n"
            f"Candidates ({len(candidates)} total, top 3 shown):\n{listing}"
        )
    if status == "no_match":
        return (
            f"STATUS: no_match. "
            f"ACTION: Tell the user you couldn't find anyone named \"{cleaned}\" in the "
            f"community. Ask them to repeat or spell the Vitana ID. Do NOT call "
            f"send_chat_message — there is no valid recipient."
        )
    if status == "failed_network":
        return (
            "STATUS: failed_network. "
            "ACTION: Recipient lookup did NOT reach the backend (network exception). "
            "Tell the user honestly that you couldn't look up the recipient and you'll "
            "try again in a moment. Do NOT call send_chat_message."
        )
    err_label = (
        err_msg if isinstance(err_msg, str) and err_msg
        else f"gateway_status={gateway_status}" if gateway_status
        else "unknown"
    )
    return (
        f"STATUS: failed. "
        f"ACTION: Recipient lookup failed ({err_label}). Tell the user honestly that "
        f"the lookup didn't work and you'll try again. Do NOT call send_chat_message."
    )


@function_tool
async def send_chat_message(
    context: RunContext,
    recipient_user_id: str,
    recipient_label: str,
    body: str,
) -> str:
    """Step 3 of the 3-step send-message flow: dispatch the message.

    VTID-03043 — Schema alignment + observability:
      - Args now match the Vertex tool catalog
        (`recipient_user_id`, `recipient_label`, `body`) so the LLM uses
        the canonical names regardless of pipeline. Legacy
        `recipient_id`/`body_text` are still accepted by the gateway as a
        belt-and-braces fallback.
      - Emits `.called` BEFORE dispatch and `.result` AFTER with a
        machine-readable status (`sent` | `missing_recipient` |
        `missing_body` | `recipient_not_uuid` | `rate_limited` |
        `self_message` | `failed` | `failed_network`).
      - Returns a deterministic text to the LLM that always opens
        `STATUS: <status>.` and tells it what to say. Saying "the
        message has been sent" is forbidden on any status except `sent`.
    """
    gw = _gw(context)
    oasis = getattr(gw, "oasis_emitter", None)
    orb_session_id = getattr(gw, "orb_session_id", None) or ""
    user_id = getattr(gw, "user_id", None) or ""

    recipient_user_id = (recipient_user_id or "").strip()
    recipient_label = (recipient_label or "").strip()
    body = (body or "").strip()

    logger.info(
        "send_chat_message.called: recipient_user_id_chars=%d label_chars=%d body_chars=%d "
        "session=%s user=%s",
        len(recipient_user_id),
        len(recipient_label),
        len(body),
        orb_session_id,
        user_id,
    )
    if oasis is not None:
        try:
            await oasis.emit(
                topic="orb.livekit.tool.send_chat_message.called",
                payload={
                    "session_id": orb_session_id,
                    "user_id": user_id,
                    "recipient_user_id_chars": len(recipient_user_id),
                    "recipient_label_chars": len(recipient_label),
                    "body_chars": len(body),
                },
                vtid="VTID-03043",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("send_chat_message: oasis .called emit failed: %s", exc)

    response = await _dispatch(
        context,
        "send_chat_message",
        {
            "recipient_user_id": recipient_user_id,
            "recipient_label": recipient_label,
            "body": body,
        },
    )

    ok = bool(response.get("ok", False)) if isinstance(response, dict) else False
    transport = response.get("transport") if isinstance(response, dict) else None
    err_msg = response.get("error") if isinstance(response, dict) else None
    gateway_status = response.get("_status") if isinstance(response, dict) else None
    result = response.get("result") if isinstance(response, dict) else None
    text_from_gateway = response.get("text") if isinstance(response, dict) else None

    # Derive status. The gateway's send-side returns specific error strings
    # for each failure mode; we keyword-match to classify so the LLM gets a
    # single token to read.
    if transport == "exception":
        status = "failed_network"
    elif ok:
        status = "sent"
    else:
        err_lower = str(err_msg or "").lower()
        if "recipient" in err_lower and ("again" in err_lower or "uuid" in err_lower or "lost track" in err_lower):
            status = "recipient_not_uuid"
        elif "didn't catch" in err_lower or "missing_body" in err_lower or "what would you like" in err_lower:
            status = "missing_body"
        elif "who would you like" in err_lower or "missing_recipient" in err_lower:
            status = "missing_recipient"
        elif "rate" in err_lower or "limit" in err_lower or "too many" in err_lower:
            status = "rate_limited"
        elif "self" in err_lower or "yourself" in err_lower:
            status = "self_message"
        elif "find " in err_lower or "couldn't find" in err_lower or "ambiguous" in err_lower:
            status = "recipient_not_resolved"
        else:
            status = "failed"

    logger.info(
        "send_chat_message.result: status=%s gateway_ok=%s gateway_status=%s error=%r",
        status,
        ok,
        gateway_status,
        err_msg,
    )
    if oasis is not None:
        try:
            await oasis.emit(
                topic="orb.livekit.tool.send_chat_message.result",
                payload={
                    "session_id": orb_session_id,
                    "user_id": user_id,
                    "status": status,
                    "gateway_ok": ok,
                    "gateway_status": gateway_status,
                    "transport": transport,
                    "error": err_msg if isinstance(err_msg, str) else None,
                },
                vtid="VTID-03043",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("send_chat_message: oasis .result emit failed: %s", exc)

    # Deterministic LLM-facing text. Only `sent` is allowed to say the
    # message went through. Every other branch must tell the user the
    # message did NOT go through.
    if status == "sent":
        # Gateway's text on success is "Sent to @vid." — preserve it.
        if isinstance(text_from_gateway, str) and text_from_gateway:
            return f"STATUS: sent. ACTION: {text_from_gateway}"
        return (
            f"STATUS: sent. "
            f"ACTION: The message has been sent to @{recipient_label}. "
            f"Acknowledge briefly to the user (vary phrasing every call)."
        )
    if status == "rate_limited":
        return (
            "STATUS: rate_limited. "
            "ACTION: The message did NOT go through — voice-send quota for this session "
            "is exhausted. Tell the user they can keep going in the app. Do NOT pretend "
            "the message was sent."
        )
    if status == "missing_body":
        return (
            "STATUS: missing_body. "
            "ACTION: You didn't pass a body. Ask the user what they want to say, then "
            "call send_chat_message again with the body filled in. Do NOT claim a "
            "message was sent."
        )
    if status == "missing_recipient":
        return (
            "STATUS: missing_recipient. "
            "ACTION: You didn't pass a recipient_user_id. Call resolve_recipient first, "
            "pick the UUID from its result, then call send_chat_message. Do NOT claim "
            "a message was sent."
        )
    if status == "recipient_not_uuid":
        return (
            "STATUS: recipient_not_uuid. "
            "ACTION: The recipient_user_id you passed is not a UUID. Call "
            "resolve_recipient again and pass that result's user_id field verbatim — "
            "NOT the display name, NOT the vitana_id. Do NOT claim a message was sent."
        )
    if status == "recipient_not_resolved":
        return (
            "STATUS: recipient_not_resolved. "
            "ACTION: The gateway couldn't confirm the recipient. Tell the user you "
            "lost track of who they meant and ask for the Vitana ID again. Do NOT "
            "claim a message was sent."
        )
    if status == "self_message":
        return (
            "STATUS: self_message. "
            "ACTION: The recipient resolves to the current user — Vitana cannot send "
            "messages to yourself. Tell the user gently. Do NOT claim a message was sent."
        )
    if status == "failed_network":
        return (
            "STATUS: failed_network. "
            "ACTION: The send did NOT reach the backend (network exception). Tell the "
            "user the message didn't go through and you'll try again. Do NOT claim a "
            "message was sent."
        )
    err_label = (
        err_msg if isinstance(err_msg, str) and err_msg
        else f"gateway_status={gateway_status}" if gateway_status
        else "unknown"
    )
    return (
        f"STATUS: failed. "
        f"ACTION: Send failed ({err_label}). Tell the user honestly the message did "
        f"NOT go through. Do NOT claim a message was sent."
    )


# ---------------------------------------------------------------------------
# Autopilot recommendations
# ---------------------------------------------------------------------------


@function_tool
async def activate_recommendation(context: RunContext, recommendation_id: str) -> str:
    """Activate an Autopilot recommendation (VTID-01180)."""
    body = await _gw(context).post(
        f"/api/v1/autopilot/recommendations/{recommendation_id}/activate"
    )
    return summarize(body)


# ---------------------------------------------------------------------------
# Sharing
# ---------------------------------------------------------------------------


@function_tool
async def share_link(context: RunContext, url: str, with_recipient: str | None = None) -> str:
    """Share a link, optionally with a contact."""
    args: dict[str, Any] = {"url": url}
    if with_recipient:
        args["with_recipient"] = with_recipient
    body = await _dispatch(context, "share_link", args)
    return summarize(body)


# ---------------------------------------------------------------------------
# Vitana Intent Engine (VTID-01975 / VTID-01976)
# ---------------------------------------------------------------------------


@function_tool
async def post_intent(context: RunContext, kind: str, body_text: str) -> str:
    """Post an intent (VTID-01975).

    Args:
        kind: One of commercial_buy, commercial_sell, activity_seek,
            partner_seek, social_seek, mutual_aid, learning_seek, mentor_seek.
        body_text: The user's natural-language description of the intent
            (used for both title and scope; classifier expands as needed).
    """
    # Endpoint accepts either {intent_kind, title, scope} or just
    # {utterance} (which classifier expands). We send the explicit form
    # since we already have the kind. Title is a short prefix of the
    # body; scope is the full text (must be 20–1500 chars).
    title = body_text[:80] if len(body_text) >= 3 else f"{kind} request"
    if len(title) < 3:
        title = f"{kind} request"
    scope = body_text if len(body_text) >= 20 else (body_text + " — looking for matches in the community").ljust(20)[:1500]
    body = await _gw(context).post(
        "/api/v1/intents",
        {"intent_kind": kind, "title": title, "scope": scope},
    )
    return summarize(body)


@function_tool
async def view_intent_matches(context: RunContext, intent_id: str, limit: int = 3) -> str:
    """View the top match candidates for ONE of the user's intents.

    PR 1.B-6: when the top match's score clearly dominates the runner-up
    (gap >= 0.15), auto-redirects the user to that match's detail screen
    via the data-channel directive. When matches are comparable, returns
    the list and lets you ask the user which one they want.

    Args:
        intent_id: The user's intent to look up matches for.
        limit: Max number of matches to return (1..10). Default 3.
    """
    body = await _dispatch_with_directive(
        context,
        "view_intent_matches",
        {"intent_id": intent_id, "limit": max(1, min(10, int(limit)))},
    )
    # Eagerly update gw.current_route on auto_nav so the next
    # get_current_screen call sees the fresh route.
    res = body.get("result") if isinstance(body, dict) else None
    if isinstance(res, dict) and res.get("decision") == "auto_nav":
        directive = res.get("directive") or {}
        new_route = directive.get("route") if isinstance(directive, dict) else None
        if isinstance(new_route, str) and new_route:
            gw = _gw(context)
            previous = gw.current_route
            gw.current_route = new_route
            if previous and previous != new_route:
                trail = [r for r in (gw.recent_routes or []) if r != previous]
                gw.recent_routes = ([previous] + trail)[:5]
    return summarize(body)


@function_tool
async def list_my_intents(context: RunContext) -> str:
    """List the user's open and historical intents."""
    body = await _gw(context).get("/api/v1/intents")
    return summarize(body)


@function_tool
async def respond_to_match(context: RunContext, match_id: str, response: str) -> str:
    """Respond to a match candidate (VTID-01976).

    Args:
        match_id: The intent_match id.
        response: One of 'interested' | 'declined' | 'pending' | 'accepted'.
    """
    body = await _dispatch(context, "respond_to_match", {"match_id": match_id, "response": response})
    return summarize(body)


@function_tool
async def mark_intent_fulfilled(context: RunContext, intent_id: str) -> str:
    """Mark an intent as fulfilled."""
    body = await _gw(context).post(f"/api/v1/intents/{intent_id}/close")
    return summarize(body)


@function_tool
async def share_intent_post(context: RunContext, intent_id: str, with_recipient: str) -> str:
    """Share an intent post with a contact."""
    body = await _dispatch(
        context, "share_intent_post", {"intent_id": intent_id, "with_recipient": with_recipient}
    )
    return summarize(body)


@function_tool
async def scan_existing_matches(context: RunContext) -> str:
    """Scan for matches across all open intents."""
    body = await _dispatch(context, "scan_existing_matches", {})
    return summarize(body)


@function_tool
async def get_matchmaker_result(context: RunContext, intent_id: str) -> str:  # noqa: D401
    """Get the matchmaker's current result for a specific intent."""
    body = await _gw(context).get(f"/api/v1/intents/{intent_id}/matchmaker")
    return summarize(body)


# VTID-03048: matchmaker parity — surface Vertex's `find_perfect_product` and
# `find_perfect_practitioner` tools to the LiveKit agent. Until this slice,
# only Vertex registered them in its function_declarations catalog
# (services/gateway/src/orb/live/tools/live-tool-catalog.ts:424-477), even
# though the shared dispatcher already implemented them
# (services/gateway/src/services/orb-tools-shared.ts:tool_find_perfect_product,
# :tool_find_perfect_practitioner). Result: when a LiveKit user asked
# "find me a tennis partner" / "recommend a supplement", the LLM had only
# `post_intent` / `share_intent_post` available and skipped straight to
# posting an intent instead of running the search-first matchmaker flow.
# Both wrappers _dispatch to the shared registry which already enforces
# the fact-fusing logic (weakest pillar + Life Compass goal + filters).
@function_tool
async def find_perfect_product(
    context: RunContext,
    goal_text: str = "",
    pillar: str = "",
    max_price: float | None = None,
    exclude_ingredients: list[str] | None = None,
) -> str:
    """Recommend the perfect product for the user (supplement / gear / food).

    Fuses the user's weakest Vitana Index pillar + active Life Compass goal
    with a free-form ask + optional filters (price cap, ingredients to
    avoid). Returns top-3 with rationale.

    Use this for PRODUCTS. For services or practitioners use
    `find_perfect_practitioner`. For people / community matches use
    `find_community_member`.

    Args:
        goal_text: Free-form description of what the user wants the product
            to help with.
        pillar: OPTIONAL — nutrition / hydration / exercise / sleep / mental.
            Defaults to the user's weakest pillar.
        max_price: OPTIONAL — price cap.
        exclude_ingredients: OPTIONAL — list of ingredient names to avoid.
    """
    args: dict[str, Any] = {"goal_text": goal_text}
    if pillar:
        args["pillar"] = pillar
    if max_price is not None:
        args["max_price"] = max_price
    if exclude_ingredients:
        args["exclude_ingredients"] = exclude_ingredients
    body = await _dispatch(context, "find_perfect_product", args)
    return summarize(body)


@function_tool
async def find_perfect_practitioner(
    context: RunContext,
    specialty: str = "",
    goal_text: str = "",
    language: str = "",
    telehealth_ok: bool | None = None,
    max_price: float | None = None,
) -> str:
    """Recommend the perfect practitioner / coach / doctor for the user.

    Multi-criteria search: specialty, language, telehealth-ok, price cap,
    fused with the active Life Compass goal. Returns top-3 with rationale.

    Use for: "find me a functional medicine doc who takes telehealth",
    "who can coach me on sleep?", "I need a German-speaking nutritionist".

    Args:
        specialty: e.g. "functional medicine", "nutrition", "therapy".
        goal_text: Free-form description of what the user is working on.
        language: OPTIONAL — language code or name, e.g. "en", "de".
        telehealth_ok: OPTIONAL — restrict to practitioners offering
            telehealth.
        max_price: OPTIONAL — price cap.
    """
    args: dict[str, Any] = {}
    if specialty:
        args["specialty"] = specialty
    if goal_text:
        args["goal_text"] = goal_text
    if language:
        args["language"] = language
    if telehealth_ok is not None:
        args["telehealth_ok"] = telehealth_ok
    if max_price is not None:
        args["max_price"] = max_price
    body = await _dispatch(context, "find_perfect_practitioner", args)
    return summarize(body)


# ---------------------------------------------------------------------------
# Navigation
# ---------------------------------------------------------------------------


@function_tool
async def navigate_to_screen(context: RunContext, target: str) -> str:
    """Navigate the user to a named screen.

    Cross-surface navigation (e.g. community user trying to go to /admin) is
    rejected with an LLM-visible error per
    memory/feedback_navigator_surface_scoping.md.

    Args:
        target: Named screen identifier from the spec's navigation registry.
    """
    # PR 1.B-5: thread the gate inputs the shared dispatcher reads —
    # current_route (already-there dedup), is_mobile (viewport gate +
    # mobile_route override), is_anonymous (anonymous gate). Auto-publish
    # any directive on the data channel; eagerly update gw.current_route
    # so the next get_current_screen / navigate_to_screen sees fresh state.
    gw = _gw(context)
    body = await _dispatch_with_directive(
        context,
        "navigate_to_screen",
        {
            "target": target,
            "current_route": gw.current_route,
            "is_mobile": gw.is_mobile,
            "is_anonymous": gw.is_anonymous,
        },
    )
    res = body.get("result") if isinstance(body, dict) else None
    if isinstance(res, dict) and not res.get("already_there"):
        new_base = res.get("base_route") or (
            res["route"].split("?", 1)[0] if isinstance(res.get("route"), str) else None
        )
        if isinstance(new_base, str) and new_base:
            previous = gw.current_route
            gw.current_route = new_base
            if previous and previous != new_base:
                trail = [r for r in (gw.recent_routes or []) if r != previous]
                gw.recent_routes = ([previous] + trail)[:5]
    return summarize(body)


# VTID-NAV-UNIFIED (PR 1.B-4) — free-text navigation. The user just speaks
# their natural-language request (e.g. "take me to my matches", "show me
# events this weekend", "open my diary") and consultNavigator's 8-step
# resolution picks the right screen + speaks the guidance + emits an
# orb_directive over the data channel for the frontend to apply.
@function_tool
async def navigate(context: RunContext, question: str) -> str:
    """Navigate the user to whatever screen best matches their natural-language
    request. Use this whenever the user expresses a navigation intent in their
    own words ("take me to my matches", "show me events this weekend", "where
    are my reminders?", "open my diary"). The system picks the catalog screen,
    redirects automatically, and you speak the guidance text it returns.

    Prefer this over `navigate_to_screen` when the user speaks free-text. Use
    `navigate_to_screen` ONLY when you already have an exact screen_id in hand
    (typically as the resolution of a previous `navigate` ambiguous decision).

    Args:
        question: The user's exact words describing where they want to go.
    """
    gw = _gw(context)
    body = await _dispatch_with_directive(
        context,
        "navigate",
        {
            "question": question,
            "current_route": gw.current_route,
            "recent_routes": list(gw.recent_routes or []),
        },
    )
    # Eagerly update GatewayClient state so the next get_current_screen call
    # (or the next gate-checked navigate_to_screen call) sees the fresh route.
    res = body.get("result") if isinstance(body, dict) else None
    if isinstance(res, dict):
        new_route = res.get("route")
        if isinstance(new_route, str) and new_route:
            previous = gw.current_route
            gw.current_route = new_route
            if previous and previous != new_route:
                trail = [r for r in (gw.recent_routes or []) if r != previous]
                gw.recent_routes = ([previous] + trail)[:5]
    return summarize(body)


# VTID-NAV-TIMEJOURNEY (PR 1.B-3) — answer "where am I?" reliably by reading
# the GatewayClient's tracked current_route + recent_routes (seeded from the
# bootstrap response in session.py and eagerly updated by future
# navigate-tool wrappers in PRs 1.B-4 / 1.B-5). Forwards both fields in the
# args payload so the shared tool_get_current_screen handler resolves them
# through the navigation catalog the same way it does for Vertex.
@function_tool
async def get_current_screen(context: RunContext) -> str:
    """Return the user's LIVE current screen — title, description, and the trail
    of screens they were on recently. Use this whenever the user asks "where am
    I?" / "what page am I on?" / "where was I just now?". Self-contained — does
    NOT need any user-supplied arguments.
    """
    gw = _gw(context)
    body = await _dispatch(
        context,
        "get_current_screen",
        {
            "current_route": gw.current_route,
            "recent_routes": list(gw.recent_routes or []),
        },
    )
    return summarize(body)



# ============================================================================
# BOOTSTRAP-VOICE-CATALOG-COMPLETE — every tool built out from the Voice Tools
# Catalog's `status: planned` backlog + P0 community-feature gaps. Handlers
# live server-side in services/gateway/src/services/orb-tools/*.ts, dispatched
# through the shared ORB_TOOL_REGISTRY via POST /api/v1/orb/tool — these
# wrappers are thin: marshal args, call _dispatch[_with_directive], summarize.
# ============================================================================

@function_tool
async def get_highest_vitana_index(context: RunContext) -> str:
    """Get the community member with the highest Vitana Index right now."""
    body = await _dispatch(context, "get_highest_vitana_index")
    return summarize(body)


@function_tool
async def get_top_in_pillar(context: RunContext, pillar: str) -> str:
    """Get the community member with the top score in ONE Vitana Index pillar."""
    body = await _dispatch(context, "get_top_in_pillar", {
            "pillar": pillar,
        })
    return summarize(body)


@function_tool
async def get_first_member(context: RunContext) -> str:
    """Get the very first (earliest-registered / OG) community member."""
    body = await _dispatch(context, "get_first_member")
    return summarize(body)


@function_tool
async def get_newest_member(context: RunContext) -> str:
    """Get the most recently joined community member."""
    body = await _dispatch(context, "get_newest_member")
    return summarize(body)


@function_tool
async def get_most_followed(context: RunContext) -> str:
    """Get the community member with the most followers."""
    body = await _dispatch(context, "get_most_followed")
    return summarize(body)


@function_tool
async def ask_who_is(context: RunContext, query: str) -> str:
    """Answer ANY free-form 'who is...?' superlative question about the"""
    body = await _dispatch(context, "ask_who_is", {
            "query": query,
        })
    return summarize(body)


@function_tool
async def list_diary_entries(context: RunContext, date_from: str | None = None, date_to: str | None = None, limit: float | None = None) -> str:
    """List the user's Daily Diary entries, newest first, optionally within a date window."""
    body = await _dispatch(context, "list_diary_entries", {
            "date_from": date_from,
            "date_to": date_to,
            "limit": limit,
        })
    return summarize(body)


@function_tool
async def get_diary_streak(context: RunContext) -> str:
    """Get the user's diary streak: current consecutive days with an entry plus their longest streak ever."""
    body = await _dispatch(context, "get_diary_streak")
    return summarize(body)


@function_tool
async def get_memory_timeline(context: RunContext, date_from: str | None = None, date_to: str | None = None, limit: float | None = None) -> str:
    """Chronological timeline of what Vitana remembers: memory items, extracted facts, and diary entries, newest first."""
    body = await _dispatch(context, "get_memory_timeline", {
            "date_from": date_from,
            "date_to": date_to,
            "limit": limit,
        })
    return summarize(body)


@function_tool
async def recall_memory_about(context: RunContext, topic: str, category: str | None = None) -> str:
    """Search stored memories and facts about ONE specific topic, person, or thing."""
    body = await _dispatch(context, "recall_memory_about", {
            "topic": topic,
            "category": category,
        })
    return summarize(body)


@function_tool
async def get_memory_garden_summary(context: RunContext) -> str:
    """Overview of the user's Memory Garden: how many memories are stored per category."""
    body = await _dispatch(context, "get_memory_garden_summary")
    return summarize(body)


@function_tool
async def forget_memory(context: RunContext, memory_id: str, confirm: bool | None = None) -> str:
    """Permanently delete ONE stored memory, only after the user explicitly confirms."""
    body = await _dispatch(context, "forget_memory", {
            "memory_id": memory_id,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def reschedule_event(context: RunContext, new_start: str, event_id: str | None = None, title_query: str | None = None, new_end: str | None = None, timezone: str | None = None) -> str:
    """Move an existing calendar event to a new start time (duration is kept unless new_end is given)."""
    body = await _dispatch(context, "reschedule_event", {
            "new_start": new_start,
            "event_id": event_id,
            "title_query": title_query,
            "new_end": new_end,
            "timezone": timezone,
        })
    return summarize(body)


@function_tool
async def cancel_event(context: RunContext, event_id: str | None = None, title_query: str | None = None, confirm: bool | None = None, timezone: str | None = None) -> str:
    """Cancel (soft-delete) a calendar event — the event stays in history with status 'cancelled'."""
    body = await _dispatch(context, "cancel_event", {
            "event_id": event_id,
            "title_query": title_query,
            "confirm": confirm,
            "timezone": timezone,
        })
    return summarize(body)


@function_tool
async def complete_event(context: RunContext, event_id: str | None = None, title_query: str | None = None, outcome: str | None = None, notes: str | None = None, timezone: str | None = None) -> str:
    """Mark a calendar event as completed, skipped, or partially done."""
    body = await _dispatch(context, "complete_event", {
            "event_id": event_id,
            "title_query": title_query,
            "outcome": outcome,
            "notes": notes,
            "timezone": timezone,
        })
    return summarize(body)


@function_tool
async def find_free_slot(context: RunContext, duration_minutes: float, search_from: str | None = None, search_to: str | None = None, timezone: str | None = None) -> str:
    """Find the next free slot of a given length in the user's calendar, within waking hours (8 AM-10 PM user-local)."""
    body = await _dispatch(context, "find_free_slot", {
            "duration_minutes": duration_minutes,
            "search_from": search_from,
            "search_to": search_to,
            "timezone": timezone,
        })
    return summarize(body)


@function_tool
async def get_event_details(context: RunContext, event_id: str | None = None, title_query: str | None = None, timezone: str | None = None) -> str:
    """Read the full details of ONE calendar event: exact time, end, location, type, status, notes."""
    body = await _dispatch(context, "get_event_details", {
            "event_id": event_id,
            "title_query": title_query,
            "timezone": timezone,
        })
    return summarize(body)


@function_tool
async def check_calendar_conflicts(context: RunContext, start_time: str, end_time: str | None = None, timezone: str | None = None) -> str:
    """Check whether a proposed time window overlaps existing confirmed calendar events."""
    body = await _dispatch(context, "check_calendar_conflicts", {
            "start_time": start_time,
            "end_time": end_time,
            "timezone": timezone,
        })
    return summarize(body)


@function_tool
async def snooze_reminder(context: RunContext, reminder_id: str | None = None, text_query: str | None = None, minutes: float | None = None) -> str:
    """Push an existing reminder out by N minutes (default 10, max 1440)."""
    body = await _dispatch(context, "snooze_reminder", {
            "reminder_id": reminder_id,
            "text_query": text_query,
            "minutes": minutes,
        })
    return summarize(body)


@function_tool
async def update_reminder(context: RunContext, reminder_id: str | None = None, text_query: str | None = None, new_text: str | None = None, new_time: str | None = None) -> str:
    """Edit an existing reminder's text and/or time."""
    body = await _dispatch(context, "update_reminder", {
            "reminder_id": reminder_id,
            "text_query": text_query,
            "new_text": new_text,
            "new_time": new_time,
        })
    return summarize(body)


@function_tool
async def acknowledge_reminder(context: RunContext, reminder_id: str | None = None, text_query: str | None = None) -> str:
    """Mark a fired reminder as heard/acknowledged so it stops being re-delivered."""
    body = await _dispatch(context, "acknowledge_reminder", {
            "reminder_id": reminder_id,
            "text_query": text_query,
        })
    return summarize(body)


@function_tool
async def complete_reminder(context: RunContext, reminder_id: str | None = None, text_query: str | None = None) -> str:
    """Mark a reminder as DONE (the user did the thing). Sets status=completed."""
    body = await _dispatch(context, "complete_reminder", {
            "reminder_id": reminder_id,
            "text_query": text_query,
        })
    return summarize(body)


@function_tool
async def list_missed_reminders(context: RunContext) -> str:
    """List reminders that fired but were never acknowledged (the user missed them)."""
    body = await _dispatch(context, "list_missed_reminders")
    return summarize(body)


@function_tool
async def set_alarm(context: RunContext, time: str, label: str | None = None, recurrence: str | None = None, timezone: str | None = None) -> str:
    """Set a wake-up/clock alarm at a specific time of day (optionally recurring)."""
    body = await _dispatch(context, "set_alarm", {
            "time": time,
            "label": label,
            "recurrence": recurrence,
            "timezone": timezone,
        })
    return summarize(body)


@function_tool
async def list_alarms(context: RunContext, timezone: str | None = None) -> str:
    """List the user's active alarms with times and labels."""
    body = await _dispatch(context, "list_alarms", {
            "timezone": timezone,
        })
    return summarize(body)


@function_tool
async def delete_alarm(context: RunContext, alarm_id: str | None = None, label: str | None = None, time: str | None = None, timezone: str | None = None, confirm: bool | None = None) -> str:
    """Cancel an alarm. Two-step confirm flow: first call WITHOUT confirm to find"""
    body = await _dispatch(context, "delete_alarm", {
            "alarm_id": alarm_id,
            "label": label,
            "time": time,
            "timezone": timezone,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def start_timer(context: RunContext, duration_minutes: float, label: str | None = None) -> str:
    """Start a countdown timer (1-1440 minutes)."""
    body = await _dispatch(context, "start_timer", {
            "duration_minutes": duration_minutes,
            "label": label,
        })
    return summarize(body)


@function_tool
async def start_pomodoro(context: RunContext, duration_minutes: float | None = None, label: str | None = None) -> str:
    """Start a pomodoro focus block (5-90 minutes; 25 if omitted)."""
    body = await _dispatch(context, "start_pomodoro", {
            "duration_minutes": duration_minutes,
            "label": label,
        })
    return summarize(body)


@function_tool
async def list_active_timers(context: RunContext) -> str:
    """List running timers and pomodoros with the remaining time on each."""
    body = await _dispatch(context, "list_active_timers")
    return summarize(body)


@function_tool
async def get_world_time(context: RunContext, location: str) -> str:
    """Get the current local time in a city or IANA timezone (no internet needed)."""
    body = await _dispatch(context, "get_world_time", {
            "location": location,
        })
    return summarize(body)


@function_tool
async def list_my_groups(context: RunContext) -> str:
    """List the community groups the user belongs to, with member counts."""
    body = await _dispatch(context, "list_my_groups")
    return summarize(body)


@function_tool
async def create_group(context: RunContext, name: str, description: str | None = None, privacy: str | None = None, confirm: bool | None = None) -> str:
    """Create a new community group. Requires a name; privacy is public or"""
    body = await _dispatch_with_directive(context, "create_group", {
            "name": name,
            "description": description,
            "privacy": privacy,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def join_group(context: RunContext, query: str | None = None, group_id: str | None = None) -> str:
    """Join a community group by name or group_id. Resolves fuzzy names and"""
    body = await _dispatch_with_directive(context, "join_group", {
            "query": query,
            "group_id": group_id,
        })
    return summarize(body)


@function_tool
async def invite_to_group(context: RunContext, group: str | None = None, group_id: str | None = None, member_name: str | None = None, member_user_id: str | None = None, message: str | None = None) -> str:
    """Invite another community member to a group. Resolves the member by"""
    body = await _dispatch(context, "invite_to_group", {
            "group": group,
            "group_id": group_id,
            "member_name": member_name,
            "member_user_id": member_user_id,
            "message": message,
        })
    return summarize(body)


@function_tool
async def accept_invitation(context: RunContext, invitation_id: str | None = None, group: str | None = None) -> str:
    """Accept a pending group invitation (joins the group). With no"""
    body = await _dispatch_with_directive(context, "accept_invitation", {
            "invitation_id": invitation_id,
            "group": group,
        })
    return summarize(body)


@function_tool
async def decline_invitation(context: RunContext, invitation_id: str | None = None, group: str | None = None, confirm: bool | None = None) -> str:
    """Decline a pending group invitation. ALWAYS call once WITHOUT confirm"""
    body = await _dispatch(context, "decline_invitation", {
            "invitation_id": invitation_id,
            "group": group,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def rsvp_event(context: RunContext, query: str | None = None, event_id: str | None = None) -> str:
    """RSVP / sign the user up for a community event or meetup, by event_id"""
    body = await _dispatch(context, "rsvp_event", {
            "query": query,
            "event_id": event_id,
        })
    return summarize(body)


@function_tool
async def cancel_rsvp(context: RunContext, query: str | None = None, event_id: str | None = None, confirm: bool | None = None) -> str:
    """Cancel the user's RSVP for an upcoming event. ALWAYS call once"""
    body = await _dispatch(context, "cancel_rsvp", {
            "query": query,
            "event_id": event_id,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def list_upcoming_meetups(context: RunContext) -> str:
    """List upcoming community meetups/events the user could attend, soonest"""
    body = await _dispatch(context, "list_upcoming_meetups")
    return summarize(body)


@function_tool
async def join_live_room(context: RunContext, query: str | None = None, room_id: str | None = None) -> str:
    """Join/open a community live room by name or room_id. Returns a"""
    body = await _dispatch_with_directive(context, "join_live_room", {
            "query": query,
            "room_id": room_id,
        })
    return summarize(body)


@function_tool
async def start_conversation(context: RunContext, member: str | None = None, member_user_id: str | None = None, message: str | None = None) -> str:
    """Start (or reuse) a direct-message conversation with a named community member,"""
    body = await _dispatch(context, "start_conversation", {
            "member": member,
            "member_user_id": member_user_id,
            "message": message,
        })
    return summarize(body)


@function_tool
async def list_conversations(context: RunContext, limit: float | None = None) -> str:
    """List the user's recent direct-message conversations, newest first, with"""
    body = await _dispatch(context, "list_conversations", {
            "limit": limit,
        })
    return summarize(body)


@function_tool
async def mark_conversation_read(context: RunContext, member: str | None = None, member_user_id: str | None = None, all: bool | None = None) -> str:
    """Mark direct messages as read. With member set, marks that conversation;"""
    body = await _dispatch(context, "mark_conversation_read", {
            "member": member,
            "member_user_id": member_user_id,
            "all": all,
        })
    return summarize(body)


@function_tool
async def mute_conversation(context: RunContext, member: str | None = None) -> str:
    """Mute a chat conversation. NOTE: chat muting is not supported in Vitana yet —"""
    body = await _dispatch(context, "mute_conversation", {
            "member": member,
        })
    return summarize(body)


@function_tool
async def archive_conversation(context: RunContext, member: str | None = None) -> str:
    """Archive a chat conversation. NOTE: chat archiving does not exist in Vitana —"""
    body = await _dispatch(context, "archive_conversation", {
            "member": member,
        })
    return summarize(body)


@function_tool
async def update_account_visibility(context: RunContext, visibility: str, confirm: bool | None = None) -> str:
    """Set the visibility of the user's WHOLE profile: public, followers_only, or private."""
    body = await _dispatch(context, "update_account_visibility", {
            "visibility": visibility,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def update_privacy_field(context: RunContext, field: str, visibility: str) -> str:
    """Set the visibility of ONE profile field: public, followers_only, or private."""
    body = await _dispatch(context, "update_privacy_field", {
            "field": field,
            "visibility": visibility,
        })
    return summarize(body)


@function_tool
async def block_user(context: RunContext, member: str | None = None, member_user_id: str | None = None, confirm: bool | None = None) -> str:
    """Block a community member so their posts and messages are hidden from the user."""
    body = await _dispatch(context, "block_user", {
            "member": member,
            "member_user_id": member_user_id,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def unblock_user(context: RunContext, member: str | None = None, member_user_id: str | None = None) -> str:
    """Unblock a previously blocked member so their posts and messages show again."""
    body = await _dispatch(context, "unblock_user", {
            "member": member,
            "member_user_id": member_user_id,
        })
    return summarize(body)


@function_tool
async def submit_bug_report(context: RunContext, summary: str, screen: str | None = None) -> str:
    """File a bug ticket (kind=bug) in the feedback pipeline. No persona swap —"""
    body = await _dispatch(context, "submit_bug_report", {
            "summary": summary,
            "screen": screen,
        })
    return summarize(body)


@function_tool
async def submit_support_ticket(context: RunContext, summary: str) -> str:
    """File a support ticket (kind=support_question) for a question the team"""
    body = await _dispatch(context, "submit_support_ticket", {
            "summary": summary,
        })
    return summarize(body)


@function_tool
async def submit_marketplace_dispute(context: RunContext, summary: str, order_reference: str | None = None) -> str:
    """File a marketplace dispute ticket (kind=marketplace_claim): refunds, wrong"""
    body = await _dispatch(context, "submit_marketplace_dispute", {
            "summary": summary,
            "order_reference": order_reference,
        })
    return summarize(body)


@function_tool
async def submit_account_issue(context: RunContext, summary: str) -> str:
    """File an account ticket (kind=account_issue): login problems, password or"""
    body = await _dispatch(context, "submit_account_issue", {
            "summary": summary,
        })
    return summarize(body)


@function_tool
async def list_my_tickets(context: RunContext) -> str:
    """List the user's OPEN feedback tickets (bugs, support, disputes, account)"""
    body = await _dispatch(context, "list_my_tickets")
    return summarize(body)


@function_tool
async def set_language(context: RunContext, language: str) -> str:
    """Set the user's app + voice language. Persists the same setting the app's"""
    body = await _dispatch(context, "set_language", {
            "language": language,
        })
    return summarize(body)


@function_tool
async def set_theme(context: RunContext, theme: str | None = None) -> str:
    """Handle a request to change the visual theme (light / dark / system)."""
    body = await _dispatch(context, "set_theme", {
            "theme": theme,
        })
    return summarize(body)


@function_tool
async def set_voice_preferences(context: RunContext, pace: str | None = None, voice: str | None = None, tone: str | None = None) -> str:
    """Tune the app's spoken-voice settings: pace (slow / normal / fast), voice"""
    body = await _dispatch(context, "set_voice_preferences", {
            "pace": pace,
            "voice": voice,
            "tone": tone,
        })
    return summarize(body)


@function_tool
async def list_connected_apps(context: RunContext) -> str:
    """List the user's connected integrations: Google, YouTube, social accounts,"""
    body = await _dispatch(context, "list_connected_apps")
    return summarize(body)


@function_tool
async def disconnect_app(context: RunContext, provider: str, confirm: bool | None = None) -> str:
    """Disconnect one connected integration (Google, YouTube, Instagram, an AI"""
    body = await _dispatch(context, "disconnect_app", {
            "provider": provider,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def global_search(context: RunContext, query: str, limit: float | None = None) -> str:
    """Unified community search across people, posts, events, groups, products,"""
    body = await _dispatch(context, "global_search", {
            "query": query,
            "limit": limit,
        })
    return summarize(body)


@function_tool
async def browse_news_feed(context: RunContext, limit: float | None = None, scope: str | None = None) -> str:
    """Read the community news feed aloud: recent posts with author and a"""
    body = await _dispatch(context, "browse_news_feed", {
            "limit": limit,
            "scope": scope,
        })
    return summarize(body)


@function_tool
async def snooze_recommendation(context: RunContext, recommendation: str, hours: float | None = None) -> str:
    """Snooze an Autopilot recommendation so it resurfaces later (default 24h,"""
    body = await _dispatch(context, "snooze_recommendation", {
            "recommendation": recommendation,
            "hours": hours,
        })
    return summarize(body)


@function_tool
async def dismiss_recommendation(context: RunContext, recommendation: str, reason: str | None = None, confirm: bool | None = None) -> str:
    """Dismiss an Autopilot recommendation for good (it will not come back)."""
    body = await _dispatch(context, "dismiss_recommendation", {
            "recommendation": recommendation,
            "reason": reason,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def explain_recommendation(context: RunContext, recommendation: str) -> str:
    """Explain WHY a specific Autopilot recommendation was suggested: its"""
    body = await _dispatch(context, "explain_recommendation", {
            "recommendation": recommendation,
        })
    return summarize(body)


@function_tool
async def update_intent(context: RunContext, intent: str, new_title: str | None = None, new_text: str | None = None, new_category: str | None = None) -> str:
    """Edit one of the user's OWN intent posts (title, description text, or"""
    body = await _dispatch(context, "update_intent", {
            "intent": intent,
            "new_title": new_title,
            "new_text": new_text,
            "new_category": new_category,
        })
    return summarize(body)


@function_tool
async def delete_intent(context: RunContext, intent: str, confirm: bool | None = None) -> str:
    """Take down one of the user's OWN intent posts from the board (closes it;"""
    body = await _dispatch(context, "delete_intent", {
            "intent": intent,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def browse_intent_board(context: RunContext, query: str | None = None, limit: float | None = None) -> str:
    """Browse the open community intent board (Open Asks): what other members"""
    body = await _dispatch(context, "browse_intent_board", {
            "query": query,
            "limit": limit,
        })
    return summarize(body)


@function_tool
async def dispute_match(context: RunContext, match_id: str | None = None, reason: str | None = None, reason_category: str | None = None, confirm: bool | None = None) -> str:
    """Open a dispute on a match the user is part of (no-show, misrepresented,"""
    body = await _dispatch(context, "dispute_match", {
            "match_id": match_id,
            "reason": reason,
            "reason_category": reason_category,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def find_perfect_match(context: RunContext, ask: str | None = None, kind_hint: str | None = None, confirmed: bool | None = None) -> str:
    """Flagship people-match: find the PERFECT person for the user — workout"""
    body = await _dispatch_with_directive(context, "find_perfect_match", {
            "ask": ask,
            "kind_hint": kind_hint,
            "confirmed": confirmed,
        })
    return summarize(body)


@function_tool
async def get_emotional_state(context: RunContext) -> str:
    """Read the user's current emotional and cognitive signals (D28): mood,"""
    body = await _dispatch(context, "get_emotional_state")
    return summarize(body)


@function_tool
async def get_situational_awareness(context: RunContext, timezone: str | None = None) -> str:
    """Summarize the user's current situation (D32): time-of-day window,"""
    body = await _dispatch(context, "get_situational_awareness", {
            "timezone": timezone,
        })
    return summarize(body)


@function_tool
async def get_availability(context: RunContext, timezone: str | None = None) -> str:
    """Check how available and ready the user is right now (D33): availability"""
    body = await _dispatch(context, "get_availability", {
            "timezone": timezone,
        })
    return summarize(body)


@function_tool
async def get_environmental_context(context: RunContext) -> str:
    """Read the user's environment and mobility context (D34): where they"""
    body = await _dispatch(context, "get_environmental_context")
    return summarize(body)


@function_tool
async def get_life_stage_context(context: RunContext) -> str:
    """Read the user's life-stage context (D40): life phase and stability,"""
    body = await _dispatch(context, "get_life_stage_context")
    return summarize(body)


@function_tool
async def follow_member(context: RunContext, name: str) -> str:
    """FOLLOW a community member by their spoken name."""
    body = await _dispatch(context, "follow_member", {
            "name": name,
        })
    return summarize(body)


@function_tool
async def unfollow_member(context: RunContext, name: str, confirmed: bool | None = None) -> str:
    """UNFOLLOW a community member by name. Two-step confirm:"""
    body = await _dispatch(context, "unfollow_member", {
            "name": name,
            "confirmed": confirmed,
        })
    return summarize(body)


@function_tool
async def get_notifications(context: RunContext, limit: float | None = None) -> str:
    """READ the user's recent notifications, unread first. Speakable."""
    body = await _dispatch(context, "get_notifications", {
            "limit": limit,
        })
    return summarize(body)


@function_tool
async def mark_notifications_read(context: RunContext, reference: str | None = None) -> str:
    """MARK notifications as read — all unread ones, or only those whose title"""
    body = await _dispatch(context, "mark_notifications_read", {
            "reference": reference,
        })
    return summarize(body)


@function_tool
async def get_wallet_balance(context: RunContext) -> str:
    """READ-ONLY wallet snapshot: balance per currency, active subscription,"""
    body = await _dispatch(context, "get_wallet_balance")
    return summarize(body)


@function_tool
async def update_profile(context: RunContext, display_name: str | None = None, bio: str | None = None, city: str | None = None, country: str | None = None, location: str | None = None, confirmed: bool | None = None) -> str:
    """UPDATE simple own-profile fields: display_name, bio, city, country, location."""
    body = await _dispatch(context, "update_profile", {
            "display_name": display_name,
            "bio": bio,
            "city": city,
            "country": country,
            "location": location,
            "confirmed": confirmed,
        })
    return summarize(body)


@function_tool
async def play_podcast(context: RunContext, query: str | None = None) -> str:
    """PLAY an internal Vitana Media Hub podcast by title or topic. Returns an"""
    body = await _dispatch_with_directive(context, "play_podcast", {
            "query": query,
        })
    return summarize(body)


@function_tool
async def like_post(context: RunContext, author_name: str, post_reference: str | None = None) -> str:
    """LIKE a community feed post — resolves 'the last post from <name>' to that"""
    body = await _dispatch(context, "like_post", {
            "author_name": author_name,
            "post_reference": post_reference,
        })
    return summarize(body)


@function_tool
async def comment_on_post(context: RunContext, author_name: str, text: str, post_reference: str | None = None, confirmed: bool | None = None) -> str:
    """COMMENT on a community feed post (public text). Two-step confirm:"""
    body = await _dispatch(context, "comment_on_post", {
            "author_name": author_name,
            "text": text,
            "post_reference": post_reference,
            "confirmed": confirmed,
        })
    return summarize(body)


@function_tool
async def dev_list_vtids(context: RunContext, status: str | None = None, limit: int | None = None) -> str:
    """DEVELOPER ONLY. List recent VTID tasks from the ledger (id, title, status)."""
    body = await _dispatch(context, "dev_list_vtids", {
            "status": status,
            "limit": limit,
        })
    return summarize(body)


@function_tool
async def dev_get_vtid_status(context: RunContext, vtid: str) -> str:
    """DEVELOPER ONLY. Get one VTID task by id — status, spec status, terminal state, claim."""
    body = await _dispatch(context, "dev_get_vtid_status", {
            "vtid": vtid,
        })
    return summarize(body)


@function_tool
async def dev_list_pending_approvals(context: RunContext, limit: int | None = None) -> str:
    """DEVELOPER ONLY. List PRs/actions waiting in the approvals queue (same queue as the Command Hub approvals view)."""
    body = await _dispatch(context, "dev_list_pending_approvals", {
            "limit": limit,
        })
    return summarize(body)


@function_tool
async def dev_count_approvals(context: RunContext) -> str:
    """DEVELOPER ONLY. Count how many items are pending approval."""
    body = await _dispatch(context, "dev_count_approvals")
    return summarize(body)


@function_tool
async def dev_approve_pr(context: RunContext, vtid: str | None = None, approval_id: str | None = None, confirm: bool | None = None) -> str:
    """DEVELOPER ONLY. Approve a queued approval — merges its PR via the governed pipeline."""
    body = await _dispatch(context, "dev_approve_pr", {
            "vtid": vtid,
            "approval_id": approval_id,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def dev_reject_pr(context: RunContext, reason: str, vtid: str | None = None, approval_id: str | None = None, confirm: bool | None = None) -> str:
    """DEVELOPER ONLY. Reject a queued approval and record why."""
    body = await _dispatch(context, "dev_reject_pr", {
            "reason": reason,
            "vtid": vtid,
            "approval_id": approval_id,
            "confirm": confirm,
        })
    return summarize(body)


@function_tool
async def dev_list_voice_sessions(context: RunContext, status: str | None = None, limit: int | None = None) -> str:
    """DEVELOPER ONLY. List recent ORB voice sessions from the Voice Lab (who, when, duration, turns)."""
    body = await _dispatch(context, "dev_list_voice_sessions", {
            "status": status,
            "limit": limit,
        })
    return summarize(body)


@function_tool
async def dev_list_routines(context: RunContext) -> str:
    """DEVELOPER ONLY. List the daily Claude routines with last-run status."""
    body = await _dispatch(context, "dev_list_routines")
    return summarize(body)


@function_tool
async def dev_get_routine_detail(context: RunContext, name: str, runs_limit: int | None = None) -> str:
    """DEVELOPER ONLY. Detail one routine plus its last runs."""
    body = await _dispatch(context, "dev_get_routine_detail", {
            "name": name,
            "runs_limit": runs_limit,
        })
    return summarize(body)


@function_tool
async def dev_list_active_healing(context: RunContext) -> str:
    """DEVELOPER ONLY. Show self-healing work currently in flight: active healing VTIDs and pending diagnoses."""
    body = await _dispatch(context, "dev_list_active_healing")
    return summarize(body)


@function_tool
async def dev_get_autonomy_pulse(context: RunContext) -> str:
    """DEVELOPER ONLY. One-shot autonomy status: pending findings, pending heals, executions"""
    body = await _dispatch(context, "dev_get_autonomy_pulse")
    return summarize(body)


@function_tool
async def dev_list_agents(context: RunContext, tier: str | None = None) -> str:
    """DEVELOPER ONLY. List registered agents with heartbeat-derived health (healthy/degraded/down)."""
    body = await _dispatch(context, "dev_list_agents", {
            "tier": tier,
        })
    return summarize(body)


# ---------------------------------------------------------------------------
# Catalogue export — used by tests + libcst smoke
# ---------------------------------------------------------------------------


def all_tool_names() -> list[str]:
    """Returns the names of every @function_tool in this module — the full
    catalogue the LiveKit Agent registers with the LLM.

    Each name corresponds to an entry in voice-pipeline-spec/spec.json.tools.
    Tools fall into two categories by transport:

    1. Direct routes — call a standalone gateway endpoint (calendar, reminders,
       intents, vitana-index, autopilot/recommendations, knowledge search).
    2. Dispatcher routes — call POST /api/v1/orb/tool (services/gateway/src/
       routes/orb-tool.ts) which wraps the inline Vertex case-body logic for
       tools that aren't exposed as standalone routes (search_memory,
       search_events, find_contact, send_chat_message, navigate_to_screen, …).

    All 40 names are active. The dispatcher returns structured graceful
    responses (not 404s) for tools whose underlying integration the user
    hasn't connected yet — the LLM narrates "you need to connect Spotify
    first" instead of apologizing about access.
    """
    return [
        # Memory / Knowledge / Recall (4)
        "search_memory", "search_knowledge", "search_web", "recall_conversation_at_time",
        # Persona / Handoff (2)
        "switch_persona", "report_to_specialist",
        # Calendar (4)
        "search_calendar", "create_calendar_event", "add_to_calendar", "get_schedule",
        # Community / Events / Recommendations (4) — find_community_member auto-redirects
        "search_events", "search_community", "find_community_member", "get_recommendations",
        # Media / Capability prefs (2)
        "play_music", "set_capability_preference",
        # Email / Contacts (2)
        "read_email", "find_contact",
        # External AI bridge (1)
        "consult_external_ai",
        # Life Compass (1) — VTID-03010 (L2.2b.6)
        "get_life_compass",
        # Journey Foundation (1) — VTID-03255: guided goal-gated dual-axis journey
        "record_journey_answer",
        # Vitana Index (3)
        "get_vitana_index", "get_index_improvement_suggestions", "create_index_improvement_plan",
        # Diary (1)
        "save_diary_entry",
        # Reminders (3)
        "set_reminder", "find_reminders", "delete_reminder",
        # Pillar agents / Feature explanations (2)
        "ask_pillar_agent", "explain_feature",
        # Structured Health logging — VTID-02753 (5)
        "log_water", "log_sleep", "log_exercise", "log_meditation",
        "get_pillar_subscores",
        # Messaging (2)
        "resolve_recipient", "send_chat_message",
        # Autopilot activation (1)
        "activate_recommendation",
        # Sharing (1)
        "share_link",
        # Vitana Intent Engine (8)
        "post_intent", "view_intent_matches", "list_my_intents", "respond_to_match",
        "mark_intent_fulfilled", "share_intent_post", "scan_existing_matches",
        "get_matchmaker_result",
        # VTID-03048: matchmaker parity — Vertex-catalog tools now exposed
        # on LiveKit. Implementations live in
        # services/gateway/src/services/orb-tools-shared.ts (tool_find_perfect_*)
        # and are reached through the shared dispatcher.
        "find_perfect_product", "find_perfect_practitioner",
        # Navigation (3)
        "navigate", "navigate_to_screen", "get_current_screen",
        # BOOTSTRAP-VOICE-CATALOG-COMPLETE — every tool built out from the
        # Voice Tools Catalog's `status: planned` backlog + P0 community-
        # feature gaps. Implementations live in services/gateway/src/
        # services/orb-tools/*.ts, reached through the shared dispatcher via
        # POST /api/v1/orb/tool exactly like the tools above.
        # Superlatives (6)
        "get_highest_vitana_index", "get_top_in_pillar", "get_first_member",
        "get_newest_member", "get_most_followed", "ask_who_is",
        # Diary + Memory (6)
        "list_diary_entries", "get_diary_streak", "get_memory_timeline",
        "recall_memory_about", "get_memory_garden_summary", "forget_memory",
        # Calendar management (6)
        "reschedule_event", "cancel_event", "complete_event", "find_free_slot",
        "get_event_details", "check_calendar_conflicts",
        # Reminders lifecycle (5)
        "snooze_reminder", "update_reminder", "acknowledge_reminder",
        "complete_reminder", "list_missed_reminders",
        # Clock (7)
        "set_alarm", "list_alarms", "delete_alarm", "start_timer",
        "start_pomodoro", "list_active_timers", "get_world_time",
        # Community groups (6)
        "list_my_groups", "create_group", "join_group", "invite_to_group",
        "accept_invitation", "decline_invitation",
        # Events / RSVP (4)
        "rsvp_event", "cancel_rsvp", "list_upcoming_meetups", "join_live_room",
        # Chat management (5)
        "start_conversation", "list_conversations", "mark_conversation_read",
        "mute_conversation", "archive_conversation",
        # Privacy (4)
        "update_account_visibility", "update_privacy_field", "block_user",
        "unblock_user",
        # Feedback (5)
        "submit_bug_report", "submit_support_ticket", "submit_marketplace_dispute",
        "submit_account_issue", "list_my_tickets",
        # Settings (5)
        "set_language", "set_theme", "set_voice_preferences",
        "list_connected_apps", "disconnect_app",
        # Search / News (2)
        "global_search", "browse_news_feed",
        # Autopilot recommendation management (3)
        "snooze_recommendation", "dismiss_recommendation", "explain_recommendation",
        # Intent management (4)
        "update_intent", "delete_intent", "browse_intent_board", "dispute_match",
        # Match (1)
        "find_perfect_match",
        # Awareness (5)
        "get_emotional_state", "get_situational_awareness", "get_availability",
        "get_environmental_context", "get_life_stage_context",
        # Developer — role-gated server-side (developer/admin/exafy_admin) (12)
        "dev_list_vtids", "dev_get_vtid_status", "dev_list_pending_approvals",
        "dev_count_approvals", "dev_approve_pr", "dev_reject_pr",
        "dev_list_voice_sessions", "dev_list_routines", "dev_get_routine_detail",
        "dev_list_active_healing", "dev_get_autonomy_pulse", "dev_list_agents",
        # P0 community-feature gaps (9)
        "follow_member", "unfollow_member", "get_notifications",
        "mark_notifications_read", "get_wallet_balance", "update_profile",
        "play_podcast", "like_post", "comment_on_post",
    ]


# All tools are now active. DEFERRED_TOOL_NAMES retained for parity-test
# back-compat — empty since the dispatcher (services/gateway/src/routes/
# orb-tool.ts) covers every previously-deferred tool with at least a
# graceful structured response.
DEFERRED_TOOL_NAMES: list[str] = []


def all_tools() -> list[Any]:
    """Returns the live @function_tool callables — the list passed to Agent(tools=...)."""
    import sys

    mod = sys.modules[__name__]
    return [getattr(mod, name) for name in all_tool_names()]
