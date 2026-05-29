/**
 * VTID-02924 (B0e.4) — capability-awareness-service tests.
 *
 * Direct mapping to the 8 acceptance checks the user locked. The
 * service is the ONLY mutation entrypoint, so test coverage at this
 * boundary IS the acceptance contract.
 *
 * #1 Selection alone does not mutate (proven indirectly here by
 *    asserting the service requires explicit ingest call to advance).
 * #2 Event ingestion advances awareness through allowed transitions only.
 * #3 Duplicate idempotency key does not double-advance.
 * #4 Tenant/user mismatch cannot update another user's awareness.
 * #5 Terminal dismissed / mastered respected unless explicit allowed event.
 * #6 Continuation accepted/dismissed events linkable to decisionId.
 * #7 (Command Hub stays read-only — separate structural test.)
 * #8 Telemetry names from central modules only.
 */

import {
  createCapabilityAwarenessService,
  type AwarenessState,
  type IngestCapabilityEventArgs,
  type IngestResult,
} from '../../../src/services/capability-awareness/capability-awareness-service';
import {
  CAPABILITY_AWARENESS_INTRODUCED,
  CAPABILITY_AWARENESS_SEEN,
  CAPABILITY_AWARENESS_TRIED,
  CAPABILITY_AWARENESS_COMPLETED,
  CAPABILITY_AWARENESS_DISMISSED,
  CAPABILITY_AWARENESS_MASTERED,
  CAPABILITY_AWARENESS_TOPIC_REGISTRY,
  AWARENESS_EVENT_TO_TOPIC,
  type CapabilityAwarenessEventName,
} from '../../../src/services/assistant-continuation/telemetry';

// ---------------------------------------------------------------------------
// Mock RPC harness — simulates advance_capability_awareness's behavior
// ---------------------------------------------------------------------------

interface MockRpcState {
  // Latest state per (tenant::user::capability).
  states: Map<string, AwarenessState>;
  // Idempotency keys already seen per (tenant::user::idemKey).
  seen: Map<string, { previous: AwarenessState; next: AwarenessState; eventId: string }>;
  // Capability keys that exist in system_capabilities.
  capabilities: Set<string>;
  rpcCalls: Array<Record<string, unknown>>;
}

function stateKey(t: string, u: string, c: string) {
  return `${t}::${u}::${c}`;
}
function idemKey(t: string, u: string, k: string) {
  return `${t}::${u}::${k}`;
}

function transitionAllowed(prev: AwarenessState, event: CapabilityAwarenessEventName): AwarenessState | null {
  if (prev === 'unknown') {
    if (['introduced', 'seen', 'tried', 'completed', 'dismissed'].includes(event)) return event as AwarenessState;
  }
  if (prev === 'introduced') {
    if (['seen', 'tried', 'completed', 'dismissed'].includes(event)) return event as AwarenessState;
  }
  if (prev === 'seen') {
    if (['tried', 'completed', 'dismissed'].includes(event)) return event as AwarenessState;
  }
  if (prev === 'tried') {
    if (['completed', 'dismissed'].includes(event)) return event as AwarenessState;
  }
  if (prev === 'completed') {
    if (['mastered', 'dismissed'].includes(event)) return event as AwarenessState;
  }
  if (prev === 'dismissed') {
    if (event === 'introduced') return 'introduced';
  }
  // mastered → terminal
  return null;
}

