/**
 * VTID-04544 — ORB greeting latency, stream B.
 *
 * The greeting's bounded reads (new-day overview gather, resume gather,
 * spoken-facts ledger) now run concurrently, and are skipped entirely when a
 * rung that never reads them is certain to win. The contract: WHEN the reads
 * happen may change; WHAT the greeting decision produces may not.
 *
 *   (a) concurrency — the wait is max(gather, ledger), not the sum;
 *   (b) golden equality — for a fixture matrix (new-day, conv_resume, guided
 *       topic, support report, first-time welcome, the anonymous / other-
 *       language sync path) × read outcomes (fast, empty payload, timeout,
 *       error; ledger fast / slow / failing), the decision built from the new
 *       reads deep-equals the decision built by a verbatim copy of the serial
 *       code this replaced — directive, rung, diag and effects — and the
 *       `read_failed` telemetry count is identical;
 *   (c) the skip path never calls the gather or the ledger read.
 *
 * Fake timers throughout: the ladders' budgets are real `setTimeout`s.
 */

import * as repo from '../../../src/services/conversation/greeting-facts-ledger-repository';
import * as oasis from '../../../src/services/oasis-event-service';
import {
  newdayHasContent,
  overviewIndependentOpenerWins,
  shouldAttemptNewdayOverview,
  shouldAttemptResumeOverview,
  tryDayCloseRung,
  computeGreetingDecision,
  type GreetingDecisionContext,
} from '../../../src/services/conversation/compute-greeting-decision';
import { decideOpeningFlow } from '../../../src/services/conversation/decide-conversation-flow';
import {
  EMPTY_GREETING_LEDGER,
  readGreetingLedger,
  startSpeculativeGreetingLedgerRead,
  type GreetingLedger,
} from '../../../src/services/conversation/greeting-facts-ledger';
import {
  boundedRead,
  gatherNewdayGreetingPayload,
  gatherSafeFastGreetingPayloads,
} from '../../../src/services/conversation/greeting-payload-gather';
import type { OverviewPayload } from '../../../src/services/assistant-continuation/providers/new-day-overview-payload';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../../../src/services/conversation/greeting-facts-ledger-repository', () => ({
  fetchGreetingLedgerSignals: jest.fn(),
  fetchExistingGreetingFactsSignal: jest.fn(),
  upsertUserAssistantStateSignal: jest.fn(),
}));
jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(() => Promise.resolve()),
}));

const fetchSignals = repo.fetchGreetingLedgerSignals as unknown as jest.Mock;
const emitOasis = oasis.emitOasisEvent as unknown as jest.Mock;

// Budgets exactly as orb-live.ts reads them with no env set.
const NEWDAY_MS = 3000;
const RESUME_MS = 1800;
const LEDGER_MS = 800;

const TODAY = '2026-06-30';
const NOW_ISO = `${TODAY}T08:00:00.000Z`;

// --- fixtures -------------------------------------------------------------

function richPayload(over: Partial<OverviewPayload> = {}): OverviewPayload {
  return {
    journey: null,
    vitana_index: {
      state: 'ok',
      today: 200,
      tier: 'Early',
      tier_framing: null,
      trend_7d: 0,
      weakest_pillar: { name: 'nutrition', score: 30 },
      strongest_pillar: null,
      balance_label: 'balanced',
      pillars: null,
      projected_day_90: null,
      projected_day_90_tier: null,
    },
    life_compass: {
      state: 'set',
      primary_goal: 'longer life',
      category: null,
      target_date: null,
      target_value: null,
      target_unit: null,
      starting_value: null,
      set_at: null,
      days_to_deadline: null,
      goal_progress_pct: null,
    },
    calendar_today: { count: 0, next: null },
    calendar_passed: { count: 0, most_recent: null },
    autopilot: { state: 'none_yet', today_checkpoint: null, this_week: [], pending_total: 0 },
    matches_unread: 4,
    messages_unread: 10,
    reminders_today: { count: 0, next: null },
    diary_last_7d: 3,
    facts_learned_since_last: null,
    guided_journey: null,
    last_session_date_user_tz: null,
    ...over,
  } as OverviewPayload;
}

