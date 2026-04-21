/**
 * BOOTSTRAP-ADMIN-BB-CC: system_health scanner — first scanner of Phase BB.
 *
 * Produces insights for:
 *   - orb_stall_cluster — ≥ 3 orb.live.stall_detected in last 1 h
 *   - error_spike       — OASIS error events exceed baseline in last 1 h
 *   - deploy_failure    — recent cicd.deploy.failed event
 *   - agent_heartbeat_stale — any service-tier agent last_heartbeat older than 5 min
 *
 * Everything is soft-failing — a bad query returns [] rather than breaking
 * the scan loop. All signals are observe-only per the plan's observe-7-days
 * policy; admin reviews and promotes to higher severity if signal is useful.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:system_health]';
const ORB_STALL_CLUSTER_THRESHOLD = 3;
const ERROR_SPIKE_THRESHOLD = 20;          // OASIS error events/hour above this = spike
const AGENT_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export const systemHealthScanner: AdminScanner = {
  id: 'system_health',
  domain: 'system_health',
  label: 'System health',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const h1 = new Date(now - 60 * 60 * 1000).toISOString();
    const d1 = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    // 1. Orb stall cluster — how many orb.live.stall_detected in the last 1h
    try {
      const { count, error } = await supabase
        .from('oasis_events')
        .select('id', { count: 'exact', head: true })
        .eq('topic', 'orb.live.stall_detected')
        .gte('created_at', h1);
      if (!error && count !== null && count >= ORB_STALL_CLUSTER_THRESHOLD) {
        insights.push({
          natural_key: 'orb_stall_cluster_1h',
          domain: 'system_health',
          title: `Orb stall cluster: ${count} stalls in last hour`,
          description:
            `The forwarding watchdog fired ${count} times in the last hour. ` +
            `Expected baseline is < ${ORB_STALL_CLUSTER_THRESHOLD} per hour.`,
          severity: count >= ORB_STALL_CLUSTER_THRESHOLD * 3 ? 'urgent' : 'action_needed',
          actionable: true,
          recommended_action: {
            type: 'investigate',
            hint: 'Check Cloud Run logs for VTID-WATCHDOG; verify Vertex region latency.',
          },
          context: { stalls_last_hour: count, threshold: ORB_STALL_CLUSTER_THRESHOLD },
          confidence_score: 0.9,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} orb_stall_cluster failed: ${err?.message}`);
    }

    // 2. Error spike — OASIS events with status='error' in last 1h
    try {
      const { count, error } = await supabase
        .from('oasis_events')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'error')
        .gte('created_at', h1);
      if (!error && count !== null && count >= ERROR_SPIKE_THRESHOLD) {
        insights.push({
          natural_key: 'error_spike_1h',
          domain: 'system_health',
          title: `Error spike: ${count} OASIS errors in last hour`,
          description: `${count} error-status events emitted in the last 60 min (baseline threshold ${ERROR_SPIKE_THRESHOLD}).`,
          severity: count >= ERROR_SPIKE_THRESHOLD * 5 ? 'urgent' : 'action_needed',
          actionable: true,
          recommended_action: {
            type: 'investigate',
            hint: 'Group oasis_events by topic in the last hour to identify the hot source.',
          },
          context: { error_count_last_hour: count, threshold: ERROR_SPIKE_THRESHOLD },
          confidence_score: 0.85,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} error_spike failed: ${err?.message}`);
    }

    // 3. Deploy failure in last 24h
    try {
      const { data, error } = await supabase
        .from('oasis_events')
        .select('topic, created_at, message')
        .in('topic', ['cicd.deploy.failed', 'deploy.gateway.failed'])
        .gte('created_at', d1)
        .order('created_at', { ascending: false })
        .limit(5);
      if (!error && data && data.length > 0) {
        insights.push({
          natural_key: `deploy_failure_${data[0].created_at}`,
          domain: 'system_health',
          title: `${data.length} deploy failure${data.length > 1 ? 's' : ''} in last 24h`,
          description:
            `Most recent: ${data[0].topic} at ${new Date(data[0].created_at).toISOString()}. ` +
            (data[0].message ? `Message: ${String(data[0].message).slice(0, 200)}` : ''),
          severity: 'warning',
          actionable: true,
          recommended_action: { type: 'review_deploy_logs', topic: data[0].topic },
          context: { failures: data.length, most_recent: data[0] },
          confidence_score: 0.95,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} deploy_failure failed: ${err?.message}`);
    }

    // 4. Service-tier agent heartbeat stale
    try {
      const { data, error } = await supabase
        .from('agents_registry')
        .select('agent_id, name, tier, last_heartbeat_at')
        .eq('tier', 'service')
        .order('last_heartbeat_at', { ascending: true, nullsFirst: true })
        .limit(20);
      if (!error && data) {
        const stale = data.filter((a: { last_heartbeat_at: string | null }) => {
          if (!a.last_heartbeat_at) return true;
          return Date.now() - new Date(a.last_heartbeat_at).getTime() > AGENT_HEARTBEAT_STALE_MS;
        });
        if (stale.length > 0) {
          insights.push({
            natural_key: 'agent_heartbeat_stale',
            domain: 'system_health',
            title: `${stale.length} service agent${stale.length > 1 ? 's' : ''} not reporting`,
            description:
              `Service-tier agents with last heartbeat > 5 min: ` +
              stale.map((a: { agent_id: string }) => a.agent_id).slice(0, 5).join(', ') +
              (stale.length > 5 ? ` (+${stale.length - 5} more)` : ''),
            severity: stale.length >= 3 ? 'action_needed' : 'warning',
            actionable: true,
            recommended_action: {
              type: 'check_agent',
              agent_ids: stale.map((a: { agent_id: string }) => a.agent_id),
            },
            context: {
              stale_count: stale.length,
              agents: stale.map((a: { agent_id: string; name?: string; last_heartbeat_at: string | null }) => ({
                agent_id: a.agent_id,
                name: a.name,
                last_heartbeat_at: a.last_heartbeat_at,
              })),
            },
            confidence_score: 0.8,
            autonomy_level: 'observe_only',
          });
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} agent_heartbeat failed: ${err?.message}`);
    }

    // NOTE: these signals are mostly *global* (OASIS + agents_registry aren't
    // strictly tenant-scoped today). For Phase BB#1 we produce one copy per
    // tenant — good enough for the observe-only period. A follow-up scanner
    // phase will introduce tenant-scoped OASIS projection so each tenant only
    // sees insights relevant to it. We tag `context.tenant_scope: 'global'`
    // so the UI can disambiguate.
    for (const insight of insights) {
      insight.context = { ...(insight.context || {}), tenant_scope: 'global', scanned_tenant: tenantId };
    }

    return insights;
  },
};
