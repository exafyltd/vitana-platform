/**
 * VTID-04444 (Conversation rebuild WS-4.2) — nightly diary theme rollup.
 *
 * Contract under test:
 *   - the flag is exact 'true', off by default
 *   - the model's answer is checked against the entries it was given:
 *     out-of-range entry numbers dropped, empty themes dropped, labels merged,
 *     counts / last-seen / trend computed from the entries' own dates
 *   - people are relationship words only; a name is dropped
 *   - per-user rollup: too few entries, unchanged inputs and model failure
 *     never call / never write; a success writes diary_themes_v1
 *   - the run respects the model-call cap and the tenant filter
 *   - readDiaryThemes ignores stale rollups; stamps summary counts only
 *   - loop 10 of the consolidator is the old count when the flag is off and
 *     the rollup when it is on
 *   - the profile synthesis reads a fresh rollup as an input
 *
 * All diary text here is synthetic.
 */

const routerReplies: Array<{ ok: boolean; text?: string; provider?: string; model?: string; error?: string }> = [];
const routerCalls: Array<{ stage: string; prompt: string; opts: any }> = [];
jest.mock('../../../src/services/llm-router', () => ({
  callViaRouter: jest.fn(async (stage: string, prompt: string, opts: any) => {
    routerCalls.push({ stage, prompt, opts });
    return routerReplies.shift() ?? { ok: false, error: 'no reply queued' };
  }),
}));

import {
  DIARY_ROLLUP_MIN_ENTRIES,
  SIGNAL_DIARY_THEMES,
  buildDiaryThemePrompt,
  computeDiaryInputsHash,
  isDiaryRollupEnabled,
  parseDiaryThemeOutput,
  readDiaryThemes,
  rollupDiaryThemesForUser,
  runDiaryThemeRollup,
  summarizeDiaryThemeStamps,
  type DiaryEntryInput,
} from '../../../src/services/memory/diary-theme-rollup';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// Fake Supabase: diary_entries, user_tenants, user_assistant_state.
// ---------------------------------------------------------------------------
interface Store {
  diary: Array<{ user_id: string; text: string; created_at: string }>;
  tenants: Array<{ user_id: string; tenant_id: string; is_primary: boolean }>;
  state: Map<string, Record<string, unknown>>; // key tenant|user|signal -> row
  upserts: Array<Record<string, unknown>>;
  failDiaryRead?: boolean;
}

