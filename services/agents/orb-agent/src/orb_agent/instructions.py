"""System instruction builders — L2.2b.6 (VTID-03010) passthrough.

Until L2.2b.6, this module re-implemented the Gemini system-prompt build
in Python. The Vertex side (services/gateway/src/orb/live/instruction/
live-system-instruction.ts) and this Python side drifted: Vertex carried
~17 sections (identity lock, greeting policy, activity awareness, intent
classifier, route integrity, retired-pillar handling, diary-logging tool
rules, AVAILABLE TOOLS catalog, etc.) while this builder had ~7. The LLM
behaved radically differently depending on which pipeline served the
session.

L2.2b.6 moves the source of truth into the gateway: GET /api/v1/orb/
context-bootstrap now renders `buildLiveSystemInstruction(...)` and
returns the rendered string under `system_instruction`. The agent reads
that field verbatim — the Python builders here are now thin fallbacks
used only when the gateway response did not include the field
(pre-L2.2b.6 gateway, or render exception).

The parameter SIGNATURES of the two builders are still part of the
parity contract (voice-pipeline-spec/spec.json -> system_instruction_params).
The libcst extractor walks both function definitions; the parity scanner
fails CI if either signature drifts. The internal body of the fallback
builder is intentionally minimal — it exists only as a safety net.
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
    """L2.2b.6 fallback builder.

    Used ONLY when the gateway's /orb/context-bootstrap response did not
    include `system_instruction` (pre-L2.2b.6 deploy, or render exception).
    Produces a minimal prompt that still gets the agent talking; the
    canonical prompt comes from the gateway.

    Parameter list mirrors orb-live.ts `buildLiveSystemInstruction` exactly
    — the parity scanner fails CI if names diverge.
    """
    parts: list[str] = []

    handle = f"@{vitana_id}" if vitana_id else None
    name = (first_name or "").strip() or None
    primary_address = name or handle or "this user"

    parts.append(
        f"You are Vitana — speaking with {primary_address} in {lang} "
        f"({voice_style}). Be warm, concise, and direct."
    )
    if active_role:
        parts.append(f"User role: {active_role}.")
    if is_reconnect:
        parts.append(
            "This is a transparent reconnect. Do NOT greet again — continue mid-thought."
        )
    if last_session_info:
        parts.append(f"Last session ended at {last_session_info.time}.")
    if bootstrap_context:
        parts.append(f"## YOUR USER'S CONTEXT\n\n{bootstrap_context}")
    if conversation_summary:
        parts.append(f"## EARLIER CONVERSATION SUMMARY\n{conversation_summary}")
    if conversation_history:
        parts.append(f"## RECENT TURNS\n{conversation_history}")
    if current_route:
        parts.append(f"User is currently on screen: {current_route}.")
    if recent_routes:
        parts.append(f"Recent screens visited: {', '.join(recent_routes)}.")
    parts.append(
        "FALLBACK MODE — the gateway did not render the full system "
        "instruction. Answer the user's question using the context above; "
        "call tools when their description matches the user's ask; never "
        "say 'I don't have access'."
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

    L2.2b.6 leaves the anonymous fallback Python-side; the gateway's
    `system_instruction` field is empty for anonymous sessions (it is
    built via `buildLiveSystemInstruction`, which is authenticated-only).
    Parameter list mirrors the TS `buildAnonymousSystemInstruction`.
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
    return "\n\n".join(parts)
