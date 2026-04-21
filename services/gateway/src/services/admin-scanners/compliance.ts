/**
 * BOOTSTRAP-ADMIN-BB-FINAL: compliance scanner.
 *
 * Produces insights for the audit/compliance domain:
 *   - privileged_role_grant_spike   — ≥ 3 admin/developer role grants in 7d
 *   - flagged_content_aging         — media_uploads status='flagged' ≥ 72h
 *   - gdpr_erasure_pending          — tenant_admin_audit_log has 'user.delete_request'
 *                                     entries without matching 'user.deleted' within 30d
 *
 * Compliance differs from content_moderation by focusing on the *paper trail* —
 * who did what to the trust surface (privileged grants, retention obligations,
 * data-deletion SLAs) rather than the moderation queue itself.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:compliance]';
const PRIVILEGED_GRANT_THRESHOLD = 3;
const FLAGGED_AGING_HOURS = 72;
const GDPR_SLA_DAYS = 30;
const PRIVILEGED_GRANT_ACTIONS = ['role.grant', 'role.promote', 'permission.grant'];
const PRIVILEGED_ROLES = ['admin', 'exafy_admin', 'developer'];

export const complianceScanner: AdminScanner = {
  id: 'compliance',
  domain: 'audit',
  label: 'Compliance & Audit',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const flaggedCutoff = new Date(now - FLAGGED_AGING_HOURS * 3600_000).toISOString();
    const d7 = new Date(now - 7 * 86400_000).toISOString();
    const gdprCutoff = new Date(now - GDPR_SLA_DAYS * 86400_000).toISOString();

    // 1. Privileged role-grant spike — filter for grants that mention a
    // privileged role in after_state.
    try {
      const { data: grants } = await supabase
        .from('tenant_admin_audit_log')
        .select('id, action, actor_user_id, target_resource, after_state, created_at')
        .eq('tenant_id', tenantId)
        .in('action', PRIVILEGED_GRANT_ACTIONS)
        .gte('created_at', d7);
      if (grants && grants.length > 0) {
        const privileged = (grants as { after_state: any }[]).filter((g) => {
          const state = g.after_state;
          if (!state) return false;
          const roles: string[] = state.roles ?? (state.role ? [state.role] : []);
          return roles.some((r) => PRIVILEGED_ROLES.includes(r));
        });
        if (privileged.length >= PRIVILEGED_GRANT_THRESHOLD) {
          insights.push({
            natural_key: 'privileged_role_grant_spike_7d',
            domain: 'audit',
            title: `${privileged.length} privileged role grant${privileged.length > 1 ? 's' : ''} in last 7 days`,
            description:
              `Grants of admin/developer/exafy_admin roles above the usual cadence. ` +
              `These are the accounts that can ban users, change settings, and read ` +
              `audit logs — verify each grant was intentional and that the recipients ` +
              `still need the elevation.`,
            severity: privileged.length >= 10 ? 'action_needed' : 'warning',
            actionable: true,
            recommended_action: {
              type: 'review_privileged_grants',
              audit_ids: privileged.slice(0, 10).map((g: any) => g.id),
            },
            context: {
              grant_count: privileged.length,
              threshold: PRIVILEGED_GRANT_THRESHOLD,
              window_days: 7,
            },
            confidence_score: 0.9,
            autonomy_level: 'observe_only',
          });
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} privileged_grant_spike failed: ${err?.message}`);
    }

    // 2. Flagged content aging beyond legal review SLA
    try {
      const { data: aged } = await supabase
        .from('media_uploads')
        .select('id, created_at, media_type')
        .eq('tenant_id', tenantId)
        .eq('status', 'flagged')
        .lt('updated_at', flaggedCutoff)
        .order('updated_at', { ascending: true })
        .limit(20);
      if (aged && aged.length > 0) {
        insights.push({
          natural_key: 'flagged_content_aging_72h',
          domain: 'audit',
          title: `${aged.length} flagged item${aged.length > 1 ? 's' : ''} unresolved for ${FLAGGED_AGING_HOURS}h+`,
          description:
            `Flagged content that's been in limbo beyond the review SLA creates ` +
            `compliance exposure — if the flag was for illegal content, every extra ` +
            `hour live is a liability. Resolve or escalate.`,
          severity: aged.length >= 5 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'escalate_aged_flags',
            item_ids: aged.map((a: { id: string }) => a.id),
          },
          context: {
            aged_count: aged.length,
            sla_hours: FLAGGED_AGING_HOURS,
          },
          confidence_score: 0.95,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} flagged_aging failed: ${err?.message}`);
    }

    // 3. GDPR erasure requests missing deletion confirmation
    try {
      const { data: requests } = await supabase
        .from('tenant_admin_audit_log')
        .select('id, target_resource, created_at')
        .eq('tenant_id', tenantId)
        .eq('action', 'user.delete_request')
        .lt('created_at', gdprCutoff);
      if (requests && requests.length > 0) {
        const requestTargets = requests
          .map((r: { target_resource: string | null }) => r.target_resource)
          .filter((t: string | null): t is string => !!t);
        const { data: completions } = requestTargets.length > 0
          ? await supabase
              .from('tenant_admin_audit_log')
              .select('target_resource')
              .eq('tenant_id', tenantId)
              .eq('action', 'user.deleted')
              .in('target_resource', requestTargets)
          : { data: [] };
        const completed = new Set(
          (completions ?? []).map((c: { target_resource: string }) => c.target_resource),
        );
        const unfulfilled = requests.filter(
          (r: { target_resource: string | null }) => r.target_resource && !completed.has(r.target_resource),
        );
        if (unfulfilled.length > 0) {
          insights.push({
            natural_key: 'gdpr_erasure_sla_breach',
            domain: 'audit',
            title: `${unfulfilled.length} GDPR erasure request${unfulfilled.length > 1 ? 's' : ''} past ${GDPR_SLA_DAYS}-day SLA`,
            description:
              `User deletion requests logged over ${GDPR_SLA_DAYS} days ago without ` +
              `a corresponding user.deleted entry. GDPR requires fulfilment within ` +
              `one month; each unresolved request is potential regulatory exposure.`,
            severity: 'urgent',
            actionable: true,
            recommended_action: {
              type: 'fulfill_erasure_requests',
              targets: unfulfilled.map((r: { target_resource: string | null }) => r.target_resource),
            },
            context: {
              unfulfilled_count: unfulfilled.length,
              sla_days: GDPR_SLA_DAYS,
            },
            confidence_score: 0.9,
            autonomy_level: 'observe_only',
          });
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} gdpr_erasure failed: ${err?.message}`);
    }

    return insights;
  },
};
