---
change_class: standard
---
# mt-guardrails — WS0 guardrails and test tooling
<!-- plan:begin -->
## Problem
WS0 is the M0 blocker (`docs/MULTI-TENANT-PLAN.md` §6 "WS0 Guard rails & test env", §7 M0): the
guardrails that must exist before any isolation work. Verified against platform `origin/main`
(latest migration `20261015180000`) and vitana-v1 on 2026-10-15, read-only:
1. **No local test stack / fixtures (D11).** `supabase/` has `migrations/`, `functions/`, `tests/`,
   `seed.sql` but no committed local-stack config snapshot or fixture tenants. The program needs
   tenants T_A/T_B, members a_member/a_admin/b_member/b_admin/ab_dual and a `CANARY_A_<uuid>` marker in
   T_A rows (plan §6 WS0, D11). Fixtures are data-only; schema comes from a production schema dump,
   never data (D11).
2. **No generated inventories or DB lint.** The resolver-ordering gate (N3, §4.2) needs a *generated*
   count of bare `current_tenant_id()` policies, plus inventories of tables, functions, routes, edge
   functions, realtime tables and storage buckets, and lints for nullable `tenant_id`, missing tenant
   policy, DEFINER without revoke/caller check, realtime tables without tenant RLS, and storage
   policies, with an owner-tagged allowlist. No *DB-schema-reading* inventory/lint generator exists
   today — `scripts/ci/` has `check-migration-drift.cjs`, VTID-specific checks, and
   `aurora-migration-inventory.cjs` (VTID-03494) which inventories the same categories but by scanning
   *source*, not DB schema, so it does not meet the WS0 DB-lint need (R1-F3; lane 2 reuses its output
   format).
3. **No tenant-isolation SQL suite.** `supabase/tests/` holds only per-VTID assertion specs; none
   covers cross-tenant isolation. The plan needs per-table/function assertions that b_member reads 0
   T_A rows and a T_A-tenant write by b_member fails. The hash-stamped parent plan **mandates pgTAP**
   for exactly these assertions — `docs/MULTI-TENANT-PLAN.md` §4.2 (`:51`, 18 tables + health tables)
   and §4.9 (`:61`, ab_dual), parent plan-body hash
   `869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326` (`:1`). So the suite **uses
   pgTAP/`pg_prove`**, introduced for the first time here — path (a); the parent already assumed WS0
   would introduce it, so no new framework decision and no parent amendment (R1-F2). The repo has
   **two** SQL-test harnesses: the self-contained `scripts/ci/test-vtid-05147-s-m-lockdown.sh:18`
   (own `initdb`/`pg_ctl` cluster) and the external-psql `scripts/ci/sql-tests/` runners. The closest
   analogue — the VTID-05149 tenant-foundation tests (same `ci_tenant_isolation_health()` RPC and
   fixtures) — lives in the latter (`scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql` +
   `run-tenant-foundation-test.sh:1`). This suite therefore **connects to lane 1's running stack over
   external `psql`** (NOT `initdb`/`pg_ctl`) and runs pgTAP via `pg_prove`, extending that harness
   location (R1-F1).
4. **No gateway tenant-scope lint or contract tests.** No lint over the gateway repositories that bans
   header/query-supplied tenant outside admin routes (S-I shape, §3), no route-inventory test (a route
   with no auth middleware must be on a public allowlist, §6 WS0, S-J), and no route×role×tenant
   contract test asserting no `CANARY_A` leaks in bodies (incl. edge functions with no JWT / anon key /
   b_member).
