/**
 * VTID-03851 — caller authentication for the Operator Console execution
 * on-ramp (`autopilot_execute_task`).
 *
 * Background: `POST /api/v1/operator/chat` is mounted without auth
 * middleware and, observed on staging 2026-09-13, accepted a request with
 * no Authorization header at all — while `autopilot_execute_task`
 * (VTID-03820) queues a real code execution that opens a pull request
 * against this repo. With OPERATOR_EXECUTION_ONRAMP_ENABLED live on
 * staging, a write-capable path was reachable anonymously.
 *
 * This module answers exactly one question at tool-execution time: was the
 * request that is driving this thread carried by a verified JWT whose
 * identity is an exafy_admin? It is deliberately a separate map from
 * gemini-operator.ts's threadIdentityMap so attaching it to the operator
 * route changes nothing about how the community/memory tools resolve
 * identity.
 *
 * Threat model note — threadId is CLIENT-SUPPLIED. A marker that lived
 * for a window (like threadIdentityMap's 30-minute auto-cleanup) could be
 * inherited by an unauthenticated request that reuses an admin's threadId.
 * So the route MUST call setThreadAuth() or clearThreadAuth() on every
 * request, before the LLM turn; the tool then reads the marker the SAME
 * request wrote (processWithGemini awaits tool execution synchronously
 * within the request). A stale-window timeout exists only as a memory
 * backstop, never as the authorization boundary.
 */

export interface ThreadAuth {
  user_id: string;
  exafy_admin: boolean;
}

export type ExecuteTaskAuthz =
  | { ok: true }
  | { ok: false; reason: 'unauthenticated' | 'not_admin' };

const THREAD_AUTH_TTL_MS = 30 * 60 * 1000;
const threadAuthMap = new Map<string, { auth: ThreadAuth; timer: ReturnType<typeof setTimeout> }>();

/** Record the verified caller for a thread — call once per request, before the LLM turn. */
export function setThreadAuth(threadId: string, auth: ThreadAuth): void {
  clearThreadAuth(threadId);
  const timer = setTimeout(() => threadAuthMap.delete(threadId), THREAD_AUTH_TTL_MS);
  // Never keep the process alive for a bookkeeping timer.
  (timer as { unref?: () => void }).unref?.();
  threadAuthMap.set(threadId, { auth: { user_id: auth.user_id, exafy_admin: auth.exafy_admin === true }, timer });
}

/** Forget the caller for a thread — call on every request that carries NO verified identity. */
export function clearThreadAuth(threadId: string): void {
  const entry = threadAuthMap.get(threadId);
  if (entry) {
    clearTimeout(entry.timer);
    threadAuthMap.delete(threadId);
  }
}

export function getThreadAuth(threadId: string): ThreadAuth | undefined {
  return threadAuthMap.get(threadId)?.auth;
}

/**
 * Pure predicate: may this caller queue an execution?
 * Requires a verified user_id AND exafy_admin === true. Anything else —
 * no marker, an empty user_id, a non-admin — is refused with a named reason.
 */
export function isExecuteTaskAuthorized(auth: ThreadAuth | undefined): ExecuteTaskAuthz {
  if (!auth || typeof auth.user_id !== 'string' || auth.user_id.length === 0) {
    return { ok: false, reason: 'unauthenticated' };
  }
  if (auth.exafy_admin !== true) {
    return { ok: false, reason: 'not_admin' };
  }
  return { ok: true };
}

/** User-facing (operator-facing) explanation for a refusal; not spoken by Vitana, never translated. */
export function describeExecuteTaskRefusal(reason: 'unauthenticated' | 'not_admin'): string {
  return reason === 'unauthenticated'
    ? 'autopilot_execute_task requires an authenticated session: the Operator Console request carried no valid Authorization bearer token, so no execution was queued (VTID-03851).'
    : 'autopilot_execute_task requires an exafy_admin session: the caller is authenticated but not an exafy admin, so no execution was queued (VTID-03851).';
}
