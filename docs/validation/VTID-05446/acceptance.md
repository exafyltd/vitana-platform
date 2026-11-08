# VTID-05446 acceptance (mt-guardrails-r2/isolation-suite)
Change types: Tooling/docs, Database (test only; no migration, no policy change).

Outcome: `scripts/ci/sql-tests/run-mt-isolation-test.sh` runs `scripts/ci/sql-tests/mt-isolation.test.sql` on the PGlite local stack through the
pgTAP-compatible shim. **STRICT is the default (reviewer round 1 fix): on the current stack 14 claims are unverified, so the default run is RED (exit 1,
no `PASS mt-isolation`) by design (plan.md Amendment 3, decision 3; LOCAL-STACK.md "an isolation suite cannot go green over a table the stack does not have").**
`--report` is the explicit opt-in: it lists the UNVERIFIED claims, exits 0 and ends with `REPORT mt-isolation: ...`, never `PASS mt-isolation`. **Real pgTAP and `pg_prove` are not used** (plan.md Amendment 2, decision 7). It touches no database but the
in-process one, no network and no secret.
States: a table the stack cannot replay is **UNVERIFIED**: in `--report` mode listed on its own line, counted as neither passed nor failed, never `ok`;
in the default (strict) mode it FAILS (Amendment 3 decision 3). The ab_dual single-series claim FAILS by default and is listed UNVERIFIED only in
`--report`, citing skipped migration 20251231000000_vtid_01103_health_compute_engine.sql. A leak or a write that is not rejected makes the suite red.
Surfaces: n/a: no screen. Callers: a developer and, after the ci-wiring lane, CI (`--expect "PASS mt-isolation"`).
Locales: n/a. Accessibility: n/a.
Contract: every claim is on NON-PRODUCTION tenant resolution and policies (docs/multitenancy/LOCAL-STACK.md, "Isolation gap on the present
tables"); the suite says so in its output. Staging proof: not verified on staging: the lane deploys nothing.

AC-1 — for each replayed table of the 18 tenant tables, the health tables (list read from scripts/mt/inventory/health-tables.json, not copied) and user_tenants, b_member sees 0 T_A / CANARY_A rows, and T_A rows exist as the owner (the zero is not an empty table)
  TEST: scripts/ci/sql-tests/mt-isolation.test.sql ("b_member sees 0 T_A / CANARY_A rows", "T_A / CANARY_A rows exist"), run by run-mt-isolation-test.sh; outputs/report-mode.txt

AC-2 — a b_member insert carrying a T_A tenant_id is rejected by RLS (SQLSTATE 42501) on every replayed table with a write path, and the same insert with a T_B tenant_id is accepted (control)
  TEST: scripts/ci/sql-tests/mt-isolation.test.sql ("insert with a T_A tenant_id is rejected by RLS", "control, the same insert with a T_B tenant_id is accepted"); outputs/mutations.txt

AC-3 — ab_dual reads and writes a health series in the T_A context and sees no other member's health rows; the single-series-across-contexts claim FAILS by default (strict) and is reported UNVERIFIED only in --report, because the replayed policy scopes health rows by tenant_id (production policy is in the skipped migration 20251231000000_vtid_01103_health_compute_engine.sql)
  TEST: scripts/ci/sql-tests/mt-isolation.test.sql ("ab_dual writes a health row", "ab_dual reads the series it wrote", "ab_dual sees no other member's health rows", "ab_dual reads the same single health series from the T_B context"); outputs/strict-default.txt (not ok 58), outputs/report-mode.txt (# UNVERIFIED ab_dual)

AC-4 — a table the stack cannot replay is never reported as passing: the default (strict) run fails the suite on each (exit 1, 14 failed, no `PASS mt-isolation`); `--report` prints one `# UNVERIFIED <table>` line each with its reason, exits 0 and never prints `PASS mt-isolation`
  TEST: scripts/ci/sql-tests/run-mt-isolation-test.sh --self-test-default (exit 0 only when the default run is red without the marker and --report is green without it); outputs/strict-default.txt (exit 1), outputs/report-mode.txt (exit 0, last line REPORT), outputs/self-test-default.txt; red before the fix: outputs/red-strict-default-test.txt

AC-5 — the runner starts with the PGHOST guard copied from run-tenant-foundation-test.sh:18-20 (*supabase*|*amazonaws*|*rds* exits 2), runs under set -euo pipefail, and `--self-test` proves PGHOST=x.supabase.co exits 2
  TEST: scripts/ci/sql-tests/run-mt-isolation-test.sh --self-test; outputs/self-test.txt, outputs/guard.txt

AC-6 — `PASS mt-isolation` is the last line, printed only after a strict run exits 0 with nothing unverified; a red suite prints FAIL and exits 1; --report never prints it
  TEST: scripts/ci/sql-tests/run-mt-isolation-test.sh; outputs/strict-default.txt, outputs/report-mode.txt, outputs/mutations.txt (runner mutations: default flipped back, report prints PASS: both caught) (RED cases), outputs/red-on-base.txt (runner absent on origin/main, exit 127)

AC-7 — the suite subjects equal supabase/tests/local-stack/required-tables.txt (no table silently dropped)
  TEST: scripts/ci/sql-tests/mt-isolation.test.sql ("suite subjects = required-tables.txt")

Decisions taken (fix attempt 1, reviewer verdict changes): strict is the default and there is no environment override (only `--report` turns it off); `--strict` stays as an alias of the default; the report-mode final line is `REPORT mt-isolation: ...`, which cannot match `^PASS mt-isolation`; a runner-side guard also refuses to print PASS over any unverified claim. No workflow on main runs this runner (git grep of .github, package.json, scripts), so no required check goes red; ci-wiring's C3 gate on `^PASS mt-isolation` will stay red until the 14 tables are replayable, as intended.
