# Sparring round 1 — in_progress

Session: `e7f1e151-ad1e-46c8-9a28-5e9f53d72117` · plan hash `8735d810028aa3ea3dc4f1f01982a27a33bbbbc141842e3d1b450a1421300d0a`

## Summary

Three findings. Two major: (1) The plan claims "there is one SQL-test harness across the repo" and proposes supabase/tests/ + initdb/pg_ctl, but a second harness already exists — scripts/ci/sql-tests/ + external-psql — and the VTID-05149 tenant foundation tests (the most directly relevant predecessor) live there, not in supabase/tests/. This also creates an internal contradiction: the isolation suite is said to both "run against the local stack" and use "initdb/pg_ctl"; the cited analogue test-vtid-05147-s-m-lockdown.sh is fully self-contained and uses neither a shared stack nor any external connection. (2) The WS0 sub-plan says "Deliberately NOT pgTAP" for the exact assertions that the hash-stamped parent program plan (MULTI-TENANT-PLAN.md §4.2 and §4.9) explicitly mandates pgTAP for — without a formal amendment to the parent. One minor: the description "scripts/ci/ has check-migration-drift.cjs and VTID-specific checks only; no inventory/lint generator" ignores the existing aurora-migration-inventory.cjs. All other verified premises hold exactly as stated in the plan.

## Findings

### R1-F1 [major]

The plan incorrectly states 'there is one SQL-test harness across the repo' and proposes placing the isolation suite in supabase/tests/ using initdb/pg_ctl. A second SQL-test harness already exists: scripts/ci/sql-tests/ with its own runner pattern. Critically, the VTID-05149 tenant-foundation tests — the most directly relevant predecessor to this spec's isolation suite, covering the same ci_tenant_isolation_health() RPC and tenant fixture shapes — live in scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql with runner scripts/ci/sql-tests/run-tenant-foundation-test.sh. That runner uses PSQL=(psql -X -q -v ON_ERROR_STOP=1) pointing at a pre-existing server and createdb/dropdb per scenario — no initdb, no pg_ctl. Placing lane 3 in supabase/tests/ with a new initdb/pg_ctl runner creates a third location for tenant-related SQL tests and directly contradicts the 'one harness' rationale the plan uses to reject pgTAP. This also produces an internal contradiction: the plan says the isolation suite 'runs against the local stack' (lane 1 provides a running Postgres) AND uses 'initdb/pg_ctl'. The cited analogue test-vtid-05147-s-m-lockdown.sh creates its own cluster from scratch via initdb, writes everything to a mktemp directory, and has no dependency on any external running stack — it is entirely self-contained. If lane 3 uses initdb/pg_ctl it does not need lane 1's running stack; if it connects to lane 1's running stack it cannot use initdb/pg_ctl. Both cannot be true simultaneously.

- `exafyltd/vitana-platform:scripts/ci/sql-tests/run-tenant-foundation-test.sh:1` — # VTID-05149: tenant foundation ... Needs PG* env vars (or a local socket) pointing at a disposable server ... PSQL=(psql -X -q -v ON_ERROR_STOP=1) ... cleanup() { ... for d in "${DBS[@]}"; do dropdb --if-exists "$d" ... done
- `exafyltd/vitana-platform:scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql:1` — -- VTID-05149: fixture for the tenant-foundation harness. Loaded into a fresh throwaway database per case by run-tenant-foundation-test.sh ... \set ON_ERROR_STOP on
- `exafyltd/vitana-platform:scripts/ci/test-vtid-05147-s-m-lockdown.sh:18` — WORK="$(mktemp -d)" ... "${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust ... "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" ... PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)

Suggestion: Choose one of the two existing patterns explicitly. If the isolation suite spins up its own cluster per run (initdb/pg_ctl), it is self-contained, does not depend on lane 1's running stack, and should live in scripts/ci/ alongside similar runners; remove 'run against the local stack' language. If it connects to lane 1's running Postgres (like run-tenant-foundation-test.sh), it uses external psql with createdb/dropdb, and should live in scripts/ci/sql-tests/ alongside the VTID-05149 tenant tests — the closest analogue in the repo. Either way, correct the 'one SQL-test harness' claim and explain why the isolation suite does not extend scripts/ci/sql-tests/ where the VTID-05149 tenant tests already live.

