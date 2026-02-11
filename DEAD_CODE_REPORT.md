# Dead Code & Orphan Files Report

**Generated:** 2026-02-11
**Scope:** Full vitana-platform monorepo
**Purpose:** Validation report for cleanup — no deletions performed yet

---

## Summary

| Category | Definite Orphans | Review Required | Total Items |
|----------|-----------------|-----------------|-------------|
| Root-level test artifacts | 6 | 0 | 6 |
| Root-level reports/summaries | 2 | 6 | 8 |
| Root-level misc files | 2 | 2 | 4 |
| One-time SQL scripts | 13 | 0 | 13 |
| Legacy Python/AI scripts | 6 (+1 .pyc) | 0 | 7 |
| Phase verification scripts | 5 | 0 | 5 |
| Placeholder directories | 1 dir (22 files) | 2 dirs | 3 |
| CI scripts | 1 | 2 | 3 |
| Unused gateway exports | 15 | 0 | 15 |
| Unused gateway functions | 6 | 0 | 6 |
| Stub/empty service code | 4 | 0 | 4 |
| Duplicate service concern | 0 | 1 | 1 |
| Package stubs | 0 | 3 | 3 |
| **TOTALS** | **~78 items** | **~16 items** | **~94 items** |

---

## TIER 1: Safe to Delete (High Confidence)

### 1.1 Root-Level Test/Debug JSON Artifacts

These are Gemini API test payloads. Not referenced anywhere in code, CI, or docs.

| # | File | Description |
|---|------|-------------|
| 1 | `json_reply.json` | Gemini API response sample (hydration haiku) |
| 2 | `json_reply_1.json` | Duplicate of above |
| 3 | `json_reply_2.json` | Duplicate of above |
| 4 | `json_reply_3.json` | Duplicate of above |
| 5 | `json_request.json` | Gemini API request sample (structured JSON schema) |
| 6 | `resp.json` | Error response from Google AI Platform |

### 1.2 Stale Root-Level Reports

| # | File | Description |
|---|------|-------------|
| 7 | `CI_VERIFICATION_TEST.md` | One-time CI test verification (2025-10-28) |
| 8 | `GITHUB_CLEANUP_REPORT.md` | One-time GitHub cleanup report (2025-11-07) |

### 1.3 Root-Level Miscellaneous

| # | File | Description |
|---|------|-------------|
| 9 | `bench.sh` | One-time load test script, not referenced anywhere |
| 10 | `cloud-run-migrate.json` | Malformed Prisma migration spec (contains typo: `1883DATABASE_URL`) |
| 11 | `governance_seed_vtid_ledger.sql` | One-time governance seed, only referenced in a summary doc |

### 1.4 Legacy Python/AI Agent Scripts

Superseded by Gateway API architecture. Not referenced by any workflow or active code.

| # | File | Description |
|---|------|-------------|
| 12 | `scripts/ai/load_claude_prompt.py` | Legacy AI agent prompt loader |
| 13 | `scripts/ai/run_claude_agent.py` | Legacy agent runner |
| 14 | `scripts/ai/start_agent.sh` | Legacy shell wrapper for agent |
| 15 | `scripts/ai/oasis_cop_register.py` | Legacy OASIS registration (docs say replaced by gateway proxy) |
| 16 | `scripts/ai/upload_to_oasis.py` | Legacy OASIS upload (docs say replaced by gateway proxy) |
| 17 | `scripts/ai/__pycache__/load_claude_prompt.cpython-312.pyc` | Compiled Python bytecode |

### 1.5 One-Time SQL Registration/Seed Scripts

These are one-time task initialization scripts. Already executed; no longer needed.

