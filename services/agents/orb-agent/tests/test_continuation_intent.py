"""VTID-03076 (P0-C) — continuation_intent tests.

Pure-function tests for the short-reply classifier. No LiveKit, no
network, no AgentSession. Run with `pytest tests/test_continuation_intent.py`.

These tests are the regression guard for the live German bug:
  agent: "Es gibt ein frisches Match für dich. Soll ich es dir vorstellen?"
  user:  "ja"
  agent: <Vitanaland explanation>   ← wrong, should have fired accepted

Acceptance #3 from the user's spec: User says "ja" after match
continuation → continuation accepted (not Vitanaland explanation).
"""
from __future__ import annotations

import pytest

from src.orb_agent.continuation_intent import (
    classify_short_reply,
    is_topic_shift,
)


# ---------------------------------------------------------------------------
# Accept patterns
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "ja",
    "Ja",
    "JA",
    "ja.",
    "ja!",
    "ja bitte",
    "ja gerne",
    "okay",
    "ok",
    "klar",
    "klar gerne",
    "mach das",
    "zeig es mir",
    "zeig mir",
    "erklär es",
    "erklär mir",
    "erzähl mir",
    "gerne",
    "bitte",
])
def test_classify_accepts_german_short_reply(text: str) -> None:
    assert classify_short_reply(text) == "accept"


@pytest.mark.parametrize("text", [
    "yes",
    "Yes",
    "yes please",
    "ok",
    "okay",
    "sure",
    "go ahead",
    "show me",
    "tell me",
    "tell me more",
    "explain",
    "please do",
    "do it",
])
def test_classify_accepts_english_short_reply(text: str) -> None:
    assert classify_short_reply(text) == "accept"


# ---------------------------------------------------------------------------
# Dismiss patterns
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "nein",
    "Nein",
    "nein danke",
    "nicht jetzt",
    "später",
    "lass mal",
    "nee",
    "ne",
])
def test_classify_dismisses_german_short_reply(text: str) -> None:
    assert classify_short_reply(text) == "dismiss"


@pytest.mark.parametrize("text", [
    "no",
    "No",
    "no thanks",
    "not now",
    "later",
    "skip",
    "nope",
])
def test_classify_dismisses_english_short_reply(text: str) -> None:
    assert classify_short_reply(text) == "dismiss"


# ---------------------------------------------------------------------------
# Compound replies ("ja, zeig mal", "yes, go ahead")
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "ja, zeig mal",
    "ja zeig mal",
    "yes, go ahead",
    "okay, do it",
])
def test_classify_handles_compound_accept(text: str) -> None:
    assert classify_short_reply(text) == "accept"


@pytest.mark.parametrize("text", [
    "nein, danke",
    "no, thanks",
    "later, please",
])
def test_classify_handles_compound_dismiss(text: str) -> None:
    assert classify_short_reply(text) == "dismiss"


# ---------------------------------------------------------------------------
# Non-matches: empty, long, off-topic
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "",
    "   ",
    None,
])
def test_classify_returns_none_for_empty(text) -> None:
    assert classify_short_reply(text) is None


def test_classify_returns_none_for_long_reply() -> None:
    # >60 chars → topic shift, not a short reply.
    long_text = "I'd like to know what the weather is going to be tomorrow evening in Berlin around six"
    assert classify_short_reply(long_text) is None
    assert is_topic_shift(long_text) is True


def test_classify_returns_none_for_many_words() -> None:
    # >6 words → topic shift even if short character count.
    many_words = "yes but tell me later about something"
    assert classify_short_reply(many_words) is None
    assert is_topic_shift(many_words) is True


@pytest.mark.parametrize("text", [
    "hello",
    "ich verstehe nicht",  # "I don't understand" — NOT acceptance
    "was hast du gesagt",  # NOT acceptance — this is the "what did you say" repeat case
    "actually",
])
def test_classify_returns_none_for_unrelated_short_text(text: str) -> None:
    assert classify_short_reply(text) is None


# ---------------------------------------------------------------------------
# Topic-shift helper
# ---------------------------------------------------------------------------

def test_is_topic_shift_short_reply_is_not_a_shift() -> None:
    assert is_topic_shift("ja") is False
    assert is_topic_shift("yes") is False


def test_is_topic_shift_empty_is_not_a_shift() -> None:
    assert is_topic_shift("") is False
    assert is_topic_shift(None) is False


def test_is_topic_shift_long_reply_is_a_shift() -> None:
    # The exact George Michael bug scenario: user replies with a long
    # support/troubleshooting sentence; we must NOT carry an old
    # active_continuation past this.
    long_text = "I'm having trouble with my account login can you help me reset my password"
    assert is_topic_shift(long_text) is True
