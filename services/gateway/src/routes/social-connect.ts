/**
 * Social Connect Routes — AP-1305 / AP-1306
 *
 * VTID: VTID-01250
 *
 * API endpoints for connecting social media accounts and managing
 * auto-share preferences.
 *
 * Endpoints:
 * - GET  /social/providers          — List available providers
 * - GET  /social/connections        — List user's connected accounts
 * - GET  /social/connect/:provider  — Get OAuth URL for a provider
 * - GET  /social/callback/:provider — OAuth callback (redirect from provider)
 * - POST /social/disconnect/:provider — Disconnect a provider
 * - POST /social/enrich/:provider   — Re-trigger profile enrichment
 * - GET  /social/share-prefs        — Get auto-share preferences
 * - PUT  /social/share-prefs        — Update auto-share preferences
 *
 * Mounted at: /api/v1/social
 */

import { Router, Request, Response } from 'express';
import {
  getOAuthUrl,
  parseOAuthState,
  exchangeCodeForTokens,
  fetchSocialProfile,
  storeSocialConnection,
  disconnectSocialAccount,
  getUserConnections,
  enrichProfileFromSocial,
  getSharePrefs,
  updateSharePrefs,
  getAvailableProviders,
  parseGoogleInclude,
  SocialProvider,
  SUPPORTED_PROVIDERS,
  type OAuthReturnMode,
  type GoogleSubService,
} from '../services/social-connect-service';

const router = Router();
const LOG_PREFIX = '[SocialConnect]';

const APP_URL = process.env.APP_URL || 'https://vitana.app';

// VTID-01928: OAuth callback redirect path per provider. Google connectors live
// in /settings/connected-apps; legacy social providers keep the /settings/social
// path so their existing flows (scrape-based import, share prefs UI) are unaffected.
// YouTube is surfaced in the Music & Video section of /settings/connected-apps,
// so its callback lands there too.
function callbackRedirectPath(provider: string): string {
  if (provider === 'google' || provider === 'youtube') return '/settings/connected-apps';
  return '/settings/social';
}

// Phase 7B: when the OAuth flow originated inside the Appilix WebView, the
// gateway redirects to /oauth/complete instead of the Connected Apps page.
// That landing page handles deep-linking back into the WebView and keeps the
// session-handoff logic in one place for both gateway-driven Google flows
// and Supabase Auth (Apple) flows.
function buildCallbackRedirect(
  provider: string,
  returnMode: OAuthReturnMode | undefined,
  params: Record<string, string>,
): string {
  const path = returnMode === 'mobile' ? '/oauth/complete' : callbackRedirectPath(provider);
  const merged: Record<string, string> = { provider, ...params };
  if (returnMode === 'mobile') merged['return'] = 'mobile';
  const query = new URLSearchParams(merged).toString();
  return `${APP_URL}${path}?${query}`;
}

// Phase 2: opaque codes like ?error=token_exchange_failed are useless to
// users. Pair every error code with a human message and a hint for what
// to do next, so the Connected Apps toast and the OAuthComplete error
// screen can show something actionable.
const CALLBACK_ERROR_MESSAGES: Record<string, { detail: string; hint: string }> = {
  oauth_denied: {
    detail: "You didn't grant Vitana permission on the provider's screen.",
    hint: 'Try the Connect button again and accept the requested scopes.',
  },
  missing_params: {
    detail: 'The provider returned an incomplete response.',
    hint: 'Please try again. If it keeps happening, contact support.',
  },
  invalid_state: {
    detail: 'Your session expired during sign-in.',
    hint: 'Please try connecting again.',
  },
  token_exchange_failed: {
    detail: 'The provider rejected our credentials.',
    hint: 'This usually clears up in a minute — please try again.',
  },
  profile_fetch_failed: {
    detail: "We connected, but couldn't read your profile.",
    hint: 'Please try again or contact support if it persists.',
  },
  service_unavailable: {
    detail: 'Our services are temporarily unavailable.',
    hint: 'Please try again in a minute.',
  },
  store_failed: {
    detail: "We couldn't save your connection.",
    hint: 'Please contact support with error code STORE-FAILED.',
  },
};

