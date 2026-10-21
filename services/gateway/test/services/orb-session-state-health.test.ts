import {
  readOrbSessionState,
  writeOrbSessionState,
  clearOrbSessionState,
  getOrbSessionStateHealth,
  __resetOrbSessionStateHealthForTest,
} from '../../src/services/orb/orb-session-state';

// VTID-03485 — health tracking for the fail-soft orb_session_state helpers.
//
// The bug this guards against (VTID-03480): the table did not exist in prod for
// ~2 months, every write returned { ok: false }, and nothing surfaced it. These
// tests assert the failure is now *observable* — they do not change the
// fail-soft contract itself, which is still verified by orb-session-state.test.ts.

function makeSupabase(handlers: {
  maybeSingle?: () => Promise<{ data: unknown; error: unknown }>;
  upsert?: () => Promise<{ error: unknown }>;
  del?: () => Promise<{ error: unknown }>;
}) {
  const builder: Record<string, (...a: unknown[]) => unknown> = {};
  builder.eq = () => builder;
  builder.select = () => builder;
  builder.maybeSingle = () =>
    handlers.maybeSingle ? handlers.maybeSingle() : Promise.resolve({ data: null, error: null });
  builder.upsert = () => (handlers.upsert ? handlers.upsert() : Promise.resolve({ error: null }));
  builder.delete = () => ({
    eq: () => ({ eq: () => (handlers.del ? handlers.del() : Promise.resolve({ error: null })) }),
  });
  return { from: () => builder } as unknown as Parameters<typeof readOrbSessionState>[0];
}

const NOW = Date.parse('2026-08-04T09:00:00Z');
const MISSING_RELATION = 'relation "orb_session_state" does not exist';

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  __resetOrbSessionStateHealthForTest();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('orb_session_state health — baseline', () => {
  it('starts healthy with zeroed counters', () => {
    const h = getOrbSessionStateHealth();
    expect(h.ok).toBe(true);
    expect(h.schema_missing).toBe(false);
    expect(h.degraded_ops).toEqual([]);
    expect(h.ops.write.attempts).toBe(0);
  });

  it('counts a successful write without going degraded', async () => {
    const supabase = makeSupabase({});
    await writeOrbSessionState(supabase, 'u1', 'continuity', { a: 1 }, 15, NOW);
    const h = getOrbSessionStateHealth();
    expect(h.ok).toBe(true);
    expect(h.ops.write.attempts).toBe(1);
    expect(h.ops.write.failures).toBe(0);
    expect(h.ops.write.last_success_at).not.toBeNull();
  });

  it('treats an absent row as a healthy read, not a failure', async () => {
    // The first session for a user legitimately has no row. That must not look
    // like an outage — this is the distinction the original code could not make.
    const supabase = makeSupabase({ maybeSingle: () => Promise.resolve({ data: null, error: null }) });
    const rec = await readOrbSessionState(supabase, 'u1', 'continuity', NOW);
    expect(rec).toBeNull();
    const h = getOrbSessionStateHealth();
    expect(h.ok).toBe(true);
    expect(h.ops.read.failures).toBe(0);
    expect(h.ops.read.last_success_at).not.toBeNull();
  });
});

