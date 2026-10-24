# Design — mt-guardrails (WS0 guardrails and test tooling)

## What exists (read these, do not copy them)
- Program plan + decision register: `docs/MULTI-TENANT-PLAN.md` (WS0 bullet in §6; M0 in §7; N3 in §4.2
  and the decision register; D11/D13 decisions).
- Migration queue (the file the R6 CI check validates): `docs/multitenancy/MIGRATION-QUEUE.md`.
- Already live, reuse — do not rebuild: `ci_tenant_isolation_health()` (`DATABASE_SCHEMA.md`;
  migration `supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql`, applied),
  wired report-only into `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` row 21b (lines 539–555).
  WS0's production isolation monitoring is this RPC — the suites in this spec never add a production
  probe.
- CI patterns to follow: `.github/workflows/PR-GATE.yml` (report-only via
  `scripts/ci/pr-gate/config.json` `enforce`; `node --test` self-tests; `continue-on-error` steps
  summed in a Verdict step), `scripts/ci/check-migration-drift.cjs` + `migration-drift-baseline.json`
  (the "baseline, not amnesty" shrinking-backlog pattern), `scripts/ci/check-migration-drift.test.cjs`.
- Local Supabase layout: `supabase/migrations/`, `supabase/functions/`, `supabase/tests/`,
  `supabase/seed.sql` (no committed local-stack config snapshot or fixtures today; no pgTAP anywhere).
- Gateway tenancy context (what the lints protect): `services/gateway/src/services/tenancy/
  tenant-context.ts` (+ repository); caller-supplied-tenant shapes to ban are S-I in
  `docs/MULTI-TENANT-PLAN.md` §3 (`x-tenant-id`, `x-user-id`, `?tenant_id`).
- Required regression suites that must stay green: `npm run test:support` (rule 42c), `npm run
  test:operator` (rule 42e), `npm run test:roles` (rule 42h) — script definitions in
  `services/gateway/package.json`.
- What's New drafter (the `v1-golden-edge` source): the gateway drafter prompt behind
  `WHATS-NEW-DRAFT.yml`; the v1 entry format in `vitana-v1/src/whats-new/README.md`.
- The health-table predicate: mt-identity's `isHealthTable()` (CROSS-SPEC O1) — reference it, never a
  local copy.

## Design per lane

### local-test-stack (kiro, seat hotmail, repo vitana-platform)
A committed `supabase/` local-stack config snapshot + a fixture seed under `supabase/tests/fixtures/`
and a `scripts/mt/` regenerate/up script. Schema is produced by dumping the production *structure*
(`--schema-only`, no `--data`) into a checked-in file; the regenerate script documents the exact
read-only dump command but the committed artifact is structure only (D11). Fixtures insert T_A/T_B,
the five members and the `CANARY_A_<uuid>` markers via SQL seed, idempotently. No live call runs in
CI; the stack is a disposable local Postgres (the same service-container style as
`SQL-TENANT-FOUNDATION.yml`).

### generated-inventories (kiro, seat hotmail, repo vitana-platform; depends on local-test-stack)
Node generators under `scripts/mt/inventory/` reading `information_schema`/`pg_catalog` from the local
stack and the route tree from `services/gateway/src/routes` + `supabase/functions`, emitting checked-in
JSON inventories under `scripts/mt/inventory/out/`. A `scripts/mt/lint/` module applies the five DB
lints and the bare-policy counter against an owner-tagged allowlist (`scripts/mt/lint/allowlist.json`,
each entry carrying an owner tag + reason, mirroring the drift-baseline pattern). Output is a report
plus a non-zero count; the bare-policy count is reported, never asserted 0 in WS0 (N3 is a WS1 gate).
Unit tests run each generator over a tiny fixture schema and assert the committed inventories
regenerate byte-identically (drift guard).

### pgtap-isolation-suite (kiro, seat hotmail, repo vitana-platform; depends on local-test-stack)
`supabase/tests/mt/*.sql` pgTAP specs run by `pg_prove` against the seeded local stack. For each of the
18 tenant tables (listed in `docs/MULTI-TENANT-PLAN.md` §2) and the health tables (resolved through the
mt-identity `isHealthTable()` list, imported, not copied), assert: as b_member, 0 rows visible that
carry a T_A `tenant_id`/`CANARY_A`; an INSERT/UPDATE with a T_A `tenant_id` is rejected by RLS. One spec
covers ab_dual reading and writing a single health series. The suite is read-only against production by
construction (it only ever touches the local stack).

