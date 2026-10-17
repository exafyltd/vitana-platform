# Internal review — mt-guardrails (WS0 guardrails and test tooling)

Reviewer: independent adversarial internal reviewer (spec NN=02, slug=mt-guardrails).
Date: 2026-10-16. Method: read-only verification against platform `origin/main` working tree
(`C:\Users\dstev\vitana-platform-1`) and `C:\Users\dstev\vitana-v1`; queue.mjs validators run on
every spec file; targeted spot-checks only (no build/test suites re-run).

## Verdict

**APPROVED.** Zero HIGH and zero MEDIUM findings. All six queue.mjs validators pass with no errors.
Every premise in `plan.md ## Problem` is verified against current code. Lane sizing, DB/code split,
governance assignment, dependency graph, cross-spec rulings (O1/O3/O4), standing rules and
dark-by-default are all correct. The `## Open questions for sparring` item is non-blocking by rule.

## Validator run (queue.mjs — parseFrontMatter / validatePlan / validateLane)

Ran `validatePlan` on `handoff.md` and `validateLane` on all six `lanes/*.md` (laneIds built from the
folder). **Every file returned `errors: []`.** Details:

- `handoff.md` → `[]` (slug, author kiro, author_seat hotmail, executor kiro, next_actor kiro,
  state drafted, updated present).
- `lanes/local-test-stack.md` → `[]`
- `lanes/generated-inventories.md` → `[]`
- `lanes/pgtap-isolation-suite.md` → `[]`
- `lanes/gateway-scope-lint-contract.md` → `[]`
- `lanes/maxina-golden-suite.md` → `[]`
- `lanes/ci-wiring.md` → `[]`

No validator error ⇒ no HIGH finding from this axis.

## Premise verification (plan.md ## Problem — each against current code)

1. **No local test stack / fixtures (D11).** VERIFIED. `supabase/` contains `migrations/`, `functions/`,
   `tests/`, `ops/`, `seed.sql` only — no committed local-stack config snapshot or fixture tenants.
   `scripts/mt/` does not exist (`file_search scripts/mt/` → none). Program WS0 bullet
   (`docs/MULTI-TENANT-PLAN.md` §6, line 108) names exactly T_A/T_B + a_member/a_admin/b_member/
   b_admin/ab_dual + `CANARY_A_<uuid>`.
2. **No generated inventories or DB lint.** VERIFIED. `scripts/ci/` holds `check-migration-drift.cjs`,
   VTID-specific `test-vtid-*.sh`, `aurora-migration-inventory.cjs`, etc. — no inventory/lint generator.
   The N3 gate / "26 bare policies on 18 tables" premise is confirmed verbatim in
   `docs/MULTI-TENANT-PLAN.md` §2 line 24 and the decision register N3 (line 161).
3. **No pgTAP isolation suite.** VERIFIED. `grep pg_prove|pgtap` under `scripts/**` and `.github/**`
   returns **no matches**; the only hits for those tokens are inside `docs/MULTI-TENANT-PLAN.md` (the
   plan text itself). The "18 tenant tables" and the health-table assertion match §2 and §4.2.
4. **No gateway tenant-scope lint or contract tests.** VERIFIED. The S-I caller-supplied-tenant shapes
   (`x-tenant-id`, `x-user-id`, `?tenant_id`) are enumerated in `docs/MULTI-TENANT-PLAN.md` §3 line 45;
   S-J route inventory in line 47. `services/gateway/src/services/tenancy/tenant-context.ts` exists
   (the surface the lint protects). No `mt-route-inventory`/`mt-contract-canary` test exists today.
5. **No Maxina golden suite.** VERIFIED. `file_search v1-golden-edge` → none; no `golden` fixture under
   `services/gateway/test`. The golden surface list matches the WS0 bullet (§6 line 108) and rule 41
   ("spoken output is not compared").
6. **No MIGRATION-QUEUE CI check.** VERIFIED. `docs/multitenancy/MIGRATION-QUEUE.md` line 9 states
   verbatim: "A CI check that enforces this file is the WS0 lint slice; until then it is a review rule."
   Nothing validates the file today.

**"Already in place" claims.** VERIFIED. `supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql`
exists; `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` wires `ci_tenant_isolation_health()`
report-only at row 21b (lines 539–555), matching design.md's "lines 539–555". Latest migration is
`20261015180000_vtid_05214_plan_sparring_policy_approval.sql`, exactly the plan's stated head.

## Lane sizing, split and assignment

- **One lane = one VTID.** Six lanes, each a single coherent deliverable, each ≤ ~4 PRs of work
  (tooling/tests, no sprawling surface). Acceptable per §4.7 sizing and the CROSS-SPEC lane-count rule.
- **DB split from code (§4.7).** The DB/stack work (`local-test-stack`, `generated-inventories`,
  `pgtap-isolation-suite` — seat hotmail, supabase/scripts paths) is split from the gateway/code work
  (`gateway-scope-lint-contract`, `maxina-golden-suite` — seat jtadic, gateway paths). No lane mixes DB
  fixtures with gateway TS. There is no migration in this spec, so no migration-vs-code lane split is
  owed.
