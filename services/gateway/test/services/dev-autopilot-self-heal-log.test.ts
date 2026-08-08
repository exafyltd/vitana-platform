// Dev Autopilot — shared self_healing_log writer.
//
// Scope:
//   1. classifyAutopilotFailure(): environmental normalisation (both the
//      explicit set and the regex-based isEnvironmentalBlocker probe over
//      failure_class+summary), policy-block tagging, and the default
//      actionable path.
//   2. isWorkerBinaryMissing() / isEnvironmentalBlocker(): the specific
//      regex patterns each is documented to catch, plus null/undefined
//      safety.
//   3. writeAutopilotFailure(): dedup-before-insert (GET then skip POST
//      when a row exists), the insert payload shape (stage embedded in
//      diagnosis, actionable/non_actionable_reason tagging,
//      original_failure_class only when normalised, resolved_at null iff
//      outcome='pending'), and that POST/GET failures never throw.
//   4. writeAutopilotSuccess(): dedup, failure_class derivation from
//      outcome, default confidence per outcome, resolved_at/created_at
//      overrides, and that failures never throw.

import {
  classifyAutopilotFailure,
  isWorkerBinaryMissing,
  isEnvironmentalBlocker,
  writeAutopilotFailure,
  writeAutopilotSuccess,
  type SupaConfig,
} from '../../src/services/dev-autopilot-self-heal-log';

const SUPA: SupaConfig = { url: 'https://supabase.test', key: 'svc-role' };

const ORIGINAL_FETCH = global.fetch;
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isWorkerBinaryMissing / isEnvironmentalBlocker
// ---------------------------------------------------------------------------

describe('isWorkerBinaryMissing', () => {
  it('matches the standard Node spawn ENOENT pattern for claude', () => {
    expect(isWorkerBinaryMissing('Error: spawn claude ENOENT')).toBe(true);
  });

  it('matches the autopilot-worker claude.ts appended hint', () => {
    expect(isWorkerBinaryMissing('Is Claude Code installed and on PATH?')).toBe(true);
  });

  it('matches a stale Antigravity extension spawn failure', () => {
    expect(isWorkerBinaryMissing('failed to spawn .../antigravity-server-2.1.114/claude-code-2.1')).toBe(true);
  });

  it('matches a stale claude-code-N version path', () => {
    expect(isWorkerBinaryMissing('failed to spawn claude-code-2 binary')).toBe(true);
  });

  it('returns false for an unrelated error message', () => {
    expect(isWorkerBinaryMissing('TypeError: cannot read property of undefined')).toBe(false);
  });

  it('returns false for null/undefined without throwing', () => {
    expect(isWorkerBinaryMissing(null)).toBe(false);
    expect(isWorkerBinaryMissing(undefined)).toBe(false);
  });
});