### gateway-scope-lint-contract (kiro, seat jtadic, repo vitana-platform; depends on generated-inventories)
- `scripts/mt/gateway-scope-lint.mjs`: a static scan of `services/gateway/src/**` repositories that
  flags reading tenant identity from a request header or query param outside the admin route allowlist
  (the S-I shapes), with a committed allowlist for the legitimate exafy_admin/service callers.
- `services/gateway/test/mt-route-inventory.test.ts`: reads the generated route inventory; every route
  with no auth middleware must appear in a committed `public-routes-allowlist.json`.
- `services/gateway/test/mt-contract-canary.test.ts`: drives route×role×tenant combinations over the
  fixtures and asserts no `CANARY_A` value in any response body, including edge-function calls with no
  JWT, the anon key, and a b_member token. Runs over fixtures/local stack only.

### maxina-golden-suite (kiro, seat jtadic, repo vitana-platform)
`services/gateway/test/mt-maxina-golden.test.ts` + `services/gateway/test/golden/` fixtures. Renders the
assembled instruction/intents and the UI/push/email strings with Maxina config and asserts byte
equality against the committed golden files for: persona, pre-login, greetings, journey-modes,
first-time welcome, push copy, What's New drafter, OG previews, signup default tenant, role routing.
Spoken output is never captured or compared (rule 41 — only facts/intents + non-speech strings). The
`golden/v1-golden-edge.*` fixture is owned here; mt-packs P4 updates it as a declared, reviewed golden
change (CROSS-SPEC O3) with an explicit depends-on. A regenerate script is documented so an intended
copy change is an explicit, reviewed update, never a silent diff.

### ci-wiring (claude, governance, repo vitana-platform; depends on lanes 2–5)
New/edited `.github/workflows/**` and `scripts/ci/**` wiring the inventory/lint generators, the pgTAP
suite, the gateway scope lint, the contract tests and the golden suite into CI, report-only first
(a `scripts/ci/mt/config.json` `enforce` switch like PR-GATE's), then enforcing. A
`scripts/ci/mt/migration-queue-check.mjs` + `.test.mjs` validates `docs/multitenancy/MIGRATION-QUEUE.md`
(every migration file has exactly one row, rows are in apply order, each names a rollback), replacing
the review rule. This lane is `executor: claude` because every file it touches is a governance path.

## Rules every successor follows
1. **Read-only against production, always.** WS0 adds no production write, probe, canary, honeytoken or
   sign-in (plan §6 WS0; rules 31/31b/48). The only production signal is the existing
   `ci_tenant_isolation_health()` RPC — never duplicate it.
2. **Local stack, never production, for every suite (D11/D13).** Schema from a structure-only dump;
   fixtures are synthetic (T_A/T_B, CANARY_A). No synthetic tenant in production.
3. **Baseline, not amnesty.** A new lint/golden check lands report-only with a visible, shrinking
   baseline (the `check-migration-drift` pattern); never a hard 0 on existing drift, never a loosened
   assertion to go green.
4. **Golden never compares spoken output (rule 41).** Compare facts/intents and non-speech UI/push/
   email strings only. An intended copy change regenerates the fixture through the documented script as
   a reviewed update.
5. **One owner for each predicate.** `isHealthTable()` is mt-identity's (O1); the bare-policy list and
   inventories are generated, never hand-maintained; the public-routes and lint allowlists are
   owner-tagged.
6. **Governance stays Claude's.** Any `.github/**`, `.claude/**`, `.kiro/steering/**`,
   `.kiro/automations/**`, `scripts/collab/**`, `CLAUDE.md`, `docs/programs/areas.yaml` change is an
   `executor: claude` lane (collaboration §3a / §7a; enforced by Lane scope).
7. **Dark by default is structural here.** These are CI checks and local-only tooling off every runtime
   path; no `MT_RESOLUTION_V2` / feature flag is needed because nothing runs in production.
8. Standing rules apply unchanged: rules 43–45 (test/service accounts never member-visible — the
   fixtures are local-only and never reach a live tenant); i18n DE-first du-form, RTL, Spotlight
   contract, What's New only for finished member features (none here), Bedrock-only AI, no Google.
