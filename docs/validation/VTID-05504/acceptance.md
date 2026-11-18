# VTID-05504 — mt-m3-r2 / morning-health-pertenant

Plan: `.kiro/specs/mt-m3-r2/plan.md` and the `morning-health-pertenant` group of `tasks.md` (W1-W2). Sparring record:
`plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (one GitHub Actions workflow plus CI Jest evidence; no gateway source changes).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied and no live system is written. The new step calls the read-only
function `ci_tenant_isolation_health_by_tenant()` (VTID-05506, migration 20261102141100) with the service role, the same
way row 21b calls `ci_tenant_isolation_health()`.

## Files

| Task | File |
|---|---|
| W1 per-tenant breakdown, step 21c | `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` |
| test (written first, red on origin/main) | `docs/validation/VTID-05504/morning-health-pertenant.test.ts` |

## Acceptance

AC-1 (W1) The morning report gets step `21c. Tenant isolation per tenant (report-only, VTID-05504)` after 21b. It POSTs
`ci_tenant_isolation_health_by_tenant()` and writes one summary row (tenant count, tenants with findings, scan errors)
and one row per tenant that has a finding, at most 15, then a `+N more` row. Each row carries only that tenant's own
numbers, labelled by slug; the row without a tenant is `unattributed`, a dangling id is `unregistered <id>`. A slug is
cleaned so it cannot break the markdown table.
TEST: morning-health-pertenant.test.ts "writes one INFO row per tenant", "adds a summary row", "labels the row without a tenant", "caps the rows", "cleans a hostile slug".

AC-2 (W1) Report-only and read-only: every row is INFO, never PASS or FAIL, the step never exits non-zero and does not
touch `TOTAL_CHECKS`; a non-200 reply (function not applied yet), a reply that is not a JSON object, or an object with
no `tenants` list each give one INFO row. The only call is the POST of the by-tenant function.
TEST: morning-health-pertenant.test.ts "exists, is report-only", "posts only to the by-tenant rpc, once", "HTTP 404/500 ... exit 0".

AC-3 (W2) Row 21b keeps calling `ci_tenant_isolation_health()` and its body is byte-identical; the existing
`vtid-05149-tenant-context.test.ts` row 21b cases stay green.
TEST: morning-health-pertenant.test.ts "keeps row 21b on the whole-database function, unchanged"; vtid-05149-tenant-context.test.ts.

AC-4 No sentence Vitana speaks is written (CLAUDE.md NEVER 41): the rows are report text, not speech.
TEST: morning-health-pertenant.test.ts "exists, is report-only" (no spoken text is produced by the step).

Not verified on staging: see `staging-tests.json` (workflow-only change, deploys nothing).
