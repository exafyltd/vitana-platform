// VTID-01952/VTID-01966 — unit tests for memory-audit.ts, the memory write
// audit chokepoint + HIPAA-grade audit-log helpers.
//
// Scope (this file — the parts of memory-audit.ts NOT covered by the
// existing top-level test/memory-audit-log.test.ts, which only exercises
// appendMemoryAuditRow/auditMemoryRead/auditMemoryWrite's no-Supabase-env
// no-op contract):
//   1. assertWriteFact() — the Identity Lock chokepoint: allow/reject
//      decisions, the OASIS audit event emitted either way, locale-aware
//      refusal phrasing, and tenant/user scoping of the audit payload.
//   2. auditWritePersisted() — HIPAA write-persisted audit event, including
//      the "skip event spam for ordinary writes" short-circuit.
//   3. appendMemoryAuditRow() exercised WITH Supabase env configured (the
//      live fetch path — success, non-2xx, and throw all non-fatal).
//
// Real memory-identity-lock.ts is used (not mocked) so the actual lock
// table/authorized-sources list is what's under test, not a stand-in.

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

import {
  assertWriteFact,
  auditWritePersisted,
  appendMemoryAuditRow,
  MEMORY_POLICY_VERSION,
} from '../../src/services/memory-audit';

const TENANT_A = 'tenant-aaa';
const USER_B = 'user-bbb';

beforeEach(() => {
  mockEmitOasisEvent.mockClear();
  mockEmitOasisEvent.mockResolvedValue({ ok: true, event_id: 'evt-1' });
});

// ---------------------------------------------------------------------------
// assertWriteFact() — allow path
// ---------------------------------------------------------------------------

