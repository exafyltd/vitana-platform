"""VTID-03074: turn-handling config locked in session_kwargs.

Structural test — asserts the literal config values are present in
session.py's AgentSession construction. We need this locked because:

- SDK default `user_turn_limit.max_duration=None` is "disabled" — production
  was running with no hard turn cap and Google STT held a turn open for
  170 seconds on 2026-05-18, killing the conversation.
- `max_duration=20.0` is the wall-clock force-finalize threshold. If
  someone bumps this back to None or removes turn_handling entirely,
  the regression returns.

Why structural and not hermetic-mock: AgentSession is constructed deep
inside the 1500-line agent_entrypoint with ~30 dependencies (oasis,
gateway client, identity resolver, VAD, etc.). Mocking all of those to
just observe the kwargs would be more fragile than reading the source
literally. The values that matter are constants; pin them.
"""
from __future__ import annotations

import pathlib


def _session_src() -> str:
    return (
        pathlib.Path(__file__).resolve().parent.parent
        / "src" / "orb_agent" / "session.py"
    ).read_text(encoding="utf-8")


def test_session_kwargs_includes_turn_handling_block() -> None:
    """The literal `"turn_handling": {` dict-key MUST appear inside the
    session_kwargs construction. Without it the SDK defaults take over
    (which leave user_turn_limit.max_duration=None — the bug)."""
    src = _session_src()
    assert "\"turn_handling\":" in src or "'turn_handling':" in src, (
        "session_kwargs lost its turn_handling block — SDK defaults "
        "would re-enable the 170-second user-turn buffering bug"
    )


def test_max_duration_explicitly_set_to_20s() -> None:
    """The 20-second hard cap is the actual fix. Anything else (None,
    0, a much higher number) re-introduces the conversation-death mode."""
    src = _session_src()
    assert "\"max_duration\": 20.0" in src or "'max_duration': 20.0" in src, (
        "max_duration override missing or changed — must be 20.0s "
        "to prevent the 170-second-turn regression from VTID-03050 telemetry"
    )


def test_endpointing_block_present_with_documented_defaults() -> None:
    """We pass min_delay=0.5 and max_delay=3.0 explicitly so the values
    are visible in code review. They match the SDK documented defaults
    (livekit-agents voice/turn.py:69-74). If the SDK ever changes its
    defaults, our agent stays on the values it was tested against."""
    src = _session_src()
    assert "\"min_delay\": 0.5" in src or "'min_delay': 0.5" in src
    assert "\"max_delay\": 3.0" in src or "'max_delay': 3.0" in src
    assert "\"mode\": \"fixed\"" in src or "'mode': 'fixed'" in src


def test_turn_handling_lives_in_agentsession_kwargs_not_update_options() -> None:
    """Sanity: the config has to land at AgentSession construction time.
    If someone moves it to a post-start update_options() call we lose the
    config for the first turn (the one most likely to wedge). Keep it
    inline with session_kwargs."""
    src = _session_src()
    # Find the AgentSession(**session_kwargs) line and assert the
    # turn_handling block appears BEFORE it in the file.
    idx_construction = src.find("AgentSession(**session_kwargs)")
    idx_turn_handling = src.find("\"turn_handling\":")
    assert idx_construction != -1, "AgentSession(**session_kwargs) line missing"
    assert idx_turn_handling != -1, "turn_handling key not found in session.py"
    assert idx_turn_handling < idx_construction, (
        "turn_handling block must be defined BEFORE the AgentSession() call "
        "so it lands at construction time, not via update_options() later"
    )
