/**
 * VTID-05161 (Health Hub Phase 1 / B1) — health_sources: the S6 functions, the
 * legacy dual-write (Change 3), the read switch (Change 4) and the reconciler
 * (Change 5), over an in-memory fake database (test/health-sources/fake-db.ts).
 * No test touches a real database; the SQL side is proven on a throwaway
 * Postgres by scripts/ci/sql-tests/run-health-sources-test.sh.
 */
import express from 'express';
import request from 'supertest';
import * as jose from 'jose';
import { createFakeDb, type FakeDb } from './health-sources/fake-db';

const mockEmit = jest.fn(async (..._args: unknown[]) => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => mockEmit(...a) }));

let currentDb: FakeDb;
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => currentDb?.client ?? null }));
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const u = req.headers['x-test-user'];
    if (!u) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: u, tenant_id: null };
    next();
  },
}));
// The manual-log route also runs the pillar agents; not under test here.
jest.mock('../src/services/pillar-agents/orchestrator', () => ({
  runPillarAgentsForUser: async () => ({ agents_run: 0, agents_failed: 0, per_pillar: {} }),
}));

import {
  canonicalSourceKey,
  healthSourceStateFromSync,
  listHealthSources,
  resolveHealthSource,
  setHealthSourceState,
} from '../src/services/health-sources/health-sources';
import {
  dualWriteUserConnections,
  dualWriteUserIntegration,
  getHealthSourcesDualWriteCounters,
  isHealthSourcesDualWriteEnabled,
  mapLegacyConnection,
  mirrorUserConnections,
  mirrorUserIntegration,
  resetHealthSourcesDualWriteCounters,
} from '../src/services/health-sources/legacy-mirror';
import { isHealthSourcesReadEnabled } from '../src/services/health-sources/read-model';
import {
  maybeRunNightlyHealthSourcesReconcile,
  resetHealthSourcesReconcileSchedule,
} from '../src/services/health-sources/reconcile';
import integrationsRouter from '../src/routes/integrations';
import wearablesRouter from '../src/routes/wearables';

const T1 = '10000000-0000-0000-0000-000000000001';
const T2 = '10000000-0000-0000-0000-000000000002';
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const ME = { tenant_id: T1, user_id: A };
const ON = { HEALTH_SOURCES_DUAL_WRITE: 'true' } as NodeJS.ProcessEnv;

const REGISTRY = [
  { id: 'fitbit', category: 'wearable', display_name: 'Fitbit', enabled: true },
  { id: 'oura', category: 'wearable', display_name: 'Oura Ring', enabled: true },
  { id: 'terra', category: 'aggregator', display_name: 'Terra', enabled: true },
  { id: 'instagram', category: 'social', display_name: 'Instagram', enabled: true },
];

