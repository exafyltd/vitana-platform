/**
 * Operator Planner (VTID-03902)
 *
 * Closes a real gap found while testing the Command Hub Operator Console:
 * `autopilot_create_task` (operator-service.ts's `createOperatorTask`) mints
 * a VTID and leaves it at `status='scheduled'`/`spec_status='missing'` with
 * a comment saying "planner agents will pick it up" — but no such consumer
 * exists anywhere in this codebase. `GET /api/v1/autopilot/tasks/pending-plan`
 * (VTID-0532) has exactly one caller in the whole repo: its own test. Every
 * task created via Operator chat was therefore permanently stranded unless a
 * human drove it forward by hand. Confirmed live against VTID-03900
 * (2026-09-15): zero rows in `oasis_specs`, no state change since creation.
 *
 * This is deliberately NOT the same thing as the autonomous execution plane
 * (worker-runner, `isAutonomousExecutionTask()`, VTID-03516). That gate
 * exists to stop a background worker from writing code / opening a PR
 * against a VTID a session or human is concurrently working — a real
 * incident already happened there. Generating a *draft spec* is a much
 * lower-risk, read-mostly action (one LLM call, one `oasis_specs` insert,
 * `spec_status` stops at 'draft') that never touches code and never opens a
 * PR, so this planner is scoped narrowly to `metadata.source ===
 * 'operator-chat'` tasks only — it never looks at, claims, or races against
 * anything the autonomous plane or a session owns. `autopilot_execute_task`
 * still requires an authenticated exafy_admin and a human-approved spec, so
 * this does not create a new path to code execution; it only makes the
 * existing "create task -> review -> approve -> execute" loop reachable at
 * all instead of dead-ending at step 1.
 *
 * Reuses the existing, already-governed spec pipeline
 * (`POST /api/v1/specs/:vtid/generate` — VTID-01188, Bedrock Claude via
 * `generateSpecWithLLM`) via the same internal self-fetch pattern
 * `executeDevGenerateSpec` (gemini-operator.ts) already uses for the
 * `dev_generate_spec` chat tool, rather than reimplementing spec generation.
 *
 * Gated OFF by default via OPERATOR_PLANNER_ENABLED — shipping this code
 * must not silently start mutating the ledger the moment it deploys.
 */

import fetch from 'node-fetch';
import { emitOasisEvent } from './oasis-event-service';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

export function isOperatorPlannerEnabled(): boolean {
  return process.env.OPERATOR_PLANNER_ENABLED === 'true';
}

interface PlannableTask {
  vtid: string;
  title: string;
  summary: string | null;
}

/**
 * Find operator-chat-created tasks that are waiting for a spec.
 *
 * Scope, deliberately narrow:
 * - metadata->>source = 'operator-chat' (never touches self-healing /
 *   autonomous-execution rows — those are a different plane, VTID-03516)
 * - status = scheduled (still just sitting in the intake queue)
 * - spec_status = missing (never attempted, or the ledger was reset) — a
 *   task whose one attempt already failed has spec_last_error set and is
 *   left alone rather than retried forever; a human can retry it via the
 *   existing dev_generate_spec chat tool.
 */
export async function findPlannableOperatorTasks(limit = 20): Promise<PlannableTask[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-03902] Supabase not configured, returning no plannable tasks');
    return [];
  }

  const url =
    `${SUPABASE_URL}/rest/v1/vtid_ledger` +
    `?select=vtid,title,summary` +
    `&status=eq.scheduled` +
    `&spec_status=eq.missing` +
    `&spec_last_error=is.null` +
    `&metadata->>source=eq.operator-chat` +
    `&order=created_at.asc` +
    `&limit=${limit}`;

  try {
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-03902] Query for plannable tasks failed: ${resp.status} - ${text}`);
      return [];
    }

    return (await resp.json()) as PlannableTask[];
  } catch (error: any) {
    console.warn(`[VTID-03902] Query for plannable tasks errored: ${error.message}`);
    return [];
  }
}

/**
 * Generate a draft spec for one VTID via the existing, already-governed
 * spec pipeline. Mirrors executeDevGenerateSpec's internal self-fetch
 * pattern exactly (gemini-operator.ts) rather than reimplementing it.
 */
export async function generateSpecForTask(task: PlannableTask): Promise<{ ok: boolean; error?: string }> {
  const gatewayPort = process.env.PORT || '8080';

  try {
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/specs/${task.vtid}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE || '',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE || ''}`,
      },
      body: JSON.stringify({
        seed_notes: task.summary || task.title,
        source: 'operator-planner',
      }),
    });

    const result = (await resp.json().catch(() => ({}))) as any;

    if (!resp.ok || !result.ok) {
      return { ok: false, error: result.error || result.message || `HTTP ${resp.status}` };
    }

    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

