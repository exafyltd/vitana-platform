"""ORB-CONVERSATION-LATENCY: the agent greets on room-join, not on a user turn.

The LiveKit orb-agent is the SOLE driver of the first spoken line — the
frontend (vitana-v1) no longer POSTs a greet trigger after getUserMedia (that
round-trip was removed for conversation-start latency). So `agent_entrypoint`
must speak the opener itself, unconditionally, once bootstrap resolves — with no
preceding user utterance. This mirrors the Vertex contract locked by
vertex-autogreet-on-connect.characterization.test.ts on the gateway side.

Structural (source-level) by design: exercising the real path needs the
livekit-agents SDK + a live room, which unit CI can't stand up. Matches the
grep-style approach already used by test_wake_brief_greeting_consumption.py.
"""
from __future__ import annotations

import pathlib


def _session_src() -> str:
    return (
        pathlib.Path(__file__).resolve().parent.parent
        / 'src' / 'orb_agent' / 'session.py'
    ).read_text(encoding='utf-8')


def test_entrypoint_speaks_initial_greeting_via_session_say() -> None:
    """The opener is spoken with session.say(greeting_text, ...) inside
    agent_entrypoint — a direct deterministic TTS line, not a model turn that
    waits for the user to speak first."""
    src = _session_src()

    assert 'async def agent_entrypoint(' in src, 'agent_entrypoint missing'
    # The deterministic opener call must exist.
    assert 'session.say(greeting_text' in src, (
        'session.py no longer speaks greeting_text via session.say — the orb '
        'would go silent on tap (the client no longer sends a greet trigger)'
    )
    # Both the authenticated and anonymous opener templates feed greeting_text.
    assert '_localized_greeting(' in src
    assert '_localized_anonymous_greeting(' in src


def test_greeting_say_precedes_the_disconnect_wait_loop() -> None:
    """The greeting session.say must run BEFORE the agent parks on the
    disconnect/handoff wait loop. If it were after, the user would hear nothing
    until they spoke (or forever). Index ordering proves the say happens on
    join, ahead of the long-lived wait."""
    src = _session_src()
    idx_say = src.index('session.say(greeting_text')
    idx_wait_loop = src.index('disconnected_evt.wait()')
    assert idx_say < idx_wait_loop, (
        'initial greeting session.say happens after the disconnect wait loop — '
        'greeting is no longer fired eagerly on join'
    )


def test_greeting_is_not_gated_on_a_prior_user_turn() -> None:
    """The opener block must not be guarded by a user-spoke condition. The only
    gate is identity.is_anonymous (which template to speak), never a check for a
    received user transcript/utterance before greeting."""
    src = _session_src()
    # Locate the opener block and assert the wake-brief / localized selection
    # branches purely on identity + bootstrap, with no 'wait for user' guard.
    idx_greet_block = src.index('if not identity.is_anonymous:')
    idx_say = src.index('session.say(greeting_text')
    block = src[idx_greet_block:idx_say]
    # These would indicate the greeting waits for the user to speak first.
    for forbidden in ('user_has_spoken', 'first_user_turn', 'await user', 'wait_for_user'):
        assert forbidden not in block, (
            f'greeting block references {forbidden!r} — greeting must fire on '
            f'join, not after a user turn'
        )
