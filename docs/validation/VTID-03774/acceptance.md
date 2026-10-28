# VTID-03774 — Acceptance

## Fix 3 — Codex review follow-up: a resume must not restart the lesson (added same PR, post-review)

Codex's automated review of this PR (P1 finding, `pull_request_review_comment` on
`live-session-controller.ts:1820`) caught a real regression risk in Fixes 1+2
combined: once the client reliably resends `guided_topic_id` on ANY
qualifying reconnect (Fix 1), and the server no longer withholds the
override block for a winning guided-topic candidate on a reconnect (Fix 2),
a reconnect AFTER real teaching audio had already played would
re-synthesize and replay the FULL Polly narration from the beginning
(`sendGuidedTopicNarrationAudioBridge`'s one-shot guard,
`guidedTopicAudioDelivered`, lives on the SESSION OBJECT — brand new every
reconnect, so it could never actually prevent a replay) and re-inject the
verbatim "say this opener" instruction — restarting/duplicating
already-heard content instead of resuming it. Verified the finding is real
by tracing `guidedTopicNarrationContent` bundling
(`live-session-controller.ts:~1885`) and confirming it is driven purely by
the candidate WINNING, independent of the override-block gate Fix 2
touches — so the replay risk applies to Fix 1 broadly, not narrowly to Fix
2's own gate.

**Fix:** a new client-side signal distinguishes "resend because turn-1 was
already delivered" (a genuine resume) from "resend because a zero-turn
retry never got to speak at all" (VTID-03771's `nova_validation` case,
where the full open must still fire):

- `orb-widget.js`: new `_s._guidedTopicAudioDelivered` flag — armed `false`
  on a fresh tap (`focusGuidedTopic`), flipped `true` at the exact
  turn-complete point that already nulls `_s.guidedTopic` (turn-1 audio
  confirmed delivered), cleared by `_hide()`. `_sessionStart()` sends
  `startPayload.guided_topic_resume = true` only when both `guidedTopic`
  AND this flag are set.
- `live-session-controller.ts` / `orb-live.ts` (`GeminiLiveSession` type):
  reads `body.guided_topic_resume` onto `session.guided_topic_resume`,
  forwards it into `decideWakeBriefForSession` as `guidedTopicResume`.
- `wake-brief-wiring.ts`: forwards `guidedTopicResume` into the
  guided-topic-narration provider's extra as `isResume`.
- `guided-topic-narration.ts`: when `isResume` is true, skips the Polly
  synthesis call entirely (`content.narrationAudio` stays `null` — the
  audio bridge already treats null as "nothing to send", a pre-existing
  safe no-op) and returns an EMPTY `userFacingLine` instead of the opener/
  post-narration line. An empty `userFacingLine` is a valid candidate shape
  (`validateContinuationCandidate` only requires it be a string) and both
  the WS and SSE callers already gate their "inject the verbatim opener"
  step on `line.length > 0`, so this alone suppresses re-opening — no
  further change needed at either call site. The candidate still WINS
  (still priority 96) and `guidedTopicNarrationContent` is still bundled,
  so the GUIDE-MODE teach block still reminds the model what topic it's
  mid-teaching; only the forced restart is suppressed, not the context.

## Live evidence (staging, 2026-08-27, real account `bc34a5ca...`, topic T003)

User report (verbatim): "when I select a session, it now starts immediately
with a new day greeting, no guided topic content at all."

Traced via `oasis_events` + `orb_wake_timelines` (the actual wake-brief
decision timeline table — `oasis_events`' `orb.livekit.next_action.*` topic
only reports the Contextual Next Action provider's own 8 ambient sub-sources,
NOT the overall winning candidate; `orb_wake_timelines` is authoritative):

- Session 1 (`live-d1894cf2...`): the guided-topic candidate correctly won
  (`dedupe_key:"guided_topic:T003"`, priority 96, `winner:true`). Real
  narration audio played (412 audio_out_chunks over ~29s — the Polly-
  synthesized T003 lesson). `turn_count` reached 1 (the short opener).
- ~29s in, an SSE-level disconnect occurred (`_announceDisconnect('connection')`
  fired client-side; `orb.session.continuity.persisted reason=connection`).
