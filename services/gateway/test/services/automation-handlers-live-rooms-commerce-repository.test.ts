import * as repo from '../../src/services/automation-handlers/live-rooms-commerce-repository';

/**
 * Functional stub Supabase client — a from()-chain that records every call
 * and resolves to a configurable {data,error,count} response, matching the
 * pattern used for the other B1 repository tests.
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

  return { from, calls, chain };
}

describe('live-rooms-commerce-repository', () => {
  describe('fetchRoomTitleAndStart / fetchRoomTitleAndTopics / fetchRoomTitle / fetchRoomTitleAndHost', () => {
    it('each reads live_rooms by id with a distinct column list', async () => {
      const sb1 = makeSupabaseStub({ data: null });
      await repo.fetchRoomTitleAndStart(sb1 as any, 'r1');
      expect(sb1.calls).toContainEqual({ method: 'select', args: ['title, starts_at'] });

      const sb2 = makeSupabaseStub({ data: null });
      await repo.fetchRoomTitleAndTopics(sb2 as any, 'r1');
      expect(sb2.calls).toContainEqual({ method: 'select', args: ['title, topic_keys'] });

      const sb3 = makeSupabaseStub({ data: null });
      await repo.fetchRoomTitle(sb3 as any, 'r1');
      expect(sb3.calls).toContainEqual({ method: 'select', args: ['title'] });

      const sb4 = makeSupabaseStub({ data: null });
      await repo.fetchRoomTitleAndHost(sb4 as any, 'r1');
      expect(sb4.calls).toContainEqual({ method: 'select', args: ['title, host_user_id'] });
    });
  });

  describe('fetchEndedRoomsSince', () => {
    it('scopes to tenant + status=ended + created_at cutoff', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchEndedRoomsSince(sb as any, 't1', 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('live_rooms');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'ended'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', 'since-iso'] });
    });
  });

  describe('fetchRecentHostedRoomsWithPricing', () => {
    it('excludes null host and applies the caller window+limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentHostedRoomsWithPricing(sb as any, 't1', 'since-iso', 2000);
      expect(sb.calls).toContainEqual({ method: 'not', args: ['host_user_id', 'is', null] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [2000] });
    });
  });

  describe('fetchScheduledSessionsInWindow', () => {
    it('scopes to status=scheduled within the starts_at window', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchScheduledSessionsInWindow(sb as any, 't1', 'from-iso', 'to-iso');
      expect(sb.from).toHaveBeenCalledWith('live_room_sessions');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'scheduled'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['starts_at', 'from-iso'] });
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['starts_at', 'to-iso'] });
    });
  });

  describe('fetchRecentAttendeeUserIds / countAttendanceForRoom / countAttendanceForRoomIds', () => {
    it('recent-attendees scopes by tenant + joined_at', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentAttendeeUserIds(sb as any, 't1', 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('live_room_attendance');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['joined_at', 'since-iso'] });
    });

    it('countAttendanceForRoom scopes by a single room id, no date filter', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countAttendanceForRoom(sb as any, 'r1');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['live_room_id', 'r1'] });
      expect(sb.calls.some((c) => c.method === 'gte')).toBe(false);
    });

    it('countAttendanceForRoomIds scopes by a room-id set, no date filter (distinct from the single-room variant)', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countAttendanceForRoomIds(sb as any, ['r1', 'r2']);
      expect(sb.calls).toContainEqual({ method: 'in', args: ['live_room_id', ['r1', 'r2']] });
    });
  });

  describe('fetchAnyTenantService / fetchServicesByTypeWithProvider', () => {
    it('fetchAnyTenantService has no service_type filter and returns a single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchAnyTenantService(sb as any, 't1', 1);
      expect(sb.from).toHaveBeenCalledWith('services_catalog');
      expect(sb.calls.some((c) => c.method === 'eq' && c.args[0] === 'service_type')).toBe(false);
      expect(sb.chain.maybeSingle).toHaveBeenCalled();
    });

    it('fetchServicesByTypeWithProvider filters by service_type and returns a list', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchServicesByTypeWithProvider(sb as any, 't1', 'doctor', 3);
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['service_type', 'doctor'] });
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id, name, service_type, provider_name'] });
    });
  });

  describe('fetchInterestedUsers', () => {
    it('filters by interest set + min confidence', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchInterestedUsers(sb as any, ['fitness'], 50, 20);
      expect(sb.from).toHaveBeenCalledWith('user_interests');
      expect(sb.calls).toContainEqual({ method: 'in', args: ['interest', ['fitness']] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['confidence_score', 50] });
    });
  });

  describe('fetchOnboardedCreators / fetchVitanaIdsForUsers / countRoomsByHost', () => {
    it('fetchOnboardedCreators filters stripe_charges_enabled + onboarded cutoff', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchOnboardedCreators(sb as any, 'cutoff-iso');
      expect(sb.from).toHaveBeenCalledWith('app_users');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['stripe_charges_enabled', true] });
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['stripe_onboarded_at', 'cutoff-iso'] });
    });

    it('fetchVitanaIdsForUsers scopes by user_id set', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchVitanaIdsForUsers(sb as any, ['u1', 'u2']);
      expect(sb.calls).toContainEqual({ method: 'in', args: ['user_id', ['u1', 'u2']] });
    });

    it('countRoomsByHost scopes by host_user_id', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countRoomsByHost(sb as any, 'host1');
      expect(sb.from).toHaveBeenCalledWith('live_rooms');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['host_user_id', 'host1'] });
    });
  });

  describe('fetchRecentHighlights', () => {
    it('scopes by tenant + room, newest-first, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentHighlights(sb as any, 't1', 'r1', 5);
      expect(sb.from).toHaveBeenCalledWith('live_highlights');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['live_room_id', 'r1'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
    });
  });

  describe('fetchServicePaymentsForPayee', () => {
    it('scopes by payee_vitana_id and state set', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchServicePaymentsForPayee(sb as any, 'vitana1', ['captured', 'released'], 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('service_payments');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['payee_vitana_id', 'vitana1'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['state', ['captured', 'released']] });
    });
  });
});
