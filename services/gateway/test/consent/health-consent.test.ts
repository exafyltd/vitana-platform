// VTID-05092 — health-consent service (Health Hub D10, WP1).
//
//   - the static category map equals the migration seed (parsed from the SQL)
//   - hasHealthConsent reads only pre-migration columns, is fail-closed
//   - setHealthConsent calls fn_set_health_consent with the given identity,
//     answers CONSENT_STORE_PENDING for a grant without the migration (a revoke
//     falls back — health-consent-premigration.test.ts), never leaks a DB message
//   - the OASIS event carries no health values; emit failures are counted
//   - member reads work before (store_pending) and after the migration
//   - the legacy partner-health/consent module delegates and stays fail-closed

import fs from 'fs';
import path from 'path';
import {
  HEALTH_CONSENT_CATEGORY_MAP,
  HEALTH_CONSENT_CATEGORY_KEYS,
  buildHealthConsentOasisEvent,
  categoryForRow,
  getConsentEmitFailureCount,
  hasHealthConsent,
  isConsentStoreMissing,
  listMemberConsentHistory,
  listMemberConsents,
  recordConsentEmitOutcome,
  resolveConsentResourceId,
  setHealthConsent,
  type HealthConsentChange,
} from '../../src/services/consent/health-consent';
import { checkDataSharingConsent } from '../../src/services/partner-health/consent';

const IDENTITY = { tenant_id: 'tenant-1', user_id: 'user-1' };

// ---------------------------------------------------------------------------
// A small chainable Supabase stand-in that records every query.
// ---------------------------------------------------------------------------
interface Query {
  table: string;
  select?: string;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  in: Array<[string, unknown]>;
  order?: [string, unknown];
  limit?: number;
  single?: boolean;
}
type Result = { data?: unknown; error?: { code?: string; message?: string } | null };

