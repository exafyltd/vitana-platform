/**
 * VTID-04968 — AI delegated credentials operate Vitanaland only through the
 * reviewed MCP surface: the gateway-wide guard, the /mcp client allow-list,
 * their audit, and the standing check that no new write route appears on the
 * partner-onboarding routers without a conscious decision.
 */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import * as jose from 'jose';

const emitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => emitOasisEvent(...a) }));
const rpc = jest.fn();
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) }));

import {
  classifyBearer,
  delegatedTokenGuard,
  guardMode,
  isDelegatedPathAllowed,
  resetDelegationCache,
  sessionVerdict,
} from '../src/services/delegation-guard';
import {
  allowedRedirectHosts,
  checkMcpClient,
  hostAllowed,
  parseRedirectUris,
  redirectUrisAllowed,
  resetClientCache,
} from '../src/services/mcp-client-allowlist';

const ISS = 'https://proj.supabase.example/auth/v1';
const key = new TextEncoder().encode('test-secret-test-secret-test-secret');
async function token(claims: Record<string, unknown>): Promise<string> {
  return new jose.SignJWT({ role: 'authenticated', iss: ISS, ...claims } as jose.JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('u-1')
    .sign(key);
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(delegatedTokenGuard());
  a.all('*', (_req, res) => res.json({ reached: true }));
  return a;
}

const prev = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  resetDelegationCache();
  resetClientCache();
  process.env.SUPABASE_URL = 'https://proj.supabase.example';
  delete process.env.DELEGATION_GUARD;
  delete process.env.DELEGATION_GUARD_UNKNOWN;
  delete process.env.COMMERCE_MCP_ALLOWED_REDIRECT_HOSTS;
  rpc.mockResolvedValue({ data: 'direct', error: null });
});
afterAll(() => {
  process.env = prev;
});

