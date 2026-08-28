# VTID-03794 — ORB voice on device-preview: disconnect + lost-continuity reconnect

Reported live: "it was disconnecting for whatever reason" on staging's
`/admin/device-preview`. Investigated with a real client-level browser
WebSocket hook (Playwright, `context.addInitScript`) against
`preview-aws.vitanaland.com` — not inferred from server logs — plus direct
`oasis_events` queries against the live Supabase project.

## What was found

Two independent, real defects. Neither is the previously-fixed dual-iframe
session-collision bug (`terminateExistingSessionsForUser`,
`superseded_by_new_session`) — there was no session overlap in any trace.

1. **Real ~58-60s disconnect, reproducible, not iframe-specific.** A plain
   top-level tab (no device-preview, no iframe) hit `code=1005,
   wasClean=true` on its ORB WebSocket three times in a row, each almost
   exactly 58-60s after connecting — the classic signature of a load
   balancer idle timeout (no WS close frame sent, just the TCP connection
   dropped). AWS ALB's *default* idle timeout is exactly 60s. The server's
   own 30s keepalive ping (`VTID-STREAM-KEEPALIVE`, `orb-live.ts`) was
   still labelled for the GCP Cloud Run era in its comment and evidently
   isn't providing enough margin against a 60s cutoff with only one ping
   in between.
2. **A reconnect after such a disconnect lost all conversation
   continuity**, confirmed via `oasis_events`: a real 112-second, 4-turn
   staging conversation (`live-c83bb562-...`) disconnected
   (`client_disconnect` / `ws_session_cleanup`) during a quiet moment
   between turns, and the very next session
   (`live-db65374d-...`, started 353ms later) opened with
   `wake_opener:"safe_fast_newday_overview"` — a first-open "new day"
   greeting — instead of the existing VTID-02020 contextual recovery
   prompt ("I'm back, what were we talking about?").

Root cause of (2), traced to `live-session-controller.ts`'s
`isReconnectStart` formula: `orb-widget.js` only ever attaches
`reconnect_stage` to a session-start payload when `_announceDisconnect()`
has actually run (a genuine first-time open never sends the field) — so
the field's mere *presence* is reliable reconnect evidence. But the
formula computed `reconnectStage` (defaulting field-absent and
field-explicitly-`'idle'` to the identical `'idle'` string) and then
checked `reconnectStage !== 'idle'` — collapsing "this is a reconnect that
happens to have nothing in flight" (a common, legitimate case — the
disconnect landed between turns) into the exact same signal as "this is a
first-time open." Whenever `transcript_history` also happened to be empty
for that specific request, `isReconnectStart` came out false and the
session was treated as brand new.

## AC-1 — WS keepalive ping tightened + re-documented for AWS

`orb-live.ts`'s `clientPingInterval` changed from 30s to 10s, and its
comment updated from "Cloud Run ALB" (GCP is decommissioned) to the real
`vitana-alb-prod` AWS ALB and the measured 58-60s reproduction. A 30s
interval gives at most one ping inside a 60s window before the timer
expires; 10s gives real margin regardless of what turns out to actually be
counted as "activity" by whichever proxy sits in front.

No test pins the literal interval value (none existed pinning the old 30s
either) — this is a tuning change to an existing, already-tested keepalive
mechanism, not new logic.

## AC-2 — reconnect during silence no longer collapses into a first-time open

`isReconnectStart` now also treats `typeof body.reconnect_stage ===
'string'` (the field's mere presence) as reconnect evidence, independent
of the value it normalizes to.

TEST: `services/gateway/test/orb/live/session/live-session-controller.test.ts`
— 2 new tests, mutation-verified (reverting the fix makes the first fail,
confirmed by hand before committing):
- `marks reconnect session with resumedFromHistory when reconnect_stage is
  explicitly "idle" and transcript_history is empty` (the exact live
  defect)
- `does NOT mark a brand-new session (no reconnect_stage field at all) as
  resumedFromHistory` (guards against overcorrecting — a genuine first
  open must never be misread as a reconnect)

Full suite re-run after both changes: `test/orb/` — 197/197 suites, 3536
passing (6 pre-existing todo), 0 failures. `tsc --noEmit` clean.

## Not yet done, and why

- **The ALB idle-timeout hypothesis itself is not confirmed against the
  live ALB attribute** — this session has no AWS CLI access. AC-1 is a
  safe, justified mitigation regardless of the exact cause (a load
  balancer of some kind is dropping idle WS connections around 58-60s,
  confirmed by direct client-side observation); raising
  `idle_timeout.timeout_seconds` on `vitana-alb-prod` is a separate,
  infra-side action handed off to whoever has AWS access, not part of this
  PR.
- **Device-preview's iframe specifically was not re-tested end-to-end**
  after this fix — the admin route sits behind a separate admin login the
  documented community test account cannot pass. The disconnect and the
  continuity bug both reproduce identically on a plain tab hitting the
  same `orb-live.ts` WS code path device-preview's iframe also hits, so
  the fix applies equally; a live device-preview retest is still the
  ideal final confirmation once someone with admin access can run it.
