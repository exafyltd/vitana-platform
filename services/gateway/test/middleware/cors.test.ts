/**
 * Tests for src/middleware/cors.ts (VTID-01176 / VTID-01226 origin allowlist).
 *
 * Contract under test:
 *   - corsOptions.origin: allows requests with no Origin (curl/same-process),
 *     exact allowlisted origins, and the dynamic Lovable / Cloud Run
 *     community-app patterns; errors ("Not allowed by CORS") for anything else,
 *     including scheme downgrades and suffix-spoofing lookalikes.
 *   - credentials stays false (VTID-02036 revert — regression guard).
 *   - setupCors wiring: allowed origin gets Access-Control-Allow-Origin and a
 *     working preflight; blocked origin propagates an error (500) with no
 *     CORS headers.
 *   - sseHeaders: applies SSE headers only on GET /stream paths (and /events when the client asks for text/event-stream), never
 *     on POST /stream/send-style JSON routes.
 */

import request from 'supertest';
import express from 'express';

import { corsOptions, setupCors, sseHeaders } from '../../src/middleware/cors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkOrigin(origin: string | undefined): Promise<{ err: Error | null; allow?: boolean }> {
  return new Promise((resolve) => {
    corsOptions.origin(origin, (err: Error | null, allow?: boolean) => resolve({ err, allow }));
  });
}

describe('corsOptions.origin callback', () => {
  it('allows requests without an Origin header (server-to-server / curl)', async () => {
    const { err, allow } = await checkOrigin(undefined);
    expect(err).toBeNull();
    expect(allow).toBe(true);
  });

  it.each([
    'https://vitanaland.com',
    'https://www.vitanaland.com',
    'https://preview.vitanaland.com',
    'https://preview-gateway.vitanaland.com',
    'https://gateway.vitanaland.com',
    'https://dr-app.vitanaland.com',
    'https://community-app-86804897789.us-central1.run.app',
  ])('allows exact allowlisted origin %s', async (origin) => {
    const { err, allow } = await checkOrigin(origin);
    expect(err).toBeNull();
    expect(allow).toBe(true);
  });

  it.each([
    'https://my-project-preview.lovableproject.com',
    'https://some-app-123.lovable.app',
    'https://community-app-00030-abc.run.app',
    'https://community-app-xyz9.us-central1.run.app',
  ])('allows dynamic pattern origin %s', async (origin) => {
    const { err, allow } = await checkOrigin(origin);
    expect(err).toBeNull();
    expect(allow).toBe(true);
  });

  it.each([
    'https://evil.com',
    'http://vitanaland.com', // scheme downgrade
    'https://vitanaland.com.evil.com', // suffix spoof of an exact entry
    'https://foo.lovable.app.evil.com', // suffix spoof of a pattern (anchoring)
    'https://xlovable.app', // missing dot before pattern domain
    'https://community-app-abc.run.app.evil.com',
    'https://sub.preview.vitanaland.com', // subdomain of an exact entry
  ])('blocks disallowed origin %s', async (origin) => {
    const { err, allow } = await checkOrigin(origin);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Not allowed by CORS');
    expect(allow).toBeUndefined();
  });

  it('keeps credentials disabled (VTID-02036 revert regression guard)', () => {
    expect(corsOptions.credentials).toBe(false);
    expect(corsOptions.maxAge).toBe(86400);
    expect(corsOptions.methods).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    );
  });
});

