"""Tool catalogue.

Every tool in voice-pipeline-spec/spec.json.tools is exposed here as a
`@function_tool`-decorated async Python function — all 40 of them. Each is
a thin wrapper that calls the equivalent gateway HTTP endpoint and
serializes the result to a string for the LLM.

NOTHING in this file re-implements business logic. Every function is a
single httpx.post / httpx.get call against the gateway, plus arg validation
via Pydantic where appropriate. The gateway is the source of truth for tool
behaviour; the agent only marshals the call.

The libcst extractor in voice-pipeline-spec/tools/extract-py.py walks every
@function_tool decorator here and feeds the names into the parity scanner.
Tool names MUST match voice-pipeline-spec/spec.json.tools[].name exactly,
or the parity scanner CI flags drift.

Skeleton today: all 40 tool stubs raise NotImplementedError("VTID-LIVEKIT-FOUNDATION").
A follow-up PR fills each in by calling the listed gateway endpoint.
"""
from __future__ import annotations

import logging
from typing import Any

# livekit-agents plumbing — the runtime decorator is `@function_tool` from
# `livekit.agents.llm.tool_context`. We import it lazily so unit tests on
# this module don't need the full livekit stack.
try:
    from livekit.agents.llm import function_tool  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover

    def function_tool(*args: Any, **kwargs: Any):  # type: ignore[no-redef]
        """Fallback decorator when livekit-agents isn't installed (e.g. in unit tests)."""

        def _wrap(fn: Any) -> Any:
            return fn

        if args and callable(args[0]):
            return args[0]
        return _wrap


logger = logging.getLogger(__name__)

NOT_IMPL = "NotImplementedError(VTID-LIVEKIT-FOUNDATION): tool stub — see services/agents/orb-agent/src/orb_agent/tools.py"


# ---------------------------------------------------------------------------
# Memory / Knowledge / Recall
# ---------------------------------------------------------------------------


@function_tool
async def search_memory(query: str, limit: int = 5) -> str:
    """Search the user's personal memory garden for entries matching `query`.

    Args:
        query: Free-text search phrase.
        limit: Max number of entries to return (1..20).
    """
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def search_knowledge(query: str) -> str:
    """Search the Vitana Knowledge Hub (longevity, platform docs).

    Args:
        query: Free-text search phrase.
    """
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def search_web(query: str) -> str:
    """Web search via the configured external-search provider.

    Args:
        query: Free-text web search phrase.
    """
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def recall_conversation_at_time(when: str) -> str:
    """Recall what the user discussed at a given time (VTID-02052).

    Args:
        when: Natural-language time anchor, e.g. "yesterday morning", "two days ago".
    """
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Persona / Handoff
# ---------------------------------------------------------------------------


@function_tool
async def switch_persona(persona: str) -> str:
    """Switch within-Vitana voice/style persona (NOT specialist handoff).

    Args:
        persona: Target persona name (e.g. "warm", "concise", "playful").
    """
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def report_to_specialist(specialist: str, reason: str, context_summary: str) -> str:
    """Hand off to a specialist (Sage / Devon / Atlas / Mira / Vitana).

    Triggers the persona-swap flow in session.py. Each specialist has its own
    voice configured in agent_voice_configs.

    Args:
        specialist: One of: 'sage' | 'devon' | 'atlas' | 'mira' | 'vitana'.
        reason: Why the user is being handed off.
        context_summary: Short summary the specialist needs to pick up the conversation.
    """
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Calendar / Schedule
# ---------------------------------------------------------------------------


@function_tool
async def search_calendar(query: str, days_ahead: int = 14) -> str:
    """Search the user's calendar for upcoming events matching `query`."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def create_calendar_event(title: str, when_iso: str, duration_min: int = 60) -> str:
    """Create a calendar event."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def add_to_calendar(title: str, when_iso: str) -> str:
    """Add an event to the user's calendar (VTID-01943)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def get_schedule(date_iso: str | None = None) -> str:
    """Return the user's schedule for a given date (defaults to today)."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Community / Events / Recommendations
# ---------------------------------------------------------------------------


@function_tool
async def search_events(query: str) -> str:
    """Search community events / meetups (VTID-01270A)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def search_community(query: str) -> str:
    """Search community groups / channels (VTID-01270A)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def get_recommendations() -> str:
    """Return current Autopilot recommendations for the user (VTID-01180)."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Music / Capability preferences
# ---------------------------------------------------------------------------


@function_tool
async def play_music(query: str, provider: str | None = None) -> str:
    """Play music via Spotify / Apple Music / Google / Vitana Hub (VTID-01941)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def set_capability_preference(capability: str, provider: str) -> str:
    """Set the default provider for a capability (VTID-01942)."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Email / Contacts
# ---------------------------------------------------------------------------


@function_tool
async def read_email() -> str:
    """Read the user's recent unread emails (VTID-01943)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def find_contact(query: str) -> str:
    """Find a contact in the user's contact book (VTID-01943)."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# External AI bridge
# ---------------------------------------------------------------------------


@function_tool
async def consult_external_ai(prompt: str, provider: str | None = None) -> str:
    """Forward a prompt to the user's connected external AI account (ChatGPT / Claude / Gemini)."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Vitana Index
