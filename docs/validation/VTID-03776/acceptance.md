# VTID-03776 — Fix infinite guided-topic reconnect loop (VTID-03774 regression)

## Report (verbatim)

> Another setback: when I select a session, it now starts immediately with a
> new day greeting, no guided topic content at all. Definitely change your
> approach, this is clearly not yielding results, on the contrary, it just
> regresses or makes no progress. You know how it should work and make it
> work that way. Flawless!

Followed, after VTID-03774 shipped to staging, by:

> ok, just checked it for multiple sessions, and it's always this: when we
> click on any session, Vitana does indeed start with the guided topic
> content, but repeats it infinitely, there is no end, and we hear the
> Connecting sound in the background non-stop. Also, you can't stop it, the
> close button doesn't work.

## Investigation — real live evidence, not a guess

Per the explicit "change your approach" directive, this VTID started from a
live `oasis_events` trace on staging (`preview-aws-gateway.vitanaland.com`,
project `inmkhvwdcuyhnxkgfvsb`) rather than another blind code-level guess.

Query: every `orb.live.diag` event in the 90 minutes before investigation
began, filtered to `metadata::text ILIKE '%guided_topic%'`.

**Finding: a brand-new `live-*` session_id is created roughly every 3.4
seconds, continuously, for the entire 5+ minute window (~90 distinct
sessions observed).** Every single one follows the identical sequence:

1. `guided_topic_audio_bridge_sent` (`topic_id:"T003"`) — the full guided-
   topic Polly narration is re-synthesized and re-sent. **This literal
   audio re-play, once every ~3.4s, is the reported "repeats it
   infinitely."**
2. `nova_instruction_sanitized` (identity_lock block)
3. `speaking` stage, `greeting_sent:true`
4. `upstream_error`, `code:"nova_validation"`,
   `diagnostic:"...blocked by our content filters."` — within ~700ms of
   `greeting_sent`, before `turn_count` ever advances past 0.
5. `upstream_closed reason:"nova_validation"`
6. `nova_premature_close_retry` — the server's own single internal retry,
   which is **also** blocked (`upstream_error` fires a second time, same
   `code:"nova_validation"`) within the same session.
7. `upstream_closed` again. The session dies. ~3.4s later, an entirely new
   `live-*` session_id begins and the sequence repeats byte-for-byte.

This is **not** the historically-documented intermittent nova_validation
flakiness (see CLAUDE.md's VTID-03674→03686 chain) — it is a **100% block
rate across ~30+ consecutive independent connection attempts** for this
exact guided-topic opener content.

### Root cause

`orb-widget.js`'s `_attemptReconnect()` success handler reset
`_s._reconnectCount = 0` whenever `_s.active` became true — i.e. on a bare
**transport**-level connect, regardless of whether the session then died
to `nova_validation` before any audio ever played. Combined with
`MAX_WIDGET_RECONNECTS=5` / `RECONNECT_DELAYS=[1500,3000,5000,8000,12000]`,
this meant the backoff budget could never actually accumulate for a
session that "succeeds" at the transport layer just long enough to zero
the counter before the very next `RECONNECT_DELAYS[0]` (1500ms) fires —
turning a nominally-bounded 5-attempt reconnect budget into a genuinely
unbounded loop.

**This gap is pre-existing, not newly introduced by this session** — but
VTID-03774's own Fix 1 (`_sessionStart()` restoring `guidedTopic` from
`_guidedTopicInFlight` at the send site) and Fix 2
(`shouldInjectWakeBriefOverrideBlock` exempting a guided-topic winner from
the reconnect-suppression gate) are what made it newly *reachable*:
**before** VTID-03774, a reconnect silently dropped `guided_topic_id`
(the original VTID-03774 bug — "starts with a new day greeting instead"),
so the SAME doomed guided-topic content was never resent on every
reconnect and the loop never had a reason to form. **After** VTID-03774,
`guided_topic_id` correctly persists and resends on every reconnect — so a
topic whose opener nova_validation deterministically rejects now retriggers
the exact same doomed request forever.

