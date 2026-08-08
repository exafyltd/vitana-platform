/**
 * Tests for src/routes/voice-tools-catalog.ts (VTID-02766)
 *
 *   GET /catalog        — list + filters (surface, role, status, q, limit, offset)
 *   GET /catalog/stats   — aggregate counts
 *   GET /catalog/:name   — single tool detail
 *   GET /health          — service health
 *
 * The file header comment claims these are "developer-tier — gated by
 * middleware on the mount path", but the route file itself imports NO auth
 * middleware, and index.ts mounts it via mountRouterSync — which is only a
 * duplicate-route guard (services/gateway/src/governance/route-guard.ts),
 * not an auth gate. So as actually wired, every endpoint here is reachable
 * without authentication. Tests assert that actual (unauthenticated) reachability.
 *
 * The manifest is loaded from disk via fs.readFileSync + a module-level
 * cache (loadManifest() populates `cachedManifest` once). We mock `fs` with
 * a fixed fixture so tests are independent of the real (683-tool) manifest
 * on disk, and use jest.isolateModules for the "manifest missing" case since
 * the cache would otherwise mask it once populated.
 */
import request from 'supertest';
import express from 'express';

const FIXTURE = {
  generated_at: '2026-01-01T00:00:00Z',
  source: 'reconciled' as const,
  total: 3,
  tools: [
    {
      name: 'tool_a',
      surface: 'Knowledge',
      category: 'knowledge',
      role: ['community'],
      status: 'live',
      description: 'Searches the knowledge base',
      wired_in: ['vertex', 'livekit'],
    },
    {
      name: 'tool_b',
      surface: 'Health',
      category: 'health',
      role: ['developer'],
      status: 'wip',
      description: 'Logs a health metric',
      wired_in: ['vertex'],
    },
    {
      name: 'tool_c',
      surface: 'Health',
      category: 'health',
      role: ['developer', 'community'],
      status: 'planned',
      description: 'Not yet wired anywhere',
      wired_in: [],
    },
  ],
};

let app: express.Express;

beforeAll(() => {
  jest.doMock('fs', () => ({
    ...jest.requireActual('fs'),
    readFileSync: jest.fn(() => JSON.stringify(FIXTURE)),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-tools-catalog').default;
  app = express();
  app.use(express.json());
  app.use('/api/v1/voice-tools', router);
});

// ---------------------------------------------------------------------------
// GET /catalog
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice-tools/catalog', () => {
  it('is reachable without auth and returns the full catalog by default', async () => {
    const res = await request(app).get('/api/v1/voice-tools/catalog');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(3);
    expect(res.body.grand_total).toBe(3);
    expect(res.body.tools).toHaveLength(3);
    expect(res.body.source).toBe('reconciled');
  });

  it('filters by surface (case-insensitive)', async () => {
    const res = await request(app).get('/api/v1/voice-tools/catalog?surface=HEALTH');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.tools.every((t: any) => t.surface === 'Health')).toBe(true);
  });

  it('filters by role', async () => {
    const res = await request(app).get('/api/v1/voice-tools/catalog?role=community');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.tools.map((t: any) => t.name).sort()).toEqual(['tool_a', 'tool_c']);
  });

  it('filters by status', async () => {
    const res = await request(app).get('/api/v1/voice-tools/catalog?status=planned');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tools[0].name).toBe('tool_c');
  });

  it('filters by free-text search across name + description', async () => {
    const res = await request(app).get('/api/v1/voice-tools/catalog?q=metric');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tools[0].name).toBe('tool_b');
  });

  it('paginates with limit/offset', async () => {
    const res = await request(app).get('/api/v1/voice-tools/catalog?limit=1&offset=1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3); // total reflects the (unfiltered) match count
    expect(res.body.tools).toHaveLength(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  it('clamps limit to the 1..200 range', async () => {
    const res = await request(app).get('/api/v1/voice-tools/catalog?limit=9999');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /catalog/stats
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice-tools/catalog/stats', () => {
  it('aggregates counts by surface, role, status, and wired_in', async () => {
    const res = await request(app).get('/api/v1/voice-tools/catalog/stats');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(3);
    expect(res.body.by_surface).toEqual({ Knowledge: 1, Health: 2 });
    expect(res.body.by_role).toEqual({ community: 2, developer: 2 });
    expect(res.body.by_status).toEqual({ live: 1, wip: 1, planned: 1 });
    expect(res.body.by_wired_in).toEqual({ both: 1, vertex_only: 1, livekit_only: 0, none: 1 });
  });
});

// ---------------------------------------------------------------------------
// GET /catalog/:name
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice-tools/catalog/:name', () => {
  it('returns the tool detail when found', async () => {
    const res = await request(app).get('/api/v1/voice-tools/catalog/tool_b');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tool.name).toBe('tool_b');
    expect(res.body.tool.description).toBe('Logs a health metric');
  });

  it('returns 404 for an unknown tool name', async () => {
    const res = await request(app).get('/api/v1/voice-tools/catalog/does_not_exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'tool_not_found', vtid: 'VTID-02766' });
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice-tools/health', () => {
  it('returns manifest totals without auth', async () => {
    const res = await request(app).get('/api/v1/voice-tools/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, total: 3, source: 'reconciled', vtid: 'VTID-02766' });
  });
});

// ---------------------------------------------------------------------------
// Manifest-missing fallback (isolated module instance so the module-level
// cache from the tests above doesn't mask the failure path)
// ---------------------------------------------------------------------------
describe('manifest file missing', () => {
  it('falls back to an empty catalog instead of throwing', async () => {
    // NOTE: `jest.isolateModules` cannot re-mock a core module like 'fs'
    // once it has already been resolved in this file's registry (the
    // `beforeAll` above already required 'fs' via the FIXTURE mock) —
    // isolateModules sandboxes *new* requires, but a core module's prior
    // resolution wins. `jest.resetModules()` clears the whole registry
    // instead, so the re-mock actually takes effect.
    jest.resetModules();
    jest.doMock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: jest.fn(() => {
        throw new Error('ENOENT: no such file or directory');
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const isolatedRouter = require('../../src/routes/voice-tools-catalog').default;
    const isolatedApp = express();
    isolatedApp.use(express.json());
    isolatedApp.use('/api/v1/voice-tools', isolatedRouter);

    const res = await request(isolatedApp).get('/api/v1/voice-tools/catalog');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.grand_total).toBe(0);
    expect(res.body.tools).toEqual([]);

    const healthRes = await request(isolatedApp).get('/api/v1/voice-tools/health');
    expect(healthRes.body).toEqual({ ok: true, total: 0, source: 'manual', vtid: 'VTID-02766' });
  });
});
