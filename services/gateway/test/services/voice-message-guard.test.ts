// VTID-01967 — unit tests for the voice-message rate limiter + audit hook
// (voice-message-guard.ts). Phase 7 (Voice/ORB tools) of
// docs/TEST_COVERAGE_PLAN.md.
//
// Scope:
//   1. checkVoiceSendQuota(): the per-session 5-send cap, exercised at
//      every boundary (4th allow, 5th allow-to-zero, 6th+ block), OASIS
//      audit events on both the allow and block paths, key_type /
//      kind-dependent event naming, and optional field inclusion
//      (body_length / target_url only present when provided).
//   2. Per-session isolation — one session's counter never leaks into
//      another's.
//   3. sweepExpired() / the 30-minute session TTL — an expired session's
//      counter resets rather than continuing to accumulate.
//   4. resetSessionQuota() and _resetSendCountersForTests() test helpers.
//   5. reportVoiceMisroute(): event shape.
//   6. Fail-mode: emitOasisEvent() rejecting is NOT caught by this module —
//      it propagates, but only AFTER the in-memory counter has already
//      been mutated. Documented as a "state committed but caller never
//      learns the outcome" risk given this is the module guarding against
//      voice-initiated message spam/misroutes.

const mockEmitOasisEvent = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

import {
  checkVoiceSendQuota,
  reportVoiceMisroute,
  resetSessionQuota,
  _resetSendCountersForTests,
} from '../../src/services/voice-message-guard';

function baseArgs(overrides: Partial<Parameters<typeof checkVoiceSendQuota>[0]> = {}) {
  return {
    session_id: 'sess-1',
    actor_id: 'actor-1',
    vitana_id: 'vitana-actor',
    recipient_user_id: 'recipient-1',
    recipient_vitana_id: 'vitana-recipient',
    kind: 'message' as const,
    ...overrides,
  };
}

