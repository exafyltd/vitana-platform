# Requirements — staging-coverage-6028392a
## R1 — The #4539 change is recorded, not changed
`live.ts` is not modified. The behaviour of `6028392a` (go-live notifications only when the session is actually
running: session create not `scheduled`, or host start via `/enter` after `startForHost` succeeds) is what the tests pin.
## R2 — A CI test proves the behaviour
A new gateway jest test covers: scheduled session create sends no go-live notification; a live/lobby session create
notifies followers and subscribers; a successful host start via `/enter` notifies them; a refused host start and a
viewer entry send none; the host is never notified of their own room going live. Cases 1 and 3 fail on `6028392a^1`.
## R3 — A CI VTID for the change
The lane's VTID comes from CI PLAN-SPAR after policy approval (`converged-auto-v1`), never by hand.
## R4 — Read-only staging suite
`docs/validation/<VTID>/staging-tests.json` for service `gateway`: `/alive`, `GET /api/v1/live/health`, a
`rejected_probe` POST to `/api/v1/live/rooms/<uuid>/enter` expecting 401, and an `existing` jest entry running the
new test plus `test/vtid-04905-live-enter-exit.test.ts`. No write, no production target (rule 48).
## R5 — Commit coverage for 6028392a
One `docs/validation/commit-coverage.json` `covers[]` entry for `6028392a12f3449a51cea7b77fe2fb64f4aaee92` naming the
VTID, why its suite covers the change, and the approval (the converged sparring record).
## R6 — Verified on staging
The next gateway STAGING-VERIFY whose range contains `6028392a` lists it as covered and passes.