### Close button — investigated, not independently reproduced as a separate defect

Read `_hide()`, `_sessionStart()`'s early-exit guards, and `_playAudio()`'s
guard in full:
- `_hide()` synchronously sets `_s.overlayVisible = false`, stops all
  `scheduledSources`, clears `_s.audioQueue`, and hides the DOM root —
  before any async network teardown.
- `_sessionStart()` bails immediately on `_s._userRequestedClose`.
- The `_attemptReconnect()` deferred `setTimeout` callback checks
  `!_s.overlayVisible || _s._userInitiatedStop` before doing anything.
- `_playAudio()` drops any late-arriving chunk when
  `_s._userInitiatedStop || !_s.overlayVisible`.
- The close (`X`) button binds `_hide` via a single `addEventListener`
  call made once at widget construction — not re-attached per state
  update, so it cannot be silently orphaned by the reconnect churn.

No structural defect was found in this path. The most consistent
explanation, given the confirmed reconnect-storm mechanics above, is that
"close doesn't work" was **downstream of the infinite loop itself** — five
or more minutes of continuous audio/state churn, with a new `_sessionStart()`
transport connect roughly every 3.4 seconds, is exactly the kind of chaos
that would make a real, functioning close button feel unresponsive. This
session has no live-browser console access (a standing limitation
throughout the VTID-03746→03774 chain) to independently confirm a click
literally reached `_hide()`; fixing the loop's root cause (below) removes
the dominant explanation for the symptom rather than patching a click
handler that reads as structurally correct.

## Fix

### Fix A — only reset the reconnect budget once real audio has played

`_attemptReconnect()`'s success handler now gates `_s._reconnectCount = 0`
on `_s._audioEverHeardThisOpen` (the same flag VTID-03727 already
established for the reconnect-caption gating, set only once real audio has
played this overlay-open, cleared only by `_hide()`) — not on `_s.active`
alone. A transport-only connect that dies to content-filter/other zero-turn
failure no longer resets the budget; `MAX_WIDGET_RECONNECTS` now actually
bounds the loop (≤5 attempts, ≤~29.5s of backoff) before
`_enterStuckState()` (a user-facing tap-to-reconnect state) takes over.

### Fix B — circuit breaker on repeated zero-audio guided-topic failures

A new per-overlay-open counter, `_s._guidedTopicZeroAudioFailCount`,
increments in `_attemptReconnect()` whenever a disconnect happens with a
guided topic in flight AND nothing has ever been heard this overlay-open.
After 2 such failures (this connection's attempt + one retry — matching
the server's own single internal retry budget for a fresh topic), the
widget drops `_s.guidedTopic`/`_s._guidedTopicInFlight` so the next
reconnect attempt falls through to safe, working generic conversation
instead of repeating the doomed narration — ending the audible repeat
well before Fix A's 5-attempt ceiling is reached. Does **not** fire once
real audio has played, so a genuine mid-lesson network blip still resumes
the SAME topic via VTID-03774's own `guided_topic_resume` signal (Fix 3) —
this only targets a topic that has never once been heard.

Reset points for both new flags follow the exact same lifecycle already
established for `_guidedTopicInFlight`/`_guidedTopicAudioDelivered`: a
fresh tap (`focusGuidedTopic`) and a real close (`_hide()`).

## Acceptance Criteria

AC-1 — `_s._guidedTopicZeroAudioFailCount` is declared in the initial `_s`
state, defaulting to 0.

TEST: `orb-widget-guided-topic-reconnect-loop.test.ts` — "is declared in the
initial _s state, defaulting to 0"

AC-2 — Reset to 0 on a fresh guided-topic tap.

TEST: same file — "is reset to 0 by focusGuidedTopic (a fresh tap is a
clean slate)"

AC-3 — Reset to 0 on `_hide()` (a real close).

TEST: same file — "is reset to 0 by _hide() — a real close ends the
overlay session"