| # | File | Description |
|---|------|-------------|
| 18 | `scripts/phase_2b_seed.sql` | Phase 2B one-time seed |
| 19 | `scripts/complete-vtid-01065.sql` | One-time VTID completion |
| 20 | `scripts/complete-vtid-01095.sql` | One-time VTID completion |
| 21 | `scripts/seed-real-vtids.sql` | One-time VTID seeding |
| 22 | `scripts/vtid-01063-register.sql` | One-time VTID registration |
| 23 | `scripts/vtid-01066-register.sql` | One-time VTID registration |
| 24 | `scripts/vtid-01079-register.sql` | One-time VTID registration |
| 25 | `scripts/vtid-01080-register.sql` | One-time VTID registration |
| 26 | `scripts/vtid-01164-register.sql` | One-time VTID registration |
| 27 | `scripts/vtid-0542-register.sql` | One-time VTID registration |
| 28 | `scripts/vtid-0601-register.sql` | One-time VTID registration |
| 29 | `scripts/create-vtid-01188-task.sh` | One-time task creation |
| 30 | `scripts/vtid-0542-acceptance-tests.sh` | One-time acceptance tests |

### 1.6 Phase-Specific Verification Scripts

One-time verification utilities for completed phases. Not referenced by CI/CD.

| # | File | Description |
|---|------|-------------|
| 31 | `scripts/verify-phase1.5.sh` | Phase 1.5 verification |
| 32 | `scripts/verify-phase2b-compliance.sh` | Phase 2B verification |
| 33 | `scripts/phase2c-audit-cloud-run.sh` | Phase 2C Cloud Run audit |

### 1.7 Placeholder Directory: `phase_2b/`

Entire directory contains 21 `PLACEHOLDER.md` files + 1 `GLOSSARY_TERMS.md`. Content was intended to migrate to `/tasks/` per ADR-001 but directory was never cleaned up.

| # | File | Description |
|---|------|-------------|
| 34 | `phase_2b/` (entire directory) | 22 placeholder files, no real content |

### 1.8 CI Script (Confirmed Orphan)

| # | File | Description |
|---|------|-------------|
| 35 | `scripts/ci/collect-status.py` | Docs explicitly say: "Remove reference, then delete" — references old URLs |

---

## TIER 2: Review Before Deleting

### 2.1 Historical Execution Summaries

These provide phase history but are not referenced by active code. Consider archiving to a `docs/archive/` folder or deleting.

| # | File | Lines | Description |
|---|------|-------|-------------|
| 1 | `PHASE2-EXECUTION-SUMMARY.md` | 252 | Phase 2 mission status |
| 2 | `PHASE2-PROGRESS.md` | 198 | Phase 2 progress tracking |
| 3 | `PHASE2B-EXECUTION-SUMMARY.md` | 549 | Phase 2B naming governance |
| 4 | `PHASE2C-EXECUTION-SUMMARY.md` | 553 | Phase 2C runtime fabric |
| 5 | `TASK_4B_PHASE2_SUMMARY.md` | 170 | Task 4B Phase 2 deployment |
| 6 | `VTID-DEV-CICDL-0031-SUMMARY.md` | 233 | DevHub SSE Feed deployment |

### 2.2 Historical Deployment Scripts

Referenced only in the summaries above. May serve as reference for future deployments.

| # | File | Description |
|---|------|-------------|
| 7 | `deploy-4b-phase2.sh` | Phase 2 deployment (references `seed-test-event.sql`) |
| 8 | `deploy-devhub-feed.sh` | DevHub SSE Feed deployment |

### 2.3 CI Scripts (Usage Unclear)

| # | File | Description |
|---|------|-------------|
| 9 | `scripts/ci/command-hub-golden-fingerprint.js` | Golden test fingerprint, usage unclear |
| 10 | `scripts/ci/command-hub-ownership-guard.js` | 17KB ownership guard, usage unclear |

### 2.4 Task JSON Files

| # | File | Description |
|---|------|-------------|
| 11 | `oasis_tasks_batch.json` | Batch task definitions, no references found |
| 12 | `dev_commu_0052_task.json` | Command Hub Kanban redeploy task record |
| 13 | `dev_commu_0053_task.json` | Command Hub UX cleanup task record |

### 2.5 Package Stubs

