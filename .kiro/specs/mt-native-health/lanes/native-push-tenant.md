---
lane: native-push-tenant
state: ready
next_actor: owner
depends_on: [health-home-tenant-db]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/routes/notifications.ts
  - services/gateway/src/routes/notifications-repository.ts
  - services/gateway/src/services/notification-service-repository.ts
  - services/gateway/test/mt-native-health/native-push-tenant.test.ts
updated: 2026-10-15T16:40Z
---
# Per-tenant native push — mt-native-health/native-push-tenant (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (authoritative) and the `native-push-tenant` group of `tasks.md`
(tasks P1–P4, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates the VTID; it then flips to `kiro`. Start after the VTID
exists AND `health-home-tenant-db` is done (shared resolved-tenant helper; no health coupling otherwise). Runs in
parallel with `native-tenant-isolation-tests`.

Builds on VTID-05177 (native token fields + `NATIVE_PUSH_DIRECT_ENABLED`, already on main). Today `/token` writes
`tenant_id: identity.tenant_id` (`notifications.ts:107-110`) and the one-active-owner index keeps one row per
(user, token); the fix is to fetch tokens by `user_id` only and take each push's tenant from the notification row.
Keep the one-active-transport-per-device invariant. Dark behind `NATIVE_PUSH_DIRECT_ENABLED` (native) and
`MT_RESOLUTION_V2` (per-tenant delivery).

The allowed paths list the current notification repositories; **verify the exact repository file names at
implementation time and narrow the paths to the real ones in the PR** (the delivery filter lives in a
notification-service repository today). Do not widen beyond the notification code + the one new test.

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
PLAN-SPAR allocates the VTID. Depends on `health-home-tenant-db`.
