/**
 * VTID-05367 (plan messenger-vitana-cards-v2, lane companion-enrichment-signals)
 * — bulk enrichment completion + dismissal for the companion tick.
 * `npx jest test/vtid-05367-companion-enrichment-signals.test.ts`
 *
 * Pins the sparred contracts:
 *  - R1-F3: completion is false-initialized for all 11 cards, so a member with
 *    no source rows (not even a profiles row) is eligible, never "unknown".
 *  - R2-F2: the seam never throws; a failed source is named in `unavailable`
 *    and the tick keeps going.
 *  - R3-F1: the eligible set is computed in the tick with the real `now`, so
 *    the 7-day dismissal cooldown is honoured (dismissed 3 days ago → hidden,
 *    8 days ago → back).
 *  - R2-F3: `unavailableEnrichmentCards()` is passed, so E6/E7 are hidden while
 *    the Meta OAuth clients are unset.
 */
const mockStrict = jest.fn();
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...a: unknown[]) => mockStrict(...a),
  fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set<string>()),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import { fetchEnrichmentCompletions, type EnrichmentCompletions } from '../src/services/companion/signals';
import { runCompanionTick } from '../src/services/companion/companion-service';
import type { CompanionConfig } from '../src/services/companion/config';
import type { MemberContext } from '../src/services/companion/moments';
import { ENRICHMENT_CARD_TYPES } from '../src/services/enrichment/card-catalog';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FULL = '11111111-1111-4111-8111-111111111111';
const EMPTY = '22222222-2222-4222-8222-222222222222';
// 2026-10-20 06:15 UTC = 08:15 Berlin (CEST) — inside the delivery window.
const NOW = new Date('2026-10-20T06:15:00Z');
const DAY_MS = 86_400_000;

const shadowConfig: CompanionConfig = {
  mode: 'shadow', reason: 'shadow', windowStartMin: 450, windowEndMin: 570,
  shadowComposeLimit: 20, model: 'eu.anthropic.claude-sonnet-4-6', fallbackModel: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
};

const META_ENV = ['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET', 'FACEBOOK_CLIENT_ID', 'FACEBOOK_CLIENT_SECRET'];
const savedEnv: Record<string, string | undefined> = {};

/** A small PostgREST-shaped fake: select/eq/in/is/not/gte/order/range/limit + await. */
function fakeSb(tables: Record<string, any[]>, failing: Set<string> = new Set()) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let range: [number, number] | null = null;
    let head = false;
    const q: any = {
      select: (_c: string, o?: { head?: boolean }) => { head = !!o?.head; return q; },
      order: () => q,
      limit: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      not: (c: string, _op: string, _v: null) => { filters.push((r) => r[c] !== null && r[c] !== undefined); return q; },
      gte: (c: string, v: any) => { filters.push((r) => String(r[c]) >= String(v)); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      range: (a: number, b: number) => { range = [a, b]; return q; },
      then: (ok: any, ko: any) => {
        if (failing.has(table)) return Promise.resolve({ data: null, error: { message: `${table} down` } }).then(ok, ko);
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return Promise.resolve(head ? { count: rows.length, data: null, error: null } : { data: rows, error: null }).then(ok, ko);
      },
    };
    return q;
  }
  return { from } as any;
}

function enrichmentTables(): Record<string, any[]> {
  return {
    profiles: [{
      user_id: FULL,
      avatar_url: 'https://x/a.jpg',
      bio: 'A bio that is clearly longer than fifty characters, so it counts as done.',
      location: 'Berlin',
      cover_url: 'https://x/c.jpg',
      universal_intent_cover_url: null,
      interests: ['sleep'],
    }],
    profile_posts: [{ user_id: FULL }],
    social_connections: [
      { user_id: FULL, provider: 'instagram', is_active: true, disconnected_at: null },
      { user_id: FULL, provider: 'facebook', is_active: true, disconnected_at: null },
      // Must NOT count: inactive / disconnected rows for EMPTY.
      { user_id: EMPTY, provider: 'instagram', is_active: false, disconnected_at: null },
      { user_id: EMPTY, provider: 'facebook', is_active: true, disconnected_at: '2026-10-01T00:00:00Z' },
    ],
    connected_app_settings: [
      { user_id: FULL, app_id: 'google-calendar', enabled: true },
      { user_id: EMPTY, app_id: 'google-calendar', enabled: false }, // disabled: not done
    ],
    contacts: [{ user_id: FULL }],
    user_device_tokens: [
      { user_id: FULL, revoked_at: null, fcm_token: 'tok' },
      { user_id: EMPTY, revoked_at: '2026-10-01T00:00:00Z', fcm_token: 'old' }, // revoked: not done
    ],
    user_enrichment_cards: [
      { user_id: EMPTY, card_type: 'E8', dismissed_at: '2026-10-17T06:15:00Z', cooldown_days: 7 },
    ],
  };
}

