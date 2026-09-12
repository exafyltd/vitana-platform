/**
 * VTID-03820: DeepSeek-powered execution on-ramp.
 *
 * Lets an operator (via the Operator Console chat, `autopilot_execute_task`
 * tool) turn an already-approved VTID's plan into a real Dev Autopilot
 * execution — writing code, opening a PR — with THIS invocation's LLM calls
 * forced onto DeepSeek (`deepseek-flash`), without touching the
 * `llm_routing_policy` stage the autonomous self-healing pipeline uses.
 *
 * Deliberately reuses the EXISTING, heavily-guarded machinery rather than
 * building a parallel execution path:
 *   - `approveAutoExecute()` (dev-autopilot-execute.ts) — runs the full
 *     safety gate (kill_switch, allow/deny scope, budget, concurrency,
 *     tests_missing, PR-flood guard) unchanged. This on-ramp does not
 *     re-implement or bypass any of it.
 *   - `EXECUTABLE_RECOMMENDATION_SOURCE_TYPES` — this file adds its own
 *     `operator_onramp` source_type there (a code-reviewed allowlist entry,
 *     per that file's own stated process), rather than reusing an existing
 *     scanner's identity.
 *   - The `find_similar_vtid_tasks`/embedding dedup from VTID-03819 is a
 *     separate concern (task INTAKE) and is not re-run here — this on-ramp
 *     acts on a VTID that already exists and is already approved.
 *
 * The override itself is threaded through metadata.llm_on_ramp_override on
 * the execution row (read by dev-autopilot-execute.ts's
 * extractLlmOnRampOverride()) — never a global routing-policy change, so
 * the self-healing pipeline's own executions (which never set this field)
 * are provably unaffected.
 *
 * Two governance gates specific to THIS on-ramp (neither exists inside the
 * reused machinery, since it was built for scanner-originated findings, not
 * operator-originated ones):
 *   1. `OPERATOR_EXECUTION_ONRAMP_ENABLED` kill switch — defaults OFF. This
 *      is genuinely new capability (an operator causing a real PR via a
 *      chat command); shipping it default-off until observed against real
 *      traffic matches this platform's own standing practice for new
 *      autonomy surfaces (e.g. VTID-03706's full-duplex voice).
 *   2. The target VTID must have `spec_status='approved'` and not be
 *      terminal — "never execute without approval" (this platform's own
 *      standing rule), enforced here explicitly because the Dev Autopilot
 *      pipeline itself has no spec_status gate (that gate normally lives on
 *      the unrelated generic VTID-lifecycle-start route).
 */

