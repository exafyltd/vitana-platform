# Vitana Test Coverage Plan — Inventory, Build-Out Schedule & Automation

**Status:** BOOTSTRAP-TEST-COVERAGE baseline — created 2026-07-13
**Scope:** `exafyltd/vitana-platform` (backend) + `exafyltd/vitana-v1` (Vitanaland frontend)
**Companion doc:** `vitana-v1/docs/TEST_COVERAGE_PLAN.md` (frontend detail)

This is the canonical file for scheduling the build-out of all missing unit
tests. Each phase below is intended to become one VTID (allocate on pickup,
per governance). Update the checkboxes and the status column as work lands.

---

## 1. Inventory — what exists today

### 1.1 vitana-platform

| Service | Source files | Test files | Runner | Runs in CI? |
|---|---:|---:|---|---|
| `services/gateway` | 925 TS | 454 (437 active, 11 quarantined + ignores) | Jest | **NO** (was: `unit` check is a no-op, gateway CI test step commented out) → **YES via `TEST-SUITE.yml`** |
| `services/vcaop` | 61 | 33 | Jest | Yes (`VCAOP-CICD`, `VCAOP-HEALTH` hourly+daily) |
| `services/agents` | 10 TS + 63 Py | 23 (22 py) | pytest (no npm runner) | No |
| `services/autopilot-worker` | 8 | 5 | Jest | No |
| `services/worker-runner` | 9 | 3 | Jest | No |
| `services/oasis-projector` | 6 | 1 | Jest | No |
| `services/openclaw-bridge` | 34 | 1 | Vitest | No |
| `services/mcp-gateway` | 8 | **0** | — | CI skips ("no test") |
| `services/mcp` | 7 | **0** | — | No |
| `services/vaea` | 12 | **0** | — | No |
| `services/deploy-watcher` | 1 | **0** | — | No |
| `services/validators` | 1 | **0** | — | No |
| `packages/` (llm-router py, vitana_py, agent-heartbeat.ts) | ~5 | **0** | — | No |
| `supabase/functions` (og-match) | 1 | **0** | — | No |

**Gateway internal coverage** (by matching test name): 639 of 925 source
files (~69%) have no matching test. By area:

| Gateway area | Source | With test | Untested |
|---|---:|---:|---:|
| `src/services` | 514 | 172 | 342 |
| `src/routes` | 234 | 54 | 180 |
| `src/orb` | 77 | 46 | 31 |
| `src/types` | 45 | 8 | 37 |
| `src/lib` | 12 | 2 | 10 |
| `src/connectors` | 11 | 1 | 10 |
| `src/middleware` | 6 | **0** | 6 |
| `src/i18n` | 4 | 1 | 3 |
| others (kb, controllers, constants, capabilities, providers, validator-core) | 15 | 2 | 13 |

**Baseline verification (2026-07-13, this branch):** full gateway suite =
**437 suites / 7,492 tests passing in ~76 s** after fixing the Jest ESM
config (see §4). Fast enough to run on every PR.

### 1.2 vitana-v1 (Vitanaland frontend)

Before this branch: **zero unit tests, no test runner installed.**

- 1,358 source files: 278 pages, 712 components (55 dirs), 189 hooks,
  103 lib modules, 16 context providers, 4 stores.
- 74 Supabase edge functions — untested.
- Only automation: ad-hoc Playwright/Node regression scripts
  (`npm run test:orb-stop` etc.), ESLint i18n gates, one scheduled LLM i18n
  audit. No CI job ran unit tests.

This branch bootstraps **Vitest + Testing Library + jsdom**
(`vitest.config.ts`, `src/test/setup.ts`, `npm test`) with 5 seed suites /
26 tests (permissions, tenant display, domain-tenant mapping, money
formatting, message date separators) — all green in ~2 s.

---

## 2. Gap map — the named missing test areas

These are the concrete untested modules behind the features the platform
depends on. Paths are real; use them as the work list.

### 2.1 Gateway (vitana-platform)

**P0 — Multi-tenancy / roles / RBAC** (tenant isolation is a NEVER-rule):
- `src/middleware/require-tenant-admin.ts` (+ all 6 middleware files — 0 tests today)
- `src/routes/tenant-admin/*` (12 files: overview, settings, insights, kpis, invitations, knowledge, audit-log, health-index, community-admin, content-moderation, assistant-config, assistant-speeches)
- `src/routes/admin-tenants.ts`, `src/routes/tenant-specialists.ts`
- `src/services/orb-tools/admin-users-rbac-tools.ts`
- `src/services/intelligence/role-aware-context-pack-shadow.ts`

**P0 — Memory & intelligence stack** (CLAUDE.md §14 core flow):
- `src/services/orb-memory-bridge.ts`, `context-pack-builder.ts`, `retrieval-router.ts`
- `src/services/memory-broker.ts`, `memory-facts-service.ts`, `memory-audit.ts`, `memory-indexer-client.ts`, `memory-source-config.ts`, `intent-memory-hooks.ts`, `session-memory-commit.ts`, `supabase-semantic-memory.ts`
- `src/services/social-memory/` (all 9 files)
- `src/routes/semantic-memory.ts`, `admin-memory-broker.ts`, `memory-governance.ts`
- un-quarantine: `test/memory.test.ts`, `test/cognee-extractor-client.test.ts`, `test/intelligence-stack-e2e.test.ts`

