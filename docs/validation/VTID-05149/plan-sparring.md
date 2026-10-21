# VTID-05149 — plan sparring record (multi-tenant M0, lane A: tenant foundation)

The final plan as approved (plan body between the markers, then the planner's
binding responses), the sparring partner's output for every round verbatim,
the verdict and the owner approval. `VTID-XXXXX` in the plan text is the
placeholder used before allocation; it is VTID-05149.

---

# Lane A — Tenant foundation: default tenant flag, one primary-tenant resolver, TenantContext, isolation health RPC

change class: standard
scope:
- vitana-platform, DB:
  - new `supabase/migrations/20261014000100_vtid_05149_tenants_default_platform_flags.sql` (M1)
  - new `supabase/migrations/20261014000200_vtid_05149_signup_default_tenant.sql` (M2)
  - new `supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql` (M3)
  - new `docs/validation/VTID-05149/{rollback-m1.sql,rollback-m2.sql,rollback-m3.sql,live-before.sql,post-apply-checks.sql,functions-before.sql,plan-sparring.md,staging-tests.json,acceptance.md}`
  - new `scripts/ci/sql-tests/run-tenant-foundation-test.sh`, new `scripts/ci/sql-tests/vtid-XXXXX-tenant-foundation.test.sql`, new `.github/workflows/SQL-TENANT-FOUNDATION.yml`
  - new `docs/multitenancy/MIGRATION-QUEUE.md` (the queue file from program plan §8; it does not exist yet)
  - edit `DATABASE_SCHEMA.md` (rule 24)
- vitana-platform, gateway:
  - new `services/gateway/src/services/tenancy/tenant-context.ts` (+ `tenant-context-repository.ts`, the B1 seam pattern)
  - edit `middleware/auth-supabase-jwt.ts`, `middleware/auth-supabase-jwt-repository.ts`
  - edit `routes/auth.ts`, `routes/auth-repository.ts`
  - edit `routes/universal-cart.ts`, `routes/universal-cart-context-repository.ts`
  - new `services/gateway/test/vtid-XXXXX-tenant-context.test.ts`, new `services/gateway/test/vtid-XXXXX-tenant-foundation-migrations.test.ts`
  - edit `services/gateway/test/middleware/auth-supabase-jwt.test.ts` (2 assertions about the query shape)
- vitana-platform, CI: edit `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` (one report-only step).
- vitana-v1: no change.

Evidence base: origin/main @ e1ad8a0fd (platform), d09d66c4f (v1). Read-only checks on live DB `inmkhvwdcuyhnxkgfvsb` on 2026-10-13 (SELECT, catalog and `pg_get_functiondef` only).

<!-- plan:begin -->
## Problem
1. **The "oldest tenant" fallback is non-deterministic.** Live 2026-10-13: `maxina` (`2e7528b8…`) and `alkalma` (`73cc592f…`) both have `created_at = 2025-08-30 16:27:07.760873+00`. Today `SELECT slug FROM tenants ORDER BY created_at LIMIT 1` returns `maxina`, but only because of physical row order. Any VACUUM FULL, row update or new plan could flip new signups to Alkalma. The fallback lives in exactly three places:
   - live `handle_new_user()` (trigger `on_auth_user_created`; md5 of its definition `9599cfbf…`). It resolves `raw_user_meta_data->>'tenant_slug'` for **any** slug, then `ORDER BY t.created_at ASC LIMIT 1`, then writes `memberships`, `role_preferences` and `auth.users.raw_app_meta_data.active_tenant_id`.
   - live `provision_platform_user()` (trigger `on_auth_user_platform_provision`; md5 `6254e35b…`). It runs the same two lookups on its own, then writes `app_users`, `user_tenants` (`is_primary=true`, which fires the side-effect triggers) and `user_permitted_roles`.
   - gateway `/auth/me` auto-provision: `routes/auth.ts:653-656` calls `repo.fetchOldestTenant` (`routes/auth-repository.ts:53-55`, `.order('created_at').limit(1).single()`) and then upserts `user_tenants` with `is_primary:true` (`auth.ts:682-688`).
   - A live regex scan of every function body and of both repos finds no other "oldest tenant" query.
   - Because the two triggers look up independently, they could also pick **different** tenants on a tie.
2. **Signup can enrol into any tenant by slug.** `tenant_slug` is client-supplied signup metadata, and both triggers accept every slug. VTID-05043 limited self-enrolment through `switch_to_tenant_by_slug` to `tenants.open_signup = true` (`20261010180000_vtid_05043_…:73-82`; live: maxina and alkalma are `true`, the column default is `false`), but signup still bypasses that rule. A newly provisioned closed tenant, or the future platform tenant (program plan §4.10: "never joinable"), could be joined at signup.
   - Live distribution: 120 signups with slug `maxina` landed in maxina, 117 with no slug landed in maxina, 1 with slug `alkalma` landed in alkalma.
3. **The gateway has no shared tenant resolver and no tenant context.**
   - `resolvePrimaryTenantId` lives in `routes/universal-cart.ts:164-174` (not in the universal-cart repository, as the brief says). It calls `universal-cart-context-repository.ts:32-34`.
   - 23 call sites query `user_tenants … eq('is_primary', true)` on their own.
   - The middleware fallback is `fetchPrimaryTenantForUser` (`middleware/auth-supabase-jwt-repository.ts:34-36`). It is `.single()`, not `limit(1)`, so program plan §2/§4.2's citation of `:510-520 limit(1)` is out of date. It is used at `auth-supabase-jwt.ts:623` (`requireTenant`) and `:712` (`requireAuthWithTenant`). `.single()` returns nothing for 0 primary rows and an error for 2 or more, so both cases end in 400 `TENANT_REQUIRED`.
   - `SupabaseIdentity.tenant_id` is the only tenant carrier (`:34-47`, set from `app_metadata.active_tenant_id` at `:273`).
   - There is no slug, role, source or platform flag, so the later slices (tenantDb, the access-token hook, platform context) have nothing to build on.
   - VTID-05043's membership check (`:512-589`) stays as it is.
