---
lane: native-push-tenant
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/notification-service-repository.ts
  - services/gateway/src/services/notification-service.ts
  - services/gateway/src/services/push-routing.ts
  - services/gateway/test/mt-native-health/native-push-tenant.test.ts
updated: 2026-11-01T15:37Z
repos: [exafyltd/vitana-platform]
---
# Per-tenant native push — mt-native-health-r2/native-push-tenant (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health-r2/plan.md` (authoritative) and the `native-push-tenant` group of `tasks.md`
(tasks P1–P4, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Builds on VTID-05177 (native token fields + `NATIVE_PUSH_DIRECT_ENABLED`, already on main). The delivery filter is
`fetchLiveDeviceTokensForUser(sb, userId, tenantId)` at `notification-service-repository.ts:28`, which filters by
`.eq('user_id')` (`:40`) AND `.eq('tenant_id')` (`:41`) and is SHARED by the legacy and native push paths
(`notification-service.ts:951`, `push-routing.ts:177`). **Do NOT modify that function** — add a NEW variant
`fetchLiveDeviceTokensForUserAcrossTenants(sb, userId, opts?)` that omits the tenant filter, called ONLY on the
native `tokenClass` pass when `MT_RESOLUTION_V2` is on; each push's copy/deep-link come from the notification row's
`tenant_id` (already a `dispatchPush` parameter, `push-routing.ts:95`). Keep the one-active-transport-per-device
invariant. Dark behind `NATIVE_PUSH_DIRECT_ENABLED` (native) and `MT_RESOLUTION_V2` (across-tenant fetch).

The allowed paths list the notification repositories touched; keep the existing `fetchLiveDeviceTokensForUser`
unchanged. Do not widen beyond the notification code + the one new test.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane's file, no merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Add
`docs/validation/<vtid>/plan-sparring.md` (copy), `scope.json`, `staging-tests.json`.

Branch `kiro/mt-native-health-r2/native-push-tenant`; PR title `VTID-xxxxx (mt-native-health-r2/native-push-tenant): …`;
commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane: mt-native-health-r2/native-push-tenant`.
When the PR is open: set `state: in-review`, `next_actor: kiro` (reviewer seat `hotmail`), `pr: <url>`, append a log
entry, release the claim.

## Log
### 2026-11-01T15:37Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-native-health/native-push-tenant`. Versions day-shifted to `20261102130*`. Executor and reviewer follow today's §3a/§7 rules.
