/**
 * Autopilot Controller - VTID-01178
 *
 * Central orchestration layer that ties all steps together into an autonomous
 * VTID lifecycle pipeline. This is the "brain" that advances VTIDs through
 * the complete workflow:
 *
 *   ALLOCATED → IN_PROGRESS → BUILDING → PR_CREATED → REVIEWING →
 *   MERGED → DEPLOYING → VERIFYING → COMPLETED (or FAILED)
 *
 * Key responsibilities:
 * 1. Poll for newly allocated VTIDs and advance their state
 * 2. Ensure spec snapshots are immutable (no drifting UI text)
 * 3. Enforce validator hard gates before merge
 * 4. Coordinate verification after deploy
 * 5. Mark terminal completion with proper ledger + event
 *
 * Design:
 * - Event-driven where possible, with poll fallback
 * - Idempotent state transitions
 * - Full OASIS traceability
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  createVtidSpec,
  getVtidSpec,
  vtidSpecExists,
  verifySpecChecksum,
  enforceSpecRequirement,
  toLegacySnapshot,
  type VtidSpec,
  type VtidSpecContent,
} from './vtid-spec-service';

// =============================================================================
// Types
// =============================================================================

/**
 * Autopilot pipeline states (strict state machine)
 */
export type AutopilotState =
  | 'allocated'       // VTID allocated, not yet started
  | 'in_progress'     // Work dispatched to worker
  | 'building'        // Worker actively building
  | 'pr_created'      // PR created, awaiting CI
  | 'reviewing'       // CI passed, awaiting validator + code review
  | 'validated'       // Validator passed, ready for merge
  | 'merged'          // PR merged to main
  | 'deploying'       // Deploy workflow triggered
  | 'verifying'       // Post-deploy verification running
  | 'completed'       // Terminal success
  | 'failed';         // Terminal failure

/**
 * Autopilot run record - tracks a single VTID through the pipeline
 */
export interface AutopilotRun {
  id: string;               // UUID for this run
  vtid: string;             // VTID being processed
  state: AutopilotState;    // Current state
  started_at: string;       // ISO timestamp when run started
  updated_at: string;       // ISO timestamp of last state change
  completed_at?: string;    // ISO timestamp when terminal state reached

  // Spec snapshot (immutable after allocation)
  spec_snapshot?: SpecSnapshot;

  // Pipeline artifacts
  pr_number?: number;
  pr_url?: string;
  merge_sha?: string;
  deploy_workflow_url?: string;

  // Validation results
  validator_result?: ValidatorResult;
  verification_result?: VerificationResult;

  // Error tracking
  error?: string;
  error_code?: string;
  retry_count: number;
  max_retries: number;
}

/**
 * Spec snapshot - immutable copy of the task spec
 * All agents reference this snapshot, not the UI text which may drift
 */
export interface SpecSnapshot {
  id: string;               // Snapshot UUID
  vtid: string;             // Associated VTID
  title: string;            // Task title at snapshot time
  spec_content: string;     // Full spec text
  task_domain?: string;     // Detected/assigned domain
  target_paths?: string[];  // Target file paths
  created_at: string;       // When snapshot was taken
  checksum: string;         // SHA256 of spec_content for integrity
}

/**
 * Validator result - from code review + governance validation
 */
export interface ValidatorResult {
  passed: boolean;
  code_review_passed: boolean;
  governance_passed: boolean;
  security_scan_passed: boolean;
  issues: ValidatorIssue[];
  validated_at: string;
}

export interface ValidatorIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  file?: string;
  line?: number;
}

/**
 * Verification result - post-deploy checks
 */
export interface VerificationResult {
  passed: boolean;
  health_check_passed: boolean;
  acceptance_assertions_passed: boolean;
  csp_check_passed: boolean;
  issues: string[];
  verified_at: string;
}

/**
 * State transition event payload
 */
