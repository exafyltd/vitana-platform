// VTID-01124 — unit tests for the D40 Life Stage, Goals & Trajectory Awareness
// Engine (d40-life-stage-awareness-engine.ts).
//
// The module is a thin, deterministic RPC-wrapper: every public function
// (1) resolves a Supabase client — the caller's own (via authToken) or, only
//     when no authToken is given AND the process is running in a "dev
//     sandbox" environment, a service-role client bootstrapped with a fixed
//     dev tenant/user identity;
// (2) calls exactly one `life_stage_*` RPC;
// (3) maps RPC success/error into the function's typed response shape; and
// (4) emits OASIS events for real state transitions only (not every call).
//
// Scope (this file):
//   1. Client resolution — UNAUTHENTICATED / SERVICE_UNAVAILABLE gates, the
//      dev-sandbox bootstrap RPC, and that an authToken always uses the
//      user's own client (never the dev identity) — this IS the tenant/user
//      isolation guarantee for a module with no explicit tenant_id param.
//   2. Per-function RPC parameter mapping (defaults + pass-through).
//   3. Per-function OASIS event emission — exactly which functions emit,
//      under which conditions, with which payload.
//   4. Error handling — RPC error vs. thrown/rejected error, mapped per
//      function's declared response shape (including the zeroed
//      overall_coherence/conflicts_detected/multi_goal_opportunities fields
//      scoreTrajectory keeps on every failure path).
//   5. ORB convenience wiring (getOrbLifeStageContext / processForOrb) —
//      that a full LifeStageBundle is correctly converted + formatted.

const mockRpc = jest.fn();
const mockCreateClient = jest.fn((url: string, key: string, opts?: any) => ({
  rpc: (...args: any[]) => mockRpc(...args),
  __url: url,
  __key: key,
  __opts: opts,
}));
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: any[]) => mockCreateClient(...args),
}));

const mockEmitOasisEvent = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

import {
  assessLifeStage,
  getCurrentLifeStage,
  overrideLifeStage,
  explainLifeStage,
  detectGoal,
  getGoals,
  updateGoal,
  scoreTrajectory,
  getOrbLifeStageContext,
  processForOrb,
} from '../../src/services/d40-life-stage-awareness-engine';
import type { LifeStageBundle, GoalSet } from '../../src/types/life-stage-awareness';

const DEV_TENANT_ID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  mockRpc.mockReset();
  mockCreateClient.mockClear();
  mockEmitOasisEvent.mockReset();
  mockEmitOasisEvent.mockResolvedValue({ ok: true, event_id: 'evt-1' });

  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  delete process.env.ENVIRONMENT;
  delete process.env.VITANA_ENV;
});

function makeBundle(overrides: Partial<LifeStageBundle> = {}): LifeStageBundle {
  return {
    phase: 'optimizing',
    phase_confidence: 85,
    stability_level: 'high',
    stability_confidence: 90,
    transition_flag: false,
    orientation_signals: [
      { signal: 'career_intensive', score: 70, confidence: 80, evidence_count: 4 },
      { signal: 'balance_seeking', score: 40, confidence: 60, evidence_count: 2 },
    ],
    assessed_at: '2026-07-01T00:00:00Z',
    decay_at: '2026-08-01T00:00:00Z',
    disclaimer: 'These are inferred signals, not diagnoses.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// assessLifeStage
// ---------------------------------------------------------------------------

describe('assessLifeStage — client resolution', () => {
  it('returns UNAUTHENTICATED and never creates a Supabase client when there is no authToken and the process is not a dev sandbox', async () => {
    const result = await assessLifeStage({ session_id: 's1' });

    expect(result).toEqual({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication required for life stage assessment',
    });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns SERVICE_UNAVAILABLE when the user client cannot be built (missing SUPABASE_ANON_KEY)', async () => {
    delete process.env.SUPABASE_ANON_KEY;

    const result = await assessLifeStage({}, 'user-jwt');

    expect(result).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE', message: 'Unable to connect to database' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('uses the authenticated user client (anon key + bearer header) and skips the dev-identity bootstrap, even while running in a dev sandbox', async () => {
    process.env.ENVIRONMENT = 'dev-sandbox';
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });

    await assessLifeStage({ session_id: 's1' }, 'user-jwt-abc');

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const [url, key, opts] = mockCreateClient.mock.calls[0];
    expect(url).toBe('http://localhost:54321');
    expect(key).toBe('test-anon-key');
    expect(opts.global.headers.Authorization).toBe('Bearer user-jwt-abc');
    // Only life_stage_assess — no dev_bootstrap_request_context call, i.e. no
    // swap onto the shared dev tenant when a real caller identity exists.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('life_stage_assess', expect.any(Object));
  });

  it('uses the service client and bootstraps the fixed dev identity when there is no authToken but the process is a dev sandbox', async () => {
    process.env.ENVIRONMENT = 'dev-sandbox';
    mockRpc.mockResolvedValueOnce({ data: null, error: null }); // bootstrap
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null }); // life_stage_assess

    await assessLifeStage({});

    const [, key] = mockCreateClient.mock.calls[0];
    expect(key).toBe('test-service-role-key');
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'dev_bootstrap_request_context', {
      p_tenant_id: DEV_TENANT_ID,
      p_active_role: 'developer',
    });
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'life_stage_assess', expect.any(Object));
  });

  it('recognizes any ENVIRONMENT value containing "dev" or "sandbox" as a dev sandbox', async () => {
    process.env.ENVIRONMENT = 'staging-dev-box';
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

    const result = await assessLifeStage({});

    expect(result.ok).toBe(true);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('falls back to VITANA_ENV when ENVIRONMENT is unset', async () => {
    process.env.VITANA_ENV = 'sandbox';
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

    const result = await assessLifeStage({});
    expect(result.ok).toBe(true);
  });
});