beforeEach(() => {
  for (const k of META_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  mockStrict.mockResolvedValue({ ok: true, ids: new Set<string>() });
});
afterEach(() => {
  for (const k of META_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('VTID-05367: fetchEnrichmentCompletions (bulk, per page)', () => {
  it('computes E1–E11 for every member; a fully set-up member is done on all 11', async () => {
    const r = await fetchEnrichmentCompletions(fakeSb(enrichmentTables()), [FULL, EMPTY]);
    expect(r.unavailable).toEqual([]);
    const full = r.completions.get(FULL)!;
    for (const t of ENRICHMENT_CARD_TYPES) expect(full.get(t)).toBe(true);
  });

  it('R1-F3: a member with no source rows (no profiles row) has all 11 = false, never absent', async () => {
    const r = await fetchEnrichmentCompletions(fakeSb(enrichmentTables()), [FULL, EMPTY]);
    const empty = r.completions.get(EMPTY)!;
    expect(empty.size).toBe(ENRICHMENT_CARD_TYPES.length);
    for (const t of ENRICHMENT_CARD_TYPES) expect(empty.get(t)).toBe(false);
  });

  it('matches the per-member rules: inactive/disconnected social, disabled calendar and revoked tokens do not count', async () => {
    const r = await fetchEnrichmentCompletions(fakeSb(enrichmentTables()), [EMPTY]);
    const empty = r.completions.get(EMPTY)!;
    expect(empty.get('E6')).toBe(false);
    expect(empty.get('E7')).toBe(false);
    expect(empty.get('E8')).toBe(false);
    expect(empty.get('E10')).toBe(false);
  });

  it('groups user_enrichment_cards dismissal rows per member', async () => {
    const r = await fetchEnrichmentCompletions(fakeSb(enrichmentTables()), [FULL, EMPTY]);
    expect(r.dismissals.get(FULL)).toEqual([]);
    expect(r.dismissals.get(EMPTY)).toEqual([{ card_type: 'E8', dismissed_at: '2026-10-17T06:15:00Z', cooldown_days: 7 }]);
  });

  it('R2-F2: a failing source never throws — it is reported and NO member gets enrichment state (empty maps)', async () => {
    const r = await fetchEnrichmentCompletions(fakeSb(enrichmentTables(), new Set(['profiles'])), [FULL, EMPTY]);
    expect(r.unavailable).toEqual(['enrichment_profiles']);
    // Unknown state must never look "not done": nothing for anyone this tick.
    expect(r.completions.size).toBe(0);
    expect(r.dismissals.size).toBe(0);
  });

  it('R2-F2: a failing dismissal read alone also yields no state (cooldowns cannot be honoured)', async () => {
    const r = await fetchEnrichmentCompletions(fakeSb(enrichmentTables(), new Set(['user_enrichment_cards'])), [EMPTY]);
    expect(r.unavailable).toEqual(['enrichment_dismissals']);
    expect(r.completions.size).toBe(0);
  });

  it('R2-F2: every source failing still resolves (every label reported, empty maps)', async () => {
    const all = new Set(['profiles', 'profile_posts', 'social_connections', 'connected_app_settings', 'contacts', 'user_device_tokens', 'user_enrichment_cards']);
    const r = await fetchEnrichmentCompletions(fakeSb(enrichmentTables(), all), [FULL]);
    expect(r.unavailable.sort()).toEqual([
      'enrichment_calendar', 'enrichment_contacts', 'enrichment_device_tokens', 'enrichment_dismissals',
      'enrichment_posts', 'enrichment_profiles', 'enrichment_social',
    ]);
    expect(r.completions.size).toBe(0);
  });
});

// ── the tick: the eligible set reaches MemberContext ──────────────────────────
function tickTables(): Record<string, any[]> {
  return {
    user_tenants: [{ user_id: EMPTY, tenant_id: T, is_primary: true }],
    profiles: [{ user_id: EMPTY, first_name: 'Mila', timezone: 'Europe/Berlin' }],
    companion_preferences: [],
    onboarding_touch_ledger: [],
    companion_messages_ledger: [],
  };
}

function tickSb(tables: Record<string, any[]>) {
  const base = fakeSb(tables);
  let nextId = 1;
  const rpc = jest.fn(async (fn: string, a: any) => {
    if (fn === 'claim_companion_message') {
      tables.companion_messages_ledger.push({ id: nextId, user_id: a.p_user_id, local_date: a.p_local_date, mode: a.p_mode, moment_key: a.p_moment_key, status: 'pending' });
      return { data: { ok: true, claimed: true, id: nextId++ }, error: null };
    }
    if (fn === 'finish_companion_message') return { data: { ok: true }, error: null };
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
  return { from: base.from, rpc } as any;
}

function enrichmentDep(dismissedAt: string | null): jest.Mock<Promise<EnrichmentCompletions>> {
  return jest.fn(async (_sb: unknown, ids: string[]) => ({
    completions: new Map(ids.map((id) => [id, new Map(ENRICHMENT_CARD_TYPES.map((t) => [t, false]))])),
    dismissals: new Map(ids.map((id) => [id, dismissedAt
      ? [{ card_type: 'E8', dismissed_at: dismissedAt, cooldown_days: 7 }]
      : []])),
    unavailable: ['enrichment_social'],
  })) as any;
}

async function eligibleSeenByCompose(now: Date, dismissedAt: string | null) {
  let seen: MemberContext | null = null;
  const enrichment = enrichmentDep(dismissedAt);
  const r = await runCompanionTick({
    sb: tickSb(tickTables()),
    now,
    config: shadowConfig,
    emit: jest.fn(async () => ({ ok: true })) as any,
    pacer: jest.fn(async () => ({ allow: true, reason: 'ok' as const })) as any,
    fetchIndex: jest.fn(async () => null),
    compose: jest.fn(async (c: MemberContext) => { seen = c; return { ok: true as const, text: 'Hallo Mila!', model: 'm' }; }) as any,
    locales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((i) => [i, 'de']))),
    signals: jest.fn(async (_sb: unknown, ids: string[]) => ({ by: new Map(ids.map((i) => [i, {}])), unavailable: [] })) as any,
    enrichment,
  });
  expect(enrichment).toHaveBeenCalledTimes(1);
  return { r, eligible: seen ? [...((seen as MemberContext).eligibleEnrichmentCardTypes ?? [])].sort() : null };
}

describe('VTID-05367: the tick puts the eligible enrichment set on MemberContext', () => {
  it('R2-F3: with the Meta OAuth clients unset, E6/E7 are never eligible', async () => {
    const { eligible } = await eligibleSeenByCompose(NOW, null);
    expect(eligible).not.toBeNull();
    expect(eligible).not.toContain('E6');
    expect(eligible).not.toContain('E7');
    expect(eligible).toContain('E1');
    expect(eligible).toContain('E8');
  });

  it('R2-F3: with the Meta OAuth clients configured, E6/E7 become eligible', async () => {
    for (const k of META_ENV) process.env[k] = 'x';
    const { eligible } = await eligibleSeenByCompose(NOW, null);
    expect(eligible).toContain('E6');
    expect(eligible).toContain('E7');
  });

  it('R3-F1: E8 dismissed 3 days ago is hidden (cooldown uses the tick\'s real now)', async () => {
    const dismissed = new Date(NOW.getTime() - 3 * DAY_MS).toISOString();
    const { eligible } = await eligibleSeenByCompose(NOW, dismissed);
    expect(eligible).not.toContain('E8');
    expect(eligible).toContain('E1');
  });

  it('R3-F1: E8 dismissed 8 days ago is offered again', async () => {
    const dismissed = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
    const { eligible } = await eligibleSeenByCompose(NOW, dismissed);
    expect(eligible).toContain('E8');
  });

  it('R2-F2: when a source fails, the tick still runs and the member gets NO eligible enrichment card', async () => {
    let seen: MemberContext | null = null;
    const r = await runCompanionTick({
      sb: tickSb(tickTables()),
      now: NOW,
      config: shadowConfig,
      emit: jest.fn(async () => ({ ok: true })) as any,
      pacer: jest.fn(async () => ({ allow: true, reason: 'ok' as const })) as any,
      fetchIndex: jest.fn(async () => null),
      compose: jest.fn(async (c: MemberContext) => { seen = c; return { ok: true as const, text: 'Hallo Mila!', model: 'm' }; }) as any,
      locales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((i) => [i, 'de']))),
      signals: jest.fn(async (_sb: unknown, ids: string[]) => ({ by: new Map(ids.map((i) => [i, {}])), unavailable: [] })) as any,
      // The REAL seam, over a database whose profiles read fails.
      enrichment: (_sb: unknown, ids: string[]) => fetchEnrichmentCompletions(fakeSb(enrichmentTables(), new Set(['profiles'])), ids),
    });
    expect(r).toMatchObject({ ok: true, decided: 1, enrichment_unavailable: ['enrichment_profiles'] });
    expect(seen).not.toBeNull();
    expect([...((seen as unknown as MemberContext).eligibleEnrichmentCardTypes ?? [])]).toEqual([]);
  });

  it('reports the enrichment seam\'s unavailable sources in their own enrichment_unavailable field', async () => {
    const { r } = await eligibleSeenByCompose(NOW, null);
    expect(r.enrichment_unavailable).toEqual(['enrichment_social']);
    // Kept apart from the Phase 3 signal list (VTID-05101 pins that field exactly).
    expect(r.signals_unavailable).toBeUndefined();
  });
});
