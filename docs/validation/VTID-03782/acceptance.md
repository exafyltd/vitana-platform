# VTID-03782 — Guided-topic circuit breaker falls through to unbounded generic conversation

## Report (verbatim)

> now something weird is happening. After it talks about the selected
> step/session, Vitana starts something that sounds like a reading a
> script, but most importantly, it doesn't finish after teaching the
> session and Well sone drawer doesn0t open afterwards, and the session is
> not marked as done.

## Investigation — live evidence

Queried `oasis_events` (`inmkhvwdcuyhnxkgfvsb`, production) for the
reporting user in the minutes before the report. Found a burst of
reconnects for topic T009:

- `08:01:58` — guided-topic candidate for T009 wins (`source:guided_topic_narration`), session `live-27563f89` starts.
- `08:02:02` — T009 candidate wins **again** (a reconnect), session `live-1774aa92` starts.
- `08:02:06` — session `live-1fb2773f` starts. **No guided-topic candidate wins for this session** — instead its `orb.live.diag` trace shows `wake_opener:"conv_resume"`, `nba:"next_session"`, `nba_domain:"journey"`, `bucket:"reconnect"` — a different, generic continuation provider.
- This session then spoke **one continuous turn of 3,562 output speech
  tokens** (`orb.live.upstream.usage`, `output_speech_tokens` climbing
  from 0 to 3562 with no intervening `turn_complete`) — matching the
  reported "sounds like reading a script."
- The session closed 45 seconds after that turn finished with
  `reason:"client_disconnect"` — no `end_guided_topic_teaching` signal
  ever fired, because the guided-topic system instruction (which is the
  only thing that ever tells the model that tool exists/matters) was
  never injected for this session in the first place.
- The very next reconnect (`live-91e60959`) also opened generic
  (`prompt_len:655`, no guided-topic tag), hit `nova_validation`
  immediately, retried, and was finally closed by the user manually
  (`reason:"user_stop"`).

## Root cause

`_attemptReconnect()`'s VTID-03776 zero-audio circuit breaker correctly
detects 2 consecutive connection failures for a guided topic with no
audio ever heard, and correctly drops the topic (`_s.guidedTopic = null`,
`_s._guidedTopicInFlight = null`) so the reconnect doesn't repeat doomed
content forever. But after dropping the topic it fell straight through to
the normal reconnect scheduling below — the next attempt runs the
ordinary wake-brief candidate ranking with no guided topic in the mix,
and whatever generic candidate wins (here, `conv_resume`/`next_session`)
opens as an ordinary, unbounded conversation.

Because that fallback conversation is not a guided-topic teaching
session, none of the teaching-completion machinery this VTID chain built
(VTID-03762/03763/03781: `end_guided_topic_teaching`, the 5-minute
backstop, `completePractice`) is reachable for it — there is nothing to
call `end_guided_topic_teaching`, nothing arms the backstop, and nothing
marks the step done. From the user's perspective this reads as "the
Journey session never finishes," even though, mechanically, it had
already silently stopped being the Journey session at all by the time it
started talking.

## Fix

