/**
 * BOOTSTRAP-ADMIN-BB345: content_moderation scanner.
 *
 * Produces insights for the moderation domain:
 *   - queue_size         — ≥ 10 pending items waiting for review
 *   - queue_oldest       — item pending ≥ 48 h (moderation SLA breach)
 *   - flagged_cluster    — ≥ 3 new flagged items in last 24 h
 *
 * Reads media_uploads — the table behind the content moderation admin UI
 * (see routes/tenant-admin/content-moderation.ts).
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:content_moderation]';
const QUEUE_SIZE_THRESHOLD = 10;
const QUEUE_OLD_HOURS = 48;
const FLAGGED_CLUSTER_THRESHOLD = 3;

export const contentModerationScanner: AdminScanner = {
  id: 'content_moderation',
  domain: 'moderation',
  label: 'Content moderation',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const d1 = new Date(now - 86400_000).toISOString();
    const hours48 = new Date(now - QUEUE_OLD_HOURS * 3600_000).toISOString();

    // 1. Queue size
    try {
      const { count } = await supabase
        .from('media_uploads')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'pending');
      if (count !== null && count >= QUEUE_SIZE_THRESHOLD) {
        insights.push({
          natural_key: 'moderation_queue_size',
          domain: 'moderation',
          title: `${count} items pending moderation review`,
          description:
            `Moderation queue depth is ${count} (threshold ${QUEUE_SIZE_THRESHOLD}). ` +
            `Each pending item is hidden from the community until reviewed.`,
          severity: count >= QUEUE_SIZE_THRESHOLD * 3 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'open_moderation_queue',
            endpoint: `/api/v1/admin/tenants/${tenantId}/content/items?status=pending`,
          },
          context: { queue_size: count, threshold: QUEUE_SIZE_THRESHOLD },
          confidence_score: 0.95,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} queue_size failed: ${err?.message}`);
    }

    // 2. Queue oldest — anything pending > 48h
    try {
      const { data } = await supabase
        .from('media_uploads')
        .select('id, created_at, media_type')
        .eq('tenant_id', tenantId)
        .eq('status', 'pending')
        .lt('created_at', hours48)
        .order('created_at', { ascending: true })
        .limit(5);
      if (data && data.length > 0) {
        insights.push({
          natural_key: 'moderation_sla_breach',
          domain: 'moderation',
          title: `${data.length} item${data.length > 1 ? 's' : ''} pending over ${QUEUE_OLD_HOURS} h`,
          description:
            `Oldest pending: ${new Date(data[0].created_at).toISOString()} (${data[0].media_type}). ` +
            `Moderation SLA is ${QUEUE_OLD_HOURS} h — these users are still waiting.`,
          severity: data.length >= 5 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'clear_aged_backlog',
            item_ids: data.map((d: { id: string }) => d.id),
          },
          context: { breached_count: data.length, oldest_ts: data[0].created_at, sla_hours: QUEUE_OLD_HOURS },
          confidence_score: 0.95,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} queue_oldest failed: ${err?.message}`);
    }

    // 3. Flagged cluster — new flagged items in last 24h
    try {
      const { count } = await supabase
        .from('media_uploads')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'flagged')
        .gte('updated_at', d1);
      if (count !== null && count >= FLAGGED_CLUSTER_THRESHOLD) {
        insights.push({
          natural_key: 'moderation_flagged_cluster_24h',
          domain: 'moderation',
          title: `${count} items flagged in last 24 hours`,
          description:
            `Cluster of flags may indicate a coordinated issue, a creator needing feedback, ` +
            `or a content policy edge case worth reviewing.`,
          severity: count >= 10 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'review_flagged_cluster',
            endpoint: `/api/v1/admin/tenants/${tenantId}/content/items?status=flagged`,
          },
          context: { flagged_count_24h: count, threshold: FLAGGED_CLUSTER_THRESHOLD },
          confidence_score: 0.85,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} flagged_cluster failed: ${err?.message}`);
    }

    return insights;
  },
};
