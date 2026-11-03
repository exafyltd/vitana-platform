# VTID-05465 — acceptance (mt-identity-r2 / helpers-and-policy-rewrite)

Base: `origin/main` 50e55fd3a4 (exafyltd/vitana-platform). Plan: `.kiro/specs/mt-identity-r2/plan.md` §Fix 1,
`tasks.md` group `helpers-and-policy-rewrite` (H1–H4). Evidence files in this folder: `red.txt`, `green.txt`,
`commands.log`, `pre-check.sql`, `post-check.sql`, `migration-queue-rows.md`, and `outputs/` (raw Jest and PGlite output).

## Plan amendment 1 (2026-11-02)

This lane implements `plan.md` lane 1 as amended ("Amendment 1", build finding). The bare policies do not fail closed
today: `current_tenant_id()` falls back to `app_metadata.active_tenant_id` and then to the caller's `user_tenants`
row (premise table below). That premise is unverified against the live database (AC-12). If the 20260218 body is live, every one of the 32 policies keeps today's audience, the members of the caller's one
resolved tenant, and the only change is the helper:
`tenant_id = current_tenant_id()` → `tenant_id = (select public.tenant_id_for_policies())`. No policy gains a
`user_id = auth.uid()` term and no policy uses `is_member()`. `is_member()` is still created, for later lanes.
`community_listings_select_public` keeps its `status IN (…)` term and `d42_domain_weights_select` keeps its
global-defaults term. The Jest test checks that each rewritten policy equals its original with only the helper
swapped. The `tasks.md` acceptance bullets below were written before the amendment; they are read through it (the
"cannot read a_admin's rows" and "`is_member` policies" wording is replaced by "today's audience").

## Fix-forward 1 (reviewer finding, `review: changes` on 28232f2bb7)

- Blocking: the rewrite now refuses to run unless the live `current_tenant_id()` has the 20260218 body's three markers
  (guard in `DO $pre$`, AC-12). The NOTICE lines print the first 200 characters of the live body and each marker.
- The premise that today's bare policies admit the members of the caller's resolved tenant is no longer stated as fact.
  It is unverified until `pre-check.sql` section 5 is read on the target. If the old body is live, the lane is parked
  for an owner decision.
- Non-blocking: `pre-check.sql` section 6 counts the members whose resolved tenant changes; `post-check.sql` check 2 is
  scoped to the 32 policies, check 3 is derived from pre-check section 1; AC-8 records the PGlite-plus-shim status.
- Fixture: `auth.users` rows carry `app_metadata.active_tenant_id`, so section 6 can run on the fixture; the old-body
  fixture and the guard pgTAP file are new.

## Acceptance criteria

AC-1: The change types are Database (2 migrations and 1 rollback) and Tooling/docs (the lint script, the Jest test, the pgTAP files and this folder). Status: met.
TEST: `git diff --name-only origin/main...HEAD` lists only the supabase/migrations, supabase/tests, scripts/ci, services/gateway/test and docs/validation/VTID-05465 paths.

AC-2: On event_attendance and live_room_attendance the rewritten policies keep today's audience. a_member still reads a_admin's row and exactly the 2 tenant A rows, b_member reads nothing of tenant A, and a non-member reads nothing. Status: met on a throwaway Postgres (see AC-8).
TEST: supabase/tests/mt_identity_helpers_rls.test.sql §2, run on PGlite (outputs/pglite-apply-rollback-reapply.txt, line "pgTAP rls (after rewrite)").

AC-3: On the 7 health tables a_member reads 0 of a_admin's rows, and their policies are not rewritten. Status: met on a throwaway Postgres.
TEST: supabase/tests/mt_identity_helpers_rls.test.sql §2b, in the same PGlite run.

