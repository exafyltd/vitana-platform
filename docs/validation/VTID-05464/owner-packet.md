# Owner packet: VTID-05464 (queue rows 17 and 18), access-token hook in shadow

Lane: `mt-identity-r2/access-token-hook-shadow`, state `done`
(`.kiro/specs/mt-identity-r2/lanes/access-token-hook-shadow.md`), seat hotmail. Prepared by session
`kiro-hotmail-202611061752-cc1f` (M0 directive stream S1), base `origin/main` `6dc6e1ba0c`.

**Nothing in this packet has been applied.** No `RUN-MIGRATION.yml` was dispatched, no live database was contacted, no Auth
config was read or changed. Every "ran" below is an in-process PGlite run whose raw output is in this folder.

## 1. What you are asked to approve (collaboration.md §7d, `.claude/rules/collaboration.md:307-322`)

| Order | Queue row | File (all under `supabase/migrations/`) | Kind |
|---|---|---|---|
| 1 | 17 | `20261102032000_vtid_05464_access_token_hook_shadow.sql` | adds one function (`MIGRATION-QUEUE.md:35`) |
| 2 | 18 | `20261102032100_vtid_05464_tenant_claim_mismatch_log.sql` (needs row 17) | adds one table (`MIGRATION-QUEUE.md:36`) |
| rollback | rows 17 and 18 | `20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql` | drops both (`MIGRATION-QUEUE.md:35-36`) |

**Target database: you name it.** `RUN-MIGRATION.yml` takes `target` = `default | supabase | aurora`
(`.github/workflows/RUN-MIGRATION.yml:11-16`). `default` follows the repo variable `MIGRATION_TARGET`, unset = `supabase`
(`:42-66`). The dispatching Kiro session reads the variable, states the resolved database and passes `target` explicitly
(`collaboration.md:316-318`). This session could not read the variable (HTTP 403 from the GitHub variables API), so the value is
not stated here. It refuses while `MIGRATION_FREEZE` is `true` (`:55-58`). Staging shares the production database (vitana-v1
`CLAUDE.md`), so this is an approval for production.

Target matters for one grant. The hook is granted to `supabase_auth_admin` only if that role exists; on a database without it
(Aurora) the file prints a NOTICE and grants EXECUTE to nobody (`...032000...sql:133-137`). A hook that nobody can execute cannot be
enabled in Auth. Supabase has the role.

## 2. What it changes

There are no bare policies in this lane. It changes no policy, no table that exists today and no Auth setting.

**Row 17** creates `public.custom_access_token_hook_shadow(event jsonb) RETURNS jsonb`:
`SECURITY DEFINER`, `search_path = ''`, `lock_timeout 100ms`, `statement_timeout 500ms` (`...032000...sql:62-65`). It looks up the
caller's `user_tenants` memberships with one indexed query (`idx_user_tenants_user`), picks the tenant the way
`resolvePrimaryTenant()` does (preferred `app_metadata.active_tenant_id` only if it is a membership, then `is_primary desc,
created_at, tenant_id`), and returns the event with one added claim, `tenant_id_shadow` (`:118`). It never adds, changes or
removes a top-level `tenant_id` or any other claim, so `current_tenant_id()` resolves exactly as before even with the hook on
(`:12-17`, self-check at `:165`). Any error returns the original event (`:119`). EXECUTE: `supabase_auth_admin` only; revoked from
PUBLIC, anon, authenticated, service_role (`:128-129`, `:133-135`). The file ends with a self-check that RAISEs and rolls the file back
if the end state is wrong (`:142-166`).

**Row 18** creates `public.tenant_claim_mismatch_log` (soak log: user id, decision, claimed and shadow tenant, counters). RLS on,
no policy, `service_role` only (`...032100...sql:31-62`). One row per (user, decision, claimed, shadow); repeats bump `seen_count`
(`:44`). Decisions: `preference_not_member`, `no_membership`, `primary_missing` (`:42`). No member content.

**Hook behaviour once it is wired into Auth (not part of this approval):** each token issue runs one indexed read and may write one
deduplicated log row. A failure of either returns the unchanged token (fail open). The hook is **not** enabled by these files;
enabling it is the separate owner-applied GO-LIVE lane (D14; migration `:26-27`, `acceptance.md:88-92`). Until Auth points at it, nothing
calls the function and the log stays empty.

## 3. Dry-run on PGlite

Command (repo root): `node docs/validation/VTID-05464/owner-packet-outputs/dry-run.mjs`. Exit 0. Raw output:
`owner-packet-outputs/dry-run.txt`. Script: `owner-packet-outputs/dry-run.mjs`.

