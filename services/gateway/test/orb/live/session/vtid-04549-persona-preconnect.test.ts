/**
 * VTID-04549 (ORB latency G) — Devon pre-connect lifecycle.
 *
 * Drives the real module with fake Nova clients: when a specialist swap is
 * queued the specialist's stream is opened in the background; at turn complete
 * it is claimed only when its envelope is byte-identical to what the swap
 * builds; everything else falls back to today's path. Flag off → nothing.
 */

import {
  PERSONA_PRECONNECT_ENV,
  checkPersonaPreconnectForSwap,
  claimPersonaPreconnect,
  comparePreconnectedEnvelope,
  discardPersonaPreconnect,
  isPersonaPreconnectEnabled,
  maybeStartPersonaPreconnect,
  personaPreconnectKey,
  personaToPreconnect,
  retireSupersededClient,
  startPersonaPreconnect,
  takeOverPersonaSwapWithPreconnect,
  type PreconnectedUpstream,
} from '../../../../src/orb/live/session/persona-preconnect';

const ON = { [PERSONA_PRECONNECT_ENV]: 'true' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

class FakeClient {
  state: 'open' | 'closing' | 'closed' = 'open';
  closeReasons: string[] = [];
  audio: string[] = [];
  handlers: Record<string, ((e: any) => void) | null> = {};
  getState() { return this.state; }
  sendAudioChunk(b64: string) { if (this.state !== 'open') return false; this.audio.push(b64); return true; }
  async close(reason?: string) {
    this.closeReasons.push(reason ?? '');
    this.state = 'closed';
    this.handlers.close?.({ initiatedLocally: true, reason });
  }
  onAudioOutput(h: any) { this.handlers.audio = h; }
  onTranscript(h: any) { this.handlers.transcript = h; }
  onToolCall(h: any) { this.handlers.tool = h; }
  onTurnComplete(h: any) { this.handlers.turn = h; }
  onInterrupted(h: any) { this.handlers.interrupted = h; }
  onUsage(h: any) { this.handlers.usage = h; }
  onError(h: any) { this.handlers.error = h; }
  onClose(h: any) { this.handlers.close = h; }
}

const DEVON_PROMPT = 'You are Devon. [HANDOFF NOTE] …';

function makeSession(over: Record<string, unknown> = {}): any {
  return {
    sessionId: 'live-test',
    active: true,
    lang: 'de',
    upstreamProvider: 'nova_sonic',
    identity: { user_id: 'u1', tenant_id: 't1', role: 'community' },
    isAnonymous: false,
    current_route: '/home',
    active_role: 'community',
    clientContext: { isMobile: false },
    pendingPersonaSwap: 'devon',
    personaSystemOverride: DEVON_PROMPT,
    personaVoiceOverride: 'devon-registry-voice',
    personaForcedFirstMessage: '',
    personaFirstUtteranceDelivered: false,
    ...over,
  };
}

function built(client: FakeClient, over: Partial<PreconnectedUpstream> = {}): PreconnectedUpstream<FakeClient> {
  return {
    client,
    systemInstruction: 'INSTRUCTION-DEVON',
    tools: [{ function_declarations: [{ name: 'append_to_ticket' }] }],
    voiceId: 'matthew',
    ...over,
  } as PreconnectedUpstream<FakeClient>;
}

const fresh = (over: Record<string, unknown> = {}) => ({
  persona: 'devon',
  systemInstruction: 'INSTRUCTION-DEVON',
  tools: [{ function_declarations: [{ name: 'append_to_ticket' }] }],
  voiceId: 'matthew',
  ...over,
});

const flush = () => new Promise((r) => setImmediate(r));

let prevEnv: string | undefined;
beforeEach(() => {
  prevEnv = process.env[PERSONA_PRECONNECT_ENV];
  process.env[PERSONA_PRECONNECT_ENV] = 'true';
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env[PERSONA_PRECONNECT_ENV];
  else process.env[PERSONA_PRECONNECT_ENV] = prevEnv;
  jest.useRealTimers();
});

function stopTimer(session: any) {
  if (session.pendingPersonaUpstream) discardPersonaPreconnect(session, 'test_cleanup', { emitDiag: () => {} });
}

describe('flag', () => {
  it('only the exact string "true" enables it', () => {
    expect(isPersonaPreconnectEnabled({ [PERSONA_PRECONNECT_ENV]: 'true' } as any)).toBe(true);
    for (const v of [undefined, '', 'TRUE', '1', 'yes', 'true ']) {
      expect(isPersonaPreconnectEnabled({ [PERSONA_PRECONNECT_ENV]: v } as any)).toBe(false);
    }
  });

  it('flag off: nothing is started and the swap is never taken over', () => {
    const session = makeSession();
    const connect = jest.fn();
    expect(maybeStartPersonaPreconnect(session, connect, { emitDiag: jest.fn() }, OFF)).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(session.pendingPersonaUpstream).toBeUndefined();

    const old = new FakeClient();
    const emitDiag = jest.fn();
    const reconnect = jest.fn();
    const took = takeOverPersonaSwapWithPreconnect({
      session, persona: 'devon', oldClient: old, emitDiag, clearKeepalive: jest.fn(), reconnect, env: OFF,
    });
    expect(took).toBe(false);
    expect(reconnect).not.toHaveBeenCalled();
    expect(old.closeReasons).toEqual([]);
    expect(emitDiag).not.toHaveBeenCalled();
    expect(session._personaPreconnectClaimArmed).toBeUndefined();
  });
});

describe('personaToPreconnect', () => {
  it('returns the queued specialist on a Nova session', () => {
    expect(personaToPreconnect(makeSession(), ON)).toBe('devon');
  });
  it.each([
    ['swap back to Vitana', { pendingPersonaSwap: 'vitana' }],
    ['nothing queued', { pendingPersonaSwap: null }],
    ['cascade session (in-process swap)', { upstreamProvider: 'cascaded' }],
    ['vertex session', { upstreamProvider: 'vertex' }],
    ['no specialist prompt override', { personaSystemOverride: null }],
    ['session ended', { active: false }],
  ])('null for %s', (_label, over) => {
    expect(personaToPreconnect(makeSession(over), ON)).toBeNull();
  });
  it('null when a matching pre-connect is already pending, restarts when the inputs changed', () => {
    const session = makeSession();
    startPersonaPreconnect(session, 'devon', async () => built(new FakeClient()), { emitDiag: () => {} });
    expect(personaToPreconnect(session, ON)).toBeNull();
    session.personaSystemOverride = DEVON_PROMPT + ' changed';
    expect(personaToPreconnect(session, ON)).toBe('devon');
    stopTimer(session);
  });
});

describe('start / keepalive / lifetime', () => {
  it('opens in the background and feeds the same silence keepalive as the prewarm', async () => {
    jest.useFakeTimers();
    const session = makeSession();
    const client = new FakeClient();
    const entry = startPersonaPreconnect(session, 'devon', async () => built(client), {
      emitDiag: () => {}, tickMs: 1000, keepaliveMs: 5000, ttlMs: 60_000,
    });
    expect(entry.state).toBe('connecting');
    await entry.ready;
    expect(entry.state).toBe('ready');
    jest.advanceTimersByTime(4000);
    expect(client.audio).toHaveLength(0);
    jest.advanceTimersByTime(1000);
    expect(client.audio).toHaveLength(1);
    jest.advanceTimersByTime(10_000);
    expect(client.audio).toHaveLength(3);
    stopTimer(session);
  });

  it('closes the pending stream when the session ends', async () => {
    jest.useFakeTimers();
    const session = makeSession();
    const client = new FakeClient();
    const emitDiag = jest.fn();
    const entry = startPersonaPreconnect(session, 'devon', async () => built(client), { emitDiag, tickMs: 1000 });
    await entry.ready;
    session.active = false;
    jest.advanceTimersByTime(1000);
    expect(session.pendingPersonaUpstream).toBeNull();
    expect(client.closeReasons).toEqual(['persona_preconnect_session_ended']);
    expect(emitDiag).toHaveBeenCalledWith(session, 'persona_preconnect_fallback', expect.objectContaining({ reason: 'session_ended', persona: 'devon' }));
  });

  it('closes the pending stream when the swap is cancelled', async () => {
    jest.useFakeTimers();
    const session = makeSession();
    const client = new FakeClient();
    const emitDiag = jest.fn();
    const entry = startPersonaPreconnect(session, 'devon', async () => built(client), { emitDiag, tickMs: 1000 });
    await entry.ready;
    session.pendingPersonaSwap = null;
    jest.advanceTimersByTime(1000);
    expect(session.pendingPersonaUpstream).toBeNull();
    expect(client.closeReasons).toEqual(['persona_preconnect_swap_cancelled']);
  });

  it('bounds the lifetime (TTL) of an unclaimed stream', async () => {
    jest.useFakeTimers();
    let t = 0;
    const session = makeSession();
    const client = new FakeClient();
    const emitDiag = jest.fn();
    const entry = startPersonaPreconnect(session, 'devon', async () => built(client), {
      emitDiag, tickMs: 1000, ttlMs: 60_000, now: () => t,
    });
    await entry.ready;
    t = 59_000; jest.advanceTimersByTime(1000);
    expect(session.pendingPersonaUpstream).toBe(entry);
    t = 60_000; jest.advanceTimersByTime(1000);
    expect(session.pendingPersonaUpstream).toBeNull();
    expect(client.closeReasons).toEqual(['persona_preconnect_expired']);
    expect(emitDiag).toHaveBeenCalledWith(session, 'persona_preconnect_fallback', expect.objectContaining({ reason: 'expired' }));
  });

  it('a stream that lands after its entry was discarded is closed', async () => {
    const session = makeSession();
    const client = new FakeClient();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const entry = startPersonaPreconnect(session, 'devon', async () => { await gate; return built(client); }, { emitDiag: () => {} });
    discardPersonaPreconnect(session, 'swap_cancelled', { emitDiag: () => {} });
    release();
    expect(await entry.ready).toBeNull();
    expect(client.closeReasons).toEqual(['persona_preconnect_discarded']);
  });

  it('a failed connect leaves a failed entry the swap reads as a fallback', async () => {
    const session = makeSession();
    const entry = startPersonaPreconnect(session, 'devon', async () => { throw new Error('nova_validation'); }, { emitDiag: () => {} });
    expect(await entry.ready).toBeNull();
    expect(entry.state).toBe('failed');
    expect(checkPersonaPreconnectForSwap(session, 'devon', ON)).toEqual({ ok: false, reason: 'connect_failed' });
    stopTimer(session);
  });
});

describe('checkPersonaPreconnectForSwap', () => {
  async function ready(over: Record<string, unknown> = {}) {
    const session = makeSession(over);
    const client = new FakeClient();
    const entry = startPersonaPreconnect(session, 'devon', async () => built(client), { emitDiag: () => {} });
    await entry.ready;
    return { session, client };
  }
  it('ok for a ready stream with unchanged inputs (and for one still connecting)', async () => {
    const { session } = await ready();
    expect(checkPersonaPreconnectForSwap(session, 'devon', ON)).toEqual({ ok: true });
    stopTimer(session);
    const s2 = makeSession();
    startPersonaPreconnect(s2, 'devon', () => new Promise(() => {}), { emitDiag: () => {} });
    expect(checkPersonaPreconnectForSwap(s2, 'devon', ON)).toEqual({ ok: true });
    stopTimer(s2);
  });
  it.each([
    ['route', { current_route: '/business' }],
    ['language', { lang: 'en' }],
    ['prompt', { personaSystemOverride: 'other' }],
    ['voice override', { personaVoiceOverride: 'x' }],
    ['role', { active_role: 'admin' }],
    ['mobile', { clientContext: { isMobile: true } }],
  ])('session_changed when the %s changed', async (_l, change) => {
    const { session } = await ready();
    Object.assign(session, change);
    expect(checkPersonaPreconnectForSwap(session, 'devon', ON)).toEqual({ ok: false, reason: 'session_changed' });
    stopTimer(session);
  });
  it('reasons for the other fallbacks', async () => {
    expect(checkPersonaPreconnectForSwap(makeSession(), 'devon', OFF)).toEqual({ ok: false, reason: 'disabled' });
    expect(checkPersonaPreconnectForSwap(makeSession(), 'vitana', ON)).toEqual({ ok: false, reason: 'target_not_specialist' });
    expect(checkPersonaPreconnectForSwap(makeSession({ upstreamProvider: 'cascaded' }), 'devon', ON)).toEqual({ ok: false, reason: 'not_nova' });
    expect(checkPersonaPreconnectForSwap(makeSession(), 'devon', ON)).toEqual({ ok: false, reason: 'no_preconnect' });
    const { session, client } = await ready();
    expect(checkPersonaPreconnectForSwap(session, 'sage', ON)).toEqual({ ok: false, reason: 'persona_mismatch' });
    client.state = 'closed';
    expect(checkPersonaPreconnectForSwap(session, 'devon', ON)).toEqual({ ok: false, reason: 'preconnect_closed' });
    stopTimer(session);
  });
  it('the key covers every input the specialist envelope reads', () => {
    const a = personaPreconnectKey(makeSession(), 'devon');
    expect(personaPreconnectKey(makeSession(), 'devon')).toBe(a);
    expect(personaPreconnectKey(makeSession({ personaForcedFirstMessage: 'x' }), 'devon')).not.toBe(a);
    expect(personaPreconnectKey(makeSession({ personaFirstUtteranceDelivered: true }), 'devon')).not.toBe(a);
    expect(personaPreconnectKey(makeSession({ isAnonymous: true }), 'devon')).not.toBe(a);
  });
});

describe('claimPersonaPreconnect', () => {
  async function armed() {
    const session = makeSession();
    const client = new FakeClient();
    const emitDiag = jest.fn();
    const entry = startPersonaPreconnect(session, 'devon', async () => built(client), { emitDiag });
    await entry.ready;
    session._personaPreconnectClaimArmed = true;
    return { session, client, emitDiag };
  }

  it('never claims for a connect the hand-off did not arm (retry, rotation)', async () => {
    const session = makeSession();
    const client = new FakeClient();
    const entry = startPersonaPreconnect(session, 'devon', async () => built(client), { emitDiag: () => {} });
    await entry.ready;
    expect(await claimPersonaPreconnect(session, fresh(), { emitDiag: jest.fn() })).toBeNull();
    expect(session.pendingPersonaUpstream).toBe(entry); // untouched
    expect(client.closeReasons).toEqual([]);
    stopTimer(session);
  });

  it('claims a byte-identical envelope and reports persona_preconnect_used', async () => {
    const { session, client, emitDiag } = await armed();
    const got = await claimPersonaPreconnect(session, fresh(), { emitDiag });
    expect(got).toBe(client);
    expect(session.pendingPersonaUpstream).toBeNull();
    expect(session._personaPreconnectClaimArmed).toBe(false);
    expect(client.closeReasons).toEqual([]);
    expect(emitDiag).toHaveBeenCalledWith(session, 'persona_preconnect_used', expect.objectContaining({ persona: 'devon', voice: 'matthew' }));
  });

  it.each([
    ['instruction_mismatch', { systemInstruction: 'INSTRUCTION-DEVON + carried tool result' }],
    ['tools_mismatch', { tools: [{ function_declarations: [{ name: 'append_to_ticket' }, { name: 'x' }] }] }],
    ['voice_mismatch', { voiceId: 'tina' }],
  ])('falls back on %s and closes the pre-connected stream', async (reason, over) => {
    const { session, client, emitDiag } = await armed();
    expect(await claimPersonaPreconnect(session, fresh(over), { emitDiag })).toBeNull();
    expect(client.closeReasons).toEqual([`persona_preconnect_${reason}`]);
    expect(emitDiag).toHaveBeenCalledWith(session, 'persona_preconnect_fallback', expect.objectContaining({ reason }));
    expect(session.pendingPersonaUpstream).toBeNull();
  });

  it('waits for a connect still in flight, then claims it', async () => {
    const session = makeSession();
    const client = new FakeClient();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    startPersonaPreconnect(session, 'devon', async () => { await gate; return built(client); }, { emitDiag: () => {} });
    session._personaPreconnectClaimArmed = true;
    session.pendingPersonaSwap = null; // turn complete cleared it
    const claim = claimPersonaPreconnect(session, fresh(), { emitDiag: jest.fn() });
    release();
    expect(await claim).toBe(client);
  });

  it('falls back when the connect failed', async () => {
    const session = makeSession();
    startPersonaPreconnect(session, 'devon', async () => { throw new Error('boom'); }, { emitDiag: () => {} });
    session._personaPreconnectClaimArmed = true;
    const emitDiag = jest.fn();
    expect(await claimPersonaPreconnect(session, fresh(), { emitDiag })).toBeNull();
    expect(emitDiag).toHaveBeenCalledWith(session, 'persona_preconnect_fallback', expect.objectContaining({ reason: 'connect_failed' }));
  });

  it('comparePreconnectedEnvelope is exact', () => {
    const a = built(new FakeClient());
    expect(comparePreconnectedEnvelope(a, a)).toBeNull();
    expect(comparePreconnectedEnvelope(a, { ...a, systemInstruction: a.systemInstruction + ' ' })).toBe('instruction_mismatch');
  });
});

describe('retireSupersededClient', () => {
  it('detaches every handler so nothing the old stream emits reaches the session, then closes it', async () => {
    const old = new FakeClient();
    const sessionAudio = jest.fn();
    old.onAudioOutput(sessionAudio);
    old.onToolCall(sessionAudio);
    const onClosed = jest.fn();
    retireSupersededClient(old as any, 'persona_swap', onClosed);
    old.handlers.audio?.({ dataB64: 'AAAA' });
    old.handlers.tool?.({ calls: [] });
    expect(sessionAudio).not.toHaveBeenCalled();
    await flush();
    expect(old.closeReasons).toEqual(['persona_swap']);
    expect(onClosed).toHaveBeenCalledWith(expect.objectContaining({ reason: 'persona_swap', initiatedLocally: true }));
  });
});

describe('takeOverPersonaSwapWithPreconnect', () => {
  async function queued() {
    const session = makeSession();
    const devon = new FakeClient();
    await startPersonaPreconnect(session, 'devon', async () => built(devon), { emitDiag: () => {} }).ready;
    // turn complete (today's mutations):
    session.activePersona = 'devon';
    session.pendingPersonaSwap = null;
    session._personaSwapInFlight = true;
    return { session, devon };
  }

  it('retires the old stream, runs the reconnect, and the reconnect claims the pre-connect', async () => {
    const { session, devon } = await queued();
    const old = new FakeClient();
    session.upstreamClient = old;
    const clearKeepalive = jest.fn();
    const emitDiag = jest.fn();
    let claimed: unknown = null;
    const reconnect = jest.fn(async () => {
      // what connectToLiveAPI does after building the envelope
      claimed = await claimPersonaPreconnect(session, fresh(), { emitDiag });
      session._personaSwapInFlight = false; // attemptTransparentReconnect's own reset
      return true;
    });
    const took = takeOverPersonaSwapWithPreconnect({
      session, persona: 'devon', oldClient: old as any, emitDiag, clearKeepalive, reconnect, env: ON,
    });
    expect(took).toBe(true);
    expect(clearKeepalive).toHaveBeenCalledWith(session);
    expect(session.upstreamClient).toBeNull();
    expect(reconnect).toHaveBeenCalledTimes(1);
    await flush(); await flush();
    expect(claimed).toBe(devon);
    expect(old.closeReasons).toEqual(['persona_swap']);
    expect(devon.closeReasons).toEqual([]);
    expect(session._personaSwapInFlight).toBe(false);
    expect(session._personaPreconnectClaimArmed).toBe(false);
    expect(emitDiag).toHaveBeenCalledWith(session, 'upstream_closed', expect.objectContaining({ superseded_by_preconnect: true }));
    expect(emitDiag).toHaveBeenCalledWith(session, 'persona_preconnect_used', expect.anything());
  });

  it('closes the pre-connect when the reconnect never reached the claim', async () => {
    const { session, devon } = await queued();
    const emitDiag = jest.fn();
    takeOverPersonaSwapWithPreconnect({
      session, persona: 'devon', oldClient: new FakeClient() as any, emitDiag, clearKeepalive: jest.fn(),
      reconnect: async () => false, env: ON,
    });
    await flush(); await flush();
    expect(devon.closeReasons).toEqual(['persona_preconnect_not_claimed']);
    expect(session._personaSwapInFlight).toBe(false);
    expect(emitDiag).toHaveBeenCalledWith(session, 'persona_preconnect_fallback', expect.objectContaining({ reason: 'not_claimed' }));
  });

  it('returns false (today\'s close path) and reports why when nothing usable is pending', () => {
    const session = makeSession({ activePersona: 'devon', pendingPersonaSwap: null });
    const emitDiag = jest.fn();
    const reconnect = jest.fn();
    const old = new FakeClient();
    expect(takeOverPersonaSwapWithPreconnect({
      session, persona: 'devon', oldClient: old as any, emitDiag, clearKeepalive: jest.fn(), reconnect, env: ON,
    })).toBe(false);
    expect(reconnect).not.toHaveBeenCalled();
    expect(old.closeReasons).toEqual([]);
    expect(emitDiag).toHaveBeenCalledWith(session, 'persona_preconnect_fallback', { reason: 'no_preconnect', persona: 'devon' });
  });

  it('falls back and closes the pre-connect when the session inputs changed before the swap', async () => {
    const { session, devon } = await queued();
    session.current_route = '/somewhere-else';
    const emitDiag = jest.fn();
    expect(takeOverPersonaSwapWithPreconnect({
      session, persona: 'devon', oldClient: new FakeClient() as any, emitDiag, clearKeepalive: jest.fn(), reconnect: jest.fn(), env: ON,
    })).toBe(false);
    expect(devon.closeReasons).toEqual(['persona_preconnect_session_changed']);
  });

  it('falls back while a Nova rotation is in flight', async () => {
    const { session } = await queued();
    session._novaRotationInFlight = true;
    const emitDiag = jest.fn();
    expect(takeOverPersonaSwapWithPreconnect({
      session, persona: 'devon', oldClient: new FakeClient() as any, emitDiag, clearKeepalive: jest.fn(), reconnect: jest.fn(), env: ON,
    })).toBe(false);
    expect(emitDiag).toHaveBeenCalledWith(session, 'persona_preconnect_fallback', expect.objectContaining({ reason: 'rotation_in_flight' }));
    stopTimer(session);
  });
});
