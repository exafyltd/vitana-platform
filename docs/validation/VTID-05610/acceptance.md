# VTID-05610 - mt-schema-queue-followup-r2 / provision-test-flags-subset

Plan: `.kiro/specs/mt-schema-queue-followup-r2/plan.md` and the `provision-test-flags-subset` group of `tasks.md`.

VALIDATION_PROFILE: database (one pgTAP/SQL assertion file; no migration, no live system).
Change types: Database, Tooling/docs. Nothing is applied from the PR; Kiro ran no SQL against any live system. Local runs are in-process PGlite.

## Change

`supabase/tests/vtid_05150_provision_tenant.test.sql` (line 144): the whole-object `feature_flags = '{"jev":...}'` equality is replaced by
1. `feature_flags -> 'jev'` equals the exact jev object, and
2. `feature_flags - 'jev' - 'erp' = '{}'::jsonb`: the only other key tolerated is `erp` (VTID-05506, migration 20261102141000, makes
   `provision_tenant()` set `feature_flags.erp.bootstrap_requested = true`). Any other key still fails.

## Acceptance

AC-1 CI stays green before and after VTID-05506's migration lands.
TEST: `outputs/new-assertion-without-141000-GREEN.txt` (exit 0) and `outputs/new-assertion-with-141000-GREEN.txt` (exit 0), via `run-pglite.mjs` [--with-141000].

AC-2 With the `erp` key present the old assertion is red and the new one green; without it both are green.
TEST: `outputs/old-assertion-with-141000-RED.txt` (exit 1, "jev flag (Alkalma pattern, budget param)") vs `outputs/new-assertion-with-141000-GREEN.txt`; `outputs/old-assertion-without-141000.txt` (exit 0).

AC-3 An unknown extra key still fails (the assertion is no looser than before except for `erp`).
TEST: `outputs/mutation-unknown-key-without-141000-RED.txt` and `outputs/mutation-unknown-key-with-141000-RED.txt` (exit 1, "feature_flags holds no key besides jev (and erp, VTID-05506)"); the mutation is a trigger adding `feature_flags.rogue`.

AC-4 Only the pgTAP file changes: no migration, no other test.
TEST: `scope.json` paths; `git diff --stat origin/main` lists the test file and `docs/validation/VTID-05610/**` only.

## Staging proof
Not verified on staging: test-only, no deploy. Covered by the PGlite runs in `commands.log`. CI runs the real runner
`scripts/ci/test-vtid-05150-provision-tenant.sh` (PostgreSQL) and is authoritative; no local PostgreSQL is available here.