interface StateTransition {
  vtid: string;
  run_id: string;
  from_state: AutopilotState;
  to_state: AutopilotState;
  trigger: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// In-Memory State
// =============================================================================

// Active autopilot runs (keyed by VTID)
// Note: Run state is persisted in autopilot_run_state table for crash recovery
const activeRuns = new Map<string, AutopilotRun>();

// VTID-01190: Spec snapshots are now persisted in vtid_specs table
// The in-memory map is REMOVED - all spec access goes through vtid-spec-service

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  pollIntervalMs: 30000,      // Poll every 30 seconds
  maxRetries: 3,              // Max retries before failing
  ciTimeoutMs: 300000,        // 5 min CI timeout
  deployTimeoutMs: 180000,    // 3 min deploy timeout
  verifyTimeoutMs: 60000,     // 1 min verification timeout
};

// =============================================================================
// OASIS Event Helpers
// =============================================================================

/**
 * Emit autopilot state transition event
 */
async function emitStateTransition(transition: StateTransition): Promise<void> {
  await emitOasisEvent({
    vtid: transition.vtid,
    type: `autopilot.state.${transition.to_state}` as any,
    source: 'autopilot-controller',
    status: transition.to_state === 'failed' ? 'error' :
            transition.to_state === 'completed' ? 'success' : 'info',
    message: `Autopilot: ${transition.from_state} → ${transition.to_state} (${transition.trigger})`,
    payload: {
      run_id: transition.run_id,
      from_state: transition.from_state,
      to_state: transition.to_state,
      trigger: transition.trigger,
      ...transition.metadata,
      transitioned_at: new Date().toISOString(),
    },
  });
}

/**
 * Emit spec snapshot created event
 */
async function emitSpecSnapshot(snapshot: SpecSnapshot): Promise<void> {
  await emitOasisEvent({
    vtid: snapshot.vtid,
    type: 'autopilot.spec.snapshot_created' as any,
    source: 'autopilot-controller',
    status: 'info',
    message: `Spec snapshot created for ${snapshot.vtid}`,
    payload: {
      snapshot_id: snapshot.id,
      vtid: snapshot.vtid,
      title: snapshot.title,
      spec_length: snapshot.spec_content.length,
      checksum: snapshot.checksum,
      task_domain: snapshot.task_domain,
      created_at: snapshot.created_at,
    },
  });
}

/**
 * Emit validator result event
 */
async function emitValidatorResult(
  vtid: string,
  runId: string,
  result: ValidatorResult
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: result.passed ? 'autopilot.validator.passed' as any : 'autopilot.validator.failed' as any,
    source: 'autopilot-controller',
    status: result.passed ? 'success' : 'warning',
    message: result.passed
      ? `Validator passed for ${vtid}`
      : `Validator blocked merge for ${vtid}: ${result.issues.length} issue(s)`,
    payload: {
      run_id: runId,
      passed: result.passed,
      code_review_passed: result.code_review_passed,
      governance_passed: result.governance_passed,
      security_scan_passed: result.security_scan_passed,
      issue_count: result.issues.length,
      issues: result.issues,
      validated_at: result.validated_at,
    },
  });
}

/**
 * Emit verification result event
 */
async function emitVerificationResult(
  vtid: string,
  runId: string,
  result: VerificationResult
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: result.passed ? 'autopilot.verification.passed' as any : 'autopilot.verification.failed' as any,
    source: 'autopilot-controller',
    status: result.passed ? 'success' : 'error',
    message: result.passed
      ? `Verification passed for ${vtid}`
      : `Verification failed for ${vtid}: ${result.issues.join(', ')}`,
    payload: {
      run_id: runId,
      passed: result.passed,
      health_check_passed: result.health_check_passed,
      acceptance_assertions_passed: result.acceptance_assertions_passed,
      csp_check_passed: result.csp_check_passed,
      issues: result.issues,
      verified_at: result.verified_at,
    },
  });
}

// =============================================================================
// Spec Snapshotting (VTID-01190: Now DB-backed via vtid-spec-service)
// =============================================================================