5. **No Maxina golden suite.** `services/gateway/test` has no `golden` fixture; the plan requires the
   assembled instruction/intents and UI/push/email strings rendered with Maxina config to be
   byte-identical across changes (persona, pre-login, greetings, journey-modes, first-time welcome,
   push copy, What's New drafter, OG previews, signup default tenant, role routing) — spoken output not
   compared (rule 41). This includes the `v1-golden-edge` fixture that mt-packs P4 regenerates when it
   changes the drafter prompt (CROSS-SPEC O3).
6. **No MIGRATION-QUEUE CI check.** `docs/multitenancy/MIGRATION-QUEUE.md` is enforced "by review rule"
   until the WS0 lint slice adds a CI check (its own §Notes and plan §8). Nothing validates the queue
   file today.
Already in place (build on, do not re-plan): `ci_tenant_isolation_health()` (VTID-05149, migration
`20261014000300`, applied) wired report-only into `MORNING-SYSTEM-HEALTH-CHECK.yml` row 21b — WS0's
*production* isolation monitoring is DONE, with one pre-existing discrepancy: row 21b binds
`SUPABASE_URL` directly (`:546`) while the other RPC checks (rows 5–12, 21) use
`vars.DATA_REST_URL || secrets.SUPABASE_URL` for the Aurora cutover, so post-Aurora it could query a
stale endpoint (ci-wiring folds the one-line fix). The `isHealthTable()` predicate (CROSS-SPEC O1) does
**not** exist in either repo yet; until mt-identity ships it, the health-table list is a shared
constant lane 2 creates from `docs/MULTI-TENANT-PLAN.md` §2. Lane 3 switches to `isHealthTable()` when
it ships.
## Fix (per lane)
1. **`local-test-stack`** (kiro, seat hotmail, repo platform) — committed D11 local-stack config
   snapshot + fixture seed: tenants T_A/T_B, members a_member/a_admin/b_member/b_admin/ab_dual, a
   `CANARY_A_<uuid>` marker in representative T_A rows. Schema from a production *schema* dump
   (structure only, never data), checked in with a regenerate script. A `make`/npm entry brings the
   stack up for the isolation-suite, inventory and contract lanes. **Install mechanism (R2-F1), named
   identically here and in lane 6:** Postgres from the **`supabase/postgres` image pinned by exact
   tag** (ships `pgtap`; stock `postgres:16` does not) + **`pg_prove` from a pinned
   `libtap-parser-sourcehandler-pgtap-perl` apt version** on the host. pgTAP's first repo introduction,
   mandated by parent §4.2/§4.9 (R1-F2). No production access of any kind.
2. **`generated-inventories`** (kiro, seat hotmail, repo platform) — generators that read the local
   schema (never production) and emit checked-in inventories of tables, functions, routes, edge
   functions, realtime tables and storage buckets, plus the DB lints (nullable `tenant_id`, missing
   tenant policy, DEFINER without revoke/caller check, realtime table without tenant RLS, storage
   policy) with an owner-tagged allowlist file. The bare-policy counter (N3 gate) lives here and reads
   ZERO today only once policies are rewritten — it reports the current count, not a hard 0, in WS0.
   The implementer reuses the output-format conventions of `scripts/ci/aurora-migration-inventory.cjs`
   (VTID-03494), which inventories the same table/RPC/realtime/storage categories from source — but
   these generators read the local DB schema, which that tool does not (R1-F3). Also produces the
   **shared health-table-list constant** (checked-in config) enumerated from
   `docs/MULTI-TENANT-PLAN.md` §2 — `health_features_daily`, `biomarker_results`, `wearable_samples`,
   `partner_health_test_orders`, `data_sharing_consents` — the single source of truth for the
   isolation-suite lane and the lints until mt-identity's `isHealthTable()` ships (then retired).
   Depends on `local-test-stack`.
3. **`isolation-suite`** (kiro, seat hotmail, repo platform) — **pgTAP** specs in
   `scripts/ci/sql-tests/mt-isolation.test.sql`, next to the runner
   `scripts/ci/sql-tests/run-mt-isolation-test.sh` — both in `scripts/ci/sql-tests/`, as VTID-05149
   places its `.test.sql` beside its runner, so `SQL-MT-ISOLATION.yml`'s `paths:` stays on
   `scripts/ci/sql-tests/**` like every `SQL-*.yml` (R2-F3). The runner invokes `pg_prove` over
   **external `psql`** against lane 1's running stack, **NOT** `initdb`/`pg_ctl` — lane 1 provides the
   Postgres and `pgtap`/`pg_prove`. Asserts b_member sees 0 T_A rows and a
   T_A-tenant write by b_member fails, per the 18 tenant tables and the health tables (via the shared
   health-table-list constant from `generated-inventories`, switching to mt-identity's `isHealthTable()`
   when it ships — never a scattered local copy); plus the ab_dual read/write single-series health
   assertion (§4.9). pgTAP is required by the hash-stamped parent §4.2/§4.9 and is first introduced
   here, so there is no competing-framework decision and no parent amendment (R1-F2). Depends on
   `local-test-stack` (running stack + `pgtap`/`pg_prove`) and `generated-inventories`.
4. **`gateway-scope-lint-contract`** (kiro, seat jtadic, repo platform) — a static lint over
   `services/gateway/src` repositories banning header/query-supplied tenant outside admin routes; a
   route-inventory Jest test (every route with no auth middleware must be on a committed public
   allowlist); and route×role×tenant contract tests asserting no `CANARY_A` in response bodies,
   covering edge functions called with no JWT / anon key / b_member. Reads the generated route and edge
   inventories. Depends on `generated-inventories`.
5. **`maxina-golden-suite`** (kiro, seat jtadic, repo platform) — a Jest golden suite rendering the
   assembled instruction/intents and UI/push/email strings with Maxina config and asserting byte
   equality for persona, pre-login, greetings, journey-modes, first-time welcome, push copy, What's New
   drafter, OG previews, signup default tenant and role routing; spoken output is never compared
   (rule 41). Owns the `v1-golden-edge` fixture that mt-packs P4 regenerates as a declared golden update
   (CROSS-SPEC O3). Independent of the other kiro lanes.
6. **`ci-wiring`** (claude, governance) — wires lanes 2–5 and the MIGRATION-QUEUE validator into CI
   (`.github/workflows/**`, `scripts/ci/**`) as standalone `SQL-*.yml`/check workflows modelled on
   `SQL-TENANT-FOUNDATION.yml`, not PR-GATE steps. **Report-only path (R2-F2, path B):** each new
   workflow reads a committed `scripts/ci/mt/config.json` `report_only` flag (default `true`) and,
   while true, warns-and-exits-0 even on failure; the flip target is a later governance PR setting
   `report_only=false`. PR-GATE's own `config.json` `enforce` gates only the Verdict `OUTCOMES` checks,
   so it cannot gate these standalone workflows — hence their own flag. The isolation workflow uses
   lane 1's **identical install mechanism** (pinned `supabase/postgres` image + pinned `pg_prove` apt
   version, R2-F1), then runs `scripts/ci/sql-tests/run-mt-isolation-test.sh`. Adds the MIGRATION-QUEUE
   check (file shape, apply order, one row per migration file) replacing the review rule, and folds the
   one-line fix aligning `MORNING-SYSTEM-HEALTH-CHECK.yml` row 21b's `SUPABASE_URL` to
   `vars.DATA_REST_URL || secrets.SUPABASE_URL` (rows 5–12/21). Governance → `executor`/`next_actor:
   claude`. Depends on lanes 2–5.