| # | File | Description |
|---|------|-------------|
| 14 | `packages/agent-heartbeat.ts` | Well-documented but no active imports found in services |
| 15 | `packages/llm-router/` | Empty/stub directory |
| 16 | `packages/openapi/` | Empty/stub directory |

### 2.6 Placeholder Directories

| # | File | Description |
|---|------|-------------|
| 17 | `skills/` | Only README, no actual skills |
| 18 | `tasks/` | Only README, no task folders |

---

## TIER 3: Dead Code in Source Files

### 3.1 Gateway Service — Unused Type Exports

**File:** `services/gateway/src/types/operator-command.ts`

Created for VTID-0525-B MVP but the actual implementation uses simpler string matching.

| Line | Export | Status |
|------|--------|--------|
| 18 | `CommandActionSchema` | Never imported |
| 19 | `CommandAction` (type) | Never imported |
| 24 | `ALLOWED_COMMAND_SERVICES` | Never imported (commented out in operator.ts) |
| 25 | `CommandServiceSchema` | Never imported |
| 26 | `CommandService` (type) | Never imported |
| 31 | `CommandEnvironmentSchema` | Never imported |
| 32 | `CommandEnvironment` (type) | Never imported |
| 37 | `DeployCommandSchema` | Never imported |
| 46 | `DeployCommand` (type) | Never imported |
| 51 | `TaskCommandSchema` | Never imported |
| 59 | `TaskCommand` (type) | Never imported |

### 3.2 Gateway Service — Unused Exported Functions

**File:** `services/gateway/src/services/operator-service.ts`

| Line | Function | Status |
|------|----------|--------|
| 37 | `classifyEventType(eventType: string)` | Exported, never called |
| 68 | `isOasisAllowed(eventType: string)` | Exported, never called |
| 1390 | `getTaskInfo(vtid: string)` | Exported, never called |
| 1503 | `emitWorkStarted(params)` | Exported, never called |
| 1539 | `emitWorkCompleted(params)` | Exported, never called |

### 3.3 Gateway Service — Unused Class Method

**File:** `services/gateway/src/services/natural-language-service.ts`

| Line | Method | Status |
|------|--------|--------|
| 60 | `parseCommand(message: string)` | Method exists in `NaturalLanguageService` but never invoked. Only `processMessage()` is used (from `command-hub.ts`) |

### 3.4 Gateway Service — Commented-Out Imports

**File:** `services/gateway/src/routes/operator.ts`

| Line | Import | Status |
|------|--------|--------|
| 65 | `naturalLanguageService` | Commented out — DISABLED FOR MVP (VTID-0525-B) |
| 72 | `ALLOWED_COMMAND_SERVICES` | Commented out in import block |
| 698 | `DeployCommandSchema, TaskCommandSchema` | Commented out |

### 3.5 OASIS-Projector — Stub Methods (Empty Implementations)

**File:** `services/oasis-projector/src/projector.ts`

| Line | Method | Status |
|------|--------|--------|
| 165 | `projectUserCreated()` | TODO: "Implement actual projection logic" — body is logging only |
| 174 | `projectUserUpdated()` | TODO: "Implement actual projection logic" — body is logging only |
| 184 | `projectTransactionCreated()` | TODO: "Implement actual projection logic" — body is logging only |

### 3.6 OASIS-Projector — Unused Constants

**File:** `services/oasis-projector/src/index.ts`

| Line | Constant | Status |
|------|----------|--------|
| 3-5 | `VTID`, `VTID_LEDGER_FIX`, `VT_LAYER`, `VT_MODULE` | Defined but only `VTID_LEDGER_WRITER` used |

### 3.7 Deploy-Watcher — Commented-Out Production Code

**File:** `services/deploy-watcher/src/index.ts`

| Line | Code | Status |
|------|------|--------|
| 44-45 | Google Cloud Logging client | Commented out, replaced by mock returning `[]` |
| 31-47 | `fetchRecentDeploys()` | Always returns empty array (stub) |
| 18-26 | `DeployEvent` interface | Defined but never populated (function returns `[]`) |

