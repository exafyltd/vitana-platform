/**
 * VTID-01149: Unified Task-Creation Intake Service
 *
 * Provides unified intake logic for both ORB and Operator Console surfaces.
 * When either surface detects "task creation" intent, this service handles:
 * - The 2-question intake flow (Q1: spec, Q2: header)
 * - DEV-default classification
 * - Scheduling the task to Command Hub board
 *
 * Key principles:
 * - Same logic for both surfaces (ORB + Operator Console)
 * - Memory-first: check historical context before asking
 * - DEV-default: all tasks default to DEV classification
 * - Event-driven: emit OASIS events at each step
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { allocateVtid } from './operator-service';

// =============================================================================
// VTID-01149: Task Intake Types
// =============================================================================

/**
 * Surface type for task intake
 */
export type IntakeSurface = 'orb' | 'operator';

/**
 * Question type in the intake flow
 */
export type IntakeQuestionType = 'spec' | 'header';

/**
 * Task Intake State - per chat session (Section 3.1)
 */
export interface TaskIntakeState {
  /** Whether intake mode is active */
  intake_active: boolean;
  /** VTID allocated for this intake (if any) */
  intake_vtid: string | null;
  /** Spec text from Q1 answer */
  spec_text: string | null;
  /** Header/title from Q2 answer */
  header: string | null;
  /** Task family - defaults to DEV per spec */
  task_family: 'DEV';
  /** Whether ready to schedule (spec_text + header both present) */
  ready_to_schedule: boolean;
  /** Surface that initiated the intake */
  surface: IntakeSurface;
  /** Session ID for this intake */
  session_id: string;
  /** Tenant for multi-tenancy */
  tenant: string;
  /** Timestamp when intake started */
  started_at: string;
  /** Timestamp of last update */
  updated_at: string;
}

/**
 * Result of processing an intake answer
 */
export interface IntakeAnswerResult {
  /** Was the answer accepted */
  ok: boolean;
  /** Current intake state */
  state: TaskIntakeState;
  /** Next question to ask (null if intake complete) */
  next_question: IntakeQuestionType | null;
  /** Prompt text for the next question */
  next_question_prompt: string | null;
  /** Is intake complete and ready to schedule */
  ready_to_schedule: boolean;
  /** Error message if any */
  error?: string;
}

/**
 * Result of scheduling a task
 */
export interface ScheduleTaskResult {
  /** Was scheduling successful */
  ok: boolean;
  /** VTID of the scheduled task */
  vtid: string;
  /** Error message if scheduling failed */
  error?: string;
  /** Event ID of the schedule event */
  event_id?: string;
}

// =============================================================================
// VTID-01149: Intake Questions (Section 2.2)
// =============================================================================

/**
 * Canonical intake questions - MUST be identical across surfaces
 */
export const INTAKE_QUESTIONS = {
  spec: 'What do you want to add to the spec?',
  header: 'What is the header of this task?'
} as const;

// =============================================================================
// VTID-01149: In-Memory State Store
// =============================================================================

/**
 * In-memory store for active intake sessions
 * Key: session_id (orb_session_id or threadId)
 */
const intakeStateStore = new Map<string, TaskIntakeState>();

/**
 * Intake session timeout (30 minutes)
 */
const INTAKE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Cleanup expired intake sessions periodically
 */
