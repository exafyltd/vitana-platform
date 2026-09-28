/**
 * VTID-04547 — ORB latency E: open the WebSocket while continuity loads.
 *
 * Before: every authenticated tap awaited GET /orb/session/continuity (up to
 * 400 ms, plus the body read) BEFORE the WebSocket was even created, so the
 * continuity round trip and the socket handshake ran back to back on the
 * tap-to-first-audio path. The activation chime waited behind it too.
 *
 * After: _sessionStart opens the socket (or claims the prewarmed one) and
 * plays the chime BEFORE awaiting continuity, and hands _sessionStartWs a
 * PROMISE of the start payload. The `start` frame is sent only once BOTH the
 * socket is connected AND that promise resolved — so the payload (which
 * carries transcript_history / conversation_id from continuity) is
 * byte-identical to before.
 *
 * Static checks pin the ordering in _sessionStart; the behavioural block runs
 * the REAL _sessionStartWs source (extracted from orb-widget.js) against a
 * fake WebSocket and asserts what goes on the wire, and when.
 */
import * as fs from 'fs';
import * as path from 'path';

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

function extractFunction(source: string, signature: string): { full: string; body: string } {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) {
      return { full: source.slice(sigIdx, i + 1), body: source.slice(openIdx + 1, i) };
    }
  }
  throw new Error(`unclosed function body: ${signature}`);
}

const source = fs.readFileSync(WIDGET_PATH, 'utf8');

describe('VTID-04547 static ordering in _sessionStart', () => {
  const body = extractFunction(source, 'async function _sessionStart()').body;
  const iEarlyOpen = body.indexOf('_wsEarly.promise = _sessionStartWs(_wsPayloadGate);');
  const iContinuityAwait = body.indexOf("contResp = await fetch(_cfg.gw + '/api/v1/orb/session/continuity'");
  const iChime = body.indexOf('_playChime(_s.playbackCtx);');
  const iKeepAlive = body.indexOf('_startCtxKeepAlive();');
  const iRelease = body.indexOf('_wsEarly.release(startPayload);');
  const iPayloadHistory = body.indexOf('startPayload.transcript_history = ');

  it('opens the socket BEFORE the continuity fetch is awaited', () => {
    expect(iEarlyOpen).toBeGreaterThan(0);
    expect(iContinuityAwait).toBeGreaterThan(0);
    expect(iEarlyOpen).toBeLessThan(iContinuityAwait);
  });

  it('only opens early when the WS transport is selected (SSE unchanged)', () => {
    const openBlock = body.slice(body.indexOf('var _wsEarly = null;'), iEarlyOpen);
    expect(openBlock).toMatch(/if \(_useWsTransport\(\)\) \{/);
    // The SSE POST still happens after continuity, with the built payload.
    expect(body.indexOf("'/api/v1/orb/live/session/start'")).toBeGreaterThan(iContinuityAwait);
  });

  it('plays the chime and starts the ctx keep-alive before awaiting continuity, exactly once', () => {
    expect(iChime).toBeGreaterThan(0);
    expect(iChime).toBeLessThan(iContinuityAwait);
    expect(iKeepAlive).toBeLessThan(iContinuityAwait);
    expect(body.split('_playChime(_s.playbackCtx);').length - 1).toBe(1);
    expect(body.split('_startCtxKeepAlive();').length - 1).toBe(1);
  });

  it('still unlocks the playback context before ANY await (gesture window)', () => {
    const iUnlock = body.indexOf('_silentUnlockSrc.start(0);');
    // First await in CODE (comments mention the word too).
    const iFirstAwait = body.search(/=\s*await |\n\s*await /);
    expect(iUnlock).toBeGreaterThan(0);
    expect(iUnlock).toBeLessThan(iFirstAwait);
    expect(iUnlock).toBeLessThan(iEarlyOpen);
  });

  it('releases the payload only after it has been fully built from continuity', () => {
    expect(iRelease).toBeGreaterThan(iContinuityAwait);
    expect(iRelease).toBeGreaterThan(iPayloadHistory);
  });

  it('closes an early socket that never received a payload when the start fails', () => {
    const catchIdx = body.lastIndexOf('} catch (err) {');
    expect(body.slice(catchIdx)).toMatch(/if \(_wsEarly && !_wsEarly\.released\) _wsEarly\.release\(null\);/);
  });

  it('keeps the WS→SSE transport fallback and the server-rejection rethrow', () => {
    expect(body).toContain('if (wsErr && wsErr.__vtOrbServerRejected) throw wsErr;');
    expect(body).toContain('_latchWsFallback(');
  });
});

// ─── Behavioural: the real _sessionStartWs against a fake WebSocket ───────────

type Sent = Record<string, unknown>;

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: Sent[] = [];
  closed = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  // test helpers
  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  recv(msg: Record<string, unknown>) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
}

