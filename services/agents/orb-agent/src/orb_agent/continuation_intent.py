"""VTID-03076 (P0-C) — short-reply intent classifier for activeContinuation.

When the agent speaks a proactive wake-brief and the user replies with a
short answer ("ja" / "yes" / "okay" / "nein" / "no"), this module decides
whether to fire `accepted` or `dismissed` to /api/v1/voice/next-action/event.

Lives as its own module (not a closure inside session.py) so it can be
unit-tested without spinning up the full LiveKit AgentSession.

Hard rules baked into the classifier:
  - Long replies (>60 chars OR >6 words) are NOT short replies.
    They're treated as topic shifts; the caller clears
    active_continuation on that signal.
  - Match is exact OR leading/trailing token so "ja bitte" and
    "klar gerne" still hit.
  - Trailing punctuation is stripped before comparison.
  - German + English coverage. Other supported_languages (fr/es/etc.)
    can extend the sets if/when ORB validation runs in those locales.
"""
from __future__ import annotations


# German acceptance — short replies that mean "do it" / "tell me more".
ACCEPT_PATTERNS_DE: frozenset[str] = frozenset({
    "ja", "ja bitte", "ja gerne", "okay", "ok", "klar", "klar gerne",
    "mach das", "zeig es mir", "zeig mir", "erklär es", "erklaer es",
    "erklär mir", "erzähl mir", "erzaehl mir", "gerne", "bitte",
})

ACCEPT_PATTERNS_EN: frozenset[str] = frozenset({
    "yes", "yes please", "ok", "okay", "sure", "go ahead",
    "show me", "tell me", "tell me more", "explain", "please do",
    "do it",
})

DISMISS_PATTERNS_DE: frozenset[str] = frozenset({
    "nein", "nein danke", "nicht jetzt", "später", "spaeter",
    "lass mal", "nee", "ne", "danke nein",
})

DISMISS_PATTERNS_EN: frozenset[str] = frozenset({
    "no", "no thanks", "not now", "later", "skip", "no thank you",
    "nope",
})

_MAX_CHARS_FOR_SHORT_REPLY = 60
_MAX_WORDS_FOR_SHORT_REPLY = 6


def classify_short_reply(text: str | None) -> str | None:
    """Return 'accept' / 'dismiss' / None for a user reply.

    None means "not a short accept/dismiss" — caller should NOT fire any
    continuation event. Long topical replies fall here too; the caller
    can use the `is_topic_shift` helper below to decide whether to also
    clear active_continuation state.
    """
    if not isinstance(text, str):
        return None
    t = text.strip().lower()
    if not t:
        return None
    if len(t) > _MAX_CHARS_FOR_SHORT_REPLY:
        return None
    if len(t.split()) > _MAX_WORDS_FOR_SHORT_REPLY:
        return None
    # Strip trailing punctuation for matching.
    t_norm = t.rstrip(".!?,;:")
    accept = ACCEPT_PATTERNS_DE | ACCEPT_PATTERNS_EN
    dismiss = DISMISS_PATTERNS_DE | DISMISS_PATTERNS_EN
    if t_norm in accept:
        return "accept"
    if t_norm in dismiss:
        return "dismiss"
    # Prefix / suffix match for compound replies ("ja, zeig mal").
    for p in accept:
        if (
            t_norm.startswith(p + " ")
            or t_norm.startswith(p + ",")
            or t_norm.endswith(" " + p)
        ):
            return "accept"
    for p in dismiss:
        if (
            t_norm.startswith(p + " ")
            or t_norm.startswith(p + ",")
            or t_norm.endswith(" " + p)
        ):
            return "dismiss"
    return None


def is_topic_shift(text: str | None) -> bool:
    """True when the user reply is long enough to qualify as a topic
    change — caller uses this to clear active_continuation state so a
    later 'ja' on a different topic doesn't fire the old acceptance.
    """
    if not isinstance(text, str):
        return False
    t = text.strip()
    if not t:
        return False
    return (
        len(t) > _MAX_CHARS_FOR_SHORT_REPLY
        or len(t.split()) > _MAX_WORDS_FOR_SHORT_REPLY
    )
