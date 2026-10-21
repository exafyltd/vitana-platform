# VTID-05124 - FU8: delete the orphan `memberships` rows left by deleted accounts

Owner approval 2026-10-12 (Gate 1: "Yes"). Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none. This PR adds one data-fixup migration and its rollback. No service deploys and nothing is applied at merge.

FINAL_URL: n/a (database only). Staging shares the production database, so the fix-up is applied once, through `RUN-MIGRATION.yml`, after `live-before.sql` re-confirms 10..14 orphans, 0 FK dependents and 0 live identities (Gate 1 covers this dispatch; no STAGING-VERIFY because nothing deploys).

CURL_PROOF: none possible without a write. Behaviour is proven on PGlite (`pglite-migration-check.mjs`, `outputs/pglite-migration-check.txt`) and, after apply, by the read-only `post-apply-checks.sql`.

OASIS_PROOF: no OASIS events; no gateway state transition is added.

## Live facts used (read-only, 2026-10-12, project inmkhvwdcuyhnxkgfvsb)

- `memberships`: 235 rows; 12 with a user_id in neither `auth.users` nor `app_users` (maxina 11, alkalma 1; 11 community, 1 reseller; `updated_at = created_at`); 0 of them with a `user_tenants` or `profiles` row.
- Constraints: pkey, status check, UNIQUE (user_id, tenant_id), tenants FK only. 0 FKs reference `memberships`; 0 triggers.
- `admin_system_health`: total_memberships 235, active_memberships 235. Archive table absent.

## Acceptance criteria

AC-1: The migration archives the full rows (all 7 columns + captured_at) of every `memberships` row whose user exists in neither `auth.users` nor `app_users` into `legacy_archive.bak_fu8_orphan_memberships_20261012`, with no client access, before deleting anything.
  TEST: docs/validation/VTID-05124/pglite-migration-check.mjs ("apply: archive holds 12 rows", "apply: archive has all 7 columns + captured_at", "apply: anon cannot read the archive")

AC-2: It deletes exactly the archived rows (by archived id) and nothing else; real members' rows, including inactive ones, stay byte-identical; post-check inside the transaction: 0 memberships without an `auth.users` row.
  TEST: pglite-migration-check.mjs ("apply: every orphan deleted", "apply: real members' rows untouched, byte-identical", "apply: post-check orphans = 0")

AC-3: It aborts and writes nothing (no archive, memberships unchanged) when the archived count is outside 10..14, when an archived user has a `user_tenants` or `profiles` row, or when any FK references `memberships`.
  TEST: pglite-migration-check.mjs ("aborts on 20 orphans", "aborts on 9 orphans", "boundary: 14 orphans are deleted", "aborts when an orphan has a profiles row", "aborts when a FK references memberships")

AC-4: A second run fails loudly on the existing archive table and changes nothing.
  TEST: pglite-migration-check.mjs ("second run fails loudly (archive exists)", "...and the archive is untouched")

AC-5: The rollback restores the archived rows byte-identical (same ids, values and timestamps), is a no-op when re-run, and aborts instead of overwriting when a deleted (user_id, tenant_id) was re-created.
  TEST: pglite-migration-check.mjs ("rollback: memberships restored byte-identical", "rollback re-run is a no-op", "rollback aborts on a re-created (user_id, tenant_id)")

AC-6: Right before apply, the read-only pre-check shows 10..14 orphans, 0 FK dependents and 0 live identities; otherwise the apply is abandoned and the new count reported to the owner.
  CURL: docs/validation/VTID-05124/live-before.sql (run read-only 2026-10-12: total 235, orphans 12, fk_dependents 0, live_identities 0, archive absent; re-run before RUN-MIGRATION)

AC-7: After apply, read-only checks show 0 orphan memberships, 12 archived rows none still present, 223 memberships, `admin_system_health` total/active memberships each 12 lower, and the archive not readable by anon/authenticated.
  CURL: docs/validation/VTID-05124/post-apply-checks.sql (run read-only after RUN-MIGRATION; results recorded in outputs/)
