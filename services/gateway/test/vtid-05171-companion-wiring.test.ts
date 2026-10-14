/**
 * VTID-05171 — Life Timeline P5: companion wiring.
 *  - habit rollup: screen_habit / active_hours / feature_affinity / pillar_rhythm,
 *    learning switches (app_usage off, category off), hidden rows never count
 *  - "Vitana noticed": weakest-pillar streak, slipping, rising, ≤1/day dedupe key
 *  - profiler: tier/hidden/category filter in the query, fallback before the
 *    migration, "what moved the Index this week" from movements
 *  - get_my_timeline: hidden rows out, measured vs counted, sensitive values out,
 *    LAST_RESORT tier in the Vertex/Nova packer
 *  - /api/v1/timeline/learning-prefs + /usage-data
 */
import express from 'express';
import request from 'supertest';

// ── a recording, chainable fake Supabase client ─────────────────────────────
type Op = [string, unknown[]];
type Call = { table: string; ops: Op[] };
type Resolver = (c: Call) => { data?: unknown; error?: unknown; count?: number | null };

function fakeSb(resolve: Resolver) {
  const calls: Call[] = [];
  const sb: any = {
    calls,
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const b: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              const r = resolve(call);
              return (ok: any, ko: any) => Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null }).then(ok, ko);
            }
            return (...args: unknown[]) => {
              call.ops.push([prop, args]);
              return b;
            };
          },
        },
      );
      return b;
    },
  };
  return sb;
}
const op = (c: Call, name: string) => c.ops.find((o) => o[0] === name)?.[1];

// ── auth + supabase for the route tests ─────────────────────────────────────
let currentIdentity: any = { user_id: 'u1', tenant_id: 't1' };
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    if (currentIdentity) req.identity = currentIdentity;
    next();
  },
  resolveVitanaId: async () => null,
}));
let routeSb: any = null;
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => routeSb }));

const writeTimelineRow = jest.fn(async (_i: unknown) => undefined);
jest.mock('../src/services/timeline-projector', () => ({
  ...jest.requireActual('../src/services/timeline-projector'),
  writeTimelineRow: (i: unknown) => writeTimelineRow(i),
}));
jest.mock('../src/services/daily-pace-service', () => ({
  ...jest.requireActual('../src/services/daily-pace-service'),
  getUserTimezone: async () => 'UTC',
}));

import { computeHabitRoutines, computeNoticedInsight, runTimelineHabitRollup, type RollupRow } from '../src/services/timeline/habit-rollup';
import { ALL_ON, prefsFromRows } from '../src/services/timeline/learning-prefs';
import { fetchActivityLogRows } from '../src/services/user-context-profiler-repository';
import { summarizeIndexMovements } from '../src/services/user-context-profiler';
import { tool_get_my_timeline, TIMELINE_TOOL_DECLARATIONS } from '../src/services/orb-tools/timeline-tools';
import { ORB_TOOL_REGISTRY, NEW_DOMAIN_TOOL_DECLARATIONS } from '../src/services/orb-tools-shared';
import { enforceToolCatalogBudget, LAST_RESORT_TOOLS, VERTEX_BRIDGE_PRIORITY_TOOLS } from '../src/orb/live/tools/vertex-tool-catalog-budget';
import timelineRouter from '../src/routes/timeline';