/** A payload with nothing worth speaking: rung 1 won't fire, resume still reads it. */
function emptyPayload(): OverviewPayload {
  return richPayload({
    vitana_index: { ...richPayload().vitana_index, state: 'no_data' } as any,
    life_compass: { ...richPayload().life_compass, state: 'unset' } as any,
    matches_unread: 0,
    messages_unread: 0,
  });
}

function baseCtx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return {
    contextReadyResolved: true,
    isAnonymous: false,
    safeFastGreetingLive: false,
    reconnectCount: 0,
    lang: 'de',
    greetLang: 'de',
    bucket: 'yesterday',
    timeAgo: 'yesterday',
    wasFailure: false,
    firstName: 'Dragan',
    hasUserId: true,
    hasSupabase: true,
    hasPriorSession: true,
    greetingNeedsOnboarding: false,
    greetingIsFirstTime: false,
    lastFullBriefingDate: '2026-06-29', // briefing due
    todayTz: TODAY,
    localHour: 9,
    timezone: 'Europe/Berlin',
    timeOfDay: 'morning',
    proactiveLine: null,
    newdayOverview: null,
    resumeOverview: null,
    greetingLedger: EMPTY_GREETING_LEDGER,
    rotationSeed: 42,
    recentNbaKeys: [],
    currentRoute: null,
    currentScreenTitle: null,
    menuPhrases: ['Schön, dass du da bist.', 'Lass uns weitermachen.', 'Ich höre dir zu.'],
    openDecision: { mode: 'speak', source: 'baseline_lead', line: 'Du hast neue Nachrichten.' },
    guidedTopicNarrationContent: null,
    supportReportOpen: false,
    dayCloseReduced: true,
    userId: 'u1',
    wakeBriefDecisionId: 'wb-1',
    silenceOnSkipEnabled: true,
    wakeBriefHasSelectedContinuation: true,
    voiceWakeBriefReason: null,
    ...over,
  } as GreetingDecisionContext;
}

function safeFast(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return baseCtx({
    contextReadyResolved: false,
    safeFastGreetingLive: true,
    openDecision: { mode: 'speak', source: 'safe_fast', line: null },
    ...over,
  });
}

interface Fixture {
  name: string;
  ladder: 'safe_fast' | 'normal';
  ctx: GreetingDecisionContext;
  /** Rung the fixture exists to exercise (sanity-checked under the rich-payload scenario). */
  expectRichOpener: string;
  /** The serial code's pre-guard for the normal ladder (lang de/en etc.) — the sync path when false. */
  normalPreGuard?: boolean;
}

const FIXTURES: Fixture[] = [
  { name: 'normal · newday_overview', ladder: 'normal', ctx: baseCtx(), expectRichOpener: 'newday_overview' },
  {
    name: 'safe-fast · safe_fast_newday_overview',
    ladder: 'safe_fast',
    ctx: safeFast(),
    expectRichOpener: 'safe_fast_newday_overview',
  },
  {
    name: 'safe-fast · conv_resume (briefing already delivered today)',
    ladder: 'safe_fast',
    ctx: safeFast({ lastFullBriefingDate: TODAY, bucket: 'today', timeAgo: 'earlier today' }),
    expectRichOpener: 'conv_resume',
  },
  {
    name: 'normal · guided topic tap',
    ladder: 'normal',
    ctx: baseCtx({ guidedTopicNarrationContent: 'Lesson body about sleep.' }),
    expectRichOpener: 'override_v2',
  },
  {
    name: 'normal · support report',
    ladder: 'normal',
    ctx: baseCtx({ supportReportOpen: true }),
    expectRichOpener: 'support_report',
  },
  {
    name: 'safe-fast · support report',
    ladder: 'safe_fast',
    ctx: safeFast({ supportReportOpen: true }),
    expectRichOpener: 'support_report',
  },
  {
    // lang de (the session at greeting entry) but the stored preference that
    // landed with the facts is fr: rung 1 is attempted, rung 3's guard is not.
    name: 'safe-fast · greetLang differs from lang (resume guard off)',
    ladder: 'safe_fast',
    ctx: safeFast({ greetLang: 'fr' }),
    expectRichOpener: 'safe_fast_newday_overview',
  },
  {
    name: 'safe-fast · first_time_welcome',
    ladder: 'safe_fast',
    ctx: safeFast({ hasPriorSession: false, greetingIsFirstTime: true, lastFullBriefingDate: null }),
    expectRichOpener: 'safe_fast_first_time_welcome',
  },
  {
    name: 'normal · other language (sync path, pre-guard rejects)',
    ladder: 'normal',
    ctx: baseCtx({ lang: 'fr', greetLang: 'fr' }),
    expectRichOpener: 'override_v2',
    normalPreGuard: false,
  },
  {
    name: 'normal · anonymous (sync path, pre-guard rejects)',
    ladder: 'normal',
    ctx: baseCtx({ isAnonymous: true, hasUserId: false }),
    expectRichOpener: 'legacy_default',
    normalPreGuard: false,
  },
];

