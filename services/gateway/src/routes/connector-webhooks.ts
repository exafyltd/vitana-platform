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
 * signature in the connector's own verifyTerraSignature / equivalent.
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { getConnector } from '../connectors';
import { emitOasisEvent } from '../services/oasis-event-service';

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
      await supabase.from('connector_webhooks_log').insert({
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
      await supabase.from('connector_webhooks_log').insert({
        connector_id: connectorId,
        event_type: 'handler_error',
        signature_valid: null,
        processed: false,
        process_error: message,
        payload: parsedPayload as object,
      });
    }
    return res.status(500).json({ ok: false, error: message });
  }

  if (!result.valid) {
    if (supabase) {
      await supabase.from('connector_webhooks_log').insert({
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
  for (const event of result.events) {
    const userId = event.user_id ?? null;
    try {
      if (!supabase || !userId) {
        skipped++;
        continue;
      }

      // Find or create user_connection row
      let userConnectionId: string | null = null;
      const { data: conn } = await supabase
        .from('user_connections')
        .select('id, tenant_id')
        .eq('user_id', userId)
        .eq('connector_id', connector.id)
        .limit(1)
        .maybeSingle();
      if (conn) userConnectionId = conn.id;
      const tenantId = conn?.tenant_id;

      // On auth.completed: flip connection active
      if (event.topic === 'connector.wearable.auth.completed' && conn) {
        await supabase
          .from('user_connections')
          .update({
            is_active: true,
            last_sync_at: new Date().toISOString(),
            provider_user_id: (event.payload.terra_user_id as string | undefined) ?? null,
            provider_username: (event.payload.provider as string | undefined) ?? null,
          })
          .eq('id', conn.id);
      }

      // On auth.revoked: flip inactive
      if (event.topic === 'connector.wearable.auth.revoked' && conn) {
        await supabase
          .from('user_connections')
          .update({ is_active: false, disconnected_at: new Date().toISOString() })
          .eq('id', conn.id);
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
          await supabase
            .from('wearable_daily_metrics')
            .upsert(patch, { onConflict: 'user_id,provider,metric_date' });
        }
      } else if (event.topic === 'connector.wearable.workout.recorded') {
        if (tenantId) {
          await supabase.from('wearable_workouts').upsert(
            {
              tenant_id: tenantId,
              user_id: userId,
              user_connection_id: userConnectionId,
              provider,
              external_workout_id: (event.payload.external_workout_id as string | null) ?? null,
              workout_type: (event.payload.workout_type as string | null) ?? null,
              started_at: (event.payload.started_at as string | null) ?? new Date().toISOString(),
              ended_at: (event.payload.ended_at as string | null) ?? null,
              duration_minutes: (event.payload.duration_minutes as number | null) ?? null,
              distance_meters: (event.payload.distance_meters as number | null) ?? null,
              calories: (event.payload.calories as number | null) ?? null,
              avg_hr: (event.payload.avg_hr as number | null) ?? null,
              max_hr: (event.payload.max_hr as number | null) ?? null,
              raw: event.raw ?? null,
            },
            { onConflict: 'user_id,provider,external_workout_id' }
          );
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

  if (supabase) {
    await supabase.from('connector_webhooks_log').insert({
      connector_id: connectorId,
      event_type: (parsedPayload as { type?: string } | null)?.type ?? 'ok',
      signature_valid: true,
      processed: true,
      payload: parsedPayload as object,
    });
  }

  res.json({ ok: true, processed: persisted, skipped });
});

export default router;
