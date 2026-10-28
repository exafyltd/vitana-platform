// BOOTSTRAP-ADMIN-BB2 — unit tests for the autopilot_health admin scanner.
//
// Scope: each of the 4 independent checks the scanner runs against
// Supabase, verified for both the "insight surfaces" and "insight stays
// quiet" side of its threshold, plus the shared soft-fail contract (one
// query throwing never kills the other checks / the scanner as a whole).
//
//   1. run_failure_spike       — runs_failed_7d / total_7d > 30%, gated on
//                                 total >= 10 samples.
//   2. self_healing_backlog    — >= 5 pending, confidence < 0.8 rows.
//   3. recommendation_queue    — >= 20 status='new' recommendations.
//   4. activation_drop         — last-7d activations < 50% of prior-7d,
//                                 gated on prior-7d >= 5.
//
// Calls happen in a fixed, sequential order inside the scanner (verified
// by reading the source), so the mock just pops responses off a queue in
// call order — no need to pattern-match on filters.

const mockGetSupabase = jest.fn();
jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: (...args: any[]) => mockGetSupabase(...args),
}));

import { autopilotHealthScanner } from '../../../src/services/admin-scanners/autopilot-health';

interface QueryResult {
  count?: number | null;
  data?: unknown;
  error?: unknown;
}

/** Builds a fake Supabase client whose `.from().select()...` chains resolve
 *  (as a thenable) with responses popped off `queue` in call order. Any
 *  call beyond the queue length falls back to a benign default so scanners
 *  that make more calls than a test cares about don't crash. */
function createSupabaseMock(queue: Array<QueryResult | Error>) {
  let i = 0;
  const calls: string[] = [];
  const client = {
    from: jest.fn((table: string) => {
      calls.push(table);
      const chain: any = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        gte: jest.fn(() => chain),
        lt: jest.fn(() => chain),
        then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) => {
          const next = i < queue.length ? queue[i] : { count: 0, data: [], error: null };
          i += 1;
          if (next instanceof Error) {
            return Promise.reject(next).catch(reject ?? (() => {}));
          }
          return Promise.resolve(next).then(resolve, reject);
        },
      };
      return chain;
    }),
  };
  return { client, calls };
}

/** Default queue: all 4 checks quiet (below every threshold / gate). */
function quietQueue(): QueryResult[] {
  return [
    { count: 0, error: null }, // 1a: tenant_autopilot_runs completed
    { count: 0, error: null }, // 1b: tenant_autopilot_runs failed
    { count: 0, error: null }, // 2: self_healing_log pending backlog
    { count: 0, error: null }, // 3: autopilot_recommendations status=new
    { count: 0, error: null }, // 4a: autopilot_recommendations activated last7
    { count: 0, error: null }, // 4b: autopilot_recommendations activated prior7
  ];
}

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('autopilotHealthScanner — basic shape', () => {
  it('has the expected id/domain/label', () => {
    expect(autopilotHealthScanner.id).toBe('autopilot_health');
    expect(autopilotHealthScanner.domain).toBe('autopilot');
    expect(autopilotHealthScanner.label).toBe('Autopilot health');
  });

  it('returns [] immediately when Supabase is unavailable', async () => {
    mockGetSupabase.mockReturnValue(null);
    const insights = await autopilotHealthScanner.scan('tenant-1');
    expect(insights).toEqual([]);
  });

  it('returns [] when every check is below its threshold', async () => {
    const { client } = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(client);
    const insights = await autopilotHealthScanner.scan('tenant-1');
    expect(insights).toEqual([]);
  });
});