function buildMockSupabase(initial: Partial<MockRpcState> = {}) {
  const state: MockRpcState = {
    states: initial.states ?? new Map(),
    seen: initial.seen ?? new Map(),
    capabilities: initial.capabilities ?? new Set([
      'life_compass', 'diary_entry', 'reminders', 'activity_match',
    ]),
    rpcCalls: [],
  };

  return {
    state,
    client: {
      async rpc(fnName: string, params: Record<string, unknown>) {
        state.rpcCalls.push({ fnName, ...params });
        if (fnName !== 'advance_capability_awareness') {
          return { data: null, error: { message: 'unknown rpc' } };
        }
        const tenantId = params.p_tenant_id as string;
        const userId = params.p_user_id as string;
        const cap = params.p_capability_key as string;
        const eventName = params.p_event_name as CapabilityAwarenessEventName;
        const idemK = params.p_idempotency_key as string;
        // Unknown capability gate.
        if (!state.capabilities.has(cap)) {
          return { data: { ok: false, reason: 'unknown_capability' }, error: null };
        }
        // Idempotency short-circuit.
        const seenK = idemKey(tenantId, userId, idemK);
        const seenEntry = state.seen.get(seenK);
        if (seenEntry) {
          return {
            data: {
              ok: true,
              idempotent: true,
              previous_state: seenEntry.previous,
              next_state: seenEntry.next,
              event_id: seenEntry.eventId,
            },
            error: null,
          };
        }
        // Compute next state.
        const sKey = stateKey(tenantId, userId, cap);
        const prev: AwarenessState = state.states.get(sKey) ?? 'unknown';
        const next = transitionAllowed(prev, eventName);
        if (!next) {
          return {
            data: {
              ok: false,
              reason: 'transition_not_allowed',
              previous_state: prev,
              attempted_event: eventName,
            },
            error: null,
          };
        }
        const eventId = `evt-${state.rpcCalls.length}`;
        state.seen.set(seenK, { previous: prev, next, eventId });
        state.states.set(sKey, next);
        return {
          data: { ok: true, idempotent: false, previous_state: prev, next_state: next, event_id: eventId },
          error: null,
        };
      },
    },
  };
}

function noOpEmit() {
  return jest.fn(async () => undefined);
}

