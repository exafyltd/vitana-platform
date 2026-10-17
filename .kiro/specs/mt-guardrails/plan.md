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
   (not hand-listed) count of bare `current_tenant_id()` policies, plus inventories of tables,
   functions, routes, edge functions, realtime tables and storage buckets, and lints for nullable
   `tenant_id`, missing tenant policy, DEFINER without revoke/caller check, realtime tables without
   tenant RLS, and storage policies, with an owner-tagged allowlist. None exist today
   (`scripts/ci/` has `check-migration-drift.cjs` and VTID-specific checks only; no inventory/lint
   generator).
3. **No pgTAP isolation suite.** No `pgtap`/`pg_prove` anywhere in CI or scripts. The plan needs
   per-table/function pgTAP asserting b_member reads 0 T_A rows and a T_A-tenant write by b_member
   fails (§4.2 "pgTAP asserts a_member cannot read a_admin's user-private rows on every one of the 18
   tables and the health tables").
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
`20261014000300`, applied; `DATABASE_SCHEMA.md`) wired report-only into
`MORNING-SYSTEM-HEALTH-CHECK.yml` row 21b — WS0's *production* isolation monitoring is DONE. The
`isHealthTable()` predicate is owned by mt-identity (CROSS-SPEC O1); this spec's lints reference it,
never their own list.

## Fix (per lane)
1. **`local-test-stack`** (kiro, seat hotmail, repo platform) — committed D11 local-stack config
   snapshot + fixture seed: tenants T_A/T_B, members a_member/a_admin/b_member/b_admin/ab_dual, a
   `CANARY_A_<uuid>` marker in representative T_A rows. Schema from a production *schema* dump
   (structure only, never data), checked in with a regenerate script. A `make`/npm entry brings the
   stack up for the pgTAP, inventory and contract lanes. No production access of any kind.
2. **`generated-inventories`** (kiro, seat hotmail, repo platform) — generators that read the local
   schema (never production) and emit checked-in inventories of tables, functions, routes, edge
   functions, realtime tables and storage buckets, plus the DB lints (nullable `tenant_id`, missing
   tenant policy, DEFINER without revoke/caller check, realtime table without tenant RLS, storage
   policy) with an owner-tagged allowlist file. The bare-policy counter (N3 gate) lives here and reads
   ZERO today only once policies are rewritten — it reports the current count, not a hard 0, in WS0.
   Depends on `local-test-stack`.
3. **`pgtap-isolation-suite`** (kiro, seat hotmail, repo platform) — `supabase/tests/**` pgTAP specs
   run by `pg_prove` against the local stack: b_member sees 0 T_A rows and a T_A-tenant write by
   b_member fails, per the 18 tenant tables and the health tables (via the mt-identity
   `isHealthTable()` list, not a local copy). ab_dual read/write single-series health assertion.
   Depends on `local-test-stack`.
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
   (`.github/workflows/**`, `scripts/ci/**`), report-only first per the PR-GATE pattern (its own
   `config.json` enforce switch), then enforcing. Adds the MIGRATION-QUEUE CI check (file shape, apply
   order, one row per migration file) replacing the review rule. Governance paths → `executor: claude`,
   `next_actor: claude`. Depends on lanes 2–5 producing the commands it runs.

## Migrations
None. `ci_tenant_isolation_health()` already exists (VTID-05149, `20261014000300`, applied). The
bare-policy lint and inventories read the schema read-only; pgTAP needs the `pgtap` extension in the
local/CI Postgres only, created by the local-stack setup, not a production migration. Reserved range if
a WS0 slice later needs one: `20261101020000`–`20261101025959` (NN=02); none used in this spec.
MIGRATION-QUEUE position: none (adds no migration).

## Tests
- `local-test-stack`: a smoke script brings the stack up and asserts the fixtures load; no live calls.
- `generated-inventories`: unit tests on each generator over a tiny fixture schema; the committed
  inventories regenerate byte-identically (drift test).
- `pgtap-isolation-suite`: `pg_prove` green against the local stack (the suite itself).
- `gateway-scope-lint-contract`: Jest — lint flags a header/query-tenant repository, passes a clean
  one; route-inventory test; contract tests over fixtures (no `CANARY_A` leak).
- `maxina-golden-suite`: Jest byte-equality; required suites `npm run test:support` (rule 42c),
  `npm run test:operator` (rule 42e), `npm run test:roles` (rule 42h) stay green.
- `ci-wiring`: `node --test` self-tests for the new scripts; the workflows run on this PR report-only.

## Staging verification
Read-only (rule 48). WS0 is tooling/tests/CI: nothing deploys and nothing writes to any live system.
The production isolation signal is the already-live, read-only `ci_tenant_isolation_health()` RPC in
`MORNING-SYSTEM-HEALTH-CHECK.yml` (row 21b); no new production probe, canary or honeytoken (plan §6 WS0
"No production canary, no honeytokens, no sign-in probes"). No STAGING-VERIFY suite is added because no
runtime surface changes.

## Rollout
Dark by default is satisfied structurally: these are CI checks and local-only test tooling, off every
runtime path (no `MT_RESOLUTION_V2` / `tenant_settings.feature_flags.mt.*` gate needed because nothing
runs in production). New CI checks land report-only first (PR-GATE `scripts/ci/pr-gate/config.json`
pattern) and are flipped to enforcing by a later governance change. No DB apply, no owner-only step. No
Gate 2 (deploys nothing).

## Risks
- A lint/golden suite red on day one is ignored (the VTID-03480/03486 lesson): every new check lands
  report-only with a visible, shrinking baseline, never a hard 0 on existing drift.
- pgTAP/`pg_prove` adds a CI dependency; `ci-wiring` installs it in the job, and the local-stack script
  creates the extension — no new production dependency.
- Golden byte-equality is brittle to intended copy changes; the suite documents the regenerate step and
  mt-packs P4's O3 fixture update is a declared, reviewed golden change, not a surprise.
- Cross-repo temptation: the What's New drafter golden could be split to vitana-v1; it is kept in the
  gateway golden lane (same repo as the drafter prompt) to avoid a cross-repo lane (CROSS-SPEC lane
  rule).

## Out of scope
Policy classification and the resolver cutover (WS1, N3 — this spec only *counts* bare policies);
membership unification; the access-token hook (D14, owner-only); WS2 data cleanup; any migration that
changes a policy or `current_tenant_id()`; native/health/commerce isolation suites beyond the table
list referenced here. Each later slice is its own sparred spec.

## Depends on
Done: VTID-05147 (S-M), VTID-05149 (A: `ci_tenant_isolation_health`, `TenantContext`), VTID-05150 (B),
VTID-05151 (C). Within this spec: `generated-inventories` → `local-test-stack`;
`pgtap-isolation-suite` → `local-test-stack`; `gateway-scope-lint-contract` → `generated-inventories`;
`ci-wiring` → lanes 2–5. The `isHealthTable()` predicate: mt-identity (CROSS-SPEC O1). Cross-spec O3:
mt-packs P4 depends on `maxina-golden-suite`'s `v1-golden-edge`.

## Owner decisions
None new. D11 (local stack), D13 (no synthetic/production tenant — WS0 runs on the local stack only),
rule 41 (golden never compares spoken output), rules 31/31b/48 (no production write/probe) all stand as
decided.
<!-- plan:end -->

## Open questions for sparring
- Confirm `v1-golden-edge` fixture ownership stays with `maxina-golden-suite` in platform (same repo as
  the drafter prompt) rather than a vitana-v1 lane — CROSS-SPEC O3 names mt-guardrails as owner but not
  the repo. Default: platform.
