---
lane: native-push-tenant
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/services/notification-service-repository.ts
  - services/gateway/src/services/notification-service.ts
  - services/gateway/src/services/push-routing.ts
  - services/gateway/test/mt-native-health/native-push-tenant.test.ts
updated: 2026-10-20T09:00Z
---
# Per-tenant native push — mt-native-health/native-push-tenant (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (authoritative) and the `native-push-tenant` group of `tasks.md`
(tasks P1–P4, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates the VTID; it then flips to `kiro`. No in-spec dependency —
runs independently (the earlier dependency on `health-home-tenant-db` was removed as spurious: push derives the
tenant from the notification row, not the frozen health home tenant). Runs in parallel with the other lanes.

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

Branch `kiro/mt-native-health/native-push-tenant`; PR title `VTID-xxxxx (mt-native-health/native-push-tenant): …`;
commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane: mt-native-health/native-push-tenant`.
When the PR is open: set `state: in-review`, `next_actor: kiro` (reviewer seat `hotmail`), `pr: <url>`, append a log
entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Lane drafted by the hotmail Kiro seat (gateway/services work → seat `jtadic`, reviewer `hotmail`). HELD until
PLAN-SPAR allocates the VTID. Independent lane (round-1 F8: removed the spurious `health-home-tenant-db` dependency;
round-1 F2: named `fetchLiveDeviceTokensForUser` + the new across-tenant variant).
### 2026-10-20T09:00Z · kiro-hotmail-202610151618-b437 · ready (answered sparring round 1, session fca982e6)
R1-F1: one notification = one tenant; `notifyUser` (`notification-service.ts:809`) builds one payload and the new
variant only widens which devices it reaches. The fetch lives in `sendPushToUser` (`:410-411`), so
`notification-service.ts` joins the paths for an `acrossTenants` opt. Contract test narrowed (tasks P2/P4).
