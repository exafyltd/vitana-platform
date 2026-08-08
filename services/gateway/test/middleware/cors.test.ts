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
 *   - sseHeaders: applies SSE headers only on GET /stream|/events paths, never
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
  function run(method: string, path: string) {
    const req: any = { method, path };
    const res: any = { setHeader: jest.fn() };
    const next = jest.fn();
    sseHeaders(req, res, next);
    return { res, next };
  }

  it('sets SSE headers on GET /stream paths', () => {
    const { res, next } = run('GET', '/api/v1/live/stream');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(next).toHaveBeenCalled();
  });

  it('sets SSE headers on GET /events paths', () => {
    const { res, next } = run('GET', '/api/v1/oasis/events');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(next).toHaveBeenCalled();
  });

  it('does NOT set SSE headers on POST /stream/send (JSON route regression)', () => {
    const { res, next } = run('POST', '/api/v1/live/stream/send');
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('does NOT set SSE headers on unrelated GET paths', () => {
    const { res, next } = run('GET', '/api/v1/tasks');
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