## Migrations
None. `ci_tenant_isolation_health()` already exists (VTID-05149, `20261014000300`, applied). The
bare-policy lint and inventories read the schema read-only; the isolation suite runs on the pinned
`supabase/postgres` image (which ships `pgtap`), not a production migration. Reserved range if a WS0 slice later needs one:
`20261101020000`–`20261101025959` (NN=02); none used in this spec.
MIGRATION-QUEUE position: none (adds no migration).
## Tests
- `local-test-stack`: a smoke script brings the pinned `supabase/postgres` stack up, installs the
  pinned `pg_prove`, and asserts the fixtures load and `pgtap` is present; no live calls.
- `generated-inventories`: unit tests on each generator over a tiny fixture schema; the committed
  inventories regenerate byte-identically (drift test).
- `isolation-suite`: `scripts/ci/sql-tests/run-mt-isolation-test.sh` runs `pg_prove` green against
  lane 1's local stack (external `psql`, same harness location as
  `scripts/ci/sql-tests/run-tenant-foundation-test.sh`).
- `gateway-scope-lint-contract`: Jest — lint flags a header/query-tenant repository, passes a clean
  one; route-inventory test; contract tests over fixtures (no `CANARY_A` leak).
- `maxina-golden-suite`: Jest byte-equality; required suites `npm run test:support` (rule 42c),
  `npm run test:operator` (rule 42e), `npm run test:roles` (rule 42h) stay green — all three are
  verified present in `services/gateway/package.json` ("test:support"/"test:operator"/"test:roles"
  scripts), so the dependency is real, not assumed.
