// VTID-05092 — "withdrawal always works" (GDPR Art. 7(3)).
//
// The gateway may be promoted to production before the VTID-05092 migration
// is applied. These tests run the REAL service and BOTH real routers over a
// strict in-memory copy of the PRE-migration schema (any new column, table or
// fn_set_health_consent answers the same errors PostgREST does), and then over
// a POST-migration store to show those paths are unchanged:
//   - revoke via /api/v1/health/consents/revoke and the legacy
//     /api/v1/partner-health/consent/revoke → 200, revoked_at written, audit
//     row with legacy columns only, OASIS revoke event
//   - audit insert failure → still 200, counter incremented, loud log
//   - grant (both routes) → 503 CONSENT_STORE_PENDING, nothing written
//   - legacy GET and the ingestion consent check (checkDataSharingConsent /
//     hasHealthConsent) keep working pre-migration

import express from 'express';
import request from 'supertest';

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TENANT_ID = 'tenant-1';

// ---------------------------------------------------------------------------
// Strict in-memory store
// ---------------------------------------------------------------------------
const LEGACY_COLUMNS: Record<string, string[]> = {
  data_sharing_consents: ['id', 'tenant_id', 'user_id', 'resource_type', 'resource_id', 'scope', 'granted_at', 'revoked_at', 'granted_via', 'created_at'],
  data_sharing_consent_events: ['id', 'tenant_id', 'user_id', 'resource_type', 'resource_id', 'scope', 'action', 'actor_role', 'actor_id', 'before', 'after', 'created_at'],
  partner_registry: ['id', 'partner_key', 'display_name', 'status'],
};

type Row = Record<string, any>;
const db = {
  migrated: false,
  failAuditInsert: false,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ name: string; args: Row }>,
  writes: [] as Array<{ table: string; op: string }>,
};
let idSeq = 0;

function columnsOf(table: string): string[] | null {
  const legacy = LEGACY_COLUMNS[table];
  if (!legacy) return db.migrated && table === 'health_consent_categories' ? ['key', 'resource_type', 'scope', 'per_resource', 'current_text_version', 'processing_active', 'sort', 'active'] : null;
  if (!db.migrated || table === 'partner_registry') return legacy;
  if (table === 'data_sharing_consents') return [...legacy, 'category_key', 'text_version', 'shown_locale'];
  return [...legacy, 'category_key', 'text_version', 'shown_locale', 'request_id'];
}