AC-4: On the 15 shared tables only members of the resolved tenant get access (the d42 global-defaults term aside), if the live current_tenant_id() is the 20260218 body. SELECT, INSERT, UPDATE and DELETE checks pass, all 32 policies use tenant_id_for_policies(), and none uses is_member() or a new user_id / auth.uid() term. Status: met on the fixture, which copies the 20260218 body. The live audience is unverified: the premise is not confirmed on the target (AC-12; premises table, row "Browser JWTs carry no top-level tenant_id").
TEST: supabase/tests/mt_identity_helpers_rls.test.sql §3 to §5 (same PGlite run), and services/gateway/test/mt-identity-bare-policy-lint.test.ts, test "rewrites every recounted policy to tenant_id_for_policies() and nothing else".

AC-5: Same audience as origin/main, if the live body is the 20260218 body (unverified, see AC-12). With the helpers applied and the rewrite not applied, the behaviour assertions of §2 to §4 pass on origin/main's policies, and only the structural assertions fail. Status: met on the fixture. Equal audience on the live database is not established.
TEST: the pgTAP run on origin/main policies recorded in docs/validation/VTID-05465/red.txt (section "pgTAP suite on origin/main policies").

AC-6: The rewrite and rollback migrations do not name access_audit_log, consents, retrieval_traces, role_sessions or user_roles. Status: met.
TEST: services/gateway/test/mt-identity-bare-policy-lint.test.ts, test "rewrites every recounted policy to tenant_id_for_policies() and nothing else" (NO_POLICY_TABLES check).

AC-7: The lint reads 0 bare policies on this branch and 32 on origin/main, and the Jest test is red on origin/main and green here. Status: met.
TEST: `npx jest test/mt-identity-bare-policy-lint.test.ts` in services/gateway (7 of 7 pass, outputs/jest-green.txt), `node scripts/ci/bare-policy-lint.mjs` (exit 0), and the red run in outputs/jest-red-origin-main.txt.

AC-8: The migrations apply, re-apply, roll back and re-apply clean on a throwaway in-process Postgres (PGlite 0.5.14) with the fixture. The refusals and the absent-table skips hold. Status: partly met. The run uses PGlite with a minimal pgTAP shim (`no_plan`, `ok`, `is`, `finish`), not the D11 Supabase local stack with real pgTAP. Real pgTAP is still pending, and no CI runner exists for these files. The D11 stack was not available (no Docker or Postgres here). Before the apply request, the owner waives this or the files run on the D11 stack with real pgTAP.
TEST: outputs/pglite-apply-rollback-reapply.txt (PGlite run of supabase/tests/mt_identity_helpers_fixture.sql, the two migrations, the rollback and the pgTAP files).

AC-9: The PR lists the recount: 32 bare policies on 15 tables in the 673 migration files at origin/main 50e55fd3a4. Status: met.
TEST: `node scripts/ci/bare-policy-lint.mjs` over origin/main 50e55fd3a4, recorded in docs/validation/VTID-05465/red.txt.

AC-10: Nothing is applied from this PR. The migrations are files only, and the MIGRATION-QUEUE rows are in migration-queue-rows.md. Status: met.
TEST: `git diff --name-only origin/main...HEAD` (no change outside the listed paths), and docs/validation/VTID-05465/commands.log (no database, gateway, Supabase or AWS endpoint contacted).

AC-11: The PR title starts with `VTID-05465 (mt-identity-r2/helpers-and-policy-rewrite):`. Status: met.
TEST: `node scripts/ci/validate-pr-locally.cjs --title "<PR title>" --body-file <PR body file> --base main` passes the Merge Deploy Gate (the title contains the VTID).

