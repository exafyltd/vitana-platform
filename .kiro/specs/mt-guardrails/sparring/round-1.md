# Sparring round 1 — in_progress

Session: `61f4c87b-cc79-4384-8172-135573b9d1cc` · plan hash `6e3c959754ced793b7cd58fcd542c3b0daee90ef05b4fbd5eb3fa08dd78ed631`

## Summary

Verified 7 premises against pinned code. Most structural claims hold: the migration, health-check workflow row 21b, MIGRATION-QUEUE doc, PR-GATE config pattern, directory layouts, and absence of golden/pgTAP tooling are all confirmed. One significant dependency gap found: the `isHealthTable()` predicate referenced as a cross-spec deliverable does not exist anywhere in either repository. One minor gap regarding the row 21b URL binding discrepancy.

## Findings

### R1-F1 [major]

The pgTAP isolation suite (lane 3) references `isHealthTable()` as an existing predicate owned by mt-identity (CROSS-SPEC O1), saying it will use 'the mt-identity isHealthTable() list, not a local copy' to determine which tables are health tables. This predicate does not exist anywhere in either repository. Multiple searches across both repos return zero hits. The plan treats it as an available dependency but provides no VTID, no migration, and no code path that creates it. Lane 3 cannot be implemented as written without this predicate — either it must define/create the predicate itself (violating the stated cross-spec ownership), hardcode the list (contradicting the explicit 'not a local copy' constraint), or block on an untracked dependency.

- `exafyltd/vitana-platform:supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql:46` — SELECT c.table_name::text AS table_name FROM information_schema.columns c ... WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.data_type = 'uuid' AND c.table_name <> 'tenants'
- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:24` — Health tables (`health_features_daily`, `biomarker_results`, `wearable_samples`, `partner_health_test_orders`, `data_sharing_consents`) are `tenant_id = current_tenant_id() AND user_id = current_user_id()`

Suggestion: Either (a) explicitly define the health-table list as a shared constant/config created by this spec (lane 2 inventories or lane 3 pgTAP setup), referencing the enumeration already in MULTI-TENANT-PLAN.md §2 as the source of truth until the mt-identity spec delivers the predicate; or (b) add the mt-identity VTID that creates `isHealthTable()` as a hard dependency of lane 3, with a concrete fallback if it ships later. The plan must not silently depend on a function that does not exist.

### R1-F2 [minor]

Row 21b in MORNING-SYSTEM-HEALTH-CHECK.yml uses `secrets.SUPABASE_URL` directly (line 547), while the other RPC-based checks (rows 5-12 at line 173, row 21 at line 501) use `vars.DATA_REST_URL || secrets.SUPABASE_URL` to support the Aurora migration. The plan states row 21b is the production isolation signal ('Already in place... wired report-only into MORNING-SYSTEM-HEALTH-CHECK.yml row 21b'), but if DATA_REST_URL is set to Aurora, row 21b would still point at the old Supabase endpoint while rows 5-12 and 21 point at Aurora. This means the isolation health check may query a different database than the other health checks. This is an existing issue not introduced by this plan, but the plan relies on it as a production signal without noting the discrepancy.

- `exafyltd/vitana-platform:.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml:546` — SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
            SUPABASE_SERVICE_ROLE: ${{ secrets.SUPABASE_SERVICE_ROLE }}
- `exafyltd/vitana-platform:.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml:172` — SUPABASE_URL: ${{ vars.DATA_REST_URL || secrets.SUPABASE_URL }}
            SUPABASE_SERVICE_ROLE: ${{ secrets.SUPABASE_SERVICE_ROLE }}

Suggestion: Note in the plan that 21b's URL binding should be updated to match the `vars.DATA_REST_URL || secrets.SUPABASE_URL` pattern used by the other checks, either in this spec's ci-wiring lane or filed as a follow-up. Otherwise the production signal may silently query a stale endpoint.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
