# Plan sparring record — VTID-05084

Plan hash (sha256 of the text between the plan markers, as approved): `ee149d71da827d3f744c0418aa5e3bf9d96b50af94a113c4a1b36e3490d83aa8`.
Partner: plan-sparring-partner (read-only, independent). Class: standard. Verdict: **CONVERGED** after 2 rounds.
Owner approval: in session 2026-10-12, "yes, approved" in answer to the Gate 1 message for plan v2 (the final plan, both rounds with responses, the files in scope and the test plan).
Gate: the VTID was allocated with `p_plan_hash` set to the hash above and no `p_sparring_id` (no gateway `plan_sparring_sessions` row exists for an in-session sparring); this record is referenced from the ledger row's metadata (`sparring_record`).

History: plan v1 (100 flat loops; `plan-v1-appendix.md`) was sparred to CONVERGED (2 rounds; findings F1–F9 all answered) and taken to Gate 1. The owner did not approve it and asked instead to compress overlapping loops and compare against Tests & QA, Routines and Health Checks. Plan v2 below is the answer to that; it was sparred from scratch by a fresh partner session.

---

# Plan v2 — Vitanaland Loop Engineering: few loops, one engine, every check owned

<!-- plan:begin -->
## 0. Meta
- **Change class:** standard. It adds a new gateway route, a Command Hub module and a nav change. There are no migrations, no auth changes, no LLM-routing changes and no workflow YAML changes. One CI script is touched (the ownership-guard allowlist).
- **Repos:** only `exafyltd/vitana-platform`.
- **Owner direction (2026-10-12):**
  - Build a Command Hub → Autonomy screen for loop engineering.
  - Then: *"we have too many things that do the same thing… compress 2 or 3 loops into one… compare with Tests & QA, Routines, Health Checks… simplification is the goal."*
- **Supersedes plan v1**, which had 100 flat loops. v1 listed sensors (single checks) as if they were loops. v2 compresses those 100 into **14 loops** on **one shared engine**. Every v1 item is kept, traceable as a case inside a loop.
- **Phase 1 only:** the catalog, the screen and the doctrine doc. The roadmap in §7 needs its own plans, sparring and VTIDs.

## 1. The simplification principle
**A check is not a loop.** A loop closes a cycle: **sense → decide → act → verify with the same sensor → learn**. Vitanaland already has hundreds of checks. Most of v1's "loops" were one of these checks, which is how the duplication crept in. v2 uses three layers:

| Layer | What it is | Rule |
|---|---|---|
| **Sensors** | Tests, health checks, routines, alert workflows. They observe and say green or red. | They stay in the registries that already exist. They are never re-listed as loops. Every sensor belongs to exactly one loop, or it is a retire candidate. |
| **Loops (14)** | A closed cycle with a goal, an act step, an independent verifier, a stop rule, a human gate, a budget and metrics. | Few loops. A new problem becomes a new case in an existing loop, not a new loop. |
| **Shared engine (one of each)** | One intake, one executor, one verifier set, one run ledger, one human inbox. | No loop builds its own copy of any of these. |

## 2. Comparison: what exists today and what it is in loop terms
| Existing asset (Command Hub location) | Size today | Loop role |
|---|---|---|
| **Testing & QA** (`testing-qa/*`): test catalog, runs, E2E, test contracts | 593 suites / ~11.7k tests (`TEST-SUITE.yml`), 16 Playwright E2E projects, 11 `live_probe` contracts, TEST-CATALOG workflow list | **Sensors and verifiers** for L1, L2 and L3 |
| **Routines** (`routines/*`) | 19 routine files, `routines`/`routine_runs` tables; a failed run already writes `self_healing_log` (`routes/routines.ts:466-581`) | **Sensors** feeding L1, which is already wired |
| **Health Checks**: `diagnostics/health-checks` and `infrastructure/health` | Both probe **the same 5 endpoints** and ignore the real registry | **Duplicate**, first L4 case |
| **Service Health registry** (header pill; `constants/service-health-registry.ts`) | 117 checks in 18 groups (`SERVICE_HEALTH_GROUPS`, `service-health-registry.ts:41-59`), incl. `ops/health/*` (google-fallback, anthropic-credit, test-actor-guard, push-dispatch…) | **The canonical sensor registry** for L1 and L5 |
| **Alert / monitor workflows** (`.github/workflows` ALERT-*, E2E-ORB-MONITOR, SCREEN-LOAD-TIMING, VCAOP-HEALTH, MIGRATION-DRIFT…) | ~19 scheduled | **Sensors**. Today most only alert and do not feed L1 (a gap) |
| **Self-healing** (`autonomy/self-healing`) | live | L1 act engine (intake + diagnosis) |
| **Dev Autopilot** (`autonomy/autopilot-developer`) | live | The **one executor** (plan → PR → merge → verify) |
| **Autonomy Pulse** (`autonomy/autonomy-pulse`) | live | The **one human inbox** (approvals across planes) |
| **Autonomy Trace** + `agent_runs_unified` | live | The **one run ledger** |
| **Autopilot — Community** (`autonomy/autopilot-community`) | info card that points to the Autopilot section | unchanged |
| **Autopilot — Admin** (`autonomy/autopilot-admin`) | "Coming soon" placeholder; its planned scope (admin recommendations from platform signals) is a loop | **Replaced by the Loops screen** |

