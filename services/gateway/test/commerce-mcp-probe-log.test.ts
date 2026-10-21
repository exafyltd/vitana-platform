/**
 * VTID-05135 / VTID-05140 — OpenAI's plugin scanner says "the latest scan did not complete" and nothing on
 * our side shows what it sends. A capped `commerce.mcp.probe` event records unauthenticated
 * hits on /mcp/chatgpt and its two discovery documents, and a token-less ChatGPT-path request
 * gets the plain RFC 6750 challenge (no error code). /mcp (Claude) is unchanged.
 */
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

function app() {
  const a = express();
  a.use(express.json());
  a.use('/mcp', routes.default);
  a.use('/.well-known', routes.wellKnownRouter);
  return a;
}

const HOST = 'gateway.vitanaland.com';
const SUPABASE = 'https://proj.supabase.example';
const META_CHATGPT = 'https://gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp/chatgpt';
const ping = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

const probes = () => emitOasisEvent.mock.calls.map((c) => c[0]).filter((e) => e.type === 'commerce.mcp.probe');
// the probe runs after the response has finished
const settle = () => new Promise((r) => setImmediate(r));

const prev = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  routes.resetMcpLimits();
  routes.resetProbeAudit();
  process.env.COMMERCE_MCP_ENABLED = 'true';
  process.env.COMMERCE_MCP_CHATGPT = 'true';
  process.env.SUPABASE_URL = SUPABASE;
  delete process.env.COMMERCE_MCP_PUBLIC_URL;
  delete process.env.COMMERCE_MCP_AUTH_ISSUER;
  verifyAndExtractIdentity.mockImplementation(async (t: string) =>
    t === 'good' ? { identity: { user_id: 'u-1', email: 'a@b.example', tenant_id: 't-1' }, claims: { client_id: 'codex-1' } } : null,
  );
  checkMcpClient.mockResolvedValue({ ok: true, clientId: 'codex-1', clientName: 'Codex', loopback: false });
  emitOasisEvent.mockResolvedValue({ ok: true });
});
afterAll(() => {
  process.env = prev;
});

describe('token-less POST /mcp/chatgpt', () => {
  test('plain challenge (no error code), body unchanged, one probe event', async () => {
    const res = await request(app())
      .post('/mcp/chatgpt')
      .set('Host', HOST)
      .set('User-Agent', 'OpenAI-Scanner/1.0')
      .set('Accept', 'application/json, text/event-stream')
      .send(ping);
    await settle();
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(`Bearer resource_metadata="${META_CHATGPT}", scope="email profile"`);
    expect(res.headers['www-authenticate']).not.toContain('error');
    expect(res.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Sign in to Vitanaland to connect this assistant.' } });
    const events = probes();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      vtid: 'VTID-05135',
      type: 'commerce.mcp.probe',
      source: 'commerce-mcp',
      status: 'info',
      payload: {
        method: 'POST',
        path: '/mcp/chatgpt',
        status: 401,
        user_agent: 'OpenAI-Scanner/1.0',
        accept: 'application/json, text/event-stream',
        has_authorization: false,
        jsonrpc_method: 'initialize',
      },
    });
  });

  test('a repeat inside the window emits nothing more; another user agent emits again', async () => {
    await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('User-Agent', 'A').send(ping);
    await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('User-Agent', 'A').send(ping);
    await settle();
    expect(probes()).toHaveLength(1);
    await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('User-Agent', 'B').send(ping);
    await settle();
    expect(probes()).toHaveLength(2);
  });
});

describe('POST /mcp/chatgpt with an unverifiable bearer token', () => {
  test('keeps the error code and description, logs a probe without the token', async () => {
    const res = await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('Authorization', 'Bearer secret-token-value').send(ping);
    await settle();
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${META_CHATGPT}", scope="email profile", error="invalid_token", error_description="The Vitanaland sign-in has expired or is not valid."`,
    );
    const events = probes();
    expect(events).toHaveLength(1);
    expect(events[0].payload.has_authorization).toBe(true);
    expect(JSON.stringify(events[0])).not.toContain('secret-token-value');
  });
});

describe('405 on /mcp/chatgpt', () => {
  test.each(['get', 'delete'] as const)('%s answers 405 unchanged and logs a probe', async (m) => {
    const res = await (request(app()) as any)[m]('/mcp/chatgpt').set('Host', HOST).set('User-Agent', `ua-${m}`);
    await settle();
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
    const events = probes();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ method: m.toUpperCase(), path: '/mcp/chatgpt', status: 405 });
  });
});

describe('discovery documents', () => {
  test.each(['/.well-known/oauth-protected-resource/mcp/chatgpt', '/.well-known/oauth-authorization-server'])(
    '%s answers 200 and logs a probe',
    async (path) => {
      const res = await request(app()).get(path).set('Host', HOST).set('User-Agent', 'OpenAI-Scanner/1.0');
      await settle();
      expect(res.status).toBe(200);
      const events = probes();
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ method: 'GET', path, status: 200 });
    },
  );

  test('the general / Claude documents emit nothing and answer as before', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await request(app()).get(path).set('Host', HOST);
      expect(res.status).toBe(200);
      expect(res.body.resource).toBe('https://gateway.vitanaland.com/mcp');
    }
    await settle();
    expect(probes()).toHaveLength(0);
  });
});

