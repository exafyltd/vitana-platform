/**
 * VTID-03093 (Teacher PR 3) — Feature Discovery Coach provider tests.
 */

import {
  makeFeatureDiscoveryTeacherProvider,
  pickCapability,
  renderTeacherLine,
  TEACHER_EXTRA_KEY,
  TEACHER_PROVIDER_KEY,
  type CapabilityCatalogRow,
  type AwarenessLedgerRow,
} from '../../../../../src/services/assistant-continuation/providers/teacher/feature-discovery-teacher';
import type { ContinuationDecisionContext } from '../../../../../src/services/assistant-continuation/types';

const NOW_ISO = '2026-05-19T08:00:00Z';
const NOW_MS = Date.parse(NOW_ISO);
const DAY_MS = 24 * 60 * 60 * 1000;

function cat(over: Partial<CapabilityCatalogRow> = {}): CapabilityCatalogRow {
  return {
    capability_key: 'life_compass',
    display_name: 'Life Compass',
    description: 'desc',
    manual_path: '/manuals/maxina/00-concepts/life-compass',
    enabled: true,
    ...over,
  };
}

function lr(over: Partial<AwarenessLedgerRow> = {}): AwarenessLedgerRow {
  return {
    capability_key: 'life_compass',
    awareness_state: 'unknown',
    dismiss_count: 0,
    last_introduced_at: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// pickCapability — pure ranker
// ---------------------------------------------------------------------------

describe('VTID-03093 — pickCapability', () => {
  test('empty catalog → null', () => {
    expect(pickCapability([], [], NOW_ISO)).toBeNull();
  });

  test('all-disabled catalog → null', () => {
    expect(pickCapability([cat({ enabled: false })], [], NOW_ISO)).toBeNull();
  });

  test('never-introduced wins over recently-introduced', () => {
    const catalog: CapabilityCatalogRow[] = [
      cat({ capability_key: 'a' }),
      cat({ capability_key: 'b' }),
    ];
    const ledger: AwarenessLedgerRow[] = [
      lr({
        capability_key: 'a',
        awareness_state: 'introduced',
        last_introduced_at: new Date(NOW_MS - 60 * DAY_MS).toISOString(),
      }),
    ];
    const picked = pickCapability(catalog, ledger, NOW_ISO);
    expect(picked?.row.capability_key).toBe('b'); // never-introduced wins
  });

  test('recently-introduced (within 7 days) is filtered out', () => {
    const catalog: CapabilityCatalogRow[] = [cat({ capability_key: 'a' })];
    const ledger: AwarenessLedgerRow[] = [
      lr({
        capability_key: 'a',
        awareness_state: 'introduced',
        last_introduced_at: new Date(NOW_MS - 3 * DAY_MS).toISOString(), // 3 days ago
      }),
    ];
    expect(pickCapability(catalog, ledger, NOW_ISO)).toBeNull();
  });

  test('terminal states (tried/completed/mastered) are filtered out', () => {
    const catalog: CapabilityCatalogRow[] = [
      cat({ capability_key: 'a' }),
      cat({ capability_key: 'b' }),
      cat({ capability_key: 'c' }),
    ];
    const ledger: AwarenessLedgerRow[] = [
      lr({ capability_key: 'a', awareness_state: 'tried' }),
      lr({ capability_key: 'b', awareness_state: 'completed' }),
      lr({ capability_key: 'c', awareness_state: 'mastered' }),
    ];
    expect(pickCapability(catalog, ledger, NOW_ISO)).toBeNull();
  });

  test('dismissed once + last introduced > 30 days ago → gentle re-offer eligible', () => {
    const catalog: CapabilityCatalogRow[] = [cat({ capability_key: 'a' })];
    const ledger: AwarenessLedgerRow[] = [
      lr({
        capability_key: 'a',
        awareness_state: 'dismissed',
        dismiss_count: 1,
        last_introduced_at: new Date(NOW_MS - 45 * DAY_MS).toISOString(),
      }),
    ];
    expect(pickCapability(catalog, ledger, NOW_ISO)?.row.capability_key).toBe('a');
  });

  test('dismissed twice (or more) → permanently filtered', () => {
    const catalog: CapabilityCatalogRow[] = [cat({ capability_key: 'a' })];
    const ledger: AwarenessLedgerRow[] = [
      lr({
        capability_key: 'a',
        awareness_state: 'dismissed',
        dismiss_count: 2,
        last_introduced_at: new Date(NOW_MS - 90 * DAY_MS).toISOString(),
      }),
    ];
    expect(pickCapability(catalog, ledger, NOW_ISO)).toBeNull();
  });

  test('alphabetical tie-break on equal-priority entries (no pedagogical order set)', () => {
    const catalog: CapabilityCatalogRow[] = [
      cat({ capability_key: 'zebra' }),
      cat({ capability_key: 'apple' }),
      cat({ capability_key: 'mango' }),
    ];
    const picked = pickCapability(catalog, [], NOW_ISO);
    expect(picked?.row.capability_key).toBe('apple');
  });

  // VTID-03108 (Item 3): pedagogical_order drives the Teacher curriculum.
  // Foundation capabilities (low pedagogical_order) should win over
  // advanced ones (high pedagogical_order) regardless of alphabetical
  // position. The order itself lives in the system_capabilities table
  // (data-driven, editable without a deploy) — these tests just lock
  // that the column is honored.
  test('pedagogical_order (low) wins over alphabetical tie-break', () => {
    const catalog: CapabilityCatalogRow[] = [
      // 'activity_match' is alphabetically first but pedagogically LATE.
      cat({ capability_key: 'activity_match', pedagogical_order: 140 }),
      // 'five_pillars' starts with 'f' but is the curriculum FIRST step.
      cat({ capability_key: 'five_pillars', pedagogical_order: 10 }),
      cat({ capability_key: 'vitana_id', pedagogical_order: 30 }),
    ];
    const picked = pickCapability(catalog, [], NOW_ISO);
    expect(picked?.row.capability_key).toBe('five_pillars');
  });

  test('pedagogical_order=null sorts LAST (treated as +Infinity)', () => {
    const catalog: CapabilityCatalogRow[] = [
      cat({ capability_key: 'activity_match', pedagogical_order: null }),
      cat({ capability_key: 'five_pillars', pedagogical_order: 10 }),
    ];
    const picked = pickCapability(catalog, [], NOW_ISO);
    expect(picked?.row.capability_key).toBe('five_pillars');
  });

  test('pedagogical_order ties still fall through to alphabetical', () => {
    const catalog: CapabilityCatalogRow[] = [
      cat({ capability_key: 'beta', pedagogical_order: 50 }),
      cat({ capability_key: 'alpha', pedagogical_order: 50 }),
    ];
    const picked = pickCapability(catalog, [], NOW_ISO);
    expect(picked?.row.capability_key).toBe('alpha');
  });
});

// ---------------------------------------------------------------------------
// renderTeacherLine
// ---------------------------------------------------------------------------

describe('VTID-03093 — renderTeacherLine', () => {
  test('concatenates greeting + invitation with single space', () => {
    expect(
      renderTeacherLine({
        greeting: 'Willkommen zurück, Dragan.',
        invitation: 'Darf ich dir kurz etwas zeigen?',
      }),
    ).toBe('Willkommen zurück, Dragan. Darf ich dir kurz etwas zeigen?');
  });

  test('trims excess whitespace', () => {
    expect(
      renderTeacherLine({
        greeting: '  Hi.  ',
        invitation: '  May I?  ',
      }),
    ).toBe('Hi. May I?');
  });

  // VTID-03123: when cadence-class skip suppressed the greeting, the
  // renderer returns just the invitation — no leading space, no stale
  // "Welcome back". The user's 5-second-re-tap complaint.
  test('VTID-03123: empty greeting drops the leading space', () => {
    expect(
      renderTeacherLine({
        greeting: '',
        invitation: 'Magst du, dass ich dir Life Compass vorstelle?',
      }),
    ).toBe('Magst du, dass ich dir Life Compass vorstelle?');
  });

  test('VTID-03123: whitespace-only greeting also drops cleanly', () => {
    expect(
      renderTeacherLine({
        greeting: '   ',
        invitation: 'Want me to show you?',
      }),
    ).toBe('Want me to show you?');
  });
});

// ---------------------------------------------------------------------------
// Provider — produce()
// ---------------------------------------------------------------------------

function fakeSb(opts: {
  catalog?: CapabilityCatalogRow[];
  ledger?: AwarenessLedgerRow[];
  catalogError?: { message: string } | null;
  ledgerError?: { message: string } | null;
  catalogThrows?: boolean;
}): import('@supabase/supabase-js').SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          if (table === 'system_capabilities') {
            if (opts.catalogThrows) throw new Error('boom');
            return Promise.resolve({
              data: opts.catalog ?? [],
              error: opts.catalogError ?? null,
            });
          }
          // user_capability_awareness chain: .eq().eq()
          return {
            eq: () =>
              Promise.resolve({
                data: opts.ledger ?? [],
                error: opts.ledgerError ?? null,
              }),
          };
        },
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function ctxWith(extra: Record<string, unknown>): ContinuationDecisionContext {
  return {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    extra,
  };
}

describe('VTID-03093 — provider produce()', () => {
  test('missing inputs → skipped', async () => {
    const provider = makeFeatureDiscoveryTeacherProvider();
    const r = await provider.produce(ctxWith({}));
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('no_teacher_inputs');
  });

  // VTID-03108 (Item 2): cadence-class skip no longer suppresses the
  // Teacher. The Teacher is the predominant first-utterance authority
  // for the community education phase; its own per-capability 4h
  // dedupe is the cadence brake. Only isReconnect-class forced skips
  // still suppress (transparent reconnect = "previous turn is alive,
  // do not produce a new opener"). See the next two tests.
  test('greetingPolicy=skip with cadence reason → still returns (fires anyway)', async () => {
    const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSb({ catalog: [cat()] }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'de',
          greetingPolicy: 'skip',
          skipReason: 'greeted_recently_within_window',
        },
      }),
    );
    expect(r.status).toBe('returned');
  });

  test('greetingPolicy=skip with isReconnect-class reason → suppressed', async () => {
    for (const reason of [
      'isReconnect_forces_skip',
      'transparent_reconnect_forces_skip',
      'bucket_reconnect_forces_skip',
    ]) {
      const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
      const r = await provider.produce(
        ctxWith({
          [TEACHER_EXTRA_KEY]: {
            supabase: fakeSb({ catalog: [cat()] }),
            tenantId: 't1',
            userId: 'u1',
            lang: 'de',
            greetingPolicy: 'skip',
            skipReason: reason,
          },
        }),
      );
      expect(r.status).toBe('suppressed');
      if (r.status === 'suppressed') expect(r.reason).toBe(`forced_skip_${reason}`);
    }
  });

  test('empty catalog → suppressed:empty_catalog', async () => {
    const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSb({ catalog: [] }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'de',
          greetingPolicy: 'fresh_intro',
        },
      }),
    );
    expect(r.status).toBe('suppressed');
    if (r.status === 'suppressed') expect(r.reason).toBe('empty_catalog');
  });

  test('catalog error → errored', async () => {
    const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSb({ catalogError: { message: 'rls denied' } }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'de',
          greetingPolicy: 'fresh_intro',
        },
      }),
    );
    expect(r.status).toBe('errored');
    if (r.status === 'errored') expect(r.reason).toMatch(/catalog_fetch_failed/);
  });

  test('returns a candidate when catalog has rows + ledger empty', async () => {
    const provider = makeFeatureDiscoveryTeacherProvider({
      newId: () => 'fixed-id',
      now: () => 1_700_000_000_000,
      rng: () => 0,
    });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSb({
            catalog: [
              cat({ capability_key: 'life_compass', display_name: 'Life Compass' }),
              cat({ capability_key: 'vitana_index', display_name: 'Vitana Index' }),
            ],
            ledger: [],
          }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'de',
          firstName: 'Dragan',
          greetingPolicy: 'fresh_intro',
          nowIso: NOW_ISO,
        },
      }),
    );
    expect(r.status).toBe('returned');
    if (r.status !== 'returned') return;
    expect(r.candidate.id).toBe('teacher-fixed-id');
    expect(r.candidate.kind).toBe('feature_discovery');
    expect(r.candidate.priority).toBe(85);
    expect(r.candidate.userFacingLine).toContain('Dragan');
    expect(r.candidate.userFacingLine).toMatch(/\?/);
    // CTA carries capability_key + manual_path
    expect((r.candidate.cta as { type: string }).type).toBe('offer_demo');
    const payload = (r.candidate.cta as { payload: { capability_key: string } }).payload;
    // alphabetical tie-break: life_compass < vitana_index → life_compass wins
    expect(payload.capability_key).toBe('life_compass');
    expect(r.candidate.dedupeKey).toBe('teacher:life_compass');
  });

  test('all capabilities mastered → suppressed:all_known_or_dismissed', async () => {
    const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSb({
            catalog: [cat({ capability_key: 'a' })],
            ledger: [lr({ capability_key: 'a', awareness_state: 'mastered' })],
          }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'de',
          greetingPolicy: 'fresh_intro',
          nowIso: NOW_ISO,
        },
      }),
    );
    expect(r.status).toBe('suppressed');
    if (r.status === 'suppressed') {
      expect(r.reason).toBe('all_capabilities_known_or_dismissed');
    }
  });

  test('provider key + extra key are stable', () => {
    expect(TEACHER_PROVIDER_KEY).toBe('feature_discovery_teacher');
    expect(TEACHER_EXTRA_KEY).toBe('teacher');
  });

  test('NO "Wie kann ich dir helfen" in produced line', async () => {
    const provider = makeFeatureDiscoveryTeacherProvider({
      newId: () => 'fixed',
      now: () => 1_700_000_000_000,
      // Sweep enough rng values to hit every invitation phrase.
    });
    for (let i = 0; i < 30; i++) {
      const rng = ((): (() => number) => {
        let v = i / 30;
        return () => {
          const out = v;
          v = (v + 1e-9) % 1;
          return out;
        };
      })();
      const provider2 = makeFeatureDiscoveryTeacherProvider({
        newId: () => 'fixed',
        now: () => 1_700_000_000_000,
        rng,
      });
      const r = await provider2.produce(
        ctxWith({
          [TEACHER_EXTRA_KEY]: {
            supabase: fakeSb({ catalog: [cat()], ledger: [] }),
            tenantId: 't1',
            userId: 'u1',
            lang: 'de',
            firstName: 'Dragan',
            greetingPolicy: 'fresh_intro',
            nowIso: NOW_ISO,
          },
        }),
      );
      if (r.status === 'returned') {
        expect(r.candidate.userFacingLine.toLowerCase()).not.toContain('wie kann ich dir helfen');
        expect(r.candidate.userFacingLine.toLowerCase()).not.toContain('how can i help');
      }
    }
  });
});