/**
 * Create an immutable spec snapshot for a VTID
 *
 * VTID-01190: This now persists to vtid_specs table instead of memory.
 * The spec is locked immediately upon creation - no edits allowed.
 *
 * This MUST be called when a VTID is allocated for autopilot processing.
 */
export async function createSpecSnapshot(
  vtid: string,
  title: string,
  specContent: string,
  taskDomain?: string,
  targetPaths?: string[],
  options?: {
    layer?: string;
    module?: string;
    executionMode?: string;
    creativity?: string;
    dependsOn?: string[];
    systemSurface?: string[];
  }
): Promise<SpecSnapshot> {
  // VTID-01196 FIX: Always bypass cache for spec creation to avoid stale entries
  // Check if spec already exists in DB (immutable - no overwrites)
  const existingSpec = await getVtidSpec(vtid, { verifyChecksum: true, bypassCache: true });
  if (existingSpec) {
    // VTID-01196 FIX: Validate the existing spec belongs to the correct VTID
    if (existingSpec.vtid !== vtid) {
      console.error(`[VTID-01196-FIX] CRITICAL: createSpecSnapshot - spec VTID mismatch! requested=${vtid}, found=${existingSpec.vtid}`);
      // Continue to create a new spec for the correct VTID
    } else {
      console.log(`[VTID-01190] Spec already exists in DB for ${vtid}, returning existing`);
      return toLegacySnapshot(existingSpec);
    }
  }

  // Determine primary domain
  const primaryDomain = taskDomain || 'unknown';

  // Create spec in database
  const result = await createVtidSpec({
    vtid,
    title,
    spec_text: specContent,
    task_domain: taskDomain,
    target_paths: targetPaths,
    primary_domain: primaryDomain,
    system_surface: options?.systemSurface || [],
    layer: options?.layer,
    module: options?.module,
    execution_mode: options?.executionMode,
    creativity: options?.creativity,
    depends_on: options?.dependsOn,
    created_by: 'autopilot-controller',
  });

  if (!result.ok || !result.spec) {
    // Fallback: create a local snapshot object for compatibility
    // This should not happen in production, but prevents hard failures during migration
    console.error(`[VTID-01190] Failed to create DB spec for ${vtid}: ${result.error}`);
    const crypto = require('crypto');
    const checksum = crypto.createHash('sha256').update(specContent).digest('hex');
    return {
      id: randomUUID(),
      vtid,
      title,
      spec_content: specContent,
      task_domain: taskDomain,
      target_paths: targetPaths,
      created_at: new Date().toISOString(),
      checksum,
    };
  }

  console.log(`[VTID-01190] Created persistent spec for ${vtid} (checksum: ${result.spec.spec_checksum.slice(0, 8)}...)`);

  return toLegacySnapshot(result.spec);
}

/**
 * Get the spec snapshot for a VTID
 *
 * VTID-01190: This now reads from vtid_specs table with checksum verification.
 * Returns null if no snapshot exists or checksum verification fails.
 */
export async function getSpecSnapshot(vtid: string): Promise<SpecSnapshot | null> {
  const spec = await getVtidSpec(vtid, { verifyChecksum: true });
  if (!spec) {
    return null;
  }
  return toLegacySnapshot(spec);
}

/**
 * Verify spec snapshot integrity
 *
 * VTID-01190: This now uses DB-level checksum verification.
 */
export async function verifySpecIntegrity(vtid: string): Promise<boolean> {
  const result = await verifySpecChecksum(vtid);
  return result.valid;
}

// =============================================================================
// State Machine
// =============================================================================

/**
 * Valid state transitions
 * VTID-01208: Added recovery transition from failed → completed for terminalization success
 */
const VALID_TRANSITIONS: Record<AutopilotState, AutopilotState[]> = {
  'allocated': ['in_progress', 'failed', 'completed'],
  'in_progress': ['building', 'failed', 'completed'],
  'building': ['pr_created', 'failed', 'completed'],
  'pr_created': ['reviewing', 'failed', 'completed'],
  'reviewing': ['validated', 'failed', 'completed'],
  'validated': ['merged', 'failed', 'completed'],
  'merged': ['deploying', 'failed', 'completed'],
  'deploying': ['verifying', 'failed', 'completed'],
  'verifying': ['completed', 'failed'],
  'completed': [],  // Terminal - no transitions
  'failed': ['completed'],  // VTID-01208: Allow recovery to completed on terminalization success
};