describe('/mcp (Claude) and authenticated calls', () => {
  test('/mcp challenge is unchanged and emits no probe', async () => {
    const res = await request(app()).post('/mcp').set('Host', HOST).send(ping);
    await settle();
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="https://gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp", scope="email profile", error="invalid_token", error_description="Sign in to Vitanaland to connect this assistant."',
    );
    expect(probes()).toHaveLength(0);
  });

  test('a valid token on /mcp/chatgpt emits no probe', async () => {
    const res = await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('Authorization', 'Bearer good').send(ping);
    await settle();
    expect(res.status).toBe(200);
    expect(probes()).toHaveLength(0);
  });
});

describe('caps and safety', () => {
  test('at most 60 events an hour; synthetic time, distinct keys; the hour window frees the cap', () => {
    const t0 = 1_000_000_000_000;
    let written = 0;
    for (let i = 0; i < 100; i += 1) if (routes.shouldAuditProbe(`GET|/x|ua-${i}`, t0 + i)) written += 1;
    expect(written).toBe(60);
    expect(routes.shouldAuditProbe('GET|/x|ua-new', t0 + 3_600_001 + 100)).toBe(true);
  });

  test('the same key is written again only after 15 minutes', () => {
    const t0 = 2_000_000_000_000;
    expect(routes.shouldAuditProbe('k', t0)).toBe(true);
    expect(routes.shouldAuditProbe('k', t0 + 14 * 60_000)).toBe(false);
    expect(routes.shouldAuditProbe('k', t0 + 15 * 60_000 + 1)).toBe(true);
  });

  test('the key map cannot grow past its cap', () => {
    const t0 = 3_000_000_000_000;
    // spread over several hours so the hourly ceiling never applies
    for (let i = 0; i < 2_100; i += 1) routes.shouldAuditProbe(`k-${i}`, t0 + i * 61_000);
    // after the clear at 2,000 keys the earliest keys are writable again (no unbounded growth)
    expect(routes.shouldAuditProbe('k-0', t0 + 2_100 * 61_000)).toBe(true);
  });

  test('a failing or throwing emitter never changes the response', async () => {
    emitOasisEvent.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('User-Agent', 'Z').send(ping);
    await settle();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(-32001);
  });

  test('long strings are clipped; the payload carries no credential, cookie or IP field', async () => {
    await request(app())
      .post('/mcp/chatgpt')
      .set('Host', HOST)
      .set('User-Agent', 'x'.repeat(500))
      .set('Cookie', 'session=abc')
      .set('X-Forwarded-For', '203.0.113.9')
      .send(ping);
    await settle();
    const [event] = probes();
    expect(event.payload.user_agent).toHaveLength(200);
    expect(Object.keys(event.payload).sort()).toEqual([
      'accept',
      'content_length',
      'content_type',
      'has_authorization',
      'header_names',
      'jsonrpc_method',
      'mcp_protocol_version',
      'method',
      'origin',
      'path',
      'response_content_type',
      'status',
      'user_agent',
    ]);
    expect(JSON.stringify(event)).not.toContain('203.0.113.9');
    expect(JSON.stringify(event)).not.toContain('session=abc');
  });
});

