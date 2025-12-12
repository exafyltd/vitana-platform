/**
 * Validator-Core Service - VTID-0535
 *
 * Deterministic Validator-Core Engine v1 for the Autopilot execution pipeline.
 * Runs strict validation rules against plan + worker state from OASIS events.
 * NO LLM calls - purely rule-based validation.
 *
 * Validation Rules:
 *   - VAL-RULE-001: Plan exists and is non-empty
 *   - VAL-RULE-002: Worker steps cover the plan (all steps have terminal status)
 *   - VAL-RULE-003: No failed steps for success
 *   - VAL-RULE-004: Failure must have error details
 *   - VAL-RULE-005: Valid state machine (no inconsistencies)
 *   - VAL-RULE-006: Final status derivation
 *
 * Error Codes:
 *   - validator.plan_missing: No plan found for the VTID
 *   - validator.worker_state_missing: Cannot reconstruct worker state
 *   - validator.no_steps: Plan has zero steps
 *   - validator.internal_error: Unexpected internal error
 */

import fetch from 'node-fetch';
import { randomUUID } from 'crypto';
import { PlanPayload } from './operator-service';
import { getWorkerState, WorkerState, WorkerStepState } from './worker-core-service';

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// ==================== Types ====================

/**
 * Validation rule IDs
 */
export type ValidationRuleId =
  | 'VAL-RULE-001'
  | 'VAL-RULE-002'
  | 'VAL-RULE-003'
  | 'VAL-RULE-004'
  | 'VAL-RULE-005'
  | 'VAL-RULE-006';

/**
 * Final validation status
 */
export type ValidationFinalStatus = 'success' | 'failed' | 'pending';

/**
 * Validation violation
 */
export interface ValidationViolation {
  code: ValidationRuleId;
  message: string;
  step_id?: string;
}

/**
 * Validation result from Validator-Core
 */
export interface ValidationResult {
  final_status: ValidationFinalStatus;
  rules_checked: ValidationRuleId[];
  violations: ValidationViolation[];
  summary: string;
  validated_at: string;
}

/**
 * Validator-Core error codes
 */
export type ValidatorErrorCode =
  | 'validator.plan_missing'
  | 'validator.worker_state_missing'
  | 'validator.no_steps'
  | 'validator.internal_error';

/**
 * Validator-Core error response
 */
export interface ValidatorError {
  code: ValidatorErrorCode;
  message: string;
}

/**
 * Validate request payload
 */
export interface ValidateRequest {
  mode?: 'auto';
  override?: null;
}

/**
 * Validator state stored in events
 */
export interface ValidatorState {
  final_status: ValidationFinalStatus;
  summary: string;
  rules_checked: ValidationRuleId[];
  violations: ValidationViolation[];
  validated_at: string | null;
}

/**
 * OASIS Event structure for autopilot events
 */
interface AutopilotOasisEvent {
  id: string;
  created_at: string;
  vtid: string;
  topic: string;
  metadata: Record<string, unknown>;
}

// ==================== Event Fetching ====================

/**
 * Fetch OASIS events for a VTID with specific topics
 */
async function fetchOasisEvents(vtid: string, topics: string[]): Promise<AutopilotOasisEvent[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0535] Supabase not configured');
    return [];
  }

  try {
    // Build topic filter using PostgREST 'or' syntax
    const topicFilter = topics.map(t => `topic.eq.${t}`).join(',');

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?vtid=eq.${encodeURIComponent(vtid)}&or=(${topicFilter})&select=id,created_at,vtid,topic,metadata&order=created_at.desc`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0535] Events fetch failed: ${resp.status} - ${text}`);
      return [];
    }

    return await resp.json() as AutopilotOasisEvent[];
  } catch (error: any) {
    console.warn(`[VTID-0535] Events fetch error: ${error.message}`);
    return [];
  }
}

/**
 * Extract plan from autopilot.plan.created event
 */
function extractPlanFromEvents(events: AutopilotOasisEvent[]): PlanPayload | null {
  const planEvent = events.find(e => e.topic === 'autopilot.plan.created');
  if (!planEvent) {
    return null;
  }

  const plan = planEvent.metadata?.plan as PlanPayload | undefined;
  return plan || null;
}

// ==================== Validation Rules ====================

/**
 * VAL-RULE-001: Plan Exists & Non-Empty
 * Fail if plan missing or plan has zero steps
 */
function validateRule001(plan: PlanPayload | null): ValidationViolation | null {
  if (!plan) {
    return {
      code: 'VAL-RULE-001',
      message: 'Plan is missing for this VTID'
    };
  }

  if (!plan.steps || plan.steps.length === 0) {
    return {
      code: 'VAL-RULE-001',
      message: 'Plan has zero steps'
    };
  }

  return null;
}

