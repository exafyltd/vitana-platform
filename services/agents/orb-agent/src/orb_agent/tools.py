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
from typing import Any

from .gateway_client import GatewayClient, summarize

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
    body = await _gw(context).post("/api/v1/memory/search", {"query": query, "limit": min(20, max(1, limit))})
    return summarize(body)


@function_tool
async def search_knowledge(context: RunContext, query: str) -> str:
    """Search the Vitana Knowledge Hub (longevity, platform docs)."""
    body = await _gw(context).post("/api/v1/assistant/knowledge/search", {"query": query})
    return summarize(body)


@function_tool
async def search_web(context: RunContext, query: str) -> str:
    """Web search via the configured external-search provider."""
    body = await _gw(context).post("/api/v1/web/search", {"query": query})
    return summarize(body)


@function_tool
async def recall_conversation_at_time(context: RunContext, when: str) -> str:
    """Recall what the user discussed at a given time (VTID-02052).

    Args:
        when: Natural-language time anchor, e.g. "yesterday morning", "two days ago".
    """
    body = await _gw(context).post("/api/v1/memory/recall-at-time", {"when": when})
    return summarize(body)


# ---------------------------------------------------------------------------
# Persona / Handoff
# ---------------------------------------------------------------------------


@function_tool
async def switch_persona(context: RunContext, persona: str) -> str:
    """Switch within-Vitana voice/style persona (NOT specialist handoff).

    Args:
        persona: Target persona name (e.g. "warm", "concise", "playful").
    """
    body = await _gw(context).post("/api/v1/orb/persona/switch", {"persona": persona})
    return summarize(body)


@function_tool
async def report_to_specialist(
    context: RunContext, specialist: str, reason: str, context_summary: str
) -> str:
    """Hand off to a specialist (Sage / Devon / Atlas / Mira / Vitana).

    Triggers the persona-swap flow in session.py. Each specialist has its own
    voice configured in agent_voice_configs.

    Args:
        specialist: One of: 'sage' | 'devon' | 'atlas' | 'mira' | 'vitana'.
        reason: Why the user is being handed off.
        context_summary: Short summary the specialist needs to pick up the conversation.
    """
    body = await _gw(context).post(
        "/api/v1/orb/handoff",
        {"specialist": specialist, "reason": reason, "context_summary": context_summary},
    )
    return summarize(body)


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
    """Create a calendar event."""
    body = await _gw(context).post(
        "/api/v1/calendar/events",
        {"title": title, "when_iso": when_iso, "duration_min": duration_min},
    )
    return summarize(body)


