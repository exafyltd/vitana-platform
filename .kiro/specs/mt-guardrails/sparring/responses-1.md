# Sparring responses — round 1
```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct, and verified against code. There are TWO SQL-test harnesses, not one. (a) scripts/ci/test-vtid-05147-s-m-lockdown.sh:18 is fully self-contained: it runs its own cluster from a mktemp dir via initdb/pg_ctl and depends on no external stack. (b) scripts/ci/sql-tests/ is the external-psql harness — PSQL=(psql -X -q -v ON_ERROR_STOP=1) against a pre-existing/disposable server with createdb/dropdb per case; the VTID-05149 tenant-foundation tests, the closest analogue to this isolation suite (same ci_tenant_isolation_health() RPC and tenant fixtures), live there: scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql + scripts/ci/sql-tests/run-tenant-foundation-test.sh:1. The plan's 'one SQL-test harness across the repo' claim and its initdb/pg_ctl-vs-local-stack self-contradiction are both removed. Decision: the isolation suite CONNECTS to lane 1's running local stack over external psql (consistent with scripts/ci/sql-tests/ and with lane 1 providing a running Postgres) and uses pg_prove/pgTAP over that connection — NO initdb/pg_ctl in this lane. Specs live under supabase/tests/mt/** and the runner under scripts/ci/sql-tests/run-mt-isolation-test.sh, alongside run-tenant-foundation-test.sh, extending that harness location rather than inventing a third. The lane is made internally consistent: it depends on lane 1's running stack and uses pg_prove over external psql.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Correct, and it reverses the prior round's raw-psql choice. The hash-stamped parent program plan explicitly MANDATES pgTAP for exactly these isolation assertions: docs/MULTI-TENANT-PLAN.md:51 (§4.2 Ordering gate N3) 'pgTAP asserts a_member cannot read a_admin's user-private rows on every one of the 18 tables (and the health tables)', and docs/MULTI-TENANT-PLAN.md:61 (§4.9 Health data & tenancy) 'pgTAP + contract test: ab_dual ... pgTAP for ab_dual.' The parent carries plan-body hash 869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326 (docs/MULTI-TENANT-PLAN.md:1). A sub-plan cannot say 'deliberately NOT pgTAP' for these exact tests without formally amending that hash-locked parent. We take resolution path (a), NOT (b): pgTAP is REINSTATED. Lane 1 (local-test-stack) installs the pgtap extension + pg_prove; the isolation suite (lane 3) uses pgTAP/pg_prove as the parent requires; ci-wiring installs pg_prove/pgtap in the job. The plan notes explicitly that this spec is the FIRST introduction of pgTAP into the repo — which the parent §4.2/§4.9 already assumed WS0 would do — so it is not a new framework decision and needs no parent amendment; MULTI-TENANT-PLAN.md is left unchanged. The sub-plan's old rationale ('pgtap/pg_prove exists nowhere in the repo') is consistent with path (a): WS0 introduces it.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Correct. scripts/ci/aurora-migration-inventory.cjs (VTID-03494) exists and is a static inventory generator: it scans TypeScript/JavaScript source and emits inventories of tables (.from()), RPCs (.rpc()), auth calls, realtime channels (.channel()) and storage buckets (.storage.from()) — the same categories lane 2 generates. It reads source code, not DB schema, so it does NOT satisfy WS0's DB-lint/DB-reading need, but the lane-2 implementer should know it exists to reuse its output-format conventions and avoid reinvention. The plan's premise is narrowed from 'scripts/ci/ has check-migration-drift.cjs and VTID-specific checks only; no inventory/lint generator' to 'no DB-schema-reading inventory/lint generator', and the generated-inventories lane now points implementers to scripts/ci/aurora-migration-inventory.cjs as a reference for format and the table/RPC/realtime/storage inventory categories it already establishes.",
    "deferred_to": ""
  }
]
```
