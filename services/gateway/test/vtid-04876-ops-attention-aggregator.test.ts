/**
 * VTID-04876 — /ops/attention aggregator: per-adapter 3 s timeout → UNKNOWN,
 * verdict (never green on missing data), env-scoped fingerprints, time-based
 * hysteresis over ops_attention_state, state failures never break the
 * response, ranking, and the per-task single-flight + 25 s cache.
 * Fakes only — no network, no database.
 */

import {
  buildOpsAttention,
  computeVerdict,
  fingerprintOf,
  getOpsAttention,
  resetOpsAttentionCacheForTests,
  setOpsAttentionDepsForTests,
  CACHE_MS,
  CLEAR_GRACE_MS,
  type AttentionStateStore,
  type StateRow,
} from '../src/services/ops-attention';
import { ATTENTION_ADAPTERS, type AdapterSpec, type Candidate } from '../src/services/ops-attention-adapters';
import { fakeReads } from './fixtures/ops-attention-fakes';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

function memStore(initial: StateRow[] = []) {
  const rows = new Map(initial.map((r) => [r.fingerprint, r]));
  const store: AttentionStateStore & { rows: Map<string, StateRow>; saves: number } = {
    rows,
    saves: 0,
    async load(_env, fps) {
      return fps.map((f) => rows.get(f)).filter(Boolean) as StateRow[];
    },
    async save(_env, rs) {
      store.saves++;
      for (const r of rs) rows.set(r.fingerprint, r);
    },
  };
  return store;
}

const cand = (o: Partial<Candidate>): Candidate => ({
  key: 'k', domain: 'platform', severity: 'P2', title: 't', detail: 'd', since: null, hold_ms: 0, count: 1,
  deeplink: { section: 'overview', tab: 'system-overview', query: {} }, evidence: {}, ...o,
});
const adapter = (id: any, candidates: Candidate[], partial_error?: string): AdapterSpec => ({
  id, run: async () => (partial_error ? { candidates, partial_error } : { candidates }),
});

describe('verdict', () => {
  const ok = [{ id: 'release' as const, status: 'ok' as const, fetched_at: '' }];
  const unk = [{ id: 'release' as const, status: 'unknown' as const, fetched_at: '' }];
  it('CRITICAL beats UNKNOWN; UNKNOWN beats ATTENTION/OK; OK only with all sources fresh and no items', () => {
    expect(computeVerdict({ p1: 1, p2: 0, p3: 0 }, unk)).toBe('CRITICAL');
    expect(computeVerdict({ p1: 0, p2: 3, p3: 0 }, unk)).toBe('UNKNOWN');
    expect(computeVerdict({ p1: 0, p2: 0, p3: 0 }, unk)).toBe('UNKNOWN');
    expect(computeVerdict({ p1: 0, p2: 0, p3: 1 }, ok)).toBe('ATTENTION');
    expect(computeVerdict({ p1: 0, p2: 0, p3: 0 }, ok)).toBe('OK');
  });
});

