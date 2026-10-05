/**
 * VTID-04886 — the aggregator side of Phase 3: ack/snooze filtering (latest
 * unexpired row wins, snoozed items hidden and counted, P1 never hidden, an
 * ack read failure hides nothing), the 24 h timeline and the two sparklines
 * (a failed read is reported, never an empty "quiet day"), and the production
 * reads behind them. No network, no database.
 */

const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
let tableResult: Record<string, { data: unknown; error: unknown }> = {};
function chain(table: string) {
  const rec = { table, ops: [] as Array<[string, unknown[]]> };
  calls.push(rec);
  const c: any = {};
  for (const m of ['select', 'in', 'gte', 'gt', 'lt', 'eq', 'order', 'limit', 'insert', 'single']) {
    c[m] = (...args: unknown[]) => { rec.ops.push([m, args]); return c; };
  }
  c.then = (res: any, rej: any) => Promise.resolve(tableResult[table] ?? { data: [], error: null }).then(res, rej);
  return c;
}
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({ from: (t: string) => chain(t) }) }));

import {
  applyAcks,
  buildOpsAttention,
  sparklinesFrom,
  timelineFrom,
  type AckRow,
  type AttentionItem,
  type AttentionStateStore,
} from '../src/services/ops-attention';
import { createAttentionReads, supabaseAckStore } from '../src/services/ops-attention-reads';
import { TIMELINE_TOPICS } from '../src/services/ops-attention-adapters';
import { fakeReads } from './fixtures/ops-attention-fakes';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (ms: number) => iso(NOW - ms);
const memStore = (): AttentionStateStore => ({ load: async () => [], save: async () => {} });

const item = (fp: string, severity: 'P1' | 'P2' | 'P3'): AttentionItem => ({
  id: fp, fingerprint: fp, domain: 'autonomy', severity, title: `t ${fp}`, detail: '', since: ago(H), count: 1,
  source: 'autonomy', deeplink: { section: 'autopilot', tab: 'live', query: {} }, evidence: {},
});
const ack = (fp: string, action: 'ack' | 'snooze', o: Partial<AckRow> = {}): AckRow => ({
  id: `a-${fp}-${action}`, env: 'production', fingerprint: fp, action, reason: 'because', severity: 'P2',
  actor_user_id: null, actor_email: 'admin@exafy.io', vtid: null, created_at: ago(10 * 60_000), expires_at: ago(-H), ...o,
});

beforeEach(() => {
  calls.length = 0;
  tableResult = {};
});

describe('applyAcks', () => {
  it('ack marks (still shown); snooze hides and lists; P1 is never hidden (snooze_overridden)', () => {
    const { shown, hidden } = applyAcks(
      [item('a', 'P2'), item('b', 'P3'), item('c', 'P1'), item('d', 'P2')],
      [ack('a', 'ack'), ack('b', 'snooze'), ack('c', 'snooze')],
      NOW,
    );
    expect(shown.map((i) => i.fingerprint)).toEqual(['a', 'c', 'd']);
    expect(shown[0].ack).toMatchObject({ action: 'ack', reason: 'because', actor_email: 'admin@exafy.io' });
    expect(shown[1]).toMatchObject({ snooze_overridden: true, ack: { action: 'snooze' } });
    expect(shown[2].ack).toBeUndefined();
    expect(hidden).toEqual([expect.objectContaining({ fingerprint: 'b', severity: 'P3', snoozed_until: ago(-H), reason: 'because' })]);
  });

  it('the latest unexpired row per fingerprint wins; expired rows are ignored', () => {
    const r = applyAcks([item('a', 'P2'), item('b', 'P2')], [
      ack('a', 'snooze', { created_at: ago(30 * 60_000) }),
      ack('a', 'ack', { created_at: ago(5 * 60_000) }),
      ack('b', 'snooze', { expires_at: ago(1) }),
    ], NOW);
    expect(r.hidden).toEqual([]);
    expect(r.shown.map((i) => i.ack?.action ?? null)).toEqual(['ack', null]);
  });
});