describe('VTID-05140: scanner-shaped requests on every path and status under /mcp and /.well-known', () => {
  const SCANNER = 'Python/3.14 aiohttp/3.14.4';

  test('an unknown /.well-known path answers 404 as before and is logged with the new fields', async () => {
    const res = await request(app()).get('/.well-known/openid-configuration').set('Host', HOST).set('User-Agent', SCANNER);
    await settle();
    expect(res.status).toBe(404);
    const events = probes();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      method: 'GET',
      path: '/.well-known/openid-configuration',
      status: 404,
      user_agent: SCANNER,
      has_authorization: false,
    });
    expect(Array.isArray(events[0].payload.header_names)).toBe(true);
    expect(events[0].payload.header_names).toContain('user-agent');
    const rct = events[0].payload.response_content_type;
    expect(rct === null || typeof rct === 'string').toBe(true);
  });

  test('POST under /mcp/chatgpt and /mcp that no route answers, and the general Claude document, are logged for the scanner', async () => {
    const a = await request(app()).post('/mcp/chatgpt/anything').set('Host', HOST).set('User-Agent', SCANNER).send(ping);
    const b = await request(app()).post('/mcp/unknown').set('Host', HOST).set('User-Agent', SCANNER).send(ping);
    const c = await request(app()).get('/.well-known/oauth-protected-resource').set('Host', HOST).set('User-Agent', SCANNER);
    await settle();
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(c.status).toBe(200);
    const events = probes();
    expect(events.map((e) => [e.payload.method, e.payload.path, e.payload.status])).toEqual([
      ['POST', '/mcp/chatgpt/anything', 404],
      ['POST', '/mcp/unknown', 404],
      ['GET', '/.well-known/oauth-protected-resource', 200],
    ]);
  });

  test('the same unknown paths with an ordinary user agent emit nothing', async () => {
    await request(app()).get('/.well-known/openid-configuration').set('Host', HOST).set('User-Agent', 'Mozilla/5.0');
    await request(app()).post('/mcp/chatgpt/anything').set('Host', HOST).set('User-Agent', 'Mozilla/5.0').send(ping);
    await request(app()).get('/.well-known/oauth-protected-resource').set('Host', HOST).set('User-Agent', 'Mozilla/5.0');
    await settle();
    expect(probes()).toHaveLength(0);
  });

  test('the codex client user agent is not scanner-shaped for this rule', async () => {
    await request(app()).get('/.well-known/openid-configuration').set('Host', HOST).set('User-Agent', 'codex-mcp-client/0.162.0');
    await settle();
    expect(probes()).toHaveLength(0);
  });

  test('header_names lists names only: no value of any header is stored', async () => {
    await request(app())
      .post('/mcp/chatgpt/anything')
      .set('Host', HOST)
      .set('User-Agent', SCANNER)
      .set('Authorization', 'Bearer secret-token-value')
      .set('Cookie', 'session=abc')
      .set('X-Forwarded-For', '203.0.113.9')
      .set('X_Under_Score', 'v')
      .send(ping);
    await settle();
    const [event] = probes();
    expect(event.payload.header_names).toEqual(expect.arrayContaining(['authorization', 'cookie', 'x-forwarded-for', 'user-agent']));
    expect(event.payload.header_names.every((n: string) => /^[a-z0-9-]{1,40}$/.test(n))).toBe(true);
    expect(event.payload.header_names.length).toBeLessThanOrEqual(40);
    expect(event.payload.header_names).not.toContain('x_under_score');
    const serialized = JSON.stringify(event);
    for (const value of ['secret-token-value', 'session=abc', '203.0.113.9']) expect(serialized).not.toContain(value);
  });

  test('content_length and mcp_protocol_version are recorded and clipped; the 401 records its own content type', async () => {
    await request(app())
      .post('/mcp/chatgpt')
      .set('Host', HOST)
      .set('User-Agent', SCANNER)
      .set('Mcp-Protocol-Version', '2025-06-18' + 'x'.repeat(100))
      .send(ping);
    await settle();
    const [event] = probes();
    expect(event.payload.status).toBe(401);
    expect(event.payload.mcp_protocol_version).toHaveLength(32);
    expect(event.payload.content_length).toBe(String(JSON.stringify(ping).length));
    expect(event.payload.response_content_type).toBe('application/json; charset=utf-8');
  });

  test('an authenticated call that succeeds is never logged; one that ends 4xx is', async () => {
    const ok = await request(app()).post('/mcp/chatgpt').set('Host', HOST).set('User-Agent', SCANNER).set('Authorization', 'Bearer good').send(ping);
    await settle();
    expect(ok.status).toBe(200);
    expect(probes()).toHaveLength(0);
    const nope = await request(app()).post('/mcp/chatgpt/nope').set('Host', HOST).set('User-Agent', SCANNER).set('Authorization', 'Bearer good').send(ping);
    await settle();
    expect(nope.status).toBe(404);
    expect(probes()).toHaveLength(1);
    expect(probes()[0].payload).toMatchObject({ status: 404, has_authorization: true });
  });

  test('the cap and the dedupe apply to scanner rows too', async () => {
    for (let i = 0; i < 3; i += 1) await request(app()).get('/.well-known/openid-configuration').set('Host', HOST).set('User-Agent', SCANNER);
    await settle();
    expect(probes()).toHaveLength(1);
  });

  test('a scanner user agent gets exactly the answers any other user agent gets', async () => {
    const paths: Array<['get' | 'post', string]> = [
      ['get', '/.well-known/openid-configuration'],
      ['get', '/.well-known/oauth-authorization-server'],
      ['post', '/mcp/chatgpt'],
      ['post', '/mcp/chatgpt/anything'],
      ['get', '/mcp/chatgpt'],
    ];
    for (const [method, path] of paths) {
      const send = (ua: string) => {
        const r = (request(app()) as any)[method](path).set('Host', HOST).set('User-Agent', ua);
        return method === 'post' ? r.send(ping) : r;
      };
      const [withScanner, plain] = [await send(SCANNER), await send('Mozilla/5.0')];
      expect(withScanner.status).toBe(plain.status);
      expect(withScanner.text).toBe(plain.text);
      expect(withScanner.headers['www-authenticate']).toBe(plain.headers['www-authenticate']);
      expect(withScanner.headers['content-type']).toBe(plain.headers['content-type']);
    }
  });
});
