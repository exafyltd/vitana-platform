# Autonomous Execution Pipeline - System Analysis & Fix Recommendations

**Analysis Date:** 2026-01-25
**Triggered By:** VTID-01213 failure (simple color change task rejected with `unknown_error`)
**Purpose:** Identify and fix systemic issues preventing fully autonomous task execution

---

## Executive Summary

The Vitana autonomous execution pipeline has **7 critical gaps** that prevent reliable end-to-end autonomous execution. A simple frontend color change (VTID-01213) failed because of **spec fragmentation** - the system has 3 different spec storage locations with no synchronization, and no automatic mechanism to register specs from git into the database.

---

## Why VTID-01213 Failed

### The Symptom
```
Status: Rejected
Transition: allocated → failed
Error: unknown_error
Stage: Worker dispatch (38s elapsed)
```

### Root Cause Chain
1. Spec file created at `docs/specs/01213-sidebar-operator-color.md` and committed to git
2. **No automatic spec registration** - git files are not detected and synced to database
3. Autopilot loop picked up task, attempted dispatch
4. `enforceSpecRequirement(vtid)` checked for spec in `vtid_specs` table → NOT FOUND
5. Fell back to `oasis_specs` table → NOT FOUND
6. Fell back to `vtid_ledger` description → NOT FOUND (task not in ledger)
7. `markInProgress()` blocked execution → transitioned to `failed`
8. No explicit error code provided → defaulted to `unknown_error`

---

## Critical Pipeline Gaps

### Gap 1: Spec Registration Not Automated (CRITICAL)

**Problem:** No system automatically discovers spec files in git and registers them in the database.

**Current State:**
- Spec files exist in `docs/specs/` directory in git
- Database tables (`vtid_specs`, `oasis_specs`) require explicit INSERT
- No webhook, cron, or trigger syncs git → database

**Impact:** Every task requires manual spec registration, breaking autonomous flow.

**Location:** Missing functionality - needs to be built.

**Recommendation:**
```
Option A: Git Webhook Handler
- Create POST /api/v1/specs/sync endpoint
- GitHub webhook triggers on push to docs/specs/**
- Handler parses spec file, extracts VTID from filename
- UPSERTs to appropriate spec table

Option B: Startup/Periodic Scan
- On gateway startup, scan docs/specs/*.md
- Parse VTID from filename pattern: {VTID}-*.md
- Register any unregistered specs
- Run every N minutes as background job

Option C: Spec CLI Command
- Add `vitana spec register <file>` CLI command
- Validates spec format, extracts metadata
- Registers to database with checksum
```

---

### Gap 2: Spec Storage Fragmentation (CRITICAL)

**Problem:** Three separate spec storage locations with no synchronization or clear priority.

**Current Sources:**
| Table | Purpose | Used By |
|-------|---------|---------|
| `vtid_specs` | Persistent, immutable, checksummed | `enforceSpecRequirement()` |
| `oasis_specs` | 3-step spec creation flow | `fetchSpecFromOasis()` |
| `vtid_ledger` | Task metadata, description field | Fallback in dispatch |

**Fetch Logic (autopilot-event-loop.ts:465-475):**
```typescript
// VTID-01206: Fetch full spec from oasis_specs (where 3-step spec flow stores it)
if (!specContent) {
  const oasisSpec = await fetchSpecFromOasis(vtid);
  if (oasisSpec) {
    specContent = oasisSpec;
  } else if (ledgerData) {
    // Fallback to summary (not ideal but better than nothing)
    specContent = ledgerData.description || ledgerData.summary || '';
    console.log(`Warning: No spec in oasis_specs for ${vtid}, using ledger summary`);
  }
}
```

Note the comment: **"not ideal but better than nothing"** - this is a known issue.

**Impact:**
- Specs can exist in one location but not others
- `enforceSpecRequirement()` checks `vtid_specs` but dispatch fetches from `oasis_specs`
- Race conditions between spec creation flows

