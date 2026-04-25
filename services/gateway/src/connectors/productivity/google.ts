/**
 * VTID-01939: Google connector — productivity capability pack.
 *
 * One connector for every Google service: Gmail (read/send), Calendar
 * (list/create), People/Contacts (read/import), YouTube / YouTube Music
 * (search + playback hand-off). A single OAuth consent covers all of them.
 *
 * Why productivity rather than social: Google as exposed here is
 * data-access, not profile enrichment. Profile-scraping YouTube still lives
 * as `youtube` provider in social-connect-service.ts.
 *
 * Env vars:
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 */

import type {
  ActionRequest,
  ActionResult,
  Connector,
  ConnectorContext,
  NormalizedProfile,
  OAuthConfig,
  OAuthExchangeResult,
  TokenPair,
} from '../types';
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshOAuth2Token } from '../runtime/oauth2';

const OAUTH_CONFIG: OAuthConfig = {
  authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_url: 'https://oauth2.googleapis.com/token',
  scopes: [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],
  client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
  client_secret_env: 'GOOGLE_OAUTH_CLIENT_SECRET',
  // offline + consent guarantees a refresh_token is returned on every consent.
  extra_authorize_params: {
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  },
};

function googleCreds(): { id: string; secret: string } | null {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { id, secret };
}

async function googleGet(url: string, token: string): Promise<{ ok: boolean; status: number; json: any; errorMessage?: string }> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  let json: any = null;
  try { json = await resp.json(); } catch { /* non-JSON — leave null */ }
  if (!resp.ok) {
    const errorMessage = json?.error?.message ?? resp.statusText ?? `HTTP ${resp.status}`;
    return { ok: false, status: resp.status, json, errorMessage };
  }
  return { ok: true, status: resp.status, json };
}

/**
 * Phase 4: detect insufficient-scope failures so the dispatcher can
 * surface a structured error to the frontend (with a reconnect URL the
 * UI can show as a "Grant access" button) instead of a generic 403.
 *
 * Google's response shape on missing scope:
 *   {
 *     "error": {
 *       "code": 403,
 *       "message": "Request had insufficient authentication scopes.",
 *       "status": "PERMISSION_DENIED",
 *       "details": [{ "reason": "ACCESS_TOKEN_SCOPE_INSUFFICIENT", ... }]
 *     }
 *   }
 */
function isInsufficientScope(r: { ok: boolean; status: number; json: any }): boolean {
  if (r.ok) return false;
  if (r.status !== 403) return false;
  const message: string = String(r.json?.error?.message ?? '').toLowerCase();
  if (message.includes('insufficient') && message.includes('scope')) return true;
  const details: any[] = r.json?.error?.details ?? [];
  return details.some((d) => String(d?.reason ?? '').toLowerCase() === 'access_token_scope_insufficient');
}

/**
 * Per-capability scope requirements + the unified-flow sub-services to
 * request when the user re-consents. Used by the insufficient-scope error
 * path to build a `reconnect_url`.
 */
const CAPABILITY_RECONNECT: Record<string, { needed: string[]; include: string[] }> = {
  'music.play': { needed: ['youtube.readonly'], include: ['youtube'] },
  'email.read': { needed: ['gmail.readonly'], include: ['gmail'] },
  'email.send': { needed: ['gmail.send'], include: ['gmail'] },
  'calendar.list': { needed: ['calendar.readonly'], include: ['calendar'] },
  'calendar.create': { needed: ['calendar.events'], include: ['calendar'] },
  'contacts.read': { needed: ['contacts.readonly'], include: ['contacts'] },
  'contacts.import': { needed: ['contacts.readonly'], include: ['contacts'] },
};

function insufficientScopeResult(capability: string): ActionResult {
  const cap = CAPABILITY_RECONNECT[capability] ?? { needed: [], include: ['gmail', 'calendar', 'contacts'] };
  const reconnectUrl = `/api/v1/social-accounts/connect/google?include=${encodeURIComponent(cap.include.join(','))}&mode=incremental`;
  return {
    ok: false,
    error: 'insufficient_scope',
    raw: {
      capability,
      needed_scopes: cap.needed,
      reconnect_url: reconnectUrl,
      message:
        cap.needed.length > 0
          ? `${capability} needs the ${cap.needed.join(', ')} permission(s) — re-connect Google to grant them.`
          : `${capability} needs an additional Google permission. Please re-connect Google.`,
    },
  };
}

type YouTubeHit = { videoId: string; title: string; channel: string; thumbnail?: string };
type YouTubeSearchResult =
  | { ok: true; hit: YouTubeHit | null }
  | { ok: false; insufficientScope: boolean; error: string };

