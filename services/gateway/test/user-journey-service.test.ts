/**
 * user-journey-service.ensureUserJourneyRow — seeding semantics.
 *
 * Pins BOOTSTRAP-ORB-GREETING-FIRSTTIME: the session-start backfill seeds a
 * MISSING user_journey row with is_first_session=false (an existing user the
 * backfill missed must not replay the one-time welcome), while the default
 * /me seeding path stays is_first_session=true. Idempotent on conflict.
 */

process.env.NODE_ENV = 'test';

import { ensureUserJourneyRow } from '../src/services/journey/user-journey-service';

/** Minimal fake supporting `.from(t).insert(p).select('user_id').maybeSingle()`.
 *  Captures the inserted payload and simulates a unique-violation when the
 *  user_id is already present. */
function makeFakeSupabase(existingIds: string[] = []) {
  const ids = new Set(existingIds);
  const inserts: any[] = [];
  const client: any = {
    __inserts: inserts,
    from(_table: string) {
      let payload: any = null;
      const builder: any = {
        insert(p: any) {
          payload = p;
          inserts.push(p);
          return builder;
        },
        select() { return builder; },
        maybeSingle() {
          if (ids.has(payload.user_id)) {
            return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
          }
          ids.add(payload.user_id);
          return Promise.resolve({ data: { user_id: payload.user_id }, error: null });
        },
      };
      return builder;
    },
  };
  return client;
}

describe('ensureUserJourneyRow', () => {
  it('defaults to is_first_session=true (the /me signup seeding path)', async () => {
    const sb = makeFakeSupabase();
    const created = await ensureUserJourneyRow(sb, 'user-new');
    expect(created).toBe(true);
    expect(sb.__inserts).toHaveLength(1);
    expect(sb.__inserts[0].is_first_session).toBe(true);
    expect(sb.__inserts[0].user_id).toBe('user-new');
  });

  it('seeds is_first_session=false when explicitly requested (session-start backfill)', async () => {
    const sb = makeFakeSupabase();
    const created = await ensureUserJourneyRow(sb, 'user-existing', {
      tenant_id: 'tenant-1',
      started_at: '2026-01-01T00:00:00.000Z',
      is_first_session: false,
    });
    expect(created).toBe(true);
    expect(sb.__inserts[0].is_first_session).toBe(false);
    expect(sb.__inserts[0].tenant_id).toBe('tenant-1');
    expect(sb.__inserts[0].started_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is idempotent: a duplicate (existing row) resolves false, never throws', async () => {
    const sb = makeFakeSupabase(['user-existing']);
    const created = await ensureUserJourneyRow(sb, 'user-existing', { is_first_session: false });
    expect(created).toBe(false);
  });
});