type GatherOutcome = { kind: 'value'; value: OverviewPayload; ms: number } | { kind: 'throw'; ms: number } | { kind: 'hang' };
type LedgerOutcome = { kind: 'value'; ms: number } | { kind: 'error'; ms: number } | { kind: 'slow'; ms: number };

interface Scenario {
  name: string;
  gathers: GatherOutcome[]; // consumed in call order (new-day first, then resume)
  ledger: LedgerOutcome;
}

const LEDGER_ROWS = [
  { signal_name: 'greeting_facts_v1', value: { facts: { messages_unread: { value: 8, spoken_at: '2026-06-29T07:00:00Z' } } } },
  { signal_name: 'greeting_last_utterance_v1', value: { text: 'Guten Morgen, Dragan!', spoken_at: '2026-06-29T07:00:00Z' } },
  { signal_name: 'wake_cadence:sessions_today', value: { date: TODAY, count: 2 } },
];

const SCENARIOS: Scenario[] = [
  { name: 'rich payload, ledger fast', gathers: [{ kind: 'value', value: richPayload(), ms: 400 }], ledger: { kind: 'value', ms: 300 } },
  { name: 'rich payload, ledger slower than gather', gathers: [{ kind: 'value', value: richPayload(), ms: 200 }], ledger: { kind: 'value', ms: 700 } },
  { name: 'rich payload, ledger times out', gathers: [{ kind: 'value', value: richPayload(), ms: 200 }], ledger: { kind: 'slow', ms: 1500 } },
  { name: 'rich payload, ledger read fails', gathers: [{ kind: 'value', value: richPayload(), ms: 200 }], ledger: { kind: 'error', ms: 100 } },
  {
    name: 'empty new-day payload, resume gather rich',
    gathers: [
      { kind: 'value', value: emptyPayload(), ms: 300 },
      { kind: 'value', value: richPayload(), ms: 250 },
    ],
    ledger: { kind: 'value', ms: 400 },
  },
  {
    name: 'empty new-day payload, ledger read fails',
    gathers: [
      { kind: 'value', value: emptyPayload(), ms: 300 },
      { kind: 'value', value: emptyPayload(), ms: 300 },
    ],
    ledger: { kind: 'error', ms: 100 },
  },
  { name: 'gather times out', gathers: [{ kind: 'hang' }, { kind: 'hang' }], ledger: { kind: 'value', ms: 100 } },
  {
    name: 'gather throws, ledger fails',
    gathers: [{ kind: 'throw', ms: 50 }, { kind: 'throw', ms: 50 }],
    ledger: { kind: 'error', ms: 50 },
  },
];

// --- I/O fakes --------------------------------------------------------------

function makeGather(outcomes: GatherOutcome[]) {
  let i = 0;
  const fn = jest.fn((): Promise<OverviewPayload> => {
    const o = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    if (o.kind === 'hang') return new Promise(() => {});
    return new Promise((resolve, reject) =>
      setTimeout(() => (o.kind === 'value' ? resolve(o.value) : reject(new Error('gather blew up'))), o.ms),
    );
  });
  return fn;
}

