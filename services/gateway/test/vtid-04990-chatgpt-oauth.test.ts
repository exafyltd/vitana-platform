/**
 * VTID-04990 — the ChatGPT-only path of the Commerce MCP.
 *
 * ChatGPT's desktop client asks for Supabase's full scope list (incl. `openid`),
 * which makes Supabase mint an ID token it cannot sign, so the token exchange
 * fails. `/mcp/chatgpt` is advertised through its own metadata (scopes `email
 * profile`) and approves a loopback redirect; `/mcp` — what Claude uses — must
 * not change at all, with the switch on or off.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

const verifyAndExtractIdentity = jest.fn();
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  verifyAndExtractIdentity: (...a: unknown[]) => verifyAndExtractIdentity(...a),
  requireAuth: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
const checkMcpClient = jest.fn();
jest.mock('../src/services/mcp-client-allowlist', () => {
  const actual = jest.requireActual('../src/services/mcp-client-allowlist');
  return { ...actual, checkMcpClient: (...a: unknown[]) => checkMcpClient(...a) };
});
const emitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => emitOasisEvent(...a) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const routes = require('../src/routes/commerce-mcp');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const allow = jest.requireActual('../src/services/mcp-client-allowlist') as typeof import('../src/services/mcp-client-allowlist');
import { isDelegatedPathAllowed } from '../src/services/delegation-guard';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/mcp', routes.default);
  a.use('/.well-known', routes.wellKnownRouter);
  return a;
}

const HOST = 'gateway.vitanaland.com';
const SUPABASE = 'https://proj.supabase.example';
const CLAUDE_METADATA = 'resource_metadata="https://gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp"';

const prev = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  routes.resetMcpLimits();
  routes.resetLoopbackAudit();
  process.env.COMMERCE_MCP_ENABLED = 'true';
  delete process.env.COMMERCE_MCP_CHATGPT;
  process.env.SUPABASE_URL = SUPABASE;
  delete process.env.COMMERCE_MCP_PUBLIC_URL;
  delete process.env.COMMERCE_MCP_AUTH_ISSUER;
  verifyAndExtractIdentity.mockImplementation(async (t: string) =>
    t === 'good' ? { identity: { user_id: 'u-1', email: 'a@b.example', tenant_id: 't-1' }, claims: { client_id: 'codex-1' } } : null,
  );
  checkMcpClient.mockResolvedValue({ ok: true, clientId: 'codex-1', clientName: 'Codex', delegated: true, loopback: true });
});
afterAll(() => {
  process.env = prev;
});

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('switch OFF: the ChatGPT path does not exist', () => {
  test('/mcp/chatgpt, its metadata and the authorization-server document all answer 404', async () => {
    expect((await request(app()).post('/mcp/chatgpt').set('Host', HOST).send(ping)).status).toBe(404);
    expect((await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('Authorization', 'Bearer good').send(ping)).status).toBe(404);
    expect((await request(app()).get('/mcp/chatgpt').set('Host', HOST)).status).toBe(404);
    expect((await request(app()).get('/.well-known/oauth-protected-resource/mcp/chatgpt').set('Host', HOST)).status).toBe(404);
    expect((await request(app()).get('/.well-known/oauth-authorization-server').set('Host', HOST)).status).toBe(404);
  });

  test('needs COMMERCE_MCP_ENABLED too, and the exact string `true`', async () => {
    process.env.COMMERCE_MCP_CHATGPT = 'TRUE';
    expect(routes.isChatgptPathEnabled()).toBe(false);
    process.env.COMMERCE_MCP_CHATGPT = 'true';
    delete process.env.COMMERCE_MCP_ENABLED;
    expect(routes.isChatgptPathEnabled()).toBe(false);
    expect((await request(app()).get('/.well-known/oauth-authorization-server').set('Host', HOST)).status).toBe(404);
  });
});

describe('/mcp (Claude) is byte-for-byte unchanged, switch off and on', () => {
  const expectedMetadata = {
    resource: 'https://gateway.vitanaland.com/mcp',
    resource_name: 'Vitanaland Commerce',
    authorization_servers: [`${SUPABASE}/auth/v1`],
    scopes_supported: ['email', 'profile'],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://vitanaland.com/commerce',
  };

  for (const state of ['off', 'on'] as const) {
    test(`protected-resource metadata and the 401 challenge, switch ${state}`, async () => {
      if (state === 'on') process.env.COMMERCE_MCP_CHATGPT = 'true';
      for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        const res = await request(app()).get(path).set('Host', HOST);
        expect(res.status).toBe(200);
        expect(res.body).toEqual(expectedMetadata);
      }
      const res = await request(app()).post('/mcp').set('Host', HOST).send(ping);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe(
        `Bearer ${CLAUDE_METADATA}, scope="email profile", error="invalid_token", error_description="Sign in to Vitanaland to connect this assistant."`,
      );
    });
  }

  test('/mcp asks the client check WITHOUT loopback, whatever the switch says', async () => {
    process.env.COMMERCE_MCP_CHATGPT = 'true';
    await request(app()).post('/mcp').set('Host', HOST).set('Authorization', 'Bearer good').send(ping);
    expect(checkMcpClient).toHaveBeenCalledTimes(1);
    expect(checkMcpClient.mock.calls[0][4]).toEqual({ allowLoopback: false });
  });
});

describe('switch ON: /mcp/chatgpt and its metadata', () => {
  beforeEach(() => {
    process.env.COMMERCE_MCP_CHATGPT = 'true';
  });

  test('the resource metadata names this gateway as the authorization server, scopes without openid', async () => {
    const res = await request(app()).get('/.well-known/oauth-protected-resource/mcp/chatgpt').set('Host', HOST);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resource: 'https://gateway.vitanaland.com/mcp/chatgpt',
      resource_name: 'Vitanaland Commerce',
      authorization_servers: ['https://gateway.vitanaland.com'],
      scopes_supported: ['email', 'profile'],
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://vitanaland.com/commerce',
    });
  });

  test('the authorization-server document: our issuer and scopes, Supabase endpoints, nothing OpenID', async () => {
    const res = await request(app()).get('/.well-known/oauth-authorization-server').set('Host', HOST);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issuer: 'https://gateway.vitanaland.com',
      authorization_endpoint: `${SUPABASE}/auth/v1/oauth/authorize`,
      token_endpoint: `${SUPABASE}/auth/v1/oauth/token`,
      registration_endpoint: `${SUPABASE}/auth/v1/oauth/clients/register`,
      scopes_supported: ['email', 'profile'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/openid|jwks|userinfo|id_token/);
  });

  test('without a Supabase URL the document is 503, never a half-built one', async () => {
    delete process.env.SUPABASE_URL;
    const res = await request(app()).get('/.well-known/oauth-authorization-server').set('Host', HOST);
    expect(res.status).toBe(503);
  });

  test('an unsigned call is 401 and points at the ChatGPT resource metadata', async () => {
    const res = await request(app()).post('/mcp/chatgpt').set('Host', HOST).send(ping);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="https://gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp/chatgpt"',
    );
    expect(res.headers['www-authenticate']).toContain('scope="email profile"');
    expect(res.headers['www-authenticate']).not.toMatch(/openid/);
  });

  test('an invalid token is 401 on the ChatGPT metadata too', async () => {
    const res = await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('Authorization', 'Bearer nope').send(ping);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('oauth-protected-resource/mcp/chatgpt');
  });

  test('a signed-in, approved client reaches the same tools; the client check allows loopback on this path only', async () => {
    const res = await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('Authorization', 'Bearer good').send(ping);
    expect(res.status).toBe(200);
    expect(checkMcpClient.mock.calls[0][4]).toEqual({ allowLoopback: true });
    const list = await request(app())
      .post('/mcp/chatgpt')
      .set('Host', HOST)
      .set('Authorization', 'Bearer good')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toContain('get_onboarding_status');
  });

  test('a refused client is 403 CLIENT_NOT_APPROVED with the path in the audit event', async () => {
    checkMcpClient.mockResolvedValue({ ok: false, reason: 'client_not_approved' });
    const res = await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('Authorization', 'Bearer good').send(ping);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('CLIENT_NOT_APPROVED');
    const ev = emitOasisEvent.mock.calls.map((c) => c[0]).find((e) => e.type === 'commerce.mcp.client_refused');
    expect(ev.payload).toEqual(expect.objectContaining({ reason: 'client_not_approved', path: '/mcp/chatgpt' }));
  });

  test('a loopback client is audited once per hour, with its (self-declared) name', async () => {
    const go = () => request(app()).post('/mcp/chatgpt').set('Host', HOST).set('Authorization', 'Bearer good').send(ping);
    await go();
    await go();
    const events = emitOasisEvent.mock.calls.map((c) => c[0]).filter((e) => e.type === 'commerce.mcp.loopback_client_approved');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ client_id: 'codex-1', client_name: 'Codex', path: '/mcp/chatgpt' });
  });

  test('GET on the path is 405 POST-only', async () => {
    const res = await request(app()).get('/mcp/chatgpt').set('Host', HOST);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });
});

describe('loopback approval in the client check', () => {
  const DEFAULTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'claude.com'];
  const uri = (...u: string[]) => u;

  test('off: no loopback is ever approved', () => {
    expect(allow.redirectUrisAllowed(uri('http://127.0.0.1:57859/callback/x'), DEFAULTS)).toBe(false);
    expect(allow.redirectUrisAllowed(uri('http://127.0.0.1:57859/callback/x'), DEFAULTS, false)).toBe(false);
  });

  test('on: exactly 127.0.0.1, [::1] and localhost over http, any port and path', () => {
    for (const u of ['http://127.0.0.1:57859/callback/ura9nyf6TpeZ', 'http://localhost:1/x', 'http://[::1]:2/y', 'http://127.0.0.1/cb']) {
      expect(allow.redirectUrisAllowed(uri(u), DEFAULTS, true)).toBe(true);
    }
  });

  test('on: look-alikes, other loopback addresses and https loopback stay refused', () => {
    for (const u of [
      'http://127.0.0.2:1/x',
      'http://127.0.0.1.evil.com/cb',
      'http://localhost.evil.com/cb',
      'http://evil.com/?h=127.0.0.1',
      'https://127.0.0.1:1/cb',
      'http://0.0.0.0:1/cb',
      'ftp://127.0.0.1/cb',
      'not a url',
    ]) {
      expect(allow.redirectUrisAllowed(uri(u), DEFAULTS, true)).toBe(false);
    }
  });

  test('on: EVERY registered URI must pass; one stranger refuses the whole client', () => {
    expect(allow.redirectUrisAllowed(uri('http://127.0.0.1:1/a', 'https://evil.example/cb'), DEFAULTS, true)).toBe(false);
    expect(allow.redirectUrisAllowed(uri('http://127.0.0.1:1/a', 'https://chatgpt.com/cb'), DEFAULTS, true)).toBe(true);
  });

  test('approved hosts behave as before with the option on or off', () => {
    for (const flag of [false, true]) {
      expect(allow.redirectUrisAllowed(uri('https://chatgpt.com/connector/oauth/x'), DEFAULTS, flag)).toBe(true);
      expect(allow.redirectUrisAllowed(uri('https://claude.ai/api/mcp/auth_callback'), DEFAULTS, flag)).toBe(true);
      expect(allow.redirectUrisAllowed(uri('https://evilchatgpt.com/cb'), DEFAULTS, flag)).toBe(false);
      expect(allow.redirectUrisAllowed([], DEFAULTS, flag)).toBe(false);
    }
  });

  test('checkMcpClient: a loopback client is approved with the option and refused without it', async () => {
    allow.resetClientCache();
    const rpc = jest.fn().mockResolvedValue({
      data: { client_name: 'Codex', redirect_uris: 'http://127.0.0.1:57859/callback/ura9nyf6TpeZ' },
      error: null,
    });
    const claims = { client_id: 'codex-1' };
    const actual = jest.requireActual('../src/services/mcp-client-allowlist');
    expect(await actual.checkMcpClient({ rpc } as any, claims, process.env, Date.now(), { allowLoopback: true })).toEqual({
      ok: true,
      clientId: 'codex-1',
      clientName: 'Codex',
      delegated: true,
      loopback: true,
    });
    expect(await actual.checkMcpClient({ rpc } as any, claims)).toEqual({ ok: false, reason: 'client_not_approved' });
    expect(await actual.checkMcpClient({ rpc } as any, claims, process.env, Date.now(), { allowLoopback: false })).toEqual({
      ok: false,
      reason: 'client_not_approved',
    });
  });

  test('checkMcpClient: an approved-host client carries no loopback flag, even with the option on', async () => {
    allow.resetClientCache();
    const rpc = jest.fn().mockResolvedValue({ data: { client_name: 'Claude', redirect_uris: 'https://claude.ai/api/mcp/auth_callback' }, error: null });
    const actual = jest.requireActual('../src/services/mcp-client-allowlist');
    expect(await actual.checkMcpClient({ rpc } as any, { client_id: 'c-1' }, process.env, Date.now(), { allowLoopback: true })).toEqual({
      ok: true,
      clientId: 'c-1',
      clientName: 'Claude',
      delegated: true,
    });
  });
});

describe('the delegated-token guard covers the new paths and nothing more', () => {
  test('/mcp/chatgpt and the well-known documents are allowed; REST routes are not', () => {
    expect(isDelegatedPathAllowed('/mcp/chatgpt')).toBe(true);
    expect(isDelegatedPathAllowed('/.well-known/oauth-authorization-server')).toBe(true);
    expect(isDelegatedPathAllowed('/.well-known/oauth-protected-resource/mcp/chatgpt')).toBe(true);
    for (const p of ['/api/v1/profile', '/api/v1/partner-onboarding/me', '/mcpx', '/mcp-admin']) expect(isDelegatedPathAllowed(p)).toBe(false);
  });
});

describe('rollout: staging has the switch on, production workflow does not pin it', () => {
  const wf = (f: string) => fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows', f), 'utf8');
  test('staging pins COMMERCE_MCP_CHATGPT=true in both lists; the production workflow never sets it', () => {
    const stage = wf('AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(stage).toContain('"COMMERCE_MCP_CHATGPT","COMMERCE_MCP_ENABLED","AUTOPILOT_ACTION_REWARD_ENABLED"');
    expect(stage).toContain('{name:"COMMERCE_MCP_CHATGPT", value:"true"}');
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).not.toContain('COMMERCE_MCP_CHATGPT');
  });
});
