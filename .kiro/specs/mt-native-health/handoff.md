---
slug: mt-native-health
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-10-17T11:52Z
---
# mt-native-health — WS9 native tenancy delta + WS10 health-×-tenancy contract

Multi-tenant program spec 13 of 14 (MULTI-TENANT-PLAN §6, WS9 + WS10). It plans ONLY the tenancy delta on top of the
already-approved `health-native` spec (VTID-05020/05021): the native active-tenant switch and picker/join, per-tenant
push fan-out, reserved slugs, the per-device transport one-owner flag, the frozen health home tenant + `healthDb`
accessor, the OTA compatibility gate, and the D18 lineage guard + ORB health/commerce dispatcher rule. The native shell,
screen ports, builds and Health Hub phases themselves stay in `health-native` and are not re-planned here.

Authored by Kiro seat hotmail (session kiro-hotmail-202610151618-b437). Pushed as `plan(mt-native-health)` for PLAN-SPAR
to spar via CI; VTIDs are allocated by PLAN-SPAR on convergence (none allocated by this planner). Lanes are HELD
(`next_actor: owner`) until PLAN-SPAR allocates each lane's VTID and flips it to `kiro`; the governance lane is
`executor: claude`, `next_actor: claude`.

## Lanes
- `native-tenant-switch` (vitana-v1, seat exafy) — client switch + picker/join + universal-link routing.
- `switch-tenant-rpc-db` (vitana-platform DB, seat hotmail) — `switch_active_tenant` RPC, reserved slugs, transport flag.
- `push-tenant-fanout` (vitana-platform gateway, seat jtadic) — per-tenant push fan-out, fetch tokens by user_id.
- `health-home-tenant-db` (vitana-platform DB, seat hotmail) — `app_users.health_home_tenant_id` + backfill + set-once.
- `health-db-accessor` (vitana-platform gateway, seat jtadic) — `healthDb(userId)` + TENANT_TABLES exclusion + conversions.
- `ota-compat-gate` (vitana-v1, seat exafy) — OTA `min_native_version` compatibility gate.
- `lineage-guard-health` (vitana-platform governance, executor claude) — D18 analytics guard + ORB dispatcher rule.

## Log
### 2026-10-17T11:48Z · kiro-hotmail-202610151618-b437 · created → drafted
Spec created and pushed push-first per BATCH-BRIEF. Premises re-verified in current code (notifications.ts:108-110,
notifications-repository.ts:29-52, notification-service-repository.ts:38-42, notification-service.ts:380-411;
switch_active_tenant / health_home_tenant_id / healthDb / TENANT_TABLES absent; apps/mobile TenantProvider +
+native-intent.tsx + maxina/alkalma portals present). CROSS-SPEC O1 applied (references mt-identity's `isHealthTable()`,
governance lane executor claude). Queue validators run on handoff.md + lanes/*.md with 0 errors before push.

### 2026-10-17T11:52Z · kiro-hotmail-202610151618-b437 · (internal review) → drafted
Internal adversarial review returned REJECTED (0 HIGH, 2 MEDIUM, 3 NIT). Addressed:
- MEDIUM-1/MEDIUM-2 (dependency completeness/consistency across the old lane split): resolved structurally by the
  7-lane restructure. The governance lane (`lineage-guard-health`) now wires only the D18 lineage guard + ORB
  dispatcher rule and depends on `health-db-accessor` (its producer); the OTA gate and transport one-owner checks live
  in their own lanes' CI (`ota-compat-gate` vitest, `switch-tenant-rpc-db` pgTAP), so no central lane wires a
  non-existent harness. `push-tenant-fanout` depends on `switch-tenant-rpc-db` for the `transport` column (one hard
  dep, stated once); `plan.md` "Depends on" lists specs only, so no two-ways inconsistency remains.
- NIT-1: requirements.md now cites the `health-native` spec folder plus the two program plans + validation dirs.
- NIT-2: design.md states `healthDb` is injected at the repository layer only; calling routes/services unchanged.
- NIT-3: design.md names the preference store — `auth.users.raw_app_meta_data->'active_tenant_id'`, reusing
  `switch_to_tenant_by_slug`'s store (verified in `supabase/tests/vtid_05147_fixture.sql:537-540`).
Removed 5 stale lane files from the interrupted earlier run. Re-ran validators: 0 errors. Re-pushed; deleted
INTERNAL-REVIEW.json.