**Recommendation:**
```
1. Designate SINGLE source of truth: vtid_specs table
   - All other sources become inputs that sync TO vtid_specs

2. Create spec unification service:
   - syncSpecFromOasis(vtid) → copies oasis_specs → vtid_specs
   - syncSpecFromLedger(vtid) → copies ledger description → vtid_specs
   - syncSpecFromGit(vtid, filepath) → parses file → vtid_specs

3. Update enforceSpecRequirement() to:
   - First check vtid_specs
   - If not found, attempt sync from other sources
   - Only fail if ALL sources empty

4. Add spec_source field to vtid_specs:
   - 'git' | 'oasis' | 'ledger' | 'manual'
   - Tracks provenance for debugging
```

---

### Gap 3: Worker Dispatch Failure Silent (HIGH)

**Problem:** Dispatch to worker-orchestrator can fail but returns `ok: true`.

**Location:** `autopilot-event-loop.ts:499-502`

```typescript
if (!routeResponse.ok || !routeResult.ok) {
  console.error(`Worker orchestrator route failed for ${vtid}: ${routeResult.error}`);
  // Don't fail the dispatch - worker can still claim from pending queue
  return { ok: true, data: { vtid, dispatched: true, route_failed: true, error: routeResult.error } };
}
```

**Impact:**
- Task appears dispatched but worker never receives it
- Relies on worker-runner polling pending queue (may be slow)
- No visibility into dispatch failures in UI
- Task can stall indefinitely

**Recommendation:**
```typescript
// Option A: Fail explicitly, let retry mechanism handle it
if (!routeResponse.ok || !routeResult.ok) {
  return { ok: false, error: routeResult.error };
}

// Option B: Track route_failed state explicitly
if (!routeResponse.ok || !routeResult.ok) {
  await emitOasisEvent({
    vtid,
    type: 'worker.dispatch.route_failed',
    status: 'warning',
    message: `Direct route failed, task in pending queue: ${routeResult.error}`,
  });
  // Set state that triggers pending queue pickup
  await markTaskForPendingPickup(vtid);
  return { ok: true, data: { vtid, dispatched: false, pending_pickup: true } };
}

// Option C: Implement retry with backoff
if (!routeResponse.ok || !routeResult.ok) {
  const retryCount = await getDispatchRetryCount(vtid);
  if (retryCount < MAX_DISPATCH_RETRIES) {
    await scheduleDispatchRetry(vtid, retryCount + 1);
    return { ok: true, data: { vtid, dispatched: false, retry_scheduled: true } };
  }
  return { ok: false, error: `Dispatch failed after ${MAX_DISPATCH_RETRIES} retries` };
}
```

---

### Gap 4: Spec Enforcement Too Late (HIGH)

**Problem:** Spec existence is only enforced at `markInProgress()`, after allocation and dispatch attempt.

**Current Flow:**
```
Task Allocated → Dispatch Attempted → markInProgress() → SPEC CHECK (too late!)
```

**Impact:**
- Resources wasted on dispatch attempts for specless tasks
- Error occurs deep in pipeline, confusing error messages
- Worker may already be spinning up when check fails

**Location:** `autopilot-controller.ts:568-607`

**Recommendation:**
```typescript
// Move spec check to BEFORE dispatch attempt
// In triggerDispatch() - autopilot-event-loop.ts:440

async function triggerDispatch(vtid: string, event: OasisEvent) {
  // EARLY ENFORCEMENT - Check spec BEFORE any dispatch work
  const specEnforcement = await enforceSpecRequirement(vtid);
  if (!specEnforcement.allowed) {
    console.error(`[SPEC_GATE] Blocking dispatch for specless VTID: ${vtid}`);
    await markFailed(vtid, specEnforcement.error, 'SPEC_NOT_FOUND');
    return { ok: false, error: specEnforcement.error };
  }

  // Now proceed with dispatch...
}
```

---

### Gap 5: No Spec Schema Validation (MEDIUM)

**Problem:** Any string accepted as `spec_text` - no validation of format or required fields.