/**
 * VAL-RULE-002: Worker Steps Cover the Plan
 * Every planned step must exist in worker state with terminal status
 */
function validateRule002(plan: PlanPayload, workerState: WorkerState): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  // Build a map of worker step states by step_id
  const workerStepsMap = new Map(workerState.steps.map(s => [s.step_id, s]));

  for (const planStep of plan.steps) {
    const workerStep = workerStepsMap.get(planStep.id);

    if (!workerStep) {
      violations.push({
        code: 'VAL-RULE-002',
        message: `Planned step "${planStep.id}" has no worker state`,
        step_id: planStep.id
      });
      continue;
    }

    // Check for terminal status (completed or failed)
    if (workerStep.status !== 'completed' && workerStep.status !== 'failed') {
      violations.push({
        code: 'VAL-RULE-002',
        message: `Step "${planStep.id}" is not in a terminal state (current: ${workerStep.status})`,
        step_id: planStep.id
      });
    }
  }

  return violations;
}

/**
 * VAL-RULE-003: No Failed Steps for Success
 * If any step has status="failed" → final_status="failed"
 */
function validateRule003(workerState: WorkerState): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  for (const step of workerState.steps) {
    if (step.status === 'failed') {
      violations.push({
        code: 'VAL-RULE-003',
        message: `Step "${step.step_id}" is in failed state`,
        step_id: step.step_id
      });
    }
  }

  return violations;
}

/**
 * VAL-RULE-004: Failure Must Have Error Details
 * Any step with status="failed" must have non-empty error
 */
function validateRule004(workerState: WorkerState): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  for (const step of workerState.steps) {
    if (step.status === 'failed') {
      if (!step.error || step.error.trim() === '') {
        violations.push({
          code: 'VAL-RULE-004',
          message: `Failed step "${step.step_id}" is missing error details`,
          step_id: step.step_id
        });
      }
    }
  }

  return violations;
}

/**
 * VAL-RULE-005: Valid State Machine (Redundant Check)
 * Detect inconsistencies:
 * - No step is both completed and failed
 * - No step with completed_at but status != completed|failed
 */
function validateRule005(workerState: WorkerState): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  for (const step of workerState.steps) {
    // Check for completed_at without terminal status
    if (step.completed_at && step.status !== 'completed' && step.status !== 'failed') {
      violations.push({
        code: 'VAL-RULE-005',
        message: `Step "${step.step_id}" has completed_at but status is "${step.status}"`,
        step_id: step.step_id
      });
    }

    // Check for started_at without at least in_progress status
    if (step.started_at && step.status === 'pending') {
      violations.push({
        code: 'VAL-RULE-005',
        message: `Step "${step.step_id}" has started_at but status is still "pending"`,
        step_id: step.step_id
      });
    }
  }

  return violations;
}

/**
 * VAL-RULE-006: Final Status Derivation
 * Derive final_status strictly from the above rules
 */
function deriveRule006FinalStatus(
  rule001Violation: ValidationViolation | null,
  rule002Violations: ValidationViolation[],
  rule003Violations: ValidationViolation[],
  rule004Violations: ValidationViolation[],
  rule005Violations: ValidationViolation[],
  workerState: WorkerState | null
): ValidationFinalStatus {
  // If any violation from rules 001-005, final_status is failed
  if (rule001Violation) {
    return 'failed';
  }

  if (rule002Violations.length > 0) {
    return 'failed';
  }

  if (rule003Violations.length > 0) {
    return 'failed';
  }

  if (rule004Violations.length > 0) {
    return 'failed';
  }

  if (rule005Violations.length > 0) {
    return 'failed';
  }

  // If all steps exist and are "completed" → "success"
  if (workerState && workerState.steps.every(s => s.status === 'completed')) {
    return 'success';
  }

  // Otherwise (e.g., pending/in_progress) → "failed" for v1 (strict)
  return 'failed';
}

/**
 * Generate summary message based on validation result
 */