describe('classifyBearer', () => {
  it('a client_id claim is delegated without any lookup', async () => {
    const r = await classifyBearer(await token({ client_id: 'c-1', session_id: 's-1' }), null);
    expect(r.verdict).toBe('delegated');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('a claim-less token is classified by its session', async () => {
    rpc.mockResolvedValueOnce({ data: 'delegated', error: null });
    const r = await classifyBearer(await token({ session_id: 's-2' }), { rpc } as any);
    expect(r.verdict).toBe('delegated');
    expect(rpc).toHaveBeenCalledWith('auth_session_is_delegated', { p_session_id: 's-2' });
  });
  it('a first-party session is direct', async () => {
    expect((await classifyBearer(await token({ session_id: 's-3' }), { rpc } as any)).verdict).toBe('direct');
  });
  it('no session id on a user token is unknown', async () => {
    expect((await classifyBearer(await token({}), { rpc } as any)).verdict).toBe('unknown');
  });
  it('tokens that cannot come from our OAuth server are skipped', async () => {
    expect((await classifyBearer(await token({ iss: 'https://other.supabase.example/auth/v1', session_id: 's' }), { rpc } as any)).verdict).toBe('skip');
    expect((await classifyBearer(await token({ role: 'service_role' }), { rpc } as any)).verdict).toBe('skip');
    expect((await classifyBearer('not-a-jwt', { rpc } as any)).verdict).toBe('skip');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('the session lookup is cached, and a lookup failure reuses the last verdict', async () => {
    rpc.mockResolvedValueOnce({ data: 'delegated', error: null });
    expect(await sessionVerdict({ rpc } as any, 's-9', 1_000)).toBe('delegated');
    expect(await sessionVerdict({ rpc } as any, 's-9', 2_000)).toBe('delegated');
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    expect(await sessionVerdict({ rpc } as any, 's-9', 70_000)).toBe('delegated'); // stale-if-error
    rpc.mockRejectedValueOnce(new Error('down'));
    expect(await sessionVerdict({ rpc } as any, 's-never-seen', 70_000)).toBe('unknown');
  });
});

describe('delegatedTokenGuard', () => {
  it('keeps a delegated token off the REST API, with an audit event', async () => {
    const res = await request(app()).get('/api/v1/profile').set('Authorization', `Bearer ${await token({ client_id: 'c-1' })}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DELEGATED_TOKEN_NOT_ALLOWED');
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'commerce.mcp.delegated_token_blocked', actor_id: 'u-1' }));
    const ev = emitOasisEvent.mock.calls[0][0];
    expect(ev.payload).toEqual(expect.objectContaining({ outcome: 'blocked', verdict: 'delegated', path: '/api/v1/profile', client_id: 'c-1' }));
  });
  it('blocks writes as well as reads, including the partner-onboarding submit and terms routes', async () => {
    const t = await token({ client_id: 'c-1' });
    for (const p of ['/api/v1/partner-onboarding/o-1/submit', '/api/v1/partner-onboarding/o-1/terms/accept']) {
      const res = await request(app()).post(p).set('Authorization', `Bearer ${t}`).send({});
      expect(res.status).toBe(403);
    }
  });
  it('lets a delegated token reach /mcp and the discovery documents', async () => {
    const t = await token({ client_id: 'c-1' });
    for (const p of ['/mcp', '/.well-known/oauth-protected-resource/mcp', '/.well-known/openai-apps-challenge']) {
      const res = await request(app()).post(p).set('Authorization', `Bearer ${t}`).send({});
      expect(res.status).toBe(200);
    }
    expect(isDelegatedPathAllowed('/mcpx')).toBe(false);
    expect(isDelegatedPathAllowed('/api/v1/mcp')).toBe(false);
    expect(isDelegatedPathAllowed('/.well-known-evil')).toBe(false);
  });
  it('a claim-less delegated session is blocked too', async () => {
    rpc.mockResolvedValue({ data: 'delegated', error: null });
    const res = await request(app()).get('/api/v1/wallet').set('Authorization', `Bearer ${await token({ session_id: 's-d' })}`);
    expect(res.status).toBe(403);
  });
  it("leaves the user's own session alone", async () => {
    const res = await request(app()).post('/api/v1/profile').set('Authorization', `Bearer ${await token({ session_id: 's-own' })}`).send({});
    expect(res.status).toBe(200);
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });
  it('unknown origin fails closed for writes and lets reads through', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    const t = await token({ session_id: 's-x' });
    expect((await request(app()).post('/api/v1/profile').set('Authorization', `Bearer ${t}`).send({})).status).toBe(403);
    expect((await request(app()).get('/api/v1/profile').set('Authorization', `Bearer ${t}`)).status).toBe(200);
    process.env.DELEGATION_GUARD_UNKNOWN = 'allow';
    expect((await request(app()).post('/api/v1/profile').set('Authorization', `Bearer ${t}`).send({})).status).toBe(200);
  });
  it('passes requests without a token, other issuers, and preflights', async () => {
    expect((await request(app()).get('/api/v1/public')).status).toBe(200);
    const foreign = await token({ iss: 'https://other.example/auth/v1', session_id: 's' });
    expect((await request(app()).post('/api/v1/x').set('Authorization', `Bearer ${foreign}`).send({})).status).toBe(200);
    expect((await request(app()).options('/api/v1/x').set('Authorization', `Bearer ${await token({ client_id: 'c' })}`)).status).toBe(200);
  });
  it('log mode reports but does not block; off mode is silent', async () => {
    const t = await token({ client_id: 'c-1' });
    process.env.DELEGATION_GUARD = 'log';
    expect((await request(app()).get('/api/v1/profile').set('Authorization', `Bearer ${t}`)).status).toBe(200);
    expect(emitOasisEvent.mock.calls[0][0].payload.outcome).toBe('would_block');
    emitOasisEvent.mockClear();
    resetDelegationCache();
    process.env.DELEGATION_GUARD = 'off';
    expect((await request(app()).get('/api/v1/profile').set('Authorization', `Bearer ${t}`)).status).toBe(200);
    expect(emitOasisEvent).not.toHaveBeenCalled();
    expect(guardMode({ DELEGATION_GUARD: 'typo' } as any)).toBe('enforce');
  });
  it('audits one event per user per minute, not one per probe', async () => {
    const t = await token({ client_id: 'c-1' });
    for (let i = 0; i < 5; i++) await request(app()).get('/api/v1/profile').set('Authorization', `Bearer ${t}`);
    expect(emitOasisEvent).toHaveBeenCalledTimes(1);
  });
  it('is mounted after the body parser and before every router in index.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    const json = src.indexOf("app.use(express.json({ limit: '2mb' }))");
    const guard = src.indexOf('app.use(delegatedTokenGuard())');
    const firstMount = src.indexOf('mountRouterSync(app,');
    expect(json).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(json);
    expect(firstMount).toBeGreaterThan(guard);
  });
});

describe('MCP client allow-list', () => {
  it('parses the redirect URIs Supabase stores', () => {
    expect(parseRedirectUris('["https://chatgpt.com/connector/oauth/a","https://chatgpt.com/b"]')).toEqual(['https://chatgpt.com/connector/oauth/a', 'https://chatgpt.com/b']);
    expect(parseRedirectUris('https://claude.ai/api/mcp/auth_callback, https://claude.com/x')).toHaveLength(2);
    expect(parseRedirectUris(['https://claude.ai/x'])).toEqual(['https://claude.ai/x']);
    expect(parseRedirectUris(null)).toEqual([]);
  });
  it('matches the host or a subdomain, never a lookalike', () => {
    const a = ['chatgpt.com'];
    expect(hostAllowed('chatgpt.com', a)).toBe(true);
    expect(hostAllowed('www.chatgpt.com', a)).toBe(true);
    expect(hostAllowed('evilchatgpt.com', a)).toBe(false);
    expect(hostAllowed('chatgpt.com.evil.io', a)).toBe(false);
  });
  it('needs every redirect to be https on an approved host', () => {
    const a = allowedRedirectHosts();
    expect(redirectUrisAllowed(['https://chatgpt.com/connector/oauth/x'], a)).toBe(true);
    expect(redirectUrisAllowed(['https://chatgpt.com/x', 'https://evil.example/cb'], a)).toBe(false);
    expect(redirectUrisAllowed(['http://chatgpt.com/x'], a)).toBe(false);
    expect(redirectUrisAllowed(['http://localhost:3000/cb'], a)).toBe(false);
    expect(redirectUrisAllowed([], a)).toBe(false);
  });
  it('approves a registered ChatGPT or Claude client and refuses everything else', async () => {
    rpc.mockResolvedValueOnce({ data: { client_name: 'ChatGPT', redirect_uris: '["https://chatgpt.com/connector/oauth/abc"]' }, error: null });
    expect(await checkMcpClient({ rpc } as any, { client_id: 'c-gpt' })).toEqual({ ok: true, clientId: 'c-gpt', clientName: 'ChatGPT', delegated: true });
    rpc.mockResolvedValueOnce({ data: { client_name: 'ChatGPT', redirect_uris: 'https://evil.example/cb' }, error: null });
    expect(await checkMcpClient({ rpc } as any, { client_id: 'c-evil' })).toEqual({ ok: false, reason: 'client_not_approved' });
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await checkMcpClient({ rpc } as any, { client_id: 'c-gone' })).toEqual({ ok: false, reason: 'client_unknown' });
    rpc.mockRejectedValueOnce(new Error('boom'));
    expect(await checkMcpClient({ rpc } as any, { client_id: 'c-err' })).toEqual({ ok: false, reason: 'client_unknown' });
    expect(await checkMcpClient(null, { client_id: 'c-nodb' })).toEqual({ ok: false, reason: 'client_unknown' });
  });
  it('honours the configured host list', async () => {
    process.env.COMMERCE_MCP_ALLOWED_REDIRECT_HOSTS = 'partner.example';
    rpc.mockResolvedValue({ data: { client_name: 'X', redirect_uris: 'https://chatgpt.com/x' }, error: null });
    expect((await checkMcpClient({ rpc } as any, { client_id: 'c-1' })).ok).toBe(false);
  });
  it('a token without client_id is allowed only when its session is the user’s own', async () => {
    rpc.mockResolvedValueOnce({ data: 'direct', error: null });
    expect((await checkMcpClient({ rpc } as any, { session_id: 's-1' })).ok).toBe(true);
    rpc.mockResolvedValueOnce({ data: 'delegated', error: null });
    expect(await checkMcpClient({ rpc } as any, { session_id: 's-2' })).toEqual({ ok: false, reason: 'client_unidentified' });
    expect(await checkMcpClient({ rpc } as any, {})).toEqual({ ok: false, reason: 'session_origin_unknown' });
  });
});

describe('standing route check', () => {
  // Every write route on the partner-onboarding routers is listed here on
  // purpose. A new one fails this test until someone decides it belongs (and,
  // for steps only the supplier may take, adds a requestDelegation check like
  // terms/accept). The global guard already keeps delegated tokens off all of
  // them; this keeps the list a conscious one.
  const KNOWN_WRITE_ROUTES = [
    'partner-onboarding-catalogue.ts put /:orgId/catalogue/merchant',
    'partner-onboarding-catalogue.ts post /:orgId/catalogue/products',
    'partner-onboarding-catalogue.ts post /:orgId/catalogue/products/import',
    'partner-onboarding-catalogue.ts patch /:orgId/catalogue/products/:productId',
    'partner-onboarding-connections.ts post /:orgId/connections',
    'partner-onboarding.ts post /start',
    'partner-onboarding.ts patch /:orgId/company',
    'partner-onboarding.ts post /:orgId/detect',
    'partner-onboarding.ts post /:orgId/verification/check',
    'partner-onboarding.ts post /:orgId/terms/accept',
    'partner-onboarding.ts post /:orgId/submit',
  ];
  const HUMAN_ONLY = ['/:orgId/terms/accept'];

  const dir = path.join(__dirname, '../src/routes');
  const files = fs.readdirSync(dir).filter((f) => /^partner-onboarding.*\.ts$/.test(f));
  const found: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/^router\.(post|put|patch|delete)\(\s*'([^']+)'/gm)) found.push(`${f} ${m[1]} ${m[2]}`);
  }

  it('lists every write route on the partner-onboarding routers', () => {
    expect(found.sort()).toEqual([...KNOWN_WRITE_ROUTES].sort());
  });
  it('keeps the steps only a supplier takes behind the delegation check', () => {
    const src = fs.readFileSync(path.join(dir, 'partner-onboarding.ts'), 'utf8');
    for (const route of HUMAN_ONLY) {
      const at = src.indexOf(`router.post('${route}'`);
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(at, at + 1500)).toContain('requestDelegation(');
    }
  });
});