**P0 — Autopilot** (autonomous execution = highest blast radius):
- `src/services/autopilot-controller.ts`, `autopilot-event-loop.ts`, `autopilot-loop-store.ts`, `autopilot-validator.ts`, `autopilot-verification.ts`, `autopilot-prompts-service.ts`, `autopilot-voice-next-actions.ts`
- `src/services/dev-autopilot-outcomes.ts`, `dev-autopilot-self-heal-log.ts`, `dev-autopilot-worker-queue.ts`, `dev-autopilot/context-loader.ts`
- `src/routes/autopilot.ts`, `dev-autopilot.ts`, `autopilot-prompts.ts`, `autopilot-recommendations.ts`
- un-quarantine: `test/routes/admin-autopilot.test.ts`, `test/dev-autopilot-synthesis.test.ts`

**P1 — Vitana Brain & contextual awareness (D-engines)**:
- `src/services/vitana-brain.ts`
- `src/services/d32-situational-awareness-engine.ts`, `d40-life-stage-awareness-engine.ts`, `d44-signal-detection-engine.ts`, `d48-opportunity-surfacing-engine.ts`, `d49-risk-mitigation-engine.ts`, `health-capacity-awareness-engine.ts`
- `src/services/awareness-registry.ts`, `awareness-watchdogs.ts`, `admin-awareness-worker.ts`, `guide/awareness-context.ts`, `guide/awareness-prompt.ts`
- `src/routes/situational-awareness.ts`, `life-stage-awareness.ts`, `awareness-config.ts`

**P1 — Voice / ORB tools**:
- `src/routes/orb-live.ts`, `orb-livekit.ts`
- `src/services/voice-config.ts`, `voice-quota-guard.ts`, `voice-auto-rollback.ts`, `voice-session-analyzer.ts`, `voice-session-classifier.ts`, `voice-message-guard.ts`, `voice-tool-router-candidate.ts`
- `src/services/voice-tools/*`, `voice-lab/*`
- routes: `voice-config.ts`, `voice-feedback.ts`, `voice-improve.ts`, `voice-awareness.ts`, `voice-journey-context.ts`, `voice-tools-catalog.ts`, `voice-wake-timeline.ts`

**P1 — Governance**:
- `src/controllers/governance-controller.ts`, `src/routes/governance-controls.ts`
- remaining quarantined suites: `test/llm-router.test.ts`, `test/services/action-executors.test.ts`, `test/routes/health.test.ts`, `test/routes/wearables-waitlist.test.ts`, `test/routes/admin-notification-categories.test.ts`, `test/services/recommendation-engine/analyzers/codebase-analyzer.test.ts`

### 2.2 Sibling services & packages (vitana-platform)

- `services/mcp-gateway`, `services/mcp` — 0 tests, add Jest + suites
- `services/vaea` — 0 tests
- `services/openclaw-bridge` — 34 source files, 1 test
- `services/worker-runner` / `autopilot-worker` / `oasis-projector` — thin
- `packages/llm-router` (Python), `packages/py/vitana_py`, `packages/agent-heartbeat.ts`
- `services/agents` Python tests: wire pytest into CI

### 2.3 Frontend (vitana-v1) — see companion doc for detail

P0: auth/role/guards (`AuthProvider`, `ProtectedRoute`, `AdminGuard`,
`useRole`, `usePermissions`), tenancy (`useTenant`, `TenantDetector`),
i18n helpers (`i18n-toast`, `locale-format`, `i18n-helpers`). P1: wallet,
messaging, offline queue, ORB/voice client libs, autopilot hooks, health
calculators. P2: edge functions (`_shared/llm-locale.ts` first), stores,
component smoke tests.

---

## 3. Build-out schedule

Each phase ≈ 1–2 weeks of autonomous/assisted work; allocate one VTID per
phase at pickup. Order is by risk: tenancy → memory → autopilot → brain/voice.

