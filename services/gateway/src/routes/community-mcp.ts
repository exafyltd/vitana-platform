/**
 * VTID-05133 — the Maxina Community MCP endpoint ("Connect your AI").
 *
 *   POST /mcp/community                                         Claude (and any MCP client); metadata → Supabase Auth
 *   POST /mcp/community/chatgpt                                 ChatGPT; metadata → this gateway's shim (A1)
 *   GET  /.well-known/oauth-protected-resource/mcp/community          RFC 9728 metadata
 *   GET  /.well-known/oauth-protected-resource/mcp/community/chatgpt  RFC 9728 metadata, ChatGPT path
 *
 * Same sign-in, client allowlist, rate limit and delegation guard as the
 * Commerce connector (routes/commerce-mcp.ts, VTID-04847/04968/04990): the
 * ChatGPT path exists for the same reason Commerce's does (ChatGPT asks for
 * `openid`, Supabase cannot sign the ID token), and only it approves loopback
 * redirects. On top of that, every call needs the member's grant for this
 * assistant (ai_connection_grants, services/ai-connection-grants.ts): Supabase
 * tokens are not bound to a resource, so the grant is what keeps a Commerce
 * connection out of Community and makes "Disconnect" in Maxina immediate.
 *
 * Off unless COMMUNITY_MCP_ENABLED=true (404); the ChatGPT path also needs
 * COMMUNITY_MCP_CHATGPT=true. Mounted BEFORE Commerce's `/mcp` (index.ts).
 */
import { Router, type Request, type Response } from 'express';
import { verifyAndExtractIdentity } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { checkMcpClient } from '../services/mcp-client-allowlist';
import { emitOasisEvent } from '../services/oasis-event-service';
import { MCP_SCOPES } from '../services/commerce-mcp';
import { allowMcpCall, authorizationServer, portalUrlFor, publicOrigin } from './commerce-mcp';
import { communityAccess, lookupGrant } from '../services/ai-connection-grants';
import {
  handleCommunityJsonRpc,
  isCommunityChatgptPathEnabled,
  isCommunityMcpEnabled,
  type CommunityCallContext,
} from '../services/community-mcp';
import type { JsonRpcRequest } from '../services/commerce-mcp';

const router = Router();
export const communityWellKnownRouter = Router();

const RESOURCE_NAME = 'Maxina Community';

function enabled(res: Response, chatgpt: boolean): boolean {
  if (chatgpt ? isCommunityChatgptPathEnabled() : isCommunityMcpEnabled()) return true;
  res.status(404).json({ ok: false, error: 'COMMUNITY_MCP_DISABLED' });
  return false;
}

/** RFC 9728 metadata. Claude path → Supabase Auth; ChatGPT path → this gateway (the shim in commerce-mcp.ts). */
export function communityResourceMetadata(req: Request, chatgpt: boolean) {
  const origin = publicOrigin(req);
  const as = chatgpt ? origin : authorizationServer();
  return {
    resource: `${origin}/mcp/community${chatgpt ? '/chatgpt' : ''}`,
    resource_name: RESOURCE_NAME,
    authorization_servers: as ? [as] : [],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: `${portalUrlFor(origin)}/connectors`,
  };
}

communityWellKnownRouter.get('/oauth-protected-resource/mcp/community', (req: Request, res: Response) => {
  if (!enabled(res, false)) return;
  res.json(communityResourceMetadata(req, false));
});

communityWellKnownRouter.get('/oauth-protected-resource/mcp/community/chatgpt', (req: Request, res: Response) => {
  if (!enabled(res, true)) return;
  res.json(communityResourceMetadata(req, true));
});

function unauthorized(req: Request, res: Response, description: string, chatgpt: boolean) {
  const metadata = `${publicOrigin(req)}/.well-known/oauth-protected-resource/mcp/community${chatgpt ? '/chatgpt' : ''}`;
  res
    .status(401)
    .set('WWW-Authenticate', `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPES.join(' ')}", error="invalid_token", error_description="${description}"`)
    .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: description } });
}

async function refuse(userId: string, clientId: string | null, reason: string, chatgpt: boolean): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-05133',
    type: 'community.mcp.client_refused',
    source: 'community-mcp',
    status: 'warning',
    message: `Community MCP refused a client: ${reason}.`,
    payload: { reason, client_id: clientId, path: chatgpt ? '/mcp/community/chatgpt' : '/mcp/community' },
    actor_id: userId,
    actor_role: 'agent',
    surface: 'api',
  }).catch(() => undefined);
}