describe('autopilotHealthScanner — run_failure_spike', () => {
  it('stays quiet below the 10-sample gate even at 100% failure', async () => {
    const q = quietQueue();
    q[0] = { count: 1, error: null }; // completed
    q[1] = { count: 8, error: null }; // failed -> total=9, below gate
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    expect(insights.find((i) => i.natural_key === 'run_failure_spike_7d')).toBeUndefined();
  });

  it('stays quiet at exactly the 30% threshold (strictly-greater-than check)', async () => {
    const q = quietQueue();
    q[0] = { count: 7, error: null }; // completed
    q[1] = { count: 3, error: null }; // failed -> total=10, 30% exactly
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    expect(insights.find((i) => i.natural_key === 'run_failure_spike_7d')).toBeUndefined();
  });

  it('fires with severity=action_needed just above the 30% threshold', async () => {
    const q = quietQueue();
    q[0] = { count: 6, error: null }; // completed
    q[1] = { count: 4, error: null }; // failed -> total=10, 40%
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    const insight = insights.find((i) => i.natural_key === 'run_failure_spike_7d');
    expect(insight).toBeDefined();
    expect(insight?.severity).toBe('action_needed');
    expect(insight?.title).toBe('Autopilot failure rate 40% (4/10) last 7 days');
    expect(insight?.actionable).toBe(true);
    expect(insight?.context).toEqual({
      failed_7d: 4,
      completed_7d: 6,
      failure_rate_pct: 40,
      threshold_pct: 30,
    });
  });

  it('escalates to severity=urgent above 60% failure', async () => {
    const q = quietQueue();
    q[0] = { count: 2, error: null }; // completed
    q[1] = { count: 8, error: null }; // failed -> total=10, 80%
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    const insight = insights.find((i) => i.natural_key === 'run_failure_spike_7d');
    expect(insight?.severity).toBe('urgent');
  });

  it('soft-fails the check (no throw, no insight) when the query rejects, and other checks still run', async () => {
    const q: Array<QueryResult | Error> = quietQueue();
    q[0] = new Error('db down');
    q[1] = new Error('db down');
    q[2] = { count: 6, error: null }; // self-healing backlog fires instead
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    expect(insights.find((i) => i.natural_key === 'run_failure_spike_7d')).toBeUndefined();
    expect(insights.find((i) => i.natural_key === 'self_healing_pending_backlog')).toBeDefined();
  });
});

describe('autopilotHealthScanner — self_healing_backlog', () => {
  it('stays quiet below the threshold of 5', async () => {
    const q = quietQueue();
    q[2] = { count: 4, error: null };
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    expect(insights.find((i) => i.natural_key === 'self_healing_pending_backlog')).toBeUndefined();
  });

  it('fires with severity=warning at exactly the threshold of 5', async () => {
    const q = quietQueue();
    q[2] = { count: 5, error: null };
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    const insight = insights.find((i) => i.natural_key === 'self_healing_pending_backlog');
    expect(insight).toBeDefined();
    expect(insight?.severity).toBe('warning');
    expect(insight?.title).toBe('5 self-healing items awaiting approval');
    expect(insight?.recommended_action).toEqual({
      type: 'review_self_healing_queue',
      endpoint: '/api/v1/self-healing/pending-approval',
    });
    expect(insight?.context).toEqual({
      pending_count: 5,
      threshold: 5,
      tenant_scope: 'global',
      scanned_tenant: 'tenant-1',
    });
  });

  it('escalates to severity=action_needed at >= 15', async () => {
    const q = quietQueue();
    q[2] = { count: 15, error: null };
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    const insight = insights.find((i) => i.natural_key === 'self_healing_pending_backlog');
    expect(insight?.severity).toBe('action_needed');
  });

  it('treats a null count as "no data" and stays quiet', async () => {
    const q = quietQueue();
    q[2] = { count: null, error: null };
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    expect(insights.find((i) => i.natural_key === 'self_healing_pending_backlog')).toBeUndefined();
  });
});

