/**
 * VTID-05164 (Health Hub Phase 1 / C1) — HTTP tests for /api/v1/health/ingest.
 *
 *   - gate: 409 INGEST_DISABLED on staging even with the flag set, with the flag
 *     unset in production, and with A's store off — before auth, the rate
 *     limiters, the body or any port is touched;
 *   - auth: 401 JSON without a token; identity only from the JWT (a body
 *     user_id is INVALID_BATCH); an AI-delegated token is refused by
 *     delegatedTokenGuard before the router;
 *   - body: gzip happy path through the real index.ts parser order (the body
 *     guard keeps express.json off), gzip bomb and oversize -> 413
 *     BATCH_TOO_LARGE, 415 for other encodings / content types, bad JSON and
 *     schema errors -> 400 INVALID_BATCH, new major -> 400
 *     UNSUPPORTED_CONTRACT_VERSION;
 *   - rate limits: per-IP 429 before auth (the JWT verifier is not called),
 *     per-member 429 after auth, per-member concurrency; all with Retry-After;
 *   - GET /contract (public), GET /status (auth, read-only), POST /source-state;
 *   - index.ts wiring order.
 * Ports are A's S10 fake and an S6 fake (test/health-sync/helpers.ts).
 */
import fs from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';
import express from 'express';
import request from 'supertest';
import * as jose from 'jose';

const mockAuth = jest.fn((req: any, res: any, next: any) => {
  const h = String(req.headers.authorization ?? '');
  if (h === 'Bearer member-1') {
    req.identity = { user_id: '22222222-2222-4222-8222-222222222222', tenant_id: '11111111-1111-4111-8111-111111111111' };
    return next();
  }
  return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', message: 'Missing or invalid Authorization header' });
});
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, res: any, next: any) => mockAuth(req, res, next),
}));
const mockRpc = jest.fn();
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }) }));
const mockEmitOasis = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => mockEmitOasis(...a) }));

import { createHealthIngestRouter, healthIngestBodyGuard, healthIngestGate, type HealthIngestRouterOptions } from '../../src/routes/health-ingest';
import { delegatedTokenGuard, resetDelegationCache } from '../../src/services/delegation-guard';
import { createHarness, INSTALL_ID, ME, stepsRecord, validBatch } from '../health-sync/helpers';

const ON = { VITANA_ENV: 'production', HEALTH_SYNC_INGEST_ENABLED: 'true', HEALTH_STORE_ENABLED: 'true', HEALTH_RAW_BUCKET: 'bucket' } as NodeJS.ProcessEnv;
const AUTH = { Authorization: 'Bearer member-1' };
const URL = '/api/v1/health/ingest';

let h: ReturnType<typeof createHarness>;
let depsCalls = 0;
const setSourceState = jest.fn(async (..._a: unknown[]) => ({ ok: true as const }));

function app(over: Partial<HealthIngestRouterOptions> = {}, { guard = false } = {}) {
  const a = express();
  a.use(URL, healthIngestBodyGuard());
  a.use(express.json({ limit: '2mb' }));
  if (guard) a.use(delegatedTokenGuard());
  a.use(
    URL,
    createHealthIngestRouter({
      env: ON,
      supabase: () => ({}) as any,
      deps: () => {
        depsCalls++;
        return h.deps;
      },
      storeStatus: () => ({ enabled: true, reason: null }),
      setSourceState: setSourceState as any,
      ...over,
    }),
  );
  return a;
}

function post(a: express.Express, body: unknown, headers: Record<string, string> = AUTH, gzip = false) {
  let r = request(a).post(URL).set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  const text = JSON.stringify(body);
  if (gzip) return sendRaw(r.set('Content-Encoding', 'gzip'), gzipSync(Buffer.from(text)));
  return r.send(text);
}

/** superagent JSON-serialises a Buffer when the type is JSON; send the bytes as they are. */
function sendRaw(r: request.Test, buf: Buffer) {
  return r.serialize((b: unknown) => b as string).send(buf as unknown as string);
}

