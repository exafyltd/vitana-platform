/**
 * Autopilot Controller - VTID-01180
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
// In-Memory State (would be DB in production)
// =============================================================================

// Active autopilot runs (keyed by VTID)
const activeRuns = new Map<string, AutopilotRun>();

// Spec snapshots (keyed by VTID)
const specSnapshots = new Map<string, SpecSnapshot>();

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
// Spec Snapshotting
// =============================================================================

/**
 * Create an immutable spec snapshot for a VTID
 * This MUST be called when a VTID is allocated for autopilot processing
 */
export function createSpecSnapshot(
  vtid: string,
  title: string,
  specContent: string,
  taskDomain?: string,
  targetPaths?: string[]
): SpecSnapshot {
  // Check if snapshot already exists (immutable - no overwrites)
  const existing = specSnapshots.get(vtid);
  if (existing) {
    console.log(`[VTID-01180] Spec snapshot already exists for ${vtid}, returning existing`);
    return existing;
  }

  // Create checksum for integrity verification
  const crypto = require('crypto');
  const checksum = crypto.createHash('sha256').update(specContent).digest('hex');

  const snapshot: SpecSnapshot = {
    id: randomUUID(),
    vtid,
    title,
    spec_content: specContent,
    task_domain: taskDomain,
    target_paths: targetPaths,
    created_at: new Date().toISOString(),
    checksum,
  };

  // Store snapshot (immutable)
  specSnapshots.set(vtid, snapshot);

  console.log(`[VTID-01180] Created spec snapshot for ${vtid} (checksum: ${checksum.slice(0, 8)}...)`);

  // Emit event asynchronously
  emitSpecSnapshot(snapshot).catch(err => {
    console.warn(`[VTID-01180] Failed to emit spec snapshot event: ${err}`);
  });

  return snapshot;
}

/**
 * Get the spec snapshot for a VTID
 * Returns null if no snapshot exists
 */
export function getSpecSnapshot(vtid: string): SpecSnapshot | null {
  return specSnapshots.get(vtid) || null;
}

/**
 * Verify spec snapshot integrity
 */
export function verifySpecIntegrity(vtid: string): boolean {
  const snapshot = specSnapshots.get(vtid);
  if (!snapshot) return false;

  const crypto = require('crypto');
  const currentChecksum = crypto.createHash('sha256').update(snapshot.spec_content).digest('hex');
  return currentChecksum === snapshot.checksum;
}

// =============================================================================
// State Machine
// =============================================================================

/**
 * Valid state transitions
 */
const VALID_TRANSITIONS: Record<AutopilotState, AutopilotState[]> = {
  'allocated': ['in_progress', 'failed'],
  'in_progress': ['building', 'failed'],
  'building': ['pr_created', 'failed'],
  'pr_created': ['reviewing', 'failed'],
  'reviewing': ['validated', 'failed'],
  'validated': ['merged', 'failed'],
  'merged': ['deploying', 'failed'],
  'deploying': ['verifying', 'failed'],
  'verifying': ['completed', 'failed'],
  'completed': [],  // Terminal - no transitions
  'failed': [],     // Terminal - no transitions
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
    console.error(`[VTID-01180] Invalid transition: ${fromState} → ${toState} for ${run.vtid}`);
    return false;
  }

  // Update run state
  run.state = toState;
  run.updated_at = new Date().toISOString();

  if (toState === 'completed' || toState === 'failed') {
    run.completed_at = run.updated_at;
  }

  console.log(`[VTID-01180] ${run.vtid}: ${fromState} → ${toState} (${trigger})`);

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
 */
export async function startAutopilotRun(
  vtid: string,
  title: string,
  specContent: string,
  taskDomain?: string,
  targetPaths?: string[]
): Promise<AutopilotRun> {
  // Check if run already exists
  const existing = activeRuns.get(vtid);
  if (existing && existing.state !== 'completed' && existing.state !== 'failed') {
    console.log(`[VTID-01180] Run already active for ${vtid}, returning existing`);
    return existing;
  }

  // Create spec snapshot first (immutable)
  const snapshot = createSpecSnapshot(vtid, title, specContent, taskDomain, targetPaths);

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

  console.log(`[VTID-01180] Started autopilot run ${run.id} for ${vtid}`);

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
 * This is the MANDATORY trigger when a worker job starts
 */
export async function markInProgress(vtid: string, runId?: string): Promise<boolean> {
  const run = activeRuns.get(vtid);
  if (!run) {
    console.error(`[VTID-01180] No autopilot run found for ${vtid}`);
    return false;
  }

  // Also update vtid_ledger status
  await updateLedgerStatus(vtid, 'in_progress');

  return transitionState(run, 'in_progress', 'worker_dispatch_accepted', { run_id: runId });
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
    console.warn(`[VTID-01180] Cannot update ledger: missing Supabase credentials`);
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
      console.warn(`[VTID-01180] Failed to update ledger status for ${vtid}: ${response.status}`);
    } else {
      console.log(`[VTID-01180] Updated ledger status for ${vtid}: ${status}`);
    }
  } catch (error) {
    console.warn(`[VTID-01180] Error updating ledger status: ${error}`);
  }
}

/**
 * Update vtid_ledger to terminal state
 */
async function updateLedgerTerminal(vtid: string, outcome: 'success' | 'failed'): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn(`[VTID-01180] Cannot update ledger terminal: missing Supabase credentials`);
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
      body: JSON.stringify({
        status: 'completed',
        is_terminal: true,
        terminal_outcome: outcome,
        completed_at: timestamp,
        updated_at: timestamp,
      }),
    });

    if (!response.ok) {
      console.warn(`[VTID-01180] Failed to update ledger terminal for ${vtid}: ${response.status}`);
    } else {
      console.log(`[VTID-01180] Updated ledger to terminal for ${vtid}: ${outcome}`);
    }
  } catch (error) {
    console.warn(`[VTID-01180] Error updating ledger terminal: ${error}`);
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
// Exports
// =============================================================================

export default {
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