describe('buildOpsAttention with acks', () => {
  const adapter = { id: 'autonomy' as const, run: async () => ({ candidates: [
    { key: 'x', domain: 'autonomy' as const, severity: 'P2' as const, title: 'X', detail: '', since: ago(H), hold_ms: 0, count: 1, deeplink: { section: 'autopilot', tab: 'live', query: {} }, evidence: {} },
    { key: 'y', domain: 'autonomy' as const, severity: 'P3' as const, title: 'Y', detail: '', since: ago(H), hold_ms: 0, count: 1, deeplink: { section: 'autopilot', tab: 'live', query: {} }, evidence: {} },
  ] }) };

  it('a snoozed P2 leaves the queue, counts.hidden says so, the domain tile counts it, the verdict follows what is shown', async () => {
    const data = await buildOpsAttention({
      env: 'production', now: NOW, reads: fakeReads(), state: memStore(), adapters: [adapter],
      acks: { active: async () => [ack('production:autonomy:x', 'snooze'), ack('production:autonomy:y', 'ack')], insert: jest.fn() },
    });
    expect(data.items.map((i) => i.fingerprint)).toEqual(['production:autonomy:y']);
    expect(data.counts).toEqual({ p1: 0, p2: 0, p3: 1, acked: 1, hidden: 1 });
    expect(data.hidden).toHaveLength(1);
    expect(data.domains.find((d) => d.key === 'autonomy')).toMatchObject({ open: 1, hidden: 1, worst_severity: 'P3' });
    expect(data.acks_error).toBeNull();
    expect(data.verdict).toBe('ATTENTION');
  });

  it('an ack read failure hides nothing and is reported in acks_error (not a source, so no false UNKNOWN)', async () => {
    const data = await buildOpsAttention({
      env: 'production', now: NOW, reads: fakeReads(), state: memStore(), adapters: [adapter],
      acks: { active: async () => { throw new Error('acks table missing'); }, insert: jest.fn() },
    });
    expect(data.items).toHaveLength(2);
    expect(data.counts.hidden).toBe(0);
    expect(data.acks_error).toBe('acks table missing');
    expect(data.sources.map((s) => s.id)).not.toContain('attention_acks');
  });

  it('an ack read that hangs is cut at 3 s', async () => {
    jest.useFakeTimers();
    try {
      const p = buildOpsAttention({
        env: 'production', now: NOW, reads: fakeReads(), state: memStore(), adapters: [adapter],
        acks: { active: () => new Promise(() => {}), insert: jest.fn() },
      });
      await jest.advanceTimersByTimeAsync(3_000);
      const data = await p;
      expect(data.acks_error).toMatch(/timeout after 3000 ms/);
      expect(data.items).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('timeline + sparklines', () => {
  const events = [
    { topic: 'prod.deploy.completed', created_at: ago(2 * H + 5 * 60_000), metadata: { service: 'gateway', commit: 'abcdef123' } },
    { topic: 'staging.verify.failed', created_at: ago(30 * 60_000), metadata: { service: 'gateway' } },
    { topic: 'dev_autopilot.kill_switch.activated', created_at: ago(5 * H), metadata: {} },
    { topic: 'not.a.timeline.topic', created_at: ago(H), metadata: {} },
  ];
  const heals = [
    { vtid: 'VTID-1', endpoint: '/api/v1/x', failure_class: null, outcome: 'rolled_back', created_at: ago(3 * H) },
    { vtid: 'VTID-2', endpoint: 'dev_autopilot.planner', failure_class: null, outcome: 'escalated', created_at: ago(H) },
  ];

  it('timelineFrom: classified, newest first, unknown topics and blocklisted self-heal endpoints dropped', () => {
    const t = timelineFrom(events, heals);
    expect(t.map((e) => [e.kind, e.tone])).toEqual([['verify', 'bad'], ['deploy', 'good'], ['self_heal', 'bad'], ['kill_switch', 'bad']]);
    expect(t[1].title).toBe('Production deploy completed · gateway · abcdef1');
    expect(t[2].title).toBe('Self-healing rolled back: /api/v1/x');
  });

  it('sparklinesFrom: 24 hourly buckets, oldest first; deploys exclude failures, incidents are the bad events', () => {
    const s = sparklinesFrom(timelineFrom(events, heals), NOW);
    expect(s.window_hours).toBe(24);
    const by = Object.fromEntries(s.series.map((x) => [x.key, x]));
    expect(by.deploys.buckets).toHaveLength(24);
    expect(by.deploys.total).toBe(1);
    expect(by.deploys.buckets[21]).toBe(1);
    expect(by.incidents.total).toBe(3);
    expect(by.incidents.buckets[23]).toBe(1);
  });

  it('the response carries the timeline and sparklines; a failed timeline read is an error and null sparklines', async () => {
    const ok = await buildOpsAttention({
      env: 'production', now: NOW, state: memStore(), adapters: [],
      reads: fakeReads({ timelineEvents: async () => events as any, selfHealOutcomes: async () => heals as any }),
    });
    expect(ok.timeline).toMatchObject({ window_hours: 24, error: null, truncated: false });
    expect(ok.timeline.events).toHaveLength(4);
    expect(ok.sparklines!.series.map((x) => x.key)).toEqual(['deploys', 'incidents']);
    const bad = await buildOpsAttention({
      env: 'production', now: NOW, state: memStore(), adapters: [],
      reads: fakeReads({ timelineEvents: async () => { throw new Error('oasis down'); } }),
    });
    expect(bad.timeline).toEqual({ window_hours: 24, events: [], truncated: false, error: 'oasis down' });
    expect(bad.sparklines).toBeNull();
  });
});

describe('production reads (VTID-04886)', () => {
  it('timelineEvents: oasis_events topic IN TIMELINE_TOPICS, 24 h, newest first, LIMIT 200; throws on error', async () => {
    await createAttentionReads().timelineEvents('S');
    expect(calls[0]).toEqual({ table: 'oasis_events', ops: [
      ['select', ['topic,created_at,metadata']], ['in', ['topic', TIMELINE_TOPICS]], ['gte', ['created_at', 'S']],
      ['order', ['created_at', { ascending: false }]], ['limit', [200]],
    ] });
    tableResult.oasis_events = { data: null, error: { message: 'x' } };
    await expect(createAttentionReads().timelineEvents('S')).rejects.toThrow('oasis_events: x');
  });

  it('selfHealOutcomes is read once per window per computation (autonomy + timeline share it)', async () => {
    const r = createAttentionReads();
    await Promise.all([r.selfHealOutcomes('W'), r.selfHealOutcomes('W')]);
    expect(calls.filter((c) => c.table === 'self_healing_log')).toHaveLength(1);
  });

  it('ack store: active rows by env and expires_at > now; insert returns the row; errors throw', async () => {
    const store = supabaseAckStore();
    await store.active('staging', 'N');
    expect(calls[0].table).toBe('ops_attention_acks');
    expect(calls[0].ops).toContainEqual(['eq', ['env', 'staging']]);
    expect(calls[0].ops).toContainEqual(['gt', ['expires_at', 'N']]);
    tableResult.ops_attention_acks = { data: { id: 'z' }, error: null };
    expect(await store.insert({ env: 'staging' } as any)).toEqual({ id: 'z' });
    expect(calls[1].ops.map((o) => o[0])).toEqual(['insert', 'select', 'single']);
    tableResult.ops_attention_acks = { data: null, error: { message: 'check violation' } };
    await expect(store.insert({ env: 'staging' } as any)).rejects.toThrow('ops_attention_acks: check violation');
  });

  it('the migration: table, CHECKs (24 h, reason, P1 never snoozed), RLS, service_role only, idempotent', () => {
    const sql = require('fs').readFileSync(require('path').join(__dirname, '../../../supabase/migrations/20261005100000_vtid_04886_ops_attention_acks.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.ops_attention_acks');
    expect(sql).toContain("expires_at <= created_at + interval '24 hours'");
    expect(sql).toContain('reason TEXT NOT NULL');
    expect(sql).toContain("CHECK (NOT (action = 'snooze' AND severity = 'P1'))");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON public.ops_attention_acks FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
    expect(sql).not.toMatch(/CREATE POLICY/i);
    const schema = require('fs').readFileSync(require('path').join(__dirname, '../../../DATABASE_SCHEMA.md'), 'utf8');
    expect(schema).toContain('`ops_attention_acks` (VTID-04886');
  });
});
