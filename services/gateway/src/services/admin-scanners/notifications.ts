/**
 * BOOTSTRAP-ADMIN-BB-FINAL: notifications scanner.
 *
 * Produces insights for the notifications domain:
 *   - unread_pileup        — ≥ 100 notifications across tenant users with
 *                            read_at NULL older than 7d (users ignoring)
 *   - push_opt_out_spike   — < 30% of tenant users have push_enabled
 *   - zero_notifications   — tenant has any users but zero notifications
 *                            created in last 30d (dead comms channel)
 *
 * Reads user_notifications + user_notification_preferences + user_tenants.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';
import * as repo from './notifications-repository';

const LOG_PREFIX = '[admin-scanner:notifications]';
const UNREAD_PILEUP_THRESHOLD = 100;
const PUSH_OPTIN_PCT_THRESHOLD = 30;

export const notificationsScanner: AdminScanner = {
  id: 'notifications',
  domain: 'notifications',
  label: 'Notifications',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const d7 = new Date(now - 7 * 86400_000).toISOString();
    const d30 = new Date(now - 30 * 86400_000).toISOString();

    // 1. Unread notification pileup
    try {
      const { count } = await repo.countUnreadNotificationsOlderThan(supabase, tenantId, d7);
      if (count !== null && count >= UNREAD_PILEUP_THRESHOLD) {
        insights.push({
          natural_key: 'notifications_unread_pileup_7d',
          domain: 'notifications',
          title: `${count} unread notifications older than 7 days`,
          description:
            `Users are ignoring or not seeing notifications. Either the delivery ` +
            `channel is broken (push tokens, email), the content isn't relevant, ` +
            `or the inbox UI isn't surfacing them. Low read-through erodes the ` +
            `channel's value for critical alerts.`,
          severity: count >= 500 ? 'warning' : 'info',
          actionable: true,
          recommended_action: {
            type: 'audit_notification_channel_health',
          },
          context: { unread_count: count, threshold: UNREAD_PILEUP_THRESHOLD },
          confidence_score: 0.8,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} unread_pileup failed: ${err?.message}`);
    }

    // 2. Push opt-in rate
    try {
      const [{ count: totalUsers }, { count: pushEnabled }] = await Promise.all([
        repo.countNotificationPreferencesTotal(supabase, tenantId),
        repo.countNotificationPreferencesPushEnabled(supabase, tenantId),
      ]);
      if (totalUsers !== null && totalUsers >= 10 && pushEnabled !== null) {
        const rate = (pushEnabled / totalUsers) * 100;
        if (rate < PUSH_OPTIN_PCT_THRESHOLD) {
          insights.push({
            natural_key: 'notifications_low_push_optin',
            domain: 'notifications',
            title: `Only ${Math.round(rate)}% of users have push enabled`,
            description:
              `${pushEnabled}/${totalUsers} users have push_enabled=true. Below ` +
              `${PUSH_OPTIN_PCT_THRESHOLD}% means most users won't receive live-room ` +
              `reminders, match notifications, or admin alerts. Investigate: are we ` +
              `asking for permission at the right moment, or is push broken on ` +
              `mobile (Appilix identity issues)?`,
            severity: rate < 15 ? 'action_needed' : 'warning',
            actionable: true,
            recommended_action: { type: 'investigate_push_optin_flow' },
            context: {
              push_enabled: pushEnabled,
              total_prefs: totalUsers,
              optin_rate_pct: Math.round(rate),
              threshold_pct: PUSH_OPTIN_PCT_THRESHOLD,
            },
            confidence_score: 0.8,
            autonomy_level: 'observe_only',
          });
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} push_optin failed: ${err?.message}`);
    }

    // 3. Dead notification channel — users exist but zero notifications in 30d
    try {
      const [{ count: userCount }, { count: notifCount }] = await Promise.all([
        repo.countUserTenants(supabase, tenantId),
        repo.countNotificationsSince(supabase, tenantId, d30),
      ]);
      if (userCount !== null && userCount >= 10 && notifCount === 0) {
        insights.push({
          natural_key: 'notifications_dead_channel_30d',
          domain: 'notifications',
          title: 'Zero notifications sent in last 30 days',
          description:
            `${userCount} users in the tenant but nothing has been pushed, ` +
            `emailed, or in-apped in a month. Either the system isn't generating ` +
            `events worth notifying on, or the notification pipeline is broken. ` +
            `Check notification-service emission points.`,
          severity: 'warning',
          actionable: true,
          recommended_action: { type: 'inspect_notification_pipeline' },
          context: { user_count: userCount, notifications_30d: 0 },
          confidence_score: 0.85,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} dead_channel failed: ${err?.message}`);
    }

    return insights;
  },
};
