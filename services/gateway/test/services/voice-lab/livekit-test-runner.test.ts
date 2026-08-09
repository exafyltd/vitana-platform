/**
 * VTID-03025: LiveKit hourly tests — orchestrator unit tests.
 *
 * `livekit-test-eval` and `livekit-test-scorer` are mocked at the module
 * boundary (each has its own dedicated suite) so these tests exercise only
 * the runner's own orchestration logic: case loading/filtering, run-row
 * bookkeeping, the one-retry-on-failure policy, errored-vs-failed handling,
 * result aggregation, and the read APIs used by the monitor panel.
 */

const mockEvaluateLiveKitDryRun = jest.fn();
jest.mock('../../../src/services/voice-lab/livekit-test-eval', () => ({
  evaluateLiveKitDryRun: (...args: unknown[]) => mockEvaluateLiveKitDryRun(...args),
}));

const mockScoreResult = jest.fn();
jest.mock('../../../src/services/voice-lab/livekit-test-scorer', () => ({
  scoreResult: (...args: unknown[]) => mockScoreResult(...args),
}));

const mockGetSupabase = jest.fn();
jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

import {
  runLiveKitTestSuite,
  listRecentRuns,
  getRunDetail,
  listCases,
} from '../../../src/services/voice-lab/livekit-test-runner';

interface CaseFixture {
  id: string;
  key: string;
  label: string;
  prompt: string;
  expected: unknown;
  layer: 'A' | 'B';
  enabled: boolean;
}

function caseFixture(overrides: Partial<CaseFixture> = {}): CaseFixture {
  return {
    id: `id-${overrides.key ?? 'x'}`,
    key: 'case_x',
    label: 'Case X',
    prompt: 'do a thing',
    expected: { tools: ['a'] },
    layer: 'A',
    enabled: true,
    ...overrides,
  };
}

/**
 * A `getSupabase()` stub covering every table the runner touches:
 *   - livekit_test_cases: select/eq/eq[/eq]/order → thenable list
 *   - livekit_test_runs: insert().select().single() (create run row)
 *                        AND update().eq() (finalize run row)
 *   - livekit_test_results: insert() per case
 * All writes are recorded for assertions.
 */
function makeRunnerSupabase(opts: {
  casesRows?: CaseFixture[] | null;
  casesError?: { message: string } | null;
  insertRunResult?: { data: { id: string } | null; error: { message: string } | null };
} = {}) {
  const insertedResults: unknown[] = [];
  const updatedRuns: unknown[] = [];
  const casesEqCalls: Array<[string, unknown]> = [];

  const from = jest.fn((table: string) => {
    if (table === 'livekit_test_cases') {
      const chain: any = {
        select: jest.fn(() => chain),
        eq: jest.fn((col: string, val: unknown) => {
          casesEqCalls.push([col, val]);
          return chain;
        }),
        order: jest.fn(() => chain),
        then: (resolve: any, reject?: any) =>
          Promise.resolve({ data: opts.casesRows ?? [], error: opts.casesError ?? null }).then(
            resolve,
            reject,
          ),
      };
      return chain;
    }
    if (table === 'livekit_test_runs') {
      const chain: any = {};
      chain.insert = jest.fn(() => chain);
      chain.update = jest.fn((payload: unknown) => {
        updatedRuns.push(payload);
        return chain;
      });
      chain.select = jest.fn(() => chain);
      chain.eq = jest.fn(() => chain);
      chain.single = jest.fn(() =>
        Promise.resolve(opts.insertRunResult ?? { data: { id: 'run-1' }, error: null }),
      );
      // update(...).eq(...) is awaited directly with no further chain call.
      chain.then = (resolve: any, reject?: any) =>
        Promise.resolve({ data: null, error: null }).then(resolve, reject);
      return chain;
    }
    if (table === 'livekit_test_results') {
      const chain: any = {
        insert: jest.fn((payload: unknown) => {
          insertedResults.push(payload);
          return chain;
        }),
        then: (resolve: any, reject?: any) =>
          Promise.resolve({ data: null, error: null }).then(resolve, reject),
      };
      return chain;
    }
    throw new Error(`unexpected table in test mock: ${table}`);
  });

  return { from, insertedResults, updatedRuns, casesEqCalls };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LIVEKIT_TESTS_CONCURRENCY;
});

