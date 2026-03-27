/**
 * Social Connect Service — AP-1305 / AP-1306
 *
 * VTID: VTID-01250
 *
 * Manages OAuth connections to external social platforms for:
 * 1. Profile enrichment — scrape bio, images, interests from social accounts
 * 2. Auto-sharing — post milestones/achievements to connected accounts
 *
 * Supported providers: Instagram, Facebook, TikTok, YouTube, LinkedIn, X/Twitter
 *
 * OAuth flow:
 * 1. Frontend calls GET /api/v1/social/connect/:provider → returns OAuth redirect URL
 * 2. User authorizes on provider's site
 * 3. Provider redirects to callback URL with auth code
 * 4. Backend exchanges code for tokens via POST /api/v1/social/callback/:provider
 * 5. Backend stores tokens and triggers profile enrichment
 */

import { SupabaseClient } from '@supabase/supabase-js';

const APP_URL = process.env.APP_URL || 'https://vitana.app';
const GATEWAY_URL = process.env.GATEWAY_PUBLIC_URL || process.env.APP_URL || 'https://vitana.app';

// =============================================================================
// Provider Configuration
// =============================================================================

export type SocialProvider = 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'linkedin' | 'twitter';

export const SUPPORTED_PROVIDERS: SocialProvider[] = [
  'instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'twitter',
];

interface ProviderConfig {
  name: string;
  authUrl: string;
  tokenUrl: string;
  profileUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
}

const PROVIDER_CONFIGS: Record<SocialProvider, ProviderConfig> = {
  instagram: {
    name: 'Instagram',
    authUrl: 'https://api.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    profileUrl: 'https://graph.instagram.com/me',
    scopes: ['user_profile', 'user_media'],
    clientIdEnv: 'INSTAGRAM_CLIENT_ID',
    clientSecretEnv: 'INSTAGRAM_CLIENT_SECRET',
  },
  facebook: {
    name: 'Facebook',
    authUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    profileUrl: 'https://graph.facebook.com/v19.0/me',
    scopes: ['public_profile', 'email'],
    clientIdEnv: 'FACEBOOK_CLIENT_ID',
    clientSecretEnv: 'FACEBOOK_CLIENT_SECRET',
  },
  tiktok: {
    name: 'TikTok',
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    profileUrl: 'https://open.tiktokapis.com/v2/user/info/',
    scopes: ['user.info.basic', 'user.info.profile'],
    clientIdEnv: 'TIKTOK_CLIENT_KEY',
    clientSecretEnv: 'TIKTOK_CLIENT_SECRET',
  },
  youtube: {
    name: 'YouTube',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
  },
  linkedin: {
    name: 'LinkedIn',
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    profileUrl: 'https://api.linkedin.com/v2/userinfo',
    scopes: ['openid', 'profile', 'email'],
    clientIdEnv: 'LINKEDIN_CLIENT_ID',
    clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
  },
  twitter: {
    name: 'X / Twitter',
    authUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    profileUrl: 'https://api.twitter.com/2/users/me',
    scopes: ['users.read', 'tweet.read'],
    clientIdEnv: 'TWITTER_CLIENT_ID',
    clientSecretEnv: 'TWITTER_CLIENT_SECRET',
  },
};

// =============================================================================
// OAuth URL Generation
// =============================================================================

/**
 * Generate the OAuth authorization URL for a provider.
 * The state parameter encodes user_id and tenant_id for the callback.
 */
export function getOAuthUrl(
  provider: SocialProvider,
  userId: string,
  tenantId: string,
): { url: string; error?: string } {
  const config = PROVIDER_CONFIGS[provider];
  if (!config) return { url: '', error: `Unsupported provider: ${provider}` };

  const clientId = process.env[config.clientIdEnv];
  if (!clientId) {
    return { url: '', error: `${config.name} is not configured. Missing ${config.clientIdEnv}.` };
  }

  const callbackUrl = `${GATEWAY_URL}/api/v1/social/callback/${provider}`;
  const state = Buffer.from(JSON.stringify({ userId, tenantId, provider })).toString('base64url');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
  });

  // Provider-specific params
  if (provider === 'tiktok') {
    params.set('client_key', clientId);
    params.delete('client_id');
  }
  if (provider === 'twitter') {
    params.set('code_challenge', 'challenge'); // PKCE simplified
    params.set('code_challenge_method', 'plain');
  }

  return { url: `${config.authUrl}?${params.toString()}` };
}

