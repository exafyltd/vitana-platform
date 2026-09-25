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
  findJob,
  latestJob,
  type DelegationCaller,
} from '../../../services/orchestrator/dispatcher';
import { registerDefaultDelegationTargets } from '../../../services/orchestrator/delegation-targets';
import { isSupportSpecialistEnabled, SUPPORT_SPECIALIST_AGENT_ID } from '../../../services/orchestrator/support-specialist';
import {
  COMMERCE_SPECIALIST_AGENT_ID,
  defaultCommerceDeps,
  isCommerceSpecialistEnabled,
  membershipsToOrgContext,
  type CommerceMembership,
} from '../../../services/orchestrator/commerce-specialist';
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

/**
 * VTID-04397: the member ORB's support specialist (agent-as-tool). Declared
 * only on the member surface, only when ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED
 * is 'true'. The specialist returns findings; Vitana answers in her own words.
 */
export const ASK_SUPPORT_SPECIALIST_TOOL_NAME = 'ask_support_specialist';
export const ASK_SUPPORT_SPECIALIST_TOOL = {
  name: ASK_SUPPORT_SPECIALIST_TOOL_NAME,
  description: [
    "Ask the support specialist about the member's own support tickets and bug reports (status, what happened, whether it is fixed)",
    'or a how-do-I / account question the knowledge base answers. It looks things up and returns findings; it changes nothing.',
    'Answer the member from the findings in your own words. If it is still working, say briefly that you are checking,',
    'then call get_delegation_result on a later turn. To report a NEW problem use report_to_specialist instead.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: { question: { type: 'string', description: "The member's question, restated clearly (include any ticket number they mentioned)." } },
    required: ['question'],
  },
};

/** The member-surface delegation tools, or none when the specialist is off. */
export function memberDelegationTools(env: NodeJS.ProcessEnv = process.env): object[] {
  return isSupportSpecialistEnabled(env) ? [ASK_SUPPORT_SPECIALIST_TOOL, ...DELEGATION_COMPANION_TOOLS] : [];
}

/**
 * VTID-04400: the business ORB's commerce onboarding specialist. Declared
 * only on the commerce surface, only when ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED
 * is 'true'.
 */
export const ASK_COMMERCE_SPECIALIST_TOOL_NAME = 'ask_commerce_specialist';
export const ASK_COMMERCE_SPECIALIST_TOOL = {
  name: ASK_COMMERCE_SPECIALIST_TOOL_NAME,
  description: [
    "Ask the commerce specialist about the user's own business on Vitana: whether the organization is still in review or active,",
    'who is on the team, pending invites, whether a health organization is connected for orders, or how onboarding works.',
    'It looks things up and returns findings; it changes nothing. Answer from the findings in your own words.',
    'If it is still working, say briefly that you are checking, then call get_delegation_result on a later turn.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: { question: { type: 'string', description: "The user's question, restated clearly (include the organization name if they gave one)." } },
    required: ['question'],
  },
};

/** The commerce-surface delegation tools, or none when the specialist is off. */
export function commerceDelegationTools(env: NodeJS.ProcessEnv = process.env): object[] {
  return isCommerceSpecialistEnabled(env) ? [ASK_COMMERCE_SPECIALIST_TOOL, ...DELEGATION_COMPANION_TOOLS] : [];
}

export interface DelegationSession {
  sessionId: string;
  current_route?: string;
  operator_thread_id?: string;
  active_role?: string | null;
  identity?: { user_id?: string | null; exafy_admin?: boolean | null; tenant_id?: string | null; role?: string | null } | null;
  assistantProfile?: { surface: import('../surface').OrbSurface };
}

export interface ToolResult { success: boolean; result: string; error?: string }

