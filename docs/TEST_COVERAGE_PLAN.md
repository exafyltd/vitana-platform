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
- ~~remaining quarantined suites~~ — all un-quarantined and green as of Phase 1 (2026-07-22)

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
| **1. Un-quarantine sweep** | platform | DONE 2026-07-22: all 11 quarantined gateway suites repaired (45 failing tests fixed — drifted mocks/assertions vs tenant-scoped autopilot tables, memory-broker refactor, Bedrock provider, VTID-01007 format, auth-middleware migration; `wearables-waitlist` had broken import paths and never ran). One genuine src bug found & fixed: `classifyCategory()` in `routes/memory.ts` matched the substring `'pr'`, misclassifying any content containing "pr" ("prefer", "espresso") as dev tasks — now word-boundary matched. `testPathIgnorePatterns` quarantine list removed. `oasis-projector/test/ledger-writer.test.ts` repaired (35/35 green; fixture VTIDs updated to canonical VTID-01007 format) and oasis-projector added to the `TEST-SUITE.yml` matrix. Open observation for the team (documented in that test): an all-error batch emits no `ledger_sync` event and still advances the projection offset (no retry) — by design or not? | 2026-07-22 | ✅ |
| **2. Tenancy & RBAC (P0)** | platform | DONE 2026-07-22: 24 new suites / 381 tests. All 6 middleware files (89 tests — cross-tenant denial, fail-closed on missing secrets, exafy bypass, paywall fail-open contract, CORS spoof-blocking, VTID gate, server-timing); all 13 `tenant-admin/*` routes (185 tests, every route with cross-tenant read AND mutation denial asserted through the real `requireTenantAdmin`); `admin-tenants`, `tenant-specialists`, RBAC orb-tools (two-step confirm, operator-only escalation, community-floor protection), `role-aware-context-pack-shadow`, plus `nova-ws-facade` (last untested Nova Sonic file). **Follow-ups surfaced (not fixed — need team decisions):** (a) `oasis_events`-backed endpoints lack DB-level tenant filtering — `overview.ts` `/alerts` returns all tenants' error events, `/activity` filters only client-side, `audit-log.ts` `/access` unfiltered (schema has no tenant_id on oasis_events); (b) `community-admin`/`content-moderation` mutate by bare id without tenant scoping past the middleware; (c) `require-tenant-admin.ts` reads `SUPABASE_SERVICE_ROLE_KEY` while docs/other code use `SUPABASE_SERVICE_ROLE` — envs setting only the latter silently 403 legitimate tenant admins; (d) `tenant-specialists.ts` auth decodes JWT without signature verification (documented VTID-02661 loosening; hardening pending). | 2026-07-22 | ✅ |
| **3. Frontend auth/roles/tenancy (P0)** | vitana-v1 | `AuthProvider`, `ProtectedRoute`, `AdminGuard`, `useRole`, `usePermissions`, `useTenant`, `TenantDetector`, guest-auth, oauthErrors | +2 weeks | ☐ |
| **4. Memory stack (P0)** | platform | DONE 2026-07-28: 22 new suites / 625 tests across all 23 files in the memory & intelligence stack (retrieval-router, context-pack-builder, orb-memory-bridge, memory-broker/facts/audit/session-commit, memory-indexer-client/source-config/intent-hooks/supabase-semantic-memory, all 9 social-memory/* files bar the type-only one, semantic-memory/admin-memory-broker/memory-governance routes). Every suite that reads or writes tenant/user-scoped data asserts explicit cross-tenant/cross-user isolation. **Two genuine src bugs found and fixed** (both minimal, both verified against the full suite): (1) `retrieval-router.ts` — `MIN_LIMITS`/`MAX_LIMITS` had no `calendar` entry, so the clamp loop silently produced `NaN`, corrupting the documented "calendar limit is always 20" contract (dead-but-wrong — no current consumer reads it yet); (2) `social-memory-prompts.ts` — the `person_activity` trigger regex required a word boundary immediately after the truncated stems `activit`/`aktivit`, which real phrasing never satisfies (`activity`, `aktivität` always continue the word), so that classification branch could never fire; fixed by consuming the rest of the word before the boundary check. One more bug flagged, not fixed (deprecated/low-impact file): `memory-indexer-client.ts` leaks a 5s abort timer on network failure (`clearTimeout` only on the success path). | 2026-07-28 | ✅ |
| **5. Autopilot (P0)** | platform | controller/event-loop/validator/verification/prompts + dev-autopilot queue & self-heal; governance gates (EXECUTION_DISARMED etc.) asserted | +4 weeks | ☐ |
| **6. Vitana Brain + awareness engines (P1)** | platform | vitana-brain, d32/d40/d44/d48/d49, health-capacity, awareness-registry/watchdogs + routes | +5 weeks | ☐ |
| **7. Voice/ORB tools (P1) — Nova-first** | platform | voice-* services, voice-tools/*, orb-live & orb-livekit route contracts. **AWS note (2026-07-22):** the Nova Sonic (AWS Bedrock) voice stack in `src/orb/live/upstream/` already has green suites for 13/15 files (`nova-sonic-live-client`, `-protocol`, `-config`, `-keepwarm`, `nova-instruction-sanitizer`, `active-provider-resolver`, `upstream-provider-selector`, …); `nova-ws-facade.ts` gets a test in Phase 2. Write all new voice tests against the provider-adapter boundary, prioritizing the Nova path; when Vertex is retired, delete `vertex-live-client(.test).ts` and update the `llm-router` vertex-flagship assertion — nothing else in the suite is Vertex-bound. | +6 weeks | ☐ |
| **8. Frontend domain logic (P1)** | vitana-v1 | wallet (client, exchangeRates, useWallet*), messaging (messageStatus, caches), offline (OfflineProvider, calendarPendingQueue), i18n helpers, orb client libs, autopilot hooks, health calculators (vitanaIndex, goalTrend, planSummaryCalculator) | +6 weeks | ☐ |
| **9. Sibling services & packages** | platform | mcp-gateway, mcp, vaea, openclaw-bridge, worker-runner depth; pytest in CI for services/agents + packages/llm-router | +7 weeks | ☐ |
| **10. Edge functions** | vitana-v1 | Deno tests for `_shared/llm-locale.ts` + top 10 critical functions (stripe-webhook, ai-chat, autopilot-profile, search-memories, set_active_tenant, vertex-live…) | +8 weeks | ☐ |
| **11. Coverage ratchet** | both | Turn on coverage thresholds (start at measured baseline, ratchet +2%/week); make `TEST-SUITE.yml` / `UNIT-TESTS.yml` required status checks | +8 weeks | ☐ |

**Definition of done per phase:** suites green locally AND in the scheduled
workflow, no new quarantines, coverage for the touched area ≥80% lines,
mocked Supabase only via the existing `test/__mocks__` patterns.

---

## 3b. Infrastructure-migration note (GCP → AWS, 2026-07-22)

The test system in this plan is deliberately **cloud-agnostic**: suites run
on GitHub Actions runners and mock all I/O, so the GCP→AWS migration does
not invalidate any of it. Specifically:
- Bedrock text-LLM adapter (VTID-03403, `eu-central-1`) is asserted in
  `test/llm-router.test.ts`.
- The Nova Sonic voice stack (Vertex/Gemini Live replacement for ORB) is
  already in-tree and 13/15 files are already covered (see Phase 7 note).
- Only two Vertex-bound test artifacts exist; both are trivial to retire
  with the provider (Phase 7 note).
- Out of scope for this plan but flagged: the deploy workflows
  (`EXEC-DEPLOY` etc.) and CLAUDE.md's ALWAYS-rules still declare GCP
  canonical — those need their own migration pass when AWS is confirmed
  as the target.

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
| 2026-07-28 | Phase 3 complete: 22 new memory/intelligence suites (625 tests) covering the full stack (retrieval router, context pack builder, memory bridge, broker/facts/audit/session-commit, indexer/config/hooks/semantic-memory, all of social-memory, memory routes); tenant/user isolation asserted throughout; 2 src bugs fixed (retrieval-router calendar-limit NaN, social-memory-prompts person_activity regex), 1 flagged (memory-indexer-client timer leak) (BOOTSTRAP-TEST-COVERAGE Phase 3) |
| 2026-07-22 | Phase 2 complete: 24 new tenancy/RBAC suites (381 tests) — middleware, all tenant-admin routes with cross-tenant denial, admin-tenants, tenant-specialists, RBAC orb-tools, role-aware shadow, nova-ws-facade; four tenant-isolation/config follow-ups surfaced for team decision (BOOTSTRAP-TEST-COVERAGE Phase 2) |
| 2026-07-22 | Phase 1 complete: all 11 quarantined gateway suites + oasis-projector ledger-writer repaired and un-quarantined; `'pr'` substring memory-classification bug fixed in `routes/memory.ts`; oasis-projector added to TEST-SUITE matrix (BOOTSTRAP-TEST-COVERAGE Phase 1) |
| 2026-07-13 | Initial inventory, schedule, TEST-SUITE.yml + UNIT-TESTS.yml routines, Jest ESM fix, frontend Vitest bootstrap (BOOTSTRAP-TEST-COVERAGE) |
