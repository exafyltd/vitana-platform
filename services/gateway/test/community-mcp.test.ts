/**
 * VTID-05133 — the Maxina Community MCP endpoint and its separation from Commerce.
 *
 *   - both paths 404 unless their switches are exactly `true`; 405 on GET;
 *   - 401 + WWW-Authenticate pointing at the right metadata per path;
 *   - RFC 9728 metadata: Claude path → Supabase Auth, ChatGPT path → this gateway;
 *   - the shared authorization-server shim is served when either ChatGPT path is on;
 *   - client allowlist reused; a token with no client (the member's own session) is refused;
 *   - grant enforcement: no row → PERMISSION_NEEDED, revoked → CONNECTION_REVOKED,
 *     lookup error → 503 (fail closed);
 *   - loopback clients only on /mcp/community/chatgpt;
 *   - Commerce: a client whose row lacks `commerce` is refused; a client with no row
 *     keeps working exactly as before (VTID-04968/04990 tests stay green);
 *   - the delegation guard already admits /mcp/community*; CORS rule covers the ChatGPT path.
 */
import express from 'express';
import request from 'supertest';

const verifyAndExtractIdentity = jest.fn();
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  verifyAndExtractIdentity: (...a: unknown[]) => verifyAndExtractIdentity(...a),
  requireAuth: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
let grantRow: { data: unknown; error: unknown } = { data: null, error: null };
const supabaseStub = {
  from: (t: string) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => (t === 'ai_connection_grants' ? grantRow : { data: null, error: null }),
    };
    return chain;
  },
};
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => supabaseStub }));
const checkMcpClient = jest.fn();
jest.mock('../src/services/mcp-client-allowlist', () => {
  const actual = jest.requireActual('../src/services/mcp-client-allowlist');
  return { ...actual, checkMcpClient: (...a: unknown[]) => checkMcpClient(...a) };
});
const emitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => emitOasisEvent(...a) }));
jest.mock('../src/services/orb-tools-shared', () => ({ tool_search_events: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const community = require('../src/routes/community-mcp');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const commerce = require('../src/routes/commerce-mcp');
import { isDelegatedPathAllowed } from '../src/services/delegation-guard';
import { applyDiscoveryCors } from '../src/middleware/cors';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/mcp/community', community.default);
  a.use('/.well-known', community.communityWellKnownRouter);
  a.use('/mcp', commerce.default);
  a.use('/.well-known', commerce.wellKnownRouter);
  return a;
}

const HOST = 'gateway.vitanaland.com';
const SUPABASE = 'https://proj.supabase.example';
const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const activeGrant = (categories: string[]) => ({ data: { categories, revoked_at: null }, error: null });

const prev = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  commerce.resetMcpLimits();
  commerce.resetLoopbackAudit();
  community.resetCommunityLoopbackAudit();
  process.env.COMMUNITY_MCP_ENABLED = 'true';
  delete process.env.COMMUNITY_MCP_CHATGPT;
  process.env.COMMERCE_MCP_ENABLED = 'true';
  delete process.env.COMMERCE_MCP_CHATGPT;
  process.env.SUPABASE_URL = SUPABASE;
  delete process.env.COMMERCE_MCP_PUBLIC_URL;
  delete process.env.COMMERCE_MCP_AUTH_ISSUER;
  verifyAndExtractIdentity.mockImplementation(async (t: string) =>
    t === 'good' ? { identity: { user_id: 'u-1', email: 'a@b.example', tenant_id: 't-1' }, claims: { client_id: 'c-1' } } : null,
  );
  checkMcpClient.mockResolvedValue({ ok: true, clientId: 'c-1', clientName: 'Claude', delegated: true });
  grantRow = activeGrant(['profile', 'matches', 'people', 'activities']);
});
afterAll(() => {
  process.env = prev;
});

const post = (path: string, body: unknown = ping, token: string | null = 'good') => {
  const r = request(app()).post(path).set('Host', HOST);
  return (token ? r.set('Authorization', `Bearer ${token}`) : r).send(body as object);
};

