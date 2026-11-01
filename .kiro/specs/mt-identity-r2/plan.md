---
change_class: standard
---
# mt-identity-r2 — WS1 identity, tenancy resolution & roles (re-plan of mt-identity)

<!-- plan:begin -->
## Re-plan answers (session `ee011de1` round 3)
Re-plan of `mt-identity` (branch `kiro/mt-identity/plan`; PLAN-SPAR session `ee011de1` escalated at the round cap).
Every premise below was re-verified on `origin/main` `62990ce285` on 2026-11-01.
- **R3-F1** (`getDefaultTenantId()` can return `null`, and `dev-auth.ts` would then bootstrap with a null tenant and
  still answer 200): lane 5 fixes the order of tenant sources in `POST /dev/auth/token`
  (`routes/dev-auth.ts:315`, block `:364-375`). The order is: the body's `tenant_id`, then `DEV_TENANT_ID`, then
  `await getDefaultTenantId()`. If all three are empty and the role is a bootstrap role (`developer`/`admin`/`staff`,
  `:368`), the handler returns `503 { ok: false, error: 'REGISTRY_UNAVAILABLE' }`. It returns before
  `bootstrapRequestContext` (`:370`) and before `mintTokenForUser`, so no token is minted. A non-bootstrap role does
  not use the tenant, so it is unchanged. Test: `test/mt-identity-slug-cleanup.test.ts` stubs
  `getDefaultTenantId()` to resolve `null`, leaves `DEV_TENANT_ID` unset and sends no `tenant_id`. It asserts 503,
  that `bootstrapRequestContext` was not called and that no token is in the body. A second case with `DEV_TENANT_ID`
  set asserts 200 and that the env id was used.
- **R3-F2** (the presence routes lose their tenant fallback and have no tests): lane 5 adds
  `test/mt-identity-presence-tenant.test.ts`. It has one Jest/supertest case per route (`routes/presence.ts:55`,
  `routes/presence-did-you-know.ts:63`). Each case stubs that route's repository `fetchPrimaryTenantForUser`
  (`presence-repository.ts:22`, `presence-did-you-know-repository.ts:23`) and `resolvePrimaryTenant()`. With
  `MT_RESOLUTION_V2=true` (`isMtResolutionV2Enabled()`, `services/mt-flags.ts:23`), it asserts that the tenant used
  equals `resolvePrimaryTenant()`'s `tenantId` and that the deprecated repository function is never called. With the
  flag off, it asserts the legacy call still happens (unchanged behaviour). Today no test references either route
  (both repository headers say "zero coverage today"), so both cases fail on `origin/main`.
- **New since the last round: the bare-policy count is wrong.** A parse of all 674 migrations (last definition wins
  per table and policy; DROP POLICY and DROP TABLE honoured) finds **32 policies on 15 tables**, not 19 on 11. Of
  these, 30 are exactly `tenant_id = current_tenant_id()` and 2 are near-bare (`community_listings_select_public`,
  `d42_domain_weights_select`). The old count missed 13 exact-bare policies on 4 tables:
  - `match_targets`: select, insert, update (`20251231000001_vtid_01088…:238-249`)
  - `relationship_nodes`: select, insert, update, delete (`20251231000001_vtid_01087…:134-156`)
  - `social_alignment_signals`: select, insert (`20260103000001_vtid_01141…:286-296`)
  - `topic_registry`: select, insert, update, delete (`20251231000001_vtid_01093…:73-97`)

  None of these four tables has a `user_id` column, so all four are tenant-shared (`(select is_member(tenant_id))`).
  No migration after 2026-10-15 adds a bare policy. The two `mt_launch` migrations (`20261101110000`,
  `20261101110100`) are `service_role`-only.
- **Other premises that changed:**
  - The last definition of `bootstrap_admin_user` is vitana-v1 `20250915132930_…:166`, not the `20250831…` files.
    It is still keyed on tenant names (`:236`, `:246`, `:254`) and still writes `memberships` (`:233`).
  - The env master `MT_RESOLUTION_V2` already exists (`services/mt-flags.ts:23`, VTID-05270). Lane 5 imports it and
    does not add a second reader.
  - The gateway test runner is Jest (`services/gateway/package.json:13`), not Vitest.
  - The `…0001` literal baseline is 34 occurrences in 29 non-test gateway files.
  - The 5 "no-policy" tables are not created by any migration in either repo. They stay out of scope.
  - Migrations `20261101110000`/`110100` now exist, so this spec's range moves to `20261102030000`–`20261102035959`
    (free).
