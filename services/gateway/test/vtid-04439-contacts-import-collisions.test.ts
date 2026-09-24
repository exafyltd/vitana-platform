/**
 * VTID-04439 — the contacts import must never fail a whole batch on the two
 * older unique indexes of `contacts` (unique_user_phone, unique_user_contact).
 * Before, a phone shared by two Google contacts, by Google and iCloud, or by a
 * contact the member added by hand made the upsert fail, and with it the sync.
 */
const imp = jest.requireActual('../src/services/connected-apps/contacts-import');

const row = (source: string, external_id: string, phone: string | null, member: string | null = null) => ({
  source, external_id, contact_phone: phone, contact_user_id: member, contact_name: external_id, is_on_platform: !!member,
});

describe('resolveCollisions', () => {
  it('skips a contact whose phone a hand-added contact already has', () => {
    const r = imp.resolveCollisions([row('google', 'g1', '+49 170 1'), row('google', 'g2', '+49 170 2')],
      [{ source: null, external_id: null, contact_phone: '+49 170 1', contact_user_id: null }]);
    expect(r.keep.map((x: any) => x.external_id)).toEqual(['g2']);
    expect(r.skipped).toBe(1);
  });

  it('two contacts in one import with the same phone: the first stays, the second is skipped', () => {
    const r = imp.resolveCollisions([row('google', 'mom', '+381 11 1'), row('google', 'dad', '+381 11 1')], []);
    expect(r.keep.map((x: any) => x.external_id)).toEqual(['mom']);
  });

  it('the same member reached from another source is not added twice', () => {
    const r = imp.resolveCollisions([row('icloud', 'i1', null, 'member-a')],
      [{ source: 'google', external_id: 'g9', contact_phone: null, contact_user_id: 'member-a' }]);
    expect(r).toEqual({ keep: [], skipped: 1 });
  });

  it('a contact re-synced from its own source keeps its phone and member', () => {
    const mine = row('google', 'g1', '+1 555', 'member-b');
    const r = imp.resolveCollisions([mine],
      [{ source: 'google', external_id: 'g1', contact_phone: '+1 555', contact_user_id: 'member-b' }]);
    expect(r).toEqual({ keep: [mine], skipped: 0 });
  });

  it('contacts without phone or member never clash', () => {
    const r = imp.resolveCollisions([row('android', 'a1', null), row('android', 'a2', null)], []);
    expect(r.skipped).toBe(0);
  });
});

describe('importContacts', () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = global.fetch;
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
  });
  afterEach(() => { global.fetch = realFetch; });

  it('writes only the rows that cannot clash, and reports the rest as already present', async () => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    global.fetch = jest.fn(async (url: string, init: any = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      const table = String(url).split('/rest/v1/')[1]?.split('?')[0];
      const payload = method !== 'GET' ? null
        : table === 'contacts' ? [{ source: null, external_id: null, contact_phone: '+49 170 1', contact_user_id: null }]
        : [];
      return { ok: true, status: 200, text: async () => (payload ? JSON.stringify(payload) : ''), json: async () => payload } as any;
    }) as any;
    const r = await imp.importContacts('u1', 'google', [
      { external_id: 'g1', name: 'Ana', phones: ['+49 170 1'], emails: [] },
      { external_id: 'g2', name: 'Bo', phones: ['+49 170 2'], emails: [] },
    ]);
    expect(r).toEqual({ received: 2, imported: 1, on_platform: 0, already_present: 1 });
    const read = calls.find((c) => c.method === 'GET' && c.url.includes('/contacts?'))!;
    expect(read.url).toContain('user_id=eq.u1');
    const write = calls.find((c) => c.method === 'POST' && c.url.includes('/contacts?on_conflict=user_id,source,external_id'))!;
    expect(write.body.map((x: any) => x.external_id)).toEqual(['g2']);
  });
});