describe('assessLifeStage — RPC parameter mapping', () => {
  it('passes explicit input fields through, applying the documented defaults for omitted fields', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });

    await assessLifeStage({ session_id: 'sess-42' }, 'jwt');

    expect(mockRpc).toHaveBeenCalledWith('life_stage_assess', {
      p_session_id: 'sess-42',
      p_include_goals: true,
      p_include_trajectory: false,
      p_context_window_days: 30,
    });
  });

  it('passes through all explicit non-default values unchanged', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });

    await assessLifeStage(
      { session_id: 'sess-99', include_goals: false, include_trajectory: true, context_window_days: 60 },
      'jwt'
    );

    expect(mockRpc).toHaveBeenCalledWith('life_stage_assess', {
      p_session_id: 'sess-99',
      p_include_goals: false,
      p_include_trajectory: true,
      p_context_window_days: 60,
    });
  });
});

describe('assessLifeStage — error handling and OASIS events', () => {
  it('on RPC error: maps to RPC_ERROR fallback and emits a d40.life_stage.assess.failed event', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db exploded' } });

    const result = await assessLifeStage({ session_id: 's1' }, 'jwt');

    expect(result).toEqual({ ok: false, error: 'RPC_ERROR', message: 'db exploded' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd40.life_stage.assess.failed',
        status: 'error',
        payload: expect.objectContaining({ error: 'db exploded', session_id: 's1' }),
      })
    );
  });

  it('propagates a specific RPC error code when present, instead of the fallback', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST999', message: 'weird' } });

    const result = await assessLifeStage({}, 'jwt');

    expect(result.error).toBe('PGRST999');
  });

  it('on success: returns the RPC data and emits a d40.life_stage.assessed event summarizing the result', async () => {
    const bundle = makeBundle({ phase: 'exploratory', stability_level: 'medium', transition_flag: true });
    const goalSet: GoalSet = {
      goals: [
        { id: 'g1', category: 'health_longevity', description: 'x', priority: 5, confidence: 80, horizon: 'medium_term', explicit: true, evidence_ids: [], created_at: 't', updated_at: 't', status: 'active' },
        { id: 'g2', category: 'learning_growth', description: 'y', priority: 3, confidence: 60, horizon: 'short_term', explicit: false, evidence_ids: [], created_at: 't', updated_at: 't', status: 'active' },
      ],
      coherence_score: 0.8,
      last_updated: 't',
    };
    const data = { ok: true, life_stage: bundle, goal_set: goalSet, rules_applied: ['r1', 'r2', 'r3'] };
    mockRpc.mockResolvedValue({ data, error: null });

    const result = await assessLifeStage({ session_id: 's7' }, 'jwt');

    expect(result).toBe(data);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd40.life_stage.assessed',
        status: 'success',
        payload: expect.objectContaining({
          session_id: 's7',
          rules_applied_count: 3,
          phase: 'exploratory',
          stability: 'medium',
          transition_flag: true,
          goal_count: 2,
        }),
      })
    );
  });

  it('defaults rules_applied_count and goal_count to 0 when the RPC response omits those fields', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });

    await assessLifeStage({}, 'jwt');

    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ rules_applied_count: 0, goal_count: 0 }),
      })
    );
  });

  it('catches a rejected RPC call, returns INTERNAL_ERROR, and emits a failed event', async () => {
    mockRpc.mockRejectedValue(new Error('socket hang up'));

    const result = await assessLifeStage({}, 'jwt');

    expect(result).toEqual({ ok: false, error: 'INTERNAL_ERROR', message: 'socket hang up' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd40.life_stage.assess.failed',
        status: 'error',
        payload: { error: 'socket hang up' },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// getCurrentLifeStage
// ---------------------------------------------------------------------------

describe('getCurrentLifeStage', () => {
  it('returns UNAUTHENTICATED with needs_refresh=true when unauthenticated', async () => {
    const result = await getCurrentLifeStage('s1');
    expect(result).toEqual({ ok: false, error: 'UNAUTHENTICATED', message: 'Authentication required', needs_refresh: true });
  });

  it('passes sessionId through as p_session_id, defaulting to null when omitted', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, needs_refresh: false }, error: null });

    await getCurrentLifeStage(undefined, 'jwt');
    expect(mockRpc).toHaveBeenCalledWith('life_stage_get_current', { p_session_id: null });

    await getCurrentLifeStage('sess-5', 'jwt');
    expect(mockRpc).toHaveBeenLastCalledWith('life_stage_get_current', { p_session_id: 'sess-5' });
  });

  it('bootstraps the dev identity in a dev sandbox with no authToken', async () => {
    process.env.ENVIRONMENT = 'dev';
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    mockRpc.mockResolvedValueOnce({ data: { ok: true, needs_refresh: false }, error: null });

    await getCurrentLifeStage();

    expect(mockRpc).toHaveBeenNthCalledWith(1, 'dev_bootstrap_request_context', {
      p_tenant_id: DEV_TENANT_ID,
      p_active_role: 'developer',
    });
  });

  it('on RPC error: returns needs_refresh=true and never emits an OASIS event', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });

    const result = await getCurrentLifeStage('s1', 'jwt');

    expect(result).toEqual({ ok: false, error: 'RPC_ERROR', message: 'timeout', needs_refresh: true });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('on success: returns the RPC data verbatim', async () => {
    const data = { ok: true, needs_refresh: false, last_assessed: '2026-07-01T00:00:00Z' };
    mockRpc.mockResolvedValue({ data, error: null });

    const result = await getCurrentLifeStage('s1', 'jwt');
    expect(result).toBe(data);
  });

  it('catches a thrown error, returns INTERNAL_ERROR with needs_refresh=true, and never emits an event', async () => {
    mockRpc.mockRejectedValue(new Error('boom'));

    const result = await getCurrentLifeStage('s1', 'jwt');

    expect(result).toEqual({ ok: false, error: 'INTERNAL_ERROR', message: 'boom', needs_refresh: true });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// overrideLifeStage
// ---------------------------------------------------------------------------

describe('overrideLifeStage', () => {
  it('returns UNAUTHENTICATED when unauthenticated', async () => {
    const result = await overrideLifeStage('assess-1', { phase: 'stabilizing' });
    expect(result).toEqual({ ok: false, error: 'UNAUTHENTICATED', message: 'Authentication required' });
  });

  it('calls life_stage_override with the assessment id and override payload', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, assessment_id: 'assess-1' }, error: null });

    await overrideLifeStage('assess-1', { phase: 'stabilizing' }, 'jwt');

    expect(mockRpc).toHaveBeenCalledWith('life_stage_override', {
      p_assessment_id: 'assess-1',
      p_override: { phase: 'stabilizing' },
    });
  });

  it('on RPC error: returns ok:false and never emits an OASIS event', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'nope' } });

    const result = await overrideLifeStage('assess-1', {}, 'jwt');

    expect(result).toEqual({ ok: false, error: 'RPC_ERROR', message: 'nope' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('on success: emits a d40.life_stage.overridden info event carrying the assessment id + override payload', async () => {
    const data = { ok: true, assessment_id: 'assess-1', override: { phase: 'stabilizing' } };
    mockRpc.mockResolvedValue({ data, error: null });

    const result = await overrideLifeStage('assess-1', { phase: 'stabilizing' }, 'jwt');

    expect(result).toBe(data);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd40.life_stage.overridden',
        status: 'info',
        payload: { assessment_id: 'assess-1', override: { phase: 'stabilizing' } },
      })
    );
  });

  it('catches a thrown error, returns INTERNAL_ERROR, and does NOT emit an OASIS event (unlike assessLifeStage)', async () => {
    mockRpc.mockRejectedValue(new Error('kaboom'));

    const result = await overrideLifeStage('assess-1', {}, 'jwt');

    expect(result).toEqual({ ok: false, error: 'INTERNAL_ERROR', message: 'kaboom' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// explainLifeStage
// ---------------------------------------------------------------------------

describe('explainLifeStage', () => {
  it('returns UNAUTHENTICATED when unauthenticated', async () => {
    const result = await explainLifeStage('assess-1');
    expect(result).toEqual({ ok: false, error: 'UNAUTHENTICATED', message: 'Authentication required' });
  });

  it('calls life_stage_explain with the assessment id', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });

    await explainLifeStage('assess-1', 'jwt');

    expect(mockRpc).toHaveBeenCalledWith('life_stage_explain', { p_assessment_id: 'assess-1' });
  });

  it('never emits an OASIS event on any path (success, RPC error, or thrown error)', async () => {
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });
    await explainLifeStage('a1', 'jwt');

    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    await explainLifeStage('a2', 'jwt');

    mockRpc.mockRejectedValueOnce(new Error('y'));
    await explainLifeStage('a3', 'jwt');

    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('on RPC error returns the mapped error; on a thrown error returns INTERNAL_ERROR', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'nf' } });
    expect(await explainLifeStage('a1', 'jwt')).toEqual({ ok: false, error: 'RPC_ERROR', message: 'nf' });

    mockRpc.mockRejectedValueOnce(new Error('crash'));
    expect(await explainLifeStage('a1', 'jwt')).toEqual({ ok: false, error: 'INTERNAL_ERROR', message: 'crash' });
  });
});

