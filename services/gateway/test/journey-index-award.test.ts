/**
 * BOOTSTRAP-GUIDED-JOURNEY-POPUP — Guided Journey "+2 Vitana Index for
 * listening" award ledger. Verifies:
 *  - first listen of a topic awards (+2); replays are idempotent no-ops
 *  - the engagement bonus sums distinct topics and is clamped to the max
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  recordSessionListen,
  getJourneyEngagementBonus,
  SESSION_INDEX_POINTS,
  MAX_ENGAGEMENT_BONUS,
} from '../src/services/guided-journey/journey-index-award';

/**
 * Minimal in-memory stand-in for the `journey_session_index_awards` table that
 * honours the (user_id, topic_id) primary key + ignoreDuplicates upsert.
 */
function mockClient(): { client: SupabaseClient; rows: Array<{ user_id: string; topic_id: string; points: number }> } {
  const rows: Array<{ user_id: string; topic_id: string; points: number }> = [];
  const client = {
    from(_table: string) {
      return {
        upsert(
          row: { user_id: string; topic_id: string; points: number },
          _opts: { onConflict: string; ignoreDuplicates: boolean },
        ) {
          const exists = rows.some((r) => r.user_id === row.user_id && r.topic_id === row.topic_id);
          if (!exists) rows.push({ ...row });
          return {
            // ignoreDuplicates: a freshly-inserted row is returned; a duplicate yields [].
            select(_cols: string) {
              return Promise.resolve({ data: exists ? [] : [{ topic_id: row.topic_id }], error: null });
            },
          };
        },
        select(_cols: string) {
          return {
            eq(_col: string, userId: string) {
              return Promise.resolve({
                data: rows.filter((r) => r.user_id === userId).map((r) => ({ points: r.points })),
                error: null,
              });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, rows };
}

describe('journey-index-award', () => {
  const USER = 'user-1';

  it('awards +2 on first listen and is idempotent on replay', async () => {
    const { client } = mockClient();

    const first = await recordSessionListen(client, USER, 'T001');
    expect(first.awarded).toBe(true);
    expect(first.points).toBe(SESSION_INDEX_POINTS);
    expect(first.totalBonus).toBe(2);

    const replay = await recordSessionListen(client, USER, 'T001');
    expect(replay.awarded).toBe(false);
    expect(replay.totalBonus).toBe(2); // unchanged — no double award
  });

  it('sums distinct topics into the engagement bonus', async () => {
    const { client } = mockClient();
    await recordSessionListen(client, USER, 'T001');
    await recordSessionListen(client, USER, 'T002');
    await recordSessionListen(client, USER, 'T002'); // replay, no-op
    expect(await getJourneyEngagementBonus(client, USER)).toBe(4);
  });

  it('clamps the bonus to the maximum', async () => {
    const { client, rows } = mockClient();
    // Seed more awards than the clamp allows.
    const topics = Math.ceil(MAX_ENGAGEMENT_BONUS / SESSION_INDEX_POINTS) + 50;
    for (let i = 0; i < topics; i++) {
      rows.push({ user_id: USER, topic_id: `T${i}`, points: SESSION_INDEX_POINTS });
    }
    expect(await getJourneyEngagementBonus(client, USER)).toBe(MAX_ENGAGEMENT_BONUS);
  });

  it('returns 0 bonus for an unknown user', async () => {
    const { client } = mockClient();
    expect(await getJourneyEngagementBonus(client, '')).toBe(0);
    expect(await getJourneyEngagementBonus(client, 'nobody')).toBe(0);
  });
});
