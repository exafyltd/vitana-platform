# B. Multi-Tenant protection report

Purpose: show exactly what the Multi-Tenant (MT) programme has built, what is in flight, and which interfaces the
initiative may consume, so that nothing here duplicates or disturbs it (directive §2).

## 0. State at 2026-11-01T19:54Z (supersedes §4, §5 and §10 item 1 where they differ)
- At 14:14Z session `kiro-hotmail-202611011402-f523` wrote `docs/owner/approve-11.sh` (branch
  `docs/mt-owner-approval-scripts`) for the escalated sessions. At 15:00Z the same programme instead re-planned them
  under new slugs (`mt-track-s-r2/handoff.md` log: "re-plan the escalated plans under new slugs instead of approving
  them as escalated"). From 15:11Z session `kiro-hotmail-202611011452-6d16` (seat `hotmail`) drives the re-plans and
  holds their `_plan` claims [git].
- Approved by policy `converged-auto-v1`: `mt-track-s-r2` (S-H residual; VTID-05441, 05442; PR #4574) and
  `mt-guardrails-r2` (WS0; VTID-05443–05448; PR #4575) [git].
- Drafted as branches, waiting for sparring slots: `mt-identity-r2`, `mt-packs-r2`, `mt-community-isolation-r2`,
  `mt-data-cleanup-r2`, `mt-discover-r2`, `mt-network-r2`, `mt-native-health-r2`, `mt-m3-r2`, `mt-tenant-admin-r2`,
  `mt-frontend-brand-r3` [git].
- `mt-packs-r2` now has a lane `content-overrides-db`, which closes the `tenant_content_overrides` gap of §6 and §10.
- `mt-identity-r2` lane `role-source-and-bootstrap` makes `user_tenants.active_role` the single role source (its
  `plan.md` lane 4). The initiative requires the grants in `user_permitted_roles` to stay a separate store (README,
  "How the initiative joins").
- New Track S plan from this initiative: `mt-track-s-authz` (PR #4579), registered in the multi-tenant programme.

## 1. Sources of truth

| Record | Path | Role |
|---|---|---|
| Programme plan v5.1 | `P:docs/MULTI-TENANT-PLAN.md` (VTID-05022) | Target architecture (§4), workstreams WS-S and WS0-WS11, milestones M0-M3 and N1, decision register D1-D27 |
| Programme registry | `P:docs/programs/multi-tenant/program.md` | Lists only 3 specs. `next_review: 2026-10-22` has passed. |
| Kiro hand-off spec | `P:.kiro/specs/multi-tenant/requirements.md` | Done lanes S-M, A, B, C; current slice VTID-05221/05222 |
| Migration queue | `P:docs/multitenancy/MIGRATION-QUEUE.md` | The single ordered list of MT migrations |
| Registry contract | `P:docs/multitenancy/LANE-C.md` | `list_public_tenants()` / `resolve_tenant()` shape |
| Approved specs | `P:.kiro/specs/{multi-tenant,mt-jobs,mt-launch,mt-frontend-brand}/` | Lanes, VTIDs, logs |
| Unapproved plans | branches `origin/kiro/mt-*/plan`, `origin/kiro/mt-frontend-brand/plan-amend-1` | Not on main (§5) |
| Owner approval scripts | branch `origin/docs/mt-owner-approval-scripts`, `docs/owner/approve-11.sh` (2026-11-01) | Approves the escalated sessions; superseded by the `-r2` re-plans (§0) |

## 2. Implemented and in production

| Lane | VTID | Delivered | Evidence |
|---|---|---|---|
| S-M | VTID-05147 | Members can no longer write `user_tenants` or role rows; `set_role_preference` checks membership; `requireTenantAdmin` requires a permitted admin role | `20261013233000…sql`; `GW/middleware/require-tenant-admin.ts:143-158` [code] |
| A | VTID-05149 | `tenants.is_default`/`is_platform`; signup lands in the default tenant; deterministic primary-tenant resolver; `TenantContext`; `ci_tenant_isolation_health()` | `GW/services/tenancy/tenant-context.ts:22-104`; `20261014000100-000300` [code] |
| B | VTID-05150 | Brand pack columns, `reserved_tenant_slugs`, `provision_tenant()`, exafy-admin provisioning API, readiness, assets, CLI | `20261014000400-000500`; `GW/routes/admin-tenants-repository.ts:60` [code] |
| C | VTID-05151 | Public registry RPCs, DB-driven `useTenant`, generic portal at `/:tenantSlug` | `20261014000600-000700`; `V1:src/hooks/useTenant.tsx`; `V1:src/App.tsx:2337` [code] |
| Track S | VTID-05040..05055 | S-A..S-L closed, except the residuals in §10 item 8 (S-I partly, S-J partly; the S-G role allowlist is unverified) | `20261010164100…05041_definer_functions_lockdown.sql`, `admin-partner-health.ts:72-99` and others [code] |

All 8 migrations were applied on 2026-10-13 (RUN-MIGRATION run ids are in the queue). Per the spec they were
staging-verified (gateway 91/91 at `f3bcf3dc3`) and published on 2026-10-14 (gateway `0b875e98`, app `49182e04`) [doc].

**VTID-05148 is not an MT VTID.** It is Loop Engineering Phase 4 "L3 Learn" (commit `e7a4c90fb5`, #4092) [git]. The
directive's range "VTID-05147 through 05151" should be read as 05147, 05149, 05150 and 05151.

## 3. Approved specs on main: lanes and real state

Lane front matter lags git in places. The table below takes merge status from `git log origin/main --grep` [git] and
lane state from the lane files.

| Spec / lane | VTID | Lane state | Real state | Next |
|---|---|---|---|---|
| multi-tenant / provisioning-ui | 05221 | in-review | V1 PR #1438 open. Last log (2026-10-18): red on the ECR pull limit and a VTID-05201 test that is red on main too. | Claude, or exceptions seat `exafyltd` |
| multi-tenant (coordinator) | 05222 | — | Signup integrity re-check, no lane | coordinator |
| mt-jobs / jobs-automation-actor-tenant | 05267 | ready | **Merged** `f6a6788bf3` (#4318), dark | lane record stale |
| mt-jobs / jobs-community-scan-tenant | 05268 | executing | **Merged** `1f0a8cf669`. Closing record #4534 says STAGING-VERIFY failed only on VTID-05308; `done` waits for a passing run. | fix-forward in #4492 |
| mt-jobs / jobs-env-prepare | 05269 | ready | Not started. The EventBridge scripts still pin one tenant. | executor Claude |
| mt-jobs / jobs-tenant-loop | 05270 | ready | **Merged** `5f76b3ab2d` (#4280), dark. Adds `mt-flags.ts`, `jobs/job-tenant-loop.ts`. | lane record stale |
| mt-launch / pack-intake-db | 05324 | executing | **Merged** `b9e0db028c` (#4265). Queue rows 9-10 pending and blocked (§6). | apply blocked |
| mt-launch / pack-intake-admin, support-landing, tenant-owner-analytics | 05323, 05325, 05326 | ready | Not started (seat `jtadic`) | — |
| mt-launch / worker-test-gate | 05327 | ready | Not started | executor Claude |
| mt-frontend-brand / email-brand-db | 05245 | in-review | **Merged** in V1 `cc19942b0` (#1464); queue row 11 queued | migration apply |
| mt-frontend-brand / brand-surface, theme-tokens | 05242, 05246 | parked / ready | To be superseded by plan `mt-frontend-brand-r2` (escalated, §5) | owner decision |
| mt-frontend-brand / adminfetch-header, cors-config, email-brand-code | 05241, 05243, 05244 | ready | `cors-config` has a branch commit (2026-10-21); claims are held | — |
| health-native (Health programme) | 17 VTIDs | executing | Several lanes in review (2026-10-27). Shares WS9/WS10 with MT. | — |

**Merged is not done.** VTID-05268 is merged and dark, but its lane waits for STAGING-VERIFY (directive §2.2 rule 9).

## 4. Open PRs touching MT (github.com listing, 2026-11-01)

| Repo | PR | Title | Opened |
|---|---|---|---|
| platform | #4567 | `plan(mt-track-s-r2)`: close the last Track S residual (S-J) | 2026-11-01 (today) |
| platform | #4171 | `plan(mt-network)`: WS3 Network layer and community/network scopes | 2026-10-17, still sparring |
| platform | #4481, #4524, #4525, #4526 | PM bookkeeping for multi-tenant, mt-frontend-brand, mt-jobs, mt-launch | 2026-10-28 to 10-31 |
| platform | #4275 | `plan(native-wave2-public-auth-onboarding)` (touches tenant onboarding) | 2026-10-21 |
| V1 | #1438 | VTID-05221 `multi-tenant/provisioning-ui` | 2026-10-15 |

Early in the session the REST API answered 403, so this list came from the public web listing filtered by "tenant"
and "mt-". Later the API worked; §0 adds #4574, #4575 (the approved `-r2` plans) and #4579 (`mt-track-s-authz`).
#4567 was replaced by #4574.

## 5. MT plans not on main (escalated or still sparring)

Each branch adds only spec documents. No VTIDs are allocated, and every lane is `ready` with `next_actor: owner`. Ten of
these plans (plus `sparring-token-efficiency`) are in `approve-11.sh`. mt-discover and mt-network are not. All of
them are now superseded by `-r2`/`-r3` re-plans (§0).

| Plan (WS) | State, verdict | Migrations (prefix `20261101`) | What it introduces that the initiative must not duplicate |
|---|---|---|---|
| **mt-identity** (WS1) | parked; escalated after 3 rounds; R3-F1 major (dev-auth null tenant) | `030000-035959` | Resolver and policies: `tenant_id_for_policies()`, `is_member()`, rewrite of 19 bare policies on 11 tables (N3 gate). Membership: `user_tenants` canonical, `memberships` becomes a view with dual-write and a drift report. Access-token hook in shadow mode. **Single role source** (`user_tenants.active_role`, still an open question at `plan.md:184`). Gateway: `tenantDb(ctx)`, `TENANT_TABLES`, `isHealthTable()`, `healthDb`, `getTenantIdBySlug`. |
| **mt-guardrails** (WS0) | drafted; escalated after 3 rounds; R3-F1 major (`pg_prove` container) | none | Local Supabase stack plus fixtures (T_A/T_B, a_member, a_admin, b_member, b_admin, ab_dual, `CANARY_A`). **Generated inventories** of tables, functions, routes, edge functions, realtime tables and buckets (`scripts/mt/inventory/out/`). DB lints, pgTAP isolation suite, gateway tenant-scope lint, route-inventory and route×role×tenant canary tests, Maxina golden suite. CI: `MT-GUARDRAILS`, `SQL-MT-ISOLATION`, `MORNING-SYSTEM-HEALTH-CHECK`. |
| **mt-packs** (WS5) | parked; escalated; R3-F1 blocker (rule-41 guard vs `SHORT_GAP_GREETING_PHRASES`) | `080000-085959` | Persona split into a fixed Vitana block and a tenant block of facts plus intents. `getEffectiveConfigSync(surface, tenantId)`, `session.packFacts`, `LiveSessionStartRequest.tenant_slug`, KB overlay (`knowledge_docs.tenant_id`), flag `mt.packs`. Lanes touch `orb/profile/**`, `routes/orb-live.ts`, `live-session-controller.ts`. |
| **mt-community-isolation** (WS3) | parked; escalated; R3-F1 major (`resolvePersonByName` unscoped) | `060*`, `061*`, `070160` | Tenant RLS on community tables, Founding pool per tenant, `platform_only_accounts` view. The social-memory resolver takes its tenant from `TenantContext`. Flag `mt.community_scope`. |
| **mt-network** (WS3) | drafted; session 2 in round 2; PR #4171 | `050-054*` | `send_message()` / `send_message_as()`, `scope` columns, `network_visible`, recipient scope in `resolve_recipient_candidates`, flags `mt.network_enabled`, `mt.network_groups` |
| **mt-data-cleanup** (WS2) | drafted; escalated | `040-043*` | Orphan quarantine, `memory_facts` supersede-merge, `profiles.tenant_id` backfill, NOT NULL on hot tables (live on apply) |
| **mt-tenant-admin** (WS4) | parked; escalated | `070100-070600` | `resolveScopedTenant(req)`, invitation accept page, moderator scope, deactivate/archive, Command Hub tenant module |
| **mt-native-health** (WS9/10) | drafted; escalated | `130000-130100` | `app_users.health_home_tenant_id`, `healthDb`, health reader and lineage inventories, push tokens keyed by user |
| **mt-m3** | drafted; escalated | `140000-141100` | `tenant_domains`, host-based `resolve_tenant`, a host arm in `getTenantContext()`, tenant switcher UI, per-tenant monitoring |
| **mt-discover** (WS11) | drafted; escalated (`infra: true`) | `120000-120300` | `supplier_tenant_relationships`, `products.distribution`, tenant RLS on products/merchants, a shared Discover predicate with a reader inventory |
| **mt-track-s** | parked; escalated; R3-F1 blocker | none | S-J only. Re-planned today as #4567. |
| **mt-frontend-brand-r2** | parked; escalated | none | Supersedes VTID-05242/05246 (brand surface, theme tokens) |

## 6. Migrations

- **Rows 1-8** were applied on 2026-10-13 with clean post-checks.
- **Rows 9-10** (VTID-05324, `20261101110000`/`110100`) are pending. The queue says they wait for "WS5's
  `tenant_content_overrides` (mt-packs) row applied first". **No migration on main creates `tenant_content_overrides`,
  and the mt-packs plan does not mention it** [git: `grep` over `supabase/migrations` and `.kiro/specs/mt-packs` on the
  plan branch]. As queued, rows 9-10 cannot be applied. Resolved in planning: `mt-packs-r2` lane
  `content-overrides-db` creates it (§0).
- **Row 11** (V1 VTID-05245) is queued.
- **Reserved ranges.** Planned plans hold `20261101` + `030000-035959`, `040-043`, `050-054`, `060`, `061`, `070100-070600`,
  `080000-085959`, `110000-115959`, `120000-120300`, `130000-130100` and `140000-141100`.
- **Rule for the initiative.** Any IA migration takes its own range, agreed with the queue owner (Lane A), gets a queue
  row in the same PR, needs owner approval to apply (collaboration.md §7d), and never shares a PR with an MT migration.

## 7. Feature flags and deployment state

| Mechanism | State | Evidence |
|---|---|---|
| Membership check on the token tenant (`TENANT_MEMBERSHIP_CHECK_MODE`) | `enforce` (unset means enforce; nothing in workflows, infra or scripts sets it) | `GW/middleware/auth-supabase-jwt.ts:527-529` [code] |
| `MT_RESOLUTION_V2` env master | off. Not set anywhere in the repo. | `GW/services/mt-flags.ts:22-24` [code] |
| `tenant_settings.feature_flags.mt.jobs_tenant_loop` | absent, which means off | `mt-flags.ts:29-40` [code] |
| `isFeatureLive(name)` | global and env-based (`FEATURE_<NAME>_ENV`), with no tenant dimension | `GW/services/feature-flags.ts:81-89` [code] |
| Per-tenant flag reader `isTenantFeatureLive` | not built (mt-launch pack-intake-admin) | — |
| `mt.packs`, `mt.community_scope`, `mt.network_enabled`, `mt.network_groups`, `mt.launch_*` | planned only | plan branches |
| Access-token hook | not built. Its shadow lane is in mt-identity. Enabling it is an owner action (D14). | plan v5.1 §4.2 |

- **Live:** S-M lockdown; enforced membership check; deterministic primary-tenant fallback; default-tenant signup;
  registry and portal; provisioning (no new tenant created yet); `req.tenant` attached by two middlewares.
- **Merged but dark:** the job fan-out (VTID-05267, 05268, 05270).
- **Not built:** hook, `tenant_id_for_policies`/`is_member`, `tenantDb`, policy rewrite, CI isolation suites, Maxina golden
  suite.

## 8. Interfaces

### Stable and safe to consume (read-only use, no edits)

| Interface | Location |
|---|---|
| `resolvePrimaryTenant`, `getTenantMeta`, `getDefaultTenantId`, type `TenantContext` | `GW/services/tenancy/tenant-context.ts:22-104` |
| `requireTenant`, `requireAuthWithTenant`, `getTenantContext` | `GW/middleware/auth-supabase-jwt.ts:635-825` |
| `requireTenantAdmin`, `requirePlatformScope` | `GW/middleware/require-tenant-admin.ts:63-191` |
| `fetchPermittedRoles`; `resolveEffectiveRole`; `pickEffectiveRole` | `GW/lib/permitted-roles.ts:23-57`; `GW/routes/orb-live.ts:814-845`; `GW/services/orchestrator/active-role.ts:20-28` |
| `forEachActiveTenant`, `activeTenantIds`, `resolveActorTenant`, `resolveJobTenants`; `isMtResolutionV2Enabled` | `GW/services/jobs/job-tenant-loop.ts`; `GW/services/mt-flags.ts` |
| `list_public_tenants()`, `resolve_tenant(p_slug)` | contract in `docs/multitenancy/LANE-C.md` |
| `ci_tenant_isolation_health()` (service_role only) | `20261014000300…sql` |
| `useTenant()` (`setTenantBySlug` → `switch_to_tenant_by_slug` → `refreshSession`) | `V1:src/hooks/useTenant.tsx:159-245` |

### About to change: do not build on the current shape

| Interface or file | Changing plan / lane | Change |
|---|---|---|
| `tenant-context.ts` | identity `tenant-db-and-slug-cleanup`; packs `persona-pack`; m3 `host-resolution-gw` | slug map, `getTenantIdBySlug` (planned in two plans), host arm |
| Tenant claim in `auth-supabase-jwt.ts` | identity hook (shadow); m3 host resolution | claim emitted by the access-token hook |
| `current_tenant_id()` and RLS policies | identity `helpers-and-policy-rewrite` | `tenant_id_for_policies`, `is_member`, policy rewrite |
| `user_tenants`, `memberships`, `role_preferences`, `user_permitted_roles` | identity `membership-unification`, `role-source-and-bootstrap` | `memberships` becomes a view; single role source (undecided) |
| `switch_to_tenant_by_slug` | tenant-admin `tenant-lifecycle-db` (070350) | deactivated tenants resolve to the default |
| ORB session context: `orb/profile/**`, `live-session-controller.ts`, `orb-live.ts`, `orb/live/types.ts` | packs `persona-pack` | `packFacts`, `tenant_slug`, `getEffectiveConfigSync` |
| `orb-tools-shared.ts` | network (two lanes), packs `kb-overlay-code` | recipient scope, `send_message_as`, KB overlay |
| `services/social-memory/**` | community-isolation | tenant taken from `TenantContext` |
| `memory_facts` data | data-cleanup (live on apply) | quarantine, supersede-merge |
| `MORNING-SYSTEM-HEALTH-CHECK.yml` | guardrails `ci-wiring`; m3 `morning-health-pertenant` | per-tenant health |
| V1 `useTenant.tsx`, `AuthGuard.tsx`, `App.tsx`, `screens.json` | m3 `tenant-switcher-ui`; frontend-brand-r2; tenant-admin pages | switcher, theme, admin screens |
| Inventories and lints | guardrails inventories and scope lint; discover reader inventory; native-health health inventories; network `chat-writer-inventory.ts`; V1 `check-edge-function-auth.mjs` (#4567) | overlap with the planned module registry and dependency graph |

## 9. Rules for the initiative

These turn directive §2.2 into checks.

1. **Tenant and role resolution.** Resolve tenant only through `getTenantContext`, `requireTenant`/`requireAuthWithTenant`
   or `resolvePrimaryTenant`. Resolve role only through `resolveEffectiveRole`/`fetchPermittedRoles` until mt-identity
   lands its single role source. No new resolver, cache or claim.
2. **Changing files.** Do not edit a file in the "about to change" table without the MT plan driver's agreement in
   writing in the IA plan record. If a change is needed there, request it in the MT lane, or sequence it after that lane.
3. **Migrations.** Use an IA migration range plus a queue row. Never edit, rename, reorder or squash an MT migration.
   Never mix IA and MT migrations in one PR.
4. **Flags.** Do not set `MT_RESOLUTION_V2` or any `mt.*` key. IA flags use their own names and default off.
5. **Inventories.** Module and dependency inventories consume mt-guardrails' generated inventories once they land. Until
   then IA builds only atlas- and import-graph-derived artifacts and marks DB and route inventories as pending.
6. **Tests in every IA lane.** The MT suites (`test/vtid-05041*`, `05043*`, `05047*`, `05048*`, `05147*`, `05149*`, `05150*`,
   `05151*`, `05267*`, `05268*`, `05270*`, `middleware/auth-supabase-jwt.test.ts`, `middleware/require-tenant-admin.test.ts`,
   `routes/tenant-admin/*`, `orb/live/ws-tenant-fallback.test.ts`) plus `test:roles`, `test:support` and `test:operator`
   stay green. No MT test is edited.
7. **MT records.** Never edit MT lane or hand-off files (collaboration.md §5, §7a). Agreements are recorded in the IA plan.
8. **Escalation.** Any conflict becomes one stop message to the owner (directive §2.2, CLAUDE.md autonomy contract).

## 10. Programme gaps observed (for the MT owners; not acted on)

1. **`tenant_content_overrides` had no creator.** Queue rows 9-10 and mt-launch's publish path depend on it (§6).
   `mt-packs-r2` lane `content-overrides-db` now plans it (§0).
2. **Stale lane records.** VTID-05267 and 05270 are merged, but their lane files say `ready`. Claim refs
   (`collab-claim/mt-*`) are still held on merged lanes.
3. **Missing records.** `CROSS-SPEC-DECISIONS.md` is cited in hand-offs (`mt-jobs/handoff.md:40`,
   `mt-frontend-brand/handoff.md:31`) but exists nowhere in either repo's history. `docs/multitenancy/PLAN.md` and
   `DECISIONS.md` (plan §8) are also absent.
4. **The programme registry lists 3 of the 16 MT specs and plans.**
5. **Path conflict.** mt-identity puts `health-db.ts` under `services/tenancy/`; mt-native-health puts it under `src/data/`.
6. **Duplicates across plans.**
   - `getTenantIdBySlug` is planned in two plans.
   - `MORNING-SYSTEM-HEALTH-CHECK.yml` is claimed by two plans.
   - Two per-tenant flag readers are planned (`mt-flags.ts`, `tenant-launch/tenant-feature-flag.ts`).
   - Two bare-policy counters are planned.
7. **MT SQL and shell tests are not referenced by name in any workflow.** Examples: `scripts/ci/test-vtid-05147/05150/05151*.sh`,
   `supabase/tests/vtid_05147/05150/05151*.test.sql`. `SQL-TENANT-FOUNDATION.yml` runs only on `*_vtid_05149_*` changes.
   Whether a glob runner picks the others up is [unverified].
8. **Direct reads and header trust.** 65 gateway files query `user_tenants` directly. `X-Vitana-Tenant` is still
   trusted in 4 places (`autopilot-recommendations.ts:431`, `:1800`, `:2351`; `calendar.ts:1054`).
9. **Capacity.** PLAN-SPAR runs at most 2 sessions repo-wide (collaboration.md §8a.2). Ten MT plans wait for the owner,
   and mt-network is still sparring. IA plans compete for the same capacity (G §4).

## 11. Who decides

| Decision | Who | Mechanism |
|---|---|---|
| Approve an escalated sparring session | Owner (exafy_admin) | `POST /api/v1/plans/spar/:id/approve`; `approve-11.sh` is superseded (§0) |
| Apply a migration; enable the auth hook (D14); publish to production | Owner | collaboration.md §7c/§7d; plan D14 |
| Plan driving, lane seats | MT planner seat `hotmail` (author of mt-launch, mt-jobs, mt-frontend-brand and all 12 unmerged mt-* plans). Lane seats `hotmail` (DB), `jtadic` (gateway), `exafyltd` (frontend, and the exceptions seat), `exafy` (platform). | `docs/programs/areas.yaml`; lane files |
| Lane acceptance | Reviewer agent `vitana-lane-reviewer` | collaboration.md §7 |
| Merge to staging | Project Manager agent (`PM_MODE=live` on staging only), or the plan driver | collaboration.md §7b |
