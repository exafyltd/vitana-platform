// VTID-01122 — unit tests for the D37 Health State, Energy & Capacity
// Awareness Engine (health-capacity-awareness-engine.ts).
//
// Unlike its D32 sibling, this engine is a thin RPC-dispatch layer: all the
// actual capacity computation happens in Postgres (`capacity_compute`,
// `capacity_get_current`, `capacity_override`, `capacity_filter_actions`
// RPCs). What belongs to *this* file — and what these tests cover — is:
//   1. Identity/auth resolution: authenticated (JWT bearer) vs. dev-sandbox
//      (service-role + `dev_bootstrap_request_context` RPC) vs. neither
//      (hard UNAUTHENTICATED refusal, no client ever created) — this is the
//      file's entire tenant-isolation surface (CLAUDE.md ALWAYS #28 /
//      NEVER #7): identity always flows through a per-call Supabase client
//      scoped to one bearer token or the fixed dev-sandbox identity, never
//      shared/cached across callers.
//   2. RPC parameter marshalling (defaults, `||` vs `??` coercion quirks).
//   3. OASIS event emission — which functions emit, on which branches,
//      with which payloads, and which functions emit nothing at all.
//   4. Error handling: RPC-returned errors vs. thrown exceptions, and the
//      response shape for each.
//   5. The ORB convenience wrappers and their "fail open" defaults.
//
// Mocking strategy: `@supabase/supabase-js`'s `createClient` is mocked to
// return one mutable, test-controlled client with a `rpc` jest.fn (same
// convention as test/services/orb-memory-bridge.test.ts / autopilot-
// validator.test.ts), plus jest.mock() for oasis-event-service.

let mockClient: { rpc: jest.Mock } | null = null;
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn((...args: any[]) => mockClient),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

import { createClient } from '@supabase/supabase-js';
import {
  computeCapacity,
  getCurrentCapacity,
  overrideCapacity,
  filterActions,
  getOrbCapacityContext,
  processMessageForOrb,
  isActionWithinCapacity,
  getCapacitySummary,
  CAPACITY_DISCLAIMER,
} from '../../src/services/health-capacity-awareness-engine';
import type { CapacityStateBundle } from '../../src/types/health-capacity-awareness';

const mockCreateClient = createClient as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.ENVIRONMENT;
  delete process.env.VITANA_ENV;
  delete process.env.SUPABASE_ANON_KEY;
}

function setDevSandbox() {
  process.env.ENVIRONMENT = 'dev-sandbox';
}

function setAnonKey() {
  process.env.SUPABASE_ANON_KEY = 'anon-key-mock';
}

beforeEach(() => {
  resetEnv();
  mockCreateClient.mockClear();
  mockEmitOasisEvent.mockClear();
  mockEmitOasisEvent.mockResolvedValue({ ok: true });
  mockClient = { rpc: jest.fn().mockResolvedValue({ data: null, error: null }) };
});

function bootstrapOk() {
  return { data: null, error: null };
}

function capacityBundle(overrides: Partial<CapacityStateBundle> = {}): CapacityStateBundle {
  return {
    energy_state: 'moderate',
    energy_score: 60,
    capacity_envelope: {
      physical: 60,
      cognitive: 60,
      emotional: 60,
      overall: 60,
      confidence: 70,
      limiting_dimension: null,
    },
    context_tags: ['moderate_ok'],
    min_intensity: 'light',
    max_intensity: 'moderate',
    signals: [],
    confidence: 70,
    decay_at: '2026-07-27T11:00:00.000Z',
    generated_at: '2026-07-27T10:00:00.000Z',
    disclaimer: CAPACITY_DISCLAIMER,
    ...overrides,
  };
}

function rpcSequence(...results: Array<{ data: any; error: any }>) {
  const impl = jest.fn();
  for (const r of results) impl.mockResolvedValueOnce(r);
  mockClient!.rpc = impl;
  return impl;
}

// ---------------------------------------------------------------------------
// 1. Identity / auth resolution — the tenant-isolation surface
// ---------------------------------------------------------------------------

