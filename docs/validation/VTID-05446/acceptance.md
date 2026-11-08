# VTID-05446 acceptance (mt-guardrails-r2/isolation-suite)
Change types: Tooling/docs, Database (test only; no migration, no policy change).

Outcome: `scripts/ci/sql-tests/run-mt-isolation-test.sh` runs `scripts/ci/sql-tests/mt-isolation.test.sql` on the PGlite local stack through the
pgTAP-compatible shim and is green. **Real pgTAP and `pg_prove` are not used** (plan.md Amendment 2, decision 7). It touches no database but the
in-process one, no network and no secret.
States: a table the stack cannot replay is **UNVERIFIED**: listed on its own line, counted as neither passed nor failed, never `ok`
(`--strict` makes it FAIL, Amendment 3 decision 3). A leak or a write that is not rejected makes the suite red.
Surfaces: n/a: no screen. Callers: a developer and, after the ci-wiring lane, CI (`--expect "PASS mt-isolation"`).
Locales: n/a. Accessibility: n/a.
Contract: every claim is on NON-PRODUCTION tenant resolution and policies (docs/multitenancy/LOCAL-STACK.md, "Isolation gap on the present
tables"); the suite says so in its output. Staging proof: not verified on staging: the lane deploys nothing.

AC-1 — for each replayed table of the 18 tenant tables, the health tables (list read from scripts/mt/inventory/health-tables.json, not copied) and user_tenants, b_member sees 0 T_A / CANARY_A rows, and T_A rows exist as the owner (the zero is not an empty table)
  TEST: scripts/ci/sql-tests/mt-isolation.test.sql ("b_member sees 0 T_A / CANARY_A rows", "T_A / CANARY_A rows exist"), run by run-mt-isolation-test.sh; outputs/green.txt

AC-2 — a b_member insert carrying a T_A tenant_id is rejected by RLS (SQLSTATE 42501) on every replayed table with a write path, and the same insert with a T_B tenant_id is accepted (control)
  TEST: scripts/ci/sql-tests/mt-isolation.test.sql ("insert with a T_A tenant_id is rejected by RLS", "control, the same insert with a T_B tenant_id is accepted"); outputs/mutations.txt

AC-3 — ab_dual reads and writes a health series in the T_A context and sees no other member's health rows; the single-series-across-contexts claim is reported UNVERIFIED (not passed) because the replayed policy scopes health rows by tenant_id
  TEST: scripts/ci/sql-tests/mt-isolation.test.sql ("ab_dual writes a health row", "ab_dual reads the series it wrote", "ab_dual sees no other member's health rows", "UNVERIFIED ab_dual single health series")

AC-4 — a table the stack cannot replay is never reported as passing: default mode prints one `# UNVERIFIED <table>` line each with its reason; `--strict` fails the suite on each
  TEST: scripts/ci/sql-tests/mt-isolation.test.sql (require_table / "# UNVERIFIED"); outputs/green.txt, outputs/strict.txt (exit 1, 14 failed)

AC-5 — the runner starts with the PGHOST guard copied from run-tenant-foundation-test.sh:18-20 (*supabase*|*amazonaws*|*rds* exits 2), runs under set -euo pipefail, and `--self-test` proves PGHOST=x.supabase.co exits 2
  TEST: scripts/ci/sql-tests/run-mt-isolation-test.sh --self-test; outputs/self-test.txt, outputs/guard.txt

AC-6 — `PASS mt-isolation` is the last line, printed only after the run exits 0; a red suite prints FAIL and exits 1
  TEST: scripts/ci/sql-tests/run-mt-isolation-test.sh; outputs/green.txt (last line), outputs/mutations.txt (RED cases), outputs/red-on-base.txt (runner absent on origin/main, exit 127)

AC-7 — the suite subjects equal supabase/tests/local-stack/required-tables.txt (no table silently dropped)
  TEST: scripts/ci/sql-tests/mt-isolation.test.sql ("suite subjects = required-tables.txt")
