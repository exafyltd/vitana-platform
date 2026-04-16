/**
 * VTID-02100: Vital connector — health aggregator (alternative to Terra).
 *
 * tryvital.io. Free tier: up to 100 connected users. Covers Apple Health
 * (via iOS SDK), Fitbit, Oura, Garmin, Whoop, Google Fit, Withings,
 * Polar, Peloton, Strava, Samsung Health + 10 more.
 *
 * Flow:
 *   (1) Server creates a "link token" for the user (POST /v2/link/token).
 *   (2) User is redirected to Vital Link widget where they pick the provider
 *       and authorize.
 *   (3) Vital fires webhooks for each data category (sleep, activity,
 *       workouts, body) — we normalize into wearable_daily_metrics.
 *
 * Env vars (set to activate):
 *   VITAL_API_KEY        — Bearer token for Vital API
 *   VITAL_WEBHOOK_SECRET — HMAC-SHA256 secret for webhook signature verify
 *   VITAL_ENVIRONMENT    — 'sandbox' (default) or 'production'
 *   VITAL_REGION         — 'us' (default) or 'eu'
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type {
  Connector,
  ConnectorContext,
  NormalizedEvent,
  WebhookRequest,
} from '../types';

function vitalBaseUrl(): string {
  const region = process.env.VITAL_REGION ?? 'us';
  const env = process.env.VITAL_ENVIRONMENT ?? 'sandbox';
  // Vital's URL pattern: https://api.{environment}.{region}.tryvital.io/v2
  return `https://api.${env}.${region}.tryvital.io/v2`;
}

function vitalHeaders(): Record<string, string> | null {
  const api_key = process.env.VITAL_API_KEY;
  if (!api_key) return null;
  return {
    'x-vital-api-key': api_key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function verifyVitalSignature(raw_body: string, sig_header: string | undefined): boolean {
  const secret = process.env.VITAL_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[vital] VITAL_WEBHOOK_SECRET not set — skipping signature verification (dev mode)');
    return true;
  }
  if (!sig_header) return false;

  // Vital uses SVIX for webhooks. Format: "v1,<base64sig> v1,<base64sig>..."
  // We accept any matching signature.
  const parts = sig_header.split(' ');
  const computed = createHmac('sha256', secret).update(raw_body).digest('base64');
  for (const p of parts) {
    const [scheme, sig] = p.split(',');
    if (scheme === 'v1' && sig) {
      const sigBuf = Buffer.from(sig);
      const computedBuf = Buffer.from(computed);
      if (sigBuf.length === computedBuf.length && timingSafeEqual(sigBuf, computedBuf)) {
        return true;
      }
    }
  }
  return false;
}

// ==================== Normalization ====================

interface VitalWebhookPayload {
  event_type?: string;          // 'sleep.created', 'activity.daily.created', 'workouts.created', ...
  data?: Record<string, unknown> | Record<string, unknown>[];
  user_id?: string;             // Vital's user_id
  client_user_id?: string;      // our user_id (reference)
  team_id?: string;
}

function normalizeSleep(record: Record<string, unknown>): Record<string, unknown> {
  // Vital sleep payload — v2 shape
  return {
    sleep_minutes: typeof record.duration === 'number' ? Math.round((record.duration as number) / 60) : null,
    sleep_deep_minutes: typeof record.deep === 'number' ? Math.round((record.deep as number) / 60) : null,
    sleep_rem_minutes: typeof record.rem === 'number' ? Math.round((record.rem as number) / 60) : null,
    sleep_light_minutes: typeof record.light === 'number' ? Math.round((record.light as number) / 60) : null,
    sleep_awake_minutes: typeof record.awake === 'number' ? Math.round((record.awake as number) / 60) : null,
    sleep_efficiency_pct: typeof record.efficiency === 'number' ? record.efficiency : null,
    sleep_start_time: typeof record.bedtime_start === 'string' ? record.bedtime_start : null,
    sleep_end_time: typeof record.bedtime_stop === 'string' ? record.bedtime_stop : null,
    avg_hr: typeof record.heart_rate_average === 'number' ? record.heart_rate_average : null,
    resting_hr: typeof record.heart_rate_minimum === 'number' ? record.heart_rate_minimum : null,
    max_hr: typeof record.heart_rate_maximum === 'number' ? record.heart_rate_maximum : null,
    hrv_avg_ms: typeof record.hrv_average === 'number' ? record.hrv_average : null,
    respiratory_rate: typeof record.respiratory_rate === 'number' ? record.respiratory_rate : null,
  };
}

function normalizeActivity(record: Record<string, unknown>): Record<string, unknown> {
  return {
    steps: typeof record.steps === 'number' ? record.steps : null,
    calories_burned: typeof record.calories_total === 'number' ? record.calories_total : null,
    active_minutes:
      typeof record.active_minutes === 'number'
        ? record.active_minutes
        : typeof record.daily_movement === 'number'
          ? Math.round((record.daily_movement as number) / 60)
          : null,
    distance_meters: typeof record.distance_meter === 'number' ? record.distance_meter : null,
    resting_hr: typeof record.heart_rate_resting === 'number' ? record.heart_rate_resting : null,
    avg_hr: typeof record.heart_rate_average === 'number' ? record.heart_rate_average : null,
    max_hr: typeof record.heart_rate_maximum === 'number' ? record.heart_rate_maximum : null,
  };
}

function normalizeWorkout(record: Record<string, unknown>): Record<string, unknown> {
  const start = typeof record.time_start === 'string' ? record.time_start : null;
  const end = typeof record.time_end === 'string' ? record.time_end : null;
  let duration_minutes: number | null = null;
  if (start && end) {
    duration_minutes = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  }
  return {
    external_workout_id: typeof record.id === 'string' ? record.id : null,
    workout_type: typeof record.sport === 'string' ? (record.sport as string).toLowerCase() : null,
    started_at: start,
    ended_at: end,
    duration_minutes,
    distance_meters: typeof record.distance_meter === 'number' ? record.distance_meter : null,
    calories: typeof record.calories === 'number' ? record.calories : null,
    avg_hr: typeof record.heart_rate_average === 'number' ? record.heart_rate_average : null,
    max_hr: typeof record.heart_rate_maximum === 'number' ? record.heart_rate_maximum : null,
  };
}

function extractDate(record: Record<string, unknown>): string | null {
  for (const key of ['calendar_date', 'date', 'bedtime_start', 'time_start']) {
    const v = record[key];
    if (typeof v === 'string') return v.slice(0, 10);
  }
  return null;
}

// ==================== Connector ====================

const vitalConnector: Connector = {
  id: 'vital',
  category: 'aggregator',
  display_name: 'Vital',
  auth_type: 'sdk_bridge',
  capabilities: ['sleep.read', 'activity.read', 'workouts.read', 'hr.read', 'hrv.read', 'body.read'],

  async initialize(): Promise<void> {
    if (!vitalHeaders()) {
      console.warn('[vital] VITAL_API_KEY not set — connector present but inactive');
    } else {
      console.log('[vital] connector ready', vitalBaseUrl());
    }
  },

  async generateWidgetUrl(ctx: ConnectorContext) {
    const headers = vitalHeaders();
    if (!headers) return null;
    const resp = await fetch(`${vitalBaseUrl()}/link/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id: ctx.user_id,
        // Default: let the user pick any supported provider via the widget
        redirect_url: process.env.VITAL_SUCCESS_URL ?? 'https://vitanaland.com/ecosystem?vital=success',
      }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '(no body)');
      throw new Error(`Vital link token failed: ${resp.status} ${err}`);
    }
    const data = (await resp.json()) as { link_token?: string };
    if (!data.link_token) throw new Error('Vital link_token missing');
    // Vital's hosted Link URL pattern — region-aware
    const region = process.env.VITAL_REGION ?? 'us';
    const env = process.env.VITAL_ENVIRONMENT ?? 'sandbox';
    const url = `https://link.${env}.tryvital.io/?token=${data.link_token}&region=${region}`;
    return { url, session_id: data.link_token };
  },

  async handleWebhook(req: WebhookRequest) {
    const raw_body = typeof req.body === 'string'
      ? req.body
      : Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : JSON.stringify(req.body);

    const sig_header = req.headers['svix-signature'] ?? req.headers['vital-signature'];
    const sigStr = Array.isArray(sig_header) ? sig_header[0] : sig_header;
    const valid = verifyVitalSignature(raw_body, sigStr);
    if (!valid) return { valid: false, events: [], error: 'signature_invalid' };

    let payload: VitalWebhookPayload;
    try {
      payload = typeof req.body === 'string' || Buffer.isBuffer(req.body)
        ? (JSON.parse(raw_body) as VitalWebhookPayload)
        : (req.body as VitalWebhookPayload);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, events: [], error: `invalid_json: ${message}` };
    }

    const eventType = (payload.event_type ?? '').toLowerCase();
    const records: Record<string, unknown>[] = Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>[])
      : payload.data
        ? [payload.data as Record<string, unknown>]
        : [];

    const userId = payload.client_user_id ?? payload.user_id ?? null;
    const events: NormalizedEvent[] = [];

    for (const record of records) {
      const metric_date = extractDate(record);
      const sourceProvider =
        typeof record.source === 'string' ? (record.source as string).toLowerCase() : 'vital';
      const base: Record<string, unknown> = {
        vital_user_id: payload.user_id,
        reference_id: payload.client_user_id,
        provider: sourceProvider,
        metric_date,
      };

      if (eventType.startsWith('sleep')) {
        events.push({
          topic: 'connector.wearable.sleep.recorded',
          user_id: userId ?? undefined,
          provider: sourceProvider,
          provider_event_type: eventType,
          payload: { ...base, ...normalizeSleep(record) },
          raw: record,
        });
      } else if (eventType.startsWith('activity') || eventType.startsWith('daily')) {
        events.push({
          topic: 'connector.wearable.activity.recorded',
          user_id: userId ?? undefined,
          provider: sourceProvider,
          provider_event_type: eventType,
          payload: { ...base, ...normalizeActivity(record) },
          raw: record,
        });
      } else if (eventType.startsWith('workouts')) {
        events.push({
          topic: 'connector.wearable.workout.recorded',
          user_id: userId ?? undefined,
          provider: sourceProvider,
          provider_event_type: eventType,
          payload: { ...base, ...normalizeWorkout(record) },
          raw: record,
        });
      } else if (eventType === 'historical.data.ready' || eventType === 'user.connected' || eventType.endsWith('.created')) {
        events.push({
          topic: 'connector.wearable.auth.completed',
          user_id: userId ?? undefined,
          provider: sourceProvider,
          provider_event_type: eventType,
          payload: base,
          raw: record,
        });
      } else if (eventType === 'user.disconnected' || eventType.endsWith('.deleted')) {
        events.push({
          topic: 'connector.wearable.auth.revoked',
          user_id: userId ?? undefined,
          provider: sourceProvider,
          provider_event_type: eventType,
          payload: base,
          raw: record,
        });
      } else {
        events.push({
          topic: 'connector.wearable.other',
          user_id: userId ?? undefined,
          provider: sourceProvider,
          provider_event_type: eventType,
          payload: base,
          raw: record,
        });
      }
    }

    return { valid: true, events };
  },
};

export default vitalConnector;
