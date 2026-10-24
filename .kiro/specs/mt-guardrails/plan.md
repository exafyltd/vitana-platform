---
change_class: standard
---
# mt-guardrails — WS0 guardrails and test tooling
<!-- plan:begin -->
## Problem
WS0 is the M0 blocker (`docs/MULTI-TENANT-PLAN.md` §6 "WS0 Guard rails & test env", §7 M0): the
guardrails that must exist before any isolation work. Verified against platform `origin/main`
(latest migration `20261015180000`) and vitana-v1 on 2026-10-15, read-only:
1. **No local test stack / fixtures (D11).** `supabase/` has no committed local-stack snapshot or
   fixture tenants; the program needs T_A/T_B, a_member/a_admin/b_member/b_admin/ab_dual and a
   `CANARY_A_<uuid>` marker in T_A rows (§6 WS0). Schema from a production schema dump, never data.
2. **No generated inventories or DB lint.** N3 (§4.2) needs a *generated* bare-`current_tenant_id()`
   policy count, inventories (tables, functions, routes, edge functions, realtime, buckets) and lints
   (nullable `tenant_id`, missing tenant policy, DEFINER without revoke/caller check, realtime without
   tenant RLS, storage) with an owner-tagged allowlist. `aurora-migration-inventory.cjs` (VTID-03494)
   scans *source*, not DB schema, so lane 2 only reuses its output format.
3. **No tenant-isolation SQL suite.** Nothing asserts b_member reads 0 T_A rows or that a T_A write by
   b_member fails. The hash-stamped parent **mandates pgTAP** for exactly this —
   `docs/MULTI-TENANT-PLAN.md` §4.2 (`:51`) and §4.9 (`:61`), parent hash
   `869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326` (`:1`) — so pgTAP/`pg_prove` is
   first introduced here, no parent amendment. Of the repo's two SQL harnesses (`initdb`/`pg_ctl` in
   `scripts/ci/test-vtid-05147-s-m-lockdown.sh:18`; external `psql` in `scripts/ci/sql-tests/`), the
   VTID-05149 analogue uses the latter, so this suite connects to lane 1's stack over external `psql`.
4. **No gateway tenant-scope lint or contract tests** (header/query tenant outside admin routes, S-I;
   unauthenticated routes not on a public allowlist, S-J; no `CANARY_A` leak per route×role×tenant,
   incl. edge functions with no JWT / anon key / b_member).
5. **No Maxina golden suite** (byte-identical instruction/intents + UI/push/email strings with Maxina
   config; spoken output never compared, rule 41), incl. the `v1-golden-edge` fixture mt-packs P4
   regenerates (CROSS-SPEC O3).
6. **No MIGRATION-QUEUE CI check** — `docs/multitenancy/MIGRATION-QUEUE.md` is "by review rule" until
   WS0 adds one (its §Notes, plan §8).
Already in place (build on, do not re-plan): `ci_tenant_isolation_health()` (VTID-05149, migration
`20261014000300`, applied) wired report-only into `MORNING-SYSTEM-HEALTH-CHECK.yml` row 21b — WS0's
*production* isolation monitoring is DONE, except row 21b binds `SUPABASE_URL` directly (`:546`)
where rows 5–12/21 use `vars.DATA_REST_URL || secrets.SUPABASE_URL` (ci-wiring folds the one-line
fix). `isHealthTable()` (CROSS-SPEC O1) does not exist yet; until mt-identity ships it, lane 2's shared
constant from `docs/MULTI-TENANT-PLAN.md` §2 is the health-table list.
## Fix (per lane)
1. **`local-test-stack`** (kiro, seat hotmail, repo platform) — committed D11 local-stack config
   snapshot + fixture seed: tenants T_A/T_B, members a_member/a_admin/b_member/b_admin/ab_dual, a
   `CANARY_A_<uuid>` marker in representative T_A rows. Schema from a production *schema* dump
   (structure only, never data), checked in with a regenerate script. A `make`/npm entry brings the
   stack up for the isolation-suite, inventory and contract lanes. **Install:** the "Pinned versions"
   literals below, identical to lane 6 (`supabase/postgres` ships `pgtap`; stock `postgres:16` does
   not). No production access of any kind. **Schema scope:** the dump is
   `pg_dump --schema=public --schema-only`, enforced by the regenerate script (refuses any other
   `--schema`); `auth`/`storage`/`realtime` come pre-installed with the image and are never re-created.
   Fixtures INSERT into the existing `auth.users`, never `CREATE` it (unlike
   `vtid-05149-tenant-foundation.test.sql:13`, written for `postgres:16` — do not copy). The smoke test
   asserts `to_regclass('auth.users')` is non-null before the dump/fixtures load.
