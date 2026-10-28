/**
 * VTID-02100: Generic connector webhook receiver.
 *
 * POST /api/v1/connectors/webhook/:connectorId
 *
 * Delegates signature verification + payload parsing to the connector's
 * handleWebhook(). Normalized events are persisted (wearable tables),
 * mirrored to OASIS, and the raw webhook is logged for audit.
 *
 * No auth — webhooks come from third parties. Security is via HMAC
 * signature, verified over the RAW body (index.ts mounts express.raw on
 * /api/v1/connectors/webhook) by connectors/runtime/webhook-signature.ts.
 * Every verifier fails closed when its secret is unset (VTID-05031).
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { getConnector } from '../connectors';
import { emitOasisEvent } from '../services/oasis-event-service';
import * as repo from './connector-webhooks-repository';
import { dualWriteUserConnections } from '../services/health-sources/legacy-mirror';
import { bridgeWearableDays, isWearableFeatureBridgeEnabled, utcDateOf } from '../services/wearable-features-bridge';

const router = Router();

router.post('/webhook/:connectorId', async (req: Request, res: Response) => {
  const connectorId = req.params.connectorId;
  const connector = getConnector(connectorId);
  const supabase = getSupabase();

  // Always capture the raw webhook for audit (even if unrecognized)
  const rawBody = typeof req.body === 'string'
    ? req.body
    : Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : JSON.stringify(req.body ?? {});

  let parsedPayload: unknown;
  try {
    parsedPayload = typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? req.body
      : JSON.parse(rawBody);
  } catch {
    parsedPayload = { raw: rawBody };
  }

  if (!connector) {
    if (supabase) {
      await repo.insertConnectorWebhookLog(supabase, {
        connector_id: connectorId,
        event_type: 'unknown_connector',
        signature_valid: false,
        processed: false,
        process_error: 'Connector not registered',
        payload: parsedPayload as object,
      });
    }
    return res.status(404).json({ ok: false, error: `Unknown connector: ${connectorId}` });
  }

  if (!connector.handleWebhook) {
    return res.status(501).json({ ok: false, error: `${connector.display_name} does not handle webhooks` });
  }

  // Normalize headers to record shape
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v as string | string[] | undefined;

  let result: Awaited<ReturnType<NonNullable<typeof connector.handleWebhook>>>;
  try {
    result = await connector.handleWebhook({ headers, body: rawBody, raw_body: rawBody });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (supabase) {
      await repo.insertConnectorWebhookLog(supabase, {
        connector_id: connectorId,
        event_type: 'handler_error',
        signature_valid: null,
        processed: false,
        process_error: message,
        payload: parsedPayload as object,
      });
    }
    // VTID-05031: the exception text stays in the audit row, never in the response.
    return res.status(500).json({ ok: false, error: 'handler_error' });
  }

  if (!result.valid) {
    if (supabase) {
      await repo.insertConnectorWebhookLog(supabase, {
        connector_id: connectorId,
        event_type: 'invalid',
        signature_valid: false,
        processed: false,
        process_error: result.error ?? 'invalid',
        payload: parsedPayload as object,
      });
    }
    return res.status(401).json({ ok: false, error: result.error ?? 'invalid webhook' });
  }

  // Persist normalized events
  let persisted = 0;
  let skipped = 0;
  // VTID-05089: member-days whose wearable rows persisted without error,
  // bridged into health_features_daily once per user after the loop.
  const bridgeTargets = new Map<string, { tenantId: string; dates: Set<string> }>();
  const noteBridgeDay = (uid: string, tid: string, date: string | null) => {
    if (!date) return;
    const t = bridgeTargets.get(uid) ?? { tenantId: tid, dates: new Set<string>() };
    t.dates.add(date);
    bridgeTargets.set(uid, t);
  };
  for (const event of result.events) {
    const userId = event.user_id ?? null;
    try {
      if (!supabase || !userId) {
        skipped++;
        continue;
      }

      // Find or create user_connection row
      let userConnectionId: string | null = null;
      const { data: conn, error: connErr } = await repo.fetchUserConnectionForWebhook(supabase, userId, connector.id);
      if (connErr) {
        // A real DB error here must NOT be treated the same as "no
        // connection row" — that silently drops tenantId, which makes every
        // downstream `if (tenantId)` upsert (sleep/activity/workout data) a
        // silent no-op while `persisted++` below still counts the event and
        // the webhook acks 200, so the provider never retries. Throw so the
        // existing per-event catch below counts it as skipped instead.
        throw connErr;
      }
      if (conn) userConnectionId = conn.id;
      const tenantId = conn?.tenant_id;

      // On auth.completed: flip connection active
      if (event.topic === 'connector.wearable.auth.completed' && conn) {
        await repo.updateUserConnectionState(supabase, conn.id, {
          is_active: true,
          last_sync_at: new Date().toISOString(),
          provider_user_id: (event.payload.terra_user_id as string | undefined) ?? null,
          provider_username: (event.payload.provider as string | undefined) ?? null,
        });
        dualWriteUserConnections(supabase, { user_id: userId, connector_id: connector.id }, 'webhook.auth_completed');
      }

      // On auth.revoked: flip inactive
      if (event.topic === 'connector.wearable.auth.revoked' && conn) {
        // VTID-05030: the vendor revoked access — stored tokens are dead, wipe them.
        await repo.updateUserConnectionState(supabase, conn.id, {
          is_active: false,
          disconnected_at: new Date().toISOString(),
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
        });
        dualWriteUserConnections(supabase, { user_id: userId, connector_id: connector.id }, 'webhook.auth_revoked');
      }

      // On data events: upsert into daily metrics / workouts
      const provider = event.provider;
      const metric_date = event.payload.metric_date as string | null | undefined;

      if (metric_date && (event.topic === 'connector.wearable.sleep.recorded' || event.topic === 'connector.wearable.activity.recorded')) {
        if (tenantId) {
          const patch: Record<string, unknown> = {
            tenant_id: tenantId,
            user_id: userId,
            user_connection_id: userConnectionId,
            provider,
            metric_date,
            raw: event.raw ?? null,
            updated_at: new Date().toISOString(),
          };
          // Only copy keys that exist in wearable_daily_metrics
          const allowed = [
            'sleep_minutes','sleep_deep_minutes','sleep_rem_minutes','sleep_light_minutes',
            'sleep_awake_minutes','sleep_start_time','sleep_end_time','sleep_efficiency_pct',
            'resting_hr','max_hr','avg_hr','hrv_avg_ms','hrv_rmssd_ms',
            'steps','active_minutes','workout_count','workout_duration_minutes',
            'calories_burned','distance_meters','vo2max','respiratory_rate','body_temp_c','weight_kg',
          ];
          for (const k of allowed) {
            if (k in event.payload && event.payload[k] !== undefined) {
              patch[k] = event.payload[k];
            }
          }
          const dm = await repo.upsertWearableDailyMetrics(supabase, patch);
          if (!dm?.error) noteBridgeDay(userId, tenantId, metric_date);
        }
      } else if (event.topic === 'connector.wearable.workout.recorded') {
        if (tenantId) {
          const startedAt = (event.payload.started_at as string | null) ?? new Date().toISOString();
          const wo = await repo.upsertWearableWorkout(supabase, {
            tenant_id: tenantId,
            user_id: userId,
            user_connection_id: userConnectionId,
            provider,
            external_workout_id: (event.payload.external_workout_id as string | null) ?? null,
            workout_type: (event.payload.workout_type as string | null) ?? null,
            started_at: startedAt,
            ended_at: (event.payload.ended_at as string | null) ?? null,
            duration_minutes: (event.payload.duration_minutes as number | null) ?? null,
            distance_meters: (event.payload.distance_meters as number | null) ?? null,
            calories: (event.payload.calories as number | null) ?? null,
            avg_hr: (event.payload.avg_hr as number | null) ?? null,
            max_hr: (event.payload.max_hr as number | null) ?? null,
            raw: event.raw ?? null,
          });
          if (!wo?.error) noteBridgeDay(userId, tenantId, utcDateOf(startedAt));
        }
      }

      persisted++;

      // Mirror to OASIS for downstream (recommendation engine, autopilot)
      await emitOasisEvent({
        vtid: 'VTID-02100',
        type: event.topic as never, // added to CicdEventType below
        source: 'gateway',
        status: 'info',
        message: `${provider} ${event.provider_event_type ?? 'event'} for user ${userId}`,
        payload: { ...event.payload, topic: event.topic },
      }).catch(() => {});
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[connector-webhook] event persist failed: ${message}`);
      skipped++;
    }
  }

  // VTID-05089 (Health Hub D6a): bridge persisted member-days into
  // health_features_daily + one Index recompute, once per distinct user.
  // Dark unless WEARABLE_FEATURE_BRIDGE_ENABLED === 'true' and not staging.
  // A bridge failure never changes this webhook's response: the raw data is
  // already stored, and the 02:00 recompute plus the next webhook repair it.
  if (supabase && bridgeTargets.size > 0 && isWearableFeatureBridgeEnabled()) {
    for (const [uid, t] of bridgeTargets) {
      try {
        await bridgeWearableDays(supabase, { tenantId: t.tenantId, userId: uid, dates: Array.from(t.dates) });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[connector-webhook] wearable features bridge failed: ${message}`);
      }
    }
  }

  if (supabase) {
    await repo.insertConnectorWebhookLog(supabase, {
      connector_id: connectorId,
      event_type: (parsedPayload as { type?: string } | null)?.type ?? 'ok',
      signature_valid: true,
      processed: true,
      payload: parsedPayload as object,
      // VTID-05174: erase_user_data() reaches this row directly. Only here,
      // after signature verification; the failure sites above stay NULL
      // (their payload is unauthenticated).
      user_id: singleBatchMember(result.events),
    });
  }

  res.json({ ok: true, processed: persisted, skipped });
});

/**
 * VTID-05174: the member a verified batch belongs to — set only when every
 * normalized event resolved to the same non-null member; an empty, mixed or
 * partly unresolved batch gives null (the erasure endpoint's payload match
 * still covers those rows).
 */
export function singleBatchMember(events: Array<{ user_id?: string | null }>): string | null {
  if (events.length === 0) return null;
  const first = events[0].user_id ?? null;
  if (!first) return null;
  return events.every((e) => (e.user_id ?? null) === first) ? first : null;
}

export default router;
