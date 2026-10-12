# VTID-05124 — plan sparring record (FU8: delete the orphan memberships rows)

Copy of the final sparred plan file (plan body between the markers, round-1 planner responses, verdict). `VTID-XXXXX` in the plan text is VTID-05124.
Verdict: CONVERGED (2 rounds). Final plan hash (as recorded with the sparring record): `e96821f8b1a655a027069f30164f6efeeaa71acef67a0ba9f17380c17fc1a37f`.

---

# FU8 — Remove 12 orphan `memberships` rows left by deleted accounts

change class: data-fixup (production data deletion, small, reversible via archive)
scope: `supabase/migrations/data-fixups/<ts>_vtid_XXXXX_delete_orphan_memberships.sql` (new),
`docs/validation/VTID-XXXXX/rollback-orphan-memberships.sql` (new),
`docs/validation/VTID-XXXXX/{live-before.sql,post-apply-checks.sql,plan-sparring.md,acceptance.md}` (new),
optional test in the existing PGlite migration-check harness. No gateway or frontend code.

<!-- plan:begin -->

## Problem (evidence)

Live read-only check, 2026-10-12, project `inmkhvwdcuyhnxkgfvsb` (SELECT only):

- `public.memberships` has 235 rows (all `status='active'`). **12** rows have a `user_id` with no
  `auth.users` row. For every one of them there is also no `app_users`, no `profiles` and no
  `user_tenants` row anywhere: the accounts were deleted.
- These are the same 12 rows VTID-05043 Migration B
  (`supabase/migrations/data-fixups/20261010180100_vtid_05043_s3_backfill_drifted_memberships.sql`)
  captured in `legacy_archive.bak_s3_drift_20261010` with `has_auth_user=false, has_app_user=false`
  and deliberately left alone (its header: "kept in the snapshot and left alone").
- Breakdown: tenant `maxina` 11 rows, `alkalma` 1 row; 11 distinct user ids (user `0b0e53cb…` has
  one row in each tenant). Roles: 11 `community`, 1 `reseller`. `created_at` from 2025-09-29 to
  2026-02-27; `updated_at = created_at` for all of them (never touched since).
  Ids (truncated): 2f8a7363, 4ff64983, 27f7fabd, fabf5609, 719384c1, 85a06581, c58d9a65, 7991f567,
  cdecbdd8, 1d69bb22, 59eb8d06, 89ccdbb5.
- **Why it didn't cascade:** `memberships` has only `memberships_pkey`, `memberships_status_check`,
  `UNIQUE (user_id, tenant_id)` and `memberships_tenant_id_fkey → tenants ON DELETE CASCADE`.
  There is **no FK from `memberships.user_id` to `auth.users` or `app_users`**, so deleting an
  auth user leaves the row behind. No triggers on `memberships`.
- **Dependents:** no FK anywhere references `memberships(id)`. The only `membership_id` column in
  the database is the VTID-05043 snapshot table itself (`legacy_archive.bak_s3_drift_20261010`,
  kept 30 days from 2026-10-10, no FK).
- **Readers / rules 43–45 exposure:** the functions reading `memberships` are access checks keyed
  on the *caller* (`search_tenant_directory`, `create_tenant_direct_thread`, `is_community_user`,
  `is_community_moderator`, `can_read_intent`, `get_user_admin_status`, `get_my_permitted_roles`,
  `list_roles_for_active_tenant`, `switch_to_tenant_by_slug`, `validate_role_assignment`,
  `set_role_preference`, `bootstrap_admin_user`, `handle_new_user`, `trg_activate_patient_profile`,
  `resolve_recipient_candidates` as a tenant fallback). A deleted user can never be the caller.
  `search_tenant_directory` returns rows from `profiles` (none exist for these users), so they are
  **not surfaced to members**. Gateway reads it in one place (`services/gateway/src/services/jev/jev-repository.ts:33`),
  also caller-keyed. The only visible effect is **inflated admin counts**, verified read-only via
  `pg_get_viewdef` on 2026-10-12: `admin_tenant_analytics` is `FROM tenants t LEFT JOIN memberships
  m ON m.tenant_id = t.tenant_id GROUP BY tenant`, with `count(DISTINCT m.user_id)` as
  `total_users`/`active_users` and per-role counts for admin/staff/professional/patient only. The
  orphans (community/reseller) therefore inflate `total_users` and `active_users` (maxina +10
  distinct users, alkalma +1), not the per-role counts. `admin_system_health` counts
  `total_memberships`/`active_memberships` straight from `memberships` (+12 each).
  Theoretical risk: `create_tenant_direct_thread` (defined in `exafyltd/vitana-v1`
  `supabase/migrations/20250917161459_8ae0b2ca-1644-48c9-9662-63e775ee36f9.sql` and redefined in
  later migrations up to `20261007180000_vtid_04960_thread_participants_join_hardening.sql`)
  accepts a deleted user id as a valid recipient (only if a caller already knows the uuid).
  Deleting these rows closes that for these 12 rows; hardening the function itself is deferred
  (see Out of scope).

