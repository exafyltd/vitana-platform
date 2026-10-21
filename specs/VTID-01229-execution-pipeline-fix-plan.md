# VTID-01229: Autonomous Execution Pipeline - Comprehensive Fix Plan

**VTID:** VTID-01229
**Status:** DRAFT
**Version:** 1.0
**Date:** 2026-02-09
**Predecessor:** VTID-01227 (Analysis), VTID-01227 Disk IO Fix (Merged)
**Type:** Implementation Specification

---

## Executive Summary

Following VTID-01227's analysis and the emergency disk IO fix, this specification documents:
- **Status of all 23 original issues** (Fixed / Still Open / Partially Fixed)
- **10 NEW critical gaps** discovered in end-to-end flow analysis
- **Prioritized fix plan** with implementation details

### Issue Status Summary

| Category | Total | Fixed | Partially Fixed | Still Open |
|----------|-------|-------|-----------------|------------|
| Frontend (F1-F6) | 6 | 2 | 1 | 3 |
| Backend (B1-B7) | 7 | 0 | 2 | 5 |
| CI/CD (C1-C6) | 6 | 2 | 0 | 4 |
| **E2E Gaps (NEW)** | 10 | 0 | 0 | 10 |
| **TOTAL** | 29 | 4 | 3 | 22 |

---

## Part 1: Original Issues Status (VTID-01227)

### Frontend Issues

| ID | Issue | Status | Evidence |
|----|-------|--------|----------|
| **F1** | Duplicate setActiveRole function | **STILL_OPEN** | Lines 101-143 (dead) vs 640-704 (active) |
| **F2** | Stale state in button handlers | **FIXED** | Handlers now refetch via fetchVtidDetail + fetchTasks |
| **F3** | MeState vs state.meContext mismatch | **STILL_OPEN** | Both still used: MeState.me at 133, 5939; state.meContext at 549, 7119 |
| **F4** | Modal frozen in "Approving..." | **FIXED** | All error paths reset executionApprovalLoading (lines 20384, 20390) |
| **F5** | Race condition fetch | **PARTIALLY_FIXED** | Sync logic exists (7888-7895) but no sequential enforcement |
| **F6** | Header function inconsistency | **STILL_OPEN** | withVitanaContextHeaders (~30 usages) vs buildContextHeaders (~11 usages) |

### Backend Issues

| ID | Issue | Status | Evidence |
|----|-------|--------|----------|
| **B1** | Async errors swallowed | **STILL_OPEN** | Line 1311: Returns 200 before async completion; errors only logged |
| **B2** | updateTaskStatus silent failures | **STILL_OPEN** | Lines 820, 1296, 1360, etc: Return values never checked |
| **B3** | Evidence timeout 30 minutes | **PARTIALLY_FIXED** | Now configurable via env vars (lines 218-227) but default still 30min |
| **B4** | Validator doesn't check worker success | **STILL_OPEN** | Lines 880-938: Only checks task/spec exist, not worker evidence |
| **B5** | Deploy verification generic | **STILL_OPEN** | Lines 1020-1082: Only /alive and /health checks, no commit SHA |
| **B6** | No work order pickup tracking | **STILL_OPEN** | Fire-and-forget dispatch (610-646), no acknowledgment |
| **B7** | Deprecated endpoints bypass | **PARTIALLY_FIXED** | Deprecation guard works (52-80) but EMERGENCY-BYPASS header allows override |

### CI/CD Issues

| ID | Issue | Status | Evidence |
|----|-------|--------|----------|
| **C1** | Root Dockerfile DATABASE_URL | **STILL_OPEN** | Line 7: $DATABASE_URL used but never defined |
| **C2** | Environment inconsistency | **STILL_OPEN** | AUTO-DEPLOY: "dev", EXEC-DEPLOY: "dev-sandbox" (line 271) |
| **C3** | Gateway missing secrets | **STILL_OPEN** | EXEC-DEPLOY missing: LOVABLE_JWT_SECRET, GITHUB_TOKEN, DEV_*, PERPLEXITY_API_KEY |
| **C4** | Hardcoded URLs | **STILL_OPEN** | deploy-service.sh lines 157, 266, 141 have hardcoded defaults |
| **C5** | Migration verification | **FIXED** | APPLY-MIGRATIONS.yml verifies core tables (107-150) |
| **C6** | VTID extraction fragility | **FIXED** | VTID-01082-FIX: 3 extraction methods with fallbacks |