const DAY = 86_400_000;
const NOW = new Date('2026-10-14T12:00:00Z');
const iso = (daysAgo: number, hour: number) => {
  const d = new Date(NOW.getTime() - daysAgo * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const row = (over: Partial<RollupRow>): RollupRow => ({
  activity_type: 'page.view', activity_data: { path: '/home' }, created_at: iso(0, 8), tier: 'silent', category: 'app_usage', pillar: null, hidden_from_ai: false, ...over,
});

function usageRows(): RollupRow[] {
  const rows: RollupRow[] = [];
  for (let d = 0; d < 6; d++) {
    rows.push(row({ activity_data: { path: '/health/vitana-index?tab=1' }, created_at: iso(d, 7) }));
    rows.push(row({ activity_data: { path: '/community' }, created_at: iso(d, 8) }));
    rows.push(row({ activity_type: 'community.post.liked', activity_data: {}, tier: 'moment', category: 'community', created_at: iso(d, 9) }));
    rows.push(row({ activity_type: 'health.log.water', activity_data: {}, tier: 'moment', category: 'hydration', pillar: 'hydration', created_at: iso(d, 8) }));
  }
  return rows;
}

describe('habit rollup — computeHabitRoutines', () => {
  it('derives the four routine kinds from 28 days of silent + visible rows', () => {
    const out = computeHabitRoutines(usageRows(), ALL_ON, 'UTC');
    const kinds = out.map((r) => `${r.routine_kind}:${r.routine_key}`);
    expect(kinds).toEqual(expect.arrayContaining([
      'screen_habit:/health/vitana-index',
      'screen_habit:/community',
      'active_hours:overall',
      'feature_affinity:community',
      'feature_affinity:hydration',
      'pillar_rhythm:hydration',
    ]));
    const rhythm = out.find((r) => r.routine_kind === 'pillar_rhythm')!;
    expect(rhythm.metadata).toMatchObject({ pillar: 'hydration', bucket: 'morning', typical_hour: 8, days: 6 });
    const hours = out.find((r) => r.routine_kind === 'active_hours')!;
    expect(hours.metadata).toMatchObject({ bucket: 'morning' });
    for (const r of out) expect(r.confidence).toBeLessThanOrEqual(0.95);
  });

  it('app_usage off → no screen_habit / active_hours / feature_affinity; pillar rhythm stays', () => {
    const out = computeHabitRoutines(usageRows(), prefsFromRows([{ category: 'app_usage', learn: false }]), 'UTC');
    expect(out.map((r) => r.routine_kind)).toEqual(['pillar_rhythm']);
  });

  it('a category switched off and rows hidden from Vitana never count', () => {
    const offHydration = computeHabitRoutines(usageRows(), prefsFromRows([{ category: 'hydration', learn: false }]), 'UTC');
    expect(offHydration.some((r) => r.routine_key === 'hydration')).toBe(false);
    const hidden = usageRows().map((r) => (r.pillar === 'hydration' ? { ...r, hidden_from_ai: true } : r));
    expect(computeHabitRoutines(hidden, ALL_ON, 'UTC').some((r) => r.routine_kind === 'pillar_rhythm')).toBe(false);
  });

  it('claims no habit from too little evidence', () => {
    expect(computeHabitRoutines(usageRows().slice(0, 6), ALL_ON, 'UTC')).toEqual([]);
  });
});

function score(date: string, p: Partial<Record<string, number>>, bf = 0.9) {
  return { date, score_total: 300, score_nutrition: 60, score_hydration: 60, score_exercise: 60, score_sleep: 60, score_mental: 60, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [`score_${k}`, v])), feature_inputs: { balance_factor: bf } } as any;
}

describe('"Vitana noticed" — computeNoticedInsight', () => {
  const days = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];
  it('the same weakest pillar for ≥5 days while balance costs points', () => {
    expect(computeNoticedInsight(days.map((d) => score(d, { hydration: 30 })))).toEqual({ insight_kind: 'weakest_pillar_streak', pillar: 'hydration' });
  });
  it('no streak insight when balance costs nothing; then slipping beats rising', () => {
    const s = days.map((d, i) => score(d, { hydration: 30, sleep: 70 - i * 3, exercise: 50 + i * 3 }, 1));
    expect(computeNoticedInsight(s)).toEqual({ insight_kind: 'pillar_slipping', pillar: 'sleep' });
    const r = days.map((d, i) => score(d, { hydration: 30, exercise: 50 + i * 3 }, 1));
    expect(computeNoticedInsight(r)).toEqual({ insight_kind: 'pillar_rising', pillar: 'exercise' });
  });
  it('nothing from fewer than 3 days, and never about a pillar switched off', () => {
    expect(computeNoticedInsight(days.slice(0, 2).map((d) => score(d, { hydration: 30 })))).toBeNull();
    expect(computeNoticedInsight(days.map((d) => score(d, { hydration: 30 })), prefsFromRows([{ category: 'hydration', learn: false }]))).toBeNull();
  });
});

