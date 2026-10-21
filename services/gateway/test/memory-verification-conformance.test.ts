/**
 * VTID-04600 — memory verification suite, layer A (conformance).
 *
 * Runs the REAL memory code — the remember_fact tool, the gateway backstop
 * that runs it when the voice model does not, the background fact extractor's
 * write guards, the Identity Lock, the forgotten-facts gate, the Memory
 * Garden, the voice forget tool and the recall broker — against one in-memory
 * database, driven by scenarios in fixtures/memory-verification/conformance.json.
 *
 * Only two things are faked: the database (served to both supabase-js and the
 * raw PostgREST fetches the write path uses, with write_fact emulated to match
 * migration 20260924150000) and the facts the LLM extracts from an utterance
 * (given per step, because extraction quality is layer B's job — see
 * docs/memory/MEMORY-VERIFICATION-SUITE.md).
 *
 * A scenario with "gap" set documents behaviour that is wrong today. It runs
 * as it.failing: CI stays green while the gap is open, and turns red the day
 * the gap is fixed so the marker has to be removed — a known gap cannot hide.
 */

import * as fs from 'fs';
import * as path from 'path';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
let idSeq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;
const nowIso = () => new Date(Date.now()).toISOString();

// ---------------------------------------------------------------------------
// supabase-js subset
// ---------------------------------------------------------------------------

function col(row: Row, key: string): any {
  const m = /^(\w+)->>(\w+)$/.exec(key);
  if (m) return row[m[1]]?.[m[2]] == null ? null : String(row[m[1]][m[2]]);
  return row[key];
}

function words(s: string): Set<string> {
  return new Set((s || '').toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length > 2));
}