- `ci-wiring`: `node --test` self-tests for the new scripts; a test asserts each new `SQL-*.yml` honours
  the `scripts/ci/mt/config.json` `report_only` flag (warn-and-exit-0 while true).
## Staging verification
Read-only (rule 48). WS0 is tooling/tests/CI: nothing deploys and nothing writes to any live system.
The production isolation signal is the already-live, read-only `ci_tenant_isolation_health()` RPC in
`MORNING-SYSTEM-HEALTH-CHECK.yml` (row 21b); no new production probe, canary or honeytoken (plan §6 WS0
"No production canary, no honeytokens, no sign-in probes"). No STAGING-VERIFY suite is added because no
runtime surface changes.
## Rollout
Dark by default is satisfied structurally: these are CI checks and local-only test tooling, off every
runtime path (no `MT_RESOLUTION_V2` / `tenant_settings.feature_flags.mt.*` gate needed because nothing
runs in production). The new standalone `SQL-*.yml`/check workflows land report-only via their own
`scripts/ci/mt/config.json` `report_only` flag (not PR-GATE's `enforce`, which gates only the Verdict
`OUTCOMES` checks, R2-F2); a later governance PR sets `report_only=false`. No DB apply, no owner-only
step. No Gate 2 (deploys nothing).
## Risks
- A lint/golden suite red on day one is ignored (the VTID-03480/03486 lesson): every new check lands
  report-only with a visible, shrinking baseline, never a hard 0 on existing drift.
- pgTAP is new to the repo; introduced only because parent §4.2/§4.9 requires it. Determinism is
  pinned by one mechanism lane 1 and lane 6 name verbatim: fixed-tag `supabase/postgres` (ships
  `pgtap`) + fixed `pg_prove` apt version — no stock `postgres:16`, no unpinned install (R2-F1).
- Golden byte-equality is brittle to intended copy changes; the suite documents the regenerate step and
  mt-packs P4's O3 fixture update is a declared, reviewed golden change.
- Cross-repo temptation: the What's New drafter golden is kept in the gateway golden lane (same repo as
  the drafter prompt) to avoid a cross-repo lane (CROSS-SPEC lane rule).
## Out of scope
Policy classification and the resolver cutover (WS1, N3 — this spec only *counts* bare policies);
membership unification; the access-token hook (D14, owner-only); WS2 data cleanup; any migration that
changes a policy or `current_tenant_id()`; native/health/commerce isolation suites beyond the table
list referenced here. Each later slice is its own sparred spec.
## Depends on
Done: VTID-05147 (S-M), VTID-05149 (A: `ci_tenant_isolation_health`, `TenantContext`), VTID-05150 (B),
VTID-05151 (C). Within this spec: `generated-inventories` → `local-test-stack`; `isolation-suite` →
`local-test-stack` (running stack + `pgtap`/`pg_prove`) and `generated-inventories`;
`gateway-scope-lint-contract` → `generated-inventories`; `ci-wiring` → lanes 2–5. `isHealthTable()` is
NOT yet available (CROSS-SPEC O1): the health-table list is the shared constant until mt-identity ships
it. Cross-spec O3: mt-packs P4 depends on `maxina-golden-suite`'s `v1-golden-edge`.
## Owner decisions
None new. D11 (local stack), D13 (no synthetic/production tenant — WS0 runs on the local stack only),
rule 41 (golden never compares spoken output), rules 31/31b/48 (no production write/probe) all stand as
decided. pgTAP is not a new owner decision — it is the parent plan's existing §4.2/§4.9 mandate.
<!-- plan:end -->
## Open questions for sparring
- Confirm `v1-golden-edge` fixture ownership stays with `maxina-golden-suite` in platform (same repo as
  the drafter prompt) rather than a vitana-v1 lane — CROSS-SPEC O3 names mt-guardrails as owner but not
  the repo. Default: platform.
