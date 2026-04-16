/**
 * VTID-02100: Fitbit direct connector (free, no aggregator).
 *
 * OAuth2 Authorization Code + PKCE flow. Data fetched on-demand via fetchData
 * (polling) — Fitbit subscriptions webhook integration deferred.
 *
 * Env vars (register app at dev.fitbit.com):
 *   FITBIT_CLIENT_ID
 *   FITBIT_CLIENT_SECRET
 */

import type {
  Connector,
  ConnectorContext,
  FetchRequest,
  NormalizedEvent,
  NormalizedProfile,
  OAuthExchangeResult,
  TokenPair,
  OAuthConfig,
} from '../types';
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshOAuth2Token } from '../runtime/oauth2';

const OAUTH_CONFIG: OAuthConfig = {
  authorize_url: 'https://www.fitbit.com/oauth2/authorize',
  token_url: 'https://api.fitbit.com/oauth2/token',
  scopes: ['sleep', 'activity', 'heartrate', 'profile', 'weight'],
  client_id_env: 'FITBIT_CLIENT_ID',
  client_secret_env: 'FITBIT_CLIENT_SECRET',
};

function fitbitCreds(): { id: string; secret: string } | null {
  const id = process.env.FITBIT_CLIENT_ID;
  const secret = process.env.FITBIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { id, secret };
}

function basicAuthHeader(id: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

async function fitbitGet<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(`https://api.fitbit.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '(no body)');
    throw new Error(`Fitbit GET ${path} failed: ${resp.status} ${err}`);
  }
  return (await resp.json()) as T;
}

const fitbitConnector: Connector = {
  id: 'fitbit',
  category: 'wearable',
  display_name: 'Fitbit',
  auth_type: 'oauth2',
  capabilities: ['sleep.read', 'activity.read', 'hr.read', 'profile.read'],
  oauth: OAUTH_CONFIG,

  async initialize(): Promise<void> {
    if (!fitbitCreds()) {
      console.warn('[fitbit] FITBIT_CLIENT_ID/SECRET not set — connector present but inactive');
    } else {
      console.log('[fitbit] connector ready');
    }
  },

  getOAuthUrl(state: string, redirect_uri: string): string {
    const creds = fitbitCreds();
    if (!creds) throw new Error('FITBIT_CLIENT_ID not configured');
    return buildAuthorizeUrl(OAUTH_CONFIG, creds.id, redirect_uri, state);
  },

  async exchangeCode(code: string, redirect_uri: string): Promise<OAuthExchangeResult> {
    const creds = fitbitCreds();
    if (!creds) throw new Error('FITBIT_CLIENT_ID not configured');

    // Fitbit requires Basic auth on token endpoint, not client_id/secret in body
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri,
      client_id: creds.id,
    });
    const resp = await fetch(OAUTH_CONFIG.token_url, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(creds.id, creds.secret),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '(no body)');
      throw new Error(`Fitbit token exchange failed: ${resp.status} ${err}`);
    }
    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
      user_id: string;
    };
    const tokens: TokenPair = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      scopes_granted: data.scope.split(' '),
    };
    // Fetch profile for display_name + avatar
    let profile: NormalizedProfile | undefined;
    try {
      const p = await fitbitGet<{ user: { encodedId: string; displayName: string; avatar: string } }>(
        '/1/user/-/profile.json',
        tokens.access_token
      );
      profile = {
        provider_user_id: p.user.encodedId,
        display_name: p.user.displayName,
        avatar_url: p.user.avatar,
        profile_url: `https://www.fitbit.com/user/${p.user.encodedId}`,
        raw: p.user as unknown as Record<string, unknown>,
      };
    } catch {
      // non-fatal
    }
    return { tokens, provider_user_id: data.user_id, profile };
  },

  async refreshToken(refresh_token: string): Promise<TokenPair> {
    const creds = fitbitCreds();
    if (!creds) throw new Error('FITBIT_CLIENT_ID not configured');
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
    const date = req.since ?? new Date().toISOString().slice(0, 10);

    if (req.stream === 'sleep') {
      interface FitbitSleepResp {
        sleep?: Array<{
          startTime: string;
          endTime: string;
          duration: number;
          efficiency: number;
          minutesAsleep: number;
          minutesAwake: number;
          levels?: { summary?: Record<string, { minutes: number }> };
        }>;
      }
      const data = await fitbitGet<FitbitSleepResp>(`/1.2/user/-/sleep/date/${date}.json`, tokens.access_token);
      return (data.sleep ?? []).map((s) => ({
        topic: 'connector.wearable.sleep.recorded',
        provider: 'fitbit',
        payload: {
          metric_date: date,
          sleep_minutes: s.minutesAsleep,
          sleep_awake_minutes: s.minutesAwake,
          sleep_deep_minutes: s.levels?.summary?.deep?.minutes ?? null,
          sleep_rem_minutes: s.levels?.summary?.rem?.minutes ?? null,
          sleep_light_minutes: s.levels?.summary?.light?.minutes ?? null,
          sleep_start_time: s.startTime,
          sleep_end_time: s.endTime,
          sleep_efficiency_pct: s.efficiency,
        },
        raw: s as unknown as Record<string, unknown>,
      }));
    }

    if (req.stream === 'activity') {
      interface FitbitActivityResp {
        summary?: {
          steps?: number;
          caloriesOut?: number;
          restingHeartRate?: number;
          distances?: Array<{ activity: string; distance: number }>;
          veryActiveMinutes?: number;
          fairlyActiveMinutes?: number;
          lightlyActiveMinutes?: number;
        };
      }
      const data = await fitbitGet<FitbitActivityResp>(
        `/1/user/-/activities/date/${date}.json`,
        tokens.access_token
      );
      const s = data.summary ?? {};
      const active =
        (s.veryActiveMinutes ?? 0) + (s.fairlyActiveMinutes ?? 0) + (s.lightlyActiveMinutes ?? 0);
      const total = s.distances?.find((d) => d.activity === 'total');
      return [
        {
          topic: 'connector.wearable.activity.recorded',
          provider: 'fitbit',
          payload: {
            metric_date: date,
            steps: s.steps,
            calories_burned: s.caloriesOut,
            resting_hr: s.restingHeartRate,
            active_minutes: active,
            distance_meters: total ? Math.round(total.distance * 1000) : null,
          },
          raw: data as unknown as Record<string, unknown>,
        },
      ];
    }

    console.log(`[fitbit] fetchData stream=${req.stream} not implemented yet`);
    return [];
  },
};

export default fitbitConnector;