describe('runLiveKitTestSuite — setup / guard rails', () => {
  it('throws when Supabase is not configured', async () => {
    mockGetSupabase.mockReturnValue(null);
    await expect(runLiveKitTestSuite({ trigger: 'test' })).rejects.toThrow(
      'Supabase client not configured',
    );
  });

  it('throws a descriptive error when no enabled cases exist for the layer', async () => {
    const sb = makeRunnerSupabase({ casesRows: [] });
    mockGetSupabase.mockReturnValue(sb);
    await expect(runLiveKitTestSuite({ trigger: 'test', layer: 'A' })).rejects.toThrow(
      /no enabled cases for layer="A"/,
    );
  });

  it('throws a descriptive error naming the case key when caseKey filter matches nothing', async () => {
    const sb = makeRunnerSupabase({ casesRows: [] });
    mockGetSupabase.mockReturnValue(sb);
    await expect(
      runLiveKitTestSuite({ trigger: 'test', caseKey: 'missing_case' }),
    ).rejects.toThrow(/no enabled case with key="missing_case"/);
  });

  it('throws when the run row cannot be created', async () => {
    const sb = makeRunnerSupabase({
      casesRows: [caseFixture()],
      insertRunResult: { data: null, error: { message: 'insert failed' } },
    });
    mockGetSupabase.mockReturnValue(sb);
    await expect(runLiveKitTestSuite({ trigger: 'test' })).rejects.toThrow(/insert failed/);
  });

  it('defaults to layer "A" and filters enabled=true + layer in the cases query', async () => {
    const sb = makeRunnerSupabase({ casesRows: [caseFixture()] });
    mockGetSupabase.mockReturnValue(sb);
    mockEvaluateLiveKitDryRun.mockResolvedValue({
      tool_calls: [],
      reply_text: 'ok',
      latency_ms: 5,
      instruction_chars: 10,
    });
    mockScoreResult.mockReturnValue({ status: 'passed', failure_reasons: [] });
    await runLiveKitTestSuite({ trigger: 'test' });
    expect(sb.casesEqCalls).toContainEqual(['enabled', true]);
    expect(sb.casesEqCalls).toContainEqual(['layer', 'A']);
  });

  it('filters the query by key when caseKey is provided', async () => {
    const sb = makeRunnerSupabase({ casesRows: [caseFixture({ key: 'only_case' })] });
    mockGetSupabase.mockReturnValue(sb);
    mockEvaluateLiveKitDryRun.mockResolvedValue({ tool_calls: [], reply_text: '', latency_ms: 1, instruction_chars: 1 });
    mockScoreResult.mockReturnValue({ status: 'passed', failure_reasons: [] });
    await runLiveKitTestSuite({ trigger: 'test', caseKey: 'only_case' });
    expect(sb.casesEqCalls).toContainEqual(['key', 'only_case']);
  });
});

