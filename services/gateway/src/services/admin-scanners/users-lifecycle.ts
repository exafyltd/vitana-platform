/**
 * BOOTSTRAP-ADMIN-BB345: users_lifecycle scanner.
 *
 * Produces insights for the users domain:
 *   - invitations_expiring_soon   — ≥ 1 invitation expires within 48h
 *   - invitations_aging           — ≥ 3 invitations untouched > 7 days
 *   - verification_bottleneck     — email_verified rate < 60% for recent signups
 *   - signup_velocity_drop        — new signups last 7d < 50% of prior 7d
 *
 * Reads: user_tenants, tenant_invitations, auth.users (via service role).
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:users_lifecycle]';
const VERIFICATION_BOTTLENECK_PCT = 60; // below 60% verified = bottleneck
const SIGNUP_DROP_RATIO = 0.5;

export const usersLifecycleScanner: AdminScanner = {
  id: 'users_lifecycle',
  domain: 'users',
  label: 'Users & lifecycle',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const in48h = new Date(now + 48 * 3600_000).toISOString();
    const d7 = new Date(now - 7 * 86400_000).toISOString();
    const d14 = new Date(now - 14 * 86400_000).toISOString();

    // 1. Invitations expiring within 48h
    try {
      const { data: expiring } = await supabase
        .from('tenant_invitations')
        .select('id, email, expires_at')
        .eq('tenant_id', tenantId)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .gte('expires_at', nowIso)
        .lte('expires_at', in48h)
        .order('expires_at', { ascending: true })
        .limit(10);
      if (expiring && expiring.length > 0) {
        insights.push({
          natural_key: 'invitations_expiring_48h',
          domain: 'users',
          title: `${expiring.length} invitation${expiring.length > 1 ? 's' : ''} expiring within 48h`,
          description:
            `Pending invitations that will auto-expire. Reach out or extend if you still want them.`,
          severity: expiring.length >= 5 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'extend_or_nudge_invitations',
            invitation_ids: expiring.map((i: { id: string }) => i.id),
          },
          context: {
            expiring_count: expiring.length,
            sample: expiring.slice(0, 5).map((i: { id: string; email: string; expires_at: string }) => ({
              email: i.email,
              expires_at: i.expires_at,
            })),
          },
          confidence_score: 0.95,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} invitations_expiring failed: ${err?.message}`);
    }

    // 2. Invitations aging — created > 7 days ago, still pending
    try {
      const { count } = await supabase
        .from('tenant_invitations')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .lt('created_at', d7);
      if (count !== null && count >= 3) {
        insights.push({
          natural_key: 'invitations_aging_7d',
          domain: 'users',
          title: `${count} invitation${count > 1 ? 's' : ''} pending over 7 days`,
          description:
            `Invitations untouched for over a week probably never will be accepted. ` +
            `Consider revoking, nudging, or changing how you invite.`,
          severity: count >= 10 ? 'warning' : 'info',
          actionable: true,
          recommended_action: { type: 'revoke_or_nudge_aged_invitations' },
          context: { aging_count: count },
          confidence_score: 0.85,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} invitations_aging failed: ${err?.message}`);
    }

    // 3. Signup velocity drop — last 7d vs prior 7d
    try {
      const [last7, prior7] = await Promise.all([
        supabase
          .from('user_tenants')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .gte('created_at', d7),
        supabase
          .from('user_tenants')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .gte('created_at', d14)
          .lt('created_at', d7),
      ]);
      const last = last7.count ?? 0;
      const prior = prior7.count ?? 0;
      if (prior >= 5 && last < prior * SIGNUP_DROP_RATIO) {
        const dropPct = Math.round(((prior - last) / prior) * 100);
        insights.push({
          natural_key: 'signup_velocity_drop_7d',
          domain: 'users',
          title: `Signups dropped ${dropPct}% week over week`,
          description:
            `${last} new members in last 7 days vs ${prior} the prior 7. ` +
            `Check acquisition channels, onboarding funnel, and any recent changes to the signup flow.`,
          severity: dropPct >= 75 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: { type: 'inspect_signup_funnel', window_days: 14 },
          context: { signups_last_7d: last, signups_prior_7d: prior, drop_pct: dropPct },
          confidence_score: 0.8,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} signup_velocity failed: ${err?.message}`);
    }

    // 4. Verification bottleneck — recent tenant members where email_confirmed_at
    // is null on the auth.users record. We sample up to 100 recent joins.
    try {
      const { data: recentMembers } = await supabase
        .from('user_tenants')
        .select('user_id, created_at')
        .eq('tenant_id', tenantId)
        .gte('created_at', d7)
        .limit(100);
      if (recentMembers && recentMembers.length >= 5) {
        const userIds = recentMembers.map((m: { user_id: string }) => m.user_id);
        // auth.users read requires service role; this is the service-role client.
        // Using a raw fetch via the REST API since supabase-js's schema("auth") path
        // isn't universally available; fall back to app_users email_verified_at if
        // that column exists. We try app_users first (safer RLS).
        const { data: verifiedRows } = await supabase
          .from('app_users')
          .select('user_id, email_verified_at')
          .in('user_id', userIds);
        if (verifiedRows && verifiedRows.length > 0) {
          const verified = verifiedRows.filter((r: { email_verified_at: string | null }) => !!r.email_verified_at).length;
          const verifiedPct = Math.round((verified / recentMembers.length) * 100);
          if (verifiedPct < VERIFICATION_BOTTLENECK_PCT) {
            insights.push({
              natural_key: 'verification_bottleneck_7d',
              domain: 'users',
              title: `Only ${verifiedPct}% of last week's signups verified their email`,
              description:
                `${verified}/${recentMembers.length} recent members confirmed email. ` +
                `Verification below ${VERIFICATION_BOTTLENECK_PCT}% usually means email delivery issues, ` +
                `confusing copy in the verify mail, or bot signups.`,
              severity: verifiedPct < 30 ? 'action_needed' : 'warning',
              actionable: true,
              recommended_action: {
                type: 'inspect_verification_funnel',
                verified_pct: verifiedPct,
              },
              context: {
                verified,
                sampled: recentMembers.length,
                verified_pct: verifiedPct,
                threshold_pct: VERIFICATION_BOTTLENECK_PCT,
              },
              confidence_score: 0.75,
              autonomy_level: 'observe_only',
            });
          }
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} verification_bottleneck failed: ${err?.message}`);
    }

    return insights;
  },
};
