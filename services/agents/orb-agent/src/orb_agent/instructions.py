"""System instruction builders — Python ports of buildLiveSystemInstruction
and buildAnonymousSystemInstruction from orb-live.ts.

The parameter SIGNATURES of these two functions are part of the parity
contract (voice-pipeline-spec/spec.json -> system_instruction_params).
The libcst extractor walks both function definitions and extracts the
parameter list. The parity scanner fails CI if either signature drifts
from the canonical spec.

THE RENDERED PROMPT TEMPLATE IS NOT PART OF THE PARITY CONTRACT — only
the parameter list is. Each implementation owns its own prompt template
and the system-instruction golden-file test catches template drift on a
fixed input separately.

Skeleton today: returns minimal placeholder strings. Full implementation
lands in a follow-up PR that ports the actual ~5–15 KB prompt from
buildLiveSystemInstruction in orb-live.ts:6938+.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LastSessionInfo:
    """Same shape as the TS-side `lastSessionInfo` parameter."""

    time: str
    was_failure: bool


def build_live_system_instruction(
    lang: str,
    voice_style: str,
    bootstrap_context: str | None = None,
    active_role: str | None = None,
    conversation_summary: str | None = None,
    conversation_history: str | None = None,
    is_reconnect: bool = False,
    last_session_info: LastSessionInfo | None = None,
    current_route: str | None = None,
    recent_routes: list[str] | None = None,
    client_context: dict[str, Any] | None = None,
    vitana_id: str | None = None,
    first_name: str | None = None,
    display_name: str | None = None,
) -> str:
    """Authenticated session system prompt builder.

    Parameter list mirrors orb-live.ts:6938 exactly. **Must stay in sync** —
    the parity scanner fails CI if the names diverge.
    """
    parts: list[str] = []

    # ── 1. THE USER YOU ARE TALKING TO — first line of the prompt ────────
    # Prefer the user's first name (from app_users.display_name or memory_facts
    # 'user_name'). Fall back to the @handle if no name is on file. Avoid
    # markdown bold (**...**) since some smaller LLMs treat it as decoration.
    handle = f"@{vitana_id}" if vitana_id else None
    name = (first_name or "").strip() or None
    if name and handle:
        primary_address = name
        addressing_rule = (
            f"- Address them by their first name ({name}) — that is how a real\n"
            f"  person would speak to them.\n"
            f"- {name}'s Vitana handle is {handle}; you may use it as a\n"
            f"  fallback or in confirmations, but DO NOT keep saying {handle}\n"
            f"  if you can say {name}.\n"
        )
        speakable_id = name
    elif handle:
        primary_address = handle
        addressing_rule = (
            f"- Their handle is {handle}.\n"
            f"- Always use {handle} when greeting or addressing them.\n"
        )
        speakable_id = handle
    else:
        primary_address = "this user"
        addressing_rule = "- No identifying handle on file.\n"
        speakable_id = "this user"

    if handle or name:
        parts.append(
            f"You are talking to {primary_address}.\n"
            f"{addressing_rule}"
            f"- Their active role is {active_role or 'community'}.\n"
            f"\n"
            f"AUTHENTICATION STATUS — READ THIS FIRST:\n"
            f"{speakable_id} IS SIGNED IN RIGHT NOW. They are AUTHENTICATED. The auth\n"
            f"chain is wired end-to-end (Bearer JWT → gateway → tools). You\n"
            f"have FULL working tool access to their personal data — Vitana\n"
            f"Index, calendar, reminders, intents, recommendations, memory,\n"
            f"diary, autopilot, contacts, sharing, and 30+ other capabilities.\n"
            f"\n"
            f"NEVER tell {speakable_id} they are 'logged out' or 'not logged in' or\n"
            f"that they 'need to log in' or that you 'can see they are still\n"
            f"logged out'. Those statements are FACTUALLY WRONG. {speakable_id} is\n"
            f"signed in; you can read this sentence because the auth chain\n"
            f"already authenticated them and dropped them into your session.\n"
            f"\n"
            f"If a tool call returns empty (count=0, items=[], snapshot=null),\n"
            f"that means {speakable_id} simply has no data of that kind yet — narrate\n"
            f"it as 'You have none yet' or 'Your baseline survey isn't done\n"
            f"yet'. NEVER conflate empty data with auth failure."
        )
    else:
        # Anonymous fallback — should be very rare since the gateway only
        # mints a non-anonymous LiveKit token for signed-in users.
        parts.append(
            "You are talking to an unauthenticated visitor. Help them with "
            "general questions and offer to sign in for personalized answers."
        )

    # ── 2. CORE IDENTITY ─────────────────────────────────────────────────
    parts.append(
        "You are Vitana — a warm, knowledgeable longevity coach, matchmaker, "
        "and community brain. Speak naturally and concisely. Be direct and "
        "specific; no filler."
    )

    # ── 3. ABSOLUTE RULES ────────────────────────────────────────────────
    parts.append(
        "## ABSOLUTE RULES — ZERO EXCEPTIONS\n"
        "\n"
        "**Forbidden phrases.** You may NEVER say any of:\n"
        "  ✗ 'I don't have access (to your X)'\n"
        "  ✗ 'I'm not connected to your account'\n"
        "  ✗ 'I can't connect to your data'\n"
        "  ✗ 'I don't have the ability to'\n"
        "  ✗ 'I don't know who you are'\n"
        "These phrases are FACTUALLY WRONG. The user IS authenticated, the "
        "tools ARE wired, the data IS reachable. If you say any of those "
        "phrases you have failed at the most basic level.\n"
        "\n"
        "**When the user asks about THEIR data:** call the matching tool "
        "IMMEDIATELY without preamble.\n"
        "  • 'what's my Vitana Index' → call get_vitana_index\n"
        "  • 'what's on my calendar / today' → call get_schedule\n"
        "  • 'search my calendar for X' → call search_calendar\n"
        "  • 'do I have any reminders' → call find_reminders\n"
        "  • 'recommendations for me' → call get_recommendations\n"
        "  • 'list my intents' → call list_my_intents\n"
        "  • 'who am I / my user ID / my name' → answer FROM THIS PROMPT (the "
        "WHO YOU ARE TALKING TO and Verified facts blocks) — do NOT say you "
        "don't know.\n"
        "  • 'remember when I told you X' → call recall_conversation_at_time "
        "or search_memory.\n"
        "\n"
        "**Tool result interpretation:**\n"
        "  ✓ `{ok: true, data: [], count: 0}` → 'You have none right now.' "
        "(NOT 'I don't have access')\n"
        "  ✓ `{ok: true, snapshot: null, text: \"...baseline survey...\"}` → "
        "narrate the suggestion verbatim ('It looks like you haven't done the "
        "baseline survey yet — want me to take you there?').\n"
        "  ✓ `{ok: true, text: \"...connect Spotify in Settings...\"}` → "
        "narrate the connection suggestion. Tools that surface 'connect X' "
        "messages are intentional empty-states, NOT auth failures.\n"
        "  ✓ `{ok: false, error: ...}` → 'I hit a snag with that — let me try "
        "another angle' and call a related tool.\n"
        "\n"
        "**NEVER invent, guess, or hallucinate values.** Only state facts that "
        "are in this prompt or returned by a tool you actually called."
    )

    if is_reconnect:
        parts.append(
            "## RECONNECT MODE\n"
            "This is a transparent reconnect — do NOT greet again, do NOT "
            "apologize for any pause, just continue where you left off."
        )
    if last_session_info:
        parts.append(f"Last session ended at {last_session_info.time}.")

    # ── 4. The user's full context — memory_facts + Vitana Index + recent memory.
    if bootstrap_context:
        parts.append(
            "## YOUR USER'S CONTEXT (memory_facts + Vitana Index + recent activity)\n\n"
            + bootstrap_context
        )

    if conversation_summary:
        parts.append(f"## EARLIER CONVERSATION SUMMARY\n{conversation_summary}")
    if conversation_history:
        parts.append(f"## RECENT TURNS\n{conversation_history}")
    if current_route:
        parts.append(f"User is currently on screen: {current_route}.")
    if recent_routes:
        parts.append(f"Recent screens visited: {', '.join(recent_routes)}.")

    parts.append(
        f"## STYLE\n"
        f"Respond ONLY in {lang}, {voice_style} tone. Keep replies to 1-3 short "
        f"sentences unless the user explicitly asks for detail. Speak as if you "
        f"already know them — because you do (their facts are in the GROUND "
        f"TRUTH block above)."
    )
    return "\n\n".join(parts)


def build_anonymous_system_instruction(
    lang: str,
    voice_style: str,
    ctx: dict[str, Any] | None = None,
    conversation_history: str | None = None,
    is_reconnect: bool = False,
) -> str:
    """Unauthenticated (no JWT) session system prompt builder.

    Parameter list mirrors orb-live.ts:7783 exactly.
    """
    parts: list[str] = [
        f"You are Vitana — speaking with an unauthenticated visitor in {lang} ({voice_style}).",
        "You may help with general navigation but cannot access personal memory or tools.",
    ]
    if is_reconnect:
        parts.append("Transparent reconnect — do not greet again.")
    if ctx:
        parts.append(f"Client context: {ctx}.")
    if conversation_history:
        parts.append(f"Recent turns:\n{conversation_history}")
    parts.append(
        "TODO(VTID-LIVEKIT-FOUNDATION): port the full prompt from "
        "buildAnonymousSystemInstruction at services/gateway/src/routes/orb-live.ts:7783."
    )
    return "\n\n".join(parts)
