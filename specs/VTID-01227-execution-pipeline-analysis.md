# VTID-01227: Autonomous Execution Pipeline - Full Analysis & Fix Specification

**VTID:** VTID-01227
**Status:** DRAFT
**Version:** 1.0
**Date:** 2026-02-03
**Type:** Analysis & Fix Specification

---

## Executive Summary

The autonomous execution pipeline is broken across **all three layers**: Frontend, Backend, and CI/CD. This analysis documents **23 distinct issues** with severity classifications and proposed fixes.

**Key Finding:** The UI fixes mentioned (approve, validate, activate buttons) are NOT working because:
1. **Duplicate function definitions** in app.js override each other (dead code being maintained)
2. **State captured in closures** at render time becomes stale
3. **MeState vs state.meContext** inconsistency causes null references
4. Backend **async errors are swallowed** - client gets 200 OK before failures occur
5. CI/CD **environment configuration is inconsistent** across deployment scripts

---

## Table of Contents

1. [Frontend Issues (Command Hub)](#1-frontend-issues-command-hub)
2. [Backend Issues (Execution Pipeline)](#2-backend-issues-execution-pipeline)
3. [CI/CD Issues](#3-cicd-issues)
4. [Execution Stage Pattern Explanation](#4-execution-stage-pattern-explanation)
5. [Prioritized Fix List](#5-prioritized-fix-list)
6. [Implementation Plan](#6-implementation-plan)

---

## 1. Frontend Issues (Command Hub)

**File:** `services/gateway/src/frontend/command-hub/app.js`

### Issue F1: DUPLICATE FUNCTION DEFINITIONS (CRITICAL)

**Severity:** CRITICAL
**Impact:** Fixes applied to wrong function have no effect

The file contains **duplicate function definitions** that override each other:

| Function | First Definition (DEAD CODE) | Second Definition (ACTIVE) |
|----------|------------------------------|----------------------------|
| `fetchMeContext()` | Lines 98-132 (uses `MeState`) | Lines 610-666 (uses `state.meContext`) |
| `setActiveRole()` | Lines 140-182 (uses `withVitanaContextHeaders()`) | Lines 675-740 (uses `buildContextHeaders()`) |

**Root Cause:** JavaScript functions can be redeclared. The second declaration silently overrides the first.

**Evidence:**
```javascript
// Line 98: First fetchMeContext - DEAD CODE
async function fetchMeContext() {
    // Uses MeState.me (old state object)
    MeState.loaded = true;
    MeState.me = data.me;
}

// Line 610: Second fetchMeContext - ACTIVE CODE
async function fetchMeContext(silentRefresh) {
    // Uses state.meContext (new state object)
    state.meContext = data.me;
}
```

**Fix Required:**
- Remove lines 98-132 and 140-182 (dead code)
- Consolidate on `state.meContext` pattern only
- Remove `MeState` object entirely

---

### Issue F2: STALE STATE IN BUTTON HANDLERS (CRITICAL)

**Severity:** CRITICAL
**Impact:** Buttons check approval status from render time, not click time

**Location:** Lines 6130-6150 (Activate button)

```javascript
// Line 6133: State captured at RENDER time
var isSpecApproved = taskSpecStatus === 'approved';  // CAPTURED HERE

activateBtn.onclick = async function() {
    // Line 6147: Uses STALE captured value!
    if (!isSpecApproved) {  // This is the OLD value from render time
        showToast('Cannot activate: spec must be approved first', 'warning');
        return;
    }
};
```

**Symptom:** User approves spec, but Activate button still shows "Cannot activate" until drawer is closed and reopened.

**Fix Required:**
```javascript
activateBtn.onclick = async function() {
    // Re-check current state at click time
    var currentSpecStatus = (state.selectedTaskDetail && state.selectedTaskDetail.spec_status)
        ? state.selectedTaskDetail.spec_status
        : (state.selectedTask.spec_status || 'missing');

    if (currentSpecStatus !== 'approved') {
        showToast('Cannot activate: spec must be approved first (current: ' + currentSpecStatus + ')', 'warning');
        return;
    }
    // ... proceed with activation
};
```

---

### Issue F3: MIXED STATE REFERENCES - MeState vs state.meContext (HIGH)

**Severity:** HIGH
**Impact:** `MeState.me` is null when code expects user data

**Location:** Lines 5950-5951 (Approve button)

```javascript
// Uses OLD dead MeState, which is never populated by active code
var userId = MeState.me?.user_id || MeState.me?.email || 'unknown';
var userRole = MeState.me?.active_role || 'operator';
```

**Problem:** The active `fetchMeContext()` (line 610) populates `state.meContext`, not `MeState.me`. So `MeState.me` is always `null`.

**Fix Required:**
```javascript
// Use the correct state object
var userId = state.meContext?.user_id || state.meContext?.email || 'unknown';
var userRole = state.meContext?.active_role || 'operator';
```

---

### Issue F4: EXECUTION APPROVAL MODAL FROZEN STATE (HIGH)

**Severity:** HIGH
**Impact:** Modal shows "Approving..." indefinitely on slow network or error

**Location:** Lines 19795-19843 (renderExecutionApprovalModal)

**Problem:** If API call `/api/v1/vtid/lifecycle/start` takes long or fails with network error, the modal button stays in "Approving..." state.

**Current Code:**
```javascript
confirmBtn.onclick = async function() {
    state.executionApprovalLoading = true;
    renderApp();  // Shows "Approving..."

    try {
        var response = await fetch('/api/v1/vtid/lifecycle/start', ...);
        // ... success handling
    } catch (e) {
        state.executionApprovalLoading = false;
        showToast('Approval failed: Network error', 'error');
        renderApp();  // Re-renders but may not reset button visually
    }
};
```

**Fix Required:**
- Add timeout for the fetch call (e.g., 30 seconds)
- Ensure button text explicitly reset to "Approve & Start Execution" in all error paths
- Add loading spinner instead of just text change

---

### Issue F5: RACE CONDITION IN fetchVtidDetail + fetchTasks (MEDIUM)

**Severity:** MEDIUM
**Impact:** UI may show stale data after approval actions

**Location:** Lines 5963-5964

```javascript
await fetchVtidDetail(vtid);  // Updates state.selectedTaskDetail
await fetchTasks();            // Updates state.tasks but may not sync selectedTask
// No guarantee state is fully consistent before next render
```

**Problem:** After spec approval, `fetchVtidDetail()` updates `state.selectedTaskDetail`, but `fetchTasks()` may overwrite or not properly reconcile `state.selectedTask`.

**Fix Required:**
- After `fetchTasks()`, explicitly reconcile `state.selectedTask` with updated data:
```javascript
await fetchVtidDetail(vtid);
await fetchTasks();
// Reconcile selectedTask with fresh data
if (state.selectedTask) {
    var updatedTask = state.tasks.find(t => t.vtid === vtid);
    if (updatedTask) {
        state.selectedTask = updatedTask;
    }
}
renderApp();
```

---

### Issue F6: withVitanaContextHeaders vs buildContextHeaders (MEDIUM)

**Severity:** MEDIUM
**Impact:** Inconsistent authorization headers in different parts of the app

**Evidence:**
- `withVitanaContextHeaders()` (line 190): Uses `MeState.me` (dead)
- `buildContextHeaders()` (line 579): Uses `state.meContext` (active)

All code should use `buildContextHeaders()`.

---

## 2. Backend Issues (Execution Pipeline)

**File:** `services/gateway/src/routes/execute.ts`

### Issue B1: ASYNC PIPELINE ERRORS SWALLOWED (CRITICAL)

**Severity:** CRITICAL
**Impact:** Client receives 200 OK but execution fails silently

**Location:** Lines 1311-1325

```typescript
// Step 6: Response sent IMMEDIATELY
res.status(200).json({
    ok: true,
    vtid,
    run_id,
    status: "started",
});

// Async execution runs in background - ERRORS SWALLOWED
executeAsyncPipeline(ctx).catch((error) => {
    console.error(`[VTID-01150] ${vtid}: Async pipeline error:`, error);
    // Error only logged, client never notified!
});
```

**Root Cause:** The HTTP response is sent before async execution completes. Any errors in `executeAsyncPipeline()` are only logged to console.

**Impact on UI:** Task appears to start but Worker/Deploy stages fail silently. UI shows "Running" but execution is actually blocked.

**Fix Required:**
Option A: Implement webhook/callback notification for async completion
Option B: Implement polling endpoint for execution status
Option C: Use Server-Sent Events (SSE) or WebSocket for real-time status

---

### Issue B2: updateTaskStatus SILENT FAILURES (CRITICAL)

**Severity:** CRITICAL
**Impact:** Status updates fail but pipeline continues with inconsistent state

**Location:** Lines 364-401

```typescript
async function updateTaskStatus(...): Promise<boolean> {
    try {
        const response = await fetch(...);
        return response.ok;  // Returns false on failure, no details
    } catch (error) {
        console.error("[VTID-01150] Error updating task status:", error);
        return false;  // Silent failure
    }
}

// Callers DON'T check return value:
// Line 820: await updateTaskStatus(...);  // No error handling!
// Line 1360: await updateTaskStatus(...); // No error handling!
```

**Fix Required:**
```typescript
const statusUpdated = await updateTaskStatus(ctx.vtid, "in_progress", ctx.run_id, {...});
if (!statusUpdated) {
    await emitStageEvent(ctx, "failed", "error", "Failed to update task status");
    return { success: false, error: "STATUS_UPDATE_FAILED" };
}
```

---

### Issue B3: EVIDENCE POLLING TIMEOUT TOO LONG (HIGH)

**Severity:** HIGH
**Impact:** Tasks stuck in "in_progress" for 30 minutes before timing out

**Location:** Lines 732-760

```typescript
const DEFAULT_EVIDENCE_TIMEOUT = {
    MAX_WAIT_MS: 1800000,      // 30 MINUTES!
    POLL_INTERVAL_MS: 30000,   // 30 seconds between checks
};
```

**Problem:**
- If external worker never picks up work order, pipeline waits 30 minutes
- No exponential backoff - fixed 30-second intervals
- No early-failure detection

**Fix Required:**
- Reduce timeout to 5-10 minutes
- Implement exponential backoff (5s, 10s, 20s, 40s...)
- Add "work order pickup timeout" (fail if not started within 60 seconds)

---

### Issue B4: VALIDATOR ALWAYS SUCCEEDS (HIGH)

**Severity:** HIGH
**Impact:** Validator passes even when Worker failed

**Location:** Lines 880-938

```typescript
async function executeValidator(ctx: ExecutionContext) {
    // VAL-RULE-001: Task must exist
    // VAL-RULE-002: Spec must exist (MANDATORY)
    // VAL-RULE-003: Task must not be terminal

    // Comment says: "Final validation deferred to CI/CD governance gate"
    // So validator ALWAYS succeeds if basic rules pass!

    return { success: true, validation: { rules_checked: 3, passed: true } };
}
```

**This explains the pattern:** Worker ERROR + Validator SUCCESS
- Worker fails (evidence timeout)
- Validator only checks if task/spec exist (they do)
- Validator succeeds regardless of worker outcome

**Fix Required:**
- Validator should check worker stage completed successfully
- Add rule: VAL-RULE-004: Worker stage must have succeeded

---

### Issue B5: DEPLOY VERIFICATION IS NOT DEPLOYMENT (HIGH)

**Severity:** HIGH
**Impact:** Deploy stage checks health endpoints, not actual deployment

**Location:** Lines 1020-1082

```typescript
async function executeDeployVerification(ctx: ExecutionContext) {
    // Just checks /alive and /api/v1/cicd/health endpoints
    const aliveResponse = await fetch(`${gatewayUrl}/alive`, ...);
    const smokeResponse = await fetch(`${gatewayUrl}/api/v1/cicd/health`, ...);

    // This is NOT checking if the actual code was deployed!
}
```

**Problem:**
- Checks internal endpoints, not deployed changes
- No integration with actual CI/CD deployment status
- Deploy stage can fail due to network timeout even if deployment succeeded

**Fix Required:**
- Integrate with GitHub Actions deployment status API
- Check Cloud Run revision for expected version
- Add commit SHA verification

---

### Issue B6: NO WORK ORDER PICKUP TRACKING (MEDIUM)

**Severity:** MEDIUM
**Impact:** Work orders may go unprocessed forever

**Location:** Lines 606-646

```typescript
// Work order dispatched to OASIS
await emitOasisEvent({
    type: 'vtid.workorder.dispatched',
    // ... work order details
});

// But NO check if any worker actually picked it up!
// If external Claude worker is offline, work order sits forever
```

**Fix Required:**
- Add "work order acknowledged" event requirement
- Add timeout for pickup (fail if not picked up within 60 seconds)
- Add dead letter queue for unprocessed work orders

---

### Issue B7: DEPRECATED ENDPOINTS STILL IN USE (MEDIUM)

**Severity:** MEDIUM
**Impact:** Confusion about canonical execution path

**Location:** Lines 1-80 (Deprecation Notice)

The file has extensive deprecation warnings for VTID-01170, but the endpoints are still functional with `X-BYPASS-ORCHESTRATOR` header. This creates confusion about which path is canonical.

---

## 3. CI/CD Issues

### Issue C1: ROOT DOCKERFILE DATABASE MIGRATION PROBLEM (CRITICAL)

**Severity:** CRITICAL
**Impact:** Root Dockerfile will fail at runtime if used

**File:** `/home/user/vitana-platform/Dockerfile`

```dockerfile
CMD ["sh", "-c", "pnpm prisma migrate deploy && psql $DATABASE_URL -f database/policies/002_oasis_events.sql"]
```

**Problems:**
1. `DATABASE_URL` not defined in the Dockerfile
2. If container runs without secret binding, migrations fail silently
3. This Dockerfile appears unused but could confuse developers

**Fix Required:**
- Either delete the root Dockerfile or add proper secret handling
- Add validation: `if [ -z "$DATABASE_URL" ]; then echo "ERROR: DATABASE_URL required"; exit 1; fi`

---

### Issue C2: ENVIRONMENT VARIABLE INCONSISTENCY (HIGH)

**Severity:** HIGH
**Impact:** Can't deploy to staging/production environments

**Files:**
- `.github/workflows/EXEC-DEPLOY.yml` (line 271)
- `scripts/deploy/deploy-service.sh` (line 85)

**Discrepancy:**

| Workflow | Environment Value |
|----------|-------------------|
| AUTO-DEPLOY.yml | Hard-coded `"dev"` (line 111) |
| EXEC-DEPLOY.yml | Default `"dev"`, overrides to `"dev-sandbox"` for gateway (line 271) |
| deploy-service.sh | Default `"dev-sandbox"` |

**Problem:** No staging or production environment support in CI/CD.

**Fix Required:**
- Standardize on single environment configuration source
- Add explicit staging/production configurations
- Remove hardcoded values

---

### Issue C3: GATEWAY SECRET BINDING INCOMPLETE (HIGH)

**Severity:** HIGH
**Impact:** Gateway deployed via EXEC-DEPLOY missing secrets

**File:** `.github/workflows/EXEC-DEPLOY.yml` (lines 273-280)

**Bound in EXEC-DEPLOY:**
- GOOGLE_GEMINI_API_KEY
- SUPABASE_URL, SUPABASE_SERVICE_ROLE, SUPABASE_JWT_SECRET, SUPABASE_ANON_KEY

**Missing (present in deploy-service.sh but not EXEC-DEPLOY):**
- GITHUB_TOKEN / GH_TOKEN
- DEV_AUTH_SECRET
- DEV_TEST_USER_EMAIL / DEV_TEST_USER_PASSWORD
- DEV_JWT_SECRET
- PERPLEXITY_API_KEY

**Fix Required:**
- Synchronize secret bindings between EXEC-DEPLOY and deploy-service.sh
- Create a single source of truth for required secrets per service

---

### Issue C4: HARDCODED GATEWAY URL (MEDIUM)

**Severity:** MEDIUM
**Impact:** Deployment scripts may fail if URL changes

**File:** `scripts/deploy/deploy-service.sh` (lines 152, 219)

```bash
GATEWAY_URL="${GATEWAY_URL:-https://gateway-q74ibpv6ia-uc.a.run.app}"
```

**Fix Required:**
- Move to environment variable or secret
- Use dynamic Cloud Run URL discovery

---

### Issue C5: MIGRATION VERIFICATION INCOMPLETE (MEDIUM)

**Severity:** MEDIUM
**Impact:** Complex migrations may fail silently

**File:** `.github/workflows/APPLY-MIGRATIONS.yml`

**Current Verification (only checks):**
- `oasis_events_v1` table exists
- `governance_rules` table exists
- `MIGRATION_GOVERNANCE` category exists
- `MG-001` rule exists

**Problem:** 75+ migration files with potentially complex dependencies. Only 4 tables verified.

**Fix Required:**
- Add comprehensive table existence checks
- Add migration version tracking
- Add rollback capability detection

---

### Issue C6: VTID EXTRACTION FRAGILITY (MEDIUM)

**Severity:** MEDIUM
**Impact:** Deployments silently skip if VTID not in commit message

**File:** `.github/workflows/AUTO-DEPLOY.yml` (lines 35-90)

**Problem:** Multiple regex patterns with increasing complexity. If none match, deployment is silently skipped.

**Fix Required:**
- Add PR body parsing as primary method
- Use GitHub API to get full PR description
- Add logging when VTID extraction fails

---

## 4. Execution Stage Pattern Explanation

**Observed Pattern from Screenshot:**
```
PLANNER:   RUNNING
WORKER:    ERROR
VALIDATOR: SUCCESS
DEPLOY:    ERROR
```

**Root Cause Chain:**

1. **PLANNER RUNNING:** Task status shows "in_progress" which appears as "running"

2. **WORKER ERROR:**
   - Work order dispatched but external worker never picked it up
   - Evidence polling timed out after 30 minutes
   - Error: `EVIDENCE_TIMEOUT`
   - Task marked "blocked" but this updates happened AFTER response was sent

3. **VALIDATOR SUCCESS:**
   - Validator only checks if task/spec exist (they do)
   - Does NOT check if worker succeeded
   - Always passes if basic existence rules pass

4. **DEPLOY ERROR:**
   - Could be: Health check endpoints timed out
   - Could be: Actual deploy never happened (worker failed)
   - Could be: Network issues checking `/alive` endpoint

**Why UI Shows Wrong State:**
- Client got 200 OK immediately when execution started
- Async errors happened AFTER response was sent
- No mechanism to push error status back to client
- UI polling (if any) may not be frequent enough

---

## 5. Prioritized Fix List

### P0 - CRITICAL (Fix Immediately)

| ID | Layer | Issue | Impact |
|----|-------|-------|--------|
| F1 | Frontend | Duplicate function definitions | Fixes have no effect |
| F2 | Frontend | Stale state in button handlers | Buttons appear broken |
| F3 | Frontend | MeState vs state.meContext | Null references |
| B1 | Backend | Async errors swallowed | Silent failures |
| B2 | Backend | updateTaskStatus failures | State inconsistency |

### P1 - HIGH (Fix This Week)

| ID | Layer | Issue | Impact |
|----|-------|-------|--------|
| F4 | Frontend | Modal frozen state | Poor UX |
| F5 | Frontend | Race condition in fetch | Stale data |
| B3 | Backend | 30-minute timeout | Long delays |
| B4 | Backend | Validator always succeeds | False positives |
| B5 | Backend | Deploy verification fake | No actual verification |
| C1 | CI/CD | Root Dockerfile broken | Deployment failure |
| C2 | CI/CD | Environment inconsistency | Can't deploy to prod |
| C3 | CI/CD | Missing gateway secrets | Incomplete deployments |

### P2 - MEDIUM (Fix This Sprint)

| ID | Layer | Issue | Impact |
|----|-------|-------|--------|
| F6 | Frontend | Header function inconsistency | Auth issues |
| B6 | Backend | No work order tracking | Lost work orders |
| B7 | Backend | Deprecated endpoints | Confusion |
| C4 | CI/CD | Hardcoded gateway URL | Fragile scripts |
| C5 | CI/CD | Migration verification | Silent failures |
| C6 | CI/CD | VTID extraction | Skipped deploys |

---

## 6. Implementation Plan

### Phase 1: Frontend Fixes (VTID-01227-A)

```yaml
tasks:
  - name: "Remove dead code (duplicate functions)"
    file: "services/gateway/src/frontend/command-hub/app.js"
    action: "Delete lines 98-182, remove MeState object"

  - name: "Fix button handlers to use current state"
    file: "services/gateway/src/frontend/command-hub/app.js"
    action: "Replace captured variables with state lookups at click time"

  - name: "Replace MeState references with state.meContext"
    file: "services/gateway/src/frontend/command-hub/app.js"
    action: "Search/replace all MeState.me with state.meContext"

  - name: "Replace withVitanaContextHeaders with buildContextHeaders"
    file: "services/gateway/src/frontend/command-hub/app.js"
    action: "Search/replace function calls"

  - name: "Add state reconciliation after fetch"
    file: "services/gateway/src/frontend/command-hub/app.js"
    action: "After fetchTasks(), sync selectedTask with updated data"
```

### Phase 2: Backend Fixes (VTID-01227-B)

```yaml
tasks:
  - name: "Implement execution status callback/polling"
    file: "services/gateway/src/routes/execute.ts"
    action: "Add SSE endpoint or webhook for status updates"

  - name: "Add error handling for updateTaskStatus"
    file: "services/gateway/src/routes/execute.ts"
    action: "Check return values and fail explicitly"

  - name: "Reduce evidence timeout to 5 minutes"
    file: "services/gateway/src/routes/execute.ts"
    action: "Update DEFAULT_EVIDENCE_TIMEOUT"

  - name: "Fix validator to check worker success"
    file: "services/gateway/src/routes/execute.ts"
    action: "Add VAL-RULE-004: Worker stage must succeed"

  - name: "Integrate deploy verification with real CI/CD"
    file: "services/gateway/src/routes/execute.ts"
    action: "Check GitHub Actions status, Cloud Run revision"
```

### Phase 3: CI/CD Fixes (VTID-01227-C)

```yaml
tasks:
  - name: "Remove or fix root Dockerfile"
    file: "Dockerfile"
    action: "Add DATABASE_URL validation or delete"

  - name: "Standardize environment configuration"
    files:
      - ".github/workflows/AUTO-DEPLOY.yml"
      - ".github/workflows/EXEC-DEPLOY.yml"
      - "scripts/deploy/deploy-service.sh"
    action: "Create single source of truth for environments"

  - name: "Sync gateway secret bindings"
    file: ".github/workflows/EXEC-DEPLOY.yml"
    action: "Add missing secrets from deploy-service.sh"

  - name: "Remove hardcoded gateway URL"
    file: "scripts/deploy/deploy-service.sh"
    action: "Use environment variable or dynamic discovery"
```

---

## Acceptance Criteria

- [ ] Frontend: Approve → Validate → Activate flow works without closing drawer
- [ ] Frontend: Modal closes properly after successful activation
- [ ] Frontend: No console errors about null MeState
- [ ] Backend: Execution failures are reported to client (not just logged)
- [ ] Backend: Evidence timeout reduced to 5 minutes
- [ ] Backend: Validator fails if worker stage failed
- [ ] CI/CD: Can deploy to dev, staging, production environments
- [ ] CI/CD: All required secrets bound for gateway service
- [ ] E2E: Task can go from Scheduled → In Progress → Completed without manual intervention

---

## Related VTIDs

- VTID-01049: Me Context State Management
- VTID-01150: Runner → Claude Execution Bridge
- VTID-01170: Deprecation of Parallel Paths
- VTID-01188: Spec Approval Gate
- VTID-01194: Execution Approval Modal
- VTID-01209: Real-time Execution Status

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-02-03 | Claude Analysis | Initial analysis |