describe('isEnvironmentalBlocker', () => {
  it('delegates to isWorkerBinaryMissing', () => {
    expect(isEnvironmentalBlocker('spawn claude ENOENT')).toBe(true);
  });

  it('matches ENOSPC / OOM / ECONNREFUSED style host failures', () => {
    expect(isEnvironmentalBlocker('write failed: ENOSPC')).toBe(true);
    expect(isEnvironmentalBlocker('Container killed: out of memory')).toBe(true);
    expect(isEnvironmentalBlocker('Process OOMKilled')).toBe(true);
    expect(isEnvironmentalBlocker('connect ECONNREFUSED 127.0.0.1:5432')).toBe(true);
  });

  it('matches worker-queue capacity messages', () => {
    expect(isEnvironmentalBlocker('exceeded worker-queue wait time of 720s')).toBe(true);
    expect(isEnvironmentalBlocker('worker queue global timeout')).toBe(true);
  });

  it('matches Cloud Run deploy optimistic-concurrency conflicts', () => {
    expect(
      isEnvironmentalBlocker(
        "ABORTED: Conflict for resource 'gateway': version 'X' was specified but current version is 'Y'",
      ),
    ).toBe(true);
  });

  it('matches missing GitHub token errors', () => {
    expect(isEnvironmentalBlocker('GITHUB_TOKEN is not set')).toBe(true);
    expect(isEnvironmentalBlocker('GITHUB_SAFE_MERGE_TOKEN is not set')).toBe(true);
  });

  it('returns false for a genuine code-defect message', () => {
    expect(isEnvironmentalBlocker('TypeError: undefined is not a function at plan.ts:42')).toBe(false);
  });

  it('returns false for null/undefined without throwing', () => {
    expect(isEnvironmentalBlocker(null)).toBe(false);
    expect(isEnvironmentalBlocker(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyAutopilotFailure
// ---------------------------------------------------------------------------

describe('classifyAutopilotFailure', () => {
  it('normalises the explicit worker_queue_unclaimed class to environmental_blocker', () => {
    const result = classifyAutopilotFailure({ failure_class: 'dev_autopilot_worker_queue_unclaimed' });
    expect(result).toEqual({
      failure_class: 'environmental_blocker',
      actionable: false,
      non_actionable_reason: 'environmental',
    });
  });

  it('normalises via the regex probe when the diagnosis summary matches an environmental pattern', () => {
    const result = classifyAutopilotFailure({
      failure_class: 'dev_autopilot_plan_gen_error',
      diagnosis: { summary: 'failed to spawn claude ENOENT' },
    });
    expect(result.failure_class).toBe('environmental_blocker');
    expect(result.actionable).toBe(false);
    expect(result.non_actionable_reason).toBe('environmental');
  });

  it('tags the safety-gate class as a policy block without renaming it', () => {
    const result = classifyAutopilotFailure({ failure_class: 'dev_autopilot_safety_gate_blocked' });
    expect(result).toEqual({
      failure_class: 'dev_autopilot_safety_gate_blocked',
      actionable: false,
      non_actionable_reason: 'policy_block',
    });
  });

  it('leaves an ordinary failure class actionable and unmodified', () => {
    const result = classifyAutopilotFailure({ failure_class: 'dev_autopilot_llm_no_output' });
    expect(result).toEqual({
      failure_class: 'dev_autopilot_llm_no_output',
      actionable: true,
      non_actionable_reason: null,
    });
  });

  it('tolerates a missing diagnosis object', () => {
    const result = classifyAutopilotFailure({ failure_class: 'dev_autopilot_llm_no_output' });
    expect(result.actionable).toBe(true);
  });

  it('ignores a non-string diagnosis.summary rather than throwing', () => {
    const result = classifyAutopilotFailure({
      failure_class: 'dev_autopilot_llm_no_output',
      diagnosis: { summary: 12345 as unknown as string },
    });
    expect(result.actionable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeAutopilotFailure
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('writeAutopilotFailure', () => {
  it('skips the insert (dedup) when a matching row already exists in the window', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      return jsonResponse([{ id: 'existing-1' }]);
    });
    global.fetch = mockFetch as any;

    await writeAutopilotFailure(SUPA, {
      stage: 'plan_gen',
      vtid: 'VTID-DA-abc',
      endpoint: 'autopilot.plan_gen',
      failure_class: 'dev_autopilot_llm_no_output',
      diagnosis: { summary: 'no output' },
    });

    expect(calls).toHaveLength(1); // only the dedup GET, no POST
    expect(calls[0].url).toContain('/rest/v1/self_healing_log');
    expect(calls[0].url).toContain('vtid=eq.VTID-DA-abc');
    expect(calls[0].url).toContain('failure_class=eq.dev_autopilot_llm_no_output');
  });

  it('inserts with defaults (confidence=0, attempt_number=1, outcome=failed) when no dedup match exists', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]);
      return jsonResponse({});
    });
    global.fetch = mockFetch as any;

    await writeAutopilotFailure(SUPA, {
      stage: 'execute_run',
      vtid: 'VTID-DA-xyz',
      endpoint: 'src/foo.ts',
      failure_class: 'dev_autopilot_llm_no_output',
      diagnosis: { summary: 'empty response' },
    });

    expect(calls).toHaveLength(2);
    const insertCall = calls[1];
    expect(insertCall.url).toBe('https://supabase.test/rest/v1/self_healing_log');
    expect(insertCall.init.method).toBe('POST');
    const body = JSON.parse(insertCall.init.body);
    expect(body.vtid).toBe('VTID-DA-xyz');
    expect(body.endpoint).toBe('src/foo.ts');
    expect(body.failure_class).toBe('dev_autopilot_llm_no_output');
    expect(body.confidence).toBe(0);
    expect(body.attempt_number).toBe(1);
    expect(body.outcome).toBe('failed');
    expect(body.diagnosis.stage).toBe('execute_run');
    expect(body.diagnosis.summary).toBe('empty response');
    expect(body.diagnosis.actionable).toBe(true);
    expect(body.diagnosis.non_actionable_reason).toBeNull();
    expect(body.diagnosis).not.toHaveProperty('original_failure_class');
    expect(typeof body.resolved_at).toBe('string'); // outcome != pending -> resolved_at set
  });

  it('sets resolved_at to null when outcome is pending', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]);
      return jsonResponse({});
    });
    global.fetch = mockFetch as any;

    await writeAutopilotFailure(SUPA, {
      stage: 'reconciler',
      vtid: 'VTID-DA-pending',
      endpoint: 'autopilot.reconciler',
      failure_class: 'dev_autopilot_retry_in_flight',
      diagnosis: {},
      outcome: 'pending',
      confidence: 0.4,
      attempt_number: 2,
    });

    const body = JSON.parse(calls[1].init.body);
    expect(body.resolved_at).toBeNull();
    expect(body.confidence).toBe(0.4);
    expect(body.attempt_number).toBe(2);
  });

  it('dedups the query and persists the normalised class, preserving the original as original_failure_class', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]);
      return jsonResponse({});
    });
    global.fetch = mockFetch as any;

    await writeAutopilotFailure(SUPA, {
      stage: 'plan_gen',
      vtid: 'VTID-DA-worker',
      endpoint: 'autopilot.plan_gen',
      failure_class: 'dev_autopilot_worker_queue_unclaimed',
      diagnosis: { summary: 'worker daemon down' },
    });

    // Dedup GET queries on the normalised class, not the raw one.
    expect(calls[0].url).toContain('failure_class=eq.environmental_blocker');

    const body = JSON.parse(calls[1].init.body);
    expect(body.failure_class).toBe('environmental_blocker');
    expect(body.diagnosis.original_failure_class).toBe('dev_autopilot_worker_queue_unclaimed');
    expect(body.diagnosis.actionable).toBe(false);
    expect(body.diagnosis.non_actionable_reason).toBe('environmental');
  });

  it('never throws when the dedup GET fails (falls through to attempt the insert)', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return { ok: false, status: 500, text: async () => '' };
      return jsonResponse({});
    });
    global.fetch = mockFetch as any;

    await expect(
      writeAutopilotFailure(SUPA, {
        stage: 'plan_gen',
        vtid: 'VTID-DA-1',
        endpoint: 'e',
        failure_class: 'dev_autopilot_llm_no_output',
        diagnosis: {},
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(2); // dedup GET failed-open, then insert attempted
  });

  it('never throws when the insert POST fails', async () => {
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      if (!init || init.method === undefined) return jsonResponse([]);
      return { ok: false, status: 500, text: async () => 'server error' };
    });
    global.fetch = mockFetch as any;

    await expect(
      writeAutopilotFailure(SUPA, {
        stage: 'plan_gen',
        vtid: 'VTID-DA-2',
        endpoint: 'e',
        failure_class: 'dev_autopilot_llm_no_output',
        diagnosis: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('never throws when fetch itself rejects', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as any;

    await expect(
      writeAutopilotFailure(SUPA, {
        stage: 'plan_gen',
        vtid: 'VTID-DA-3',
        endpoint: 'e',
        failure_class: 'dev_autopilot_llm_no_output',
        diagnosis: {},
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// writeAutopilotSuccess
// ---------------------------------------------------------------------------

describe('writeAutopilotSuccess', () => {
  it('skips the insert (dedup) when a matching success row already exists', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      return jsonResponse([{ id: 'existing-success' }]);
    });
    global.fetch = mockFetch as any;

    await writeAutopilotSuccess(SUPA, {
      vtid: 'VTID-DA-fix',
      endpoint: 'src/bar.ts',
      outcome: 'fixed',
      diagnosis: { pr_url: 'https://x/pr/1' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('failure_class=eq.auto_fix_applied');
  });

  it('inserts with failure_class=auto_fix_applied and confidence=1.0 for outcome=fixed', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]);
      return jsonResponse({});
    });
    global.fetch = mockFetch as any;

    await writeAutopilotSuccess(SUPA, {
      vtid: 'VTID-DA-fix2',
      endpoint: 'src/bar.ts',
      outcome: 'fixed',
      diagnosis: { pr_url: 'https://x/pr/2' },
    });

    const body = JSON.parse(calls[1].init.body);
    expect(body.failure_class).toBe('auto_fix_applied');
    expect(body.confidence).toBe(1.0);
    expect(body.outcome).toBe('fixed');
    expect(body.attempt_number).toBe(1);
    expect(body.diagnosis.stage).toBe('execute_run');
    expect(body.diagnosis.pr_url).toBe('https://x/pr/2');
    expect(body).not.toHaveProperty('created_at');
  });

  it('inserts with failure_class=auto_fix_reverted and confidence=0.5 for outcome=rolled_back', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]);
      return jsonResponse({});
    });
    global.fetch = mockFetch as any;

    await writeAutopilotSuccess(SUPA, {
      vtid: 'VTID-DA-revert',
      endpoint: 'src/baz.ts',
      outcome: 'rolled_back',
      diagnosis: {},
    });

    const body = JSON.parse(calls[1].init.body);
    expect(body.failure_class).toBe('auto_fix_reverted');
    expect(body.confidence).toBe(0.5);
    expect(body.outcome).toBe('rolled_back');
  });

  it('honors an explicit confidence override', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]);
      return jsonResponse({});
    });
    global.fetch = mockFetch as any;

    await writeAutopilotSuccess(SUPA, {
      vtid: 'VTID-DA-conf',
      endpoint: 'src/baz.ts',
      outcome: 'fixed',
      diagnosis: {},
      confidence: 0.77,
    });

    const body = JSON.parse(calls[1].init.body);
    expect(body.confidence).toBe(0.77);
  });

  it('includes created_at/resolved_at overrides for backfill when passed', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]);
      return jsonResponse({});
    });
    global.fetch = mockFetch as any;

    await writeAutopilotSuccess(SUPA, {
      vtid: 'VTID-DA-backfill',
      endpoint: 'src/baz.ts',
      outcome: 'fixed',
      diagnosis: {},
      createdAtIso: '2026-01-01T00:00:00.000Z',
      resolvedAtIso: '2026-01-02T00:00:00.000Z',
    });

    const body = JSON.parse(calls[1].init.body);
    expect(body.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(body.resolved_at).toBe('2026-01-02T00:00:00.000Z');
  });

  it('never throws when the insert POST fails', async () => {
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      if (!init || init.method === undefined) return jsonResponse([]);
      return { ok: false, status: 500, text: async () => 'server error' };
    });
    global.fetch = mockFetch as any;

    await expect(
      writeAutopilotSuccess(SUPA, { vtid: 'VTID-DA-err', endpoint: 'e', outcome: 'fixed', diagnosis: {} }),
    ).resolves.toBeUndefined();
  });

  it('never throws when fetch itself rejects', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as any;

    await expect(
      writeAutopilotSuccess(SUPA, { vtid: 'VTID-DA-err2', endpoint: 'e', outcome: 'rolled_back', diagnosis: {} }),
    ).resolves.toBeUndefined();
  });
});
