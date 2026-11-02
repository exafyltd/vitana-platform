# VTID-05465 — acceptance (mt-identity-r2 / helpers-and-policy-rewrite)

Base: `origin/main` 50e55fd3a4 (exafyltd/vitana-platform). Plan: `.kiro/specs/mt-identity-r2/plan.md` §Fix 1,
`tasks.md` group `helpers-and-policy-rewrite` (H1–H4). Evidence files in this folder: `red.txt`, `green.txt`,
`commands.log`, `pre-check.sql`, `post-check.sql`, `migration-queue-rows.md`, and `outputs/` (raw Jest and PGlite output).

## Plan amendment 1 (2026-11-02)

This lane implements `plan.md` lane 1 as amended ("Amendment 1", build finding). The bare policies do not fail closed
today: `current_tenant_id()` falls back to `app_metadata.active_tenant_id` and then to the caller's `user_tenants`
row (premise table below). So every one of the 32 policies keeps today's audience, the members of the caller's one
resolved tenant, and the only change is the helper:
`tenant_id = current_tenant_id()` → `tenant_id = (select public.tenant_id_for_policies())`. No policy gains a
`user_id = auth.uid()` term and no policy uses `is_member()`. `is_member()` is still created, for later lanes.
`community_listings_select_public` keeps its `status IN (…)` term and `d42_domain_weights_select` keeps its
global-defaults term. The Jest test checks that each rewritten policy equals its original with only the helper
swapped. The `tasks.md` acceptance bullets below were written before the amendment; they are read through it (the
"cannot read a_admin's rows" and "`is_member` policies" wording is replaced by "today's audience").

## Acceptance criteria

AC-1: The change types are Database (2 migrations and 1 rollback) and Tooling/docs (the lint script, the Jest test, the pgTAP files and this folder). Status: met.
TEST: `git diff --name-only origin/main...HEAD` lists only the supabase/migrations, supabase/tests, scripts/ci, services/gateway/test and docs/validation/VTID-05465 paths.

AC-2: On event_attendance and live_room_attendance the rewritten policies keep today's audience. a_member still reads a_admin's row and exactly the 2 tenant A rows, b_member reads nothing of tenant A, and a non-member reads nothing. Status: met on a throwaway Postgres (see AC-8).
TEST: supabase/tests/mt_identity_helpers_rls.test.sql §2, run on PGlite (outputs/pglite-apply-rollback-reapply.txt, line "pgTAP rls (after rewrite)").

AC-3: On the 7 health tables a_member reads 0 of a_admin's rows, and their policies are not rewritten. Status: met on a throwaway Postgres.
TEST: supabase/tests/mt_identity_helpers_rls.test.sql §2b, in the same PGlite run.

AC-4: On the 15 shared tables only members of the resolved tenant get access (the d42 global-defaults term aside). SELECT, INSERT, UPDATE and DELETE checks pass, all 32 policies use tenant_id_for_policies(), and none uses is_member() or a new user_id / auth.uid() term. Status: met.
TEST: supabase/tests/mt_identity_helpers_rls.test.sql §3 to §5 (same PGlite run), and services/gateway/test/mt-identity-bare-policy-lint.test.ts, test "rewrites every recounted policy to tenant_id_for_policies() and nothing else".

AC-5: Same audience as origin/main. With the helpers applied and the rewrite not applied, the behaviour assertions of §2 to §4 pass on origin/main's policies, and only the structural assertions fail. Status: met.
TEST: the pgTAP run on origin/main policies recorded in docs/validation/VTID-05465/red.txt (section "pgTAP suite on origin/main policies").

AC-6: The rewrite and rollback migrations do not name access_audit_log, consents, retrieval_traces, role_sessions or user_roles. Status: met.
TEST: services/gateway/test/mt-identity-bare-policy-lint.test.ts, test "rewrites every recounted policy to tenant_id_for_policies() and nothing else" (NO_POLICY_TABLES check).

AC-7: The lint reads 0 bare policies on this branch and 32 on origin/main, and the Jest test is red on origin/main and green here. Status: met.
TEST: `npx jest test/mt-identity-bare-policy-lint.test.ts` in services/gateway (7 of 7 pass, outputs/jest-green.txt), `node scripts/ci/bare-policy-lint.mjs` (exit 0), and the red run in outputs/jest-red-origin-main.txt.

AC-8: The migrations apply, re-apply, roll back and re-apply clean on a throwaway in-process Postgres (PGlite 0.5.14) with the fixture. The refusals and the absent-table skips hold. Status: partly met. The D11 Supabase local stack was not available (no Docker or Postgres here), so a run on that stack is still open.
TEST: outputs/pglite-apply-rollback-reapply.txt (PGlite run of supabase/tests/mt_identity_helpers_fixture.sql, the two migrations, the rollback and the pgTAP files).

AC-9: The PR lists the recount: 32 bare policies on 15 tables in the 673 migration files at origin/main 50e55fd3a4. Status: met.
TEST: `node scripts/ci/bare-policy-lint.mjs` over origin/main 50e55fd3a4, recorded in docs/validation/VTID-05465/red.txt.