// Helper: get Supabase service client
async function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

// Helper: extract user info from JWT
function extractUserFromJwt(req: Request): { userId: string; tenantId: string } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.split(' ')[1];
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return {
      userId: payload.sub,
      tenantId: payload.app_metadata?.active_tenant_id || process.env.DEFAULT_TENANT_ID || '',
    };
  } catch {
    return null;
  }
}

// =============================================================================
// GET /providers — List available social providers
// =============================================================================
router.get('/providers', (_req: Request, res: Response) => {
  const providers = getAvailableProviders();
  return res.json({
    ok: true,
    providers,
    settings_url: `${APP_URL}/settings/social`,
  });
});

// =============================================================================
// GET /connections — List user's connected accounts
// =============================================================================
router.get('/connections', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const connections = await getUserConnections(supabase, user.userId);
  return res.json({ ok: true, connections });
});

// =============================================================================
// GET /connect/:provider — Get OAuth URL to connect a social account
// =============================================================================
router.get('/connect/:provider', (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const provider = req.params.provider as SocialProvider;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({
      ok: false,
      error: `Unsupported provider: ${provider}`,
      supported: SUPPORTED_PROVIDERS,
    });
  }

  // Phase 7B: clients running inside the Appilix WebView pass `?return=mobile`
  // so the callback can route the success/error screen to /oauth/complete
  // instead of the inline Connected Apps page (which the user would only
  // see in the system browser tab, not in the app).
  const returnMode: OAuthReturnMode = req.query.return === 'mobile' ? 'mobile' : 'web';

  // Phase 3 (unified Google connect): clients can request a specific bundle
  // of Google sub-services with `?include=gmail,calendar,contacts,youtube`.
  // Default behavior (no include) keeps the legacy Gmail+Calendar+Contacts
  // bundle so existing per-service Connect buttons still work.
  // Phase 4 (incremental consent): `?mode=incremental` adds the requested
  // scopes onto the user's existing token without forcing a full re-consent.
  let includeServices: GoogleSubService[] | undefined = undefined;
  if (provider === 'google' && typeof req.query.include === 'string') {
    const parsed = parseGoogleInclude(req.query.include);
    if (parsed === null) {
      // include= present but empty/invalid — fall through to default bundle.
    } else if (parsed.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid `include` value. Use a comma-separated list of: gmail, calendar, contacts, youtube.',
      });
    } else {
      includeServices = parsed;
    }
  }
  const mode: 'full' | 'incremental' = req.query.mode === 'incremental' ? 'incremental' : 'full';

  const { url, error } = getOAuthUrl(provider, user.userId, user.tenantId, {
    returnMode,
    includeServices,
    mode,
  });
  if (error) {
    return res.status(400).json({ ok: false, error });
  }

  return res.json({ ok: true, provider, auth_url: url });
});

