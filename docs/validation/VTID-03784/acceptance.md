# VTID-03784 — Guided-topic circuit breaker false-completes via unstopped 5-min backstop

## Report (verbatim)

> and again, after a few minutes (cca. 5) the drawer appeared. I have
> selected My Journey step within the Session 7.

(Two screenshots: first shows the orb in the "Tap the orb to reconnect"
stuck state with a muted-mic icon; second, taken ~5 minutes later with no
user interaction in between, shows the "Well done!" drawer with "+2 VITANA
INDEX" credit for My Journey.)

## Investigation

The first screenshot's caption ("Tap the orb to reconnect") is the exact
text `_enterStuckState()` sets — this is a DIFFERENT frozen state from the
one VTID-03783 just fixed (that was "Session ended — app was in the
background", a distinct caption from a distinct code path). This report is
about `_enterStuckState()`, the shared tap-to-reconnect stop used by both
the VTID-03776/VTID-03782 guided-topic circuit breaker and generic
`MAX_WIDGET_RECONNECTS` exhaustion.

Read `focusGuidedTopic(topicId)`: on every fresh My Journey tap it arms a
5-minute backstop (`GUIDED_TOPIC_BACKSTOP_MS`, VTID-03762) via
`setInterval`, which — if nothing else has ended the guided-topic teaching
session by then — fires `_endGuidedTopicTeaching(topicId, 'backstop_timeout')`
unconditionally. That function is idempotency-guarded
(`_s._guidedTopicTeachingEnded`, VTID-03781) but nothing else gates it: it
calls `_hide()` and fires the `onGuidedTopicTeachingEnd` host callback
(→ `completePractice`), i.e. it awards real step completion.

Read where the backstop is ever *cancelled*: only `_hide()` clears
`_s._guidedTopicOpenedAt` and the interval handle. Read
`_enterStuckState()` (both its circuit-breaker call site, VTID-03782, and
the `MAX_WIDGET_RECONNECTS` call site): neither calls `_hide()` — by
design, the overlay is meant to stay up on-screen so the user can tap to
retry, not disappear. Neither clears the backstop either.

## Root cause

The VTID-03782 circuit breaker correctly gives up on a guided topic after
2 consecutive zero-audio `nova_validation` failures and stops honestly via
`_enterStuckState()` — but the VTID-03762 backstop timer armed back when
the topic was first tapped keeps running regardless, because nothing on
the stuck-state path ever cancels it. Five minutes after the honest stop,
the backstop still fires, closes the (already-stuck) overlay, and awards
completion credit for a lesson that was never delivered — reproducing
almost exactly the "no Well-done drawer" defect VTID-03782 fixed, just
inverted: now the drawer appears, but for content the user never actually
heard.

## Fix

Moved the backstop cancellation into `_enterStuckState()` itself — the
same `_s._guidedTopicOpenedAt = null` / `clearInterval(...)` /
`_s._guidedTopicBackstopInterval = null` cleanup `_hide()` already does —
rather than duplicating it only at the circuit-breaker call site. This
covers both current call sites (the circuit breaker and
`MAX_WIDGET_RECONNECTS` exhaustion) and any future one, consistent with
`_enterStuckState()` already being the established, reused "stop honestly"
mechanism for this whole VTID chain (no new UI or mechanism invented).

## Acceptance Criteria

AC-1 — `_enterStuckState()` clears `_s._guidedTopicOpenedAt`.

TEST: `orb-widget-guided-topic-backstop-stuck-state.test.ts` — "clears
_guidedTopicOpenedAt"

AC-2 — `_enterStuckState()` cancels the backstop interval and nulls the
handle.

TEST: same file — "cancels the backstop interval and nulls the handle"

AC-3 — The existing tap-to-reconnect UI behavior (orb error state, caption,
`_disconnectStuck`) is unchanged.

TEST: same file — "still sets the tap-to-reconnect UI state (unchanged
behavior)"

AC-4 — The fix lives in the shared `_enterStuckState()`, not duplicated at
just the circuit-breaker call site — so `MAX_WIDGET_RECONNECTS` exhaustion
for a guided-topic session gets the identical protection.

TEST: same file — "the guided-topic circuit breaker call site no longer
needs its own duplicate cancellation — _enterStuckState covers it",
"MAX_WIDGET_RECONNECTS exhaustion also stops via the same _enterStuckState"

AC-5 — All 19 pre-existing tests across the two sibling guided-topic
circuit-breaker/reconnect test files still pass unmodified.

TEST: `orb-widget-guided-topic-circuit-breaker-stop.test.ts` (7 tests),
`orb-widget-guided-topic-reconnect-loop.test.ts` (12 tests) — both
unmodified, both green.

AC-6 — `node --check` is clean.

TEST: `outputs/node-check.txt` — exit 0.

AC-7 — `tsc --noEmit` is clean.

TEST: `outputs/tsc-noemit.txt` — exit 0 (empty output).

AC-8 — The fix is mutation-verified: deleting the 3 fix lines from
`_enterStuckState()` fails exactly 2 tests (the two directly asserting the
fix); the other 22 tests across the 3 related files stay green. Clean
restore confirmed via `diff`.

TEST: `commands.log` — mutation testing section.

AC-9 — The full gateway suite is green.

TEST: `outputs/jest-full-suite.txt`.

## Deliberately NOT attempted

- **No change to `onGuidedTopicTeachingEnd`/`completePractice` on the host
  (`vitana-v1`) side.** The client-side backstop cancellation stops the
  false signal from ever being sent in the first place — the cleanest
  point to fix this, since the host has no way to distinguish "the
  backstop fired after an honest stop" from "the backstop fired after a
  genuine, silently-uncompleted lesson" once the signal already arrived.
- **No change to the circuit breaker's own detection threshold (2
  consecutive zero-audio failures) or to `nova_validation` itself** — both
  remain the standing, still-unroot-caused open issues named throughout
  this VTID chain since VTID-03665.
- **Not independently confirmed against live traffic.** Same standing
  caveat as every VTID in this chain: this session has no live-browser
  verification path. The next real signal is the platform owner
  reproducing the circuit-breaker stuck state again and confirming no
  Well-done drawer appears 5 minutes later without an explicit retry.
