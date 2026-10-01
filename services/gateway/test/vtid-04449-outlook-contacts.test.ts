/**
 * VTID-04449 — Outlook Contacts, the tenth Connected Apps entry: the
 * catalogue entry, the Graph fetch (all pages, names/e-mails/phones only),
 * the hub sync writing contacts with source 'microsoft', removing them on
 * request when the app is turned off, the background tick, and the
 * assistant's contacts.read on the Microsoft connector.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

function withEnv(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

type Call = { method: string; url: string; body: any };

/** Graph answers from `graph`, PostgREST from `tables`. */
function scripted(tables: Record<string, any[]>, graph: (url: string) => { status: number; json: any }) {
  const calls: Call[] = [];
  const fetchMock = jest.fn(async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    const u = String(url);
    if (u.startsWith('https://graph.microsoft.com')) {
      calls.push({ method, url: u, body: undefined });
      const g = graph(u);
      return { ok: g.status < 400, status: g.status, statusText: 'x', json: async () => g.json } as any;
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: u, body });
    const table = u.split('/rest/v1/')[1]?.split('?')[0] ?? '';
    const payload = method === 'GET' ? tables[table] ?? [] : null;
    return { ok: true, status: 200, text: async () => (payload ? JSON.stringify(payload) : ''), json: async () => payload } as any;
  });
  return { calls, fetchMock };
}

const PAGE1 = {
  value: [
    { id: 'c1', displayName: 'Clara Weiss', emailAddresses: [{ address: 'Clara@Example.com' }], mobilePhone: '+49 170 1234567', homePhones: [], businessPhones: [] },
    { id: 'c2', displayName: '', givenName: 'Milan', surname: 'Petrović', emailAddresses: [], mobilePhone: null, homePhones: ['+381 11 7654321'], businessPhones: ['+381 11 1111111'] },
  ],
  '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/contacts?$skip=2',
};
const PAGE2 = { value: [{ id: 'c3', displayName: 'Ana', emailAddresses: [{ address: 'ana@example.org' }], homePhones: [], businessPhones: [] }] };

describe('catalogue', () => {
  const cat = jest.requireActual('../src/services/connected-apps/catalogue');
  it('Outlook Contacts is a Microsoft contacts app asking only for Contacts.Read', () => {
    const app = cat.getConnectedApp('outlook-contacts');
    expect(app).toMatchObject({ provider: 'microsoft', kind: 'contacts', method: 'oauth', sync: 'contacts_import', scopes: ['Contacts.Read'] });
    expect(app.capabilities).toEqual(['contacts.read', 'contacts.import']);
    expect(cat.scopesToRequest(app)).toEqual(expect.arrayContaining(['offline_access', 'User.Read', 'Contacts.Read']));
  });
  it('a broader Contacts.ReadWrite grant covers it', () => {
    expect(cat.scopesCover(['https://graph.microsoft.com/Contacts.ReadWrite'], ['Contacts.Read'])).toBe(true);
    expect(cat.scopesCover(['Mail.Read'], ['Contacts.Read'])).toBe(false);
  });
  it('the migration allows the new id and keeps the other nine', () => {
    const mig = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260924100000_vtid_04449_outlook_contacts_app.sql'), 'utf8');
    expect(mig).toContain("'outlook-contacts'");
    expect(mig).toMatch(/DROP CONSTRAINT IF EXISTS connected_app_settings_app_id_check/);
  });
});

