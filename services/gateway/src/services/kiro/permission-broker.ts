/**
 * VTID-04975: tool-trust for Kiro sessions.
 *
 * Kiro asks permission (ACP session/request_permission) before a tool runs.
 * Policy: read/search/think tools are allowed without asking; anything else
 * becomes an approval card for the session owner and is DENIED when nobody
 * answers within KIRO_PERMISSION_TIMEOUT_MS (default 120 s). If kiro-cli never
 * emits permission requests, nothing here runs and write/exec stay off at the
 * runner (Phase 2: read-only trust flags).
 *
 * VTID-05065: Kiro's calls to the Operator's own MCP read tools arrive as kind
 * `other` with the title `Running: @vitana/<tool>` (kiro-cli 2.28.0, recorded in
 * production 2026-10-10). Exactly that title, kind `other`, and a name on
 * KIRO_MCP_READ_TOOLS is allowed without a card. Anything else — a write tool,
 * an unknown name, another title format, another kind — still asks. A format
 * change therefore brings cards back, never an allow. Write tools also keep
 * their own DB-backed Allow in the MCP route, which dispatches by its own tool
 * name, not by this title.
 *
 * Every answer (user or timeout) is reported as a `kiro.permission_answer`
 * event so a run record can show it and clear its pending card.
 */
import { randomUUID } from 'crypto';
import type { AcpPermissionHandler, AcpPermissionOption, AcpPermissionRequest } from './acp-client';
import type { KiroTurnEventSink } from './kiro-events';
import { KIRO_MCP_READ_TOOLS } from './kiro-mcp-read-tools';

export const KIRO_PERMISSION_TIMEOUT_MS_DEFAULT = 120_000;
const AUTO_ALLOW_KINDS = new Set(['read', 'search', 'think']);

/** VTID-05065: kiro-cli's title for a call to one of the gateway's MCP tools (server name `vitana`). */
export const KIRO_MCP_TOOL_TITLE = /^Running: @vitana\/([a-z0-9_]+)$/;
const TRUSTED_READ_TOOLS = new Set<string>(KIRO_MCP_READ_TOOLS);

/**
 * VTID-05065: the Operator read tool this permission request runs, or null when it is not
 * exactly one (wrong kind, other title format, unknown or write tool name).
 */
export function trustedKiroReadTool(req: Pick<AcpPermissionRequest, 'title' | 'kind'>): string | null {
  if (req.kind !== 'other') return null;
  const m = KIRO_MCP_TOOL_TITLE.exec(req.title);
  return m && TRUSTED_READ_TOOLS.has(m[1]) ? m[1] : null;
}

interface PendingPermission {
  ownerUserId: string | null;
  threadId: string;
  options: AcpPermissionOption[];
  emit: KiroTurnEventSink;
  resolve: (optionId: string | null) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingPermission>();

function pickAllow(options: AcpPermissionOption[]): string | null {
  const o = options.find((x) => x.kind === 'allow_once') ?? options.find((x) => /allow/i.test(x.kind ?? ''));
  return o?.optionId ?? null;
}

export function permissionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.KIRO_PERMISSION_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : KIRO_PERMISSION_TIMEOUT_MS_DEFAULT;
}

/** The handler the ACP client uses for one turn of one thread. */
export function makePermissionHandler(
  ctx: { threadId: string; userId: string | null; emit: KiroTurnEventSink },
  env: NodeJS.ProcessEnv = process.env,
): AcpPermissionHandler {
  return (req: AcpPermissionRequest) => {
    if (AUTO_ALLOW_KINDS.has(req.kind) || trustedKiroReadTool(req)) return Promise.resolve(pickAllow(req.options));
    const timeoutMs = permissionTimeoutMs(env);
    const requestId = randomUUID();
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(null);
        reportAnswer(ctx.emit, requestId, false, 'timeout');
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, { ownerUserId: ctx.userId, threadId: ctx.threadId, options: req.options, resolve, timer, emit: ctx.emit });
      ctx.emit({
        type: 'kiro.permission_request',
        request_id: requestId,
        tool_call_id: req.toolCallId,
        title: req.title,
        kind: req.kind,
        expires_at: new Date(Date.now() + timeoutMs).toISOString(),
      });
    });
  };
}

/** Answer a pending approval card. Only the session owner may answer. */
export function answerPermission(
  requestId: string,
  userId: string | null,
  allow: boolean,
): { ok: true } | { ok: false; error: 'not_found' | 'forbidden' } {
  const p = pending.get(requestId);
  if (!p) return { ok: false, error: 'not_found' };
  if (p.ownerUserId && p.ownerUserId !== userId) return { ok: false, error: 'forbidden' };
  pending.delete(requestId);
  clearTimeout(p.timer);
  p.resolve(allow ? pickAllow(p.options) : null);
  reportAnswer(p.emit, requestId, allow, 'user');
  return { ok: true };
}

function reportAnswer(emit: KiroTurnEventSink, requestId: string, allow: boolean, by: 'user' | 'timeout'): void {
  try { emit({ type: 'kiro.permission_answer', request_id: requestId, allow, by }); } catch { /* a sink never fails the answer */ }
}

/** VTID-05065: is this approval card still waiting in this gateway task? */
export function isPermissionPending(requestId: string): boolean { return pending.has(requestId); }

export function pendingPermissionCount(): number { return pending.size; }
