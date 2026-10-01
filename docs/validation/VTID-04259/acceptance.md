# VTID-04259 — Command Hub session timeout extended to every Command Hub role

## Report

Reported live: the ~3 real people who use the Gateway Command Hub (on both
`preview-aws-gateway.vitanaland.com` and the production Command Hub) were
being logged out every ~10-20 minutes instead of staying logged in for a
full workday as intended.

Root cause, found by reading the code rather than guessing: a 24-hour(*)
idle-logout + silent-refresh mechanism already existed
(`BOOTSTRAP-DEV-6H-SESSION`, `services/gateway/src/frontend/command-hub/app.js`),
but was gated on `active_role === 'developer'` EXACTLY, at 6 hours. Command
Hub access itself is granted to a wider role set — developer/admin/infra/staff
(see the "Access control" block in `app.js`'s boot sequence, `allowedRoles`).
Anyone whose resolved `active_role` landed on `admin`/`infra`/`staff` instead
of the literal string `'developer'` fell straight through to the OLD strict
"log out the instant the raw Supabase JWT `exp` passes, no refresh attempt"
path (`isDeveloperSession()`'s `else` branch) — at whatever the Supabase
project's JWT lifetime is, which is not controlled by this repo and is often
well under an hour. That is the actual mechanism behind the reported
repeated logouts.

(*) corrected from a prior "6 hours" description once the code was actually
read — see AC-1.

## Acceptance Criteria

AC-1 — The idle-logout window used for Command Hub roles is 24 hours (a full
workday), not the previous 6 hours.
TEST: services/gateway/test/vtid-04259-session-timeout.test.ts — "the idle-logout window is 24 hours (a full day), not the old 6 hours".

AC-2 — The 401-retry / silent-refresh path in the global fetch interceptor
applies to every Command Hub role (developer, admin, infra, staff), not only
the literal string `'developer'`.
TEST: services/gateway/test/vtid-04259-session-timeout.test.ts — "the fetch interceptor no longer short-circuits on a literal active_role !== 'developer' check".

AC-3 — The idle-logout session monitor (`isDeveloperSession()`) applies the
same widened role check as AC-2, sharing one role list rather than
duplicating/drifting from it.
TEST: services/gateway/test/vtid-04259-session-timeout.test.ts — "the idle-logout monitor (isDeveloperSession) checks role membership, not exact equality to 'developer'" and "defines a shared EXTENDED_SESSION_ROLES list covering every Command Hub role".

AC-4 — A Supabase refresh-token rotation race between two Command Hub tabs
open at once (routine for the ~3 real operators, who commonly keep several
tabs open) no longer produces a spurious logout in the losing tab — the
losing tab picks up the winning tab's freshly rotated tokens from
`localStorage` instead of retrying with a token it already knows is stale.
TEST: services/gateway/test/vtid-04259-session-timeout.test.ts — "handles a cross-tab refresh-token rotation by picking up another tab's written tokens".

AC-5 — No behavior change for roles the Command Hub does not admit
(community, professional, patient) — those still hit the strict "logout on
JWT exp" path exactly as before; this PR only widens the extended-session
role set, it does not remove the fallback branch.
TEST: services/gateway full jest suite in CI (`npm test`) — `services/gateway/test/command-hub/` (17 suites / 259 tests) and the full suite stay green; no test asserting community/professional/patient auth behavior was changed by this diff.

AC-6 — The Command Hub's own cache-bust marker is bumped so the changed
`app.js` is actually served, per CLAUDE.md §16 IF-THEN 25.
TEST: services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts — "the Command Hub cache-buster on index.html was bumped for this change" (also re-asserted in the new VTID-04259 test file).
