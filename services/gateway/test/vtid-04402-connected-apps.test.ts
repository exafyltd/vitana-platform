/**
 * VTID-04402..04405 — Connected Apps: one toggle per mail / calendar /
 * contacts app (Google, Microsoft, Apple iCloud, Android contacts).
 *
 * Pins the catalogue, the on/off state machine, the toggle flows against a
 * scripted PostgREST, the Microsoft provider, the iCloud parsers, contacts
 * import, the assistant gate, the routes and the migration.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(__dirname, '../src');

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

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

describe('catalogue', () => {
  const cat = jest.requireActual('../src/services/connected-apps/catalogue');

  it('lists exactly the ten apps the Connected Apps screen shows', () => {
    expect(cat.CONNECTED_APP_IDS.sort()).toEqual([
      'android-contacts', 'apple-calendar', 'apple-mail', 'gmail', 'google-calendar',
      'google-contacts', 'iphone-contacts', 'outlook-calendar', 'outlook-contacts', 'outlook-mail',
    ]);
    // The latest migration that rewrites the app_id CHECK must allow every id (VTID-04449).
    const mig = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260924100000_vtid_04449_outlook_contacts_app.sql'), 'utf8');
    for (const id of cat.CONNECTED_APP_IDS) expect(mig).toContain(`'${id}'`);
  });

  it('each app asks only for its own scopes', () => {
    expect(cat.getConnectedApp('gmail').scopes.every((s: string) => s.includes('gmail'))).toBe(true);
    expect(cat.getConnectedApp('google-contacts').scopes).toEqual(['https://www.googleapis.com/auth/contacts.readonly']);
    expect(cat.getConnectedApp('outlook-mail').scopes).toEqual(['Mail.Read', 'Mail.Send']);
    expect(cat.scopesToRequest(cat.getConnectedApp('outlook-calendar'))).toEqual(
      expect.arrayContaining(['offline_access', 'User.Read', 'Calendars.ReadWrite']),
    );
  });

  it('scopesCover reads Microsoft scopes with or without the resource prefix, and broader grants', () => {
    expect(cat.scopesCover(['https://graph.microsoft.com/Mail.Read', 'mail.send'], ['Mail.Read', 'Mail.Send'])).toBe(true);
    expect(cat.scopesCover(['Calendars.ReadWrite'], ['Calendars.Read'])).toBe(true);
    expect(cat.scopesCover(['Mail.Read'], ['Mail.Read', 'Mail.Send'])).toBe(false);
    expect(cat.scopesCover(null, ['x'])).toBe(false);
    expect(cat.scopesCover([], [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('computeAppState', () => {
  const hub = jest.requireActual('../src/services/connected-apps/hub');
  const cat = jest.requireActual('../src/services/connected-apps/catalogue');
  const G = 'https://www.googleapis.com/auth/';
  const ready = { google: 'ready', microsoft: 'ready', apple: 'ready', device: 'ready' };
  const base = { connections: [], apple: null, settings: [], availability: ready };
  const state = (id: string, inp: any) => hub.computeAppState(cat.getConnectedApp(id), { ...base, ...inp });

  it('a pre-hub Google token that covers the app counts as on; one that does not stays off', () => {
    const connections = [{ provider: 'google', account: 'a@x.com', scopes: [`${G}contacts.readonly`] }];
    expect(state('google-contacts', { connections }).status).toBe('on');
    expect(state('google-contacts', { connections }).account).toBe('a@x.com');
    expect(state('gmail', { connections }).status).toBe('off');
  });

  it('an explicit toggle wins over the token', () => {
    const connections = [{ provider: 'google', account: 'a', scopes: [`${G}contacts.readonly`] }];
    const settings = [{ app_id: 'google-contacts', enabled: false, last_sync_at: null, last_result: null, last_error: null }];
    expect(state('google-contacts', { connections, settings }).status).toBe('off');
  });

  it('on but the grant is gone or missing a scope → needs_reconnect', () => {
    const settings = [{ app_id: 'outlook-mail', enabled: true, last_sync_at: null, last_result: null, last_error: null }];
    expect(state('outlook-mail', { settings }).status).toBe('needs_reconnect');
    const connections = [{ provider: 'microsoft', account: 'm', scopes: ['Mail.Read'] }];
    expect(state('outlook-mail', { settings, connections }).status).toBe('needs_reconnect');
    const full = [{ provider: 'microsoft', account: 'm', scopes: ['Mail.Read', 'Mail.Send'] }];
    expect(state('outlook-mail', { settings, connections: full }).status).toBe('on');
  });

  it('Apple is on only with stored credentials that last worked', () => {
    const settings = [{ app_id: 'apple-calendar', enabled: true, last_sync_at: null, last_result: null, last_error: null }];
    expect(state('apple-calendar', { settings, apple: { apple_id: 'me@icloud.com', last_error: null } }).status).toBe('on');
    const bad = state('apple-calendar', { settings, apple: { apple_id: 'me@icloud.com', last_error: 'apple_auth_failed' } });
    expect(bad.status).toBe('needs_reconnect');
    expect(bad.last_error).toBe('apple_auth_failed');
  });

  it('an app this stack cannot serve is never on', () => {
    const settings = [{ app_id: 'outlook-calendar', enabled: true, last_sync_at: null, last_result: null, last_error: null }];
    const connections = [{ provider: 'microsoft', account: 'm', scopes: ['Calendars.ReadWrite'] }];
    const s = state('outlook-calendar', { settings, connections, availability: { ...ready, microsoft: 'not_configured' } });
    expect(s.availability).toBe('not_configured');
    expect(s.status).toBe('needs_reconnect');
  });

  it('dueApps: calendars every 15 min, contacts daily, oldest first, capped', () => {
    const now = Date.parse('2026-09-23T12:00:00Z');
    const rows = [
      { user_id: 'u1', app_id: 'outlook-calendar', last_sync_at: '2026-09-23T11:50:00Z' },
      { user_id: 'u2', app_id: 'apple-calendar', last_sync_at: '2026-09-23T11:40:00Z' },
      { user_id: 'u3', app_id: 'google-contacts', last_sync_at: '2026-09-23T01:00:00Z' },
      { user_id: 'u4', app_id: 'iphone-contacts', last_sync_at: '2026-09-22T11:00:00Z' },
      { user_id: 'u5', app_id: 'iphone-contacts', last_sync_at: null },
    ];
    expect(hub.dueApps(rows, now).map((r: any) => r.user_id)).toEqual(['u5', 'u4', 'u2']);
  });
});

// ---------------------------------------------------------------------------
// Toggle flows against a scripted PostgREST
// ---------------------------------------------------------------------------

type Call = { method: string; url: string; body: any };

function scriptDb(tables: Record<string, any[]>) {
  const calls: Call[] = [];
  const fetchMock = jest.fn(async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    const table = String(url).split('/rest/v1/')[1]?.split('?')[0] ?? '';
    const payload = method === 'GET' ? tables[table] ?? [] : null;
    return { ok: true, status: 200, text: async () => (payload ? JSON.stringify(payload) : ''), json: async () => payload } as any;
  });
  return { calls, fetchMock };
}

describe('toggle flows', () => {
  let restore: () => void;
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = global.fetch;
    restore = withEnv({
      SUPABASE_URL: 'https://db.test',
      SUPABASE_SERVICE_ROLE: 'service-role-secret',
      GOOGLE_OAUTH_CLIENT_ID: 'gid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
      MICROSOFT_OAUTH_CLIENT_ID: 'mid',
      MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret',
      MICROSOFT_OAUTH_TENANT: undefined,
      AI_CREDENTIALS_ENC_KEY: 'a'.repeat(64),
      GATEWAY_PUBLIC_URL: 'https://gw.test',
    });
    jest.resetModules();
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
  });
  afterEach(() => {
    global.fetch = realFetch;
    restore();
    jest.dontMock('../src/services/oasis-event-service');
  });

  it('Outlook Mail with no Microsoft grant → consent URL for its scopes, signed state naming the app', async () => {
    const { fetchMock } = scriptDb({ social_connections: [], connected_app_settings: [], apple_account_credentials: [] });
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    const r = await hub.connectApp('u1', 't1', 'outlook-mail');
    expect(r.status).toBe('consent_required');
    const u = new URL(r.auth_url);
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(u.searchParams.get('scope')!.split(' ')).toEqual(
      expect.arrayContaining(['offline_access', 'User.Read', 'Mail.Read', 'Mail.Send']),
    );
    expect(u.searchParams.get('scope')).not.toContain('Calendars');
    expect(u.searchParams.get('redirect_uri')).toBe('https://gw.test/api/v1/social-accounts/callback/microsoft');
    const { verifyOAuthState } = require('../src/lib/oauth-state');
    expect(verifyOAuthState(u.searchParams.get('state'))).toMatchObject({ userId: 'u1', provider: 'microsoft', enableApp: 'outlook-mail' });
  });

  it('a second Google app asks for its scopes plus the ones already on (no app is dropped)', async () => {
    const G = 'https://www.googleapis.com/auth/';
    const { fetchMock } = scriptDb({
      social_connections: [{ provider: 'google', provider_username: 'a@x.com', scopes: [`${G}contacts.readonly`] }],
      connected_app_settings: [{ app_id: 'google-contacts', enabled: true, last_sync_at: null, last_result: null, last_error: null }],
    });
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    const r = await hub.connectApp('u1', 't1', 'gmail');
    const scope = new URL(r.auth_url).searchParams.get('scope')!.split(' ');
    expect(scope).toEqual(expect.arrayContaining([`${G}gmail.readonly`, `${G}gmail.send`, `${G}contacts.readonly`]));
    expect(new URL(r.auth_url).searchParams.get('prompt')).toBeNull(); // incremental
  });

  it('when the token already covers the app, one tap turns it on (no consent)', async () => {
    const { calls, fetchMock } = scriptDb({
      social_connections: [{ provider: 'microsoft', provider_username: 'm@x.com', scopes: ['Mail.Read', 'Mail.Send'] }],
    });
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    const r = await hub.connectApp('u1', 't1', 'outlook-mail');
    expect(r).toEqual({ ok: true, status: 'on' });
    const up = calls.find((c) => c.method === 'POST' && c.url.includes('connected_app_settings'))!;
    expect(up.body).toMatchObject({ user_id: 'u1', app_id: 'outlook-mail', enabled: true });
    const { emitOasisEvent } = require('../src/services/oasis-event-service');
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'connected_app.enabled', actor_id: 'u1', vtid: 'VTID-04402', payload: expect.objectContaining({ app_id: 'outlook-mail' }) }));
  });

  it('an app the stack cannot serve refuses with not_configured', async () => {
    const r2 = withEnv({ MICROSOFT_OAUTH_CLIENT_SECRET: undefined });
    const { fetchMock } = scriptDb({});
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    expect(await hub.connectApp('u1', 't1', 'outlook-calendar')).toMatchObject({ ok: false, error: 'not_configured' });
    r2();
  });

  it('Apple needs an Apple ID + app-specific password before anything is stored', async () => {
    const { calls, fetchMock } = scriptDb({});
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    expect(await hub.connectApp('u1', 't1', 'apple-mail')).toMatchObject({ ok: false, error: 'apple_credentials_required' });
    expect(await hub.connectApp('u1', 't1', 'apple-mail', { appleId: 'nope', appPassword: 'x' })).toMatchObject({ error: 'apple_id_invalid' });
    expect(calls.some((c) => c.url.includes('apple_account_credentials') && c.method === 'POST')).toBe(false);
  });

  it('Apple: a rejected password is reported and nothing is stored; a good one is stored encrypted', async () => {
    const dav = require('../src/services/connected-apps/apple-dav');
    const { calls, fetchMock } = scriptDb({});
    const principal = (href: string) => `<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>${href}</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`;
    let reject = true;
    global.fetch = jest.fn(async (url: string, init: any = {}) => {
      if (String(url).includes('icloud.com')) {
        if (reject) return { ok: false, status: 401, text: async () => '' } as any;
        const body = String(init.body);
        if (body.includes('current-user-principal')) return { ok: true, status: 207, text: async () => principal('/123/principal/') } as any;
        const tag = body.includes('calendar-home-set') ? 'calendar-home-set' : 'addressbook-home-set';
        return { ok: true, status: 207, text: async () => `<multistatus xmlns="DAV:"><response><propstat><prop><x:${tag} xmlns:x="urn"><href>https://p1-${tag}.icloud.com/123/</href></x:${tag}></prop></propstat></response></multistatus>` } as any;
      }
      return fetchMock(url, init);
    }) as any;
    const hub = require('../src/services/connected-apps/hub');
    expect(await hub.connectApp('u1', 't1', 'apple-mail', { appleId: 'me@icloud.com', appPassword: 'abcd-efgh-ijkl-mnop' }))
      .toMatchObject({ ok: false, error: 'apple_auth_failed' });
    expect(calls.some((c) => c.url.includes('apple_account_credentials') && c.method === 'POST')).toBe(false);

    reject = false;
    const r = await hub.connectApp('u1', 't1', 'apple-mail', { appleId: 'me@icloud.com', appPassword: 'abcd-efgh-ijkl-mnop' });
    expect(r).toMatchObject({ ok: true, status: 'on' });
    const saved = calls.find((c) => c.url.includes('apple_account_credentials') && c.method === 'POST')!;
    expect(saved.body.apple_id).toBe('me@icloud.com');
    expect(JSON.stringify(saved.body)).not.toContain('abcdefghijklmnop');
    expect(saved.body.caldav_home_url).toBe('https://p1-calendar-home-set.icloud.com/123/');
    expect(saved.body.secret_ciphertext).toMatch(/^\\x[0-9a-f]+$/);
    expect(dav.AppleAuthError).toBeDefined();
  });

  it('turning off the last Microsoft app releases the grant and clears Outlook busy times', async () => {
    const { calls, fetchMock } = scriptDb({
      social_connections: [{ id: 'sc1', provider: 'microsoft', provider_username: 'm', scopes: ['Calendars.ReadWrite'], refresh_token: 'r' }],
      connected_app_settings: [{ app_id: 'outlook-calendar', enabled: false, last_sync_at: null, last_result: null, last_error: null }],
    });
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    const r = await hub.disconnectApp('u1', 'outlook-calendar');
    expect(r).toEqual({ ok: true, provider_released: true });
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('calendar_external_busy') && c.url.includes('source=eq.microsoft'))).toBe(true);
    const release = calls.find((c) => c.method === 'PATCH' && c.url.includes('social_connections?id=eq.sc1'))!;
    expect(release.body).toMatchObject({ is_active: false, access_token: null, refresh_token: null });
  });

  it('turning off one Google app keeps the grant while another is still on', async () => {
    const G = 'https://www.googleapis.com/auth/';
    const { calls, fetchMock } = scriptDb({
      social_connections: [{ id: 'sc1', provider: 'google', provider_username: 'a', scopes: [`${G}gmail.readonly`, `${G}gmail.send`, `${G}contacts.readonly`] }],
      connected_app_settings: [{ app_id: 'google-contacts', enabled: false, last_sync_at: null, last_result: null, last_error: null }],
    });
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    expect(await hub.disconnectApp('u1', 'google-contacts')).toEqual({ ok: true, provider_released: false });
    expect(calls.some((c) => c.url.includes('oauth2.googleapis.com/revoke'))).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('contacts?'))).toBe(false); // data kept by default
  });

  it('the grant callback turns the app on only when the member granted every scope', async () => {
    const { calls, fetchMock } = scriptDb({ social_connections: [{ provider: 'microsoft', provider_username: 'm', scopes: ['Mail.Read'] }] });
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    expect(await hub.onGrantReturned('u1', 't1', 'outlook-mail')).toEqual({ ok: false });
    const up = calls.filter((c) => c.method === 'POST' && c.url.includes('connected_app_settings')).pop()!;
    expect(up.body).toMatchObject({ enabled: false, last_error: 'permission_not_granted' });
  });

  it('Outlook calendar sync writes busy times only (no titles) and records the result', async () => {
    // Pull only here; the push half (VTID-04436) has its own suite.
    process.env.CONNECTED_APPS_CALENDAR_PUSH = 'false';
    const { calls, fetchMock } = scriptDb({ social_connections: [] });
    global.fetch = jest.fn(async (url: string, init: any = {}) => {
      if (String(url).startsWith('https://graph.microsoft.com')) {
        return {
          ok: true, status: 200,
          json: async () => ({ value: [
            { subject: 'Secret', showAs: 'busy', start: { dateTime: '2026-09-24T09:00:00.0000000' }, end: { dateTime: '2026-09-24T10:00:00.0000000' } },
            { subject: 'Lunch', showAs: 'free', start: { dateTime: '2026-09-24T12:00:00' }, end: { dateTime: '2026-09-24T13:00:00' } },
            { subject: 'Off', isCancelled: true, showAs: 'busy', start: { dateTime: '2026-09-24T14:00:00' }, end: { dateTime: '2026-09-24T15:00:00' } },
          ] }),
        } as any;
      }
      return fetchMock(url, init);
    }) as any;
    jest.doMock('../src/connectors/runtime/dispatcher', () => ({ getConnectorAccessToken: jest.fn(async () => 'ms-token') }));
    const hub = require('../src/services/connected-apps/hub');
    const r = await hub.syncApp('u1', 'outlook-calendar');
    expect(r).toEqual({ ok: true, result: { busy: 1, pushed: 'switched_off' } });
    const ins = calls.find((c) => c.method === 'POST' && c.url.endsWith('/calendar_external_busy'))!;
    expect(ins.body).toEqual([{ user_id: 'u1', source: 'microsoft', start_time: '2026-09-24T09:00:00.000Z', end_time: '2026-09-24T10:00:00.000Z' }]);
    expect(JSON.stringify(ins.body)).not.toContain('Secret');
    jest.dontMock('../src/connectors/runtime/dispatcher');
    delete process.env.CONNECTED_APPS_CALENDAR_PUSH;
  });

  it('assistant gate: Gmail switched off hides Google from email.read', async () => {
    const G = 'https://www.googleapis.com/auth/';
    const { fetchMock } = scriptDb({
      social_connections: [{ provider: 'google', provider_username: 'a', scopes: [`${G}gmail.readonly`, `${G}gmail.send`] }],
      connected_app_settings: [{ app_id: 'gmail', enabled: false, last_sync_at: null, last_result: null, last_error: null }],
    });
    global.fetch = fetchMock as any;
    const hub = require('../src/services/connected-apps/hub');
    const m = await hub.hubConnectorAvailability('u1', 'email.read');
    expect(m.get('google')).toBe(false);
    expect(m.get('microsoft')).toBe(false);
    expect(m.get('apple')).toBe(false);
    expect((await hub.hubConnectorAvailability('u1', 'music.play')).has('google')).toBe(false);
  });

  it('Android: picked contacts are imported, de-duplicated and the app turned on', async () => {
    const { calls, fetchMock } = scriptDb({ profiles: [], service_bot_accounts: [], notification_test_actors: [] });
    global.fetch = fetchMock as any;
    jest.doMock('../src/lib/excluded-test-service-accounts', () => ({ fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set()) }));
    const hub = require('../src/services/connected-apps/hub');
    const r = await hub.importDeviceContacts('u1', [
      { name: ['Ana'], emails: ['ana@x.com'], phones: ['+49 170 1234567'] },
      { name: ['Ana'], emails: ['ana@x.com'], phones: ['+49 170 1234567'] },
      { name: [''], emails: [], phones: [] },
    ]);
    expect(r).toMatchObject({ ok: true, result: { received: 3, imported: 1 } });
    const up = calls.find((c) => c.url.includes('contacts?on_conflict=user_id,source,external_id'))!;
    expect(up.body[0]).toMatchObject({ user_id: 'u1', source: 'android', contact_name: 'Ana', contact_email: 'ana@x.com' });
    // OASIS: the import and the switch-on are recorded with the member as actor.
    const { emitOasisEvent } = require('../src/services/oasis-event-service');
    const types = (emitOasisEvent as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(types).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'connected_app.contacts_imported', actor_id: 'u1', vtid: 'VTID-04402', payload: expect.objectContaining({ app_id: 'android-contacts' }) }),
    ]));
    expect(await hub.importDeviceContacts('u1', [])).toMatchObject({ ok: false, error: 'no_contacts' });
    jest.dontMock('../src/lib/excluded-test-service-accounts');
  });
});

// ---------------------------------------------------------------------------
// Contacts import
// ---------------------------------------------------------------------------

describe('contacts import', () => {
  const ci = jest.requireActual('../src/services/connected-apps/contacts-import');

  it('normalizes: trims, drops invalid e-mails and short phones, needs a name or a way to reach them', () => {
    expect(ci.normalizeContact({ external_id: 'x', name: '  Ana   B ', emails: ['ANA@X.COM', 'bad'], phones: ['12'] }))
      .toEqual({ external_id: 'x', name: 'Ana B', emails: ['ana@x.com'], phones: [] });
    expect(ci.normalizeContact({ external_id: 'x', name: '', emails: ['a@b.co'] })!.name).toBe('a@b.co');
    expect(ci.normalizeContact({ external_id: 'x', name: '' })).toBeNull();
    expect(ci.normalizeContact({ external_id: '', name: 'A' })).toBeNull();
  });

  it('device ids are stable and order-independent', () => {
    const a = ci.deviceContactId({ name: 'Ana', emails: ['b@x.com', 'a@x.com'], phones: ['+1 (555) 123'] });
    const b = ci.deviceContactId({ name: ' ana ', emails: ['A@x.com', 'b@x.com'], phones: ['+15551 23'] });
    expect(a).toBe(b);
    expect(ci.deviceContactId({ name: 'Bob' })).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Microsoft provider + connector
// ---------------------------------------------------------------------------

describe('microsoft', () => {
  it('Graph local times are read as UTC', () => {
    const { asUtcIso } = jest.requireActual('../src/connectors/productivity/microsoft');
    expect(asUtcIso('2026-09-24T09:00:00.0000000')).toBe('2026-09-24T09:00:00.000Z');
    expect(asUtcIso('2026-09-24T09:00:00+02:00')).toBe('2026-09-24T07:00:00.000Z');
    expect(asUtcIso('')).toBeNull();
  });

  it('refresh stores the rotated refresh token', async () => {
    const restore = withEnv({ MICROSOFT_OAUTH_CLIENT_ID: 'mid', MICROSOFT_OAUTH_CLIENT_SECRET: 'ms', MICROSOFT_OAUTH_TENANT: 'contoso.onmicrosoft.com' });
    const realFetch = global.fetch;
    const seen: string[] = [];
    global.fetch = jest.fn(async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600, scope: 'Mail.Read' }) } as any;
    }) as any;
    const c = jest.requireActual('../src/connectors/productivity/microsoft').default;
    const t = await c.refreshToken('old-rt');
    expect(t).toMatchObject({ access_token: 'new-at', refresh_token: 'new-rt', scopes_granted: ['Mail.Read'] });
    expect(seen[0]).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token');
    global.fetch = realFetch;
    restore();
  });

  it('email.read maps Outlook messages; a missing scope names the app to turn on', async () => {
    const realFetch = global.fetch;
    let status = 200;
    global.fetch = jest.fn(async () => ({
      ok: status === 200,
      status,
      json: async () => (status === 200
        ? { value: [{ id: 'm1', from: { emailAddress: { name: 'Ana', address: 'ana@x.com' } }, subject: 'Hi', receivedDateTime: '2026-09-23T10:00:00Z', bodyPreview: 'hello' }] }
        : { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }),
    })) as any;
    const c = jest.requireActual('../src/connectors/productivity/microsoft').default;
    const ok = await c.performAction({ tenant_id: 't', user_id: 'u' }, { access_token: 'x' }, { capability: 'email.read', args: {} });
    expect(ok.raw.messages[0]).toMatchObject({ from: 'Ana <ana@x.com>', subject: 'Hi', snippet: 'hello' });
    status = 403;
    const denied = await c.performAction({ tenant_id: 't', user_id: 'u' }, { access_token: 'x' }, { capability: 'email.read', args: {} });
    expect(denied).toMatchObject({ ok: false, error: 'insufficient_scope', raw: { reconnect_app: 'outlook-mail' } });
    global.fetch = realFetch;
  });

  it('the token exchange keeps the scopes the provider granted, and Microsoft profiles normalize', async () => {
    const restore = withEnv({ MICROSOFT_OAUTH_CLIENT_ID: 'mid', MICROSOFT_OAUTH_CLIENT_SECRET: 'ms', GATEWAY_PUBLIC_URL: 'https://gw.test' });
    const realFetch = global.fetch;
    const posted: any[] = [];
    global.fetch = jest.fn(async (url: string, init: any = {}) => {
      if (String(url).includes('/token')) {
        posted.push({ url, body: String(init.body) });
        return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'Mail.Read Mail.Send openid' }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ id: 'ms1', displayName: 'Ana', userPrincipalName: 'ana@contoso.com' }) } as any;
    }) as any;
    jest.resetModules();
    const svc = require('../src/services/social-connect-service');
    const t = await svc.exchangeCodeForTokens('microsoft', 'code');
    expect(t.scopes_granted).toEqual(['Mail.Read', 'Mail.Send', 'openid']);
    expect(posted[0].url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(posted[0].body).toContain('redirect_uri=https%3A%2F%2Fgw.test%2Fapi%2Fv1%2Fsocial-accounts%2Fcallback%2Fmicrosoft');
    const p = await svc.fetchSocialProfile('microsoft', 'at');
    expect(p).toMatchObject({ provider_user_id: 'ms1', username: 'ana@contoso.com', display_name: 'Ana' });
    expect(svc.isProviderConfigured('microsoft')).toBe(true);
    global.fetch = realFetch;
    restore();
  });
});

// ---------------------------------------------------------------------------
// iCloud parsers
// ---------------------------------------------------------------------------

describe('iCloud parsing', () => {
  const dav = jest.requireActual('../src/services/connected-apps/apple-dav');

  it('reads DAV multistatus with any namespace prefix', () => {
    const xml = '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar xmlns:C="x"/></D:resourcetype></D:prop></D:propstat></D:response>' +
      '<response><href>/b/</href></response></D:multistatus>';
    const rs = dav.responses(xml);
    expect(rs).toHaveLength(2);
    expect(dav.xmlFirst(rs[0], 'href')).toBe('/a/');
    expect(dav.xmlHas(dav.xmlFirst(rs[0], 'resourcetype'), 'calendar')).toBe(true);
    expect(dav.absolute('https://p1.icloud.com/123/', '/456/cal/')).toBe('https://p1.icloud.com/456/cal/');
    expect(dav.xmlUnescape('a &amp;lt; &lt;b&gt; <![CDATA[x&y]]>')).toBe('a &lt; <b> x&y');
  });

  it('parses VEVENTs: times, all-day, duration, transparent and cancelled', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'UID:1', 'SUMMARY:Dentist\\, early', 'DTSTART:20260924T080000Z', 'DTEND:20260924T090000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:2', 'DTSTART;VALUE=DATE:20260925', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:3', 'DTSTART;TZID=Europe/Berlin:20260926T100000', 'DURATION:PT1H30M', 'TRANSP:TRANSPARENT', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:4', 'DTSTART:20260927T100000Z', 'DTEND:20260927T110000Z', 'STATUS:CANCELLED', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:5', 'DTSTART:20260928T100000Z', 'DTEND:20260928T11', ' 0000Z', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const ev = dav.parseIcsEvents(ics);
    expect(ev.map((e: any) => e.uid)).toEqual(['1', '2', '3', '4', '5']);
    expect(ev[0]).toMatchObject({ summary: 'Dentist, early', start: '2026-09-24T08:00:00.000Z', end: '2026-09-24T09:00:00.000Z' });
    expect(ev[1]).toMatchObject({ allDay: true, end: '2026-09-26T00:00:00.000Z' });
    expect(ev[2]).toMatchObject({ transparent: true, end: '2026-09-26T11:30:00.000Z' });
    expect(ev[4].end).toBe('2026-09-28T11:00:00.000Z'); // folded line
    expect(dav.busyFromEvents(ev).map((b: any) => b.start_time)).toEqual(['2026-09-24T08:00:00.000Z', '2026-09-28T10:00:00.000Z']);
    expect(dav.parseDuration('P1W')).toBe(7 * 86_400_000);
    expect(dav.parseDuration('-PT15M')).toBe(-900_000);
  });

  it('parses vCards: FN, N fallback, grouped EMAIL/TEL', () => {
    const v = [
      'BEGIN:VCARD', 'VERSION:3.0', 'UID:abc', 'FN:Ana Novak', 'item1.EMAIL;type=INTERNET:Ana@X.com', 'TEL;type=CELL:+49 170 111', 'END:VCARD',
      'BEGIN:VCARD', 'UID:def', 'N:Petrović;Marko;;;', 'TEL:tel:+381 60 222', 'END:VCARD',
    ].join('\r\n');
    expect(dav.parseVCards(v)).toEqual([
      { uid: 'abc', name: 'Ana Novak', emails: ['ana@x.com'], phones: ['+49 170 111'] },
      { uid: 'def', name: 'Marko Petrović', emails: [], phones: ['+381 60 222'] },
    ]);
  });

  it('IMAP: decodes RFC 2047 headers and parses FETCH header literals', () => {
    expect(dav.decodeMimeWords('=?UTF-8?B?w5xiZXJ3ZWlzdW5n?= fertig')).toBe('Überweisung fertig');
    expect(dav.decodeMimeWords('=?iso-8859-1?Q?Gr=FC=DFe_aus?=')).toBe('Grüße aus');
    const h1 = 'From: Ana <ana@x.com>\r\nSubject: Hi\r\n there\r\nDate: Tue, 22 Sep 2026 10:00:00 +0000\r\n\r\n';
    const raw = `* 1 FETCH (UID 41 BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(h1)}}\r\n${h1})\r\nV3 OK done\r\n`;
    expect(dav.parseHeaderBlocks(Buffer.from(raw, 'utf8').toString('binary'))).toEqual([
      { uid: 41, from: 'Ana <ana@x.com>', subject: 'Hi there', date: 'Tue, 22 Sep 2026 10:00:00 +0000' },
    ]);
    expect(dav.imapQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

// ---------------------------------------------------------------------------
// Wiring (route handlers are in test/routes/connected-apps.test.ts)
// ---------------------------------------------------------------------------

describe('wiring', () => {
  it('is mounted, its loop starts at boot, and the resolver consults the toggles', () => {
    const idx = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
    expect(idx).toContain("'/api/v1/connected-apps'");
    expect(idx).toContain('startConnectedAppsLoop()');
    expect(fs.readFileSync(path.join(SRC, 'capabilities/index.ts'), 'utf8')).toContain('hubConnectorAvailability(userId, capabilityId)');
    const refresher = fs.readFileSync(path.join(SRC, 'services/oauth-token-refresher.ts'), 'utf8');
    expect(refresher).toContain('provider=in.(google,youtube,microsoft)');
  });
});

describe('migration', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260923200000_vtid_04402_connected_apps.sql'), 'utf8');

  it('new tables are service-role only; microsoft/apple busy sources and the contacts upsert key exist', () => {
    for (const t of ['connected_app_settings', 'apple_account_credentials']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM anon, authenticated`));
      expect(sql).not.toMatch(new RegExp(`CREATE POLICY[^;]*${t}`));
    }
    expect(sql).toContain("'microsoft'");
    expect(sql).toContain("CHECK (source IN ('google','microsoft','apple'))");
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS contacts_user_source_external_uidx\s+ON public\.contacts \(user_id, source, external_id\);/);
    expect(sql).toContain('secret_ciphertext bytea NOT NULL');
  });
});