2. **`generated-inventories`** (kiro, seat hotmail, repo platform) — generators that read the local
   schema (never production) and emit the checked-in inventories and the five DB lints of Problem 2,
   with an owner-tagged allowlist file. The bare-policy counter (N3) reports the current count, not a
   hard 0, in WS0. Output format follows `scripts/ci/aurora-migration-inventory.cjs`. Also produces the
   **shared health-table-list constant** (checked-in config) enumerated from
   `docs/MULTI-TENANT-PLAN.md` §2 — `health_features_daily`, `biomarker_results`, `wearable_samples`,
   `partner_health_test_orders`, `data_sharing_consents` — the single source of truth for the
   isolation-suite lane and the lints until mt-identity's `isHealthTable()` ships (then retired).
   Depends on `local-test-stack`.
3. **`isolation-suite`** (kiro, seat hotmail, repo platform) — **pgTAP** specs in
   `scripts/ci/sql-tests/mt-isolation.test.sql`, next to the runner
   `scripts/ci/sql-tests/run-mt-isolation-test.sh` — both in `scripts/ci/sql-tests/`, as VTID-05149
   places its `.test.sql` beside its runner, so `SQL-MT-ISOLATION.yml`'s `paths:` uses the
   `scripts/ci/sql-tests/**` glob like `SQL-HEALTH-STORE.yml:13` and `SQL-MEMORY-SENSITIVITY.yml:10`
   — NOT the per-file list of `SQL-TENANT-FOUNDATION.yml:13` (496d R1-F2). The runner invokes `pg_prove` over
   **external `psql`** against lane 1's running stack, **NOT** `initdb`/`pg_ctl` — lane 1 provides the
   Postgres and `pgtap`/`pg_prove`. **Production guard (496d R1-F3):** the runner starts with the PGHOST
   guard copied from `run-tenant-foundation-test.sh:18-20` (`*supabase*|*amazonaws*|*rds*` → exit 2),
   runs under `set -euo pipefail`, and prints `PASS mt-isolation` as its last line only after
   `pg_prove` exits 0 (the marker lane 6's `--expect` checks). Asserts b_member sees 0 T_A rows and a
   T_A-tenant write by b_member fails, per the 18 tenant tables and the health tables (via the shared
   health-table-list constant from `generated-inventories`, switching to mt-identity's `isHealthTable()`
   when it ships — never a scattered local copy); plus the ab_dual read/write single-series health
   assertion (§4.9). pgTAP: parent §4.2/§4.9 mandate (R1-F2). Depends on
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
   `SQL-TENANT-FOUNDATION.yml` (except `paths:`, below), not PR-GATE steps (PR-GATE's `enforce` gates
   only Verdict `OUTCOMES`). **Report-only mechanism (496d R2-F2) — one contract, one helper.** The
   existing `SQL-*.yml` pattern is "run step (`set -o pipefail … | tee log`), then `grep -q '^PASS …'`"
   (`SQL-HEALTH-STORE.yml:43`); there is no config reading anywhere today. The new workflows keep that
   shape and replace only the final assert step:
   (a) every check step has an `id:` and `continue-on-error: true` (it still `tee`s its log);
   (b) the next step is `node scripts/ci/mt/report-gate.mjs --outcome "${{ steps.<id>.outcome }}"
   [--log <file> --expect '<regex>']` (always runs, `if: always()`). The helper reads committed
   `scripts/ci/mt/config.json` `{ "report_only": true }`: the check **passed** iff outcome is
   `success` and (when given) the log matches `--expect`; passed → exit 0; failed and
   `report_only === true` → print `::warning title=mt-guardrails::<check> failed (report-only)` and
   exit 0; failed and `report_only === false` → `::error::` and exit 1; config missing / unparsable /
   `report_only` not a boolean → exit 1 (fail loud, never silently report-only). The isolation runner
   ends by printing `PASS mt-isolation` (lane 3), so `SQL-MT-ISOLATION.yml` passes
   `--expect '^PASS mt-isolation'`, exactly like the existing grep. Flip target: a later governance PR
   setting `report_only` to `false` — no workflow edit needed. The isolation workflow uses
   lane 1's **identical install mechanism** ("Pinned versions" below: service `image:` = the pinned
   tag, `runs-on: ubuntu-24.04`, `sudo apt-get install -y` the pinned apt string), then runs
   `scripts/ci/sql-tests/run-mt-isolation-test.sh`; its `paths:` copies the
   glob form of `SQL-HEALTH-STORE.yml` (not `SQL-TENANT-FOUNDATION.yml`'s file list) and its PGHOST
   is only the service container, never a live endpoint (496d R1-F2/F3). Adds the MIGRATION-QUEUE
   check (file shape, apply order, one row per migration file) replacing the review rule, and folds the
   one-line fix aligning `MORNING-SYSTEM-HEALTH-CHECK.yml` row 21b's `SUPABASE_URL` to
   `vars.DATA_REST_URL || secrets.SUPABASE_URL` (rows 5–12/21). Governance → `executor`/`next_actor:
   claude`. Depends on lanes 2–5.
## Pinned versions (496d R2-F1 — lanes 1 and 6 copy these strings verbatim)
| What | Exact value | Why this value |
|---|---|---|
| Postgres image | `supabase/postgres:17.4.1.074` | the version production reports (`supabase-postgres-17.4.1.074`, `docs/SUPABASE-SECURITY-ADVISOR-AUDIT-2026-08-28.md:60`); ships `pgtap`, `auth`, `storage`, `realtime` |
| Image index digest (recorded, checked by the smoke test) | `sha256:dc436b5b4ebeb0f3bdf6d8dda2b390cc094e14d24cd434d5fe02840459e67670` | Docker Hub digest of that tag; the tag is the pin, the digest guards a re-push |
| `pg_prove` apt package | `libtap-parser-sourcehandler-pgtap-perl=3.36-2` | the Ubuntu 24.04 (noble, universe) published version |
| Runner / host OS | CI `runs-on: ubuntu-24.04` (not `ubuntu-latest`); locally `scripts/mt/stack/` runs `pg_prove` inside an `ubuntu:24.04` container with the same apt pin | the apt version above exists only on noble, so the OS is pinned too |
Lane 1 records these four values once in `docs/multitenancy/LOCAL-STACK.md`; lane 6 uses the same
literals. A bump changes this table first (a plan change), then both lanes in one PR each.
## Migrations
None. `ci_tenant_isolation_health()` already exists (VTID-05149, `20261014000300`, applied). The
bare-policy lint and inventories read the schema read-only; the isolation suite needs no migration. Reserved range if a WS0 slice later needs one:
`20261101020000`–`20261101025959` (NN=02); none used in this spec.
MIGRATION-QUEUE position: none (adds no migration).
## Tests
- `local-test-stack`: a smoke script brings the pinned `supabase/postgres` stack up, installs the
  pinned `pg_prove`, and asserts the fixtures load, `pgtap` is present and `auth.users` pre-exists
  (fixtures INSERT, never CREATE, 496d R1-F1); no live calls.
- `generated-inventories`: unit tests on each generator over a tiny fixture schema; the committed
  inventories regenerate byte-identically (drift test).
- `isolation-suite`: `run-mt-isolation-test.sh` runs `pg_prove` green against lane 1's stack
  (external `psql`); with `PGHOST=x.supabase.co` it exits 2 before connecting (496d R1-F3).
- `gateway-scope-lint-contract`: Jest — lint flags a header/query-tenant repository, passes a clean
  one; route-inventory test; contract tests over fixtures (no `CANARY_A` leak).
- `maxina-golden-suite`: Jest byte-equality; required suites `npm run test:support` (rule 42c),
  `npm run test:operator` (rule 42e), `npm run test:roles` (rule 42h) stay green (all three exist in
  `services/gateway/package.json`).
- `ci-wiring`: `node --test scripts/ci/mt/*.test.mjs` — `report-gate.test.mjs` runs the helper against
  temp config files and asserts the contract above: success+match → 0; failure with
  `report_only:true` → 0 plus a `::warning` line; failure with `false` → 1; missing/invalid config → 1;
  `--expect` mismatch counts as failure. A workflow-shape test parses `MT-GUARDRAILS.yml` and
  `SQL-MT-ISOLATION.yml` and asserts every check step has `continue-on-error: true` and is followed by
  a `report-gate.mjs` step, and that the service image / apt string equal the "Pinned versions" literals.
## Staging verification
Read-only (rule 48). WS0 is tooling/tests/CI: nothing deploys and nothing writes to any live system.
The production isolation signal is the already-live, read-only `ci_tenant_isolation_health()` RPC in
`MORNING-SYSTEM-HEALTH-CHECK.yml` (row 21b); no new production probe, canary or honeytoken (plan §6 WS0
"No production canary, no honeytokens, no sign-in probes"). No STAGING-VERIFY suite is added because no
runtime surface changes.
## Rollout
Dark by default is satisfied structurally: these are CI checks and local-only test tooling, off every
runtime path (no `MT_RESOLUTION_V2` / `tenant_settings.feature_flags.mt.*` gate needed because nothing
runs in production). The new standalone `SQL-*.yml`/check workflows land report-only via
`scripts/ci/mt/config.json` `report_only: true`, read by `scripts/ci/mt/report-gate.mjs` (lane 6; not
PR-GATE's `enforce`, which gates only the Verdict `OUTCOMES` checks); a later governance PR sets it to
`false`, with no workflow edit. No DB apply, no owner-only
step. No Gate 2 (deploys nothing).
## Risks
- A lint/golden suite red on day one is ignored (the VTID-03480/03486 lesson): every new check lands
  report-only with a visible, shrinking baseline, never a hard 0 on existing drift.
- pgTAP is new to the repo; introduced only because parent §4.2/§4.9 requires it. Determinism is
  pinned by the "Pinned versions" table both lanes copy verbatim (image tag + digest, apt version,
  `ubuntu-24.04`) — no stock `postgres:16`, no unpinned install, no `ubuntu-latest` drift.
- Golden byte-equality is brittle to intended copy changes; the suite documents the regenerate step and
  mt-packs P4's O3 fixture update is a declared, reviewed golden change.
- The What's New drafter golden stays in the gateway lane (same repo as its prompt): no cross-repo lane.
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
