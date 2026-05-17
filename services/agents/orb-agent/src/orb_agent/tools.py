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
    return await _gw(ctx).post("/api/v1/orb/tool", {"name": name, "args": args or {}})


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
    """File a customer-support ticket and hand the call to a specialist.

    Mirrors Vertex's tool schema (voice-pipeline-spec/spec.json). The
    gateway creates a real feedback_tickets row + handoff event + OASIS
    emit. If the response includes a `persona`, this wrapper SIGNALS the
    agent's main loop to rebuild the AgentSession for that persona —
    Devon answers in Devon's voice with Devon's system_instruction.

    VTID-03033 — Observability + fail-loud:
    - Emits `orb.livekit.tool.report_to_specialist.called` before dispatch
      and `.result` after, so an operator reading OASIS can distinguish:
        (1) LLM never called the tool — no `called` event for the turn.
        (2) Tool called, backend returned stay_inline — `.result` payload
            carries status="stay_inline" + rpc_gate.
        (3) Tool called, backend created handoff — status="handoff_created"
            + persona name.
        (4) Tool called, gateway/network failed — status="failed" or
            "failed_network" + gateway_status / error.
    - Returns a deterministic, machine-keyed text to the LLM (replaces
      the free-text `summarize(body)` that let Gemini hallucinate "I'm
      connecting you to Devon" even on stay_inline / failed outcomes).
      The text always opens with `STATUS: <status>.` so the model has a
      single token to read; the action sentence that follows tells it
      what to say to the user.

    Args:
        kind: Best classification of what's being reported. One of:
            'bug', 'ux_issue', 'support_question', 'account_issue',
            'marketplace_claim', 'feature_request', 'feedback'.
        summary: Concrete description in the user's own words (>= 15
            words). What broke, on which screen/feature, with specifics.
        specialist_hint: Optional persona key.
    """
    gw = _gw(context)
    oasis = getattr(gw, "oasis_emitter", None)
    orb_session_id = getattr(gw, "orb_session_id", None) or ""
    user_id = getattr(gw, "user_id", None) or ""

    args: dict[str, Any] = {"kind": kind, "summary": summary}
    if specialist_hint:
        args["specialist_hint"] = specialist_hint

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
async def resolve_recipient(context: RunContext, name: str) -> str:
    """Step 1 of 3-step send-message flow: resolve a name to candidates."""
    body = await _dispatch(context, "resolve_recipient", {"name": name})
    return summarize(body)


@function_tool
async def send_chat_message(context: RunContext, recipient_id: str, body_text: str) -> str:
    """Step 3: send the message after the user confirms the recipient."""
    body = await _dispatch(
        context, "send_chat_message", {"recipient_id": recipient_id, "body_text": body_text}
    )
    return summarize(body)


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
        # Navigation (3)
        "navigate", "navigate_to_screen", "get_current_screen",
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