**Impact:**
- Malformed specs pass through to workers
- Workers may fail unpredictably on invalid specs
- No early warning for spec quality issues

**Recommendation:**
```typescript
// Define spec schema
interface SpecSchema {
  // Required sections
  summary: string;          // Min 10 chars
  problem_statement: string;
  acceptance_criteria: string[];

  // Optional but validated
  technical_approach?: string;
  test_plan?: string;
  dependencies?: string[];
}

// Add validation function
function validateSpecFormat(specText: string): ValidationResult {
  const sections = parseSpecSections(specText);
  const errors: string[] = [];

  if (!sections.summary || sections.summary.length < 10) {
    errors.push('Summary required (min 10 chars)');
  }
  if (!sections.acceptance_criteria?.length) {
    errors.push('At least one acceptance criterion required');
  }

  return { valid: errors.length === 0, errors };
}

// Enforce in spec registration
async function registerSpec(vtid: string, specText: string) {
  const validation = validateSpecFormat(specText);
  if (!validation.valid) {
    throw new SpecValidationError(validation.errors);
  }
  // ... proceed with registration
}
```

---

### Gap 6: Unknown Error Code Masking (MEDIUM)

**Problem:** When `markFailed()` is called without an explicit error code, it defaults to `unknown_error`, hiding the real cause.

**Location:** `autopilot-controller.ts:757`

```typescript
trigger: errorCode || 'unknown_error',
```

**Impact:**
- Debugging difficult - "unknown_error" provides no information
- Operators cannot identify failure patterns
- No ability to auto-retry specific error types

**Recommendation:**
```typescript
// Option A: Make errorCode required
export async function markFailed(
  vtid: string,
  error: string,
  errorCode: string  // Required, not optional
): Promise<boolean>

// Option B: Infer error code from error message
function inferErrorCode(error: string): string {
  if (error.includes('spec')) return 'SPEC_ERROR';
  if (error.includes('worker')) return 'WORKER_ERROR';
  if (error.includes('timeout')) return 'TIMEOUT_ERROR';
  if (error.includes('network')) return 'NETWORK_ERROR';
  return 'UNCLASSIFIED_ERROR';  // Better than 'unknown'
}

// Option C: Add stack trace / context to error payload
export async function markFailed(
  vtid: string,
  error: string,
  errorCode?: string,
  context?: { stack?: string; source?: string; metadata?: Record<string, unknown> }
): Promise<boolean>
```

---

### Gap 7: Missing Task-to-Spec Linkage at Creation (MEDIUM)

**Problem:** When a task is created (e.g., via task intake), there's no guaranteed linkage to ensure the spec is registered before the autopilot loop picks it up.

**Current Flow:**
```
User creates task → VTID allocated → Task scheduled →
Autopilot picks up → Spec not found → FAIL
```

**Expected Flow:**
```
User creates task → Spec created → Spec registered →
VTID allocated → Task scheduled → Autopilot picks up →
Spec found → SUCCESS
```

**Recommendation:**
```typescript
// In task-intake-service.ts - completeIntakeAndSchedule()

async function completeIntakeAndSchedule() {
  // 1. Create spec content from user input
  const specContent = buildSpecFromIntake(state.spec_text, state.header);

  // 2. Allocate VTID
  const { vtid } = await allocateVtid('task-intake', 'DEV', 'COMHU');

  // 3. CRITICAL: Register spec BEFORE scheduling
  const specResult = await registerSpec(vtid, specContent, {
    source: 'task-intake',
    locked: true,  // Immediately lock for execution
  });

  if (!specResult.ok) {
    throw new Error(`Failed to register spec for ${vtid}: ${specResult.error}`);
  }

  // 4. NOW schedule the task (spec is guaranteed to exist)
  await ensureScheduledDevTask(vtid, state.header, specContent);

  // 5. Emit event
  await emit('commandhub.task.scheduled', { vtid, spec_registered: true });
}
```

---

## Implementation Priority

