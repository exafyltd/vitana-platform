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
 * 4. Backend exchanges code for tokens via POST /api/v1/social-accounts/callback/:provider
 * 5. Backend stores tokens and triggers profile enrichment
 */

import { SupabaseClient } from '@supabase/supabase-js';

const APP_URL = process.env.APP_URL || 'https://vitana.app';
const GATEWAY_URL = process.env.GATEWAY_PUBLIC_URL || process.env.APP_URL || 'https://vitana.app';

// =============================================================================
// Provider Configuration
// =============================================================================

// VTID-01928: `google` covers Gmail + Calendar + Contacts + YouTube data access.
// Distinct from the `youtube` social-enrichment provider which shares the same
// OAuth client but only requests the youtube.readonly scope and is surfaced in
// the Social Media section, not Mail/Calendar/Music.
export type SocialProvider =
  | 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'linkedin' | 'twitter'
  | 'google';

export const SUPPORTED_PROVIDERS: SocialProvider[] = [
  'instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'twitter',
  'google',
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
    profileUrl: 'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/userinfo.profile'],
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
    profileUrl: 'https://api.twitter.com/2/users/me?user.fields=description,location,url,profile_image_url,public_metrics,pinned_tweet_id',
    scopes: ['users.read', 'tweet.read'],
    clientIdEnv: 'TWITTER_CLIENT_ID',
    clientSecretEnv: 'TWITTER_CLIENT_SECRET',
  },
  // VTID-01928: Google covers Gmail, Google Calendar, Google Contacts (People API),
  // YouTube data and YouTube Music. All routed through a single OAuth consent so
  // the user grants once and every Google-based connector activates together.
  google: {
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/youtube.readonly',
    ],
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
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

  const callbackUrl = `${GATEWAY_URL}/api/v1/social-accounts/callback/${provider}`;
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
  if (provider === 'google') {
    // offline + consent so Google actually returns a refresh_token on every consent,
    // not just the very first one — required for long-lived background access.
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
    params.set('include_granted_scopes', 'true');
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

  const callbackUrl = `${GATEWAY_URL}/api/v1/social-accounts/callback/${provider}`;

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
  location: string;
  website: string;
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
      url += `?fields=id,username,account_type,media_count,biography,website,followers_count,follows_count&access_token=${accessToken}`;
      delete headers.Authorization;
    } else if (provider === 'facebook') {
      url += `?fields=id,name,picture,email,link,about,bio,location,website,friends.summary(true),likes.limit(50){name,category}&access_token=${accessToken}`;
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
        bio: data.biography || '',
        location: '',
        website: data.website || '',
        followers_count: data.followers_count || 0,
        following_count: data.follows_count || 0,
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
        bio: data.about || data.bio || '',
        location: data.location?.name || '',
        website: data.website || '',
        followers_count: data.friends?.summary?.total_count || 0,
        following_count: 0,
        posts_count: 0,
        interests: (data.likes?.data || []).map((l: any) => l.name).slice(0, 20),
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
        location: '',
        website: '',
        followers_count: user.follower_count || 0,
        following_count: user.following_count || 0,
        posts_count: user.video_count || 0,
        interests: [],
        raw: data,
      };
    }
    case 'youtube': {
      const channel = data.items?.[0]?.snippet || {};
      const stats = data.items?.[0]?.statistics || {};
      return {
        provider_user_id: data.items?.[0]?.id || '',
        username: channel.customUrl || channel.title || '',
        display_name: channel.title || '',
        avatar_url: channel.thumbnails?.medium?.url || channel.thumbnails?.default?.url || '',
        profile_url: channel.customUrl ? `https://youtube.com/${channel.customUrl}` : '',
        bio: channel.description || '',
        location: channel.country || '',
        website: '',
        followers_count: parseInt(stats.subscriberCount) || 0,
        following_count: 0,
        posts_count: parseInt(stats.videoCount) || 0,
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
        bio: data.headline || '',
        location: data.locale ? `${data.locale.language}-${data.locale.country}` : '',
        website: '',
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        interests: [],
        raw: data,
      };
    case 'google':
      // Google userinfo (OpenID Connect) returns sub/email/name/picture.
      return {
        provider_user_id: data.sub || '',
        username: data.email || '',
        display_name: data.name || data.email || '',
        avatar_url: data.picture || '',
        profile_url: '',
        bio: '',
        location: data.locale || '',
        website: '',
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
        avatar_url: user.profile_image_url?.replace('_normal', '_400x400') || '',
        profile_url: user.username ? `https://x.com/${user.username}` : '',
        bio: user.description || '',
        location: user.location || '',
        website: user.url || '',
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
        profile_url: '', bio: '', location: '', website: '',
        followers_count: 0, following_count: 0,
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
// Profile Enrichment — the core value of social connect
// =============================================================================

/**
 * Comprehensive profile enrichment from a connected social account.
 *
 * Pulls everything useful and merges into Vitana profile:
 * 1. Avatar photo (if user has none)
 * 2. Display name (if user has none)
 * 3. Bio text (if user has none — merges from best source)
 * 4. Interests → auto-populates user_topic_profile
 * 5. Location (if detectable from profile)
 * 6. Social links (stored as memory facts)
 * 7. Social proof metrics (followers, posts)
 * 8. Recent media URLs (for potential profile gallery)
 * 9. All raw data stored for future enrichment passes
 */
export async function enrichProfileFromSocial(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
  connectionId: string,
): Promise<{ ok: boolean; enrichments: string[]; error?: string }> {
  const enrichments: string[] = [];

  const { data: conn } = await supabase
    .from('social_connections')
    .select('*')
    .eq('id', connectionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!conn || !conn.is_active) {
    return { ok: false, enrichments, error: 'Connection not found or inactive' };
  }

  await supabase.from('social_connections')
    .update({ enrichment_status: 'enriching', updated_at: new Date().toISOString() })
    .eq('id', connectionId);

  try {
    // ── 1. Fetch fresh profile ──────────────────────────────────
    const profile = await fetchSocialProfile(conn.provider, conn.access_token);
    if (!profile) {
      await supabase.from('social_connections')
        .update({ enrichment_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', connectionId);
      return { ok: false, enrichments, error: 'Failed to fetch social profile' };
    }

    // ── 2. Fetch media/content (provider-specific) ──────────────
    const media = await fetchProviderMedia(conn.provider, conn.access_token);

    // ── 3. Get current Vitana profile ───────────────────────────
    const { data: vitanaUser } = await supabase
      .from('app_users')
      .select('display_name, avatar_url, bio')
      .eq('user_id', userId)
      .maybeSingle();

    const profileUpdates: Record<string, string> = {};

    // ── 4. Enrich avatar ────────────────────────────────────────
    if (!vitanaUser?.avatar_url && profile.avatar_url) {
      profileUpdates.avatar_url = profile.avatar_url;
      enrichments.push('avatar');
    }

    // ── 5. Enrich display name ──────────────────────────────────
    if (!vitanaUser?.display_name && profile.display_name) {
      profileUpdates.display_name = profile.display_name;
      enrichments.push('display_name');
    }

    // ── 6. Enrich bio (pick best available) ─────────────────────
    if (!vitanaUser?.bio && profile.bio) {
      profileUpdates.bio = profile.bio.slice(0, 500);
      enrichments.push('bio');
    }

    // Apply profile updates
    if (Object.keys(profileUpdates).length > 0) {
      profileUpdates.updated_at = new Date().toISOString();
      await supabase.from('app_users').update(profileUpdates).eq('user_id', userId);
    }

    // ── 7. Store ALL scraped data as memory facts ───────────────
    // These feed the recommendation engine, matchmaking, and Maxina conversations
    const facts: Array<{ key: string; value: string }> = [];

    if (profile.bio) {
      facts.push({ key: `social_bio_${conn.provider}`, value: profile.bio.slice(0, 1000) });
    }
    if (profile.username) {
      facts.push({ key: `social_handle_${conn.provider}`, value: profile.username });
    }
    if (profile.profile_url) {
      facts.push({ key: `social_url_${conn.provider}`, value: profile.profile_url });
    }
    if (profile.followers_count > 0) {
      facts.push({ key: `social_followers_${conn.provider}`, value: String(profile.followers_count) });
    }
    if (profile.location) {
      facts.push({ key: 'location', value: profile.location });
      enrichments.push('location');
    }
    if (profile.website) {
      facts.push({ key: 'website', value: profile.website });
      enrichments.push('website');
    }

    for (const fact of facts) {
      await supabase.from('memory_facts').upsert({
        user_id: userId,
        key: fact.key,
        value: fact.value,
        source: `social_${conn.provider}`,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,key' });
    }
    if (facts.length > 0) enrichments.push('memory_facts');

    // ── 8. Extract interests and auto-populate topics ───────────
    const extractedTopics = extractInterestsFromProfile(profile, media);
    if (extractedTopics.length > 0) {
      for (const topic of extractedTopics) {
        await supabase.from('user_topic_profile').upsert({
          tenant_id: tenantId,
          user_id: userId,
          topic_key: topic.key,
          score: topic.score,
          source_weights: { [`social_${conn.provider}`]: topic.score },
          updated_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id,user_id,topic_key' });
      }
      enrichments.push(`topics:${extractedTopics.map(t => t.key).join(',')}`);
    }

    // ── 9. Store media URLs for gallery ─────────────────────────
    if (media.length > 0) {
      await supabase.from('memory_facts').upsert({
        user_id: userId,
        key: `social_media_${conn.provider}`,
        value: JSON.stringify(media.slice(0, 20)), // top 20 media items
        source: `social_${conn.provider}`,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,key' });
      enrichments.push(`media:${media.length}`);
    }

    // ── 10. Mark enrichment complete ────────────────────────────
    await supabase.from('social_connections').update({
      enrichment_status: 'completed',
      enrichment_data: {
        enrichments,
        profile_snapshot: {
          display_name: profile.display_name,
          bio: profile.bio?.slice(0, 200),
          followers: profile.followers_count,
          following: profile.following_count,
          posts: profile.posts_count,
          location: profile.location,
          website: profile.website,
          topics_extracted: extractedTopics.map(t => t.key),
          media_count: media.length,
        },
        enriched_at: new Date().toISOString(),
      },
      profile_data: profile.raw,
      last_enriched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', connectionId);

    console.log(`[SocialConnect] Enriched ${conn.provider} for ${userId.slice(0, 8)}…: ${enrichments.join(', ')}`);
    return { ok: true, enrichments };

  } catch (err: any) {
    await supabase.from('social_connections')
      .update({ enrichment_status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', connectionId);
    return { ok: false, enrichments, error: err.message };
  }
}

// =============================================================================
// Media Fetching — provider-specific content retrieval
// =============================================================================

interface MediaItem {
  type: 'image' | 'video' | 'post';
  url: string;
  thumbnail_url?: string;
  caption?: string;
  timestamp?: string;
}

async function fetchProviderMedia(
  provider: SocialProvider,
  accessToken: string,
): Promise<MediaItem[]> {
  try {
    switch (provider) {
      case 'instagram': {
        const resp = await fetch(
          `https://graph.instagram.com/me/media?fields=id,media_type,media_url,thumbnail_url,caption,timestamp&limit=20&access_token=${accessToken}`
        );
        if (!resp.ok) return [];
        const data = await resp.json() as any;
        return (data.data || []).map((m: any) => ({
          type: m.media_type === 'VIDEO' ? 'video' : 'image',
          url: m.media_url,
          thumbnail_url: m.thumbnail_url || m.media_url,
          caption: m.caption,
          timestamp: m.timestamp,
        }));
      }
      case 'youtube': {
        const resp = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video&maxResults=20&order=date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!resp.ok) return [];
        const data = await resp.json() as any;
        return (data.items || []).map((v: any) => ({
          type: 'video' as const,
          url: `https://youtube.com/watch?v=${v.id.videoId}`,
          thumbnail_url: v.snippet.thumbnails?.medium?.url,
          caption: v.snippet.title,
          timestamp: v.snippet.publishedAt,
        }));
      }
      case 'tiktok': {
        const resp = await fetch(
          `https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,create_time`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ max_count: 20 }),
          }
        );
        if (!resp.ok) return [];
        const data = await resp.json() as any;
        return (data.data?.videos || []).map((v: any) => ({
          type: 'video' as const,
          url: v.share_url || '',
          thumbnail_url: v.cover_image_url,
          caption: v.title,
          timestamp: v.create_time ? new Date(v.create_time * 1000).toISOString() : undefined,
        }));
      }
      case 'facebook': {
        const resp = await fetch(
          `https://graph.facebook.com/v19.0/me/photos?fields=images,name,created_time&limit=20&access_token=${accessToken}`
        );
        if (!resp.ok) return [];
        const data = await resp.json() as any;
        return (data.data || []).map((p: any) => ({
          type: 'image' as const,
          url: p.images?.[0]?.source || '',
          caption: p.name,
          timestamp: p.created_time,
        }));
      }
      // LinkedIn and Twitter don't easily expose media via basic API
      default:
        return [];
    }
  } catch (err) {
    console.warn(`[SocialConnect] Media fetch failed for ${provider}:`, err);
    return [];
  }
}

// =============================================================================
// Interest Extraction — turn social profile data into Vitana topics
// =============================================================================

/** Known topic keywords mapped to Vitana topic_keys */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  'wellness': ['wellness', 'wellbeing', 'well-being', 'self-care', 'selfcare', 'mindfulness'],
  'fitness': ['fitness', 'workout', 'gym', 'training', 'exercise', 'crossfit', 'running', 'marathon'],
  'yoga': ['yoga', 'pilates', 'meditation', 'zen', 'breathwork'],
  'nutrition': ['nutrition', 'diet', 'vegan', 'vegetarian', 'healthy eating', 'meal prep', 'food'],
  'mental-health': ['mental health', 'therapy', 'anxiety', 'depression', 'psychology', 'mindset'],
  'travel': ['travel', 'wanderlust', 'nomad', 'backpacking', 'adventure', 'exploring'],
  'music': ['music', 'musician', 'singer', 'guitar', 'piano', 'dj', 'producer', 'beats'],
  'art': ['art', 'artist', 'painting', 'drawing', 'illustration', 'creative', 'design'],
  'photography': ['photography', 'photographer', 'photo', 'camera', 'portrait', 'landscape'],
  'tech': ['tech', 'developer', 'coding', 'programming', 'startup', 'ai', 'software', 'engineer'],
  'business': ['business', 'entrepreneur', 'founder', 'ceo', 'marketing', 'growth', 'sales'],
  'cooking': ['cooking', 'chef', 'recipe', 'baking', 'kitchen', 'foodie'],
  'reading': ['reading', 'books', 'bookworm', 'literature', 'author', 'writing', 'writer'],
  'sports': ['sports', 'football', 'basketball', 'soccer', 'tennis', 'swimming', 'cycling'],
  'nature': ['nature', 'hiking', 'outdoors', 'camping', 'mountains', 'ocean', 'gardening'],
  'fashion': ['fashion', 'style', 'outfit', 'clothing', 'designer', 'beauty', 'makeup'],
  'parenting': ['parent', 'mom', 'dad', 'family', 'kids', 'children', 'motherhood', 'fatherhood'],
  'gaming': ['gaming', 'gamer', 'esports', 'twitch', 'streamer', 'playstation', 'xbox'],
  'spirituality': ['spiritual', 'faith', 'prayer', 'church', 'mosque', 'temple', 'soul'],
  'education': ['teacher', 'professor', 'education', 'learning', 'student', 'university', 'school'],
  'social-impact': ['nonprofit', 'charity', 'volunteer', 'activism', 'sustainability', 'climate', 'impact'],
  'pets': ['dog', 'cat', 'pet', 'puppy', 'kitten', 'animals', 'rescue'],
};

function extractInterestsFromProfile(
  profile: SocialProfile,
  media: MediaItem[],
): Array<{ key: string; score: number }> {
  const scores: Record<string, number> = {};

  // Scan bio text
  const bioLower = (profile.bio || '').toLowerCase();
  for (const [topicKey, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (bioLower.includes(kw)) {
        scores[topicKey] = (scores[topicKey] || 0) + 30;
      }
    }
  }

  // Scan media captions
  for (const item of media.slice(0, 20)) {
    const captionLower = (item.caption || '').toLowerCase();
    for (const [topicKey, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      for (const kw of keywords) {
        if (captionLower.includes(kw)) {
          scores[topicKey] = (scores[topicKey] || 0) + 5; // lighter weight per caption
        }
      }
    }
  }

  // Scan hashtags from captions
  const allText = [profile.bio || '', ...media.map(m => m.caption || '')].join(' ');
  const hashtags = allText.match(/#\w+/g) || [];
  for (const tag of hashtags) {
    const tagLower = tag.slice(1).toLowerCase();
    for (const [topicKey, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      for (const kw of keywords) {
        if (tagLower.includes(kw) || kw.includes(tagLower)) {
          scores[topicKey] = (scores[topicKey] || 0) + 10;
        }
      }
    }
  }

  // Normalize scores to 0-100 and return top matches
  const maxScore = Math.max(...Object.values(scores), 1);
  return Object.entries(scores)
    .filter(([_, score]) => score >= 10) // minimum threshold
    .map(([key, score]) => ({
      key,
      score: Math.min(Math.round((score / maxScore) * 80) + 20, 100), // scale to 20-100
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10); // max 10 topics per provider
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
