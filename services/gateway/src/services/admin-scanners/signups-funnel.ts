/**
 * BOOTSTRAP-ADMIN-BB-FINAL: signups_funnel scanner.
 *
 * Produces insights for the signups domain:
 *   - stuck_at_started            — ≥ 3 attempts stuck in 'started' > 2h
 *   - stuck_at_email_sent         — ≥ 3 attempts stuck in 'email_sent' > 24h
 *   - abandonment_spike           — abandonment rate last 24h > 60%
 *   - invitations_expiring_unused — ≥ 3 onboarding_invitations expired without
 *                                   conversion in 7d
 *
 * Reads signup_attempts + onboarding_invitations.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:signups_funnel]';
const STUCK_THRESHOLD = 3;
const ABANDONMENT_RATE_PCT = 60;

export const signupsFunnelScanner: AdminScanner = {
  id: 'signups_funnel',
  domain: 'signups',
  label: 'Signups & Onboarding',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const h2 = new Date(now - 2 * 3600_000).toISOString();
    const d1 = new Date(now - 86400_000).toISOString();
    const d7 = new Date(now - 7 * 86400_000).toISOString();

    // 1. Stuck in 'started' — user hit the form but never got email confirmation
    try {
      const { count } = await supabase
        .from('signup_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'started')
        .lt('started_at', h2);
      if (count !== null && count >= STUCK_THRESHOLD) {
        insights.push({
          natural_key: 'signup_stuck_at_started_2h',
          domain: 'signups',
          title: `${count} signup attempt${count > 1 ? 's' : ''} stuck before email send`,
          description:
            `Attempts in 'started' state for >2h haven't even received the verification email. ` +
            `Usually caused by email-provider rate limiting, Postmark key issues, or a Supabase ` +
            `auth outage. Users assume the system is broken.`,
          severity: count >= 10 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'inspect_signup_email_delivery',
            endpoint: `/api/v1/admin/tenants/${tenantId}/signups?status=started`,
          },
          context: { stuck_count: count, stage: 'started', threshold_hours: 2 },
          confidence_score: 0.9,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} stuck_started failed: ${err?.message}`);
    }

    // 2. Stuck in 'email_sent' — email sent but user hasn't verified in 24h
    try {
      const { count } = await supabase
        .from('signup_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'email_sent')
        .lt('started_at', d1);
      if (count !== null && count >= STUCK_THRESHOLD) {
        insights.push({
          natural_key: 'signup_stuck_at_email_sent_24h',
          domain: 'signups',
          title: `${count} signup attempt${count > 1 ? 's' : ''} unverified after 24h`,
          description:
            `Emails sent but users never clicked through. Either the mail landed in spam, ` +
            `the copy is confusing, or the user lost interest. Consider a nudge template ` +
            `or reviewing the verification email content.`,
          severity: count >= 10 ? 'warning' : 'info',
          actionable: true,
          recommended_action: {
            type: 'nudge_unverified_signups',
            stage: 'email_sent',
          },
          context: { stuck_count: count, stage: 'email_sent', threshold_hours: 24 },
          confidence_score: 0.85,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} stuck_email_sent failed: ${err?.message}`);
    }

    // 3. Abandonment rate spike
    try {
      const [{ count: abandoned }, { count: total }] = await Promise.all([
        supabase
          .from('signup_attempts')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('status', 'abandoned')
          .gte('started_at', d1),
        supabase
          .from('signup_attempts')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .gte('started_at', d1),
      ]);
      if (total !== null && total >= 10 && abandoned !== null) {
        const rate = (abandoned / total) * 100;
        if (rate >= ABANDONMENT_RATE_PCT) {
          insights.push({
            natural_key: 'signup_abandonment_spike_24h',
            domain: 'signups',
            title: `${Math.round(rate)}% signup abandonment in last 24h`,
            description:
              `${abandoned}/${total} attempts marked abandoned. Above ${ABANDONMENT_RATE_PCT}% ` +
              `points to a systemic issue — broken email template, form bug, confusing copy, ` +
              `or a new acquisition channel sending low-intent traffic.`,
            severity: rate >= 80 ? 'action_needed' : 'warning',
            actionable: true,
            recommended_action: { type: 'investigate_signup_funnel', window_hours: 24 },
            context: {
              abandoned,
              total,
              abandonment_rate_pct: Math.round(rate),
              threshold_pct: ABANDONMENT_RATE_PCT,
            },
            confidence_score: 0.8,
            autonomy_level: 'observe_only',
          });
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} abandonment_rate failed: ${err?.message}`);
    }

    // 4. Onboarding invitations expired unconverted in last 7d
    try {
      const { count } = await supabase
        .from('onboarding_invitations')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'expired')
        .gte('created_at', d7);
      if (count !== null && count >= STUCK_THRESHOLD) {
        insights.push({
          natural_key: 'onboarding_invitations_expired_7d',
          domain: 'signups',
          title: `${count} onboarding invitation${count > 1 ? 's' : ''} expired without conversion`,
          description:
            `Invitations sent in the last week that hit their TTL without the invitee ` +
            `ever signing in. Either the invites aren't reaching users (deliverability) ` +
            `or the invitation copy/flow isn't compelling enough.`,
          severity: count >= 10 ? 'warning' : 'info',
          actionable: true,
          recommended_action: { type: 'review_invitation_conversion', window_days: 7 },
          context: { expired_count: count, window_days: 7 },
          confidence_score: 0.8,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} invitations_expired failed: ${err?.message}`);
    }

    // Reference now variables to avoid tsc unused-var complaints
    void nowIso;

    return insights;
  },
};
