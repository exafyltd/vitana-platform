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

/** YouTube search → first video hit. Used by the music.play capability. */
async function youtubeSearchFirst(query: string, token: string): Promise<{ videoId: string; title: string; channel: string; thumbnail?: string } | null> {
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  u.searchParams.set('part', 'snippet');
  u.searchParams.set('type', 'video');
  u.searchParams.set('maxResults', '1');
  u.searchParams.set('q', query);
  // videoCategoryId=10 is Music — bias results toward music videos.
  u.searchParams.set('videoCategoryId', '10');
  const r = await googleGet(u.toString(), token);
  if (!r.ok) throw new Error(`YouTube search failed: ${r.errorMessage}`);
  const item = r.json?.items?.[0];
  if (!item?.id?.videoId) return null;
  return {
    videoId: item.id.videoId,
    title: item.snippet?.title ?? query,
    channel: item.snippet?.channelTitle ?? '',
    thumbnail: item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url,
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
        const hit = await youtubeSearchFirst(query, token);
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

      case 'email.read':
      case 'email.send':
      case 'calendar.list':
      case 'calendar.create':
      case 'contacts.read':
      case 'contacts.import':
        return { ok: false, error: `Capability ${action.capability} declared but not yet implemented` };

      default:
        return { ok: false, error: `Unknown capability ${action.capability}` };
    }
  },
};

export default googleConnector;