describe('setupCors (Express integration)', () => {
  const app = express();
  setupCors(app);
  app.get('/ping', (_req, res) => res.json({ ok: true }));

  it('sets Access-Control-Allow-Origin for an allowed origin', async () => {
    const res = await request(app).get('/ping').set('Origin', 'https://vitanaland.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://vitanaland.com');
    // credentials:false → no allow-credentials header on the response
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers preflight OPTIONS for an allowed origin', async () => {
    const res = await request(app)
      .options('/ping')
      .set('Origin', 'https://preview.vitanaland.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://preview.vitanaland.com');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-max-age']).toBe('86400');
  });

  it('errors (500, no CORS headers) for a blocked origin', async () => {
    const res = await request(app).get('/ping').set('Origin', 'https://evil.com');
    expect(res.status).toBe(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('sseHeaders', () => {
  function run(method: string, path: string, accept?: string) {
    const req: any = { method, path, headers: accept ? { accept } : {} };
    const res: any = { setHeader: jest.fn() };
    const next = jest.fn();
    sseHeaders(req, res, next);
    return { res, next };
  }

  it('leaves the Kiro run stream alone: the route sets its own SSE headers after auth (VTID-05065)', () => {
    const { res, next } = run('GET', '/api/v1/operator/kiro/runs/00000000-0000-4000-8000-000000000000/stream');
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('leaves the pipeline-tree stream alone: the route sets its own SSE headers after auth (VTID-05069)', () => {
    const { res, next } = run('GET', '/api/v1/operator/runs/VTID-05069/stream');
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('sets SSE headers on GET /stream paths', () => {
    const { res, next } = run('GET', '/api/v1/live/stream');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(next).toHaveBeenCalled();
  });

  // VTID-04695: every GET under /events is a JSON route; they were served as
  // text/event-stream (STAGING-VERIFY: calendar window 401 was event-stream,
  // /api/v1/oasis/events a JSON list labelled event-stream).
  it.each(['/api/v1/oasis/events', '/api/v1/calendar/events/window', '/api/v1/calendar/events', '/api/v1/universal-cart/events'])(
    'does NOT set SSE headers on the JSON route GET %s (VTID-04695)',
    (path) => {
      const { res, next } = run('GET', path, 'application/json');
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    },
  );

  it('sets SSE headers on GET /events when the client asks for a stream (EventSource)', () => {
    const { res, next } = run('GET', '/api/v1/oasis/events', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(next).toHaveBeenCalled();
  });

  it('does NOT set SSE headers on POST /stream/send (JSON route regression)', () => {
    const { res, next } = run('POST', '/api/v1/live/stream/send');
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it.each([
    '/command-hub/oasis/events/',
    '/command-hub/oasis/streams/',
    '/command-hub/command-hub/events/',
    '/command-hub/events.js',
  ])('does NOT set SSE headers on Command Hub page %s (VTID-04615)', (path) => {
    const { res, next } = run('GET', path);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('still sets SSE headers on the API stream the Command Hub opens', () => {
    const { res } = run('GET', '/api/v1/events/stream');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
  });

  it.each([
    '/api/v1/calendar/events',
    '/api/v1/calendar/events/window',
    '/api/v1/calendar/events/abc-123',
  ])('does NOT set SSE headers on the calendar JSON API: %s (VTID-04680)', (path) => {
    const { res, next } = run('GET', path);
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(next).toHaveBeenCalled();
  });

  it('does NOT set SSE headers on unrelated GET paths', () => {
    const { res, next } = run('GET', '/api/v1/tasks');
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// VTID-05243: CORS_EXTRA_ORIGINS — read once at module load, appended to the
// compiled list. Each env value gets a fresh module via jest.resetModules() +
// a dynamic require inside jest.isolateModules (the static import above is
// never reused for these cases).
// ---------------------------------------------------------------------------

type CorsModule = typeof import('../../src/middleware/cors');

function loadCors(extra: string | undefined): CorsModule {
  const saved = process.env.CORS_EXTRA_ORIGINS;
  if (extra === undefined) delete process.env.CORS_EXTRA_ORIGINS;
  else process.env.CORS_EXTRA_ORIGINS = extra;
  let mod: CorsModule | undefined;
  try {
    jest.resetModules();
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('../../src/middleware/cors');
    });
  } finally {
    if (saved === undefined) delete process.env.CORS_EXTRA_ORIGINS;
    else process.env.CORS_EXTRA_ORIGINS = saved;
  }
  return mod as CorsModule;
}

function checkWith(mod: CorsModule, origin: string): Promise<{ err: Error | null; allow?: boolean }> {
  return new Promise((resolve) => {
    mod.corsOptions.origin(origin, (err: Error | null, allow?: boolean) => resolve({ err, allow }));
  });
}

// Every compiled origin on main before VTID-05243 — unset env must keep all of them.
const COMPILED_ORIGINS = [
  'https://vitana-gateway-86804897789.us-central1.run.app',
  'https://gateway-86804897789.us-central1.run.app',
  'https://gateway-q74ibpv6ia-uc.a.run.app',
  'https://gateway.vitanaland.com',
  'https://vitana-dev-gateway-86804897789.us-central1.run.app',
  'https://community-app-86804897789.us-central1.run.app',
  'https://community-app-q74ibpv6ia-uc.a.run.app',
  'https://id-preview--vitana-v1.lovable.app',
  'https://vitanaland.com',
  'https://www.vitanaland.com',
  'https://preview.vitanaland.com',
  'https://preview-gateway.vitanaland.com',
  'https://gateway-staging-q74ibpv6ia-uc.a.run.app',
  'https://preview-aws.vitanaland.com',
  'https://preview-aws-gateway.vitanaland.com',
  'https://dr-app.vitanaland.com',
  'https://dr-gateway.vitanaland.com',
];
const PATTERN_ORIGINS = [
  'https://my-project-preview.lovableproject.com',
  'https://some-app-123.lovable.app',
  'https://community-app-00030-abc.run.app',
  'https://community-app-xyz9.us-central1.run.app',
];

describe('CORS_EXTRA_ORIGINS (VTID-05243)', () => {
  it.each([undefined, '', ' , ,'])('env %p keeps every compiled origin and pattern, blocks unknown', async (env) => {
    const mod = loadCors(env);
    for (const origin of [...COMPILED_ORIGINS, ...PATTERN_ORIGINS]) {
      const { err, allow } = await checkWith(mod, origin);
      expect(err).toBeNull();
      expect(allow).toBe(true);
    }
    const blocked = await checkWith(mod, 'https://tenant-brand.example.com');
    expect(blocked.err).toBeInstanceOf(Error);
  });

  it('allows configured extra origins (trimmed) and keeps the compiled list', async () => {
    const mod = loadCors(' https://tenant-brand.example.com ,https://app.other-tenant.org:8443');
    for (const origin of ['https://tenant-brand.example.com', 'https://app.other-tenant.org:8443', ...COMPILED_ORIGINS, ...PATTERN_ORIGINS]) {
      const { err, allow } = await checkWith(mod, origin);
      expect(err).toBeNull();
      expect(allow).toBe(true);
    }
  });

  it('ignores malformed, non-https, path and wildcard entries', async () => {
    const bad = [
      'http://insecure.example.com',
      'https://*.wild.example.com',
      '*',
      'https://path.example.com/app',
      'https://trailing.example.com/',
      'https://query.example.com?x=1',
      'not-a-url',
      'https://',
      'https://user@cred.example.com',
    ];
    const mod = loadCors(bad.join(','));
    for (const origin of [...bad, 'https://path.example.com', 'https://trailing.example.com', 'https://query.example.com', 'https://cred.example.com', 'https://x.wild.example.com']) {
      const { err } = await checkWith(mod, origin);
      expect(err).toBeInstanceOf(Error);
    }
    const unknown = await checkWith(mod, 'https://evil.com');
    expect(unknown.err).toBeInstanceOf(Error);
  });

  it('an extra origin gets the generic CORS reply on a normal route', async () => {
    const mod = loadCors('https://tenant-brand.example.com');
    const app = express();
    mod.setupCors(app);
    app.get('/ping', (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/ping').set('Origin', 'https://tenant-brand.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://tenant-brand.example.com');
  });

  it('leaves /.well-known/* and /mcp/chatgpt unchanged: an extra origin never widens the MCP rule', async () => {
    const mod = loadCors('https://tenant-brand.example.com');
    const app = express();
    mod.setupCors(app);
    app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({ ok: true }));
    app.post('/mcp/chatgpt', (_req, res) => res.json({ ok: true }));

    const wk = await request(app).get('/.well-known/oauth-authorization-server').set('Origin', 'https://tenant-brand.example.com');
    expect(wk.headers['access-control-allow-origin']).toBe('*');

    const openai = await request(app).options('/mcp/chatgpt').set('Origin', 'https://platform.openai.com').set('Access-Control-Request-Method', 'POST');
    expect(openai.status).toBe(204);
    expect(openai.headers['access-control-allow-origin']).toBe('https://platform.openai.com');
    expect(openai.headers['access-control-expose-headers']).toContain('Mcp-Session-Id');

    for (const method of ['POST', 'OPTIONS']) {
      const req: any = { path: '/mcp/chatgpt', method, headers: { origin: 'https://tenant-brand.example.com' } };
      const res: any = { setHeader: jest.fn() };
      expect(mod.applyDiscoveryCors(req, res)).toBe(false);
      expect(res.setHeader).not.toHaveBeenCalled();
    }
    const extra = await request(app).options('/mcp/chatgpt').set('Origin', 'https://tenant-brand.example.com').set('Access-Control-Request-Method', 'POST');
    expect(extra.headers['access-control-expose-headers']).toBeUndefined();
    expect(String(extra.headers['access-control-allow-headers'] || '')).not.toContain('Mcp-Session-Id');
  });
});