/**
 * Check if a state transition is valid
 */
function isValidTransition(from: AutopilotState, to: AutopilotState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Transition a run to a new state
 */
async function transitionState(
  run: AutopilotRun,
  toState: AutopilotState,
  trigger: string,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  const fromState = run.state;

  // Validate transition
  if (!isValidTransition(fromState, toState)) {
    console.error(`[VTID-01178] Invalid transition: ${fromState} → ${toState} for ${run.vtid}`);
    return false;
  }

  // Update run state
  run.state = toState;
  run.updated_at = new Date().toISOString();

  if (toState === 'completed' || toState === 'failed') {
    run.completed_at = run.updated_at;
  }

  console.log(`[VTID-01178] ${run.vtid}: ${fromState} → ${toState} (${trigger})`);

  // Emit state transition event
  await emitStateTransition({
    vtid: run.vtid,
    run_id: run.id,
    from_state: fromState,
    to_state: toState,
    trigger,
    metadata,
  });

  return true;
}

// =============================================================================
// Run Management
// =============================================================================

/**
 * Start a new autopilot run for a VTID
 *
 * VTID-01190: This now enforces spec requirement before execution.
 * A VTID cannot enter in_progress without a persisted, verified spec.
 */
export async function startAutopilotRun(
  vtid: string,
  title: string,
  specContent: string,
  taskDomain?: string,
  targetPaths?: string[],
  options?: {
    layer?: string;
    module?: string;
    executionMode?: string;
    creativity?: string;
    dependsOn?: string[];
    systemSurface?: string[];
  }
): Promise<AutopilotRun> {
  // Check if run already exists
  const existing = activeRuns.get(vtid);
  if (existing && existing.state !== 'completed' && existing.state !== 'failed') {
    console.log(`[VTID-01190] Run already active for ${vtid}, returning existing`);

    // VTID-01190: Verify spec still exists and is valid
    const specCheck = await enforceSpecRequirement(vtid);
    if (!specCheck.allowed) {
      console.error(`[VTID-01190] SPEC ENFORCEMENT FAILED for active run ${vtid}: ${specCheck.error}`);
      // Mark the run as failed if spec is invalid
      await markFailed(vtid, specCheck.error || 'Spec enforcement failed', specCheck.error_code);
      throw new Error(`[VTID-01190] SPEC REQUIRED: ${specCheck.error}`);
    }

    return existing;
  }

  // VTID-01190: Create spec snapshot first (immutable, DB-backed)
  const snapshot = await createSpecSnapshot(vtid, title, specContent, taskDomain, targetPaths, options);

  // VTID-01190: HARD ENFORCEMENT - Verify spec was persisted
  const specEnforcement = await enforceSpecRequirement(vtid);
  if (!specEnforcement.allowed) {
    console.error(`[VTID-01190] SPEC ENFORCEMENT FAILED for ${vtid}: ${specEnforcement.error}`);
    throw new Error(`[VTID-01190] SPEC REQUIRED: ${specEnforcement.error}`);
  }

  // Create new run
  const run: AutopilotRun = {
    id: randomUUID(),
    vtid,
    state: 'allocated',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    spec_snapshot: snapshot,
    retry_count: 0,
    max_retries: CONFIG.maxRetries,
  };

  activeRuns.set(vtid, run);

  console.log(`[VTID-01190] Started autopilot run ${run.id} for ${vtid} (spec verified)`);

  // Emit run started event
  await emitOasisEvent({
    vtid,
    type: 'autopilot.run.started' as any,
    source: 'autopilot-controller',
    status: 'info',
    message: `Autopilot run started for ${vtid}`,
    payload: {
      run_id: run.id,
      vtid,
      title,
      task_domain: taskDomain,
      spec_checksum: snapshot.checksum,
      spec_verified: true, // VTID-01190: Indicates spec was verified
      started_at: run.started_at,
    },
  });

  return run;
}

/**
 * Get an active autopilot run
 */
export function getAutopilotRun(vtid: string): AutopilotRun | null {
  return activeRuns.get(vtid) || null;
}

/**
 * Get all active (non-terminal) runs
 */
export function getActiveRuns(): AutopilotRun[] {
  return Array.from(activeRuns.values()).filter(
    run => run.state !== 'completed' && run.state !== 'failed'
  );
}

// =============================================================================
// State Handlers (called by pipeline stages)
// =============================================================================

/**
 * Mark a VTID as in_progress (called when worker dispatch is accepted)
 *
 * VTID-01190: This is the CRITICAL enforcement point. A specless VTID
 * CANNOT enter in_progress state. This enforces the hard governance rule:
 * "No VTID may execute without a persisted spec."
 */
export async function markInProgress(vtid: string, runId?: string): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) {
    console.error(`[VTID-01190] No autopilot run found for ${vtid}`);
    return false;
  }

  // VTID-01190: HARD ENFORCEMENT - Verify spec exists and is valid before execution
  const specEnforcement = await enforceSpecRequirement(vtid);
  if (!specEnforcement.allowed) {
    console.error(`[VTID-01190] EXECUTION BLOCKED - Specless VTID cannot enter in_progress: ${vtid}`);
    console.error(`[VTID-01190] Enforcement failure: ${specEnforcement.error}`);

    // Emit governance event for blocked execution
    await emitOasisEvent({
      vtid,
      type: 'governance.spec.execution_blocked' as any,
      source: 'autopilot-controller',
      status: 'error',
      message: `VTID ${vtid} blocked from execution: ${specEnforcement.error}`,
      payload: {
        vtid,
        run_id: run.id,
        error: specEnforcement.error,
        error_code: specEnforcement.error_code,
        blocked_at: new Date().toISOString(),
      },
    });

    return false;
  }

  // Also update vtid_ledger status
  await updateLedgerStatus(vtid, 'in_progress');

  return transitionState(run, 'in_progress', 'worker_dispatch_accepted', {
    run_id: runId,
    spec_checksum: specEnforcement.spec?.spec_checksum, // Include checksum in transition metadata
  });
}

