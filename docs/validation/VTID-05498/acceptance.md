# VTID-05498 — mt-packs-r2 / kb-overlay-db

Plan: `.kiro/specs/mt-packs-r2/plan.md` and the `kb-overlay-db` group of `tasks.md` (D1-D3). Sparring record:
`plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (migration file, pgTAP and read-only SQL only; the PR carries no gateway code).
ROUTE_MOUNT: none. FINAL_URL: n/a. Change types: Database. Nothing is applied from the PR; the file is applied later
through `RUN-MIGRATION.yml` after the owner approves the file and the target database (collaboration.md §7d). Kiro ran no
SQL against any live system; the local runs are in-process PGlite (`pglite-harness/`).

## Files

| Task | File |
|---|---|
| D1 expand-only column | `supabase/migrations/20261102080000_mt_packs_knowledge_docs_tenant_id.sql` |
| D2 pgTAP (15 cases) | `supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql` |
| D3 queue row 40 / drift baseline | `docs/multitenancy/MIGRATION-QUEUE.md`; `scripts/ci/migration-drift-baseline.json` (comment only; this lane does not touch `count` or the list) |
| D3 rollback / read-only checks | `rollback.sql`, `pre-check.sql`, `post-check.sql` |
| static gate | `static-checks.test.cjs` |

## Acceptance

AC-1 (D1) `knowledge_docs.tenant_id uuid NULL REFERENCES tenants(tenant_id)`: nullable, no default, no backfill, every
existing column unchanged.
TEST: pgTAP cases 1-9 in supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql.

AC-2 (D2) A NULL (baseline) row resolves, an old writer that omits the column still works, an overlay row belongs to
its tenant only, an unknown tenant fails the FK, and `path` stays unique.
TEST: pgTAP cases 10-15 in supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql.

AC-3 (D1/D3) The migration applies twice without error and rolls back clean; the queue row carries rollback and
pre/post checks; this lane adds no baseline table entry.
TEST: node --test docs/validation/VTID-05498/static-checks.test.cjs (6 tests), and
`outputs/read-only-checks-and-rollback-pglite.txt`, `outputs/pgtap-green-applied-twice.txt`.

AC-4 Nothing is applied from the PR: the migration contains no DML, no DROP, no index and no policy.
TEST: node --test docs/validation/VTID-05498/static-checks.test.cjs (the expand-only test).

## Red / green

- Baseline independence (reviewer fix-forward 1): the pgTAP file inserts its own rows under the path prefix `vtid05498/`
  and filters or compares on them. It needs no fixture row: `base_schema.sql` no longer seeds one, and
  `pglite-harness/lane.sh --seed-extra` loads 5 unrelated baseline rows before the migration; green both ways
  (`outputs/pgtap-green.txt`, `outputs/pgtap-green-seeded-baseline.txt`), red without the migration both ways.
- pgTAP red without the migration: `outputs/pgtap-red-no-migration.txt`; green: `outputs/pgtap-green.txt` (15 ok), twice:
  `outputs/pgtap-green-applied-twice.txt`.
- Static test red on origin/main: `outputs/static-red-on-origin-main.txt` (1 pass, 5 fail); green:
  `outputs/static-green.txt` (6 pass).
- Drift check unit test: `node --test scripts/ci/check-migration-drift.test.cjs` 8 pass.

## Decisions taken

- The FK targets `tenants(tenant_id)`, the live key (VTID-04716), not `tenants(id)` as the plan text says.
- No `known_missing_tables` entry: the drift check reads `CREATE TABLE` only, so a column is not tracked and a table
  entry named `knowledge_docs` would be wrong (the table is live). The baseline gets a `_comment_vtid_05498` note and
  this lane does not change its `count` or list.
- The queue row is numbered 37, after the last row. Numbering and the baseline count may shift at landing.
- No index and no RLS change in this expand-only lane (see Open items).

## Open items for kb-overlay-code (not changed here, deferred)

- `knowledge_docs_authenticated_select` (20260216000000_security_linter_fixes.sql:107-108) is `USING (true)`: once
  overlay rows exist, any authenticated client could read every tenant's overlay. The kb-overlay-code readers must go
  through the gateway with the service role, or a follow-up lane must narrow that policy before the first overlay write.
- `knowledge_docs.path` is `UNIQUE`: an overlay document cannot reuse a baseline path, so overlay paths need their own
  namespace (pgTAP case 15 pins this). Changing the constraint to `(path, tenant_id)` would alter
  `upsert_knowledge_doc()` conflict behaviour and is not part of an expand-only column.
- An index on `tenant_id` is left to the reader lane once the query shape is known.

## Before the first overlay write (not owned by this lane)

Two read paths are open to every authenticated client and are NOT narrowed by any lane of this plan
(kb-overlay-code is gateway TypeScript only): the policy `knowledge_docs_authenticated_select USING (true)` and the
`search_knowledge_docs` RPC, which would also return overlay rows. Before the first overlay row is written, a new lane or
a plan amendment must narrow the policy (baseline rows and the caller's own tenant only) and the RPC. This lane does not
change either; it adds the nullable column only.

## Decision taken (fix-forward 1)

After merging `origin/main`, the baseline there reads `count` 118 with 119 listed tables (VTID-05493 added
`bak_vtid_05493_tenant_lifecycle` to the list without moving the count). That mismatch is main's, not this lane's. The
static test therefore no longer asserts `count == len(list)`; it asserts this lane adds no `knowledge_docs` entry and keeps
its comment. The baseline's count is not edited here (outside the lane's task).