4. **There is no production isolation signal.** M0's exit criterion needs `ci_tenant_isolation_health()` (program plan §1 and WS0), and it does not exist. Live baseline 2026-10-13, read-only, 258 base tables with a uuid `tenant_id` (excluding `tenants`):
   - 3,628 rows in 19 tables point at a tenant that does not exist. Examples: memory_facts 1,067, mem_facts 1,066, vitana_index_scores 708, chat_messages 305, memory_items 138.
   - 2,158 rows in 22 tables have a NULL tenant_id. Examples: jev_shadow_decisions 646, profiles 238, user_journey 236.
   - Memberships: 238 users in `user_tenants`, 0 with zero primary rows, 0 with two or more, 3 with several memberships, 0 auth users without a `user_tenants` row.
   - Drift between the two membership tables: 0 rows only in `memberships`, 18 only in `user_tenants`.
   - 32 more tables have a text `tenant_id` (VCAOP etc.).
   - A one-pass count over all 258 tables took 0.32 s. Requests through PostgREST run under the `authenticator` role, whose `statement_timeout` is 8 s, so the budget holds.
5. **Side-effect triggers that must not change.** `user_tenants` has four AFTER INSERT triggers (`welcome_chat_on_primary_membership`, `founding_seat_on_primary_membership`, `seed_onboarding_autopilot_on_primary_membership`, `trg_create_user_live_room`). Each is guarded by `is_primary AND NOT membership_side_effects_suppressed()`. This slice changes none of them, and none of the inserts that reach them change shape.

## Fix
1. **M1, columns (inert on apply).**
   - New columns: `tenants.is_default boolean NOT NULL DEFAULT false` and `tenants.is_platform boolean NOT NULL DEFAULT false`.
   - `CHECK (NOT (is_default AND is_platform))`.
   - At most one default: partial unique index `tenants_one_default ON tenants ((true)) WHERE is_default`.
   - At least one default: deferred constraint trigger `tenants_exactly_one_default` (AFTER INSERT/UPDATE OF is_default/DELETE, `DEFERRABLE INITIALLY DEFERRED`) runs `tenants_assert_one_default()`, which raises at commit unless exactly one row has `is_default`. That function is SECURITY DEFINER with `search_path` pinned and `REVOKE ALL … FROM PUBLIC, anon, authenticated`; the harness proves the trigger still fires for an `authenticated` UPDATE.
   - `UPDATE tenants SET is_default = true WHERE slug = 'maxina'`.
   - **Statement order inside M1 (one transaction):** add both columns → CHECK → partial unique index → create the trigger function → create the constraint trigger → the maxina UPDATE, last. Correctness relies on the trigger being DEFERRABLE INITIALLY DEFERRED, so it evaluates at COMMIT, after the UPDATE; the harness runs M1 on a copy of the 2-row table and asserts it commits.
   - The platform tenant **row** is not created here (later slice, see Out of scope).
2. **M2, signup triggers.** `CREATE OR REPLACE` both functions with the live bodies verbatim plus exactly these changes:
   - (a) The slug lookup adds `AND t.open_signup AND t.is_active AND NOT t.is_platform`. This is the same rule as `switch_to_tenant_by_slug`, and maxina and alkalma are both open and active, so their results are identical.
   - (b) `ORDER BY t.created_at ASC LIMIT 1` becomes `WHERE t.is_default LIMIT 1`.
   - (c) If there is still no tenant, `RAISE WARNING 'VTID-05149: no default tenant for %', NEW.id`. It never raises an exception, so a broken default can never block `auth.users` inserts and with them every signup.
   - Nothing else changes: column lists, `ON CONFLICT`, `is_primary=true`, the `memberships`/`role_preferences`/`app_metadata` writes and the `SET search_path`.
   - ACL left as is, with a `-- definer-public:` line explaining why: these are trigger functions that Postgres refuses to call directly, and touching their grants is outside a byte-identical signup change.
3. **Gateway `services/tenancy/tenant-context.ts`, the single implementation.**
   ```ts
   export type TenantSource = 'token' | 'exafy_admin_token' | 'primary' | 'membership_fallback';
   export interface TenantContext { tenantId: string; slug: string | null; role: string | null; source: TenantSource; isPlatform: boolean; }
   export async function resolvePrimaryTenant(userId: string, opts?: { signal?: AbortSignal }):
     Promise<PrimaryTenantResult>;
   export type PrimaryTenantResult =
     | { status: 'found'; tenantId: string; role: string | null; source: 'primary' | 'membership_fallback' }
     | { status: 'none' }          // the user has no membership
     | { status: 'unavailable' };  // lookup error, timeout or abort
   export async function getTenantMeta(tenantId: string): Promise<{ slug: string; isPlatform: boolean; isDefault: boolean } | null>;
   export async function getDefaultTenantId(): Promise<string | null>;
   ```
   - **Query.** `resolvePrimaryTenant` runs one `user_tenants select('tenant_id, active_role, is_primary') .eq('user_id') .order('is_primary',{ascending:false}) .order('created_at') .order('tenant_id') .limit(1)` with an abort signal. The result is deterministic: `is_primary` first, then the oldest membership, then `tenant_id`. A non-primary hit returns `source:'membership_fallback'` and logs `{event:'tenant_primary_missing'}` (live: 0 users).
   - **Result type.** A tagged union (`status`), not a mix of object/null/string, so the two failure meanings ("no membership" vs "could not look it up") cannot be confused. Every caller switches on `status` with an exhaustive `default: { const _x: never = r; }` branch, so a new variant is a compile error; a unit test covers each variant in each caller.
   - **Tenant metadata.** `getTenantMeta` and `getDefaultTenantId` read `tenants select('tenant_id, slug, is_default, is_platform')` into a 60 s in-process cache (2 rows today). They never cache an error. Accepted staleness: each ECS task holds its own cache, so a change to `is_default`/`is_platform` reaches every task within 60 s (documented in the module header; changing the default tenant is a rare, migration-driven action, and the signup triggers in the DB never use this cache).
   - **Seam.** The queries live in `tenant-context-repository.ts`.