/**
 * Mark a VTID as building (called when worker starts actual work)
 */
export async function markBuilding(vtid: string): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) return false;
  return transitionState(run, 'building', 'worker_started_building');
}

/**
 * Mark PR created
 */
export async function markPrCreated(
  vtid: string,
  prNumber: number,
  prUrl: string
): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) return false;

  run.pr_number = prNumber;
  run.pr_url = prUrl;

  return transitionState(run, 'pr_created', 'pr_created', { pr_number: prNumber, pr_url: prUrl });
}

/**
 * Mark as reviewing (CI passed, awaiting validator)
 */
export async function markReviewing(vtid: string): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) return false;
  return transitionState(run, 'reviewing', 'ci_passed');
}

/**
 * Mark as validated (validator passed, ready for merge)
 * MUST record the validator result
 */
export async function markValidated(
  vtid: string,
  result: ValidatorResult
): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) return false;

  run.validator_result = result;

  // Emit validator result event
  await emitValidatorResult(vtid, run.id, result);

  return transitionState(run, 'validated', 'validator_passed', {
    code_review_passed: result.code_review_passed,
    governance_passed: result.governance_passed,
    security_scan_passed: result.security_scan_passed,
  });
}

/**
 * Mark as merged
 */
export async function markMerged(vtid: string, sha: string): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) return false;

  run.merge_sha = sha;

  return transitionState(run, 'merged', 'merge_executed', { merge_sha: sha });
}

/**
 * Mark as deploying
 */
export async function markDeploying(vtid: string, workflowUrl?: string): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) return false;

  run.deploy_workflow_url = workflowUrl;

  return transitionState(run, 'deploying', 'deploy_triggered', { workflow_url: workflowUrl });
}

