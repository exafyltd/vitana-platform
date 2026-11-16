/**
 * Dispatch to the implementation agent for CHANGES_REQUESTED remediation.
 * Fails closed: a throw, a timeout, an unparseable head, or a "fix" that returns
 * the same head all count as a failed remediation, which escalates the cycle.
 * The agent itself is injected; the live agent interface is not part of this module.
 */
export interface RemediationRequest {
  correlationId: string;
  mr_iid: number;
  head_sha: string;
  findings: unknown[];
}
export interface ImplementationAgent {
  dispatch(req: RemediationRequest, signal: AbortSignal): Promise<{ ok: true; new_head_sha: string } | { ok: false; error: string }>;
}
export type RemediateFn = (head: string, findings: unknown[], correlationId: string) => Promise<{ ok: true; newHead: string } | { ok: false; error: string }>;

export function failClosedRemediation(agent: ImplementationAgent, timeoutMs: number, mrIid: number): RemediateFn {
  return async (head, findings, correlationId) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await Promise.race([
        agent.dispatch({ correlationId, mr_iid: mrIid, head_sha: head, findings }, controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')))),
      ]);
      if (!r.ok) return { ok: false, error: `implementation agent: ${r.error}` };
      if (!/^[0-9a-f]{40}$/.test(r.new_head_sha)) return { ok: false, error: 'implementation agent returned no valid head' };
      if (r.new_head_sha === head) return { ok: false, error: 'implementation agent returned the same head: nothing was fixed' };
      return { ok: true, newHead: r.new_head_sha };
    } catch (e) {
      return { ok: false, error: `implementation agent unavailable: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  };
}
