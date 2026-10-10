/**
 * VTID-04847 — the Vitanaland Commerce MCP endpoint (owner decision
 * 2026-10-02: hosted by the gateway, signed in through Supabase Auth's
 * OAuth 2.1 server).
 *
 *   POST /mcp                                       MCP, Streamable HTTP, stateless JSON
 *   GET|DELETE /mcp                                 405 (no server-sent events, no sessions)
 *   GET  /.well-known/oauth-protected-resource      RFC 9728 metadata → Supabase Auth
 *   GET  /.well-known/oauth-protected-resource/mcp  same, path-suffixed form
 *
 * A request without a valid Vitanaland access token gets 401 with
 * `WWW-Authenticate: Bearer resource_metadata=…`, which is how an assistant
 * (Claude, ChatGPT, …) discovers where to sign the supplier in. The token is
 * verified like every other gateway token (verifyAndExtractIdentity); the
 * tools then act as that user through the Commerce services
 * (services/commerce-mcp.ts).
 *
 * Off unless COMMERCE_MCP_ENABLED=true (404).
 *
 * VTID-04990 — a ChatGPT-only path, so the Claude path above never changes:
 *
 *   POST /mcp/chatgpt                                          same tools, same auth
 *   GET  /.well-known/oauth-protected-resource/mcp/chatgpt     resource metadata → this gateway
 *   GET  /.well-known/oauth-authorization-server               metadata shim, scopes `email profile`
 *
 * ChatGPT's desktop client requests Supabase's full scope list (incl. `openid`),
 * for which Supabase must mint an ID token it cannot sign (HS256 project key), so
 * its token exchange fails (500). Pointing ChatGPT at a metadata document that
 * advertises only `email profile` avoids that; every endpoint in it stays
 * Supabase's. On this path only, a loopback redirect (a desktop app's
 * http://127.0.0.1:<port>/…) is an approved client. Off unless
 * COMMERCE_MCP_CHATGPT=true as well (404 everywhere above, today's behaviour).
 */
import { Router, type Request, type Response } from 'express';
import { verifyAndExtractIdentity } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { checkMcpClient } from '../services/mcp-client-allowlist';
import { emitOasisEvent } from '../services/oasis-event-service';
import { handleJsonRpc, isCommerceMcpEnabled, MCP_SCOPES as SERVICE_MCP_SCOPES, type JsonRpcRequest, type McpCallContext } from '../services/commerce-mcp';

const router = Router();
export const wellKnownRouter = Router();

/** The public origin assistants reached us on (Cloudflare / ALB set the host). */
export function publicOrigin(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.COMMERCE_MCP_PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return configured;
  const host = req.get('host') ?? 'localhost';
  const proto = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https';
  return `${proto}://${host}`;
}

/** Supabase Auth is the authorization server (OAuth 2.1, PKCE, dynamic registration). */
export function authorizationServer(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.COMMERCE_MCP_AUTH_ISSUER?.replace(/\/+$/, '');
  if (explicit) return explicit;
  const supabase = env.SUPABASE_URL?.replace(/\/+$/, '');
  return supabase ? `${supabase}/auth/v1` : null;
}

/** Links in tool results point at the app that belongs to this gateway. */
export function portalUrlFor(origin: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.COMMERCE_PORTAL_URL?.replace(/\/+$/, '');
  if (configured) return configured;
  return origin.replace('://preview-aws-gateway.', '://preview-aws.').replace('://gateway.', '://');
}

/**
 * VTID-04882: the scopes an assistant should request. Without them Claude asked
 * for Supabase's full list, including `openid`; Supabase then mints an ID token,
 * which it cannot sign with this project's HS256 key, and the token exchange
 * failed (500). The gateway only needs the access token, so no `openid`.
 */
export const MCP_SCOPES = SERVICE_MCP_SCOPES;

function protectedResourceMetadata(req: Request) {
  const origin = publicOrigin(req);
  const as = authorizationServer();
  return {
    resource: `${origin}/mcp`,
    resource_name: 'Vitanaland Commerce',
    authorization_servers: as ? [as] : [],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: `${portalUrlFor(origin)}/commerce`,
  };
}

function enabled(res: Response): boolean {
  if (isCommerceMcpEnabled()) return true;
  res.status(404).json({ ok: false, error: 'COMMERCE_MCP_DISABLED' });
  return false;
}

