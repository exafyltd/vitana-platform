# VTID-05084 — Loop Engineering Phase 1: 14 loops, one shared engine, every check owned

Owner approval 2026-10-12 ("yes, approved" at Gate 1 on plan v2). Sparring: `plan-sparring.md` (standard, 2 rounds, CONVERGED). Doctrine: `docs/autonomy/LOOP-ENGINEERING.md`.

Problem: the owner asked for a Top 100 self-improvement loops screen in Command Hub → Autonomy. Comparing a first draft against Testing & QA, Routines and Health Checks showed that most "loops" were single checks that already exist, and that several checks are duplicated (two identical Health Checks tabs, ORB health in 4 places, scheduled jobs listed in 4 places). On the owner's direction ("simplification is the goal") the 100 were compressed into 14 loops on one shared engine, with a rule that every check is owned by exactly one loop.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: GET /api/v1/autonomy/loops (new, `routes/autonomy-loops.ts`), mounted in services/gateway/src/index.ts under /api/v1/autonomy next to the pulse and trace routers.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/command-hub/autonomy/loops/

OASIS_PROOF: none. The change is read-only and emits no events; it reads `agent_runs_unified` only.

CURL_PROOF: `GET /api/v1/autonomy/loops` without a token → 401 JSON (staging-tests.json); with an exafy_admin token the body has `data.catalog.loops` (14), `data.coverage`, `data.signals`, `data.totals` (route test).

## Acceptance criteria

AC-1: The catalog holds 14 loops (6 platform, 8 product); every loop carries the full contract (trigger, goal, act, verifier, stop, human gate, budget, metrics), a risk and an autonomy level.
  TEST: services/gateway/test/loop-catalog.test.ts
AC-2: R2/R3 loops always have a human gate; R3 loops never exceed L2; the loops that write health, product or creator text use the shared claim verifier; the health loop also uses the red-flag rules; the guard loop only escalates.
  TEST: services/gateway/test/loop-catalog.test.ts
AC-3: All 100 v1 cases are folded in exactly once (loops plus shared verifiers), each with its v1 title.
  TEST: services/gateway/test/loop-catalog.test.ts
AC-4: Coverage rule — every Service Health group, routine (`routines/*.md`), scheduled workflow and test contract is owned by exactly one loop or is a retire candidate; no name in the catalog is dangling.
  TEST: services/gateway/test/loop-catalog.test.ts
AC-5: Every `existing_ref` resolves to a real file, directory, workflow, routine or table in this repo.
  TEST: services/gateway/test/loop-catalog.test.ts
AC-6: `GET /api/v1/autonomy/loops` answers 401 without a token, 403 for a non-admin, 200 with catalog, coverage, signals and totals for an exafy_admin; GET only; it reads `agent_runs_unified` and writes nothing.
  TEST: services/gateway/test/routes/autonomy-loops.test.ts
  CURL: GET /api/v1/autonomy/loops → 401 application/json on staging (staging-tests.json)
AC-7: The plane signal counts 7 days of runs per status, marks a capped window, caches 60 s, and degrades to `unavailable` on a view error without failing the catalog; an invalid catalog throws loudly.
  TEST: services/gateway/test/loop-catalog.test.ts
AC-8: Command Hub → Autonomy → Loops replaces the "Autopilot — Admin (Coming soon)" placeholder (tab count stays 6); the old path redirects; the placeholder render function is removed; the voice-navigation entry is swapped to "Autonomy Loops".
  TEST: services/gateway/test/command-hub/vtid-05084-loops-screen.test.ts
  TEST: services/gateway/test/navigation/vtid-04814-command-hub-navigation.test.ts
AC-9: The screen shows the three layers, KPIs, 14 keyboard-reachable loop cards in two groups, a detail panel per loop (contract, owned sensors linking to Testing & QA / Routines, folded cases), the shared engine, and the Simplification panel (coverage + 10 overlaps); errors show a Retry.
  TEST: services/gateway/test/command-hub/vtid-05084-loops-screen.test.ts
  UI: https://preview-aws-gateway.vitanaland.com/command-hub/autonomy/loops/
AC-10: CSP: the module sets text only through textContent, has no inline handlers, innerHTML or eval; it loads before app.js (modules.json kind "module") with ?v= on its script and stylesheet; the stylesheet is RTL-safe.
  TEST: services/gateway/test/command-hub/vtid-05084-loops-screen.test.ts

## Decisions taken
- **L12 Engagement is L2, not L3.** The approved plan gave it "no gate for cadence changes within bounds", which contradicts the plan's own invariant (R2 ⇒ human gate). The catalog test caught it. The more conservative option was taken: a human approves every cadence change until the per-loop kill switch and budget exist (roadmap Phase 3).
- **No `loop-catalog-external-refs.json`.** No loop's `existing_ref` points into vitana-v1, so the allowlist would have been empty. The test instead asserts that every ref is in this repo.
- **Coverage at runtime vs in CI.** The gateway image ships `specs/` but not `routines/` or `.github/`. The API checks the two registries compiled into the gateway (health groups, test contracts) live; routines and scheduled workflows are enforced by the CI test against the repo.
- **Coverage is per Service Health group** (18 groups), not per check (117), as the plan states. L5 Guard owns "Governance & Integrity"; its other inputs (the Google-fallback and Anthropic-credit checks) sit in the "AI & Assistant" group owned by L1.
- **`app.js` and `styles.css` move to `?v=20261116-vtid-05084` together** (repo convention, VTID-04137). The four tests and the staging suites that pinned the previous version follow the bump (VTID-04696 rule). `styles.css` content is unchanged.
- **Voice-navigation vectors were regenerated** with the documented `test/nav-golden/build-embeddings.ts` (Bedrock Titan embeddings, read-only model call): 6 new texts for "Autonomy Loops", the 6 placeholder texts dropped.
- **The legacy `specs/dev_screen_inventory_v1.json`** (underscore), which no code reads, is left untouched.
