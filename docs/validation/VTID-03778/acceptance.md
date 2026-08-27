# VTID-03778 — Fix ORB overlay frozen on server-initiated `session_ended`

## Report (verbatim)

> No looping, but now again "general" Vitana continues with: let's continue
> where we left off. And you cannot close it, Orb overlay remains with
> Listening subtitle under it, and the close button doesn't work, I need to
> refresh to exit

## Context

This report followed a successful retest of VTID-03776 (the reconnect-loop
fix): the loop was confirmed gone. The "let's continue where we left off"
line is VTID-03776's OWN circuit breaker working exactly as designed —
after nova_validation kept blocking the guided-topic opener, it correctly
dropped the topic and fell through to safe generic conversation. That part
is not a regression; it is documented, intended fallback behavior (the
underlying nova_validation block on that specific topic content is a
separate, still-open, unroot-caused issue — see VTID-03776's own
"Deliberately NOT attempted" section).

The NEW defect is the second half of the report: the overlay froze on a
stale "Listening" caption and the close (X) button had no effect,
requiring a page refresh to exit.

## Investigation — live evidence across both repos

Queried `oasis_events` for `orb.live.diag` in the report window
(`inmkhvwdcuyhnxkgfvsb`, staging). Found:

- Session `live-0df64f19-...` opened normally, spoke the fallback line
  (`greeting_sent`, `prompt_len:655`), completed a turn, and entered
  LISTENING — `audio_forwarding` events confirm real mic audio was being
  forwarded (`audio_in` incrementing) for ~10+ seconds. This session was
  healthy, not stuck.
- ~57 seconds after it opened, it was closed with
  `stage:"upstream_closed", reason:"superseded_by_new_session"`.
- A new session `live-029a7c08-...` started essentially simultaneously and
  immediately failed: `code:"nova_validation"`,
  `diagnostic:"...All contents must be closed before ending prompt"` — a
  Nova/Bedrock protocol-sequencing error, distinct from the usual
  content-filter block, most likely caused by the old session's upstream
  stream not being fully torn down before the new one's stream opened.

Read `terminateExistingSessionsForUser()`
(`services/gateway/src/routes/orb-live.ts`) — the mechanism that produces
`reason:"superseded_by_new_session"`. It is the **only** live emitter of a
`session_ended` message that reaches a client whose handlers are still
attached and listening. The other two emitters
(`POST /session/stop` in both `orb-live.ts` and
`live-session-controller.ts`) are both **echoes of a stop the client
itself already initiated** — by the time either fires, the client's own
`_sessionStop()` has already detached its SSE/WS handlers (its own code
comment says so explicitly), so in practice neither ever reaches a live
`case 'session_ended':` handler.

Read `orb-widget.js`'s `case 'session_ended':` handler
(`_handleMessage()`): it called `_sessionStop()` unconditionally. Reading
`_sessionStop()` in full surfaced two compounding defects:

1. It sets `_s._userInitiatedStop = true` at its very top,
   **unconditionally** — mislabeling a SERVER-forced close as a user
   action. That flag is read by roughly a dozen guard checks throughout
   the file to suppress reconnect attempts ("the user is deliberately
   leaving, don't reconnect"). Once falsely set, nothing in the file has a
   path left to un-set it short of a fresh `_sessionStart()` (which clears
   it at its own top) — but nothing was calling that either, since the
   overlay was never told to close.
2. `_sessionStop()` tears down session internals (mic, audio contexts, WS)
   but **never touches overlay visibility or the status caption** — unlike
   `_hide()`, which does both. So the overlay was left showing whatever
   caption was last set ("Listening...") with nothing running behind it,
   forever.

The very next case block in the same dispatcher
(`connection_issue`/`live_api_disconnected`) already carries the exact
lesson this defect violates, in its own pre-existing comment: *"We never
auto-`_sessionStop` here; killing the orb forces a page refresh."*
`session_ended` was the one case that still did exactly that.

## Fix

`case 'session_ended':` now calls `_hide()` instead of `_sessionStop()` —
the same full, honest teardown a real user-initiated close uses (stops
audio synchronously, closes the session, and — critically — actually
hides the overlay). `_hide()` does not require or check any prior "was
this user-initiated" flag, so it is safe to call from this
server-triggered path. Reopening the ORB is one tap away; freezing behind
a stale caption is not recoverable without a refresh.

`_sessionStop()` itself is intentionally left unchanged — the fix works by
avoiding that call site for this one case, not by changing
`_sessionStop()`'s own (still correct for its many genuine
user-initiated-stop callers) behavior.