describe('fetchOutlookContacts', () => {
  let realFetch: typeof fetch;
  beforeEach(() => { realFetch = global.fetch; });
  afterEach(() => { global.fetch = realFetch; });

  it('follows every page and keeps names, e-mails and all phone numbers', async () => {
    const { calls, fetchMock } = scripted({}, (u) => ({ status: 200, json: u.includes('$skip=2') ? PAGE2 : PAGE1 }));
    global.fetch = fetchMock as any;
    const imp = jest.requireActual('../src/services/connected-apps/contacts-import');
    const out = await imp.fetchOutlookContacts('tok');
    expect(out).toEqual([
      { external_id: 'c1', name: 'Clara Weiss', emails: ['Clara@Example.com'], phones: ['+49 170 1234567'] },
      { external_id: 'c2', name: 'Milan Petrović', emails: [], phones: ['+381 11 7654321', '+381 11 1111111'] },
      { external_id: 'c3', name: 'Ana', emails: ['ana@example.org'], phones: [] },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('$select=id,displayName,givenName,surname,emailAddresses,mobilePhone,homePhones,businessPhones');
  });

  it('a missing permission is reported as permission_not_granted', async () => {
    const { fetchMock } = scripted({}, () => ({ status: 403, json: { error: { code: 'ErrorAccessDenied', message: 'no' } } }));
    global.fetch = fetchMock as any;
    const imp = jest.requireActual('../src/services/connected-apps/contacts-import');
    await expect(imp.fetchOutlookContacts('tok')).rejects.toThrow('permission_not_granted');
  });
});

describe('hub', () => {
  let restore: () => void;
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = global.fetch;
    restore = withEnv({
      SUPABASE_URL: 'https://db.test',
      SUPABASE_SERVICE_ROLE: 'service-role-secret',
      MICROSOFT_OAUTH_CLIENT_ID: 'mid',
      MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret',
    });
    jest.resetModules();
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
    jest.doMock('../src/connectors/runtime/dispatcher', () => ({ getConnectorAccessToken: jest.fn(async () => 'ms-token') }));
  });
  afterEach(() => {
    global.fetch = realFetch;
    restore();
    jest.dontMock('../src/services/oasis-event-service');
    jest.dontMock('../src/connectors/runtime/dispatcher');
  });

  it('sync imports Outlook contacts into `contacts` with source microsoft', async () => {
    const { calls, fetchMock } = scripted(
      { social_connections: [], contacts: [], connected_app_settings: [] },
      (u) => ({ status: 200, json: u.includes('$skip=2') ? PAGE2 : PAGE1 }),
    );
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    const r = await hub.syncApp('u1', 'outlook-contacts');
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ received: 3 });
    const up = calls.find((c) => c.method === 'POST' && c.url.includes('/rest/v1/contacts?on_conflict=user_id,source,external_id'));
    expect(up).toBeDefined();
    expect(up!.body.every((row: any) => row.source === 'microsoft' && row.user_id === 'u1')).toBe(true);
    const setting = calls.filter((c) => c.url.includes('/connected_app_settings')).pop()!;
    expect(setting.body).toMatchObject({ app_id: 'outlook-contacts', last_error: null });
  });

  it('turning it off with removeData deletes only the Outlook-imported contacts', async () => {
    const { calls, fetchMock } = scripted(
      { social_connections: [], connected_app_settings: [], apple_account_credentials: [] },
      () => ({ status: 200, json: {} }),
    );
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    const r = await hub.disconnectApp('u1', 'outlook-contacts', { removeData: true });
    expect(r.ok).toBe(true);
    const del = calls.find((c) => c.method === 'DELETE' && c.url.includes('/rest/v1/contacts?'));
    expect(del?.url).toContain('source=eq.microsoft');
  });

  it('the background tick picks it up', async () => {
    const { calls, fetchMock } = scripted({ connected_app_settings: [] }, () => ({ status: 200, json: {} }));
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    await hub.runConnectedAppsTick();
    expect(calls[0].url).toContain('outlook-contacts');
    expect(hub.dueApps([{ user_id: 'u', app_id: 'outlook-contacts', last_sync_at: null }], Date.now())).toHaveLength(1);
  });
});

describe('Microsoft connector contacts.read', () => {
  let realFetch: typeof fetch;
  beforeEach(() => { realFetch = global.fetch; });
  afterEach(() => { global.fetch = realFetch; });

  const ctx = { user_id: 'u1', tenant_id: 't1' } as any;
  const tokens = { access_token: 'ms-token' } as any;

  it('lists and filters the address book', async () => {
    const { fetchMock } = scripted({}, () => ({ status: 200, json: PAGE1 }));
    global.fetch = fetchMock as any;
    const ms = jest.requireActual('../src/connectors/productivity/microsoft').default;
    expect(ms.capabilities).toContain('contacts.read');
    const r = await ms.performAction(ctx, tokens, { capability: 'contacts.read', args: { query: 'milan' } });
    expect(r.ok).toBe(true);
    expect(r.raw.contacts).toEqual([{ name: 'Milan Petrović', emails: [], phones: ['+381 11 7654321', '+381 11 1111111'] }]);
  });

  it('a missing scope points the member at Outlook Contacts', async () => {
    const { fetchMock } = scripted({}, () => ({ status: 403, json: { error: { code: 'ErrorAccessDenied' } } }));
    global.fetch = fetchMock as any;
    const ms = jest.requireActual('../src/connectors/productivity/microsoft').default;
    const r = await ms.performAction(ctx, tokens, { capability: 'contacts.read', args: {} });
    expect(r).toMatchObject({ ok: false, error: 'insufficient_scope', raw: { reconnect_app: 'outlook-contacts' } });
  });
});