AC-12: The rewrite refuses to run on the old `current_tenant_id()` body (20251229). The guard in `DO $pre$` reads
`pg_get_functiondef('public.current_tenant_id()')` and requires all three markers of the 20260218 body: marker 1
`v_jwt_claims->'app_metadata'->>'active_tenant_id'`, marker 2 `FROM public.user_tenants`, marker 3 `WHERE user_id =
auth.uid()`. The 20251229 body has none of them (the file has no `app_metadata` at all). Test: the rewrite file is run on
the old-body fixture (`supabase/tests/mt_identity_helpers_live_body_guard_fixture.sql`), and the pgTAP file
`supabase/tests/mt_identity_helpers_live_body_guard.test.sql` asserts the state after the refused apply. Red on the
previous head: the rewrite committed on the old body and the 32 policies read `tenant_id_for_policies()`
(`outputs/live-body-guard-red.txt`: "have 0, want 32"). Green on this head: the rewrite raises the guard message and the
pgTAP file passes 5 of 5 (`outputs/live-body-guard-green.txt`). Static check, red then green: Jest `VTID-05465 live-body
guard` (`outputs/jest-live-body-guard-red.txt`, `-green.txt`). The NOTICE lines and the pre-check reads on both bodies:
`outputs/pre-post-check-fixture.txt`. Status: met on PGlite with the shim. The live status is unverified: if pre-check
section 5 shows a false marker on the target, the rewrite refuses and **the lane is parked for an owner decision**.
TEST: supabase/tests/mt_identity_helpers_live_body_guard.test.sql on PGlite (outputs/pglite-apply-rollback-reapply.txt: the guard refuses the old-body fixture, then the rewrite runs on the 20260218 fixture), and `npx jest test/mt-identity-bare-policy-lint.test.ts` in services/gateway (outputs/jest-green.txt).

## Acceptance bullets → evidence

| Acceptance bullet (tasks.md) | Evidence | Status |
|---|---|---|
| Change types: Database, Tooling/docs | 2 migrations + 1 rollback (Database); `scripts/ci/bare-policy-lint.mjs`, Jest test, pgTAP files, this folder (Tooling/docs) | met |
| pgTAP (read through amendment 1): the attendance policies keep today's audience | `supabase/tests/mt_identity_helpers_rls.test.sql` §2: on `event_attendance` and `live_room_attendance` a_member still reads a_admin's row, as today, and reads exactly the 2 tenant A rows; b_member reads nothing of tenant A; a member of A (resolved) and B reads nothing of tenant B; a non-member reads nothing | met (throwaway Postgres, see note) |
| … and, read-only, on the health tables | same file §2b: the 7 health tables, a_member reads 0 of a_admin's rows; their policies are not rewritten | met (throwaway Postgres) |
| Shared policies on all 15 tables admit the members of the resolved tenant only | §3: SELECT on the 11 tables with a SELECT policy: a_member reads A, b_member reads B and nothing of A, a member of A (resolved) and B reads A and nothing of B, a non-member reads nothing (d42 global defaults aside); with a top-level `tenant_id` claim for B, B is the resolved tenant instead. §4: INSERT (b_member into A → 42501, a_member → ok, the A+B member into B → 42501), UPDATE (b_member 0 rows, a_member 1, moving a row to B → 42501), DELETE (b_member 0, a_member 1). §5: 32 policies on `tenant_id_for_policies()`, 0 on `is_member()`, 0 with a new `user_id` / `auth.uid()` term. | met |
| Same audience as origin/main | The same pgTAP file on origin/main's policies (helpers applied, rewrite not applied): every behaviour assertion of §2–§4 passes; only the 4 structural assertions of §5–§6 fail (red.txt). | met on the fixture. Live audience unverified (premises table, AC-12); if the old body is live, the rewrite refuses and the lane is parked for an owner decision. |
| The 5 no-policy tables are not asserted | No test or migration names `access_audit_log`, `consents`, `retrieval_traces`, `role_sessions`, `user_roles` (Jest asserts it) | met |
| The lint reads 0, and its red run on origin/main is recorded | `node scripts/ci/bare-policy-lint.mjs` → 0 (green.txt); on origin/main → 32 on 15 tables (red.txt); Jest `reads ZERO …` red → green | met |
| The migrations apply and roll back clean on the local stack | Applied, re-applied, rolled back and re-applied on a throwaway in-process Postgres (PGlite 0.5.14) with the fixture; pgTAP 160 + 10 + 160 assertions pass; refusals on missing helpers and on live drift; absent tables skipped (green.txt). **Not run on the D11 Supabase local stack** (no Docker/Postgres here). | partly met — PGlite with a pgTAP shim; real pgTAP and the D11 stack are still pending |
| The PR lists the recount output | Recount table below (+ red.txt) | met |
| Nothing is applied from the PR; applying is a later owner-approved `RUN-MIGRATION.yml` run (§7d) | Files only; no database contacted (commands.log). Queue rows in `migration-queue-rows.md` | met |
| PR title `VTID-05465 (mt-identity-r2/helpers-and-policy-rewrite): …` | set by the caller when the PR is opened | caller |