---

## Part 2: NEW Critical Gaps in E2E Flow

### Gap Analysis Summary

| ID | Gap | Location | Severity | Impact |
|----|-----|----------|----------|--------|
| **G1** | Dispatch fails silently | autopilot-event-loop.ts:507 | CRITICAL | Tasks hang indefinitely |
| **G2** | Worker claim race condition | RPC claim_vtid_task | HIGH | Duplicate claims possible |
| **G3** | PR creation implicit | Worker completion | HIGH | State=pr_created but no PR |
| **G4** | Validator no timeout | validator-core-service.ts | HIGH | Stuck in reviewing forever |
| **G5** | Merge doesn't verify PR exists | autopilot-event-loop.ts:575 | HIGH | Merge to deleted PR fails |
| **G6** | Deploy no recovery | GitHub Actions | HIGH | Failed deploy stuck forever |
| **G7** | Terminalize no event | vtid-terminalize.ts | MEDIUM | State machine doesn't know |
| **G8** | Worker no timeout | execution-service.ts | CRITICAL | Can hang indefinitely, duplicate execution |
| **G9** | No state reconciliation | All actions | MEDIUM | Events in wrong state accepted |
| **G10** | Dispatch not idempotent | Event loop | MEDIUM | Duplicate work orders on restart |

### Detailed Gap Descriptions

#### G1: Dispatch Fails Silently (CRITICAL)
**Location:** `autopilot-event-loop.ts` lines 507-510

```typescript
catch (error) {
    // Task is still in pending queue - BUT NO ERROR EVENT EMITTED
    return { ok: true, data: { vtid, dispatched: true, route_error: String(error) } };
}
```

**Problem:** If `POST /api/v1/worker/orchestrator/route` fails, no error event is emitted. Task stays in pending queue indefinitely.

**Fix Required:**
- Add retry with exponential backoff (3 attempts max)
- Emit `vtid.dispatch.failed` event after max retries
- Escalation: mark task as `blocked` after repeated failures

---

#### G2: Worker Claim Race Condition (HIGH)
**Location:** RPC `claim_vtid_task()` in Supabase

**Problem:** Multiple workers can poll and attempt to claim the same task. Only one succeeds, but both emit "claimed" events.

**Fix Required:**
- Add client-side retry with backoff after claim failure
- Losing worker should gracefully retry next poll cycle
- Add claim conflict resolution monitoring

---

#### G3: PR Creation Implicit (HIGH)
**Location:** Worker completion → State transition

**Problem:** Worker reports completion, state transitions to `pr_created`, but no actual PR exists. PR creation is delegated to CI/CD which may fail silently.

**Fix Required:**
- Verify PR exists via GitHub API before transitioning to `pr_created`
- If no PR after 5 minutes, trigger explicit `triggerCreatePr()` action
- Add `github.pr.created` event requirement for state transition

---

#### G4: Validator No Timeout (HIGH)
**Location:** `validator-core-service.ts`

**Problem:** If OASIS event fetch hangs or state reconstruction is slow, validator blocks indefinitely in `reviewing` state.

**Fix Required:**
- Add 30-second timeout for full validation
- On timeout: emit `autopilot.validation.timeout` event
- Transition to `failed` state with timeout reason

---

#### G5: Merge Doesn't Verify PR Exists (HIGH)
**Location:** `autopilot-event-loop.ts` lines 575-587

**Problem:** Merge action uses stored `pr_number` but doesn't verify PR still exists on GitHub. PR could have been deleted/closed.

**Fix Required:**
- Before merge: `GET /repos/{owner}/{repo}/pulls/{pr_number}`
- If PR deleted: emit event, transition to `failed`
- Provide clear error message to user

---

#### G6: Deploy No Recovery (HIGH)
**Location:** GitHub Actions deploy workflow

**Problem:** Failed deploy remains in `deploying` state indefinitely. No automatic rollback or timeout.

**Fix Required:**
- Add deploy timeout (10 minutes max)
- On timeout: mark as `failed`
- Consider automatic rollback to previous revision