/** VTID-04990: the ChatGPT-only path needs BOTH switches, exact string `true`. */
export function isChatgptPathEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCommerceMcpEnabled(env) && env.COMMERCE_MCP_CHATGPT === 'true';
}

function chatgptEnabled(res: Response): boolean {
  if (isChatgptPathEnabled()) return true;
  res.status(404).json({ ok: false, error: 'COMMERCE_MCP_DISABLED' });
  return false;
}

/** The resource metadata the ChatGPT path advertises: this gateway is its authorization server (the shim below). */
export function chatgptResourceMetadata(req: Request) {
  const origin = publicOrigin(req);
  return {
    resource: `${origin}/mcp/chatgpt`,
    resource_name: 'Vitanaland Commerce',
    authorization_servers: [origin],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: `${portalUrlFor(origin)}/commerce`,
  };
}

/**
 * VTID-04990: authorization-server metadata (RFC 8414) for the ChatGPT path. Only the
 * scopes differ from Supabase's own document (no `openid`, so no ID token); the
 * endpoints are Supabase's, which still registers clients, shows consent and
 * issues the tokens. No jwks / userinfo / ID-token fields: nothing here is an
 * OpenID provider.
 */
export function chatgptAuthorizationServerMetadata(req: Request) {
  const origin = publicOrigin(req);
  const as = authorizationServer();
  if (!as) return null;
  return {
    issuer: origin,
    authorization_endpoint: `${as}/oauth/authorize`,
    token_endpoint: `${as}/oauth/token`,
    registration_endpoint: `${as}/oauth/clients/register`,
    scopes_supported: [...MCP_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  };
}

/**
 * VTID-04969: OpenAI verifies the domain by fetching a token the portal shows,
 * served as plain text and nothing else. Off (404) until the token is set; it is
 * independent of the MCP switch because OpenAI pings it when the plugin is submitted.
 */
wellKnownRouter.get('/openai-apps-challenge', (_req: Request, res: Response) => {
  const token = (process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? '').trim();
  if (!token) return res.status(404).type('text/plain').send('');
  return res.status(200).type('text/plain').send(token);
});

wellKnownRouter.get(['/oauth-protected-resource', '/oauth-protected-resource/mcp'], (req: Request, res: Response) => {
  if (!enabled(res)) return;
  res.json(protectedResourceMetadata(req));
});

// VTID-04990: the ChatGPT-only path (404 unless COMMERCE_MCP_CHATGPT=true).
wellKnownRouter.get('/oauth-protected-resource/mcp/chatgpt', (req: Request, res: Response) => {
  if (!chatgptEnabled(res)) return;
  res.json(chatgptResourceMetadata(req));
});

wellKnownRouter.get('/oauth-authorization-server', (req: Request, res: Response) => {
  if (!chatgptEnabled(res)) return;
  const doc = chatgptAuthorizationServerMetadata(req);
  if (!doc) return res.status(503).json({ ok: false, error: 'AUTH_SERVER_UNCONFIGURED' });
  return res.json(doc);
});

/** A small per-user budget: an assistant loop must not hammer the services. */
const CALLS_PER_MINUTE = 120;
const windows = new Map<string, number[]>();
export function allowMcpCall(userId: string, now = Date.now()): boolean {
  const recent = (windows.get(userId) ?? []).filter((t) => t > now - 60_000);
  if (recent.length >= CALLS_PER_MINUTE) {
    windows.set(userId, recent);
    return false;
  }
  recent.push(now);
  windows.set(userId, recent);
  return true;
}
export function resetMcpLimits(): void {
  windows.clear();
}

function unauthorized(req: Request, res: Response, description: string, chatgpt = false) {
  const metadata = `${publicOrigin(req)}/.well-known/oauth-protected-resource/mcp${chatgpt ? '/chatgpt' : ''}`;
  res
    .status(401)
    .set('WWW-Authenticate', `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPES.join(' ')}", error="invalid_token", error_description="${description}"`)
    .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: description } });
}

