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
  hasLivePrewarmedNovaSession,
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

  // BOOTSTRAP-NOVA-PREWARM-REGISTRY-HARDEN: registering a SECOND prewarm
  // while the first is still open and unclaimed now KEEPS the first and
  // discards the second — the reverse of the original behavior. Measured
  // live: two tabs/frames for the same user (confirmed via
  // /admin/device-preview, which iframes the app for the same logged-in
  // user) each prewarm independently, and the old "last wins" rule kept
  // resetting the ready clock so a real tap could arrive mid-connect on
  // the newest attempt even though an earlier one had already finished.
  it('registering a second prewarm while the first is still open KEEPS the first and closes the second', () => {
    const first = makeFakeClient('open');
    const second = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(first));
    registerPrewarmedNovaSession('user-1', baseEntry(second));

    expect(second.close).toHaveBeenCalledWith('prewarm_superseded_kept_existing');
    expect(first.close).not.toHaveBeenCalled();
    expect(__prewarmedNovaSessionCountForTest()).toBe(1);
    const claimed = consumePrewarmedNovaSession('user-1');
    expect(claimed?.client).toBe(first);
  });

  it('registering a second prewarm DOES replace a dead (closed) first entry', () => {
    const first = makeFakeClient('open');
    const second = makeFakeClient('open');
    registerPrewarmedNovaSession('user-1', baseEntry(first));
    first.__setState('closed'); // died between prewarm and the second attempt

    registerPrewarmedNovaSession('user-1', baseEntry(second));

    expect(first.close).toHaveBeenCalledWith('superseded_by_new_prewarm');
    expect(second.close).not.toHaveBeenCalled();
    const claimed = consumePrewarmedNovaSession('user-1');
    expect(claimed?.client).toBe(second);
  });

  describe('hasLivePrewarmedNovaSession', () => {
    it('is false when nothing is registered for the user', () => {
      expect(hasLivePrewarmedNovaSession('user-1')).toBe(false);
    });

    it('is true once a still-open entry is registered', () => {
      registerPrewarmedNovaSession('user-1', baseEntry(makeFakeClient('open')));
      expect(hasLivePrewarmedNovaSession('user-1')).toBe(true);
    });

    it('is false once the entry has been claimed', () => {
      registerPrewarmedNovaSession('user-1', baseEntry(makeFakeClient('open')));
      consumePrewarmedNovaSession('user-1');
      expect(hasLivePrewarmedNovaSession('user-1')).toBe(false);
    });

    it('is false when the registered entry has died', () => {
      const client = makeFakeClient('open');
      registerPrewarmedNovaSession('user-1', baseEntry(client));
      client.__setState('closed');
      expect(hasLivePrewarmedNovaSession('user-1')).toBe(false);
    });

    it('does not affect a different user\'s entry', () => {
      registerPrewarmedNovaSession('user-1', baseEntry(makeFakeClient('open')));
      expect(hasLivePrewarmedNovaSession('user-2')).toBe(false);
    });
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
