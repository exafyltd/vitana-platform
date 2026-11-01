# Sparring round 1 — in_progress

Session: `c30d4bc1-ef3f-47be-b2e7-1b04c31e86b8` · plan hash `9e7de1b737a7b2b0ec061bdf1acb02ab1148d028abfa68212e5402132a74f5bd`

## Summary

Verified 12+ premises against the pinned commit; most hold. One major finding about the row 21b SUPABASE_URL "alignment" fix that could silently disable production isolation monitoring when the Aurora flip activates. The rest of the plan is well-structured, with correct references to existing patterns and files.

## Findings

### R1-F1 [major]

The plan's 'one-line fix' changing row 21b's `SUPABASE_URL` from `secrets.SUPABASE_URL` to `vars.DATA_REST_URL || secrets.SUPABASE_URL` would silently disable production tenant isolation monitoring when `DATA_REST_URL` is set. `ci_tenant_isolation_health()` queries Supabase-only tenant tables (`tenants`, `user_tenants`, membership drift, etc.). When `DATA_REST_URL` is set to Aurora (`https://data.vitanaland.com`), the RPC would 404 there and fall into the `HTTP != 200` branch (line 556–558), permanently reporting `INFO | RPC HTTP 404 (not applied yet?)` — masking the isolation signal. Row 21 (`ci_memory_health`) uses `DATA_REST_URL` correctly because memory tables may migrate to Aurora; tenant/membership tables do not. The current direct use of `secrets.SUPABASE_URL` for row 21b is intentionally correct, not an inconsistency to fix.

- `exafyltd/vitana-platform:.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml:545` — SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
... if [ "$HTTP" != "200" ]; then
  echo "| 21b | Tenant isolation health | INFO | RPC HTTP $HTTP (not applied yet?) |" >> "$REPORT"
  exit 0
- `exafyltd/vitana-platform:.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml:497` — # VTID-05023 part 9: REST base; repo variable DATA_REST_URL (unset = Supabase as before)
# is https://data.vitanaland.com (Aurora) after the flip.
SUPABASE_URL: ${{ vars.DATA_REST_URL || secrets.SUPABASE_URL }}

Suggestion: Do NOT change row 21b's URL. The direct `secrets.SUPABASE_URL` binding is correct because `ci_tenant_isolation_health()` queries Supabase-only tenant tables. Add a comment explaining why it deliberately differs from rows 5–12/21 (those RPCs follow the Aurora flip; this one does not).

### R1-F2 [minor]

The plan says the isolation workflow uses `runs-on: ubuntu-24.04` (pinned for the apt package), but every existing SQL workflow uses `runs-on: ubuntu-latest` (SQL-HEALTH-STORE.yml:23, SQL-TENANT-FOUNDATION.yml:32). When GitHub eventually retires ubuntu-24.04 as a named runner, the new workflow will break while the old ones silently migrate. The divergence is explained but the plan doesn't document a maintenance trigger for re-aligning.

- `exafyltd/vitana-platform:.github/workflows/SQL-HEALTH-STORE.yml:23` — runs-on: ubuntu-latest
- `exafyltd/vitana-platform:.github/workflows/SQL-TENANT-FOUNDATION.yml:31` — sql:
      runs-on: ubuntu-latest

Suggestion: Add a note in the Pinned Versions table or LOCAL-STACK.md that the runner pin must be reviewed when GitHub announces ubuntu-24.04 deprecation, or when `ubuntu-latest` moves to 26.04+.

### R1-F3 [minor]

The plan states `supabase/postgres:17.4.1.074` ships `pgtap` as a built-in extension, which is the reason for choosing it over stock `postgres:16`. This is unverifiable from the repository code alone — no file in the repo documents which extensions that image bundles. If the image does NOT ship `pgtap`, the entire pgTAP-based isolation suite (lane 3) is blocked. The plan's spike (lane 1, task 1) would catch this, but if it fails, lanes 1–3 and 6 are all blocked with no fallback.

- `exafyltd/vitana-platform:docs/SUPABASE-SECURITY-ADVISOR-AUDIT-2026-08-28.md:60` — - **`vulnerable_postgres_version`**: currently `supabase-postgres-17.4.1.074`
  with patches outstanding.
- `exafyltd/vitana-platform:.github/workflows/SQL-HEALTH-STORE.yml:26` — image: postgres:16

Suggestion: Lane 1's spike task should explicitly test `CREATE EXTENSION IF NOT EXISTS pgtap` and `SELECT * FROM pg_available_extensions WHERE name = 'pgtap'` and record the result. If pgtap is absent, document the fallback (e.g., installing it from the pgTAP GitHub release inside the container). Mention this check explicitly in the Tests section.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
