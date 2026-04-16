/**
 * VTID-02100: Terra connector — health data aggregator.
 *
 * Terra exposes ~20 wearable providers (Apple Health, Fitbit, Oura, Garmin,
 * Whoop, Google Fit, Samsung Health, Strava, MyFitnessPal, Polar, Withings,
 * Peloton, ...) through a single API.
 *
 * Two flows:
 *   (1) Terra "widget" — hosted HTML the user sees to pick their wearable and
 *       authorize. Works in-browser for Fitbit/Garmin/Oura/Whoop/Google Fit/etc.
 *   (2) Terra iOS SDK — embedded in our vitana-ios-companion app for Apple
 *       Health + Apple Watch (HealthKit can't be reached from a WebView).
 *
 * Both flows produce the same webhook payloads that this connector normalizes
 * into our wearable_daily_metrics + wearable_workouts tables.
 *
 * Env vars (all optional until Terra is enabled):
 *   TERRA_API_KEY       — x-api-key header for Terra API
 *   TERRA_DEV_ID        — dev-id header
 *   TERRA_WEBHOOK_SECRET — used to verify webhook signatures (HMAC-SHA256)
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type {
  Connector,
  ConnectorContext,
  NormalizedEvent,
  WebhookRequest,
  TokenPair,
  FetchRequest,
} from '../types';

const TERRA_API_BASE = 'https://api.tryterra.co/v2';

function getTerraCreds(): { api_key: string; dev_id: string } | null {
  const api_key = process.env.TERRA_API_KEY;
  const dev_id = process.env.TERRA_DEV_ID;
  if (!api_key || !dev_id) return null;
  return { api_key, dev_id };
}

function terraHeaders(): Record<string, string> | null {
  const creds = getTerraCreds();
  if (!creds) return null;
  return {
    'x-api-key': creds.api_key,
    'dev-id': creds.dev_id,
    'Content-Type': 'application/json',
  };
}

function verifyTerraSignature(raw_body: string, signature_header: string | undefined): boolean {
  const secret = process.env.TERRA_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[terra] TERRA_WEBHOOK_SECRET not set — skipping signature verification');
    return true; // dev mode
  }
  if (!signature_header) return false;

  // Terra signature header format: "t=<timestamp>,v1=<hmac-sha256-hex>"
  const parts = signature_header.split(',').reduce((acc, kv) => {
    const [k, v] = kv.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {} as Record<string, string>);

  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return false;

  const signedPayload = `${timestamp}.${raw_body}`;
  const computed = createHmac('sha256', secret).update(signedPayload).digest('hex');

  if (computed.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
}

// ==================== Normalization helpers ====================

interface TerraWebhookPayload {
  type?: string; // 'auth' | 'deauth' | 'sleep' | 'activity' | 'daily' | 'body' | 'workout'
  user?: { user_id?: string; reference_id?: string; provider?: string };
  data?: unknown[] | Record<string, unknown>;
}

function extractUserKeys(payload: TerraWebhookPayload): {
  terra_user_id: string | undefined;
  reference_id: string | undefined;
  provider: string | undefined;
} {
  const u = payload.user;
  return {
    terra_user_id: u?.user_id,
    reference_id: u?.reference_id,
    provider: u?.provider?.toLowerCase(),
  };
}

function normalizeSleepRecord(record: Record<string, unknown>): Record<string, unknown> {
  const metadata = (record.metadata as Record<string, unknown>) ?? {};
  const sleep_durations_data = (record.sleep_durations_data as Record<string, unknown>) ?? {};
  const asleep = (sleep_durations_data.asleep as Record<string, unknown>) ?? {};
  const awake = (sleep_durations_data.awake as Record<string, unknown>) ?? {};
  const durations = {
    total: typeof asleep.duration_asleep_state_seconds === 'number'
      ? Math.round((asleep.duration_asleep_state_seconds as number) / 60)
      : null,
    deep: typeof asleep.duration_deep_sleep_state_seconds === 'number'
      ? Math.round((asleep.duration_deep_sleep_state_seconds as number) / 60)
      : null,
    rem: typeof asleep.duration_REM_sleep_state_seconds === 'number'
      ? Math.round((asleep.duration_REM_sleep_state_seconds as number) / 60)
      : null,
    light: typeof asleep.duration_light_sleep_state_seconds === 'number'
      ? Math.round((asleep.duration_light_sleep_state_seconds as number) / 60)
      : null,
    awake_min: typeof awake.duration_short_interruption_state_seconds === 'number'
      ? Math.round((awake.duration_short_interruption_state_seconds as number) / 60)
      : null,
  };

  const heart_rate_data = (record.heart_rate_data as Record<string, unknown>) ?? {};
  const summary = (heart_rate_data.summary as Record<string, unknown>) ?? {};
  const hrv_data = (record.heart_rate_data_hrv as Record<string, unknown>) ??
    (record.hrv_data as Record<string, unknown>) ?? {};
  const hrv_summary = (hrv_data.summary as Record<string, unknown>) ?? {};

  return {
    sleep_minutes: durations.total,
    sleep_deep_minutes: durations.deep,
    sleep_rem_minutes: durations.rem,
    sleep_light_minutes: durations.light,
    sleep_awake_minutes: durations.awake_min,
    sleep_start_time: typeof metadata.start_time === 'string' ? metadata.start_time : null,
    sleep_end_time: typeof metadata.end_time === 'string' ? metadata.end_time : null,
    sleep_efficiency_pct: typeof record.efficiency === 'number' ? record.efficiency : null,
    avg_hr: typeof summary.avg_hr_bpm === 'number' ? summary.avg_hr_bpm : null,
    max_hr: typeof summary.max_hr_bpm === 'number' ? summary.max_hr_bpm : null,
    resting_hr: typeof summary.resting_hr_bpm === 'number' ? summary.resting_hr_bpm : null,
    hrv_avg_ms: typeof hrv_summary.avg_hrv_sdnn === 'number' ? hrv_summary.avg_hrv_sdnn : null,
    hrv_rmssd_ms: typeof hrv_summary.avg_hrv_rmssd === 'number' ? hrv_summary.avg_hrv_rmssd : null,
  };
}

function normalizeDailyOrActivity(record: Record<string, unknown>): Record<string, unknown> {
  const distance = (record.distance_data as Record<string, unknown>) ?? {};
  const active = (record.active_durations_data as Record<string, unknown>) ?? {};
  const heart = (record.heart_rate_data as Record<string, unknown>) ?? {};
  const heartSummary = (heart.summary as Record<string, unknown>) ?? {};
  const metabolism = (record.calories_data as Record<string, unknown>) ?? {};

  return {
    steps: typeof distance.steps === 'number' ? distance.steps : null,
    distance_meters: typeof distance.distance_meters === 'number' ? distance.distance_meters : null,
    active_minutes: typeof active.activity_seconds === 'number'
      ? Math.round((active.activity_seconds as number) / 60)
      : null,
    calories_burned: typeof metabolism.total_burned_calories === 'number'
      ? metabolism.total_burned_calories
      : null,
    resting_hr: typeof heartSummary.resting_hr_bpm === 'number' ? heartSummary.resting_hr_bpm : null,
    avg_hr: typeof heartSummary.avg_hr_bpm === 'number' ? heartSummary.avg_hr_bpm : null,
    max_hr: typeof heartSummary.max_hr_bpm === 'number' ? heartSummary.max_hr_bpm : null,
  };
}

function normalizeWorkoutRecord(record: Record<string, unknown>): Record<string, unknown> {
  const metadata = (record.metadata as Record<string, unknown>) ?? {};
  const distance = (record.distance_data as Record<string, unknown>) ?? {};
  const heart = (record.heart_rate_data as Record<string, unknown>) ?? {};
  const heartSummary = (heart.summary as Record<string, unknown>) ?? {};
  const metabolism = (record.calories_data as Record<string, unknown>) ?? {};

  const start_time = typeof metadata.start_time === 'string' ? (metadata.start_time as string) : null;
  const end_time = typeof metadata.end_time === 'string' ? (metadata.end_time as string) : null;
  let duration_minutes: number | null = null;
  if (start_time && end_time) {
    duration_minutes = Math.round(
      (new Date(end_time).getTime() - new Date(start_time).getTime()) / 60000
    );
  }

  return {
    external_workout_id: typeof metadata.summary_id === 'string' ? metadata.summary_id : null,
    workout_type: typeof metadata.type === 'string' ? metadata.type.toLowerCase() : null,
    started_at: start_time,
    ended_at: end_time,
    duration_minutes,
    distance_meters: typeof distance.distance_meters === 'number' ? distance.distance_meters : null,
    calories: typeof metabolism.total_burned_calories === 'number' ? metabolism.total_burned_calories : null,
    avg_hr: typeof heartSummary.avg_hr_bpm === 'number' ? heartSummary.avg_hr_bpm : null,
    max_hr: typeof heartSummary.max_hr_bpm === 'number' ? heartSummary.max_hr_bpm : null,
  };
}

function extractMetricDate(record: Record<string, unknown>): string | null {
  const metadata = (record.metadata as Record<string, unknown>) ?? {};
  const start = metadata.start_time;
  if (typeof start === 'string') return start.slice(0, 10);
  const end = metadata.end_time;
  if (typeof end === 'string') return end.slice(0, 10);
  return null;
}

// ==================== Connector ====================

const terraConnector: Connector = {
  id: 'terra',
  category: 'aggregator',
  display_name: 'Terra',
  auth_type: 'sdk_bridge', // Terra's own hosted widget + iOS SDK handle auth
  capabilities: ['sleep.read', 'activity.read', 'workouts.read', 'hr.read', 'hrv.read', 'body.read'],

  async initialize(): Promise<void> {
    if (!getTerraCreds()) {
      console.warn('[terra] TERRA_API_KEY / TERRA_DEV_ID not set — connector present but inactive');
    } else {
      console.log('[terra] connector ready');
    }
  },

  async generateWidgetUrl(ctx: ConnectorContext) {
    const headers = terraHeaders();
    if (!headers) return null;
    const resp = await fetch(`${TERRA_API_BASE}/auth/generateWidgetSession`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reference_id: ctx.user_id,
        providers: 'FITBIT,OURA,GARMIN,WHOOP,GOOGLE,SAMSUNG,APPLE,STRAVA,MYFITNESSPAL,POLAR,WITHINGS,PELOTON',
        language: 'en',
        auth_success_redirect_url: process.env.TERRA_SUCCESS_URL ?? 'https://vitanaland.com/ecosystem?terra=success',
        auth_failure_redirect_url: process.env.TERRA_FAILURE_URL ?? 'https://vitanaland.com/ecosystem?terra=failure',
      }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '(no body)');
      throw new Error(`Terra widget session failed: ${resp.status} ${err}`);
    }
    const data = (await resp.json()) as { url?: string; session_id?: string };
    if (!data.url || !data.session_id) throw new Error('Terra widget session missing url/session_id');
    return { url: data.url, session_id: data.session_id };
  },

  async fetchData(
    _ctx: ConnectorContext,
    _tokens: TokenPair,
    req: FetchRequest
  ): Promise<NormalizedEvent[]> {
    // Phase 1: primary sync happens via webhooks. On-demand fetch left as stub.
    console.log('[terra] fetchData stream=%s — not yet implemented (webhook-driven)', req.stream);
    return [];
  },

  async handleWebhook(req: WebhookRequest) {
    const raw_body = typeof req.body === 'string'
      ? req.body
      : Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : JSON.stringify(req.body);

    const sig_header = req.headers['terra-signature'] ?? req.headers['Terra-Signature'];
    const sigStr = Array.isArray(sig_header) ? sig_header[0] : sig_header;
    const valid = verifyTerraSignature(raw_body, sigStr);
    if (!valid) {
      return { valid: false, events: [], error: 'signature_invalid' };
    }

    let payload: TerraWebhookPayload;
    try {
      payload = typeof req.body === 'string' || Buffer.isBuffer(req.body)
        ? (JSON.parse(raw_body) as TerraWebhookPayload)
        : (req.body as TerraWebhookPayload);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, events: [], error: `invalid_json: ${message}` };
    }

    const { terra_user_id, reference_id, provider } = extractUserKeys(payload);
    const eventType = (payload.type ?? 'unknown').toLowerCase();
    const records: Record<string, unknown>[] = Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>[])
      : payload.data
        ? [payload.data as Record<string, unknown>]
        : [];

    const events: NormalizedEvent[] = [];

    for (const record of records) {
      const date = extractMetricDate(record);
      const commonPayload: Record<string, unknown> = {
        terra_user_id,
        reference_id,
        provider,
        metric_date: date,
      };

      switch (eventType) {
        case 'sleep':
          events.push({
            topic: 'connector.wearable.sleep.recorded',
            user_id: reference_id,
            provider: provider ?? 'terra',
            provider_event_type: eventType,
            payload: { ...commonPayload, ...normalizeSleepRecord(record) },
            raw: record,
          });
          break;
        case 'daily':
        case 'activity':
          events.push({
            topic: 'connector.wearable.activity.recorded',
            user_id: reference_id,
            provider: provider ?? 'terra',
            provider_event_type: eventType,
            payload: { ...commonPayload, ...normalizeDailyOrActivity(record) },
            raw: record,
          });
          break;
        case 'workout':
        case 'athlete':
          events.push({
            topic: 'connector.wearable.workout.recorded',
            user_id: reference_id,
            provider: provider ?? 'terra',
            provider_event_type: eventType,
            payload: { ...commonPayload, ...normalizeWorkoutRecord(record) },
            raw: record,
          });
          break;
        case 'auth':
          events.push({
            topic: 'connector.wearable.auth.completed',
            user_id: reference_id,
            provider: provider ?? 'terra',
            provider_event_type: eventType,
            payload: { ...commonPayload },
            raw: record,
          });
          break;
        case 'deauth':
          events.push({
            topic: 'connector.wearable.auth.revoked',
            user_id: reference_id,
            provider: provider ?? 'terra',
            provider_event_type: eventType,
            payload: { ...commonPayload },
            raw: record,
          });
          break;
        default:
          events.push({
            topic: 'connector.wearable.other',
            user_id: reference_id,
            provider: provider ?? 'terra',
            provider_event_type: eventType,
            payload: commonPayload,
            raw: record,
          });
      }
    }

    return { valid: true, events };
  },
};

export default terraConnector;