- **Lanes on today's rules:** every lane is `executor: kiro`, `next_actor: kiro`, `reviewer_seat:
  agent:vitana-lane-reviewer`, reviewed by the reviewer agent (`collaboration.md` §3a, §7). No lane touches a
  governance path or a protected gate file. Migrations are applied by Kiro through `RUN-MIGRATION.yml`, and only after
  the owner approves the files and the target database (`collaboration.md` §7d). A policy approval never authorises
  one.

## Problem
Program `docs/MULTI-TENANT-PLAN.md` v5.1, §4 items 2 and 3 (the "§4.2/§4.3" citations at `:89`, `:117`), workstream
WS1 (`:108`). VTID-05149 already shipped `tenants.is_default`/`is_platform`, the signup default tenant,
`resolvePrimaryTenant()` + `TenantContext` (`services/gateway/src/services/tenancy/tenant-context.ts:43`) and
`ci_tenant_isolation_health()`. The remaining WS1 pieces are still open on platform `origin/main` `62990ce285`:

1. No tenant-claim access-token hook exists in `supabase/migrations/**` (no `access_token_hook`,
   `custom_access_token` or `tenant_id_shadow`). Browser JWTs carry no top-level `tenant_id`, so `current_tenant_id()`
   returns NULL for them (program §2).
2. Bare `tenant_id = current_tenant_id()` policies (no `auth.uid()`/`current_user_id()`/`is_member`/
   `is_tenant_admin`/service-role check) fail closed while the claim is NULL. They would open tenant-wide the moment
   `current_tenant_id()` resolves (N3). **Recount on 2026-11-01: 32 policies on 15 tables** (parser over all 674
   `supabase/migrations/*.sql`, last definition wins per policy):
   - `community_groups`: insert, update, delete
   - `community_meetups`: insert, update, delete
   - `community_listings`: `_select_public` (near-bare: `status IN (…) AND tenant_id = current_tenant_id()`)
   - `d42_domain_weights`: `_select` (near-bare: `… OR tenant_id = '…0001'`)
   - `event_attendance`: `_select`
   - `live_highlights`: `_select`
   - `live_room_attendance`: `_select`
   - `live_rooms`: select, insert, update
   - `products_catalog`: select, insert
   - `services_catalog`: select, insert
   - `tenant_catalog_overrides`: `_select`
   - `match_targets`: select, insert, update
   - `relationship_nodes`: select, insert, update, delete
   - `social_alignment_signals`: select, insert
   - `topic_registry`: select, insert, update, delete

   This supersedes both the program's "26 on 18" (`docs/MULTI-TENANT-PLAN.md:108`) and the earlier "19 on 11". The
   5 tables `access_audit_log`, `consents`, `retrieval_traces`, `role_sessions` and `user_roles` have no policy and
   no `CREATE TABLE` in either repo's migrations. No `tenant_id_for_policies()` or `is_member()` helper exists in
   either repo.
3. The membership stores disagree: `memberships` (a table, created in vitana-v1 `20250831074859_…:32`) vs
   `user_tenants` (`20251231000000_vtid_01101_phase_a_bootstrap.sql:90`, `UNIQUE (tenant_id, user_id)` `:98`,
   `active_role` `:94`, `is_primary` `:95`). Program §2 counts 15 rows only in one and 18 only in the other. There
   are also competing role sources: `user_permitted_roles`, `role_preferences` and `active_role`. Four AFTER INSERT
   triggers on `user_tenants` fire on a primary membership: `welcome_chat_on_primary_membership`,
   `founding_seat_on_primary_membership`, `seed_onboarding_autopilot_on_primary_membership` and
   `trg_create_user_live_room`. Each is gated by `membership_side_effects_suppressed()`
   (`20261010180000_vtid_05043_…:46-70`).
4. `tenantDb`/`TENANT_TABLES`/`isHealthTable`/`healthDb` do not exist. The only trace is a forward-reference comment
   at `middleware/auth-supabase-jwt-repository.ts:17-21`. Tenant-table access is ad hoc, and health tables are not
   excluded.
5. Two kinds of fake tenant id are live.
   - (a) Two four-entry slug maps (`…0001`–`…0004` = vitana/maxina/alkalma/earthlings). One is in `routes/me.ts`:
     `TENANT_SLUGS` id→slug at `:15`, read at `:270,408`, and `SLUG_TO_TENANT_ID` at `:23`. The other is
     `routes/dev-auth.ts:26` `SLUG_TO_TENANT_ID`, read at `:491`.
   - (b) A dev-sandbox constant: `services/orb-memory-bridge.ts:66` `DEV_IDENTITY` (user `…0099`), pinned to
     `TENANT_ID='…0001'`/`TENANT_SLUG='vitana'`.
   - Separately, `dev-auth.ts:364` defaults to `DEV_TENANT_ID || '…0001'`. When bootstrap fails, `:371-373` only
     logs a warning, and the handler still mints and returns 200.
6. `bootstrap_admin_user` is keyed on `tenants.name IN ('Maxina','Alkalma','Earthlings')` / `name = 'Maxina'` (the
   wrong key column) and writes `memberships`. Its last definition is vitana-v1
   `20250915132930_…:166` (`:233`, `:236`, `:246`, `:254`). vitana-platform does not redefine it.

## Fix
DB lanes are separate from CODE lanes (program §4 item 7). Five lanes. The hook GO-LIVE is a separate later lane on
purpose (owner D14) and is not part of this spec.

1. **helpers-and-policy-rewrite (DB).**
   - Add `tenant_id_for_policies()` and `is_member(tenant_id)` as a STABLE SECURITY DEFINER pair over the unique
     `(tenant_id, user_id)` index. `tenant_id_for_policies()` is a NEW name; this lane does not redefine
     `current_tenant_id()`. The N2 degraded path is `coalesce(<claim if is_member>, <auth.uid()'s primary
     user_tenants row>)`.
   - Query cost. `(select tenant_id_for_policies())` is uncorrelated, so Postgres hoists it to an initPlan: one
     indexed lookup per statement on the hot user-private tables. `(select is_member(tenant_id))` is correlated on the
     outer `tenant_id`, so it runs once per row. That is acceptable because it is one probe of the unique index per
     call. An EXPLAIN check bounds the per-row cost on the largest tenant-shared table (`live_rooms`).
   - Rewrite each of the **32 policies on the 15 tables above**:
     - User-private policies become `user_id = auth.uid() AND tenant_id = (select tenant_id_for_policies())`.
     - Tenant-shared policies become `(select is_member(tenant_id))`, keeping any extra predicate:
       `community_listings` keeps its `status IN (…)` term, and `d42_domain_weights` keeps its `OR tenant_id = '…0001'`
       global-defaults term.
     - Classification rule: a table with a `user_id` owner column is user-private, otherwise tenant-shared. All four
       newly found tables (`match_targets`, `relationship_nodes`, `social_alignment_signals`, `topic_registry`) have
       no `user_id` and are tenant-shared.
     - Write policies keep today's audience (any member of the tenant); this lane does not tighten them to admins.
       The writers are listed in the PR, and tightening is a later decision.
   - The 5 tables with no policy and no migration are out of scope. This lane neither creates nor relaxes a policy on
     them.
   - Add the N3 bare-policy lint, `scripts/ci/bare-policy-lint.mjs`. It counts bare `current_tenant_id()` policies
     outside an owner-tagged tenant-shared allowlist and must read ZERO. This lane does not enable the hook.
   - **The executor re-runs the recount at implementation** with the same parser and records the exact set in the PR
     before rewriting. If a migration that lands later changes the set, the executor updates the per-table list in the
     PR, not this plan.
2. **membership-unification (DB).** `user_tenants` (with `is_primary`/`active_role`) becomes canonical.
   - Backfill the drifted rows, after a read-only recount at implementation.
   - `memberships` becomes a view over `user_tenants`, with a dual-write trigger for legacy writers.
   - A nightly drift report reads 0 once the two are converged.
   - The steady-state dual-write trigger body (not only the backfill) writes `INSERT INTO user_tenants … ON CONFLICT
     (tenant_id, user_id) DO NOTHING`. A legacy re-insert of an existing `memberships` row is then a no-op and never
     re-fires the four AFTER INSERT triggers (the VTID-03990 duplicate-welcome-DM shape, program §3/S-E).
   - The Vitana bot user (`lib/vitana-bot.ts:9`, user id `…0001`) and every `service_bot_accounts` user
     (`20260917084341_vtid_03990_…`) are excluded from the backfill and from the drift report's member counts. The
     bot's user id is the same literal as the vitana tenant id but sits in a different column, so there is no key
     clash.
   - Expand/contract, snapshot first. The backfill runs with `membership_side_effects_suppressed()` true, and the
     view cutover must not trigger any of the four AFTER INSERT side effects (N1 guard).
3. **access-token-hook-shadow (DB).**
   - The hook function reads the active `user_tenants` membership and treats `app_metadata.active_tenant_id` as a
     preference only.
   - It emits `tenant_id_shadow` ONLY and fails open: `EXCEPTION WHEN OTHERS` returns the original claims. It does a
     single indexed lookup under a short statement timeout.
   - A mismatch-log table records shadow-vs-membership disagreements as decisions for the 7-day soak. It is
     **service-role-only**: the migration runs `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT ALL … TO
     service_role; ALTER TABLE … ENABLE ROW LEVEL SECURITY` with no policy.
   - Migrations only; no auth config in this lane.
4. **role-source-and-bootstrap (DB, depends on membership-unification).**
   - One role source of truth, `user_tenants.active_role`; the other role sources derive from it.
   - Redefine `bootstrap_admin_user` (the last definition is vitana-v1 `20250915132930_…:166`) to key on
     `tenants.is_default` and to write canonical `user_tenants` through the dual-write path.
   - The new definition is a platform migration (shared database), keeping the same signature
     (`p_user_id`, `p_user_email`).
   - Expand/contract, snapshot first.
5. **tenant-db-and-slug-cleanup (CODE, gateway; depends on helpers-and-policy-rewrite).**
   - Ship the O1 interface that other specs reference: `type TENANT_TABLES` (a schema-derived set),
     `isHealthTable(tableName: string): boolean`, `tenantDb(ctx: TenantContext)` and `healthDb(userId: string)`.
     Health tables are excluded from `TENANT_TABLES` and reachable only via `healthDb` (the frozen home tenant).
   - (a) Remove the two four-entry slug maps (`me.ts:15`+`:23`, `dev-auth.ts:26`) and resolve through the DB
     registry instead.
     - Add a `bySlug` map in `loadTenantFlags()` (`tenant-context.ts:70`), built from the already-fetched `slug`
       column, and export `getTenantIdBySlug(slug): Promise<string | null>`.
     - `dev-auth.ts:491` uses it. An unknown slug returns the same 400 with the live slug list; an unavailable
       registry returns 503.
     - `me.ts:270,408` use `(await getTenantMeta(id))?.slug ?? null`.
   - (b) `orb-memory-bridge.ts:66` `DEV_IDENTITY`: drive `TENANT_ID`/`TENANT_SLUG` from a `DEV_TENANT_SLUG` env var
     that defaults to `vitana` and resolves through the registry. The pinned dev user `…0099` stays.
   - (c) `dev-auth.ts:364` resolves its tenant in this order: the body's `tenant_id`, then `DEV_TENANT_ID`, then
     `await getDefaultTenantId()`. If nothing resolves for a bootstrap role, it returns
     `503 REGISTRY_UNAVAILABLE` before bootstrap and before mint (R3-F1). No `…0001` literal remains in `me.ts`,
     `dev-auth.ts` or `orb-memory-bridge.ts`.
   - (d) Move the last `fetchPrimaryTenantForUser` callers to `resolvePrimaryTenant()` (`tenant-context.ts:43`),
     behind `isMtResolutionV2Enabled()`:
     - `routes/autopilot-prompts.ts:109` (repo fn `middleware/auth-supabase-jwt-repository.ts:35`)
     - `routes/presence.ts:55` (repo fn `presence-repository.ts:22`)
     - `routes/presence-did-you-know.ts:63` (repo fn `presence-did-you-know-repository.ts:23`)

     The three repo fns are marked `@deprecated` (removed in the contract step after the flag is on), and the `:17`
     comment is rewritten to say so. The other ad-hoc `.eq('is_primary', true)` reads are listed in the PR. Each
     moves when its route adopts `tenantDb`, not in this lane.
   - Every new read is dark behind `MT_RESOLUTION_V2` / `tenant_settings.feature_flags.mt.*`. The dev-auth 503 guard
     only replaces a path that minted a token against a hard-coded tenant, and it is reachable only in the dev
     sandbox (`isDevSandbox()`, `:317`).

## Migrations
Range `20261102030000`–`20261102035959` (free; the newest existing migration is
`20261101110100_mt_launch_tenant_content_pipeline.sql`). If a later migration lands before implementation, the
executor renumbers and adds the MIGRATION-QUEUE rows after the existing rows. Files:
- helpers: `…030000_tenant_id_for_policies_is_member.sql`, `…030100_bare_policy_rewrite.sql` (+ rollback).
- membership: `…031000_user_tenants_canonical.sql`, `…031100_memberships_view_dualwrite.sql`,
  `…031200_membership_drift_report.sql` (+ rollback).
- hook shadow: `…032000_access_token_hook_shadow.sql`, `…032100_tenant_claim_mismatch_log.sql` (+ rollback).
- role/bootstrap: `…033000_single_role_source.sql`, `…033100_fix_bootstrap_admin_user.sql` (+ rollback).

Every DB slice gets a dry run on the D11 local stack, a pre-approved rollback migration, an off-peak window and a
read-only post-apply check. All slices are expand/contract only, with `lock_timeout` + retries and a 30-day `bak_*`
snapshot before any data move. **Applying:** after merge, Kiro dispatches `RUN-MIGRATION.yml` only when the owner has
approved the named files and the target database in the conversation, with `target` passed explicitly and not while
`MIGRATION_FREEZE` is `true` (`collaboration.md` §7d). The CODE lane has no migration.

## Tests
- pgTAP:
  - For every rewritten user-private policy, a_member cannot read a_admin's rows. The health tables, which already
    enforce this, are checked read-only.
  - On each of the 15 tables, a tenant-shared (`is_member`) policy admits same-tenant members only, never another
    tenant's member. This includes the 4 newly found tables.
  - The 5 no-policy tables are not asserted.
  - The bare-policy lint reads 0.
  - The hook fails open (returns the original claims on a forced error) and emits only `tenant_id_shadow`.
  - With the hook OFF, `is_member()` and the degraded fallback resolve the right tenant.
  - `tenant_claim_mismatch_log` denies a read by `authenticated` and admits `service_role`.
  - Re-inserting a `memberships` row that already exists, through the dual-write trigger, creates zero extra
    `chat_messages`, founding seats, autopilot rows or live rooms.
  - Inserting a `memberships` row for the bot user `…0001` yields zero `chat_messages`.
  - The backfill touches no bot or `service_bot_accounts` user.
  - An EXPLAIN check bounds the per-row `is_member()` cost on `live_rooms`.
- Local-stack test with the hook OFF after the policy rewrite: members still see their own rows and nothing of the
  other tenant.
- Jest (gateway):
  - `tenantDb` injects the tenant predicate.
  - `isHealthTable()` matches the health table set, and health tables are absent from `TENANT_TABLES`.
  - `healthDb` resolves the frozen home tenant.
  - The two slug maps are gone.
  - `getTenantMeta(id)` and `getTenantIdBySlug(slug)` round-trip on stubbed flags, and an unknown slug gives null.
  - dev-auth R3-F1: tenant unresolved for a bootstrap role gives 503, bootstrap is not called and no token is
    returned; `DEV_TENANT_ID` set gives 200.
  - Presence R3-F2: `test/mt-identity-presence-tenant.test.ts`, one case per route, flag on and flag off.
  - With the flag on, `autopilot-prompts` resolves via `resolvePrimaryTenant()`, and
    `test/vtid-05121-autopilot-prompts-not-behind-service-token.test.ts` stays green.
  - Literal lint, in two parts:
    1. `me.ts`, `dev-auth.ts` and `orb-memory-bridge.ts` contain NO `…0001`–`…0004` literal. There is no
       carve-out, so a partial removal fails.
    2. A ratchet on `…0001` literals in non-test gateway TS outside `lib/vitana-bot.ts`. The baseline is 34 in 29
       files on `62990ce285`, minus this lane's removals (re-counted and recorded in the test at implementation). The
       count must never exceed it. The remaining literals are WS2 cleanup.
- Required suites when touched: `npm run test:support` (42c) and `npm run test:operator` (42e) for the CODE lane.
  `npm run test:roles` (42h) for the role-source lane. The Maxina golden suite stays unchanged (program WS0).

## Staging verification
Read-only (rule 48). CODE lane: a staging spec signs in as the test user and asserts, through existing GET endpoints,
that resolution still returns the member's own tenant and no cross-tenant rows. A network guard aborts every non-GET.
DB lanes are verified by the RUN-MIGRATION post-checks (read-only SQL) and `ci_tenant_isolation_health()` after the
owner-approved apply. No suite targets production.

## Rollout
Dark by default: every CODE read is behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`. DB changes
follow the program §4 item 7 slice protocol. Each one is applied only after the owner approves its files and target
database (§7d), and the hook stays shadow-only. Owner steps in this spec: the migration approvals. The hook go-live
(D14) is a separate later lane.

## Risks
- A bare policy missed by the rewrite would open a table tenant-wide when the hook later goes live. Mitigation: the
  N3 lint must read 0 before any go-live lane, with pgTAP per table. The recount at implementation is the gate; this
  re-plan already found 13 policies the earlier count missed.
- The `memberships` → view cutover breaks a legacy writer or fires an N1 side-effect trigger. Mitigation: the
  dual-write trigger with `ON CONFLICT DO NOTHING`, the suppression guard on the backfill, the drift report, and a
  snapshot + rollback.
- The bot user id `…0001` equals the vitana tenant id literal; counted as a member, it would skew seat counts.
  Mitigation: the backfill and drift report exclude it and `service_bot_accounts`, with a pgTAP zero-side-effect
  check.
- Hook latency or errors on login. Mitigation: shadow-only here, fail-open, a single indexed lookup, a short statement
  timeout and a 7-day mismatch soak before any go-live.
- `is_member()` per-row cost on the tenant-shared tables. Mitigation: the unique index probe and the EXPLAIN bound on
  `live_rooms`.
- The dev-auth 503 changes dev-sandbox behaviour when the registry is down. Mitigation: `DEV_TENANT_ID` still
  overrides, and the change is visible in the response instead of a silent null bootstrap.

## Out of scope
- The access-token hook GO-LIVE (emitting a real `tenant_id`) and its Supabase auth-config enablement and disable
  runbook. That is a separate later lane, owner-applied per D14.
- Redefining `current_tenant_id()` as an alias of `tenant_id_for_policies()` (the final go-live migration, a later
  lane).
- Tightening tenant-shared write policies from "any member" to admins only.
- WS2 data cleanup, WS3 community/network isolation, the WS0 CI lint and isolation-suite wiring (mt-guardrails-r2),
  and the health-table policy move to `user_id = auth.uid()` (WS10). Each has its own spec.
- Creating or hardening RLS on the 5 no-policy tables named above (WS2/WS10).
- Cleaning the other gateway `…0001` literals (ratcheted, WS2) and moving every ad-hoc `is_primary` read.

## Depends on
- Done: VTID-05147 (S-M), VTID-05149 (A: `tenants.is_default`/`is_platform`, `TenantContext`, resolver),
  VTID-05150, VTID-05151, VTID-05270 (`services/mt-flags.ts`).
- Cross-spec: O1 (this spec OWNS the canonical `isHealthTable()`). mt-guardrails-r2 lints with it, and
  mt-native-health references it.

## Owner decisions
Cited, already decided: N2 and N3 (program decision register), and D14 (the hook is applied by the owner only; go-live
stays out of this spec). Owner instruction 2026-11-01, "you make the decisions for me": re-plan under a new slug
rather than approve as escalated. No new owner decision proposed.
<!-- plan:end -->

## Open questions for sparring
- Role source of truth: the role-source lane makes `user_tenants.active_role` canonical and derives
  `role_preferences` / `user_permitted_roles` from it. Is there a consumer that needs one of the others as a primary
  write path? Cross-check with mt-tenant-admin's role work.