4. **Middleware (additive).**
   - `AuthenticatedRequest` gains `tenant?: TenantContext`.
   - In `requireTenant` and `requireAuthWithTenant`, `repo.fetchPrimaryTenantForUser` (`:623`, `:712`) is replaced by `resolvePrimaryTenant`. The same `AUTH_LOOKUP_TIMEOUT_MS` abort applies, and the same "not resolved → 400 TENANT_REQUIRED" path follows.
   - `fetchMembershipForUserTenant` selects `tenant_id, active_role`, and the 60 s positive cache stores the role with the expiry. The VTID-05043 semantics stay: never cache a negative, 403/503, and log mode.
   - After the tenant is final, both functions set `req.tenant`:
     - `source` is `token` (membership-verified), `exafy_admin_token` (unverified, role `null` unless the cached lookup has it), or what the resolver returned.
     - `slug` and `isPlatform` come from `getTenantMeta`. If the metadata is unavailable, `slug` is `null`, `isPlatform` is `false` and a warning is logged; the request is not failed.
   - `req.identity.tenant_id` keeps exactly the value it gets today, so all existing readers keep working.
   - `requireAuth`/`optionalAuth` do **not** add a per-request DB call. Instead, an exported `getTenantContext(req)` resolves lazily and memoises on `req.tenant` for routes that need it later.
   - `fetchPrimaryTenantForUser` is removed from the repository once no caller is left.
   - `routes/auth-repository.ts:32-33` `fetchPrimaryTenantMembership` (caller `auth.ts:279`, login welcome) stays untouched in this slice; only `fetchOldestTenant` in that file is deleted. Moving it to the resolver belongs to the tenantDb slice with the other `is_primary` readers.
5. **`routes/auth.ts` auto-provision.** `fetchOldestTenant` becomes `getDefaultTenantId()`. If there is no default, it logs `{event:'default_tenant_unresolved'}` and creates no membership; the profile upsert is unchanged, with `tenant_id: null`. There is no oldest fallback left in code, so `fetchOldestTenant` is deleted.
6. **`routes/universal-cart.ts`.** `resolvePrimaryTenantId` keeps its export and signature and delegates to `resolvePrimaryTenant`. Once that delegation is in place, `universal-cart-context-repository.ts:32-34` (`fetchPrimaryTenantId`, whose only caller is `resolvePrimaryTenantId`) has no caller and is removed in the same commit. The other 21 `is_primary` readers move to the resolver in Lane B's tenantDb slice (Out of scope).
7. **M3, `public.ci_tenant_isolation_health() RETURNS json`.**
   - Declaration: `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog`. `REVOKE ALL … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO service_role`.
   - It reads counts and table names only, never row content.
   - Table list: computed at run time from `information_schema.columns` (`table_schema='public'`, `column_name='tenant_id'`, `data_type='uuid'`, base tables, excluding `tenants`).
   - Each table is scanned once with `EXECUTE format('select count(*) filter (where tenant_id is not null and tenant_id not in (select tenant_id from public.tenants)), count(*) filter (where tenant_id is null) from public.%I', t)`. Each table runs in its own `BEGIN … EXCEPTION WHEN OTHERS` block, so one failing table is reported in `scan_errors` instead of failing the whole call.
   - Returns:
     - `generated_at`, `tables_scanned`, `text_tenant_id_tables`
     - `foreign_tenant_rows`, `foreign_tenant_tables` (top 25, `{table, rows}`)
     - `null_tenant_rows`, `null_tenant_tables` (top 25)
     - `users_zero_primary`, `users_multi_primary`, `auth_users_without_membership`
     - `memberships_not_in_user_tenants`, `user_tenants_not_in_memberships`
     - `default_tenant_count`, `platform_tenant_count`
     - `scan_errors`
   - The "row tenant ≠ owner's membership" metric is deferred to WS2. Measured 2026-10-13: 4,490 rows in 168 tables, 3.2 s on its own, which would put the core call at risk of the 8 s timeout.
8. **Morning check.**
   - A new step `'21b. Tenant isolation health (report-only, VTID-05149)'` is placed between check 21 and check 22.
   - It calls the RPC the same way as `ci_memory_health` (`MORNING-SYSTEM-HEALTH-CHECK.yml:491-531`) and appends `| 21b | Tenant isolation health | INFO | foreign X (top: …), null Y, primary 0/2+: a/b, drift m/u, default=1 |`.
   - It **never writes `| FAIL |`**. HTTP ≠ 200 gives `INFO … RPC HTTP n (not applied yet?)`. `TOTAL_CHECKS` stays 22, the publish/gate step counts only `| FAIL |` rows, and so nothing new pages anyone.
9. **Docs.**
   - `DATABASE_SCHEMA.md`: the two columns, the index, the constraint trigger and the RPC.
   - `docs/multitenancy/MIGRATION-QUEUE.md` is created with three entries: M1 → M2 → M3 (owner lane A, rollback ids, apply window). The PR body states that every concurrent multi-tenant lane (B, C, S-M) must add its migrations to this file in the same PR; the sibling plans reference it. A CI check enforcing it is out of scope (WS0 lint slice).

## Migrations
All three use `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;`. They are applied in the order M1 → M2 → M3, each through `RUN-MIGRATION.yml` (`workflow_dispatch`, `migration_file=…`). They run as `postgres`, so the in-file guards are the protection.

- **M1** `20261014000100_vtid_05149_tenants_default_platform_flags.sql` (expand; no reader until M2 and the gateway deploy).
  - Pre-guard `DO`: raise unless there are exactly 2 tenants, exactly one `slug='maxina'`, and `is_default` does not yet exist (`information_schema`).
  - Body as in Fix 1.
  - Self-check: raise unless `count(*) FILTER (WHERE is_default) = 1` and that row is maxina.
  - The ACCESS EXCLUSIVE lock from `ALTER TABLE` is held for milliseconds on a 2-row table. `ADD COLUMN … DEFAULT false` causes no rewrite on PG 17.4.
  - Rollback `rollback-m1.sql`: drop the trigger, the function, the index, the CHECK and both columns. **Only after R2 and after the gateway is reverted.**