describe('assertWriteFact — non-identity-class keys', () => {
  it('allows ordinary fact keys without emitting any audit event (fast path)', async () => {
    const result = await assertWriteFact({
      fact_key: 'user_favorite_color',
      provenance_source: 'assistant_inferred',
      actor_id: 'orb-live',
      tenant_id: TENANT_A,
      user_id: USER_B,
    });

    expect(result).toEqual({ ok: true });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('assertWriteFact — identity-class keys, authorized source', () => {
  it('allows the write and emits an "allowed" audit event', async () => {
    const result = await assertWriteFact({
      fact_key: 'user_first_name',
      provenance_source: 'user_stated_via_settings',
      actor_id: 'profile-ui',
      tenant_id: TENANT_A,
      user_id: USER_B,
      source_engine: 'profile-service',
    });

    expect(result).toEqual({ ok: true });
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      vtid: 'VTID-01952',
      type: 'memory.identity.write_attempted',
      status: 'success',
      payload: expect.objectContaining({
        fact_key: 'user_first_name',
        provenance_source: 'user_stated_via_settings',
        actor_id: 'profile-ui',
        source_engine: 'profile-service',
        tenant_id: TENANT_A,
        user_id: USER_B,
        allowed: true,
        policy_version: MEMORY_POLICY_VERSION,
      }),
    }));
  });

  it('does not block if emitOasisEvent rejects — audit must never block the write', async () => {
    mockEmitOasisEvent.mockRejectedValue(new Error('oasis unreachable'));

    await expect(assertWriteFact({
      fact_key: 'user_first_name',
      provenance_source: 'user_stated_via_settings',
      actor_id: 'profile-ui',
      tenant_id: TENANT_A,
      user_id: USER_B,
    })).resolves.toEqual({ ok: true });
  });
});

describe('assertWriteFact — identity-class keys, unauthorized source', () => {
  it('rejects with reason identity_locked, a redirect_target, and a refusal message', async () => {
    const result = await assertWriteFact({
      fact_key: 'user_first_name',
      provenance_source: 'assistant_inferred',
      actor_id: 'orb-live',
      tenant_id: TENANT_A,
      user_id: USER_B,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('identity_locked');
    expect(result.fact_key).toBe('user_first_name');
    expect(result.attempted_provenance_source).toBe('assistant_inferred');
    expect(result.redirect_target).toEqual({
      event: 'vitana:open-profile-edit',
      payload: { section: 'personal_info', field: 'first_name' },
    });
    expect(result.refusal_message).toContain('first name');
  });

  it('rejects a null provenance_source the same way as an unauthorized one', async () => {
    const result = await assertWriteFact({
      fact_key: 'user_email',
      provenance_source: null,
      actor_id: 'orb-live',
      tenant_id: TENANT_A,
      user_id: USER_B,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.redirect_target.event).toBe('vitana:open-account-settings');
  });

  it('emits a "warning" (not "error") audit event on rejection — refusal is expected behavior', async () => {
    await assertWriteFact({
      fact_key: 'user_email',
      provenance_source: 'assistant_inferred',
      actor_id: 'orb-live',
      tenant_id: TENANT_A,
      user_id: USER_B,
    });

    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'warning',
      payload: expect.objectContaining({
        allowed: false,
        rejection_reason: 'locked_key_unauthorized_provenance',
        redirect_target: { event: 'vitana:open-account-settings', payload: { section: 'contact', field: 'email' } },
      }),
    }));
  });

  it('uses German refusal phrasing when user_locale="de"', async () => {
    const result = await assertWriteFact({
      fact_key: 'user_first_name',
      provenance_source: 'assistant_inferred',
      actor_id: 'orb-live',
      tenant_id: TENANT_A,
      user_id: USER_B,
      user_locale: 'de',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal_message).toContain('kann ich nicht');
    expect(result.refusal_message).toContain('Vornamen');
  });

  it('does not throw when emitOasisEvent rejects on the reject path either', async () => {
    mockEmitOasisEvent.mockRejectedValue(new Error('oasis unreachable'));

    await expect(assertWriteFact({
      fact_key: 'user_first_name',
      provenance_source: 'assistant_inferred',
      actor_id: 'orb-live',
      tenant_id: TENANT_A,
      user_id: USER_B,
    })).resolves.toMatchObject({ ok: false, reason: 'identity_locked' });
  });
});

describe('assertWriteFact — tenant/user scoping of the audit payload', () => {
  it('propagates the exact tenant_id/user_id given, never swapped, across repeated calls', async () => {
    await assertWriteFact({
      fact_key: 'user_first_name',
      provenance_source: 'user_stated_via_settings',
      actor_id: 'profile-ui',
      tenant_id: 'tenant-1',
      user_id: 'user-1',
    });
    await assertWriteFact({
      fact_key: 'user_first_name',
      provenance_source: 'user_stated_via_settings',
      actor_id: 'profile-ui',
      tenant_id: 'tenant-2',
      user_id: 'user-2',
    });

    const payloads = mockEmitOasisEvent.mock.calls.map((c) => c[0].payload);
    expect(payloads[0]).toMatchObject({ tenant_id: 'tenant-1', user_id: 'user-1' });
    expect(payloads[1]).toMatchObject({ tenant_id: 'tenant-2', user_id: 'user-2' });
  });
});

// ---------------------------------------------------------------------------
// auditWritePersisted()
// ---------------------------------------------------------------------------

describe('auditWritePersisted', () => {
  it('emits memory.write.persisted for a health-classified, non-identity write', async () => {
    await auditWritePersisted({
      fact_key: 'sleep_hours_last_night',
      fact_id: 'fact-99',
      provenance_source: 'user_stated',
      provenance_confidence: 0.9,
      actor_id: 'orb-live',
      source_engine: 'orb-live',
      tenant_id: TENANT_A,
      user_id: USER_B,
      classification: { health: true },
    });

    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      vtid: 'VTID-01952',
      type: 'memory.write.persisted',
      status: 'success',
      payload: expect.objectContaining({
        fact_key: 'sleep_hours_last_night',
        fact_id: 'fact-99',
        health_scope: true,
        identity_scope: false,
        tenant_id: TENANT_A,
        user_id: USER_B,
      }),
    }));
  });

  it('emits for an identity-class write even without the health flag', async () => {
    await auditWritePersisted({
      fact_key: 'user_first_name',
      provenance_source: 'user_stated_via_settings',
      provenance_confidence: 0.99,
      actor_id: 'profile-ui',
      source_engine: 'profile-service',
      tenant_id: TENANT_A,
      user_id: USER_B,
    });

    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ health_scope: false, identity_scope: true }),
    }));
  });

  it('skips event emission entirely for an ordinary, non-health, non-identity write', async () => {
    await auditWritePersisted({
      fact_key: 'user_favorite_color',
      provenance_source: 'user_stated',
      provenance_confidence: 0.9,
      actor_id: 'orb-live',
      source_engine: 'orb-live',
      tenant_id: TENANT_A,
      user_id: USER_B,
    });

    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('does not throw when emitOasisEvent rejects', async () => {
    mockEmitOasisEvent.mockRejectedValue(new Error('oasis unreachable'));

    await expect(auditWritePersisted({
      fact_key: 'user_first_name',
      provenance_source: 'user_stated_via_settings',
      provenance_confidence: 0.99,
      actor_id: 'profile-ui',
      source_engine: 'profile-service',
      tenant_id: TENANT_A,
      user_id: USER_B,
    })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// appendMemoryAuditRow() — live fetch path (Supabase env IS configured;
// setup-tests.ts sets SUPABASE_URL/SUPABASE_SERVICE_ROLE before this file's
// module-level consts in memory-audit.ts are captured at import time).
// ---------------------------------------------------------------------------

describe('appendMemoryAuditRow — live fetch path', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (global.fetch as jest.Mock).mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('POSTs to memory_audit_log_insert with the full mapped RPC body', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
    });

    await appendMemoryAuditRow({
      tenant_id: TENANT_A,
      user_id: USER_B,
      op: 'write',
      tier: 'memory_facts',
      actor_id: 'orb-live',
      source_engine: 'orb-live',
      confidence: 0.9,
      health_scope: true,
      identity_scope: false,
      details: { fact_key: 'sleep_hours' },
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain('/rest/v1/rpc/memory_audit_log_insert');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      p_tenant_id: TENANT_A,
      p_user_id: USER_B,
      p_op: 'write',
      p_tier: 'memory_facts',
      p_actor_id: 'orb-live',
      p_policy_version: MEMORY_POLICY_VERSION,
      p_source_engine: 'orb-live',
      p_confidence: 0.9,
      p_source_event_id: null,
      p_health_scope: true,
      p_identity_scope: false,
      p_details: { fact_key: 'sleep_hours' },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('defaults p_policy_version and p_details when omitted', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });

    await appendMemoryAuditRow({
      tenant_id: TENANT_A,
      user_id: USER_B,
      op: 'read',
      tier: 'tier0',
      actor_id: 'orb-live',
    });

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.p_policy_version).toBe(MEMORY_POLICY_VERSION);
    expect(body.p_details).toEqual({});
  });

  it('logs a warning (does not throw) on a non-2xx response', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'insert failed',
    });

    await expect(appendMemoryAuditRow({
      tenant_id: TENANT_A,
      user_id: USER_B,
      op: 'write',
      tier: 'memory_facts',
      actor_id: 'orb-live',
    })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('memory_audit_log_insert failed 500'));
  });

  it('logs a warning (does not throw) when fetch itself throws', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network down'));

    await expect(appendMemoryAuditRow({
      tenant_id: TENANT_A,
      user_id: USER_B,
      op: 'write',
      tier: 'memory_facts',
      actor_id: 'orb-live',
    })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('memory_audit_log_insert threw (non-fatal)'),
      expect.any(String)
    );
  });
});