describe('identity resolution — computeCapacity', () => {
  it('refuses with UNAUTHENTICATED and never creates a Supabase client when there is no authToken and not dev-sandbox', async () => {
    const res = await computeCapacity({ message: 'hi' });
    expect(res).toEqual({ ok: false, error: 'UNAUTHENTICATED', message: 'Authentication required for capacity computation' });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns SERVICE_UNAVAILABLE (not UNAUTHENTICATED) when an authToken is given but SUPABASE_ANON_KEY is unset', async () => {
    const res = await computeCapacity({ message: 'hi' }, 'user-jwt-token');
    expect(res).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE', message: 'Unable to connect to database' });
  });

  it('uses a per-call authenticated client with the bearer token in headers, and never calls the dev-sandbox bootstrap RPC', async () => {
    setAnonKey();
    rpcSequence({ data: { ok: true, capacity_state: capacityBundle() }, error: null });
    const res = await computeCapacity({ message: 'hi' }, 'user-jwt-abc');
    expect(res.ok).toBe(true);

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const [, , opts] = mockCreateClient.mock.calls[0];
    expect(opts.global.headers.Authorization).toBe('Bearer user-jwt-abc');

    const rpcCalls = mockClient!.rpc.mock.calls.map((c) => c[0]);
    expect(rpcCalls).not.toContain('dev_bootstrap_request_context');
    expect(rpcCalls).toEqual(['capacity_compute']);
  });

  it('two different bearer tokens each get their own client with their own (never mixed) Authorization header', async () => {
    setAnonKey();
    mockClient!.rpc = jest.fn().mockResolvedValue({ data: { ok: true, capacity_state: capacityBundle() }, error: null });
    await computeCapacity({}, 'token-for-user-A');
    await computeCapacity({}, 'token-for-user-B');

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockCreateClient.mock.calls[0][2].global.headers.Authorization).toBe('Bearer token-for-user-A');
    expect(mockCreateClient.mock.calls[1][2].global.headers.Authorization).toBe('Bearer token-for-user-B');
  });

  it('returns SERVICE_UNAVAILABLE when in dev-sandbox but the service-role key is unset', async () => {
    setDevSandbox();
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await computeCapacity({ message: 'hi' });
    expect(res).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE', message: 'Unable to connect to database' });
  });

  it('dev-sandbox path: no headers/Authorization on the client, bootstraps DEV identity via RPC before capacity_compute', async () => {
    setDevSandbox();
    rpcSequence(bootstrapOk(), { data: { ok: true, capacity_state: capacityBundle() }, error: null });

    const res = await computeCapacity({ message: 'hi' });
    expect(res.ok).toBe(true);

    const [, , opts] = mockCreateClient.mock.calls[0];
    expect(opts.global).toBeUndefined(); // service client never sets an Authorization header

    const rpcCalls = mockClient!.rpc.mock.calls;
    expect(rpcCalls[0][0]).toBe('dev_bootstrap_request_context');
    expect(rpcCalls[0][1]).toEqual({
      p_tenant_id: '00000000-0000-0000-0000-000000000001',
      p_active_role: 'developer',
    });
    expect(rpcCalls[1][0]).toBe('capacity_compute');
  });

  it('a failing (non-fatal) dev-sandbox bootstrap RPC does not block the subsequent capacity_compute call', async () => {
    setDevSandbox();
    rpcSequence(
      { data: null, error: { message: 'bootstrap failed' } },
      { data: { ok: true, capacity_state: capacityBundle() }, error: null }
    );
    const res = await computeCapacity({ message: 'hi' });
    expect(res.ok).toBe(true);
    expect(mockClient!.rpc).toHaveBeenCalledTimes(2);
  });
});

