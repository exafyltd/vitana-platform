---
lane: native-tenant-isolation-tests
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - apps/mobile/tests/mt-native-health/tenant-resolution.test.tsx
  - apps/mobile/tests/mt-native-health/deep-link-nonmember.test.tsx
  - apps/mobile/tests/mt-native-health/push-identity.test.ts
updated: 2026-11-01T15:37Z
repos: [exafyltd/vitana-v1]
---
# Native tenancy contract tests — mt-native-health-r2/native-tenant-isolation-tests (repo vitana-v1)

Plan: `.kiro/specs/mt-native-health-r2/plan.md` (authoritative) and the `native-tenant-isolation-tests` group of
`tasks.md` (tasks N1–N3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

This lane verifies the N1 tenancy invariant on the EXISTING Expo/React Native app in vitana-v1 `apps/mobile/`
(NOT the Capacitor shell the program plan assumed — drift corrected in the spec). It adds TESTS ONLY against the
existing tenant layer (`src/identity/TenantProvider.tsx`), deep-link routing (`src/linking/resolve-link.ts`) and
push registration (`src/push/registration.ts`) using the existing fake-gateway/fixture harness (`tests/helpers/`),
fixture tenants T_A/T_B. No app source changes, no production calls. If a test reveals a real source gap, log it and
set park the lane (`next_actor: owner`) — do not expand scope into app source.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane's file, no merge/approve/deploy/workflow dispatch, no Supabase or AWS writes, never call a live system from a
test. Add `docs/validation/<vtid>/plan-sparring.md` (copy), `scope.json`, `staging-tests.json` under vitana-v1.

Branch `kiro/mt-native-health-r2/native-tenant-isolation-tests`; PR title
`VTID-xxxxx (mt-native-health-r2/native-tenant-isolation-tests): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-native-health-r2/native-tenant-isolation-tests`. When the
PR is open: set `state: in-review`, `next_actor: kiro` (reviewer seat `hotmail`), `pr: <url>`, append a log entry,
release the claim.

## Log
### 2026-11-01T15:37Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-native-health/native-tenant-isolation-tests`. Versions day-shifted to `20261102130*`. Executor and reviewer follow today's §3a/§7 rules.
