"""VTID-WAKE-OPENER: suppressed wake_brief must not fall back to
_localized_greeting().

Background
----------
VTID-03054 wired session.py to speak `wake_brief.user_facing_line` when
the gateway returns a non-empty proactive opener. But the `else` branch
was a single bucket covering BOTH:
  (a) gateway returned no wake_brief_decision (degraded / pre-VTID-03052
      gateway)
  (b) gateway returned a decision but the decider deliberately produced
      no line (B1 cadence skip, greeted-recently, heavy-day dampening,
      etc.)

In case (b) the policy says "do not greet again". Falling back to
`_localized_greeting()` was exactly the bug the user reported on the
LiveKit Test Bench: three minutes after hearing "Hallo, wie kann ich
helfen?", they heard the identical line again. Wake-brief had decided
NOT to greet; session.py overrode that decision.

Fix structure (session.py)
--------------------------
1. `decision_present` is computed first (raw_wake_brief is dict).
2. Branch order:
     - wake_line non-empty             → speak it
     - decision_present, no wake_line  → greeting_text = None; SKIP say
     - else                            → _localized_greeting() fallback
3. session.say() is only called when greeting_text is not None.
4. Three [VTID-WAKE-OPENER] log lines (override / suppressed / legacy)
   so production can grep which branch fired.

These tests are structural — they lock the branch shape so a future
refactor cannot silently re-merge the (a) and (b) cases.
"""
from __future__ import annotations

import pathlib


def _session_src() -> str:
    return (
        pathlib.Path(__file__).resolve().parent.parent
        / 'src' / 'orb_agent' / 'session.py'
    ).read_text(encoding='utf-8')


def test_session_py_distinguishes_decision_present_from_decision_absent() -> None:
    """The two cases — `wake_brief_decision is a dict` vs `is None` — must
    be branched on separately. A single `else` clause covering both is
    the bug this PR fixes."""
    src = _session_src()
    assert 'decision_present' in src, (
        "session.py is missing the decision_present guard — the suppressed "
        "(case b) and absent (case a) paths must be distinguishable."
    )
    # The guard is defined as isinstance(raw_wake_brief, dict). Look for
    # the exact pattern so a future refactor that loses the dict check
    # (e.g. just `bool(raw_wake_brief)` — which is False for empty dicts)
    # fails this assertion.
    assert 'isinstance(raw_wake_brief, dict)' in src


def test_session_py_skips_say_when_decision_suppressed() -> None:
    """When wake_brief_decision exists but has no user_facing_line, the
    code must set greeting_text=None and skip session.say() — NOT fall
    back to _localized_greeting()."""
    src = _session_src()

    # The suppressed branch must be present as a distinct elif.
    assert 'elif decision_present:' in src, (
        'session.py must branch on `elif decision_present:` between '
        'the speak-line path and the localized-fallback path.'
    )

    # Capture ONLY the elif body — stop at the next `else:` (the
    # absent-decision branch) so the absent-branch fallback call doesn't
    # bleed into the assertion.
    suppressed_marker_idx = src.index('elif decision_present:')
    next_else_rel = src[suppressed_marker_idx:].index('\n        else:')
    window = src[suppressed_marker_idx:suppressed_marker_idx + next_else_rel]

    assert 'greeting_text = None' in window, (
        'suppressed branch must set greeting_text = None — sentinel for '
        'skipping session.say().'
    )
    # The suppressed branch must NOT call _localized_greeting.
    # (Comment mentions of the helper that include the literal `(` would
    # also fail this check — keep prose without parens in this branch.)
    assert '_localized_greeting(' not in window, (
        'suppressed branch must not call _localized_greeting() — that is '
        'the exact regression this PR closes.'
    )


def test_session_py_say_is_guarded_on_greeting_text_not_none() -> None:
    """session.say() must be wrapped in an `if greeting_text is None / else`
    so the suppressed branch's None sentinel actually short-circuits the
    speak path."""
    src = _session_src()
    assert 'if greeting_text is None:' in src, (
        'session.py must guard session.say() on greeting_text not being None.'
    )
    # session.say must still be in the file — we did not remove the speak
    # path, only guarded it.
    assert 'await session.say(greeting_text' in src


def test_session_py_falls_back_only_when_decision_absent() -> None:
    """When wake_brief_decision is MISSING (degraded bootstrap / pre-
    VTID-03052 gateway), _localized_greeting() is still the right
    fallback so the orb never silently fails to greet."""
    src = _session_src()
    # The _localized_greeting() call must live INSIDE the `else:` branch
    # that follows `elif decision_present:` — i.e. only fires when the
    # decision is absent, not when it's suppressed.
    suppressed_idx = src.index('elif decision_present:')
    # The next `else:` after `elif decision_present:` is the absent-decision branch.
    absent_branch_start = src.index('\n        else:', suppressed_idx)
    absent_window = src[absent_branch_start:absent_branch_start + 800]
    assert '_localized_greeting(' in absent_window, (
        'absent-decision branch must still call _localized_greeting() so '
        'a degraded bootstrap path does not silence the orb.'
    )


def test_session_py_emits_vtid_wake_opener_logs() -> None:
    """Three [VTID-WAKE-OPENER] log lines must fire so production logs can
    prove which branch handled the wake — override / suppressed / legacy."""
    src = _session_src()
    assert 'path=livekit override_active=true' in src, (
        '[VTID-WAKE-OPENER] override branch log line missing.'
    )
    assert 'path=livekit override_active=false suppressed=true' in src, (
        '[VTID-WAKE-OPENER] suppressed branch log line missing.'
    )
    assert 'path=livekit override_active=false suppressed=false' in src, (
        '[VTID-WAKE-OPENER] legacy / absent-decision branch log line missing.'
    )
    # The suppressed log must include suppression_reason so we can later
    # tell B1-cadence from heavy-day from greeted-recently in production.
    sup_idx = src.index('path=livekit override_active=false suppressed=true')
    sup_window = src[sup_idx:sup_idx + 600]
    assert 'suppression_reason' in sup_window, (
        'suppressed log must include suppression_reason field.'
    )
    # Three branches each log selected_kind / user_facing_line OR said=.
    assert 'said=<skipped>' in src, (
        'suppressed branch log must mark said=<skipped> for grep parity.'
    )


def test_session_py_anonymous_path_unaffected() -> None:
    """The is_anonymous branch is still wired to _localized_anonymous_greeting.
    Wake-brief decisions never apply to anonymous sessions (no user_id at the
    gateway), so the anonymous path should be untouched by this PR."""
    src = _session_src()
    assert '_localized_anonymous_greeting(' in src
    # Anonymous branch must NOT consult wake_brief_decision.
    anon_idx = src.index('_localized_anonymous_greeting(')
    # The 200 chars BEFORE the anonymous call must not reference wake_brief.
    pre_anon = src[max(0, anon_idx - 200):anon_idx]
    assert 'wake_brief' not in pre_anon, (
        'anonymous branch must not consult wake_brief_decision.'
    )