**Duplicates found. These form the initial L4 backlog; Phase 1 only lists them:**
1. `diagnostics/health-checks` and `infrastructure/health` render the same 5 probes; neither uses the 117-check registry.
2. The ORB health probe exists four times: the `orb-audio-smoke` routine, `E2E-ORB-MONITOR`, `ALERT-ORB-*`, and Service Health.
3. The push probe exists three times: the `push-pipeline-probe` routine, `ALERT-PUSH-DISPATCH-HEALTH`, and `ops/health/push-dispatch`.
4. Migration drift is checked twice: the `migration-backlog` routine and `MIGRATION-DRIFT-CHECK`.
5. Frontend reachability is checked twice: the `cloud-run-frontend-health` routine and `ops/runtime/deploy/frontend-*`.
6. The self-healing queue is actionable on two screens: `autonomy/self-healing` and `autonomy-pulse`.
7. Test-contract failures are actionable on two screens: `testing-qa/test-contracts` and `autonomy-pulse`.
8. `self-healing-triage` is registered twice: as a routine and in `agents_registry`.
9. The missing-test scanner is registered twice: in `dev_autopilot_scanners` and as a test-contract source type.
10. Scheduled-job lists live in four places: `routines`, the TEST-CATALOG JSON, the EventBridge shell script, and the hardcoded `SCHEDULED_WORKFLOWS` list (`ops-runtime-health.ts:273`).

## 3. The 14 loops (v1 IDs in brackets: every one of v1's 100 is accounted for)
Status: LIVE = closed today · PARTIAL = runs, but one step is missing (named) · PLANNED.

### Platform loops (make the system fix and improve itself)
| # | Loop | Cycle | Sensors it owns | Gate | Status | v1 cases folded in |
|---|---|---|---|---|---|---|
| L1 | **Repair** | any sensor red → one intake (`self_healing_log`) → diagnose → fix via executor → **re-run the same sensor** + STAGING-VERIFY | Service Health registry (operational groups), routines, alert/monitor workflows, test contracts, error clusters | spec approval for code changes | PARTIAL: routines and contracts feed intake, but alert workflows only alert | P01 P02 P03 P05 P06 P07 P08 P09 P10 Q01 Q10 V02 V03 G07 G08 |
| L2 | **Build & Release** | finding → plan → PR → LLM review → merge → staging → STAGING-VERIFY → Gate 2 → prod check | CI suites, nightly staging suite, a11y/visual/CSP gates, nav-registry test | approval gates, Gate 2 | LIVE (Dev Autopilot); a11y/visual/CSP gates planned | E01 E02 E03 E08 E09 E10 P04 Q04 Q06 Q07 Q08 Q09 |
| L3 | **Learn** | every L1/L2/L6 outcome leaves a lesson: a new test, a repair pattern, a prompt learning, a graduation proposal, a sparring-quality score | outcomes ledger, `repair_patterns`, `dev_autopilot_prompt_learnings`, shadow evals | owner approves each graduation | PARTIAL: outcomes are recorded, nothing acts on them | E04 E05 E06 E07 V10 Q02 Q03 Q05 |
| L4 | **Simplify** *(new)* | duplicate, orphan or never-red sensor, dead code, stale rule → retire/merge proposal → removal PR → verify coverage unchanged | the catalog's own coverage check (§4), repowise dead-code/health, rules↔code drift | owner approves every removal | PLANNED | K10 + the 10 duplicates in §2 |
| L5 | **Guard** | cost, fallback, secret, test-account, consent or ledger signal → **escalate, never auto-act** | `ops/health/*` (google-fallback, anthropic-credit, test-actor-guard), OASIS ledger integrity, sparring reconciler, persona-voice test | owner / DPO | PARTIAL: the checks exist, but spend budgets, the GCP window and the consent audit are missing | G02 G03 G04 G05 G06 G09 G10 M07 V04 |
| L6 | **Support** | ticket → Devon spec / Sage answer → executor → reporter told → answer acceptance feeds the knowledge base | `feedback_tickets`, support regression suite | dispatch activation | LIVE; KB feedback is partial | G01 K09 |

