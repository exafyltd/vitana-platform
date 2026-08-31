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

TEST: `outputs/jest-full-suite-host-callbacks.txt` — 732/733 suites (1 pre-existing skip), 13,626 passing, 44/44 snapshots, 0 failures.

AC-9 — Every host callback the widget reads from `_cfg` is wired from `opts`
in `init()`. Found by the live probe: `onGuidedTopicTeachingEnd` was read at
two fire sites and never assigned, so the crediting path — AC-4's — was
unreachable in the real app regardless of the rest of this VTID.

TEST: `orb-widget-host-callbacks.test.ts` — all five tests; "every callback the widget reads is assignable from opts" is the class-level diff guard.

AC-10 — Mutation-verified: removing the wiring fails the guard.

TEST: `outputs/jest-mutation-D-host-callback-unwired.txt` — 3 of 5 failed. The two that still pass are the point: "still reads … at both fire sites" cannot detect the defect, which is exactly the blind spot in static-source testing that let this ship.

## Live probe result — staging b4a48529

Recorded in `outputs/live-probe-host-callback-drop.txt`.

The replay fix **is** deployed (verified by grepping the deployed bundle, not
this repo). The probe then found a second, independent defect underneath it:
`init()` dropped `onGuidedTopicTeachingEnd`, which `vitana-v1` genuinely
passes, so the Well Done drawer could never open even with the replay loop
fixed. Fixing the loop alone would have produced a partially-working feature
and a report of success that the user's next tap would have contradicted.

## Honest caveat

The replay loop, the close behaviour, and the crediting call are verified by
unit tests, mutation testing, and a deployed-artifact check. What is **still
not** verified is the end-to-end user experience — a real My Journey tap
where the lesson plays once, the close works first press, and the drawer
actually appears. Driving that to completion writes journey progress for the
account, which the standing rule forbids, so it needs either a human on a real
device or an isolated environment. Reported as a blocker, not routed around.
