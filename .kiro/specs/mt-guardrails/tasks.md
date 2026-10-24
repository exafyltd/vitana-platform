# Tasks — mt-guardrails (WS0 guardrails and test tooling)
Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`. VTID: allocated by PLAN-SPAR after
approval. Each lane adds its own `docs/validation/<vtid>/` (scope.json, plan copy, staging-tests.json)
— not listed in Allowed paths; the lane body states it.
<!-- lane: local-test-stack -->
## local-test-stack — D11 local Supabase stack + fixtures (repo vitana-platform)
Allowed paths:
- `supabase/tests/fixtures/**`
- `supabase/tests/local-stack/**`
- `scripts/mt/stack/**`
- `docs/multitenancy/LOCAL-STACK.md`
- [ ] T1 Commit a local-stack config snapshot (schema from a production `--schema-only` dump, structure
      only, never data) under `supabase/tests/local-stack/` with a regenerate script in `scripts/mt/stack/`.
      The dump is `pg_dump --schema=public --schema-only` (the script refuses any other schema);
      `auth`/`storage`/`realtime` are pre-installed by `supabase/postgres` and never re-created.
- [ ] T2 Fixture seed in `supabase/tests/fixtures/`: tenants T_A/T_B; members a_member, a_admin,
      b_member, b_admin, ab_dual; `CANARY_A_<uuid>` markers in representative T_A rows; idempotent. Users are INSERTed into the
      pre-existing `auth.users` — never `CREATE TABLE auth.users` (do not copy
      `vtid-05149-tenant-foundation.test.sql:13`, which targets `postgres:16`).
- [ ] T3 `scripts/mt/stack/up.*` brings the disposable local Postgres up and seeds it with no live call.
- [ ] T4 Bring the stack up from `supabase/postgres:17.4.1.074` (index digest
      `sha256:dc436b5b4ebeb0f3bdf6d8dda2b390cc094e14d24cd434d5fe02840459e67670`; ships `pgtap`, stock
      `postgres:16` does not) and run `pg_prove` from `libtap-parser-sourcehandler-pgtap-perl=3.36-2`
      inside an `ubuntu:24.04` container — the plan's "Pinned versions" table, copied verbatim; ci-wiring
      uses the same literals. First introduction of pgTAP into the repo, mandated by parent plan
      §4.2/§4.9. Record the four values in `docs/multitenancy/LOCAL-STACK.md`.
- [ ] T5 Smoke test asserts `auth.users` pre-exists (`to_regclass`), the fixtures load and
      `pgtap`/`pg_prove` are available; document in
      `docs/multitenancy/LOCAL-STACK.md`.
Acceptance: the up+seed script runs green locally and in a CI service container; `pgtap`/`pg_prove`
installed and version-pinned; no call to any live system; fixtures idempotent. PR title
`VTID-xxxxx (mt-guardrails/local-test-stack): —`; commits carry `Collab-Session` /
`Collab-Lane: mt-guardrails/local-test-stack`.
<!-- lane: generated-inventories -->
## generated-inventories — generated inventories + DB lint (repo vitana-platform)
Allowed paths:
- `scripts/mt/inventory/**`
- `scripts/mt/lint/**`
- [ ] G1 Generators in `scripts/mt/inventory/` read the local schema + route/edge trees and emit
      checked-in JSON inventories (tables, functions, routes, edge functions, realtime tables, buckets).
      Reuse the output-format conventions of `scripts/ci/aurora-migration-inventory.cjs` (VTID-03494),
      which inventories the same categories from source — but these generators read the local DB schema,
      which that tool does not (R1-F3).
- [ ] G2 `scripts/mt/lint/` applies the five DB lints (nullable `tenant_id`, missing tenant policy,
      DEFINER without revoke/caller check, realtime table without tenant RLS, storage policy) against an
      owner-tagged allowlist `scripts/mt/lint/allowlist.json`.
- [ ] G3 Bare-policy counter (no `auth.uid()`/`current_user_id()`/`is_member`/`is_tenant_admin`, outside
      the allowlist) reports the current count — not asserted 0 (N3 is a WS1 gate).
- [ ] G4 Shared health-table-list constant (checked-in config) enumerated from `docs/MULTI-TENANT-PLAN.md`
      §2 (`health_features_daily`, `biomarker_results`, `wearable_samples`, `partner_health_test_orders`,
      `data_sharing_consents`) — the single source of truth the isolation-suite lane and the lints consume
      until mt-identity's `isHealthTable()` ships, then they switch to it (CROSS-SPEC O1).
- [ ] G5 Unit tests per generator over a tiny fixture schema; committed inventories regenerate
      byte-identically (drift guard).
Acceptance: generators + lints run against the local stack from `local-test-stack`; unit tests green;
inventories deterministic. Depends on `local-test-stack`. PR title
`VTID-xxxxx (mt-guardrails/generated-inventories): —`; trailers `Collab-Lane:
mt-guardrails/generated-inventories`.
<!-- lane: isolation-suite -->
## isolation-suite — tenant-isolation SQL suite, pgTAP (repo vitana-platform)
Allowed paths:
- `scripts/ci/sql-tests/mt-isolation.test.sql`
- `scripts/ci/sql-tests/run-mt-isolation-test.sh`
- [ ] P1 `scripts/ci/sql-tests/mt-isolation.test.sql` **pgTAP** specs — placed beside the runner in
      `scripts/ci/sql-tests/`, exactly as VTID-05149 places `vtid-05149-tenant-foundation.test.sql`
      next to its runner, so `SQL-MT-ISOLATION.yml`'s `paths:` uses the `scripts/ci/sql-tests/**` glob
      like `SQL-HEALTH-STORE.yml`/`SQL-MEMORY-SENSITIVITY.yml` — not `SQL-TENANT-FOUNDATION.yml`'s file list. The hash-stamped parent plan §4.2 at `:51` and §4.9 at `:61`
      mandate pgTAP; parent hash `869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326`.
      For each of the 18 tenant tables (plan §2) and the health tables (via the shared health-table-list
      constant from `generated-inventories`), assert b_member sees 0 T_A/`CANARY_A` rows. First
      introduction of pgTAP into the repo, path (a) — no parent amendment (R1-F2).
- [ ] P2 pgTAP: assert a b_member write with a T_A `tenant_id` is rejected by RLS; ab_dual reads and
      writes one health series (§4.9).
- [ ] P3 `scripts/ci/sql-tests/run-mt-isolation-test.sh` runs `mt-isolation.test.sql` via `pg_prove`
      over **external `psql`** against lane 1's running local stack (both files co-located in
      `scripts/ci/sql-tests/`, like `run-tenant-foundation-test.sh` + its `.test.sql`, R2-F3), NOT
      `initdb`/`pg_ctl` (R1-F1). The pinned `supabase/postgres` image (ships `pgtap`) and `pg_prove`
      are provided by the `local-test-stack` lane. The runner starts with the PGHOST guard copied from
      `run-tenant-foundation-test.sh:18-20` (`*supabase*|*amazonaws*|*rds*` → exit 2); a self-test case
      with `PGHOST=x.supabase.co` exits 2 before connecting. Runs under `set -euo pipefail` and prints
      `PASS mt-isolation` as its last line only after `pg_prove` exits 0 (ci-wiring's `--expect` marker).
Acceptance: `scripts/ci/sql-tests/run-mt-isolation-test.sh` green (`pg_prove`) against the local stack;
no production access. Depends on `local-test-stack` (running stack + `pgtap`/`pg_prove`) and
`generated-inventories`. PR title `VTID-xxxxx (mt-guardrails/isolation-suite): —`; trailers
`Collab-Lane: mt-guardrails/isolation-suite`.
<!-- lane: gateway-scope-lint-contract -->
## gateway-scope-lint-contract — gateway tenant-scope lint + contract/route tests (repo vitana-platform)
Allowed paths:
- `scripts/mt/gateway-scope-lint.mjs`
- `scripts/mt/gateway-scope-lint.test.mjs`
- `services/gateway/test/mt-route-inventory.test.ts`
- `services/gateway/test/mt-contract-canary.test.ts`
- `services/gateway/test/mt/**`
- [ ] L1 `scripts/mt/gateway-scope-lint.mjs` flags header/query-supplied tenant in
      `services/gateway/src/**` repositories outside an admin allowlist (S-I shapes); clean repo passes.
- [ ] L2 `mt-route-inventory.test.ts`: every route with no auth middleware must be in a committed
      `public-routes-allowlist.json` (under `services/gateway/test/mt/`).
- [ ] L3 `mt-contract-canary.test.ts`: route×role×tenant over fixtures asserts no `CANARY_A` in bodies,
      incl. edge functions with no JWT / anon key / b_member.
Acceptance: Jest green; lint flags a bad repo and passes a clean one; `test:support`/`test:operator`/
`test:roles` stay green (all three verified present in `services/gateway/package.json`). Depends
on `generated-inventories`. PR title `VTID-xxxxx (mt-guardrails/gateway-scope-lint-contract): —`;
trailers `Collab-Lane: mt-guardrails/gateway-scope-lint-contract`.
<!-- lane: maxina-golden-suite -->
## maxina-golden-suite — Maxina golden suite + v1-golden-edge fixture (repo vitana-platform)
Allowed paths:
- `services/gateway/test/mt-maxina-golden.test.ts`
- `services/gateway/test/golden/**`
- `scripts/mt/golden/**`
- [ ] M1 `mt-maxina-golden.test.ts` asserts byte-identical assembled instruction/intents + UI/push/email
      strings with Maxina config for persona, pre-login, greetings, journey-modes, first-time welcome,
      push copy, What's New drafter, OG previews, signup default tenant, role routing.
- [ ] M2 Never capture or compare spoken output (rule 41).
- [ ] M3 Own `golden/v1-golden-edge.*`; document a regenerate script in `scripts/mt/golden/` for
      declared, reviewed golden updates (mt-packs P4 / CROSS-SPEC O3).
Acceptance: Jest green and byte-stable; `test:support`/`test:operator`/`test:roles` stay green (all
three verified present in `services/gateway/package.json`). PR title
`VTID-xxxxx (mt-guardrails/maxina-golden-suite): —`; trailers `Collab-Lane:
mt-guardrails/maxina-golden-suite`.
<!-- lane: ci-wiring -->
## ci-wiring — CI wiring + MIGRATION-QUEUE check (governance, repo vitana-platform)
Allowed paths:
- `.github/workflows/MT-GUARDRAILS.yml`
- `.github/workflows/SQL-MT-ISOLATION.yml`
- `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml`
- `scripts/ci/mt/**`
- [ ] C1 `MT-GUARDRAILS.yml` runs the inventory/lint generators, the gateway scope lint, the contract
      tests and the golden suite; the pgTAP isolation suite gets its OWN standalone
      `SQL-MT-ISOLATION.yml` (modelled on `SQL-TENANT-FOUNDATION.yml`, but `paths:` on the
      `scripts/ci/sql-tests/**` glob like `SQL-HEALTH-STORE.yml`). Both land report-only through the plan's
      one mechanism: each check step has an `id:` + `continue-on-error: true`, followed by an
      `if: always()` step `node scripts/ci/mt/report-gate.mjs --outcome "${{ steps.<id>.outcome }}"
      [--log <file> --expect '<regex>']`, which reads `scripts/ci/mt/config.json` `{ "report_only": true }`:
      pass → 0; fail + `true` → `::warning` + 0; fail + `false` → `::error` + 1; missing/invalid config → 1.
      Not PR-GATE's `enforce` (gates only Verdict `OUTCOMES`). Flip: a later governance PR sets `false`.
      `report-gate.test.mjs` covers all five cases; a workflow-shape test asserts every check step is
      `continue-on-error` + followed by `report-gate.mjs`.
- [ ] C2 `scripts/ci/mt/migration-queue-check.mjs` + `.test.mjs` validates
      `docs/multitenancy/MIGRATION-QUEUE.md` (one row per migration file, apply order, each names a
      rollback), replacing the review rule.
- [ ] C3 `SQL-MT-ISOLATION.yml` uses lane 1's identical pins (plan "Pinned versions"): `runs-on:
      ubuntu-24.04`, service `image: supabase/postgres:17.4.1.074`, `sudo apt-get install -y
      libtap-parser-sourcehandler-pgtap-perl=3.36-2` — then runs
      `scripts/ci/sql-tests/run-mt-isolation-test.sh` and gates it with `report-gate.mjs --expect
      '^PASS mt-isolation'`; the shape test asserts these literals; `paths:` uses the glob form of
      `SQL-HEALTH-STORE.yml`; PGHOST is only the service container, never a live endpoint; wire a shrinking baseline
      (the drift-check pattern). Fold the row-21b fix: align `MORNING-SYSTEM-HEALTH-CHECK.yml` row 21b's
      `SUPABASE_URL` binding to `vars.DATA_REST_URL || secrets.SUPABASE_URL` (matching rows 5—12/21).
Acceptance: `node --test scripts/ci/mt/*.test.mjs` green; the workflow runs report-only on its own PR;
the queue check flags a malformed row and passes the current file. Governance lane (`executor: claude`,
`next_actor: claude`). Depends on `local-test-stack`, `generated-inventories`, `isolation-suite`,
`gateway-scope-lint-contract`, `maxina-golden-suite`. PR title `VTID-xxxxx (mt-guardrails/ci-wiring): —`;
trailers `Collab-Lane: mt-guardrails/ci-wiring`.

## Escalation carry-over (owner approved escalated, 2026-10-20)

The plan was round-capped and escalated (session `496d49e4`, round 3); the owner approved it as escalated on
2026-10-20 ("yes, A all 4 approved"). The open last-round findings are folded into the lane tasks here; `plan.md`
is unchanged.

- R3-F1 [major] — "Lane 6 (ci-wiring) runs the isolation suite in CI by spinning up `supabase/postgres:17.4.1.074`
  as a GitHub Actions `service:` container and installing `pg_prove` on the runner."
  Lane `ci-wiring`, added task (runs before C1/C3 assert the service shape):
  - [ ] C0 Spike: prove `supabase/postgres:17.4.1.074` (pinned digest) boots as a GitHub Actions `service:`
        container on `ubuntu-24.04`, and record the exact healthcheck, env and init contract it needs (not assumed
        to be the `postgres:16` `pg_isready` shape of `SQL-TENANT-FOUNDATION.yml`), including whether its own
        migrations must finish before `pg_prove` connects. If it cannot run as a service, record the adapter used
        (e.g. a `docker run` step with an explicit wait).
        Acceptance (carry-over R3-F1): the spike's run link and the recorded contract are in the PR body and in
        `docs/validation/<vtid>/`; C3 and the workflow-shape test use that recorded contract; the smoke test is
        never silently skipped when the digest check cannot run (it fails instead).
- R3-F2 [minor] — "Lane 1's spec states both 'Schema from a production *schema* dump (structure only, never data)'
  and 'No production access of any kind'."
  Lane `local-test-stack`, added task:
  - [ ] T1a Document in `docs/multitenancy/LOCAL-STACK.md` and the regenerate script's header that the
        `pg_dump --schema=public --schema-only` is a single, explicit, manual, read-only step run once by a seated
        engineer on a workstation (never by CI, never by the local stack at runtime), and is the only sanctioned
        production connection in this spec; "no production access" applies to the local stack and every CI
        workflow.
        Acceptance (carry-over R3-F2): both texts state this; no CI workflow and no `scripts/mt/stack/up.*` path
        invokes `pg_dump` or any live endpoint.
- R3-F3 [minor] — "The 'Pinned versions' table pin `supabase/postgres:17.4.1.074`, justified as 'the version
  production reports', is the exact version the plan's own cited source flags as vulnerable."
  Lane `local-test-stack`, added task:
  - [ ] T4a Next to the four pinned values in `docs/multitenancy/LOCAL-STACK.md`, record that `17.4.1.074` is the
        version `docs/SUPABASE-SECURITY-ADVISOR-AUDIT-2026-08-28.md:58` flags as `vulnerable_postgres_version`
        (patches outstanding); it is pinned only for production-parity determinism of the throwaway local stack,
        which holds no real data and reaches no live endpoint; the digest guard does not cover upstream
        vulnerabilities; a bump of the pin table is the upgrade path.
        Acceptance (carry-over R3-F3): the note is present beside the pins in `LOCAL-STACK.md`.
