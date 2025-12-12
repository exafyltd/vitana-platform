/**
 * Worker-Core Service - VTID-0534
 *
 * Core Worker Engine for the Autopilot execution pipeline.
 * Tracks per-step execution state, enforces state machine transitions,
 * and reconstructs state from OASIS events (SSOT).
 *
 * State Machine:
 *   pending → in_progress → completed | failed
 *
 * Error Codes:
 *   - worker.plan_missing: No plan found for the VTID
 *   - worker.step_not_found: Step ID not in the plan
 *   - worker.invalid_transition: Invalid state transition attempted
 */

import fetch from 'node-fetch';
import { randomUUID } from 'crypto';
import { PlanPayload, PlanStep } from './operator-service';

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// ==================== Types ====================

/**
 * Step execution status
 */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Overall worker status (derived from step states)
 */
export type WorkerOverallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Worker step state - tracks execution state of a single step
 */
export interface WorkerStepState {
  step_id: string;
  step_index: number;
  label: string;
  status: StepStatus;
  started_at: string | null;
  completed_at: string | null;
  agent: string | null;
  executor_type: string | null;
  output_summary: string | null;
  error: string | null;
}

/**
 * Worker state for a VTID - aggregated view of all steps
 */
export interface WorkerState {
  overall_status: WorkerOverallStatus;
  steps: WorkerStepState[];
}

/**
 * Work start request payload (v1)
 */
export interface WorkStartRequest {
  step_id: string;
  step_index: number;
  label: string;
  agent: string;
  executor_type: string;
  notes?: string;
}

/**
 * Work complete request payload (v1)
 */
export interface WorkCompleteRequest {
  step_id: string;
  step_index: number;
  status: 'completed' | 'failed';
  output_summary?: string;
  error?: string;
  agent?: string;
}

/**
 * Worker-Core error codes
 */
export type WorkerErrorCode =
  | 'worker.plan_missing'
  | 'worker.step_not_found'
  | 'worker.invalid_transition'
  | 'worker.error_required';

/**
 * Worker-Core error response
 */