/**
 * Parse the state parameter from the OAuth callback.
 */
export function parseOAuthState(state: string): { userId: string; tenantId: string; provider: SocialProvider } | null {
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString());
  } catch {
    return null;
  }
}

// =============================================================================
// Token Exchange
// =============================================================================

/**
 * Exchange an authorization code for access/refresh tokens.
 */
export async function exchangeCodeForTokens(
  provider: SocialProvider,
  code: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}> {
  const config = PROVIDER_CONFIGS[provider];
  const clientId = process.env[config.clientIdEnv];
  const clientSecret = process.env[config.clientSecretEnv];

  if (!clientId || !clientSecret) {
    return { access_token: '', error: `Missing OAuth credentials for ${config.name}` };
  }

  const callbackUrl = `${GATEWAY_URL}/api/v1/social/callback/${provider}`;

  try {
    const body: Record<string, string> = {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
    };

    // TikTok uses client_key instead of client_id
    if (provider === 'tiktok') {
      body.client_key = clientId;
      delete body.client_id;
    }

    const resp = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[SocialConnect] Token exchange failed for ${provider}:`, errText);
      return { access_token: '', error: `Token exchange failed: ${resp.status}` };
    }

    const data = await resp.json() as any;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    };
  } catch (err: any) {
    return { access_token: '', error: err.message };
  }
}

// =============================================================================
// Profile Fetching
// =============================================================================

interface SocialProfile {
  provider_user_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  profile_url: string;
  bio: string;
  followers_count: number;
  following_count: number;
  posts_count: number;
  interests: string[];
  raw: Record<string, unknown>;
}

/**
 * Fetch the user's profile from a social provider using their access token.
 */
export async function fetchSocialProfile(
  provider: SocialProvider,
  accessToken: string,
): Promise<SocialProfile | null> {
  const config = PROVIDER_CONFIGS[provider];

  try {
    let url = config.profileUrl;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
    };

    // Provider-specific profile URL adjustments
    if (provider === 'instagram') {
      url += `?fields=id,username,account_type,media_count&access_token=${accessToken}`;
      delete headers.Authorization;
    } else if (provider === 'facebook') {
      url += `?fields=id,name,picture,email,link&access_token=${accessToken}`;
      delete headers.Authorization;
    } else if (provider === 'tiktok') {
      url += `?fields=open_id,union_id,avatar_url,display_name,bio_description,follower_count,following_count,likes_count`;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      console.error(`[SocialConnect] Profile fetch failed for ${provider}: ${resp.status}`);
      return null;
    }

    const data = await resp.json() as any;
    return normalizeProfile(provider, data);
  } catch (err: any) {
    console.error(`[SocialConnect] Profile fetch error for ${provider}:`, err.message);
    return null;
  }
}

/**
 * Normalize provider-specific profile data into a common format.
 */
function normalizeProfile(provider: SocialProvider, data: any): SocialProfile {
  switch (provider) {
    case 'instagram':
      return {
        provider_user_id: data.id,
        username: data.username || '',
        display_name: data.username || '',
        avatar_url: '',
        profile_url: `https://instagram.com/${data.username}`,
        bio: '',
        followers_count: 0,
        following_count: 0,
        posts_count: data.media_count || 0,
        interests: [],
        raw: data,
      };
    case 'facebook':
      return {
        provider_user_id: data.id,
        username: data.name || '',
        display_name: data.name || '',
        avatar_url: data.picture?.data?.url || '',
        profile_url: data.link || `https://facebook.com/${data.id}`,
        bio: '',
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        interests: [],
        raw: data,
      };
    case 'tiktok': {
      const user = data.data?.user || data;
      return {
        provider_user_id: user.open_id || user.union_id || '',
        username: user.display_name || '',
        display_name: user.display_name || '',
        avatar_url: user.avatar_url || '',
        profile_url: '',
        bio: user.bio_description || '',
        followers_count: user.follower_count || 0,
        following_count: user.following_count || 0,
        posts_count: user.video_count || 0,
        interests: [],
        raw: data,
      };
    }
    case 'youtube': {
      const channel = data.items?.[0]?.snippet || {};
      return {
        provider_user_id: data.items?.[0]?.id || '',
        username: channel.customUrl || channel.title || '',
        display_name: channel.title || '',
        avatar_url: channel.thumbnails?.default?.url || '',
        profile_url: channel.customUrl ? `https://youtube.com/${channel.customUrl}` : '',
        bio: channel.description || '',
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        interests: [],
        raw: data,
      };
    }
    case 'linkedin':
      return {
        provider_user_id: data.sub || '',
        username: data.name || '',
        display_name: data.name || '',
        avatar_url: data.picture || '',
        profile_url: '',
        bio: '',
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        interests: [],
        raw: data,
      };
    case 'twitter': {
      const user = data.data || data;
      return {
        provider_user_id: user.id || '',
        username: user.username || '',
        display_name: user.name || '',
        avatar_url: user.profile_image_url || '',
        profile_url: user.username ? `https://x.com/${user.username}` : '',
        bio: user.description || '',
        followers_count: user.public_metrics?.followers_count || 0,
        following_count: user.public_metrics?.following_count || 0,
        posts_count: user.public_metrics?.tweet_count || 0,
        interests: [],
        raw: data,
      };
    }
    default:
      return {
        provider_user_id: '', username: '', display_name: '', avatar_url: '',
        profile_url: '', bio: '', followers_count: 0, following_count: 0,
        posts_count: 0, interests: [], raw: data,
      };
  }
}

