/**
 * VTID-04402: Connected Apps hub — one on/off toggle per mail / calendar /
 * contacts app, the way assistants connect external apps: tap once, grant
 * access on the provider's own screen if needed, and the app is on.
 *
 *   listApps()        what the screen renders: availability, on/off, account,
 *                     last sync, and whether a reconnect is needed.
 *   connectApp()      turn an app on. OAuth apps return a consent URL when
 *                     the provider token does not cover the app yet; Apple
 *                     takes an Apple ID + app-specific password; Android is
 *                     on immediately (contacts come from the phone).
 *   onGrantReturned() the OAuth callback finishing a toggle's consent.
 *   disconnectApp()   turn it off; when the provider's last app goes off,
 *                     the provider access is released too.
 *   syncApp()         run the app's sync now (contacts import, busy times,
 *                     two-way calendar for Google, Outlook and iCloud).
 *
 * Tokens stay where they already live (social_connections for Google and
 * Microsoft, apple_account_credentials for Apple). connected_app_settings
 * holds only the toggle and the last sync result.
 */

import { emitOasisEvent } from '../oasis-event-service';
import {
  CONNECTED_APPS,
  appsForProvider,
  getConnectedApp,
  scopesCover,
  scopesToRequest,
  type AppProvider,
  type ConnectedAppDef,
} from './catalogue';
import { db, dbConfigured, enc } from './db';

const LOG = '[connected-apps]';
const VTID = 'VTID-04402';

// ---------------------------------------------------------------------------
// State (pure)
// ---------------------------------------------------------------------------

export interface ProviderConnection {
  provider: 'google' | 'microsoft';
  account: string | null;
  scopes: string[];
}

export interface AppSettingRow {
  app_id: string;
  enabled: boolean;
  last_sync_at: string | null;
  last_result: Record<string, unknown> | null;
  last_error: string | null;
}

export interface AppleSummary {
  apple_id: string;
  last_error: string | null;
}

export type AppAvailability = 'ready' | 'not_configured';
export type AppStatus = 'off' | 'on' | 'needs_reconnect';

export interface AppState {
  id: string;
  provider: AppProvider;
  kind: ConnectedAppDef['kind'];
  method: ConnectedAppDef['method'];
  availability: AppAvailability;
  status: AppStatus;
  account: string | null;
  syncs: boolean;
  last_sync_at: string | null;
  last_result: Record<string, unknown> | null;
  last_error: string | null;
}

export interface HubInputs {
  connections: ProviderConnection[];
  apple: AppleSummary | null;
  settings: AppSettingRow[];
  availability: Record<AppProvider, AppAvailability>;
}

/**
 * On/off for one app. An explicit toggle row wins. Without one (members who
 * connected Google before the hub), a Google token that already covers the
 * app counts as on, so nothing they had working switches itself off.
 */
export function computeAppState(app: ConnectedAppDef, inp: HubInputs): AppState {
  const setting = inp.settings.find((s) => s.app_id === app.id) ?? null;
  const availability = inp.availability[app.provider];
  let credentialOk = false;
  let account: string | null = null;
  let credentialError: string | null = null;

  if (app.method === 'oauth') {
    const conn = inp.connections.find((c) => c.provider === app.provider);
    account = conn?.account ?? null;
    credentialOk = !!conn && scopesCover(conn.scopes, app.scopes);
  } else if (app.method === 'app_password') {
    account = inp.apple?.apple_id ?? null;
    credentialOk = !!inp.apple && !inp.apple.last_error;
    credentialError = inp.apple?.last_error ?? null;
  } else {
    credentialOk = true;
  }

  const wantsOn = setting ? setting.enabled : app.provider === 'google' && credentialOk;
  let status: AppStatus = 'off';
  if (wantsOn) status = credentialOk && availability === 'ready' ? 'on' : 'needs_reconnect';

  return {
    id: app.id,
    provider: app.provider,
    kind: app.kind,
    method: app.method,
    availability,
    status,
    account,
    syncs: app.sync !== null || app.id === 'android-contacts',
    last_sync_at: setting?.last_sync_at ?? null,
    last_result: setting?.last_result ?? null,
    last_error: setting?.last_error ?? credentialError,
  };
}

// ---------------------------------------------------------------------------
// Availability (what this stack can offer)
// ---------------------------------------------------------------------------