- **M2** `20261014000200_vtid_05149_signup_default_tenant.sql`.
  - Pre-guard: `md5(pg_get_functiondef('public.handle_new_user()'::regprocedure)) = '9599cfbfa7d9f8532ea1564df99e430f'`, the same check for `provision_platform_user()` = `'6254e35b2765d8edd5976ec5b9eec4f3'`, and exactly one `is_default` row. If live has drifted, the migration aborts and the bodies are re-read; nothing is clobbered. **Drift runbook:** never force or edit the guard at apply time. Re-read both live definitions, rebuild M2 and its rollback from them, re-run the harness (golden + rollback rehearsal), and ship that as a follow-up PR under the same VTID before applying. The window between merge and apply is kept short (apply in the next approved window after Gate 2) so drift is unlikely; `live-before.sql` re-checks the md5s right before the window.
  - Body as in Fix 2.
  - Post-guard: both definitions contain `is_default` and `open_signup`, and contain no `created_at ASC`.
  - Rollback `rollback-m2.sql`: the two captured live definitions, verbatim from `functions-before.sql`. It is pre-approved and rehearsed in the harness.
- **M3** `20261014000300_vtid_05149_ci_tenant_isolation_health.sql`. Creates the function and the grants as in Fix 7. Rollback `rollback-m3.sql`: `DROP FUNCTION`.
- **Pre-check `live-before.sql`** (read-only, re-run right before the apply window):
  - the tenants rows and columns;
  - the two md5s;
  - the trigger list on `auth.users` and `user_tenants` (expected: the 7 AFTER INSERT triggers on `auth.users` and the 4 on `user_tenants` listed in the evidence);
  - primary-membership counts (0/0);
  - `SELECT slug FROM tenants ORDER BY created_at LIMIT 1` (still `maxina`).
- **Post-check `post-apply-checks.sql`** (read-only):
  - `is_default` only on maxina, `is_platform` false everywhere;
  - the new md5s recorded;
  - `has_function_privilege('anon'|'authenticated', 'public.ci_tenant_isolation_health()', 'EXECUTE') = false`, and `service_role` = true;
  - calling the RPC as `postgres` returns every key, with `foreign_tenant_rows` ≈ 3,628 and `default_tenant_count` = 1;
  - **24 h later**: every `auth.users` row created after the apply has exactly one primary `user_tenants` row, in maxina or in its open slug's tenant, and a `memberships` row in the same tenant.

## Tests
1. **SQL harness**: `scripts/ci/sql-tests/run-tenant-foundation-test.sh` + `vtid-XXXXX-tenant-foundation.test.sql`, run against a throwaway `postgres:16` by `SQL-TENANT-FOUNDATION.yml`, the same pattern as `SQL-MEMORY-FUNCTIONS-MIGRATE-REVOKE.yml`. The script refuses `*supabase*|*amazonaws*|*rds*` hosts.
   - **Fixture:**
     - minimal `auth.users`, `tenants` (maxina, alkalma, `closedco` with `open_signup=false`, both pilot tenants with the same `created_at`), `profiles`, `global_community_profiles`, `memberships`, `role_preferences`, `app_users`, `user_tenants`, `user_permitted_roles`;
     - a stub `allocate_vitana_id`;
     - the real `membership_side_effects_suppressed()`;
     - the four `user_tenants` triggers bound to stub functions that log `(trigger, user_id, tenant_id)` into `side_effect_log`.
   - **Golden (Maxina unchanged):** load `functions-before.sql`, insert 4 users (no slug, `maxina`, `alkalma`, unknown slug) and snapshot every written row except generated ids and timestamps, plus `side_effect_log`. Reset, apply M1+M2, insert the same 4 users, snapshot again. The two snapshots must be **identical**: same tenant per user, same rows in all 7 tables, same `app_metadata`, and 4 side-effect rows per signup in the same order.
   - **Determinism:** with alkalma inserted physically first, a no-slug signup lands in maxina under M2. With the old bodies the harness documents the tie.
   - **Hardening:** slug `closedco` lands in the default tenant. A tenant with `is_platform=true`, as the slug, lands in the default. An inactive tenant lands in the default.
   - **Invariants:**
     - a second `is_default=true` gives a unique violation;
     - `UPDATE … SET is_default=false` on the only default fails at COMMIT;
     - swapping the default inside one transaction succeeds;
     - `is_default AND is_platform` gives a CHECK violation;
     - an UPDATE as `authenticated` with tenants RLS stubbed open still fires the deferred trigger with EXECUTE revoked.
   - **No default:** with the constraint trigger disabled inside the test only, a signup still succeeds, a WARNING is emitted, and no membership is created.
   - **RPC:** a fixture with 2 foreign rows, 1 NULL row, a user with 0 primaries, a user with 2 primaries and a memberships-only row gives exact counts. A table that errors appears in `scan_errors`. `anon`/`authenticated` get `permission denied`, and `service_role` succeeds.
   - **Rollback:** R3 → R2 → R1 restores the before-snapshot. Re-applying M1 aborts on its pre-guard.
2. **Jest** `test/vtid-XXXXX-tenant-context.test.ts`, using the per-table thenable fake from `test/middleware/auth-supabase-jwt.test.ts:30-45`:
   - **Resolver:** order calls are `is_primary desc, created_at, tenant_id` with `limit(1)`; 0 rows gives `null`; an error or abort gives `'unavailable'`; a non-primary hit gives `membership_fallback` plus a log line.
   - **Middleware:**
     - Maxina member, token tenant = maxina: `req.tenant = {tenantId: maxina, slug:'maxina', role:'community', source:'token', isPlatform:false}` and `req.identity.tenant_id` unchanged.
     - No claim: `source:'primary'` and the same `identity.tenant_id` as before.
     - exafy_admin: `exafy_admin_token`.
     - Cognito identity: `primary`.
     - Two primary rows: deterministic, no longer 400.
     - Metadata unavailable: `req.tenant.slug === null` and the request still succeeds.
     - The VTID-05043 403/503/log-mode cases are unchanged.
   - **`/auth/me` auto-provision:** the tenants fake returns alkalma first with an identical `created_at` and maxina `is_default`, and the upsert targets maxina. No `tenants … order('created_at')` call is made anywhere (source pin). With no default, no `user_tenants` upsert happens and a log line is written.
   - **`resolvePrimaryTenantId`** (universal-cart) returns the resolver's tenant.
   - **Morning row:** the step's own bash runs against fixture RPC replies (the VTID-05088 technique). The cases are 200 with counts, 404, and malformed JSON. The output always contains `| INFO |` and never `| FAIL |`, and `TOTAL_CHECKS: 22` is unchanged.
