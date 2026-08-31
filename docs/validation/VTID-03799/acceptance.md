# VTID-03799 — Acceptance Criteria

Root cause and full reasoning: `root-cause.md` in this directory.

AC-1 — One predicate decides whether a guided topic may be resumed, and it
refuses once teaching has ended.

TEST: `guided-topic-replay-loop.test.ts` — "declares _shouldResumeGuidedTopic()", "refuses to resume once teaching has ended", "still requires an in-flight topic that is not already armed".

AC-2 — All three re-arm sites (`_attemptReconnect`, `_resetAndReconnect`, the
`_sessionStart` send site) go through that predicate, and none still carries
the teaching-blind literal condition.

TEST: `guided-topic-replay-loop.test.ts` — "all three re-arm sites are guarded by it", "no re-arm site still uses the old teaching-blind condition".

AC-3 — The delivered-audio flag is set on its own condition at turn-complete,
not nested inside the one-shot `guidedAutoClose` block.

TEST: `guided-topic-replay-loop.test.ts` — "is set on its own condition, not inside the guidedAutoClose branch", "the auto-close branch no longer sets it".

AC-4 — Closing an overlay whose lesson was delivered but never credited fires
`onGuidedTopicTeachingEnd`, after teardown, guarded against a throwing host
handler, and marks teaching ended so it cannot double-fire with the tool call.

TEST: `guided-topic-replay-loop.test.ts` — "_hide captures a pending completion before clearing the flags", "marks teaching ended so the tool call and this path cannot double-fire", "fires onGuidedTopicTeachingEnd after teardown".

AC-5 — A lesson whose audio never played is NOT credited (no regression to
VTID-03784's false completion).

TEST: `guided-topic-replay-loop.test.ts` — "does NOT credit a lesson whose audio never played".

AC-6 — Pre-existing guided-topic invariants still hold: the resume ordering in
each caller, `_hide()` clearing every guided flag, a fresh tap resetting
teaching-ended, and the VTID-03784 backstop gate.

TEST: `orb-widget-guided-topic-mid-lesson-resume.test.ts` and `orb-widget-guided-topic-backstop-stuck-state.test.ts` — all assertions, including the seven re-recorded ones.

AC-7 — Mutation-verified: each defect, reintroduced individually, fails tests.

TEST: `outputs/jest-mutation-A-teaching-blind-rearm.txt` (3 failed), `outputs/jest-mutation-B-delivered-flag-renested.txt` (3 failed), `outputs/jest-mutation-C-no-completion-crediting.txt` (1 failed).

AC-8 — `tsc --noEmit` clean and the full gateway suite green.

TEST: `outputs/jest-full-suite.txt` — 731/732 suites (1 pre-existing skip), 13,621 passing, 44/44 snapshots, 0 failures.

## Honest caveat

This is verified by unit tests and mutation testing, not yet against live
traffic. The live confirmation is a real My Journey tap on staging: the lesson
plays **once**, the close button works on the first press, and the Well Done
drawer opens. That has not happened yet and will be reported as measured,
either way — the same treatment VTID-03797's first attempt got when it was
disproven.