// ---------------------------------------------------------------------------
// detectGoal
// ---------------------------------------------------------------------------

describe('detectGoal', () => {
  const baseInput = { source: 'explicit' as const };

  it('returns UNAUTHENTICATED when unauthenticated', async () => {
    const result = await detectGoal(baseInput);
    expect(result).toEqual({ ok: false, error: 'UNAUTHENTICATED', message: 'Authentication required' });
  });

  it('passes message/session_id (or null) and source through to the RPC', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });

    await detectGoal({ source: 'conversation' }, 'jwt');
    expect(mockRpc).toHaveBeenCalledWith('life_stage_detect_goal', {
      p_message: null,
      p_session_id: null,
      p_source: 'conversation',
    });

    await detectGoal({ message: 'I want to run a marathon', session_id: 's9', source: 'explicit' }, 'jwt');
    expect(mockRpc).toHaveBeenLastCalledWith('life_stage_detect_goal', {
      p_message: 'I want to run a marathon',
      p_session_id: 's9',
      p_source: 'explicit',
    });
  });

  it('emits d40.goal.detected only when the response is ok AND a goal was returned', async () => {
    const goal = {
      id: 'goal-1',
      category: 'health_longevity',
      description: 'x',
      priority: 5,
      confidence: 90,
      horizon: 'long_term',
      explicit: true,
      evidence_ids: [],
      created_at: 't',
      updated_at: 't',
      status: 'active',
    };
    mockRpc.mockResolvedValue({ data: { ok: true, goal }, error: null });

    const result = await detectGoal({ source: 'explicit' }, 'jwt');

    expect(result).toEqual({ ok: true, goal });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd40.goal.detected',
        status: 'success',
        payload: expect.objectContaining({
          goal_id: 'goal-1',
          category: 'health_longevity',
          explicit: true,
          source: 'explicit',
        }),
      })
    );
  });

  it('does NOT emit an event when ok=true but no goal was detected', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });

    await detectGoal({ source: 'behavior' }, 'jwt');

    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('does NOT emit an event on ok=false', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'NO_GOAL' }, error: null });

    const result = await detectGoal({ source: 'behavior' }, 'jwt');

    expect(result).toEqual({ ok: false, error: 'NO_GOAL' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('on RPC error and thrown error, returns the mapped error shapes', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    expect(await detectGoal(baseInput, 'jwt')).toEqual({ ok: false, error: 'RPC_ERROR', message: 'x' });

    mockRpc.mockRejectedValueOnce(new Error('y'));
    expect(await detectGoal(baseInput, 'jwt')).toEqual({ ok: false, error: 'INTERNAL_ERROR', message: 'y' });
  });
});