describe('runLiveKitTestSuite — scoring outcomes + retry policy', () => {
  it('persists a passed case with no retry and reflects it in the summary totals', async () => {
    const sb = makeRunnerSupabase({ casesRows: [caseFixture({ key: 'c1' })] });
    mockGetSupabase.mockReturnValue(sb);
    mockEvaluateLiveKitDryRun.mockResolvedValue({
      tool_calls: [{ name: 'a', args: {} }],
      reply_text: 'done',
      latency_ms: 42,
      instruction_chars: 99,
    });
    mockScoreResult.mockReturnValue({ status: 'passed', failure_reasons: [] });

    const summary = await runLiveKitTestSuite({ trigger: 'manual' });

    expect(mockEvaluateLiveKitDryRun).toHaveBeenCalledTimes(1); // no retry on pass
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.errored).toBe(0);
    expect(summary.results[0]).toMatchObject({
      case_key: 'c1',
      status: 'passed',
      retried: false,
      latency_ms: 42,
      instruction_chars: 99,
    });
    expect(sb.insertedResults[0]).toMatchObject({
      run_id: 'run-1',
      case_key: 'c1',
      status: 'passed',
      retried: false,
    });
  });

  it('retries exactly once on a failed (not errored) first attempt, and the SECOND attempt is authoritative', async () => {
    const sb = makeRunnerSupabase({ casesRows: [caseFixture({ key: 'c1' })] });
    mockGetSupabase.mockReturnValue(sb);
    mockEvaluateLiveKitDryRun
      .mockResolvedValueOnce({ tool_calls: [], reply_text: '', latency_ms: 10, instruction_chars: 5 })
      .mockResolvedValueOnce({ tool_calls: [{ name: 'a', args: {} }], reply_text: 'ok', latency_ms: 8, instruction_chars: 5 });
    mockScoreResult
      .mockReturnValueOnce({ status: 'failed', failure_reasons: ['missing_tool:a'] })
      .mockReturnValueOnce({ status: 'passed', failure_reasons: [] });

    const summary = await runLiveKitTestSuite({ trigger: 'manual' });

    expect(mockEvaluateLiveKitDryRun).toHaveBeenCalledTimes(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]).toMatchObject({ status: 'passed', retried: true, latency_ms: 8 });
  });

  it('a case that fails on both attempts is persisted as failed with the SECOND attempt failure reasons', async () => {
    const sb = makeRunnerSupabase({ casesRows: [caseFixture({ key: 'c1' })] });
    mockGetSupabase.mockReturnValue(sb);
    mockEvaluateLiveKitDryRun
      .mockResolvedValueOnce({ tool_calls: [], reply_text: '', latency_ms: 10, instruction_chars: 5 })
      .mockResolvedValueOnce({ tool_calls: [], reply_text: '', latency_ms: 12, instruction_chars: 5 });
    mockScoreResult
      .mockReturnValueOnce({ status: 'failed', failure_reasons: ['missing_tool:a'] })
      .mockReturnValueOnce({ status: 'failed', failure_reasons: ['missing_tool:b'] });

    const summary = await runLiveKitTestSuite({ trigger: 'manual' });

    expect(summary.failed).toBe(1);
    expect(summary.results[0]).toMatchObject({
      status: 'failed',
      retried: true,
      failure_reasons: ['missing_tool:b'],
    });
  });

  it('does NOT retry on an errored (thrown) first attempt — errored cases need human diagnosis', async () => {
    const sb = makeRunnerSupabase({ casesRows: [caseFixture({ key: 'c1' })] });
    mockGetSupabase.mockReturnValue(sb);
    mockEvaluateLiveKitDryRun.mockRejectedValue(new Error('vertex unreachable'));

    const summary = await runLiveKitTestSuite({ trigger: 'manual' });

    expect(mockEvaluateLiveKitDryRun).toHaveBeenCalledTimes(1);
    expect(summary.errored).toBe(1);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]).toMatchObject({
      status: 'errored',
      error: 'vertex unreachable',
      tool_calls: null,
      reply_text: null,
      failure_reasons: null,
      retried: false,
    });
  });

  it('aggregates mixed outcomes correctly across multiple cases', async () => {
    // Force serial (not batched) execution so `lastPrompt` tracking below is
    // deterministic regardless of default concurrency.
    process.env.LIVEKIT_TESTS_CONCURRENCY = '1';
    const sb = makeRunnerSupabase({
      casesRows: [
        caseFixture({ key: 'pass_case', prompt: 'prompt-pass' }),
        caseFixture({ key: 'fail_case', prompt: 'prompt-fail' }),
        caseFixture({ key: 'error_case', prompt: 'prompt-error' }),
      ],
    });
    mockGetSupabase.mockReturnValue(sb);

    let lastPrompt = '';
    mockEvaluateLiveKitDryRun.mockImplementation(async (input: { prompt: string }) => {
      lastPrompt = input.prompt;
      if (input.prompt === 'prompt-error') throw new Error('boom');
      return { tool_calls: [], reply_text: 'x', latency_ms: 1, instruction_chars: 1 };
    });
    mockScoreResult.mockImplementation(() => {
      if (lastPrompt === 'prompt-fail') return { status: 'failed', failure_reasons: ['x'] };
      return { status: 'passed', failure_reasons: [] };
    });

    const summary = await runLiveKitTestSuite({ trigger: 'cron' });

    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1); // fails on both attempts (retry doesn't change outcome)
    expect(summary.errored).toBe(1);
  });

  it('finalizes the run row with passed/failed/errored/duration_ms', async () => {
    const sb = makeRunnerSupabase({ casesRows: [caseFixture({ key: 'c1' })] });
    mockGetSupabase.mockReturnValue(sb);
    mockEvaluateLiveKitDryRun.mockResolvedValue({ tool_calls: [], reply_text: 'x', latency_ms: 1, instruction_chars: 1 });
    mockScoreResult.mockReturnValue({ status: 'passed', failure_reasons: [] });

    await runLiveKitTestSuite({ trigger: 'manual' });

    expect(sb.updatedRuns).toHaveLength(1);
    const update = sb.updatedRuns[0] as Record<string, unknown>;
    expect(update.passed).toBe(1);
    expect(update.failed).toBe(0);
    expect(update.errored).toBe(0);
    expect(typeof update.duration_ms).toBe('number');
    expect(update.finished_at).toEqual(expect.any(String));
  });
});

