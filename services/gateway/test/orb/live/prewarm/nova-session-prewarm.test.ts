/**
 * VTID-03779 — session pre-establishment ("warm start") registry.
 *
 * This module is deliberately tested in isolation from the real Nova
 * connect/context pipeline: it only owns the lifecycle of an
 * ALREADY-CONNECTED client handed to it, so a fake client with the same
 * shape (getState/sendAudioChunk/close) is enough to exercise every real
 * code path (register, claim, expire, supersede, dead-on-claim).
 */
import {
  registerPrewarmedNovaSession,
  consumePrewarmedNovaSession,
  discardPrewarmedNovaSession,
  __clearAllPrewarmedNovaSessionsForTest,
  __prewarmedNovaSessionCountForTest,
} from '../../../../src/orb/live/prewarm/nova-session-prewarm';

function makeFakeClient(initialState: 'open' | 'closed' = 'open') {
  let state: 'open' | 'closed' = initialState;
  const sendAudioChunk = jest.fn(() => true);
  const close = jest.fn(async () => {
    state = 'closed';
  });
  return {
    getState: () => state,
    sendAudioChunk,
    close,
    // test helper, not part of the real client's public surface
    __setState: (s: 'open' | 'closed') => { state = s; },
  };
}

function baseEntry(client: ReturnType<typeof makeFakeClient>) {
  return {
    client: client as any,
    systemInstruction: 'You are Vitana.',
    tools: [{ function_declarations: [{ name: 'navigate' }] }],
    voiceId: 'tina',
    lang: 'en',
  };
}

describe('VTID-03779 nova-session-prewarm registry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __clearAllPrewarmedNovaSessionsForTest();
    delete process.env.ORB_NOVA_PREWARM_TTL_MS;
  });

  afterEach(() => {
    __clearAllPrewarmedNovaSessionsForTest();
    jest.useRealTimers();
  });

  it('registers and then claims a still-open prewarmed session', () => {
    const client = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(client));
    expect(__prewarmedNovaSessionCountForTest()).toBe(1);

    const claimed = consumePrewarmedNovaSession('user-1');
    expect(claimed).not.toBeNull();
    expect(claimed?.client).toBe(client);
    expect(claimed?.systemInstruction).toBe('You are Vitana.');
    expect(claimed?.voiceId).toBe('tina');
    // Claiming pops it — a second claim (a client-side double-tap, a retry)
    // must fall through to a cold connect, never reuse the same client twice.
    expect(__prewarmedNovaSessionCountForTest()).toBe(0);
    expect(consumePrewarmedNovaSession('user-1')).toBeNull();
  });

  it('returns null for a user with no prewarmed session', () => {
    expect(consumePrewarmedNovaSession('nobody')).toBeNull();
  });

  it('claiming a dead (closed) connection returns null and closes it — never hands back a broken client', () => {
    const client = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(client));
    // Died between prewarm and claim — an idle-kill despite the keepalive,
    // a transient network blip.
    client.__setState('closed');

    const claimed = consumePrewarmedNovaSession('user-1');
    expect(claimed).toBeNull();
    expect(client.close).toHaveBeenCalledWith('prewarm_claim_found_dead');
  });

  it('registering a second prewarm for the same user discards (and closes) the first', () => {
    const first = makeFakeClient('open');
    const second = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(first));
    registerPrewarmedNovaSession('user-1', baseEntry(second));

    expect(first.close).toHaveBeenCalledWith('superseded_by_new_prewarm');
    expect(__prewarmedNovaSessionCountForTest()).toBe(1);
    const claimed = consumePrewarmedNovaSession('user-1');
    expect(claimed?.client).toBe(second);
  });

  it('discardPrewarmedNovaSession closes and removes a pending entry, is a no-op if none exists', () => {
    const client = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(client));
    discardPrewarmedNovaSession('user-1', 'client_disconnect');
    expect(client.close).toHaveBeenCalledWith('client_disconnect');
    expect(__prewarmedNovaSessionCountForTest()).toBe(0);

    // No throw, no-op, on a user with nothing registered.
    expect(() => discardPrewarmedNovaSession('nobody', 'x')).not.toThrow();
  });

  it('feeds a silence keepalive frame on an interval while unclaimed, and stops once claimed', () => {
    const client = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(client));

    jest.advanceTimersByTime(5_000);
    expect(client.sendAudioChunk).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5_000);
    expect(client.sendAudioChunk).toHaveBeenCalledTimes(2);

    consumePrewarmedNovaSession('user-1');
    const callsAtClaim = client.sendAudioChunk.mock.calls.length;
    jest.advanceTimersByTime(30_000);
    // The claimed client is the real session's problem now (its own
    // armUpstreamKeepalive takes over) — this module must not keep feeding
    // it silence after handing it off.
    expect(client.sendAudioChunk).toHaveBeenCalledTimes(callsAtClaim);
  });

  it('never feeds silence to a client that has already closed', () => {
    const client = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(client));
    client.__setState('closed');
    jest.advanceTimersByTime(20_000);
    expect(client.sendAudioChunk).not.toHaveBeenCalled();
  });

  it('closes and removes an unclaimed entry once the TTL expires', () => {
    process.env.ORB_NOVA_PREWARM_TTL_MS = '10000';
    const client = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(client));

    jest.advanceTimersByTime(9_999);
    expect(client.close).not.toHaveBeenCalled();
    expect(__prewarmedNovaSessionCountForTest()).toBe(1);

    jest.advanceTimersByTime(2);
    expect(client.close).toHaveBeenCalledWith('prewarm_ttl_expired');
    expect(__prewarmedNovaSessionCountForTest()).toBe(0);
  });

  it('a TTL that fires after the entry was already claimed is a no-op — never closes the real session\'s client out from under it', () => {
    process.env.ORB_NOVA_PREWARM_TTL_MS = '10000';
    const client = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(client));

    consumePrewarmedNovaSession('user-1');
    jest.advanceTimersByTime(10_000);
    // The claim already popped the entry and cleared its timers, but even a
    // stray fire must not reach into a client that now belongs to a live
    // conversation.
    expect(client.close).not.toHaveBeenCalled();
  });

  it('an invalid TTL env var falls back to the default rather than firing immediately or never', () => {
    process.env.ORB_NOVA_PREWARM_TTL_MS = 'not-a-number';
    const client = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(client));

    jest.advanceTimersByTime(1_000);
    expect(client.close).not.toHaveBeenCalled();
    expect(__prewarmedNovaSessionCountForTest()).toBe(1);
  });
});
