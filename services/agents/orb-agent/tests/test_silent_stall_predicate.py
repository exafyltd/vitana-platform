"""VTID-03079: silent_stall predicate must check BOTH conditions.

The 2026-05-18 18:43-18:46 UTC session showed the original VTID-03075
single-condition watchdog firing during normal speech:

  stall #1: speaking_for=3.48s  since_last_transcript=80.14s  ← real
  stall #2: speaking_for=3.23s  since_last_transcript=3.37s   ← FALSE POSITIVE
  stall #3: speaking_for=3.68s  since_last_transcript=33.14s  ← maybe real

The chime/banner fired mid-sentence because Google STT was just slow to
finalize a normal 6-second utterance. This regression test pins the
new combined predicate so a future PR can't accidentally drop the
second condition and reintroduce mid-sentence false-positive chimes.
"""
from __future__ import annotations

import pathlib


def _session_src() -> str:
    return (
        pathlib.Path(__file__).resolve().parent.parent
        / "src" / "orb_agent" / "session.py"
    ).read_text(encoding="utf-8")


def test_min_transcript_age_constant_exists_with_15s() -> None:
    """15s is the floor for declaring a stall. Anything lower
    (especially the original 3s) re-introduces false positives during
    normal STT finalization latency."""
    src = _session_src()
    assert "SILENT_STALL_MIN_TRANSCRIPT_AGE_S = 15.0" in src, (
        "VTID-03079 regression: SILENT_STALL_MIN_TRANSCRIPT_AGE_S must be 15.0"
    )


def test_fallback_predicate_uses_both_conditions() -> None:
    """The fallback (timer-based) detector MUST gate on speaking_for AND
    since_last_transcript. Either condition alone is wrong:
      - speaking_for only → fires during normal STT latency (the bug VTID-03079 fixed)
      - since_last_transcript only → fires during ordinary silence between turns
    VTID-03080 keeps this as backstop; both conditions still required.
    """
    src = _session_src()
    # Find the _check_for_stall body (where the dual predicate now lives)
    fn_start = src.find("def _check_for_stall")
    assert fn_start != -1, "VTID-03080 regression: _check_for_stall missing"
    body = src[fn_start : fn_start + 3500]
    # Both predicates must appear in the fallback detector branch
    assert "speaking_for >= SILENT_STALL_THRESHOLD_S" in body, (
        "VTID-03079/03080 regression: lost the VAD speaking-time predicate"
    )
    assert "since_last_transcript >= SILENT_STALL_MIN_TRANSCRIPT_AGE_S" in body, (
        "VTID-03079/03080 regression: lost the transcript-age predicate; "
        "fallback would re-introduce mid-sentence false positives"
    )


def test_primary_detector_is_vad_speech_end() -> None:
    """VTID-03080: the primary stall detector watches for VAD-speech-end
    without follow-up transcript. This is the fast signal (~2s detection
    vs the timer-based fallback at ~15s). Pin its presence."""
    src = _session_src()
    fn_start = src.find("def _check_for_stall")
    body = src[fn_start : fn_start + 3500]
    # The primary detector consumes `expecting_transcript_since` and the
    # VAD_SPEECH_END_TRANSCRIPT_TIMEOUT_S threshold. Both must be referenced.
    assert "expecting_transcript_since" in body, (
        "VTID-03080 regression: primary detector lost reference to "
        "`expecting_transcript_since` (the VAD speech-end timestamp)"
    )
    assert "VAD_SPEECH_END_TRANSCRIPT_TIMEOUT_S" in body, (
        "VTID-03080 regression: primary detector lost the 2s timeout"
    )
    # The fast-path branch must be checked BEFORE the slow fallback so
    # detection latency stays at ~2s on the common case.
    primary_idx = body.find("expecting_transcript_since")
    fallback_idx = body.find("speaking_for >= SILENT_STALL_THRESHOLD_S")
    assert primary_idx != -1 and fallback_idx != -1
    assert primary_idx < fallback_idx, (
        "VTID-03080 regression: VAD-speech-end primary detector must be "
        "checked BEFORE the wall-clock fallback so detection stays ~2s"
    )


def test_vad_speech_end_timeout_constant_pinned_at_2s() -> None:
    """VTID-03080 sets the VAD-speech-end-to-transcript window at 2s.
    Google STT's typical finalize latency after speech_end is <1s, so
    2s is a generous-but-tight ceiling. Anything longer means user waits
    longer; anything shorter risks racing fast STT finalizations."""
    src = _session_src()
    assert "VAD_SPEECH_END_TRANSCRIPT_TIMEOUT_S = 2.0" in src, (
        "VTID-03080 regression: VAD-speech-end timeout must be 2.0s"
    )