function legacySeed() {
  return {
    connector_registry: REGISTRY,
    user_tenants: [
      { tenant_id: T1, user_id: A, is_primary: true, created_at: '2026-01-01T00:00:00+00:00', active_role: 'community' },
      { tenant_id: T1, user_id: B, is_primary: false, created_at: '2026-01-01T00:00:00+00:00', active_role: 'community' },
      { tenant_id: T2, user_id: B, is_primary: true, created_at: '2026-02-01T00:00:00+00:00', active_role: 'community' },
    ],
    user_connections: [
      {
        id: 'a1000000-0000-0000-0000-000000000001', tenant_id: T1, user_id: A, connector_id: 'fitbit', category: 'wearable',
        provider_user_id: 'fb-a', display_name: 'Fitbit A', provider_username: 'alice', access_token: 'sealed:v1:x', refresh_token: null,
        is_active: true, last_sync_at: '2026-10-12T06:00:00+00:00', last_error: null, connected_at: '2026-03-01T10:00:00+00:00',
        disconnected_at: null, sync_cursor: { sleep_since: '2026-10-01' },
      },
      {
        id: 'a1000000-0000-0000-0000-000000000002', tenant_id: T1, user_id: A, connector_id: 'oura', category: 'wearable',
        provider_user_id: 'oura-a', display_name: null, provider_username: null, access_token: null, refresh_token: null,
        is_active: false, last_sync_at: null, last_error: 'token expired', connected_at: '2026-04-01T10:00:00+00:00',
        disconnected_at: '2026-05-01T10:00:00+00:00', sync_cursor: {},
      },
      {
        id: 'a1000000-0000-0000-0000-000000000003', tenant_id: T1, user_id: A, connector_id: 'terra', category: 'aggregator',
        provider_user_id: null, display_name: null, provider_username: null, access_token: null, refresh_token: null,
        is_active: false, last_sync_at: null, last_error: null, connected_at: '2026-06-01T10:00:00+00:00', disconnected_at: null, sync_cursor: {},
      },
      {
        id: 'a1000000-0000-0000-0000-000000000004', tenant_id: T1, user_id: A, connector_id: 'instagram', category: 'social',
        provider_user_id: 'ig-a', display_name: 'IG', provider_username: 'alice', access_token: 'sealed:v1:y', refresh_token: null,
        is_active: true, last_sync_at: null, last_error: null, connected_at: '2026-06-01T10:00:00+00:00', disconnected_at: null, sync_cursor: {},
      },
    ],
    user_integrations: [
      {
        id: 'a2000000-0000-0000-0000-000000000001', user_id: A, integration_id: 'manual-entry', status: 'connected',
        connected_at: '2026-05-01T08:00:00+00:00', disconnected_at: null, last_sync_at: '2026-10-12T07:00:00+00:00', last_error: null,
        metadata: { source: 'manual_log' },
      },
      {
        id: 'a2000000-0000-0000-0000-000000000002', user_id: A, integration_id: 'oura', status: 'disconnected',
        connected_at: '2026-05-02T08:00:00+00:00', disconnected_at: '2026-05-03T08:00:00+00:00', last_sync_at: null, last_error: null, metadata: {},
      },
      {
        id: 'b2000000-0000-0000-0000-000000000001', user_id: B, integration_id: 'manual-entry', status: 'error',
        connected_at: '2026-05-06T08:00:00+00:00', disconnected_at: null, last_sync_at: null, last_error: 'x', metadata: {},
      },
    ],
  };
}

const prevEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  resetHealthSourcesDualWriteCounters();
  resetHealthSourcesReconcileSchedule();
  process.env = { ...prevEnv };
  delete process.env.HEALTH_SOURCES_DUAL_WRITE;
  delete process.env.HEALTH_SOURCES_READ;
  delete process.env.VITANA_ENV;
});
afterAll(() => {
  process.env = prevEnv;
});