### Product loops (make the member, supplier and creator experience improve itself)
| # | Loop | Cycle | Gate | Status | v1 cases folded in |
|---|---|---|---|---|---|
| L7 | **Voice quality** | session outcomes (opener, tool success, misroute, locale errors, repetition, provider cost) → tuning PR → shadow → enforce | owner flips shadow→enforce | PARTIAL (`jev/gates`) | V01 V05 V06 V07 V08 V09 |
| L8 | **Content & language** | new content or string → propagate to 11 locales → audit (register, RTL, quality) → apply ≥ 0.80 suggestions → What's New once live | human merges | PARTIAL: the audit is manual-only | K01 K02 K03 K04 K05 K06 K07 K08 |
| L9 | **Supplier catalog** | supplier/feed in → normalize (deterministic validators first) → claim + media + certificate + duplicate checks → draft → approve → publish → keep in sync (stock, price, affiliate links) | human review + publish; never auto-pay a PO | PARTIAL (`partner-verification.ts`, Shopify/Awin sync) | S01–S10 C09 |
| L10 | **Listing & creator commerce** | listing or creator video → completeness/SEO/image audit, product match, copy and caption variants under the claim verifier → creator/supplier approves → measure CTR/CVR → next angle | supplier/creator approves | PLANNED | C01–C07 C10 |
| L11 | **Trust** | review or report → classify (fraud, abuse, test account) → hold → human decides → classifier feedback | moderator | PLANNED | C08 M10 |
| L12 | **Engagement** | every notification/nudge → open, mute and unsubscribe rates → cadence and throttle adjust | none for cadence within bounds | PARTIAL (morning-brief pacer, lifecycle worker, welcome alert) | M03 M04 M06 M08 |
| L13 | **Community matching** | matches, events, recommendations, admin insights → acceptance/attendance → weights adjust | supervisor / tenant admin | PARTIAL (community autopilot shadow, recompute, recommendation engine) | M01 M02 M05 M09 H06 |
| L14 | **Health coaching** *(R3: no diagnosis, no prescription, no autonomous purchase)* | check-in / consented data → non-diagnostic plan → prepared cart or booking → **member confirms** → adherence → adjust | member; professional for labs | PARTIAL (guided journey, daily recompute) | H01 H02 H03 H05 H07 H08 H09 |

**Shared engine components (not loops, one of each):**
- **Intake:** `self_healing_log` + `autopilot_recommendations`.
- **Executor:** Dev Autopilot.
- **Run ledger:** `agent_runs_unified`.
- **Human inbox:** Autonomy Pulse.
- **Verifier set:** the sensors, plus two shared safety verifiers used by L8, L9, L10 and L14: a **claim verifier** (no diagnosis or treatment claims; v1 H10) and **red-flag rules** (deterministic urgent-care escalation; v1 H04).

