/**
 * VTID-04074: extension-aware Cache-Control for the /command-hub static mount.
 *
 * Contract under test (src/index.ts, `app.use('/command-hub', express.static(staticPath, ...))`):
 *   - `.js` / `.css` requests get `public, max-age=31536000, immutable`, because
 *     index.html loads them with `?v=<slug>` cache-bust query params — a bump of
 *     that param (enforced discipline whenever those files change) is the
 *     invalidation mechanism, so revalidation on every request is pure waste.
 *   - every other file served by the same mount — the standalone .html pages
 *     (intent-engine.html, intent-moderation.html, orb-voice-bench.html,
 *     voice-budget.html, watcher.html) which have no `?v=` anywhere — keeps
 *     `no-cache, no-store, must-revalidate`.
 *
 * The assertions run against the real app from src/index.ts, so a regression in
 * the mount's setHeaders callback (or an accidental global header) fails here.
 */

import * as fs from 'fs';
import * as path from 'path';

import request from 'supertest';

// keep the app import cheap/offline: same mocking shape other index.ts-driven
// route tests use (index.ts constructs Supabase-backed routers at import time)
const createChainableMock = () => {
  const chain: any = {
    from: jest.fn(() => chain),
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve)),
  };
  return chain;
};
const mockSupabase = createChainableMock();

jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn(() => mockSupabase) }));
jest.mock('../../src/services/oasis-event-service', () => ({
  default: { deployRequested: jest.fn(), deployAccepted: jest.fn(), deployFailed: jest.fn() },
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' }),
  cicdEvents: {},
  memoryGovernanceEvents: {},
  responseFramingEvents: {},
  GOVERNANCE_EVENT_TYPES: [],
  MEMORY_GOVERNANCE_EVENT_TYPES: [],
  RESPONSE_FRAMING_EVENT_TYPES: [],
  getGovernanceHistory: jest.fn().mockResolvedValue({ ok: true, events: [] }),
}));
jest.mock('../../src/services/deploy-orchestrator', () => ({
  __esModule: true,
  default: { executeDeploy: jest.fn(), createVtid: jest.fn(), createTask: jest.fn() },
}));

import app from '../../src/index';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache, no-store, must-revalidate';

const COMMAND_HUB_DIR = path.join(__dirname, '../../src/frontend/command-hub');

describe('VTID-04074 /command-hub static Cache-Control', () => {
  it('serves app.js with a long immutable max-age (cache-busted via ?v= in index.html)', async () => {
    const res = await request(app).get('/command-hub/app.js?v=test');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
  });

  it('serves styles.css with a long immutable max-age', async () => {
    const res = await request(app).get('/command-hub/styles.css?v=test');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
  });

  it('serves orb-widget.js with a long immutable max-age', async () => {
    const res = await request(app).get('/command-hub/orb-widget.js?v=test');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
  });

  it('keeps no-cache on the standalone watcher.html page (not cache-busted anywhere)', async () => {
    const res = await request(app).get('/command-hub/watcher.html');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(NO_CACHE);
  });

  it('keeps no-cache on index.html itself (the file carrying the ?v= tags)', async () => {
    const res = await request(app).get('/command-hub/index.html');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(NO_CACHE);
  });

  it('every standalone .html page under /command-hub keeps the no-cache treatment', async () => {
    // Discover the pages rather than hardcoding a list that can drift.
    const htmlPages = fs
      .readdirSync(COMMAND_HUB_DIR)
      .filter((name) => name.endsWith('.html') && !name.includes('.backup'))
      // debug.html 404s via the VTID-04056 denylist, and index.html is asserted above.
      .filter((name) => name !== 'debug.html' && name !== 'index.html');

    expect(htmlPages.length).toBeGreaterThan(0);

    for (const page of htmlPages) {
      const res = await request(app).get(`/command-hub/${page}`);
      expect([page, res.status]).toEqual([page, 200]);
      expect([page, res.headers['cache-control']]).toEqual([page, NO_CACHE]);
    }
  });

  it('index.html still cache-busts styles.css and app.js through ?v=', () => {
    const html = fs.readFileSync(path.join(COMMAND_HUB_DIR, 'index.html'), 'utf8');

    // The immutable policy above is only safe while this discipline holds.
    expect(html).toMatch(/\/command-hub\/styles\.css\?v=[^"']+/);
    expect(html).toMatch(/\/command-hub\/app\.js\?v=[^"']+/);
  });

  it('leaves the separate /voice-lab mount on its blanket no-cache policy', async () => {
    const voiceLabDir = path.join(__dirname, '../../src/frontend/voice-lab');
    const jsFile = fs.existsSync(voiceLabDir)
      ? fs.readdirSync(voiceLabDir).find((name) => name.endsWith('.js'))
      : undefined;

    expect(jsFile).toBeDefined();

    const res = await request(app).get(`/voice-lab/${jsFile}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(NO_CACHE);
  });
});
