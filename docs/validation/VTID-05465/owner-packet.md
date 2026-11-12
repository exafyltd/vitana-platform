# Owner packet: VTID-05465 (queue rows 12 and 13), bare-policy rewrite

Lane: `mt-identity-r2/helpers-and-policy-rewrite`, state `done` (`.kiro/specs/mt-identity-r2/lanes/helpers-and-policy-rewrite.md:3`),
seat hotmail. Prepared by session `kiro-hotmail-202611061752-cc1f` (M0 directive stream S1), base `origin/main` `6dc6e1ba0c`.

**Nothing in this packet has been applied.** No `RUN-MIGRATION.yml` was dispatched, no live database was contacted. Every
"ran" below is an in-process PGlite run whose raw output is in this folder. Every "did not run" is listed in section 3.

## 1. What you are asked to approve (collaboration.md §7d, `.claude/rules/collaboration.md:307-322`)

| Order | Queue row | File (all under `supabase/migrations/`) | Kind |
|---|---|---|---|
| 1 | 12 | `20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql` | additive: creates 2 functions (`MIGRATION-QUEUE.md:30`) |
| 2 | 13 | `20261102030100_vtid_05465_bare_policy_rewrite.sql` (needs row 12) | rewrites 32 policies (`MIGRATION-QUEUE.md:31`) |
| rollback | rows 12 and 13 | `20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql` | pre-approved restore (`MIGRATION-QUEUE.md:30-31`) |