| Priority | Gap | Effort | Impact |
|----------|-----|--------|--------|
| P0 | Gap 2: Spec Fragmentation | High | Fixes root cause of most failures |
| P0 | Gap 1: Auto-Registration | Medium | Enables true autonomous flow |
| P1 | Gap 4: Early Spec Check | Low | Faster failure, clearer errors |
| P1 | Gap 7: Task-Spec Linkage | Medium | Prevents orphaned tasks |
| P2 | Gap 3: Silent Dispatch | Low | Better observability |
| P2 | Gap 6: Unknown Error | Low | Better debugging |
| P3 | Gap 5: Schema Validation | Medium | Quality improvement |

---

## Immediate Actions for VTID-01213

To unblock the specific task (and verify the fix works):

1. **Manual spec registration:**
```sql
INSERT INTO vtid_specs (vtid, spec_text, checksum, locked_at, created_at)
VALUES (
  'VTID-01213',
  '<content of docs/specs/01213-sidebar-operator-color.md>',
  '<sha256 hash>',
  NOW(),
  NOW()
);
```

2. **Reset task state:**
```sql
UPDATE autopilot_runs
SET state = 'allocated', error = NULL, error_code = NULL
WHERE vtid = 'VTID-01213';
```

3. **Re-emit execution event:**
```typescript
await emitOasisEvent({
  vtid: 'VTID-01213',
  type: 'vtid.lifecycle.execution_approved',
  source: 'manual-retry',
  status: 'pending',
});
```

---

## Long-Term Architecture Recommendation

```
┌─────────────────────────────────────────────────────────────────┐
│                     SPEC MANAGEMENT LAYER                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │  Git Specs   │  │ Task Intake  │  │  Manual UI   │           │
│  │  (webhook)   │  │   (3-step)   │  │   Entry      │           │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │
│         │                 │                 │                    │
│         └────────────────┼─────────────────┘                    │
│                          ▼                                       │
│              ┌───────────────────────┐                          │
│              │   SPEC UNIFICATION    │                          │
│              │      SERVICE          │                          │
│              │  - Validates format   │                          │
│              │  - Generates checksum │                          │
│              │  - Tracks source      │                          │
│              └───────────┬───────────┘                          │
│                          ▼                                       │
│              ┌───────────────────────┐                          │
│              │    vtid_specs         │  ← SINGLE SOURCE OF TRUTH│
│              │  (immutable, locked)  │                          │
│              └───────────────────────┘                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   EXECUTION PIPELINE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐       │
│  │ ALLOCATE│───▶│ DISPATCH│───▶│ EXECUTE │───▶│ VERIFY  │       │
│  └────┬────┘    └────┬────┘    └─────────┘    └─────────┘       │
│       │              │                                           │
│       │              │                                           │
│       ▼              ▼                                           │
│  ┌─────────────────────────┐                                    │
│  │   SPEC GATE (EARLY)     │ ← Check spec EXISTS before work    │
│  │   enforceSpecRequirement│                                    │
│  └─────────────────────────┘                                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `services/gateway/src/services/autopilot-event-loop.ts` | Move spec check earlier, improve dispatch error handling |
| `services/gateway/src/services/autopilot-controller.ts` | Make errorCode required in markFailed() |
| `services/gateway/src/services/vtid-spec-service.ts` | Add spec unification, auto-registration |
| `services/gateway/src/services/task-intake-service.ts` | Ensure spec registered before task scheduled |
| `services/gateway/src/api/specs/` | New: Spec sync webhook endpoint |

---

## Conclusion

The VTID-01213 failure exposed a fundamental architectural gap: **specs exist in multiple disconnected locations with no automatic synchronization**. The simplest task cannot execute autonomously because the pipeline assumes specs are manually registered in the database.

Fixing this requires:
1. Unifying spec storage to a single source of truth
2. Adding automatic spec registration from git
3. Moving spec validation earlier in the pipeline
4. Improving error reporting when specs are missing

Once these changes are implemented, any task with a spec file in git will automatically flow through the autonomous execution pipeline without manual intervention.
