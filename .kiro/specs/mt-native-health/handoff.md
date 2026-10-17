---
slug: mt-native-health
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-17T19:36Z
---
# mt-native-health — WS9 native tenancy delta + WS10 health-×-tenancy contract

Multi-tenant program spec 13 of 14 (MULTI-TENANT-PLAN §6, WS9 + WS10). It plans ONLY the tenancy delta on top of the
already-approved `health-native` spec (VTID-05020/05021): the native active-tenant picker/join (reusing the existing `switch_to_tenant_by_slug` RPC, VTID-05043), per-tenant
push fan-out, the per-device transport one-owner flag, the frozen health home tenant + `healthDb`
accessor, the OTA compatibility gate, and the D18 lineage guard + ORB health/commerce dispatcher rule.
Reserved slugs are already shipped and applied (VTID-05150) and are referenced, not rebuilt. The native shell,
screen ports, builds and Health Hub phases themselves stay in `health-native` and are not re-planned here.

Authored by Kiro seat hotmail (session kiro-hotmail-202610151618-b437). Pushed as `plan(mt-native-health)` for PLAN-SPAR
to spar via CI; VTIDs are allocated by PLAN-SPAR on convergence (none allocated by this planner). Lanes are HELD
(`next_actor: owner`) until PLAN-SPAR allocates each lane's VTID and flips it to `kiro`; the governance lane is
`executor: claude`, `next_actor: claude`.

## Lanes
- `native-tenant-switch` (vitana-v1, seat exafy) — client switch + picker/join + universal-link routing.
- `switch-tenant-rpc-db` (vitana-platform DB, seat hotmail) — per-device transport one-owner flag (DB); reuses the existing `switch_to_tenant_by_slug` RPC (VTID-05043), does not rebuild it.
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

### 2026-10-17T13:30Z · kiro-hotmail-202610151618-b437 · (internal review round 2) → drafted
Second internal adversarial review returned REJECTED (3 HIGH, 2 MEDIUM, 1 LOW). All fixed, premises re-verified in
current code:
- HIGH W1 (reserved slugs already shipped/applied by VTID-05150): verified `reserved_tenant_slugs`
  (`20261014000400:129-170`), `provision_tenant` `RESERVED_SLUG` (`20261014000500:124`), `reserved-slugs.ts`,
  `gen-reserved-slugs.mjs`/`TENANT-RESERVED-SLUGS-DRIFT.yml`. Reframed Problem #3 / R3; removed the create-table and
  provision_tenant-guard work from `switch-tenant-rpc-db` and `tasks.md`.
- HIGH W2 (switch RPC already exists): verified `switch_to_tenant_by_slug` (`20261010180200:38-127`) and the native
  client half (`TenantProvider.tsx:112-126` calls it, maps 42501→`not_joinable`, refreshSession, claim-gate, stored
  slug). Corrected Problem #2 / R2; `switch-tenant-rpc-db` re-scoped to the transport flag only (reuse the RPC, extend
  in place only if a real gap appears); `native-tenant-switch` re-scoped to picker/join + `/<slug>` routing.
- HIGH W3 (health-db-accessor paths non-existent): verified real paths — `routes/integrations-repository.ts`,
  `routes/health-repository.ts`, `services/automation-handlers/health-wellness-repository.ts`,
  `services/automation-handlers/health-action-initiative-repository.ts`,
  `services/diary-health-extractor-repository.ts`; accessor placed at `services/gateway/src/services/health-db.ts`
  (no `repositories/` or `services/health/` dir). Lane `paths`, `tasks.md` allowed paths and `design.md` updated;
  `resolveHealthTenantId()` convergence note added (`services/orb-tools/health-depth-tools.ts:118`).
- MEDIUM-4 (cross-repo screens.json seeding): removed from `switch-tenant-rpc-db`; the applied `reserved_tenant_slugs`
  table is the source.
- MEDIUM-5 (backfill tie-break): stated the deterministic rule (is_primary → is_default/is_platform → oldest by
  created_at, matching `20261014000200`) in plan.md, design.md, tasks.md; pgTAP asserts one row per user.
- LOW (grant naming): design.md now states `GRANT EXECUTE … TO authenticated` / `REVOKE … FROM PUBLIC, anon`
  explicitly, matching `20261010180200:126-127`.
Migration `20261101130000` renamed `..._transport_flag.sql`; plan body trimmed to ~15.3k chars. Re-ran validators: 0
errors (below). Re-pushed (force); deleted INTERNAL-REVIEW.json.

### 2026-10-17T15:38Z · kiro-hotmail-202610151618-b437 · (internal review round 3) → drafted
Third internal adversarial review returned REJECTED (0 HIGH, 2 MEDIUM). Both fixed, premises re-verified in current
code:
- MEDIUM-1 (handoff.md stale Lanes index + non-existent `switch_active_tenant` RPC): the `## Lanes` index line for
  `switch-tenant-rpc-db` now reads "per-device transport one-owner flag (DB); reuses the existing
  `switch_to_tenant_by_slug` RPC (VTID-05043), does not rebuild it", and the opening paragraph drops "reserved slugs"
  from the delta list (reserved slugs shipped/applied by VTID-05150, referenced not rebuilt). This matches the round-2
  re-scope already carried by plan.md/tasks.md/design.md/the lane file; `switch_active_tenant` (never existed) removed.
- MEDIUM-2 (D18 lineage guard: undefined surface + unstated granularity): applied the mt-discover resolution
  (CROSS-SPEC-DECISIONS, per-QUERY not per-module) to R8 (requirements.md), plan.md Problem/Fix #8, design.md and
  tasks.md and the `lineage-guard-health` lane. Named the concrete surface set the guard scans —
  `services/gateway/src/routes/tenant-admin/*-repository.ts` + their routes, enumerated today as overview, kpis,
  insights, product-analytics, community-admin, audit-log, health-index (verified by listing the dir and grepping
  `.from(` in each `*-repository.ts`). Stated it fails only a specific `.from('<table>')` read of a per-member health
  table there; explicitly does NOT fail (a) a tenant-level aggregate — `health-index-repository.ts` reads
  `tenant_health_index_daily` (verified `:21,:30`), not a per-member health table — or (b) the member-facing `healthDb`
  readers outside the set (the five Problem #5 files). Membership via `mt-identity`'s `isHealthTable()` (O1).
Plan body trimmed to ~15.1k chars (condensed Out-of-scope / Depends-on / Owner-decisions / Fix bullets). Re-ran
validators: 0 errors (below). Prepared commit via the private-index recipe for the parent to fast-forward; deleted
INTERNAL-REVIEW.json.

### 2026-10-17T15:43Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T18:44Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T18:47Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T19:36Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
