/**
 * VCAOP Partner Portal gateway surface (VTID-03544).
 *
 * Includes the transition-map SYNC TEST: the gateway mirrors the connection
 * state machine from services/vcaop/src/factory/manifest.ts (the gateway
 * Docker image cannot depend on the vcaop package), so any edit to the
 * canonical map that is not mirrored here must fail CI — same pattern as
 * nav-manifest-sync.test.ts pinning the vitana-v1 manifest.
 */
import fs from 'fs';
import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import vcaopPortalRouter, {
  CONNECTION_STATES,
  STATE_TRANSITIONS,
  canTransition,
  extractSchemaSources,
  pendingReviewMappings,
} from '../../src/routes/vcaop-portal';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn() }));

const app = express();
app.use(express.json());
app.use('/api/v1/vcaop/portal', vcaopPortalRouter);

const asAdmin = () =>
  (requireAuth as jest.Mock).mockImplementation((req: any, _res: Response, next: NextFunction) => {
    req.identity = { user_id: 'admin-1', tenant_id: 'platform', exafy_admin: true };
    next();
  });
const asCommunity = () =>
  (requireAuth as jest.Mock).mockImplementation((req: any, _res: Response, next: NextFunction) => {
    req.identity = { user_id: 'user-1', tenant_id: 'platform', exafy_admin: false };
    next();
  });

describe('state machine mirror stays in sync with services/vcaop', () => {
  const canonicalSource = fs.readFileSync(
    path.join(__dirname, '../../../vcaop/src/factory/manifest.ts'),
    'utf8',
  );

  test('every mirrored state exists in the canonical CONNECTION_STATES', () => {
    for (const state of CONNECTION_STATES) {
      expect(canonicalSource).toMatch(new RegExp(`'${state}'`));
    }
  });

  test('the mirrored transition map matches the canonical map row for row', () => {
    // Parse the canonical STATE_TRANSITIONS object literal out of the source.
    const block = canonicalSource.match(/STATE_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\};/);
    expect(block).not.toBeNull();
    const rows = [...block![1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)];
    expect(rows.length).toBe(CONNECTION_STATES.length);
    for (const [, from, targets] of rows) {
      const canonicalTargets = targets
        .split(',')
        .map((t) => t.replace(/['"\s]/g, ''))
        .filter(Boolean)
        .sort();
      const mirrored = [...(STATE_TRANSITIONS as any)[from]].sort();
      expect({ from, targets: mirrored }).toEqual({ from, targets: canonicalTargets });
    }
  });
});

describe('pure helpers', () => {
  test('canTransition follows the map and rejects unknown states', () => {
    expect(canTransition('certified', 'active')).toBe(true);
    expect(canTransition('discovered', 'active')).toBe(false);
    expect(canTransition('revoked', 'active')).toBe(false);
    expect(canTransition('nonsense', 'active')).toBe(false);
  });

  test('pendingReviewMappings flags sensitive + low-confidence non-human mappings only', () => {
    const pending = pendingReviewMappings([
      { id: 'a', sensitive: true, confidence: 0.99, decided_by: 'ai' },
      { id: 'b', sensitive: false, confidence: 0.5, decided_by: 'ai' },
      { id: 'c', sensitive: false, confidence: 0.99, decided_by: 'ai' },
      { id: 'd', sensitive: true, confidence: 0.4, decided_by: 'human' },
    ]);
    expect(pending).toEqual(['a', 'b']);
  });

  test('extractSchemaSources pulls component schemas with required flags', () => {
    const sources = extractSchemaSources({
      components: {
        schemas: {
          Order: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' }, total: { type: 'number' } },
          },
          Empty: { type: 'object' },
        },
      },
    });
    expect(sources).toEqual([
      {
        name: 'Order',
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'total', type: 'number', required: false },
        ],
      },
    ]);
    expect(extractSchemaSources(undefined)).toEqual([]);
    expect(extractSchemaSources({})).toEqual([]);
  });
});

describe('route auth rules', () => {
  beforeEach(() => jest.clearAllMocks());

  test('community role is denied everywhere (403)', async () => {
    asCommunity();
    (getSupabase as jest.Mock).mockReturnValue({});
    const res = await request(app).get('/api/v1/vcaop/portal/connections');
    expect(res.status).toBe(403);
  });

  test('admin without a database gets 503, not a crash', async () => {
    asAdmin();
    (getSupabase as jest.Mock).mockReturnValue(null);
    const res = await request(app).get('/api/v1/vcaop/portal/connections');
    expect(res.status).toBe(503);
  });

  test('create validates required fields before touching the database', async () => {
    asAdmin();
    (getSupabase as jest.Mock).mockReturnValue({});
    const res = await request(app).post('/api/v1/vcaop/portal/connections').send({ name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connector_id/);
  });
});