describe('identity resolution — applies identically to getCurrentCapacity / overrideCapacity / filterActions', () => {
  it.each([
    ['getCurrentCapacity', () => getCurrentCapacity()],
    ['overrideCapacity', () => overrideCapacity({ energy_state: 'low' })],
    ['filterActions', () => filterActions({ actions: [] })],
  ])('%s refuses UNAUTHENTICATED with no client created when neither authToken nor dev-sandbox', async (_name, call) => {
    const res: any = await call();
    expect(res.ok).toBe(false);
    expect(res.error).toBe('UNAUTHENTICATED');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. computeCapacity — RPC param marshalling + response handling
// ---------------------------------------------------------------------------

describe('computeCapacity — RPC params + response handling', () => {
  beforeEach(() => setAnonKey());

  it('marshals every optional field to null when omitted, and include_wearables defaults to false', async () => {
    rpcSequence({ data: { ok: true, capacity_state: capacityBundle() }, error: null });
    await computeCapacity({}, 'tok');
    expect(mockClient!.rpc).toHaveBeenCalledWith('capacity_compute', {
      p_message: null,
      p_session_id: null,
      p_self_reported_energy: null,
      p_self_reported_note: null,
      p_include_wearables: false,
    });
  });

  it('passes through explicitly-provided fields, including include_wearables=true', async () => {
    rpcSequence({ data: { ok: true, capacity_state: capacityBundle() }, error: null });
    await computeCapacity(
      {
        message: 'feeling tired',
        session_id: '11111111-1111-1111-1111-111111111111',
        self_reported_energy: 'low',
        self_reported_note: 'long day',
        include_wearables: true,
      },
      'tok'
    );
    expect(mockClient!.rpc).toHaveBeenCalledWith('capacity_compute', {
      p_message: 'feeling tired',
      p_session_id: '11111111-1111-1111-1111-111111111111',
      p_self_reported_energy: 'low',
      p_self_reported_note: 'long day',
      p_include_wearables: true,
    });
  });

  it('returns ok:false with the RPC error code/message and emits d37.capacity.compute.failed on an RPC-level error', async () => {
    rpcSequence({ data: null, error: { code: 'PGRST100', message: 'bad request' } });
    const res = await computeCapacity({ session_id: 's-1' }, 'tok');
    expect(res).toEqual({ ok: false, error: 'PGRST100', message: 'bad request' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd37.capacity.compute.failed',
        status: 'error',
        payload: expect.objectContaining({ error: 'bad request', session_id: 's-1' }),
      })
    );
  });

  it('defaults the error code to RPC_ERROR when the RPC error has no code', async () => {
    rpcSequence({ data: null, error: { message: 'unknown failure' } });
    const res = await computeCapacity({}, 'tok');
    expect(res.error).toBe('RPC_ERROR');
  });

  it('on success, emits d37.capacity.computed with the state/tags summary', async () => {
    const bundle = capacityBundle({ energy_state: 'moderate', energy_score: 55, context_tags: ['moderate_ok'] });
    rpcSequence({ data: { ok: true, capacity_state: bundle }, error: null });
    await computeCapacity({ session_id: 's-2' }, 'tok');
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd37.capacity.computed',
        status: 'success',
        payload: expect.objectContaining({
          session_id: 's-2',
          energy_state: 'moderate',
          energy_score: 55,
          context_tags: ['moderate_ok'],
        }),
      })
    );
  });

  it('ALSO emits d37.low_energy.detected as a second event when energy_state is "low"', async () => {
    const bundle = capacityBundle({ energy_state: 'low', energy_score: 20 });
    rpcSequence({ data: { ok: true, capacity_state: bundle }, error: null });
    await computeCapacity({}, 'tok');
    const types = mockEmitOasisEvent.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['d37.capacity.computed', 'd37.low_energy.detected']);
  });

  it.each(['moderate', 'high', 'unknown'])('does NOT emit d37.low_energy.detected when energy_state is "%s"', async (state) => {
    const bundle = capacityBundle({ energy_state: state as any });
    rpcSequence({ data: { ok: true, capacity_state: bundle }, error: null });
    await computeCapacity({}, 'tok');
    const types = mockEmitOasisEvent.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['d37.capacity.computed']);
  });

  it('catches a thrown/rejected RPC call, emits d37.capacity.compute.failed WITHOUT session_id in the payload, and returns INTERNAL_ERROR', async () => {
    mockClient!.rpc = jest.fn().mockRejectedValue(new Error('connection reset'));
    const res = await computeCapacity({ session_id: 'should-not-appear' }, 'tok');
    expect(res).toEqual({ ok: false, error: 'INTERNAL_ERROR', message: 'connection reset' });
    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.type).toBe('d37.capacity.compute.failed');
    // Regression note: unlike the RPC-error branch above, the catch-block
    // payload only carries `error`, never `session_id`.
    expect(call.payload).toEqual({ error: 'connection reset' });
  });
});

// ---------------------------------------------------------------------------
// 3. getCurrentCapacity — pass-through, no OASIS events at all
// ---------------------------------------------------------------------------