### 3.8 Duplicate Service Concern: `mcp/` vs `mcp-gateway/`

Two nearly-identical MCP services exist with minor differences:

| Feature | `services/mcp/gateway/` | `services/mcp-gateway/` |
|---------|------------------------|------------------------|
| `/health` | Yes | Yes |
| `/mcp/health` | Yes | Yes |
| `/mcp/call` | Yes | Yes |
| `/skills/mcp` | **Yes** (hardcoded data) | No |
| `playwright-mcp` connector | No | **Yes** |

**Recommendation:** Consolidate into a single service or clearly document their distinct purposes.

---

## TIER 4: TODOs and Incomplete Implementations

These are not dead code but represent unfinished work that should be tracked.

| File | Line | TODO |
|------|------|------|
| `services/gateway/src/services/autopilot-prompts-service.ts` | 821 | Create relationship edge with pending state |
| `services/gateway/src/services/autopilot-prompts-service.ts` | 828 | Add user to group |
| `services/gateway/src/services/autopilot-prompts-service.ts` | 834 | Create RSVP/attendance record |
| `services/gateway/src/services/autopilot-prompts-service.ts` | 843 | Create interest edge |
| `services/gateway/src/services/context-pack-builder.ts` | 782 | Implement tenant policy retrieval |
| `services/gateway/src/services/intent-detection-engine.ts` | 757 | Could extract from conversation items |
| `services/gateway/src/services/operator-service.ts` | 1151 | Add filter when autopilot.plan.created events implemented |
| `services/gateway/src/services/orb-memory-bridge.ts` | 1399 | Add user_reinforcement_signals when available |
| `services/gateway/src/services/skills/preflight-runner.ts` | 347 | Implement actual OASIS query for duplicate detection |
| `services/gateway/src/routes/governance-controls.ts` | 51 | Restrict to admin roles in production |
| `services/gateway/src/routes/conversation.ts` | 244 | Get from routing policy (hardcoded model) |
| `services/gateway/src/routes/live.ts` | 672 | Extract user_id from JWT token |
| `services/gateway/src/routes/operator.ts` | 83 | Extract from auth headers when authentication implemented |

---

## Recommended Cleanup Order

### Phase 1 — Quick Wins (Tier 1 files, zero risk)
1. Delete 6 root-level JSON test artifacts
2. Delete 2 stale root-level reports
3. Delete `bench.sh`, `cloud-run-migrate.json`, `governance_seed_vtid_ledger.sql`
4. Delete 6 legacy Python/AI scripts + `.pyc`
5. Delete 13 one-time SQL/shell scripts
6. Delete 3 phase verification scripts
7. Delete `phase_2b/` directory (22 placeholder files)
8. Delete `scripts/ci/collect-status.py`

**Files removed: ~56 | Risk: None**

### Phase 2 — Source Code Cleanup (Tier 3, low risk)
1. Remove 11 unused type exports from `operator-command.ts`
2. Remove 5 unused functions from `operator-service.ts`
3. Remove unused `parseCommand()` method from `natural-language-service.ts`
4. Remove 3 commented-out imports from `operator.ts`
5. Remove unused constants from `oasis-projector/src/index.ts`
6. Complete or remove stub methods in `oasis-projector/src/projector.ts`
7. Complete or remove stub `deploy-watcher` service

**Items addressed: ~25 | Risk: Low (unused code paths)**

### Phase 3 — Architectural Review (Tier 2, needs discussion)
1. Decide on historical summaries: archive or delete
2. Decide on `mcp/` vs `mcp-gateway/` consolidation
3. Decide on package stubs (`llm-router`, `openapi`, `agent-heartbeat`)
4. Decide on CI guard scripts
5. Clean up placeholder directories (`skills/`, `tasks/`)

**Items addressed: ~18 | Risk: Requires team input**

---

*This report is for validation only. No files have been modified or deleted.*