describe('switches', () => {
  test('off → 404 on both paths and both metadata documents', async () => {
    delete process.env.COMMUNITY_MCP_ENABLED;
    process.env.COMMUNITY_MCP_CHATGPT = 'true';
    for (const p of ['/mcp/community', '/mcp/community/chatgpt']) expect((await post(p)).status).toBe(404);
    for (const p of ['/oauth-protected-resource/mcp/community', '/oauth-protected-resource/mcp/community/chatgpt']) {
      expect((await request(app()).get(`/.well-known${p}`).set('Host', HOST)).status).toBe(404);
    }
  });

  test('exact string `true` only; ChatGPT path needs both switches', async () => {
    process.env.COMMUNITY_MCP_ENABLED = 'TRUE';
    expect((await post('/mcp/community')).status).toBe(404);
    process.env.COMMUNITY_MCP_ENABLED = 'true';
    expect((await post('/mcp/community/chatgpt')).status).toBe(404);
    process.env.COMMUNITY_MCP_CHATGPT = 'true';
    expect((await post('/mcp/community/chatgpt')).status).toBe(200);
  });

  test('GET is 405 with Allow: POST', async () => {
    const r = await request(app()).get('/mcp/community').set('Host', HOST);
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('POST');
  });
});

describe('sign-in discovery', () => {
  test('no token → 401 pointing at the path’s own metadata', async () => {
    process.env.COMMUNITY_MCP_CHATGPT = 'true';
    const a = await post('/mcp/community', ping, null);
    expect(a.status).toBe(401);
    expect(a.headers['www-authenticate']).toContain('resource_metadata="https://gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp/community"');
    expect(a.headers['www-authenticate']).toContain('scope="email profile"');
    const b = await post('/mcp/community/chatgpt', ping, null);
    expect(b.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp/community/chatgpt"');
    expect((await post('/mcp/community', ping, 'bad')).status).toBe(401);
  });

  test('metadata: Claude path → Supabase Auth, ChatGPT path → this gateway; no openid', async () => {
    process.env.COMMUNITY_MCP_CHATGPT = 'true';
    const a = (await request(app()).get('/.well-known/oauth-protected-resource/mcp/community').set('Host', HOST)).body;
    expect(a).toMatchObject({ resource: 'https://gateway.vitanaland.com/mcp/community', resource_name: 'Maxina Community', authorization_servers: [`${SUPABASE}/auth/v1`] });
    expect(a.scopes_supported).toEqual(['email', 'profile']);
    const b = (await request(app()).get('/.well-known/oauth-protected-resource/mcp/community/chatgpt').set('Host', HOST)).body;
    expect(b).toMatchObject({ resource: 'https://gateway.vitanaland.com/mcp/community/chatgpt', authorization_servers: ['https://gateway.vitanaland.com'] });
  });

  test('the authorization-server shim is served when either ChatGPT path is on, 404 when neither', async () => {
    const shim = () => request(app()).get('/.well-known/oauth-authorization-server').set('Host', HOST);
    expect((await shim()).status).toBe(404);
    process.env.COMMUNITY_MCP_CHATGPT = 'true';
    const r = await shim();
    expect(r.status).toBe(200);
    expect(r.body.scopes_supported).toEqual(['email', 'profile']);
    delete process.env.COMMUNITY_MCP_CHATGPT;
    process.env.COMMERCE_MCP_CHATGPT = 'true';
    expect((await shim()).status).toBe(200);
  });
});

describe('who may call', () => {
  test('an approved client with an active grant gets the four tools', async () => {
    const r = await post('/mcp/community', list);
    expect(r.status).toBe(200);
    expect(r.body.result.tools.map((t: any) => t.name)).toEqual(['get_my_maxina_profile', 'get_my_matches', 'find_people', 'find_activities']);
  });

  test('a client outside the allowlist → 403 CLIENT_NOT_APPROVED', async () => {
    checkMcpClient.mockResolvedValue({ ok: false, reason: 'client_not_approved' });
    const r = await post('/mcp/community');
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe('CLIENT_NOT_APPROVED');
    expect(emitOasisEvent.mock.calls[0][0].type).toBe('community.mcp.client_refused');
  });

  test("the member's own session (no client) is refused: the connector is for assistants", async () => {
    checkMcpClient.mockResolvedValue({ ok: true, clientId: null, clientName: null, delegated: false });
    expect((await post('/mcp/community')).status).toBe(403);
  });

  test('no grant row → 403 PERMISSION_NEEDED; revoked → CONNECTION_REVOKED; lookup error → 503', async () => {
    grantRow = { data: null, error: null };
    expect((await post('/mcp/community')).body.error.message).toBe('PERMISSION_NEEDED');
    grantRow = { data: { categories: ['profile'], revoked_at: '2026-10-13T00:00:00Z' }, error: null };
    expect((await post('/mcp/community')).body.error.message).toBe('CONNECTION_REVOKED');
    grantRow = { data: null, error: { message: 'boom' } };
    const r = await post('/mcp/community');
    expect(r.status).toBe(503);
    expect(r.body.error.message).toBe('PERMISSIONS_UNAVAILABLE');
  });

  test('a Commerce-only grant cannot use Community tools', async () => {
    grantRow = activeGrant(['commerce']);
    const r = await post('/mcp/community', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_people', arguments: { query: 'yoga' } } });
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.structuredContent.error.code).toBe('permission_needed');
  });

  test('loopback is allowed on the ChatGPT path only (and audited once)', async () => {
    process.env.COMMUNITY_MCP_CHATGPT = 'true';
    checkMcpClient.mockResolvedValue({ ok: true, clientId: 'c-1', clientName: 'ChatGPT', delegated: true, loopback: true });
    await post('/mcp/community/chatgpt');
    await post('/mcp/community/chatgpt');
    expect(checkMcpClient.mock.calls[0][4]).toEqual({ allowLoopback: true });
    expect(emitOasisEvent.mock.calls.filter((c) => c[0].type === 'community.mcp.loopback_client_approved')).toHaveLength(1);
    await post('/mcp/community');
    expect(checkMcpClient.mock.calls[2][4]).toEqual({ allowLoopback: false });
  });
});

describe('Commerce stays separate', () => {
  test('a Community-only grant is refused on /mcp', async () => {
    grantRow = activeGrant(['profile', 'people']);
    const r = await post('/mcp');
    expect(r.status).toBe(403);
    expect(emitOasisEvent.mock.calls.some((c) => c[0].payload?.reason === 'not_granted_commerce')).toBe(true);
  });

  test('a disconnected Commerce grant is refused on /mcp', async () => {
    grantRow = { data: { categories: [], revoked_at: '2026-10-13T00:00:00Z' }, error: null };
    expect((await post('/mcp')).status).toBe(403);
  });

  test('no grant row (every pre-existing Commerce connection) works exactly as before', async () => {
    grantRow = { data: null, error: null };
    expect((await post('/mcp')).status).toBe(200);
    grantRow = activeGrant(['commerce']);
    expect((await post('/mcp')).status).toBe(200);
  });
});

describe('surrounding guards', () => {
  test('the delegation guard admits both Community paths', () => {
    expect(isDelegatedPathAllowed('/mcp/community')).toBe(true);
    expect(isDelegatedPathAllowed('/mcp/community/chatgpt')).toBe(true);
  });

  test('CORS: OpenAI origins may call /mcp/community/chatgpt, nobody else, and not the Claude path', () => {
    const run = (path: string, origin: string) => {
      const headers: Record<string, string> = {};
      const handled = applyDiscoveryCors(
        { path, method: 'POST', headers: { origin } } as any,
        { setHeader: (k: string, v: string) => (headers[k] = v) } as any,
      );
      return { handled, headers };
    };
    expect(run('/mcp/community/chatgpt', 'https://chatgpt.com').headers['Access-Control-Allow-Origin']).toBe('https://chatgpt.com');
    expect(run('/mcp/community/chatgpt', 'https://example.com').handled).toBe(false);
    expect(run('/mcp/community', 'https://chatgpt.com').handled).toBe(false);
  });
});
