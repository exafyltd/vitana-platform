# VTID-04689 — a read-only E2E run never saves the shared test account's role

## Problem

Every E2E project signs in as the same account (`e2e-test@vitana.dev`, an exafy
admin). When the Command Hub boots for a user whose saved role it does not
allow, it saves `developer` on the server (`app.js` `setActiveRole(bestRole)`).
So under `E2E_READONLY=1` the suite still made one production write — and it
flipped the role the community projects rely on:

- `role_preferences` for the test account → `developer` at 2026-09-28
  11:16:36 UTC, 4 s into read-only run 36414594812.
- Run 36418982908 on staging @ 19a1080 then failed
  `Desktop — Role Guard › community user blocked from admin route /admin/system`
  (twice, 15 s poll timeout) and `/admin/dashboard` was flaky: the "community"
  page was a developer page, correctly allowed into /admin.

## Acceptance

AC-1: with `E2E_READONLY=1`, every spec and the smoke helper take `test` from
`fixtures/readonly-test.ts`, whose auto fixture blocks the two role-saving
calls (gateway `POST /api/v1/me/active-role`, Supabase RPC
`set_role_preference` / `me_set_active_role`).
  TEST: docs/validation/VTID-04689/outputs/guard.spec.ts › with the guard: role saves blocked, reads and other writes pass
AC-2: control — without the guard every one of the same requests reaches the
stub, so the guard alone makes the difference (not the sandbox network).
  TEST: docs/validation/VTID-04689/outputs/guard.spec.ts › without the guard (control): every request reaches the stub
AC-3: reads and unrelated writes pass (GET active-role, GET me/context, RPC
get_my_permitted_roles).
  TEST: docs/validation/VTID-04689/outputs/guard.spec.ts › with the guard: role saves blocked, reads and other writes pass
AC-4: the suite still loads in full: `playwright test --list` → 1011 tests in 17 files.
  TEST: e2e/playwright.config.ts (list run in commands.log)
AC-5: the next full read-only run on staging leaves the account's
`role_preferences.updated_at` unchanged and the role-guard tests pass.
  UI: E2E-TEST-RUN.yml read_only=true after merge

OASIS_IMPACT: none — test suite only; no gateway code, route, event or schema change.