// ---------------------------------------------------------------------------
describe('S6 resolveHealthSource / setHealthSourceState / listHealthSources', () => {
  it('create:true is idempotent for the member\'s own logging sources', async () => {
    const db = createFakeDb({ connector_registry: REGISTRY });
    const first = await resolveHealthSource(db.client, ME, { kind: 'manual', create: true });
    const second = await resolveHealthSource(db.client, ME, { kind: 'manual', create: true });
    expect(first).toEqual({ ok: true, source_id: expect.any(String), kind: 'manual', connector_id: null, status: 'connected' });
    expect(second).toEqual(first);
    expect(db.tables.health_sources).toHaveLength(1);
    // voice and diary are separate sources of the same member.
    const voice = await resolveHealthSource(db.client, ME, { kind: 'voice', create: true });
    expect(voice.ok && voice.source_id).not.toBe(first.ok && first.source_id);
    expect(db.tables.health_sources).toHaveLength(2);
  });

  it('without create, an unknown source is SOURCE_NOT_CONNECTED and nothing is written', async () => {
    const db = createFakeDb({ connector_registry: REGISTRY });
    expect(await resolveHealthSource(db.client, ME, { kind: 'diary' })).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([]);
  });

  it('create:true never creates a device cloud, aggregator or partner source', async () => {
    const db = createFakeDb({ connector_registry: REGISTRY });
    for (const kind of ['device_cloud', 'aggregator'] as const) {
      expect(await resolveHealthSource(db.client, ME, { kind, connector_id: 'fitbit', create: true })).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
    }
    expect(await resolveHealthSource(db.client, ME, { kind: 'partner', connector_id: 'lab-x', create: true })).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
    expect(db.tables.health_sources).toEqual([]);
  });

  it('a lookup by source_id must belong to the identity', async () => {
    const db = createFakeDb({ connector_registry: REGISTRY });
    const mine = await resolveHealthSource(db.client, ME, { kind: 'manual', create: true });
    if (!mine.ok) throw new Error('setup');
    expect(await resolveHealthSource(db.client, ME, { source_id: mine.source_id })).toEqual(mine);
    expect(await resolveHealthSource(db.client, { tenant_id: T1, user_id: B }, { source_id: mine.source_id })).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
    expect(await resolveHealthSource(db.client, { tenant_id: T2, user_id: A }, { source_id: mine.source_id })).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
  });

  it('phone-store alias and canonical S6 form resolve to the same row', async () => {
    const db = createFakeDb({ connector_registry: [...REGISTRY, { id: 'apple_health', category: 'wearable' }, { id: 'health_connect', category: 'wearable' }] });
    const alias = await resolveHealthSource(db.client, ME, { kind: 'phone_store', install_id: 'inst-1', platform: 'ios', create: true });
    const canonical = await resolveHealthSource(db.client, ME, { kind: 'phone_store', connector_id: 'apple_health', provider_user_id: 'inst-1' });
    expect(alias).toEqual({ ok: true, source_id: expect.any(String), kind: 'phone_store', connector_id: 'apple_health', status: 'connected' });
    expect(canonical).toEqual(alias);
    const android = await resolveHealthSource(db.client, ME, { kind: 'phone_store', install_id: 'inst-1', platform: 'android', create: true });
    expect(android.ok && android.connector_id).toBe('health_connect');
    expect(db.tables.health_sources).toHaveLength(2);
    expect(canonicalSourceKey({ kind: 'phone_store', install_id: ' inst-1 ', platform: 'ios' })).toEqual({
      kind: 'phone_store', connector_id: 'apple_health', provider_user_id: 'inst-1', create: false,
    });
  });

  it('an unknown platform or an empty install_id is SOURCE_NOT_CONNECTED and creates nothing', async () => {
    const db = createFakeDb({ connector_registry: [...REGISTRY, { id: 'apple_health', category: 'wearable' }] });
    for (const bad of [
      { kind: 'phone_store', install_id: 'inst-1', platform: 'windows', create: true },
      { kind: 'phone_store', install_id: '', platform: 'ios', create: true },
      { kind: 'phone_store', install_id: '   ', platform: 'android', create: true },
      { kind: 'phone_store', connector_id: 'fitbit', provider_user_id: 'x', create: true },
      { kind: 'phone_store', connector_id: 'apple_health', create: true },
      { kind: 'manual', connector_id: 'fitbit', create: true },
      { kind: 'wearable', create: true },
    ]) {
      expect(await resolveHealthSource(db.client, ME, bad as any)).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
    }
    expect(db.calls).toEqual([]);
  });

  it('a phone-store create answers STORE_UNAVAILABLE until C1 registers the connector ids', async () => {
    const db = createFakeDb({ connector_registry: REGISTRY });
    expect(await resolveHealthSource(db.client, ME, { kind: 'phone_store', install_id: 'inst-1', platform: 'ios', create: true })).toEqual({
      ok: false, code: 'STORE_UNAVAILABLE',
    });
    expect(db.tables.health_sources).toEqual([]);
    db.tables.connector_registry.push({ id: 'apple_health', category: 'wearable' });
    expect((await resolveHealthSource(db.client, ME, { kind: 'phone_store', install_id: 'inst-1', platform: 'ios', create: true })).ok).toBe(true);
  });

  it('answers STORE_PENDING while the table is missing, and never throws', async () => {
    const db = createFakeDb();
    db.missing.add('health_sources');
    expect(await resolveHealthSource(db.client, ME, { kind: 'manual', create: true })).toEqual({ ok: false, code: 'STORE_PENDING' });
    expect(await resolveHealthSource(db.client, ME, { source_id: 'x' })).toEqual({ ok: false, code: 'STORE_PENDING' });
    expect(await setHealthSourceState(db.client, ME, { source_id: 'x', status: 'paused' })).toEqual({ ok: false, code: 'STORE_PENDING' });
    expect(await listHealthSources(db.client, ME)).toEqual({ ok: false, code: 'STORE_PENDING' });
    db.throwAll = true;
    expect(await resolveHealthSource(db.client, ME, { kind: 'manual', create: true })).toEqual({ ok: false, code: 'STORE_UNAVAILABLE' });
    expect(await setHealthSourceState(db.client, ME, { source_id: 'x', status: 'paused' })).toEqual({ ok: false, code: 'STORE_UNAVAILABLE' });
    expect(await listHealthSources(db.client, ME)).toEqual({ ok: false, code: 'STORE_UNAVAILABLE' });
  });

  it('setHealthSourceState updates own sources only and maps C\'s states', async () => {
    const db = createFakeDb({ connector_registry: REGISTRY });
    const s = await resolveHealthSource(db.client, ME, { kind: 'voice', create: true });
    if (!s.ok) throw new Error('setup');
    const revoked = healthSourceStateFromSync('os_permission_revoked')!;
    expect(revoked).toEqual({ status: 'paused', reason_code: 'OS_PERMISSION_REVOKED' });
    expect(healthSourceStateFromSync('active')).toEqual({ status: 'connected' });
    expect(healthSourceStateFromSync('whatever')).toBeNull();
    expect(await setHealthSourceState(db.client, ME, { source_id: s.source_id, ...revoked })).toEqual({ ok: true });
    expect(db.tables.health_sources[0]).toMatchObject({ status: 'paused', last_error_code: 'OS_PERMISSION_REVOKED' });
    expect(await setHealthSourceState(db.client, ME, { source_id: s.source_id, status: 'disconnected' })).toEqual({ ok: true });
    expect(db.tables.health_sources[0].disconnected_at).toEqual(expect.any(String));
    expect(await setHealthSourceState(db.client, { tenant_id: T1, user_id: B }, { source_id: s.source_id, status: 'error' })).toEqual({
      ok: false, code: 'SOURCE_NOT_CONNECTED',
    });
    expect(await setHealthSourceState(db.client, ME, { source_id: s.source_id, status: 'pending' as any })).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(await setHealthSourceState(db.client, ME, { source_id: s.source_id, status: 'error', reason_code: 'free text!' })).toEqual({
      ok: false, code: 'INVALID_INPUT',
    });
    const list = await listHealthSources(db.client, ME);
    expect(list).toEqual({ ok: true, sources: [expect.objectContaining({ source_id: s.source_id, kind: 'voice', status: 'disconnected' })] });
    expect(await listHealthSources(db.client, { tenant_id: T1, user_id: B })).toEqual({ ok: true, sources: [] });
  });
});

