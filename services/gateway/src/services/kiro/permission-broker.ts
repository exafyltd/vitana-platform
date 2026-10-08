/**
 * VTID-04975: tool-trust for Kiro sessions.
 *
 * Kiro asks permission (ACP session/request_permission) before a tool runs.
 * Policy: read/search/think tools are allowed without asking; anything else
 * becomes an approval card for the session owner and is DENIED when nobody
 * answers within KIRO_PERMISSION_TIMEOUT_MS (default 120 s). If kiro-cli never
 * emits permission requests, nothing here runs and write/exec stay off at the
 * runner (Phase 2: read-only trust flags).
 */
import { randomUUID } from 'crypto';
import type { AcpPermissionHandler, AcpPermissionOption, AcpPermissionRequest } from './acp-client';
import type { KiroTurnEventSink } from './kiro-events';

export const KIRO_PERMISSION_TIMEOUT_MS_DEFAULT = 120_000;
const AUTO_ALLOW_KINDS = new Set(['read', 'search', 'think']);

interface PendingPermission {
  ownerUserId: string | null;
  threadId: string;
  options: AcpPermissionOption[];
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
    if (AUTO_ALLOW_KINDS.has(req.kind)) return Promise.resolve(pickAllow(req.options));
    const timeoutMs = permissionTimeoutMs(env);
    const requestId = randomUUID();
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => { pending.delete(requestId); resolve(null); }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, { ownerUserId: ctx.userId, threadId: ctx.threadId, options: req.options, resolve, timer });
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
  return { ok: true };
}

export function pendingPermissionCount(): number { return pending.size; }