function generateSummary(
  finalStatus: ValidationFinalStatus,
  violations: ValidationViolation[],
  workerState: WorkerState | null
): string {
  if (finalStatus === 'success') {
    const stepCount = workerState?.steps.length || 0;
    return `All ${stepCount} steps completed successfully without failures.`;
  }

  if (violations.length === 0) {
    return 'Task failed due to incomplete or non-terminal step states.';
  }

  // Count violations by type
  const violationCounts = violations.reduce((acc, v) => {
    acc[v.code] = (acc[v.code] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const parts: string[] = [];

  if (violationCounts['VAL-RULE-001']) {
    parts.push('plan is missing or empty');
  }

  if (violationCounts['VAL-RULE-002']) {
    const count = violationCounts['VAL-RULE-002'];
    parts.push(`${count} step(s) missing worker coverage or not in terminal state`);
  }

  if (violationCounts['VAL-RULE-003']) {
    const count = violationCounts['VAL-RULE-003'];
    parts.push(`${count} step(s) in failed state`);
  }

  if (violationCounts['VAL-RULE-004']) {
    const count = violationCounts['VAL-RULE-004'];
    parts.push(`${count} failed step(s) missing error details`);
  }

  if (violationCounts['VAL-RULE-005']) {
    const count = violationCounts['VAL-RULE-005'];
    parts.push(`${count} state machine inconsistency(ies) detected`);
  }

  return `Task failed: ${parts.join('; ')}.`;
}

// ==================== Event Emission ====================

/**
 * Emit autopilot.validation.completed event
 */
async function emitValidationCompletedEvent(
  vtid: string,
  result: ValidationResult
): Promise<{ ok: true; eventId: string } | { ok: false; error: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0535] Supabase not configured');
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    const dbPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: vtid,
      topic: 'autopilot.validation.completed',
      service: 'autopilot-pipeline',
      role: 'AUTOPILOT',
      model: 'validator-core',
      status: result.final_status === 'success' ? 'success' : 'warning',
      message: result.summary,
      link: null,
      metadata: {
        vtid: vtid,
        final_status: result.final_status,
        rules_checked: result.rules_checked,
        violations: result.violations,
        summary: result.summary,
        validated_at: result.validated_at
      }
    };

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(dbPayload)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0535] Validation completed event failed: ${resp.status} - ${text}`);
      return { ok: false, error: `Event emit failed: ${resp.status}` };
    }

    console.log(`[VTID-0535] Validation completed event emitted: ${eventId}`);
    return { ok: true, eventId };
  } catch (error: any) {
    console.warn(`[VTID-0535] Validation completed event error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * Emit autopilot.task.finalized event
 */
async function emitTaskFinalizedEvent(
  vtid: string,
  result: ValidationResult
): Promise<{ ok: true; eventId: string } | { ok: false; error: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0535] Supabase not configured');
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    const dbPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: vtid,
      topic: 'autopilot.task.finalized',
      service: 'autopilot-pipeline',
      role: 'AUTOPILOT',
      model: 'validator-core',
      status: result.final_status === 'success' ? 'success' : 'warning',
      message: result.final_status === 'success'
        ? 'Task successfully validated and finalized.'
        : `Task finalized as failed: ${result.summary}`,
      link: null,
      metadata: {
        vtid: vtid,
        final_status: result.final_status,
        finalized_at: timestamp,
        summary: result.summary,
        violations: result.violations
      }
    };

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(dbPayload)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0535] Task finalized event failed: ${resp.status} - ${text}`);
      return { ok: false, error: `Event emit failed: ${resp.status}` };
    }

    console.log(`[VTID-0535] Task finalized event emitted: ${eventId}`);
    return { ok: true, eventId };
  } catch (error: any) {
    console.warn(`[VTID-0535] Task finalized event error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * Update task status in VtidLedger based on validation result
 */
