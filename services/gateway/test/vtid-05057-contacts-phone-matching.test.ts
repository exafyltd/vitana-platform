/**
 * VTID-05057 — imported contacts match members by phone as well as e-mail.
 *
 * Numbers are normalised to E.164 in the importer's region. A number matches
 * only a member whose phone is verified and who allows being found by number,
 * never a test/service account. Before the migration adds the columns, phone
 * matching finds no one and the import still succeeds.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set(['bot-1'])),
}));

const imp = jest.requireActual('../src/services/connected-apps/contacts-import');

describe('phone normalisation', () => {
  it('reads national numbers in the region and keeps international ones', () => {
    expect(imp.toE164('0170 1234567', 'DE')).toBe('+491701234567');
    expect(imp.toE164('0049 170 1234567', 'DE')).toBe('+491701234567');
    expect(imp.toE164('+381 64 123 4567', 'DE')).toBe('+381641234567');
    expect(imp.toE164('0664 1234567', 'AT')).toBe('+436641234567');
    expect(imp.toE164('(212) 555-0123', 'US')).toBe('+12125550123');
  });

  it('drops what is not a phone number', () => {
    expect(imp.toE164('12', 'DE')).toBeNull();
    expect(imp.toE164('call me', 'DE')).toBeNull();
    expect(imp.phonesE164(['0170 1234567', '+49 170 1234567', 'x'], 'DE')).toEqual(['+491701234567']);
  });

  it('region hints: country codes and locales, default DE', () => {
    expect(imp.phoneRegion('AT')).toBe('AT');
    expect(imp.phoneRegion('de-CH')).toBe('CH');
    expect(imp.phoneRegion('sr_RS')).toBe('RS');
    expect(imp.phoneRegion('xx')).toBe('DE');
    expect(imp.phoneRegion(undefined)).toBe('DE');
  });
});

describe('importContacts — phone matching', () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = global.fetch;
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
    imp.resetE164ColumnCache();
  });
  afterEach(() => { global.fetch = realFetch; });

  function mockDb(opts: { migrated: boolean; members?: Array<{ user_id: string; phone_e164: string }> }) {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    global.fetch = jest.fn(async (url: string, init: any = {}) => {
      const method = init.method ?? 'GET';
      const u = decodeURIComponent(String(url));
      calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : undefined });
      const missingColumn = !opts.migrated && /phone_e164|phone_verified|discoverable_by_phone/.test(u) && method === 'GET';
      if (missingColumn) {
        return { ok: false, status: 400, text: async () => '{"code":"42703"}', json: async () => ({ code: '42703' }) } as any;
      }
      let payload: any = method === 'GET' ? [] : null;
      if (method === 'GET' && u.includes('/profiles?') && u.includes('phone_e164=in.')) payload = opts.members ?? [];
      return { ok: true, status: 200, text: async () => (payload ? JSON.stringify(payload) : ''), json: async () => payload } as any;
    }) as any;
    return calls;
  }

  it('links a contact to a verified, discoverable member by number; asks only for those', async () => {
    const calls = mockDb({ migrated: true, members: [{ user_id: 'm1', phone_e164: '+491701234567' }, { user_id: 'bot-1', phone_e164: '+491709999999' }] });
    const r = await imp.importContacts('u1', 'android', [
      { external_id: 'a', name: 'Ana', phones: ['0170 1234567'], emails: [] },
      { external_id: 'b', name: 'Bot', phones: ['0170 9999999'], emails: [] },
      { external_id: 'c', name: 'Cid', phones: ['0170 5555555'], emails: [] },
    ], { region: 'DE', method: 'vcf' });
    expect(r).toEqual({ received: 3, imported: 3, on_platform: 1, already_present: 0 });
    const lookup = calls.find((c) => c.url.includes('/profiles?') && c.url.includes('phone_e164=in.'))!;
    expect(lookup.url).toContain('phone_verified=is.true');
    expect(lookup.url).toContain('discoverable_by_phone=is.true');
    const write = calls.find((c) => c.method === 'POST' && c.url.includes('/contacts?on_conflict='))!;
    const byId = Object.fromEntries(write.body.map((x: any) => [x.external_id, x]));
    expect(byId.a.contact_user_id).toBe('m1');
    expect(byId.b.contact_user_id).toBeNull(); // service account never matches
    expect(byId.a.contact_phone_e164).toEqual(['+491701234567']);
    expect(byId.a.metadata.phones_e164).toEqual(['+491701234567']);
    expect(byId.a.metadata.import_method).toBe('vcf');
  });

  it('never matches the importer to themselves', async () => {
    mockDb({ migrated: true, members: [{ user_id: 'u1', phone_e164: '+491701234567' }] });
    const r = await imp.importContacts('u1', 'android', [{ external_id: 'me', name: 'Me', phones: ['0170 1234567'], emails: [] }]);
    expect(r.on_platform).toBe(0);
  });

  it('before the migration: no phone matches, no unknown column written, import succeeds', async () => {
    const calls = mockDb({ migrated: false });
    const r = await imp.importContacts('u1', 'android', [{ external_id: 'a', name: 'Ana', phones: ['0170 1234567'], emails: [] }]);
    expect(r).toEqual({ received: 1, imported: 1, on_platform: 0, already_present: 0 });
    const write = calls.find((c) => c.method === 'POST' && c.url.includes('/contacts?on_conflict='))!;
    expect(write.body[0]).not.toHaveProperty('contact_phone_e164');
    expect(write.body[0].metadata.phones_e164).toEqual(['+491701234567']);
  });

  it('reports how many contacts were over the cap', async () => {
    mockDb({ migrated: true });
    const many = Array.from({ length: imp.MAX_CONTACTS_PER_IMPORT + 3 }, (_, i) => ({ external_id: `x${i}`, name: `N${i}`, emails: [], phones: [] }));
    const r = await imp.importContacts('u1', 'android', many);
    expect(r.truncated).toBe(3);
  });
});

describe('migration', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../../supabase/migrations/20261010160000_vtid_05057_contacts_phone_matching.sql'), 'utf8');

  it('adds columns without a table rewrite and mirrors verification from auth.users', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS discoverable_by_phone boolean NOT NULL DEFAULT true/);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OF phone, phone_confirmed_at ON auth\.users/);
    expect(sql).toMatch(/NEW\.phone_confirmed_at IS NOT NULL/);
  });

  it('both older phone matchers require a verified, discoverable number and skip test/service accounts', () => {
    const match = sql.slice(sql.indexOf('FUNCTION public.match_existing_contacts'), sql.indexOf('DROP TRIGGER IF EXISTS on_phone_verified'));
    const check = sql.slice(sql.indexOf('FUNCTION public.check_phone_on_platform'));
    for (const body of [match, check]) {
      expect(body).toMatch(/phone_verified/);
      expect(body).toMatch(/discoverable_by_phone/);
      expect(body).toMatch(/service_bot_accounts/);
      expect(body).toMatch(/notification_test_actors/);
      expect(body).not.toMatch(/contact_phone = NEW\.phone|p\.phone = phone_number/);
    }
  });
});

describe('hub + route', () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
    realFetch = global.fetch;
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.dontMock('../src/services/oasis-event-service');
  });

  function recordFetch() {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    global.fetch = jest.fn(async (url: string, init: any = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url: decodeURIComponent(String(url)), body: init.body ? JSON.parse(init.body) : undefined });
      const payload = method === 'GET' ? [] : null;
      return { ok: true, status: 200, text: async () => (payload ? JSON.stringify(payload) : ''), json: async () => payload } as any;
    }) as any;
    return calls;
  }

  it('device import passes the method and reads national numbers in the region hint', async () => {
    const calls = recordFetch();
    const hub = require('../src/services/connected-apps/hub');
    const r = await hub.importDeviceContacts('u1', [{ name: 'Ana', phones: ['0664 1234567'] }], { region: 'de-AT', method: 'native' });
    expect(r.ok).toBe(true);
    const write = calls.find((c) => c.method === 'POST' && c.url.includes('/contacts?on_conflict='))!;
    expect(write.body[0].metadata.phones_e164).toEqual(['+436641234567']);
    expect(write.body[0].metadata.import_method).toBe('native');
  });

  it('an unknown method is recorded as picker', async () => {
    const calls = recordFetch();
    const hub = require('../src/services/connected-apps/hub');
    await hub.importDeviceContacts('u1', [{ name: 'Ana', phones: ['0170 1234567'] }], { method: 'evil' });
    const write = calls.find((c) => c.method === 'POST' && c.url.includes('/contacts?on_conflict='))!;
    expect(write.body[0].metadata.import_method).toBe('picker');
  });

  it('removing phone contacts deletes only this member\'s android rows and records it', async () => {
    const calls = recordFetch();
    const hub = require('../src/services/connected-apps/hub');
    await expect(hub.removeDeviceContacts('u1')).resolves.toEqual({ ok: true });
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('contacts?user_id=eq.u1&source=eq.android');
    const { emitOasisEvent } = require('../src/services/oasis-event-service');
    expect((emitOasisEvent as jest.Mock).mock.calls.map((c: any[]) => c[0].type)).toContain('connected_app.contacts_removed');
  });

  it('the route exposes DELETE /android-contacts before the /:id routes', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/connected-apps.ts'), 'utf8');
    expect(src.indexOf("router.delete('/android-contacts'")).toBeGreaterThan(-1);
    expect(src.indexOf("router.delete('/android-contacts'")).toBeLessThan(src.indexOf("router.post('/:id/connect'"));
  });
});
