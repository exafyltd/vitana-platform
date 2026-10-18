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
- [ ] T2 Fixture seed in `supabase/tests/fixtures/`: tenants T_A/T_B; members a_member, a_admin,
      b_member, b_admin, ab_dual; `CANARY_A_<uuid>` markers in representative T_A rows; idempotent.
- [ ] T3 `scripts/mt/stack/up.*` brings the disposable local Postgres up and seeds it with no live call.
- [ ] T4 Smoke test asserts the fixtures load; document in `docs/multitenancy/LOCAL-STACK.md`.
Acceptance: the up+seed script runs green locally and in a CI service container; no call to any live
system; fixtures idempotent. PR title `VTID-xxxxx (mt-guardrails/local-test-stack): —`; commits carry
`Collab-Session` / `Collab-Lane: mt-guardrails/local-test-stack`.
<!-- lane: generated-inventories -->
## generated-inventories — generated inventories + DB lint (repo vitana-platform)
Allowed paths:
- `scripts/mt/inventory/**`
- `scripts/mt/lint/**`
- [ ] G1 Generators in `scripts/mt/inventory/` read the local schema + route/edge trees and emit
      checked-in JSON inventories (tables, functions, routes, edge functions, realtime tables, buckets).
- [ ] G2 `scripts/mt/lint/` applies the five DB lints (nullable `tenant_id`, missing tenant policy,
      DEFINER without revoke/caller check, realtime table without tenant RLS, storage policy) against an
      owner-tagged allowlist `scripts/mt/lint/allowlist.json`.
- [ ] G3 Bare-policy counter (no `auth.uid()`/`current_user_id()`/`is_member`/`is_tenant_admin`, outside
      the allowlist) reports the current count — not asserted 0 (N3 is a WS1 gate).
- [ ] G4 Shared health-table-list constant (checked-in config) enumerated from `docs/MULTI-TENANT-PLAN.md`
      §2 (`health_features_daily`, `biomarker_results`, `wearable_samples`, `partner_health_test_orders`,
      `data_sharing_consents`) — the single source of truth the isolation-suite lane and the lints consume
      until mt-identity's `isHealthTable()` ships, then they switch to it (R1-F1).
- [ ] G5 Unit tests per generator over a tiny fixture schema; committed inventories regenerate
      byte-identically (drift guard).
Acceptance: generators + lints run against the local stack from `local-test-stack`; unit tests green;
inventories deterministic. Depends on `local-test-stack`. PR title
`VTID-xxxxx (mt-guardrails/generated-inventories): —`; trailers `Collab-Lane:
mt-guardrails/generated-inventories`.
<!-- lane: isolation-suite -->
## isolation-suite — tenant-isolation SQL suite, raw-psql (repo vitana-platform)
Allowed paths:
- `supabase/tests/mt/**`
- `scripts/ci/test-mt-isolation.sh`
- [ ] P1 `supabase/tests/mt/*.test.sql` raw-psql + RAISE specs (`\set ON_ERROR_STOP 1`, matching
      `supabase/tests/vtid_05147_s_m_lockdown.test.sql`): for each of the 18 tenant tables (plan §2) and
      the health tables (via the shared health-table-list constant from `generated-inventories`), b_member
      sees 0 T_A/`CANARY_A` rows. NOT pgTAP/`pg_prove` (none exists in the repo).
- [ ] P2 Assert a b_member write with a T_A `tenant_id` is rejected by RLS; ab_dual reads and writes one
      health series.
- [ ] P3 `scripts/ci/test-mt-isolation.sh` runs the specs against a throwaway local Postgres via
      `initdb`/`pg_ctl` (same harness shape as `scripts/ci/test-vtid-05147-s-m-lockdown.sh`), seeded by
      the `local-test-stack`. No `pg_prove`.
Acceptance: `scripts/ci/test-mt-isolation.sh` green against the local stack; no production access.
Depends on `local-test-stack` and `generated-inventories`. PR title `VTID-xxxxx
(mt-guardrails/isolation-suite): —`; trailers `Collab-Lane: mt-guardrails/isolation-suite`.
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
`test:roles` stay green (all three verified present in `services/gateway/package.json`, R1-F2). Depends
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
three verified present in `services/gateway/package.json`, R1-F2). PR title
`VTID-xxxxx (mt-guardrails/maxina-golden-suite): —`; trailers `Collab-Lane:
mt-guardrails/maxina-golden-suite`.
<!-- lane: ci-wiring -->
## ci-wiring — CI wiring + MIGRATION-QUEUE check (governance, repo vitana-platform)
Allowed paths:
- `.github/workflows/MT-GUARDRAILS.yml`
- `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml`
- `scripts/ci/mt/**`
- [ ] C1 `MT-GUARDRAILS.yml` runs the inventory/lint generators, the raw-psql isolation suite
      (`scripts/ci/test-mt-isolation.sh`), the gateway scope lint, the contract tests and the golden
      suite; report-only via `scripts/ci/mt/config.json` `enforce`, then enforcing.
- [ ] C2 `scripts/ci/mt/migration-queue-check.mjs` + `.test.mjs` validates
      `docs/multitenancy/MIGRATION-QUEUE.md` (one row per migration file, apply order, each names a
      rollback), replacing the review rule.
- [ ] C3 Wire a shrinking baseline (the drift-check pattern); the isolation suite needs no `pg_prove`/
      `pgtap` install — it runs the raw-psql harness via `initdb`/`pg_ctl`. Fold the R1-F2 fix: align
      `MORNING-SYSTEM-HEALTH-CHECK.yml` row 21b's `SUPABASE_URL` binding to
      `vars.DATA_REST_URL || secrets.SUPABASE_URL` (matching rows 5—12/21).
Acceptance: `node --test scripts/ci/mt/*.test.mjs` green; the workflow runs report-only on its own PR;
the queue check flags a malformed row and passes the current file. Governance lane (`executor: claude`,
`next_actor: claude`). Depends on `local-test-stack`, `generated-inventories`, `isolation-suite`,
`gateway-scope-lint-contract`, `maxina-golden-suite`. PR title `VTID-xxxxx (mt-guardrails/ci-wiring): —`;
trailers `Collab-Lane: mt-guardrails/ci-wiring`.
