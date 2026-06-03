"""
PATCH STUB — Phase A (Bootstrap context hard cap) — LiveKit parity.

WHERE THIS GOES
    Repo:  exafyltd/vitana-platform (NOT present in the autonomous sandbox checkout)
    File:  services/agents/orb-agent/session.py
    The LiveKit Python agent assembles its own system instruction independently of the
    gateway's TypeScript `buildLiveSystemInstruction`. The gateway side is capped by
    PR (Phase A) via `bootstrap-cap.ts`. This stub gives the agent the SAME safety net
    so a heavy user can't overflow the agent-side instruction either.

WHY A STUB
    `services/agents/orb-agent/session.py` does not exist in the sandbox checkout used by
    the autonomous run, so this code cannot be applied or built here. A human with the
    full tree should paste the equivalent into the agent's instruction-assembly path.

ACCEPTANCE (after applying)
    - Agent instruction containing a >12 KB bootstrap block is trimmed to the cap with a
      visible trim sentinel; identity/role/recent-activity head is preserved.
    - LiveKit canary session for dragan1 (heavy) still produces audio.
    - A structured "voice.instruction.budget_trimmed" log line is emitted on trim.

REFERENCE IMPLEMENTATION (mirror of gateway bootstrap-cap.ts)
"""

BOOTSTRAP_CONTEXT_MAX_CHARS = 12_000


def trim_sentinel(omitted: int) -> str:
    return f"\n[context trimmed: {omitted} chars of older context omitted to fit budget]"


def cap_bootstrap_context(
    text: str | None,
    max_chars: int = BOOTSTRAP_CONTEXT_MAX_CHARS,
) -> tuple[str, int]:
    """Cap a bootstrap-context string to a character budget.

    Trims from the bottom (older/lower-priority content) and appends a sentinel.
    Returns (capped_text, trimmed_chars). trimmed_chars == 0 when nothing trimmed.
    """
    if not text or len(text) <= max_chars:
        return (text or "", 0)
    trimmed = len(text) - max_chars
    return (text[:max_chars] + trim_sentinel(trimmed), trimmed)


# INTEGRATION SKETCH (inside the agent's instruction builder):
#
#   capped, trimmed = cap_bootstrap_context(bootstrap_context)
#   if trimmed > 0:
#       logger.warning(
#           "voice.instruction.budget_trimmed",
#           extra={"vitana_id": vitana_id, "chars_trimmed": trimmed,
#                  "cap": BOOTSTRAP_CONTEXT_MAX_CHARS, "transport": "livekit"},
#       )
#   instruction += "\n\n" + capped
