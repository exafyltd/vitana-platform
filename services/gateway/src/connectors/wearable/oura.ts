/**
 * VTID-02100: Oura direct connector (free personal OAuth2 integration).
 *
 * Best-in-class sleep + HRV + readiness data. No webhooks — polling via
 * fetchData on the scheduler.
 *
 * Env vars (register app at cloud.ouraring.com/oauth/applications):
 *   OURA_CLIENT_ID
 *   OURA_CLIENT_SECRET
 */

import type {
  Connector,
  ConnectorContext,
  FetchRequest,
  NormalizedEvent,
  OAuthExchangeResult,
  TokenPair,
  OAuthConfig,
} from '../types';
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshOAuth2Token } from '../runtime/oauth2';

const OAUTH_CONFIG: OAuthConfig = {
  authorize_url: 'https://cloud.ouraring.com/oauth/authorize',
  token_url: 'https://api.ouraring.com/oauth/token',
  scopes: ['personal', 'daily', 'heartrate', 'workout', 'session'],
  client_id_env: 'OURA_CLIENT_ID',
  client_secret_env: 'OURA_CLIENT_SECRET',
};

function ouraCreds(): { id: string; secret: string } | null {
  const id = process.env.OURA_CLIENT_ID;
  const secret = process.env.OURA_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { id, secret };
}

async function ouraGet<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(`https://api.ouraring.com/v2${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '(no body)');
    throw new Error(`Oura GET ${path} failed: ${resp.status} ${err}`);
  }
  return (await resp.json()) as T;
}

const ouraConnector: Connector = {
  id: 'oura',
  category: 'wearable',
  display_name: 'Oura Ring',
  auth_type: 'oauth2',
  capabilities: ['sleep.read', 'activity.read', 'hrv.read', 'readiness.read'],
  oauth: OAUTH_CONFIG,

  async initialize(): Promise<void> {
    if (!ouraCreds()) {
      console.warn('[oura] OURA_CLIENT_ID/SECRET not set — connector present but inactive');
    } else {
      console.log('[oura] connector ready');
    }
  },

  getOAuthUrl(state: string, redirect_uri: string): string {
    const creds = ouraCreds();
    if (!creds) throw new Error('OURA_CLIENT_ID not configured');
    return buildAuthorizeUrl(OAUTH_CONFIG, creds.id, redirect_uri, state);
  },

  async exchangeCode(code: string, redirect_uri: string): Promise<OAuthExchangeResult> {
    const creds = ouraCreds();
    if (!creds) throw new Error('OURA_CLIENT_ID not configured');
    const tokens = await exchangeCodeForTokens({
      config: OAUTH_CONFIG,
      code,
      client_id: creds.id,
      client_secret: creds.secret,
      redirect_uri,
    });
    // Fetch personal_info for profile
    try {
      const profile = await ouraGet<{ id?: string; age?: number; email?: string; weight?: number; height?: number }>(
        '/usercollection/personal_info',
        tokens.access_token
      );
      return {
        tokens,
        provider_user_id: profile.id,
        profile: {
          provider_user_id: profile.id ?? '',
          display_name: profile.email ?? 'Oura user',
          raw: profile as unknown as Record<string, unknown>,
        },
      };
    } catch {
      return { tokens };
    }
  },

  async refreshToken(refresh_token: string): Promise<TokenPair> {
    const creds = ouraCreds();
    if (!creds) throw new Error('OURA_CLIENT_ID not configured');
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
    const startDate = req.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = req.until ?? new Date().toISOString().slice(0, 10);

    if (req.stream === 'sleep') {
      interface OuraSleepResp {
        data?: Array<{
          id: string;
          day: string;
          bedtime_start: string;
          bedtime_end: string;
          total_sleep_duration: number;
          deep_sleep_duration: number;
          rem_sleep_duration: number;
          light_sleep_duration: number;
          awake_time: number;
          efficiency: number;
          average_heart_rate: number;
          average_hrv: number;
          lowest_heart_rate: number;
          respiratory_rate: number;
        }>;
      }
      const data = await ouraGet<OuraSleepResp>(
        `/usercollection/sleep?start_date=${startDate}&end_date=${endDate}`,
        tokens.access_token
      );
      return (data.data ?? []).map((s) => ({
        topic: 'connector.wearable.sleep.recorded',
        provider: 'oura',
        payload: {
          metric_date: s.day,
          sleep_minutes: Math.round((s.total_sleep_duration ?? 0) / 60),
          sleep_deep_minutes: Math.round((s.deep_sleep_duration ?? 0) / 60),
          sleep_rem_minutes: Math.round((s.rem_sleep_duration ?? 0) / 60),
          sleep_light_minutes: Math.round((s.light_sleep_duration ?? 0) / 60),
          sleep_awake_minutes: Math.round((s.awake_time ?? 0) / 60),
          sleep_start_time: s.bedtime_start,
          sleep_end_time: s.bedtime_end,
          sleep_efficiency_pct: s.efficiency,
          avg_hr: s.average_heart_rate,
          resting_hr: s.lowest_heart_rate,
          hrv_avg_ms: s.average_hrv,
          respiratory_rate: s.respiratory_rate,
        },
        raw: s as unknown as Record<string, unknown>,
      }));
    }

    if (req.stream === 'activity') {
      interface OuraActivityResp {
        data?: Array<{
          id: string;
          day: string;
          steps: number;
          active_calories: number;
          total_calories: number;
          equivalent_walking_distance: number;
          high_activity_time: number;
          medium_activity_time: number;
          low_activity_time: number;
          resting_time: number;
        }>;
      }
      const data = await ouraGet<OuraActivityResp>(
        `/usercollection/daily_activity?start_date=${startDate}&end_date=${endDate}`,
        tokens.access_token
      );
      return (data.data ?? []).map((a) => ({
        topic: 'connector.wearable.activity.recorded',
        provider: 'oura',
        payload: {
          metric_date: a.day,
          steps: a.steps,
          calories_burned: a.total_calories ?? a.active_calories,
          active_minutes: Math.round(((a.high_activity_time ?? 0) + (a.medium_activity_time ?? 0) + (a.low_activity_time ?? 0)) / 60),
          distance_meters: a.equivalent_walking_distance,
        },
        raw: a as unknown as Record<string, unknown>,
      }));
    }

    if (req.stream === 'workouts') {
      interface OuraWorkoutResp {
        data?: Array<{
          id: string;
          activity: string;
          start_datetime: string;
          end_datetime: string;
          calories: number;
          distance: number;
          heart_rate?: { average?: number; max?: number };
        }>;
      }
      const data = await ouraGet<OuraWorkoutResp>(
        `/usercollection/workout?start_date=${startDate}&end_date=${endDate}`,
        tokens.access_token
      );
      return (data.data ?? []).map((w) => ({
        topic: 'connector.wearable.workout.recorded',
        provider: 'oura',
        payload: {
          external_workout_id: w.id,
          workout_type: w.activity?.toLowerCase(),
          started_at: w.start_datetime,
          ended_at: w.end_datetime,
          duration_minutes: Math.round((new Date(w.end_datetime).getTime() - new Date(w.start_datetime).getTime()) / 60000),
          distance_meters: w.distance,
          calories: w.calories,
          avg_hr: w.heart_rate?.average,
          max_hr: w.heart_rate?.max,
        },
        raw: w as unknown as Record<string, unknown>,
      }));
    }

    return [];
  },
};

export default ouraConnector;
