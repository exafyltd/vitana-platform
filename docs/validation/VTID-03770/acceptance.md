# VTID-03770 — guided-topic teaching lost on a health-probe-recovered
# reconnect; session reopens generic instead of resuming

User report (verbatim): "It starts talking about the selected step/session,
and after it finishes, you can hear that sound like Orb is again switched
on, and it just continues with the New Day Greeting. You cannot stop it;
close button doesn't react to tapping."

## Investigation

This is the exact failure shape VTID-03746 already fixed once (its own
test file documents it: topic T007, "then vitana starts talking and its a
new day greeting instead of reading the session") — so the first step was
confirming whether this is a genuine regression/gap rather than reasserting
an unroot-caused flake. Self-allocated this VTID and traced live via
`oasis_events` (Supabase MCP, read-only) rather than guessing.

Initial `oasis_events` query scoped to the documented e2e test account
(`a27552a3-...`) turned up a real, still-unexplained repeating-session
pattern, but zero guided-topic activity for that account in the prior 12
hours — a dead end that could have led to a wrong diagnosis if trusted
without corroboration (this session has been burned by exactly that
mistake once already this conversation, on the CI-blocking investigation).
Widened the query to all users and found the real reporting account
(`bc34a5ca-...`, `j.tadic@exafy.io`, staging, `preview-aws.vitanaland.com`,
Android/Edge Mobile) with two real guided-topic taps in the same window
(T003 at 08:01, T005 at 09:15).

Traced T005's full session chain second-by-second:
1. `live-c3bde79b` — T005 candidate wins (priority 96,
   `source:guided_topic_narration`), narration audio bridge sent, but hits
   Nova's `nova_validation` content filter TWICE in ~200ms (still
   unroot-caused, consistent with every prior row in this chain) and gets
   superseded.
2. `live-3b5251dd` — T005 wins again, delivers the opener, and runs a REAL
   37.7-second, 335-audio-chunk conversational turn (`turn_count:1` at
   teardown) — the actual lesson genuinely played.
3. At ~34.5s in, the underlying connection drops
   (`orb.session.continuity.persisted reason=connection`) — a transport
   failure, not a user action; `_announceDisconnect('connection')` fires
   client-side.
4. ~5.5s later a brand-new session (`live-4c56c1f3`) starts and
   `live-3b5251dd` is torn down server-side with
   `reason:"superseded_by_new_session"`.
5. `live-4c56c1f3`'s own wake-brief candidate ranking shows EVERY source
   `skipped`/`all_sources_skipped` — no `guided_topic_narration` candidate
   at all. It opens generic instead, runs ~4.5s (one short model turn),
   then hides. This is what read as "Vitana switches on again with the New
   Day Greeting" right after the T005 lesson was cut off.

Static code reading of `orb-widget.js` to find why the topic wasn't
resumed: `_attemptReconnect()` (the scheduled 1.5s/3s/5s/8s/12s retry
ladder) already has the VTID-03746 restore guard
(`if (_s._guidedTopicInFlight && !_s.guidedTopic) { _s.guidedTopic =
_s._guidedTopicInFlight; }`) run immediately before its own
`_sessionStart()` call. But the ~5.5s gap between the connection drop and
the new session landing is a much closer match to the 5-second health-probe
watchdog (`_s._recoveryWatchdog`, armed by `_announceDisconnect`) than to
`_attemptReconnect`'s first 1.5s retry delay. That watchdog's probe
success handler calls `_resetAndReconnect()` — a SEPARATE function that
rebuilds the session via a plain `_sessionStart()` with NO restore logic
at all, confirmed by direct read: no reference to `_guidedTopicInFlight`
anywhere in its body. VTID-03746 fixed one of the two reconnect code paths
and missed the other.

Root cause: `_resetAndReconnect()` never restores `_s.guidedTopic` from
`_s._guidedTopicInFlight` before starting a fresh session, so any
disconnect recovered via the health-probe watchdog (or the tap-to-reconnect
stuck-state button, which also calls this function) silently drops an
in-progress guided topic and opens a generic session instead.

Separately, while reading `_resetAndReconnect()` end-to-end, found it sets
`_s._isReconnecting = false` at its own top — the exact opposite of a
re-entrancy guard. The watchdog's own probe tick checks
`if (_s._isReconnecting) return;` before firing another probe, but since
`_resetAndReconnect` never actually sets the flag true, that check was
inert: a second probe tick landing while the first `_resetAndReconnect`'s
own `_sessionStart()` was still in flight (plausible under the exact
repeated-`nova_validation`-retry conditions measured live in this same
trace, each retry costing a few hundred ms) could fire a second, concurrent
`_resetAndReconnect()`, racing two session-starts against each other. Fixed
in the same edit, mirroring `_attemptReconnect()`'s existing correct
pattern (`true` before starting, reset to `false` once `_sessionStart()`
settles, on both the success and failure branch).

The "close button doesn't react to tapping" half of the report was not
independently reproduced with its own distinct root cause — `_hide()`
(bound directly to the close button's click handler, unconditionally, no
state-gating) synchronously sets `_userInitiatedStop`/`_userRequestedClose`
and stops playback before any network teardown, and `_sessionStart()`
itself re-checks `_userInitiatedStop` at multiple intermediate await
points, so a close tap should interrupt an in-flight reconnect reasonably
promptly. The much more likely explanation, given the concurrency gap just
found: repeated auto-reopens (a session dies again quickly, e.g. via
`nova_validation`, re-arming a fresh watchdog probe) could keep popping the
overlay back open faster than a user could register the close as having
"worked," reading as "unresponsive" without actually being a distinct
missing-handler bug. Fixing the restore + mutex gap directly reduces how
often this loop can fire at all. Flagging this explicitly rather than
silently declaring the close-button half independently fixed.

## Fix

`services/gateway/src/frontend/command-hub/orb-widget.js`,
`_resetAndReconnect()`:
- Added the identical `_guidedTopicInFlight` restore guard
  `_attemptReconnect()` already has, run immediately before
  `_sessionStart()`.
- Changed `_s._isReconnecting = false` (at function entry) to `true`, and
  added `_s._isReconnecting = false` to both the `.then()` success branch
  and the `.catch()` failure branch of the `_sessionStart()` promise.

## Verification

TEST: services/gateway/test/frontend/orb-widget-guided-topic-mid-lesson-resume.test.ts
  4 new tests in a new `describe('orb-widget _resetAndReconnect guided-topic
  resume + reconnect mutex (VTID-03770)')` block:
  - re-arms `_s.guidedTopic` from `_guidedTopicInFlight` under the same
    condition as `_attemptReconnect`, before `_sessionStart()`
  - sets `_isReconnecting = true` before starting the reconnect
  - resets `_isReconnecting = false` on both settle branches
  - the guided-topic re-arm precedes the settle-branch reset (ordering)

Mutation-tested both fixes (outputs/mutation-testing-log.txt): reverting
either one independently fails exactly the test(s) written to catch it and
nothing else; `node --check` clean after each restore.

Full gateway suite: 713/714 suites (1 pre-existing skip), 13,433/13,468
tests passing, 0 failures (outputs/jest-full-suite.txt). `tsc --noEmit`
clean (outputs/tsc-noemit.txt).

**Not yet independently confirmed against live traffic** — same honest
caveat as every row in the VTID-03644→03770 chain this belongs to: the
next real signal is the reporting user's next mid-lesson disconnect
actually resuming the same topic instead of falling through to a generic
open, and the still-fully-open, still-unroot-caused `nova_validation`
flakiness that makes a reconnect necessary in the first place is unchanged
by this fix.