AC-10: Nothing is applied from this PR. The migrations are files only, and the MIGRATION-QUEUE rows are in migration-queue-rows.md. Status: met.
TEST: `git diff --name-only origin/main...HEAD` (no change outside the listed paths), and docs/validation/VTID-05465/commands.log (no database, gateway, Supabase or AWS endpoint contacted).

AC-11: The PR title starts with `VTID-05465 (mt-identity-r2/helpers-and-policy-rewrite):`. Status: met.
TEST: `node scripts/ci/validate-pr-locally.cjs --title "<PR title>" --body-file <PR body file> --base main` passes the Merge Deploy Gate (the title contains the VTID).

## Acceptance bullets → evidence

| Acceptance bullet (tasks.md) | Evidence | Status |
|---|---|---|
| Change types: Database, Tooling/docs | 2 migrations + 1 rollback (Database); `scripts/ci/bare-policy-lint.mjs`, Jest test, pgTAP files, this folder (Tooling/docs) | met |
| pgTAP (read through amendment 1): the attendance policies keep today's audience | `supabase/tests/mt_identity_helpers_rls.test.sql` §2: on `event_attendance` and `live_room_attendance` a_member still reads a_admin's row, as today, and reads exactly the 2 tenant A rows; b_member reads nothing of tenant A; a member of A (resolved) and B reads nothing of tenant B; a non-member reads nothing | met (throwaway Postgres, see note) |
| … and, read-only, on the health tables | same file §2b: the 7 health tables, a_member reads 0 of a_admin's rows; their policies are not rewritten | met (throwaway Postgres) |
| Shared policies on all 15 tables admit the members of the resolved tenant only | §3: SELECT on the 11 tables with a SELECT policy: a_member reads A, b_member reads B and nothing of A, a member of A (resolved) and B reads A and nothing of B, a non-member reads nothing (d42 global defaults aside); with a top-level `tenant_id` claim for B, B is the resolved tenant instead. §4: INSERT (b_member into A → 42501, a_member → ok, the A+B member into B → 42501), UPDATE (b_member 0 rows, a_member 1, moving a row to B → 42501), DELETE (b_member 0, a_member 1). §5: 32 policies on `tenant_id_for_policies()`, 0 on `is_member()`, 0 with a new `user_id` / `auth.uid()` term. | met |
| Same audience as origin/main | The same pgTAP file on origin/main's policies (helpers applied, rewrite not applied): every behaviour assertion of §2–§4 passes; only the 4 structural assertions of §5–§6 fail (red.txt). | met |
| The 5 no-policy tables are not asserted | No test or migration names `access_audit_log`, `consents`, `retrieval_traces`, `role_sessions`, `user_roles` (Jest asserts it) | met |
| The lint reads 0, and its red run on origin/main is recorded | `node scripts/ci/bare-policy-lint.mjs` → 0 (green.txt); on origin/main → 32 on 15 tables (red.txt); Jest `reads ZERO …` red → green | met |
| The migrations apply and roll back clean on the local stack | Applied, re-applied, rolled back and re-applied on a throwaway in-process Postgres (PGlite 0.5.14) with the fixture; pgTAP 160 + 10 + 160 assertions pass; refusals on missing helpers and on live drift; absent tables skipped (green.txt). **Not run on the D11 Supabase local stack** (no Docker/Postgres here). | partly met — needs a run on the D11 stack |
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
| "Browser JWTs carry no top-level `tenant_id`, so `current_tenant_id()` returns NULL"; bare policies "fail closed while the claim is NULL" (plan §Problem 1–2) | **false.** The last definition of `current_tenant_id()` (`20260218000000_fix_maxina_signup_tenant_association.sql:33-103`) falls back to `app_metadata.active_tenant_id` and then to the caller's `user_tenants` row (`:78-96`), and members can read their own `user_tenants` rows (`…01101…:111`). So the bare policies already admit every member of the caller's resolved tenant today. The fixture mirrors this, and the red run shows it: on the main policies a_member reads a_admin's attendance rows. |
| The rewrite causes no visible change | **true after amendment 1**, with one residual. Each policy keeps its predicate and only `current_tenant_id()` becomes `(select tenant_id_for_policies())`, so the audience is the caller's one resolved tenant, as today (pgTAP §2–§4 pass on both). Residual: the two helpers resolve the tenant from different inputs. `current_tenant_id()` reads, in order, the `request.tenant_id` setting, the top-level `tenant_id` / `tenant` claim, `app_metadata.active_tenant_id`, then the caller's `is_primary` row, then any row. `tenant_id_for_policies()` (plan N2) reads the top-level `tenant_id` claim only when the caller is a member of it, then the primary row (`is_primary desc, created_at, tenant_id`). Browser JWTs carry no top-level claim, so for a member of one tenant both resolve the same tenant. They can differ for a member of two or more tenants whose `app_metadata.active_tenant_id` names a non-primary tenant, and for a caller whose `app_metadata.active_tenant_id` names a tenant they are not a member of (today admitted, after the rewrite not). A behaviour-preserving alternative is to let `tenant_id_for_policies()` also read `app_metadata.active_tenant_id` when the caller is a member of it. It is not implemented, because it changes the helper the converged plan defines (N2). `pre-check.sql` does not measure how many members are affected; that needs a read-only count on the target before the apply. |
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
