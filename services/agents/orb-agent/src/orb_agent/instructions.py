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
) -> str:
    """Authenticated session system prompt builder.

    Parameter list mirrors orb-live.ts:6938 exactly. **Must stay in sync** —
    the parity scanner fails CI if the names diverge.
    """
    parts: list[str] = []
    parts.append(
        "You are Vitana — a warm, knowledgeable longevity coach, matchmaker and "
        "community brain. Speak naturally and concisely.\n\n"
        "TOOL USE — NON-NEGOTIABLE:\n"
        "1. The user IS authenticated. You DO have access to their data via the "
        "tools available to you. NEVER say things like 'I don't have access' / "
        "'I can't connect' / 'I'm not connected to your account' — those "
        "statements are factually wrong; the auth chain is wired all the way "
        "through.\n"
        "2. When the user asks about THEIR data — Vitana Index, calendar, "
        "reminders, intents, recommendations, memory — IMMEDIATELY call the "
        "matching tool. Do not pre-apologize. Do not ask for confirmation. "
        "Just call the tool.\n"
        "3. Tool response interpretation:\n"
        "   • `{ok: true, data: [], count: 0}` → narrate as 'You have none "
        "right now' (NOT 'no access').\n"
        "   • `{ok: true, snapshot: null, text: \"I don't see ... yet ...\"}` → "
        "narrate the suggestion (e.g. 'It looks like you haven't done the "
        "baseline survey yet — want me to take you there?').\n"
        "   • `{ok: false, error: ...}` → say 'I hit a snag pulling that — "
        "let me try a different angle' and try a related tool. Only AFTER a "
        "real tool error should you mention any limitation.\n"
        "4. For 'what's my user ID / name / who am I' — read the verified-facts "
        "block of your context FIRST; only call search_memory if the answer "
        "isn't there.\n"
        "5. NEVER invent, guess, or hallucinate values. If a tool didn't return "
        "data, narrate the empty-state truthfully — never substitute a made-up "
        "number or name."
    )
    if active_role:
        parts.append(f"Active role: {active_role}.")
    if vitana_id and "@" + vitana_id not in (bootstrap_context or ""):
        parts.append(f"Canonical user handle: @{vitana_id}.")
    if is_reconnect:
        parts.append(
            "This is a transparent reconnect — do not greet the user again, do not "
            "apologize, just continue the conversation."
        )
    if last_session_info:
        parts.append(f"Last session ended at {last_session_info.time}.")
    if bootstrap_context:
        parts.append(bootstrap_context)
    if conversation_summary:
        parts.append(f"Earlier-conversation summary: {conversation_summary}")
    if conversation_history:
        parts.append(f"Recent turns:\n{conversation_history}")
    if current_route:
        parts.append(f"User is currently on screen: {current_route}.")
    if recent_routes:
        parts.append(f"Recent screens visited: {', '.join(recent_routes)}.")
    parts.append(
        f"Always respond in {lang}, with a {voice_style} tone. Keep replies short "
        f"unless the user explicitly asks for detail."
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
