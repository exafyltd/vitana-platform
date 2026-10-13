/**
 * VTID-05054 (Health Hub D5): 90-day retention for connector_webhooks_log.
 *
 * Vendor webhook payloads can carry health data and are kept only for audit.
 * Rows older than the retention window are deleted. The statement is
 * idempotent, so it runs on every gateway instance without leader election.
 *
 * Off unless CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED is exactly 'true'. Staging
 * shares the production database and must never purge — the flag is set only
 * on production at publish.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';

export const WEBHOOK_LOG_RETENTION_DAYS = 90;
export const WEBHOOK_LOG_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function isWebhookLogPurgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED === 'true';
}

export function retentionCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - WEBHOOK_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export async function purgeConnectorWebhookLog(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<{ ok: boolean; deleted: number; cutoff: string; error?: string }> {
  const cutoff = retentionCutoff(now);
  const { data, error } = await supabase
    .from('connector_webhooks_log')
    .delete()
    .lt('received_at', cutoff)
    .select('id');
  const deleted = Array.isArray(data) ? data.length : 0;
  await emitOasisEvent({
    vtid: 'VTID-05054',
    type: 'connector.webhook_log.purged',
    source: 'gateway',
    status: error ? 'error' : 'info',
    message: error
      ? `connector_webhooks_log purge failed: ${error.message}`
      : `connector_webhooks_log purge deleted ${deleted} row(s) older than ${WEBHOOK_LOG_RETENTION_DAYS} days`,
    payload: { deleted, cutoff, retention_days: WEBHOOK_LOG_RETENTION_DAYS },
  }).catch(() => {});
  return error ? { ok: false, deleted: 0, cutoff, error: error.message } : { ok: true, deleted, cutoff };
}
