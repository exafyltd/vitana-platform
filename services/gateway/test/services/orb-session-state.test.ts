import {
  readOrbSessionState,
  writeOrbSessionState,
  clearOrbSessionState,
} from '../../src/services/orb/orb-session-state';

// DEV-COMHU-0503 — ORB Recovery 2+3: orb_session_state read/write helper.
// Exercised against a hand-rolled Supabase query-builder mock (no live DB).

function makeSupabase(handlers: {
  maybeSingle?: () => Promise<{ data: unknown; error: unknown }>;
  upsert?: (rows: unknown, opts: unknown) => Promise<{ error: unknown }>;
  del?: () => Promise<{ error: unknown }>;
}) {
  const calls: Record<string, unknown[]> = { upsert: [] };
  const builder: Record<string, (...a: unknown[]) => unknown> = {};
  // chainable .eq()
  builder.eq = () => builder;
  builder.select = () => builder;
  builder.maybeSingle = () => (handlers.maybeSingle ? handlers.maybeSingle() : Promise.resolve({ data: null, error: null }));
  builder.upsert = (rows: unknown, opts: unknown) => {
    calls.upsert.push({ rows, opts });
    return handlers.upsert ? handlers.upsert(rows, opts) : Promise.resolve({ error: null });
  };
  builder.delete = () => ({ eq: () => ({ eq: () => (handlers.del ? handlers.del() : Promise.resolve({ error: null })) }) });
  return {
    supabase: { from: () => builder } as unknown as Parameters<typeof readOrbSessionState>[0],
    calls,
  };
}

const NOW = Date.parse('2026-05-31T12:00:00Z');

describe('readOrbSessionState', () => {
  it('returns the value when present and not expired', async () => {
    const { supabase } = makeSupabase({
      maybeSingle: () => Promise.resolve({
        data: { value: { conversation_id: 'c1' }, expires_at: new Date(NOW + 60_000).toISOString() },
        error: null,
      }),
    });
    const rec = await readOrbSessionState(supabase, 'u1', 'continuity', NOW);
    expect(rec).not.toBeNull();
    expect(rec!.value).toEqual({ conversation_id: 'c1' });
  });

  it('returns null when expired', async () => {
    const { supabase } = makeSupabase({
      maybeSingle: () => Promise.resolve({
        data: { value: { x: 1 }, expires_at: new Date(NOW - 1000).toISOString() },
        error: null,
      }),
    });
    expect(await readOrbSessionState(supabase, 'u1', 'continuity', NOW)).toBeNull();
  });

  it('fails open (null) on error or missing identity', async () => {
    const { supabase } = makeSupabase({
      maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
    });
    expect(await readOrbSessionState(supabase, 'u1', 'continuity', NOW)).toBeNull();
    expect(await readOrbSessionState(supabase, '', 'continuity', NOW)).toBeNull();
  });
});

describe('writeOrbSessionState', () => {
  it('upserts with a computed expires_at from ttlMinutes', async () => {
    const { supabase, calls } = makeSupabase({});
    const res = await writeOrbSessionState(supabase, 'u1', 'continuity', { a: 1 }, 15, NOW);
    expect(res.ok).toBe(true);
    const row = (calls.upsert[0] as { rows: Record<string, unknown> }).rows;
    expect(row.user_id).toBe('u1');
    expect(row.key).toBe('continuity');
    expect(row.expires_at).toBe(new Date(NOW + 15 * 60_000).toISOString());
  });

  it('defaults a non-positive ttl to 15 minutes', async () => {
    const { supabase, calls } = makeSupabase({});
    await writeOrbSessionState(supabase, 'u1', 'pending_cta', {}, 0, NOW);
    const row = (calls.upsert[0] as { rows: Record<string, unknown> }).rows;
    expect(row.expires_at).toBe(new Date(NOW + 15 * 60_000).toISOString());
  });

  it('returns ok=false on missing identity', async () => {
    const { supabase } = makeSupabase({});
    expect((await writeOrbSessionState(supabase, '', 'continuity', {}, 15, NOW)).ok).toBe(false);
  });
});

describe('clearOrbSessionState', () => {
  it('deletes without throwing', async () => {
    const { supabase } = makeSupabase({ del: () => Promise.resolve({ error: null }) });
    expect((await clearOrbSessionState(supabase, 'u1', 'continuity')).ok).toBe(true);
  });
});
