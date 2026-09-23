/**
 * VTID-04392 — golden recall eval.
 *
 * Runs the real memory broker (and the real Memory Garden reader) against an
 * in-memory store seeded from test/fixtures/memory-golden/scenarios.json, and
 * checks each scenario's "must contain / must not contain". No LLM, no
 * network, no database — so it runs on every PR and a recall regression
 * (a superseded fact coming back, one user's memory reaching another, a
 * work-role note leaking into personal recall, the diary not loading) fails
 * the build instead of reaching users.
 *
 * Semantic search is simulated deterministically: rows are ranked by word
 * overlap with the query, then by recency. The eval measures what the broker
 * and its filters let through, not embedding quality.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// In-memory store with the PostgREST subset the memory code uses.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
let lastEmbeddedText = '';

function col(row: Row, key: string): any {
  const m = /^(\w+)->>(\w+)$/.exec(key);
  if (m) return row[m[1]]?.[m[2]] == null ? null : String(row[m[1]][m[2]]);
  return row[key];
}

function parseOr(expr: string): (r: Row) => boolean {
  const parts = expr.split(',').map((p) => {
    const [field, op, ...rest] = p.split('.');
    const value = rest.join('.');
    return (r: Row) => {
      const v = col(r, field);
      if (op === 'is' && value === 'null') return v == null;
      if (op === 'eq') return String(v) === value;
      throw new Error(`unsupported or-op ${op}`);
    };
  });
  return (r) => parts.some((f) => f(r));
}

function words(s: string): Set<string> {
  return new Set((s || '').toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length > 2));
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private orders: Array<{ key: string; asc: boolean }> = [];
  private lim = Infinity;
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: any;
  private singleMode: 'single' | 'maybe' | null = null;
  constructor(private table: string) {}
  select() { return this; }
  eq(k: string, v: any) { this.filters.push((r) => String(col(r, k)) === String(v)); return this; }
  neq(k: string, v: any) { this.filters.push((r) => String(col(r, k)) !== String(v)); return this; }
  is(k: string, v: any) { this.filters.push((r) => (v === null ? col(r, k) == null : col(r, k) === v)); return this; }
  in(k: string, vs: any[]) { this.filters.push((r) => vs.map(String).includes(String(col(r, k)))); return this; }
  gte(k: string, v: any) { this.filters.push((r) => col(r, k) != null && String(col(r, k)) >= String(v)); return this; }
  lte(k: string, v: any) { this.filters.push((r) => col(r, k) != null && String(col(r, k)) <= String(v)); return this; }
  or(expr: string) { this.filters.push(parseOr(expr)); return this; }
  order(key: string, opts: { ascending?: boolean } = {}) { this.orders.push({ key, asc: opts.ascending !== false }); return this; }
  limit(n: number) { this.lim = n; return this; }
  abortSignal() { return this; }
  insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
  update(p: any) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  single() { this.singleMode = 'single'; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }
  private run(): { data: any; error: any } {
    const rows = (db[this.table] = db[this.table] || []);
    if (this.op === 'insert') {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p: Row) => ({ id: `gen-${rows.length + 1}`, ...p }));
      rows.push(...list);
      return { data: this.singleMode ? list[0] : list, error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'update') { hit.forEach((r) => Object.assign(r, this.payload)); return { data: hit, error: null }; }
    if (this.op === 'delete') { db[this.table] = rows.filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
    const sorted = [...hit].sort((a, b) => {
      for (const o of this.orders) {
        const av = col(a, o.key), bv = col(b, o.key);
        if (av === bv) continue;
        const c = av == null ? 1 : bv == null ? -1 : av < bv ? -1 : 1;
        return o.asc ? c : -c;
      }
      return 0;
    }).slice(0, this.lim);
    if (this.singleMode) return { data: sorted[0] ?? null, error: null };
    return { data: sorted, error: null };
  }
  then(res: any, rej?: any) { return Promise.resolve(this.run()).then(res, rej); }
}

const fakeClient: any = {
  from: (t: string) => new Query(t),
  rpc: async (fn: string, a: any) => {
    if (fn !== 'memory_semantic_search') return { data: [], error: null };
    const q = words(lastEmbeddedText);
    const rows = (db.memory_items || []).filter((r) =>
      r.tenant_id === a.p_tenant_id && r.user_id === a.p_user_id &&
      (a.p_active_role == null || r.active_role == null || r.active_role === a.p_active_role));
    const scored = rows.map((r) => ({ r, s: [...words(r.content)].filter((w) => q.has(w)).length }));
    scored.sort((x, y) => y.s - x.s || (x.r.occurred_at < y.r.occurred_at ? 1 : -1));
    return { data: scored.slice(0, a.p_top_k ?? 10).map(({ r, s }) => ({ ...r, similarity_score: s })), error: null };
  },
};

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => fakeClient }));
jest.mock('../src/services/memory-embedding', () => ({
  embedMemoryText: async (text: string) => { lastEmbeddedText = text; return { ok: true, embedding: [0.1], model: 'test' }; },
  toPgVector: (e: number[]) => `[${e.join(',')}]`,
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue(undefined) }));

import { getMemoryContext } from '../src/services/memory-broker';
import { listGardenEntries, deleteGardenEntry, _resetGardenCache } from '../src/services/memory/garden';

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const USERS: Record<string, string> = { me: '00000000-0000-4000-8000-000000000001', other: '00000000-0000-4000-8000-000000000002' };
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/memory-golden/scenarios.json'), 'utf8'));

function seed(store: Record<string, Row[]>) {
  for (const k of Object.keys(db)) delete db[k];
  db.memory_category_mapping = [{ source_category: 'notes', garden_category: 'uncategorized' }, { source_category: 'session_summary', garden_category: 'uncategorized' }];
  let n = 0;
  for (const [table, rows] of Object.entries(store)) {
    db[table] = rows.map((r) => {
      const { user = 'me', ...rest } = r;
      const row: Row = { id: rest.id ?? `${table}-${++n}`, user_id: USERS[user], ...rest };
      if (table !== 'diary_entries') row.tenant_id = TENANT;
      if (table === 'memory_facts') row.entity = row.entity ?? 'self';
      if (table === 'memory_items') { row.content_json = row.content_json ?? {}; row.active_role = row.active_role ?? null; }
      if (table === 'memory_facts') row.superseded_at = row.superseded_at ?? null;
      return row;
    });
  }
}

async function recallText(sc: any): Promise<string> {
  const parts: string[] = [];
  const me = { tenant_id: TENANT, user_id: USERS.me, active_role: sc.recall.role ?? 'community' };
  if (sc.recall.blocks.length) {
    const pack = await getMemoryContext({
      tenant_id: TENANT,
      user_id: USERS.me,
      intent: 'recall_history',
      channel: 'conversation',
      role: sc.recall.role ?? 'community',
      latency_budget_ms: 5000,
      required_blocks: sc.recall.blocks,
      query: sc.recall.query,
    } as any);
    parts.push(JSON.stringify(pack.blocks));
  }
  if (sc.recall.garden) {
    _resetGardenCache();
    parts.push(JSON.stringify(await listGardenEntries(fakeClient, me)));
  }
  return parts.join('\n');
}

describe('VTID-04392 golden recall eval', () => {
  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
    jest.setSystemTime(new Date(FIXTURE.now));
  });
  afterAll(() => jest.useRealTimers());

  const results: Array<{ name: string; pass: boolean }> = [];

  for (const sc of FIXTURE.scenarios) {
    it(sc.name, async () => {
      seed(sc.store);
      for (const step of sc.before || []) {
        if (step.op === 'garden_forget_fact') {
          const r = await deleteGardenEntry(fakeClient, { tenant_id: TENANT, user_id: USERS.me }, 'fact', step.id);
          expect(r.ok).toBe(true);
        }
      }
      const text = await recallText(sc);
      const missing = (sc.expect.contains || []).filter((s: string) => !text.includes(s));
      const leaked = (sc.expect.not_contains || []).filter((s: string) => text.includes(s));
      results.push({ name: sc.name, pass: missing.length === 0 && leaked.length === 0 });
      expect({ missing, leaked }).toEqual({ missing: [], leaked: [] });
    });
  }

  it('reports the recall score', () => {
    const passed = results.filter((r) => r.pass).length;
    // Printed so the CI log carries the number; every golden scenario must pass.
    console.log(`[memory-golden-eval] ${passed}/${results.length} scenarios pass`);
    expect(passed).toBe(FIXTURE.scenarios.length);
  });
});
