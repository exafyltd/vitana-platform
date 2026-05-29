"""VTID-03075: VTID-03074's turn_handling/max_duration block was a no-op.

Per livekit-agents source (voice/audio_recognition.py
_check_user_turn_limit), the SDK only checks max_duration AFTER a final
transcript arrives. That cannot help when STT silently buffers audio
without producing transcripts — exactly the 170-second bug VTID-03074
claimed to fix.

The actual detection now lives in the silent-stall watchdog (see
test_silent_stall_watchdog.py). These structural assertions just lock
in the REMOVAL of the dead config so it doesn't sneak back in.
"""
from __future__ import annotations

import pathlib


def _session_src() -> str:
    return (
        pathlib.Path(__file__).resolve().parent.parent
        / "src" / "orb_agent" / "session.py"
    ).read_text(encoding="utf-8")


def test_turn_handling_block_removed_from_session_kwargs() -> None:
    """`turn_handling` MUST NOT appear inside session_kwargs. The block
    we shipped in VTID-03074 was a no-op. If it comes back, reviewers
    should reject the PR."""
    src = _session_src()
    assert "\"turn_handling\":" not in src, (
        "turn_handling block re-introduced — VTID-03074 was a no-op for "
        "silent-buffer bugs (SDK checks max_duration only after a final "
        "transcript event, which never arrives during the bug). Detection "
        "lives in the silent-stall watchdog instead."
    )


def test_max_duration_dict_literal_not_present_in_session_kwargs() -> None:
    """No `"max_duration": 20.0` (the VTID-03074 dead value). It would
    only resurface inside a fresh turn_handling block — the test above
    catches that case too, but pin the literal explicitly so the failure
    message points at the right thing."""
    src = _session_src()
    assert "\"max_duration\": 20.0" not in src
    assert "'max_duration': 20.0" not in src
