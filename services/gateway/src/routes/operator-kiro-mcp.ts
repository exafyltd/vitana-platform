/**
 * VTID-05005 — the Operator's developer tools for a Kiro session, as MCP.
 *
 *   POST /api/v1/operator/kiro/mcp     MCP, Streamable HTTP, stateless JSON
 *
 * Caller: the `vitana` stdio relay the kiro-runner attaches to every Kiro
 * session (services/kiro-runner/src/mcp-proxy.ts). It carries the session's
 * pass (`Authorization: Bearer <kiro mcp token>`, kiro-mcp-token.ts), minted by
 * this gateway when the session opened. Every call:
 *   - verifies the pass (signature, environment, expiry),
 *   - re-checks that the user is still exafy_admin (60 s cache),
 *   - is rate-limited per user, and
 *   - for tools/call, is logged as OASIS `operator.kiro.tool_called`
 *     (tool, user, thread, latency, outcome — never arguments or results).
 *
 * Off (404) unless KIRO_MCP_ENABLED=true. GATEWAY_INTERNAL_TOKEN unset = 503.
 */
import { Router, type Request, type Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { isKiroMcpEnabled, verifyKiroMcpToken } from '../services/kiro/kiro-mcp-token';
import { callKiroMcpTool, isKiroMcpTool, kiroMcpTools } from '../services/kiro/kiro-mcp-tools';
import { MCP_PROTOCOL_VERSIONS, negotiateVersion, type JsonRpcRequest, type JsonRpcResponse } from '../services/commerce-mcp';

const router = Router();

export const KIRO_MCP_SERVER_INFO = { name: 'vitana', title: 'Vitana developer tools', version: '1.0.0' };
// Admin/dev tooling, English by design (server i18n 13b admin/dev exclusion).
const INSTRUCTIONS =
  'Read-only Vitana developer tools, the same ones the Command Hub Operator uses: search and read both repos ' +
  '(exafyltd/vitana-platform, exafyltd/vitana-v1), RepoWise and Graphify, the domain atlas, OASIS events and the VTID ledger, ' +
  'Dev Autopilot status, ECS/CloudWatch, deploy and CI status, read-only SQL. Every call is logged.';

export { MCP_PROTOCOL_VERSIONS };

// ---- caller checks ---------------------------------------------------------

type AdminLookup = (userId: string) => Promise<{ admin: boolean; tenantId: string | null }>;

const ADMIN_CACHE_MS = 60_000;
const adminCache = new Map<string, { at: number; admin: boolean; tenantId: string | null }>();

const lookupAdminFromSupabase: AdminLookup = async (userId) => {
  const supabase = getSupabase();
  if (!supabase) return { admin: false, tenantId: null };
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) return { admin: false, tenantId: null };
  const meta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
  return { admin: meta.exafy_admin === true, tenantId: typeof meta.active_tenant_id === 'string' ? meta.active_tenant_id : null };
};

let adminLookup: AdminLookup = lookupAdminFromSupabase;
/** Tests only. */
export function setKiroMcpAdminLookup(fn: AdminLookup | null): void { adminLookup = fn ?? lookupAdminFromSupabase; adminCache.clear(); }

async function adminStatus(userId: string, now = Date.now()) {
  const hit = adminCache.get(userId);
  if (hit && now - hit.at < ADMIN_CACHE_MS) return hit;
  const r = await adminLookup(userId).catch(() => ({ admin: false, tenantId: null }));
  const entry = { at: now, ...r };
  adminCache.set(userId, entry);
  return entry;
}

const CALLS_PER_MINUTE = 240;
const windows = new Map<string, number[]>();
export function allowKiroMcpCall(userId: string, now = Date.now()): boolean {
  const recent = (windows.get(userId) ?? []).filter((t) => t > now - 60_000);
  if (recent.length >= CALLS_PER_MINUTE) { windows.set(userId, recent); return false; }
  recent.push(now);
  windows.set(userId, recent);
  return true;
}
export function resetKiroMcpLimits(): void { windows.clear(); adminCache.clear(); }

const rpcError = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });

// ---- JSON-RPC --------------------------------------------------------------

interface CallCtx { userId: string; tenantId: string | null; threadId: string }

export async function handleKiroMcp(msg: JsonRpcRequest, ctx: CallCtx): Promise<JsonRpcResponse | null> {
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;
  const err = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isNotification ? null : err(-32600, 'Invalid Request');

  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: { protocolVersion: negotiateVersion(msg.params?.protocolVersion), capabilities: { tools: { listChanged: false } }, serverInfo: KIRO_MCP_SERVER_INFO, instructions: INSTRUCTIONS },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: kiroMcpTools() } };
    case 'tools/call': {
      const name = msg.params?.name;
      if (typeof name !== 'string') return err(-32602, 'Invalid params: name is required');
      if (!isKiroMcpTool(name)) return err(-32602, `Unknown tool: ${name}`);
      const args = (msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}) as Record<string, unknown>;
      const started = Date.now();
      const r = await callKiroMcpTool(ctx, name, args);
      await emitOasisEvent({
        vtid: 'VTID-05005',
        type: 'operator.kiro.tool_called',
        source: 'gateway-operator',
        status: r.ok ? 'success' : 'warning',
        message: `Kiro used ${name}: ${r.ok ? 'ok' : 'error'}`,
        actor_id: ctx.userId,
        actor_role: 'admin',
        surface: 'command-hub',
        payload: { tool: name, thread_id: ctx.threadId, latency_ms: Date.now() - started, outcome: r.ok ? 'ok' : 'error' },
      }).catch(() => undefined);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: !r.ok } };
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return isNotification ? null : err(-32601, `Method not found: ${msg.method}`);
  }
}

router.post('/', async (req: Request, res: Response) => {
  if (!isKiroMcpEnabled()) return res.status(404).json({ ok: false, error: 'KIRO_MCP_DISABLED' });
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return rpcError(res, 401, -32001, 'missing token');
  const check = verifyKiroMcpToken(header.slice(7));
  if (!check.ok) {
    if (check.reason === 'unconfigured') return rpcError(res, 503, -32002, 'kiro mcp is not configured on this gateway');
    return rpcError(res, 401, -32001, `invalid token (${check.reason})`);
  }
  const { userId, threadId } = check.claims;
  const status = await adminStatus(userId);
  if (!status.admin) return rpcError(res, 403, -32003, 'exafy_admin required');
  if (!allowKiroMcpCall(userId)) return rpcError(res, 429, -32004, 'too many tool calls; slow down');

  const ctx: CallCtx = { userId, tenantId: status.tenantId, threadId };
  const body = req.body;
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleKiroMcp(m, ctx)))).filter(Boolean);
    return out.length ? res.json(out) : res.status(202).end();
  }
  const out = await handleKiroMcp(body ?? {}, ctx);
  return out ? res.json(out) : res.status(202).end();
});

router.all('/', (_req: Request, res: Response) => res.status(405).set('Allow', 'POST').json({ ok: false, error: 'method_not_allowed' }));

export default router;
