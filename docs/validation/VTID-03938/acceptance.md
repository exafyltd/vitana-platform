# VTID-03938 — Fix expired tenant invitations permanently blocking re-invite

## Context

This is Rung 1 of a 5-rung staged trust-building exercise for the
Operator/autopilot execution plane, executed directly by this Claude Code
session per explicit platform-owner instruction (this session has no
exafy_admin credentials to invoke the real `autopilot_execute_task`
on-ramp, so it proxies the task itself; this validates the task design and
CI gates, not the autonomous Operator agent specifically).

## Bug

`fetchExistingPendingInvitation()`
(`services/gateway/src/services/tenant-invitations/tenant-invitations-repository.ts`)
checked only `accepted_at IS NULL AND revoked_at IS NULL` — never
`expires_at`. Invitations expire after 7 days (per the accept route's own
expiry check), but nothing in the codebase auto-revokes an expired
invitation. Once expired-but-unrevoked, `POST
/api/v1/admin/tenants/:tenantId/invitations` returned `409 ALREADY_INVITED`
for that email/tenant pair forever — the only workaround was an admin
manually calling `/:id/revoke` first.

## Fix

Added `.gt('expires_at', new Date().toISOString())` to the duplicate-check
query, so an expired-but-unrevoked row no longer counts as "pending."
One line, one file. No other invitation logic touched.

## Acceptance Criteria

AC-1 — An invitation whose `expires_at` is in the past no longer triggers
`409 ALREADY_INVITED` when the same email is re-invited to the same tenant.

TEST: `services/gateway/test/routes/tenant-admin/invitations.test.ts` —
"POST / allows re-inviting once the previous invitation has expired
(VTID-03938)" (new). Asserts both the `201` outcome AND that the query
itself calls `chain.gt('expires_at', expect.any(String))` — the mock
resolves purely from queued values regardless of which filters were
applied, so asserting the outcome alone wouldn't distinguish "filtered
correctly" from "filter never added." This is the assertion that actually
pins the fix.

AC-2 — No regression to the existing 409 behavior when a genuinely pending
(non-expired) invitation exists.

TEST: same file, "POST / returns 409 when a pending invitation already
exists" (pre-existing, unmodified, still passing).

AC-3 — No regression to any other invitation route (list, revoke, accept,
tenant isolation).

TEST: same file, all 19 tests passing (18 pre-existing + 1 new).

## Verification

- `tsc --noEmit`: clean (`outputs/tsc-noemit.txt`).
- New/changed-file suite: `outputs/jest-new-suite.txt` — 19/19 passing
  (18 pre-existing + 1 new regression test).
- Full gateway suite (regression check): `outputs/jest-full-suite.txt` —
  906/907 suites (1 pre-existing skip), 14,983/15,018 tests passing (+1
  from the new test), 0 failures.

## Test infrastructure note

The test file's mock Supabase query-builder chain (`createChain()`) did
not implement `.gt()` — every existing test exercising this code path
would have thrown `TypeError: chain.gt is not a function` once the real
code started calling it. Added `gt: jest.fn(() => chain)` alongside the
chain's existing `eq`/`gte`/`is`/`not` mocks, matching the exact pattern
already used for every other query-builder method. This is test
infrastructure, not product code — no behavior change.

## What this does NOT do

- Does not touch the `POST /accept/:token` expiry check (`expires_at <
  now` → 410) — that logic is correct and untouched.
- Does not add auto-revocation of expired invitations — this fix only
  stops an expired invitation from blocking a NEW one; the old row still
  exists with `revoked_at IS NULL`, just no longer matches the duplicate
  check.
- Does not touch the `POST /` invitation email TODO (a separate, larger,
  explicitly-out-of-scope gap noted during investigation).

## OASIS impact

OASIS_IMPACT: no — a query-filter bug fix, no schema/event changes.
