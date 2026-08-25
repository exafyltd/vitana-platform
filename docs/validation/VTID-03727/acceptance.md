# VTID-03727 — reconnecting cue shown before anything is heard, and a
# guided-topic tap losing to newday_overview through a second mechanism

Live report (staging, right after VTID-03724/PR #3181 shipped): the mic
button appeared frozen, the X close button appeared unresponsive, a
"reconnecting" screen showed before any audio ever played, and an ongoing
session appeared to be interrupted mid-dictation by a new-day greeting.

## Root causes (both confirmed via live, read-only `oasis_events` evidence
against the exact reported staging window, then confirmed in code)

### 1. Premature "reconnecting" cue

`orb-widget.js`'s `_attemptReconnect()` — the widget's shared reconnect
loop, fired from every WS/SSE close handler in the file, including a
`nova_validation`-driven close that happens before turn 1 has ever played —
unconditionally called `_setStatus(_caption('reconnecting'))`. Unlike
`_announceDisconnect()` (per-reason labels) and the already-shipped
VTID-03685 fix for the WS error-frame handler and the server-side
`resendGreetingIfStuckAtZeroTurns` retry cue (both gated on "has anything
actually been heard yet"), this specific call site was never covered.

**Fix:** gate the caption on a new `_s._audioEverHeardThisOpen` flag —
`'connecting'` (the same honest label `_show()` uses for the very first
attempt) before anything has played, `'reconnecting'` once real audio has
played. **Codex review fix (P2):** the first version of this gated directly
on `_s.greetingComplete`, which is wrong — that flag is deliberately reset
to `false` on every reconnect (VTID-01988, mic-restart), so a SECOND
consecutive retry within the same overlay open would misreport `'connecting'`
even though the user genuinely heard audio earlier. `_audioEverHeardThisOpen`
is set once true (alongside `greetingComplete`, same call site) and only
cleared by `_hide()` — never by any reconnect path — so it survives however
many retries happen within one overlay open.

### 2. A pending guided-topic tap silenced by an unrelated cadence heuristic

Traced live via `oasis_events` for the reporting user's exact session
window (08:05–08:09 UTC): a guided-topic candidate won the wake-brief
ranker correctly (`guided_topic_audio_bridge_sent` fired for session
`912f74a8`), then hit Nova's `nova_validation` content filter TWICE in a
row — still at `turn_count:0`, nothing ever spoken — and was superseded by
a BRAND NEW session (`06fb8ada`): the widget's own client-side
`_attemptReconnect()` giving up and calling `_sessionStart()` fresh, not a
same-session server-internal retry. Session `06fb8ada` never emitted
`guided_topic_audio_bridge_sent` at all and instead delivered
`wake_opener:newday_overview` — VTID-03724's exact symptom, reproduced
through a different mechanism than the one that VTID fixed.

`tryGuidedTopicRung` (compute-greeting-decision.ts, added by VTID-03724)
composes its ENTIRE spoken line from `ctx.openDecision.line` and only fires
when `ctx.openDecision.mode === 'speak'`. `decideOpening()`
(opening-contract.ts) returns `mode:'silent'` whenever `isReconnect` is
true, OR whenever `wakeCadenceSkip` is true (< ~120s since
`session.lastSessionInfo` — BOOTSTRAP-NOVA-GREETING-CADENCE, built to stop
a reopened orb repeating the same passive nudge) — REGARDLESS of
`ctx.guidedTopicNarrationContent`. Session `06fb8ada` is a brand-new
session object, so its own `_reconnectCount` starts at 0 (`isReconnect`
reads false there regardless of the pre-existing
`_freshOpenAfterZeroTurnRecovery` flag, which is scoped to same-session
server-internal retries only, VTID-03634) — but `wakeCadenceSkip` still
fires, because the failed prior session ended only ~1–3s earlier. The
cadence heuristic cannot tell "the user just heard a full passive nudge and
reopened" apart from "the user's tapped lesson died silently before
speaking a single word and the widget is quietly retrying."

**Fix:** new `_hasPendingGuidedTopicAtOpen`
(`!!session.guidedTopicNarrationContent && session.turn_count === 0`)
suppresses both `isReconnect` and `wakeCadenceSkip` for THIS
`decideOpening()` call. Gated on THIS session's own `turn_count` (not the
prior session's) so a genuine mid-lesson reconnect (`turn_count > 0`) is
completely unaffected — `silent_reconnect` (compute-greeting-decision.ts
rung 7, which reads `openDecision.source`) still wins exactly as before,
preserving VTID-03724's AC-5 ("a genuine silent reconnect still wins over a
guided tap").

---

AC-1 — `_attemptReconnect()` shows `'connecting'`, not `'reconnecting'`,
before anything has been heard

TEST: `test/frontend/orb-widget-reconnect-cue-not-premature.test.ts`
Output: `outputs/full-regression.txt`

AC-2 — a caption is still shown every time (the fix does not silently drop
the status update)

TEST: same file, "still shows a caption every time"
Output: `outputs/full-regression.txt`

AC-3 — the rest of the reconnect loop (offline check, in-flight guard,
`MAX_WIDGET_RECONNECTS`) is untouched

TEST: same file, "the reconnect loop itself is unchanged otherwise"
Output: `outputs/full-regression.txt`

AC-4 — a pending, unspoken guided topic suppresses both `isReconnect` and
`wakeCadenceSkip` in the real `decideOpening()` call

TEST: `test/orb/live/characterization/guided-topic-cadence-skip-not-silenced.characterization.test.ts`
Output: `outputs/full-regression.txt`

AC-5 — the suppression is scoped to THIS session's own `turn_count`, not
carried over from a prior session object (so a genuine mid-lesson reconnect
still hits `silent_reconnect`)

TEST: same file, "the flag is computed from THIS session's own turn_count"
Output: `outputs/full-regression.txt`

AC-6 — the fix does not widen scope into the unrelated rung-9
(`silenced_on_cadence`) mechanism

TEST: same file, "does not touch silenceOnSkipEnabled"
Output: `outputs/full-regression.txt`

AC-7 — `_audioEverHeardThisOpen` (Codex P2 fix) survives multiple reconnect
attempts within the same overlay open, unlike `greetingComplete`

TEST: same file, describe block "orb-widget _audioEverHeardThisOpen
lifecycle (VTID-03727 Codex fix)" — declared false by default, set true at
the same call site as `greetingComplete` (never a separate/unguarded
assignment), NOT cleared by any of the `greetingComplete = false` reconnect
resets, and IS cleared by `_hide()`.
Output: `outputs/full-regression.txt`

AC-8 — mutation-verified, not asserted on faith

Reverted each fix independently (scripted text replacement back to the
pre-fix code, source otherwise untouched) and re-ran exactly the new tests
for that fix:
- orb-live.ts fix reverted → 4 of 5 new characterization tests failed (the
  5th, AC-6, correctly still passed — it tests a mechanism this fix does
  not touch). Restored → 5/5 green.
- orb-widget.js fix reverted → 2 of 4 new tests failed (AC-2/AC-3 correctly
  still passed — they test invariants this fix does not touch). Restored →
  4/4 green.
- `_audioEverHeardThisOpen` gate reverted to `greetingComplete`-only → the
  AC-7 gate-expression test failed, the other 3 in that describe block
  correctly still passed. Restored → 4/4 green.
- `_hide()`'s reset of the new flag removed → the AC-7 "IS reset by _hide()"
  test failed, the other 3 correctly still passed. Restored → 4/4 green.

TEST: mutation runs recorded in `commands.log` (revert → confirm expected
subset fails → restore → confirm green, for each fix independently).

AC-9 — no regression to the full orb + frontend widget suites, or to the
whole gateway suite

TEST: `npx jest test/orb test/frontend` — 199/199 suites, 3481/3487 tests
passing (6 pre-existing todo), 0 failures.
Output: `outputs/full-regression.txt`

TEST: `npx jest` (entire gateway suite) — full suite re-run after the Codex
fix, 0 failures (see `outputs/full-suite.txt`).
Output: `outputs/full-suite.txt`

AC-10 — type-checks clean

TEST: `npx tsc --noEmit` — no output, exit 0.
Output: `outputs/tsc.txt` (empty — clean)

---

## What this does NOT fix, and what could NOT be verified from this session

**The "frozen mic button / unresponsive X close button" symptom has no
separate, distinct code-level defect found.** `_toggleMute()` and `_hide()`
were read in full: both are pure client-side state toggles/synchronous
teardown paths that do not check connection state and are not gated by
`_isReconnecting`; there is no `pointer-events:none` or disabled state
applied to the controls during any orb state, including `'connecting'`.
The strong, evidence-adjacent hypothesis is that this was the PERCEIVED
consequence of the same underlying defect chain fixed above: while the
widget cycled through failed guided-topic sessions every ~2–9 seconds
(nova_validation blocking repeatedly, each retry showing the now-fixed
false "reconnecting" flash), the screen kept changing out from under the
user's taps, making a technically-responsive mic/close button feel
unresponsive. This is a plausible correlation, not a confirmed second root
cause — flagged explicitly rather than silently declared fixed. If the
mic/close buttons are still unresponsive after this ships AND the retry
storm has stopped, it needs its own fresh reproduction with more detail
(does the button's icon/color visibly change on tap, any console errors).

**Full live-browser visual/interactive verification (screenshot the
buttons, click them, observe the DOM) could not be performed from this
session.** Headless Chromium cannot complete a TLS handshake through this
session's egress proxy at all — confirmed via extensive diagnosis
(`--log-net-log`, `--enable-logging=stderr`, and systematically testing
`--ignore-certificate-errors`, `--disable-http2`, `--disable-quic`,
`--no-sandbox`, and disabling ECH/post-quantum-Kyber/TLS-extension-
permutation, singly and combined — none change the outcome:
`net::ERR_CONNECTION_RESET`, BoringSSL `SSL error code 1`, 100%
reproducible against `https://example.com` itself, not just staging).
`curl`, `openssl s_client`, and Node's `ws` package with an explicit
proxy agent all succeed through the IDENTICAL proxy against the IDENTICAL
hosts — isolating the failure to Chromium's own TLS stack specifically.
This is an environment limitation of this remote session, not a shortcut
taken.

**A live ORB voice session (guided-topic tap or otherwise) was deliberately
NOT opened as the test account for verification, on governance grounds.**
This session's own prior work (VTID-03716,
`scripts/tts/verify-cascade-audio-timing.ts`'s own header comment) already
establishes that opening a live ORB voice session "creates session state
and can trigger memory extraction, which is exactly the write CLAUDE.md's
absolute test-account rule forbids regardless of who/what opens it." That
precedent stands without exception here, via Playwright OR a raw WebSocket
client. Read-only queries against `oasis_events` for the reporting user's
own already-existing live sessions were the only live-evidence source used
throughout this investigation.

**Net effect:** both confirmed root causes are fixed and mutation-tested at
the code level, with a clean full regression suite. Genuine end-to-end
acoustic/visual/interactive confirmation on a live rendered browser session
needs either the platform owner's own device or a designated safe test
environment — neither available from this session. This is stated
explicitly rather than asserted as done.
