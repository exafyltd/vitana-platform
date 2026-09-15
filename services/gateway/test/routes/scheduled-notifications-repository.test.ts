import * as repo from '../../src/routes/scheduled-notifications-repository';

/**
 * Functional stub Supabase client — a from()-chain that records every call
 * and resolves to a configurable {data,error,count} response, matching the
 * pattern used for the other B1 repository tests (chat-groups-repository,
 * admin-marketplace-repository, etc).
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
    'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'like', 'or',
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
  const rpc = jest.fn((fn: string, args?: any) => {
    calls.push({ method: 'rpc', args: [fn, args] });
    return Promise.resolve(resolved);
  });

  return { from, rpc, calls, chain };
}

describe('scheduled-notifications-repository', () => {
  describe('fetchActiveUsersPage', () => {
    it('pages user_tenants scoped to tenant + is_primary', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchActiveUsersPage(sb as any, { tenantId: 't1', offset: 0, pageSize: 1000 });
      expect(sb.from).toHaveBeenCalledWith('user_tenants');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_primary', true] });
      expect(sb.calls).toContainEqual({ method: 'range', args: [0, 999] });
    });
  });

  describe('fetchRecentlyNotifiedChunk — VTID-03487 idempotency guard', () => {
    it('filters by tenant, type, and the lookback window', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentlyNotifiedChunk(sb as any, {
        tenantId: 't1', type: 'morning_briefing_ready', since: '2026-01-01T00:00:00.000Z', userIdChunk: ['u1', 'u2'],
      });
      expect(sb.from).toHaveBeenCalledWith('user_notifications');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['type', 'morning_briefing_ready'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', '2026-01-01T00:00:00.000Z'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['user_id', ['u1', 'u2']] });
    });
  });

  describe('briefing context fetchers', () => {
    it('fetchBriefingFacts scopes to the three known fact keys', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchBriefingFacts(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('memory_facts');
      expect(sb.calls).toContainEqual({ method: 'in', args: ['fact_key', ['display_name', 'name', 'preferred_language']] });
    });

    it('fetchBriefingHealthScores orders desc and limits to 2 (for trend delta)', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchBriefingHealthScores(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('vitana_index_scores');
      expect(sb.calls).toContainEqual({ method: 'limit', args: [2] });
    });

    it('fetchBriefingNewRecCount uses the null-or-mine OR filter', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.fetchBriefingNewRecCount(sb as any, 'u1');
      expect(sb.calls).toContainEqual({ method: 'or', args: ['user_id.is.null,user_id.eq.u1'] });
    });

    it('fetchBriefingDiaryStreakEntries limits to 14 days', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchBriefingDiaryStreakEntries(sb as any, 'u1');
      expect(sb.calls).toContainEqual({ method: 'limit', args: [14] });
    });
  });

  describe('insertDailyPacePreNotification', () => {
    it('inserts into user_notifications verbatim', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { user_id: 'u1', tenant_id: 't1', type: 'daily_pace_check' };
      await repo.insertDailyPacePreNotification(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('user_notifications');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
    });
  });

  describe('daily-feature-tip helpers', () => {
    it('fetchDidYouKnowState reads last_index for the tenant', async () => {
      const sb = makeSupabaseStub({ data: { last_index: 3 } });
      await repo.fetchDidYouKnowState(sb as any, 't1');
      expect(sb.from).toHaveBeenCalledWith('did_you_know_state');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
    });

    it('insertFeatureAnnouncement selects the inserted id back', async () => {
      const sb = makeSupabaseStub({ data: { id: 'a1' } });
      await repo.insertFeatureAnnouncement(sb as any, { tenant_id: 't1' });
      expect(sb.from).toHaveBeenCalledWith('feature_announcements');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id'] });
    });

    it('upsertDidYouKnowState upserts tenant/last_index/updated_at', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.upsertDidYouKnowState(sb as any, { tenantId: 't1', lastIndex: 4, updatedAt: '2026-01-01T00:00:00.000Z' });
      expect(sb.calls).toContainEqual({
        method: 'upsert',
        args: [{ tenant_id: 't1', last_index: 4, updated_at: '2026-01-01T00:00:00.000Z' }],
      });
    });

    it('markFeatureAnnouncementNotified sets notified_at by id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markFeatureAnnouncementNotified(sb as any, { announcementId: 'a1', notifiedAt: '2026-01-01T00:00:00.000Z' });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'a1'] });
    });
  });

  describe('meetup-reminders helpers', () => {
    it('fetchMeetupsStartingBetween scopes tenant + window', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchMeetupsStartingBetween(sb as any, { tenantId: 't1', from: 'A', to: 'B' });
      expect(sb.from).toHaveBeenCalledWith('community_meetups');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['starts_at', 'A'] });
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['starts_at', 'B'] });
    });

    it('fetchMeetupRsvps filters by meetup + rsvp status', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchMeetupRsvps(sb as any, 'm1');
      expect(sb.from).toHaveBeenCalledWith('community_meetup_attendance');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['meetup_id', 'm1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'rsvp'] });
    });
  });

  describe('fetchTodaysCalendarEvents', () => {
    it('excludes cancelled and orders ascending', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchTodaysCalendarEvents(sb as any, { todayStart: 'A', todayEnd: 'B' });
      expect(sb.calls).toContainEqual({ method: 'neq', args: ['status', 'cancelled'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['start_time', { ascending: true }] });
    });
  });

  describe('fetchExpiringRecommendations', () => {
    it('scopes to pending + the 24h expiry window', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchExpiringRecommendations(sb as any, { tenantId: 't1', tomorrow: 'B', now: 'A' });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'pending'] });
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['expires_at', 'B'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['expires_at', 'A'] });
    });
  });

  describe('signal-cleanup helpers', () => {
    it('fetchActiveExpiredSignals scopes to active + expired', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchActiveExpiredSignals(sb as any, { tenantId: 't1', now: 'A' });
      expect(sb.from).toHaveBeenCalledWith('d44_predictive_signals');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'active'] });
    });

    it('markSignalExpired updates status by id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markSignalExpired(sb as any, 's1');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ status: 'expired' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 's1'] });
    });
  });

  describe('push-dispatch helpers — VTID-03656', () => {
    it('fetchPendingPushNotifications uses the given lookback cutoff, unsent, push channels only', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchPendingPushNotifications(sb as any, '2026-01-01T00:00:00.000Z');
      expect(sb.from).toHaveBeenCalledWith('user_notifications');
      expect(sb.calls).toContainEqual({ method: 'is', args: ['push_sent_at', null] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['channel', ['push', 'push_and_inapp']] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', '2026-01-01T00:00:00.000Z'] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [100] });
    });

    it('fetchUserNotificationPreferences scopes user + tenant', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchUserNotificationPreferences(sb as any, { userId: 'u1', tenantId: 't1' });
      expect(sb.from).toHaveBeenCalledWith('user_notification_preferences');
    });

    it('markNotificationPushSent stamps push_sent_at by id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markNotificationPushSent(sb as any, 'n1', '2026-01-01T00:00:00.000Z');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ push_sent_at: '2026-01-01T00:00:00.000Z' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'n1'] });
    });
  });

  describe('recommendation-cleanup helpers — VTID-01185', () => {
    it('expireOverdueRecommendations only targets status=new with a set, past expires_at', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.expireOverdueRecommendations(sb as any, 'NOW');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'new'] });
      expect(sb.calls).toContainEqual({ method: 'not', args: ['expires_at', 'is', null] });
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['expires_at', 'NOW'] });
    });

    it('unsnoozeOverdueRecommendations resets snoozed rows to new', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.unsnoozeOverdueRecommendations(sb as any, 'NOW');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ status: 'new', snoozed_until: null, updated_at: 'NOW' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'snoozed'] });
    });

    it('purgeStaleRecommendationSeeds only targets fingerprint-less rows older than 30d', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.purgeStaleRecommendationSeeds(sb as any, { now: 'NOW', thirtyDaysAgo: 'OLD' });
      expect(sb.calls).toContainEqual({ method: 'is', args: ['fingerprint', null] });
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['created_at', 'OLD'] });
    });

    it('rpcCleanupExpiredAutopilotRecommendations calls the RPC by name', async () => {
      const sb = makeSupabaseStub();
      await repo.rpcCleanupExpiredAutopilotRecommendations(sb as any);
      expect(sb.rpc).toHaveBeenCalledWith('cleanup_expired_autopilot_recommendations');
    });
  });

  describe('reminders-tick helpers — VTID-02601', () => {
    it('rpcClaimDueReminders passes lookahead/limit as p_ params', async () => {
      const sb = makeSupabaseStub();
      await repo.rpcClaimDueReminders(sb as any, { lookaheadSeconds: 15, limit: 200 });
      expect(sb.rpc).toHaveBeenCalledWith('reminders_claim_due', { p_lookahead_seconds: 15, p_limit: 200 });
    });

    it('fallbackClaimDueReminders claims pending rows due within the lookahead and returns them', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fallbackClaimDueReminders(sb as any, { lookahead: 'L', dispatchStartedAt: 'D', limit: 200 });
      expect(sb.from).toHaveBeenCalledWith('reminders');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ status: 'dispatching', dispatch_started_at: 'D' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'pending'] });
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['next_fire_at', 'L'] });
      expect(sb.calls).toContainEqual({ method: 'select', args: ['*'] });
    });

    it('markReminderFired sets status=fired + fired_at', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markReminderFired(sb as any, { reminderId: 'r1', firedAt: 'F' });
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ status: 'fired', fired_at: 'F' }] });
    });
  });

  describe('reminders-sweeper helpers — VTID-02601', () => {
    it('fetchStuckDispatchingReminders finds rows stuck before the cutoff', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchStuckDispatchingReminders(sb as any, { cutoff: 'C', limit: 500 });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'dispatching'] });
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['dispatch_started_at', 'C'] });
    });

    it('updateReminderRecoveryStatus writes the recomputed status/attempts and clears dispatch_started_at', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.updateReminderRecoveryStatus(sb as any, { reminderId: 'r1', newStatus: 'pending', attempts: 2 });
      expect(sb.calls).toContainEqual({
        method: 'update',
        args: [{ status: 'pending', dispatch_attempts: 2, dispatch_started_at: null }],
      });
    });
  });

  describe('scheduleReminderFcmPush helpers — VTID-03481', () => {
    it('countAppilixNativeDeviceTokens filters non-revoked Appilix-labeled tokens', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countAppilixNativeDeviceTokens(sb as any, { userId: 'u1', tenantId: 't1' });
      expect(sb.from).toHaveBeenCalledWith('user_device_tokens');
      expect(sb.calls).toContainEqual({ method: 'is', args: ['revoked_at', null] });
      expect(sb.calls).toContainEqual({ method: 'like', args: ['device_label', 'Appilix %'] });
    });

    it('markReminderDeliveredViaFcm only touches rows still unacked', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markReminderDeliveredViaFcm(sb as any, 'r1');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ delivery_via: 'fcm' }] });
      expect(sb.calls).toContainEqual({ method: 'is', args: ['acked_at', null] });
    });
  });

  describe('night-push helpers — VTID-03604', () => {
    it('fetchUserJourneyNightDates reads both stamp columns for one user', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchUserJourneyNightDates(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('user_journey');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['last_day_close_date, last_night_push_date'] });
    });

    it('updateLastNightPushDate stamps the night key for that user', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.updateLastNightPushDate(sb as any, { userId: 'u1', nightKey: '2026-06-30' });
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ last_night_push_date: '2026-06-30' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });
  });
});