- **Governance lane.** `ci-wiring` touches `.github/workflows/MT-GUARDRAILS.yml` (a governance path:
  `.github/**` is in `GOVERNANCE_PATHS`) → correctly `executor: claude`, `next_actor: claude`, no seat,
  Kiro `reviewer_seat: hotmail`. Validator accepts it; a kiro executor on this path would be refused.
- **Never merged across repos.** All six lanes are repo `vitana-platform`. No cross-repo lane. The
  What's New drafter golden is deliberately kept in the gateway repo (same repo as the drafter prompt),
  explicitly to avoid a cross-repo lane (plan Risks + Open question) — matches CROSS-SPEC lane rule.
- **Seats valid and reviewer_seat ≠ seat.** All seats (hotmail, jtadic, exafy, exafyltd) exist in
  `docs/programs/areas.yaml`. Every kiro lane has `reviewer_seat` different from `seat`
  (hotmail→exafy ×3, jtadic→exafyltd ×2); ci-wiring (claude) → reviewer hotmail. Seat assignment
  matches the brief's uncovered-platform rule (hotmail = supabase/migrations+DB, jtadic = gateway/
  services).

## Dependency graph (depends_on)

Within-spec, acyclic, complete:
- `local-test-stack`: [] (root)
- `generated-inventories`: [local-test-stack] ✓
- `pgtap-isolation-suite`: [local-test-stack] ✓
- `gateway-scope-lint-contract`: [generated-inventories] ✓ (reads the generated route/edge inventory)
- `maxina-golden-suite`: [] (independent — renders Maxina config, needs no stack) ✓
- `ci-wiring`: [local-test-stack, generated-inventories, pgtap-isolation-suite,
  gateway-scope-lint-contract, maxina-golden-suite] — all five, complete ✓

Every `depends_on` id is a lane of this spec (validator confirms). No self-dependency, no cycle.
Cross-spec deps are stated as references, not local `depends_on` (correct): `isHealthTable()`→mt-identity;
mt-packs P4 → this spec's `v1-golden-edge`.

## Cross-spec rulings

- **O1 (health table list).** APPLIED. Plan premise 2 closing note, design "What exists" and the
  pgTAP/gateway lane bodies all reference mt-identity's `isHealthTable()` and explicitly forbid a local
  copy. mt-identity spec exists.