import { createHash, randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import type { CicdEventType } from '../types/cicd';
import { approveAutoExecute, getSupabase, supa, type SupaConfig } from './dev-autopilot-execute';

const VTID = 'VTID-03820';
const ONRAMP_SOURCE_TYPE = 'operator_onramp';
const DEEPSEEK_MODEL = 'deepseek-flash';

export interface TriggerOperatorExecutionInput {
  /** The already-allocated, already-approved VTID to execute. */
  vtid: string;
  /** Plan content — what to change and why. Not auto-derived; the caller
   *  (operator or the model composing the tool call) supplies it, same as
   *  a human filling in a plan before clicking Activate. */
  planMarkdown: string;
  /** Files the plan touches, source AND paired test files. The existing
   *  safety gate's tests_missing rule (unchanged) will reject a list
   *  missing test coverage — this on-ramp does not pre-derive or paper
   *  over that check. */
  filesReferenced: string[];
  /** Who asked for this — logged on the execution row and OASIS event. */
  requestedBy: string;
}

export type TriggerOperatorExecutionResult =
  | { ok: true; execution_id: string; finding_id: string }
  | { ok: false; error: string; violations?: unknown[] };

function isOnRampEnabled(): boolean {
  return process.env.OPERATOR_EXECUTION_ONRAMP_ENABLED === 'true';
}

/**
 * Split out for testability — real DB call, no side effects beyond the read.
 */
async function loadVtidGovernanceState(
  s: SupaConfig,
  vtid: string
): Promise<{ ok: true; spec_status: string | null; is_terminal: boolean } | { ok: false; error: string }> {
  const r = await supa<Array<{ spec_status: string | null; is_terminal: boolean | null }>>(
    s,
    `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&select=spec_status,is_terminal&limit=1`
  );
  if (!r.ok || !r.data || r.data.length === 0) {
    return { ok: false, error: `vtid_ledger row not found for ${vtid}` };
  }
  return { ok: true, spec_status: r.data[0].spec_status, is_terminal: r.data[0].is_terminal === true };
}

export async function triggerOperatorExecution(
  input: TriggerOperatorExecutionInput
): Promise<TriggerOperatorExecutionResult> {
  if (!isOnRampEnabled()) {
    return { ok: false, error: 'operator_execution_onramp_disabled: OPERATOR_EXECUTION_ONRAMP_ENABLED is not "true"' };
  }

  const s = getSupabase();
  if (!s) {
    return { ok: false, error: 'supabase_not_configured' };
  }

  if (!input.planMarkdown || input.planMarkdown.trim().length === 0) {
    return { ok: false, error: 'planMarkdown is required' };
  }
  if (!Array.isArray(input.filesReferenced) || input.filesReferenced.length === 0) {
    return { ok: false, error: 'filesReferenced is required and must be non-empty' };
  }

  // Governance gate 1: the target VTID must already be approved. The Dev
  // Autopilot pipeline itself has no spec_status check (see module doc) —
  // this on-ramp is the one place that enforces it for operator-triggered
  // execution.
  const gov = await loadVtidGovernanceState(s, input.vtid);
  if (!gov.ok) {
    return { ok: false, error: gov.error };
  }
  if (gov.is_terminal) {
    return { ok: false, error: `${input.vtid} is already terminal — nothing to execute` };
  }
  if (gov.spec_status !== 'approved') {
    return { ok: false, error: `${input.vtid} spec_status is '${gov.spec_status ?? 'null'}', not 'approved' — cannot execute` };
  }

  const specHash = createHash('sha256').update(input.planMarkdown).digest('hex');
  const title = `Operator on-ramp: ${input.vtid}`;

  const recBody = {
    title,
    summary: input.planMarkdown.slice(0, 1000),
    domain: 'general',
    risk_level: 'medium',
    impact_score: 5,
    effort_score: 4,
    source_type: ONRAMP_SOURCE_TYPE,
    risk_class: 'medium',
    auto_exec_eligible: false,
    status: 'new',
    activated_vtid: input.vtid,
    spec_snapshot: {
      scanner: 'operator-onramp',
      vtid: input.vtid,
      spec_markdown: input.planMarkdown,
      files_referenced: input.filesReferenced,
      requested_by: input.requestedBy,
    },
    spec_checksum: specHash,
  };

  const recResp = await fetch(`${s.url}/rest/v1/autopilot_recommendations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: s.key,
      Authorization: `Bearer ${s.key}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(recBody),
  });
  if (!recResp.ok) {
    const errText = await recResp.text();
    return { ok: false, error: `autopilot_recommendations insert failed: ${recResp.status} ${errText.slice(0, 300)}` };
  }
  const recRows = (await recResp.json()) as Array<{ id: string }>;
  if (!recRows || recRows.length === 0) {
    return { ok: false, error: 'autopilot_recommendations insert returned no row' };
  }
  const findingId = recRows[0].id;

  const planResp = await fetch(`${s.url}/rest/v1/dev_autopilot_plan_versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: s.key,
      Authorization: `Bearer ${s.key}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      finding_id: findingId,
      version: 1,
      plan_markdown: input.planMarkdown,
      files_referenced: input.filesReferenced,
    }),
  });
  if (!planResp.ok) {
    const errText = await planResp.text();
    return { ok: false, error: `dev_autopilot_plan_versions insert failed: ${planResp.status} ${errText.slice(0, 300)}` };
  }

  // Governance gate 2 (reused, not reimplemented): approveAutoExecute runs
  // the full existing safety gate. approved_by is set, so a rejection is
  // returned synchronously here — never silently snoozed the way an
  // unattended autoApproveTick call would be.
  const approval = await approveAutoExecute({ finding_id: findingId, approved_by: input.requestedBy });
  if (!approval.ok || !approval.execution) {
    return { ok: false, error: approval.error || 'approval failed', violations: approval.decision?.violations };
  }
  const executionId = approval.execution.id;

  // One PATCH sets the DeepSeek override AND fast-forwards execute_after —
  // deliberately combined so there is no window where a background tick
  // could pick up this execution before the override metadata is attached.
  await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${executionId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      execute_after: new Date().toISOString(),
      metadata: {
        llm_on_ramp: 'deepseek',
        llm_on_ramp_override: { provider: 'deepseek', model: DEEPSEEK_MODEL },
        triggered_by: input.requestedBy,
        source: 'operator-onramp',
      },
    }),
  });

  await emitOasisEvent({
    vtid: input.vtid,
    type: 'operator.execution_onramp.triggered' as CicdEventType,
    source: 'operator-execution-onramp',
    status: 'success',
    message: `Operator on-ramp queued DeepSeek-powered execution ${executionId.slice(0, 8)} for ${input.vtid}`,
    payload: {
      execution_id: executionId,
      finding_id: findingId,
      vtid: input.vtid,
      requested_by: input.requestedBy,
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      correlation_id: randomUUID(),
    },
  }).catch((err: any) => console.warn(`[${VTID}] Failed to log execution_onramp.triggered:`, err.message));

  return { ok: true, execution_id: executionId, finding_id: findingId };
}