/** Loopback (desktop) clients on the ChatGPT path: one audit event per client per hour. */
const loopbackLogged = new Map<string, number>();
export function resetCommunityLoopbackAudit(): void {
  loopbackLogged.clear();
}
async function auditLoopback(clientId: string | null, clientName: string | null, userId: string, now = Date.now()): Promise<void> {
  const key = clientId ?? userId;
  if (now - (loopbackLogged.get(key) ?? 0) < 3_600_000) return;
  if (loopbackLogged.size > 5_000) loopbackLogged.clear();
  loopbackLogged.set(key, now);
  await emitOasisEvent({
    vtid: 'VTID-05133',
    type: 'community.mcp.loopback_client_approved',
    source: 'community-mcp',
    status: 'info',
    message: `Community MCP approved a loopback client on /mcp/community/chatgpt: ${clientName ?? 'unnamed'}.`,
    payload: { client_id: clientId, client_name: clientName, path: '/mcp/community/chatgpt' },
    actor_id: userId,
    actor_role: 'agent',
    surface: 'api',
  }).catch(() => undefined);
}

const ACCESS_MESSAGE: Record<string, { status: number; code: number; message: string }> = {
  permission_needed: { status: 403, code: -32002, message: 'PERMISSION_NEEDED' },
  revoked: { status: 403, code: -32002, message: 'CONNECTION_REVOKED' },
  lookup_failed: { status: 503, code: -32603, message: 'PERMISSIONS_UNAVAILABLE' },
};

/**
 * The member's tenant when the token carries none (OAuth tokens may not). Null on
 * any error: people tools then show nobody (fetchAiDiscoverableUserIds fails closed).
 */
async function profileTenant(sb: any, userId: string): Promise<string | null> {
  try {
    const { data, error } = await sb.from('profiles').select('tenant_id').eq('user_id', userId).maybeSingle();
    return !error && typeof data?.tenant_id === 'string' ? data.tenant_id : null;
  } catch {
    return null;
  }
}

export const communityMcpPost = (chatgpt: boolean) => async (req: Request, res: Response) => {
  // impact-allow-no-oasis: every tools/call emits community.mcp.tool_called
  // (services/community-mcp.ts auditCommunityToolCall); refusals emit
  // community.mcp.client_refused. Read-only tools, nothing else changes.
  if (!enabled(res, chatgpt)) return;
  const header = req.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return unauthorized(req, res, 'Sign in to Maxina to connect this assistant.', chatgpt);
  const verified = await verifyAndExtractIdentity(token).catch(() => null);
  if (!verified?.identity?.user_id) return unauthorized(req, res, 'The Maxina sign-in has expired or is not valid.', chatgpt);
  const identity = verified.identity;

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'DB_UNAVAILABLE' } });
  if (!allowMcpCall(identity.user_id)) {
    return res.status(429).set('Retry-After', '60').json({ jsonrpc: '2.0', id: null, error: { code: -32003, message: 'RATE_LIMITED' } });
  }

  const client = await checkMcpClient(supabase as any, verified.claims, process.env, Date.now(), { allowLoopback: chatgpt });
  if (!client.ok) {
    await refuse(identity.user_id, typeof (verified.claims as any)?.client_id === 'string' ? (verified.claims as any).client_id : null, client.reason, chatgpt);
    return res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'CLIENT_NOT_APPROVED' } });
  }
  // The connector is for assistants only: the member's own app session has no client to grant.
  if (!client.clientId) {
    await refuse(identity.user_id, null, 'no_client', chatgpt);
    return res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'CLIENT_NOT_APPROVED' } });
  }
  if (client.loopback) await auditLoopback(client.clientId, client.clientName, identity.user_id);

  const access = communityAccess(await lookupGrant(supabase as any, identity.user_id, client.clientId));
  if (!access.ok) {
    await refuse(identity.user_id, client.clientId, access.reason, chatgpt);
    const m = ACCESS_MESSAGE[access.reason];
    return res.status(m.status).json({ jsonrpc: '2.0', id: null, error: { code: m.code, message: m.message } });
  }

  const ctx: CommunityCallContext = {
    supabase,
    userId: identity.user_id,
    tenantId: identity.tenant_id ?? (await profileTenant(supabase, identity.user_id)),
    clientId: client.clientId,
    categories: access.categories,
    appUrl: portalUrlFor(publicOrigin(req)),
    path: chatgpt ? '/mcp/community/chatgpt' : '/mcp/community',
  };

  const body = req.body;
  if (Array.isArray(body)) {
    if (body.length === 0) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    const out = [];
    for (const m of body) {
      const r = await handleCommunityJsonRpc(m as JsonRpcRequest, ctx);
      if (r) out.push(r);
    }
    return out.length ? res.json(out) : res.status(202).end();
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const r = await handleCommunityJsonRpc(body as JsonRpcRequest, ctx);
  return r ? res.json(r) : res.status(202).end();
};

router.post('/', (req: Request, res: Response) => { // inline-bearer-auth
  // impact-allow-no-oasis: communityMcpPost authenticates inline and emits community.mcp.* events.
  return communityMcpPost(false)(req, res);
});
router.post('/chatgpt', (req: Request, res: Response) => { // inline-bearer-auth
  // impact-allow-no-oasis: the same handler as above, on the ChatGPT-only path.
  return communityMcpPost(true)(req, res);
});

router.all('/', (_req: Request, res: Response) => {
  if (!enabled(res, false)) return;
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } });
});
router.all('/chatgpt', (_req: Request, res: Response) => {
  if (!enabled(res, true)) return;
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } });
});

export default router;