// =============================================================================
// Connection Management
// =============================================================================

/**
 * Store a social connection and trigger profile enrichment.
 */
export async function storeSocialConnection(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
  provider: SocialProvider,
  tokens: { access_token: string; refresh_token?: string; expires_in?: number },
  profile: SocialProfile,
): Promise<{ ok: boolean; connection_id?: string; error?: string }> {
  const tokenExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  const { data, error } = await supabase
    .from('social_connections')
    .upsert({
      tenant_id: tenantId,
      user_id: userId,
      provider,
      provider_user_id: profile.provider_user_id,
      provider_username: profile.username,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      profile_url: profile.profile_url,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      token_expires_at: tokenExpiresAt,
      scopes: PROVIDER_CONFIGS[provider].scopes,
      profile_data: profile.raw,
      enrichment_status: 'pending',
      connected_at: new Date().toISOString(),
      disconnected_at: null,
      is_active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,user_id,provider' })
    .select('id')
    .single();

  if (error) {
    console.error(`[SocialConnect] Store connection error:`, error.message);
    return { ok: false, error: error.message };
  }

  return { ok: true, connection_id: data?.id };
}

/**
 * Disconnect a social account.
 */
export async function disconnectSocialAccount(
  supabase: SupabaseClient,
  userId: string,
  provider: SocialProvider,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('social_connections')
    .update({
      is_active: false,
      disconnected_at: new Date().toISOString(),
      access_token: null,
      refresh_token: null,
    })
    .eq('user_id', userId)
    .eq('provider', provider);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Get all active social connections for a user.
 */
export async function getUserConnections(
  supabase: SupabaseClient,
  userId: string,
): Promise<Array<{
  provider: SocialProvider;
  username: string;
  display_name: string;
  avatar_url: string;
  profile_url: string;
  enrichment_status: string;
  connected_at: string;
}>> {
  const { data } = await supabase
    .from('social_connections')
    .select('provider, provider_username, display_name, avatar_url, profile_url, enrichment_status, connected_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('connected_at', { ascending: false });

  return (data || []).map((c: any) => ({
    provider: c.provider,
    username: c.provider_username,
    display_name: c.display_name,
    avatar_url: c.avatar_url,
    profile_url: c.profile_url,
    enrichment_status: c.enrichment_status,
    connected_at: c.connected_at,
  }));
}

// =============================================================================
// Profile Enrichment
// =============================================================================

/**
 * Enrich a user's Vitana profile using data from their connected social accounts.
 * Pulls bio, avatar, interests from social profiles and merges into Vitana profile.
 */
export async function enrichProfileFromSocial(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
  connectionId: string,
): Promise<{ ok: boolean; enrichments: string[]; error?: string }> {
  const enrichments: string[] = [];

  // Get the connection
  const { data: conn } = await supabase
    .from('social_connections')
    .select('*')
    .eq('id', connectionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!conn || !conn.is_active) {
    return { ok: false, enrichments, error: 'Connection not found or inactive' };
  }

  // Update enrichment status
  await supabase.from('social_connections')
    .update({ enrichment_status: 'enriching', updated_at: new Date().toISOString() })
    .eq('id', connectionId);

  try {
    // Fetch fresh profile data
    const profile = await fetchSocialProfile(conn.provider, conn.access_token);
    if (!profile) {
      await supabase.from('social_connections')
        .update({ enrichment_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', connectionId);
      return { ok: false, enrichments, error: 'Failed to fetch social profile' };
    }

    // Get current Vitana profile
    const { data: vitanaUser } = await supabase
      .from('app_users')
      .select('display_name, avatar_url, bio')
      .eq('user_id', userId)
      .maybeSingle();

    const updates: Record<string, string> = {};

    // Enrich avatar if missing
    if (!vitanaUser?.avatar_url && profile.avatar_url) {
      updates.avatar_url = profile.avatar_url;
      enrichments.push('avatar');
    }

    // Enrich bio if missing
    if (!vitanaUser?.bio && profile.bio) {
      // Truncate to 500 chars (Vitana bio limit)
      updates.bio = profile.bio.slice(0, 500);
      enrichments.push('bio');
    }

    // Apply updates to Vitana profile
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      await supabase
        .from('app_users')
        .update(updates)
        .eq('user_id', userId);
    }

    // Extract interests from bio text and store as topics
    if (profile.bio) {
      // Store the bio as a memory fact for the recommendation engine to use
      await supabase.from('memory_facts').upsert({
        user_id: userId,
        key: `social_bio_${conn.provider}`,
        value: profile.bio.slice(0, 1000),
        source: `social_${conn.provider}`,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,key' });
      enrichments.push('interests_extracted');
    }

    // Store enrichment data
    await supabase.from('social_connections').update({
      enrichment_status: 'completed',
      enrichment_data: {
        avatar_enriched: enrichments.includes('avatar'),
        bio_enriched: enrichments.includes('bio'),
        interests_extracted: enrichments.includes('interests_extracted'),
        profile_snapshot: {
          followers: profile.followers_count,
          following: profile.following_count,
          posts: profile.posts_count,
        },
        enriched_at: new Date().toISOString(),
      },
      profile_data: profile.raw,
      last_enriched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', connectionId);

    return { ok: true, enrichments };
  } catch (err: any) {
    await supabase.from('social_connections')
      .update({ enrichment_status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', connectionId);
    return { ok: false, enrichments, error: err.message };
  }
}

// =============================================================================
// Auto-Share
// =============================================================================

/**
 * Get a user's auto-share preferences.
 */
export async function getSharePrefs(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<{
  auto_share_enabled: boolean;
  share_milestones: boolean;
  share_to_providers: string[];
  share_visibility: string;
}> {
  const { data } = await supabase
    .from('social_share_prefs')
    .select('*')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  return {
    auto_share_enabled: data?.auto_share_enabled ?? true,
    share_milestones: data?.share_milestones ?? true,
    share_to_providers: data?.share_to_providers ?? ['instagram', 'facebook', 'linkedin'],
    share_visibility: data?.share_visibility ?? 'public',
  };
}

/**
 * Update auto-share preferences.
 */
export async function updateSharePrefs(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
  prefs: {
    auto_share_enabled?: boolean;
    share_milestones?: boolean;
    share_to_providers?: string[];
    share_visibility?: string;
  },
): Promise<{ ok: boolean }> {
  await supabase.from('social_share_prefs').upsert({
    tenant_id: tenantId,
    user_id: userId,
    ...prefs,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,user_id' });

  return { ok: true };
}

/**
 * Share a milestone to connected social accounts.
 * Posts to each provider the user has enabled.
 * If auto-share is disabled, sends a notification instead.
 */
export async function shareMilestoneToSocial(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
  milestone: { id: string; name: string; celebration: string; icon: string },
): Promise<{ shared: string[]; skipped: string[]; notify_instead: boolean }> {
  const shared: string[] = [];
  const skipped: string[] = [];

  // Check share preferences
  const prefs = await getSharePrefs(supabase, userId, tenantId);

  if (!prefs.auto_share_enabled || !prefs.share_milestones) {
    return { shared: [], skipped: [], notify_instead: true };
  }

  // Get active connections for the providers user wants to share to
  const { data: connections } = await supabase
    .from('social_connections')
    .select('id, provider, access_token, provider_username')
    .eq('user_id', userId)
    .eq('is_active', true)
    .in('provider', prefs.share_to_providers);

  if (!connections?.length) {
    return { shared: [], skipped: [], notify_instead: true };
  }

  const shareText = `${milestone.icon} ${milestone.name} — ${milestone.celebration} #Vitana`;
  const shareUrl = `${APP_URL}/profile?milestone=${milestone.id}`;

  for (const conn of connections) {
    // Log the share attempt
    const { data: logEntry } = await supabase.from('social_share_log').insert({
      tenant_id: tenantId,
      user_id: userId,
      provider: conn.provider,
      share_type: 'milestone',
      content_ref: milestone.id,
      share_url: shareUrl,
      share_status: 'pending',
    }).select('id').single();

    try {
      // Provider-specific posting
      const posted = await postToProvider(conn.provider, conn.access_token, shareText, shareUrl);

      if (posted) {
        shared.push(conn.provider);
        if (logEntry?.id) {
          await supabase.from('social_share_log')
            .update({ share_status: 'posted', posted_at: new Date().toISOString() })
            .eq('id', logEntry.id);
        }
      } else {
        skipped.push(conn.provider);
        if (logEntry?.id) {
          await supabase.from('social_share_log')
            .update({ share_status: 'failed', error_message: 'Post API returned false' })
            .eq('id', logEntry.id);
        }
      }
    } catch (err: any) {
      skipped.push(conn.provider);
      if (logEntry?.id) {
        await supabase.from('social_share_log')
          .update({ share_status: 'failed', error_message: err.message })
          .eq('id', logEntry.id);
      }
    }
  }

  return { shared, skipped, notify_instead: shared.length === 0 };
}

/**
 * Post content to a specific social provider.
 * Returns true if successful.
 */
async function postToProvider(
  provider: SocialProvider,
  accessToken: string,
  text: string,
  url: string,
): Promise<boolean> {
  try {
    switch (provider) {
      case 'facebook': {
        const resp = await fetch('https://graph.facebook.com/v19.0/me/feed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            link: url,
            access_token: accessToken,
          }),
        });
        return resp.ok;
      }
      case 'linkedin': {
        const resp = await fetch('https://api.linkedin.com/v2/ugcPosts', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
          },
          body: JSON.stringify({
            author: 'urn:li:person:me',
            lifecycleState: 'PUBLISHED',
            specificContent: {
              'com.linkedin.ugc.ShareContent': {
                shareCommentary: { text },
                shareMediaCategory: 'ARTICLE',
                media: [{ status: 'READY', originalUrl: url }],
              },
            },
            visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
          }),
        });
        return resp.ok;
      }
      case 'twitter': {
        const resp = await fetch('https://api.twitter.com/2/tweets', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: `${text}\n${url}` }),
        });
        return resp.ok;
      }
      // Instagram, TikTok, YouTube don't support text-only posting via API
      // For these, we return false so the notification fallback triggers
      case 'instagram':
      case 'tiktok':
      case 'youtube':
        return false;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Get available (configured) providers.
 * Only returns providers whose OAuth credentials are set.
 */
export function getAvailableProviders(): Array<{
  provider: SocialProvider;
  name: string;
  configured: boolean;
}> {
  return SUPPORTED_PROVIDERS.map(p => {
    const config = PROVIDER_CONFIGS[p];
    return {
      provider: p,
      name: config.name,
      configured: !!process.env[config.clientIdEnv] && !!process.env[config.clientSecretEnv],
    };
  });
}