// ---------------------------------------------------------------------------
// getGoals
// ---------------------------------------------------------------------------

describe('getGoals', () => {
  it('returns UNAUTHENTICATED when unauthenticated', async () => {
    expect(await getGoals()).toEqual({ ok: false, error: 'UNAUTHENTICATED', message: 'Authentication required' });
  });

  it('calls life_stage_get_goals with no params, returns the data verbatim, and never emits events', async () => {
    const data = { ok: true, goals: [] };
    mockRpc.mockResolvedValue({ data, error: null });

    const result = await getGoals('jwt');

    expect(mockRpc).toHaveBeenCalledWith('life_stage_get_goals');
    expect(result).toBe(data);
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('bootstraps the dev identity when called with no authToken in a dev sandbox', async () => {
    process.env.ENVIRONMENT = 'sandbox';
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    mockRpc.mockResolvedValueOnce({ data: { ok: true, goals: [] }, error: null });

    await getGoals();

    expect(mockRpc).toHaveBeenNthCalledWith(1, 'dev_bootstrap_request_context', {
      p_tenant_id: DEV_TENANT_ID,
      p_active_role: 'developer',
    });
  });

  it('maps RPC error and thrown error to the expected shapes', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    expect(await getGoals('jwt')).toEqual({ ok: false, error: 'RPC_ERROR', message: 'x' });

    mockRpc.mockRejectedValueOnce(new Error('y'));
    expect(await getGoals('jwt')).toEqual({ ok: false, error: 'INTERNAL_ERROR', message: 'y' });
  });
});

// ---------------------------------------------------------------------------
// updateGoal
// ---------------------------------------------------------------------------

describe('updateGoal', () => {
  it('returns UNAUTHENTICATED when unauthenticated', async () => {
    expect(await updateGoal('goal-1', { priority: 8 })).toEqual({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
  });

  it('calls life_stage_update_goal with the goal id and updates payload', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });

    await updateGoal('goal-1', { priority: 8, status: 'paused' }, 'jwt');

    expect(mockRpc).toHaveBeenCalledWith('life_stage_update_goal', {
      p_goal_id: 'goal-1',
      p_updates: { priority: 8, status: 'paused' },
    });
  });

  it('never emits an OASIS event, on success or failure', async () => {
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });
    await updateGoal('goal-1', {}, 'jwt');

    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    await updateGoal('goal-1', {}, 'jwt');

    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scoreTrajectory
// ---------------------------------------------------------------------------

describe('scoreTrajectory', () => {
  const baseInput = { actions: [{ action_id: 'a1', action: 'go for a walk', action_type: 'reminder' }] };

  it('returns UNAUTHENTICATED with zeroed coherence fields when unauthenticated', async () => {
    const result = await scoreTrajectory(baseInput);
    expect(result).toEqual({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication required',
      overall_coherence: 0,
      conflicts_detected: 0,
      multi_goal_opportunities: 0,
    });
  });

  it('returns SERVICE_UNAVAILABLE with zeroed coherence fields when the client cannot be built', async () => {
    delete process.env.SUPABASE_ANON_KEY;

    const result = await scoreTrajectory(baseInput, 'jwt');

    expect(result).toEqual({
      ok: false,
      error: 'SERVICE_UNAVAILABLE',
      message: 'Unable to connect to database',
      overall_coherence: 0,
      conflicts_detected: 0,
      multi_goal_opportunities: 0,
    });
  });

  it('passes actions/session_id/include_trade_offs through to the RPC, defaulting include_trade_offs to true', async () => {
    mockRpc.mockResolvedValue({
      data: { ok: true, overall_coherence: 0.9, conflicts_detected: 0, multi_goal_opportunities: 1 },
      error: null,
    });

    await scoreTrajectory(baseInput, 'jwt');

    expect(mockRpc).toHaveBeenCalledWith('life_stage_score_trajectory', {
      p_actions: baseInput.actions,
      p_session_id: null,
      p_include_trade_offs: true,
    });
  });

  it('on RPC error: returns zeroed coherence fields with the mapped error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'x' } });

    const result = await scoreTrajectory(baseInput, 'jwt');

    expect(result).toEqual({
      ok: false,
      error: 'RPC_ERROR',
      message: 'x',
      overall_coherence: 0,
      conflicts_detected: 0,
      multi_goal_opportunities: 0,
    });
  });

  it('on success: returns the RPC data verbatim', async () => {
    const data = { ok: true, overall_coherence: 0.72, conflicts_detected: 1, multi_goal_opportunities: 2, scored_actions: [] };
    mockRpc.mockResolvedValue({ data, error: null });

    const result = await scoreTrajectory(baseInput, 'jwt');
    expect(result).toBe(data);
  });

  it('catches a thrown error and returns INTERNAL_ERROR with zeroed coherence fields', async () => {
    mockRpc.mockRejectedValue(new Error('boom'));

    const result = await scoreTrajectory(baseInput, 'jwt');

    expect(result).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'boom',
      overall_coherence: 0,
      conflicts_detected: 0,
      multi_goal_opportunities: 0,
    });
  });

  it('never emits an OASIS event', async () => {
    mockRpc.mockResolvedValue({
      data: { ok: true, overall_coherence: 1, conflicts_detected: 0, multi_goal_opportunities: 0 },
      error: null,
    });

    await scoreTrajectory(baseInput, 'jwt');

    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ORB integration: getOrbLifeStageContext / processForOrb
// ---------------------------------------------------------------------------

describe('getOrbLifeStageContext', () => {
  it('returns null when getCurrentLifeStage is not ok', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'RPC_ERROR', needs_refresh: true }, error: null });

    const result = await getOrbLifeStageContext('s1', 'jwt');
    expect(result).toBeNull();
  });

  it('returns null when ok but life_stage is missing', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, needs_refresh: false }, error: null });

    const result = await getOrbLifeStageContext('s1', 'jwt');
    expect(result).toBeNull();
  });

  it('builds an ORB context + formatted prompt string from a full life stage bundle', async () => {
    const bundle = makeBundle();
    mockRpc.mockResolvedValue({ data: { ok: true, needs_refresh: false, life_stage: bundle }, error: null });

    const result = await getOrbLifeStageContext('s1', 'jwt');

    expect(result).not.toBeNull();
    expect(result!.orbContext.phase).toBe('optimizing');
    expect(result!.orbContext.primary_orientation).toBe('career_intensive'); // highest score of the two signals
    expect(result!.orbContext.recommendation_style).toBe('optimization');
    expect(result!.orbContext.commitment_level).toBe('high_commitment'); // optimizing + high stability
    expect(result!.orbContext.horizon_focus).toBe('long_term');
    expect(result!.context).toContain('Life Phase: optimizing (confidence: 85%)');
    expect(result!.context).toContain('Style: optimization');
  });
});

describe('processForOrb', () => {
  it('returns null when assessLifeStage is not ok', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'RPC_ERROR' }, error: null });

    const result = await processForOrb('s1', 'jwt');
    expect(result).toBeNull();
  });

  it('returns null when ok but life_stage is missing', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });

    const result = await processForOrb('s1', 'jwt');
    expect(result).toBeNull();
  });

  it('on success returns context/orbContext with assessmentId always undefined (no assessment id is threaded through yet)', async () => {
    const bundle = makeBundle({ phase: 'exploratory', transition_flag: true });
    mockRpc.mockResolvedValue({ data: { ok: true, life_stage: bundle }, error: null });

    const result = await processForOrb('s1', 'jwt');

    expect(result).not.toBeNull();
    expect(result!.assessmentId).toBeUndefined();
    expect(result!.orbContext.commitment_level).toBe('low_pressure'); // transition_flag=true forces low_pressure
    expect(result!.orbContext.recommendation_style).toBe('exploratory');
  });
});