# ---------------------------------------------------------------------------


@function_tool
async def get_vitana_index() -> str:
    """Return the user's current Vitana Index score + per-pillar breakdown (VTID-01983)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def get_index_improvement_suggestions() -> str:
    """Return suggested actions that would lift the user's Vitana Index (VTID-01983)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def create_index_improvement_plan(target_pillar: str) -> str:
    """Create a multi-step plan to improve a specific pillar (VTID-01983)."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Diary
# ---------------------------------------------------------------------------


@function_tool
async def save_diary_entry(text: str) -> str:
    """Save a diary entry. Triggers Vitana Index recompute via /memory/diary/sync-index (VTID-01983)."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Reminders
# ---------------------------------------------------------------------------


@function_tool
async def set_reminder(text: str, when_iso: str) -> str:
    """Set a reminder (VTID-02601)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def find_reminders(query: str | None = None) -> str:
    """List the user's active reminders (VTID-02601)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def delete_reminder(reminder_id: str) -> str:
    """Delete a reminder (VTID-02601)."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Pillar agents / Feature explanations
# ---------------------------------------------------------------------------


@function_tool
async def ask_pillar_agent(pillar: str, question: str) -> str:
    """Ask a specific pillar agent (Nutrition / Hydration / Exercise / Sleep / Mental)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def explain_feature(feature: str) -> str:
    """Explain a Vitana feature in plain language."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Messaging (3-step send_message flow)
# ---------------------------------------------------------------------------


@function_tool
async def resolve_recipient(name: str) -> str:
    """Step 1 of 3-step send-message flow: resolve a name to candidates."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def send_chat_message(recipient_id: str, body: str) -> str:
    """Step 3: send the message after the user confirms the recipient."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Autopilot recommendations
# ---------------------------------------------------------------------------


@function_tool
async def activate_recommendation(recommendation_id: str) -> str:
    """Activate an Autopilot recommendation (VTID-01180)."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Sharing
# ---------------------------------------------------------------------------


@function_tool
async def share_link(url: str, with_recipient: str | None = None) -> str:
    """Share a link, optionally with a contact."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Vitana Intent Engine (VTID-01975 / VTID-01976)
# ---------------------------------------------------------------------------


@function_tool
async def post_intent(kind: str, body: str) -> str:
    """Post an intent (commercial_buy / sell, activity_seek, partner_seek, social_seek, mutual_aid) (VTID-01975)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def view_intent_matches() -> str:
    """View match candidates for the user's open intents (VTID-01976)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def list_my_intents() -> str:
    """List the user's open and historical intents."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def respond_to_match(match_id: str, response: str) -> str:
    """Respond to a match candidate (VTID-01976)."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def mark_intent_fulfilled(intent_id: str) -> str:
    """Mark an intent as fulfilled."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def share_intent_post(intent_id: str, with_recipient: str) -> str:
    """Share an intent post with a contact."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def scan_existing_matches() -> str:
    """Scan for matches across all open intents."""
    raise NotImplementedError(NOT_IMPL)


@function_tool
async def get_matchmaker_result(intent_id: str) -> str:
    """Get the matchmaker's current result for a specific intent."""
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Navigation
# ---------------------------------------------------------------------------


@function_tool
async def navigate_to_screen(target: str) -> str:
    """Navigate the user to a named screen.

    Cross-surface navigation (e.g. community user trying to go to /admin)
    is rejected with an LLM-visible error per
    memory/feedback_navigator_surface_scoping.md.

    Args:
        target: Named screen identifier from the spec's navigation registry.
    """
    raise NotImplementedError(NOT_IMPL)


# ---------------------------------------------------------------------------
# Catalogue export — used by tests + libcst smoke
# ---------------------------------------------------------------------------


def all_tool_names() -> list[str]:
    """Returns the names of every @function_tool in this module.

    Used by tests/test_tools.py to assert the tool list matches
    voice-pipeline-spec/spec.json. Update when adding/removing a tool.
    """
    return [
        "search_memory", "search_knowledge", "search_web", "recall_conversation_at_time",
        "switch_persona", "report_to_specialist",
        "search_calendar", "create_calendar_event", "add_to_calendar", "get_schedule",
        "search_events", "search_community", "get_recommendations",
        "play_music", "set_capability_preference",
        "read_email", "find_contact",
        "consult_external_ai",
        "get_vitana_index", "get_index_improvement_suggestions", "create_index_improvement_plan",
        "save_diary_entry",
        "set_reminder", "find_reminders", "delete_reminder",
        "ask_pillar_agent", "explain_feature",
        "resolve_recipient", "send_chat_message",
        "activate_recommendation",
        "share_link",
        "post_intent", "view_intent_matches", "list_my_intents", "respond_to_match",
        "mark_intent_fulfilled", "share_intent_post", "scan_existing_matches", "get_matchmaker_result",
        "navigate_to_screen",
    ]