describe('buildOpsAttention', () => {
  it('response shape, env-scoped fingerprints, ranking by severity then age', async () => {
    const data = await buildOpsAttention({
      env: 'staging', now: NOW, reads: fakeReads(), state: memStore(),
      adapters: [
        adapter('release', [cand({ key: 'a', severity: 'P3', since: iso(NOW - 5 * MIN) })]),
        adapter('governance', [cand({ key: 'b', severity: 'P2', since: iso(NOW - MIN) }), cand({ key: 'c', severity: 'P2', since: iso(NOW - 9 * MIN) })]),
      ],
    });
    expect(data.env).toBe('staging');
    expect(data.generated_at).toBe(iso(NOW));
    expect(data.items.map((i) => i.id)).toEqual(['governance:c', 'governance:b', 'release:a']);
    expect(data.items[0].fingerprint).toBe('staging:governance:c');
    expect(data.counts).toEqual({ p1: 0, p2: 2, p3: 1, acked: 0, hidden: 0 }); // acked/hidden: VTID-04886
    expect(data.verdict).toBe('ATTENTION');
    expect(data.sources.map((s) => [s.id, s.status])).toEqual([
      ['release', 'ok'], ['governance', 'ok'], ['attention_state', 'ok'],
    ]);
    expect(Object.keys(data.items[0]).sort()).toEqual(
      ['count', 'deeplink', 'detail', 'domain', 'evidence', 'fingerprint', 'id', 'severity', 'since', 'source', 'title'].sort(),
    );
    expect(fingerprintOf('production', 'release', 'x')).toBe('production:release:x');
  });

  it('an adapter that exceeds the 3 s timeout is UNKNOWN; the verdict is UNKNOWN, not OK', async () => {
    jest.useFakeTimers();
    try {
      const slow: AdapterSpec = { id: 'voice_supervisor', run: () => new Promise(() => {}) };
      const p = buildOpsAttention({ env: 'production', now: NOW, reads: fakeReads(), state: memStore(), adapters: [slow, adapter('release', [])] });
      await jest.advanceTimersByTimeAsync(3_000);
      const data = await p;
      const s = data.sources.find((x) => x.id === 'voice_supervisor')!;
      expect(s.status).toBe('unknown');
      expect(s.error).toMatch(/timeout after 3000 ms/);
      expect(data.verdict).toBe('UNKNOWN');
    } finally {
      jest.useRealTimers();
    }
  });

  it('per-source budgets: service health 8 s, autonomy 6 s, every other source 3 s', async () => {
    const budgets = Object.fromEntries(ATTENTION_ADAPTERS.map((a) => [a.id, a.timeoutMs ?? 3_000]));
    expect(budgets).toEqual({
      service_health: 8_000, release: 3_000, voice_supervisor: 3_000, autonomy: 6_000,
      operator_pipeline: 3_000, governance: 3_000, decisions_waiting: 3_000,
      // VTID-04885 (Phase 2): the spend read pages through today's events.
      cost_budgets: 8_000, tests_contracts: 3_000, routines: 3_000, support_tickets: 3_000,
      llm_google_fallback: 3_000, stuck_vtids: 3_000,
    });
    jest.useFakeTimers();
    try {
      let resolveSlow: (v: { candidates: never[] }) => void = () => {};
      const slowHealthy: AdapterSpec = { id: 'service_health', timeoutMs: 8_000, run: () => new Promise((r) => { resolveSlow = r; }) };
      const p = buildOpsAttention({ env: 'production', now: NOW, reads: fakeReads(), state: memStore(), adapters: [slowHealthy] });
      await jest.advanceTimersByTimeAsync(5_000); // past 3 s, inside its own 8 s budget
      resolveSlow({ candidates: [] });
      const data = await p;
      expect(data.sources.find((x) => x.id === 'service_health')!.status).toBe('ok');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a throwing adapter is UNKNOWN; a P1 elsewhere still makes the verdict CRITICAL', async () => {
    const boom: AdapterSpec = { id: 'autonomy', run: async () => { throw new Error('db down'); } };
    const data = await buildOpsAttention({
      env: 'production', now: NOW, reads: fakeReads(), state: memStore(),
      adapters: [boom, adapter('release', [cand({ severity: 'P1', since: iso(NOW) })])],
    });
    expect(data.sources[0]).toMatchObject({ id: 'autonomy', status: 'unknown', error: 'db down' });
    expect(data.verdict).toBe('CRITICAL');
  });

  it('a partial adapter is UNKNOWN but still shows its candidates', async () => {
    const data = await buildOpsAttention({
      env: 'production', now: NOW, reads: fakeReads(), state: memStore(),
      adapters: [adapter('release', [cand({ since: iso(NOW) })], 'build_info_prod: no_url')],
    });
    expect(data.items).toHaveLength(1);
    expect(data.sources[0]).toMatchObject({ status: 'unknown', error: 'build_info_prod: no_url' });
    expect(data.verdict).toBe('UNKNOWN');
  });

  it('the full default registry runs over all-healthy fakes: OK with 14 fresh sources (13 adapters + state, VTID-04885)', async () => {
    const data = await buildOpsAttention({
      env: 'production', now: NOW,
      reads: fakeReads({ latestEvent: async (t) => (t[0] === 'staging.verify.passed' ? { topic: 'staging.verify.passed', created_at: iso(NOW - MIN) } : null) }),
      state: memStore(),
    });
    expect(data.sources).toHaveLength(14);
    expect(data.sources.every((s) => s.status === 'ok')).toBe(true);
    expect(data.verdict).toBe('OK');
    expect(data.items).toEqual([]);
  });
});

describe('hysteresis (time-based, N2/N5/N8)', () => {
  const health = adapter('service_health', [cand({ key: '/health', severity: 'P1', hold_ms: 2 * MIN })]);
  const fp = 'production:service_health:/health';

  it('a source-timestamped candidate is stateless: shown once held long enough, no state write', async () => {
    const store = memStore();
    const run = (since: number) => buildOpsAttention({
      env: 'production', now: NOW, reads: fakeReads(), state: store,
      adapters: [adapter('release', [cand({ hold_ms: 10 * MIN, since: iso(since) })])],
    });
    expect((await run(NOW - 9 * MIN)).items).toHaveLength(0);
    expect((await run(NOW - 10 * MIN)).items).toHaveLength(1);
    expect(store.saves).toBe(0);
  });

  it('a stateless-source candidate opens only after 2 min of consecutive observation', async () => {
    const store = memStore();
    const at = (t: number) => buildOpsAttention({ env: 'production', now: t, reads: fakeReads(), state: store, adapters: [health] });
    expect((await at(NOW)).items).toHaveLength(0); // first seen now
    expect(store.rows.get(fp)).toEqual({ fingerprint: fp, first_seen: iso(NOW), last_seen: iso(NOW) });
    expect((await at(NOW + 60_000)).items).toHaveLength(0);
    const open = await at(NOW + 120_000);
    expect(open.items).toHaveLength(1);
    expect(open.items[0].since).toBe(iso(NOW)); // since = first seen
    expect(open.verdict).toBe('CRITICAL');
  });

  it('a gap longer than the clear grace (90 s) resets first_seen; a shorter one keeps it', async () => {
    const kept = memStore([{ fingerprint: fp, first_seen: iso(NOW - 10 * MIN), last_seen: iso(NOW - CLEAR_GRACE_MS) }]);
    const a = await buildOpsAttention({ env: 'production', now: NOW, reads: fakeReads(), state: kept, adapters: [health] });
    expect(a.items[0].since).toBe(iso(NOW - 10 * MIN));

    const reset = memStore([{ fingerprint: fp, first_seen: iso(NOW - 10 * MIN), last_seen: iso(NOW - CLEAR_GRACE_MS - 1) }]);
    const b = await buildOpsAttention({ env: 'production', now: NOW, reads: fakeReads(), state: reset, adapters: [health] });
    expect(b.items).toHaveLength(0);
    expect(reset.rows.get(fp)!.first_seen).toBe(iso(NOW));
  });

  it('staging and production state never mix: the fingerprint and the store call carry env', async () => {
    const calls: string[] = [];
    const store: AttentionStateStore = {
      load: async (env, fps) => { calls.push(`load:${env}:${fps.join(',')}`); return []; },
      save: async (env, rows) => { calls.push(`save:${env}:${rows.map((r) => r.fingerprint).join(',')}`); },
    };
    await buildOpsAttention({ env: 'staging', now: NOW, reads: fakeReads(), state: store, adapters: [health] });
    expect(calls).toEqual(['load:staging:staging:service_health:/health', 'save:staging:staging:service_health:/health']);
  });

  it('a state READ failure never breaks the response: logged, first seen at this request, attention_state UNKNOWN', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const store: AttentionStateStore = { load: async () => { throw new Error('relation does not exist'); }, save: jest.fn() };
    const data = await buildOpsAttention({
      env: 'production', now: NOW, reads: fakeReads(), state: store,
      adapters: [adapter('service_health', [cand({ key: 'x', hold_ms: 0 })])],
    });
    expect(data.items[0].since).toBe(iso(NOW));
    const s = data.sources.find((x) => x.id === 'attention_state')!;
    expect(s).toMatchObject({ status: 'unknown', error: expect.stringMatching(/state_read_failed/) });
    expect(data.verdict).toBe('UNKNOWN');
    expect(store.save).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a state WRITE failure never breaks the response: logged, source stays ok with the error noted', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const store: AttentionStateStore = { load: async () => [], save: async () => { throw new Error('permission denied'); } };
    const data = await buildOpsAttention({
      env: 'production', now: NOW, reads: fakeReads(), state: store,
      adapters: [adapter('service_health', [cand({ key: 'x', severity: 'P3', hold_ms: 0 })])],
    });
    expect(data.items).toHaveLength(1);
    expect(data.sources.find((x) => x.id === 'attention_state')).toMatchObject({ status: 'ok', error: expect.stringMatching(/state_write_failed/) });
    expect(data.verdict).toBe('ATTENTION');
    err.mockRestore();
  });
});

describe('getOpsAttention — single-flight + cache', () => {
  afterEach(() => setOpsAttentionDepsForTests(null));

  it('concurrent callers share one computation; within 25 s the cache answers; after, it recomputes', async () => {
    let healthCalls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    setOpsAttentionDepsForTests({
      reads: () => fakeReads({
        healthSummary: async () => { healthCalls++; await gate; return { checked_at: iso(NOW), items: [] }; },
      }),
      state: () => memStore(),
    });
    const a = getOpsAttention({ now: NOW });
    const b = getOpsAttention({ now: NOW });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(healthCalls).toBe(1);
    expect(ra.data).toBe(rb.data);
    expect(ra.cached).toBe(false);

    const c = await getOpsAttention({ now: NOW + CACHE_MS - 1 });
    expect(c.cached).toBe(true);
    expect(healthCalls).toBe(1);

    const d = await getOpsAttention({ now: NOW + CACHE_MS });
    expect(d.cached).toBe(false);
    expect(healthCalls).toBe(2);
    expect(CACHE_MS).toBeGreaterThanOrEqual(20_000);
    expect(CACHE_MS).toBeLessThanOrEqual(30_000);
    resetOpsAttentionCacheForTests();
  });
});
