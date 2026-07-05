/**
 * Greeting continuity — spoken-facts ledger + wording-variety walls.
 *
 * The four operator rules under test:
 *   1. never repeat updates from the previous session (unchanged levels
 *      are forbidden; changed levels are spoken as their DELTA)
 *   2. never reuse the previous greeting's wording (negative example)
 *   3. no hardcoded speeches (the mandated "du hast schon X Sessions
 *      geschafft" template is GONE from the briefing contract)
 *   4. context-first (SITUATION block present; sessions_today surfaced)
 */

import {
  computeFactDeltas,
  extractSpokenFactsFromPayload,
  parseFacts,
  buildFactContinuityLines,
  buildPreviousGreetingSection,
  readGreetingLedger,
  recordGreetingFacts,
  recordGreetingUtterance,
  EMPTY_GREETING_LEDGER,
  SIGNAL_GREETING_FACTS,
  SIGNAL_GREETING_LAST_UTTERANCE,
  UTTERANCE_MAX_CHARS,
  type GreetingLedger,
} from '../../../src/services/conversation/greeting-facts-ledger';
import { buildResumeDirective } from '../../../src/services/conversation/decide-opening';
import { buildNewDayOverviewBlock } from '../../../src/services/assistant-continuation/providers/new-day-overview-prompt';
import type { OverviewPayload } from '../../../src/services/assistant-continuation/providers/new-day-overview-payload';

const NOW = '2026-07-03T08:00:00.000Z';
const YESTERDAY = '2026-07-02T08:00:00.000Z';
const LAST_WEEK = '2026-06-20T08:00:00.000Z';

function ledgerWith(
  facts: Record<string, { value: number; spoken_at: string }>,
  lastUtterance: string | null = null,
): GreetingLedger {
  return {
    facts,
    last_utterance: lastUtterance,
    last_utterance_at: lastUtterance ? YESTERDAY : null,
    sessions_today: null,
  };
}

function basePayload(overrides: Partial<OverviewPayload> = {}): OverviewPayload {
  return {
    journey: null,
    vitana_index: { state: 'not_set_up' } as OverviewPayload['vitana_index'],
    life_compass: { state: 'not_set' } as OverviewPayload['life_compass'],
    calendar_today: { count: 0, next: null } as OverviewPayload['calendar_today'],
    calendar_passed: { count: 0, most_recent: null } as OverviewPayload['calendar_passed'],
    autopilot: { state: 'none_yet', today_checkpoint: null, this_week: [], pending_total: 0 } as OverviewPayload['autopilot'],
    matches_unread: 0,
    messages_unread: 0,
    reminders_today: { count: 0, next: null },
    guided_journey: null,
    diary_last_7d: 1,
    last_session_date_user_tz: null,
    ...overrides,
  } as OverviewPayload;
}

// ---------------------------------------------------------------------------
// Delta computation (rule 1 core)
// ---------------------------------------------------------------------------

describe('computeFactDeltas', () => {
  it('marks a never-spoken fact as new', () => {
    const d = computeFactDeltas({ messages_unread: 10 }, ledgerWith({}), { nowIso: NOW });
    expect(d.messages_unread.status).toBe('new');
    expect(d.messages_unread.previous).toBeNull();
  });

  it('marks an identical fresh fact as unchanged', () => {
    const d = computeFactDeltas(
      { messages_unread: 10 },
      ledgerWith({ messages_unread: { value: 10, spoken_at: YESTERDAY } }),
      { nowIso: NOW },
    );
    expect(d.messages_unread.status).toBe('unchanged');
    expect(d.messages_unread.delta).toBe(0);
  });

  it('marks a moved fact as changed with the exact delta', () => {
    const d = computeFactDeltas(
      { messages_unread: 12, sessions_completed: 13 },
      ledgerWith({
        messages_unread: { value: 10, spoken_at: YESTERDAY },
        sessions_completed: { value: 11, spoken_at: YESTERDAY },
      }),
      { nowIso: NOW },
    );
    expect(d.messages_unread.status).toBe('changed');
    expect(d.messages_unread.delta).toBe(2);
    expect(d.sessions_completed.delta).toBe(2);
  });

  it('treats a stale spoken fact (>48h) as new again', () => {
    const d = computeFactDeltas(
      { messages_unread: 10 },
      ledgerWith({ messages_unread: { value: 10, spoken_at: LAST_WEEK } }),
      { nowIso: NOW },
    );
    expect(d.messages_unread.status).toBe('new');
  });
});