export interface WorkerError {
  code: WorkerErrorCode;
  message: string;
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

// ==================== Event Reconstruction ====================

/**
 * Fetch OASIS events for a VTID with specific topics
 */
async function fetchOasisEvents(vtid: string, topics: string[]): Promise<AutopilotOasisEvent[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0534] Supabase not configured');
    return [];
  }

  try {
    // Build topic filter using PostgREST 'or' syntax
    const topicFilter = topics.map(t => `topic.eq.${t}`).join(',');

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?vtid=eq.${encodeURIComponent(vtid)}&or=(${topicFilter})&select=id,created_at,vtid,topic,metadata&order=created_at.asc`,
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
      console.error(`[VTID-0534] Events fetch failed: ${resp.status} - ${text}`);
      return [];
    }

    return await resp.json() as AutopilotOasisEvent[];
  } catch (error: any) {
    console.error(`[VTID-0534] Events fetch error: ${error.message}`);
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

/**
 * Reconstruct step states from OASIS events
 */
function reconstructStepStates(plan: PlanPayload, events: AutopilotOasisEvent[]): WorkerStepState[] {
  // Initialize all steps from the plan as pending
  const stepsMap = new Map<string, WorkerStepState>();

  plan.steps.forEach((step, index) => {
    stepsMap.set(step.id, {
      step_id: step.id,
      step_index: index,
      label: step.title,
      status: 'pending',
      started_at: null,
      completed_at: null,
      agent: null,
      executor_type: null,
      output_summary: null,
      error: null
    });
  });

  // Process work.started events
  const startedEvents = events.filter(e => e.topic === 'autopilot.work.started');
  for (const event of startedEvents) {
    const stepId = (event.metadata?.step_id || event.metadata?.stepId) as string | undefined;
    if (stepId && stepsMap.has(stepId)) {
      const step = stepsMap.get(stepId)!;
      step.status = 'in_progress';
      step.started_at = (event.metadata?.started_at as string) || event.created_at;
      step.agent = (event.metadata?.agent || event.metadata?.workerModel) as string || null;
      step.executor_type = (event.metadata?.executor_type) as string || null;
      // Update label if provided
      if (event.metadata?.label) {
        step.label = event.metadata.label as string;
      }
    }
  }

  // Process work.completed events (override started state)
  const completedEvents = events.filter(e => e.topic === 'autopilot.work.completed');
  for (const event of completedEvents) {
    const stepId = (event.metadata?.step_id || event.metadata?.stepId) as string | undefined;
    if (stepId && stepsMap.has(stepId)) {
      const step = stepsMap.get(stepId)!;
      const eventStatus = event.metadata?.status as string | undefined;

      // Map event status to step status
      if (eventStatus === 'completed' || eventStatus === 'success') {
        step.status = 'completed';
      } else if (eventStatus === 'failed' || eventStatus === 'failure') {
        step.status = 'failed';
      }

      step.completed_at = (event.metadata?.completed_at as string) || event.created_at;
      step.output_summary = (event.metadata?.output_summary || event.metadata?.outputSummary) as string || null;
      step.error = (event.metadata?.error) as string || null;

      // Update agent if provided in completion
      if (event.metadata?.agent) {
        step.agent = event.metadata.agent as string;
      }
    }
  }

  // Return steps sorted by index
  return Array.from(stepsMap.values()).sort((a, b) => a.step_index - b.step_index);
}

/**
 * Derive overall worker status from step states
 */
function deriveOverallStatus(steps: WorkerStepState[]): WorkerOverallStatus {
  if (steps.length === 0) {
    return 'pending';
  }

  // Any failed → failed
  if (steps.some(s => s.status === 'failed')) {
    return 'failed';
  }

  // Any in_progress → in_progress
  if (steps.some(s => s.status === 'in_progress')) {
    return 'in_progress';
  }

  // All completed → completed
  if (steps.every(s => s.status === 'completed')) {
    return 'completed';
  }

  // Otherwise (all pending or mix of pending/completed) → pending or in_progress
  // If some are completed but not all, we're technically in progress
  if (steps.some(s => s.status === 'completed')) {
    return 'in_progress';
  }

  return 'pending';
}

// ==================== Public API ====================

/**
 * Get worker state for a VTID
 * Reconstructs state from OASIS events
 */
export async function getWorkerState(vtid: string): Promise<{ ok: true; state: WorkerState } | { ok: false; error: WorkerError }> {
  console.log(`[VTID-0534] Getting worker state for ${vtid}`);

  // Fetch all relevant events
  const events = await fetchOasisEvents(vtid, [
    'autopilot.plan.created',
    'autopilot.work.started',
    'autopilot.work.completed'
  ]);

  // Extract plan
  const plan = extractPlanFromEvents(events);
  if (!plan) {
    return {
      ok: false,
      error: {
        code: 'worker.plan_missing',
        message: `No plan found for VTID ${vtid}`
      }
    };
  }

  // Reconstruct step states
  const steps = reconstructStepStates(plan, events);
  const overall_status = deriveOverallStatus(steps);

  return {
    ok: true,
    state: {
      overall_status,
      steps
    }
  };
}

/**
 * Start work on a step
 * Validates step exists in plan and is in pending state
 */
export async function startWork(
  vtid: string,
  request: WorkStartRequest
): Promise<{ ok: true; state: WorkerState; eventId: string } | { ok: false; error: WorkerError }> {
  console.log(`[VTID-0534] Starting work on ${vtid}, step: ${request.step_id}`);

  // Fetch events and get current state
  const events = await fetchOasisEvents(vtid, [
    'autopilot.plan.created',
    'autopilot.work.started',
    'autopilot.work.completed'
  ]);

  // Extract plan
  const plan = extractPlanFromEvents(events);
  if (!plan) {
    return {
      ok: false,
      error: {
        code: 'worker.plan_missing',
        message: `No plan found for VTID ${vtid}`
      }
    };
  }

  // Verify step exists in plan
  const planStep = plan.steps.find(s => s.id === request.step_id);
  if (!planStep) {
    return {
      ok: false,
      error: {
        code: 'worker.step_not_found',
        message: `Step ${request.step_id} not found in plan for VTID ${vtid}`
      }
    };
  }

  // Reconstruct current state
  const currentSteps = reconstructStepStates(plan, events);
  const currentStep = currentSteps.find(s => s.step_id === request.step_id);

  // Validate transition: must be pending
  if (currentStep && currentStep.status !== 'pending') {
    return {
      ok: false,
      error: {
        code: 'worker.invalid_transition',
        message: `Step ${request.step_id} is already ${currentStep.status}, cannot start`
      }
    };
  }

  // Emit work.started event
  const eventResult = await emitWorkStartedEvent(vtid, request);
  if (!eventResult.ok) {
    return {
      ok: false,
      error: {
        code: 'worker.invalid_transition',
        message: `Failed to emit event: ${eventResult.error}`
      }
    };
  }

  // Update task status to in-progress
  await updateTaskStatusToInProgress(vtid);

  // Return updated state
  const updatedSteps = currentSteps.map(s => {
    if (s.step_id === request.step_id) {
      return {
        ...s,
        status: 'in_progress' as StepStatus,
        started_at: new Date().toISOString(),
        agent: request.agent,
        executor_type: request.executor_type,
        label: request.label
      };
    }
    return s;
  });

  return {
    ok: true,
    eventId: eventResult.eventId,
    state: {
      overall_status: deriveOverallStatus(updatedSteps),
      steps: updatedSteps
    }
  };
}

/**
 * Complete work on a step
 * Validates step exists and is in in_progress state
 */
export async function completeWork(
  vtid: string,
  request: WorkCompleteRequest
): Promise<{ ok: true; state: WorkerState; eventId: string } | { ok: false; error: WorkerError }> {
  console.log(`[VTID-0534] Completing work on ${vtid}, step: ${request.step_id}`);

  // Validate: if status is 'failed', error is required
  if (request.status === 'failed' && (!request.error || request.error.trim() === '')) {
    return {
      ok: false,
      error: {
        code: 'worker.error_required',
        message: 'Error message is required when status is "failed"'
      }
    };
  }

  // Fetch events and get current state
  const events = await fetchOasisEvents(vtid, [
    'autopilot.plan.created',
    'autopilot.work.started',
    'autopilot.work.completed'
  ]);

  // Extract plan
  const plan = extractPlanFromEvents(events);
  if (!plan) {
    return {
      ok: false,
      error: {
        code: 'worker.plan_missing',
        message: `No plan found for VTID ${vtid}`
      }
    };
  }

  // Verify step exists in plan
  const planStep = plan.steps.find(s => s.id === request.step_id);
  if (!planStep) {
    return {
      ok: false,
      error: {
        code: 'worker.step_not_found',
        message: `Step ${request.step_id} not found in plan for VTID ${vtid}`
      }
    };
  }

  // Reconstruct current state
  const currentSteps = reconstructStepStates(plan, events);
  const currentStep = currentSteps.find(s => s.step_id === request.step_id);

  // Validate transition: must be in_progress
  if (!currentStep || currentStep.status !== 'in_progress') {
    const actualStatus = currentStep?.status || 'unknown';
    return {
      ok: false,
      error: {
        code: 'worker.invalid_transition',
        message: `Step ${request.step_id} is ${actualStatus}, must be in_progress to complete`
      }
    };
  }

  // Emit work.completed event
  const eventResult = await emitWorkCompletedEvent(vtid, request, currentStep);
  if (!eventResult.ok) {
    return {
      ok: false,
      error: {
        code: 'worker.invalid_transition',
        message: `Failed to emit event: ${eventResult.error}`
      }
    };
  }

  // Return updated state
  const updatedSteps = currentSteps.map(s => {
    if (s.step_id === request.step_id) {
      return {
        ...s,
        status: request.status as StepStatus,
        completed_at: new Date().toISOString(),
        output_summary: request.output_summary || null,
        error: request.error || null,
        agent: request.agent || s.agent
      };
    }
    return s;
  });

  return {
    ok: true,
    eventId: eventResult.eventId,
    state: {
      overall_status: deriveOverallStatus(updatedSteps),
      steps: updatedSteps
    }
  };
}

// ==================== Event Emission ====================

/**
 * Emit autopilot.work.started event with rich payload
 */
async function emitWorkStartedEvent(
  vtid: string,
  request: WorkStartRequest
): Promise<{ ok: true; eventId: string } | { ok: false; error: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0534] Supabase not configured');
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    const dbPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: vtid,
      topic: 'autopilot.work.started',
      service: 'autopilot-pipeline',
      role: 'AUTOPILOT',
      model: 'worker-core',
      status: 'info',
      message: `Work started on step: ${request.step_id} - ${request.label}`,
      link: null,
      metadata: {
        vtid: vtid,
        step_id: request.step_id,
        step_index: request.step_index,
        label: request.label,
        agent: request.agent,
        executor_type: request.executor_type,
        status: 'in_progress',
        started_at: timestamp,
        notes: request.notes || null
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
      console.error(`[VTID-0534] Work started event failed: ${resp.status} - ${text}`);
      return { ok: false, error: `Event emit failed: ${resp.status}` };
    }

    console.log(`[VTID-0534] Work started event emitted: ${eventId}`);
    return { ok: true, eventId };
  } catch (error: any) {
    console.error(`[VTID-0534] Work started event error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * Emit autopilot.work.completed event with rich payload
 */
async function emitWorkCompletedEvent(
  vtid: string,
  request: WorkCompleteRequest,
  currentStep: WorkerStepState
): Promise<{ ok: true; eventId: string } | { ok: false; error: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0534] Supabase not configured');
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    const dbPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: vtid,
      topic: 'autopilot.work.completed',
      service: 'autopilot-pipeline',
      role: 'AUTOPILOT',
      model: 'worker-core',
      status: request.status === 'completed' ? 'success' : 'warning',
      message: request.output_summary || `Step ${request.step_id} ${request.status}`,
      link: null,
      metadata: {
        vtid: vtid,
        step_id: request.step_id,
        step_index: request.step_index,
        label: currentStep.label,
        status: request.status,
        output_summary: request.output_summary || null,
        error: request.error || null,
        completed_at: timestamp,
        agent: request.agent || currentStep.agent
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
      console.error(`[VTID-0534] Work completed event failed: ${resp.status} - ${text}`);
      return { ok: false, error: `Event emit failed: ${resp.status}` };
    }

    console.log(`[VTID-0534] Work completed event emitted: ${eventId}`);
    return { ok: true, eventId };
  } catch (error: any) {
    console.error(`[VTID-0534] Work completed event error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * Update task status to in-progress in VtidLedger
 */
async function updateTaskStatusToInProgress(vtid: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return;
  }

  try {
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
          status: 'in-progress',
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0534] Task status update failed: ${resp.status} - ${text}`);
    }
  } catch (error: any) {
    console.warn(`[VTID-0534] Task status update error: ${error.message}`);
  }
}