function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const used: string[] = [];
      let op: 'select' | 'update' | 'insert' = 'select';
      let payload: Row | null = null;
      let selectCols: string | null = null;
      let single = false;
      let limitN: number | null = null;
      const chain: any = {
        select(cols: string) { selectCols = cols; return chain; },
        update(v: Row) { op = 'update'; payload = v; used.push(...Object.keys(v)); return chain; },
        insert(v: Row) { op = 'insert'; payload = v; used.push(...Object.keys(v)); return chain; },
        eq(c: string, v: unknown) { used.push(c); filters.push((r) => r[c] === v); return chain; },
        is(c: string, v: unknown) { used.push(c); filters.push((r) => (r[c] ?? null) === v); return chain; },
        in(c: string, v: unknown[]) { used.push(c); filters.push((r) => v.includes(r[c])); return chain; },
        order() { return chain; },
        limit(n: number) { limitN = n; return chain; },
        maybeSingle() { single = true; return chain; },
        then(resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) {
          return Promise.resolve().then(() => run()).then(resolve, reject);
        },
      };
      function run() {
        const cols = columnsOf(table);
        if (!cols) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } };
        const requested = selectCols && selectCols !== '*' ? selectCols.split(',').map((c) => c.trim()) : [];
        const unknown = [...used, ...requested].find((c) => !cols.includes(c));
        if (unknown) return { data: null, error: { code: '42703', message: `column ${table}.${unknown} does not exist` } };
        const rows = (db.tables[table] ??= []);
        const project = (r: Row) => (requested.length ? Object.fromEntries(requested.map((c) => [c, r[c] ?? null])) : { ...r });
        if (op === 'insert') {
          if (table === 'data_sharing_consent_events' && db.failAuditInsert) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
          const row = { id: `id-${++idSeq}`, created_at: new Date().toISOString(), ...payload };
          rows.push(row);
          db.writes.push({ table, op });
          return { data: single ? project(row) : [project(row)], error: null };
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') {
          matched.forEach((r) => Object.assign(r, payload));
          if (matched.length) db.writes.push({ table, op });
        }
        const out = (limitN ? matched.slice(0, limitN) : matched).map(project);
        return { data: single ? out[0] ?? null : out, error: null };
      }
      return chain;
    },
    async rpc(name: string, args: Row) {
      db.rpcCalls.push({ name, args });
      if (!db.migrated) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` } };
      // Post-migration: the function owns the write (simulated minimally).
      const row = (db.tables.data_sharing_consents ?? []).find((r) => r.user_id === args.p_user && r.resource_id === (args.p_resource_id ?? args.p_category) && r.revoked_at == null);
      if (args.p_action === 'revoke') {
        if (!row) return { data: { ok: true, changed: false }, error: null };
        row.revoked_at = 'fn-revoked';
        return { data: { ok: true, changed: true, consent_id: row.id, event_id: 'fn-event', resource_id: row.resource_id, revoked_at: row.revoked_at }, error: null };
      }
      return { data: { ok: true, changed: true, consent_id: 'fn-c', event_id: 'fn-e', text_version: args.p_text_version, shown_locale: args.p_locale, granted_via: args.p_granted_via }, error: null };
    },
  };
}

const sb = fakeSupabase();

jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => sb }));
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer user-1') return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: USER_ID, tenant_id: TENANT_ID };
    return next();
  },
}));
const emitOasisEventMock = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: any[]) => emitOasisEventMock(...a) }));
jest.mock('../../src/connectors', () => ({ listConnectors: () => [{ id: 'oura', category: 'wearable', display_name: 'Oura' }] }));

/* eslint-disable @typescript-eslint/no-var-requires */
const memberRouter = require('../../src/routes/health-consent').default;
const legacyRouter = require('../../src/routes/partner-health-consent').default;
const svc = require('../../src/services/consent/health-consent');
const { checkDataSharingConsent } = require('../../src/services/partner-health/consent');
/* eslint-enable @typescript-eslint/no-var-requires */

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/health/consents', memberRouter);
  a.use('/api/v1/partner-health/consent', legacyRouter);
  return a;
}
const AUTH = { Authorization: 'Bearer user-1' };

function seed() {
  db.tables = {
    partner_registry: [{ id: 'p1', partner_key: 'doctorbox', display_name: 'DoctorBox', status: 'sandbox' }],
    data_sharing_consents: [
      { id: 'c-doc', tenant_id: TENANT_ID, user_id: USER_ID, resource_type: 'partner_integration', resource_id: 'doctorbox', scope: 'result_ingestion', granted_at: 't0', revoked_at: null, granted_via: 'settings_connected_apps', created_at: 't0' },
      { id: 'c-ai', tenant_id: TENANT_ID, user_id: USER_ID, resource_type: 'health_category', resource_id: 'ai_health_analysis', scope: 'processing', granted_at: 't0', revoked_at: null, granted_via: 'settings_privacy', created_at: 't0' },
      { id: 'c-other', tenant_id: TENANT_ID, user_id: OTHER_USER, resource_type: 'partner_integration', resource_id: 'doctorbox', scope: 'result_ingestion', granted_at: 't0', revoked_at: null, granted_via: 'settings_connected_apps', created_at: 't0' },
    ],
    data_sharing_consent_events: [],
  };
  db.rpcCalls = [];
  db.writes = [];
}

const consent = (id: string) => db.tables.data_sharing_consents.find((r) => r.id === id) as Row;

beforeEach(() => {
  db.migrated = false;
  db.failAuditInsert = false;
  seed();
  emitOasisEventMock.mockReset().mockResolvedValue({ ok: true });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('pre-migration: withdrawal always works (GDPR Art. 7(3))', () => {
  it('new route: revoke → 200, revoked_at written, legacy-column audit row, OASIS revoke event', async () => {
    const r = await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({ category: 'ai_health_analysis' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, changed: true, consent: {
      category: 'ai_health_analysis', resource_id: 'ai_health_analysis', active: false, text_version: null, shown_locale: null,
      granted_via: 'settings_privacy', granted_at: 't0', revoked_at: expect.any(String),
    } });
    expect(consent('c-ai').revoked_at).toEqual(expect.any(String));
    expect(consent('c-doc').revoked_at).toBeNull(); // other consents untouched
    const ev = db.tables.data_sharing_consent_events;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ user_id: USER_ID, resource_type: 'health_category', resource_id: 'ai_health_analysis', scope: 'processing', action: 'revoke', actor_role: 'user', actor_id: USER_ID });
    expect(ev[0].before.revoked_at).toBeNull();
    expect(ev[0].after.revoked_at).toEqual(expect.any(String));
    expect(Object.keys(ev[0]).filter((k) => !LEGACY_COLUMNS.data_sharing_consent_events.includes(k))).toEqual([]);
    expect(db.rpcCalls.map((c) => c.name)).toEqual(['fn_set_health_consent']); // tried the function first
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
    expect(emitOasisEventMock.mock.calls[0][0]).toMatchObject({ type: 'health.consent.revoked', payload: { category: 'ai_health_analysis', resource_id: 'ai_health_analysis', text_version: null, locale: null } });
  });

  it('legacy route: revoke → 200 { ok: true }, only the caller\'s DoctorBox row revoked', async () => {
    const r = await request(app()).post('/api/v1/partner-health/consent/revoke').set(AUTH).send({ partner_key: 'doctorbox', scope: 'result_ingestion', user_id: OTHER_USER });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(consent('c-doc').revoked_at).toEqual(expect.any(String));
    expect(consent('c-other').revoked_at).toBeNull();
    expect(db.tables.data_sharing_consent_events).toHaveLength(1);
    expect(emitOasisEventMock.mock.calls[0][0]).toMatchObject({ type: 'health.consent.revoked', source: 'partner-health-consent' });
  });

  it('revoke of a consent the member does not hold → 200 changed:false, no write, no event', async () => {
    const r = await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({ category: 'community_insights' });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(false);
    expect(db.writes).toEqual([]);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('audit insert failure → revoke still 200, consent revoked, failure counted and logged loudly, OASIS still sent', async () => {
    db.failAuditInsert = true;
    const before = svc.getConsentAuditFailureCount();
    const errorSpy = console.error as jest.Mock;
    const r = await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({ category: 'partner_results', resource_id: 'doctorbox' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, changed: true, consent: { active: false } });
    expect(consent('c-doc').revoked_at).toEqual(expect.any(String));
    expect(db.tables.data_sharing_consent_events).toHaveLength(0);
    expect(svc.getConsentAuditFailureCount()).toBe(before + 1);
    expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/AUDIT ROW MISSING: consent c-doc/);
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);

    const legacy = await request(app()).post('/api/v1/partner-health/consent/revoke').set(AUTH).send({ partner_key: 'doctorbox', scope: 'result_ingestion' });
    expect(legacy.status).toBe(200); // already revoked: idempotent
  });

  it('a per-resource revoke without a resource is 400, never a silent success', async () => {
    const r = await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({ category: 'partner_results' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'UNKNOWN_RESOURCE' });
  });

  it('grant stays fail-closed on both routes: 503 CONSENT_STORE_PENDING, nothing written', async () => {
    const a = await request(app()).post('/api/v1/health/consents/grant').set(AUTH).send({ category: 'community_insights', text_version: 'v1', locale: 'de' });
    expect(a.status).toBe(503);
    expect(a.body).toEqual({ ok: false, error: 'CONSENT_STORE_PENDING' });
    const b = await request(app()).post('/api/v1/partner-health/consent/grant').set(AUTH).send({ partner_key: 'doctorbox', scope: 'result_ingestion' });
    expect(b.status).toBe(503);
    expect(b.body).toEqual({ ok: false, error: 'CONSENT_STORE_PENDING' });
    expect(db.writes).toEqual([]);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('legacy GET keeps working', async () => {
    const r = await request(app()).get('/api/v1/partner-health/consent?partner_key=doctorbox&scope=result_ingestion').set(AUTH);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, granted: true });
    await request(app()).post('/api/v1/partner-health/consent/revoke').set(AUTH).send({ partner_key: 'doctorbox', scope: 'result_ingestion' });
    const after = await request(app()).get('/api/v1/partner-health/consent?partner_key=doctorbox&scope=result_ingestion').set(AUTH);
    expect(after.body).toEqual({ ok: true, granted: false });
  });

  it('the ingestion consent check (checkDataSharingConsent / hasHealthConsent) keeps working, scoped to the member', async () => {
    const id = { tenant_id: TENANT_ID, user_id: USER_ID };
    await expect(checkDataSharingConsent(sb, id, 'partner_integration', 'doctorbox', 'result_ingestion')).resolves.toBe(true);
    await expect(svc.hasHealthConsent(sb, id, 'partner_results', 'doctorbox')).resolves.toBe(true);
    await expect(svc.hasHealthConsent(sb, id, 'wearables', 'oura')).resolves.toBe(false);
    await expect(checkDataSharingConsent(sb, { tenant_id: TENANT_ID, user_id: 'nobody' }, 'partner_integration', 'doctorbox', 'result_ingestion')).resolves.toBe(false);
  });

  it('GET / and GET /history answer store_pending with legacy columns', async () => {
    const r = await request(app()).get('/api/v1/health/consents').set(AUTH);
    expect(r.status).toBe(200);
    expect(r.body.store_pending).toBe(true);
    expect(r.body.consents.map((c: Row) => c.category).sort()).toEqual(['ai_health_analysis', 'partner_results']);
    const h = await request(app()).get('/api/v1/health/consents/history').set(AUTH);
    expect(h.status).toBe(200);
    expect(h.body).toEqual({ ok: true, store_pending: true, events: [] });
  });
});

describe('post-migration: paths unchanged', () => {
  beforeEach(() => { db.migrated = true; });

  it('revoke goes through fn_set_health_consent only — no direct table write', async () => {
    const r = await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({ category: 'ai_health_analysis' });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.writes).toEqual([]); // the function did the write
    expect(consent('c-ai').revoked_at).toBe('fn-revoked');
  });

  it('legacy revoke and grants go through the function', async () => {
    expect((await request(app()).post('/api/v1/partner-health/consent/revoke').set(AUTH).send({ partner_key: 'doctorbox', scope: 'result_ingestion' })).status).toBe(200);
    expect((await request(app()).post('/api/v1/partner-health/consent/grant').set(AUTH).send({ partner_key: 'doctorbox', scope: 'result_ingestion' })).status).toBe(200);
    expect((await request(app()).post('/api/v1/health/consents/grant').set(AUTH).send({ category: 'community_insights', text_version: 'v1', locale: 'de' })).status).toBe(200);
    expect(db.rpcCalls.map((c) => c.args.p_action)).toEqual(['revoke', 'grant', 'grant']);
    expect(db.writes).toEqual([]);
  });
});