AC-4 — The zero-audio fail counter increments only when a guided topic is
in flight AND no audio has ever been heard this overlay-open.

TEST: same file — "increments the zero-audio fail counter only when a
guided topic is in flight AND nothing has been heard yet"

AC-5 — At the threshold (2), both `guidedTopic` and `_guidedTopicInFlight`
are dropped.

TEST: same file — "drops both guidedTopic and _guidedTopicInFlight once
the threshold is reached"

AC-6 — The breaker check runs before the `MAX_WIDGET_RECONNECTS`
stuck-state check, so a dropped topic still gets a fair remaining-budget
retry as generic conversation.

TEST: same file — "the breaker check runs before the MAX_WIDGET_RECONNECTS
stuck-state check"

AC-7 — The breaker does not touch the counter or drop the topic once real
audio has played this overlay-open (mid-lesson resume must survive).

TEST: same file — "does NOT touch the counter or drop the topic once real
audio has played"

AC-8 — `_reconnectCount` is NOT reset on bare `_s.active` alone.

TEST: same file — "does NOT reset _reconnectCount on bare _s.active alone"

AC-9 — The reset is gated on `_s._audioEverHeardThisOpen`, nested inside
the `_s.active` branch.

TEST: same file — "gates the reset on _s._audioEverHeardThisOpen, nested
inside the _s.active branch"

AC-10 — Success logging and disconnect-banner clearing are unaffected by
whether the budget was actually reset.

TEST: same file — "still logs success and clears the disconnect banner
regardless of whether the budget was reset"

AC-11 — The reconnect loop is otherwise unchanged: `_isOffline`/
`_isReconnecting`/`MAX_WIDGET_RECONNECTS` gates are all still intact.

TEST: same file — "the reconnect loop itself is otherwise unchanged"

AC-12 — The sibling VTID-03675 invariant is updated, not weakened:
`_attemptReconnect` still cannot bare-null `guidedTopic` — any null is
provably inside the new breaker's own `>= 2` guard.

TEST: `orb-widget-guided-topic-reconnect.test.ts` — "a client-side
reconnect (_attemptReconnect -> _sessionStart) can still see a pending
guided topic" (updated)

AC-13 — `node --check` is clean.

TEST: `outputs/node-check.txt` — exit 0.

AC-14 — `tsc --noEmit` is clean.

TEST: `outputs/tsc-noemit.txt` — exit 0.

AC-15 — The full gateway suite is green.

TEST: `outputs/jest-full-suite.txt` — 715/716 suites (1 pre-existing
skip), 13476/13511 tests passing, 0 failures.

AC-16 — Both fixes are mutation-verified.

TEST: `commands.log` — Fix A mutation fails exactly 1 test; Fix B mutation
fails exactly 4 tests (3 new + the updated sibling invariant); both
restores confirmed clean via `diff`.

## Deliberately NOT attempted

- **The close button was not independently reproduced as a defect and was
  not given its own code change.** Every guard governing it was read and
  found structurally correct (see "Close button" section above). Fixing
  the confirmed loop root cause is the intervention that addresses the
  most consistent explanation for the symptom; if the platform owner still
  sees an unresponsive close button on a genuinely SHORT (non-looping)
  guided-topic session after this fix ships, that would newly isolate it
  as an independent defect worth its own investigation.
- **The underlying `nova_validation` block on T003's guided-topic opener is
  still fully unroot-caused.** This VTID does not attempt to make Nova
  accept that content — it makes the system behave sanely (bounded retries,
  a working fallback to generic conversation, no infinite audible repeat)
  when Nova keeps rejecting it, which is the correct posture given this
  exact content-filter flakiness has never been made deterministic or
  reproducible on demand across the whole VTID-03644→03776 chain.
- **Not confirmed against live traffic.** Same standing caveat as every
  VTID in this chain: this session has no live-browser verification path.
  The next real signal is the platform owner's own retest — tap a guided-
  topic session and confirm it does NOT loop/repeat audio indefinitely and
  the close button responds normally.
