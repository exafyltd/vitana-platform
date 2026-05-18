"""VTID-03086: Silero VAD parameter regression tests.

The defaults were the root cause for the 2026-05-18 20:56-21:03 UTC
silent-stall thrash. STT recognition cycles consumed 79-86 SECONDS of
audio per cycle because Silero's `min_silence_duration=0.55s` default
didn't catch natural comma-pauses, so the agent's STT stream stayed
open for over a minute on a single "speech" state.

These tests pin the three tuned values so a future PR can't silently
revert to defaults and bring the marathon-batch failure mode back.
"""
from __future__ import annotations

import pathlib


def _session_src() -> str:
    return (
        pathlib.Path(__file__).resolve().parent.parent
        / "src" / "orb_agent" / "session.py"
    ).read_text(encoding="utf-8")


def test_min_silence_duration_pinned() -> None:
    """0.25s is the bar to catch natural German comma-pauses. The
    upstream default (0.55s) was too long — speakers blew past it
    without VAD ever declaring speech_end."""
    src = _session_src()
    assert "_VAD_MIN_SILENCE_DURATION_S = 0.25" in src, (
        "VTID-03086 regression: VAD min_silence_duration must be 0.25s"
    )


def test_activation_threshold_pinned() -> None:
    """0.6 is slightly above the Silero default (0.5) — less sensitive
    to breathing / ambient noise being misclassified as ongoing speech.
    Critical for the "no pause is ever long enough for VAD" failure mode."""
    src = _session_src()
    assert "_VAD_ACTIVATION_THRESHOLD = 0.6" in src, (
        "VTID-03086 regression: VAD activation_threshold must be 0.6"
    )


def test_max_buffered_speech_pinned() -> None:
    """8.0 is the hard ceiling. The upstream default (60.0) lets a single
    "speech" state run for a full minute; production telemetry showed
    cycles reaching 79-86s. This cap is the structural guarantee that
    STT can never again receive a marathon batch — Silero force-declares
    end-of-speech at 8s of continuous detection regardless of silence
    threshold."""
    src = _session_src()
    assert "_VAD_MAX_BUFFERED_SPEECH_S = 8.0" in src, (
        "VTID-03086 regression: VAD max_buffered_speech must be 8.0s "
        "(hard ceiling against marathon-batch STT cycles)"
    )


def test_get_vad_passes_all_three_to_load() -> None:
    """The constants only matter if `_get_vad()` actually forwards them
    to `silero.VAD.load()`. Pin the call shape so a future PR can't
    quietly drop a kwarg and revert to the upstream default."""
    src = _session_src()
    # Find _get_vad body
    fn_start = src.find("def _get_vad")
    assert fn_start != -1
    body = src[fn_start : fn_start + 2000]
    assert "silero.VAD.load(" in body, "VTID-03086 regression: _get_vad lost silero.VAD.load() call"
    assert "min_silence_duration=_VAD_MIN_SILENCE_DURATION_S" in body, (
        "VTID-03086 regression: _get_vad must pass min_silence_duration to silero.VAD.load"
    )
    assert "activation_threshold=_VAD_ACTIVATION_THRESHOLD" in body, (
        "VTID-03086 regression: _get_vad must pass activation_threshold to silero.VAD.load"
    )
    assert "max_buffered_speech=_VAD_MAX_BUFFERED_SPEECH_S" in body, (
        "VTID-03086 regression: _get_vad must pass max_buffered_speech to silero.VAD.load"
    )