describe('orb_session_state health — persistence, not blips', () => {
  it('stays healthy after a single transient write failure', async () => {
    const supabase = makeSupabase({ upsert: () => Promise.resolve({ error: { message: 'timeout' } }) });
    await writeOrbSessionState(supabase, 'u1', 'continuity', {}, 15, NOW);
    const h = getOrbSessionStateHealth();
    expect(h.ok).toBe(true); // one blip is not news
    expect(h.ops.write.consecutive_failures).toBe(1);
  });

  it('goes degraded on the third consecutive transient failure', async () => {
    const supabase = makeSupabase({ upsert: () => Promise.resolve({ error: { message: 'timeout' } }) });
    for (let i = 0; i < 3; i++) await writeOrbSessionState(supabase, 'u1', 'continuity', {}, 15, NOW);
    const h = getOrbSessionStateHealth();
    expect(h.ok).toBe(false);
    expect(h.degraded_ops).toContain('write');
    expect(h.ops.write.last_failure_reason).toBe('timeout');
  });

  it('resets the consecutive counter on a success', async () => {
    const failing = makeSupabase({ upsert: () => Promise.resolve({ error: { message: 'timeout' } }) });
    await writeOrbSessionState(failing, 'u1', 'continuity', {}, 15, NOW);
    await writeOrbSessionState(failing, 'u1', 'continuity', {}, 15, NOW);
    const ok = makeSupabase({});
    await writeOrbSessionState(ok, 'u1', 'continuity', {}, 15, NOW);
    const h = getOrbSessionStateHealth();
    expect(h.ok).toBe(true);
    expect(h.ops.write.consecutive_failures).toBe(0);
    expect(h.ops.write.failures).toBe(2); // lifetime total is still retained
  });

  it('logs the alert marker once, not once per failure', async () => {
    const supabase = makeSupabase({ upsert: () => Promise.resolve({ error: { message: 'timeout' } }) });
    for (let i = 0; i < 6; i++) await writeOrbSessionState(supabase, 'u1', 'continuity', {}, 15, NOW);
    // 6 failures, but the re-alert interval means only the transition logs.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('ORB_SESSION_STATE_UNHEALTHY');
  });
});

describe('orb_session_state health — missing relation (the VTID-03480 signature)', () => {
  it('flags schema_missing immediately, without waiting for three strikes', async () => {
    const supabase = makeSupabase({
      upsert: () => Promise.resolve({ error: { message: MISSING_RELATION } }),
    });
    await writeOrbSessionState(supabase, 'u1', 'continuity', {}, 15, NOW);
    const h = getOrbSessionStateHealth();
    expect(h.ok).toBe(false); // conclusive on the first occurrence
    expect(h.schema_missing).toBe(true);
    expect(h.schema_missing_detail).toBe(MISSING_RELATION);
    expect(String(errorSpy.mock.calls[0][0])).toContain('TABLE/RELATION APPEARS MISSING');
  });

  it('detects the PostgREST schema-cache phrasing too', async () => {
    const supabase = makeSupabase({
      upsert: () =>
        Promise.resolve({ error: { message: "Could not find the table 'public.orb_session_state' in the schema cache" } }),
    });
    await writeOrbSessionState(supabase, 'u1', 'continuity', {}, 15, NOW);
    expect(getOrbSessionStateHealth().schema_missing).toBe(true);
  });

  it('flags a missing relation surfaced through a failing read', async () => {
    const supabase = makeSupabase({
      maybeSingle: () => Promise.resolve({ data: null, error: { message: MISSING_RELATION } }),
    });
    await readOrbSessionState(supabase, 'u1', 'continuity', NOW);
    const h = getOrbSessionStateHealth();
    expect(h.schema_missing).toBe(true);
    expect(h.ops.read.failures).toBe(1);
  });

  it('recovers without a redeploy once the migration is applied', async () => {
    // VTID-03480 was confirmed fixed exactly this way: the migration was applied
    // and the next live session flipped ok:false -> ok:true with no deploy.
    const broken = makeSupabase({
      upsert: () => Promise.resolve({ error: { message: MISSING_RELATION } }),
    });
    await writeOrbSessionState(broken, 'u1', 'continuity', {}, 15, NOW);
    expect(getOrbSessionStateHealth().schema_missing).toBe(true);

    const fixed = makeSupabase({});
    await writeOrbSessionState(fixed, 'u1', 'continuity', {}, 15, NOW);
    const h = getOrbSessionStateHealth();
    expect(h.ok).toBe(true);
    expect(h.schema_missing).toBe(false);
    expect(warnSpy).toHaveBeenCalled(); // recovery is announced too
  });

  it('tracks clear() failures on their own op counter', async () => {
    const supabase = makeSupabase({ del: () => Promise.resolve({ error: { message: MISSING_RELATION } }) });
    await clearOrbSessionState(supabase, 'u1', 'continuity');
    const h = getOrbSessionStateHealth();
    expect(h.ops.clear.failures).toBe(1);
    expect(h.ops.write.failures).toBe(0);
    expect(h.schema_missing).toBe(true);
  });
});
