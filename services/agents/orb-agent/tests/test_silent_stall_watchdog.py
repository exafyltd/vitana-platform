"""VTID-03075: silent-stall watchdog structural + constant tests.

The runtime behavior of the watchdog (asyncio.Task polling
stall_state every 1s, firing oasis emit + publish_data on a
3-second threshold) is hard to unit-test hermetically without
booting a real LiveKit room. These tests pin the OBSERVABLE
contract instead:

  1. The new oasis topic exists with the exact gateway-allowlisted
     string `livekit.stt.silent_stall`.
  2. session.py imports the topic + registers the user_state_changed
     handler + creates the watchdog asyncio.Task + tears it down.
  3. The 3-second threshold constant is set to 3.0s (the user said
     5-10s is their tolerance; 3s leaves recovery budget under that).

Behavior smoke tests live in real LiveKit sessions; pull from
`oasis_events` after a real conversation.
"""
from __future__ import annotations

import pathlib


def _session_src() -> str:
    return (
        pathlib.Path(__file__).resolve().parent.parent
        / "src" / "orb_agent" / "session.py"
    ).read_text(encoding="utf-8")


def test_silent_stall_topic_exact_string() -> None:
    """The gateway oasis-emit allowlist accepts `livekit.` prefix.
    The CicdEventType union expects this exact string. Pin it."""
    from src.orb_agent.oasis import TOPIC_STT_SILENT_STALL
    assert TOPIC_STT_SILENT_STALL == "livekit.stt.silent_stall"


def test_session_imports_silent_stall_topic() -> None:
    """session.py must import TOPIC_STT_SILENT_STALL from oasis or the
    watchdog can't emit. Structural — small fast guard against a stray
    refactor stripping the import."""
    src = _session_src()
    assert "TOPIC_STT_SILENT_STALL" in src, (
        "session.py is no longer importing TOPIC_STT_SILENT_STALL — the "
        "silent-stall watchdog can't emit telemetry without it"
    )


def test_threshold_set_to_3_seconds() -> None:
    """3s detection window. The user said: 'all of that happens within
    the time frame of maybe 5 seconds, maximum 10'. Detection at 3s
    leaves 7s of remaining budget for the agent to recover before the
    user gives up and disconnects."""
    src = _session_src()
    assert "SILENT_STALL_THRESHOLD_S = 3.0" in src, (
        "silent-stall detection threshold drifted from 3.0s — that breaks "
        "the user-tolerance budget (5-10s before they disconnect)"
    )


def test_record_user_state_replaces_lambda() -> None:
    """The old `user_state_changed`-feeds-stall lambda was replaced by
    `_record_user_state` so we ALSO record the VAD-speaking-start
    timestamp. If someone reverts to the lambda the watchdog can never
    fire (no speaking_since recorded)."""
    src = _session_src()
    assert "_record_user_state" in src
    # The lambda form must NOT exist anymore.
    assert "lambda _ev=None: stall.feed())" not in src, (
        "lambda form of user_state_changed re-introduced — the watchdog "
        "loses its 'user is currently speaking' input"
    )


def test_publish_client_alert_publishes_orb_alert_topic() -> None:
    """Publish path uses `topic='orb_alert'` so the Test Bench frontend
    can disambiguate it from orb_directive / transcript messages."""
    src = _session_src()
    assert "topic=\"orb_alert\"" in src or "topic='orb_alert'" in src


def test_watchdog_task_torn_down_on_shutdown() -> None:
    """The asyncio.Task must be cancelled in the shutdown callback so a
    long-running agent process doesn't leak tasks across sessions."""
    src = _session_src()
    assert "_silent_stall_task" in src
    assert "_silent_stall_task.cancel()" in src