function cleanupExpiredIntakes(): void {
  const now = Date.now();
  for (const [sessionId, state] of intakeStateStore.entries()) {
    const updatedAt = new Date(state.updated_at).getTime();
    if (now - updatedAt > INTAKE_TIMEOUT_MS) {
      console.log(`[VTID-01149] Cleaning up expired intake session: ${sessionId}`);
      intakeStateStore.delete(sessionId);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredIntakes, 5 * 60 * 1000);

// =============================================================================
// VTID-01149: Task Creation Intent Detection
// =============================================================================

/**
 * Keywords that indicate task creation intent
 * Used for deterministic classification
 */
const TASK_CREATION_KEYWORDS: RegExp[] = [
  // English
  /\b(create|add|make|new)\s*(a\s*)?(task|issue|ticket|todo|bug|feature|item|work item)\b/i,
  /\b(report|log|file|submit)\s*(a\s*)?(bug|issue|problem|defect)\b/i,
  /\b(i want|i need|we need|please)\s+(to\s+)?(create|add|make)\b/i,
  /\b(can you|could you)\s+(create|add|make)\s+(a\s+)?(task|issue|ticket)\b/i,
  /\b(let'?s|let me)\s+(create|add|make)\s+(a\s+)?(task|issue|ticket)\b/i,
  /\b(schedule|plan|queue)\s+(a\s+)?(task|work|item)\b/i,
  /\b(add\s+to|put\s+on)\s+(the\s+)?(backlog|board|queue|list)\b/i,
  /\b(track|capture)\s+(this|that|the)\s+(as\s+a\s+)?(task|issue|ticket)\b/i,
  // German - expanded patterns
  /\b(erstell|anleg|hinzuf[uü]g)(en|e|st|t)?\s*(mir\s*)?(eine?n?\s*)?(neue?n?\s*)?(aufgabe|ticket|task|bug|fehler|eintrag)\b/i,
  /\b(meld|bericht|logg)(en|e|st|t)?\s*(eine?n?\s*)?(bug|fehler|problem)\b/i,
  /\b(ich\s+)?(m[oö]chte|will|brauche|h[aä]tte\s+gerne?)\s+(eine?n?\s*)?(neue?n?\s*)?(aufgabe|ticket|task|eintrag)\b/i,
  /\b(kannst|k[oö]nntest|w[uü]rdest)\s+(du\s+)?(mir\s+)?(eine?n?\s*)?(aufgabe|ticket|task)\s*(erstellen|anlegen|machen)\b/i,
  /\b(neue?n?\s+)(aufgabe|ticket|task|eintrag)\s*(bitte|erstellen|anlegen)?\b/i,
  /\b(bitte\s+)?(erstell|leg|mach)(e|st|t)?\s*(mir\s+)?(eine?n?\s*)?(aufgabe|ticket|task)\b/i,
  /\b(ich\s+)?(brauche|ben[oö]tige)\s+(eine?n?\s*)?(neue?n?\s*)?(aufgabe|ticket|task)\b/i,
  /\baufgabe\s+(erstellen|anlegen|hinzuf[uü]gen)\b/i,
  /\bticket\s+(erstellen|anlegen|aufmachen)\b/i,
];

/**
 * VTID-01149: Detect if user message indicates task creation intent
 * Uses deterministic keyword matching for consistency across surfaces
 *
 * @param message - User message to analyze
 * @returns true if task creation intent is detected
 */
export function detectTaskCreationIntent(message: string): boolean {
  if (!message || typeof message !== 'string') {
    return false;
  }

  const normalizedMessage = message.trim().toLowerCase();

  // Check for explicit task creation patterns
  for (const pattern of TASK_CREATION_KEYWORDS) {
    if (pattern.test(normalizedMessage)) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// VTID-01149: Intake State Management
// =============================================================================

/**
 * Get existing intake state for a session
 */
export function getIntakeState(sessionId: string): TaskIntakeState | null {
  return intakeStateStore.get(sessionId) || null;
}

/**
 * Check if a session has active intake
 */
export function hasActiveIntake(sessionId: string): boolean {
  const state = intakeStateStore.get(sessionId);
  return state?.intake_active === true;
}

/**
 * Start a new intake session
 */
export async function startIntake(params: {
  sessionId: string;
  surface: IntakeSurface;
  tenant?: string;
}): Promise<TaskIntakeState> {
  const { sessionId, surface, tenant = 'vitana' } = params;
  const now = new Date().toISOString();

  // Create new intake state with DEV defaults (Section 2.3)
  const state: TaskIntakeState = {
    intake_active: true,
    intake_vtid: null,
    spec_text: null,
    header: null,
    task_family: 'DEV', // DEV-default per spec
    ready_to_schedule: false,
    surface,
    session_id: sessionId,
    tenant,
    started_at: now,
    updated_at: now
  };

  intakeStateStore.set(sessionId, state);

  // Emit task create detected event (Section 4.1)
  await emitOasisEvent({
    vtid: 'VTID-01149',
    type: 'autopilot.intent.task_create_detected' as any,
    source: 'task-intake-service',
    status: 'info',
    message: `Task creation intent detected on ${surface}`,
    payload: {
      session_id: sessionId,
      surface,
      tenant,
      started_at: now
    }
  });

  console.log(`[VTID-01149] Started intake session: ${sessionId} on ${surface}`);

  return state;
}

/**
 * Get the next question to ask in the intake flow
 */
export function getNextQuestion(state: TaskIntakeState): {
  question: IntakeQuestionType | null;
  prompt: string | null;
} {
  // Must ask Q1 (spec) first if not answered
  if (state.spec_text === null) {
    return { question: 'spec', prompt: INTAKE_QUESTIONS.spec };
  }

  // Then ask Q2 (header) if not answered
  if (state.header === null) {
    return { question: 'header', prompt: INTAKE_QUESTIONS.header };
  }

  // Both answered - no more questions
  return { question: null, prompt: null };
}

/**
 * Process an answer to an intake question
 */
export async function processIntakeAnswer(params: {
  sessionId: string;
  question: IntakeQuestionType;
  answer: string;
  surface: IntakeSurface;
}): Promise<IntakeAnswerResult> {
  const { sessionId, question, answer, surface } = params;
  const state = intakeStateStore.get(sessionId);

  if (!state || !state.intake_active) {
    return {
      ok: false,
      state: state || createEmptyState(sessionId, surface),
      next_question: null,
      next_question_prompt: null,
      ready_to_schedule: false,
      error: 'No active intake session'
    };
  }

  // Validate answer is not empty
  const trimmedAnswer = answer?.trim();
  if (!trimmedAnswer) {
    return {
      ok: false,
      state,
      next_question: question,
      next_question_prompt: INTAKE_QUESTIONS[question],
      ready_to_schedule: false,
      error: 'Answer cannot be empty'
    };
  }

  // Update state based on question type
  const now = new Date().toISOString();
  if (question === 'spec') {
    state.spec_text = trimmedAnswer;
  } else if (question === 'header') {
    state.header = trimmedAnswer;
  }
  state.updated_at = now;

  // Check if ready to schedule (Section 3.2)
  state.ready_to_schedule = state.spec_text !== null && state.header !== null;

  // Save updated state
  intakeStateStore.set(sessionId, state);

  // Emit answer received event (Section 4.1)
  await emitOasisEvent({
    vtid: state.intake_vtid || 'VTID-01149',
    type: 'autopilot.task.intake.answer_received' as any,
    source: 'task-intake-service',
    status: 'info',
    message: `Received ${question} answer on ${surface}`,
    payload: {
      session_id: sessionId,
      question,
      text: trimmedAnswer,
      surface,
      ready_to_schedule: state.ready_to_schedule
    }
  });

  // Get next question
  const next = getNextQuestion(state);

  // If asking next question, emit question_asked event
  if (next.question) {
    await emitOasisEvent({
      vtid: state.intake_vtid || 'VTID-01149',
      type: 'autopilot.task.intake.question_asked' as any,
      source: 'task-intake-service',
      status: 'info',
      message: `Asking ${next.question} question on ${surface}`,
      payload: {
        session_id: sessionId,
        question: next.question,
        surface
      }
    });
  }

  console.log(`[VTID-01149] Processed ${question} answer for ${sessionId}, ready_to_schedule=${state.ready_to_schedule}`);

  return {
    ok: true,
    state,
    next_question: next.question,
    next_question_prompt: next.prompt,
    ready_to_schedule: state.ready_to_schedule
  };
}

/**
 * Cancel an active intake session
 */
export function cancelIntake(sessionId: string): void {
  const state = intakeStateStore.get(sessionId);
  if (state) {
    state.intake_active = false;
    state.updated_at = new Date().toISOString();
    intakeStateStore.set(sessionId, state);
    console.log(`[VTID-01149] Cancelled intake session: ${sessionId}`);
  }
}

/**
 * Clear intake state for a session
 */
export function clearIntakeState(sessionId: string): void {
  intakeStateStore.delete(sessionId);
}

// =============================================================================
// VTID-01149: Bridge Function - Spec → Scheduled Card (Section 5)
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

/**
 * VTID-01149: Ensure a task is scheduled with DEV defaults (Section 5.1)
 *
 * This is the bridge function that:
 * 1. Validates header + spec_text (hard requirement)
 * 2. Enforces DEV defaults
 * 3. Upserts into vtid_ledger with status='scheduled'
 * 4. Emits commandhub.task.scheduled on success
 * 5. Emits commandhub.task.schedule_failed on failure (does not crash)
 *
 * @param params - Task data with vtid, header, spec_text, tenant
 * @returns Result with success status and event ID
 */
export async function ensureScheduledDevTask(params: {
  vtid: string;
  header: string;
  spec_text: string;
  tenant?: string;
}): Promise<ScheduleTaskResult> {
  const { vtid, header, spec_text, tenant = 'vitana' } = params;

  console.log(`[VTID-01149] Scheduling DEV task: ${vtid}`);

  // Validate header + spec_text (Section 5.1 - hard requirement)
  if (!header || typeof header !== 'string' || header.trim().length === 0) {
    const error = 'Header is required and cannot be empty';
    await emitScheduleFailedEvent(vtid, error);
    return { ok: false, vtid, error };
  }

  if (!spec_text || typeof spec_text !== 'string' || spec_text.trim().length === 0) {
    const error = 'Spec text is required and cannot be empty';
    await emitScheduleFailedEvent(vtid, error);
    return { ok: false, vtid, error };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    const error = 'Supabase not configured';
    await emitScheduleFailedEvent(vtid, error);
    return { ok: false, vtid, error };
  }

  try {
    const now = new Date().toISOString();

    // Build upsert payload with DEV defaults (Section 2.3)
    const taskPayload = {
      vtid,
      title: header.trim(),
      description: spec_text.trim(),
      summary: spec_text.trim(),
      status: 'pending', // VTID-01150: Use 'pending' like the button does (NOT 'scheduled')
      task_family: 'DEV', // DEV-default
      layer: 'DEV',
      module: 'COMHU', // Command Hub module
      tenant,
      // Note: belongs_to column removed - doesn't exist in vtid_ledger schema
      is_test: false,
      metadata: {
        source: 'task-intake-service',
        scope_checkbox: { dev: true },
        created_via: 'vtid-01149-intake',
        spec_text,
        header
      },
      updated_at: now
    };

    // Use UPSERT pattern: POST with on_conflict resolution to handle both insert and update
    // This is more reliable than PATCH-then-INSERT because it's atomic
    const upsertPayload = {
      ...taskPayload,
      id: randomUUID(), // Will be ignored on conflict
      created_at: now
    };

    console.log(`[VTID-01149] Upserting task ${vtid} with status='scheduled'`);

    // Use on_conflict=vtid to upsert - if vtid exists, update; if not, insert
    const upsertResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          // Use merge-duplicates to update on conflict
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(upsertPayload)
      }
    );

    if (!upsertResp.ok) {
      const errorText = await upsertResp.text();
      console.error(`[VTID-01149] Upsert failed: ${upsertResp.status} - ${errorText}`);

      // Fallback: try direct PATCH if upsert doesn't work
      console.log(`[VTID-01149] Falling back to PATCH for ${vtid}`);
      const patchResp = await fetch(
        `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
            Prefer: 'return=representation'
          },
          body: JSON.stringify(taskPayload)
        }
      );

      if (patchResp.ok) {
        const patchedRows = await patchResp.json() as unknown[];
        if (Array.isArray(patchedRows) && patchedRows.length > 0) {
          console.log(`[VTID-01149] PATCH succeeded for ${vtid}`);
          const eventResult = await emitScheduledEvent(vtid, header, 'update');
          return { ok: true, vtid, event_id: eventResult.event_id };
        }
      }

      const error = `Failed to upsert/patch task: ${upsertResp.status} - ${errorText}`;
      await emitScheduleFailedEvent(vtid, error);
      return { ok: false, vtid, error };
    }

    const upsertedRows = await upsertResp.json() as unknown[];
    const wasInsert = Array.isArray(upsertedRows) && upsertedRows.length > 0;

    console.log(`[VTID-01149] Successfully upserted task ${vtid} to scheduled status`);
    const eventResult = await emitScheduledEvent(vtid, header, wasInsert ? 'insert' : 'update');
    return { ok: true, vtid, event_id: eventResult.event_id };

  } catch (err: any) {
    const error = `Exception scheduling task: ${err.message}`;
    console.error(`[VTID-01149] ${error}`);
    await emitScheduleFailedEvent(vtid, error);
    return { ok: false, vtid, error };
  }
}

/**
 * Emit commandhub.task.scheduled event
 */
async function emitScheduledEvent(
  vtid: string,
  header: string,
  operation: 'insert' | 'update'
): Promise<{ ok: boolean; event_id?: string }> {
  return emitOasisEvent({
    vtid,
    type: 'commandhub.task.scheduled' as any,
    source: 'task-intake-service',
    status: 'info',  // VTID-01150: Changed from 'success' to avoid false terminal detection
    message: `Task scheduled: ${header}`,
    payload: {
      vtid,
      header,
      task_family: 'DEV',
      status: 'scheduled',
      operation,
      scheduled_at: new Date().toISOString()
    }
  });
}

/**
 * Emit commandhub.task.schedule_failed event (does not crash ingestion)
 */
async function emitScheduleFailedEvent(vtid: string, error: string): Promise<void> {
  try {
    await emitOasisEvent({
      vtid,
      type: 'commandhub.task.schedule_failed' as any,
      source: 'task-intake-service',
      status: 'error',
      message: `Task scheduling failed: ${error}`,
      payload: {
        vtid,
        error,
        failed_at: new Date().toISOString()
      }
    });
  } catch (e) {
    // Do not crash ingestion - just log
    console.error(`[VTID-01149] Failed to emit schedule_failed event: ${e}`);
  }
}

// =============================================================================
// VTID-01149: Complete Intake Flow (Convenience Function)
// =============================================================================

/**
 * Complete the intake flow and schedule the task
 * Called when ready_to_schedule becomes true
 */
export async function completeIntakeAndSchedule(sessionId: string): Promise<ScheduleTaskResult> {
  const state = intakeStateStore.get(sessionId);

  if (!state) {
    return { ok: false, vtid: '', error: 'No intake state found' };
  }

  if (!state.ready_to_schedule) {
    return { ok: false, vtid: '', error: 'Intake not complete - missing spec or header' };
  }

  // Allocate VTID if not already allocated
  let vtid = state.intake_vtid;
  if (!vtid) {
    const allocResult = await allocateVtid('task-intake', 'DEV', 'COMHU');
    if (!allocResult.ok || !allocResult.vtid) {
      // Generate fallback VTID
      vtid = `VTID-${Date.now().toString().slice(-5)}`;
      console.warn(`[VTID-01149] Allocator failed, using fallback VTID: ${vtid}`);
    } else {
      vtid = allocResult.vtid;
    }
    state.intake_vtid = vtid;
    intakeStateStore.set(sessionId, state);
  }

  // Emit ready_to_schedule event (Section 4.1)
  await emitOasisEvent({
    vtid,
    type: 'autopilot.task.ready_to_schedule' as any,
    source: 'task-intake-service',
    status: 'info',
    message: `Task ready to schedule: ${state.header}`,
    payload: {
      vtid,
      header: state.header,
      spec_text: state.spec_text,
      task_family: 'DEV',
      surface: state.surface,
      session_id: sessionId
    }
  });

  // Schedule the task
  const result = await ensureScheduledDevTask({
    vtid,
    header: state.header!,
    spec_text: state.spec_text!,
    tenant: state.tenant
  });

  if (result.ok) {
    // Clear intake state after successful scheduling
    state.intake_active = false;
    intakeStateStore.set(sessionId, state);
    console.log(`[VTID-01149] Intake complete and task scheduled: ${vtid}`);
  }

  return result;
}

// =============================================================================
// VTID-01149: Helper Functions
// =============================================================================

/**
 * Create an empty intake state for error responses
 */
function createEmptyState(sessionId: string, surface: IntakeSurface): TaskIntakeState {
  const now = new Date().toISOString();
  return {
    intake_active: false,
    intake_vtid: null,
    spec_text: null,
    header: null,
    task_family: 'DEV',
    ready_to_schedule: false,
    surface,
    session_id: sessionId,
    tenant: 'vitana',
    started_at: now,
    updated_at: now
  };
}

/**
 * Generate the intake start message with first question
 */
export function generateIntakeStartMessage(): string {
  return `I'll help you create a new task. ${INTAKE_QUESTIONS.spec}`;
}

/**
 * Check if a message is an answer to the current intake question
 * (Simple heuristic - not a question, reasonably long)
 */
export function looksLikeAnswer(message: string): boolean {
  if (!message || typeof message !== 'string') return false;
  const trimmed = message.trim();
  // Not empty, not a question, at least a few words
  return trimmed.length > 5 && !trimmed.endsWith('?');
}

// INTAKE_QUESTIONS and INTAKE_TIMEOUT_MS are already exported at their definitions