beforeEach(() => {
  h = createHarness();
  depsCalls = 0;
  jest.clearAllMocks();
  resetDelegationCache();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const stepsBatch = (over: Record<string, unknown> = {}) => validBatch({ records: [stepsRecord(30, 120)], ...over });

describe('ingest gate (409, nothing read)', () => {
  it('the gate function: exact true, not staging, store on', () => {
    expect(healthIngestGate(ON)).toEqual({ open: true });
    expect(healthIngestGate({ ...ON, VITANA_ENV: 'staging' })).toEqual({ open: false, reason: 'staging' });
    expect(healthIngestGate({ ...ON, HEALTH_SYNC_INGEST_ENABLED: 'TRUE' })).toEqual({ open: false, reason: 'flag_off' });
    expect(healthIngestGate({ ...ON, HEALTH_SYNC_INGEST_ENABLED: undefined })).toEqual({ open: false, reason: 'flag_off' });
    expect(healthIngestGate({ ...ON, HEALTH_STORE_ENABLED: undefined })).toEqual({ open: false, reason: 'flag_off' });
    expect(healthIngestGate({ ...ON, HEALTH_RAW_BUCKET: '' })).toEqual({ open: false, reason: 'flag_off' });
  });

  it.each([
    ['staging, flag set', { ...ON, VITANA_ENV: 'staging' }, 'staging'],
    ['production, flag unset', { ...ON, HEALTH_SYNC_INGEST_ENABLED: undefined }, 'flag_off'],
    ['production, store off', { ...ON, HEALTH_STORE_ENABLED: undefined }, 'flag_off'],
  ])('%s: POST / and POST /source-state answer 409 before auth, the body or any port', async (_l, env, reason) => {
    const a = app({ env: env as NodeJS.ProcessEnv });
    // an oversize declared body would be 413 if anything read it
    const res = await request(a).post(URL).set(AUTH).set('Content-Type', 'application/json').set('Content-Length', String(10 * 1024 * 1024)).send('{}');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'INGEST_DISABLED', retryable: false, reason });
    const ss = await request(a).post(`${URL}/source-state`).set(AUTH).send({ source_kind: 'apple_health', install_id: INSTALL_ID, state: 'active', permitted_categories: [] });
    expect(ss.status).toBe(409);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(depsCalls).toBe(0);
    expect(h.writes).toHaveLength(0);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('POST / — auth and identity', () => {
  it('401 JSON without a token', async () => {
    const res = await post(app(), stepsBatch(), {});
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(depsCalls).toBe(0);
  });

  it('a body user_id is INVALID_BATCH (strict schema); identity is the JWT member', async () => {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    const bad = await post(app(), stepsBatch({ user_id: '99999999-9999-4999-8999-999999999999' }));
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, error: 'INVALID_BATCH', retryable: false, details: [{ path: '', code: 'unknown_field' }] });
    const ok = await post(app(), stepsBatch());
    expect(ok.status).toBe(200);
    expect((h.writes[0] as any).identity).toEqual(ME);
  });

  it('an AI-delegated token is refused before the router (delegatedTokenGuard)', async () => {
    process.env.SUPABASE_URL = 'https://proj.supabase.example';
    const key = new TextEncoder().encode('test-secret-test-secret-test-secret');
    const token = await new jose.SignJWT({ role: 'authenticated', iss: 'https://proj.supabase.example/auth/v1', client_id: 'chatgpt' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .sign(key);
    const res = await post(app({}, { guard: true }), stepsBatch(), { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DELEGATED_TOKEN_NOT_ALLOWED');
    expect(mockAuth).not.toHaveBeenCalled();
    expect(depsCalls).toBe(0);
  });
});

describe('POST / — body, encoding and schema', () => {
  beforeEach(() => h.store.grantConsent(ME, 'sync_activity', 'apple_health'));

  it('gzip happy path through the index.ts parser order: 200 with counts, consent and source state', async () => {
    const res = await post(app(), stepsBatch(), AUTH, true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      batch_id: stepsBatch().batch_id,
      replay: false,
      counts: { stored: 1, duplicate: 0, updated: 0, deleted: 0, rejected: 0 },
      rejected: [],
      consent: { activity: 'granted' },
      source_state: 'connected',
    });
  });

  it('a gzip bomb (> 4 MB inflated) is 413 BATCH_TOO_LARGE', async () => {
    const bomb = gzipSync(Buffer.from(`{"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`));
    expect(bomb.length).toBeLessThan(512 * 1024);
    const res = await sendRaw(request(app()).post(URL).set(AUTH).set('Content-Type', 'application/json').set('Content-Encoding', 'gzip'), bomb);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ ok: false, error: 'BATCH_TOO_LARGE', retryable: false });
    expect(h.writes).toHaveLength(0);
  });

  it('a body over 512 KB as sent is 413 BATCH_TOO_LARGE', async () => {
    const big = JSON.stringify({ pad: 'y'.repeat(600 * 1024) });
    const res = await request(app()).post(URL).set(AUTH).set('Content-Type', 'application/json').send(big);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('BATCH_TOO_LARGE');
  });

  it('415 UNSUPPORTED_ENCODING for another content type or encoding', async () => {
    const t = await request(app()).post(URL).set(AUTH).set('Content-Type', 'text/plain').send('{}');
    expect(t.status).toBe(415);
    expect(t.body).toMatchObject({ ok: false, error: 'UNSUPPORTED_ENCODING', retryable: false });
    const b = await sendRaw(request(app()).post(URL).set(AUTH).set('Content-Type', 'application/json').set('Content-Encoding', 'br'), Buffer.from('{}'));
    expect(b.status).toBe(415);
  });

  it('bad JSON and a bad gzip stream are 400 INVALID_BATCH', async () => {
    const j = await request(app()).post(URL).set(AUTH).set('Content-Type', 'application/json').send('{not json');
    expect(j.status).toBe(400);
    expect(j.body.error).toBe('INVALID_BATCH');
    const g = await sendRaw(request(app()).post(URL).set(AUTH).set('Content-Type', 'application/json').set('Content-Encoding', 'gzip'), Buffer.from('not gzip'));
    expect(g.status).toBe(400);
  });

  it('an unknown major is 400 UNSUPPORTED_CONTRACT_VERSION with the supported majors', async () => {
    const res = await post(app(), stepsBatch({ contract_version: '2.0' }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'UNSUPPORTED_CONTRACT_VERSION', retryable: false, details: { supported_majors: [1] } });
  });

  it('every batch error body has { ok:false, error, retryable } and no database message', async () => {
    h.store.revokeConsent(ME, 'sync_activity', 'apple_health');
    const res = await post(app(), stepsBatch());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'CONSENT_REQUIRED', retryable: false, categories: ['activity'] });
  });
});

describe('rate limits', () => {
  it('the per-IP limit answers 429 with Retry-After BEFORE auth runs', async () => {
    const a = app({ ipLimitPerMinute: 2 });
    await post(a, stepsBatch(), {});
    await post(a, stepsBatch(), {});
    mockAuth.mockClear();
    const res = await post(a, stepsBatch(), {});
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body).toMatchObject({ ok: false, error: 'RATE_LIMITED', retryable: true });
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('the per-member limit runs after auth, keyed by the JWT user', async () => {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    const a = app({ memberBatchesPerHour: 1 });
    expect((await post(a, stepsBatch())).status).toBe(200);
    mockAuth.mockClear();
    const res = await post(a, stepsBatch({ batch_id: '7a2d3c4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e' }));
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body.error).toBe('RATE_LIMITED');
    expect(mockAuth).toHaveBeenCalledTimes(1);
  });

  it('per-member concurrency: a second batch while one is in flight is 429', async () => {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    let release: () => void = () => undefined;
    const slow = new Promise<void>((r) => (release = r));
    const deps = { ...h.deps, writeHealthSamples: async (i: any) => { await slow; return h.deps.writeHealthSamples(i); } };
    const a = app({ memberConcurrency: 1, deps: () => deps });
    const first = post(a, stepsBatch()).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const second = await post(a, stepsBatch({ batch_id: '7a2d3c4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e' }));
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBe('5');
    release();
    expect((await first).status).toBe(200);
  });
});

describe('GET /contract and GET /status', () => {
  it('/contract is public, read-only, version 1.0 with four categories and no glucose code', async () => {
    const res = await request(app({ env: { VITANA_ENV: 'staging' } as NodeJS.ProcessEnv })).get(`${URL}/contract`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, contract_version: '1.0', supported_majors: [1] });
    expect(res.body.catalogue).toHaveLength(4);
    expect(JSON.stringify(res.body)).not.toMatch(/glucose/i);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('/status needs a member (401 JSON) and validates its query', async () => {
    const a = app();
    expect((await request(a).get(`${URL}/status`)).status).toBe(401);
    const bad = await request(a).get(`${URL}/status?source_kind=fitbit&install_id=x`).set(AUTH);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('INVALID_REQUEST');
  });

  it('/status on staging: readable, ingest_enabled:false, store state, consent per sync category, store_pending', async () => {
    h.store.grantConsent(ME, 'sync_sleep', 'apple_health');
    h.sources.setMode('STORE_PENDING');
    const a = app({ env: { VITANA_ENV: 'staging', HEALTH_SYNC_INGEST_ENABLED: 'true' } as NodeJS.ProcessEnv, storeStatus: () => ({ enabled: false, reason: 'staging' }) });
    const res = await request(a).get(`${URL}/status?source_kind=apple_health&install_id=${INSTALL_ID}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      contract_version: '1.0',
      ingest_enabled: false,
      ingest_disabled_reason: 'staging',
      store: { enabled: false, reason: 'staging' },
      store_pending: true,
      source_state: 'store_pending',
      consent: { activity: 'not_granted', sleep: 'granted', heart: 'not_granted', body: 'not_granted' },
    });
    expect(h.sources.calls[0]).toEqual({ kind: 'phone_store', connector_id: 'apple_health', provider_user_id: INSTALL_ID });
    expect(h.writes).toHaveLength(0);
  });
});

describe('POST /source-state — OS permission revoked -> paused', () => {
  async function connect() {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    expect((await post(app(), stepsBatch())).status).toBe(200);
    return h.sources.rows[0].source_id;
  }
  const body = (state: string) => ({ source_kind: 'apple_health', install_id: INSTALL_ID, state, permitted_categories: ['sleep'] });

  it('os_permission_revoked pauses the source (OS_PERMISSION_REVOKED) and emits health.sync.source.paused', async () => {
    const id = await connect();
    h.events.length = 0;
    const res = await request(app()).post(`${URL}/source-state`).set(AUTH).send(body('os_permission_revoked'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, changed: true, source_state: 'paused' });
    expect(setSourceState).toHaveBeenCalledWith(expect.anything(), ME, { source_id: id, status: 'paused', reason_code: 'OS_PERMISSION_REVOKED' });
    expect(h.events.map((e) => e.type)).toEqual(['health.sync.source.paused']);
    expect(h.events[0].payload).toEqual({ source_kind: 'apple_health', reason_code: 'OS_PERMISSION_REVOKED', permitted_categories: ['sleep'] });
  });

  it('active resumes only a paused source; a disconnected one stays disconnected', async () => {
    const id = await connect();
    h.sources.setStatus(id, 'paused');
    const r1 = await request(app()).post(`${URL}/source-state`).set(AUTH).send(body('active'));
    expect(r1.body).toEqual({ ok: true, changed: true, source_state: 'connected' });
    expect(setSourceState).toHaveBeenLastCalledWith(expect.anything(), ME, { source_id: id, status: 'connected', reason_code: null });
    setSourceState.mockClear();
    h.sources.setStatus(id, 'disconnected');
    const r2 = await request(app()).post(`${URL}/source-state`).set(AUTH).send(body('active'));
    expect(r2.body).toEqual({ ok: true, changed: false, source_state: 'disconnected' });
    expect(setSourceState).not.toHaveBeenCalled();
  });

  it('no source yet: nothing is created; a bad body is 400', async () => {
    const res = await request(app()).post(`${URL}/source-state`).set(AUTH).send(body('os_permission_revoked'));
    expect(res.body).toEqual({ ok: true, changed: false, source_state: 'not_connected' });
    expect(h.sources.rows).toHaveLength(0);
    const bad = await request(app()).post(`${URL}/source-state`).set(AUTH).send({ ...body('active'), user_id: 'x' });
    expect(bad.status).toBe(400);
  });
});

describe('index.ts wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf8');
  it('the body guard is mounted before the global JSON parser; the router after the delegation guard', () => {
    const guard = src.indexOf("app.use('/api/v1/health/ingest', healthIngestModule.healthIngestBodyGuard())");
    const json = src.indexOf("app.use(express.json({ limit: '2mb' }))");
    const delegation = src.indexOf('app.use(delegatedTokenGuard())');
    const mount = src.indexOf("mountRouterSync(app, '/api/v1/health/ingest', healthIngestRouter");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(json);
    expect(delegation).toBeGreaterThan(json);
    expect(mount).toBeGreaterThan(delegation);
  });

  it('the route file is claimed by the health domain of the atlas (^health)', () => {
    expect(fs.existsSync(path.join(__dirname, '../../src/routes/health-ingest.ts'))).toBe(true);
    const atlas = fs.readFileSync(path.join(__dirname, '../../src/orb/developer/domain-atlas.ts'), 'utf8');
    expect(atlas).toMatch(/\^health/);
  });
});