Tasks: H1 `20261102030000_…_tenant_id_for_policies_is_member.sql`; H2 `20261102030100_…_bare_policy_rewrite.sql`;
H3 `scripts/ci/bare-policy-lint.mjs` + `services/gateway/test/mt-identity-bare-policy-lint.test.ts`; H4
`20261102030100_…_bare_policy_rewrite_rollback.sql`, `pre-check.sql`, `post-check.sql`, `migration-queue-rows.md`.

## Recount at implementation (origin/main 50e55fd3a4)

`scripts/ci/bare-policy-lint.mjs` over the 673 `supabase/migrations/*.sql` files (the plan's "674" counts the
`data-fixups/` folder), last definition wins, DROP POLICY / DROP TABLE honoured, DO and function bodies parsed:
**32 policies on 15 tables**, the same set as the 2026-11-01 recount. 30 are exactly `tenant_id = current_tenant_id()`;
2 are near-bare. All are `TO authenticated`.

| Table | `user_id` column? (CREATE TABLE) | Policies (cmd, defined at) | Rewritten to |
|---|---|---|---|
| community_groups | no (`20251231100000_vtid_01084…:33`) | insert `:161`, update `:169` (USING only), delete `:177` | `tenant_id = (select public.tenant_id_for_policies())` |
| community_meetups | no (`…01084…:56`) | insert `:207`, update `:215` (USING only), delete `:223` | same term |
| community_listings | no; `seller_user_id` (`20260727090000_bootstrap_community_marketplace.sql:54`) | select_public `:225` | `status IN ('active', 'paused', 'sold') AND tenant_id = (select public.tenant_id_for_policies())` |
| d42_domain_weights | no (`20260102000000_vtid_01136…:108`) | select `:204` | `tenant_id = (select public.tenant_id_for_policies()) OR tenant_id = '…0001'::UUID` |
| event_attendance | **yes** (`20251231000001_vtid_01090…:226`) | select `:253` | same term |
| live_highlights | no; `created_by_user_id` (`…01090…:289`) | select `:314` | same term |
| live_room_attendance | **yes** (`…01090…:159`) | select `:190` | same term |
| live_rooms | no; `host_user_id` (`…01090…:100`) | select `:128`, insert `:134`, update `:140` | same term |
| products_catalog | no (`20251231100000_vtid_01092…:44`) | select `:159`, insert `:165` | same term |
| services_catalog | no (`…01092…:19`) | select `:146`, insert `:152` | same term |
| tenant_catalog_overrides | no; `created_by` (`20260416120000_vtid_02000…:326`) | select `:809` | same term |
| match_targets | no (`20251231000001_vtid_01088…:95`) | select `:238`, insert `:242`, update `:246` (USING only) | same term |
| relationship_nodes | no (`20251231000001_vtid_01087…:25`) | select `:134`, insert `:140`, update `:146`, delete `:153` | same term |
| social_alignment_signals | no (`20260103000001_vtid_01141…:155`) | select `:286`, insert `:293` | same term |
| topic_registry | no (`20251231000001_vtid_01093…:17`) | select `:73`, insert `:81`, update `:87`, delete `:94` | same term |

No `ALTER TABLE … ADD COLUMN` adds a `user_id` to any of them. Under amendment 1 the column does not change the
rewrite: every policy gets the same tenant term. Policy names, commands, roles and the USING / WITH CHECK shape are
kept. Write policies keep the audience "any member of the resolved tenant".

