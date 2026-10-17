---
lane: push-tenant-fanout
state: ready
next_actor: owner
depends_on: [switch-tenant-rpc-db]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/routes/notifications.ts
  - services/gateway/src/routes/notifications-repository.ts
  - services/gateway/src/services/notification-service.ts
  - services/gateway/src/services/notification-service-repository.ts
  - services/gateway/test/services/mt-native-health-push-fanout.test.ts
updated: 2026-10-17T11:48Z
---
# Per-tenant push fan-out — fetch device tokens by user_id — mt-native-health (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (push-tenant-fanout) and `tasks.md`. Design: `design.md`.

HELD until PLAN-SPAR allocates this lane's VTID. Depends on `switch-tenant-rpc-db` for the `transport` column it
honours. Dark behind `tenant_settings.feature_flags.mt.native_push_tenant_fanout` — deploying the code changes nothing
until the flag is on. Expand/contract: `user_device_tokens.tenant_id` stays (no longer load-bearing for delivery);
delivery fetches by `user_id`, copy/deep-link come from the notification row's tenant.

§7a: no VTID allocation, no `_plan` claim, no merge/approve/deploy, no live writes, no sign-in probe or push against
production (the `ab_dual` dual-member contract test runs against the fake Supabase client / local stack only). Work only
inside the allowed paths. This lane adds its own `docs/validation/<vtid>/` (plan-sparring copy, scope.json,
staging-tests.json) — not in `paths`. Required suites when touched: `npm run test:support` (42c); Maxina golden push
copy unchanged.

PR title `VTID-xxxxx (mt-native-health/push-tenant-fanout): …`; trailers `Collab-Session: <id>`,
`Collab-Lane: mt-native-health/push-tenant-fanout`.

## Log
### 2026-10-17T11:48Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created (held). Stop writing `tenant_id` on token upsert (notifications.ts:108-110); drop the `tenant_id` filter
from `fetchLiveDeviceTokensForUser`/`sendPushToUser`; derive per-tenant copy + deep link from the notification row.
