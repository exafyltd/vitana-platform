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


def test_predicate_uses_both_conditions() -> None:
    """The watchdog tick MUST gate on speaking_for AND since_last_transcript.
    Either condition alone is wrong:
      - speaking_for only → fires during normal STT latency (the bug we're fixing)
      - since_last_transcript only → fires during ordinary silence between turns
    """
    src = _session_src()
    # Find the watchdog tick body
    watchdog_start = src.find("async def _silent_stall_watchdog")
    assert watchdog_start != -1
    body = src[watchdog_start : watchdog_start + 3500]
    # Both predicates must appear in the tick
    assert "speaking_for < SILENT_STALL_THRESHOLD_S" in body, (
        "VTID-03079 regression: lost the VAD speaking-time predicate"
    )
    assert "since_last_transcript < SILENT_STALL_MIN_TRANSCRIPT_AGE_S" in body, (
        "VTID-03079 regression: lost the transcript-age predicate; "
        "watchdog will re-introduce mid-sentence false positives"
    )


def test_predicate_returns_early_on_each_failure() -> None:
    """Both predicates are early-return checks: if EITHER condition is
    not met, the tick skips alert/recovery entirely. The 18:45:30 false
    positive happened with since_last_transcript=3.37s — that condition
    alone must be enough to skip even when speaking_for is high."""
    src = _session_src()
    watchdog_start = src.find("async def _silent_stall_watchdog")
    body = src[watchdog_start : watchdog_start + 3500]
    # Both should be followed by `continue` (loop skip).
    # Find the `< SILENT_STALL_MIN_TRANSCRIPT_AGE_S` check and check
    # the next line is a continue.
    import re
    match = re.search(
        r"if\s+since_last_transcript\s*<\s*SILENT_STALL_MIN_TRANSCRIPT_AGE_S\s*:\s*\n\s+continue",
        body,
    )
    assert match, (
        "VTID-03079 regression: the transcript-age check must `continue` on miss "
        "(skip this tick), not fall through to fire the alert"
    )