describe('habit rollup — runner', () => {
  beforeEach(() => writeTimelineRow.mockClear());

  it('upserts routines, deletes stale rollup rows only, writes one insight with a per-day dedupe key', async () => {
    const sb = fakeSb((c) => {
      if (c.table === 'timeline_learning_prefs') return { data: [] };
      if (c.table === 'vitana_index_scores') return { data: ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'].map((d) => score(d, { sleep: 20 })) };
      if (c.table === 'user_activity_log') {
        if (op(c, 'select')?.[0] === 'user_id') return { data: [{ user_id: 'u1' }, { user_id: 'u1' }] };
        if (op(c, 'eq')?.[0] === 'user_id' && c.ops.some((o) => o[0] === 'eq' && o[1][0] === 'activity_type')) return { data: [] };
        return { data: usageRows() };
      }
      if (c.table === 'user_routines') {
        if (op(c, 'select')) return { data: [{ id: 'old', routine_kind: 'screen_habit', routine_key: '/gone' }, { id: 'keep', routine_kind: 'active_hours', routine_key: 'overall' }] };
        return { data: null, count: 1 };
      }
      return { data: [] };
    });
    const r = await runTimelineHabitRollup(sb, { now: NOW });
    expect(r).toMatchObject({ users_scanned: 1, insights_written: 1, routines_deleted: 1, errors: 0 });
    const upsert = sb.calls.find((c: Call) => c.table === 'user_routines' && op(c, 'upsert'))!;
    expect((op(upsert, 'upsert')![1] as any).onConflict).toBe('user_id,routine_kind,routine_key');
    const del = sb.calls.find((c: Call) => c.table === 'user_routines' && op(c, 'delete'))!;
    expect(c_in(del)).toEqual(['id', ['old']]);
    expect(writeTimelineRow).toHaveBeenCalledWith(expect.objectContaining({
      activity_type: 'index.insight.noticed',
      activity_data: { insight_kind: 'weakest_pillar_streak', pillar: 'sleep' },
      dedupe_key: 'vitana-noticed:u1:2026-10-14',
    }));
  });

  it('does not repeat the same insight within a week', async () => {
    const sb = fakeSb((c) => {
      if (c.table === 'vitana_index_scores') return { data: ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'].map((d) => score(d, { sleep: 20 })) };
      if (c.table === 'user_activity_log') {
        if (op(c, 'select')?.[0] === 'user_id') return { data: [{ user_id: 'u1' }] };
        if (c.ops.some((o) => o[0] === 'eq' && o[1][0] === 'activity_type')) return { data: [{ activity_data: { insight_kind: 'weakest_pillar_streak', pillar: 'sleep' } }] };
        return { data: [] };
      }
      return { data: [] };
    });
    const r = await runTimelineHabitRollup(sb, { now: NOW });
    expect(r.insights_written).toBe(0);
    expect(writeTimelineRow).not.toHaveBeenCalled();
  });
});
function c_in(c: Call) {
  return op(c, 'in');
}

describe('profiler — what reaches the brain', () => {
  it('filters tier, hidden_from_ai and switched-off categories in the query', async () => {
    const sb = fakeSb(() => ({ data: [] }));
    await fetchActivityLogRows(sb, 'u1', '2026-10-01T00:00:00Z', ['community', 'bad;drop']);
    const c = sb.calls[0];
    expect(op(c, 'in')).toEqual(['tier', ['spotlight', 'moment', 'digest']]);
    expect(c.ops).toContainEqual(['eq', ['hidden_from_ai', false]]);
    expect(op(c, 'not')).toEqual(['category', 'in', '(community)']);
    expect(op(c, 'limit')).toEqual([400]);
  });

  it('falls back to the unfiltered query before the VTID-05167 columns exist', async () => {
    let n = 0;
    const sb = fakeSb(() => (n++ === 0 ? { error: { code: '42703', message: 'column user_activity_log.tier does not exist' } } : { data: [{ activity_type: 'diary.entry.created' }] }));
    const res: any = await fetchActivityLogRows(sb, 'u1', '2026-10-01T00:00:00Z');
    expect(res.data).toHaveLength(1);
    expect(sb.calls[1].ops.some((o: Op) => o[0] === 'in')).toBe(false);
  });

  it('summarizes the week’s movements: per pillar, per trigger, the latest real change', () => {
    const s = summarizeIndexMovements([
      { at: '2026-10-14T09:00:00Z', trigger: 'voice_log', delta_total: 6, delta_pillars: { hydration: 6, sleep: 0 } },
      { at: '2026-10-13T03:00:00Z', trigger: 'daily', delta_total: 0, delta_pillars: {} },
      { at: '2026-10-12T21:00:00Z', trigger: 'wearable_sync', delta_total: 4, delta_pillars: { sleep: 5, exercise: -1 } },
    ]);
    expect(s.last_movement).toEqual({ pillar: 'hydration', delta: 6, reason: 'voice_log' });
    expect(s.week_movers).toEqual({ by_pillar: { hydration: 6, sleep: 5, exercise: -1 }, by_trigger: { voice_log: 1, wearable_sync: 1 }, movements: 2 });
    expect(summarizeIndexMovements([])).toEqual({});
  });
});

describe('get_my_timeline', () => {
  const visible = [
    { id: 'a', activity_type: 'health.log.water', activity_data: { movement_id: 'm1', amount_ml: 500 }, created_at: '2026-10-14T09:00:00Z', tier: 'moment', pillar: 'hydration', category: 'hydration', topic: 'water_logged', hidden_from_ai: false },
    { id: 'b', activity_type: 'community.group.join', activity_data: {}, created_at: '2026-10-14T08:00:00Z', tier: 'moment', pillar: null, secondary_pillar: 'mental', category: 'community', topic: 'group_joined', hidden_from_ai: false },
    { id: 'c', activity_type: 'health.log.mood', activity_data: { mood: 'low' }, created_at: '2026-10-14T07:00:00Z', tier: 'moment', pillar: 'mental', category: 'mental', topic: 'mood_logged', hidden_from_ai: true },
  ];
  const movement = { id: 'm1', at: '2026-10-14T09:00:01Z', score_date: '2026-10-14', trigger: 'voice_log', delta_total: 6, delta_pillars: { hydration: 6 }, before: {}, after: { score_total: 306 } };

  function sbFor() {
    return fakeSb((c) => (c.table === 'vitana_index_movements' ? { data: [movement] } : { data: visible }));
  }

  it('is a registered community domain tool with a declaration', () => {
    expect(typeof ORB_TOOL_REGISTRY.get_my_timeline).toBe('function');
    expect(NEW_DOMAIN_TOOL_DECLARATIONS.map((d) => d.name)).toContain('get_my_timeline');
    expect(TIMELINE_TOOL_DECLARATIONS).toHaveLength(1);
  });

  it('returns structured facts: hidden rows out, measured only from a movement, counted otherwise', async () => {
    const r: any = await tool_get_my_timeline({ range: 'week' }, { user_id: 'u1' } as any, sbFor());
    expect(r.ok).toBe(true);
    expect(r.result.moments.map((m: any) => m.topic)).toEqual(['water_logged', 'group_joined']);
    expect(r.result.moments[0].influence).toEqual({ kind: 'measured', delta_total: 6, delta_pillars: { hydration: 6 } });
    expect(r.result.moments[1].influence).toEqual({ kind: 'counted', pillar: 'mental' });
    expect(r.result.index_days[0]).toMatchObject({ date: '2026-10-14', delta_total: 6, score_after: 306 });
    expect(r.text).toContain('entries=2');
    expect(r.text).not.toMatch(/\b(you|your)\b/i); // data for the model, not a sentence (rule 41)
  });

  it('special-category moments carry their topic only; bad arguments are refused', async () => {
    const sb = fakeSb((c) => (c.table === 'vitana_index_movements' ? { data: [] } : { data: [{ ...visible[2], hidden_from_ai: false, activity_data: { via: 'voice' } }] }));
    const r: any = await tool_get_my_timeline({}, { user_id: 'u1' } as any, sb);
    expect(r.result.moments).toHaveLength(1);
    expect(r.result.moments[0]).toMatchObject({ topic: 'mood_logged', details: {} }); // 'via' is dropped for special-category
    expect(await tool_get_my_timeline({ pillar: 'wealth' }, { user_id: 'u1' } as any, sbFor())).toMatchObject({ ok: false });
    expect(await tool_get_my_timeline({ category: 'system' }, { user_id: 'u1' } as any, sbFor())).toMatchObject({ ok: false });
  });

  it('is packed last: never displaces a priority or ordinary tool, first to go when tight', () => {
    expect(LAST_RESORT_TOOLS).toContain('get_my_timeline');
    const decl = (name: string, pad = 200) => ({ name, description: 'x'.repeat(pad) });
    const priority = VERTEX_BRIDGE_PRIORITY_TOOLS.slice(0, 2);
    const tools = [{ function_declarations: [TIMELINE_TOOL_DECLARATIONS[0], decl(priority[0]), decl('ordinary_tool'), decl(priority[1])] }];
    const full = enforceToolCatalogBudget(tools, 10_000_000);
    expect(full.trimmed).toBe(false);
    const bytesWithout = Buffer.byteLength(JSON.stringify([{ function_declarations: [decl(priority[0]), decl('ordinary_tool'), decl(priority[1])] }]));
    const tight = enforceToolCatalogBudget(tools, bytesWithout + 5);
    expect(tight.dropped).toEqual(['get_my_timeline']);
    const kept = (tight.tools[0] as any).function_declarations.map((d: any) => d.name);
    expect(kept).toEqual([priority[0], 'ordinary_tool', priority[1]]);
  });
});

describe('/api/v1/timeline learning-prefs + usage-data', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/timeline', timelineRouter);
  beforeEach(() => {
    currentIdentity = { user_id: 'u1', tenant_id: 't1' };
  });

  it.each([
    ['get', '/api/v1/timeline/learning-prefs'],
    ['put', '/api/v1/timeline/learning-prefs'],
    ['get', '/api/v1/timeline/usage-data'],
    ['get', '/api/v1/timeline/usage-data/export'],
    ['delete', '/api/v1/timeline/usage-data'],
    ['get', '/api/v1/timeline/routines'],
    ['delete', '/api/v1/timeline/routines/0b5f3a52-1d6c-4c3e-9a0e-1d2b3c4d5e6f'],
  ])('%s %s → 401 without identity', async (method, url) => {
    currentIdentity = null;
    routeSb = fakeSb(() => ({ data: [] }));
    const res = await (request(app) as any)[method](url).send({});
    expect(res.status).toBe(401);
  });

  it('GET lists every category, missing row = on', async () => {
    routeSb = fakeSb(() => ({ data: [{ category: 'community', learn: false }] }));
    const res = await request(app).get('/api/v1/timeline/learning-prefs');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.prefs).toContainEqual({ category: 'community', learn: false });
    expect(res.body.prefs).toContainEqual({ category: 'app_usage', learn: true });
    expect(res.body.prefs.some((p: any) => p.category === 'system')).toBe(false);
  });

  it('PUT validates, upserts for the JWT user only, and app_usage off deletes the app-usage routines', async () => {
    routeSb = fakeSb((c) => (c.table === 'user_routines' ? { count: 3 } : { data: null }));
    expect((await request(app).put('/api/v1/timeline/learning-prefs').send({ category: 'system', learn: false })).status).toBe(400);
    expect((await request(app).put('/api/v1/timeline/learning-prefs').send({ category: 'diary', learn: 'no' })).status).toBe(400);
    const res = await request(app).put('/api/v1/timeline/learning-prefs').send({ category: 'app_usage', learn: false, user_id: 'someone-else' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, category: 'app_usage', learn: false, routines_deleted: 3 });
    const up = routeSb.calls.find((c: Call) => c.table === 'timeline_learning_prefs');
    expect(op(up, 'upsert')![0]).toMatchObject({ user_id: 'u1', category: 'app_usage', learn: false });
    const del = routeSb.calls.find((c: Call) => c.table === 'user_routines');
    expect(del.ops).toContainEqual(['eq', ['user_id', 'u1']]);
    expect(op(del, 'in')).toEqual(['routine_kind', ['screen_habit', 'active_hours', 'feature_affinity']]);
  });

  it('PUT answers 409 before the migration', async () => {
    routeSb = fakeSb(() => ({ error: { code: '42P01', message: 'relation "timeline_learning_prefs" does not exist' } }));
    const res = await request(app).put('/api/v1/timeline/learning-prefs').send({ category: 'diary', learn: false });
    expect(res.status).toBe(409);
  });

  it('usage-data: count, export and delete only the member’s silent/system rows (archive too)', async () => {
    routeSb = fakeSb(() => ({ data: [{ activity_type: 'page.view' }], count: 42 }));
    const count = await request(app).get('/api/v1/timeline/usage-data');
    expect(count.body).toMatchObject({ ok: true, available: true, count: 42 });
    const exp = await request(app).get('/api/v1/timeline/usage-data/export');
    expect(exp.status).toBe(200);
    expect(exp.headers['content-disposition']).toContain('attachment');
    expect(exp.body.rows).toHaveLength(1);
    const del = await request(app).delete('/api/v1/timeline/usage-data');
    expect(del.body).toMatchObject({ ok: true, deleted: 84, routines_deleted: 42 });
    const tables = routeSb.calls.filter((c: Call) => op(c, 'delete')).map((c: Call) => c.table);
    expect(tables).toEqual(['user_activity_log', 'user_activity_log_archive', 'user_routines']);
    for (const c of routeSb.calls as Call[]) expect(c.ops).toContainEqual(['eq', ['user_id', 'u1']]);
    const logDel = routeSb.calls.find((c: Call) => c.table === 'user_activity_log' && op(c, 'delete'));
    expect(op(logDel, 'in')).toEqual(['tier', ['silent', 'system']]);
  });

  it('routines: the member’s own, confidence ≥ 0.5, no English strings; forget one by id (404 when not theirs)', async () => {
    routeSb = fakeSb(() => ({ data: [{ id: 'r1', routine_kind: 'pillar_rhythm', routine_key: 'sleep', metadata: { bucket: 'night' }, confidence: 0.8 }] }));
    const res = await request(app).get('/api/v1/timeline/routines');
    expect(res.status).toBe(200);
    expect(res.body.routines[0]).toMatchObject({ routine_kind: 'pillar_rhythm', routine_key: 'sleep' });
    const sel = routeSb.calls[0];
    expect(op(sel, 'select')![0]).not.toMatch(/title|summary/);
    expect(sel.ops).toContainEqual(['eq', ['user_id', 'u1']]);
    expect(sel.ops).toContainEqual(['gte', ['confidence', 0.5]]);

    expect((await request(app).delete('/api/v1/timeline/routines/not-a-uuid')).status).toBe(400);
    routeSb = fakeSb(() => ({ count: 0 }));
    expect((await request(app).delete('/api/v1/timeline/routines/0b5f3a52-1d6c-4c3e-9a0e-1d2b3c4d5e6f')).status).toBe(404);
    routeSb = fakeSb(() => ({ count: 1 }));
    const ok = await request(app).delete('/api/v1/timeline/routines/0b5f3a52-1d6c-4c3e-9a0e-1d2b3c4d5e6f');
    expect(ok.status).toBe(200);
    expect(routeSb.calls[0].ops).toContainEqual(['eq', ['user_id', 'u1']]);
  });
});