// ---------------------------------------------------------------------------
describe('Change 3 — dual-write of the legacy connection models', () => {
  it('flag off, or on staging, does nothing at all', () => {
    const db = createFakeDb(legacySeed());
    expect(isHealthSourcesDualWriteEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isHealthSourcesDualWriteEnabled({ HEALTH_SOURCES_DUAL_WRITE: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isHealthSourcesDualWriteEnabled({ HEALTH_SOURCES_DUAL_WRITE: 'true', VITANA_ENV: 'staging' } as NodeJS.ProcessEnv)).toBe(false);
    expect(dualWriteUserConnections(db.client, { user_id: A, connector_id: 'fitbit' }, 'wearables.callback', {} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      dualWriteUserIntegration(db.client, { user_id: A, integration_id: 'manual-entry' }, 'voice.health_log', {
        HEALTH_SOURCES_DUAL_WRITE: 'true', VITANA_ENV: 'staging',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(db.calls).toEqual([]);
  });

  it('mirrors health connections with the backfill mapping and ignores other categories', async () => {
    const db = createFakeDb(legacySeed());
    for (const c of ['fitbit', 'oura', 'terra', 'instagram']) {
      expect((await mirrorUserConnections(db.client, { user_id: A, connector_id: c })).ok).toBe(true);
    }
    expect(db.tables.health_sources).toHaveLength(3);
    const fitbit = db.tables.health_sources.find((s) => s.connector_id === 'fitbit')!;
    expect(fitbit).toMatchObject({
      tenant_id: T1, user_id: A, kind: 'device_cloud', status: 'connected', provider_user_id: 'fb-a',
      token_ref: 'user_connections:a1000000-0000-0000-0000-000000000001', sync_cursor: { sleep_since: '2026-10-01' },
      legacy_user_connection_id: 'a1000000-0000-0000-0000-000000000001',
    });
    expect(Object.keys(fitbit).some((k) => /token$/.test(k) && k !== 'token_ref')).toBe(false);
    expect(db.tables.health_sources.find((s) => s.connector_id === 'oura')!.status).toBe('disconnected');
    expect(db.tables.health_sources.find((s) => s.connector_id === 'terra')).toMatchObject({ kind: 'aggregator', status: 'pending' });

    // A legacy disconnect is mirrored onto the same row (keyed by the legacy id).
    Object.assign(db.tables.user_connections[0], { is_active: false, disconnected_at: '2026-10-13T09:00:00+00:00' });
    expect(await mirrorUserConnections(db.client, { user_id: A, connector_id: 'fitbit' })).toEqual({ ok: true, mirrored: 1 });
    expect(db.tables.health_sources).toHaveLength(3);
    expect(db.tables.health_sources.find((s) => s.connector_id === 'fitbit')).toMatchObject({
      status: 'disconnected', disconnected_at: '2026-10-13T09:00:00+00:00', tenant_id: T1,
    });
    expect(mapLegacyConnection({ ...db.tables.user_connections[3] } as any)).toBeNull();
  });

  it('mirrors user_integrations: manual-entry, registered ids, primary tenant, unmapped and tenant-less rows', async () => {
    const db = createFakeDb({ ...legacySeed(), user_tenants: legacySeed().user_tenants.filter((t) => t.user_id === B) });
    // A has no membership now: nothing can be placed.
    expect(await mirrorUserIntegration(db.client, { user_id: A, integration_id: 'manual-entry' })).toEqual({ ok: false, code: 'NO_TENANT' });
    // ...unless the caller knows the tenant.
    expect(await mirrorUserIntegration(db.client, { user_id: A, integration_id: 'manual-entry', tenant_id: T1 })).toEqual({ ok: true, mirrored: 1 });
    expect(await mirrorUserIntegration(db.client, { user_id: A, integration_id: 'oura', tenant_id: T1 })).toEqual({ ok: true, mirrored: 1 });
    // B: two memberships, T2 is primary.
    expect(await mirrorUserIntegration(db.client, { user_id: B, integration_id: 'manual-entry' })).toEqual({ ok: true, mirrored: 1 });
    expect(db.tables.health_sources.find((s) => s.user_id === B)).toMatchObject({ tenant_id: T2, kind: 'manual', status: 'error', connector_id: null });
    expect(db.tables.health_sources.find((s) => s.connector_id === 'oura')).toMatchObject({ kind: 'device_cloud', status: 'disconnected' });
    db.tables.user_integrations.push({ id: 'a2000000-0000-0000-0000-000000000009', user_id: A, integration_id: 'whoop', status: 'connected' });
    expect(await mirrorUserIntegration(db.client, { user_id: A, integration_id: 'whoop', tenant_id: T1 })).toEqual({ ok: false, code: 'UNMAPPED_INTEGRATION' });
    expect(await mirrorUserIntegration(db.client, { user_id: A, integration_id: 'calm', tenant_id: T1 })).toEqual({ ok: false, code: 'LEGACY_ROW_MISSING' });
    // Replays update in place.
    expect(await mirrorUserIntegration(db.client, { user_id: B, integration_id: 'manual-entry' })).toEqual({ ok: true, mirrored: 1 });
    expect(db.tables.health_sources).toHaveLength(3);
  });

  it('a failure is counted, logged and emitted with codes only — and never changes the legacy response', async () => {
    process.env.HEALTH_SOURCES_DUAL_WRITE = 'true';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const app = express();
    app.use(express.json());
    app.use('/api/v1/integrations', integrationsRouter);

    currentDb = createFakeDb(legacySeed());
    currentDb.missing.add('health_sources');
    const on1 = await request(app).post('/api/v1/integrations/oura/connect').set('x-test-user', A);
    const settleOn = dualWriteUserIntegration(currentDb.client, { user_id: A, integration_id: 'oura' }, 'integrations.connect', ON);
    expect(await settleOn).toEqual({ ok: false, code: 'STORE_PENDING' });
    await new Promise((r) => setImmediate(r));

    process.env.HEALTH_SOURCES_DUAL_WRITE = 'false';
    currentDb = createFakeDb(legacySeed());
    const off = await request(app).post('/api/v1/integrations/oura/connect').set('x-test-user', A);
    expect(currentDb.calls.some((c) => c.table === 'health_sources')).toBe(false);

    const strip = (b: any) => ({ ...b, integration: { ...b.integration, connected_at: 'T', updated_at: 'T' } });
    expect(on1.status).toBe(off.status);
    expect(strip(on1.body)).toEqual(strip(off.body));

    expect(getHealthSourcesDualWriteCounters()['integrations.connect:STORE_PENDING']).toBeGreaterThanOrEqual(2);
    const events = mockEmit.mock.calls.map((c) => c[0] as any).filter((e) => e.type === 'health.sources.dual_write_failed');
    expect(events).toHaveLength(1); // rate-limited per site+code
    expect(events[0].payload).toEqual({ site: 'integrations.connect', code: 'STORE_PENDING', suppressed_since_last: 0 });
    expect(JSON.stringify(events[0])).not.toContain(A);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"code":"STORE_PENDING"'));
    warn.mockRestore();
  });

  it('a throwing client still settles to a code', async () => {
    const db = createFakeDb(legacySeed());
    db.throwAll = true;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await dualWriteUserConnections(db.client, { user_id: A, connector_id: 'fitbit' }, 'webhook.auth_completed', ON)).toEqual({
      ok: false, code: 'MIRROR_THREW',
    });
  });
});

// ---------------------------------------------------------------------------
describe('Change 4 — read switch: byte-identical responses for both flag states', () => {
  function apps() {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/integrations', integrationsRouter);
    app.use('/api/v1/wearables', wearablesRouter);
    return app;
  }
  const bearer = new jose.UnsecuredJWT({ sub: A }).encode();

  async function fixtureWithMirroredSources(): Promise<FakeDb> {
    const db = createFakeDb(legacySeed());
    for (const c of ['fitbit', 'oura', 'terra']) await mirrorUserConnections(db.client, { user_id: A, connector_id: c });
    for (const i of ['manual-entry', 'oura']) await mirrorUserIntegration(db.client, { user_id: A, integration_id: i });
    return db;
  }

  async function getAll(app: express.Express) {
    const integrations = await request(app).get('/api/v1/integrations').set('x-test-user', A);
    const connections = await request(app).get('/api/v1/wearables/connections').set('authorization', `Bearer ${bearer}`);
    const providers = await request(app).get('/api/v1/wearables/providers').set('authorization', `Bearer ${bearer}`);
    return { integrations: integrations.text, connections: connections.text, providers: providers.text };
  }

  it('the switch is exact-true and never on staging', () => {
    expect(isHealthSourcesReadEnabled({ HEALTH_SOURCES_READ: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isHealthSourcesReadEnabled({ HEALTH_SOURCES_READ: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isHealthSourcesReadEnabled({ HEALTH_SOURCES_READ: 'true', VITANA_ENV: 'staging' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('GET /integrations, /wearables/connections and /wearables/providers are byte-identical over the same fixture', async () => {
    currentDb = await fixtureWithMirroredSources();
    const app = apps();
    const off = await getAll(app);
    process.env.HEALTH_SOURCES_READ = 'true';
    currentDb.calls.length = 0;
    const on = await getAll(app);
    expect(currentDb.calls.filter((c) => c.table === 'health_sources').length).toBe(3);
    expect(on).toEqual(off);
    expect(JSON.parse(on.connections).connections).toHaveLength(3);
    expect(JSON.parse(on.integrations).integrations.map((r: any) => r.integration_id)).toEqual(['manual-entry', 'oura']);
  });

  it('with the switch on, connection state comes from health_sources', async () => {
    currentDb = await fixtureWithMirroredSources();
    // health_sources says fitbit is disconnected; the legacy row still says active.
    Object.assign(currentDb.tables.health_sources.find((s) => s.connector_id === 'fitbit' && s.legacy_user_connection_id)!, {
      status: 'disconnected', disconnected_at: '2026-10-13T09:00:00+00:00',
    });
    process.env.HEALTH_SOURCES_READ = 'true';
    const res = await request(apps()).get('/api/v1/wearables/connections').set('authorization', `Bearer ${bearer}`);
    const fitbit = res.body.connections.find((c: any) => c.connector_id === 'fitbit');
    expect(fitbit).toMatchObject({ is_active: false, disconnected_at: '2026-10-13T09:00:00+00:00', display_name: 'Fitbit A' });
    const providers = await request(apps()).get('/api/v1/wearables/providers').set('authorization', `Bearer ${bearer}`);
    expect(providers.body.providers.find((p: any) => p.id === 'fitbit').status).toBe('available');
  });

  it('falls back to the legacy answer when the table is missing or a legacy row is unlinked', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    currentDb = createFakeDb(legacySeed());
    const off = await getAll(apps());
    process.env.HEALTH_SOURCES_READ = 'true';
    currentDb.missing.add('health_sources');
    expect(await getAll(apps())).toEqual(off);
    currentDb.missing.delete('health_sources');
    await mirrorUserConnections(currentDb.client, { user_id: A, connector_id: 'fitbit' }); // oura, terra, integrations unlinked
    expect(await getAll(apps())).toEqual(off);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"code":"LEGACY_UNLINKED"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"code":"STORE_PENDING"'));
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
describe('Change 5 — reconciler', () => {
  const COUNTS = {
    legacy_connections: [{ kind: 'device_cloud', status: 'connected', n: 1 }],
    legacy_integrations: [{ kind: 'manual', status: 'connected', n: 1 }],
    sources: [{ kind: 'device_cloud', status: 'connected', n: 1 }, { kind: 'manual', status: 'connected', n: 1 }],
    mismatch: { connections_unlinked: 0, integrations_unlinked: 0, integrations_no_tenant: 0, integrations_unmapped: 0, status_mismatch: 0, orphaned_sources: 0, total: 0 },
    computed_at: '2026-10-14T02:00:00Z',
  };

  it('runs once per UTC date, only on the first batch, only with a flag on, never on staging', async () => {
    const db = createFakeDb();
    db.rpcResults.health_sources_reconcile_counts = { data: COUNTS, error: null };
    const now = new Date('2026-10-14T02:00:00Z');
    expect(maybeRunNightlyHealthSourcesReconcile(db.client, { cursor: null, now }, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(maybeRunNightlyHealthSourcesReconcile(db.client, { cursor: null, now }, { HEALTH_SOURCES_DUAL_WRITE: 'true', VITANA_ENV: 'staging' } as NodeJS.ProcessEnv)).toBeNull();
    expect(maybeRunNightlyHealthSourcesReconcile(db.client, { cursor: 'c-1', now }, ON)).toBeNull();
    const run = maybeRunNightlyHealthSourcesReconcile(db.client, { cursor: null, now }, ON);
    expect(await run).toEqual({ ok: true, counts: COUNTS });
    expect(maybeRunNightlyHealthSourcesReconcile(db.client, { cursor: null, now }, ON)).toBeNull();
    expect(maybeRunNightlyHealthSourcesReconcile(db.client, { cursor: null, now: new Date('2026-10-15T02:00:00Z') }, ON)).not.toBeNull();
    const ev = mockEmit.mock.calls.map((c) => c[0] as any).find((e) => e.type === 'health.sources.reconcile');
    expect(ev.status).toBe('info');
    expect(ev.payload.mismatch.total).toBe(0);
    expect(db.calls.every((c) => c.op === 'rpc')).toBe(true);
  });

  it('a missing function is STORE_PENDING and emits nothing', async () => {
    const db = createFakeDb();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await maybeRunNightlyHealthSourcesReconcile(db.client, { cursor: undefined }, { HEALTH_SOURCES_READ: 'true' } as NodeJS.ProcessEnv)).toEqual({
      ok: false, code: 'STORE_PENDING',
    });
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