| Phase | Repo | Deliverable | Target | Status |
|---|---|---|---|---|
| **0. Enforcement baseline** | both | CI actually runs all existing tests (this branch: `TEST-SUITE.yml` + `UNIT-TESTS.yml`, Jest ESM fix, Vitest bootstrap) | 2026-07-13 | ✅ this PR |
| **1. Un-quarantine sweep** | platform | Fix the 11 quarantined gateway suites (memory, admin-autopilot, action-executors, llm-router, cognee, intelligence-e2e, health, wearables, notification-categories, codebase-analyzer, dev-autopilot-synthesis); remove `testPathIgnorePatterns` entries. Also repair `services/oasis-projector/test/ledger-writer.test.ts`: it had unresolved merge-conflict markers committed on `main` (fixed on this branch), and now that it parses, 27/35 tests fail from drift against the current `LedgerWriter` (mocked `Database.getInstance` path no longer populates the ledger store). It is excluded from the `TEST-SUITE.yml` matrix until green — add it back when fixed. | +1 week | ☐ |
| **2. Tenancy & RBAC (P0)** | platform | Tests for all 6 middleware files, `tenant-admin/*` routes, `admin-tenants`, RBAC orb-tools; assert cross-tenant denial paths | +2 weeks | ☐ |
| **3. Frontend auth/roles/tenancy (P0)** | vitana-v1 | `AuthProvider`, `ProtectedRoute`, `AdminGuard`, `useRole`, `usePermissions`, `useTenant`, `TenantDetector`, guest-auth, oauthErrors | +2 weeks | ☐ |
| **4. Memory stack (P0)** | platform | retrieval-router rule table, context-pack-builder, orb-memory-bridge, memory-facts-service (write_fact semantics), social-memory/*, memory routes | +3 weeks | ☐ |
| **5. Autopilot (P0)** | platform | controller/event-loop/validator/verification/prompts + dev-autopilot queue & self-heal; governance gates (EXECUTION_DISARMED etc.) asserted | +4 weeks | ☐ |
| **6. Vitana Brain + awareness engines (P1)** | platform | vitana-brain, d32/d40/d44/d48/d49, health-capacity, awareness-registry/watchdogs + routes | +5 weeks | ☐ |
| **7. Voice/ORB tools (P1)** | platform | voice-* services, voice-tools/*, orb-live & orb-livekit route contracts | +6 weeks | ☐ |
| **8. Frontend domain logic (P1)** | vitana-v1 | wallet (client, exchangeRates, useWallet*), messaging (messageStatus, caches), offline (OfflineProvider, calendarPendingQueue), i18n helpers, orb client libs, autopilot hooks, health calculators (vitanaIndex, goalTrend, planSummaryCalculator) | +6 weeks | ☐ |
| **9. Sibling services & packages** | platform | mcp-gateway, mcp, vaea, openclaw-bridge, worker-runner depth; pytest in CI for services/agents + packages/llm-router | +7 weeks | ☐ |
| **10. Edge functions** | vitana-v1 | Deno tests for `_shared/llm-locale.ts` + top 10 critical functions (stripe-webhook, ai-chat, autopilot-profile, search-memories, set_active_tenant, vertex-live…) | +8 weeks | ☐ |
| **11. Coverage ratchet** | both | Turn on coverage thresholds (start at measured baseline, ratchet +2%/week); make `TEST-SUITE.yml` / `UNIT-TESTS.yml` required status checks | +8 weeks | ☐ |

**Definition of done per phase:** suites green locally AND in the scheduled
workflow, no new quarantines, coverage for the touched area ≥80% lines,
mocked Supabase only via the existing `test/__mocks__` patterns.

---

## 4. The automation routine (stability guarantee)

### 4.1 What this branch adds

**`.github/workflows/TEST-SUITE.yml` (vitana-platform)** — runs the real
test suites:
- **Triggers:** every PR, every push to `main` touching `services/**`, a
  **nightly cron (03:17 UTC)**, and manual `workflow_dispatch`.
- **Jobs:** matrix over `gateway` (pnpm + Jest, 7,492 tests), `vcaop`,
  `autopilot-worker`, `worker-runner`, `oasis-projector` (npm + Jest),
  `openclaw-bridge` (pnpm + Vitest).
- The nightly run catches breakage that lands outside PR paths
  (dependency drift, main-only pushes, flaky accumulation).

**`.github/workflows/UNIT-TESTS.yml` (vitana-v1)** — same shape for the
frontend: Vitest on every PR/push to `main` + nightly cron + dispatch.

**Jest ESM fix (gateway `jest.config.js`):** `sanitize-html@2.17` pulls in
ESM-only `htmlparser2@12`, which broke any suite importing
`dev-autopilot-html.ts` in a clean environment (nobody noticed — tests
never ran in CI). `transformIgnorePatterns`/`transform` now compile that
dependency chain; full suite verified green.

### 4.2 Deliberately NOT changed (governance)

- `UNIT.yml` (the gutted required check) is left untouched — it was
  neutered on purpose after the 2026-05-08 autopilot audit. Making
  `TEST-SUITE.yml` a **required** branch-protection check is a repo-admin
  decision scheduled in Phase 11, after a burn-in period proves it stable.
- `VCAOP-HEALTH.yml` hourly/daily probes stay as-is.

### 4.3 Escalation rule

If the nightly run fails: treat as a stability incident, not noise. The
failing commit range is `git log --since=<last green>` on `main`. Fix or
revert within one working day; never quarantine without an entry in this
file's schedule table.

---

## 5. Change log

| Date | Change |
|---|---|
| 2026-07-13 | Initial inventory, schedule, TEST-SUITE.yml + UNIT-TESTS.yml routines, Jest ESM fix, frontend Vitest bootstrap (BOOTSTRAP-TEST-COVERAGE) |