- A reconnect produced Session 2 (`live-2313a2e1...`), which superseded
  Session 1. Session 2's OWN wake-timeline row
  (`orb_wake_timelines.session_id='live-2313a2e1...'`) shows:
  - `session_start_received: {isReconnect:true, reconnectStage:"idle"}`
  - `continuation_decision_finished.providerResults` includes
    `{"key":"guided_topic_narration","reason":"no_topic_tapped","status":"skipped"}`
    — proof positive `guided_topic_id` never reached the server on this
    reconnect's start payload, despite the widget's own
    `_attemptReconnect()`/`_resetAndReconnect()` restore-guards (VTID-03746/
    VTID-03770) appearing correct on static reading. The exact code path
    that dropped it could not be conclusively identified from static
    analysis + oasis_events alone (this session has no live-browser console
    access) — see "Deliberately NOT attempted" below.
  - `unread_messages_announce` won instead (`status:"returned"`) — a
    generic provider, not guided-topic content. This is what the user
    perceived as "new day greeting... no guided topic content at all."
  - Separately visible in the SAME timeline row: `feature_discovery_teacher`,
    `journey_guide`, `login_briefing` all self-suppress on
    `forced_skip_isReconnect_forces_skip`/`forced_skip_reconnect` — but
    `guided_topic_narration` does NOT read `isReconnect` at all (removed
    VTID-03677) and would have WON at priority 96 had `topicId` reached it.

## Two independent, defensible fixes

### Fix 1 — orb-widget.js: restore guidedTopic at the send site, not only in each caller

`_attemptReconnect()` and `_resetAndReconnect()` both already restore
`_s.guidedTopic` from `_s._guidedTopicInFlight` before calling
`_sessionStart()` (VTID-03746/VTID-03770). Live evidence shows the restored
value still didn't reach the server on at least one real reconnect, and the
exact reason could not be pinned down with certainty from this session's
tools (no live browser/console access — see "Deliberately NOT attempted").

Rather than add a THIRD caller-side restore-guard on a guess, the restore
is now ALSO applied inside `_sessionStart()` itself, immediately before
`startPayload.guided_topic_id` is read — the one point every caller
(current and any future one) must pass through before the field can ever
be sent. This structurally cannot be bypassed by an as-yet-unidentified
caller-ordering bug, regardless of which one is really at fault. Diagnostic
logging was added alongside it (guidedTopic / guidedTopicInFlight /
preDisconnectStage / isReconnectAttempt) so a recurrence is traceable from
console logs alone instead of requiring another multi-hour reconstruction
from `oasis_events`.

### Fix 2 — live-session-controller.ts: SSE transport never got the guided-topic reconnect exemption