/**
 * Mark as verifying
 */
export async function markVerifying(vtid: string): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) return false;
  return transitionState(run, 'verifying', 'deploy_success');
}

/**
 * Mark as completed (terminal success)
 * This updates the vtid_ledger and emits terminal event
 */
export async function markCompleted(
  vtid: string,
  verificationResult?: VerificationResult
): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) return false;

  if (verificationResult) {
    run.verification_result = verificationResult;
    await emitVerificationResult(vtid, run.id, verificationResult);
  }

  // Update ledger to terminal state
  await updateLedgerTerminal(vtid, 'success');

  return transitionState(run, 'completed', 'verification_passed', {
    verification_passed: verificationResult?.passed ?? true,
  });
}

/**
 * Mark as failed (terminal failure)
 */
export async function markFailed(
  vtid: string,
  error: string,
  errorCode?: string
): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) {
    // Create a minimal run record for tracking
    const failedRun: AutopilotRun = {
      id: randomUUID(),
      vtid,
      state: 'failed',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      error,
      error_code: errorCode,
      retry_count: 0,
      max_retries: CONFIG.maxRetries,
    };
    activeRuns.set(vtid, failedRun);

    // Update ledger to terminal state
    await updateLedgerTerminal(vtid, 'failed');

    await emitStateTransition({
      vtid,
      run_id: failedRun.id,
      from_state: 'allocated',
      to_state: 'failed',
      trigger: errorCode || 'unknown_error',
      metadata: { error },
    });

    return true;
  }

  run.error = error;
  run.error_code = errorCode;

  // Update ledger to terminal state
  await updateLedgerTerminal(vtid, 'failed');

  return transitionState(run, 'failed', errorCode || 'error', { error });
}

// =============================================================================
// Ledger Integration
// =============================================================================

/**
 * Update vtid_ledger status
 */
async function updateLedgerStatus(vtid: string, status: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn(`[VTID-01178] Cannot update ledger: missing Supabase credentials`);
    return;
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        status,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      console.warn(`[VTID-01178] Failed to update ledger status for ${vtid}: ${response.status}`);
    } else {
      console.log(`[VTID-01178] Updated ledger status for ${vtid}: ${status}`);
    }
  } catch (error) {
    console.warn(`[VTID-01178] Error updating ledger status: ${error}`);
  }
}

/**
 * Update vtid_ledger to terminal state
 */
async function updateLedgerTerminal(vtid: string, outcome: 'success' | 'failed'): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn(`[VTID-01178] Cannot update ledger terminal: missing Supabase credentials`);
    return;
  }

  const timestamp = new Date().toISOString();

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      // VTID-01206: Use 'rejected' for failed tasks (shows red), 'completed' for success (shows green)
      body: JSON.stringify({
        status: outcome === 'success' ? 'completed' : 'rejected',
        is_terminal: true,
        terminal_outcome: outcome,
        completed_at: timestamp,
        updated_at: timestamp,
      }),
    });

    if (!response.ok) {
      console.warn(`[VTID-01178] Failed to update ledger terminal for ${vtid}: ${response.status}`);
    } else {
      console.log(`[VTID-01178] Updated ledger to terminal for ${vtid}: ${outcome}`);
    }
  } catch (error) {
    console.warn(`[VTID-01178] Error updating ledger terminal: ${error}`);
  }
}

// =============================================================================
// Validator Hard Gate
// =============================================================================

/**
 * Check if a VTID has passed validator (hard gate for merge)
 * Merge endpoint MUST call this and refuse if not passed
 */
export function hasValidatorPass(vtid: string): boolean {
  const run = activeRuns.get(vtid);
  if (!run) return false;

  // Must have validator result recorded AND passed
  return run.validator_result?.passed === true;
}

/**
 * Get validator result for a VTID
 */
export function getValidatorResult(vtid: string): ValidatorResult | null {
  const run = activeRuns.get(vtid);
  return run?.validator_result || null;
}