| Part | What ran | Result |
|---|---|---|
| A. Replayed local stack (`scripts/mt/stack`, a copy of `supabase/migrations/` without this lane's three files: 422 applied, 308 skipped, 0 failed) | state before; row 17; row 18; `post-check.sql`; both again; rollback; rollback again; both again | state before `hook:false, log:false`; every step PASS; after both files `hook:true, log:true`; `post-check.sql` shows `prosecdef true`, `search_path/lock_timeout/statement_timeout` as specified, `auth_admin_exec true`, `authenticated_exec false`, `anon_exec false`, `service_role_exec false`, log `relrowsecurity true`, `authenticated_select false`, `anon_select false`, `service_role_select true`, `policies 0`, `rows 0`; after rollback `hook:false, log:false`; a second rollback is a no-op |
| B. Lane fixture (`mt_identity_hook_fixture.sql`) with the lane's committed pgTAP shim | row 17, row 18, pgTAP plan of 36, rollback, row 17 + 18 again, pgTAP again | PASS; 36 of 36 after apply and 36 of 36 after rollback + re-apply. The same numbers as the lane's own run (`outputs/pglite-green-36.txt`) |

The stack has no `supabase_auth_admin` role; the harness creates it before part A (stated in the output) so the grant branch runs.

**What did not run, and why**
- Real pgTAP and the D11 Supabase local stack: no Docker or Postgres server here (`acceptance.md:79-86` records the same limit,
  "Run on PGlite"). Part B's assertions run on a shim, not on pgTAP.
- Nothing ran against Supabase Auth. Whether Auth accepts this function as a `custom_access_token` hook, and its 2 s limit on
  the call, are not exercised. The 500 ms `statement_timeout` is pinned but Postgres does not arm it inside a function call; the
  effective bounds are `lock_timeout`, the single index probe and Auth's own limit (`acceptance.md:50-58`).
- No latency or load measurement.
- `post-check.sql` and its `pre` section have run on the replayed stack only, not on the target.

## 4. Pre-check (read only, before row 17)

`docs/validation/VTID-05464/post-check.sql`, the two `pre` queries:
1. Expect `hook` and `log` both `NULL` (nothing to clobber).
2. Expect `user_tenants` still has `idx_user_tenants_user`, the hook's lookup index (created at
   `20251231000000_vtid_01101_phase_a_bootstrap.sql:103`). If it is missing, the lookup becomes a scan; stop.

## 5. Post-check (read only, after each file)

The `post` queries of the same file, after row 18:
1. Hook: `prosecdef = true`, `proconfig` holds the three pinned settings, `auth_admin_exec = true`, `authenticated_exec`,
   `anon_exec`, `service_role_exec` all `false`.
2. Log: `relrowsecurity = true`, `authenticated_select = false`, `anon_select = false`, `service_role_select = true`,
   `policies = 0`, `rows = 0`.
3. By hand: Supabase dashboard, Authentication, Hooks: **no** custom access token hook points at
   `custom_access_token_hook_shadow` (the file's last comment). This check is not SQL and I cannot run it.

A row is marked applied in `MIGRATION-QUEUE.md` only after its post-check passed (`MIGRATION-QUEUE.md:6-9`).

## 6. Rollback

Rollback id: `20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql` (both rows). It drops the hook function and the
log table and self-checks (`...rollback.sql:38-43`). Precondition: the hook is not configured in Auth; otherwise disable it in
Auth first, or every sign-in fails on a missing function (`:7-9`). The log holds ids and counters only; export it first if soak
evidence is still needed (`:11-13`).

It acts only when `tenant_claim_mismatch_log` exists, because it shares the version `20261102032000` and sorts between the two
forward files (`:17-19`). To undo only row 17 (row 18 not applied), the lane gives one statement:
`DROP FUNCTION IF EXISTS public.custom_access_token_hook_shadow(jsonb);` (`acceptance.md:98-108`). Dry-run: part A and B above
(rollback, second rollback no-op, re-apply).

## 7. Apply window

- Row 17 then row 18, one dispatch per file, post-check after each (`MIGRATION-QUEUE.md:6-9`; row 18 "Depends on #17"). Row 17
  has no other dependency than the existing `user_tenants` (`MIGRATION-QUEUE.md:35`).
- Not while `MIGRATION_FREEZE` is `true` (`RUN-MIGRATION.yml:55-58`).
- Off-peak, per the plan rule for DB slices (`.kiro/specs/mt-identity-r2/plan.md:237-239`). Both files use `lock_timeout 3s`
  and `statement_timeout 60s` (`...032000...sql:55-56`) and touch no existing table, so locks are on new objects only. Low traffic is
  a convenience here, not a need.
- Readers to retire first: none. Nothing calls the function or reads the table until Auth is pointed at the hook, and no code in
  either repo reads `tenant_id_shadow` (the lane changes no gateway or workflow file, `acceptance.md:88-92`).
- Ordering with other rows: independent of rows 12-13 and 14-16 (`MIGRATION-QUEUE.md:35`, "Depends on" `—`). The GO-LIVE lane
  later needs the bare-policy lint at 0 (rows 12-13) and a 7-day mismatch soak first (`plan.md:295`, `:304`).

**Window date: left for the owner.**

## 8. Decision for you beyond the approval

The plan calls for a "7-day mismatch soak before any go-live" (`plan.md:304`). Rows 17-18 alone collect no soak data, because
the log fills only after Auth is pointed at the hook (section 2). The lane puts that Auth step in the owner-applied GO-LIVE lane
(D14), not in this one. If you want a shadow soak first, someone has to enable the hook in Auth in shadow mode, and that is an
Auth configuration change that no lane in the queue covers today. Say whether you want it planned as its own lane.

## 9. Recommendation

Approve rows 17 and 18 together, in order. They are additive, touch no existing object, change no claim and are inert until an Auth
setting you control is changed. Run the `pre` queries and the `post` queries; then decide section 8 separately.

## 10. Evidence index

`acceptance.md`, `post-check.sql`, `commands.log`, `outputs/pglite-green-36.txt`, `outputs/pglite-red-first-assertion.txt`,
`outputs/static-checks.txt`, `pglite/run.mjs`, `pglite/shim.sql` (lane evidence); `owner-packet-outputs/dry-run.mjs`,
`owner-packet-outputs/dry-run.txt` (this packet).