/** VTID-04990: one audit event per loopback client per hour (the name is self-declared; it is logged, never trusted). */
const loopbackLogged = new Map<string, number>();
export function resetLoopbackAudit(): void {
  loopbackLogged.clear();
}
async function auditLoopbackClient(clientId: string | null, clientName: string | null, userId: string, now = Date.now()): Promise<void> {
  const key = clientId ?? userId;
  const last = loopbackLogged.get(key) ?? 0;
  if (now - last < 3_600_000) return;
  if (loopbackLogged.size > 5_000) loopbackLogged.clear();
  loopbackLogged.set(key, now);
  await emitOasisEvent({
    vtid: 'VTID-04990',
    type: 'commerce.mcp.loopback_client_approved',
    source: 'commerce-mcp',
    status: 'info',
    message: `Commerce MCP approved a loopback client on /mcp/chatgpt: ${clientName ?? 'unnamed'}.`,
    payload: { client_id: clientId, client_name: clientName, path: '/mcp/chatgpt' },
    actor_id: userId,
    actor_role: 'agent',
    surface: 'api',
  }).catch(() => undefined);
}

const mcpPost = (chatgpt: boolean) => async (req: Request, res: Response) => {
  // impact-allow-no-oasis: every tools/call emits commerce.mcp.tool_called
  // (services/commerce-mcp.ts auditToolCall), and each Commerce write emits
  // its own partner_org.* event through the shared services.
  if (chatgpt ? !chatgptEnabled(res) : !enabled(res)) return;
  const header = req.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return unauthorized(req, res, 'Sign in to Vitanaland to connect this assistant.', chatgpt);
  const verified = await verifyAndExtractIdentity(token).catch(() => null);
  if (!verified?.identity?.user_id) return unauthorized(req, res, 'The Vitanaland sign-in has expired or is not valid.', chatgpt);
  const identity = verified.identity;

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'DB_UNAVAILABLE' } });
  if (!allowMcpCall(identity.user_id)) {
    return res.status(429).set('Retry-After', '60').json({ jsonrpc: '2.0', id: null, error: { code: -32003, message: 'RATE_LIMITED' } });
  }

  // VTID-04968: only approved assistants (by registered redirect host) may use the tools.
  // VTID-04990: a loopback redirect (a desktop app) is approved on the ChatGPT path only.
  const client = await checkMcpClient(supabase as any, verified.claims, process.env, Date.now(), { allowLoopback: chatgpt });
  if (client.ok && client.loopback) await auditLoopbackClient(client.clientId, client.clientName, identity.user_id);
  if (!client.ok) {
    await emitOasisEvent({
      vtid: 'VTID-04968',
      type: 'commerce.mcp.client_refused',
      source: 'commerce-mcp',
      status: 'warning',
      message: `Commerce MCP refused a client: ${client.reason}.`,
      payload: { reason: client.reason, client_id: typeof (verified.claims as any)?.client_id === 'string' ? (verified.claims as any).client_id : null, path: chatgpt ? '/mcp/chatgpt' : '/mcp' },
      actor_id: identity.user_id,
      actor_role: 'agent',
      surface: 'api',
    }).catch(() => undefined);
    return res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'CLIENT_NOT_APPROVED' } });
  }

  const origin = publicOrigin(req);
  const ctx: McpCallContext = {
    supabase,
    caller: { userId: identity.user_id, email: identity.email, tenantId: identity.tenant_id, exafyAdmin: false },
    clientId: typeof (verified.claims as any)?.client_id === 'string' ? (verified.claims as any).client_id : null,
    portalUrl: portalUrlFor(origin),
  };

  const body = req.body;
  if (Array.isArray(body)) {
    if (body.length === 0) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    const out = [];
    for (const m of body) {
      const r = await handleJsonRpc(m as JsonRpcRequest, ctx);
      if (r) out.push(r);
    }
    return out.length ? res.json(out) : res.status(202).end();
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const r = await handleJsonRpc(body as JsonRpcRequest, ctx);
  return r ? res.json(r) : res.status(202).end();
};

router.post('/', (req: Request, res: Response) => { // inline-bearer-auth
  // impact-allow-no-oasis: mcpPost authenticates inline, every tools/call emits
  // commerce.mcp.tool_called (services/commerce-mcp.ts) and a refused client emits
  // commerce.mcp.client_refused.
  return mcpPost(false)(req, res);
});
router.post('/chatgpt', (req: Request, res: Response) => { // inline-bearer-auth
  // impact-allow-no-oasis: the same handler as above, on the ChatGPT-only path.
  return mcpPost(true)(req, res);
});

router.all('/', (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } });
});

router.all('/chatgpt', (_req: Request, res: Response) => {
  if (!chatgptEnabled(res)) return;
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } });
});

export default router;
