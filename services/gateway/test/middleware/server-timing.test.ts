/**
 * Tests for src/middleware/server-timing.ts (VTID-03177 PROFILE, Phase 1 W1).
 *
 * Contract under test:
 *   - Feature gate: isFeatureLive('LATENCY_TELEMETRY') false → no-op, no header.
 *   - Feature on: emits a Server-Timing header with a `total;dur=<ms>` entry
 *     measured across the request.
 *   - Per-handler marks pushed onto res.locals.serverTimingMarks are emitted in
 *     insertion order BEFORE total; marks without dur emit just the name.
 *   - RFC 8941 hygiene: marks with non-conforming names are dropped entirely;
 *     non-conforming descs are dropped while the mark itself is kept.
 *   - Streaming responses (headers already flushed) never get the header, and
 *     the response still completes.
 */

import request from 'supertest';
import express from 'express';

jest.mock('../../src/services/feature-flags', () => ({
  isFeatureLive: jest.fn(),
}));

import { withServerTiming } from '../../src/middleware/server-timing';
import { isFeatureLive } from '../../src/services/feature-flags';

const mockIsFeatureLive = isFeatureLive as jest.Mock;

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------

const app = express();
app.use(withServerTiming());
app.get('/plain', (_req, res) => res.json({ ok: true }));
app.get('/marks', (_req, res) => {
  res.locals.serverTimingMarks?.push({ name: 'db', dur: 42 });
  res.locals.serverTimingMarks?.push({ name: 'render', dur: 8 });
  res.json({ ok: true });
});
app.get('/bad-name', (_req, res) => {
  res.locals.serverTimingMarks?.push({ name: 'bad name!', dur: 1 });
  res.locals.serverTimingMarks?.push({ name: 'ok_mark-1', dur: 2 });
  res.json({ ok: true });
});
app.get('/desc', (_req, res) => {
  res.locals.serverTimingMarks?.push({ name: 'db', dur: 1, desc: 'query' });
  res.locals.serverTimingMarks?.push({ name: 'x', dur: 2, desc: 'has space' });
  res.locals.serverTimingMarks?.push({ name: 'flag' }); // no dur → name only
  res.json({ ok: true });
});
app.get('/stream', (_req, res) => {
  res.write('chunk-1'); // flushes headers
  res.end('chunk-2');
});

describe('withServerTiming middleware', () => {
  beforeEach(() => {
    mockIsFeatureLive.mockReturnValue(true);
  });

  it('is a no-op (no header) when the feature flag is off', async () => {
    mockIsFeatureLive.mockReturnValue(false);

    const res = await request(app).get('/plain');
    expect(res.status).toBe(200);
    expect(res.headers['server-timing']).toBeUndefined();
    expect(mockIsFeatureLive).toHaveBeenCalledWith('LATENCY_TELEMETRY');
  });

  it('emits a total;dur mark when the feature is live', async () => {
    const res = await request(app).get('/plain');
    expect(res.status).toBe(200);
    expect(res.headers['server-timing']).toMatch(/^total;dur=\d+\.\d$/);
  });

  it('emits handler marks in insertion order before total', async () => {
    const res = await request(app).get('/marks');
    expect(res.status).toBe(200);
    expect(res.headers['server-timing']).toMatch(
      /^db;dur=42\.0, render;dur=8\.0, total;dur=\d+\.\d$/
    );
  });

  it('drops marks with names that violate RFC 8941, keeping valid ones', async () => {
    const res = await request(app).get('/bad-name');
    const header = res.headers['server-timing'];
    expect(header).not.toContain('bad name!');
    expect(header).toMatch(/^ok_mark-1;dur=2\.0, total;dur=\d+\.\d$/);
  });

  it('emits valid descs, drops invalid descs but keeps the mark, allows dur-less marks', async () => {
    const res = await request(app).get('/desc');
    const header = res.headers['server-timing'];
    expect(header).toMatch(/^db;dur=1\.0;desc="query", x;dur=2\.0, flag, total;dur=\d+\.\d$/);
  });

  it('skips the header on streaming responses whose headers were already flushed', async () => {
    const res = await request(app).get('/stream');
    expect(res.status).toBe(200);
    expect(res.text).toBe('chunk-1chunk-2');
    expect(res.headers['server-timing']).toBeUndefined();
  });
});