---

#### G7: Terminalize No Event (MEDIUM)
**Location:** `vtid-terminalize.ts`

**Problem:** Task reaches terminal state, vtid_ledger updated, but no OASIS event emitted. Autopilot state machine doesn't know.

**Fix Required:**
- Emit `vtid.lifecycle.completed` or `vtid.terminalize.success` event
- Include outcome (success|failed|cancelled|timeout)
- State machine respects terminal marker

---

#### G8: Worker No Timeout (CRITICAL)
**Location:** `execution-service.ts`

**Problem:** If Vertex AI API hangs or LLM generation takes >30 minutes, worker stuck. Claim expires (24h) and another worker can claim same task, causing duplicate execution.

**Fix Required:**
- Add 30-minute execution timeout
- On timeout: cancel LLM generation, mark failed, release claim
- Report timeout to OASIS

---

#### G9: No State Reconciliation (MEDIUM)
**Location:** All action handlers

**Problem:** Each action assumes prior state is correct. Events in wrong state are accepted, leading to impossible state machine configurations.

**Fix Required:**
- Validate current state before each action
- Reject events that violate forward-only state transitions
- Emit `state_mismatch` event for debugging

---

#### G10: Dispatch Not Idempotent (MEDIUM)
**Location:** Event loop restart

**Problem:** If autopilot event loop crashes after emitting `execution_approved` but before updating cursor, restart processes same event again, potentially dispatching twice.

**Fix Required:**
- Track (VTID, action) pairs that have been executed
- Check before dispatch: "have we already dispatched this VTID?"
- Skip if already processed

---

## Part 3: Prioritized Fix Plan

### Priority 0 - CRITICAL (Block Production)

| Issue | Fix | Files | Effort |
|-------|-----|-------|--------|
| **G8** | Add 30min worker execution timeout | execution-service.ts | 2h |
| **G1** | Add dispatch retry + failure event | autopilot-event-loop.ts | 3h |
| **B1** | Implement status callback/SSE for async completion | execute.ts | 4h |
| **B2** | Check updateTaskStatus return values | execute.ts (8 locations) | 1h |

### Priority 1 - HIGH (Fix This Week)

| Issue | Fix | Files | Effort |
|-------|-----|-------|--------|
| **F1** | Delete dead setActiveRole (lines 101-143) | app.js | 30m |
| **F3** | Replace MeState.me with state.meContext | app.js (~10 locations) | 1h |
| **F6** | Replace withVitanaContextHeaders with buildContextHeaders | app.js (~30 locations) | 2h |
| **G4** | Add 30s validator timeout | validator-core-service.ts | 2h |
| **G5** | Verify PR exists before merge | autopilot-event-loop.ts | 1h |
| **B4** | Add worker success check to validator | execute.ts | 2h |
| **C2** | Sync environment values | AUTO-DEPLOY.yml, EXEC-DEPLOY.yml | 1h |
| **C3** | Add missing gateway secrets | EXEC-DEPLOY.yml | 30m |

### Priority 2 - MEDIUM (Fix This Sprint)

| Issue | Fix | Files | Effort |
|-------|-----|-------|--------|
| **F5** | Enforce sequential fetch execution | app.js | 1h |
| **G2** | Add claim retry + conflict resolution | worker-runner | 2h |
| **G3** | Verify PR exists before pr_created state | autopilot-event-loop.ts | 2h |
| **G6** | Add deploy timeout + recovery | EXEC-DEPLOY.yml | 3h |
| **G7** | Emit terminalize event | vtid-terminalize.ts | 1h |
| **G9** | Add state validation before actions | autopilot-event-loop.ts | 3h |
| **G10** | Add dispatch idempotency tracking | autopilot-event-loop.ts | 2h |
| **B3** | Change default timeout to 5min | execute.ts | 30m |
| **B5** | Add commit SHA verification to deploy | execute.ts | 3h |
| **B6** | Add work order acknowledgment | execute.ts, worker-orchestrator.ts | 4h |
| **C4** | Remove hardcoded URLs | deploy-service.sh | 1h |

### Priority 3 - LOW (Backlog)