3. **Jest** `test/vtid-XXXXX-tenant-foundation-migrations.test.ts`, static pins:
   - `BEGIN`/`COMMIT`/`lock_timeout` in all three files;
   - M2 contains both md5 guards and no `ORDER BY t.created_at`;
   - the M2 diff against `functions-before.sql` is limited to the slug/default/warning lines;
   - M3 has the REVOKE and GRANT lines and selects no content column;
   - the rollback files exist.
4. **Existing suites that must stay green:**
   - `test/middleware/auth-supabase-jwt.test.ts`: the assertions at `:516` and `:620` (`eq('is_primary', true)`) are updated to the new order/limit shape. This is a deliberate contract change of the query, not of behaviour; the PR says so.
   - the VTID-05043 suites, `test/vtid-05041-definer-lockdown.test.ts` (M1/M3 revoke; M2 `definer-public` reason), `universal-cart.test.ts`, `routes/auth-cognito.test.ts`, `vtid-04345`, `vtid-04787`, `vtid-05088`;
   - `npm run test:roles` (no new route file);
   - `npm run test:support` and `npm run test:operator`, because every authenticated route passes through the middleware;
   - gateway `tsc` and lint, and `MIGRATION-DRIFT-CHECK`.

## Staging verification
`docs/validation/VTID-05149/staging-tests.json`. Every probe is read-only and unauthenticated.
- `GET /api/v1/auth/health` returns 200 JSON.
- `GET /api/v1/auth/me` without a token returns 401 `{ok:false,error:'UNAUTHENTICATED'}`.
- `GET /api/v1/autopilot/prefs` without a token returns 401 JSON. This proves the middleware module loads with the new import.
- build-info shows the merged commit.
- `existing`: the jest files from Tests 2 and 3 and the SQL harness command, with the reason "tenant resolution and signup are proven here, never by writes on staging (one Supabase project)".
- No sign-in and no signup probe: a signup would write production rows (rules 31/48).

## Rollout
1. **One PR** with the migrations, rollbacks, harness, gateway code, tests and workflow step. CI must be green, including `SQL-TENANT-FOUNDATION`. Then merge.
2. **Apply window (off-peak).** The Gate 1 "yes" covers these dispatches; there is no separate ask.
   - Run `live-before.sql` and continue only if it matches the evidence.
   - Dispatch `RUN-MIGRATION.yml` for M1, then M2, then M3, running the post-check after each.
   - **The DB part goes first.** M1 must be live before the gateway reads `is_default`. If the gateway ran without M1, `getDefaultTenantId` would return null, auto-provision would skip the membership (logged), and `getTenantMeta` would answer with slug `null`. No request fails, but this order avoids it.
3. **Gateway.** Staging deploy → STAGING-VERIFY on the merge commit → Gate 2 with the commit range against production build-info and the three migrations listed → production deploy pinned to the verified commit → post-deploy check.
4. **Next morning.** The 21b row shows the baseline. The 24 h signup post-check is run and recorded in `acceptance.md`.
5. **No flag.**
   - `req.tenant` has no reader yet.
   - The resolver changes behaviour only for 0- or 2+-primary users (0 live).
   - The default-tenant swap returns maxina, as today.
   - Rollback is a code revert (gateway), then R2, then R1 if needed. R3 is independent.

## Risks
- **Signup path (every new member).** Mitigated by:
  - the md5 drift guard;
  - a body diff limited to three lines;
  - the before/after golden harness, including side-effect trigger order;
  - WARNING-only failure;
  - the rehearsed verbatim rollback;
  - the 24 h post-check.
- **Behaviour change for a closed/inactive/platform slug at signup.** No live tenant is affected (both are open and active). A new tenant created with `open_signup=false` gets signups-by-slug routed to Maxina until it is opened or invited. This is intended and consistent with S-E.
- **Constraint trigger on `tenants`.** An exafy_admin edit that leaves zero defaults fails at commit; this is the intended loud failure.
- **The middleware is on every authenticated request.** The query count is unchanged (one membership/primary lookup, the same timeout); `getTenantMeta` is cached, and its failure never fails a request.
- **The RPC's runtime grows with the tables.** Today 0.32 s against an 8 s budget. Per-table errors are isolated, and the morning row can never page.
- **`MIGRATION-QUEUE.md` is new.** Other lanes must start using it (program plan §8).

## Out of scope
- **Lane A, next slices:**
  - the platform tenant row (`slug='vitanaland-platform'`), signup-intent branching and the `platform_only_accounts` view (platform-tenant slice);
  - the access-token hook, `tenant_id_for_policies()`, `is_member()` (hook-shadow slice);
  - RLS, `current_tenant_id()` and `caller_tenant_id()`;
  - `memberships` → view and dual-write;
  - `bootstrap_admin`.
- **Lane B tenantDb slice:**
  - moving the other 21 `is_primary` readers and `routes/auth.ts:279` (login welcome) to `resolvePrimaryTenant`;
  - attaching `req.tenant` in `requireAuth`/`optionalAuth`;
  - per-tenant `settings` on TenantContext (program plan §4.4).
- **WS2:** the owner-membership mismatch metric and the cleanup that drives `foreign_tenant_rows` to 0.
- **Paging thresholds:** a later slice, once WS2 brings the counts to 0.
- **Earthlinks leftovers** (`routes/me.ts`, `dev-auth.ts`, `live-tool-catalog.ts:409`): none are in the files this slice touches, so they belong to the WS1 slug-map slice.

## Owner decisions
None. The default tenant (Maxina), the platform flag, the report-only monitoring and the `open_signup` rule all follow the program register (§4.1, §4.10, WS0) and VTID-05043.
<!-- plan:end -->

