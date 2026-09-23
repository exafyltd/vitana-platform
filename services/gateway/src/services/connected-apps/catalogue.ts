/**
 * VTID-04402: the mail / calendar / contacts apps on the Connected Apps
 * screen (ten since VTID-04449 added Outlook Contacts), as one catalogue.
 * The app renders from this (via GET /api/v1/connected-apps), so an app is
 * never shown with a Connect button the backend cannot honour.
 *
 * Three ways to connect:
 *   oauth         — Google or Microsoft consent screen; one token per
 *                   provider, each app asks only for its own scopes.
 *   app_password  — Apple: iCloud has no OAuth for mail, calendar or
 *                   contacts. The member signs in once with an Apple ID +
 *                   app-specific password, shared by the three Apple apps.
 *   device        — Android contacts come from the phone itself (the
 *                   browser Contact Picker); nothing is stored at a provider.
 */

export type AppKind = 'mail' | 'calendar' | 'contacts';
export type ConnectMethod = 'oauth' | 'app_password' | 'device';
export type AppProvider = 'google' | 'microsoft' | 'apple' | 'device';

export interface ConnectedAppDef {
  id: string;
  provider: AppProvider;
  kind: AppKind;
  method: ConnectMethod;
  /** Scopes this app needs on the provider's token (oauth apps only). */
  scopes: string[];
  /** Capabilities the assistant can use once this app is on. */
  capabilities: string[];
  /** What a sync does, if the app syncs at all. */
  sync: 'contacts_import' | 'calendar_busy' | 'calendar_two_way' | null;
}

const G = 'https://www.googleapis.com/auth/';

export const CONNECTED_APPS: ConnectedAppDef[] = [
  {
    id: 'gmail',
    provider: 'google',
    kind: 'mail',
    method: 'oauth',
    scopes: [`${G}gmail.readonly`, `${G}gmail.send`],
    capabilities: ['email.read', 'email.send'],
    sync: null,
  },
  {
    id: 'google-calendar',
    provider: 'google',
    kind: 'calendar',
    method: 'oauth',
    // calendar.app.created + freebusy drive the VTID-04372 two-way sync;
    // calendar.events lets the assistant read and add events.
    scopes: [`${G}calendar.app.created`, `${G}calendar.freebusy`, `${G}calendar.events`],
    capabilities: ['calendar.list', 'calendar.create'],
    sync: 'calendar_two_way',
  },
  {
    id: 'google-contacts',
    provider: 'google',
    kind: 'contacts',
    method: 'oauth',
    scopes: [`${G}contacts.readonly`],
    capabilities: ['contacts.read', 'contacts.import'],
    sync: 'contacts_import',
  },
  {
    id: 'outlook-mail',
    provider: 'microsoft',
    kind: 'mail',
    method: 'oauth',
    scopes: ['Mail.Read', 'Mail.Send'],
    capabilities: ['email.read', 'email.send'],
    sync: null,
  },
  {
    id: 'outlook-calendar',
    provider: 'microsoft',
    kind: 'calendar',
    method: 'oauth',
    scopes: ['Calendars.ReadWrite'],
    capabilities: ['calendar.list', 'calendar.create'],
    sync: 'calendar_busy',
  },
  {
    // VTID-04449: Outlook / Microsoft 365 address book, imported the same way
    // as Google and iPhone contacts.
    id: 'outlook-contacts',
    provider: 'microsoft',
    kind: 'contacts',
    method: 'oauth',
    scopes: ['Contacts.Read'],
    capabilities: ['contacts.read', 'contacts.import'],
    sync: 'contacts_import',
  },
  {
    id: 'apple-mail',
    provider: 'apple',
    kind: 'mail',
    method: 'app_password',
    scopes: [],
    capabilities: ['email.read', 'email.send'],
    sync: null,
  },
  {
    id: 'apple-calendar',
    provider: 'apple',
    kind: 'calendar',
    method: 'app_password',
    scopes: [],
    capabilities: ['calendar.list'],
    sync: 'calendar_busy',
  },
  {
    id: 'iphone-contacts',
    provider: 'apple',
    kind: 'contacts',
    method: 'app_password',
    scopes: [],
    capabilities: ['contacts.read', 'contacts.import'],
    sync: 'contacts_import',
  },
  {
    id: 'android-contacts',
    provider: 'device',
    kind: 'contacts',
    method: 'device',
    scopes: [],
    capabilities: [],
    sync: null,
  },
];

export const CONNECTED_APP_IDS = CONNECTED_APPS.map((a) => a.id);

export function getConnectedApp(id: string): ConnectedAppDef | undefined {
  return CONNECTED_APPS.find((a) => a.id === id);
}

export function appsForProvider(provider: AppProvider): ConnectedAppDef[] {
  return CONNECTED_APPS.filter((a) => a.provider === provider);
}

/** Microsoft scopes come back without the resource prefix or with it; compare loosely. */
function normalizeScope(s: string): string {
  return s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase();
}

/** Does a token's granted scope list cover everything this app needs? */
export function scopesCover(granted: string[] | null | undefined, needed: string[]): boolean {
  if (needed.length === 0) return true;
  const have = new Set((granted ?? []).map(normalizeScope));
  return needed.every((n) => {
    const want = normalizeScope(n);
    if (have.has(want)) return true;
    // A broader Microsoft grant covers the narrower one.
    if (want === 'calendars.read' && have.has('calendars.readwrite')) return true;
    if (want === 'mail.read' && have.has('mail.readwrite')) return true;
    if (want === 'contacts.read' && have.has('contacts.readwrite')) return true;
    return false;
  });
}

/** Scopes to request when switching an oauth app on: the provider's base plus the app's own. */
export function scopesToRequest(app: ConnectedAppDef): string[] {
  if (app.provider === 'google') return ['openid', 'email', 'profile', ...app.scopes];
  if (app.provider === 'microsoft') {
    return ['openid', 'email', 'profile', 'offline_access', 'User.Read', ...app.scopes];
  }
  return [];
}
