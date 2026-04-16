/**
 * VTID-02100: Strava direct connector (free, OAuth2 + webhook subscription).
 *
 * Workout-focused. Good for runners/cyclists/swimmers.
 *
 * Env vars (register at strava.com/settings/api):
 *   STRAVA_CLIENT_ID
 *   STRAVA_CLIENT_SECRET
 *   STRAVA_WEBHOOK_VERIFY_TOKEN — any random string; must match the token set
 *                                 when registering a subscription via POST
 *                                 /api/v3/push_subscriptions
 */

import type {
  Connector,
  ConnectorContext,
  FetchRequest,
  NormalizedEvent,
  OAuthExchangeResult,
  TokenPair,
  WebhookRequest,
  OAuthConfig,
} from '../types';
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshOAuth2Token } from '../runtime/oauth2';

const OAUTH_CONFIG: OAuthConfig = {
  authorize_url: 'https://www.strava.com/oauth/authorize',
  token_url: 'https://www.strava.com/oauth/token',
  scopes: ['read', 'activity:read_all', 'profile:read_all'],
  client_id_env: 'STRAVA_CLIENT_ID',
  client_secret_env: 'STRAVA_CLIENT_SECRET',
  extra_authorize_params: { approval_prompt: 'auto' },
};

function stravaCreds(): { id: string; secret: string } | null {
  const id = process.env.STRAVA_CLIENT_ID;
  const secret = process.env.STRAVA_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { id, secret };
}

async function stravaGet<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '(no body)');
    throw new Error(`Strava GET ${path} failed: ${resp.status} ${err}`);
  }
  return (await resp.json()) as T;
}

const stravaConnector: Connector = {
  id: 'strava',
  category: 'wearable',
  display_name: 'Strava',
  auth_type: 'oauth2',
  capabilities: ['workouts.read', 'activity.read', 'profile.read'],
  oauth: OAUTH_CONFIG,

  async initialize(): Promise<void> {
    if (!stravaCreds()) {
      console.warn('[strava] STRAVA_CLIENT_ID/SECRET not set — connector present but inactive');
    } else {
      console.log('[strava] connector ready');
    }
  },

  getOAuthUrl(state: string, redirect_uri: string): string {
    const creds = stravaCreds();
    if (!creds) throw new Error('STRAVA_CLIENT_ID not configured');
    return buildAuthorizeUrl(OAUTH_CONFIG, creds.id, redirect_uri, state);
  },

  async exchangeCode(code: string, redirect_uri: string): Promise<OAuthExchangeResult> {
    const creds = stravaCreds();
    if (!creds) throw new Error('STRAVA_CLIENT_ID not configured');
    const tokens = await exchangeCodeForTokens({
      config: OAUTH_CONFIG,
      code,
      client_id: creds.id,
      client_secret: creds.secret,
      redirect_uri,
    });
    // Strava returns athlete object in the same token response — our helper
    // doesn't surface it, so fetch separately.
    try {
      const athlete = await stravaGet<{
        id: number;
        username?: string;
        firstname?: string;
        lastname?: string;
        profile?: string;
      }>('/athlete', tokens.access_token);
      return {
        tokens,
        provider_user_id: String(athlete.id),
        profile: {
          provider_user_id: String(athlete.id),
          provider_username: athlete.username,
          display_name: [athlete.firstname, athlete.lastname].filter(Boolean).join(' '),
          avatar_url: athlete.profile,
          profile_url: `https://www.strava.com/athletes/${athlete.id}`,
          raw: athlete as unknown as Record<string, unknown>,
        },
      };
    } catch {
      return { tokens };
    }
  },

  async refreshToken(refresh_token: string): Promise<TokenPair> {
    const creds = stravaCreds();
    if (!creds) throw new Error('STRAVA_CLIENT_ID not configured');
    return refreshOAuth2Token({
      config: OAUTH_CONFIG,
      refresh_token,
      client_id: creds.id,
      client_secret: creds.secret,
    });
  },

  async fetchData(
    _ctx: ConnectorContext,
    tokens: TokenPair,
    req: FetchRequest
  ): Promise<NormalizedEvent[]> {
    if (req.stream === 'workouts') {
      const after = req.since
        ? Math.floor(new Date(req.since).getTime() / 1000)
        : Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
      interface StravaActivity {
        id: number;
        type: string;
        sport_type?: string;
        start_date: string;
        elapsed_time: number;
        moving_time: number;
        distance: number;
        calories?: number;
        average_heartrate?: number;
        max_heartrate?: number;
      }
      const data = await stravaGet<StravaActivity[]>(
        `/athlete/activities?after=${after}&per_page=50`,
        tokens.access_token
      );
      return data.map((a) => {
        const end = new Date(new Date(a.start_date).getTime() + a.elapsed_time * 1000).toISOString();
        return {
          topic: 'connector.wearable.workout.recorded',
          provider: 'strava',
          payload: {
            external_workout_id: String(a.id),
            workout_type: (a.sport_type ?? a.type)?.toLowerCase(),
            started_at: a.start_date,
            ended_at: end,
            duration_minutes: Math.round(a.moving_time / 60),
            distance_meters: Math.round(a.distance),
            calories: a.calories,
            avg_hr: a.average_heartrate,
            max_hr: a.max_heartrate,
          },
          raw: a as unknown as Record<string, unknown>,
        };
      });
    }
    return [];
  },

  async handleWebhook(req: WebhookRequest) {
    // Strava webhook payloads are simple JSON; Strava does NOT sign them.
    // Security: the webhook URL should be kept private + verify_token used
    // only at subscription creation.
    const raw_body = typeof req.body === 'string'
      ? req.body
      : Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : JSON.stringify(req.body);

    let payload: { object_type?: string; object_id?: number; aspect_type?: string; owner_id?: number; updates?: Record<string, unknown> };
    try {
      payload = typeof req.body === 'object' && !Buffer.isBuffer(req.body)
        ? (req.body as typeof payload)
        : JSON.parse(raw_body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, events: [], error: `invalid_json: ${message}` };
    }

    // Webhook only fires a notification — we'd need to fetch the full activity
    // via the stored token. For Phase 1 MVP, emit a "pending sync" event so
    // a downstream worker can pull it.
    const events: NormalizedEvent[] = [];
    if (payload.object_type === 'activity' && payload.aspect_type === 'create') {
      events.push({
        topic: 'connector.wearable.other',
        provider: 'strava',
        provider_event_type: 'activity.create',
        payload: {
          strava_activity_id: payload.object_id,
          strava_owner_id: payload.owner_id,
          note: 'Full fetch required via fetchData(stream=workouts)',
        },
      });
    }
    return { valid: true, events };
  },
};

export default stravaConnector;