So: low severity, no member-visible leak; this is data hygiene plus correct admin analytics.

## Fix

One data-fixup migration, one transaction, not idempotent by design (same pattern as VTID-05043 B):

1. `BEGIN; SET LOCAL lock_timeout = '3s';`
2. Archive first: `CREATE TABLE legacy_archive.bak_fu8_orphan_memberships_<yyyymmdd> AS SELECT m.*,
   now() AS captured_at FROM public.memberships m WHERE NOT EXISTS (SELECT 1 FROM auth.users u
   WHERE u.id = m.user_id) AND NOT EXISTS (SELECT 1 FROM public.app_users a WHERE a.user_id =
   m.user_id);` (plain CREATE TABLE so a second run fails loudly; schema `legacy_archive` already
   exists with no client grants; full rows, all 7 columns, so the rollback is exact).
3. Self-check `DO $$` block, RAISE EXCEPTION (aborts the whole transaction) if:
   - archived count < 10 or > 14 (counted 12 on 2026-10-12; tolerance ±2 for accounts deleted or
     re-created in between);
   - any archived `user_id` has a row in `public.user_tenants` or `public.profiles` (would mean a
     live identity, not an orphan);
   - any FK in `pg_constraint` now references `public.memberships` (`confrelid =
     'public.memberships'::regclass`) — guard against a dependent added after this plan.
4. `DELETE FROM public.memberships m USING legacy_archive.bak_fu8_orphan_memberships_<yyyymmdd> b
   WHERE m.id = b.id;` — delete by the archived ids, never by a re-evaluated predicate, so the
   rows deleted are exactly the rows archived. `GET DIAGNOSTICS` / post-check: deleted count =
   archived count, else RAISE.
5. Post-check: `SELECT count(*) FROM public.memberships m WHERE NOT EXISTS (auth.users …)` = 0.
6. `COMMIT;`

Rollback file `docs/validation/VTID-XXXXX/rollback-orphan-memberships.sql`:
`INSERT INTO public.memberships (id, user_id, tenant_id, role, status, created_at, updated_at)
SELECT id, user_id, tenant_id, role, status, created_at, updated_at FROM legacy_archive.bak_fu8_… 
ON CONFLICT (id) DO NOTHING;` plus a count assert. The archive is kept 30 days (same retention as
the VTID-05043 snapshots), then dropped in a later cleanup together with them.

**Optional / separate VTID (recommended, not in this change):** prevent recurrence. Options in
order of preference: (a) `ALTER TABLE memberships ADD CONSTRAINT memberships_user_id_fkey FOREIGN
KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID; VALIDATE CONSTRAINT …` —
valid only after this fixup, small table (235 rows) so the validate is cheap; (b) cascade via the
account-deletion path in the gateway. Kept separate because `memberships` is a legacy table being
retired behind `user_tenants` (VTID-05043), so the owner may prefer retiring the table to adding
a constraint to it.

## Tests

- Read-only `live-before.sql` re-run right before apply: same 12 ids, 0 FK dependents.
- PGlite migration check (existing harness `docs/validation/VTID-05043/pglite-migration-check.mjs`
  pattern): seed memberships with orphans + a real user (auth.users + app_users + user_tenants)
  → migration deletes only the orphans; a run with 20 orphans aborts (count guard); a run with
  an orphan that has a `profiles` row aborts; a second run aborts on the existing archive table;
  rollback restores rows byte-identical.
- Migration lint/drift CI (`MIGRATION-DRIFT-CHECK.yml`) green.
- `post-apply-checks.sql` (read-only): 0 orphan memberships; archive has 12 rows; memberships
  total = 223; `admin_system_health.total_memberships` dropped by exactly 12.
- No staging suite needed beyond these: the change deploys no service (no Gate 2; done when the
  migration is applied and post-checks pass).

## Rollout

1. PR with migration + rollback + validation docs; checks green; merge.
2. Re-run `live-before.sql` (read-only). Proceed only if it shows 10–14 orphans and zero FK
   dependents on `memberships`. **If the count is below 10 (or above 14), abandon: do not widen the
   bounds, do not apply; report the new count to the owner.**
3. Apply via `RUN-MIGRATION.yml` (`workflow_dispatch`, input `migration_file =
   supabase/migrations/data-fixups/<ts>_vtid_XXXXX_delete_orphan_memberships.sql`). The workflow
   runs the SQL through the Supabase Management API (`scripts/ci/apply-sql-via-management-api.sh`)
   as `postgres`, so RLS (`memberships_delete_new` etc.) is bypassed; the in-migration guards,
   not RLS, are the protection.
