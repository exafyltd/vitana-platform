/**
 * VTID-04310 — Command Hub voice hands work to the Operator.
 *
 * Before this, the Command Hub developer voice assistant had its own task
 * tools (dev_create_task / dev_allocate_vtid / dev_execute_vtid) that called
 * the legacy /api/v1/vtid/create and worker-orchestrator endpoints without
 * forwarding any auth, and never reached the Operator on-ramp — so a task
 * agreed by voice could not go through the approval hold, the agent
 * executor, or the Operator Console at all.
 *
 * Now there is one path. `operator_delegate(request)` runs the SAME turn the
 * Operator Console runs (routes/operator.ts runOperatorChatTurn): same
 * thread (the console thread the voice session is bound to, VTID-04309),
 * same model and tools (autopilot_run_task, review/approve, read tools), same
 * exafy_admin gate on execution (VTID-03851, set from the voice session's
 * verified JWT identity), same approval hold, and the turn is recorded in
 * the thread so it shows in the console. The voice model then tells the
 * user what the Operator did.
 *
 * Voice tool calls cannot wait minutes, so the turn is awaited for a bounded
 * time; if it is still running, the tool says so and the result lands in
 * the console thread when it finishes.
 */
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { resolveOrbSurface } from '../surface';

export const OPERATOR_DELEGATE_TOOL_NAME = 'operator_delegate';

export const OPERATOR_DELEGATE_TOOL = {
  name: OPERATOR_DELEGATE_TOOL_NAME,
  description: [
    'Hand a request to the Vitana Operator — the developer agent behind the Command Hub Operator Console.',
    'Use it whenever the user wants something DONE on the platform: start or queue a task, fix a bug, change code,',
    'check or approve/reject a held execution, look up task status, or investigate something that needs the',
    "Operator's tools. Pass the user's request in their own words plus any detail agreed in this conversation.",
    'The Operator allocates a VTID itself and every code change waits for human approval before a PR opens.',
    'Confirm with the user before delegating work that changes code. After the call, tell the user briefly',
    'what the Operator did or that it is still working; the full exchange is in the Operator Console thread.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'The request for the Operator, self-contained: what to do, where, and any constraints agreed in the conversation.',
      },
    },
    required: ['request'],
  },
};

export const DEFAULT_DELEGATE_WAIT_MS = 25_000;
const REPLY_MAX_CHARS = 1_500;

export interface DelegateSession {
  sessionId: string;
  current_route?: string;
  operator_thread_id?: string;
  identity?: { user_id?: string | null; exafy_admin?: boolean | null; tenant_id?: string | null } | null;
}

export type RunTurn = (
  req: Request,
  opts: { threadId?: string; channel?: string },
) => Promise<{ status: number; body: Record<string, unknown> }>;

export interface DelegateResult { success: boolean; result: string; error?: string }

function summarizeOutcome(body: Record<string, unknown>): string {
  const reply = typeof body.reply === 'string' ? body.reply : '';
  const tools = Array.isArray(body.toolResults) ? (body.toolResults as Array<{ name?: string; response?: Record<string, unknown> }>) : [];
  const executions = tools
    .map((t) => t?.response || {})
    .filter((r) => typeof r.execution_id === 'string')
    .map((r) => ({ execution_id: r.execution_id, vtid: r.vtid ?? null, status: r.status ?? null }));
  return JSON.stringify({
    operator_reply: reply.length > REPLY_MAX_CHARS ? `${reply.slice(0, REPLY_MAX_CHARS)}…` : reply,
    tools_used: tools.map((t) => t?.name).filter(Boolean),
    executions,
    thread_id: body.threadId ?? null,
    note: 'Summarize this for the user in one or two spoken sentences. The full exchange is in the Operator Console thread.',
  });
}

export async function runOperatorDelegate(
  session: DelegateSession,
  args: Record<string, unknown>,
  deps: { runTurn?: RunTurn; waitMs?: number } = {},
): Promise<DelegateResult> {
  if (resolveOrbSurface({ currentRoute: session.current_route ?? null }) !== 'command-hub') {
    return { success: false, result: '', error: 'operator_delegate is only available in the Command Hub' };
  }
  const identity = session.identity;
  if (!identity?.user_id) {
    return { success: false, result: '', error: 'Sign in to the Command Hub to hand work to the Operator' };
  }
  const request = typeof args.request === 'string' ? args.request.trim() : '';
  if (!request) return { success: false, result: '', error: 'request is required' };

  const runTurn: RunTurn = deps.runTurn
    ?? (async (req, opts) => (await import('../../../routes/operator')).runOperatorChatTurn(req, opts));
  const threadId = session.operator_thread_id || randomUUID();
  // The Operator turn reads the verified identity exactly as POST /chat does
  // (optionalAuth sets req.identity from the JWT); here it is the identity
  // the voice session verified at start. exafy_admin decides whether the
  // Operator may queue an execution — the gate itself is unchanged.
  const req = {
    body: { message: request.slice(0, 4_000), threadId },
    identity,
    headers: {},
  } as unknown as Request;

  const turn = runTurn(req, { threadId, channel: 'voice_delegate' });
  const waitMs = deps.waitMs ?? DEFAULT_DELEGATE_WAIT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), waitMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const outcome = await Promise.race([turn, timeout]);
    if (outcome === 'timeout') {
      turn.catch((err) => console.warn('[VTID-04310] delegated operator turn failed:', err instanceof Error ? err.message : err));
      return {
        success: true,
        result: JSON.stringify({
          status: 'still_working',
          thread_id: threadId,
          note: 'The Operator is still working on this. Tell the user it will appear in the Operator Console thread shortly.',
        }),
      };
    }
    if (outcome.status >= 400 || outcome.body.ok === false) {
      const detail = typeof outcome.body.details === 'string' ? outcome.body.details : String(outcome.body.error ?? outcome.status);
      return { success: false, result: '', error: `Operator turn failed: ${detail}` };
    }
    return { success: true, result: summarizeOutcome(outcome.body) };
  } catch (err) {
    return { success: false, result: '', error: `Operator turn failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