describe('extractSpokenFactsFromPayload', () => {
  it('extracts the repetition-prone levels', () => {
    const facts = extractSpokenFactsFromPayload(
      basePayload({
        messages_unread: 10,
        matches_unread: 3,
        guided_journey: {
          sessions_completed: 11,
          topics_learned: 21,
          topics_total: 30,
          next_session_title: 'Zellgesundheit',
          last_session_recall: null,
        },
        vitana_index: { state: 'ok', today: 72 } as unknown as OverviewPayload['vitana_index'],
        reminders_today: { count: 2, next: null },
      }),
    );
    expect(facts).toMatchObject({
      messages_unread: 10,
      matches_unread: 3,
      sessions_completed: 11,
      vitana_index: 72,
      reminders_today: 2,
    });
  });

  it('returns empty for a null payload', () => {
    expect(extractSpokenFactsFromPayload(null)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Resume directive (same-day reopens — where "10 Nachrichten" repeated)
// ---------------------------------------------------------------------------

describe('buildResumeDirective — spoken-facts continuity', () => {
  const payload = basePayload({
    messages_unread: 10,
    guided_journey: {
      sessions_completed: 11,
      topics_learned: 21,
      topics_total: 30,
      next_session_title: 'Zellgesundheit',
      last_session_recall: null,
    },
  });

  it('unchanged counts move OUT of new_since_last into already_mentioned', () => {
    const deltas = computeFactDeltas(extractSpokenFactsFromPayload(payload), ledgerWith({
      messages_unread: { value: 10, spoken_at: YESTERDAY },
      sessions_completed: { value: 11, spoken_at: YESTERDAY },
    }), { nowIso: NOW });
    const { text } = buildResumeDirective({
      register: 'same_day',
      payload,
      firstName: 'Dragan',
      lang: 'de',
      timeAgo: 'about 3 hours ago',
      factDeltas: deltas,
    });
    expect(text).not.toContain('"new_since_last"');
    expect(text).toContain('"already_mentioned"');
    expect(text).toContain('NEVER restate their counts');
  });

  it('a changed count is phrased as its delta, never the running total', () => {
    const deltas = computeFactDeltas(extractSpokenFactsFromPayload(payload), ledgerWith({
      messages_unread: { value: 8, spoken_at: YESTERDAY },
    }), { nowIso: NOW });
    const { text } = buildResumeDirective({
      register: 'same_day',
      payload,
      firstName: 'Dragan',
      lang: 'de',
      timeAgo: 'about 3 hours ago',
      factDeltas: deltas,
    });
    expect(text).toContain('2 message(s) arrived since you last mentioned the inbox');
    // Neither the what's-new list nor the suggestion may hand the model the
    // plain running total to recite.
    expect(text).not.toContain('10 unread message(s)');
  });

  it('without a ledger (legacy call) the plain counts still flow', () => {
    const { text } = buildResumeDirective({
      register: 'same_day',
      payload,
      firstName: 'Dragan',
      lang: 'de',
      timeAgo: 'about 3 hours ago',
    });
    expect(text).toContain('10 unread message(s)');
  });

  it('the previous greeting is embedded as a negative example (rule 2)', () => {
    const { text } = buildResumeDirective({
      register: 'quick_resume',
      payload,
      firstName: 'Dragan',
      lang: 'de',
      timeAgo: 'a few minutes ago',
      previousUtterance: 'Guten Morgen Dragan, du hast 10 ungelesene Nachrichten.',
    });
    expect(text).toContain('YOUR PREVIOUS GREETING TO THIS USER');
    expect(text).toContain('Guten Morgen Dragan, du hast 10 ungelesene Nachrichten.');
    expect(text).toContain('NEVER IMITATE');
  });

  it('the reply_messages suggestion drops the stale number when unchanged', () => {
    const deltas = computeFactDeltas(extractSpokenFactsFromPayload(payload), ledgerWith({
      messages_unread: { value: 10, spoken_at: YESTERDAY },
    }), { nowIso: NOW });
    const { text, nba } = buildResumeDirective({
      register: 'same_day',
      payload,
      firstName: 'Dragan',
      lang: 'de',
      timeAgo: 'about 3 hours ago',
      factDeltas: deltas,
    });
    if (nba?.key === 'reply_messages') {
      expect(text).toContain('the unread messages the user already knows about');
      expect(text).not.toContain('"what": "10 unread message(s)"');
    }
  });

  it('sessions_today is surfaced as situation context (rule 4)', () => {
    const { text } = buildResumeDirective({
      register: 'same_day',
      payload,
      firstName: 'Dragan',
      lang: 'de',
      timeAgo: 'about 3 hours ago',
      sessionsToday: 4,
    });
    expect(text).toContain('"sessions_today": 4');
  });
});

// ---------------------------------------------------------------------------
// Daily briefing block (once/day — where "11 Sessions" was mandated)
// ---------------------------------------------------------------------------

describe('buildNewDayOverviewBlock — de-templated, ledger-conditional coverage', () => {
  const payload = basePayload({
    messages_unread: 10,
    guided_journey: {
      sessions_completed: 11,
      topics_learned: 21,
      topics_total: 30,
      next_session_title: 'Zellgesundheit',
      last_session_recall: null,
    },
  });
  const baseArgs = {
    payload,
    lang: 'de',
    firstName: 'Dragan',
    localHour: 8,
    timezone: 'Europe/Berlin',
  };

  it('rule 3: the mandated "du hast schon X Sessions geschafft" template is gone', () => {
    const block = buildNewDayOverviewBlock(baseArgs);
    expect(block).not.toContain('du hast schon 11 Sessions geschafft');
    expect(block).toContain('compose the sentence yourself');
    expect(block).toContain('are NOT fixed wording');
  });

  it('rule 1: unchanged session count → coverage forbids restating it', () => {
    const deltas = computeFactDeltas(extractSpokenFactsFromPayload(payload), ledgerWith({
      sessions_completed: { value: 11, spoken_at: YESTERDAY },
      messages_unread: { value: 10, spoken_at: YESTERDAY },
    }), { nowIso: NOW });
    const block = buildNewDayOverviewBlock({ ...baseArgs, factDeltas: deltas });
    expect(block).toContain('Do NOT restate the count');
    expect(block).toContain('ALREADY-SPOKEN FACTS');
    // messages: soft nod at most, never the number as news
    expect(block).toContain('already knows about their 10 unread message(s)');
  });

  it('rule 1: advanced session count → coverage demands the delta framing', () => {
    const deltas = computeFactDeltas(extractSpokenFactsFromPayload(payload), ledgerWith({
      sessions_completed: { value: 9, spoken_at: YESTERDAY },
    }), { nowIso: NOW });
    const block = buildNewDayOverviewBlock({ ...baseArgs, factDeltas: deltas });
    expect(block).toContain('completed 2 more session(s)');
    expect(block).toContain('the progress since last time is the news');
  });

  it('rule 2: the previous greeting appears as a negative example', () => {
    const block = buildNewDayOverviewBlock({
      ...baseArgs,
      previousUtterance: 'Guten Morgen Dragan — schön, dass du wieder da bist.',
    });
    expect(block).toContain('YOUR PREVIOUS GREETING TO THIS USER');
    expect(block).toContain('different first words');
  });

  it('rule 4: the SITUATION section frames the composition', () => {
    const block = buildNewDayOverviewBlock({ ...baseArgs, sessionsToday: 2 });
    expect(block).toContain('## SITUATION');
    expect(block).toContain('Sessions the user already opened today: 2');
    expect(block).toContain('Local hour: 8');
  });

  it('without a ledger the briefing still builds (legacy behavior)', () => {
    const block = buildNewDayOverviewBlock(baseArgs);
    expect(block).toContain('COVERAGE CHECKLIST');
    expect(block).toContain('10 unread message(s)');
  });
});

// ---------------------------------------------------------------------------
// Ledger persistence (fake supabase — user_assistant_state contract)
// ---------------------------------------------------------------------------

type Row = { tenant_id: string; user_id: string; signal_name: string; value: unknown };

function fakeSupabase(rows: Row[]) {
  const state = [...rows];
  const table = {
    upserts: [] as unknown[],
    from(name: string) {
      if (name !== 'user_assistant_state') throw new Error(`unexpected table ${name}`);
      const filters: Record<string, unknown> = {};
      let inSignals: string[] | null = null;
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        in: (_col: string, vals: string[]) => {
          inSignals = vals;
          return Promise.resolve({
            data: state.filter(
              (r) =>
                r.tenant_id === filters.tenant_id &&
                r.user_id === filters.user_id &&
                (inSignals as string[]).includes(r.signal_name),
            ),
            error: null,
          });
        },
        maybeSingle: () =>
          Promise.resolve({
            data:
              state.find(
                (r) =>
                  r.tenant_id === filters.tenant_id &&
                  r.user_id === filters.user_id &&
                  r.signal_name === filters.signal_name,
              ) ?? null,
            error: null,
          }),
        upsert: (row: Row | Row[]) => {
          for (const r of Array.isArray(row) ? row : [row]) {
            table.upserts.push(r);
            const idx = state.findIndex(
              (s) =>
                s.tenant_id === r.tenant_id &&
                s.user_id === r.user_id &&
                s.signal_name === r.signal_name,
            );
            if (idx >= 0) state[idx] = r;
            else state.push(r);
          }
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  };
  return table;
}

describe('greeting ledger persistence', () => {
  const ident = { tenantId: 't-1', userId: 'u-1' };

  it('round-trips facts and the last utterance through user_assistant_state', async () => {
    const sb = fakeSupabase([]);
    await recordGreetingFacts({
      supabase: sb as any,
      ...ident,
      facts: { messages_unread: 10, sessions_completed: 11 },
      nowIso: NOW,
    });
    await recordGreetingUtterance({
      supabase: sb as any,
      ...ident,
      utterance: 'Guten Morgen Dragan.',
      nowIso: NOW,
    });
    const ledger = await readGreetingLedger({ supabase: sb as any, ...ident, nowIso: NOW });
    expect(ledger.facts.messages_unread).toEqual({ value: 10, spoken_at: NOW });
    expect(ledger.facts.sessions_completed).toEqual({ value: 11, spoken_at: NOW });
    expect(ledger.last_utterance).toBe('Guten Morgen Dragan.');
  });

  it('merges new facts into the existing map without dropping others', async () => {
    const sb = fakeSupabase([
      {
        ...{ tenant_id: 't-1', user_id: 'u-1' },
        signal_name: SIGNAL_GREETING_FACTS,
        value: { facts: { vitana_index: { value: 72, spoken_at: YESTERDAY } } },
      },
    ]);
    await recordGreetingFacts({
      supabase: sb as any,
      ...ident,
      facts: { messages_unread: 12 },
      nowIso: NOW,
    });
    const ledger = await readGreetingLedger({ supabase: sb as any, ...ident, nowIso: NOW });
    expect(ledger.facts.vitana_index.value).toBe(72);
    expect(ledger.facts.messages_unread.value).toBe(12);
  });

  it('reads sessions_today from the cadence signal in the same query', async () => {
    const sb = fakeSupabase([
      {
        tenant_id: 't-1',
        user_id: 'u-1',
        signal_name: 'wake_cadence:sessions_today',
        value: { date: NOW.slice(0, 10), count: 3 },
      },
    ]);
    const ledger = await readGreetingLedger({ supabase: sb as any, ...ident, nowIso: NOW });
    expect(ledger.sessions_today).toBe(3);
  });

  it('ignores a stale sessions_today from another day', async () => {
    const sb = fakeSupabase([
      {
        tenant_id: 't-1',
        user_id: 'u-1',
        signal_name: 'wake_cadence:sessions_today',
        value: { date: '2026-07-01', count: 9 },
      },
    ]);
    const ledger = await readGreetingLedger({ supabase: sb as any, ...ident, nowIso: NOW });
    expect(ledger.sessions_today).toBeNull();
  });

  it('fails OPEN: missing identity or throwing client → empty ledger, ok:false', async () => {
    const throwing = { from: () => { throw new Error('db down'); } };
    const ledger = await readGreetingLedger({ supabase: throwing as any, ...ident });
    expect(ledger).toEqual({ ...EMPTY_GREETING_LEDGER });
    const wr = await recordGreetingFacts({
      supabase: throwing as any,
      ...ident,
      facts: { messages_unread: 1 },
    });
    expect(wr.ok).toBe(false);
    const noId = await recordGreetingUtterance({
      supabase: throwing as any,
      tenantId: '',
      userId: 'u-1',
      utterance: 'x',
    });
    expect(noId).toEqual({ ok: false, reason: 'missing_identity' });
  });

  it('truncates stored utterances to the cap', async () => {
    const sb = fakeSupabase([]);
    await recordGreetingUtterance({
      supabase: sb as any,
      ...ident,
      utterance: 'A'.repeat(2000),
      nowIso: NOW,
    });
    const ledger = await readGreetingLedger({ supabase: sb as any, ...ident, nowIso: NOW });
    expect((ledger.last_utterance as string).length).toBe(UTTERANCE_MAX_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Pure prompt helpers
// ---------------------------------------------------------------------------

describe('prompt helpers', () => {
  it('buildFactContinuityLines emits rules only for unchanged/changed facts', () => {
    const lines = buildFactContinuityLines({
      a: { key: 'a', current: 5, previous: 5, delta: 0, status: 'unchanged', spoken_at: YESTERDAY },
      b: { key: 'b', current: 7, previous: 4, delta: 3, status: 'changed', spoken_at: YESTERDAY },
      c: { key: 'c', current: 9, previous: null, delta: null, status: 'new', spoken_at: null },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Do NOT restate this number');
    expect(lines[1]).toContain('speak the CHANGE');
  });

  it('buildPreviousGreetingSection is empty without an utterance', () => {
    expect(buildPreviousGreetingSection(null)).toBe('');
    expect(buildPreviousGreetingSection('  ')).toBe('');
  });

  it('parseFacts drops malformed entries', () => {
    const facts = parseFacts({
      facts: {
        good: { value: 3, spoken_at: NOW },
        bad_value: { value: 'x', spoken_at: NOW },
        bad_at: { value: 3, spoken_at: 42 },
        not_obj: 7,
      },
    });
    expect(Object.keys(facts)).toEqual(['good']);
  });

  it('exports the signal names the wiring depends on', () => {
    expect(SIGNAL_GREETING_FACTS).toBe('greeting_facts_v1');
    expect(SIGNAL_GREETING_LAST_UTTERANCE).toBe('greeting_last_utterance_v1');
  });
});
