# VTID-05445 acceptance (mt-guardrails-r2/generated-inventories)
Change types: Tooling/docs, Database.

Outcome: generators in `scripts/mt/inventory/` read the local PGlite schema (VTID-05520 stack) and the route and edge trees and emit
checked-in JSON inventories; `scripts/mt/lint/` applies five DB lints and a bare-policy counter against an owner-tagged allowlist.
A developer regenerates with `node scripts/mt/inventory/generate.mjs` and checks drift with `--check`; lints run with
`node scripts/mt/lint/run.mjs` (`--strict` exits 1 on a finding outside the allowlist).
States: a table in `supabase/tests/local-stack/not-replayable.txt` is reported `unverified` in every inventory and every lint, never
passing; an allowlist entry without owner or reason is rejected; an allowlist entry that matches no finding is reported stale.
Surfaces: n/a: no screen. Callers are developers and the later lanes (isolation-suite, gateway-scope-lint-contract, ci-wiring).
Locales: n/a. Accessibility: n/a.
Contract: inventories are JSON with sorted keys and arrays, two-space indent, trailing newline, no timestamp. Sources: tables,
functions and realtime tables from the PGlite catalog; routes and edge functions from the source trees; buckets and storage policies
from migration text (the `storage` schema does not replay on PGlite, those rows carry `source: migrations`).
Staging proof: not verified on staging: the lane changes no runtime surface and deploys nothing. The covering tests are the lane's node tests.

AC-1 (G1) — generators emit tables, functions, routes, edge functions, realtime tables and buckets as JSON; a fixture schema yields the expected rows
  TEST: scripts/mt/inventory/inventory.pglite-tests.mjs ("fixture inventories")

AC-2 (G1) — output is deterministic: sorted, no timestamps, identical on two runs
  TEST: scripts/mt/inventory/inventory.pglite-tests.mjs ("determinism")

AC-3 (G1, G5) — the committed inventories under scripts/mt/inventory/data regenerate byte-identically from the repo
  TEST: scripts/mt/inventory/inventory.pglite-tests.mjs ("drift guard")

AC-4 (G2) — the five lints flag a bad fixture and pass a clean one: nullable tenant_id, missing tenant policy, DEFINER without revoke or caller check, realtime table without tenant RLS, storage policy
  TEST: scripts/mt/lint/lint.pglite-tests.mjs ("db lints")

AC-5 (G2) — the allowlist is owner-tagged: entries need lint, subject, owner, reason; an allowed finding is reported as allowed; a stale entry is reported
  TEST: scripts/mt/lint/lint.pglite-tests.mjs ("allowlist")

AC-6 (G3) — the bare-policy counter counts policies using current_tenant_id() without auth.uid(), current_user_id(), is_member or is_tenant_admin, outside the allowlist, and reports the number without asserting 0
  TEST: scripts/mt/lint/lint.pglite-tests.mjs ("bare-policy counter")

AC-7 (G4) — one health-table list with the five tables of docs/MULTI-TENANT-PLAN.md section 2, checked against the plan text
  TEST: scripts/mt/inventory/extract.test.mjs ("health table list")

AC-8 — a table of not-replayable.txt is `unverified` in the inventories and the lints, never passing, and the summary counts it separately
  TEST: scripts/mt/lint/lint.test.mjs ("unverified tables", over the committed inventories); scripts/mt/lint/lint.pglite-tests.mjs and scripts/mt/inventory/inventory.pglite-tests.mjs ("unverified tables")

AC-9 (G5) — the tests that need no database run in the required `unit` check (UNIT.yml runs every scripts/**/*.test.mjs on Node 20 without an install): scanners, renderer, allowlist, lints over hand-built inventories, bare-policy counter, committed inventories in canonical form
  TEST: scripts/mt/inventory/extract.test.mjs; scripts/mt/lint/lint.test.mjs (red: outputs/red-unit-without-pglite.txt)

## Decisions taken
1. Real-schema findings are reported, not gated: the CLI exits 0 by default and 1 under `--strict`. The gate on the real schema belongs to ci-wiring (N3 is a WS1 gate).
2. `allowlist.json` ships with no entries: which tables are tenant-shared is an owner decision, and an invented owner tag would be false.
3. Realtime tables are the union of `pg_publication_tables` and `ALTER PUBLICATION ... ADD TABLE` in migration text, because a migration that fails on PGlite is a skip.
4. Routes are listed per source file with the path as written, the mount prefix is not resolved (like aurora-migration-inventory.cjs, an inventory of call sites).
5. No CI workflow and no package.json script: both are outside the lane's paths. The tests that need PGlite are named `*.pglite-tests.mjs`, not `*.test.mjs`, because the required `unit` check (UNIT.yml) runs every `scripts/**/*.test.mjs` on Node 20 with no install and a PGlite test there fails on `Cannot find package '@electric-sql/pglite'` (seen on the PR head a07a93213b). They run with `node --test scripts/mt/inventory/inventory.pglite-tests.mjs scripts/mt/lint/lint.pglite-tests.mjs`; no required CI job runs them until ci-wiring wires them (MT-LOCAL-STACK or `test:mt-stack`). The database-free tests are `*.test.mjs` and run in `unit`.

## Measured (outputs/green.txt, outputs/lint-report.txt, outputs/drift-check.txt)
- Inventories from the real stack: 471 tables (458 verified, 13 unverified = the 13 of not-replayable.txt), 395 functions (97 SECURITY DEFINER, executable, no caller check), 1562 route call sites in 271 files, 2 edge functions, 4 realtime tables (3 unverified), 2 buckets, 9 storage policies. Generation takes about 6 s.
- Lint report on the real schema (no allowlist entries): nullable tenant_id 20, missing tenant policy 232, DEFINER without guard 97, realtime without tenant RLS 1, storage policy 2; bare policies 21 (reported, not asserted 0; a lower bound because skipped migrations and the 13 unverified tables are not counted). 29 lint results are unverified.
- Tests: 26 database-free tests (`unit` check) and 31 PGlite tests, all green; red on base: 2 of 2 files fail (outputs/red-on-base.txt).
- Not run here: any CI job (the lane adds no workflow, package script or path outside its allowed paths).
