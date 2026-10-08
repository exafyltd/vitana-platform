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

/**
 * VTID-04969: OpenAI verifies the domain by fetching a token the portal shows,
 * served as plain text and nothing else. Off (404) until the token is set; it is
 * independent of the MCP switch because OpenAI pings it when the plugin is submitted.
 */
wellKnownRouter.get('/openai-apps-challenge', (_req: Request, res: Response) => {
  const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN?.trim();
  if (!token) return res.status(404).type('text/plain').send('');
  return res.status(200).type('text/plain').send(token);
});

wellKnownRouter.get(['/oauth-protected-resource', '/oauth-protected-resource/mcp'], (req: Request, res: Response) => {
  if (!enabled(res)) return;
  res.json(protectedResourceMetadata(req));
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

function unauthorized(req: Request, res: Response, description: string) {
  const metadata = `${publicOrigin(req)}/.well-known/oauth-protected-resource/mcp`;
  res
    .status(401)
    .set('WWW-Authenticate', `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPES.join(' ')}", error="invalid_token", error_description="${description}"`)
    .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: description } });
}

router.post('/', async (req: Request, res: Response) => { // inline-bearer-auth
  // impact-allow-no-oasis: every tools/call emits commerce.mcp.tool_called
  // (services/commerce-mcp.ts auditToolCall), and each Commerce write emits
  // its own partner_org.* event through the shared services.
  if (!enabled(res)) return;
  const header = req.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return unauthorized(req, res, 'Sign in to Vitanaland to connect this assistant.');
  const verified = await verifyAndExtractIdentity(token).catch(() => null);
  if (!verified?.identity?.user_id) return unauthorized(req, res, 'The Vitanaland sign-in has expired or is not valid.');
  const identity = verified.identity;

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'DB_UNAVAILABLE' } });
  if (!allowMcpCall(identity.user_id)) {
    return res.status(429).set('Retry-After', '60').json({ jsonrpc: '2.0', id: null, error: { code: -32003, message: 'RATE_LIMITED' } });
  }

  // VTID-04968: only approved assistants (by registered redirect host) may use the tools.
  const client = await checkMcpClient(supabase as any, verified.claims);
  if (!client.ok) {
    await emitOasisEvent({
      vtid: 'VTID-04968',
      type: 'commerce.mcp.client_refused',
      source: 'commerce-mcp',
      status: 'warning',
      message: `Commerce MCP refused a client: ${client.reason}.`,
      payload: { reason: client.reason, client_id: typeof (verified.claims as any)?.client_id === 'string' ? (verified.claims as any).client_id : null },
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
});

router.all('/', (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } });
});

export default router;