| Issue | Fix | Files | Effort |
|-------|-----|-------|--------|
| **B7** | Remove emergency bypass header | execute.ts | 30m |
| **C1** | Add DATABASE_URL validation to Dockerfile | Dockerfile | 30m |

---

## Part 4: Implementation Phases

### Phase 1: Stop the Bleeding (P0 Issues)
**Goal:** Prevent silent failures and task hangs
**Duration:** 1-2 days

1. Add worker execution timeout (G8)
2. Add dispatch retry with failure events (G1)
3. Check updateTaskStatus return values (B2)
4. Add basic async status endpoint (B1)

### Phase 2: Frontend Consolidation (F1, F3, F6)
**Goal:** Single source of truth for state and headers
**Duration:** 1 day

1. Delete dead setActiveRole function
2. Replace all MeState.me with state.meContext
3. Replace all withVitanaContextHeaders with buildContextHeaders
4. Remove MeState object entirely

### Phase 3: Pipeline Hardening (G4, G5, B4)
**Goal:** Prevent impossible state transitions
**Duration:** 2-3 days

1. Add validator timeout
2. Add PR existence verification before merge
3. Add worker success evidence check to validator
4. Add state validation before all actions

### Phase 4: Recovery & Observability (G6, G7, B5, B6)
**Goal:** Enable recovery from failures
**Duration:** 3-4 days

1. Add deploy timeout and recovery
2. Emit terminalize events
3. Add commit SHA verification
4. Add work order acknowledgment tracking

### Phase 5: CI/CD Cleanup (C2, C3, C4)
**Goal:** Consistent deployment configuration
**Duration:** 1 day

1. Sync environment variables across workflows
2. Add missing gateway secrets
3. Remove hardcoded URLs

---

## Part 5: Verification Checklist

### Frontend Verification
- [ ] Only one `setActiveRole` function exists
- [ ] No references to `MeState.me` in codebase
- [ ] All API calls use `buildContextHeaders`
- [ ] Approve → Validate → Activate works without closing drawer
- [ ] Modal closes properly after activation

### Backend Verification
- [ ] Async execution failures appear in UI within 5 seconds
- [ ] updateTaskStatus failures abort pipeline
- [ ] Evidence timeout is 5 minutes (not 30)
- [ ] Validator fails if worker failed
- [ ] Deploy verifies commit SHA

### E2E Flow Verification
- [ ] Dispatch failure emits event after 3 retries
- [ ] Worker execution times out after 30 minutes
- [ ] Validator times out after 30 seconds
- [ ] Merge verifies PR exists before proceeding
- [ ] Deploy timeout triggers after 10 minutes
- [ ] Terminal state emits completion event

### CI/CD Verification
- [ ] ENVIRONMENT is "dev-sandbox" in all workflows
- [ ] Gateway has all required secrets bound
- [ ] No hardcoded URLs in deploy scripts

---

## Part 6: Acceptance Criteria

A task can be considered "working end-to-end" when:

1. **Activation:** User clicks Activate → API returns 200 → Task status shows "In Progress"
2. **Dispatch:** Work order dispatched within 5 seconds
3. **Worker Claim:** Worker claims task within 30 seconds
4. **Execution:** Worker completes within 30 minutes OR times out with error
5. **PR Created:** PR exists on GitHub, verified via API
6. **CI Passes:** All checks green
7. **Validation:** Validator completes within 30 seconds
8. **Merge:** PR merged to main
9. **Deploy:** Service deployed within 10 minutes
10. **Verification:** Health checks pass
11. **Terminal:** Task marked complete/failed with appropriate OASIS event

**Failure at any step:** Task transitions to `failed` state with clear error message visible in UI.

---

## Related VTIDs

- VTID-01227: Original analysis (predecessor)
- VTID-01049: Me Context State Management
- VTID-01150: Runner → Claude Execution Bridge
- VTID-01170: Deprecation of Parallel Paths
- VTID-01178: Autopilot Event Loop
- VTID-01188: Spec Approval Gate
- VTID-01194: Execution Approval Modal
- VTID-01200: Worker Heartbeat
- VTID-01206: Spec Fetch Enhancement
- VTID-01208: Terminal State Recovery

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-02-09 | Claude Analysis | Initial comprehensive fix plan |