// =============================================================================
// GET /callback/:provider — OAuth callback (redirect from provider)
//
// NB: the :provider in the URL is what was registered in the OAuth client's
// redirect-URI allowlist, which is not always the actual provider the user is
// connecting. YouTube shares Google's OAuth client and rides on the
// /callback/google URL (see callbackProviderFor). The real provider lives in
// the state blob — parse that first, then dispatch.
// =============================================================================
router.get('/callback/:provider', async (req: Request, res: Response) => {
  const urlProvider = req.params.provider as SocialProvider;
  const { code, state, error: oauthError } = req.query;

  // Best-effort returnMode read — if we can't parse the state we fall
  // back to web routing.
  let returnMode: OAuthReturnMode | undefined = undefined;
  let stateProvider: SocialProvider | undefined = undefined;
  if (typeof state === 'string') {
    const probe = parseOAuthState(state);
    if (probe) {
      returnMode = probe.returnMode;
      stateProvider = probe.provider;
    }
  }

  const errRedirect = (errCode: string, providerForRedirect: string) => {
    const msg = CALLBACK_ERROR_MESSAGES[errCode] ?? {
      detail: 'Sign-in failed.',
      hint: 'Please try again.',
    };
    return res.redirect(buildCallbackRedirect(providerForRedirect, returnMode, {
      status: 'failed',
      error: errCode,
      error_detail: msg.detail,
      error_hint: msg.hint,
    }));
  };

  if (oauthError) {
    console.warn(`${LOG_PREFIX} OAuth error for ${urlProvider}: ${oauthError}`);
    return errRedirect('oauth_denied', stateProvider ?? urlProvider);
  }

  if (!code || !state) {
    return errRedirect('missing_params', stateProvider ?? urlProvider);
  }

  // Parse state to get userId, tenantId and the real provider.
  const stateData = parseOAuthState(state as string);
  if (!stateData) {
    return errRedirect('invalid_state', urlProvider);
  }

  // From here on use the actual provider from state, not the URL path.
  const provider = stateData.provider;
  returnMode = stateData.returnMode ?? returnMode;

  console.log(`${LOG_PREFIX} Processing callback for ${provider} (url:${urlProvider}, return:${returnMode ?? 'web'}), user ${stateData.userId.slice(0, 8)}…`);

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(provider, code as string);
  if (!tokens.access_token) {
    console.error(`${LOG_PREFIX} Token exchange failed: ${tokens.error}`);
    return errRedirect('token_exchange_failed', provider);
  }

  // Fetch social profile
  const profile = await fetchSocialProfile(provider, tokens.access_token);
  if (!profile) {
    return errRedirect('profile_fetch_failed', provider);
  }

  // Store connection
  const supabase = await getServiceClient();
  if (!supabase) {
    return errRedirect('service_unavailable', provider);
  }

  const result = await storeSocialConnection(
    supabase, stateData.userId, stateData.tenantId, provider, tokens, profile,
  );

  if (!result.ok) {
    return errRedirect('store_failed', provider);
  }

  // VTID-01928: Skip social enrichment for Google — it's a data-access connector,
  // not a profile-scraping one. Social providers (Instagram/Facebook/TikTok/etc.)
  // still run the enrichment pipeline for interest/topic extraction.
  if (result.connection_id && provider !== 'google') {
    enrichProfileFromSocial(supabase, stateData.userId, stateData.tenantId, result.connection_id)
      .then(enrichResult => {
        console.log(`${LOG_PREFIX} Enrichment for ${provider}: ${enrichResult.enrichments.join(', ') || 'none'}`);
      })
      .catch(err => {
        console.warn(`${LOG_PREFIX} Enrichment failed for ${provider}: ${err.message}`);
      });
  }

  return res.redirect(buildCallbackRedirect(provider, returnMode, {
    status: 'ok',
    connected: provider,
    username: profile.username,
  }));
});

// =============================================================================
// POST /disconnect/:provider — Disconnect a social account
// =============================================================================
router.post('/disconnect/:provider', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const provider = req.params.provider as SocialProvider;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ ok: false, error: `Unsupported provider: ${provider}` });
  }

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const result = await disconnectSocialAccount(supabase, user.userId, provider);
  return res.json(result);
});

// =============================================================================
// POST /enrich/:provider — Re-trigger profile enrichment
// =============================================================================
router.post('/enrich/:provider', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const provider = req.params.provider as SocialProvider;
  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  // Find the connection
  const { data: conn } = await supabase
    .from('social_connections')
    .select('id')
    .eq('user_id', user.userId)
    .eq('provider', provider)
    .eq('is_active', true)
    .maybeSingle();

  if (!conn) {
    return res.status(404).json({ ok: false, error: `No active ${provider} connection found` });
  }

  const result = await enrichProfileFromSocial(supabase, user.userId, user.tenantId, conn.id);
  return res.json({
    ok: result.ok,
    enrichments: result.enrichments,
    error: result.error,
  });
});