function makeSb(opts: { from?: (q: Query) => Result | Promise<Result>; rpc?: (name: string, args: Record<string, unknown>) => Result | Promise<Result> }) {
  const queries: Query[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const sb = {
    from(table: string) {
      const q: Query = { table, eq: [], is: [], in: [] };
      queries.push(q);
      const chain: any = {
        select(cols: string) { q.select = cols; return chain; },
        eq(c: string, v: unknown) { q.eq.push([c, v]); return chain; },
        is(c: string, v: unknown) { q.is.push([c, v]); return chain; },
        in(c: string, v: unknown) { q.in.push([c, v]); return chain; },
        order(c: string, o: unknown) { q.order = [c, o]; return chain; },
        limit(n: number) { q.limit = n; return chain; },
        maybeSingle() { q.single = true; return chain; },
        then(resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) {
          return Promise.resolve()
            .then(() => (opts.from ? opts.from(q) : { data: null, error: null }))
            .then((r) => ({ data: r.data ?? null, error: r.error ?? null }))
            .then(resolve, reject);
        },
      };
      return chain;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const r = opts.rpc ? await opts.rpc(name, args) : { data: null, error: null };
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return { sb: sb as any, queries, rpcCalls };
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('static category map', () => {
  it('equals the migration seed exactly', () => {
    const dir = path.join(__dirname, '../../../../supabase/migrations');
    const file = fs.readdirSync(dir).find((f) => /_vtid_05092_health_consent_categories\.sql$/.test(f));
    expect(file).toBeDefined();
    const sql = fs.readFileSync(path.join(dir, file as string), 'utf8');
    const block = sql.slice(sql.indexOf('INSERT INTO public.health_consent_categories'), sql.indexOf('ON CONFLICT (key) DO NOTHING'));
    const rows = [...block.matchAll(/\('(\w+)',\s*'(\w+)',\s*'(\w+)',\s*(TRUE|FALSE),\s*'(\w+)',\s*(TRUE|FALSE),\s*(\d+)\)/g)];
    const seed = Object.fromEntries(
      rows.map((m) => [m[1], { resource_type: m[2], scope: m[3], per_resource: m[4] === 'TRUE' }]),
    );
    expect(seed).toEqual(HEALTH_CONSENT_CATEGORY_MAP);
    expect(HEALTH_CONSENT_CATEGORY_KEYS).toEqual(['wearables', 'partner_results', 'ai_health_analysis', 'health_data_analytics', 'community_insights']);
  });

  it('partner_results matches the existing DoctorBox rows unchanged', () => {
    expect(HEALTH_CONSENT_CATEGORY_MAP.partner_results).toEqual({ resource_type: 'partner_integration', scope: 'result_ingestion', per_resource: true });
    expect(categoryForRow({ resource_type: 'partner_integration', resource_id: 'doctorbox', scope: 'result_ingestion' })).toBe('partner_results');
    expect(categoryForRow({ resource_type: 'partner_integration', resource_id: 'doctorbox', scope: 'order_tracking' })).toBeNull();
    expect(categoryForRow({ resource_type: 'health_category', resource_id: 'community_insights', scope: 'processing' })).toBe('community_insights');
    expect(categoryForRow({ resource_type: 'health_category', resource_id: 'something_else', scope: 'processing' })).toBeNull();
  });

  it('category-wide consents are stored under their own key; per-resource ones need a resource', () => {
    expect(resolveConsentResourceId('ai_health_analysis', 'ignored')).toBe('ai_health_analysis');
    expect(resolveConsentResourceId('wearables', '  oura ')).toBe('oura');
    expect(resolveConsentResourceId('wearables', ' ')).toBeNull();
    expect(resolveConsentResourceId('partner_results', null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('hasHealthConsent — fail closed, pre-migration columns only', () => {
  it('true for an active row, queried by tenant/user/resource_type/resource_id/scope/revoked_at only', async () => {
    const { sb, queries } = makeSb({ from: () => ({ data: { id: 'c1' } }) });
    await expect(hasHealthConsent(sb, IDENTITY, 'ai_health_analysis')).resolves.toBe(true);
    expect(queries[0]).toMatchObject({
      table: 'data_sharing_consents',
      select: 'id',
      eq: [['tenant_id', 'tenant-1'], ['user_id', 'user-1'], ['resource_type', 'health_category'], ['resource_id', 'ai_health_analysis'], ['scope', 'processing']],
      is: [['revoked_at', null]],
      single: true,
    });
  });

  it('per-partner check uses the partner key', async () => {
    const { sb, queries } = makeSb({ from: () => ({ data: { id: 'c1' } }) });
    await expect(hasHealthConsent(sb, IDENTITY, 'partner_results', 'doctorbox')).resolves.toBe(true);
    expect(queries[0].eq).toContainEqual(['resource_id', 'doctorbox']);
    expect(queries[0].eq).toContainEqual(['scope', 'result_ingestion']);
  });

  it('false when no row', async () => {
    const { sb } = makeSb({ from: () => ({ data: null }) });
    await expect(hasHealthConsent(sb, IDENTITY, 'wearables', 'oura')).resolves.toBe(false);
  });

  it('false on a DB error (never treated as consent)', async () => {
    const { sb } = makeSb({ from: () => ({ error: { message: 'boom' } }) });
    await expect(hasHealthConsent(sb, IDENTITY, 'ai_health_analysis')).resolves.toBe(false);
  });

  it('false when the client throws', async () => {
    const { sb } = makeSb({ from: () => { throw new Error('network'); } });
    await expect(hasHealthConsent(sb, IDENTITY, 'ai_health_analysis')).resolves.toBe(false);
  });

  it('false without a resource for a per-resource category, and for an unknown category — no query', async () => {
    const { sb, queries } = makeSb({ from: () => ({ data: { id: 'c1' } }) });
    await expect(hasHealthConsent(sb, IDENTITY, 'wearables')).resolves.toBe(false);
    await expect(hasHealthConsent(sb, IDENTITY, 'nope' as any)).resolves.toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('legacy checkDataSharingConsent keeps its signature and fails closed', async () => {
    const ok = makeSb({ from: () => ({ data: { id: 'c1' } }) });
    await expect(checkDataSharingConsent(ok.sb, IDENTITY, 'partner_integration', 'doctorbox', 'result_ingestion')).resolves.toBe(true);
    expect(ok.queries[0].eq).toContainEqual(['resource_type', 'partner_integration']);
    const bad = makeSb({ from: () => ({ error: { message: 'x' } }) });
    await expect(checkDataSharingConsent(bad.sb, IDENTITY, 'partner_integration', 'doctorbox', 'result_ingestion')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('setHealthConsent — one transaction through fn_set_health_consent', () => {
  const okData = {
    ok: true, changed: true, action: 'grant', consent_id: 'c1', event_id: 'e1', category: 'ai_health_analysis',
    resource_type: 'health_category', resource_id: 'ai_health_analysis', scope: 'processing', text_version: 'v1',
    shown_locale: 'de', granted_via: 'settings_privacy', granted_at: '2026-10-12T10:00:00Z', revoked_at: null,
  };

  it('calls the function with the given identity and every audit field', async () => {
    const { sb, rpcCalls, queries } = makeSb({ rpc: () => ({ data: okData }) });
    const r = await setHealthConsent(sb, {
      identity: IDENTITY, category: 'ai_health_analysis', action: 'grant', granted_via: 'settings_privacy',
      text_version: 'v1', locale: 'de', actor: { role: 'user', id: 'user-1' }, request_id: 'req-1',
    });
    expect(rpcCalls).toEqual([{ name: 'fn_set_health_consent', args: {
      p_tenant: 'tenant-1', p_user: 'user-1', p_category: 'ai_health_analysis', p_resource_id: null, p_action: 'grant',
      p_granted_via: 'settings_privacy', p_text_version: 'v1', p_locale: 'de', p_actor_role: 'user', p_actor_id: 'user-1', p_request_id: 'req-1',
    } }]);
    expect(queries).toHaveLength(0); // never writes the tables directly
    expect(r).toMatchObject({ ok: true, changed: true, category: 'ai_health_analysis', text_version: 'v1', shown_locale: 'de', event_id: 'e1' });
  });

  it('a revoke sends no version and no granted_via', async () => {
    const { sb, rpcCalls } = makeSb({ rpc: () => ({ data: { ...okData, action: 'revoke', revoked_at: '2026-10-12T11:00:00Z' } }) });
    await setHealthConsent(sb, { identity: IDENTITY, category: 'partner_results', resource_id: 'doctorbox', action: 'revoke', text_version: 'v1', granted_via: 'settings_privacy' });
    expect(rpcCalls[0].args).toMatchObject({ p_action: 'revoke', p_resource_id: 'doctorbox', p_text_version: null, p_granted_via: null, p_actor_role: 'user', p_actor_id: 'user-1' });
  });

  it('a GRANT answers CONSENT_STORE_PENDING (503) when the function does not exist yet', async () => {
    for (const error of [
      { code: 'PGRST202', message: 'Could not find the function public.fn_set_health_consent in the schema cache' },
      { code: '42883', message: 'function public.fn_set_health_consent does not exist' },
    ]) {
      const { sb } = makeSb({ rpc: () => ({ error }) });
      await expect(setHealthConsent(sb, { identity: IDENTITY, category: 'ai_health_analysis', action: 'grant', text_version: 'v1', locale: 'de', granted_via: 'settings_privacy' }))
        .resolves.toEqual({ ok: false, status: 503, error: 'CONSENT_STORE_PENDING' });
    }
  });

  it('maps function codes to API codes', async () => {
    const cases: Array<[string, number, string]> = [
      ['unknown_category', 400, 'UNKNOWN_CATEGORY'],
      ['unknown_resource', 400, 'UNKNOWN_RESOURCE'],
      ['resource_required', 400, 'UNKNOWN_RESOURCE'],
      ['stale_text_version', 409, 'STALE_TEXT_VERSION'],
      ['invalid_granted_via', 400, 'INVALID_REQUEST'],
      ['something_new', 500, 'CONSENT_WRITE_FAILED'],
    ];
    for (const [code, status, error] of cases) {
      const { sb } = makeSb({ rpc: () => ({ data: { ok: false, code } }) });
      await expect(setHealthConsent(sb, { identity: IDENTITY, category: 'partner_results', resource_id: 'x', action: 'grant', text_version: 'v1', locale: 'de', granted_via: 'settings_privacy' }))
        .resolves.toEqual({ ok: false, status, error });
    }
  });

  it('a database error answers a code, never the database message', async () => {
    const { sb } = makeSb({ rpc: () => ({ error: { code: '23514', message: 'new row violates check constraint "secret_internal_name"' } }) });
    const r = await setHealthConsent(sb, { identity: IDENTITY, category: 'ai_health_analysis', action: 'grant', text_version: 'v1', locale: 'de', granted_via: 'settings_privacy' });
    expect(r).toEqual({ ok: false, status: 500, error: 'CONSENT_WRITE_FAILED' });
    expect(JSON.stringify(r)).not.toContain('secret_internal_name');
  });

  it('a thrown client error answers CONSENT_WRITE_FAILED', async () => {
    const { sb } = makeSb({ rpc: () => { throw new Error('socket hang up'); } });
    await expect(setHealthConsent(sb, { identity: IDENTITY, category: 'ai_health_analysis', action: 'revoke' }))
      .resolves.toEqual({ ok: false, status: 500, error: 'CONSENT_WRITE_FAILED' });
  });

  it('an unknown category is refused before the database', async () => {
    const { sb, rpcCalls } = makeSb({});
    await expect(setHealthConsent(sb, { identity: IDENTITY, category: 'nope' as any, action: 'grant' }))
      .resolves.toEqual({ ok: false, status: 400, error: 'UNKNOWN_CATEGORY' });
    expect(rpcCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('OASIS event', () => {
  const change: HealthConsentChange = {
    changed: true, action: 'grant', category: 'partner_results', resource_type: 'partner_integration', resource_id: 'doctorbox',
    scope: 'result_ingestion', text_version: 'v1', shown_locale: 'de', granted_via: 'settings_privacy',
    granted_at: '2026-10-12T10:00:00Z', revoked_at: null, consent_id: 'c1', event_id: 'e1',
  };

  it('grant → health.consent.granted, payload has exactly category/resource/version/locale/granted_via', () => {
    const ev = buildHealthConsentOasisEvent(change, IDENTITY, 'health-consent');
    expect(ev).toMatchObject({ vtid: 'VTID-05092', type: 'health.consent.granted', source: 'health-consent', actor_id: 'user-1', actor_role: 'user' });
    expect(Object.keys(ev.payload ?? {}).sort()).toEqual(['category', 'granted_via', 'locale', 'resource_id', 'text_version']);
    expect(ev.payload).toEqual({ category: 'partner_results', resource_id: 'doctorbox', text_version: 'v1', locale: 'de', granted_via: 'settings_privacy' });
  });

  it('revoke → health.consent.revoked', () => {
    expect(buildHealthConsentOasisEvent({ ...change, action: 'revoke' }, IDENTITY, 'x').type).toBe('health.consent.revoked');
  });

  it('a failed or thrown emit is counted, never thrown', () => {
    const before = getConsentEmitFailureCount();
    expect(() => recordConsentEmitOutcome({ ok: false, error: 'down' }, change)).not.toThrow();
    expect(() => recordConsentEmitOutcome(undefined, change)).not.toThrow();
    recordConsentEmitOutcome({ ok: true }, change);
    expect(getConsentEmitFailureCount()).toBe(before + 2);
  });
});

// ---------------------------------------------------------------------------
describe('listMemberConsents', () => {
  const partners = [{ partner_key: 'doctorbox', display_name: 'DoctorBox', status: 'sandbox' }];
  const connectors = [{ id: 'oura', display_name: 'Oura' }];

  it('before the migration: store_pending, legacy columns only, legacy rows mapped to partner_results', async () => {
    const { sb, queries } = makeSb({
      from: (q) => {
        if (q.table === 'health_consent_categories') return { error: { code: 'PGRST205', message: "Could not find the table 'public.health_consent_categories' in the schema cache" } };
        if (q.table === 'data_sharing_consents') return { data: [
          { resource_type: 'partner_integration', resource_id: 'doctorbox', scope: 'result_ingestion', granted_at: 't1', revoked_at: null, granted_via: 'settings_connected_apps' },
          { resource_type: 'something_else', resource_id: 'x', scope: 'y', granted_at: 't1', revoked_at: null, granted_via: 'checkout_flow' },
        ] };
        return { data: partners };
      },
    });
    const r = await listMemberConsents(sb, IDENTITY, { connectors });
    expect(r).toEqual({
      ok: true, store_pending: true, categories: [], partners, connectors,
      consents: [{ category: 'partner_results', resource_id: 'doctorbox', active: true, granted_at: 't1', revoked_at: null, granted_via: 'settings_connected_apps', text_version: null, shown_locale: null }],
    });
    const consentQuery = queries.find((q) => q.table === 'data_sharing_consents') as Query;
    expect(consentQuery.select).not.toMatch(/category_key|text_version|shown_locale/);
    expect(consentQuery.eq).toEqual([['tenant_id', 'tenant-1'], ['user_id', 'user-1']]);
    expect((queries.find((q) => q.table === 'partner_registry') as Query).in).toEqual([['status', ['active', 'sandbox']]]);
  });

  it('after the migration: catalogue + version/locale per row', async () => {
    const categories = [{ key: 'wearables', resource_type: 'health_source', scope: 'ingestion', per_resource: true, current_text_version: 'v1', processing_active: false, sort: 10 }];
    const { sb, queries } = makeSb({
      from: (q) => {
        if (q.table === 'health_consent_categories') return { data: categories };
        if (q.table === 'data_sharing_consents') return { data: [
          { resource_type: 'health_source', resource_id: 'oura', scope: 'ingestion', granted_at: 't1', revoked_at: 't2', granted_via: 'settings_privacy', category_key: 'wearables', text_version: 'v1', shown_locale: 'en' },
        ] };
        return { data: partners };
      },
    });
    const r = await listMemberConsents(sb, IDENTITY, { connectors });
    expect(r).toMatchObject({ ok: true, store_pending: false, categories, consents: [{ category: 'wearables', resource_id: 'oura', active: false, text_version: 'v1', shown_locale: 'en' }] });
    expect((queries.find((q) => q.table === 'health_consent_categories') as Query).eq).toEqual([['active', true]]);
    expect((queries.find((q) => q.table === 'data_sharing_consents') as Query).select).toMatch(/category_key, text_version, shown_locale/);
  });

  it('a real read error answers CONSENTS_UNAVAILABLE', async () => {
    const { sb } = makeSb({ from: (q) => (q.table === 'data_sharing_consents' ? { error: { code: '57014', message: 'timeout' } } : { data: [] }) });
    await expect(listMemberConsents(sb, IDENTITY, { connectors })).resolves.toEqual({ ok: false, status: 500, error: 'CONSENTS_UNAVAILABLE' });
  });
});

// ---------------------------------------------------------------------------
describe('listMemberConsentHistory', () => {
  it('own events only, newest first, max 100, no snapshots or actor ids', async () => {
    const { sb, queries } = makeSb({ from: () => ({ data: [
      { id: 'e2', action: 'revoke', resource_type: 'health_category', resource_id: 'ai_health_analysis', scope: 'processing', actor_role: 'user', created_at: 't2', category_key: 'ai_health_analysis', text_version: 'v1', shown_locale: null },
    ] }) });
    const r = await listMemberConsentHistory(sb, IDENTITY);
    expect(r).toEqual({ ok: true, store_pending: false, events: [
      { id: 'e2', action: 'revoke', category: 'ai_health_analysis', resource_id: 'ai_health_analysis', text_version: 'v1', shown_locale: null, actor_role: 'user', created_at: 't2' },
    ] });
    expect(queries[0]).toMatchObject({ table: 'data_sharing_consent_events', eq: [['tenant_id', 'tenant-1'], ['user_id', 'user-1']], order: ['created_at', { ascending: false }], limit: 100 });
    expect(queries[0].select).not.toMatch(/before|after|actor_id|request_id/);
  });

  it('before the migration: retries with the legacy columns and flags store_pending', async () => {
    let n = 0;
    const { sb, queries } = makeSb({ from: () => (n++ === 0
      ? { error: { code: '42703', message: 'column data_sharing_consent_events.category_key does not exist' } }
      : { data: [{ id: 'e1', action: 'grant', resource_type: 'partner_integration', resource_id: 'doctorbox', scope: 'result_ingestion', actor_role: 'user', created_at: 't1' }] }) });
    const r = await listMemberConsentHistory(sb, IDENTITY);
    expect(r).toMatchObject({ ok: true, store_pending: true, events: [{ category: 'partner_results', resource_id: 'doctorbox', text_version: null }] });
    expect(queries[1].select).not.toMatch(/category_key/);
  });

  it('any other error answers CONSENT_HISTORY_UNAVAILABLE', async () => {
    const { sb } = makeSb({ from: () => ({ error: { code: '57014', message: 'timeout' } }) });
    await expect(listMemberConsentHistory(sb, IDENTITY)).resolves.toEqual({ ok: false, status: 500, error: 'CONSENT_HISTORY_UNAVAILABLE' });
  });
});

describe('isConsentStoreMissing', () => {
  it('recognises a missing table, column or function, and nothing else', () => {
    expect(isConsentStoreMissing({ code: '42P01', message: 'relation "x" does not exist' })).toBe(true);
    expect(isConsentStoreMissing({ code: 'PGRST205' })).toBe(true);
    expect(isConsentStoreMissing({ message: 'Could not find the function public.fn_set_health_consent(...) in the schema cache' })).toBe(true);
    expect(isConsentStoreMissing({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(isConsentStoreMissing(null)).toBe(false);
  });
});
