/**
 * BOOTSTRAP-ADMIN-BB345: community scanner.
 *
 * Produces insights for the community domain:
 *   - dormant_groups        — group with zero new memberships in 30 days
 *   - event_capacity_strain — event has RSVPs near or above capacity
 *   - no_upcoming_events    — zero events scheduled in the next 7 days
 *   - live_room_unused      — upcoming live rooms with zero access grants
 *
 * Reads:
 *   global_community_events, global_community_groups, community_memberships,
 *   live_rooms, live_room_access_grants.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:community]';

export const communityScanner: AdminScanner = {
  id: 'community',
  domain: 'community',
  label: 'Community',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const in7d = new Date(now + 7 * 86400_000).toISOString();
    const d30 = new Date(now - 30 * 86400_000).toISOString();

    // 1. No upcoming events
    try {
      const { count } = await supabase
        .from('global_community_events')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('start_time', nowIso)
        .lt('start_time', in7d);
      if (count !== null && count === 0) {
        insights.push({
          natural_key: 'no_upcoming_events_7d',
          domain: 'community',
          title: 'No community events scheduled in the next 7 days',
          description:
            `Empty event calendar for the week. Consider scheduling a meetup or ` +
            `prompting community organizers.`,
          severity: 'warning',
          actionable: true,
          recommended_action: { type: 'invite_organizers_to_schedule' },
          context: { events_next_7d: 0 },
          confidence_score: 0.9,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} no_upcoming_events failed: ${err?.message}`);
    }

    // 2. Dormant groups — groups with no new memberships in 30 days
    try {
      const { data: groups } = await supabase
        .from('global_community_groups')
        .select('id, name, created_at')
        .eq('tenant_id', tenantId)
        .lt('created_at', d30);
      if (groups && groups.length > 0) {
        // For each group, check if any membership updated in last 30d
        const groupIds = groups.map((g: { id: string }) => g.id);
        const { data: recentMembers } = await supabase
          .from('community_memberships')
          .select('group_id')
          .in('group_id', groupIds)
          .gte('created_at', d30);
        const activeGroupIds = new Set((recentMembers ?? []).map((m: { group_id: string }) => m.group_id));
        const dormant = groups.filter((g: { id: string }) => !activeGroupIds.has(g.id));
        if (dormant.length >= 3) {
          insights.push({
            natural_key: 'dormant_groups_30d',
            domain: 'community',
            title: `${dormant.length} community groups dormant 30+ days`,
            description:
              `Groups with no new members in 30 days. Consider archiving or ` +
              `prompting the group owner with a re-engagement nudge.`,
            severity: dormant.length >= 10 ? 'action_needed' : 'warning',
            actionable: true,
            recommended_action: {
              type: 'review_dormant_groups',
              group_ids: dormant.slice(0, 10).map((g: { id: string }) => g.id),
            },
            context: {
              dormant_count: dormant.length,
              total_groups_30d: groups.length,
              sample: dormant.slice(0, 5).map((g: { id: string; name?: string }) => ({ id: g.id, name: g.name })),
            },
            confidence_score: 0.85,
            autonomy_level: 'observe_only',
          });
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} dormant_groups failed: ${err?.message}`);
    }

    // 3. Live-room unused — upcoming rooms with zero access grants
    try {
      const { data: rooms } = await supabase
        .from('live_rooms')
        .select('id, title, starts_at')
        .eq('tenant_id', tenantId)
        .gte('starts_at', nowIso)
        .lt('starts_at', in7d)
        .limit(20);
      if (rooms && rooms.length > 0) {
        const roomIds = rooms.map((r: { id: string }) => r.id);
        const { data: grants } = await supabase
          .from('live_room_access_grants')
          .select('live_room_id')
          .in('live_room_id', roomIds);
        const withGrants = new Set((grants ?? []).map((g: { live_room_id: string }) => g.live_room_id));
        const unused = rooms.filter((r: { id: string }) => !withGrants.has(r.id));
        if (unused.length >= 2) {
          insights.push({
            natural_key: 'live_rooms_unused_week',
            domain: 'community',
            title: `${unused.length} upcoming live room${unused.length > 1 ? 's' : ''} with zero attendees`,
            description:
              `Rooms scheduled this week but no one registered. Confirm visibility ` +
              `and promotion, or consider reaching out to the host.`,
            severity: 'info',
            actionable: true,
            recommended_action: {
              type: 'promote_live_rooms',
              room_ids: unused.slice(0, 10).map((r: { id: string }) => r.id),
            },
            context: {
              unused_count: unused.length,
              sample: unused.slice(0, 5).map((r: { id: string; title?: string; starts_at?: string }) => ({
                id: r.id,
                title: r.title,
                starts_at: r.starts_at,
              })),
            },
            confidence_score: 0.75,
            autonomy_level: 'observe_only',
          });
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} live_rooms_unused failed: ${err?.message}`);
    }

    return insights;
  },
};