Independent of Fix 1, `live-session-controller.ts` (the SSE-transport
session controller — a SEPARATE code path from `orb-live.ts`'s WS handling)
has its own `!isReconnectStart` gate around injecting the picked wake-brief
candidate's line, and that gate has NO exemption for a guided-topic winner —
unlike `orb-live.ts`, which already carries this exact exemption
(`_hasPendingGuidedTopicAtOpen`, VTID-03727/VTID-03771). Confirmed by
reading `guided-topic-narration.ts`'s `produce()`: since VTID-03677 it does
not read `isReconnect` at all and returns its candidate purely on `topicId`
presence — so IF `topicId` reaches the server on a reconnect (which Fix 1
now defends more robustly), the guided-topic candidate would correctly WIN
the ranking (priority 96, highest of any provider) but this SSE controller
would then silently discard that win anyway, because the gate has no
concept of which candidate won — it withholds ANY winner uniformly on a
reconnect. This is real and independently worth fixing as defense-in-depth,
regardless of whether it was the literal cause of the specific T003 incident
(which per the wake-timeline was actually `no_topic_tapped` — the
candidate never got a chance to compete at all).

Extracted as `shouldInjectWakeBriefOverrideBlock(isReconnectStart, dedupeKey)`,
a pure, directly unit-tested predicate (mirrors this codebase's own
`shouldRetryDayCloseReduced`/`shouldFallbackToVertexOnGuidedTopicContentFilterBlock`
pattern from `orb-live.ts`) instead of an inline `&&` chain.

## Acceptance Criteria

AC-1 — `_sessionStart()` restores `_s.guidedTopic` from
`_s._guidedTopicInFlight` when `_s.guidedTopic` is empty, immediately before
`startPayload.guided_topic_id` is read.
TEST: `test/frontend/orb-widget-guided-topic-mid-lesson-resume.test.ts` —
"restores guidedTopic from _guidedTopicInFlight when guidedTopic is empty,
immediately before the payload read".

AC-2 — The restore is additive: the existing `_attemptReconnect`/
`_resetAndReconnect` restore-guards (VTID-03746/VTID-03770) are unchanged.
TEST: same file — "the existing _attemptReconnect/_resetAndReconnect
restore-guards are unchanged (this is additive, not a replacement)".

AC-3 — Diagnostic logging captures guidedTopic/guidedTopicInFlight/
preDisconnectStage/isReconnectAttempt on every `_sessionStart()` call.
TEST: same file — "logs guidedTopic/guidedTopicInFlight/preDisconnectStage
state on every _sessionStart call".

AC-4 — Mutation-verified: removing the new restore block alone fails
exactly the 3 tests that assert it (existence, no-op-when-already-set,
log-presence) and none of the other 15 in the same file.
TEST: manual mutation run, see `commands.log`.

AC-5 — `shouldInjectWakeBriefOverrideBlock` returns `true` on a
non-reconnect open regardless of candidate.
TEST: `test/orb/live/session/live-session-controller.test.ts` — "injects on
a non-reconnect open regardless of dedupeKey".

AC-6 — `shouldInjectWakeBriefOverrideBlock` returns `false` on a reconnect
for any non-guided-topic candidate (unchanged prior behavior).
TEST: same file — "withholds injection on a reconnect for a
non-guided-topic candidate (unchanged behavior)".

AC-7 — `shouldInjectWakeBriefOverrideBlock` returns `true` on a reconnect
specifically when the winning candidate's dedupeKey starts with
`guided_topic:`.
TEST: same file — "still injects on a reconnect when the winning candidate
is a guided-topic resume".

AC-8 — The exemption requires an exact `guided_topic:` prefix — a
lookalike key is not accidentally exempted.
TEST: same file — "requires an exact guided_topic: prefix — a lookalike
key is not exempted".

AC-9 — `undefined`/empty dedupeKey on a reconnect is non-exempt (safe
default).
TEST: same file — "handles undefined/empty dedupeKey on a reconnect as
non-exempt".

AC-10 — Mutation-verified: reverting the predicate's own logic to the old
unconditional `!isReconnectStart` fails exactly the 1 test asserting the
guided-topic exemption, and no others.
TEST: manual mutation run, see `commands.log`.

AC-11 — The call site (`live-session-controller.ts`) uses the extracted
predicate instead of the old inline expression.
TEST: `tsc --noEmit` clean (compile-time proof the call site type-checks
against the new function signature) + `commands.log`'s grep confirmation.

AC-13 — `tsc --noEmit` is clean.
TEST: `commands.log` — exit 0.

AC-14 — `orb-widget.js`: `_s._guidedTopicAudioDelivered` defaults `false`
and is reset `false` on every fresh `focusGuidedTopic()` tap.
TEST: `test/frontend/orb-widget-guided-topic-mid-lesson-resume.test.ts` —
"is declared in the initial _s state, defaulting to false",
"focusGuidedTopic resets it to false on every fresh tap".

AC-15 — It flips `true` at the exact turn-complete point that already
nulls `_s.guidedTopic` (turn-1 audio confirmed delivered).
TEST: same file — "is flipped true at the same turn-complete point that
nulls _s.guidedTopic".

AC-16 — `_hide()` clears it (real close ends the overlay session).
TEST: same file — "_hide() clears it — a real close ends the overlay
session".

AC-17 — `_sessionStart()` sends `guided_topic_resume` only when BOTH
`guidedTopic` and the delivered flag are truthy, nested inside the
`guided_topic_id` block so it can never be sent alone.
TEST: same file — "_sessionStart sends guided_topic_resume only when both
guidedTopic AND the delivered flag are set", "the resume field is nested
inside the guidedTopic block".

AC-18 — Mutation-verified (client): removing the flag-set-true statement
fails exactly 1 test; removing the send-condition fails exactly 2 tests;
neither touches the other 22/21 tests in the file.
TEST: manual mutation run, see `commands.log`.

AC-19 — `live-session-controller.ts` stores `guided_topic_id` AND
`guided_topic_resume` on the created session from the request body, and
forwards `guidedTopicResume` into `decideWakeBriefForSession`.
TEST: `test/orb/live/session/live-session-controller.test.ts` — "stores
guided_topic_id and guided_topic_resume on the created session".

AC-20 — `guided_topic_resume` defaults to `false` when absent, and a
non-boolean value is ignored (defensive against a malformed payload).
TEST: same file — "defaults guided_topic_resume to false when the field is
absent", "ignores a non-boolean guided_topic_resume".

AC-21 — `guided-topic-narration.ts`: on `isResume`, the candidate still
WINS (still priority 96, topic context still bundled) but does NOT call
Polly synthesis and returns an empty `userFacingLine`.
TEST: `test/services/assistant-continuation/providers/guided-topic-narration.test.ts`
— the full "VTID-03774 ... isResume" describe block (7 tests): still
leads, no Polly call, empty line, empty line still validates, narrationAudio
stays null, TEACH content still bundled, no regression when isResume is
false/unset.

AC-22 — Mutation-verified (server): reverting the empty-line branch fails
exactly 1 test; reverting the Polly-skip branch fails exactly 1 (different)
test; neither touches the other 18/18 tests in the file.
TEST: manual mutation run, see `commands.log`.

AC-23 — Full gateway suite passes with no new failures, INCLUDING the
Fix-3 tests.
TEST: `commands.log` — 714/715 suites (1 pre-existing skip), 13,465/13,500
tests passing, 0 failures (13,449 baseline + 16 new: 6 widget + 3
controller + 7 provider).

AC-24 — `tsc --noEmit` is clean after Fix 3 (including the new
`guided_topic_resume` field on the `GeminiLiveSession` type).
TEST: `commands.log` — exit 0.

## Deliberately NOT attempted / not claimed

- **The exact caller-ordering bug that let the T003 incident's
  guided_topic_id go missing despite both existing restore-guards appearing
  correct on static reading was NOT conclusively identified.** This session
  has no live-browser/console access (the same standing environment
  limitation recorded in VTID-03763's evidence pack — headless Chromium
  cannot complete a TLS handshake through this sandbox's proxy). Fix 1
  closes the gap structurally (restore at the one unbypassable point)
  rather than by naming the exact defect, which is honest but weaker than a
  root-caused fix — if a THIRD, structurally different code path is
  somehow bypassing `_sessionStart()` entirely (not evidenced, but not
  ruled out either), this fix would not help it. No evidence points at
  that; it's flagged for completeness.
- **Confirmed against live traffic — explicitly NOT yet.** Same standing
  caveat as every prior VTID in this chain. The next real signal is a
  guided-topic session that disconnects and reconnects mid-lesson actually
  resuming the SAME topic, and `guided_topic_narration`'s wake-timeline
  entry showing something other than `no_topic_tapped` on that reconnect.
- **The `active_role` field flipping from `"community"` to `null"` between
  the two sessions in this trace** was noticed during investigation and is
  unexplained — not obviously connected to the guided-topic loss (it's
  server-resolved, not client-sent), not touched by this fix, and not
  chased further given it doesn't bear on the reported symptom.
- **Correction to this PR's own earlier framing:** the PR description
  originally called `live-session-controller.ts` "the SSE-transport session
  controller — a separate code path from `orb-live.ts`'s WS handling."
  That's imprecise: `ws-start-adapter.ts` calls the exact same
  `handleLiveSessionStart` this file exports for WS sessions too (confirmed
  by reading `ws-start-adapter.ts:141`) — `live-session-controller.ts`
  handles session-START for BOTH transports; `orb-live.ts`'s own
  `_hasPendingGuidedTopicAtOpen`/`sendGreetingPromptToLiveAPI` is a
  SEPARATE, LATER decision point (the live Nova greeting-prompt path, not
  session creation). This means Fix 2 (and Fix 3) already benefit BOTH
  transports, not narrowly SSE — a correction in this PR's own favor, not a
  gap, but recorded here since the PR body says otherwise and wasn't
  edited after the fact.
- **Fix 3, like Fixes 1 and 2, is NOT independently confirmed against live
  traffic.** The next real signal is a guided-topic session that
  disconnects mid-lesson (after real audio has played) and reconnects
  WITHOUT restarting the narration from the beginning — ideally observed
  via `orb_wake_timelines`/`oasis_events` showing `guided_topic_resume` on
  the reconnect's start body and `guided_topic_narration`'s decision
  carrying an empty `userFacingLine` with `narrationAudio: null`.