beforeEach(() => {
  mockEmitOasisEvent.mockReset();
  mockEmitOasisEvent.mockResolvedValue({ ok: true });
  _resetSendCountersForTests();
  jest.useRealTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('checkVoiceSendQuota() — 5-send cap boundary', () => {
  test('sends 1 through 4 are allowed with correctly decreasing remaining', async () => {
    for (let i = 1; i <= 4; i++) {
      const res = await checkVoiceSendQuota(baseArgs());
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(5 - i);
    }
  });

  test('the 5th send is allowed and brings remaining to exactly 0 (not negative)', async () => {
    for (let i = 1; i <= 4; i++) await checkVoiceSendQuota(baseArgs());
    const fifth = await checkVoiceSendQuota(baseArgs());

    expect(fifth.allowed).toBe(true);
    expect(fifth.remaining).toBe(0);
  });

  test('the 6th send is blocked (off-by-one boundary: cap is inclusive of 5, not 6)', async () => {
    for (let i = 1; i <= 5; i++) await checkVoiceSendQuota(baseArgs());
    const sixth = await checkVoiceSendQuota(baseArgs());

    expect(sixth).toEqual({ allowed: false, reason: 'rate_limited', remaining: 0 });
  });

  test('further sends after the cap stay blocked and do not keep incrementing internal count', async () => {
    for (let i = 1; i <= 5; i++) await checkVoiceSendQuota(baseArgs());
    const sixth = await checkVoiceSendQuota(baseArgs());
    const seventh = await checkVoiceSendQuota(baseArgs());

    expect(sixth.allowed).toBe(false);
    expect(seventh).toEqual({ allowed: false, reason: 'rate_limited', remaining: 0 });
  });
});

describe('checkVoiceSendQuota() — per-session isolation', () => {
  test("session A's count does not affect session B", async () => {
    for (let i = 1; i <= 5; i++) await checkVoiceSendQuota(baseArgs({ session_id: 'sess-A' }));
    const blockedOnA = await checkVoiceSendQuota(baseArgs({ session_id: 'sess-A' }));
    const firstOnB = await checkVoiceSendQuota(baseArgs({ session_id: 'sess-B' }));

    expect(blockedOnA.allowed).toBe(false);
    expect(firstOnB).toEqual({ allowed: true, remaining: 4 });
  });
});

describe('checkVoiceSendQuota() — OASIS audit events', () => {
  test('an allowed send emits voice.message.sent with the correct send_index/cap', async () => {
    await checkVoiceSendQuota(baseArgs());
    await checkVoiceSendQuota(baseArgs());

    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(2);
    const secondCall = mockEmitOasisEvent.mock.calls[1][0];
    expect(secondCall.type).toBe('voice.message.sent');
    expect(secondCall.status).toBe('success');
    expect(secondCall.payload.send_index).toBe(2);
    expect(secondCall.payload.cap).toBe(5);
  });

  test('kind="share_link" emits voice.message.share_link_sent instead', async () => {
    await checkVoiceSendQuota(baseArgs({ kind: 'share_link', target_url: 'https://vitanaland.com/x' }));

    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.type).toBe('voice.message.share_link_sent');
    expect(call.message).toContain('link share');
  });

  test('kind="message" message text differs from share_link', async () => {
    await checkVoiceSendQuota(baseArgs({ kind: 'message' }));
    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.message).toContain('message');
    expect(call.message).not.toContain('link share');
  });

  test('a blocked send emits voice.message.rate_limited with status=warning', async () => {
    for (let i = 1; i <= 5; i++) await checkVoiceSendQuota(baseArgs());
    mockEmitOasisEvent.mockClear();

    await checkVoiceSendQuota(baseArgs());

    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.type).toBe('voice.message.rate_limited');
    expect(call.status).toBe('warning');
    expect(call.payload.cap).toBe(5);
  });

  test('body_length is included in the payload only when provided', async () => {
    await checkVoiceSendQuota(baseArgs({ body_length: 42 }));
    expect(mockEmitOasisEvent.mock.calls[0][0].payload.body_length).toBe(42);

    mockEmitOasisEvent.mockClear();
    await checkVoiceSendQuota(baseArgs());
    expect(mockEmitOasisEvent.mock.calls[0][0].payload).not.toHaveProperty('body_length');
  });

  test('target_url is included in the payload only when provided', async () => {
    await checkVoiceSendQuota(baseArgs({ target_url: 'https://vitanaland.com/y' }));
    expect(mockEmitOasisEvent.mock.calls[0][0].payload.target_url).toBe('https://vitanaland.com/y');

    mockEmitOasisEvent.mockClear();
    await checkVoiceSendQuota(baseArgs());
    expect(mockEmitOasisEvent.mock.calls[0][0].payload).not.toHaveProperty('target_url');
  });

  test('key_type defaults to "real_session" when not provided', async () => {
    await checkVoiceSendQuota(baseArgs());
    expect(mockEmitOasisEvent.mock.calls[0][0].payload.key_type).toBe('real_session');
  });

  test('an explicit key_type="missing_session_fallback" is propagated into the payload', async () => {
    await checkVoiceSendQuota(baseArgs({ key_type: 'missing_session_fallback' }));
    expect(mockEmitOasisEvent.mock.calls[0][0].payload.key_type).toBe('missing_session_fallback');
  });

  test('actor_id/actor_role/surface/vitana_id are set correctly on the emitted event', async () => {
    await checkVoiceSendQuota(baseArgs({ actor_id: 'actor-99', vitana_id: 'vitana-99' }));
    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.actor_id).toBe('actor-99');
    expect(call.actor_role).toBe('user');
    expect(call.surface).toBe('orb');
    expect(call.vitana_id).toBe('vitana-99');
  });

  test('a null vitana_id is normalized to undefined on the emitted event (?? undefined)', async () => {
    await checkVoiceSendQuota(baseArgs({ vitana_id: null }));
    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.vitana_id).toBeUndefined();
  });
});

describe('checkVoiceSendQuota() — 30-minute session TTL sweep', () => {
  test('an expired session counter is swept and the session starts fresh', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    for (let i = 1; i <= 5; i++) await checkVoiceSendQuota(baseArgs({ session_id: 'sess-ttl' }));
    const blocked = await checkVoiceSendQuota(baseArgs({ session_id: 'sess-ttl' }));
    expect(blocked.allowed).toBe(false);

    // Advance past the 30-minute TTL.
    jest.setSystemTime(new Date('2026-01-01T00:30:00.001Z'));

    const afterExpiry = await checkVoiceSendQuota(baseArgs({ session_id: 'sess-ttl' }));
    expect(afterExpiry).toEqual({ allowed: true, remaining: 4 });

    jest.useRealTimers();
  });

  test('a session counter within the TTL is NOT swept', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    await checkVoiceSendQuota(baseArgs({ session_id: 'sess-ttl-2' }));
    jest.setSystemTime(new Date('2026-01-01T00:29:59.000Z'));
    const stillCounting = await checkVoiceSendQuota(baseArgs({ session_id: 'sess-ttl-2' }));

    expect(stillCounting.remaining).toBe(3); // 2nd send: 5 - 2 = 3
    jest.useRealTimers();
  });
});

