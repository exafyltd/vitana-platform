/**
 * VTID-03991/VTID-03992 — the shared exclusion set that every real-member-
 * facing surface (Members Directory, ORB "who is...?" voice tools,
 * connect-people automations) must consult before showing a profile to a
 * real user.
 */

import { fetchExcludedTestServiceAccountIds } from '../../src/lib/excluded-test-service-accounts';

function makeFakeSupabase(resultsByTable: Record<string, { data?: any; error?: any }>) {
  return {
    from(table: string) {
      const result = resultsByTable[table] || { data: [], error: null };
      return {
        select: () => Promise.resolve(result),
      };
    },
  } as any;
}

describe('fetchExcludedTestServiceAccountIds', () => {
  it('unions service_bot_accounts and notification_test_actors user_ids', async () => {
    const sb = makeFakeSupabase({
      service_bot_accounts: { data: [{ user_id: 'bot-1' }, { user_id: 'bot-2' }], error: null },
      notification_test_actors: { data: [{ user_id: 'test-1' }, { user_id: 'bot-1' }], error: null },
    });

    const ids = await fetchExcludedTestServiceAccountIds(sb);

    expect(ids).toEqual(new Set(['bot-1', 'bot-2', 'test-1']));
  });

  it('returns an empty set, not an error, when both tables are empty', async () => {
    const sb = makeFakeSupabase({});

    const ids = await fetchExcludedTestServiceAccountIds(sb);

    expect(ids.size).toBe(0);
  });

  it('fails open — a thrown error resolves to an empty set instead of rejecting', async () => {
    const sb = {
      from() {
        throw new Error('connection reset');
      },
    } as any;

    const ids = await fetchExcludedTestServiceAccountIds(sb);

    expect(ids.size).toBe(0);
  });

  it('fails open — a rejected query promise resolves to an empty set instead of rejecting', async () => {
    const sb = {
      from() {
        return { select: () => Promise.reject(new Error('timeout')) };
      },
    } as any;

    const ids = await fetchExcludedTestServiceAccountIds(sb);

    expect(ids.size).toBe(0);
  });
});
