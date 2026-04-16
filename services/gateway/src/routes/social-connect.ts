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
  SocialProvider,
  SUPPORTED_PROVIDERS,
} from '../services/social-connect-service';

const router = Router();
const LOG_PREFIX = '[SocialConnect]';

const APP_URL = process.env.APP_URL || 'https://vitana.app';

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

  const { url, error } = getOAuthUrl(provider, user.userId, user.tenantId);
  if (error) {
    return res.status(400).json({ ok: false, error });
  }

  return res.json({ ok: true, provider, auth_url: url });
});

// =============================================================================
// GET /callback/:provider — OAuth callback (redirect from provider)
// =============================================================================
router.get('/callback/:provider', async (req: Request, res: Response) => {
  const provider = req.params.provider as SocialProvider;
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    console.warn(`${LOG_PREFIX} OAuth error for ${provider}: ${oauthError}`);
    return res.redirect(`${APP_URL}/settings/social?error=oauth_denied&provider=${provider}`);
  }

  if (!code || !state) {
    return res.redirect(`${APP_URL}/settings/social?error=missing_params&provider=${provider}`);
  }

  // Parse state to get userId and tenantId
  const stateData = parseOAuthState(state as string);
  if (!stateData) {
    return res.redirect(`${APP_URL}/settings/social?error=invalid_state&provider=${provider}`);
  }

  console.log(`${LOG_PREFIX} Processing callback for ${provider}, user ${stateData.userId.slice(0, 8)}…`);

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(provider, code as string);
  if (!tokens.access_token) {
    console.error(`${LOG_PREFIX} Token exchange failed: ${tokens.error}`);
    return res.redirect(`${APP_URL}/settings/social?error=token_exchange_failed&provider=${provider}`);
  }

  // Fetch social profile
  const profile = await fetchSocialProfile(provider, tokens.access_token);
  if (!profile) {
    return res.redirect(`${APP_URL}/settings/social?error=profile_fetch_failed&provider=${provider}`);
  }

  // Store connection
  const supabase = await getServiceClient();
  if (!supabase) {
    return res.redirect(`${APP_URL}/settings/social?error=service_unavailable&provider=${provider}`);
  }

  const result = await storeSocialConnection(
    supabase, stateData.userId, stateData.tenantId, provider, tokens, profile,
  );

  if (!result.ok) {
    return res.redirect(`${APP_URL}/settings/social?error=store_failed&provider=${provider}`);
  }

  // Trigger profile enrichment in the background
  if (result.connection_id) {
    enrichProfileFromSocial(supabase, stateData.userId, stateData.tenantId, result.connection_id)
      .then(enrichResult => {
        console.log(`${LOG_PREFIX} Enrichment for ${provider}: ${enrichResult.enrichments.join(', ') || 'none'}`);
      })
      .catch(err => {
        console.warn(`${LOG_PREFIX} Enrichment failed for ${provider}: ${err.message}`);
      });
  }

  // Redirect back to settings with success
  return res.redirect(
    `${APP_URL}/settings/social?connected=${provider}&username=${encodeURIComponent(profile.username)}`
  );
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
