/**
 * VTID-05164 (C1) — the golden request/response fixtures published for the
 * native team's own contract tests:
 *   docs/programs/health-hub/health-sync-v1/golden.json
 * Each case runs through the real router + adapter over A's S10 fake and an S6
 * fake, at a fixed clock (2026-10-13T12:00:00Z), and must answer exactly the
 * recorded status and body. Regenerate after a deliberate contract change:
 *   UPDATE_HEALTH_SYNC_GOLDEN=1 npx jest test/health-sync/golden.test.ts
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer <member access token>') {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', message: 'Missing or invalid Authorization header. Expected: Bearer <token>' });
    }
    req.identity = { user_id: '22222222-2222-4222-8222-222222222222', tenant_id: '11111111-1111-4111-8111-111111111111' };
    return next();
  },
}));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: async () => ({ ok: true }) }));

import { createHealthIngestRouter, healthIngestBodyGuard } from '../../src/routes/health-ingest';
import { createHarness, ME } from './helpers';

const FILE = path.join(__dirname, '../../../../docs/programs/health-hub/health-sync-v1/golden.json');
const ON = { VITANA_ENV: 'production', HEALTH_SYNC_INGEST_ENABLED: 'true', HEALTH_STORE_ENABLED: 'true', HEALTH_RAW_BUCKET: 'bucket' } as NodeJS.ProcessEnv;
const AUTH = 'Bearer <member access token>';
const BATCH_ID = '6f1c2b1e-4d6a-4a8e-9c1b-2f3e4d5a6b7c';
const INSTALL = '0b7f6d52-3a1e-4c2f-8d9a-1e2f3a4b5c6d';
const source = { kind: 'apple_health', install_id: INSTALL, platform: 'ios', os_version: '18.1', app_version: '1.0.0', device: { manufacturer: 'Apple', model: 'Watch7,1' } };
const steps = (start: string, value: number) => {
  const end = new Date(Date.parse(start) + 5 * 60 * 1000).toISOString();
  return { record_id: `steps:${new Date(start).toISOString()}`, type: 'steps', value, unit: '{steps}', start, end, tz: 'Europe/Berlin' };
};
const sleep = { record_id: 'B3C1E6A0-5D2F-4A8B-9E1C-7F6D5A4B3C2D', type: 'sleep_session', value: 452, unit: 'min', start: '2026-10-12T22:31:00+02:00', end: '2026-10-13T06:03:00+02:00', tz: 'Europe/Berlin',
  stages: [{ stage: 'light', start: '2026-10-12T22:31:00+02:00', end: '2026-10-13T01:10:00+02:00' }, { stage: 'deep', start: '2026-10-13T01:10:00+02:00', end: '2026-10-13T02:40:00+02:00' }, { stage: 'rem', start: '2026-10-13T02:40:00+02:00', end: '2026-10-13T06:03:00+02:00' }] };
const batch = (over: Record<string, unknown> = {}) => ({ contract_version: '1.0', batch_id: BATCH_ID, source, sync_mode: 'incremental', records: [steps('2026-10-13T08:00:00Z', 412)], deletions: [], ...over });

interface Step { request: { path: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown }; response?: { status: number; body: unknown } }
interface Case { name: string; env?: 'production' | 'staging'; consents: Array<{ key: string; resource: string }>; steps: Step[] }

const post = (body: unknown, headers: Record<string, string> = { Authorization: AUTH }): Step => ({
  request: { path: '/api/v1/health/ingest', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body },
});

const CASES: Case[] = [
  { name: 'contract self-check', consents: [], steps: [{ request: { path: '/api/v1/health/ingest/contract', method: 'GET', headers: {} } }] },
  { name: 'activity consented: stored', consents: [{ key: 'sync_activity', resource: 'apple_health' }], steps: [post(batch())] },
  { name: 'same batch re-sent after a timeout: replay', consents: [{ key: 'sync_activity', resource: 'apple_health' }], steps: [post(batch()), post(batch())] },
  {
    name: 'interval re-sent with a new value and an emptied interval deleted',
    consents: [{ key: 'sync_activity', resource: 'apple_health' }],
    steps: [
      post(batch({ records: [steps('2026-10-13T08:00:00Z', 412), steps('2026-10-13T08:05:00Z', 90)] })),
      post(batch({ batch_id: '7a2d3c4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', records: [steps('2026-10-13T08:00:00Z', 415)], deletions: [{ record_id: 'steps:2026-10-13T08:05:00.000Z', type: 'steps' }] })),
    ],
  },
  { name: 'sleep not consented: dropped per record, steps stored', consents: [{ key: 'sync_activity', resource: 'apple_health' }], steps: [post(batch({ records: [steps('2026-10-13T08:00:00Z', 412), sleep] }))] },
  { name: 'nothing consented: 403', consents: [], steps: [post(batch({ records: [steps('2026-10-13T08:00:00Z', 412), sleep] }))] },
  {
    name: 'per-record rejections',
    consents: [{ key: 'sync_activity', resource: 'apple_health' }, { key: 'sync_body', resource: 'apple_health' }],
    steps: [post(batch({ records: [
      { record_id: 'w-lb', type: 'body_weight', value: 160, unit: '[lb_av]', start: '2026-10-13T07:00:00+02:00', end: '2026-10-13T07:00:00+02:00', tz: 'Europe/Berlin' },
      { record_id: 'w-999', type: 'body_weight', value: 999, unit: 'kg', start: '2026-10-13T07:00:00+02:00', end: '2026-10-13T07:00:00+02:00', tz: 'Europe/Berlin' },
      { record_id: 'glucose-1', type: 'blood_glucose', value: 5.4, unit: 'mmol/L', start: '2026-10-13T07:00:00+02:00', end: '2026-10-13T07:00:00+02:00', tz: 'Europe/Berlin' },
      { ...steps('2024-01-01T08:00:00Z', 10), record_id: 'old-1' },
    ] }))],
  },
  { name: 'unknown field: 400', consents: [], steps: [post(batch({ user_id: '99999999-9999-4999-8999-999999999999' }))] },
  { name: 'newer major: 400', consents: [], steps: [post(batch({ contract_version: '2.0' }))] },
  { name: 'no token: 401', consents: [], steps: [post(batch(), {})] },
  { name: 'staging: 409', env: 'staging', consents: [], steps: [post(batch())] },
];

async function run(c: Case) {
  const h = createHarness();
  for (const g of c.consents) h.store.grantConsent(ME, g.key as any, g.resource);
  const env = c.env === 'staging' ? ({ ...ON, VITANA_ENV: 'staging' } as NodeJS.ProcessEnv) : ON;
  const a = express();
  a.use('/api/v1/health/ingest', healthIngestBodyGuard());
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/v1/health/ingest', createHealthIngestRouter({ env, supabase: () => ({}) as any, deps: () => h.deps, storeStatus: () => ({ enabled: true, reason: null }) }));
  const out: Step[] = [];
  for (const s of c.steps) {
    let r = s.request.method === 'GET' ? request(a).get(s.request.path) : request(a).post(s.request.path);
    for (const [k, v] of Object.entries(s.request.headers)) r = r.set(k, v);
    const res = s.request.body === undefined ? await r : await r.send(JSON.stringify(s.request.body));
    out.push({ request: s.request, response: { status: res.status, body: res.body } });
  }
  return { name: c.name, env: c.env ?? 'production', consents: c.consents, steps: out };
}

describe('golden fixtures (docs/programs/health-hub/health-sync-v1/golden.json)', () => {
  it('every published case answers exactly as recorded', async () => {
    const actual = { contract_version: '1.0', clock: '2026-10-13T12:00:00.000Z', cases: [] as unknown[] };
    for (const c of CASES) actual.cases.push(await run(c));
    if (process.env.UPDATE_HEALTH_SYNC_GOLDEN === '1') fs.writeFileSync(FILE, `${JSON.stringify(actual, null, 2)}\n`);
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
  });
});
