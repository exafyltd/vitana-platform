"""VTID-03054: agent speaks wake_brief.user_facing_line as the first turn.

Previously session.py always called _localized_greeting() for the first
spoken line — the hardcoded "Hallo Dragan! Womit kann ich dir heute
helfen?" per language. With VTID-03052 + VTID-03053 the gateway now
computes a wake-brief decision per bootstrap and may emit a proactive
observation (e.g. "Your nutrition pillar has been slipping lately…").
This slice wires session.py to consume that decision.

Coverage:
  1. BootstrapResult parses wake_brief_decision from the response payload.
  2. Greeting selection prefers wake_brief.user_facing_line when non-empty.
  3. Empty / null / whitespace-only line falls back to _localized_greeting.
  4. Anonymous sessions are unaffected.
  5. Missing wake_brief_decision (pre-VTID-03052 gateway) falls back to the
     existing path with no exception.

Tests stub the dependency chain so no livekit-agents SDK is required.
"""
from __future__ import annotations

import pathlib
from dataclasses import fields as dc_fields


def test_bootstrap_result_carries_wake_brief_decision_field() -> None:
    """The BootstrapResult dataclass must expose wake_brief_decision so
    session.py can read it without an attribute error."""
    from src.orb_agent.bootstrap import BootstrapResult

    field_names = {f.name for f in dc_fields(BootstrapResult)}
    assert 'wake_brief_decision' in field_names

    # Defaults to None — old gateways without the field do NOT break.
    instance = BootstrapResult(
        bootstrap_context='',
        active_role=None,
        conversation_summary=None,
        last_turns=None,
        last_session_info=None,
        current_route=None,
        recent_routes=[],
        client_context={},
        vitana_id=None,
        voice_config=None,
    )
    assert instance.wake_brief_decision is None


def test_bootstrap_constructor_accepts_wake_brief_decision() -> None:
    """When the payload includes wake_brief_decision, the dataclass holds it."""
    from src.orb_agent.bootstrap import BootstrapResult

    decision = {
        'decision_id': 'd-1',
        'selected_kind': 'wake_brief',
        'user_facing_line': 'Your nutrition pillar has been slipping lately. Want help getting it back on track?',
        'suppression_reason': None,
    }
    instance = BootstrapResult(
        bootstrap_context='',
        active_role=None,
        conversation_summary=None,
        last_turns=None,
        last_session_info=None,
        current_route=None,
        recent_routes=[],
        client_context={},
        vitana_id=None,
        voice_config=None,
        wake_brief_decision=decision,
    )
    assert instance.wake_brief_decision == decision
    assert instance.wake_brief_decision['user_facing_line'].startswith(
        'Your nutrition pillar'
    )


def test_session_py_reads_wake_brief_user_facing_line() -> None:
    """Grep-style structural check on session.py — the new code path must
    branch on wake_brief_decision.user_facing_line before falling back to
    _localized_greeting()."""
    session_src = (
        pathlib.Path(__file__).resolve().parent.parent
        / 'src' / 'orb_agent' / 'session.py'
    ).read_text(encoding='utf-8')

    # The VTID marker AND the field read must both be present.
    assert 'VTID-03054' in session_src, 'session.py missing VTID-03054 marker'
    assert 'wake_brief_decision' in session_src, (
        'session.py missing wake_brief_decision access'
    )
    assert 'user_facing_line' in session_src, (
        'session.py missing user_facing_line access'
    )

    # The fallback path must still exist so degraded bootstraps don't
    # silence the orb.
    assert '_localized_greeting(' in session_src, (
        'session.py removed _localized_greeting() fallback — breakage risk'
    )

    # Anonymous path must remain on _localized_anonymous_greeting (no
    # wake-brief for anonymous sessions — the decision is gated on
    # userId + tenantId at the gateway).
    assert '_localized_anonymous_greeting(' in session_src


def test_session_py_falls_back_when_user_facing_line_is_empty() -> None:
    """The branch is `if isinstance(wake_line, str) and wake_line.strip()`:
    empty string + whitespace + non-str must fall through. Structural check
    that the guard is present and uses both isinstance + strip()."""
    session_src = (
        pathlib.Path(__file__).resolve().parent.parent
        / 'src' / 'orb_agent' / 'session.py'
    ).read_text(encoding='utf-8')
    # Require both isinstance + strip() so a typed None doesn't crash and
    # whitespace-only doesn't pass through as a "valid" greeting.
    assert 'isinstance(wake_line, str)' in session_src
    assert 'wake_line.strip()' in session_src


def test_bootstrap_parsing_handles_pre_vtid_03052_gateway() -> None:
    """When the gateway response is missing wake_brief_decision (older
    gateway revision), BootstrapResult constructs with None — no KeyError,
    no AttributeError downstream."""
    from src.orb_agent.bootstrap import BootstrapResult

    # The fetch() codepath uses `.get('wake_brief_decision')` which returns
    # None on a missing key. Simulate that here.
    raw_payload_no_wake_brief: dict = {
        'bootstrap_context': '',
        'active_role': 'community',
        'conversation_summary': None,
        'last_turns': None,
        'last_session_info': None,
        'current_route': None,
        'recent_routes': [],
        'client_context': {},
        'vitana_id': None,
        'voice_config': None,
        # NOTE: no wake_brief_decision key.
    }
    instance = BootstrapResult(
        bootstrap_context=raw_payload_no_wake_brief['bootstrap_context'],
        active_role=raw_payload_no_wake_brief['active_role'],
        conversation_summary=raw_payload_no_wake_brief['conversation_summary'],
        last_turns=raw_payload_no_wake_brief['last_turns'],
        last_session_info=raw_payload_no_wake_brief['last_session_info'],
        current_route=raw_payload_no_wake_brief['current_route'],
        recent_routes=raw_payload_no_wake_brief['recent_routes'],
        client_context=raw_payload_no_wake_brief['client_context'],
        vitana_id=raw_payload_no_wake_brief['vitana_id'],
        voice_config=raw_payload_no_wake_brief['voice_config'],
        wake_brief_decision=raw_payload_no_wake_brief.get('wake_brief_decision'),
    )
    assert instance.wake_brief_decision is None