describe('getCurrentCapacity', () => {
  beforeEach(() => setAnonKey());

  it('sends p_session_id=null when sessionId is omitted, and null explicitly maps through when given', async () => {
    rpcSequence({ data: { ok: true, capacity_state: capacityBundle() }, error: null });
    await getCurrentCapacity(undefined, 'tok');
    expect(mockClient!.rpc).toHaveBeenCalledWith('capacity_get_current', { p_session_id: null });

    rpcSequence({ data: { ok: true, capacity_state: capacityBundle() }, error: null });
    await getCurrentCapacity('sess-42', 'tok');
    expect(mockClient!.rpc).toHaveBeenCalledWith('capacity_get_current', { p_session_id: 'sess-42' });
  });

  it('returns result.data verbatim on success', async () => {
    const payload = { ok: true, capacity_state: capacityBundle(), has_override: true, override_expires_at: '2026-07-27T12:00:00Z' };
    rpcSequence({ data: payload, error: null });
    const res = await getCurrentCapacity(undefined, 'tok');
    expect(res).toEqual(payload);
  });

  it('returns the RPC error shape on failure', async () => {
    rpcSequence({ data: null, error: { code: 'E1', message: 'boom' } });
    const res = await getCurrentCapacity(undefined, 'tok');
    expect(res).toEqual({ ok: false, error: 'E1', message: 'boom' });
  });

  it('returns INTERNAL_ERROR when the RPC call throws', async () => {
    mockClient!.rpc = jest.fn().mockRejectedValue(new Error('network down'));
    const res = await getCurrentCapacity(undefined, 'tok');
    expect(res).toEqual({ ok: false, error: 'INTERNAL_ERROR', message: 'network down' });
  });

  it('never emits any OASIS event, on success or failure', async () => {
    rpcSequence({ data: { ok: true, capacity_state: capacityBundle() }, error: null });
    await getCurrentCapacity(undefined, 'tok');
    rpcSequence({ data: null, error: { message: 'x' } });
    await getCurrentCapacity(undefined, 'tok');
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. overrideCapacity
// ---------------------------------------------------------------------------

describe('overrideCapacity', () => {
  beforeEach(() => setAnonKey());

  it('defaults note to null and duration_minutes to 60 when omitted', async () => {
    rpcSequence({ data: { ok: true, previous_state: 'moderate' }, error: null });
    await overrideCapacity({ energy_state: 'low' }, 'tok');
    expect(mockClient!.rpc).toHaveBeenCalledWith('capacity_override', {
      p_energy_state: 'low',
      p_note: null,
      p_duration_minutes: 60,
    });
  });

  it('passes through an explicit note/duration_minutes', async () => {
    rpcSequence({ data: { ok: true }, error: null });
    await overrideCapacity({ energy_state: 'high', note: 'feeling great', duration_minutes: 120 }, 'tok');
    expect(mockClient!.rpc).toHaveBeenCalledWith('capacity_override', {
      p_energy_state: 'high',
      p_note: 'feeling great',
      p_duration_minutes: 120,
    });
  });

  it('QUIRK: duration_minutes=0 falls back to 60 because the source uses `||`, not `??`', async () => {
    rpcSequence({ data: { ok: true }, error: null });
    await overrideCapacity({ energy_state: 'low', duration_minutes: 0 }, 'tok');
    expect(mockClient!.rpc).toHaveBeenCalledWith(
      'capacity_override',
      expect.objectContaining({ p_duration_minutes: 60 })
    );
  });

  it('on success, emits d37.capacity.overridden with previous/new state, expiry, and note', async () => {
    rpcSequence({
      data: { ok: true, previous_state: 'moderate', new_state: 'low', expires_at: '2026-07-27T12:00:00Z' },
      error: null,
    });
    await overrideCapacity({ energy_state: 'low', note: 'napping soon' }, 'tok');
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd37.capacity.overridden',
        status: 'info',
        payload: {
          previous_state: 'moderate',
          new_state: 'low',
          expires_at: '2026-07-27T12:00:00Z',
          note: 'napping soon',
        },
      })
    );
  });

  it('on RPC error, returns the error shape and does NOT emit any OASIS event', async () => {
    rpcSequence({ data: null, error: { code: 'E2', message: 'bad state' } });
    const res = await overrideCapacity({ energy_state: 'low' }, 'tok');
    expect(res).toEqual({ ok: false, error: 'E2', message: 'bad state' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('returns INTERNAL_ERROR (no OASIS event) when the RPC call throws', async () => {
    mockClient!.rpc = jest.fn().mockRejectedValue(new Error('timeout'));
    const res = await overrideCapacity({ energy_state: 'low' }, 'tok');
    expect(res).toEqual({ ok: false, error: 'INTERNAL_ERROR', message: 'timeout' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. filterActions
// ---------------------------------------------------------------------------

describe('filterActions', () => {
  beforeEach(() => setAnonKey());

  it('respect_capacity defaults to true (via `??`, so an explicit false is honored, unlike overrideCapacity duration)', async () => {
    rpcSequence({ data: { ok: true, filtered_actions: [] }, error: null });
    await filterActions({ actions: [{ action: 'run', intensity: 'high' }] }, 'tok');
    expect(mockClient!.rpc).toHaveBeenCalledWith('capacity_filter_actions', {
      p_actions: [{ action: 'run', intensity: 'high' }],
      p_respect_capacity: true,
    });

    rpcSequence({ data: { ok: true, filtered_actions: [] }, error: null });
    await filterActions({ actions: [], respect_capacity: false }, 'tok');
    expect(mockClient!.rpc).toHaveBeenCalledWith('capacity_filter_actions', {
      p_actions: [],
      p_respect_capacity: false,
    });
  });

  it('emits d37.actions.filtered ONLY when blocked_count > 0, with the blocked/recommended/energy_state summary', async () => {
    rpcSequence({
      data: { ok: true, filtered_actions: [], blocked_count: 2, recommended_count: 1, capacity_state: capacityBundle({ energy_state: 'low' }) },
      error: null,
    });
    await filterActions({ actions: [] }, 'tok');
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd37.actions.filtered',
        payload: { blocked_count: 2, recommended_count: 1, energy_state: 'low' },
      })
    );
  });

  it.each([0, undefined])('does NOT emit d37.actions.filtered when blocked_count is %p', async (blockedCount) => {
    rpcSequence({ data: { ok: true, filtered_actions: [], blocked_count: blockedCount, recommended_count: 3 }, error: null });
    await filterActions({ actions: [] }, 'tok');
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('returns the RPC error shape on failure and does not emit an event', async () => {
    rpcSequence({ data: null, error: { code: 'E3', message: 'filter failed' } });
    const res = await filterActions({ actions: [] }, 'tok');
    expect(res).toEqual({ ok: false, error: 'E3', message: 'filter failed' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('returns INTERNAL_ERROR when the RPC call throws', async () => {
    mockClient!.rpc = jest.fn().mockRejectedValue(new Error('rpc exploded'));
    const res = await filterActions({ actions: [] }, 'tok');
    expect(res).toEqual({ ok: false, error: 'INTERNAL_ERROR', message: 'rpc exploded' });
  });
});

// ---------------------------------------------------------------------------
// 6. ORB integration wrappers
// ---------------------------------------------------------------------------

describe('getOrbCapacityContext', () => {
  beforeEach(() => setAnonKey());

  it('returns null (not an error) when getCurrentCapacity is not ok', async () => {
    rpcSequence({ data: null, error: { message: 'nope' } });
    const res = await getOrbCapacityContext(undefined, 'tok');
    expect(res).toBeNull();
  });

  it('returns null when ok but capacity_state is missing', async () => {
    rpcSequence({ data: { ok: true }, error: null });
    const res = await getOrbCapacityContext(undefined, 'tok');
    expect(res).toBeNull();
  });

  it('converts a capacity_state bundle into orbContext hints and a formatted prompt block', async () => {
    const bundle = capacityBundle({
      energy_state: 'low',
      max_intensity: 'restorative',
      capacity_envelope: { physical: 20, cognitive: 20, emotional: 20, overall: 20, confidence: 80, limiting_dimension: 'physical' },
    });
    rpcSequence({ data: { ok: true, capacity_state: bundle }, error: null });
    const res = await getOrbCapacityContext(undefined, 'tok');
    expect(res).not.toBeNull();
    expect(res!.orbContext.intensity_hint).toBe('restorative');
    expect(res!.orbContext.commitment_hint).toBe('avoid_new'); // energy_state === 'low'
    expect(res!.orbContext.social_hint).toBe('alone_time'); // emotional < 30
    expect(res!.context).toContain('## Current User Capacity (D37 Health Awareness)');
    expect(res!.context).toContain('DO NOT suggest high-energy activities');
  });

  it.each([
    [{ energy_state: 'high', cognitive: 75 }, 'open_to_growth'],
    [{ energy_state: 'moderate', cognitive: 40 }, 'minimize'],
    [{ energy_state: 'moderate', cognitive: 60 }, 'normal'],
  ])('commitment_hint derivation: %p -> %s', async (opts, expected) => {
    const bundle = capacityBundle({
      energy_state: opts.energy_state as any,
      capacity_envelope: { physical: 60, cognitive: opts.cognitive, emotional: 60, overall: 60, confidence: 70, limiting_dimension: null },
    });
    rpcSequence({ data: { ok: true, capacity_state: bundle }, error: null });
    const res = await getOrbCapacityContext(undefined, 'tok');
    expect(res!.orbContext.commitment_hint).toBe(expected);
  });
});

describe('processMessageForOrb', () => {
  beforeEach(() => setAnonKey());

  it('calls computeCapacity with include_wearables always false, forwarding message/session_id', async () => {
    rpcSequence({ data: { ok: true, capacity_state: capacityBundle() }, error: null });
    await processMessageForOrb('I am exhausted', 'sess-9', 'tok');
    expect(mockClient!.rpc).toHaveBeenCalledWith('capacity_compute', {
      p_message: 'I am exhausted',
      p_session_id: 'sess-9',
      p_self_reported_energy: null,
      p_self_reported_note: null,
      p_include_wearables: false,
    });
  });

  it('returns null when computeCapacity fails or returns no capacity_state', async () => {
    rpcSequence({ data: null, error: { message: 'fail' } });
    const res = await processMessageForOrb('hello', undefined, 'tok');
    expect(res).toBeNull();
  });

  it('returns a formatted context on success', async () => {
    rpcSequence({ data: { ok: true, capacity_state: capacityBundle({ energy_state: 'high', max_intensity: 'high' }) }, error: null });
    const res = await processMessageForOrb('feeling great', undefined, 'tok');
    expect(res).not.toBeNull();
    expect(res!.orbContext.energy_state).toBe('high');
    expect(res!.context).toContain('Growth and exploration activities are OK');
  });
});

// ---------------------------------------------------------------------------
// 7. isActionWithinCapacity — "fail open" defaults
// ---------------------------------------------------------------------------

describe('isActionWithinCapacity', () => {
  beforeEach(() => setAnonKey());

  it('delegates to filterActions with a single-action, respect_capacity=true request', async () => {
    rpcSequence({
      data: { ok: true, filtered_actions: [{ action: 'run', intensity: 'high', capacity_fit: 'good', confidence: 70, recommended: true, reason: 'fine' }] },
      error: null,
    });
    await isActionWithinCapacity('run', 'high', 'tok');
    expect(mockClient!.rpc).toHaveBeenCalledWith('capacity_filter_actions', {
      p_actions: [{ action: 'run', intensity: 'high' }],
      p_respect_capacity: true,
    });
  });

  it('returns the first filtered action\'s recommended/reason on success', async () => {
    rpcSequence({
      data: { ok: true, filtered_actions: [{ action: 'run', intensity: 'high', capacity_fit: 'exceeds', confidence: 70, recommended: false, reason: 'too intense right now' }] },
      error: null,
    });
    const res = await isActionWithinCapacity('run', 'high', 'tok');
    expect(res).toEqual({ ok: true, recommended: false, reason: 'too intense right now' });
  });

  it('DEFAULTS TO ALLOWING (recommended: true) when the capacity check itself fails — a "fail open" behavior worth flagging against the engine\'s own "err on the side of rest and safety" spec constraint', async () => {
    rpcSequence({ data: null, error: { message: 'db down' } });
    const res = await isActionWithinCapacity('run', 'high', 'tok');
    expect(res).toEqual({ ok: false, recommended: true, reason: 'Unable to check capacity' });
  });

  it('also fails open when filtered_actions comes back empty', async () => {
    rpcSequence({ data: { ok: true, filtered_actions: [] }, error: null });
    const res = await isActionWithinCapacity('run', 'high', 'tok');
    expect(res).toEqual({ ok: false, recommended: true, reason: 'Unable to check capacity' });
  });

  it('still fails open (reason "Unable to check capacity") when the underlying RPC throws, because filterActions() itself never propagates — it always resolves ok:false', async () => {
    // Note: filterActions() has its own internal try/catch, so a thrown RPC
    // never reaches isActionWithinCapacity's own catch block — that catch
    // (reason: 'Error checking capacity') is unreachable through the public
    // API as currently composed; this documents the actually-reachable path.
    mockClient!.rpc = jest.fn().mockRejectedValue(new Error('crash'));
    const res = await isActionWithinCapacity('run', 'high', 'tok');
    expect(res).toEqual({ ok: false, recommended: true, reason: 'Unable to check capacity' });
  });
});

// ---------------------------------------------------------------------------
// 8. getCapacitySummary
// ---------------------------------------------------------------------------

describe('getCapacitySummary', () => {
  beforeEach(() => setAnonKey());

  it('maps a successful capacity_state onto the summary shape, defaulting has_override to false when absent', async () => {
    rpcSequence({
      data: { ok: true, capacity_state: capacityBundle({ energy_state: 'high', max_intensity: 'high', context_tags: ['high_capacity_ok'] }) },
      error: null,
    });
    const res = await getCapacitySummary('tok');
    expect(res).toEqual({
      ok: true,
      energy_state: 'high',
      max_intensity: 'high',
      context_tags: ['high_capacity_ok'],
      has_override: false,
    });
  });

  it('preserves has_override:true when present', async () => {
    rpcSequence({ data: { ok: true, capacity_state: capacityBundle(), has_override: true }, error: null });
    const res = await getCapacitySummary('tok');
    expect(res.has_override).toBe(true);
  });

  it('returns a safe-default failure shape (moderate/unknown/no override), surfacing getCurrentCapacity\'s own error CODE (not its message)', async () => {
    rpcSequence({ data: null, error: { code: 'NOT_FOUND', message: 'no row for user' } });
    const res = await getCapacitySummary('tok');
    expect(res).toEqual({
      ok: false,
      energy_state: 'unknown',
      max_intensity: 'moderate',
      context_tags: [],
      has_override: false,
      error: 'NOT_FOUND',
    });
  });

  it('falls back to RPC_ERROR (getCurrentCapacity\'s own default) when the failure carries no code — never reaches getCapacitySummary\'s own "Unable to get capacity" fallback text', async () => {
    rpcSequence({ data: null, error: {} });
    const res = await getCapacitySummary('tok');
    expect(res.error).toBe('RPC_ERROR');
  });

  it('catches a thrown error and returns the same safe-default shape, with error set to getCurrentCapacity\'s own INTERNAL_ERROR code (not the raw message)', async () => {
    mockClient!.rpc = jest.fn().mockRejectedValue(new Error('kaboom'));
    const res = await getCapacitySummary('tok');
    expect(res).toEqual({
      ok: false,
      energy_state: 'unknown',
      max_intensity: 'moderate',
      context_tags: [],
      has_override: false,
      error: 'INTERNAL_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Tenant / user isolation (CLAUDE.md ALWAYS #28 / NEVER #7)
// ---------------------------------------------------------------------------

describe('tenant/user isolation', () => {
  it('production-like environment (no ENVIRONMENT/VITANA_ENV, no authToken) is refused outright — never silently falls back to the dev-sandbox identity', async () => {
    const res = await computeCapacity({ message: 'hi' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('UNAUTHENTICATED');
    expect(mockCreateClient).not.toHaveBeenCalled();
    // No RPC of any kind — in particular, never the fixed DEV_IDENTITY bootstrap.
    expect(mockClient!.rpc).not.toHaveBeenCalled();
  });

  it('the dev-sandbox bootstrap always targets the fixed sandbox tenant, never a caller-supplied one (there is no such parameter)', async () => {
    setDevSandbox();
    rpcSequence(bootstrapOk(), { data: { ok: true, capacity_state: capacityBundle() }, error: null });
    await computeCapacity({});
    expect(mockClient!.rpc.mock.calls[0][1]).toEqual({
      p_tenant_id: '00000000-0000-0000-0000-000000000001',
      p_active_role: 'developer',
    });
  });

  it('concurrent calls for two different bearer tokens each resolve through their own isolated client (no shared/cached client across users)', async () => {
    setAnonKey();
    mockClient!.rpc = jest.fn().mockResolvedValue({ data: { ok: true, capacity_state: capacityBundle() }, error: null });
    await Promise.all([
      computeCapacity({ message: 'from user A' }, 'jwt-user-A'),
      computeCapacity({ message: 'from user B' }, 'jwt-user-B'),
    ]);
    const headers = mockCreateClient.mock.calls.map((c) => c[2].global.headers.Authorization);
    expect(headers).toEqual(expect.arrayContaining(['Bearer jwt-user-A', 'Bearer jwt-user-B']));
    expect(new Set(headers).size).toBe(2); // never collapsed/reused across the two callers
  });
});