// =============================================================================
// Controller Status
// =============================================================================

/**
 * Get autopilot controller status (for health checks)
 */
export function getAutopilotStatus(): {
  active_runs: number;
  completed_runs: number;
  failed_runs: number;
  runs_by_state: Record<AutopilotState, number>;
} {
  const runs = Array.from(activeRuns.values());

  const runsByState: Record<AutopilotState, number> = {
    allocated: 0,
    in_progress: 0,
    building: 0,
    pr_created: 0,
    reviewing: 0,
    validated: 0,
    merged: 0,
    deploying: 0,
    verifying: 0,
    completed: 0,
    failed: 0,
  };

  for (const run of runs) {
    runsByState[run.state]++;
  }

  return {
    active_runs: runs.filter(r => r.state !== 'completed' && r.state !== 'failed').length,
    completed_runs: runsByState.completed,
    failed_runs: runsByState.failed,
    runs_by_state: runsByState,
  };
}

// =============================================================================
// VTID-01178: Initialization - Ensure VTID exists in ledger
// =============================================================================

/**
 * Ensure a VTID exists in the ledger. Used at startup to register
 * feature VTIDs that were used in code but not formally allocated.
 *
 * This is idempotent - if the VTID already exists, it does nothing.
 */
async function ensureVtidExists(
  vtid: string,
  title: string,
  layer: string = 'DEV',
  module: string = 'AUTO'
): Promise<boolean> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn(`[VTID-01178] Cannot ensure VTID exists: missing Supabase credentials`);
    return false;
  }

  try {
    // First check if VTID already exists
    const checkResponse = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}&select=vtid`, {
      method: 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    if (checkResponse.ok) {
      const existing = await checkResponse.json();
      if (Array.isArray(existing) && existing.length > 0) {
        console.log(`[VTID-01178] VTID ${vtid} already exists in ledger`);
        return true;
      }
    }

    // VTID doesn't exist, create it
    console.log(`[VTID-01178] Creating VTID ${vtid} in ledger...`);
    const timestamp = new Date().toISOString();

    const insertResponse = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        vtid,
        title,
        layer,
        module,
        status: 'deployed',
        summary: title,
        created_at: timestamp,
        updated_at: timestamp,
      }),
    });

    if (insertResponse.ok || insertResponse.status === 201) {
      console.log(`[VTID-01178] Successfully created VTID ${vtid} in ledger`);
      return true;
    } else {
      const errorText = await insertResponse.text();
      console.warn(`[VTID-01178] Failed to create VTID ${vtid}: ${insertResponse.status} - ${errorText}`);
      return false;
    }
  } catch (error) {
    console.warn(`[VTID-01178] Error ensuring VTID exists: ${error}`);
    return false;
  }
}

/**
 * Initialize autopilot controller - called at startup
 * Ensures required VTIDs exist in the ledger
 */
export async function initializeAutopilotController(): Promise<void> {
  console.log(`[VTID-01178] Initializing autopilot controller...`);

  // Ensure VTID-01178 exists (Autopilot Controller implementation)
  await ensureVtidExists(
    'VTID-01178',
    'Autopilot Controller - End-to-end VTID lifecycle automation',
    'DEV',
    'AUTOP'
  );

  console.log(`[VTID-01178] Autopilot controller initialization complete`);
}

// =============================================================================
// Exports
// =============================================================================

export default {
  // Initialization
  initializeAutopilotController,

  // Run management
  startAutopilotRun,
  getAutopilotRun,
  getActiveRuns,

  // Spec snapshots
  createSpecSnapshot,
  getSpecSnapshot,
  verifySpecIntegrity,

  // State transitions
  markInProgress,
  markBuilding,
  markPrCreated,
  markReviewing,
  markValidated,
  markMerged,
  markDeploying,
  markVerifying,
  markCompleted,
  markFailed,

  // Validator gate
  hasValidatorPass,
  getValidatorResult,

  // Status
  getAutopilotStatus,
};