## Planner responses — round 1
- F1 (minor, observation) — ACKNOWLEDGED. No change: the tests assert the query chain shape.
- F2 (minor) — ACCEPTED. Fix 6 now says the repository function is removed only once the delegation leaves it without a caller (it has exactly one today).
- F3 (major) — ACCEPTED. Fix 1 states the statement order inside M1 (columns → CHECK → index → function → constraint trigger → maxina UPDATE last) and that correctness relies on the DEFERRABLE INITIALLY DEFERRED trigger evaluating at COMMIT; the harness asserts M1 commits on the 2-row fixture.
- F4 (major) — ACCEPTED. `resolvePrimaryTenant` returns a tagged union `{status:'found'|'none'|'unavailable'}`; callers switch exhaustively with a `never` default; unit tests per variant per caller.
- F5 (minor) — ACCEPTED. The 60 s per-task staleness is documented in Fix 3 and the module header; the DB signup path never uses the cache.
- F6 (minor) — DEFERRED to the WS0 alerting slice (program plan §6 WS0, "ci_tenant_isolation_health wired into MORNING-SYSTEM-HEALTH-CHECK"). This slice is deliberately report-only; an RPC HTTP error is shown as an INFO line naming the status so it is visible in the morning report.
- F7 (minor) — ACCEPTED. Fix 9: the PR body requires every concurrent lane (B, C, S-M) to add its migrations to MIGRATION-QUEUE.md in the same PR; the sibling plans will reference it. CI enforcement deferred to the WS0 lint slice.
- F8 (major) — ACCEPTED. The M2 entry now carries an explicit drift runbook: never force the guard; re-read, rebuild M2 + rollback, re-run harness, follow-up PR under the same VTID, then apply; apply in the first approved window after Gate 2; `live-before.sql` re-checks the md5s right before.
- F9 (minor, observation) — ACKNOWLEDGED. No change.
- F10 (minor) — ACCEPTED. Fix 4 states `fetchPrimaryTenantMembership` (`auth-repository.ts:32-33`) stays untouched; only `fetchOldestTenant` is deleted from that file.

---

## Sparring partner output (verbatim)

# Partner output — round 1 (verbatim)

Good, single caller -- safe to delete. Now I have enough to write the review.

## Verified premises

- **"fetchOldestTenant at auth-repository.ts:53-55 uses ORDER BY created_at LIMIT 1"** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/routes/auth-repository.ts:53-54` confirms `.order('created_at', { ascending: true }).limit(1).single()`.

- **"fetchPrimaryTenantForUser at middleware/auth-supabase-jwt-repository.ts:34-36 uses .single(), not limit(1)"** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/middleware/auth-supabase-jwt-repository.ts:34-35` confirms `.eq('is_primary', true).abortSignal(signal).single()`.

- **"resolvePrimaryTenantId lives in routes/universal-cart.ts:164-174 and calls universal-cart-context-repository.ts:32-34"** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/routes/universal-cart.ts:164-173` calls `ctxRepo.fetchPrimaryTenantId`, and `/home/user/vitana-platform/services/gateway/src/routes/universal-cart-context-repository.ts:32-33` is the repository function.

- **"23 call sites query user_tenants eq('is_primary', true) on their own"** --> TRUE -- grep across `services/gateway/src` (excluding tests) returns exactly 23 non-test hits.

- **"SupabaseIdentity.tenant_id set from app_metadata.active_tenant_id at :273"** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/middleware/auth-supabase-jwt.ts:273`.

- **"VTID-05043 added tenants.open_signup at migration lines 73-82 with maxina and alkalma set true"** --> TRUE -- `/home/user/vitana-platform/supabase/migrations/20261010180000_vtid_05043_s3_membership_side_effect_guard.sql:73,82`.

- **"TOTAL_CHECKS is 22 at line 90 of the morning health check"** --> TRUE -- `/home/user/vitana-platform/.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml:90`.

- **"The auth-supabase-jwt.test.ts assertions at :516 and :620 check eq('is_primary', true)"** --> TRUE -- `/home/user/vitana-platform/services/gateway/test/middleware/auth-supabase-jwt.test.ts:516,620`.

## Findings

**F1 [minor] The plan cites `fetchPrimaryTenantForUser` usage at auth-supabase-jwt.ts `:623` and `:712` but the test file has no grep hits for `fetchPrimaryTenantForUser` -- it asserts on the query shape (`eq('is_primary', true)`), not the function name.**

Evidence: The plan says it will update assertions at `:516` and `:620` "to the new order/limit shape." This is consistent -- the tests assert on the chain's `.eq` calls, not the function name. Not a factual error in the plan, just confirming the test approach is correct.

Suggestion: No action needed; this is an observation, not a problem.

**F2 [minor] The plan proposes to delete `universal-cart-context-repository.ts:32-34` (`fetchPrimaryTenantId`) but this function has callers beyond `resolvePrimaryTenantId` in `universal-cart.ts`.**

Evidence: The plan says "The unused `universal-cart-context-repository.ts:32-34` is removed." But at `/home/user/vitana-platform/services/gateway/src/routes/universal-cart.ts:167`, `ctxRepo.fetchPrimaryTenantId` is called from `resolvePrimaryTenantId` which the plan is refactoring to delegate to the new resolver. The function itself IS only called from that one place in `universal-cart.ts`, so "unused after the refactor" is correct if the delegation change makes it no longer needed. The wording is slightly misleading -- it is not "unused" today, it becomes unused after the refactor.

Suggestion: Clarify that the deletion is conditional on the delegation refactor being in place. This is cosmetic.

