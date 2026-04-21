/**
 * BOOTSTRAP-ADMIN-BB2: autopilot_health scanner.
 *
 * Produces insights for the operations domain:
 *   - run_failure_spike     — runs_failed_7d / total_7d > 30 %
 *   - self_healing_backlog  — ≥ 5 pending-approval self-healing rows
 *   - recommendation_queue  — ≥ 20 recommendations in `new` status for this tenant
 *   - activation_drop       — activation rate of last 7d < 50 % of prior 7d
 *
 * Inputs:
 *   - tenant_autopilot_runs (tenant_id, status, started_at)
 *   - autopilot_recommendations (status, tenant_id, updated_at, created_at)
 *   - self_healing_log (outcome='pending', confidence < 0.8)
 *
 * Soft-fails per check so one bad query never kills the scanner.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:autopilot_health]';
const FAILURE_RATE_THRESHOLD_PCT = 30;
const SELF_HEALING_BACKLOG_THRESHOLD = 5;
const RECOMMENDATION_QUEUE_THRESHOLD = 20;
const ACTIVATION_DROP_RATIO = 0.5; // last-7d activation < 50% of prior 7d

export const autopilotHealthScanner: AdminScanner = {
  id: 'autopilot_health',
  domain: 'autopilot',
  label: 'Autopilot health',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const d7 = new Date(now - 7 * 86400_000).toISOString();
    const d14 = new Date(now - 14 * 86400_000).toISOString();

    // 1. Run failure spike
    try {
      const [completed, failed] = await Promise.all([
        supabase
          .from('tenant_autopilot_runs')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('status', 'completed')
          .gte('started_at', d7),
        supabase
          .from('tenant_autopilot_runs')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('status', 'failed')
          .gte('started_at', d7),
      ]);
      const c = completed.count ?? 0;
      const f = failed.count ?? 0;
      const total = c + f;
      if (total >= 10) {
        const failPct = Math.round((f / total) * 100);
        if (failPct > FAILURE_RATE_THRESHOLD_PCT) {
          insights.push({
            natural_key: 'run_failure_spike_7d',
            domain: 'autopilot',
            title: `Autopilot failure rate ${failPct}% (${f}/${total}) last 7 days`,
            description:
              `Failure rate exceeds the ${FAILURE_RATE_THRESHOLD_PCT}% threshold. ` +
              `Review the failed runs by automation to find the common root cause.`,
            severity: failPct > 60 ? 'urgent' : 'action_needed',
            actionable: true,
            recommended_action: {
              type: 'inspect_failed_runs',
              hint: 'Group tenant_autopilot_runs by automation_id where status=failed in last 7d.',
            },
            context: { failed_7d: f, completed_7d: c, failure_rate_pct: failPct, threshold_pct: FAILURE_RATE_THRESHOLD_PCT },
            confidence_score: 0.9,
            autonomy_level: 'observe_only',
          });
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} run_failure_spike failed: ${err?.message}`);
    }

    // 2. Self-healing pending-approval backlog (global, not tenant-scoped — flagged in context)
    try {
      const { count } = await supabase
        .from('self_healing_log')
        .select('id', { count: 'exact', head: true })
        .eq('outcome', 'pending')
        .lt('confidence', 0.8);
      if (count !== null && count >= SELF_HEALING_BACKLOG_THRESHOLD) {
        insights.push({
          natural_key: 'self_healing_pending_backlog',
          domain: 'autopilot',
          title: `${count} self-healing items awaiting approval`,
          description:
            `Self-healing rows with confidence < 0.8 waiting for a human decision. ` +
            `Each backlog item is a fix the system proposed but isn't confident enough to auto-apply.`,
          severity: count >= 15 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'review_self_healing_queue',
            endpoint: '/api/v1/self-healing/pending-approval',
          },
          context: { pending_count: count, threshold: SELF_HEALING_BACKLOG_THRESHOLD, tenant_scope: 'global', scanned_tenant: tenantId },
          confidence_score: 0.95,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} self_healing_backlog failed: ${err?.message}`);
    }

    // 3. Recommendation queue depth per tenant
    try {
      const { count } = await supabase
        .from('autopilot_recommendations')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'new');
      // NOTE: autopilot_recommendations currently isn't tenant_id scoped in the
      // count query because the `user_id` column targets specific users; a
      // tenant-scoped rollup lives in the per-user index we don't reach here.
      // For now flag the global queue depth and let follow-up work tighten
      // the scope. Context tag says this is global.
      if (count !== null && count >= RECOMMENDATION_QUEUE_THRESHOLD) {
        insights.push({
          natural_key: 'recommendation_queue_depth',
          domain: 'autopilot',
          title: `${count} autopilot recommendations pending`,
          description:
            `Recommendations with status='new' across the platform. ` +
            `A deep queue suggests users aren't seeing or engaging with recommendations — ` +
            `check the surface (Command Hub / vitana-v1 autopilot badge) is delivering them.`,
          severity: count >= 100 ? 'action_needed' : 'info',
          actionable: true,
          recommended_action: {
            type: 'inspect_recommendation_queue',
            endpoint: '/api/v1/autopilot/recommendations?status=new',
          },
          context: { pending_count: count, threshold: RECOMMENDATION_QUEUE_THRESHOLD, tenant_scope: 'global', scanned_tenant: tenantId },
          confidence_score: 0.75,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} recommendation_queue failed: ${err?.message}`);
    }

    // 4. Activation-rate drop — compare last 7d vs prior 7d
    try {
      const [act7, act14] = await Promise.all([
        supabase
          .from('autopilot_recommendations')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'activated')
          .gte('updated_at', d7),
        supabase
          .from('autopilot_recommendations')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'activated')
          .gte('updated_at', d14)
          .lt('updated_at', d7),
      ]);
      const last7 = act7.count ?? 0;
      const prior7 = act14.count ?? 0;
      if (prior7 >= 5 && last7 < prior7 * ACTIVATION_DROP_RATIO) {
        const dropPct = Math.round(((prior7 - last7) / prior7) * 100);
        insights.push({
          natural_key: 'activation_drop_7d',
          domain: 'autopilot',
          title: `Autopilot activation dropped ${dropPct}% week over week`,
          description:
            `${last7} activations in last 7 days vs ${prior7} in prior 7. ` +
            `If surfacing and UX haven't changed, investigate what shifted in the recommended-content mix.`,
          severity: dropPct >= 75 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'inspect_activation_funnel',
            window_days: 14,
          },
          context: { activated_last_7d: last7, activated_prior_7d: prior7, drop_pct: dropPct, tenant_scope: 'global', scanned_tenant: tenantId },
          confidence_score: 0.8,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} activation_drop failed: ${err?.message}`);
    }

    return insights;
  },
};