Writers (member JWT, vitana-v1 `origin/main` c3d71c83e, `git grep "from('<table>')"` in `src/`,
`supabase/functions/`): no member-JWT write to any of the 15 tables. Member-JWT reads: `src/pages/admin/live/Attendance.tsx:54`
(`live_room_attendance`, route `/admin/live/attendance`, `requiredRole="admin"`), `src/pages/admin/intelligence/Relationships.tsx:93`
(`relationship_nodes`), `src/pages/community/LiveRoomViewer.tsx:73` (`live_rooms`). Gateway writers use the service role
(RLS bypassed). Tightening writes to admins stays a later decision (plan "Out of scope").

## Premises checked against the code

| Plan premise | Finding |
|---|---|
| 32 policies on 15 tables, names and file:line as cited | **true** (exact match) |
| The 4 newly found tables have no `user_id` | **true** |
| No migration after 2026-10-15 adds a bare policy; the `mt_launch` migrations are service-role-only | **true** (lint over all files) |
| The 5 no-policy tables have no CREATE TABLE | **true** (`grep -i "create table.*(access_audit_log\|consents\|retrieval_traces\|role_sessions\|user_roles)"` → none) |
| No `is_member()` / `tenant_id_for_policies()` exists | **true** |
| `user_tenants` has `UNIQUE (tenant_id, user_id)` (`20251231000000_vtid_01101_phase_a_bootstrap.sql:98`) | **true** |
| Migration range `20261102030000`–`035959` is free | **true** (newest is `20261101110100`) |
| "Browser JWTs carry no top-level `tenant_id`, so `current_tenant_id()` returns NULL"; bare policies "fail closed while the claim is NULL" (plan §Problem 1–2) | **Unverified: the migration text says the opposite, and the docs say the live body is the 20251229 one.** The last definition of `current_tenant_id()` (`20260218000000_fix_maxina_signup_tenant_association.sql:33-103`) falls back to `app_metadata.active_tenant_id` and then to the caller's `user_tenants` row (`:78-96`), and members can read their own `user_tenants` rows (`…01101…:111`). So the bare policies already admit every member of the caller's resolved tenant today. The fixture mirrors this, and the red run shows it: on the main policies a_member reads a_admin's attendance rows. **Whether the live database runs this body is not verified, and the docs say it does not run the 20260218 body.** `docs/MULTI-TENANT-PLAN.md:24` (verified 2026-10-06) says the live `current_tenant_id()` reads only the top-level JWT claims and returns NULL for browser JWTs. `docs/DATABASE_SCHEMA.md:3320-3322` and `:3646-3647` say the 20260218 fix was never applied live, and `docs/CHANGELOG.md:30` (VTID-04655) says `current_tenant_id()` never sees a tenant in a Supabase JWT. If the 20251229 body (`20251229000000_vtid_01051_me_active_role_fix.sql:15-58`) is live, browsers resolve no tenant today, and the rewrite would open all 32 policies to every member of the caller's primary tenant. The guard in `DO $pre$` (AC-12) therefore refuses unless the live body has the 20260218 markers. Read the live body with `pre-check.sql` section 5 before any apply request. **If the old body is live, the lane is parked for an owner decision.** Plan amendment 1 rests on the same premise (`.kiro/specs/mt-identity-r2/plan.md`). |
| The rewrite causes no visible change | **Not established.** On the 20260218 body, amendment 1 keeps today's audience for the fixture (the behaviour assertions pass on both policy sets), but for some members the resolved tenant changes, which is a visible change for them. Each policy keeps its predicate and only `current_tenant_id()` becomes `(select tenant_id_for_policies())`, so the audience is the caller's one resolved tenant, as today (pgTAP §2–§4 pass on both). The residual: the two helpers resolve the tenant from different inputs. `current_tenant_id()` reads, in order, the `request.tenant_id` setting, the top-level `tenant_id` / `tenant` claim, `app_metadata.active_tenant_id`, then the caller's `is_primary` row, then any row. `tenant_id_for_policies()` (plan N2) reads the top-level `tenant_id` claim only when the caller is a member of it, then the primary row (`is_primary desc, created_at, tenant_id`). Browser JWTs carry no top-level claim, so for a member of one tenant both resolve the same tenant. They can differ for a member of two or more tenants whose `app_metadata.active_tenant_id` names a non-primary tenant, and for a caller whose `app_metadata.active_tenant_id` names a tenant they are not a member of (today admitted, after the rewrite not). A behaviour-preserving alternative is to let `tenant_id_for_policies()` also read `app_metadata.active_tenant_id` when the caller is a member of it. It is not implemented, because it changes the helper the converged plan defines (N2). `pre-check.sql` section 6 counts the affected members on the target: members whose `app_metadata.active_tenant_id` is not their primary row (the non-primary and non-member cases), callers with that tenant but no `user_tenants` row, and section 6b, members with several memberships and no primary row. On the fixture, section 6 gives 1 (no membership row), 1 (non-primary membership), 0 (not a membership), total 2, and section 6b gives 0 (`outputs/pre-post-check-fixture.txt`). The apply request quotes the live counts, and the owner accepts the change for those members. Request-scoped inputs (`request.tenant_id`, the top-level `tenant` / `tenant_id` JWT claims) are not in the database, so section 6 does not count them. |
| The 15 tables exist in production | **not all.** `scripts/ci/migration-drift-baseline.json` (2026-08-04) lists 8 of them as declared but absent in production: community_groups, community_meetups, d42_domain_weights, products_catalog, services_catalog, match_targets, social_alignment_signals, topic_registry. The rewrite and the rollback skip an absent table with a NOTICE. `pre-check.sql` shows which tables are present. |