/**
 * One planning pass: find plannable operator-chat tasks and generate a
 * draft spec for each. Returns a summary for logging/testing — never
 * throws, matching this codebase's other background-loop conventions
 * (autopilot-event-loop.ts's runLoopIteration).
 *
 * Per the OASIS event taxonomy ("polling ≠ progress"), this function does
 * NOT emit an event for finding zero tasks or for the sweep itself — only
 * for a real state transition, and `POST /api/v1/specs/:vtid/generate`
 * already emits vtid.spec.generate.requested/completed for that. A single
 * summary event is emitted only when at least one task was processed, so a
 * quiet sweep produces no OASIS noise.
 */
export async function runOperatorPlannerOnce(): Promise<{
  found: number;
  generated: number;
  failed: number;
  results: Array<{ vtid: string; ok: boolean; error?: string }>;
}> {
  const tasks = await findPlannableOperatorTasks();
  const results: Array<{ vtid: string; ok: boolean; error?: string }> = [];

  for (const task of tasks) {
    const outcome = await generateSpecForTask(task);
    results.push({ vtid: task.vtid, ok: outcome.ok, error: outcome.error });
    if (!outcome.ok) {
      console.warn(`[VTID-03902] Spec generation failed for ${task.vtid}: ${outcome.error}`);
    }
  }

  const generated = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;

  if (results.length > 0) {
    await emitOasisEvent({
      vtid: 'VTID-03902',
      type: 'operator.planner.sweep_completed',
      source: 'operator-planner',
      status: failed > 0 ? 'warning' : 'success',
      message: `Operator planner: ${generated} spec(s) generated, ${failed} failed, out of ${results.length} candidate task(s)`,
      payload: { results },
      // VTID-03927: 'operator.planner.sweep_completed' matches none of
      // inferTaskStageFromType()'s keyword patterns (it only recognizes
      // 'recommendation'/'autopilot.intent'/'task.intake'/etc. for PLANNER),
      // and emitOasisEvent() never writes a `kind`/`title` column for the
      // stage-mapping fallback matcher to fall back on either — so this
      // event was invisible in every VTID-03902 stage timeline view.
      // Explicit here since it's a planning-phase summary by definition.
      task_stage: 'PLANNER',
    }).catch(err => console.warn('[VTID-03902] Failed to log planner sweep event:', err.message));
  }

  return { found: tasks.length, generated, failed, results };
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the recurring planner sweep, gated by OPERATOR_PLANNER_ENABLED.
 * Mirrors autopilot-event-loop.ts's initializeEventLoop() wiring: called
 * once at gateway boot, a no-op when the flag is off.
 */
export async function initializeOperatorPlanner(): Promise<void> {
  if (!isOperatorPlannerEnabled()) {
    console.log('[VTID-03902] Operator planner disabled (OPERATOR_PLANNER_ENABLED != "true")');
    return;
  }

  if (intervalHandle) {
    return; // already running
  }

  const intervalMs = Number(process.env.OPERATOR_PLANNER_INTERVAL_MS) || 5 * 60 * 1000;

  console.log(`[VTID-03902] Operator planner starting, interval=${intervalMs}ms`);

  // Run once immediately, then on the interval — matches the "don't wait a
  // full cycle to see it work" expectation from the same investigation
  // this planner exists to close.
  runOperatorPlannerOnce().catch(err => console.warn('[VTID-03902] Initial planner sweep failed:', err.message));

  intervalHandle = setInterval(() => {
    runOperatorPlannerOnce().catch(err => console.warn('[VTID-03902] Planner sweep failed:', err.message));
  }, intervalMs);
  intervalHandle.unref?.();
}

export function stopOperatorPlanner(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
