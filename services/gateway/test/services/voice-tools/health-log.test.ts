/**
 * Tests for src/services/voice-tools/health-log.ts — the log_water / log_sleep /
 * log_exercise / log_meditation voice tools (VTID-02753).
 *
 * Every path is asserted to return a well-formed, JSON-serializable object
 * (never undefined/a bare primitive) — this is the exact failure class from
 * commit b9acd92 ("wrap non-object tool outputs — Nova kills the stream on
 * unparseable toolResult").
 */

import { createQueryMock, assertWellFormedToolResult, MockResp } from './supabase-mock';

const mock = createQueryMock();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mock.client),
}));

import { logHealthSignal, LogHealthSignalInput } from '../../../src/services/voice-tools/health-log';

const ORIGINAL_ENV = { ...process.env };

function resetMocks() {
  // Recreate queues/defaults by clearing via a fresh mock isn't possible
  // (module-level `mock` is captured by the jest.mock factory), so instead
  // clear each map directly through the exposed setters by overwriting with
  // empty defaults per table used in this suite.
  for (const t of [
    'user_tenants',
    'vitana_index_scores',
    'health_features_daily',
    'user_integrations',
  ]) {
    mock.setTable(t, { data: null, error: null });
  }
  mock.setRpc('health_compute_vitana_index_for_user', { data: null, error: null });
  mock.calls.length = 0;
  mock.rpcCalls.length = 0;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function baseInput(overrides: Partial<LogHealthSignalInput> = {}): LogHealthSignalInput {
  return {
    user_id: 'user-1',
    tenant_id: 'tenant-1',
    tool: 'log_water',
    date: '2026-07-28',
    amount_ml: 500,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Input validation (no DB access should happen for these)
// ---------------------------------------------------------------------------

describe('logHealthSignal — input validation', () => {
  it('rejects an unknown tool name', async () => {
    const result = await logHealthSignal(baseInput({ tool: 'log_unknown' as any }));
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('unknown tool: log_unknown');
    assertWellFormedToolResult(result);
  });

  it('rejects log_water with no amount_ml', async () => {
    const result = await logHealthSignal(
      baseInput({ tool: 'log_water', amount_ml: undefined }),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('amount_ml or minutes is required');
    assertWellFormedToolResult(result);
  });

  it('rejects log_sleep with no minutes', async () => {
    const result = await logHealthSignal(
      baseInput({ tool: 'log_sleep', amount_ml: undefined, minutes: undefined }),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('amount_ml or minutes is required');
    assertWellFormedToolResult(result);
  });

  it('rejects a non-finite value (NaN guarded via typeof number check)', async () => {
    const result = await logHealthSignal(
      baseInput({ tool: 'log_water', amount_ml: Number.POSITIVE_INFINITY }),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('amount_ml or minutes is required');
    assertWellFormedToolResult(result);
  });

  it('rejects a value below the tool bounds', async () => {
    const result = await logHealthSignal(baseInput({ tool: 'log_water', amount_ml: 10 }));
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/value out of range: 10 ml/);
    assertWellFormedToolResult(result);
  });

  it('rejects a value above the tool bounds', async () => {
    const result = await logHealthSignal(baseInput({ tool: 'log_water', amount_ml: 999999 }));
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/value out of range: 999999 ml/);
    assertWellFormedToolResult(result);
  });

  it('rejects log_meditation minutes below its (tighter) bounds', async () => {
    const result = await logHealthSignal(
      baseInput({ tool: 'log_meditation', amount_ml: undefined, minutes: 0 }),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/value out of range: 0 min \(allowed 1–240\)/);
    assertWellFormedToolResult(result);
  });

  it('reports supabase_not_configured when SUPABASE_URL / service key are unset — no DB call attempted', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const result = await logHealthSignal(baseInput());
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('supabase_not_configured');
    expect(mock.calls.length).toBe(0);
    assertWellFormedToolResult(result);
  });
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('logHealthSignal — happy paths', () => {
  it('logs water with a provided tenant_id, skipping the user_tenants lookup', async () => {
    mock.setTable('vitana_index_scores', { data: { score_total: 40 }, error: null });
    mock.setTable('health_features_daily', { data: null, error: null });
    mock.setRpc('health_compute_vitana_index_for_user', {
      data: { score_total: 55, score_hydration: 80 },
      error: null,
    });

    const result = await logHealthSignal(baseInput({ tool: 'log_water', amount_ml: 500 }));

    expect(result.ok).toBe(true);
    const summary = (result as any).summary;
    expect(summary.tool).toBe('log_water');
    expect(summary.pillar).toBe('hydration');
    expect(summary.feature_key).toBe('water_intake');
    expect(summary.value).toBe(500);
    expect(summary.unit).toBe('ml');
    expect(summary.date).toBe('2026-07-28');
    expect(summary.pillar_score_after).toBe(80);
    expect(summary.total_after).toBe(55);
    expect(summary.index_delta).toBe(15); // 55 - 40
    expect(mock.calls.some((c) => c.table === 'user_tenants')).toBe(false);
    assertWellFormedToolResult(result);
  });

  it('resolves tenant_id via user_tenants when none is provided', async () => {
    mock.setTable('user_tenants', { data: { tenant_id: 'resolved-tenant' }, error: null });
    mock.setTable('vitana_index_scores', { data: null, error: null });
    mock.setTable('health_features_daily', { data: null, error: null });

    const result = await logHealthSignal(
      baseInput({ tenant_id: null, tool: 'log_sleep', amount_ml: undefined, minutes: 420 }),
    );

    expect(result.ok).toBe(true);
    expect(mock.calls.some((c) => c.table === 'user_tenants')).toBe(true);
    assertWellFormedToolResult(result);
  });

  it('falls back to the zero-UUID tenant when user_tenants has no row either', async () => {
    mock.setTable('user_tenants', { data: null, error: null });
    mock.setTable('health_features_daily', { data: null, error: null });

    const result = await logHealthSignal(
      baseInput({ tenant_id: null, tool: 'log_water', amount_ml: 500 }),
    );

    expect(result.ok).toBe(true);
    assertWellFormedToolResult(result);
  });

  it('computes index_delta as null when there is no previous index row', async () => {
    mock.setTable('vitana_index_scores', { data: null, error: null });
    mock.setTable('health_features_daily', { data: null, error: null });
    mock.setRpc('health_compute_vitana_index_for_user', {
      data: { score_total: 55, score_hydration: 80 },
      error: null,
    });

    const result = await logHealthSignal(baseInput({ tool: 'log_water', amount_ml: 500 }));
    const summary = (result as any).summary;
    expect(summary.total_after).toBe(55);
    expect(summary.pillar_score_after).toBe(80);
    expect(summary.index_delta).toBeNull();
    assertWellFormedToolResult(result);
  });

  it('returns null total_after / pillar_score_after / index_delta when the RPC returns no row', async () => {
    mock.setTable('vitana_index_scores', { data: { score_total: 40 }, error: null });
    mock.setTable('health_features_daily', { data: null, error: null });
    mock.setRpc('health_compute_vitana_index_for_user', { data: null, error: null });

    const result = await logHealthSignal(baseInput({ tool: 'log_water', amount_ml: 500 }));
    const summary = (result as any).summary;
    expect(summary.total_after).toBeNull();
    expect(summary.pillar_score_after).toBeNull();
    expect(summary.index_delta).toBeNull();
    assertWellFormedToolResult(result);
  });

  it('carries activity_type through for log_exercise', async () => {
    mock.setTable('health_features_daily', { data: null, error: null });
    mock.setRpc('health_compute_vitana_index_for_user', {
      data: { score_total: 70, score_exercise: 65 },
      error: null,
    });

    const result = await logHealthSignal(
      baseInput({
        tool: 'log_exercise',
        amount_ml: undefined,
        minutes: 45,
        activity_type: 'running',
      }),
    );

    expect(result.ok).toBe(true);
    const summary = (result as any).summary;
    expect(summary.pillar).toBe('exercise');
    expect(summary.feature_key).toBe('wearable_workout');
    expect(summary.activity_type).toBe('running');
    expect(summary.pillar_score_after).toBe(65);
    assertWellFormedToolResult(result);
  });

  it('does not set activity_type for non-exercise tools even if passed', async () => {
    mock.setTable('health_features_daily', { data: null, error: null });

    const result = await logHealthSignal(
      baseInput({
        tool: 'log_meditation',
        amount_ml: undefined,
        minutes: 20,
        activity_type: 'should_be_ignored',
      }),
    );

    expect(result.ok).toBe(true);
    const summary = (result as any).summary;
    expect(summary.pillar).toBe('mental');
    expect(summary.feature_key).toBe('meditation_minutes');
    // activity_type still echoes through the summary's input passthrough,
    // but must NOT have been written into the upsert metadata as exercise
    // activity_type — verified via the upsert call args below.
    const upsertCall = mock.calls.find(
      (c) => c.table === 'health_features_daily' && c.steps.some((s) => s.method === 'upsert'),
    );
    const upsertArgs = upsertCall!.steps.find((s) => s.method === 'upsert')!.args[0] as any;
    expect(upsertArgs.metadata).toEqual({ source: 'voice_tool' });
    assertWellFormedToolResult(result);
  });

  it('logs meditation minutes correctly (mental pillar)', async () => {
    mock.setTable('health_features_daily', { data: null, error: null });

    const result = await logHealthSignal(
      baseInput({ tool: 'log_meditation', amount_ml: undefined, minutes: 15 }),
    );

    expect(result.ok).toBe(true);
    const summary = (result as any).summary;
    expect(summary.pillar).toBe('mental');
    expect(summary.value).toBe(15);
    expect(summary.unit).toBe('min');
    assertWellFormedToolResult(result);
  });
});

// ---------------------------------------------------------------------------
// Upstream failure path
// ---------------------------------------------------------------------------

describe('logHealthSignal — upstream write failure', () => {
  it('returns feature_write_failed when the health_features_daily upsert errors', async () => {
    mock.setTable('health_features_daily', {
      data: null,
      error: { message: 'constraint violation' },
    });

    const result = await logHealthSignal(baseInput({ tool: 'log_water', amount_ml: 500 }));

    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('feature_write_failed: constraint violation');
    assertWellFormedToolResult(result);
  });

  it('does not attempt the Index recompute RPC when the feature write failed', async () => {
    mock.setTable('health_features_daily', {
      data: null,
      error: { message: 'db down' },
    });

    await logHealthSignal(baseInput({ tool: 'log_water', amount_ml: 500 }));

    expect(mock.rpcCalls.length).toBe(0);
  });
});