## Decisions taken (conservative options inside the plan)

1. Every policy gets the same tenant term, whatever its table's columns (amendment 1). The `user_id` column evidence
   above stays as a record. Narrowing the attendance reads to the owner and widening reads to every tenant of a
   multi-tenant member are later, separately sparred decisions.
2. The degraded path of `tenant_id_for_policies()` picks the "primary row" with the ordering of
   `resolvePrimaryTenant()` (`is_primary desc, created_at, tenant_id`), so it matches the gateway. The claim it reads
   is only the top-level `tenant_id` (the future hook claim), and only when the caller is a member of that tenant.
   `app_metadata` and `request.tenant_id` are not read.
3. The helpers are `REVOKE`d from PUBLIC and anon, and `GRANT`ed to authenticated and service_role. Policies run
   with the caller's privileges. Every rewritten policy is `TO authenticated`.
4. The rewrite refuses to run when a policy in the rewrite set is missing, or differs live (command, role, filter),
   on a present table. This way the rollback restores what was live. It re-runs cleanly on its own output.
5. The rollback lives in `supabase/migrations/` because the lane paths say so, but it is not a forward migration.
   The lint skips a `_rollback.sql` that pairs with a forward file of the same stem. Risk: a tool that replays every
   file in `supabase/migrations/` in name order would apply it right after the forward file. The header says so.
6. The MIGRATION-QUEUE rows are in `migration-queue-rows.md`, because `docs/multitenancy/MIGRATION-QUEUE.md` is not
   in the lane paths.
7. The pgTAP files have no CI runner. A `scripts/ci/test-*.sh` runner, like `test-vtid-05147-s-m-lockdown.sh`, would
   be outside the lane paths. The run order is in the fixture header.
8. The live-body guard is tested by running the rewrite file itself, on the old-body fixture (PGlite), not by a copy of
   the guard. The pgTAP file asserts the state after the refused apply, not the error text, because pgTAP cannot run a
   migration file; the runner order is in its header. The guard also has a static Jest test, because the pgTAP files
   have no CI runner. The guard reads `pg_get_functiondef` and not a comment, so a comment edit cannot change its result.