describe('autopilotHealthScanner — recommendation_queue', () => {
  it('stays quiet below the threshold of 20', async () => {
    const q = quietQueue();
    q[3] = { count: 19, error: null };
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    expect(insights.find((i) => i.natural_key === 'recommendation_queue_depth')).toBeUndefined();
  });

  it('fires with severity=info at the threshold of 20 (below the 100 escalation)', async () => {
    const q = quietQueue();
    q[3] = { count: 20, error: null };
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    const insight = insights.find((i) => i.natural_key === 'recommendation_queue_depth');
    expect(insight).toBeDefined();
    expect(insight?.severity).toBe('info');
    expect(insight?.title).toBe('20 autopilot recommendations pending');
  });

  it('escalates to severity=action_needed at >= 100', async () => {
    const q = quietQueue();
    q[3] = { count: 100, error: null };
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    const insight = insights.find((i) => i.natural_key === 'recommendation_queue_depth');
    expect(insight?.severity).toBe('action_needed');
  });
});

describe('autopilotHealthScanner — activation_drop', () => {
  it('stays quiet below the prior-7d gate of 5', async () => {
    const q = quietQueue();
    q[4] = { count: 0, error: null }; // last7
    q[5] = { count: 4, error: null }; // prior7, below gate
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    expect(insights.find((i) => i.natural_key === 'activation_drop_7d')).toBeUndefined();
  });

  it('stays quiet when last7 is exactly 50% of prior7 (strictly-less-than check)', async () => {
    const q = quietQueue();
    q[4] = { count: 5, error: null }; // last7
    q[5] = { count: 10, error: null }; // prior7 -> 50% exactly, not a drop
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    expect(insights.find((i) => i.natural_key === 'activation_drop_7d')).toBeUndefined();
  });

  it('fires with severity=warning on a drop below 50% but under the 75% escalation', async () => {
    const q = quietQueue();
    q[4] = { count: 4, error: null }; // last7
    q[5] = { count: 10, error: null }; // prior7 -> last7 < 5, drop=60%
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    const insight = insights.find((i) => i.natural_key === 'activation_drop_7d');
    expect(insight).toBeDefined();
    expect(insight?.severity).toBe('warning');
    expect(insight?.title).toBe('Autopilot activation dropped 60% week over week');
    expect(insight?.context).toEqual({
      activated_last_7d: 4,
      activated_prior_7d: 10,
      drop_pct: 60,
      tenant_scope: 'global',
      scanned_tenant: 'tenant-1',
    });
  });

  it('escalates to severity=action_needed at >= 75% drop', async () => {
    const q = quietQueue();
    q[4] = { count: 1, error: null }; // last7
    q[5] = { count: 10, error: null }; // prior7 -> drop=90%
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    const insight = insights.find((i) => i.natural_key === 'activation_drop_7d');
    expect(insight?.severity).toBe('action_needed');
  });
});

describe('autopilotHealthScanner — combined / soft-fail contract', () => {
  it('can surface all 4 insights simultaneously when every check crosses its threshold', async () => {
    const q: QueryResult[] = [
      { count: 6, error: null }, // completed
      { count: 4, error: null }, // failed -> 40%
      { count: 6, error: null }, // self-healing backlog
      { count: 25, error: null }, // recommendation queue
      { count: 1, error: null }, // activation last7
      { count: 10, error: null }, // activation prior7 -> 90% drop
    ];
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    const insights = await autopilotHealthScanner.scan('tenant-1');
    const keys = insights.map((i) => i.natural_key).sort();
    expect(keys).toEqual([
      'activation_drop_7d',
      'recommendation_queue_depth',
      'run_failure_spike_7d',
      'self_healing_pending_backlog',
    ]);
  });

  it('never throws when every query rejects — returns []', async () => {
    const q: Array<QueryResult | Error> = [
      new Error('boom1'),
      new Error('boom2'),
      new Error('boom3'),
      new Error('boom4'),
      new Error('boom5'),
      new Error('boom6'),
    ];
    const { client } = createSupabaseMock(q);
    mockGetSupabase.mockReturnValue(client);

    await expect(autopilotHealthScanner.scan('tenant-1')).resolves.toEqual([]);
  });
});