**Target database: you name it.** `RUN-MIGRATION.yml` takes `target` = `default | supabase | aurora`
(`.github/workflows/RUN-MIGRATION.yml:11-16`). `default` follows the repo variable `MIGRATION_TARGET`, unset = `supabase`
(`:42-66`). The Kiro session that dispatches reads the variable, states the resolved database in its reply and passes
`target` explicitly (`collaboration.md:316-318`). This session could not read the variable (GitHub API answered HTTP 403 for
`MIGRATION_TARGET`, `MIGRATION_FREEZE` and `CLAUDE_AVAILABLE`), so the value is not stated here. The workflow refuses while
`MIGRATION_FREEZE` is `true` (`RUN-MIGRATION.yml:55-58`). The `supabase` job applies the file through
`scripts/ci/apply-sql-via-management-api.sh --record-migration` (`:71-104`); the `aurora` job applies it over the RDS Data API
and runs a dry-run plan first (`:117-168`). Staging shares the production database (vitana-v1 `CLAUDE.md`, "Why no host is
exempt"), so the approval is an approval for production data.

The dispatch Kiro would make, one per file, after your approval:
`RUN-MIGRATION.yml` with `migration_file=supabase/migrations/<file>` and `target=<supabase|aurora>`.

## 2. What it changes

**Row 12** adds `public.is_member(uuid)` and `public.tenant_id_for_policies()`, both `STABLE SECURITY DEFINER`, revoked from
PUBLIC and anon, executable by `authenticated` and `service_role` (`...030000...sql:61-127`). It refuses without `public.user_tenants`
and its unique `(tenant_id, user_id)` index (`:43`, `:56`). Nothing calls them until row 13. `current_tenant_id()` is not touched.

**Row 13** rewrites the bare policies. Under plan amendment 1 (`acceptance.md:7-18`) every one keeps its command, role
(`authenticated`) and shape and changes only the helper:
`tenant_id = current_tenant_id()` becomes `tenant_id = (select public.tenant_id_for_policies())`. No policy gains a `user_id` term
and none uses `is_member()`. `community_listings_select_public` keeps its `status IN ('active','paused','sold')` term and
`d42_domain_weights_select` keeps its global-defaults term (`...030100...sql:24-26`).

The 32 policies on 15 tables (recount at `acceptance.md:101-126`; `pre-check.sql` section 1 lists them by name):

| Table | Policies | Table | Policies |
|---|---|---|---|
| community_groups | insert, update, delete | products_catalog | select, insert |
| community_meetups | insert, update, delete | services_catalog | select, insert |
| community_listings | select_public | tenant_catalog_overrides | select |
| d42_domain_weights | select | match_targets | select, insert, update |
| event_attendance | select | relationship_nodes | select, insert, update, delete |
| live_highlights | select | social_alignment_signals | select, insert |
| live_room_attendance | select | topic_registry | select, insert, update, delete |
| live_rooms | select, insert, update | | |

Not touched: `access_audit_log`, `consents`, `retrieval_traces`, `role_sessions`, `user_roles` (no policy, no CREATE TABLE in
either repo; `acceptance.md:143`). 8 of the 15 tables are recorded as absent in production in
`scripts/ci/migration-drift-baseline.json` (`acceptance.md:149`); the rewrite skips an absent table with a NOTICE
(for example `...030100...sql:156` for `community_groups`).

**Guards inside row 13** (all in one transaction, `BEGIN` at `:53`): helpers must exist (`:69`); live `current_tenant_id()` must be the
20260218 body, three markers (`:80-99`); each rewrite-set policy on a present table must exist live with the expected command
and role (`:139`, `:146`). A failed guard rolls the whole file back.

## 3. Dry-run on PGlite

Command (repo root, PGlite from `/projects/sandbox/.tools/pglite`): `node docs/validation/VTID-05465/owner-packet-outputs/dry-run.mjs`
Exit 0. Raw output: `owner-packet-outputs/dry-run.txt` (lines longer than 420 characters are cut). Script:
`owner-packet-outputs/dry-run.mjs`.

| Part | What ran | Result |
|---|---|---|
| A. Replayed local stack (`scripts/mt/stack`, all `supabase/migrations/*.sql` except this lane's two, 423 applied, 307 skipped, 0 failed) | row 12; then row 13 | row 12 applies. **Row 13 refuses**: `the live current_tenant_id() is not the 20260218 body (markers f, f, f)`. The replayed body is the 20251229 one because `20260218000000_fix_maxina_signup_tenant_association.sql` is a recorded replay skip (`supabase/tests/local-stack/replay-skip.json`, reason "expects a column the replayed schema does not have"). This is the guard working, and it is why `replay-skip.json` lists row 13 as a skip. |
| B. Lane fixture (copies the 20260218 body, 15 + 7 tables) | `pre-check.sql`, row 12, row 13, both again, `post-check.sql`, pgTAP `mt_identity_helpers_rls.test.sql`, rollback, pgTAP rollback test, row 12 + 13 again, pgTAP again | all PASS. pgTAP 160 of 160, rollback test 10 of 10, 160 of 160 after re-apply. `post-check.sql`: `rewrite_set_live 32, rewritten_on_helper 32, on_is_member 0`, section 2 returns 0 rows. The same numbers as the lane's own run (`outputs/pglite-apply-rollback-reapply.txt`). |
| C. Lane fixture with the old (20251229) body | row 12, row 13, pgTAP `mt_identity_helpers_live_body_guard.test.sql` | row 13 refuses with the same message; pgTAP 5 of 5. |

The pgTAP files run on the stack's assertion shim (`scripts/mt/stack/tap-shim.sql`), plus a harness-only `no_plan()`/`finish()`
addition inside `dry-run.mjs` (the shim has `plan()` only). Nothing in the repo is changed by it.

**What did not run, and why**
- Real pgTAP and the D11 Supabase local stack: no Docker or Postgres server here. This is the open part of AC-8
  (`acceptance.md:55-59`): "Before the apply request, the owner waives this or the files run on the D11 stack with real pgTAP."
  **That waiver is yours to give or refuse.**
- Part B uses a synthetic fixture, not the production schema. It proves the SQL and the audience logic. It does not prove what
  production holds.
- `pre-check.sql` and `post-check.sql` ran only on the fixture (part B). They have not run on the target.
- Row 13 has not run on the replayed stack past its guard (part A), so no run covers "rewrite on a body the guard accepts and
  the real 15-table schema".
- I did not re-run the Jest lint (`services/gateway/test/mt-identity-bare-policy-lint.test.ts`, 7 of 7 in the lane's
  `outputs/jest-green.txt`); that run is the lane's evidence, not this packet's.

## 4. Pre-check (read only, run by the owner-approved dispatch window before row 12)

`docs/validation/VTID-05465/pre-check.sql`. Read these before approving row 13:

1. **Section 5, the go/no-go.** `marker_1`, `marker_2`, `marker_3` must all be `true`. If any is `false`, the live
   `current_tenant_id()` is not the 20260218 body and row 13 will refuse. The acceptance file says the lane is then "parked for
   an owner decision" (`acceptance.md:67-80`). The repo disagrees with itself on which body is live: `docs/MULTI-TENANT-PLAN.md:24`
   says the live function reads only the top-level JWT claim, while the last migration defines the 20260218 body
   (`acceptance.md:147`). Only this query settles it.
2. **Section 6 and 6b, who sees a different tenant after the rewrite.** The two helpers resolve the tenant from different inputs
   (`acceptance.md:148`). The counts show members with `app_metadata.active_tenant_id` that is not their primary row. A non-zero
   count is a visible change for those members and is yours to accept. On the fixture the count was 2 (a synthetic number).
3. Section 1: `table_present` and `policy_present` per policy. The expected `policy_present = true` count is the number the
   post-check must reproduce.
4. Section 3: both helpers absent, `user_tenants` unique index present. Section 4: the bare policies live today.

## 5. Post-check (read only, after each file)

`docs/validation/VTID-05465/post-check.sql`, after row 13:
1. Both helpers exist, `SECURITY DEFINER`, `STABLE`, `authenticated_exec = true`, `anon_exec = false`.
2. Expected 0 rows: no rewrite-set policy still references `current_tenant_id()`.
3. `rewrite_set_live = rewritten_on_helper = <pre-check section 1 count of policy_present>`, `on_is_member = 0`.
4. The rewrite set as it now reads. Section 5: `current_tenant_id()` md5 unchanged from `pre-check.sql` section 3.

A row is marked applied in `MIGRATION-QUEUE.md` only after its post-check passed (`MIGRATION-QUEUE.md:6-9`).

## 6. Rollback

Rollback id: `20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql` (`MIGRATION-QUEUE.md:30-31`). It restores each of the
32 policies to the text of the migration that defined it, so the bare-policy lint reads 32 again (`...rollback.sql:5-14`). It
drops the two helpers only when no policy or function body still references them (`:18-21`). Absent tables are skipped. It is
not a forward migration: do not apply it in the normal order. It runs only through `RUN-MIGRATION.yml` on your approval.
Dry-run: part B above (rollback, pgTAP 10 of 10, re-apply, pgTAP 160 of 160). Because audience is the same before and after
(amendment 1), a rollback changes the helper name only; it does not undo a member-visible change except for the members counted
in pre-check section 6.

Risk recorded by the lane (`acceptance.md:164-166`): a tool that replays every file in `supabase/migrations/` in name order would
run the rollback right after the forward file. The lint skips it by name pairing.

## 7. Apply window

Preconditions and order, from the queue and acceptance files:
- Row 12 before row 13, one dispatch per file, post-check after each (`MIGRATION-QUEUE.md:6-9`, row 13 "Depends on #12").
- Row 13 only after pre-check section 5 shows three `true` and section 6 is reviewed by you.
- `MIGRATION_FREEZE` is not `true` (`RUN-MIGRATION.yml:55-58`).
- Rows 14-16 (VTID-05466) depend on row 13 (`MIGRATION-QUEUE.md:32-34`), so 12-13 come first.
- Plan rule for every DB slice: "an off-peak window" and a read-only post-check (`.kiro/specs/mt-identity-r2/plan.md:237-239`).
  Row 13 takes `lock_timeout 5s` (`...030100...sql:55`), rewrites 32 policies in one transaction, so it takes table-level locks on up to 15 tables
  until it commits (the file does not say which lock level; the lane did not measure it). Pick a low-traffic window.
- Reader impact: the rewrite is read by member-JWT screens `src/pages/admin/live/Attendance.tsx:54` (`live_room_attendance`),
  `src/pages/admin/intelligence/Relationships.tsx:93` (`relationship_nodes`) and `src/pages/community/LiveRoomViewer.tsx:73`
  (`live_rooms`) in vitana-v1 (`acceptance.md:130-135`). No member-JWT writer exists for the 15 tables. Gateway writers use the
  service role. No reader needs retiring first. After the window, open those three screens as a member (read only).
- Hook go-live (a later lane) needs this lint at 0 first (`plan.md:295`). That is why 12-13 precede it.

**Window date: left for the owner.**

## 8. Recommendation

Approve row 12 now (additive, nothing uses it). Approve row 13 only together with the pre-check read: dispatch row 12, run
`pre-check.sql`, show you sections 5 and 6, then ask for the go on row 13. If section 5 shows a `false`, do not apply row 13;
the lane needs your decision first.

## 9. Evidence index

`acceptance.md`, `pre-check.sql`, `post-check.sql`, `red.txt`, `green.txt`, `commands.log`, `outputs/` (lane evidence);
`owner-packet-outputs/dry-run.mjs`, `owner-packet-outputs/dry-run.txt` (this packet).
