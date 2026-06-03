/**
 * VTID-03093 (Teacher PR 3) — Feature Discovery Coach provider tests.
 */

import {
  makeFeatureDiscoveryTeacherProvider,
  pickCapability,
  renderTeacherLine,
  TEACHER_EXTRA_KEY,
  TEACHER_PROVIDER_KEY,
  // R4 (BOOTSTRAP-ORB-R4-GRADUATED-TEACHER) graduated-track exports.
  pickRefreshCapability,
  gracefulPauseAllowed,
  startOfNextLocalDayIso,
  nextRefreshOkIso,
  renderRefreshInvitation,
  renderGracefulPauseLine,
  GRACEFUL_PAUSE_KEY,
  TEACHER_REFRESH_INTERVAL_DAYS,
  type CapabilityCatalogRow,
  type AwarenessLedgerRow,
  type RefreshScheduleRow,
} from '../../../../../src/services/assistant-continuation/providers/teacher/feature-discovery-teacher';
import type { ContinuationDecisionContext } from '../../../../../src/services/assistant-continuation/types';

// VTID-03218 (R3): the provider now resolves Teacher Mode content atomically
// inside produce() (dynamic import). Mock the resolver so produce() tests
// control whether content resolves, fails, or throws. jest.mock intercepts
// the provider's dynamic import() of this module.
jest.mock('../../../../../src/orb/teacher/teacher-content-resolver', () => ({
  resolveTeacherModeContent: jest.fn(),
}));
import { resolveTeacherModeContent } from '../../../../../src/orb/teacher/teacher-content-resolver';
import type { TeacherModeContent } from '../../../../../src/orb/teacher/teacher-content-resolver';
const mockResolveTeacherMode = resolveTeacherModeContent as jest.Mock;