function loadSessionStartWs(state: Record<string, unknown>) {
  const fn = extractFunction(source, 'function _sessionStartWs(startPayload)').full;
  const calls: string[] = [];
  const stubs: Record<string, unknown> = {
    _s: state,
    _cfg: { gw: 'https://gw.example', token: 'tok' },
    WebSocket: FakeWS,
    _closeWs: (sendStop: boolean) => {
      calls.push('closeWs:' + sendStop);
      const w = state.ws as FakeWS | null;
      state.ws = null;
      if (w) w.close();
    },
  };
  // Every other widget-internal helper (_signalAudioReady, _updateUI,
  // _startWatchdog, _latMark, ...) resolves to a recording no-op.
  const scope = new Proxy(stubs, {
    has: (_t, key) => typeof key === 'string' && (key in stubs || key.startsWith('_')),
    get: (_t, key) => {
      if (typeof key !== 'string') return undefined;
      if (key in stubs) return stubs[key];
      return (..._args: unknown[]) => {
        calls.push(key);
      };
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('scope', `with (scope) { ${fn}\n return _sessionStartWs; }`);
  return { start: factory(scope) as (p: unknown) => Promise<void>, calls };
}

function freshState(extra: Record<string, unknown> = {}) {
  return {
    prewarmWs: null,
    prewarmWsReady: false,
    ws: null,
    overlayVisible: true,
    _userInitiatedStop: false,
    _sessionGeneration: 0,
    ...extra,
  } as Record<string, unknown>;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('VTID-04547 _sessionStartWs payload gate (behavioural)', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    jest.useRealTimers();
  });

  const payload = {
    lang: 'de',
    voice_style: 'friendly, calm, empathetic',
    response_modalities: ['audio', 'text'],
    vad_silence_ms: 600,
    transcript_history: [{ role: 'user', text: 'hallo' }],
    reconnect_stage: 'idle',
    conversation_id: 'conv-1',
  };

  it('opens the socket immediately but sends start only after BOTH connected and payload', async () => {
    const state = freshState();
    const { start } = loadSessionStartWs(state);
    let release!: (p: unknown) => void;
    const gate = new Promise((r) => { release = r; });
    const done = start(gate);

    expect(FakeWS.instances).toHaveLength(1); // socket opened before payload
    const w = FakeWS.instances[0];
    w.open();
    w.recv({ type: 'connected' });
    await flush();
    expect(w.sent).toHaveLength(0); // connected, but no payload yet

    release(payload);
    await flush();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toEqual({ type: 'start', ...payload }); // byte-identical payload

    w.recv({ type: 'session_started', session_id: 's-1' });
    await done;
    expect(state.sessionId).toBe('s-1');
    expect(state.active).toBe(true);
  });

  it('payload first, connected later: start goes out on connected', async () => {
    const state = freshState();
    const { start } = loadSessionStartWs(state);
    const done = start(Promise.resolve(payload));
    await flush();
    const w = FakeWS.instances[0];
    expect(w.sent).toHaveLength(0);
    w.open();
    w.recv({ type: 'connected' });
    expect(w.sent).toEqual([{ type: 'start', ...payload }]);
    w.recv({ type: 'session_started', session_id: 's-2' });
    await done;
  });

  it('claims a ready prewarmed socket and sends start once the payload resolves', async () => {
    const pre = new FakeWS('prewarm');
    pre.readyState = 1;
    FakeWS.instances = [];
    const state = freshState({ prewarmWs: pre, prewarmWsReady: true });
    const { start } = loadSessionStartWs(state);
    let release!: (p: unknown) => void;
    const done = start(new Promise((r) => { release = r; }));
    expect(FakeWS.instances).toHaveLength(0); // no new socket
    expect(state.prewarmWs).toBeNull();
    expect(pre.sent).toHaveLength(0);
    release(payload);
    await flush();
    expect(pre.sent).toEqual([{ type: 'start', ...payload }]);
    pre.recv({ type: 'session_started', session_id: 's-3' });
    await done;
  });

  it('a plain payload object keeps the pre-VTID-04547 behaviour', async () => {
    const state = freshState();
    const { start } = loadSessionStartWs(state);
    const done = start(payload);
    const w = FakeWS.instances[0];
    w.open();
    w.recv({ type: 'connected' });
    expect(w.sent).toEqual([{ type: 'start', ...payload }]);
    w.recv({ type: 'session_started', session_id: 's-4' });
    await done;
  });

  it('a null payload (start aborted before a payload existed) closes without sending start', async () => {
    const state = freshState();
    const { start } = loadSessionStartWs(state);
    const done = start(Promise.resolve(null));
    const w = FakeWS.instances[0];
    await done;
    expect(w.closed).toBe(true);
    expect(w.sent).toHaveLength(0);
  });

  it('overlay closed while continuity was loading: bails instead of sending start', async () => {
    const state = freshState();
    const { start, calls } = loadSessionStartWs(state);
    let release!: (p: unknown) => void;
    const done = start(new Promise((r) => { release = r; }));
    const w = FakeWS.instances[0];
    w.open();
    w.recv({ type: 'connected' });
    state.overlayVisible = false; // user pressed X during continuity
    release(payload);
    await done;
    expect(w.sent).toHaveLength(0);
    expect(calls).toContain('closeWs:true');
  });

  it('a socket that dies while the payload is pending rejects (transport fallback path)', async () => {
    const state = freshState();
    const { start } = loadSessionStartWs(state);
    const done = start(new Promise(() => { /* never */ }));
    const w = FakeWS.instances[0];
    if (w.onclose) w.onclose();
    await expect(done).rejects.toThrow('WS closed during session start');
  });

  it('arms the 8s start budget when the payload arrives, not while continuity loads', async () => {
    jest.useFakeTimers();
    const state = freshState();
    const { start } = loadSessionStartWs(state);
    let release!: (p: unknown) => void;
    const done = start(new Promise((r) => { release = r; }));
    let rejected: Error | null = null;
    done.catch((e) => { rejected = e; });
    jest.advanceTimersByTime(9000); // continuity "slow" — no timeout yet
    await Promise.resolve();
    expect(rejected).toBeNull();
    release(payload);
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(8001);
    await Promise.resolve();
    await Promise.resolve();
    expect(rejected).not.toBeNull();
    expect(String(rejected)).toMatch(/WS session start timed out after 8s/);
    jest.useRealTimers();
  });
});