function armLedger(o: LedgerOutcome) {
  fetchSignals.mockReset();
  fetchSignals.mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(o.kind === 'error' ? { data: null, error: { message: 'db down' } } : { data: LEDGER_ROWS, error: null }),
          o.ms,
        ),
      ),
  );
}

const SUPA = {} as any;
const UID = 'u1' as string | null;
const TENANT = 't1' as string | null;
const IDENT = { supabase: SUPA, tenantId: 't1', userId: 'u1' };

// --- the serial code this replaced, copied verbatim (orb-live.ts @ 1e09f77) -

async function oldSafeFast(base: GreetingDecisionContext, gather: () => Promise<OverviewPayload>) {
  let _newdayOverviewSF: OverviewPayload | null = null;
  if (shouldAttemptNewdayOverview(base) && SUPA && UID && !tryDayCloseRung(base)) {
    _newdayOverviewSF = await Promise.race([
      gather(),
      new Promise<null>((r) => setTimeout(() => r(null), NEWDAY_MS)),
    ]).catch(() => null);
  }
  const _newdayWillFireSF = !!_newdayOverviewSF && newdayHasContent(_newdayOverviewSF);
  const _resumeCheckSF = _newdayWillFireSF ? { attempt: false as boolean } : shouldAttemptResumeOverview(base);
  let _resumeOverviewSF: OverviewPayload | null = null;
  if (_resumeCheckSF.attempt && SUPA && UID) {
    _resumeOverviewSF = await Promise.race([
      gather(),
      new Promise<null>((r) => setTimeout(() => r(null), RESUME_MS)),
    ]).catch(() => null);
  }
  const _ledgerSF =
    TENANT && UID && SUPA && (_newdayWillFireSF || _resumeCheckSF.attempt)
      ? await Promise.race([
          readGreetingLedger(IDENT),
          new Promise<GreetingLedger>((r) => setTimeout(() => r({ ...EMPTY_GREETING_LEDGER }), LEDGER_MS)),
        ]).catch(() => ({ ...EMPTY_GREETING_LEDGER }))
      : { ...EMPTY_GREETING_LEDGER };
  return decideOpeningFlow(
    { ...base, newdayOverview: _newdayOverviewSF, resumeOverview: _resumeOverviewSF, greetingLedger: _ledgerSF },
    { transport: 'vertex', role: null },
  );
}

async function oldNormal(base: GreetingDecisionContext, preGuard: boolean, gather: () => Promise<OverviewPayload>) {
  if (!preGuard) return decideOpeningFlow(base, { transport: 'vertex', role: null });
  const _ctxNS = base;
  if (shouldAttemptNewdayOverview(_ctxNS) && !tryDayCloseRung(_ctxNS)) {
    const _overviewNS = await Promise.race([
      gather(),
      new Promise<null>((r) => setTimeout(() => r(null), NEWDAY_MS)),
    ]).catch(() => null);
    const _tenantNS = TENANT;
    const _ledgerNS =
      _overviewNS && _tenantNS
        ? await Promise.race([
            readGreetingLedger(IDENT),
            new Promise<GreetingLedger>((r) => setTimeout(() => r({ ...EMPTY_GREETING_LEDGER }), LEDGER_MS)),
          ]).catch(() => ({ ...EMPTY_GREETING_LEDGER }))
        : { ...EMPTY_GREETING_LEDGER };
    return decideOpeningFlow({ ..._ctxNS, newdayOverview: _overviewNS, greetingLedger: _ledgerNS }, {
      transport: 'vertex',
      role: null,
    });
  }
  return decideOpeningFlow(_ctxNS, { transport: 'vertex', role: null });
}

// --- the new code, wired exactly as orb-live.ts wires it --------------------