@function_tool
async def add_to_calendar(context: RunContext, title: str, when_iso: str) -> str:
    """Add an event to the user's calendar (VTID-01943)."""
    body = await _gw(context).post(
        "/api/v1/calendar/events",
        {"title": title, "when_iso": when_iso},
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
async def search_events(context: RunContext, query: str) -> str:
    """Search community events / meetups (VTID-01270A)."""
    body = await _gw(context).get("/api/v1/community/events/search", {"query": query})
    return summarize(body)


@function_tool
async def search_community(context: RunContext, query: str) -> str:
    """Search community groups / channels (VTID-01270A)."""
    body = await _gw(context).get("/api/v1/community/groups/search", {"query": query})
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
    body = await _gw(context).post(
        "/api/v1/integrations/music/play",
        {"query": query, "provider": provider} if provider else {"query": query},
    )
    return summarize(body)


@function_tool
async def set_capability_preference(context: RunContext, capability: str, provider: str) -> str:
    """Set the default provider for a capability (VTID-01942)."""
    body = await _gw(context).put(
        "/api/v1/integrations/preferences",
        {"capability": capability, "provider": provider},
    )
    return summarize(body)


# ---------------------------------------------------------------------------
# Email / Contacts
# ---------------------------------------------------------------------------


@function_tool
async def read_email(context: RunContext) -> str:
    """Read the user's recent unread emails (VTID-01943)."""
    body = await _gw(context).get("/api/v1/integrations/email/recent")
    return summarize(body)


@function_tool
async def find_contact(context: RunContext, query: str) -> str:
    """Find a contact in the user's contact book (VTID-01943)."""
    body = await _gw(context).get("/api/v1/contacts/search", {"query": query})
    return summarize(body)


# ---------------------------------------------------------------------------
# External AI bridge
# ---------------------------------------------------------------------------


@function_tool
async def consult_external_ai(
    context: RunContext, prompt: str, provider: str | None = None
) -> str:
    """Forward a prompt to the user's connected external AI account (ChatGPT / Claude / Gemini)."""
    payload: dict[str, Any] = {"prompt": prompt}
    if provider:
        payload["provider"] = provider
    body = await _gw(context).post("/api/v1/integrations/ai-assistants/forward", payload)
    return summarize(body)


# ---------------------------------------------------------------------------
# Vitana Index
# ---------------------------------------------------------------------------


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
    body = await _gw(context).post(
        "/api/v1/vitana-index/plan", {"target_pillar": target_pillar}
    )
    return summarize(body)


# ---------------------------------------------------------------------------
# Diary
# ---------------------------------------------------------------------------


@function_tool
async def save_diary_entry(context: RunContext, text: str) -> str:
    """Save a diary entry. Triggers Vitana Index recompute via /memory/diary/sync-index (VTID-01983)."""
    body = await _gw(context).post("/api/v1/memory/diary/sync-index", {"raw_text": text})
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
    body = await _gw(context).post(
        "/api/v1/pillar-agents/ask", {"pillar": pillar, "question": question}
    )
    return summarize(body)


@function_tool
async def explain_feature(context: RunContext, feature: str) -> str:
    """Explain a Vitana feature in plain language."""
    body = await _gw(context).get("/api/v1/features/explain", {"feature": feature})
    return summarize(body)


# ---------------------------------------------------------------------------
# Messaging (3-step send_message flow)
# ---------------------------------------------------------------------------


@function_tool
async def resolve_recipient(context: RunContext, name: str) -> str:
    """Step 1 of 3-step send-message flow: resolve a name to candidates."""
    body = await _gw(context).post("/api/v1/messaging/candidate", {"name": name})
    return summarize(body)


@function_tool
async def send_chat_message(context: RunContext, recipient_id: str, body_text: str) -> str:
    """Step 3: send the message after the user confirms the recipient."""
    body = await _gw(context).post(
        "/api/v1/messaging/send", {"recipient_id": recipient_id, "body": body_text}
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
    payload: dict[str, Any] = {"url": url}
    if with_recipient:
        payload["with_recipient"] = with_recipient
    body = await _gw(context).post("/api/v1/sharing/link", payload)
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
async def view_intent_matches(context: RunContext) -> str:
    """View match candidates for the user's open intents (VTID-01976)."""
    # Mounted at /api/v1/intent-matches/{outgoing,incoming}; surface incoming
    # matches (the ones the LLM cares about — what came back to the user).
    body = await _gw(context).get("/api/v1/intent-matches/incoming")
    return summarize(body)


@function_tool
async def list_my_intents(context: RunContext) -> str:
    """List the user's open and historical intents."""
    body = await _gw(context).get("/api/v1/intents")
    return summarize(body)


@function_tool
async def respond_to_match(context: RunContext, match_id: str, response: str) -> str:
    """Respond to a match candidate (VTID-01976)."""
    # /api/v1/intent-matches/:id/state takes {state} as body; pass the user's
    # 'response' string through unchanged and let the gateway map it.
    body = await _gw(context).post(
        f"/api/v1/intent-matches/{match_id}/state", {"state": response}
    )
    return summarize(body)


@function_tool
async def mark_intent_fulfilled(context: RunContext, intent_id: str) -> str:
    """Mark an intent as fulfilled."""
    body = await _gw(context).post(f"/api/v1/intents/{intent_id}/close")
    return summarize(body)


@function_tool
async def share_intent_post(context: RunContext, intent_id: str, with_recipient: str) -> str:
    """Share an intent post with a contact."""
    body = await _gw(context).post(
        f"/api/v1/intents/{intent_id}/share", {"with_recipient": with_recipient}
    )
    return summarize(body)


@function_tool
async def scan_existing_matches(context: RunContext) -> str:
    """Scan for matches across all open intents."""
    body = await _gw(context).post("/api/v1/intents/scan-matches")
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
    body = await _gw(context).post("/api/v1/navigator/dispatch", {"target": target})
    return summarize(body)


# ---------------------------------------------------------------------------
# Catalogue export — used by tests + libcst smoke
# ---------------------------------------------------------------------------


def all_tool_names() -> list[str]:
    """Returns the names of every @function_tool in this module that has a
    working gateway endpoint right now.

    Tools whose business logic is currently inline in orb-live.ts (Vertex
    pipeline) and not yet exposed as standalone HTTP routes are tracked in
    DEFERRED_TOOL_NAMES below. Re-enable each there as its endpoint lands.

    Used by tests/test_tools_catalogue.py to assert the tool list matches
    voice-pipeline-spec/spec.json. Update when wiring or unwiring a tool.
    """
    return [
        # Memory / Knowledge
        "search_knowledge",
        # Calendar (4)
        "search_calendar", "create_calendar_event", "add_to_calendar", "get_schedule",
        # Recommendations (2)
        "get_recommendations", "activate_recommendation",
        # Vitana Index (2)
        "get_vitana_index", "get_index_improvement_suggestions",
        # Diary
        "save_diary_entry",
        # Reminders (3)
        "set_reminder", "find_reminders", "delete_reminder",
        # Intents (5)
        "post_intent", "view_intent_matches", "list_my_intents",
        "mark_intent_fulfilled", "get_matchmaker_result",
    ]


# Tools whose Vertex implementation is INLINE inside orb-live.ts case
# blocks (not exposed as HTTP routes). Calling their gateway URL today
# returns 404 because no router handles it. Each lands in a follow-up
# PR that either (a) lifts the inline logic into a route file, or (b)
# adds a generic POST /api/v1/orb/tool dispatcher that wraps the inline
# logic. Until then we exclude them from the live catalogue so the LLM
# doesn't try to call them and apologize for "no access".
DEFERRED_TOOL_NAMES: list[str] = [
    "search_memory",                  # orb-live.ts:4125 inline
    "search_web",                     # orb-live.ts:4232 inline
    "recall_conversation_at_time",    # no Vertex equivalent
    "switch_persona",                 # orb-live.ts:2385 inline
    "report_to_specialist",           # orb-live.ts:4458 — PR 5/6
    "search_events",                  # orb-live.ts inline
    "search_community",               # orb-live.ts inline
    "play_music",                     # orb-live.ts:5251 inline
    "set_capability_preference",      # orb-live.ts:5385 inline
    "read_email",                     # orb-live.ts:5449 inline
    "find_contact",                   # orb-live.ts:5452 inline
    "consult_external_ai",            # orb-live.ts:2549 inline (path mismatch)
    "create_index_improvement_plan",  # orb-live.ts:5758 inline
    "ask_pillar_agent",               # orb-live.ts:6183 inline
    "explain_feature",                # orb-live.ts:6231 inline
    "resolve_recipient",              # orb-live.ts:6278 inline
    "send_chat_message",              # orb-live.ts:6326 inline
    "share_link",                     # orb-live.ts inline
    "scan_existing_matches",          # orb-live.ts inline
    "share_intent_post",              # orb-live.ts inline
    "respond_to_match",               # path uncertain — need check
    "navigate_to_screen",             # orb-live.ts:6959 inline
]


def all_tools() -> list[Any]:
    """Returns the live @function_tool callables — the list passed to Agent(tools=...)."""
    import sys

    mod = sys.modules[__name__]
    return [getattr(mod, name) for name in all_tool_names()]