// =============================================================================
// GET /share-prefs — Get auto-share preferences
// =============================================================================
router.get('/share-prefs', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const prefs = await getSharePrefs(supabase, user.userId, user.tenantId);
  return res.json({
    ok: true,
    prefs,
    settings_url: `${APP_URL}/settings/autopilot`,
  });
});

// =============================================================================
// PUT /share-prefs — Update auto-share preferences
// =============================================================================
router.put('/share-prefs', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const { auto_share_enabled, share_milestones, share_to_providers, share_visibility } = req.body || {};

  // Validate
  if (share_to_providers && !Array.isArray(share_to_providers)) {
    return res.status(400).json({ ok: false, error: 'share_to_providers must be an array' });
  }
  if (share_visibility && !['public', 'connections', 'private'].includes(share_visibility)) {
    return res.status(400).json({ ok: false, error: 'share_visibility must be public, connections, or private' });
  }

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const result = await updateSharePrefs(supabase, user.userId, user.tenantId, {
    ...(auto_share_enabled !== undefined && { auto_share_enabled }),
    ...(share_milestones !== undefined && { share_milestones }),
    ...(share_to_providers !== undefined && { share_to_providers }),
    ...(share_visibility !== undefined && { share_visibility }),
  });

  return res.json(result);
});

// =============================================================================
// VTID-02000: GET /:provider/profile-summary — Enrichment snapshot for the
// "Vitana knows you now" success modal shown after connecting a social account.
//
// Returns: extracted interests + topics + display summary, sourced from
// enrichment_data and the user's topic profile / memory facts.
// =============================================================================
router.get('/:provider/profile-summary', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const provider = req.params.provider;
  const { data: connection, error } = await supabase
    .from('social_connections')
    .select('provider, provider_username, display_name, avatar_url, profile_url, enrichment_data, enrichment_status, last_enriched_at')
    .eq('user_id', user.userId)
    .eq('provider', provider)
    .eq('is_active', true)
    .maybeSingle();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!connection) return res.status(404).json({ ok: false, error: 'Connection not found' });

  // Derive interests + topic hints from enrichment_data (shape varies by provider)
  const enrichment = (connection.enrichment_data as Record<string, unknown>) ?? {};
  const interests = Array.isArray(enrichment.interests) ? (enrichment.interests as string[]).slice(0, 12) : [];
  const topics = Array.isArray(enrichment.topics) ? (enrichment.topics as string[]).slice(0, 12) : [];
  const bio = typeof enrichment.bio === 'string' ? enrichment.bio : null;
  const follower_count = typeof enrichment.follower_count === 'number' ? enrichment.follower_count : null;

  return res.json({
    ok: true,
    summary: {
      provider: connection.provider,
      display_name: connection.display_name,
      provider_username: connection.provider_username,
      avatar_url: connection.avatar_url,
      profile_url: connection.profile_url,
      bio,
      follower_count,
      interests,
      topics,
      enrichment_status: connection.enrichment_status,
      last_enriched_at: connection.last_enriched_at,
      headline: interests.length
        ? `Vitana picked up ${interests.length} interests from your ${provider} profile — we'll use them to shape your experience.`
        : `Connected to ${provider}. Enrichment is still processing.`,
    },
  });
});

