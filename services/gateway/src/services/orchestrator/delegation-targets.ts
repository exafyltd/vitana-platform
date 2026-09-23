/**
 * VTID-04375 (Orchestrator v2, P3): the agents `delegate_to_agent` can reach.
 *
 * One entry per agent. Adding a specialist is adding an entry here with its
 * surfaces, policy domain/tier and a `run` adapter — the dispatcher does the
 * surface check, the policy check, the async job and the isolation.
 *
 * First target: the Vitana Operator (VTID-04310's operator_delegate), same
 * turn, thread, exafy_admin execution gate and approval hold. The dispatcher
 * now owns the waiting, so the adapter waits for the turn to finish.
 */

import { registerDelegationTarget, type DelegationTarget } from './dispatcher';
import { isSupportSpecialistEnabled, SUPPORT_TARGET } from './support-specialist';

/** Upper bound for one operator turn run as a delegated job. */
export const OPERATOR_JOB_MAX_MS = 5 * 60 * 1000;

export const OPERATOR_TARGET: DelegationTarget = {
  agent_id: 'operator',
  description: 'The Vitana Operator (developer agent): queues and reviews code tasks, looks up VTIDs, executions and platform state. Code changes always wait for human approval.',
  surfaces: ['command-hub'],
  domain: 'dev',
  // Delegating asks the Operator to act; the Operator's own executions keep
  // their exafy_admin gate and approval hold (VTID-03851 / W4e).
  tier: 'draft',
  async run(request, caller) {
    const { runOperatorDelegate } = await import('../../orb/live/tools/operator-delegate');
    const out = await runOperatorDelegate(
      {
        sessionId: caller.session_id ?? '',
        current_route: '/command-hub',
        operator_thread_id: typeof caller.extras?.operator_thread_id === 'string' ? caller.extras.operator_thread_id : undefined,
        identity: { user_id: caller.user_id, exafy_admin: caller.exafy_admin, tenant_id: caller.tenant_id },
      },
      { request },
      { waitMs: OPERATOR_JOB_MAX_MS },
    );
    if (!out.success) return { ok: false, result: null, error: out.error ?? 'operator turn failed' };
    let parsed: unknown = out.result;
    try { parsed = JSON.parse(out.result); } catch { /* keep the string */ }
    return { ok: true, result: parsed };
  },
};

let registered = false;
export function registerDefaultDelegationTargets(): void {
  if (registered) return;
  registered = true;
  registerDelegationTarget(OPERATOR_TARGET);
  // VTID-04397: the member-side support specialist, only when switched on.
  if (isSupportSpecialistEnabled()) registerDelegationTarget(SUPPORT_TARGET);
}

/** Test helper. */
export function resetDefaultRegistration(): void {
  registered = false;
}