**F3 [major] The deferred constraint trigger `tenants_exactly_one_default` uses `DEFERRABLE INITIALLY DEFERRED` semantics, but the plan says M1 both adds the column AND sets `is_default = true` on maxina. If M1 runs as a single transaction, the trigger fires at COMMIT. However, the initial state has zero `is_default = true` rows (the column is added with `DEFAULT false`) and the UPDATE happens in the same transaction. The trigger function `tenants_assert_one_default()` checks "exactly one row has `is_default`" -- but the plan needs to ensure the ADD COLUMN and the UPDATE both happen BEFORE the trigger fires at commit. Since the trigger is `AFTER INSERT/UPDATE OF is_default/DELETE`, the question is: does `ADD COLUMN ... DEFAULT false` fire the trigger for every existing row? In PostgreSQL 11+, `ADD COLUMN ... NOT NULL DEFAULT` does NOT rewrite the table and does NOT fire triggers. If the trigger is created AFTER the column addition but BEFORE the UPDATE, then the UPDATE fires the trigger (deferred to commit) and at commit time exactly one row has `is_default = true`. This is correct. BUT: the partial unique index `tenants_one_default ON tenants ((true)) WHERE is_default` -- if the index is created before the UPDATE, it is fine because no row has `is_default = true` yet. If created after, also fine. So the ordering within M1 must be: (1) add columns, (2) add CHECK, (3) add partial unique index, (4) create trigger function, (5) create trigger, (6) UPDATE maxina. The plan does not state this ordering explicitly.**

Evidence: The plan says "Body as in Fix 1" but does not detail the DDL ordering within M1. A misordering (e.g., trigger created before the UPDATE, but the UPDATE must be the last statement) is a transaction-level concern. With `DEFERRABLE INITIALLY DEFERRED`, the constraint trigger fires at COMMIT, not at statement time, so the ordering of DDL within the transaction is less critical as long as all DDL and DML happen before COMMIT. This makes it safe, but only because the trigger is deferred.

Suggestion: Explicitly state in the plan that within M1, the UPDATE that sets `is_default = true` on maxina runs after the trigger and index are created, and that correctness depends on the deferred trigger checking at COMMIT (after the UPDATE). This removes ambiguity for the implementer.

**F4 [major] The plan proposes `resolvePrimaryTenant` returns `'unavailable'` as a string union member alongside `null` and the object. The middleware then branches on string equality. This creates a fragile API surface: a consumer can easily forget to handle `'unavailable'` vs `null`, and TypeScript will not warn unless they exhaustively match the union. The existing pattern (`fetchPrimaryTenantForUser`) returns a Supabase response `{data, error}`, and the error path is well understood.**

Evidence: Plan line 70: `Promise<{ tenantId: string; ... } | null | 'unavailable'>`. A three-way union of object, null, and string is unusual in this codebase. The existing patterns use `{data, error}` pairs (Supabase convention) or throw.

Suggestion: Consider returning `{data: ..., error?: 'unavailable'}` or throwing on truly unavailable (abort/network error) to match the codebase's existing conventions. If the string union is deliberate (to distinguish "no primary membership" from "could not reach DB"), document it as a conscious deviation and ensure the middleware exhaustively matches both cases with a compile-time check (e.g., `satisfies never` in the default branch).

**F5 [minor] The plan says the 60s cache for tenant metadata is "in-process" and holds "2 rows today." With multiple ECS tasks, each has its own cache. A tenant metadata update (e.g., changing `is_default`) takes up to 60s to propagate per task. This is acceptable for a 2-row table that changes almost never, but should be documented as a known staleness window.**

Evidence: Plan line 75: "60 s in-process cache (2 rows today). They never cache an error."

Suggestion: Add a one-line note to the implementation that the 60s staleness is accepted and that changing the default tenant requires waiting out the cache across all tasks, or restarting the service.

**F6 [minor] The plan adds step `21b` to the morning check but says it "never writes `| FAIL |`". The morning check's publish/gate step counts `| FAIL |` rows (confirmed at line 592: `$FAILS/$TOTAL_CHECKS`). Since the step never writes FAIL and TOTAL_CHECKS stays 22, the step is purely informational. This is correct and deliberate, but it means a broken `ci_tenant_isolation_health` RPC (returning garbage JSON, or timing out) is silently reported as INFO rather than paging anyone.**

Evidence: Plan line 106: "It never writes `| FAIL |`". Morning check workflow line 592 counts only FAIL rows.

Suggestion: Consider a future follow-up to page on RPC failures (HTTP errors from the function itself), even if the metric counts don't page. The plan already defers paging thresholds to a later slice; this is consistent.

**F7 [minor] The plan creates `docs/multitenancy/MIGRATION-QUEUE.md` (line 109) and says "other lanes must start using it." The program plan's section 8 queue convention does not exist yet in the repo. If other lanes are developed in parallel and do not discover this file, the queue could desynchronize.**

