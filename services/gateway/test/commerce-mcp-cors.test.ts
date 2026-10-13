/**
 * VTID-05079 — OpenAI's plugin portal reads our OAuth discovery documents and calls the
 * ChatGPT MCP endpoint from the browser. The generic CORS handler answered any unknown
 * origin with an HTML 500, so the portal reported "Authorization unavailable". Two narrow
 * rules (exact paths) fix that; everything else keeps the existing allow-list.
 */
import express from 'express';
import request from 'supertest';
import { setupCors, applyDiscoveryCors } from '../src/middleware/cors';

const OPENAI = 'https://platform.openai.com';
const CHATGPT = 'https://chatgpt.com';
const STRANGER = 'https://example.com';
const ALLOWED = 'https://vitanaland.com';

function app() {
  const a = express();
  a.use(express.json());
  setupCors(a);
  const ok = (_req: express.Request, res: express.Response) => res.status(200).send('ok');
  a.get('/.well-known/oauth-authorization-server', ok);
  a.get('/.well-known/oauth-protected-resource/mcp/chatgpt', ok);
  a.get('/.well-known/openai-apps-challenge', ok);
  a.post('/.well-known/oauth-authorization-server', ok);
  a.post('/mcp/chatgpt', (_req, res) => res.status(401).set('WWW-Authenticate', 'Bearer resource_metadata="x"').json({ error: 'unauthorized' }));
  a.post('/mcp', ok);
  a.get('/api/v1/x', ok);
  a.post('/mcp/chatgptx', ok);
  a.post('/mcp/chatgpt/extra', ok);
  a.get('/.well-known-evil', ok);
  return a;
}

const DISCOVERY = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp/chatgpt', '/.well-known/openai-apps-challenge'];

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('discovery documents (/.well-known/*)', () => {
  it.each(DISCOVERY)('%s is readable from OpenAI\'s portal and from any origin, and unchanged without an origin', async (p) => {
    for (const origin of [OPENAI, CHATGPT, STRANGER, ALLOWED]) {
      const res = await request(app()).get(p).set('Origin', origin);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
    const plain = await request(app()).get(p);
    expect(plain.status).toBe(200);
  });

  it('answers a preflight with an explicit 204 and the allow headers', async () => {
    const res = await request(app()).options('/.well-known/oauth-authorization-server').set('Origin', OPENAI).set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
  });

  it('does not cover other methods: a POST from a stranger is still refused', async () => {
    const res = await request(app()).post('/.well-known/oauth-authorization-server').set('Origin', STRANGER).send({});
    expect(res.status).toBe(500);
  });
});

describe('ChatGPT MCP endpoint (/mcp/chatgpt)', () => {
  it.each([OPENAI, CHATGPT])('a preflight from %s is 204, the origin is reflected (never *), the challenge header is exposed', async (origin) => {
    const res = await request(app())
      .options('/mcp/chatgpt')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['vary']).toMatch(/Origin/);
    expect(res.headers['access-control-allow-headers']).toMatch(/Authorization/);
    expect(res.headers['access-control-expose-headers']).toMatch(/WWW-Authenticate/);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('a POST from OpenAI reaches the handler (still 401 without a token) and the browser can read the challenge', async () => {
    const res = await request(app()).post('/mcp/chatgpt').set('Origin', OPENAI).send({});
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(OPENAI);
    expect(res.headers['access-control-expose-headers']).toMatch(/WWW-Authenticate/);
  });

  it('a stranger keeps today\'s behaviour (500), and so does no origin at all (200/401 from the route)', async () => {
    expect((await request(app()).post('/mcp/chatgpt').set('Origin', STRANGER).send({})).status).toBe(500);
    expect((await request(app()).options('/mcp/chatgpt').set('Origin', STRANGER).set('Access-Control-Request-Method', 'POST')).status).toBe(500);
    expect((await request(app()).post('/mcp/chatgpt').send({})).status).toBe(401);
  });
});

describe('nothing else is widened', () => {
  it('/mcp (Claude\'s path) from OpenAI and Claude origins is still refused, an allowed origin still passes', async () => {
    expect((await request(app()).post('/mcp').set('Origin', OPENAI).send({})).status).toBe(500);
    expect((await request(app()).post('/mcp').set('Origin', 'https://claude.ai').send({})).status).toBe(500);
    const ok = await request(app()).post('/mcp').set('Origin', ALLOWED).send({});
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('an API path from OpenAI is still refused, from an allowed origin it keeps the existing headers', async () => {
    expect((await request(app()).get('/api/v1/x').set('Origin', OPENAI)).status).toBe(500);
    const ok = await request(app()).get('/api/v1/x').set('Origin', ALLOWED);
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('look-alike paths are not covered', async () => {
    for (const [method, p] of [['post', '/mcp/chatgptx'], ['post', '/mcp/chatgpt/extra'], ['get', '/.well-known-evil']] as const) {
      const res = await (request(app()) as any)[method](p).set('Origin', OPENAI).send({});
      expect(res.status).toBe(500);
    }
  });
});

describe('applyDiscoveryCors (unit)', () => {
  const fake = (method: string, path: string, origin?: string) => {
    const headers: Record<string, string> = {};
    const req = { method, path, headers: origin ? { origin } : {} } as any;
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as any;
    return { handled: applyDiscoveryCors(req, res), headers };
  };

  it('handles exactly the two rules', () => {
    expect(fake('GET', '/.well-known/x', STRANGER).handled).toBe(true);
    expect(fake('POST', '/mcp/chatgpt', OPENAI).handled).toBe(true);
    expect(fake('POST', '/mcp/chatgpt', STRANGER).handled).toBe(false);
    expect(fake('POST', '/mcp/chatgpt').handled).toBe(false);
    expect(fake('GET', '/mcp/chatgpt', OPENAI).handled).toBe(false);
    expect(fake('POST', '/mcp', OPENAI).handled).toBe(false);
    expect(fake('GET', '/api/v1/x', OPENAI).handled).toBe(false);
  });
});