### R1-F2 [major]

The WS0 sub-plan contradicts the hash-stamped parent program plan on pgTAP without documenting a formal amendment. MULTI-TENANT-PLAN.md §4.2 (the 'Ordering gate N3' paragraph) explicitly mandates 'pgTAP asserts a_member cannot read a_admin's user-private rows on every one of the 18 tables (and the health tables)' as a WS0 deliverable. §4.9 (Health data & tenancy) mandates 'pgTAP + contract test: ab_dual in a T_B session writes and reads the same single series. pgTAP for ab_dual.' These are the exact tests that lane 3 of this sub-plan implements. The sub-plan says 'Deliberately NOT pgTAP: no pgtap/pg_prove exists in the repo.' Both cannot be true: either the parent plan governs and pgTAP is required, or the sub-plan amends the parent and the parent hash must be updated. The parent plan (VTID-05022) carries a body hash of 869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326; a sub-plan changing that plan's requirements without updating the hash violates the governance chain. A later WS1/WS2 slice reading §4.2 would expect pgTAP from WS0 and find raw-psql with no amendment on record.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:51` — A WS0 DB-lint hard gate counts bare policies ... pgTAP asserts a_member cannot read a_admin's user-private rows on every one of the 18 tables (and the health tables).
- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:61` — pgTAP + contract test: ab_dual in a T_B session writes and reads the same single series. Target ... pgTAP for ab_dual.
- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:1` — Plan-body hash (text between the markers): `869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326`

Suggestion: One of two paths: (a) install pgTAP in lane 1 (local-test-stack), use pgTAP for the isolation assertions as the parent plan requires, and note this as the first introduction of pgTAP into the repo — since the parent plan already mandated it, no new framework decision is needed; or (b) formally amend MULTI-TENANT-PLAN.md §4.2 and §4.9 to replace 'pgTAP' with 'raw-psql + RAISE', obtain owner sign-off per the VTID-05022 governance record, and update the plan body hash before this sub-plan receives a VTID. The sub-plan's rationale ('pgTAP exists nowhere in the repo') is consistent with path (a) — WS0 introduces it — and the parent plan already assumed that would happen.

### R1-F3 [minor]

The plan states 'scripts/ci/ has check-migration-drift.cjs and VTID-specific checks only; no inventory/lint generator.' This is inaccurate: aurora-migration-inventory.cjs (VTID-03494) exists in scripts/ci/ and is a static inventory tool that scans TypeScript/JavaScript source files and generates inventories of tables (.from()), RPCs (.rpc()), auth calls, realtime channels (.channel()), and storage buckets (.storage.from()). It reads source code rather than DB schema so it does not satisfy WS0's DB-lint need, but it generates inventories for the exact same categories that lane 2 will generate. The lane-2 implementer should know it exists to avoid reinvention and to reuse its output-format conventions.

- `exafyltd/vitana-platform:scripts/ci/aurora-migration-inventory.cjs:1` — VTID-03494 — inventory the Supabase surface that a full platform replacement has to replace ... turns it into a worklist: which tables, which RPCs, which files
- `exafyltd/vitana-platform:scripts/ci/aurora-migration-inventory.cjs:60` — const PATTERNS = { from: /\.from\(\s*['`"]([a-zA-Z0-9_]+)['`"]/g, rpc: /\.rpc\(/, auth: /\.auth\.([a-zA-Z]+)\s*\(/g, realtime: /\.channel\(/, storage: /\.storage\.from\(/ }

Suggestion: Narrow the description to 'no DB-schema-reading inventory/lint generator' and add a note in the generated-inventories lane pointing lane-2 implementers to aurora-migration-inventory.cjs as a reference for output format and the table/RPC/realtime/storage inventory categories already established.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