// =============================================================================
// VTID-01928: GET /google/verify — functional health check of the stored
// Google OAuth token. Hits Gmail profile, Calendar list and Contacts count in
// parallel with the user's access_token, returns a compact summary per
// service. Used by the Manage button on Connected Apps to prove the
// connection actually works against Google — not just that a DB row exists.
// YouTube has its own connection (see /connect/youtube) and is verified
// through that flow, not here.
// =============================================================================
router.get('/google/verify', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const { data: conn } = await supabase
    .from('social_connections')
    .select('id, access_token, refresh_token, token_expires_at, scopes, provider_username, connected_at')
    .eq('user_id', user.userId)
    .eq('provider', 'google')
    .eq('is_active', true)
    .maybeSingle();

  if (!conn || !conn.access_token) {
    return res.status(404).json({ ok: false, error: 'No active Google connection for this user' });
  }

  // VTID-01928: Refresh the access_token if it's expired or about to expire.
  // Without this, any verify call >1h after consent fails with 401 from Google.
  let token = conn.access_token as string;
  let tokenRefreshed = false;
  const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  const shouldRefresh = expiresAt > 0 && expiresAt < Date.now() + 30_000; // 30s buffer

  if (shouldRefresh && conn.refresh_token) {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (clientId && clientSecret) {
      try {
        const refreshResp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: conn.refresh_token as string,
            grant_type: 'refresh_token',
          }).toString(),
        });
        const refreshJson: any = await refreshResp.json().catch(() => ({}));
        if (refreshResp.ok && refreshJson.access_token) {
          token = refreshJson.access_token;
          tokenRefreshed = true;
          const newExpiry = new Date(Date.now() + (refreshJson.expires_in ?? 3600) * 1000).toISOString();
          await supabase
            .from('social_connections')
            .update({
              access_token: token,
              token_expires_at: newExpiry,
              updated_at: new Date().toISOString(),
            })
            .eq('id', conn.id);
          conn.token_expires_at = newExpiry;
          console.log(`[SocialConnect] Refreshed google access_token for user ${user.userId.slice(0, 8)}…, new expiry ${newExpiry}`);
        } else {
          console.warn(`[SocialConnect] Token refresh failed:`, refreshJson);
        }
      } catch (err: any) {
        console.warn(`[SocialConnect] Token refresh exception: ${err.message}`);
      }
    }
  }

  const headers = { Authorization: `Bearer ${token}` };

  // Run the Mail/Calendar/Contacts probes in parallel — each one's failure is
  // isolated. YouTube is verified separately via the dedicated youtube
  // connection (see VTID-01928 YouTube OAuth split).
  const [gmailR, calR, contactsR] = await Promise.allSettled([
    fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers }),
    fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=10', { headers }),
    fetch('https://people.googleapis.com/v1/people/me/connections?personFields=names&pageSize=1', { headers }),
  ]);

  type ProbeResult = { ok: boolean; status?: number; data?: any; error?: string };

  const normalize = async (r: PromiseSettledResult<globalThis.Response>): Promise<ProbeResult> => {
    if (r.status === 'rejected') return { ok: false, error: String(r.reason) };
    const resp = r.value;
    let body: any = null;
    try { body = await resp.json(); } catch { /* noop */ }
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: body?.error?.message ?? resp.statusText };
    }
    return { ok: true, status: resp.status, data: body };
  };

  const [gmail, cal, contacts] = await Promise.all([
    normalize(gmailR), normalize(calR), normalize(contactsR),
  ]);

  return res.json({
    ok: true,
    connection: {
      email: conn.provider_username,
      connected_at: conn.connected_at,
      token_expires_at: conn.token_expires_at,
      scopes: conn.scopes,
      has_refresh_token: Boolean(conn.refresh_token),
      token_refreshed: tokenRefreshed,
    },
    probes: {
      gmail: gmail.ok ? {
        ok: true,
        email: gmail.data?.emailAddress,
        messages_total: gmail.data?.messagesTotal,
        threads_total: gmail.data?.threadsTotal,
      } : { ok: false, status: gmail.status, error: gmail.error },

      calendar: cal.ok ? {
        ok: true,
        calendars: (cal.data?.items ?? []).length,
        primary: (cal.data?.items ?? []).find((c: any) => c.primary)?.summary ?? null,
      } : { ok: false, status: cal.status, error: cal.error },

      contacts: contacts.ok ? {
        ok: true,
        total_people: contacts.data?.totalPeople ?? contacts.data?.totalItems ?? null,
      } : { ok: false, status: contacts.status, error: contacts.error },
    },
  });
});

// =============================================================================
// Health
// =============================================================================
router.get('/health', (_req: Request, res: Response) => {
  const providers = getAvailableProviders();
  return res.json({
    ok: true,
    service: 'social-connect',
    configured_providers: providers.filter(p => p.configured).map(p => p.provider),
    total_providers: providers.length,
  });
});

export default router;