`_attemptReconnect()`'s circuit-breaker branch now calls the **existing**
`_enterStuckState()` function — the exact same tap-to-reconnect state
already used when `MAX_WIDGET_RECONNECTS` is exhausted — instead of
falling through. This stops the attempt honestly (visible "tap to
reconnect" state) rather than silently degrading into an unrelated,
unbounded conversation the user cannot distinguish from their lesson. No
new UI, caption, or state was invented — `_enterStuckState()` is reused
verbatim.

## Acceptance Criteria

AC-1 — The circuit breaker still drops `guidedTopic` and
`_guidedTopicInFlight` once the threshold is reached (unchanged
behavior).

TEST: `orb-widget-guided-topic-circuit-breaker-stop.test.ts` — "still
drops guidedTopic and _guidedTopicInFlight once the threshold is reached
(unchanged)"

AC-2 — The breaker calls `_enterStuckState()` after dropping the topic.

TEST: same file — "calls _enterStuckState() after dropping the topic"

AC-3 — The breaker returns immediately after `_enterStuckState()` — it
does not fall through to the normal reconnect scheduling below.

TEST: same file — "returns immediately after _enterStuckState() — does
not fall through to the normal reconnect scheduling below"

AC-4 — No reconnect budget is consumed and no delayed reconnect is
scheduled once the breaker has stopped the attempt.

TEST: same file — "does not increment _reconnectCount or schedule a
delayed reconnect once the breaker has stopped the attempt"

AC-5 — `_enterStuckState()` is the same single function
`MAX_WIDGET_RECONNECTS` exhaustion already uses — no new/duplicate stuck
state was created.

TEST: same file — "_enterStuckState remains the exact same function
MAX_WIDGET_RECONNECTS exhaustion uses — no new UI invented"

AC-6 — Sibling VTID-03776 tests still pass, with one updated to reflect
the new (no-fallthrough) behavior instead of the old ("fair
remaining-budget retry") one.

TEST: `orb-widget-guided-topic-reconnect-loop.test.ts` — "does NOT fall
through to a fresh reconnect once the breaker trips — it stops
immediately instead"

AC-7 — `node --check` is clean.

TEST: `outputs/node-check.txt` — exit 0.

AC-8 — `tsc --noEmit` is clean.

TEST: `outputs/tsc-noemit.txt` — exit 0 (empty output).

AC-9 — The fix is mutation-verified: removing the `_enterStuckState()` +
`return` fails exactly 3 tests (2 in the new suite, 1 in the sibling
suite), all of which directly assert this behavior; 19 other tests across
the same 3 files stay green. Clean restore confirmed via `diff`.

TEST: `commands.log` — mutation testing section.

AC-10 — The full gateway suite is green.

TEST: `outputs/jest-full-suite.txt`.

## Codex review finding — addressed before merge

Automated review on this PR (chatgpt-codex-connector) flagged a real gap in
the initial fix, P1: `_enterStuckState()` alone does not stop *automatic*
recovery. `_resetAndReconnect()`'s own pre-existing comment confirms
`_disconnectActive` is deliberately left `true` after entering a stuck
state so the 5-second `_recoveryWatchdog` health-probe (armed by
`_announceDisconnect()`) can auto-recover once the gateway answers again —
correct behavior for the original `MAX_WIDGET_RECONNECTS` (real network
outage) case, but wrong for this breaker: it trips while the gateway is
fully reachable (Nova's content filter rejected the content, not a dropped
connection), so the watchdog's next probe would succeed within ~5 seconds
and call `_resetAndReconnect()` automatically — silently reopening the
exact unrelated conversation this fix exists to prevent, merely delayed by
a few seconds instead of happening immediately.

Verified against the code before fixing (not just the review's claim):
read `_announceDisconnect()`/`_recoveryWatchdog` (lines ~1308-1433) and
`_resetAndReconnect()` (lines ~1479-1553, whose own comment literally says
"Keep `_disconnectActive` true so the UI doesn't flash to a usable state
before the new session lands") — confirmed the watchdog is real, already
armed by the time this breaker runs, and untouched by the original fix.

**Fix:** the breaker now cancels `_recoveryWatchdog` and clears
`_disconnectActive` before calling `_enterStuckState()`, so only an
explicit tap (still gated on `_disconnectStuck`, which `_enterStuckState()`
already sets) can resume from this stop. `_enterStuckState()` itself and
the `MAX_WIDGET_RECONNECTS` call site are deliberately left untouched —
their existing auto-recover-on-reachable behavior is correct for a real
network outage and is not this VTID's bug to fix.

AC-11 — The breaker cancels the recovery watchdog and clears
`_disconnectActive` before entering the stuck state, so an automatic
health-probe cannot silently undo the stop.

TEST: `orb-widget-guided-topic-circuit-breaker-stop.test.ts` — "cancels
the recovery watchdog and clears _disconnectActive before entering the
stuck state"

AC-12 — The manual tap-to-reconnect path still works after
`_disconnectActive` is cleared (the tap handler ORs it with
`_disconnectStuck`, which `_enterStuckState()` sets).

TEST: same file — "the manual tap-to-reconnect path still works with
_disconnectActive cleared (gated on _disconnectStuck too)"

Mutation-verified alongside the other AC's (see `commands.log`): removing
the watchdog-cancel + `_disconnectActive` clear fails exactly this one new
test; the 6 others in the same file stay green.

## Deliberately NOT attempted

- **No change to what candidate wins when a guided topic is dropped.**
  The fallback ranking itself (which picks `conv_resume`/`next_session`
  when no guided topic is in play) is correct, ordinary ORB behavior for
  a session that genuinely has no guided topic — the defect was only in
  silently treating a dropped-topic session as if it were still that
  ordinary case, with the user having no way to tell the difference. This
  fix stops the attempt instead of trying to redesign or bound the
  fallback conversation itself.
- **No retry of the specific topic is offered automatically.** After 2
  failures for the same content, immediately retrying would very likely
  hit the same `nova_validation` block again (still fully unroot-caused
  across this entire VTID chain, from VTID-03665 onward). The person can
  re-tap the topic from My Journey (a fresh `focusGuidedTopic()` call,
  which resets the zero-audio-fail counter and gives it a genuine new
  attempt) or use the stuck-state's own tap-to-reconnect for ordinary
  conversation.
- **The underlying `nova_validation` flakiness itself is untouched** —
  same standing, still-open issue named in nearly every VTID in this
  chain since VTID-03665.
- **Not independently confirmed against live traffic.** Same standing
  caveat as every VTID in this chain: this session has no live-browser
  verification path. The next real signal is the platform owner's own
  retest — reproduce (or wait for) two consecutive guided-topic
  connection failures and confirm the ORB now shows a tap-to-reconnect
  state instead of opening an unrelated, unbounded conversation.