function args(over: Partial<IngestCapabilityEventArgs> = {}): IngestCapabilityEventArgs {
  return {
    tenantId: 't1',
    userId: 'u1',
    capabilityKey: 'life_compass',
    eventName: 'introduced',
    idempotencyKey: 'idem-1',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Acceptance check #2 — allowed transitions only
// ---------------------------------------------------------------------------

describe('B0e.4 acceptance check #2: allowed transitions only', () => {
  const allowed: Array<[AwarenessState, CapabilityAwarenessEventName, AwarenessState]> = [
    ['unknown',    'introduced', 'introduced'],
    ['unknown',    'seen',       'seen'],
    ['unknown',    'tried',      'tried'],
    ['unknown',    'completed',  'completed'],
    ['unknown',    'dismissed',  'dismissed'],
    ['introduced', 'seen',       'seen'],
    ['introduced', 'tried',      'tried'],
    ['introduced', 'completed',  'completed'],
    ['introduced', 'dismissed',  'dismissed'],
    ['seen',       'tried',      'tried'],
    ['seen',       'completed',  'completed'],
    ['seen',       'dismissed',  'dismissed'],
    ['tried',      'completed',  'completed'],
    ['tried',      'dismissed',  'dismissed'],
    ['completed',  'mastered',   'mastered'],
    ['completed',  'dismissed',  'dismissed'],
    ['dismissed',  'introduced', 'introduced'], // explicit reopen
  ];

  it.each(allowed)(
    'state=%s + event=%s → %s',
    async (from, event, to) => {
      const sb = buildMockSupabase({
        states: new Map([[stateKey('t1', 'u1', 'life_compass'), from]]),
      });
      const svc = createCapabilityAwarenessService({
        getDb: () => sb.client as any,
        emit: noOpEmit() as any,
      });
      const result = await svc.ingest(args({ eventName: event, idempotencyKey: `${from}-${event}` }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.previousState).toBe(from);
        expect(result.nextState).toBe(to);
      }
    },
  );

  const rejected: Array<[AwarenessState, CapabilityAwarenessEventName]> = [
    // Cannot mastered without completed first.
    ['unknown',    'mastered'],
    ['introduced', 'mastered'],
    ['seen',       'mastered'],
    ['tried',      'mastered'],
    // Cannot regress from a later state.
    ['tried',      'introduced'],
    ['tried',      'seen'],
    ['completed',  'introduced'],
    ['completed',  'seen'],
    ['completed',  'tried'],
    // dismissed only reopens via 'introduced'.
    ['dismissed',  'seen'],
    ['dismissed',  'tried'],
    ['dismissed',  'completed'],
    ['dismissed',  'mastered'],
    ['dismissed',  'dismissed'],
    // mastered is terminal in this slice.
    ['mastered',   'introduced'],
    ['mastered',   'seen'],
    ['mastered',   'tried'],
    ['mastered',   'completed'],
    ['mastered',   'dismissed'],
    ['mastered',   'mastered'],
  ];

  it.each(rejected)('state=%s + event=%s → rejected', async (from, event) => {
    const sb = buildMockSupabase({
      states: new Map([[stateKey('t1', 'u1', 'life_compass'), from]]),
    });
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    const result = await svc.ingest(args({ eventName: event, idempotencyKey: `${from}-${event}` }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('transition_not_allowed');
      expect(result.previousState).toBe(from);
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #3 — idempotency
// ---------------------------------------------------------------------------

describe('B0e.4 acceptance check #3: idempotency', () => {
  it('duplicate idempotency key does not double-advance', async () => {
    const sb = buildMockSupabase();
    const emit = noOpEmit();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: emit as any,
    });

    const first = await svc.ingest(args({ idempotencyKey: 'dupe-key' }));
    const second = await svc.ingest(args({ idempotencyKey: 'dupe-key' }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.idempotent).toBe(false);
      expect(second.idempotent).toBe(true);
      expect(second.eventId).toBe(first.eventId);
      expect(second.previousState).toBe(first.previousState);
      expect(second.nextState).toBe(first.nextState);
    }
    // Only the first call advanced; second was a replay.
    expect(sb.state.states.get(stateKey('t1', 'u1', 'life_compass'))).toBe('introduced');
    // OASIS emitted once, not twice (no emit on idempotent replays).
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('idempotencyKey is required', async () => {
    const sb = buildMockSupabase();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    const result = await svc.ingest(args({ idempotencyKey: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('idempotency_key_required');
  });

  it('whitespace-only idempotencyKey is rejected', async () => {
    const sb = buildMockSupabase();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    const result = await svc.ingest(args({ idempotencyKey: '   ' }));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #4 — tenant/user mismatch
// ---------------------------------------------------------------------------

describe('B0e.4 acceptance check #4: tenant/user isolation', () => {
  it('events scoped by (tenant_id, user_id) do not cross over', async () => {
    const sb = buildMockSupabase();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    await svc.ingest(args({ tenantId: 'A', userId: 'x', idempotencyKey: 'k1' }));
    await svc.ingest(args({ tenantId: 'B', userId: 'x', idempotencyKey: 'k1' }));
    // Different tenants → both fresh advances (idempotency key is
    // scoped to tenant+user).
    expect(sb.state.states.get(stateKey('A', 'x', 'life_compass'))).toBe('introduced');
    expect(sb.state.states.get(stateKey('B', 'x', 'life_compass'))).toBe('introduced');
    expect(sb.state.seen.size).toBe(2);
  });

  it('requires both tenantId and userId', async () => {
    const sb = buildMockSupabase();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    const r1 = await svc.ingest(args({ tenantId: '' }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('identity_required');
    const r2 = await svc.ingest(args({ userId: '' }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('identity_required');
  });

  it('RPC is invoked with the exact tenant + user that the caller passed', async () => {
    const sb = buildMockSupabase();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    await svc.ingest(args({ tenantId: 'tenant-A', userId: 'user-X', idempotencyKey: 'k' }));
    const lastCall = sb.state.rpcCalls[sb.state.rpcCalls.length - 1];
    expect(lastCall.p_tenant_id).toBe('tenant-A');
    expect(lastCall.p_user_id).toBe('user-X');
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #5 — terminal states respected
// ---------------------------------------------------------------------------

describe('B0e.4 acceptance check #5: terminal states', () => {
  it('mastered is terminal — no event advances it', async () => {
    const events: CapabilityAwarenessEventName[] = [
      'introduced', 'seen', 'tried', 'completed', 'dismissed', 'mastered',
    ];
    for (const event of events) {
      const sb = buildMockSupabase({
        states: new Map([[stateKey('t1', 'u1', 'life_compass'), 'mastered']]),
      });
      const svc = createCapabilityAwarenessService({
        getDb: () => sb.client as any,
        emit: noOpEmit() as any,
      });
      const result = await svc.ingest(args({ eventName: event, idempotencyKey: `m-${event}` }));
      expect(result.ok).toBe(false);
    }
  });

  it('dismissed only advances via the explicit "introduced" reopen event', async () => {
    const sb = buildMockSupabase({
      states: new Map([[stateKey('t1', 'u1', 'life_compass'), 'dismissed']]),
    });
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    // Allowed: dismissed → introduced (the reopen path).
    const reopen = await svc.ingest(args({ eventName: 'introduced', idempotencyKey: 'reopen' }));
    expect(reopen.ok).toBe(true);
    if (reopen.ok) expect(reopen.nextState).toBe('introduced');

    // All other events from dismissed → rejected (covered in #2 too, but
    // explicit here for the acceptance check).
    const sb2 = buildMockSupabase({
      states: new Map([[stateKey('t1', 'u1', 'life_compass'), 'dismissed']]),
    });
    const svc2 = createCapabilityAwarenessService({
      getDb: () => sb2.client as any,
      emit: noOpEmit() as any,
    });
    const tried = await svc2.ingest(args({ eventName: 'tried', idempotencyKey: 't' }));
    expect(tried.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #6 — decisionId linkage
// ---------------------------------------------------------------------------

describe('B0e.4 acceptance check #6: decisionId linkage', () => {
  it('decisionId is passed to the RPC (audit log row carries it)', async () => {
    const sb = buildMockSupabase();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    const decisionId = 'decision-12345';
    await svc.ingest(args({ decisionId, idempotencyKey: 'k' }));
    const lastCall = sb.state.rpcCalls[sb.state.rpcCalls.length - 1];
    expect(lastCall.p_decision_id).toBe(decisionId);
  });

  it('decisionId reaches the OASIS payload', async () => {
    const sb = buildMockSupabase();
    const emit = noOpEmit();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: emit as any,
    });
    await svc.ingest(args({ decisionId: 'dec-99', idempotencyKey: 'k' }));
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = (emit as jest.Mock).mock.calls[0][0];
    expect(payload.payload.decision_id).toBe('dec-99');
  });

  it('decisionId is optional (null when absent)', async () => {
    const sb = buildMockSupabase();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    await svc.ingest(args({ idempotencyKey: 'no-dec' }));
    const lastCall = sb.state.rpcCalls[sb.state.rpcCalls.length - 1];
    expect(lastCall.p_decision_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #8 — central telemetry only
// ---------------------------------------------------------------------------

describe('B0e.4 acceptance check #8: telemetry uses central constants', () => {
  it('emits the correct central topic per event', async () => {
    const cases: Array<[CapabilityAwarenessEventName, string]> = [
      ['introduced', CAPABILITY_AWARENESS_INTRODUCED],
      ['seen',       CAPABILITY_AWARENESS_SEEN],
      ['tried',      CAPABILITY_AWARENESS_TRIED],
      ['completed',  CAPABILITY_AWARENESS_COMPLETED],
      ['dismissed',  CAPABILITY_AWARENESS_DISMISSED],
      ['mastered',   CAPABILITY_AWARENESS_MASTERED],
    ];
    for (const [event, expectedTopic] of cases) {
      // Seed each case from a state that allows the event.
      const startState: AwarenessState =
        event === 'mastered' ? 'completed' :
        event === 'tried'    ? 'seen' :
        event === 'completed'? 'tried' :
        event === 'dismissed'? 'introduced' :
        event === 'seen'     ? 'introduced' :
        event === 'introduced'? 'unknown' :
        'unknown';
      const sb = buildMockSupabase({
        states: new Map([[stateKey('t1', 'u1', 'life_compass'), startState]]),
      });
      const emit = noOpEmit();
      const svc = createCapabilityAwarenessService({
        getDb: () => sb.client as any,
        emit: emit as any,
      });
      await svc.ingest(args({ eventName: event, idempotencyKey: `e-${event}` }));
      expect(emit).toHaveBeenCalledTimes(1);
      const payload = (emit as jest.Mock).mock.calls[0][0];
      expect(payload.type).toBe(expectedTopic);
    }
  });

  it('AWARENESS_EVENT_TO_TOPIC covers every event name', () => {
    const events: CapabilityAwarenessEventName[] = [
      'introduced', 'seen', 'tried', 'completed', 'dismissed', 'mastered',
    ];
    for (const e of events) {
      expect(AWARENESS_EVENT_TO_TOPIC[e]).toBeDefined();
      expect(CAPABILITY_AWARENESS_TOPIC_REGISTRY).toContain(AWARENESS_EVENT_TO_TOPIC[e]);
    }
  });

  it('service source file does not contain raw capability.awareness.* literals', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/services/capability-awareness/capability-awareness-service.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/['"`]capability\.awareness\./);
  });
});

// ---------------------------------------------------------------------------
// Extra coverage — input validation, error paths, OASIS-on-idempotent
// ---------------------------------------------------------------------------

describe('B0e.4 — extra coverage', () => {
  it('rejects invalid eventName at the service boundary', async () => {
    const sb = buildMockSupabase();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    const result = await svc.ingest(args({ eventName: 'made_up' as any }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('event_name_invalid');
  });

  it('returns database_unavailable when getSupabase returns null', async () => {
    const svc = createCapabilityAwarenessService({
      getDb: () => null,
      emit: noOpEmit() as any,
    });
    const result = await svc.ingest(args());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('database_unavailable');
  });

  it('returns unknown_capability when RPC reports it', async () => {
    const sb = buildMockSupabase({
      // No capabilities seeded.
      capabilities: new Set(),
    });
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: noOpEmit() as any,
    });
    const result = await svc.ingest(args({ capabilityKey: 'made_up' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_capability');
  });

  it('does NOT emit OASIS on idempotent replays', async () => {
    const sb = buildMockSupabase();
    const emit = noOpEmit();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: emit as any,
    });
    await svc.ingest(args({ idempotencyKey: 'k' }));
    await svc.ingest(args({ idempotencyKey: 'k' }));
    await svc.ingest(args({ idempotencyKey: 'k' }));
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit OASIS on rejected transitions', async () => {
    const sb = buildMockSupabase({
      states: new Map([[stateKey('t1', 'u1', 'life_compass'), 'mastered']]),
    });
    const emit = noOpEmit();
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: emit as any,
    });
    await svc.ingest(args({ eventName: 'introduced', idempotencyKey: 'attempted' }));
    expect(emit).toHaveBeenCalledTimes(0);
  });

  it('telemetry failure does not block the state advance', async () => {
    const sb = buildMockSupabase();
    const explodingEmit = jest.fn(async () => { throw new Error('oasis-down'); });
    const svc = createCapabilityAwarenessService({
      getDb: () => sb.client as any,
      emit: explodingEmit as any,
    });
    const result = await svc.ingest(args({ idempotencyKey: 'k' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextState).toBe('introduced');
  });
});
