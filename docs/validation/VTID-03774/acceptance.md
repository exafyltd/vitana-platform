# VTID-03774 — Acceptance

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

AC-12 — Full gateway suite passes with no new failures.
TEST: `commands.log` — 714/715 suites (1 pre-existing skip), 13,449/13,484
tests passing, 0 failures.

AC-13 — `tsc --noEmit` is clean.
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
