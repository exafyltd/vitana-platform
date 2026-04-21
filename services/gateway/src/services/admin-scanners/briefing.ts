/**
 * BOOTSTRAP-ADMIN-EE: Admin briefing module.
 *
 * Two responsibilities:
 *   1. fetchAdminBriefingBlock(tenantId, limit)
 *      → returns a markdown block of the top-N open insights, formatted so
 *        Vitana voice can open the admin session with them.
 *   2. notifyUnnotifiedUrgentInsights(tenantId)
 *      → finds urgent insights not yet pushed, fires notifyUserAsync to every
 *        tenant admin, and stamps urgent_notified_at.
 *
 * Called from:
 *   - orb-live.ts buildBootstrapContextPack → (1), admin role only
 *   - admin-scanners/index.ts runAllScannersForTenant → (2), every scan
 */
import { getSupabase } from '../../lib/supabase';
import { notifyUserAsync } from '../notification-service';

const LOG_PREFIX = '[admin-briefing]';

// Severity → rank for ordering the briefing. Higher = surfaced first.
const SEVERITY_RANK: Record<string, number> = {
  urgent: 4,
  action_needed: 3,
  warning: 2,
  info: 1,
};

const PRIVILEGED_ROLES = ['admin', 'exafy_admin', 'developer'];

export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && PRIVILEGED_ROLES.includes(role);
}

interface InsightRow {
  id: string;
  scanner: string;
  natural_key: string;
  domain: string;
  title: string;
  description: string | null;
  severity: string;
  confidence_score: number | null;
  recommended_action: Record<string, unknown> | null;
}

/**
 * Returns a markdown block of the top-N open insights for this tenant,
 * or null if there are none. The block is wrapped with a directive that
 * Gemini should open the admin session by surfacing them.
 */
export async function fetchAdminBriefingBlock(
  tenantId: string,
  limit = 3,
): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    // Fetch open insights excluding snoozed-until-future. Rank severity client-side
    // since Postgres sorts the text alphabetically, not by our semantic order.
    const { data, error } = await supabase
      .from('admin_insights')
      .select(
        'id, scanner, natural_key, domain, title, description, severity, confidence_score, recommended_action, snoozed_until',
      )
      .eq('tenant_id', tenantId)
      .eq('status', 'open')
      .limit(20);
    if (error) {
      console.warn(`${LOG_PREFIX} fetch failed: ${error.message}`);
      return null;
    }
    if (!data || data.length === 0) return null;

    const now = Date.now();
    const ranked = (data as (InsightRow & { snoozed_until: string | null })[])
      .filter((r) => !r.snoozed_until || new Date(r.snoozed_until).getTime() <= now)
      .map((r) => ({
        row: r,
        score:
          (SEVERITY_RANK[r.severity] ?? 1) * 10 +
          (typeof r.confidence_score === 'number' ? r.confidence_score : 0.5),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (ranked.length === 0) return null;

    const lines = ranked.map((entry, idx) => {
      const r = entry.row;
      const pill = r.severity === 'urgent' ? '🔴'
        : r.severity === 'action_needed' ? '🟠'
        : r.severity === 'warning' ? '🟡'
        : '⚪';
      const n = idx + 1;
      const desc = r.description ? r.description.split('\n')[0].slice(0, 220) : '';
      return `${n}. ${pill} **[${r.domain}]** ${r.title}${desc ? `\n   ${desc}` : ''}`;
    });

    return [
      '## ADMIN BRIEFING (active tenant signals — speak these on open)',
      '',
      `The supervisor just opened the orb. These are the top ${ranked.length} open insight${ranked.length > 1 ? 's' : ''} right now, ranked by severity × confidence. OPEN by briefly naming what needs attention — two short sentences each, ask which to tackle first. Do NOT do a generic greeting. Be direct, numeric, action-oriented.`,
      '',
      ...lines,
      '',
      'After the user picks one, stay on that insight until it is approved, rejected, snoozed, or handed off.',
    ].join('\n');
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} fetchAdminBriefingBlock error: ${err?.message}`);
    return null;
  }
}

/**
 * Returns the user_ids of every admin-ish member of this tenant.
 * Used to fan out urgent push notifications.
 */
async function getTenantAdminUserIds(tenantId: string): Promise<string[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('user_tenants')
      .select('user_id, active_role')
      .eq('tenant_id', tenantId)
      .in('active_role', PRIVILEGED_ROLES);
    if (error) {
      console.warn(`${LOG_PREFIX} getTenantAdminUserIds failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map((r: { user_id: string }) => r.user_id);
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} getTenantAdminUserIds error: ${err?.message}`);
    return [];
  }
}

/**
 * Find urgent open insights that have not been pushed yet, fire a push/in-app
 * notification to every admin of this tenant, and stamp urgent_notified_at.
 * Fire-and-forget; soft-fails per insight.
 */
export async function notifyUnnotifiedUrgentInsights(tenantId: string): Promise<number> {
  const supabase = getSupabase();
  if (!supabase) return 0;

  try {
    const { data, error } = await supabase
      .from('admin_insights')
      .select('id, title, description, domain, scanner, natural_key')
      .eq('tenant_id', tenantId)
      .eq('status', 'open')
      .eq('severity', 'urgent')
      .is('urgent_notified_at', null)
      .limit(20);
    if (error) {
      console.warn(`${LOG_PREFIX} notify fetch failed: ${error.message}`);
      return 0;
    }
    if (!data || data.length === 0) return 0;

    const adminIds = await getTenantAdminUserIds(tenantId);
    if (adminIds.length === 0) {
      // Still mark notified so we don't re-query. If admins show up later
      // they'll see the insight in the console; the first-push opportunity
      // is only valuable for live admins.
      const ids = data.map((r: { id: string }) => r.id);
      await supabase
        .from('admin_insights')
        .update({ urgent_notified_at: new Date().toISOString() })
        .in('id', ids);
      return 0;
    }

    let notified = 0;
    for (const insight of data as InsightRow[]) {
      const title = `Urgent: ${insight.title.slice(0, 120)}`;
      const body = (insight.description || '').split('\n')[0].slice(0, 200);
      for (const userId of adminIds) {
        try {
          notifyUserAsync(
            userId,
            tenantId,
            'admin_insight_urgent',
            {
              title,
              body,
              data: {
                insight_id: insight.id,
                scanner: insight.scanner,
                natural_key: insight.natural_key,
                domain: insight.domain,
                link: `/command-hub/admin/insights/${insight.id}`,
              },
            },
            supabase,
          );
          notified++;
        } catch (err: any) {
          console.warn(`${LOG_PREFIX} notify user=${userId.substring(0, 8)}... failed: ${err?.message}`);
        }
      }
    }

    // Stamp notified — use one UPDATE for all ids
    const ids = data.map((r: { id: string }) => r.id);
    await supabase
      .from('admin_insights')
      .update({ urgent_notified_at: new Date().toISOString() })
      .in('id', ids);

    return notified;
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} notifyUnnotifiedUrgentInsights error: ${err?.message}`);
    return 0;
  }
}