Evidence: No `docs/multitenancy/` directory exists yet in the platform repo (checked via the plan's own "it does not exist yet" statement on line 11).

Suggestion: The PR description should note that `MIGRATION-QUEUE.md` is created and must be consulted by any concurrent lane work. A CI check that blocks a migration file without a queue entry would be stronger but is out of scope for this slice.

**F8 [major] The plan proposes the signup trigger changes only affect `handle_new_user()` and `provision_platform_user()`, and says it verifies them with md5 checksums of their current definitions. But the plan does not address what happens if the live function bodies have drifted since the evidence was captured (2026-10-13). The md5 guard in M2 is the protection, and the plan says "If live has drifted, the migration aborts." However, a drifted function means the new bodies (with the `is_default`/`open_signup` changes) would be based on stale definitions. The plan captures the live bodies in `functions-before.sql` -- but does it re-read them at apply time, or does it bake them in at PR time?**

Evidence: Plan line 121-124: M2 pre-guard checks md5, and the rollback uses `functions-before.sql` "verbatim." The plan does NOT say `functions-before.sql` is generated at apply time; it appears to be generated at PR time based on the 2026-10-13 evidence. If another VTID modifies these functions between PR creation and apply, M2 will correctly abort (md5 mismatch), but the developer will need to re-read the functions and rebuild M2.

Suggestion: Add to the rollout instructions: "If M2's pre-guard md5 check fails, do NOT manually force it. Re-read the live function bodies, rebuild M2 and its rollback, and re-test." This is implied but should be explicit.

**F9 [minor] The plan proposes a `SECURITY DEFINER` function `tenants_assert_one_default()` for the constraint trigger. It also says `REVOKE ALL ... FROM PUBLIC, anon, authenticated`. A constraint trigger function is invoked by PostgreSQL itself, not by users directly, so the REVOKE is defense-in-depth. However, the plan then says "the harness proves the trigger still fires for an `authenticated` UPDATE." This is correct: a REVOKE on the function does not prevent PostgreSQL from invoking it as a trigger -- the trigger invocation is done by the engine, not by the user's EXECUTE privilege on the function.**

Evidence: Plan line 56 and test description at line 154.

Suggestion: No change needed; the plan's reasoning is correct.

**F10 [minor] The plan says `fetchPrimaryTenantMembership` at `auth-repository.ts:33` uses `.single()`. The plan's Out of Scope says moving the 21 other `is_primary` readers (and `routes/auth.ts:279` login welcome) to the resolver is Lane B work. But `auth-repository.ts:33` (`fetchPrimaryTenantMembership`) is a DIFFERENT function from `auth-repository.ts:53` (`fetchOldestTenant`) -- both are in the same file, and this slice only touches/deletes `fetchOldestTenant`. `fetchPrimaryTenantMembership` at line 32-33 is not mentioned as staying or being touched.**

Evidence: `/home/user/vitana-platform/services/gateway/src/routes/auth-repository.ts:32-33` has `fetchPrimaryTenantMembership`, called from `auth.ts:279`. The plan's "edit" of `auth-repository.ts` only mentions deleting `fetchOldestTenant`.

Suggestion: Confirm in the plan that `fetchPrimaryTenantMembership` at `auth-repository.ts:32-33` stays untouched and is part of Lane B's migration scope. This avoids implementer confusion about which functions in that file are in scope.

## Questions for the planner

1. (Re F3) Can you confirm the DDL ordering within M1 is: add columns, add CHECK, add index, create function, create trigger, then UPDATE? And that correctness depends on the deferred trigger evaluating at COMMIT rather than at statement time?

2. (Re F4) Is the `| null | 'unavailable'` return type a conscious design choice? What is the precedent for this pattern in the gateway codebase? Have you considered returning an error variant object instead?

3. (Re F8) If the md5 guard fails at apply time, is the documented recovery path "re-read, rebuild M2, re-test, re-merge, re-apply"? That means a second PR. Is the time window between merge and apply short enough that this is unlikely, or should there be a contingency?

## Verdict

NOT CONVERGED -- three major findings (F3, F4, F8) need responses. F3 and F8 are about implementation ordering and drift resilience that need explicit acknowledgment or plan clarification. F4 is a design concern about the resolver's return type that could be accepted with reasoning. None are blockers (the md5 guard in F8 is the actual protection; the DDL ordering in F3 works with deferred triggers), but each needs a planner response before I can confirm the plan is implementable without ambiguity.

# Partner output — round 2 (verbatim)

I need to write both rounds to the file. Here is my round-2 analysis:

---

## Round 2 — Status of prior findings

- **F1** (minor, observation) — `closed`. Acknowledged by planner, no change needed.
- **F2** (minor) — `closed`. Plan Fix 6 now clarifies the deletion is conditional on the delegation leaving it without a caller.
- **F3** (major) — `closed`. Plan Fix 1 line 58 now explicitly states the DDL ordering (columns, CHECK, index, function, trigger, UPDATE last) and that correctness relies on DEFERRABLE INITIALLY DEFERRED evaluating at COMMIT. The harness assertion is specified.
- **F4** (major) — `closed`. Plan Fix 3 lines 71-80 now uses a proper tagged union `PrimaryTenantResult` with `status: 'found' | 'none' | 'unavailable'`, exhaustive switch with `never` default, and per-variant unit tests. This is a clean, idiomatic pattern.
- **F5** (minor) — `closed`. Plan Fix 3 line 81 documents the 60s per-task staleness and that signup triggers never use the cache.
- **F6** (minor) — `acknowledged`. Deferred to WS0 alerting slice. The INFO-only reporting for this slice is deliberate and documented.
- **F7** (minor) — `closed`. Plan Fix 9 line 116 states the PR body requirement and references from sibling plans. CI enforcement deferred to WS0 lint.
- **F8** (major) — `closed`. Plan M2 entry at line 128 now carries an explicit drift runbook (never force, re-read, rebuild, re-test, follow-up PR under same VTID). The apply-window discipline and `live-before.sql` re-check are specified.
- **F9** (minor, observation) — `closed`. Acknowledged, no change needed.
- **F10** (minor) — `closed`. Plan Fix 4 line 93 explicitly states `fetchPrimaryTenantMembership` stays untouched and belongs to the tenantDb slice.

## Verified premises (round 2, new checks on revised sections)

- **Tagged union type replaces the three-way union** --> TRUE in plan lines 71-80.
- **M1 DDL ordering explicitly stated** --> TRUE in plan line 58.
- **Drift runbook added to M2** --> TRUE in plan line 128.
- **`fetchPrimaryTenantMembership` explicitly scoped out** --> TRUE in plan line 93.

## Findings

No new blocker or major findings. The revisions address all three round-1 majors with concrete, verifiable changes to the plan text.

## Questions for the planner

None.

## Verdict

CONVERGED -- all three prior majors (F3, F4, F8) are closed with plan-text evidence. All minors are closed or acknowledged with a documented deferral. No new findings from the revisions.

---

## Record

- Sparring record: `e1cd7275-b9f6-49a8-b5b6-e026c4b97fb7` (plan_sparring_sessions).
- Partner: plan-sparring-partner, 2 rounds. Round 1: NOT CONVERGED (majors F3, F4, F8). Round 2: all findings
  closed or acknowledged/deferred (F6 deferred to the WS0 alerting slice). Verdict: **CONVERGED**.
- Plan hash (as recorded at Gate 1, computed before VTID substitution):
  `2f1a7b23a6c7d1e5b457e11581e01eb80606a6c85aa588c1e6eda039ab44d983`.

## Owner approval (Gate 1)
Owner approval (Gate 1): "Yes" — 2026-10-13, Claude Code session; plan hash 2f1a7b23a6c7d1e5b457e11581e01eb80606a6c85aa588c1e6eda039ab44d983 (computed before VTID substitution); sparring record e1cd7275-b9f6-49a8-b5b6-e026c4b97fb7.
