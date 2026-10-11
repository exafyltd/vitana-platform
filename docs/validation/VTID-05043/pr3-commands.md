# VTID-05043 PR3 — commands and results (services/gateway, 2026-10-10)

```
$ npx jest test/middleware/auth-supabase-jwt.test.ts
Tests: 54 passed, 54 total        (22 new: 11 membership scenarios x requireTenant + requireAuthWithTenant)

$ (mutation: membership result ignored in requireAuthWithTenant) npx jest test/middleware/auth-supabase-jwt.test.ts
Tests: 6 failed, 48 passed, 54 total   (restored afterwards)

$ npx jest test/routes/orb-livekit.test.ts
Tests: 92 passed, 92 total        (fixtures: chain mock gains abortSignal; fixture callers are members of
                                   their token tenant; two "supabase unavailable" cases keep the auth
                                   lookups reachable so they still exercise the route's degraded path)

$ npm run test:roles      -> Tests: 105 passed, 105 total
$ npm run test:support    -> Tests: 87 passed, 87 total (4 suites)
$ npm run test:operator   -> Tests: 38 passed, 38 total

$ npx jest   (full gateway suite)
Test Suites: 7 failed, 1 skipped, 1591 passed, 1598 of 1599 total
Tests:       7 failed, 25 skipped, 6 todo, 25515 passed, 25553 total
  The 7 failures are the local-Postgres SQL harness cases of vtid-04809, 04859, 04868, 04878, 04981,
  04982, 04988 ("applies ... to a local Postgres replica"). They fail identically on the unmodified
  origin/main tree in this container (same 7 tests, 7 failed / 158 passed on those 8 files), i.e.
  environmental, not caused by this change.
  First full run before the orb-livekit fixture fix: 8 suites / 23 tests failed (orb-livekit 16 + the 7 above).

$ npx tsc --noEmit -p . --declaration false --declarationMap false   -> exit 0
  (plain `tsc --noEmit -p .` reports only TS2742 "inferred type cannot be named" in untouched
   repository files, caused by this worktree's node_modules being a symlink to another checkout)
```
