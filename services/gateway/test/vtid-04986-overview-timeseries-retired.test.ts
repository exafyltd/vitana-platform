/**
 * VTID-04986: GET /api/v1/ops/overview-timeseries is retired.
 *
 * The route (DEV-COMHU-03404) lost its only caller in Overview Phase 4
 * (VTID-04887). This suite runs the REAL app from src/index.ts in-process and
 * pins what the retired path answers now, which is also what the read-only
 * staging check asserts (docs/validation/VTID-04986/staging-tests.json): no
 * router claims it, so it falls through to Express's default 404 (text/html,
 * "Cannot GET ..."), not the old 401 JSON.
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

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => mockSupabase) }));
jest.mock('../src/services/oasis-event-service', () => ({
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
jest.mock('../src/services/deploy-orchestrator', () => ({
  __esModule: true,
  default: { executeDeploy: jest.fn(), createVtid: jest.fn(), createTask: jest.fn() },
}));

import app from '../src/index';

const GATEWAY = path.join(__dirname, '..');
const RETIRED = '/api/v1/ops/overview-timeseries';

describe('VTID-04986: /api/v1/ops/overview-timeseries is retired', () => {
  it('the retired path falls through to the default 404 (text/html), not 401 JSON', async () => {
    const res = await request(app).get(RETIRED);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toContain(`Cannot GET ${RETIRED}`);
  });

  it('a sibling ops route is still mounted and answers 401 JSON unauthenticated', async () => {
    const res = await request(app).get('/api/v1/ops/pipeline-summary');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('the route file, its mount and its env mention are gone', () => {
    expect(fs.existsSync(path.join(GATEWAY, 'src/routes/ops-overview-timeseries.ts'))).toBe(false);
    const index = fs.readFileSync(path.join(GATEWAY, 'src/index.ts'), 'utf8');
    expect(index).not.toContain('ops-overview-timeseries');
    expect(index).not.toContain(RETIRED);
    expect(fs.readFileSync(path.join(GATEWAY, '.env.example'), 'utf8')).not.toContain('ops-overview-timeseries');
  });

  it('the Command Hub never calls it', () => {
    const appJs = fs.readFileSync(path.join(GATEWAY, 'src/frontend/command-hub/app.js'), 'utf8');
    expect(appJs).not.toContain('overview-timeseries');
  });

  it('the generated route manifest no longer lists it', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(GATEWAY, '../../scripts/aws-staging-validation/route-manifest.json'), 'utf8'));
    expect(manifest.routes.map((r: { prefix: string }) => r.prefix)).not.toContain(RETIRED);
  });
});
