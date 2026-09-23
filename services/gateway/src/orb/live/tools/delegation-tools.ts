/**
 * VTID-04386 (Orchestrator v2, P3): voice delegation runs through the
 * dispatcher (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.4 pattern 3, §5 P3 exit).
 *
 * `operator_delegate` keeps its name, declaration and prompt (VTID-04310), but
 * no longer blocks a voice turn for up to 25 s: it goes through
 * `delegateToAgent('operator', …)`, which waits the 1.5 s voice ack window and
 * otherwise returns `working` with a job id. Two companion tools finish the
 * async pattern:
 *   - get_delegation_result(job_id?) — the result on a later turn (no id →
 *     the caller's latest job on this surface);
 *   - cancel_delegation(job_id?)    — "stop that".
 * Both are scoped by the dispatcher to the same user on the same surface.
 *
 * Role: the Command Hub is an exafy_admin surface, so a verified exafy_admin
 * session there is resolved as the developer role for policy — a statement
 * about the caller's context (like the surface itself), not a policy bypass.
 * Everywhere else the session's active role is used as is.
 */

import {
  cancelJob,
  delegateToAgent,
  getJob,
  listJobs,
  type DelegationCaller,
} from '../../../services/orchestrator/dispatcher';
import { registerDefaultDelegationTargets } from '../../../services/orchestrator/delegation-targets';
import { resolveOrbSurface } from '../surface';

export const GET_DELEGATION_RESULT_TOOL_NAME = 'get_delegation_result';
export const CANCEL_DELEGATION_TOOL_NAME = 'cancel_delegation';

const JOB_ID_PARAM = {
  type: 'string',
  description: 'The job_id a delegation returned. Omit it to use the most recent delegation in this session.',
};

export const GET_DELEGATION_RESULT_TOOL = {
  name: GET_DELEGATION_RESULT_TOOL_NAME,
  description: [
    'Check on work you handed to an agent (for example the Operator) that was still running.',
    'Call it when the user asks how it went, or on a later turn after you acknowledged a delegation.',
    'Returns running, succeeded (with the result), failed, or cancelled.',
  ].join(' '),
  parameters: { type: 'object', properties: { job_id: JOB_ID_PARAM } },
};

export const CANCEL_DELEGATION_TOOL = {
  name: CANCEL_DELEGATION_TOOL_NAME,
  description: 'Stop work you handed to an agent when the user says to stop or cancel it. Its result will not be reported.',
  parameters: { type: 'object', properties: { job_id: JOB_ID_PARAM } },
};

export const DELEGATION_COMPANION_TOOLS = [GET_DELEGATION_RESULT_TOOL, CANCEL_DELEGATION_TOOL];

export interface DelegationSession {
  sessionId: string;
  current_route?: string;
  operator_thread_id?: string;
  active_role?: string | null;
  identity?: { user_id?: string | null; exafy_admin?: boolean | null; tenant_id?: string | null; role?: string | null } | null;
}

export interface ToolResult { success: boolean; result: string; error?: string }

export function callerFromSession(session: DelegationSession): DelegationCaller {
  const surface = resolveOrbSurface({ currentRoute: session.current_route ?? null });
  const exafyAdmin = session.identity?.exafy_admin === true;
  const role = surface === 'command-hub' && exafyAdmin ? 'developer' : (session.active_role ?? null);
  return {
    user_id: session.identity?.user_id ?? null,
    tenant_id: session.identity?.tenant_id ?? null,
    platform_role: role,
    exafy_admin: exafyAdmin,
    surface,
    channel: 'voice',
    session_id: session.sessionId || null,
    extras: session.operator_thread_id ? { operator_thread_id: session.operator_thread_id } : undefined,
  };
}

function jobView(job: NonNullable<ReturnType<typeof getJob>>) {
  return {
    job_id: job.job_id,
    agent_id: job.agent_id,
    status: job.status,
    result: job.status === 'succeeded' ? job.result : null,
    error: job.status === 'failed' ? job.error : null,
  };
}

/** operator_delegate, now async via the dispatcher. */
export async function runOperatorDelegateAsync(session: DelegationSession, args: Record<string, unknown>): Promise<ToolResult> {
  registerDefaultDelegationTargets();
  const caller = callerFromSession(session);
  if (caller.surface !== 'command-hub') {
    return { success: false, result: '', error: 'operator_delegate is only available in the Command Hub' };
  }
  const request = typeof args.request === 'string' ? args.request : '';
  const r = await delegateToAgent('operator', request, caller);
  switch (r.status) {
    case 'done':
      return { success: true, result: JSON.stringify(r.result) };
    case 'working':
      return {
        success: true,
        result: JSON.stringify({
          status: 'working',
          job_id: r.job_id,
          note: 'The Operator is working on it. Tell the user briefly that it is handed over; call get_delegation_result with this job_id when they ask or on a later turn, and cancel_delegation if they want it stopped.',
        }),
      };
    case 'failed':
      return { success: false, result: '', error: `Operator turn failed: ${r.error}` };
    case 'escalate':
      return { success: true, result: JSON.stringify({ status: 'needs_confirmation', note: r.note, reason: r.policy.reason }) };
    default:
      return { success: false, result: '', error: r.error };
  }
}

function pickJob(session: DelegationSession, args: Record<string, unknown>) {
  const caller = callerFromSession(session);
  const id = typeof args.job_id === 'string' ? args.job_id.trim() : '';
  const job = id ? getJob(id, caller) : (listJobs(caller, 1)[0] ?? null);
  return { caller, job };
}

export function runGetDelegationResult(session: DelegationSession, args: Record<string, unknown>): ToolResult {
  const { job } = pickJob(session, args);
  if (!job) return { success: false, result: '', error: 'No delegation found in this session' };
  return { success: true, result: JSON.stringify(jobView(job)) };
}

export function runCancelDelegation(session: DelegationSession, args: Record<string, unknown>): ToolResult {
  const { caller, job } = pickJob(session, args);
  if (!job) return { success: false, result: '', error: 'No delegation found in this session' };
  const r = cancelJob(job.job_id, caller);
  if (!r.ok) return { success: false, result: '', error: r.error };
  return { success: true, result: JSON.stringify({ job_id: job.job_id, status: 'cancelled', note: 'Stopped. Its result will not be reported.' }) };
}