function makeTeacherMode(over: Partial<TeacherModeContent> = {}): TeacherModeContent {
  return {
    active_capability_key: 'life_compass',
    active_display_name: 'Life Compass',
    active_description: 'desc',
    active_manual_path: '/manuals/maxina/00-concepts/life-compass',
    active_manual_content: 'manual chapter text',
    active_teacher_intro_script: null,
    remaining_capabilities: [],
    ...over,
  };
}

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
  // VTID-03218: default the resolver to a successful content payload so the
  // pre-existing "returned" assertions hold. Individual tests override it.
  beforeEach(() => {
    mockResolveTeacherMode.mockReset();
    mockResolveTeacherMode.mockResolvedValue(makeTeacherMode());
  });

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

  // VTID-03218 (R3): atomic selection + content. The candidate carries its
  // Teacher Mode content; content failure means the Teacher does NOT fire.
  test('returned candidate carries bundled teacherMode content', async () => {
    mockResolveTeacherMode.mockResolvedValue(
      makeTeacherMode({ active_capability_key: 'life_compass' }),
    );
    const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSb({ catalog: [cat()] }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'de',
          greetingPolicy: 'fresh_intro',
        },
      }),
    );
    expect(r.status).toBe('returned');
    if (r.status !== 'returned') return;
    const tm = (r.candidate as { teacherMode?: TeacherModeContent }).teacherMode;
    expect(tm).toBeDefined();
    expect(tm?.active_capability_key).toBe('life_compass');
    expect(mockResolveTeacherMode).toHaveBeenCalledTimes(1);
  });

  test('content resolution returns null → errored (Teacher does not fire)', async () => {
    mockResolveTeacherMode.mockResolvedValue(null);
    const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSb({ catalog: [cat()] }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'de',
          greetingPolicy: 'fresh_intro',
        },
      }),
    );
    expect(r.status).toBe('errored');
    if (r.status === 'errored') {
      expect(r.reason).toBe('teacher_content_resolution_failed');
    }
  });

  test('content resolution throws → errored (Teacher does not fire)', async () => {
    mockResolveTeacherMode.mockRejectedValue(new Error('knowledge_docs down'));
    const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSb({ catalog: [cat()] }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'de',
          greetingPolicy: 'fresh_intro',
        },
      }),
    );
    expect(r.status).toBe('errored');
    if (r.status === 'errored') {
      expect(r.reason).toMatch(/teacher_content_resolution_failed/);
    }
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

  // R4 (BOOTSTRAP-ORB-R4-GRADUATED-TEACHER): an all-mastered user no longer
  // SUPPRESSES — the linear pick returns null, the graduated track runs, and
  // (with no `tried` capability to refresh and no pause sentinel yet) it speaks
  // the graceful-pause line once. This test previously asserted suppression;
  // R4 deliberately changes that contract. See the "graduated track" suite for
  // the refresh/pause/silent matrix.
  test('all capabilities mastered → graceful-pause fires (R4 re-engage, no suppress)', async () => {
    const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSbGraduated({
            catalog: [cat({ capability_key: 'a' })],
            ledger: [lr({ capability_key: 'a', awareness_state: 'mastered' })],
            schedule: [],
          }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'de',
          greetingPolicy: 'fresh_intro',
          nowIso: NOW_ISO,
        },
      }),
    );
    expect(r.status).toBe('returned');
    if (r.status === 'returned') {
      expect(r.candidate.kind).toBe('check_in');
      expect(r.candidate.dedupeKey).toBe('teacher:graceful_pause');
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

// ===========================================================================
// R4 (BOOTSTRAP-ORB-R4-GRADUATED-TEACHER) — graduated-user Teacher track.
//
// When the linear curriculum is exhausted (Dragan1: every enabled capability
// tried/completed/introduced within cooldown → pickCapability returns null),
// the Teacher must RE-ENGAGE instead of suppressing:
//   1. deepening refresh of a `tried` capability when refresh-due, ELSE
//   2. graceful-pause line once per local day, ELSE
//   3. silent on subsequent same-day opens.
// ===========================================================================

const REFRESH_INTERVAL_MS = TEACHER_REFRESH_INTERVAL_DAYS * DAY_MS;

function sched(over: Partial<RefreshScheduleRow> = {}): RefreshScheduleRow {
  return {
    capability_key: 'life_compass',
    next_refresh_ok_at: NOW_ISO,
    refresh_count: 0,
    ...over,
  };
}

describe('R4 — pickRefreshCapability (pure)', () => {
  test('a `tried` capability with NO schedule row is refresh-eligible', () => {
    const catalog = [cat({ capability_key: 'life_compass' })];
    const ledger = [lr({ capability_key: 'life_compass', awareness_state: 'tried' })];
    const picked = pickRefreshCapability(catalog, ledger, [], NOW_ISO);
    expect(picked?.row.capability_key).toBe('life_compass');
    expect(picked?.refreshCount).toBe(0);
  });

  test('completed / mastered / introduced are NOT refresh candidates', () => {
    const catalog = [
      cat({ capability_key: 'a' }),
      cat({ capability_key: 'b' }),
      cat({ capability_key: 'c' }),
    ];
    const ledger = [
      lr({ capability_key: 'a', awareness_state: 'completed' }),
      lr({ capability_key: 'b', awareness_state: 'mastered' }),
      lr({ capability_key: 'c', awareness_state: 'introduced' }),
    ];
    expect(pickRefreshCapability(catalog, ledger, [], NOW_ISO)).toBeNull();
  });

  test('refresh NOT due yet (next_refresh_ok_at in the future) → filtered out', () => {
    const catalog = [cat({ capability_key: 'life_compass' })];
    const ledger = [lr({ capability_key: 'life_compass', awareness_state: 'tried' })];
    const schedule = [
      sched({
        capability_key: 'life_compass',
        next_refresh_ok_at: new Date(NOW_MS + 10 * DAY_MS).toISOString(),
      }),
    ];
    expect(pickRefreshCapability(catalog, ledger, schedule, NOW_ISO)).toBeNull();
  });

  test('refresh due (next_refresh_ok_at in the past) → eligible, carries refresh_count', () => {
    const catalog = [cat({ capability_key: 'life_compass' })];
    const ledger = [lr({ capability_key: 'life_compass', awareness_state: 'tried' })];
    const schedule = [
      sched({
        capability_key: 'life_compass',
        next_refresh_ok_at: new Date(NOW_MS - 1 * DAY_MS).toISOString(),
        refresh_count: 2,
      }),
    ];
    const picked = pickRefreshCapability(catalog, ledger, schedule, NOW_ISO);
    expect(picked?.row.capability_key).toBe('life_compass');
    expect(picked?.refreshCount).toBe(2);
  });

  test('never-refreshed sorts before a due-refreshed one', () => {
    const catalog = [
      cat({ capability_key: 'never', pedagogical_order: 99 }),
      cat({ capability_key: 'dueonce', pedagogical_order: 1 }),
    ];
    const ledger = [
      lr({ capability_key: 'never', awareness_state: 'tried' }),
      lr({ capability_key: 'dueonce', awareness_state: 'tried' }),
    ];
    const schedule = [
      sched({
        capability_key: 'dueonce',
        next_refresh_ok_at: new Date(NOW_MS - 1 * DAY_MS).toISOString(),
      }),
    ];
    // 'never' has nextOkMs=-Infinity → sorts first despite higher ped order.
    const picked = pickRefreshCapability(catalog, ledger, schedule, NOW_ISO);
    expect(picked?.row.capability_key).toBe('never');
  });
});

describe('R4 — pause + schedule pure helpers', () => {
  test('gracefulPauseAllowed: no sentinel → allowed', () => {
    expect(gracefulPauseAllowed([], NOW_ISO)).toBe(true);
  });

  test('gracefulPauseAllowed: sentinel in the future → NOT allowed (already spoke today)', () => {
    const schedule = [
      sched({
        capability_key: GRACEFUL_PAUSE_KEY,
        next_refresh_ok_at: new Date(NOW_MS + 6 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    expect(gracefulPauseAllowed(schedule, NOW_ISO)).toBe(false);
  });

  test('gracefulPauseAllowed: sentinel due (past) → allowed again', () => {
    const schedule = [
      sched({
        capability_key: GRACEFUL_PAUSE_KEY,
        next_refresh_ok_at: new Date(NOW_MS - 60 * 1000).toISOString(),
      }),
    ];
    expect(gracefulPauseAllowed(schedule, NOW_ISO)).toBe(true);
  });

  test('startOfNextLocalDayIso (UTC) is the next midnight after now', () => {
    // NOW_ISO = 2026-05-19T08:00:00Z → next UTC midnight = 2026-05-20T00:00:00Z
    expect(startOfNextLocalDayIso(NOW_ISO, 0)).toBe('2026-05-20T00:00:00.000Z');
  });

  test('startOfNextLocalDayIso honors a +120min (CEST) offset', () => {
    // Local time is 10:00 CEST on the 19th → next local midnight = 2026-05-20
    // 00:00 local = 2026-05-19T22:00:00Z.
    expect(startOfNextLocalDayIso(NOW_ISO, 120)).toBe('2026-05-19T22:00:00.000Z');
  });

  test('nextRefreshOkIso defaults to now + 90 days', () => {
    expect(nextRefreshOkIso(NOW_ISO)).toBe(
      new Date(NOW_MS + REFRESH_INTERVAL_MS).toISOString(),
    );
  });

  test('renderRefreshInvitation names the capability (first refresh)', () => {
    const en = renderRefreshInvitation({ lang: 'en', displayName: 'Life Compass', refreshCount: 0 });
    expect(en).toContain('Life Compass');
    expect(en.toLowerCase()).toContain('revisit');
    const de = renderRefreshInvitation({ lang: 'de', displayName: 'Life Compass', refreshCount: 0 });
    expect(de).toContain('Life Compass');
  });

  test('renderRefreshInvitation escalates framing on a repeat refresh', () => {
    const first = renderRefreshInvitation({ lang: 'en', displayName: 'X', refreshCount: 0 });
    const second = renderRefreshInvitation({ lang: 'en', displayName: 'X', refreshCount: 1 });
    expect(second).not.toBe(first);
    expect(second.toLowerCase()).toContain('deeper');
  });

  test('renderGracefulPauseLine is the operator-fixed copy', () => {
    expect(renderGracefulPauseLine('en')).toBe(
      "You've explored most of what Vitana offers. I'll surface new things as they ship. Want me to summarize what you've learned this month?",
    );
    expect(renderGracefulPauseLine('de')).toContain('Vitana');
  });
});

// ---------------------------------------------------------------------------
// Graduated-track mock: supports the schedule SELECT + captures rpc() calls.
// ---------------------------------------------------------------------------

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function fakeSbGraduated(opts: {
  catalog: CapabilityCatalogRow[];
  ledger: AwarenessLedgerRow[];
  schedule?: RefreshScheduleRow[];
  scheduleError?: { message: string } | null;
  rpcCalls?: RpcCall[];
}): import('@supabase/supabase-js').SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          if (table === 'system_capabilities') {
            return Promise.resolve({ data: opts.catalog, error: null });
          }
          // user_capability_awareness + teacher_capability_refresh_schedule
          // both use .eq().eq().
          return {
            eq: () => {
              if (table === 'teacher_capability_refresh_schedule') {
                return Promise.resolve({
                  data: opts.schedule ?? [],
                  error: opts.scheduleError ?? null,
                });
              }
              return Promise.resolve({ data: opts.ledger, error: null });
            },
          };
        },
      }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      opts.rpcCalls?.push({ fn, args });
      return { data: null, error: null };
    },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('R4 — provider produce() graduated track', () => {
  beforeEach(() => {
    mockResolveTeacherMode.mockReset();
    mockResolveTeacherMode.mockResolvedValue(makeTeacherMode());
  });

  // Dragan1 case: linear curriculum exhausted (the one capability is `tried`),
  // refresh is due (no schedule row) → deepening refresh FIRES.
  test('exhausted curriculum + refresh due → deepening refresh fires (bundled content)', async () => {
    mockResolveTeacherMode.mockResolvedValue(
      makeTeacherMode({ active_capability_key: 'life_compass' }),
    );
    const rpcCalls: RpcCall[] = [];
    const provider = makeFeatureDiscoveryTeacherProvider({ newId: () => 'rid', rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSbGraduated({
            catalog: [cat({ capability_key: 'life_compass', display_name: 'Life Compass' })],
            ledger: [lr({ capability_key: 'life_compass', awareness_state: 'tried' })],
            schedule: [],
            rpcCalls,
          }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'en',
          firstName: 'Dragan',
          greetingPolicy: 'warm_return',
          nowIso: NOW_ISO,
        },
      }),
    );
    expect(r.status).toBe('returned');
    if (r.status !== 'returned') return;
    expect(r.candidate.id).toBe('teacher-refresh-rid');
    expect(r.candidate.kind).toBe('feature_discovery');
    expect(r.candidate.dedupeKey).toBe('teacher:refresh:life_compass');
    // next-level framing names the capability.
    expect(r.candidate.userFacingLine).toContain('Life Compass');
    // bundled teacherMode (R3 atomicity preserved for the refresh path).
    const tm = (r.candidate as { teacherMode?: TeacherModeContent }).teacherMode;
    expect(tm?.active_capability_key).toBe('life_compass');
    // schedule advanced by 90 days via the RPC.
    const refreshRpc = rpcCalls.find((c) => c.args.p_capability_key === 'life_compass');
    expect(refreshRpc?.fn).toBe('record_teacher_refresh');
    expect(refreshRpc?.args.p_is_refresh).toBe(true);
    expect(refreshRpc?.args.p_next_ok_at).toBe(nextRefreshOkIso(NOW_ISO));
  });

  // Nothing refresh-eligible (the tried capability was refreshed recently) →
  // graceful-pause line, ONCE, and stamps the same-day silence sentinel.
  test('nothing refresh-eligible → graceful-pause line fires once + stamps sentinel', async () => {
    const rpcCalls: RpcCall[] = [];
    const provider = makeFeatureDiscoveryTeacherProvider({ newId: () => 'pid', rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSbGraduated({
            catalog: [cat({ capability_key: 'life_compass' })],
            ledger: [lr({ capability_key: 'life_compass', awareness_state: 'tried' })],
            // refresh NOT due → no refresh candidate.
            schedule: [
              sched({
                capability_key: 'life_compass',
                next_refresh_ok_at: new Date(NOW_MS + 30 * DAY_MS).toISOString(),
              }),
            ],
            rpcCalls,
          }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'en',
          greetingPolicy: 'warm_return',
          nowIso: NOW_ISO,
          tzOffsetMinutes: 0,
        },
      }),
    );
    expect(r.status).toBe('returned');
    if (r.status !== 'returned') return;
    expect(r.candidate.id).toBe('teacher-pause-pid');
    expect(r.candidate.kind).toBe('check_in');
    expect(r.candidate.dedupeKey).toBe('teacher:graceful_pause');
    expect(r.candidate.userFacingLine).toBe(renderGracefulPauseLine('en'));
    // resolver NOT called on the pause path (no capability to teach).
    expect(mockResolveTeacherMode).not.toHaveBeenCalled();
    // sentinel stamped for next local day, NOT a refresh.
    const pauseRpc = rpcCalls.find((c) => c.args.p_capability_key === GRACEFUL_PAUSE_KEY);
    expect(pauseRpc?.fn).toBe('record_teacher_refresh');
    expect(pauseRpc?.args.p_is_refresh).toBe(false);
    expect(pauseRpc?.args.p_next_ok_at).toBe(startOfNextLocalDayIso(NOW_ISO, 0));
  });

  // Same-day reopen after the pause already fired → silent (no second pause).
  test('graceful-pause already spoken today → suppressed (silent)', async () => {
    const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSbGraduated({
            catalog: [cat({ capability_key: 'life_compass' })],
            ledger: [lr({ capability_key: 'life_compass', awareness_state: 'completed' })],
            schedule: [
              // pause sentinel already set for later today.
              sched({
                capability_key: GRACEFUL_PAUSE_KEY,
                next_refresh_ok_at: new Date(NOW_MS + 8 * 60 * 60 * 1000).toISOString(),
              }),
            ],
          }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'en',
          greetingPolicy: 'warm_return',
          nowIso: NOW_ISO,
        },
      }),
    );
    expect(r.status).toBe('suppressed');
    if (r.status === 'suppressed') {
      expect(r.reason).toBe('graceful_pause_already_spoken_today');
    }
  });

  // Refresh content resolution failure must NOT fire an empty Teacher — R3
  // atomicity contract carries into the graduated track.
  test('refresh content resolution null → errored (Teacher does not fire empty)', async () => {
    mockResolveTeacherMode.mockResolvedValue(null);
    const provider = makeFeatureDiscoveryTeacherProvider({ rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSbGraduated({
            catalog: [cat({ capability_key: 'life_compass' })],
            ledger: [lr({ capability_key: 'life_compass', awareness_state: 'tried' })],
            schedule: [],
          }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'en',
          greetingPolicy: 'warm_return',
          nowIso: NOW_ISO,
        },
      }),
    );
    expect(r.status).toBe('errored');
    if (r.status === 'errored') {
      expect(r.reason).toMatch(/teacher_refresh_content_resolution_failed/);
    }
  });

  // NON-exhausted case: an unknown capability is still eligible → the NORMAL
  // Teacher path runs, NOT the graduated track. No regression.
  test('non-exhausted curriculum → normal Teacher path (no graduated track)', async () => {
    const rpcCalls: RpcCall[] = [];
    const provider = makeFeatureDiscoveryTeacherProvider({ newId: () => 'nid', rng: () => 0 });
    const r = await provider.produce(
      ctxWith({
        [TEACHER_EXTRA_KEY]: {
          supabase: fakeSbGraduated({
            catalog: [
              cat({ capability_key: 'life_compass' }),
              // 'vitana_index' is unknown (never introduced) → normal pick.
              cat({ capability_key: 'vitana_index', display_name: 'Vitana Index' }),
            ],
            ledger: [lr({ capability_key: 'life_compass', awareness_state: 'tried' })],
            schedule: [],
            rpcCalls,
          }),
          tenantId: 't1',
          userId: 'u1',
          lang: 'en',
          firstName: 'Dragan',
          greetingPolicy: 'fresh_intro',
          nowIso: NOW_ISO,
        },
      }),
    );
    expect(r.status).toBe('returned');
    if (r.status !== 'returned') return;
    // Normal path id prefix (not -refresh- / -pause-), normal dedupe key.
    expect(r.candidate.id).toBe('teacher-nid');
    expect(r.candidate.dedupeKey).toBe('teacher:vitana_index');
    // No refresh/pause RPC was issued on the normal path.
    expect(rpcCalls.length).toBe(0);
  });
});