/** YouTube search → first video hit. Used by the music.play capability. */
async function youtubeSearchFirst(query: string, token: string): Promise<YouTubeSearchResult> {
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  u.searchParams.set('part', 'snippet');
  u.searchParams.set('type', 'video');
  u.searchParams.set('maxResults', '1');
  u.searchParams.set('q', query);
  // videoCategoryId=10 is Music — bias results toward music videos.
  u.searchParams.set('videoCategoryId', '10');
  const r = await googleGet(u.toString(), token);
  if (!r.ok) {
    return {
      ok: false,
      insufficientScope: isInsufficientScope(r),
      error: r.errorMessage ?? 'YouTube search failed',
    };
  }
  const item = r.json?.items?.[0];
  if (!item?.id?.videoId) return { ok: true, hit: null };
  return {
    ok: true,
    hit: {
      videoId: item.id.videoId,
      title: item.snippet?.title ?? query,
      channel: item.snippet?.channelTitle ?? '',
      thumbnail: item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url,
    },
  };
}

const googleConnector: Connector = {
  id: 'google',
  category: 'productivity',
  display_name: 'Google',
  auth_type: 'oauth2',
  // Capabilities are the voice-agent-facing verbs. Runtime (performAction)
  // must handle each id listed here.
  capabilities: [
    'music.play',        // YouTube/YouTube Music playback via URL hand-off
    'email.read',        // Gmail list/read
    'email.send',        // Gmail send
    'calendar.list',     // Calendar list events
    'calendar.create',   // Calendar add event
    'contacts.read',     // People API list
    'contacts.import',   // People API → Vitana user_contacts
  ],
  oauth: OAUTH_CONFIG,

  async initialize(): Promise<void> {
    if (!googleCreds()) {
      console.warn('[google] GOOGLE_OAUTH_CLIENT_ID/SECRET not set — connector registered but inactive');
    } else {
      console.log('[google] connector ready');
    }
  },

  getOAuthUrl(state: string, redirect_uri: string): string {
    const creds = googleCreds();
    if (!creds) throw new Error('GOOGLE_OAUTH_CLIENT_ID not configured');
    return buildAuthorizeUrl(OAUTH_CONFIG, creds.id, redirect_uri, state);
  },

  async exchangeCode(code: string, redirect_uri: string): Promise<OAuthExchangeResult> {
    const creds = googleCreds();
    if (!creds) throw new Error('GOOGLE_OAUTH_CLIENT_ID not configured');
    const tokens = await exchangeCodeForTokens({
      config: OAUTH_CONFIG,
      code,
      client_id: creds.id,
      client_secret: creds.secret,
      redirect_uri,
    });
    const userinfo = await googleGet('https://openidconnect.googleapis.com/v1/userinfo', tokens.access_token);
    const profile = userinfo.ok && googleConnector.normalizeProfile
      ? googleConnector.normalizeProfile(userinfo.json)
      : undefined;
    return { tokens, provider_user_id: profile?.provider_user_id, profile };
  },

  async refreshToken(refresh_token: string): Promise<TokenPair> {
    const creds = googleCreds();
    if (!creds) throw new Error('GOOGLE_OAUTH_CLIENT_ID not configured');
    return refreshOAuth2Token({
      config: OAUTH_CONFIG,
      refresh_token,
      client_id: creds.id,
      client_secret: creds.secret,
    });
  },

  normalizeProfile(raw: Record<string, unknown>): NormalizedProfile {
    const r = raw as { sub?: string; email?: string; name?: string; picture?: string; locale?: string };
    return {
      provider_user_id: r.sub ?? '',
      provider_username: r.email ?? '',
      display_name: r.name ?? r.email ?? '',
      avatar_url: r.picture ?? '',
      raw,
    };
  },

  /**
   * Phase-3 surface: capability execution. Today implements music.play;
   * email.read, calendar.list etc. follow the same shape.
   */
  async performAction(
    _ctx: ConnectorContext,
    tokens: TokenPair,
    action: ActionRequest,
  ): Promise<ActionResult> {
    const token = tokens.access_token;
    switch (action.capability) {
      case 'music.play': {
        const query = String(action.args?.query ?? '').trim();
        if (!query) return { ok: false, error: 'music.play: "query" arg is required' };
        const search = await youtubeSearchFirst(query, token);
        if (!search.ok) {
          if (search.insufficientScope) return insufficientScopeResult('music.play');
          return { ok: false, error: `YouTube search failed: ${search.error}` };
        }
        const hit = search.hit;
        if (!hit) return { ok: false, error: `No YouTube result found for "${query}"` };

        // Three URL variants so the widget picks the right one per platform.
        // Key insight: a mobile WebView (Appilix, Chrome Custom Tab, etc.)
        // will happily *load* https://music.youtube.com inside itself,
        // covering Vitana with a raw web player that isn't signed in. An
        // intent:// URL with the YouTube Music package forces Android to
        // hand off to the native app — already signed in with Premium.
        const params = new URLSearchParams({ v: hit.videoId });
        if (_ctx.provider_username) params.set('authuser', _ctx.provider_username);
        const webUrl = `https://music.youtube.com/watch?${params.toString()}`;
        const androidIntent =
          `intent://music.youtube.com/watch?v=${encodeURIComponent(hit.videoId)}` +
          `#Intent;scheme=https;package=com.google.android.apps.youtube.music;` +
          `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
        // youtubemusic:// is the iOS URL scheme the YouTube Music app
        // registers — triggers the native app if installed.
        const iosScheme = `youtubemusic://watch?v=${encodeURIComponent(hit.videoId)}`;

        return {
          ok: true,
          external_id: hit.videoId,
          url: webUrl,
          raw: {
            action: 'open_url',
            url: webUrl,
            android_intent: androidIntent,
            ios_scheme: iosScheme,
            title: hit.title,
            channel: hit.channel,
            thumbnail: hit.thumbnail,
            source: 'youtube_music',
            query,
            authuser: _ctx.provider_username ?? null,
          },
        };
      }

      // VTID-01943: Gmail read. Returns the N most recent unread messages
      // (or messages matching a from: filter) as a compact list the voice
      // layer can read back.
      case 'email.read': {
        const limit = Math.max(1, Math.min(25, Number(action.args?.limit ?? 5) || 5));
        const from = typeof action.args?.from === 'string' ? (action.args.from as string).trim() : '';
        const unreadOnly = action.args?.unread_only !== false;

        const qParts: string[] = [];
        if (unreadOnly) qParts.push('is:unread');
        if (from) qParts.push(`from:${from}`);
        const gmailQ = qParts.join(' ');

        const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
        listUrl.searchParams.set('maxResults', String(limit));
        if (gmailQ) listUrl.searchParams.set('q', gmailQ);

        const listR = await googleGet(listUrl.toString(), token);
        if (isInsufficientScope(listR)) return insufficientScopeResult('email.read');
        if (!listR.ok) return { ok: false, error: `Gmail list failed: ${listR.errorMessage}` };

        const ids: Array<{ id: string }> = listR.json?.messages ?? [];
        if (ids.length === 0) {
          return {
            ok: true,
            raw: {
              action: 'structured_list',
              messages: [],
              query: gmailQ,
              summary: unreadOnly
                ? (from ? `No unread emails from ${from}.` : 'No unread emails.')
                : 'No emails matched.',
            },
          };
        }

        // Parallel-fetch headers. Field mask keeps responses tiny + within
        // the 3-second TOOL_TIMEOUT_MS budget.
        const details = await Promise.all(
          ids.slice(0, limit).map(async (m): Promise<any> => {
            const u = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
            const r = await googleGet(u, token);
            if (!r.ok) return null;
            const headers: Array<{ name: string; value: string }> = r.json?.payload?.headers ?? [];
            const h = (name: string) => headers.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value;
            return {
              id: m.id,
              from: h('From') ?? '',
              subject: h('Subject') ?? '(no subject)',
              date: h('Date') ?? '',
              snippet: r.json?.snippet ?? '',
            };
          }),
        );
        const messages = details.filter(Boolean);

        return {
          ok: true,
          raw: {
            action: 'structured_list',
            messages,
            query: gmailQ,
            summary: `${messages.length} ${unreadOnly ? 'unread ' : ''}email${messages.length === 1 ? '' : 's'}${from ? ' from ' + from : ''}.`,
          },
        };
      }

      // VTID-01943: Calendar list — upcoming events in primary calendar.
      case 'calendar.list': {
        const daysAhead = Math.max(1, Math.min(60, Number(action.args?.days_ahead ?? 7) || 7));
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + daysAhead * 24 * 3600 * 1000).toISOString();

        const u = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
        u.searchParams.set('timeMin', timeMin);
        u.searchParams.set('timeMax', timeMax);
        u.searchParams.set('maxResults', '20');
        u.searchParams.set('singleEvents', 'true');
        u.searchParams.set('orderBy', 'startTime');
        const r = await googleGet(u.toString(), token);
        if (isInsufficientScope(r)) return insufficientScopeResult('calendar.list');
        if (!r.ok) return { ok: false, error: `Calendar list failed: ${r.errorMessage}` };

        const events = (r.json?.items ?? []).map((ev: any) => ({
          id: ev.id,
          summary: ev.summary ?? '(no title)',
          start: ev.start?.dateTime ?? ev.start?.date,
          end: ev.end?.dateTime ?? ev.end?.date,
          location: ev.location ?? '',
          all_day: Boolean(ev.start?.date && !ev.start?.dateTime),
          html_link: ev.htmlLink ?? '',
        }));

        return {
          ok: true,
          raw: {
            action: 'structured_list',
            events,
            days_ahead: daysAhead,
            summary: events.length === 0
              ? `No events in the next ${daysAhead} day${daysAhead === 1 ? '' : 's'}.`
              : `${events.length} event${events.length === 1 ? '' : 's'} in the next ${daysAhead} day${daysAhead === 1 ? '' : 's'}.`,
          },
        };
      }

      // VTID-01943: Calendar create — adds an event to the primary calendar.
      case 'calendar.create': {
        const summary = String(action.args?.title ?? '').trim();
        const start = String(action.args?.start ?? '').trim();
        const end = String(action.args?.end ?? '').trim();
        const description = typeof action.args?.description === 'string' ? (action.args.description as string) : undefined;
        const attendees = Array.isArray(action.args?.attendees) ? (action.args.attendees as string[]) : [];
        if (!summary) return { ok: false, error: 'calendar.create: "title" is required' };
        if (!start) return { ok: false, error: 'calendar.create: "start" is required (RFC3339)' };

        let endFinal = end;
        if (!endFinal) {
          const s = new Date(start);
          if (Number.isNaN(s.getTime())) return { ok: false, error: 'calendar.create: "start" is not a valid date' };
          endFinal = new Date(s.getTime() + 60 * 60 * 1000).toISOString();
        }

        const body: Record<string, unknown> = {
          summary,
          start: { dateTime: start },
          end: { dateTime: endFinal },
        };
        if (description) body.description = description;
        if (attendees.length) body.attendees = attendees.map((email) => ({ email }));

        const resp = await fetch(
          'https://www.googleapis.com/calendar/v3/calendars/primary/events',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          },
        );
        const json: any = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          if (isInsufficientScope({ ok: false, status: resp.status, json })) {
            return insufficientScopeResult('calendar.create');
          }
          return { ok: false, error: json?.error?.message ?? resp.statusText };
        }
        return {
          ok: true,
          external_id: json.id,
          url: json.htmlLink,
          raw: {
            action: 'ack',
            summary,
            start,
            end: endFinal,
            attendees,
            html_link: json.htmlLink,
          },
        };
      }

      // VTID-01943: Contacts — list via People API, optional name/email filter.
      case 'contacts.read': {
        const queryFilter = typeof action.args?.query === 'string' ? (action.args.query as string).trim().toLowerCase() : '';
        const limit = Math.max(1, Math.min(200, Number(action.args?.limit ?? 50) || 50));

        const u = new URL('https://people.googleapis.com/v1/people/me/connections');
        u.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers');
        u.searchParams.set('pageSize', String(Math.min(limit, 100)));
        u.searchParams.set('sortOrder', 'LAST_MODIFIED_DESCENDING');
        const r = await googleGet(u.toString(), token);
        if (isInsufficientScope(r)) return insufficientScopeResult('contacts.read');
        if (!r.ok) return { ok: false, error: `Contacts list failed: ${r.errorMessage}` };

        const all = (r.json?.connections ?? []).map((c: any) => {
          const nameObj = (c.names ?? [])[0] ?? {};
          const emails: string[] = (c.emailAddresses ?? []).map((e: any) => e.value).filter(Boolean);
          const phones: string[] = (c.phoneNumbers ?? []).map((p: any) => p.value).filter(Boolean);
          return {
            resource_name: c.resourceName,
            name: nameObj.displayName ?? [nameObj.givenName, nameObj.familyName].filter(Boolean).join(' '),
            emails,
            phones,
          };
        }).filter((c: any) => c.name || c.emails.length || c.phones.length);

        const filtered = queryFilter
          ? all.filter((c: any) =>
              (c.name ?? '').toLowerCase().includes(queryFilter) ||
              c.emails.some((e: string) => e.toLowerCase().includes(queryFilter)) ||
              c.phones.some((p: string) => p.toLowerCase().includes(queryFilter)),
            )
          : all;

        return {
          ok: true,
          raw: {
            action: 'structured_list',
            contacts: filtered.slice(0, limit),
            total: filtered.length,
            total_people: r.json?.totalPeople ?? null,
            query: queryFilter,
            summary: queryFilter
              ? `${filtered.length} contact${filtered.length === 1 ? '' : 's'} matching "${queryFilter}".`
              : `${filtered.length} contact${filtered.length === 1 ? '' : 's'}.`,
          },
        };
      }

      case 'email.send':
      case 'contacts.import':
        return { ok: false, error: `Capability ${action.capability} declared but not yet implemented` };

      default:
        return { ok: false, error: `Unknown capability ${action.capability}` };
    }
  },
};

export default googleConnector;