4. Run `post-apply-checks.sql`, record outputs in `docs/validation/VTID-XXXXX/`, terminalize VTID.

**Governance of the production write (Autonomy Contract, VTID-04947):** no service deploys, so
there is no staging deploy and no STAGING-VERIFY. The `RUN-MIGRATION.yml` dispatch in step 3 *is*
the production write, and it is explicitly covered by the owner's Gate 1 "yes" for this plan (the
Gate 1 message names this dispatch). It runs only after step 2 re-confirms 10–14 orphans and zero
dependents. The work is done when the post-apply checks pass, not at merge; the result (counts
before/after, archive row count, workflow run link) is reported to the owner as the closing
message, the Gate 2 equivalent for this change.

## Risks

- Deleting production data: mitigated by full-row archive in the same transaction, delete-by-
  archived-id, count and dependency guards, and a tested rollback.
- An account re-created with the same uuid between check and apply: guarded by the
  `auth.users`/`app_users`/`user_tenants`/`profiles` existence checks.
- Admin dashboards show 12 fewer members in `maxina`/`alkalma` after apply — intended, but worth
  a note to whoever reads those numbers.
- `lock_timeout` 3s: on contention the migration fails and is retried; no partial state.

## Out of scope

- The FK / cascade on `memberships.user_id` (separate VTID, see Fix).
- Retiring `memberships` entirely in favour of `user_tenants`.
- Orphan rows for deleted accounts in other tables (not surveyed here).
- Dropping the VTID-05043 `legacy_archive` snapshots (their own 30-day cleanup).
- Hardening `create_tenant_direct_thread` to reject recipients without an `auth.users`/`app_users`
  row (deferred to a separate follow-up; after this fixup the gap no longer applies to these rows).

## Owner decisions

1. **Approve deleting 12 production rows** in `public.memberships` that belong to deleted accounts,
   including the `RUN-MIGRATION.yml` dispatch that performs it (the production write; Gate 1 "yes"
   covers it, gated by the step-2 re-check — see Rollout). Recommended: yes — no member-visible
   use, archived and reversible for 30 days.
2. Recurrence prevention: FK `ON DELETE CASCADE` on `memberships.user_id` as a follow-up VTID,
   or leave `memberships` as-is pending its retirement (recommended: follow-up FK, small and cheap).

<!-- plan:end -->

## Planner responses — round 1

- **F1 [minor] — ACCEPTED.** Problem section now notes `create_tenant_direct_thread` is defined in
  `exafyltd/vitana-v1` `supabase/migrations/20250917161459_8ae0b2ca-1644-48c9-9662-63e775ee36f9.sql`
  (redefined later, latest `20261007180000_vtid_04960_thread_participants_join_hardening.sql`).
- **F2 [minor] — ACCEPTED, verified.** `pg_get_viewdef('public.admin_tenant_analytics')` read live
  2026-10-12: `tenants LEFT JOIN memberships`, `count(DISTINCT m.user_id)` for total/active users,
  role counts only for admin/staff/professional/patient. Rationale corrected: the orphans
  (community/reseller) inflate `total_users`/`active_users` (maxina +10, alkalma +1), not role counts.
- **F3 [minor] — ACCEPTED.** Rollout step 2: below 10 (or above 14) at the pre-check → abandon,
  do not widen bounds, report to owner.
- **F4 [minor] naming — acknowledged.** Will be applied when the files are created.
- **F5 [major] governance — ACCEPTED.** New "Governance of the production write" paragraph in
  Rollout: no service deploy → no STAGING-VERIFY; the RUN-MIGRATION.yml dispatch is the production
  write, covered by the Gate 1 "yes" (named in the Gate 1 message), runs only after the live-before
  re-check (10–14 orphans, 0 dependents); done when post-apply checks pass; closing report to the
  owner is the Gate 2 equivalent. Former owner decision #2 folded into #1.
- **F6 [minor] FK-only dependency guard — acknowledged.** No change; the guard stays FK-based.
- **F7 [minor] — ACCEPTED.** Rollout step 3 notes the Management API runs as `postgres` (RLS
  bypassed), so the in-migration guards are the protection.
- **Partner Q2 (`create_tenant_direct_thread` hardening) — DEFERRED** to a separate follow-up,
  listed under Out of scope; once these orphan rows are deleted, the gap no longer applies to them.

## Owner approval (Gate 1)
Approved by owner in Claude Code session https://claude.ai/code/session_01TMPMNGNEtPxKwmVqyfdx46 on 2026-10-12 ("Yes"), including the recommended option for every owner decision and the production steps named in the plan. Verdict: CONVERGED (2 rounds).

Owner approval (Gate 1): "Yes" — 2026-10-12, Claude Code session; plan hash e96821f8b1a655a027069f30164f6efeeaa71acef67a0ba9f17380c17fc1a37f; sparring record 33db1d1d-4b1c-497a-8120-cb55481beeb5.