- **O3 (What's New golden).** APPLIED CORRECTLY. `maxina-golden-suite` owns `v1-golden-edge`; the plan
  "Depends on" line states "mt-packs P4 depends on `maxina-golden-suite`'s `v1-golden-edge`" — the
  depends-on direction matches O3 (mt-packs declares the dependency and regenerates the fixture as a
  declared, reviewed golden update). The regenerate script is required by tasks M3.
- **O4 (moderation).** CLEAN. `grep moderation-tenant-db` in the spec folder → no matches; no stale
  moderation lane reference.

## Migration safety and MIGRATION-QUEUE CI design

No migration in this spec (plan ## Migrations: "None"). The pgtap extension is created only in the
local/CI Postgres by the local-stack setup — not a production migration. The range
`20261101020000–025959` (NN=02) is reserved and declared unused, consistent with the batch brief's
per-spec range. MIGRATION-QUEUE position: none. The R6 CI check design (one row per migration file,
apply order, each row names a rollback, report-only→enforce via `scripts/ci/mt/config.json`) mirrors the
established `check-migration-drift` shrinking-baseline pattern, which exists
(`scripts/ci/check-migration-drift.cjs` + `.test.cjs` + `migration-drift-baseline.json`).

## Dark-by-default rollout

Satisfied structurally and correctly justified: WS0 is CI checks + local-only test tooling, off every
runtime path, so no `MT_RESOLUTION_V2` / `tenant_settings.feature_flags.mt.*` gate is needed (nothing
runs in production). New checks land report-only first with a shrinking baseline (the VTID-03480/03486
lesson is explicitly cited in Risks), flipped to enforcing by a later governance change. No DB apply, no
owner-only step, no Gate 2 (deploys nothing).

## Standing rules present

- Rule 41 (golden never compares spoken output) — plan Fix 5, R5.2, design Rule 4, tasks M2. ✓
- Rules 31/31b/48 (no production write/probe; staging read-only) — plan Staging verification + Rollout,
  design Rule 1, every lane body. ✓
- Rules 43–45 (test/service accounts never member-visible) — design Rule 8 (fixtures local-only, never a
  live tenant). ✓
- 42c/42e/42h (`test:support`/`test:operator`/`test:roles` stay green) — plan Tests, gateway + golden
  lane bodies, tasks acceptance. ✓
- Bedrock-only AI / no Google beyond carve-outs — design Rule 8 (no AI call added here; noted). ✓
- i18n DE-first/RTL, Spotlight, What's New only for finished features (none here), nav registry/manifest/
  parity (no App.tsx route added) — design Rule 8 notes these; none are triggered by this tooling-only
  spec. ✓
- Governance stays Claude's (design Rule 6; ci-wiring is executor: claude). ✓

## No duplication of DONE or another spec

- DONE work (VTID-05147/05149/05150/05151) is referenced as predecessors and explicitly built-on, not
  re-planned. `ci_tenant_isolation_health()` is reused, never rebuilt (design "What exists" + Rule 1).
- Other mt-* specs present: `mt-identity`, `mt-track-s`, `multi-tenant`. No overlap — this spec owns the
  WS0 tooling (stack, inventories, pgTAP, gateway lint, golden, MIGRATION-QUEUE check); `isHealthTable()`
  is deferred to mt-identity by reference. No `scripts/mt/**`, pgTAP, golden fixture or MIGRATION-QUEUE
  check exists anywhere today.

## Paths — narrow AND complete

Each lane's `paths` cover exactly the files its tasks change and nothing broader:
- local-test-stack: `supabase/tests/fixtures/**`, `supabase/tests/local-stack/**`, `scripts/mt/stack/**`,
  `docs/multitenancy/LOCAL-STACK.md` — covers T1–T4 (snapshot, seed, up script, doc). Complete.
- generated-inventories: `scripts/mt/inventory/**`, `scripts/mt/lint/**` — covers G1–G4 incl. the
  `out/` inventories and `allowlist.json` (both under those globs). Complete.
- pgtap-isolation-suite: `supabase/tests/mt/**`, `scripts/mt/pgtap/**` — covers P1–P3. Complete.
- gateway-scope-lint-contract: the two `scripts/mt/gateway-scope-lint.*` files, the two named gateway
  test files, and `services/gateway/test/mt/**` (holds `public-routes-allowlist.json` per L2). Complete.
- maxina-golden-suite: `services/gateway/test/mt-maxina-golden.test.ts`, `services/gateway/test/golden/**`,
  `scripts/mt/golden/**` — covers M1–M3 incl. `v1-golden-edge.*` and the regenerate script. Complete.
- ci-wiring: `.github/workflows/MT-GUARDRAILS.yml`, `scripts/ci/mt/**` — covers C1–C3 incl.
  `config.json` and `migration-queue-check.mjs`/`.test.mjs`. Complete.

`docs/validation/<vtid>/` is intentionally omitted from `paths` and each lane body states it adds its own
— matches the batch brief.

## Findings

(No HIGH or MEDIUM. The items below are LOW/NIT and do NOT block, recorded for the executor.)

1. **LOW — `scripts/ci/**` described as a "governance path".** `plan.md` Fix 6, `design.md` ci-wiring and
   `lanes/ci-wiring.md` call `scripts/ci/**` a governance path. In `scripts/collab/queue.mjs`
   `GOVERNANCE_PATHS` (line 69) the only `scripts/**` governance entry is `scripts/collab/**` — not
   `scripts/ci/**`. The lane is nonetheless correctly `executor: claude` because it also touches
   `.github/workflows/MT-GUARDRAILS.yml`, which IS governance. Fix: in the three docs, attribute the
   governance classification to the `.github/**` workflow file, and treat `scripts/ci/mt/**` as ordinary
   platform scripting that is bundled into the claude lane for cohesion (optional wording only).

2. **NIT — Open question on `v1-golden-edge` repo ownership.** The `## Open questions for sparring` block
   asks the sparring partner to confirm the fixture stays in platform (same repo as the drafter prompt)
   rather than vitana-v1, defaulting to platform. This is correctly below `<!-- plan:end -->` and is
   non-blocking by the rubric. The default (platform) is the right call — it keeps O3 single-repo and
   avoids a cross-repo lane. No change needed.

## Verified assumptions

- queue.mjs exports `parseFrontMatter`, `validatePlan`, `validateLane` and they run clean on all files.
- Latest migration head `20261015180000` matches plan.
- `ci_tenant_isolation_health()` migration + MORNING row 21b (lines 539–555) exist as cited.
- No pg_prove/pgtap, no `scripts/mt/`, no `v1-golden-edge`, no gateway mt-* tests, no MIGRATION-QUEUE CI
  check exist today (all premises are current).
- S-I/S-J shapes, 18-table/26-bare-policy count, WS0 bullet, N3 gate all present in
  `docs/MULTI-TENANT-PLAN.md` as the plan cites.
- `docs/multitenancy/MIGRATION-QUEUE.md` line 9 confirms "until then it is a review rule".
- All four seats valid in `docs/programs/areas.yaml`; reviewer_seat ≠ seat on every lane.
- No `moderation-tenant-db` reference (O4 clean).

## Unverified / wrong assumptions

- None. Every premise checked resolved to current code. (The spoken-output / rule-41 compliance of the
  future golden suite and the actual byte-stability of generated inventories are implementation-time
  properties the tasks already pin via acceptance criteria; nothing in the plan is contradicted by
  current code.)
