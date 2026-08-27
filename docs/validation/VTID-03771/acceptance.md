# VTID-03771 — Acceptance

## Root cause

`sendGreetingPromptToLiveAPI()` (`services/gateway/src/routes/orb-live.ts`)
has two decision paths for what Vitana says on turn 1:

1. **The safe-fast branch** (`contextReadyResolved === false && !isAnonymous`)
   — a self-contained fast path (DEV-COMHU-0513 B2 / `FEATURE_ORB_SAFE_FAST_GREETING`)
   that builds its own `GreetingDecisionContext`, decides among
   `safe_fast_newday_overview` / `first_time_welcome` / `conv_resume` /
   `proactive` / `newday`, sends it, and **returns synchronously** — it never
   reaches path 2.
2. **The normal ladder** (everything after the safe-fast `if` block closes)
   — includes `tryGuidedTopicRung`, and already protects a pending guided
   topic via `_hasPendingGuidedTopicAtOpen` (VTID-03727), suppressing
   `isReconnect`/`wakeCadenceSkip` so the guided-topic candidate can win.

Path 1 had **no equivalent protection** — it is entirely unaware that a
guided topic might be pending. A same-session Nova `nova_validation` retry
(`resendGreetingIfStuckAtZeroTurns` → `sendGreetingPromptToLiveAPI`) that
lands with `contextReadyResolved` still `false` takes path 1 and hijacks
the turn with a `newday_overview`-style greeting instead of resuming the
guided topic — stamping the daily briefing as delivered in the process.
Because the real lesson never happens, no completion signal (model
`end_guided_topic_teaching` call or the 5-minute client backstop) ever
fires either, so the step never auto-marks Done.

## Live evidence (staging, 2026-08-27, real account `bc34a5ca...`, topic T005)

- `orb.livekit.next_action.candidate` — `winner:true`, `dedupe_key:"guided_topic:T005"` (correct: the tap won).
- `orb.live.diag stage=upstream_error code=nova_validation` at `turn_count:0` — Nova's content filter blocked the first attempt.
- `orb.live.diag stage=nova_premature_close_retry` → `stage=greeting_recovery` — the server-internal same-session retry fired.
- `orb.live.diag stage=newday_briefing_eval` then `stage=stamp_briefing_date_write` then `stage=greeting_sent` — the retry took the safe-fast branch and delivered a *daily briefing*, not T005.
- `audio_out` climbs to 394 chunks on a single turn (a substantial spoken block — consistent with a full new-day overview, not a short opener), `turn_count` becomes 1, and no further model turn ever fires despite continuous `vtid.live.audio.in.chunk` from the user for 2+ minutes.
- User report, verbatim, twice (once immediately after VTID-03770 — a different, already-shipped fix — proved insufficient): "after it correctly finished teaching about that step/session, Vitana just switched to New Day greeting... After it finished with the New Day Greeting, it just continued listening, the Orb never stops, no Well Done drawer after guided topic content."

## Acceptance Criteria

AC-1 — `_hasPendingGuidedTopicAtOpen` is computed once, before the safe-fast
branch's own `if`, and reused (not redeclared) by the normal ladder's
`decideOpening()` call further down.
TEST: `test/orb/live/characterization/safe-fast-greeting-respects-pending-guided-topic.characterization.test.ts` — "declared exactly once", "declared BEFORE the safe-fast branch's `if`".

AC-2 — The safe-fast branch's `if` condition is gated on
`!_hasPendingGuidedTopicAtOpen`, in addition to its pre-existing two
conditions (both unchanged).
TEST: `test/orb/live/characterization/safe-fast-greeting-respects-pending-guided-topic.characterization.test.ts` — "gated on !_hasPendingGuidedTopicAtOpen", "no regression to the original DEV-COMHU-0513 B2 fast path".

AC-3 — The flag's own definition is unchanged from VTID-03727 (pending
topic content present AND this session's own `turn_count === 0`) — only its
declaration site moved.
TEST: `test/orb/live/characterization/safe-fast-greeting-respects-pending-guided-topic.characterization.test.ts` — "requires BOTH a pending topic AND this session having spoken nothing yet".

AC-4 — The pre-existing VTID-03727 protection on the normal ladder
(`decideOpening()`'s `isReconnect`/`wakeCadenceSkip` inputs) is unaffected
by this relocation.
TEST: `test/orb/live/characterization/safe-fast-greeting-respects-pending-guided-topic.characterization.test.ts` — "no regression to the VTID-03727 fix"; also re-run `test/orb/live/characterization/guided-topic-cadence-skip-not-silenced.characterization.test.ts` in full, unmodified, still green.

AC-5 — Mutation-verified: reverting the `if` condition's new guard alone
(leaving everything else intact) fails exactly the one test asserting that
guard, and no others.
TEST: manual mutation run, see `commands.log` — 1 test failed (the exact
guard assertion), 5 others in the same suite still passed.

AC-6 — A session with no pending guided topic is completely unaffected —
still takes the safe-fast branch under the original two conditions.
TEST: `test/orb/live/characterization/safe-fast-greeting-respects-pending-guided-topic.characterization.test.ts` — "no regression to the original DEV-COMHU-0513 B2 fast path".

AC-7 — Full gateway suite passes with no new failures.
TEST: `commands.log` — 714/715 suites (1 pre-existing skip), 13,439/13,474 tests passing, 0 failures.

AC-8 — `tsc --noEmit` is clean after the change (duplicate-`const` removal
verified not to break compilation).
TEST: `commands.log` — `tsc --noEmit` exit 0.

## Deliberately NOT attempted in this VTID

- **The "close button doesn't respond" half of the live report.** No
  distinct code defect was found for this — `_hide()` (orb-widget.js) is
  bound unconditionally to the close button and synchronously tears down
  the session regardless of state. The live evidence (a session stuck
  indefinitely with `audio_out` never advancing past 394 while the user
  kept talking) is consistent with this fix's own root cause: once the
  safe-fast branch hijacks the turn with a new-day greeting instead of the
  guided topic, the model is left in an unexpected conversational state
  with no teaching context, and the session just idles. This fix removes
  the hijack; whether "orb never stops"/"close doesn't work" was purely a
  symptom of that (the user never actually testing a real close during a
  correctly-behaving session) or a separate, still-open defect can only be
  confirmed by re-testing after this ships to staging.
- **Whether `FEATURE_ORB_SAFE_FAST_GREETING`'s safe-fast branch should ever
  fire mid-conversation at all** (as opposed to only on a session's very
  first greeting attempt) — out of scope; this fix only stops it from
  overriding a guided topic specifically, which is the reported defect.