async function newSafeFast(base: GreetingDecisionContext, gather: () => Promise<OverviewPayload>) {
  const _explicitOpenSF = overviewIndependentOpenerWins(base);
  const r = await gatherSafeFastGreetingPayloads({
    attemptNewday:
      !_explicitOpenSF && !!(shouldAttemptNewdayOverview(base) && SUPA && UID && !tryDayCloseRung(base)),
    resumeGuard: _explicitOpenSF ? { attempt: false } : shouldAttemptResumeOverview(base),
    resumeGatherEligible: true,
    ledgerEligible: true,
    newdayWillFire: (o) => !!o && newdayHasContent(o),
    gather: (timeoutMs) => boundedRead(gather, timeoutMs, () => null, () => null),
    startLedger: () => startSpeculativeGreetingLedgerRead(IDENT, LEDGER_MS),
    emptyLedger: () => ({ ...EMPTY_GREETING_LEDGER }),
    newdayTimeoutMs: NEWDAY_MS,
    resumeTimeoutMs: RESUME_MS,
  });
  return decideOpeningFlow(
    { ...base, newdayOverview: r.newdayOverview, resumeOverview: r.resumeOverview, greetingLedger: r.ledger },
    { transport: 'vertex', role: null },
  );
}

async function newNormal(base: GreetingDecisionContext, preGuard: boolean, gather: () => Promise<OverviewPayload>) {
  // The pre-guard gains one gate: no_explicit_open_rung.
  if (!(preGuard && !overviewIndependentOpenerWins(base))) {
    return decideOpeningFlow(base, { transport: 'vertex', role: null });
  }
  const _ctxNS = base;
  if (shouldAttemptNewdayOverview(_ctxNS) && !tryDayCloseRung(_ctxNS)) {
    const { overview, ledger } = await gatherNewdayGreetingPayload({
      ledgerEligible: true,
      gather: (timeoutMs) => boundedRead(gather, timeoutMs, () => null, () => null),
      startLedger: () => startSpeculativeGreetingLedgerRead(IDENT, LEDGER_MS),
      emptyLedger: () => ({ ...EMPTY_GREETING_LEDGER }),
      newdayTimeoutMs: NEWDAY_MS,
    });
    return decideOpeningFlow({ ..._ctxNS, newdayOverview: overview, greetingLedger: ledger }, {
      transport: 'vertex',
      role: null,
    });
  }
  return decideOpeningFlow(_ctxNS, { transport: 'vertex', role: null });
}

/** Run a promise to completion under fake timers; returns value + fake ms elapsed. */
async function drive<T>(p: Promise<T>): Promise<{ value: T; elapsed: number }> {
  const t0 = Date.now();
  let done = false;
  let value!: T;
  let err: unknown;
  p.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      err = e;
    },
  );
  let elapsed = 0;
  for (let i = 0; i < 2000 && !done; i++) {
    await jest.advanceTimersByTimeAsync(10);
    elapsed = Date.now() - t0;
  }
  if (!done) throw new Error('did not settle');
  if (err) throw err;
  // flush trailing fire-and-forget work (the failure telemetry's dynamic import)
  await jest.advanceTimersByTimeAsync(3000);
  return { value, elapsed };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(NOW_ISO) });
  emitOasis.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// (b) golden equality
// ---------------------------------------------------------------------------