export async function providerAvailability(env: NodeJS.ProcessEnv = process.env): Promise<Record<AppProvider, AppAvailability>> {
  const { isProviderConfigured } = await import('../social-connect-service');
  const { appleStorageAvailable } = await import('./apple-store');
  return {
    google: isProviderConfigured('google', env) ? 'ready' : 'not_configured',
    microsoft: isProviderConfigured('microsoft', env) ? 'ready' : 'not_configured',
    // Apple needs nothing registered — only somewhere safe to keep the password.
    apple: appleStorageAvailable() && env.CONNECTED_APPS_APPLE_ENABLED !== 'false' ? 'ready' : 'not_configured',
    device: 'ready',
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadConnections(userId: string): Promise<ProviderConnection[]> {
  const rows = (await db(
    `social_connections?select=provider,provider_username,display_name,scopes,is_active` +
      `&user_id=eq.${enc(userId)}&provider=in.(google,microsoft)&is_active=eq.true`,
  )) as Array<{ provider: 'google' | 'microsoft'; provider_username: string | null; display_name: string | null; scopes: string[] | null }>;
  return (rows ?? []).map((r) => ({
    provider: r.provider,
    account: r.provider_username || r.display_name || null,
    scopes: r.scopes ?? [],
  }));
}

async function loadSettings(userId: string): Promise<AppSettingRow[]> {
  return ((await db(
    `connected_app_settings?select=app_id,enabled,last_sync_at,last_result,last_error&user_id=eq.${enc(userId)}`,
  )) ?? []) as AppSettingRow[];
}

async function loadInputs(userId: string): Promise<HubInputs> {
  const { appleAccountSummary } = await import('./apple-store');
  const [connections, settings, apple, availability] = await Promise.all([
    loadConnections(userId),
    loadSettings(userId),
    appleAccountSummary(userId).catch(() => null),
    providerAvailability(),
  ]);
  return { connections, settings, apple, availability };
}

export async function listApps(userId: string): Promise<AppState[]> {
  const inp = await loadInputs(userId);
  return CONNECTED_APPS.map((a) => computeAppState(a, inp));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function upsertSetting(userId: string, appId: string, patch: Partial<AppSettingRow>): Promise<void> {
  await db('connected_app_settings?on_conflict=user_id,app_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, app_id: appId, ...patch, updated_at: new Date().toISOString() }),
  });
}

function emit(type: string, status: 'info' | 'success' | 'warning' | 'error', userId: string, appId: string, extra: Record<string, unknown> = {}): void {
  void emitOasisEvent({
    vtid: VTID,
    type: type as any,
    source: 'connected-apps',
    status,
    message: `${appId}: ${type.split('.').pop()}`,
    actor_id: userId,
    payload: { app_id: appId, ...extra },
  } as any).catch(() => undefined);
}

export type ConnectResult =
  | { ok: true; status: 'on'; sync?: SyncOutcome }
  | { ok: true; status: 'consent_required'; auth_url: string }
  | { ok: false; error: string; status?: number };

export interface ConnectOptions {
  returnMode?: 'web' | 'mobile';
  appleId?: string;
  appPassword?: string;
}

export async function connectApp(
  userId: string,
  tenantId: string,
  appId: string,
  opts: ConnectOptions = {},
): Promise<ConnectResult> {
  const app = getConnectedApp(appId);
  if (!app) return { ok: false, error: 'unknown_app', status: 404 };
  if (!dbConfigured()) return { ok: false, error: 'service_unavailable', status: 503 };
  const inp = await loadInputs(userId);
  if (inp.availability[app.provider] !== 'ready') return { ok: false, error: 'not_configured', status: 409 };

  if (app.method === 'oauth') {
    const provider = app.provider as 'google' | 'microsoft';
    const conn = inp.connections.find((c) => c.provider === provider);
    if (conn && scopesCover(conn.scopes, app.scopes)) {
      return turnOn(userId, app);
    }
    // Ask for this app's scopes plus those of the provider's other apps that
    // are on, so a new consent never drops an app the member already has.
    const others = appsForProvider(app.provider).filter(
      (a) => a.id !== app.id && computeAppState(a, inp).status === 'on',
    );
    const scopes = Array.from(new Set([app, ...others].flatMap(scopesToRequest)));
    const { getOAuthUrl } = await import('../social-connect-service');
    const { url, error } = getOAuthUrl(provider, userId, tenantId, {
      returnMode: opts.returnMode ?? 'web',
      scopesOverride: scopes,
      enableApp: app.id,
      mode: conn ? 'incremental' : 'full',
    });
    if (error || !url) return { ok: false, error: error ?? 'oauth_unavailable', status: 400 };
    return { ok: true, status: 'consent_required', auth_url: url };
  }

  if (app.method === 'app_password') {
    if (!inp.apple || inp.apple.last_error) {
      const appleId = (opts.appleId ?? '').trim();
      const password = (opts.appPassword ?? '').replace(/\s+/g, '');
      if (!appleId || !password) return { ok: false, error: 'apple_credentials_required', status: 400 };
      if (!/.+@.+/.test(appleId)) return { ok: false, error: 'apple_id_invalid', status: 400 };
      const { discoverApple, AppleAuthError } = await import('./apple-dav');
      const { saveAppleCredentials } = await import('./apple-store');
      try {
        const homes = await discoverApple({ appleId, password });
        await saveAppleCredentials(userId, tenantId, { appleId, password }, homes);
      } catch (err: unknown) {
        if (err instanceof AppleAuthError) return { ok: false, error: 'apple_auth_failed', status: 401 };
        console.warn(`${LOG} apple sign-in failed: ${err instanceof Error ? err.message : err}`);
        return { ok: false, error: 'apple_unreachable', status: 502 };
      }
    }
    return turnOn(userId, app);
  }

  return turnOn(userId, app);
}

async function turnOn(userId: string, app: ConnectedAppDef): Promise<ConnectResult> {
  await upsertSetting(userId, app.id, { enabled: true, last_error: null });
  emit('connected_app.enabled', 'success', userId, app.id);
  const sync = app.sync ? await syncApp(userId, app.id) : undefined;
  return { ok: true, status: 'on', ...(sync ? { sync } : {}) };
}

/** The OAuth callback after a toggle's consent: switch the app on, sync in the background. */
export async function onGrantReturned(userId: string, _tenantId: string, appId: string): Promise<{ ok: boolean }> {
  const app = getConnectedApp(appId);
  if (!app || app.method !== 'oauth') return { ok: false };
  const conns = await loadConnections(userId);
  const conn = conns.find((c) => c.provider === app.provider);
  if (!conn || !scopesCover(conn.scopes, app.scopes)) {
    // The member unticked a permission on the consent screen.
    await upsertSetting(userId, app.id, { enabled: false, last_error: 'permission_not_granted' });
    emit('connected_app.consent_incomplete', 'warning', userId, app.id);
    return { ok: false };
  }
  await upsertSetting(userId, app.id, { enabled: true, last_error: null });
  emit('connected_app.enabled', 'success', userId, app.id, { via: 'oauth_callback' });
  if (app.sync) {
    void syncApp(userId, app.id).catch((err) => console.warn(`${LOG} first sync of ${app.id} failed: ${err?.message}`));
  }
  return { ok: true };
}

export interface DisconnectOptions {
  /** Also delete contacts this app imported. Default: keep them. */
  removeData?: boolean;
}

export async function disconnectApp(
  userId: string,
  appId: string,
  opts: DisconnectOptions = {},
): Promise<{ ok: true; provider_released: boolean } | { ok: false; error: string; status?: number }> {
  const app = getConnectedApp(appId);
  if (!app) return { ok: false, error: 'unknown_app', status: 404 };
  if (!dbConfigured()) return { ok: false, error: 'service_unavailable', status: 503 };

  await upsertSetting(userId, app.id, { enabled: false });

  // What the app left in Vitanaland.
  if (app.id === 'google-calendar') {
    const { disableGoogleSync } = await import('../calendar-google-sync');
    await disableGoogleSync(userId).catch(() => undefined);
  }
  if (app.id === 'outlook-calendar' || app.id === 'apple-calendar') {
    const provider = app.id === 'outlook-calendar' ? 'microsoft' : 'apple';
    await clearBusy(userId, provider);
    // The Vitanaland calendar stays in their account; we just stop writing to it.
    const { forgetPush } = await import('./calendar-push');
    await forgetPush(userId, provider);
  }
  if (opts.removeData && app.kind === 'contacts') {
    const { removeImportedContacts } = await import('./contacts-import');
    const source = app.provider === 'google' ? 'google' : app.provider === 'apple' ? 'icloud' : 'android';
    await removeImportedContacts(userId, source);
  }

  // Release the provider when its last app is off.
  let released = false;
  if (app.provider !== 'device') {
    const inp = await loadInputs(userId);
    const stillOn = appsForProvider(app.provider).some((a) => computeAppState(a, inp).status !== 'off');
    if (!stillOn) {
      released = await releaseProvider(userId, app.provider);
      // Pre-hub Google grants count as on without a row; pin the siblings off
      // so a released provider does not reappear as "on" on reconnect.
      for (const sib of appsForProvider(app.provider)) {
        if (!inp.settings.some((s) => s.app_id === sib.id)) await upsertSetting(userId, sib.id, { enabled: false });
      }
    }
  }
  emit('connected_app.disabled', 'info', userId, app.id, { provider_released: released, removed_data: !!opts.removeData });
  return { ok: true, provider_released: released };
}

async function releaseProvider(userId: string, provider: AppProvider): Promise<boolean> {
  try {
    if (provider === 'apple') {
      const { deleteAppleCredentials } = await import('./apple-store');
      await deleteAppleCredentials(userId);
      return true;
    }
    if (provider === 'google' || provider === 'microsoft') {
      const rows = (await db(
        `social_connections?select=id,refresh_token,access_token&user_id=eq.${enc(userId)}&provider=eq.${provider}&is_active=eq.true&limit=1`,
      )) as Array<{ id: string; refresh_token: string | null; access_token: string | null }>;
      const row = rows?.[0];
      if (!row) return false;
      if (provider === 'google') {
        // Revoking the refresh token withdraws the grant at Google too.
        const token = row.refresh_token || row.access_token;
        if (token) {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${enc(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          }).catch(() => undefined);
        }
      }
      // Microsoft has no token revocation endpoint for this flow; dropping the
      // tokens ends our access, and the member can remove the app at
      // account.microsoft.com → Privacy → Apps and services.
      await db(`social_connections?id=eq.${enc(row.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          is_active: false,
          access_token: null,
          refresh_token: null,
          disconnected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
      return true;
    }
  } catch (err: unknown) {
    console.warn(`${LOG} releasing ${provider} failed: ${err instanceof Error ? err.message : err}`);
  }
  return false;
}

async function clearBusy(userId: string, source: 'microsoft' | 'apple'): Promise<void> {
  await db(`calendar_external_busy?user_id=eq.${enc(userId)}&source=eq.${source}`, { method: 'DELETE' }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

/** Busy intervals are replaced wholesale for the source; times only, never titles. */
async function replaceBusy(
  userId: string,
  source: 'microsoft' | 'apple',
  busy: Array<{ start_time: string; end_time: string }>,
): Promise<void> {
  await clearBusy(userId, source);
  const rows = busy.slice(0, 1000).map((b) => ({ user_id: userId, source, start_time: b.start_time, end_time: b.end_time }));
  if (rows.length) {
    await db('calendar_external_busy', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
  }
}

const BUSY_HORIZON_MS = 30 * 86_400_000;

async function providerToken(userId: string, connectorId: 'google' | 'microsoft'): Promise<string | null> {
  const { createClient } = await import('@supabase/supabase-js');
  const { getConnectorAccessToken } = await import('../../connectors/runtime/dispatcher');
  return getConnectorAccessToken(
    createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE as string) as any,
    userId,
    connectorId,
    [connectorId],
  );
}

/** What a calendar push did, for last_result (the screen shows it). */
function pushSummary(p: { created: number; updated: number; deleted: number; skipped: number } | null): Record<string, unknown> {
  if (!p) return { pushed: 'switched_off' };
  return { created: p.created, updated: p.updated, deleted: p.deleted, ...(p.skipped ? { skipped: p.skipped } : {}) };
}

async function runSync(userId: string, app: ConnectedAppDef): Promise<Record<string, unknown>> {
  const now = Date.now();
  switch (app.id) {
    case 'google-contacts': {
      const token = await providerToken(userId, 'google');
      if (!token) throw new Error('not_connected');
      const { fetchGoogleContacts, importContacts } = await import('./contacts-import');
      const r = await importContacts(userId, 'google', await fetchGoogleContacts(token));
      return { ...r };
    }
    case 'google-calendar': {
      const g = await import('../calendar-google-sync');
      if (g.googleSyncAvailability() !== 'ready') return { two_way_sync: 'switched_off' };
      const en = await g.enableGoogleSync(userId);
      if (!en.ok) throw new Error(en.error);
      const r = await g.syncUser(en.state, now);
      if (!r.ok) throw new Error(r.error ?? 'google_sync_failed');
      return { created: r.created, updated: r.updated, deleted: r.deleted, busy: r.busy };
    }
    case 'outlook-calendar': {
      const token = await providerToken(userId, 'microsoft');
      if (!token) throw new Error('not_connected');
      // VTID-04436: push Vitanaland entries into a "Vitanaland" Outlook
      // calendar first, then pull busy times from every other one.
      const push = await import('./calendar-push');
      let pushed: Awaited<ReturnType<typeof push.pushOutlook>> | null = null;
      if (push.calendarPushEnabled()) pushed = await push.pushOutlook(userId, token, now);
      const { listOutlookBusy } = await import('../../connectors/productivity/microsoft');
      const r = await listOutlookBusy(token, new Date(now).toISOString(), new Date(now + BUSY_HORIZON_MS).toISOString(), pushed?.pushed_ids);
      if (!r.ok) throw new Error(r.status === 403 ? 'permission_not_granted' : r.error);
      await replaceBusy(userId, 'microsoft', r.busy);
      return { busy: r.busy.length, ...pushSummary(pushed) };
    }
    case 'apple-calendar':
    case 'iphone-contacts': {
      const { loadAppleCredentials, markAppleError } = await import('./apple-store');
      const creds = await loadAppleCredentials(userId);
      if (!creds) throw new Error('not_connected');
      const dav = await import('./apple-dav');
      try {
        if (app.id === 'apple-calendar') {
          if (!creds.caldavHome) throw new Error('no_calendar_home');
          // VTID-04436: entries go into a "Vitanaland" iCloud calendar (the
          // iPhone Calendar app shows it); the busy pull skips that one.
          const push = await import('./calendar-push');
          let pushed: Awaited<ReturnType<typeof push.pushApple>> | null = null;
          if (push.calendarPushEnabled()) pushed = await push.pushApple(userId, creds.credentials, creds.caldavHome, now);
          const events = await dav.listAppleEvents(
            creds.credentials,
            creds.caldavHome,
            new Date(now).toISOString(),
            new Date(now + BUSY_HORIZON_MS).toISOString(),
            pushed ? [pushed.calendar] : [],
          );
          const busy = dav.busyFromEvents(events);
          await replaceBusy(userId, 'apple', busy);
          return { busy: busy.length, ...pushSummary(pushed) };
        }
        if (!creds.carddavHome) throw new Error('no_contacts_home');
        const { importContacts } = await import('./contacts-import');
        const cards = await dav.listAppleContacts(creds.credentials, creds.carddavHome);
        const r = await importContacts(userId, 'icloud', cards.map((c) => ({ external_id: c.uid, name: c.name, emails: c.emails, phones: c.phones })));
        return { ...r };
      } catch (err) {
        if (err instanceof dav.AppleAuthError) {
          await markAppleError(userId, 'apple_auth_failed').catch(() => undefined);
          throw new Error('apple_auth_failed');
        }
        throw err;
      }
    }
    default:
      return {};
  }
}

export async function syncApp(userId: string, appId: string): Promise<SyncOutcome> {
  const app = getConnectedApp(appId);
  if (!app) return { ok: false, error: 'unknown_app' };
  if (!app.sync) return { ok: true, result: {} };
  const at = new Date().toISOString();
  try {
    const result = await runSync(userId, app);
    await upsertSetting(userId, app.id, { last_sync_at: at, last_result: result, last_error: null });
    return { ok: true, result };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    await upsertSetting(userId, app.id, { last_sync_at: at, last_error: error.slice(0, 300) }).catch(() => undefined);
    emit('connected_app.sync_failed', 'warning', userId, app.id, { error: error.slice(0, 300) });
    return { ok: false, error };
  }
}

/** Android: contacts the member picked on their phone (browser Contact Picker). */
export async function importDeviceContacts(
  userId: string,
  contacts: Array<{ name?: unknown; emails?: unknown; phones?: unknown }>,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string; status?: number }> {
  if (!Array.isArray(contacts) || contacts.length === 0) return { ok: false, error: 'no_contacts', status: 400 };
  const { deviceContactId, importContacts, MAX_CONTACTS_PER_IMPORT } = await import('./contacts-import');
  if (contacts.length > MAX_CONTACTS_PER_IMPORT) return { ok: false, error: 'too_many_contacts', status: 413 };
  const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? '')).filter(Boolean) : []);
  const shaped = contacts.map((c) => {
    const name = Array.isArray(c.name) ? String(c.name[0] ?? '') : String(c.name ?? '');
    const emails = asList(c.emails);
    const phones = asList(c.phones);
    return { external_id: deviceContactId({ name, emails, phones }), name, emails, phones };
  });
  const result = await importContacts(userId, 'android', shaped);
  const at = new Date().toISOString();
  await upsertSetting(userId, 'android-contacts', { enabled: true, last_sync_at: at, last_result: { ...result }, last_error: null });
  emit('connected_app.contacts_imported', 'success', userId, 'android-contacts', { imported: result.imported });
  return { ok: true, result: { ...result } };
}

// ---------------------------------------------------------------------------
// Assistant: which connectors are usable for a capability
// ---------------------------------------------------------------------------

/**
 * For the capability resolver: per connector id (google / microsoft /
 * apple), whether the member has an app of that provider switched on that
 * serves this capability. Connectors not listed fall back to the resolver's
 * own token check.
 */
export async function hubConnectorAvailability(userId: string, capabilityId: string): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (!dbConfigured()) return out;
  const inp = await loadInputs(userId);
  for (const provider of ['google', 'microsoft', 'apple'] as const) {
    const apps = appsForProvider(provider).filter((a) => a.capabilities.includes(capabilityId));
    if (apps.length === 0) continue;
    out.set(provider, apps.some((a) => computeAppState(a, inp).status === 'on'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Background sync
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const CALENDAR_EVERY_MS = 15 * MINUTE;
const CONTACTS_EVERY_MS = 24 * 60 * MINUTE;
const MAX_PER_TICK = 50;

/** Which enabled apps are due, oldest first. Google Calendar has its own loop. */
export function dueApps(
  rows: Array<{ user_id: string; app_id: string; last_sync_at: string | null }>,
  now: number,
): Array<{ user_id: string; app_id: string }> {
  return rows
    .filter((r) => {
      const every = r.app_id.endsWith('-calendar') ? CALENDAR_EVERY_MS : CONTACTS_EVERY_MS;
      return !r.last_sync_at || now - new Date(r.last_sync_at).getTime() >= every;
    })
    .sort((a, b) => String(a.last_sync_at ?? '').localeCompare(String(b.last_sync_at ?? '')))
    .slice(0, MAX_PER_TICK)
    .map(({ user_id, app_id }) => ({ user_id, app_id }));
}

export async function runConnectedAppsTick(now: number = Date.now()): Promise<{ synced: number; failed: number }> {
  if (!dbConfigured()) return { synced: 0, failed: 0 };
  const rows = (await db(
    `connected_app_settings?select=user_id,app_id,last_sync_at&enabled=eq.true` +
      `&app_id=in.(outlook-calendar,apple-calendar,google-contacts,iphone-contacts)&order=last_sync_at.asc.nullsfirst&limit=500`,
  )) as Array<{ user_id: string; app_id: string; last_sync_at: string | null }>;
  let synced = 0;
  let failed = 0;
  for (const r of dueApps(rows ?? [], now)) {
    const out = await syncApp(r.user_id, r.app_id);
    if (out.ok) synced += 1; else failed += 1;
  }
  return { synced, failed };
}

let loopStarted = false;

/** Every 5 minutes; each app decides whether it is due. Off with CONNECTED_APPS_SYNC_LOOP=false. */
export function startConnectedAppsLoop(): boolean {
  if (loopStarted || process.env.CONNECTED_APPS_SYNC_LOOP === 'false' || !dbConfigured()) return false;
  loopStarted = true;
  const tick = () => {
    runConnectedAppsTick()
      .then((r) => { if (r.synced || r.failed) console.log(`${LOG} tick synced=${r.synced} failed=${r.failed}`); })
      .catch((err) => console.warn(`${LOG} tick failed: ${err?.message}`));
  };
  const t = setInterval(tick, 5 * MINUTE);
  (t as any).unref?.();
  setTimeout(tick, 60_000).unref?.();
  return true;
}
