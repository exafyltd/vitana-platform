import * as repo from '../../src/services/automation-handlers/engagement-events-repository';

/**
 * Functional stub Supabase client — a from()-chain that records every call
 * and resolves to a configurable {data,error,count} response, matching the
 * pattern used for the other B1 repository tests (billing-repository.test.ts,
 * scheduled-notifications-repository.test.ts, community-groups-repository).
 */
function makeSupabaseStub(response: { data?: any; error?: any; count?: number | null } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const resolved = { data: response.data ?? null, error: response.error ?? null, count: response.count ?? null };

  const chain: any = {};
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of [
    'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'like', 'or', 'contains',
    'order', 'limit', 'range', 'filter', 'update', 'insert', 'upsert', 'delete',
  ]) {
    chain[m] = record(m);
  }
  chain.single = jest.fn(() => Promise.resolve(resolved));
  chain.maybeSingle = jest.fn(() => Promise.resolve(resolved));
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);

  const from = jest.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return chain;
  });

  return { from, calls, chain };
}

describe('engagement-events-repository', () => {
  describe('fetchUserConnectionEdges', () => {
    it('scopes to tenant/source/target connected-edge shape and caller-supplied limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUserConnectionEdges(sb as any, 't1', 'u1', 10);
      expect(sb.from).toHaveBeenCalledWith('relationship_edges');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['source_type', 'person'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['source_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['target_type', 'person'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['edge_type', 'connected'] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [10] });
    });
  });

  describe('fetchAttendingConnectionsForEvent', () => {
    it('filters global_event_participants by event, user set, and attending status', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchAttendingConnectionsForEvent(sb as any, 'ev1', ['u1', 'u2']);
      expect(sb.from).toHaveBeenCalledWith('global_event_participants');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['event_id', 'ev1'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['user_id', ['u1', 'u2']] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'attending'] });
    });
  });

  describe('fetchAttendingParticipants', () => {
    it('filters by event + attending status only (no user-id scope)', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchAttendingParticipants(sb as any, 'ev1');
      expect(sb.from).toHaveBeenCalledWith('global_event_participants');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['event_id', 'ev1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'attending'] });
    });
  });

  describe('countUserRegisteredForEvent', () => {
    it('uses a head-count query scoped to event + user', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countUserRegisteredForEvent(sb as any, 'ev1', 'u1');
      expect(sb.from).toHaveBeenCalledWith('global_event_participants');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id', { count: 'exact', head: true }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['event_id', 'ev1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });
  });

  describe('fetchUserDisplayName', () => {
    it('reads app_users by user_id', async () => {
      const sb = makeSupabaseStub({ data: { display_name: 'Ada' } });
      await repo.fetchUserDisplayName(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('app_users');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.chain.maybeSingle).toHaveBeenCalled();
    });
  });

  describe('fetchEndedEventsInWindow', () => {
    it('bounds global_community_events end_time between the two window edges', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchEndedEventsInWindow(sb as any, '2026-01-01T00:00:00.000Z', '2026-01-01T06:00:00.000Z', 100);
      expect(sb.from).toHaveBeenCalledWith('global_community_events');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['end_time', '2026-01-01T00:00:00.000Z'] });
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['end_time', '2026-01-01T06:00:00.000Z'] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [100] });
    });
  });

  describe('fetchTrendingUpcomingEvents', () => {
    it('orders by participant_count descending within the start_time window', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchTrendingUpcomingEvents(sb as any, 'from-iso', 'to-iso', 10);
      expect(sb.from).toHaveBeenCalledWith('global_community_events');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['start_time', 'from-iso'] });
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['start_time', 'to-iso'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['participant_count', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [10] });
    });
  });

  describe('fetchUpcomingEventsForConcierge', () => {
    it('excludes events with no created_by, orders soonest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUpcomingEventsForConcierge(sb as any, 'lead-cutoff', 'horizon-cutoff', 500);
      expect(sb.from).toHaveBeenCalledWith('global_community_events');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['start_time', 'lead-cutoff'] });
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['start_time', 'horizon-cutoff'] });
      expect(sb.calls).toContainEqual({ method: 'not', args: ['created_by', 'is', null] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['start_time', { ascending: true }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [500] });
    });
  });

  describe('fetchPastPopularEvents', () => {
    it('filters ended events above the min-participants floor, newest-ended-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchPastPopularEvents(sb as any, 'now-iso', 5, 200);
      expect(sb.from).toHaveBeenCalledWith('global_community_events');
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['end_time', 'now-iso'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['participant_count', 5] });
      expect(sb.calls).toContainEqual({ method: 'not', args: ['created_by', 'is', null] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['end_time', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [200] });
    });
  });

  describe('countUpcomingEventsByCreator', () => {
    it('head-counts future events by created_by', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countUpcomingEventsByCreator(sb as any, 'host1', 'now-iso');
      expect(sb.from).toHaveBeenCalledWith('global_community_events');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['created_by', 'host1'] });
      expect(sb.calls).toContainEqual({ method: 'gt', args: ['start_time', 'now-iso'] });
    });
  });

  describe('fetchGroupsWithChatThreadForTrending', () => {
    it('requires both chat_thread_id and created_by to be non-null', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchGroupsWithChatThreadForTrending(sb as any, 500);
      expect(sb.from).toHaveBeenCalledWith('global_community_groups');
      expect(sb.calls).toContainEqual({ method: 'not', args: ['chat_thread_id', 'is', null] });
      expect(sb.calls).toContainEqual({ method: 'not', args: ['created_by', 'is', null] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [500] });
    });
  });

  describe('countRecentGroupMessages', () => {
    it('head-counts global_messages by thread since a cutoff', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countRecentGroupMessages(sb as any, 'thread1', 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('global_messages');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['thread_id', 'thread1'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', 'since-iso'] });
    });
  });

  describe('fetchRecentConciergeNudge', () => {
    it('scopes to AP-0309 in the notification data payload', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentConciergeNudge(sb as any, 'u1', 'cutoff-iso');
      expect(sb.from).toHaveBeenCalledWith('user_notifications');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['type', 'orb_proactive_message'] });
      expect(sb.calls).toContainEqual({ method: 'contains', args: ['data', { automation_id: 'AP-0309' }] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', 'cutoff-iso'] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });

  describe('fetchRecentSeriesSuggestion', () => {
    it('scopes to AP-0306 in the notification data payload', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentSeriesSuggestion(sb as any, 'u1', 'cutoff-iso');
      expect(sb.from).toHaveBeenCalledWith('user_notifications');
      expect(sb.calls).toContainEqual({ method: 'contains', args: ['data', { automation_id: 'AP-0306' }] });
    });
  });

  describe('fetchRecentLiveRoomSuggestion', () => {
    it('scopes to AP-0307 plus the specific group_id in the notification data payload', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentLiveRoomSuggestion(sb as any, 'u1', 'group1', 'cutoff-iso');
      expect(sb.from).toHaveBeenCalledWith('user_notifications');
      expect(sb.calls).toContainEqual({ method: 'contains', args: ['data', { automation_id: 'AP-0307', group_id: 'group1' }] });
    });
  });

  describe('countRecentReadNotifications', () => {
    it('head-counts notifications with a non-null read_at since a cutoff', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countRecentReadNotifications(sb as any, 'u1', 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('user_notifications');
      expect(sb.calls).toContainEqual({ method: 'not', args: ['read_at', 'is', null] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['read_at', 'since-iso'] });
    });
  });

  describe('fetchRecentStreakNudge', () => {
    it('scopes to AP-0511 plus the specific pair_key in the notification data payload', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentStreakNudge(sb as any, 'u1', 'u1-u2', 'cutoff-iso');
      expect(sb.from).toHaveBeenCalledWith('user_notifications');
      expect(sb.calls).toContainEqual({ method: 'contains', args: ['data', { automation_id: 'AP-0511', pair_key: 'u1-u2' }] });
    });
  });

  describe('fetchPrimaryTenantUsers / fetchPrimaryTenantUsersLimited', () => {
    it('fetchPrimaryTenantUsers has no limit clause', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchPrimaryTenantUsers(sb as any, 't1');
      expect(sb.from).toHaveBeenCalledWith('user_tenants');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_primary', true] });
      expect(sb.calls.some((c) => c.method === 'limit')).toBe(false);
    });

    it('fetchPrimaryTenantUsersLimited applies the caller-supplied limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchPrimaryTenantUsersLimited(sb as any, 't1', 100);
      expect(sb.calls).toContainEqual({ method: 'limit', args: [100] });
    });
  });

  describe('countRecentDailyMatches', () => {
    it('head-counts daily_matches by user since a cutoff', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countRecentDailyMatches(sb as any, 'u1', 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('daily_matches');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', 'since-iso'] });
    });
  });

  describe('fetchQuietConversations', () => {
    it('bounds chat_messages created_at between the two window edges, tenant-scoped', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchQuietConversations(sb as any, 't1', 'from-iso', 'to-iso', 50);
      expect(sb.from).toHaveBeenCalledWith('chat_messages');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', 'from-iso'] });
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['created_at', 'to-iso'] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [50] });
    });
  });

  describe('countRecentMessagesBetweenPair', () => {
    it('builds the sender/receiver OR pair exactly as the original inline query did', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countRecentMessagesBetweenPair(sb as any, 't1', 'a', 'b', 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('chat_messages');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'or', args: ['sender_id.eq.a,sender_id.eq.b'] });
      expect(sb.calls).toContainEqual({ method: 'or', args: ['receiver_id.eq.a,receiver_id.eq.b'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', 'since-iso'] });
    });
  });

  describe('fetchUserStreak', () => {
    it('reads user_diary_streak by user_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchUserStreak(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('user_diary_streak');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.chain.maybeSingle).toHaveBeenCalled();
    });
  });
});