describe('VTID-04544 (b) — the decision is byte-identical to the serial code', () => {
  for (const fx of FIXTURES) {
    for (const sc of SCENARIOS) {
      it(`${fx.name} × ${sc.name}`, async () => {
        const preGuard = fx.normalPreGuard !== false;

        armLedger(sc.ledger);
        const oldGather = makeGather(sc.gathers);
        const old = await drive(
          fx.ladder === 'safe_fast' ? oldSafeFast(fx.ctx, oldGather) : oldNormal(fx.ctx, preGuard, oldGather),
        );
        const oldFailures = emitOasis.mock.calls.length;

        emitOasis.mockClear();
        armLedger(sc.ledger);
        const newGather = makeGather(sc.gathers);
        const neu = await drive(
          fx.ladder === 'safe_fast' ? newSafeFast(fx.ctx, newGather) : newNormal(fx.ctx, preGuard, newGather),
        );
        const newFailures = emitOasis.mock.calls.length;

        // Directive text, rung, diag and effects — the whole decision.
        expect(neu.value.wakeOpener).toBe(old.value.wakeOpener);
        expect(neu.value.directive).toBe(old.value.directive);
        expect(neu.value).toEqual(old.value);
        // No write the serial code would not have made. Where an overview-
        // independent opener wins (the skip path), the discarded ledger read no
        // longer happens at all, so neither does its `read_failed` event; on
        // every other path the telemetry is identical.
        if (preGuard && overviewIndependentOpenerWins(fx.ctx)) {
          expect(newFailures).toBe(0);
          expect(newGather).not.toHaveBeenCalled();
        } else {
          expect(newFailures).toBe(oldFailures);
        }
        // Never more gathers than before; never slower.
        expect(newGather.mock.calls.length).toBeLessThanOrEqual(oldGather.mock.calls.length);
        expect(neu.elapsed).toBeLessThanOrEqual(old.elapsed);
      });
    }
  }

  it('the fixtures really exercise the rungs they are named after (rich payload, fast ledger)', async () => {
    for (const fx of FIXTURES) {
      armLedger({ kind: 'value', ms: 100 });
      const g = makeGather([
        { kind: 'value', value: richPayload(), ms: 100 },
        { kind: 'value', value: richPayload(), ms: 100 },
      ]);
      const r = await drive(
        fx.ladder === 'safe_fast' ? newSafeFast(fx.ctx, g) : newNormal(fx.ctx, fx.normalPreGuard !== false, g),
      );
      expect({ fixture: fx.name, opener: r.value.wakeOpener }).toEqual({ fixture: fx.name, opener: fx.expectRichOpener });
    }
  });

  it('the ledger actually reaches the decision on the payload paths (so equality above is not vacuous)', async () => {
    armLedger({ kind: 'value', ms: 100 });
    const g = makeGather([{ kind: 'value', value: richPayload(), ms: 100 }]);
    const withLedger = await drive(newNormal(baseCtx(), true, g));
    const withoutLedger = decideOpeningFlow(
      { ...baseCtx(), newdayOverview: richPayload(), greetingLedger: EMPTY_GREETING_LEDGER },
      { transport: 'vertex', role: null },
    );
    expect(withLedger.value.wakeOpener).toBe('newday_overview');
    expect(withLedger.value.directive).not.toBe(withoutLedger.directive);
  });
});

// ---------------------------------------------------------------------------
// (a) concurrency
// ---------------------------------------------------------------------------

describe('VTID-04544 (a) — gather and ledger run concurrently', () => {
  it('normal ladder: waits max(gather 500, ledger 400) ≈ 500 ms, not the serial 900 ms', async () => {
    armLedger({ kind: 'value', ms: 400 });
    const oldRun = await drive(oldNormal(baseCtx(), true, makeGather([{ kind: 'value', value: richPayload(), ms: 500 }])));
    armLedger({ kind: 'value', ms: 400 });
    const newRun = await drive(newNormal(baseCtx(), true, makeGather([{ kind: 'value', value: richPayload(), ms: 500 }])));
    expect(oldRun.elapsed).toBeGreaterThanOrEqual(900);
    expect(newRun.elapsed).toBeGreaterThanOrEqual(500);
    expect(newRun.elapsed).toBeLessThan(600);
    expect(newRun.value).toEqual(oldRun.value);
  });

  it('safe-fast ladder, resume path: max(500 + 300, 400) ≈ 800 ms, not the serial 1200 ms', async () => {
    const gathers: GatherOutcome[] = [
      { kind: 'value', value: emptyPayload(), ms: 500 },
      { kind: 'value', value: richPayload(), ms: 300 },
    ];
    armLedger({ kind: 'value', ms: 400 });
    const oldRun = await drive(oldSafeFast(safeFast(), makeGather(gathers)));
    armLedger({ kind: 'value', ms: 400 });
    const newRun = await drive(newSafeFast(safeFast(), makeGather(gathers)));
    expect(oldRun.elapsed).toBeGreaterThanOrEqual(1200);
    expect(newRun.elapsed).toBeGreaterThanOrEqual(800);
    expect(newRun.elapsed).toBeLessThan(900);
    expect(newRun.value.wakeOpener).toBe('conv_resume');
    expect(newRun.value).toEqual(oldRun.value);
  });

  it('the ledger read starts before the gather has settled', async () => {
    const order: string[] = [];
    fetchSignals.mockReset();
    fetchSignals.mockImplementation(() => {
      order.push('ledger_start');
      return new Promise((r) => setTimeout(() => r({ data: LEDGER_ROWS, error: null }), 100));
    });
    const gather = () => {
      order.push('gather_start');
      return new Promise<OverviewPayload>((r) =>
        setTimeout(() => {
          order.push('gather_end');
          r(richPayload());
        }, 300),
      );
    };
    await drive(
      gatherNewdayGreetingPayload({
        ledgerEligible: true,
        gather: (ms) => boundedRead(gather, ms, () => null, () => null),
        startLedger: () => startSpeculativeGreetingLedgerRead(IDENT, LEDGER_MS),
        emptyLedger: () => ({ ...EMPTY_GREETING_LEDGER }),
        newdayTimeoutMs: NEWDAY_MS,
      }),
    );
    expect(order.indexOf('ledger_start')).toBeLessThan(order.indexOf('gather_end'));
  });
});

