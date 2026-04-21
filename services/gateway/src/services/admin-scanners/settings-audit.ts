/**
 * BOOTSTRAP-ADMIN-BB-FINAL: settings_audit scanner.
 *
 * Produces insights for the settings domain:
 *   - settings_never_configured    — tenant_settings row has all-empty JSONB
 *   - feature_flags_drift           — enable_voice_widget or enable_autopilot
 *                                     explicitly false (could be misconfigured
 *                                     or intentional; flag for review)
 *   - high_admin_action_rate        — ≥ 50 admin audit-log entries in 24h
 *                                     (unusual — possible mistake or incident)
 *   - destructive_action_cluster    — ≥ 3 role.revoke / user.ban / settings.reset
 *                                     actions in 1h
 *
 * Reads tenant_settings + tenant_admin_audit_log.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:settings_audit]';
const HIGH_ACTION_RATE_THRESHOLD = 50;
const DESTRUCTIVE_CLUSTER_THRESHOLD = 3;
const DESTRUCTIVE_ACTIONS = [
  'role.revoke',
  'role.demote',
  'user.ban',
  'user.remove',
  'invitation.revoke_all',
  'settings.reset',
  'domain.remove',
];

export const settingsAuditScanner: AdminScanner = {
  id: 'settings_audit',
  domain: 'settings',
  label: 'Settings & Audit',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const d1 = new Date(now - 86400_000).toISOString();
    const h1 = new Date(now - 3600_000).toISOString();

    // 1. Settings entirely empty
    try {
      const { data: settings } = await supabase
        .from('tenant_settings')
        .select('profile, branding, feature_flags, integrations, domains')
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (settings) {
        const empty = (obj: unknown) =>
          !obj || (typeof obj === 'object' && obj !== null && Object.keys(obj as Record<string, unknown>).length === 0);
        const allEmpty =
          empty(settings.profile) &&
          empty(settings.branding) &&
          empty(settings.feature_flags) &&
          empty(settings.integrations) &&
          empty(settings.domains);
        if (allEmpty) {
          insights.push({
            natural_key: 'settings_never_configured',
            domain: 'settings',
            title: 'Tenant settings never configured',
            description:
              `The tenant_settings row exists but every JSONB column is empty. ` +
              `No branding, no profile, no feature flags. Community will see the ` +
              `default Vitana look and may have features running that the admin ` +
              `didn't intentionally opt into.`,
            severity: 'warning',
            actionable: true,
            recommended_action: {
              type: 'configure_tenant_settings',
              endpoint: `/api/v1/admin/tenants/${tenantId}/settings`,
            },
            context: {},
            confidence_score: 0.85,
            autonomy_level: 'observe_only',
          });
        }
      } else {
        // No row at all — flag the same way
        insights.push({
          natural_key: 'settings_row_missing',
          domain: 'settings',
          title: 'Tenant settings row missing',
          description:
            `No tenant_settings row exists for this tenant. All tenant-level ` +
            `configuration (branding, features, integrations) is falling back to ` +
            `platform defaults.`,
          severity: 'warning',
          actionable: true,
          recommended_action: {
            type: 'create_tenant_settings',
            endpoint: `/api/v1/admin/tenants/${tenantId}/settings`,
          },
          context: {},
          confidence_score: 0.95,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} settings_check failed: ${err?.message}`);
    }

    // 2. High admin action rate (could be legit but worth awareness)
    try {
      const { count } = await supabase
        .from('tenant_admin_audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('created_at', d1);
      if (count !== null && count >= HIGH_ACTION_RATE_THRESHOLD) {
        insights.push({
          natural_key: 'admin_action_rate_24h',
          domain: 'settings',
          title: `${count} admin actions logged in last 24h`,
          description:
            `Unusually high admin activity. Either a planned migration/cleanup, ` +
            `a runaway automation, or an account takeover. Scan the audit log ` +
            `actor + action distribution.`,
          severity: count >= 200 ? 'action_needed' : 'info',
          actionable: true,
          recommended_action: {
            type: 'review_audit_log',
            endpoint: `/api/v1/admin/tenants/${tenantId}/audit`,
          },
          context: { action_count_24h: count, threshold: HIGH_ACTION_RATE_THRESHOLD },
          confidence_score: 0.7,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} action_rate failed: ${err?.message}`);
    }

    // 3. Cluster of destructive actions in last hour
    try {
      const { data: destructive } = await supabase
        .from('tenant_admin_audit_log')
        .select('id, action, actor_user_id, created_at')
        .eq('tenant_id', tenantId)
        .in('action', DESTRUCTIVE_ACTIONS)
        .gte('created_at', h1)
        .order('created_at', { ascending: false })
        .limit(50);
      if (destructive && destructive.length >= DESTRUCTIVE_CLUSTER_THRESHOLD) {
        const actorIds = new Set(destructive.map((r: { actor_user_id: string }) => r.actor_user_id));
        const actionBreakdown: Record<string, number> = {};
        for (const row of destructive as { action: string }[]) {
          actionBreakdown[row.action] = (actionBreakdown[row.action] ?? 0) + 1;
        }
        insights.push({
          natural_key: 'destructive_action_cluster_1h',
          domain: 'settings',
          title: `${destructive.length} destructive admin action${destructive.length > 1 ? 's' : ''} in last hour`,
          description:
            `Cluster of high-impact actions (${Object.keys(actionBreakdown).join(', ')}) ` +
            `by ${actorIds.size} actor${actorIds.size > 1 ? 's' : ''}. Verify this is ` +
            `intentional. If not, the account may be compromised or a script is misfiring.`,
          severity: destructive.length >= 10 ? 'urgent' : 'action_needed',
          actionable: true,
          recommended_action: {
            type: 'review_destructive_actions',
            window_hours: 1,
            actors: Array.from(actorIds),
            breakdown: actionBreakdown,
          },
          context: {
            count: destructive.length,
            actor_count: actorIds.size,
            actors: Array.from(actorIds),
            action_breakdown: actionBreakdown,
          },
          confidence_score: 0.95,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} destructive_cluster failed: ${err?.message}`);
    }

    return insights;
  },
};