async function updateTaskStatusFromValidation(
  vtid: string,
  finalStatus: ValidationFinalStatus
): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return false;
  }

  try {
    // Map validation final_status to task status
    const taskStatus = finalStatus === 'success' ? 'completed' : 'failed';

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/VtidLedger?vtid=eq.${encodeURIComponent(vtid)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          status: taskStatus,
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0535] Task status update failed: ${resp.status} - ${text}`);
      return false;
    }

    console.log(`[VTID-0535] Task ${vtid} status updated to: ${taskStatus}`);
    return true;
  } catch (error: any) {
    console.warn(`[VTID-0535] Task status update error: ${error.message}`);
    return false;
  }
}

// ==================== Public API ====================

/**
 * Run deterministic validation for a VTID
 * Returns ValidationResult or ValidatorError
 */
export async function runValidation(
  vtid: string,
  _request?: ValidateRequest
): Promise<{ ok: true; result: ValidationResult } | { ok: false; error: ValidatorError }> {
  console.log(`[VTID-0535] Running validation for ${vtid}`);

  const validatedAt = new Date().toISOString();
  const rulesChecked: ValidationRuleId[] = [];
  const allViolations: ValidationViolation[] = [];

  // Fetch plan events
  const planEvents = await fetchOasisEvents(vtid, ['autopilot.plan.created']);
  const plan = extractPlanFromEvents(planEvents);

  // VAL-RULE-001: Plan Exists & Non-Empty
  rulesChecked.push('VAL-RULE-001');
  const rule001Violation = validateRule001(plan);

  if (rule001Violation) {
    allViolations.push(rule001Violation);

    // If no plan, we can't proceed with other rules
    const errorCode: ValidatorErrorCode = !plan ? 'validator.plan_missing' : 'validator.no_steps';

    // Still return a validation result for consistency
    const result: ValidationResult = {
      final_status: 'failed',
      rules_checked: rulesChecked,
      violations: allViolations,
      summary: rule001Violation.message,
      validated_at: validatedAt
    };

    // Emit events even for failures
    await emitValidationCompletedEvent(vtid, result);
    await emitTaskFinalizedEvent(vtid, result);

    return {
      ok: false,
      error: {
        code: errorCode,
        message: rule001Violation.message
      }
    };
  }

  // At this point, plan is guaranteed to exist and have steps
  const validPlan = plan!;

  // Get worker state
  const workerResult = await getWorkerState(vtid);

  if (!workerResult.ok) {
    const result: ValidationResult = {
      final_status: 'failed',
      rules_checked: rulesChecked,
      violations: [{
        code: 'VAL-RULE-002',
        message: 'Cannot reconstruct worker state from OASIS events'
      }],
      summary: 'Cannot reconstruct worker state from OASIS events',
      validated_at: validatedAt
    };

    await emitValidationCompletedEvent(vtid, result);
    await emitTaskFinalizedEvent(vtid, result);

    return {
      ok: false,
      error: {
        code: 'validator.worker_state_missing',
        message: workerResult.error.message
      }
    };
  }

  const workerState = workerResult.state;

  // VAL-RULE-002: Worker Steps Cover the Plan
  rulesChecked.push('VAL-RULE-002');
  const rule002Violations = validateRule002(validPlan, workerState);
  allViolations.push(...rule002Violations);

  // VAL-RULE-003: No Failed Steps for Success
  rulesChecked.push('VAL-RULE-003');
  const rule003Violations = validateRule003(workerState);
  allViolations.push(...rule003Violations);

  // VAL-RULE-004: Failure Must Have Error Details
  rulesChecked.push('VAL-RULE-004');
  const rule004Violations = validateRule004(workerState);
  allViolations.push(...rule004Violations);

  // VAL-RULE-005: Valid State Machine
  rulesChecked.push('VAL-RULE-005');
  const rule005Violations = validateRule005(workerState);
  allViolations.push(...rule005Violations);

  // VAL-RULE-006: Final Status Derivation
  rulesChecked.push('VAL-RULE-006');
  const finalStatus = deriveRule006FinalStatus(
    rule001Violation,
    rule002Violations,
    rule003Violations,
    rule004Violations,
    rule005Violations,
    workerState
  );

  // Generate summary
  const summary = generateSummary(finalStatus, allViolations, workerState);

  const result: ValidationResult = {
    final_status: finalStatus,
    rules_checked: rulesChecked,
    violations: allViolations,
    summary,
    validated_at: validatedAt
  };

  // Emit OASIS events
  await emitValidationCompletedEvent(vtid, result);
  await emitTaskFinalizedEvent(vtid, result);

  // Update task status in VtidLedger
  await updateTaskStatusFromValidation(vtid, finalStatus);

  console.log(`[VTID-0535] Validation completed for ${vtid}: ${finalStatus}`);

  return {
    ok: true,
    result
  };
}

/**
 * Get validator state from OASIS events
 * Returns the most recent validation result or a pending state
 */
export async function getValidatorState(vtid: string): Promise<ValidatorState> {
  // Fetch validation completed events
  const events = await fetchOasisEvents(vtid, ['autopilot.validation.completed']);

  if (events.length === 0) {
    return {
      final_status: 'pending',
      summary: 'Validation not yet executed.',
      rules_checked: [],
      violations: [],
      validated_at: null
    };
  }

  // Get the most recent validation event (already sorted desc by created_at)
  const latestEvent = events[0];
  const metadata = latestEvent.metadata;

  return {
    final_status: (metadata.final_status as ValidationFinalStatus) || 'pending',
    summary: (metadata.summary as string) || 'Validation completed.',
    rules_checked: (metadata.rules_checked as ValidationRuleId[]) || [],
    violations: (metadata.violations as ValidationViolation[]) || [],
    validated_at: (metadata.validated_at as string) || latestEvent.created_at
  };
}