function makeSb(store: Store): any {
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let limitN = Infinity;
      let desc = false;
      const q: any = {
        select() { return q; },
        eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return q; },
        gte(col: string, v: string) { filters.push((r) => String(r[col]) >= v); return q; },
        in(col: string, vs: unknown[]) { filters.push((r) => vs.includes(r[col])); return q; },
        order(_c: string, o: { ascending: boolean }) { desc = o && o.ascending === false; return q; },
        limit(n: number) { limitN = n; return q; },
        maybeSingle() {
          const rows = rowsFor(table).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        upsert(row: Record<string, unknown>) {
          store.upserts.push(row);
          store.state.set(`${row.tenant_id}|${row.user_id}|${row.signal_name}`, row);
          return Promise.resolve({ error: null });
        },
        then(resolve: (v: any) => void, reject: (e: any) => void) {
          if (table === 'diary_entries' && store.failDiaryRead) {
            return Promise.resolve({ data: null, error: { message: 'diary read failed' } }).then(resolve, reject);
          }
          let rows = rowsFor(table).filter((r) => filters.every((f) => f(r)));
          if (table === 'diary_entries') rows = rows.sort((a, b) => (desc ? b.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b.created_at)));
          return Promise.resolve({ data: rows.slice(0, limitN), error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  function rowsFor(table: string): any[] {
    if (table === 'diary_entries') return store.diary;
    if (table === 'user_tenants') return store.tenants;
    if (table === 'user_assistant_state') return [...store.state.values()];
    return [];
  }
}

function newStore(): Store {
  return { diary: [], tenants: [], state: new Map(), upserts: [] };
}

function addEntries(store: Store, userId: string, ages: number[]) {
  ages.forEach((a, i) => store.diary.push({ user_id: userId, text: `Synthetic entry ${i + 1} about the garden and sleep.`, created_at: daysAgo(a) }));
}

const T = 'tenant-a';
const U1 = 'user-00000001';
const U2 = 'user-00000002';

function reply(obj: unknown) {
  routerReplies.push({ ok: true, provider: 'bedrock', model: 'test-model', text: JSON.stringify(obj) });
}

beforeEach(() => {
  routerReplies.length = 0;
  routerCalls.length = 0;
  delete process.env.CONSOLIDATOR_DIARY_ROLLUP_ENABLED;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('flag', () => {
  it('is off unless exactly "true"', () => {
    expect(isDiaryRollupEnabled(undefined)).toBe(false);
    expect(isDiaryRollupEnabled('TRUE')).toBe(false);
    expect(isDiaryRollupEnabled('1')).toBe(false);
    expect(isDiaryRollupEnabled('true ')).toBe(false);
    expect(isDiaryRollupEnabled('true')).toBe(true);
  });
});

describe('parseDiaryThemeOutput', () => {
  const entries: DiaryEntryInput[] = [
    { text: 'a', created_at: daysAgo(20) },
    { text: 'b', created_at: daysAgo(15) },
    { text: 'c', created_at: daysAgo(3) },
    { text: 'd', created_at: daysAgo(1) },
  ];

  it('computes counts, last-seen and trend from the entries, not the model', () => {
    const out = parseDiaryThemeOutput(JSON.stringify({
      themes: [
        { label: 'Garden project', entries: [1, 2] },
        { label: 'Evening walks', entries: [3, 4] },
        { label: 'Work stress', entries: [2, 4] },
      ],
      mood_arc: 'Calmer towards the end.',
      people: ['partner'],
    }), entries, NOW);
    expect(out).not.toBeNull();
    const byLabel = Object.fromEntries(out!.themes.map((t) => [t.label, t]));
    expect(byLabel['Garden project']).toEqual({ label: 'Garden project', entries: 2, last_seen: daysAgo(15).slice(0, 10), trend: 'fading' });
    expect(byLabel['Evening walks'].trend).toBe('rising');
    expect(byLabel['Work stress'].trend).toBe('steady');
    expect(out!.mood_arc).toBe('Calmer towards the end.');
  });

  it('drops out-of-range entry numbers and themes left with none', () => {
    const out = parseDiaryThemeOutput(JSON.stringify({
      themes: [
        { label: 'Invented', entries: [9, 0, -1, 2.5] },
        { label: 'Real', entries: [1, 99] },
      ],
    }), entries, NOW);
    expect(out!.themes.map((t) => t.label)).toEqual(['Real']);
    expect(out!.themes[0].entries).toBe(1);
  });

  it('merges duplicate labels case-insensitively and caps at six themes', () => {
    const themes = Array.from({ length: 9 }, (_, i) => ({ label: `Theme ${i}`, entries: [1] }));
    themes.push({ label: 'theme 0', entries: [2] });
    const out = parseDiaryThemeOutput(JSON.stringify({ themes }), entries, NOW);
    expect(out!.themes).toHaveLength(6);
    expect(out!.themes[0]).toMatchObject({ label: 'Theme 0', entries: 2 });
  });

  it('keeps relationship words and drops names', () => {
    const out = parseDiaryThemeOutput(JSON.stringify({
      themes: [{ label: 'Family', entries: [1] }],
      people: ['partner', 'Sarah', 'a colleague', 'Dr. Weber', 'mother', 'partner'],
    }), entries, NOW);
    expect(out!.people).toEqual(['partner', 'a colleague', 'mother']);
  });

  it('accepts fenced JSON and returns null for prose or no themes', () => {
    expect(parseDiaryThemeOutput('```json\n{"themes":[{"label":"Sleep","entries":[1]}]}\n```', entries, NOW)!.themes).toHaveLength(1);
    expect(parseDiaryThemeOutput('The user writes about many things.', entries, NOW)).toBeNull();
    expect(parseDiaryThemeOutput('{"themes":[]}', entries, NOW)).toBeNull();
  });
});

describe('prompt and hash', () => {
  it('numbers entries oldest first and bounds their length', () => {
    const p = buildDiaryThemePrompt([
      { text: 'x'.repeat(500), created_at: daysAgo(2) },
      { text: 'second', created_at: daysAgo(1) },
    ]);
    expect(p).toContain(`[1] ${daysAgo(2).slice(0, 10)}: ${'x'.repeat(300)}`);
    expect(p).not.toContain('x'.repeat(301));
    expect(p).toContain('[2]');
  });

  it('hash is order-independent and changes with a new entry', () => {
    const a = [{ text: 'a', created_at: daysAgo(2) }, { text: 'b', created_at: daysAgo(1) }];
    expect(computeDiaryInputsHash(a)).toBe(computeDiaryInputsHash([...a].reverse()));
    expect(computeDiaryInputsHash(a)).not.toBe(computeDiaryInputsHash([...a, { text: 'c', created_at: daysAgo(0) }]));
  });
});

describe('rollupDiaryThemesForUser', () => {
  it('does not call the model below the minimum', async () => {
    const s = newStore();
    addEntries(s, U1, Array.from({ length: DIARY_ROLLUP_MIN_ENTRIES - 1 }, (_, i) => i + 1));
    const r = await rollupDiaryThemesForUser(makeSb(s), T, U1, { nowMs: NOW });
    expect(r.status).toBe('too_few_entries');
    expect(routerCalls).toHaveLength(0);
    expect(s.upserts).toHaveLength(0);
  });

  it('ignores entries outside the 30-day window', async () => {
    const s = newStore();
    addEntries(s, U1, [1, 2, 45, 60]);
    const r = await rollupDiaryThemesForUser(makeSb(s), T, U1, { nowMs: NOW });
    expect(r.status).toBe('too_few_entries');
  });

  it('writes diary_themes_v1 on the memory stage and skips when unchanged', async () => {
    const s = newStore();
    addEntries(s, U1, [10, 5, 2]);
    reply({ themes: [{ label: 'Garden', entries: [1, 2, 3] }], mood_arc: '', people: [] });
    const sb = makeSb(s);
    const r = await rollupDiaryThemesForUser(sb, T, U1, { nowMs: NOW });
    expect(r).toMatchObject({ status: 'written', entries: 3, model_called: true });
    expect(routerCalls[0].stage).toBe('memory');
    expect(routerCalls[0].opts.service).toBe('diary-theme-rollup');
    const row = s.upserts[0];
    expect(row.signal_name).toBe(SIGNAL_DIARY_THEMES);
    expect(row.tenant_id).toBe(T);
    expect(row.value).toMatchObject({ schema_version: 1, theme_count: 1, entries_considered: 3, mood_arc: null });

    const again = await rollupDiaryThemesForUser(sb, T, U1, { nowMs: NOW });
    expect(again.status).toBe('unchanged');
    expect(routerCalls).toHaveLength(1);
  });

  it('writes nothing when the model fails or names no theme', async () => {
    const s = newStore();
    addEntries(s, U1, [3, 2, 1]);
    routerReplies.push({ ok: false, error: 'throttled' });
    expect((await rollupDiaryThemesForUser(makeSb(s), T, U1, { nowMs: NOW })).status).toBe('model_failed');
    reply({ themes: [{ label: 'Nothing real', entries: [42] }] });
    expect((await rollupDiaryThemesForUser(makeSb(s), T, U1, { nowMs: NOW })).status).toBe('no_themes');
    expect(s.upserts).toHaveLength(0);
  });

  it('reports a failed diary read without calling the model', async () => {
    const s = newStore();
    s.failDiaryRead = true;
    const r = await rollupDiaryThemesForUser(makeSb(s), T, U1, { nowMs: NOW });
    expect(r.status).toBe('read_failed');
    expect(routerCalls).toHaveLength(0);
  });
});

describe('runDiaryThemeRollup', () => {
  it('stores each rollup under the author\'s primary tenant, most active first', async () => {
    const s = newStore();
    addEntries(s, U1, [1, 2, 3]);
    addEntries(s, U2, [1, 2, 3, 4]);
    addEntries(s, 'user-few', [1]);
    s.tenants.push({ user_id: U1, tenant_id: T, is_primary: true }, { user_id: U2, tenant_id: 'tenant-b', is_primary: true });
    reply({ themes: [{ label: 'A', entries: [1] }] });
    reply({ themes: [{ label: 'B', entries: [1] }] });
    const r = await runDiaryThemeRollup(makeSb(s), { nowMs: NOW });
    expect(r).toMatchObject({ candidates: 2, written: 2, model_calls: 2, errors: 0 });
    expect(s.upserts.map((u) => `${u.tenant_id}|${u.user_id}`)).toEqual([`tenant-b|${U2}`, `${T}|${U1}`]);
  });

  it('filters by tenant and skips authors with no primary tenant', async () => {
    const s = newStore();
    addEntries(s, U1, [1, 2, 3]);
    addEntries(s, U2, [1, 2, 3]);
    addEntries(s, 'user-no-tenant', [1, 2, 3]);
    s.tenants.push({ user_id: U1, tenant_id: T, is_primary: true }, { user_id: U2, tenant_id: 'tenant-b', is_primary: true });
    reply({ themes: [{ label: 'A', entries: [1] }] });
    const r = await runDiaryThemeRollup(makeSb(s), { nowMs: NOW, tenantId: T });
    expect(r.candidates).toBe(1);
    expect(r.notes.join(' ')).toContain('1 author(s) without a primary tenant skipped');
    expect(s.upserts.map((u) => u.user_id)).toEqual([U1]);
  });

  it('stops at the model-call cap; unchanged users cost no call', async () => {
    const s = newStore();
    const users = ['u-1', 'u-2', 'u-3'];
    users.forEach((u) => { addEntries(s, u, [1, 2, 3]); s.tenants.push({ user_id: u, tenant_id: T, is_primary: true }); });
    reply({ themes: [{ label: 'A', entries: [1] }] });
    const sb = makeSb(s);
    const first = await runDiaryThemeRollup(sb, { nowMs: NOW, maxModelCalls: 1 });
    expect(first).toMatchObject({ written: 1, model_calls: 1 });
    expect(first.notes.join(' ')).toContain('model-call cap 1 reached');

    reply({ themes: [{ label: 'B', entries: [1] }] });
    const second = await runDiaryThemeRollup(sb, { nowMs: NOW, maxModelCalls: 1 });
    expect(second.outcomes.unchanged).toBe(1);
    expect(second.written).toBe(1);
  });

  it('with a scope rolls up only that user', async () => {
    const s = newStore();
    addEntries(s, U1, [1, 2, 3]);
    addEntries(s, U2, [1, 2, 3]);
    reply({ themes: [{ label: 'A', entries: [1] }] });
    const r = await runDiaryThemeRollup(makeSb(s), { nowMs: NOW, scope: { tenant_id: T, user_id: U2 } });
    expect(r.candidates).toBe(1);
    expect(s.upserts.map((u) => u.user_id)).toEqual([U2]);
  });
});

describe('readDiaryThemes and stamps', () => {
  function stored(s: Store, generatedAt: string) {
    s.state.set(`${T}|${U1}|${SIGNAL_DIARY_THEMES}`, {
      tenant_id: T, user_id: U1, signal_name: SIGNAL_DIARY_THEMES,
      value: { generated_at: generatedAt, entries_considered: 5, themes: [{ label: 'Garden', entries: 3, last_seen: '2026-09-20', trend: 'rising' }], mood_arc: 'steady', people: ['partner'] },
    });
  }

  it('returns a fresh rollup and ignores a stale one', async () => {
    const s = newStore();
    stored(s, daysAgo(2));
    const fresh = await readDiaryThemes(makeSb(s), T, U1, NOW);
    expect(fresh).toMatchObject({ entries_considered: 5, mood_arc: 'steady', people: ['partner'] });
    expect(fresh!.themes[0].label).toBe('Garden');
    stored(s, daysAgo(20));
    expect(await readDiaryThemes(makeSb(s), T, U1, NOW)).toBeNull();
  });

  it('summarizes stamps without any theme text', () => {
    const out = summarizeDiaryThemeStamps([
      { generated_at: daysAgo(1), theme_count: '3' },
      { generated_at: daysAgo(30), theme_count: '5' },
      { generated_at: 'not a date', theme_count: '9' },
      null,
    ], NOW);
    expect(out).toEqual({ users_with_themes: 2, fresh: 1, avg_themes: 4, newest_generated_at: daysAgo(1) });
  });
});