// ---------------------------------------------------------------------------
// the speculative ledger read keeps the serial bound and writes nothing unused
// ---------------------------------------------------------------------------

describe('VTID-04544 — startSpeculativeGreetingLedgerRead', () => {
  it('a discarded read that fails emits NO read_failed event', async () => {
    armLedger({ kind: 'error', ms: 50 });
    startSpeculativeGreetingLedgerRead(IDENT, LEDGER_MS);
    await jest.advanceTimersByTimeAsync(3000);
    expect(emitOasis).not.toHaveBeenCalled();
  });

  it('a consumed read that fails emits exactly one read_failed event, like readGreetingLedger', async () => {
    armLedger({ kind: 'error', ms: 50 });
    const r = startSpeculativeGreetingLedgerRead(IDENT, LEDGER_MS);
    const { value } = await drive(r.consume());
    r.consume();
    await jest.advanceTimersByTimeAsync(3000);
    expect(value).toEqual(EMPTY_GREETING_LEDGER);
    expect(emitOasis).toHaveBeenCalledTimes(1);
    expect(emitOasis.mock.calls[0][0].type).toBe('memory.greeting_ledger.read_failed');
  });

  it('the bound runs from the read\'s own start: a read slower than 800 ms is EMPTY even if consumed later', async () => {
    armLedger({ kind: 'value', ms: 900 });
    const r = startSpeculativeGreetingLedgerRead(IDENT, LEDGER_MS);
    await jest.advanceTimersByTimeAsync(1000);
    const { value } = await drive(r.consume());
    expect(value).toEqual(EMPTY_GREETING_LEDGER);
  });

  it('a read that finished within its bound is used when consumed later', async () => {
    armLedger({ kind: 'value', ms: 300 });
    const r = startSpeculativeGreetingLedgerRead(IDENT, LEDGER_MS);
    await jest.advanceTimersByTimeAsync(2000);
    const { value, elapsed } = await drive(r.consume());
    expect(value.sessions_today).toBe(2);
    expect(value.last_utterance).toBe('Guten Morgen, Dragan!');
    expect(elapsed).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// (c) the skip path
// ---------------------------------------------------------------------------

describe('VTID-04544 (c) — overview-independent openers skip the reads', () => {
  const supportNormal = baseCtx({ supportReportOpen: true });
  const guidedNormal = baseCtx({ guidedTopicNarrationContent: 'Lesson body.' });
  const supportFast = safeFast({ supportReportOpen: true });

  it.each([
    ['normal · support report', supportNormal, 'normal'],
    ['normal · guided topic', guidedNormal, 'normal'],
    ['safe-fast · support report', supportFast, 'safe_fast'],
  ] as const)('%s: gather and ledger are never called', async (_n, c, ladder) => {
    armLedger({ kind: 'value', ms: 100 });
    const g = makeGather([{ kind: 'value', value: richPayload(), ms: 100 }]);
    await drive(ladder === 'safe_fast' ? newSafeFast(c, g) : newNormal(c, true, g));
    expect(g).not.toHaveBeenCalled();
    expect(fetchSignals).not.toHaveBeenCalled();
  });

  it('overviewIndependentOpenerWins is exactly "the decision ignores payloads and ledger"', () => {
    const rich = { newdayOverview: richPayload(), resumeOverview: richPayload(), greetingLedger: { ...EMPTY_GREETING_LEDGER, sessions_today: 5, last_utterance: 'x', last_utterance_at: NOW_ISO } };
    const cases: GreetingDecisionContext[] = [supportNormal, guidedNormal, supportFast];
    for (const c of cases) {
      expect(overviewIndependentOpenerWins(c)).toBe(true);
      expect(computeGreetingDecision({ ...c, ...rich })).toEqual(computeGreetingDecision(c));
    }
  });

  it('is false where a payload rung can still win (guided topic with no speakable line, safe-fast guided, plain sessions)', () => {
    expect(overviewIndependentOpenerWins(baseCtx())).toBe(false);
    expect(overviewIndependentOpenerWins(safeFast())).toBe(false);
    expect(
      overviewIndependentOpenerWins(
        baseCtx({ guidedTopicNarrationContent: 'x', openDecision: { mode: 'speak', source: 'baseline_lead', line: '  ' } }),
      ),
    ).toBe(false);
    // safe-fast carries no opening line, so a guided topic can never win there.
    expect(overviewIndependentOpenerWins(safeFast({ guidedTopicNarrationContent: 'x' }))).toBe(false);
    expect(overviewIndependentOpenerWins(baseCtx({ supportReportOpen: true, isAnonymous: true }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// orb-live.ts wires the helpers the way the functions above assume
// ---------------------------------------------------------------------------

describe('VTID-04544 — orb-live.ts wiring', () => {
  const src = readFileSync(join(__dirname, '../../../src/routes/orb-live.ts'), 'utf8');

  it('both ladders go through the concurrent helpers; no serial ledger read is left', () => {
    expect(src).toContain('await gatherSafeFastGreetingPayloads({');
    expect(src).toContain('await gatherNewdayGreetingPayload({');
    expect(src).not.toMatch(/readGreetingLedger\(/);
    expect(src.split('startSpeculativeGreetingLedgerRead(').length - 1).toBe(2);
  });

  it('the safe-fast plan skips on an overview-independent opener, the normal pre-guard gates on it', () => {
    expect(src).toContain('const _explicitOpenSF = overviewIndependentOpenerWins(_baseCtxSF);');
    expect(src).toMatch(/attemptNewday:\s*!_explicitOpenSF &&/);
    expect(src).toMatch(/resumeGuard: _explicitOpenSF \? \{ attempt: false \} : shouldAttemptResumeOverview\(_baseCtxSF\)/);
    const gates = src.slice(src.indexOf('const _ndGates = {'), src.indexOf('const _newdaySyncPossible'));
    expect(gates).toContain('no_explicit_open_rung: !overviewIndependentOpenerWins(_baseCtxSync)');
  });

  it('budgets are unchanged', () => {
    expect(src.split("Number(process.env.ORB_NEWDAY_OVERVIEW_WAIT_MS || 3000)").length - 1).toBe(2);
    expect(src).toContain("Number(process.env.ORB_RESUME_OVERVIEW_WAIT_MS || 1800)");
    expect(src).toMatch(/startSpeculativeGreetingLedgerRead\(\{ supabase: _supaSF!, tenantId: _tenantSF!, userId: _uidSF! \}, 800\)/);
    expect(src).toMatch(/startSpeculativeGreetingLedgerRead\(\{ supabase: _syncSupa!, tenantId: _tenantNS!, userId: _syncUid! \}, 800\)/);
  });
});