describe('resetSessionQuota() / _resetSendCountersForTests()', () => {
  test('resetSessionQuota() clears only the named session', async () => {
    for (let i = 1; i <= 5; i++) await checkVoiceSendQuota(baseArgs({ session_id: 'sess-X' }));
    await checkVoiceSendQuota(baseArgs({ session_id: 'sess-Y' }));

    resetSessionQuota('sess-X');

    const freshX = await checkVoiceSendQuota(baseArgs({ session_id: 'sess-X' }));
    const secondY = await checkVoiceSendQuota(baseArgs({ session_id: 'sess-Y' }));

    expect(freshX).toEqual({ allowed: true, remaining: 4 });
    expect(secondY.remaining).toBe(3); // sess-Y unaffected, this is its 2nd send
  });

  test('_resetSendCountersForTests() clears ALL sessions', async () => {
    await checkVoiceSendQuota(baseArgs({ session_id: 'sess-P' }));
    await checkVoiceSendQuota(baseArgs({ session_id: 'sess-Q' }));

    _resetSendCountersForTests();

    const freshP = await checkVoiceSendQuota(baseArgs({ session_id: 'sess-P' }));
    const freshQ = await checkVoiceSendQuota(baseArgs({ session_id: 'sess-Q' }));

    expect(freshP.remaining).toBe(4);
    expect(freshQ.remaining).toBe(4);
  });
});

describe('reportVoiceMisroute()', () => {
  test('emits voice.message.misroute with status=warning and the full context', async () => {
    await reportVoiceMisroute({
      session_id: 'sess-1',
      actor_id: 'actor-1',
      vitana_id: 'vitana-actor',
      intended_token: 'John',
      resolved_user_id: 'user-wrong',
      resolved_vitana_id: 'vitana-wrong',
    });

    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.type).toBe('voice.message.misroute');
    expect(call.status).toBe('warning');
    expect(call.vtid).toBe('VTID-01967');
    expect(call.message).toContain('John');
    expect(call.message).toContain('vitana-wrong');
    expect(call.payload).toEqual({
      session_id: 'sess-1',
      intended_token: 'John',
      resolved_user_id: 'user-wrong',
      resolved_vitana_id: 'vitana-wrong',
    });
    expect(call.actor_role).toBe('user');
    expect(call.surface).toBe('orb');
  });

  test('falls back to actor_id/resolved_user_id in the message when vitana handles are missing', async () => {
    await reportVoiceMisroute({
      session_id: 'sess-1',
      actor_id: 'actor-42',
      vitana_id: null,
      intended_token: 'Jane',
      resolved_user_id: 'user-99',
      resolved_vitana_id: null,
    });

    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.message).toContain('actor-42');
    expect(call.message).toContain('user-99');
  });
});

describe('checkVoiceSendQuota() — emitOasisEvent dependency failure (fail-mode)', () => {
  test('an allow-path emit failure propagates, but the counter has ALREADY been incremented', async () => {
    mockEmitOasisEvent.mockRejectedValueOnce(new Error('oasis outage'));

    // NOTE (fail-mode finding): checkVoiceSendQuota() sets the counter via
    // sendCounters.set(...) BEFORE awaiting emitOasisEvent(). If the OASIS
    // write fails, this call rejects and the caller never receives an
    // {allowed:true/false} verdict — but the in-memory quota has already
    // been consumed. A caller that retries after a transient OASIS outage
    // will silently burn an extra unit of the user's 5-send cap without
    // ever having been told the first attempt "succeeded". Documented,
    // not modified (no try/catch exists around this emit call).
    await expect(checkVoiceSendQuota(baseArgs())).rejects.toThrow('oasis outage');

    // Prove the state was mutated despite the rejection: the next
    // (successful) call is send #2, not send #1.
    const next = await checkVoiceSendQuota(baseArgs());
    expect(next.remaining).toBe(3);
  });

  test('a block-path emit failure also propagates (rate-limit audit trail is not resilient either)', async () => {
    for (let i = 1; i <= 5; i++) await checkVoiceSendQuota(baseArgs());
    mockEmitOasisEvent.mockRejectedValueOnce(new Error('oasis outage'));

    await expect(checkVoiceSendQuota(baseArgs())).rejects.toThrow('oasis outage');
  });
});
