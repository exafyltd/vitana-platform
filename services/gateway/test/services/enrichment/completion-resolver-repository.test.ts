/**
 * VTID-05143 (builds VTID-05085 Phase 1) — the repository asks each source
 * table exactly what the verified plan says (no social_connections.status,
 * revoked device tokens excluded, calendar apps only), always scoped to the
 * caller's user_id.
 */
import * as repo from '../../../src/services/enrichment/completion-resolver-repository';

type Call = { table: string; ops: Array<[string, unknown[]]> };

function recorder() {
  const calls: Call[] = [];
  const sb: any = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const chain: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'then') return (res: any) => res({ data: [], error: null });
          return (...args: unknown[]) => { call.ops.push([prop, args]); return chain; };
        },
      });
      return chain;
    },
  };
  return { sb, calls };
}

const U = 'user-a';
const op = (c: Call, name: string) => c.ops.filter(([n]) => n === name).map(([, a]) => a);

it('profiles: the five enrichment fields of the caller', async () => {
  const { sb, calls } = recorder();
  await repo.fetchProfileEnrichmentFields(sb, U);
  expect(calls[0].table).toBe('profiles');
  expect(op(calls[0], 'select')[0][0]).toBe('avatar_url, bio, location, cover_url, universal_intent_cover_url, interests');
  expect(op(calls[0], 'eq')).toEqual([['user_id', U]]);
});

it('social_connections: is_active + disconnected_at IS NULL, instagram/facebook, no status column', async () => {
  const { sb, calls } = recorder();
  await repo.fetchActiveSocialConnections(sb, U);
  const c = calls[0];
  expect(c.table).toBe('social_connections');
  expect(op(c, 'eq')).toEqual([['user_id', U], ['is_active', true]]);
  expect(op(c, 'is')).toEqual([['disconnected_at', null]]);
  expect(op(c, 'in')).toEqual([['provider', ['instagram', 'facebook']]]);
  expect(JSON.stringify(c.ops)).not.toContain('status');
});

it('connected_app_settings: enabled calendar apps only', async () => {
  const { sb, calls } = recorder();
  await repo.fetchEnabledCalendarApp(sb, U);
  expect(calls[0].table).toBe('connected_app_settings');
  expect(op(calls[0], 'in')).toEqual([['app_id', ['google-calendar', 'outlook-calendar', 'apple-calendar']]]);
  expect(op(calls[0], 'eq')).toEqual([['user_id', U], ['enabled', true]]);
});

it('user_device_tokens: not revoked, token present', async () => {
  const { sb, calls } = recorder();
  await repo.fetchActiveDeviceToken(sb, U);
  expect(calls[0].table).toBe('user_device_tokens');
  expect(op(calls[0], 'is')).toEqual([['revoked_at', null]]);
  expect(op(calls[0], 'not')).toEqual([['fcm_token', 'is', null]]);
});

it('profile_posts and contacts: one row is enough', async () => {
  const { sb, calls } = recorder();
  await repo.fetchAnyProfilePost(sb, U);
  await repo.fetchAnyContact(sb, U);
  expect(calls.map((c) => c.table)).toEqual(['profile_posts', 'contacts']);
  for (const c of calls) {
    expect(op(c, 'eq')).toEqual([['user_id', U]]);
    expect(op(c, 'limit')).toEqual([[1]]);
  }
});

it('dismissal upsert writes only the caller row and never cooldown_days', async () => {
  const { sb, calls } = recorder();
  await repo.upsertEnrichmentCardDismissal(sb, U, 'E1', '2026-10-13T10:00:00.000Z');
  const [row, opts] = op(calls[0], 'upsert')[0] as [Record<string, unknown>, Record<string, unknown>];
  expect(calls[0].table).toBe('user_enrichment_cards');
  expect(row).toEqual({ user_id: U, card_type: 'E1', dismissed_at: '2026-10-13T10:00:00.000Z', updated_at: '2026-10-13T10:00:00.000Z' });
  expect(opts).toEqual({ onConflict: 'user_id,card_type' });
});

// ==================== Boost trigger sources (Phase 3) ====================

it('G1 profiles: every field useProfileProgress weighs, the caller only', async () => {
  const { sb, calls } = recorder();
  await repo.fetchProfileProgressFields(sb, U);
  expect(calls[0].table).toBe('profiles');
  expect(op(calls[0], 'select')[0][0]).toBe(
    'display_name, handle, avatar_url, bio, location, links, cover_url, universal_intent_cover_url, languages, service_offerings',
  );
  expect(op(calls[0], 'eq')).toEqual([['user_id', U]]);
  expect(op(calls[0], 'maybeSingle')).toHaveLength(1);
});

it('G2 daily_matches: a head count of the caller\'s live, untouched, unseen matches', async () => {
  const { sb, calls } = recorder();
  await repo.countUnseenLiveMatches(sb, U, '2026-10-13T12:00:00.000Z');
  const c = calls[0];
  expect(c.table).toBe('daily_matches');
  expect(op(c, 'select')[0]).toEqual(['matched_user_id', { count: 'exact', head: true }]);
  expect(op(c, 'eq')).toEqual([['user_id', U]]);
  expect(op(c, 'gt')).toEqual([['expires_at', '2026-10-13T12:00:00.000Z']]);
  expect(op(c, 'is')).toEqual([['action', null], ['viewed_at', null]]);
  expect(JSON.stringify(c.ops)).not.toMatch(/update|upsert|insert|delete/);
});

it('G3 diary_entries: the caller\'s entry times since the look-back, newest first, bounded', async () => {
  const { sb, calls } = recorder();
  await repo.fetchRecentDiaryEntryTimes(sb, U, '2026-06-15T00:00:00.000Z');
  const c = calls[0];
  expect(c.table).toBe('diary_entries');
  expect(op(c, 'select')[0][0]).toBe('created_at');
  expect(op(c, 'eq')).toEqual([['user_id', U]]);
  expect(op(c, 'gte')).toEqual([['created_at', '2026-06-15T00:00:00.000Z']]);
  expect(op(c, 'order')).toEqual([['created_at', { ascending: false }]]);
  expect(op(c, 'limit')).toEqual([[repo.DIARY_STREAK_ROW_LIMIT]]);
});