function parseOr(expr: string): (r: Row) => boolean {
  const parts = expr.split(',').map((p) => {
    const [field, op, ...rest] = p.split('.');
    const value = rest.join('.');
    return (r: Row) => {
      const v = col(r, field);
      if (op === 'is' && value === 'null') return v == null;
      if (op === 'eq') return String(v) === value;
      if (op === 'ilike') return String(v ?? '').toLowerCase().includes(value.replace(/%/g, '').toLowerCase());
      throw new Error(`unsupported or-op ${op}`);
    };
  });
  return (r) => parts.some((f) => f(r));
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private orders: Array<{ key: string; asc: boolean }> = [];
  private lim = Infinity;
  private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private payload: any;
  private singleMode: 'single' | 'maybe' | null = null;
  constructor(private table: string) {}
  select() { return this; }
  eq(k: string, v: any) { this.filters.push((r) => String(col(r, k)) === String(v)); return this; }
  neq(k: string, v: any) { this.filters.push((r) => String(col(r, k)) !== String(v)); return this; }
  is(k: string, v: any) { this.filters.push((r) => (v === null ? col(r, k) == null : col(r, k) === v)); return this; }
  not(k: string, op: string, v: any) { this.filters.push((r) => (op === 'is' && v === null ? col(r, k) != null : String(col(r, k)) !== String(v))); return this; }
  in(k: string, vs: any[]) { this.filters.push((r) => vs.map(String).includes(String(col(r, k)))); return this; }
  gte(k: string, v: any) { this.filters.push((r) => col(r, k) != null && String(col(r, k)) >= String(v)); return this; }
  gt(k: string, v: any) { this.filters.push((r) => col(r, k) != null && String(col(r, k)) > String(v)); return this; }
  lte(k: string, v: any) { this.filters.push((r) => col(r, k) != null && String(col(r, k)) <= String(v)); return this; }
  lt(k: string, v: any) { this.filters.push((r) => col(r, k) != null && String(col(r, k)) < String(v)); return this; }
  ilike(k: string, v: string) { const n = v.replace(/%/g, '').toLowerCase(); this.filters.push((r) => String(col(r, k) ?? '').toLowerCase().includes(n)); return this; }
  or(expr: string) { this.filters.push(parseOr(expr)); return this; }
  order(key: string, opts: { ascending?: boolean } = {}) { this.orders.push({ key, asc: opts.ascending !== false }); return this; }
  limit(n: number) { this.lim = n; return this; }
  range(a: number, b: number) { this.lim = b - a + 1; return this; }
  abortSignal() { return this; }
  insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
  upsert(p: any) { this.op = 'upsert'; this.payload = p; return this; }
  update(p: any) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  single() { this.singleMode = 'single'; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }
  private run(): { data: any; error: any } {
    const rows = (db[this.table] = db[this.table] || []);
    if (this.op === 'insert' || this.op === 'upsert') {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p: Row) => ({ id: newId(), created_at: nowIso(), ...p }));
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

let lastEmbeddedText = '';
let failWrites = false;

/** write_fact as in migration 20260924150000 (VTID-04494 / VTID-04341). */
function rank(src: string): number {
  if (src && src.startsWith('user_')) return 3;
  if (src === 'system_observed') return 2;
  if (src === 'assistant_inferred') return 1;
  return 0;
}
function writeFactRpc(a: Row): string {
  const rows = (db.memory_facts = db.memory_facts || []);
  const entity = a.p_entity ?? 'self';
  const current = rows
    .filter((r) => r.tenant_id === a.p_tenant_id && r.user_id === a.p_user_id && r.fact_key === a.p_fact_key && (r.entity ?? 'self') === entity && r.superseded_by == null)
    .sort((x, y) => (x.extracted_at < y.extracted_at ? 1 : -1));
  const old = current[0];
  const src = a.p_provenance_source ?? 'user_stated';
  if (old && String(old.fact_value).trim().toLowerCase() === String(a.p_fact_value).trim().toLowerCase() && rank(src) <= rank(old.provenance_source)) {
    return old.id;
  }
  const id = newId();
  rows.push({
    id, tenant_id: a.p_tenant_id, user_id: a.p_user_id, thread_id: a.p_thread_id ?? null, entity,
    fact_key: a.p_fact_key, fact_value: a.p_fact_value, fact_value_type: a.p_fact_value_type ?? 'text',
    provenance_source: src, provenance_confidence: a.p_provenance_confidence ?? 0.9,
    extracted_at: nowIso(), superseded_by: null, superseded_at: null,
  });
  for (const r of current) { r.superseded_by = id; r.superseded_at = nowIso(); }
  return id;
}

const fakeClient: any = {
  from: (t: string) => new Query(t),
  rpc: async (fn: string, a: any) => {
    if (fn === 'write_fact') return failWrites ? { data: null, error: { message: 'service unavailable' } } : { data: writeFactRpc(a), error: null };
    if (fn === 'memory_semantic_search') {
      const q = words(lastEmbeddedText);
      // Role filter exactly as the live function (read 2026-09-26):
      // AND (p_active_role IS NULL OR mi.active_role = p_active_role OR mi.active_role IS NULL)
      const rows = (db.memory_items || []).filter((r) => r.tenant_id === a.p_tenant_id && r.user_id === a.p_user_id
        && (a.p_active_role == null || r.active_role === a.p_active_role || r.active_role == null));
      const scored = rows.map((r) => ({ r, s: Array.from(words(r.content)).filter((w) => q.has(w)).length }));
      scored.sort((x, y) => y.s - x.s);
      return { data: scored.slice(0, a.p_top_k ?? 10).map(({ r, s }) => ({ ...r, similarity_score: s })), error: null };
    }
    return { data: [], error: null };
  },
};

// ---------------------------------------------------------------------------
// PostgREST over fetch — the write path (rememberFact, extractor, forgotten).
// ---------------------------------------------------------------------------

const SUPA = 'http://memory-verification.local';
process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

function restFilters(params: URLSearchParams): Array<(r: Row) => boolean> {
  const out: Array<(r: Row) => boolean> = [];
  params.forEach((v, k) => {
    if (['select', 'limit', 'order', 'on_conflict'].includes(k)) return;
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    if (op === 'eq') out.push((r) => String(r[k]) === val);
    else if (op === 'is' && val === 'null') out.push((r) => r[k] == null);
    else if (op === 'neq') out.push((r) => String(r[k]) !== val);
  });
  return out;
}

const fetchMock = jest.fn(async (input: any, init: any = {}) => {
  const u = new URL(String(input));
  const ok = (body: any, status = 200) => ({ ok: true, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (!u.pathname.startsWith('/rest/v1/')) return ok({});
  const parts = u.pathname.replace(/^\/rest\/v1\//, '').split('/');
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (parts[0] === 'rpc') {
    if (parts[1] === 'write_fact') {
      if (failWrites) return { ok: false, status: 503, json: async () => ({}), text: async () => 'service unavailable' };
      return ok(writeFactRpc(body));
    }
    if (parts[1] === 'check_canonical_fact_key') return ok({ ok: true, mapped: false });
    return ok(null);
  }
  const table = parts[0];
  const rows = (db[table] = db[table] || []);
  const filters = restFilters(u.searchParams);
  if (method === 'GET') {
    const lim = Number(u.searchParams.get('limit') || Infinity);
    return ok(rows.filter((r) => filters.every((f) => f(r))).slice(0, lim));
  }
  if (method === 'POST') {
    for (const p of Array.isArray(body) ? body : [body]) {
      const dup = table === 'memory_fact_forgotten' && rows.some((r) => r.tenant_id === p.tenant_id && r.user_id === p.user_id && r.fact_key === p.fact_key && r.value_hash === p.value_hash);
      if (!dup) rows.push({ id: newId(), ...p });
    }
    return ok([], 201);
  }
  if (method === 'DELETE') { db[table] = rows.filter((r) => !filters.every((f) => f(r))); return ok([]); }
  if (method === 'PATCH') { rows.filter((r) => filters.every((f) => f(r))).forEach((r) => Object.assign(r, body)); return ok([]); }
  return ok([]);
});
(global as any).fetch = fetchMock;

// ---------------------------------------------------------------------------
// The one faked model: what the LLM extracts from the utterance.
// ---------------------------------------------------------------------------

let nextExtraction: Row[] = [];
jest.mock('../src/services/llm-router', () => ({
  callViaRouter: jest.fn(async () => ({ ok: true, provider: 'test', model: 'scripted', text: JSON.stringify(nextExtraction) })),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => fakeClient }));
jest.mock('../src/services/memory-embedding', () => ({
  embedMemoryText: async (text: string) => { lastEmbeddedText = text; return { ok: true, embedding: [0.1], model: 'test' }; },
  toPgVector: (e: number[]) => `[${e.join(',')}]`,
}));
jest.mock('../src/services/memory-facts-service', () => ({ generateFactEmbeddingAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/routes/agents-registry', () => ({ recordAgentHeartbeat: jest.fn().mockResolvedValue(undefined) }));

import { tool_remember_fact } from '../src/services/orb-tools-shared';
import { maybeRunRememberBackstop } from '../src/orb/live/session/remember-backstop-hook';
import { extractAndPersistFacts } from '../src/services/inline-fact-extractor';
import { deleteGardenEntry, _resetGardenCache } from '../src/services/memory/garden';
import { tool_forget_memory } from '../src/services/orb-tools/diary-memory-tools';
import { getMemoryContext } from '../src/services/memory-broker';
import { valuesMatch } from '../src/services/memory/remember-fact-tool';

// ---------------------------------------------------------------------------
// Scenario engine
// ---------------------------------------------------------------------------

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const USERS: Record<string, string> = { me: '', other: '' };
let scenarioNo = 0;
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/memory-verification/conformance.json'), 'utf8'));

interface Ctx { session: Row; sessionNo: number; lastText: string; lastStatuses: string[]; lastNote: string | null }

function reset(sc: Row) {
  for (const k of Object.keys(db)) delete db[k];
  idSeq = 0;
  scenarioNo++;
  // A fresh member per scenario: the pending-conflict store is process-wide.
  USERS.me = `00000000-0000-4000-9000-${String(scenarioNo).padStart(8, '0')}a001`;
  USERS.other = `00000000-0000-4000-9000-${String(scenarioNo).padStart(8, '0')}a002`;
  failWrites = !!sc.fail_writes;
  db.memory_category_mapping = [{ source_category: 'notes', garden_category: 'uncategorized' }];
  // Live value on the shared project, read 2026-09-26: memory_broker_enabled = true.
  db.system_controls = [{ key: 'memory_broker_enabled', enabled: true, expires_at: null }];
  db.profiles = [{ user_id: USERS.me, ...(sc.profile || {}) }];
  db.app_users = [{ user_id: USERS.me, tenant_id: TENANT, display_name: null, email: null, locale: 'de', vitana_id: null, profile: sc.app_user_profile || {} }];
  for (const f of sc.facts || []) {
    db.memory_facts = db.memory_facts || [];
    db.memory_facts.push({
      id: newId(), tenant_id: TENANT, user_id: USERS[f.user || 'me'], entity: f.entity || 'self',
      fact_key: f.key, fact_value: f.value, fact_value_type: 'text',
      provenance_source: f.source || 'user_stated', provenance_confidence: 0.9,
      extracted_at: f.at || new Date(Date.now() - 86_400_000).toISOString(), superseded_by: null, superseded_at: null,
    });
  }
  for (const it of sc.items || []) {
    db.memory_items = db.memory_items || [];
    db.memory_items.push({
      id: newId(), tenant_id: TENANT, user_id: USERS[it.user || 'me'], category_key: it.category || 'notes',
      source: 'orb_voice', content: it.content, content_json: {}, importance: 50, active_role: it.role ?? null,
      occurred_at: new Date(Date.now() - 3_600_000).toISOString(), created_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
  }
}

function newSession(): Row {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
    active: true,
    upstreamProvider: 'nova_sonic',
    identity: { user_id: USERS.me, tenant_id: TENANT },
    upstreamClient: { sent: [] as string[], sendTextTurn(t: string) { this.sent.push(t); return true; } },
  };
}

const identity = () => ({ user_id: USERS.me, tenant_id: TENANT, session_id: 'live-verification', role: 'community' } as any);

function currentFacts(): Row[] {
  return (db.memory_facts || []).filter((r) => r.user_id === USERS.me && r.superseded_by == null);
}

function keyMatches(pattern: string, key: string): boolean {
  const re = new RegExp('^' + pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(key);
}

function checkDb(exp: Row, label: string) {
  const cur = currentFacts();
  for (const f of exp.facts || []) {
    const hits = cur.filter((r) => keyMatches(f.key, r.fact_key) && (f.value == null || valuesMatch(String(r.fact_value), String(f.value))));
    if (f.count != null) expect({ label, key: f.key, value: f.value, current_rows: hits.length }).toEqual({ label, key: f.key, value: f.value, current_rows: f.count });
    else expect({ label, key: f.key, value: f.value, found: hits.length > 0, current: cur.map((r) => `${r.fact_key}=${r.fact_value}`) })
      .toEqual({ label, key: f.key, value: f.value, found: true, current: expect.anything() });
    if (f.entity) expect(hits[0]?.entity).toBe(f.entity);
  }
  for (const f of exp.absent || []) {
    const same = (v: string) => (f.exact ? v === String(f.value) : valuesMatch(v, String(f.value)));
    const hits = cur.filter((r) => keyMatches(f.key, r.fact_key) && (f.value == null || same(String(r.fact_value))));
    expect({ label, absent: f, found: hits.map((r) => `${r.fact_key}=${r.fact_value}`) }).toEqual({ label, absent: f, found: [] });
  }
  if (exp.total_current != null) expect({ label, total_current: cur.length }).toEqual({ label, total_current: exp.total_current });
  if (exp.rows_total != null) {
    const all = (db.memory_facts || []).filter((r) => r.user_id === USERS.me && keyMatches(exp.rows_total.key, r.fact_key));
    expect({ label, rows_ever: all.length }).toEqual({ label, rows_ever: exp.rows_total.count });
  }
}

async function recallText(query: string, role = 'community', blocks: string[] = ['SEMANTIC']): Promise<string> {
  const pack: any = await getMemoryContext({
    tenant_id: TENANT, user_id: USERS.me, intent: 'recall_history', channel: 'conversation', role,
    latency_budget_ms: 5000, required_blocks: blocks, query,
  } as any);
  return JSON.stringify(pack.blocks);
}

async function runStep(step: Row, ctx: Ctx, label: string) {
  switch (step.op) {
    case 'session':
      ctx.session = newSession();
      ctx.sessionNo++;
      return;
    case 'advance':
      jest.setSystemTime(Date.now() + step.minutes * 60_000);
      return;
    case 'tool': {
      const r: any = await tool_remember_fact(step.args, identity(), fakeClient);
      ctx.lastText = String(r.text ?? r.error ?? '');
      ctx.lastStatuses = [String(r.result?.status ?? 'error')];
      break;
    }
    case 'turn': {
      // One voice turn: the model may call remember_fact itself (tool_args);
      // the gateway backstop runs at turn_complete; the background extractor
      // runs on every turn with the same extraction.
      nextExtraction = step.extracted || [];
      ctx.session.rememberFactCalledThisTurn = false;
      ctx.lastText = '';
      ctx.lastStatuses = [];
      if (step.tool_args) {
        const r: any = await tool_remember_fact(step.tool_args, identity(), fakeClient);
        ctx.lastText = String(r.text ?? '');
        ctx.lastStatuses.push(String(r.result?.status));
        ctx.session.rememberFactCalledThisTurn = true;
      }
      const before = ctx.session.upstreamClient.sent.length;
      const p = maybeRunRememberBackstop({ deps: { emitDiag: () => undefined } }, ctx.session, step.say);
      const results: any[] = (await p) || [];
      ctx.lastStatuses.push(...results.map((x) => x.status));
      const sent: string[] = ctx.session.upstreamClient.sent.slice(before);
      ctx.lastNote = sent.length ? sent.join('\n') : null;
      if (ctx.lastNote) ctx.lastText += '\n' + ctx.lastNote;
      if (step.background !== false && step.say.length >= 30) {
        await extractAndPersistFacts({ conversationText: `User: ${step.say}`, tenant_id: TENANT, user_id: USERS.me, session_id: ctx.session.sessionId });
      }
      break;
    }
    case 'replay_note': {
      // The note the gateway injected comes back through the input transcript
      // path; it must not be treated as a member asking to remember.
      expect({ label, had_note: !!ctx.lastNote }).toEqual({ label, had_note: true });
      const before = ctx.session.upstreamClient.sent.length;
      ctx.session.rememberFactCalledThisTurn = false;
      const results: any[] = (await maybeRunRememberBackstop({ deps: { emitDiag: () => undefined } }, ctx.session, String(ctx.lastNote))) || [];
      expect({ label, replayed_statuses: results.map((x) => x.status), new_notes: ctx.session.upstreamClient.sent.length - before })
        .toEqual({ label, replayed_statuses: [], new_notes: 0 });
      return;
    }
    case 'extract':
      nextExtraction = step.extracted || [];
      await extractAndPersistFacts({ conversationText: `User: ${step.say}`, tenant_id: TENANT, user_id: USERS.me, session_id: ctx.session.sessionId });
      break;
    case 'garden_forget': {
      const row = currentFacts().find((r) => keyMatches(step.key, r.fact_key));
      expect({ label, garden_forget_target: !!row }).toEqual({ label, garden_forget_target: true });
      _resetGardenCache();
      const r = await deleteGardenEntry(fakeClient, { tenant_id: TENANT, user_id: USERS.me }, 'fact', row!.id);
      expect(r.ok).toBe(true);
      break;
    }
    case 'voice_forget': {
      // What the voice model can do today: find a memory_items row by text and
      // delete it with forget_memory (confirm=true).
      const needle = String(step.query).toLowerCase();
      const items = (db.memory_items || []).filter((r) => r.user_id === USERS.me && String(r.content).toLowerCase().includes(needle));
      for (const it of items) await tool_forget_memory({ memory_id: it.id, confirm: true }, identity(), fakeClient);
      ctx.lastText = `forgot ${items.length} item(s)`;
      break;
    }
    case 'recall': {
      const text = await recallText(step.query, step.role, step.blocks);
      if (process.env.MV_DEBUG) console.log(label, text.slice(0, 1500));
      const missing = (step.contains || []).filter((s: string) => !text.toLowerCase().includes(s.toLowerCase()));
      const leaked = (step.not_contains || []).filter((s: string) => text.toLowerCase().includes(s.toLowerCase()));
      expect({ label, missing, leaked }).toEqual({ label, missing: [], leaked: [] });
      return;
    }
    default:
      throw new Error(`unknown op ${step.op}`);
  }
  const e = step.expect || {};
  if (e.status) expect({ label, statuses: ctx.lastStatuses }).toEqual({ label, statuses: [].concat(e.status) });
  if (e.no_note) expect({ label, note: ctx.lastNote }).toEqual({ label, note: null });
  for (const s of e.says || []) expect({ label, says: s, in: ctx.lastText.toLowerCase().includes(s.toLowerCase()) }).toEqual({ label, says: s, in: true });
  for (const s of e.never_says || []) expect({ label, never_says: s, in: ctx.lastText.toLowerCase().includes(s.toLowerCase()) }).toEqual({ label, never_says: s, in: false });
  if (step.db) checkDb(step.db, label);
}

describe('VTID-04600 memory verification — layer A (conformance)', () => {
  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
  });
  afterAll(() => jest.useRealTimers());
  beforeEach(() => jest.setSystemTime(new Date(FIXTURE.now)));

  const ids = new Set<string>();
  for (const sc of FIXTURE.scenarios) {
    it('has a unique id: ' + sc.id, () => { expect(ids.has(sc.id)).toBe(false); ids.add(sc.id); });
    const title = `${sc.id} ${sc.title}${sc.gap ? ` [KNOWN GAP: ${sc.gap}]` : ''}`;
    const body = async () => {
      jest.setSystemTime(new Date(FIXTURE.now));
      reset(sc);
      const ctx: Ctx = { session: newSession(), sessionNo: 1, lastText: '', lastStatuses: [], lastNote: null };
      let n = 0;
      for (const step of sc.steps) await runStep(step, ctx, `${sc.id} step ${++n} (${step.op})`);
    };
    if (sc.gap) it.failing(title, body);
    else it(title, body);
  }

  it('covers every category in the plan', () => {
    const cats = new Set(FIXTURE.scenarios.map((s: Row) => s.category));
    for (const c of ['self', 'other', 'profile', 'duplicate', 'conflict', 'recall', 'forget', 'noise', 'time', 'honesty']) {
      expect({ category: c, present: cats.has(c) }).toEqual({ category: c, present: true });
    }
  });
});