export function callerFromSession(session: DelegationSession): DelegationCaller {
  // VTID-04560: the session's resolved profile when it has one.
  const surface = session.assistantProfile ? session.assistantProfile.surface : resolveOrbSurface({ currentRoute: session.current_route ?? null });
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

/**
 * Voice ack window for the read-only specialists (VTID-04485). The dispatcher's
 * 1.5 s voice default suits a hand-off; a specialist answer measured 3.0 s live
 * on staging, so at 1.5 s the member only ever heard "I'm checking". Waiting a
 * little longer lets the answer land in the same turn. Env-tunable, clamped.
 */
export const SPECIALIST_VOICE_ACK_DEFAULT_MS = 4_500;
export function specialistAckWindowMs(channel: string): number | undefined {
  if (channel !== 'voice') return undefined;
  const raw = Number(process.env.ORCHESTRATOR_SPECIALIST_VOICE_ACK_MS);
  if (!Number.isFinite(raw) || raw <= 0) return SPECIALIST_VOICE_ACK_DEFAULT_MS;
  return Math.min(8_000, Math.max(1_500, Math.round(raw)));
}

/** ask_support_specialist, through the dispatcher (voice ack window: specialistAckWindowMs). */
export async function runAskSupportSpecialist(session: DelegationSession, args: Record<string, unknown>): Promise<ToolResult> {
  if (!isSupportSpecialistEnabled()) {
    return { success: false, result: '', error: 'the support specialist is not enabled' };
  }
  registerDefaultDelegationTargets();
  const caller = callerFromSession(session);
  const question = typeof args.question === 'string' ? args.question : typeof args.request === 'string' ? args.request : '';
  const r = await delegateToAgent(SUPPORT_SPECIALIST_AGENT_ID, question, caller, { ackWindowMs: specialistAckWindowMs(caller.channel) });
  switch (r.status) {
    case 'done':
      return { success: true, result: JSON.stringify(r.result) };
    case 'working':
      return {
        success: true,
        result: JSON.stringify({
          status: 'working',
          job_id: r.job_id,
          note: 'The support specialist is still looking it up. Tell the member briefly that you are checking; call get_delegation_result with this job_id on a later turn or when they ask.',
        }),
      };
    case 'failed':
      return { success: false, result: '', error: `Support specialist failed: ${r.error}` };
    case 'escalate':
      return { success: true, result: JSON.stringify({ status: 'needs_confirmation', note: r.note, reason: r.policy.reason }) };
    default:
      return { success: false, result: '', error: r.error };
  }
}

/**
 * ask_commerce_specialist, through the dispatcher. Commerce authority comes
 * from organization membership, so the caller's memberships are loaded
 * first and handed to the policy; none → the dispatcher refuses.
 */
export async function runAskCommerceSpecialist(
  session: DelegationSession,
  args: Record<string, unknown>,
  loadMemberships: (userId: string) => Promise<CommerceMembership[]> = defaultCommerceDeps.listMemberships,
): Promise<ToolResult> {
  if (!isCommerceSpecialistEnabled()) {
    return { success: false, result: '', error: 'the commerce specialist is not enabled' };
  }
  registerDefaultDelegationTargets();
  const caller = callerFromSession(session);
  if (caller.user_id) {
    try {
      caller.orgs = membershipsToOrgContext(await loadMemberships(caller.user_id));
    } catch (e) {
      return { success: false, result: '', error: `could not read the user's organizations: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const question = typeof args.question === 'string' ? args.question : typeof args.request === 'string' ? args.request : '';
  const r = await delegateToAgent(COMMERCE_SPECIALIST_AGENT_ID, question, caller, { ackWindowMs: specialistAckWindowMs(caller.channel) });
  switch (r.status) {
    case 'done':
      return { success: true, result: JSON.stringify(r.result) };
    case 'working':
      return {
        success: true,
        result: JSON.stringify({
          status: 'working',
          job_id: r.job_id,
          note: 'The commerce specialist is still looking it up. Tell the user briefly that you are checking; call get_delegation_result with this job_id on a later turn or when they ask.',
        }),
      };
    case 'failed':
      return { success: false, result: '', error: `Commerce specialist failed: ${r.error}` };
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

/**
 * VTID-04415: reading a result may also look in the run ledger, so a result
 * produced for an earlier session on another gateway task is still found.
 */
export async function runGetDelegationResult(session: DelegationSession, args: Record<string, unknown>): Promise<ToolResult> {
  const caller = callerFromSession(session);
  const id = typeof args.job_id === 'string' ? args.job_id.trim() : '';
  const job = id ? await findJob(id, caller) : await latestJob(caller);
  if (!job) return { success: false, result: '', error: 'No delegation found in this session' };
  return { success: true, result: JSON.stringify(jobView(job)) };
}

/** Cancel stays local: a job running on another task cannot be stopped from here. */
export function runCancelDelegation(session: DelegationSession, args: Record<string, unknown>): ToolResult {
  const { caller, job } = pickJob(session, args);
  if (!job) return { success: false, result: '', error: 'No delegation found in this session' };
  const r = cancelJob(job.job_id, caller);
  if (!r.ok) return { success: false, result: '', error: r.error };
  return { success: true, result: JSON.stringify({ job_id: job.job_id, status: 'cancelled', note: 'Stopped. Its result will not be reported.' }) };
}