describe('listRecentRuns', () => {
  it('throws when Supabase is not configured', async () => {
    mockGetSupabase.mockReturnValue(null);
    await expect(listRecentRuns()).rejects.toThrow('Supabase client not configured');
  });

  it('throws on query error', async () => {
    const chain: any = {
      select: jest.fn(() => chain),
      order: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      then: (resolve: any) => Promise.resolve({ data: null, error: { message: 'db down' } }).then(resolve),
    };
    mockGetSupabase.mockReturnValue({ from: jest.fn(() => chain) });
    await expect(listRecentRuns()).rejects.toThrow('db down');
  });

  it('caps the limit at 200 even when a larger limit is requested', async () => {
    const limitSpy = jest.fn(() => chain);
    const chain: any = {
      select: jest.fn(() => chain),
      order: jest.fn(() => chain),
      limit: limitSpy,
      then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    mockGetSupabase.mockReturnValue({ from: jest.fn(() => chain) });
    await listRecentRuns(9999);
    expect(limitSpy).toHaveBeenCalledWith(200);
  });

  it('returns the mapped rows unchanged when under the limit cap', async () => {
    const rows = [{ id: 'r1', started_at: 't', finished_at: null, trigger: 'cron', layer: 'A', total: 1, passed: 1, failed: 0, errored: 0, duration_ms: 5 }];
    const chain: any = {
      select: jest.fn(() => chain),
      order: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      then: (resolve: any) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    mockGetSupabase.mockReturnValue({ from: jest.fn(() => chain) });
    const result = await listRecentRuns(10);
    expect(result).toEqual(rows);
  });
});

describe('getRunDetail', () => {
  it('throws when Supabase is not configured', async () => {
    mockGetSupabase.mockReturnValue(null);
    await expect(getRunDetail('run-1')).rejects.toThrow('Supabase client not configured');
  });

  it('returns null when the run row does not exist', async () => {
    const runChain: any = {
      select: jest.fn(() => runChain),
      eq: jest.fn(() => runChain),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
    };
    mockGetSupabase.mockReturnValue({ from: jest.fn(() => runChain) });
    const result = await getRunDetail('missing-run');
    expect(result).toBeNull();
  });

  it('throws when the run query errors', async () => {
    const runChain: any = {
      select: jest.fn(() => runChain),
      eq: jest.fn(() => runChain),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: { message: 'run query broke' } })),
    };
    mockGetSupabase.mockReturnValue({ from: jest.fn(() => runChain) });
    await expect(getRunDetail('run-1')).rejects.toThrow('run query broke');
  });

  it('throws when the results query errors', async () => {
    const runRow = { id: 'run-1', started_at: 't', finished_at: 't2', trigger: 'cron', layer: 'A', total: 1, passed: 1, failed: 0, errored: 0, duration_ms: 5 };
    const from = jest.fn((table: string) => {
      if (table === 'livekit_test_runs') {
        return {
          select: jest.fn(function (this: any) { return this; }),
          eq: jest.fn(function (this: any) { return this; }),
          maybeSingle: jest.fn(() => Promise.resolve({ data: runRow, error: null })),
        };
      }
      const resultsChain: any = {
        select: jest.fn(() => resultsChain),
        eq: jest.fn(() => resultsChain),
        order: jest.fn(() => resultsChain),
        then: (resolve: any) => Promise.resolve({ data: null, error: { message: 'results query broke' } }).then(resolve),
      };
      return resultsChain;
    });
    mockGetSupabase.mockReturnValue({ from });
    await expect(getRunDetail('run-1')).rejects.toThrow('results query broke');
  });

  it('returns the combined run + results shape when both queries succeed', async () => {
    const runRow = { id: 'run-1', started_at: 't', finished_at: 't2', trigger: 'cron', layer: 'A', total: 1, passed: 1, failed: 0, errored: 0, duration_ms: 5 };
    const resultRows = [{ case_key: 'c1', status: 'passed', tool_calls: [], reply_text: 'ok', expected: {}, failure_reasons: null, error: null, latency_ms: 3, retried: false, started_at: 't', finished_at: 't2' }];
    const from = jest.fn((table: string) => {
      if (table === 'livekit_test_runs') {
        const chain: any = {
          select: jest.fn(() => chain),
          eq: jest.fn(() => chain),
          maybeSingle: jest.fn(() => Promise.resolve({ data: runRow, error: null })),
        };
        return chain;
      }
      const chain: any = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        order: jest.fn(() => chain),
        then: (resolve: any) => Promise.resolve({ data: resultRows, error: null }).then(resolve),
      };
      return chain;
    });
    mockGetSupabase.mockReturnValue({ from });
    const result = await getRunDetail('run-1');
    expect(result).toEqual({ run: runRow, results: resultRows });
  });
});

describe('listCases', () => {
  it('throws when Supabase is not configured', async () => {
    mockGetSupabase.mockReturnValue(null);
    await expect(listCases()).rejects.toThrow('Supabase client not configured');
  });

  it('throws on query error', async () => {
    const chain: any = {
      select: jest.fn(() => chain),
      order: jest.fn(() => chain),
      then: (resolve: any) => Promise.resolve({ data: null, error: { message: 'cases query broke' } }).then(resolve),
    };
    mockGetSupabase.mockReturnValue({ from: jest.fn(() => chain) });
    await expect(listCases()).rejects.toThrow('cases query broke');
  });

  it('returns the mapped case rows', async () => {
    const rows = [{ id: '1', key: 'k1', label: 'L1', prompt: 'p1', layer: 'A', enabled: true, notes: null }];
    const chain: any = {
      select: jest.fn(() => chain),
      order: jest.fn(() => chain),
      then: (resolve: any) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    mockGetSupabase.mockReturnValue({ from: jest.fn(() => chain) });
    const result = await listCases();
    expect(result).toEqual(rows);
  });
});