Totals: **14 loops** (2 LIVE · 9 PARTIAL · 3 PLANNED), 2 shared verifiers, 100/100 v1 cases mapped. (The v1 list of 100 is the appendix file `loop-engineering-plan.md` next to this plan, and the catalog stores each case's v1 ID and text.) Two loops are new and were missing in v1 as loops: **L3 Learn** (unifies four half-built learning stores) and **L4 Simplify**, the loop that keeps the system small.

## 4. The coverage rule (the mechanical part of simplification)
Each loop in the catalog declares the sensors it owns, by reference to the registries that already exist. Nothing is copied. Reference kinds:
- `health_group`: a group in `SERVICE_HEALTH_REGISTRY`.
- `routine`: `routines/<name>.md` at the repo root (19 files; `README-mobile-loading.md` is excluded).
- `workflow`: a `.github/workflows/*.yml` with a `schedule:`.
- `test_contract`: a key in `COMMAND_ALLOWLIST` (`services/test-contract-commands.ts`).

A test reads those four registries and asserts:
1. **Every sensor is owned by exactly one loop**, or is listed in `retire_candidates` with a reason. No orphan check nobody acts on, and no check owned twice.
2. Every reference resolves; there are no dangling refs.
3. Every v1 case ID is mapped exactly once.

A new routine, health check or scheduled workflow therefore fails CI until someone says which loop acts on it. This is how the system stops growing duplicate checks. The ten §2 duplicates are listed in the catalog as `overlaps`. That list is the visible L4 backlog. Phase 1 does not remove any of them.

## 5. What Phase 1 builds
1. **Catalog spec** `services/gateway/specs/loop-catalog-v1.json`. It holds:
   - the 14 loops; each has the full contract (trigger, goal, act, verifier, stop + stagnation rule, human gate, budget, metrics), risk R0–R3, autonomy L0–L3, status + gap, `existing_ref`, owned sensors, folded v1 cases, and an optional `run_plane`;
   - the shared components;
   - `overlaps`;
   - `retire_candidates`.

   **Invariants:**
   - R2/R3 ⇒ human gate.
   - R3 ⇒ autonomy ≤ L2.
   - L8, L9, L10 and L14 ⇒ the claim verifier.
   - No Google LLM routing (CLAUDE.md 10a–10c, IF-THEN 27).
   - No test-account writes (rules 31 and 43).

   `existing_ref` = `{repo, kind, ref}`. vitana-v1 refs are checked against `specs/loop-catalog-external-refs.json`, whose count is asserted.
2. **Service** `services/gateway/src/services/loop-catalog.ts`:
   - loads and validates the catalog, failing loudly if it is invalid;
   - computes sensor coverage from the four registries at request time;
   - attaches a read-only plane-level 7-day signal from `agent_runs_unified`. `run_plane` ∈ {`dev_autopilot`, `community_autopilot`, `self_healing`}: L1 → `self_healing`, L2 → `dev_autopilot`, L13 → `community_autopilot`. Each distinct plane is queried once and cached for 60 s. The query selects `status` with `plane = X AND created_at > now() - 7 days` and is capped at 5,000 rows; if the cap is hit, the signal is marked `capped`. A view error degrades the signal to `unavailable`. The UI tells the cases apart: "no run ledger yet" for the 11 loops without a `run_plane` (Phase 3 gives them per-loop signals), "no runs in 7 days", "unavailable", or the counts. The card's main content is the contract and the sensor coverage, so cards without a ledger still read as complete.
3. **Route** `services/gateway/src/routes/autonomy-loops.ts`:
   - `GET /api/v1/autonomy/loops` only, returning loops, components, coverage, overlaps and totals;
   - guarded by the exported shared `requireAuth` + `requireExafyAdmin` (`middleware/auth-supabase-jwt.ts:384,462`);
   - a separate router on `/api/v1/autonomy`, next to pulse and trace (`index.ts:895-896`);
   - one unpaginated payload.
4. **Command Hub: Autonomy → "Loops"** (`/command-hub/autonomy/loops/`) **replaces the "Autopilot — Admin (Coming soon)" tab**, so the Autonomy tab count stays at 6:
   - remove the `autopilot-admin` nav entry, its render-switch branch and `renderAutopilotAdminView` (so `t2-no-zero-caller-functions` stays green);
   - add `autonomy/autopilot-admin` → `autonomy/loops` to `AUTONOMY_REDIRECTS` so old links still work;
   - new module `loops-catalog.js`/`.css`, as `modules.json` `bundle` `kind: "module"` before `app.js`, exposing `window.LoopsCatalog.render(container)`. At load time it only defines the global and never touches the DOM; `app.js` calls `render` from its render switch and guards the global like `app.js:1501-1503`. `modules.json` lists JS only. The CSS is a plain `<link rel="stylesheet" href="/command-hub/loops-catalog.css?v=…">` in `index.html`, like `kiro-console.css` and `pipeline-tree.css` (`index.html:9,12`); it is an external stylesheet, so it is CSP-compliant. The `<script>` tag also carries `?v=`.
   - The Command Hub voice-navigation registry `src/navigation/data/command-hub-screens.json` replaces the `DEVHUB.AUTONOMY.AUTOPILOT_ADMIN` entry (`:710`) with a `DEVHUB.AUTONOMY.LOOPS` entry (route, title, "shows", phrasings), keeping `test/navigation/vtid-04814-command-hub-navigation.test.ts` green.
   - The stale `'autopilot-admin'` label overrides in `scripts/regen-screens-catalog.mjs:136,360` are removed. `specs/dev_screen_inventory_v1.json` (underscore, a legacy copy no code reads) is not touched.

   **UI (read-only, no action buttons):**
   - a header strip that explains the three layers in one line each;
   - 14 loop cards in two groups (Platform / Product), each with its cycle, status + gap, gate, number of sensors owned, and the 7-day signal where one exists;
   - a loop detail panel with the full contract, the folded v1 cases, and the owned sensors, each linking to its home screen (Testing & QA, Routines, Service Health);
   - a **Simplification panel** with coverage (owned / orphan / double-owned / retire candidates) and the overlaps list.

   Handlers use `addEventListener` (CSP); the screen has keyboard-reachable cards and ARIA labels.
5. **Regenerated** `navigation-config.js` and `specs/dev-screen-inventory-v1.json` (never hand-edited); `--check` must pass.
6. **Doctrine doc** `docs/autonomy/LOOP-ENGINEERING.md`: the three layers, the loop contract, risk and autonomy ladders, the coverage rule, the comparison table, the 14 loops, the v1→v2 mapping, and the roadmap.
7. **Ownership guard:** the VTID goes into `ALLOWED_VTID_PATTERN` in `scripts/ci/command-hub-ownership-guard.js`.

## 6. Files and tests
**New:**
- `services/gateway/specs/loop-catalog-v1.json`
- `services/gateway/specs/loop-catalog-external-refs.json`
- `services/gateway/src/services/loop-catalog.ts`
- `services/gateway/src/routes/autonomy-loops.ts`
- `command-hub/loops-catalog.js` and `loops-catalog.css`
- `docs/autonomy/LOOP-ENGINEERING.md`
- tests
- `docs/validation/<VTID>/plan-sparring.md` and `staging-tests.json`

**Changed:**
- `index.ts`: one mount line
- `app.js`: nav entry swap, render hook, redirect, removal of `renderAutopilotAdminView`
- `index.html`: `?v=`, plus the new `<script>` and `<link>`
- `src/navigation/data/command-hub-screens.json`: AUTOPILOT_ADMIN entry → LOOPS entry
- `scripts/regen-screens-catalog.mjs`: remove the two stale label overrides
- `modules.json`
- `navigation-config.js` and `dev-screen-inventory-v1.json` (both generated)
- `scripts/ci/command-hub-ownership-guard.js`

**Not touched:** DB, auth middleware, LLM routing, workflow YAML, vitana-v1, and every existing sensor (none is removed in Phase 1).

**Tests:**
- **Catalog test:** 14 loops; the full contract on each; the invariants; 100/100 v1 cases mapped exactly once; refs resolve.
- **Coverage test:**
  - reads `SERVICE_HEALTH_REGISTRY` groups, `routines/*.md`, scheduled workflows and `COMMAND_ALLOWLIST`;
  - asserts every sensor is owned by exactly one loop or is a retire candidate;
  - asserts the reported counts match.
- **Service test:**
  - signals from a mocked view; a view error gives `unavailable`;
  - an invalid catalog throws.
- **Route test** `test/routes/autonomy-loops.test.ts`:
  - 401 without a token, 403 for a non-admin, 200 shape for an admin;
  - GET only.
- **Command Hub test** `test/command-hub/vtid-<VTID>-loops-screen.test.ts`:
  - Autonomy nav has `loops` and not `autopilot-admin`;
  - the redirect works;
  - 14 cards from a fixture;
  - the detail panel and the Simplification panel render;
  - no inline handlers.

  The existing guards stay green: bundle manifest, t2 zero-caller, t10 a11y, golden fingerprint, screen-inventory sync.
- **Local:** typecheck, lint, Jest, regen `--check`.
- **Staging (read-only `staging-tests.json`, picked up by STAGING-VERIFY by path convention, `STAGING-VERIFY.yml:17`, with no workflow change):**
  - `/command-hub/` references `loops-catalog.js?v=…`;
  - the module is served with its render function;
  - `GET /api/v1/autonomy/loops` without a token returns 401 JSON.
- **Production:** no tests.

## 7. Roadmap (each item needs its own plan, sparring and VTID; not approved by this plan)
- **Phase 2 — run L4 Simplify on the §2 overlaps first:**
  - fold `diagnostics/health-checks` + `infrastructure/health` into one view of the 117-check registry;
  - de-duplicate the ORB, push, migration and frontend probes to one sensor each;
  - make Autonomy Pulse the only place to act on self-healing and contract failures;
  - collapse the four scheduled-job lists into `routines`, adding a `kind`/`runner` column.

  Fewer things before more things.
- **Phase 3 — close L1:** every alert workflow writes to the one intake instead of only alerting, and is verified by re-running the same sensor. Also the L5 budgets (LLM spend per stage, the silent-fallback incident rule, the GCP window) and a per-loop kill switch, budget and stagnation stop on the existing `agents_registry` + `agent_runs`.
- **Phase 4 — L3 Learn:** act on the outcomes ledger (graduation proposals, an escaped bug becomes a test).
- **Phase 5 — L9 Supplier catalog wave 1:** one category, ≤ 20 SKUs per run, deterministic validators before any LLM, the shared claim verifier, a human publish gate. Target: 80% of rows ready for approval without manual entry.
- **Phase 6 — shared safety verifiers (claim + red-flag) with eval sets, then L14 Health coaching MVP.**
<!-- plan:end -->

---
## Planner responses — round 1 (v2)
- **F1 [minor] — ACCEPTED.** Corrected to 117 checks and 18 groups. Coverage is checked per `SERVICE_HEALTH_GROUPS` entry.
- **F2 [major] — ACCEPTED (clarified).** The CSS is a plain `<link>` in `index.html`, the same pattern as `kiro-console.css`/`pipeline-tree.css` (`index.html:9,12`). `modules.json` stays JS-only. It is an external stylesheet, so it is CSP-safe. Plan §5.4 updated.
- **F3 [major] — REJECTED.** `routines/*.md` exists at the **repo root** (`/home/user/vitana-platform/routines/`: 19 routine files plus `README-mobile-loading.md`). The glob ran under `services/gateway`. Plan §4 now names the exact path and the README exclusion.
- **F4 [major] — ACCEPTED.** The query is defined (plane + 7-day filter, 5k cap, `capped` flag, 60 s cache, one query per plane). The UI separates "no run ledger yet", "no runs in 7 days", "unavailable" and counts. Cards lead with the contract and coverage, so planeless loops do not look broken. Plan §5.2 updated.
- **F5 [minor] — ACCEPTED.** The module only defines the global at load time; `render` is called from the render switch. Stated in §5.4.
- **F6 [minor] — ACCEPTED.** The v1 list is the appendix file `loop-engineering-plan.md` in the same directory, and the catalog test enforces 100/100 mechanically.
- **F7 [minor] — ACCEPTED (verified).** STAGING-VERIFY reads `docs/validation/<VTID>/staging-tests.json` by convention (`STAGING-VERIFY.yml:17`). No workflow change.
- **F8 [minor] — ACCEPTED, with two more files found.** `src/navigation/data/command-hub-screens.json:710` (the voice-navigation entry, guarded by the vtid-04814 test) is swapped to a LOOPS entry. The `regen-screens-catalog.mjs:136,360` label overrides are removed. The legacy `specs/dev_screen_inventory_v1.json` is read by no code and is left untouched. Files list updated.
- **Q1–Q4:** answered by F2, F3, F4 and F6.

## Partner round 2 (v2)
F1–F8 are closed. F3 is closed after the partner re-checked the repo root and confirmed the routine files are there. No new findings.

## Verdict
**CONVERGED** after 2 rounds (standard class, cap 3). No blocker or major is open or disputed.