## Acceptance Criteria

AC-1 — The `session_ended` case block no longer calls the old, bare
`_sessionStop()`.

TEST: `orb-widget-session-ended-overlay-close.test.ts` — "does not call
the old, unconditional _sessionStop() handler"

AC-2 — The `session_ended` case block calls `_hide()`.

TEST: same file — "calls _hide() — the same full, honest teardown a real
close uses"

AC-3 — The fix is scoped: the case block contains exactly one `_hide()`
call and no other new logic.

TEST: same file — "is a scoped fix — the case block itself contains
exactly one _hide() call, no other logic added"

AC-4 — `_sessionStop()` itself is confirmed unchanged (still sets
`_userInitiatedStop = true` at its top) — the fix works by avoiding this
call site, not by patching it.

TEST: same file — "_sessionStop() still sets _userInitiatedStop = true at
its top"

AC-5 — `_hide()` is confirmed safe to call from a server-driven event: it
does not gate on any prior user-gesture flag, and it does flip
`overlayVisible` false.

TEST: same file — "_hide() itself is safe to call from a server-driven
event: it does not require a prior user gesture"

AC-6 — `node --check` is clean.

TEST: `outputs/node-check.txt` — exit 0.

AC-7 — `tsc --noEmit` is clean.

TEST: `outputs/tsc-noemit.txt` — exit 0.

AC-8 — The full gateway suite is green.

TEST: `outputs/jest-full-suite.txt` — 716/716 suites (1 pre-existing
skip), 13481/13516 tests passing, 0 failures. (An earlier run in the same
session showed one unrelated flake — a 60-second timing-sensitive
`worker-orchestrator await-autopilot-execution` test, nothing to do with
this diff — that passed cleanly on re-run; see `commands.log`.)

AC-9 — The fix is mutation-verified.

TEST: `commands.log` — reverting the `_hide()` call back to `_sessionStop()`
fails exactly the 3 tests that assert the new behavior; the 2 tests
asserting unrelated background context stay green; restore confirmed
clean via `diff`.

## Deliberately NOT attempted

- **`_sessionStop()`'s own `_userInitiatedStop = true` assignment was not
  made conditional.** It remains correct for every one of its many genuine
  user-initiated callers (`_hide()`, `destroy()`, the background/idle
  watchdog, etc.). Parameterizing it was considered and rejected in favor
  of the smaller, more surgical fix: route the one genuinely
  server-initiated case around it entirely via `_hide()`, which already
  does everything needed without depending on that flag's truthfulness.
- **The underlying Nova protocol error on the RESULTING new session**
  (`"All contents must be closed before ending prompt"`) is not fixed
  here. It is a distinct, real, only-partially-understood issue (a
  content-filter block, not a sequencing error, is the well-documented
  failure mode elsewhere in this codebase) that would need its own
  dedicated investigation with more live traffic samples than this one
  incident provides. This VTID fixes the CLIENT-side consequence (a
  frozen, unrecoverable overlay) regardless of why the superseding session
  itself failed — the overlay now closes cleanly either way.
- **Not confirmed against live traffic.** Same standing caveat as every
  VTID in this chain: this session has no live-browser verification path.
  The next real signal is the platform owner's own retest — reach the
  state where a session gets superseded (or simply let a session run long
  enough to be replaced) and confirm the overlay closes on its own instead
  of freezing.
