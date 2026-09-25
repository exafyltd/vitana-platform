/**
 * VTID-04554 — ORB latency L (client half): audio_ready is always sent.
 *
 * _signalAudioReady() only sent `audio_ready` when the playback AudioContext
 * was already 'running' at session_started. Otherwise it returned, and the
 * only retry was _processQueue's resume().then — which only runs once greeting
 * audio arrives, and the server was holding the greeting for this very ack.
 * So the server's 1 s fallback released it (measured ~50 % of WS sessions).
 *
 * Now: a not-yet-running context is awaited (its resume() was already
 * requested in the tap gesture) for at most _AUDIO_READY_RESUME_BOUND_MS, and
 * audio_ready is sent then — or immediately on a statechange → 'running'
 * inside that window. At most once per session; never without a session id.
 *
 * The behavioural block runs the REAL _signalAudioReady source against a fake
 * AudioContext and a fake WebSocket.
 */
import * as fs from 'fs';
import * as path from 'path';

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);
const source = fs.readFileSync(WIDGET_PATH, 'utf8');

function extractFunction(signature: string): { full: string; body: string } {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return { full: source.slice(sigIdx, i + 1), body: source.slice(openIdx + 1, i) };
  }
  throw new Error(`unclosed function body: ${signature}`);
}

describe('VTID-04554 static wiring', () => {
  it('bounds the wait at 300 ms (well under the server 1 s fallback)', () => {
    expect(source).toMatch(/var _AUDIO_READY_RESUME_BOUND_MS = 300;/);
  });

  it('no longer gives up when the context is not running — it arms a bounded wait', () => {
    const body = extractFunction('function _signalAudioReady()').body;
    expect(body).toMatch(/if \(_s\._audioReadyWaitSid === sid\) return;/);
    expect(body).toMatch(/ctx\.addEventListener\('statechange', onState\)/);
    expect(body).toMatch(/boundTimer = setTimeout\(fire, _AUDIO_READY_RESUME_BOUND_MS\);/);
    // Still never before the session id is known.
    expect(body).toMatch(/if \(!_s\.sessionId\) return;/);
  });

  it('the tap-to-hear suspended-context recovery in _processQueue is untouched', () => {
    const pq = extractFunction('function _processQueue()').body;
    expect(pq).toMatch(/_announceAudioBlocked\(\{ reason: 'resume_timeout', elapsed_ms: elapsed \}\);/);
    expect(pq).not.toMatch(/_s\.audioQueue\.length = 0\s*;/);
  });
});

// ─── Behavioural ─────────────────────────────────────────────────────────────

type Listener = () => void;

function makeCtx(initial: string, resumeBehaviour: 'resolve-running' | 'never' | 'reject', resumeDelayMs = 50) {
  const listeners: Listener[] = [];
  const ctx = {
    state: initial,
    resumeCalls: 0,
    addEventListener: (ev: string, fn: Listener) => { if (ev === 'statechange') listeners.push(fn); },
    removeEventListener: (ev: string, fn: Listener) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    resume: () => {
      ctx.resumeCalls++;
      if (resumeBehaviour === 'never') return new Promise(() => { /* never */ });
      if (resumeBehaviour === 'reject') return Promise.reject(new Error('not allowed'));
      return new Promise<void>((r) => setTimeout(() => { ctx.state = 'running'; r(); }, resumeDelayMs));
    },
    setState(s: string) {
      ctx.state = s;
      listeners.slice().forEach((fn) => fn());
    },
    listenerCount: () => listeners.length,
  };
  return ctx;
}

function load(state: Record<string, unknown>) {
  const fetchCalls: string[] = [];
  const stubs: Record<string, unknown> = {
    _s: state,
    _cfg: { gw: 'https://gw.example', token: 't' },
    _AUDIO_READY_RESUME_BOUND_MS: 300,
    fetch: (url: string) => { fetchCalls.push(url); return Promise.resolve({ ok: true }); },
  };
  const scope = new Proxy(stubs, {
    has: (_t, key) => typeof key === 'string' && (key in stubs || key.startsWith('_')),
    get: (_t, key) => (typeof key === 'string' && key in stubs ? stubs[key] : () => undefined),
  });
  const fn = extractFunction('function _signalAudioReady()').full;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const signal = new Function('scope', `with (scope) { ${fn}\n return _signalAudioReady; }`)(scope) as () => void;
  return { signal, fetchCalls };
}

function wsState(ctx: unknown, sessionId: string | null = 'sess-1') {
  const sent: string[] = [];
  const state: Record<string, unknown> = {
    sessionId,
    playbackCtx: ctx,
    _audioReadySignaled: false,
    ws: { readyState: 1, send: (d: string) => sent.push(d) },
  };
  return { state, sent };
}

describe('VTID-04554 _signalAudioReady (behavioural)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const flushMicro = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('running context: sends audio_ready immediately (unchanged)', () => {
    const ctx = makeCtx('running', 'never');
    const { state, sent } = wsState(ctx);
    load(state).signal();
    expect(sent).toEqual([JSON.stringify({ type: 'audio_ready' })]);
    expect(state._audioReadySignaled).toBe(true);
  });

  it('suspended context that resumes: sends as soon as it is running, before the bound', async () => {
    const ctx = makeCtx('suspended', 'resolve-running', 50);
    const { state, sent } = wsState(ctx);
    load(state).signal();
    expect(sent).toHaveLength(0);
    jest.advanceTimersByTime(50);
    await flushMicro();
    expect(sent).toHaveLength(1);
    jest.advanceTimersByTime(1000);
    await flushMicro();
    expect(sent).toHaveLength(1); // at most once
  });

  it('suspended context that never resumes: still sends at the 300 ms bound', async () => {
    const ctx = makeCtx('suspended', 'never');
    const { state, sent } = wsState(ctx);
    load(state).signal();
    jest.advanceTimersByTime(299);
    await flushMicro();
    expect(sent).toHaveLength(0);
    jest.advanceTimersByTime(1);
    await flushMicro();
    expect(sent).toEqual([JSON.stringify({ type: 'audio_ready' })]);
    expect(ctx.listenerCount()).toBe(0); // statechange listener cleaned up
  });

  it('a statechange → running (e.g. Safari "interrupted" recovering) sends immediately', async () => {
    const ctx = makeCtx('interrupted', 'never');
    const { state, sent } = wsState(ctx);
    load(state).signal();
    expect(sent).toHaveLength(0);
    ctx.setState('running');
    expect(sent).toHaveLength(1);
    jest.advanceTimersByTime(500);
    await flushMicro();
    expect(sent).toHaveLength(1);
  });

  it('a rejected resume still sends at the bound', async () => {
    const ctx = makeCtx('suspended', 'reject');
    const { state, sent } = wsState(ctx);
    load(state).signal();
    await flushMicro();
    expect(sent).toHaveLength(0);
    jest.advanceTimersByTime(300);
    expect(sent).toHaveLength(1);
  });

  it('repeated calls while waiting arm only one wait and send once', async () => {
    const ctx = makeCtx('suspended', 'never');
    const { state, sent } = wsState(ctx);
    const { signal } = load(state);
    signal();
    signal();
    signal();
    expect(ctx.listenerCount()).toBe(1);
    jest.advanceTimersByTime(300);
    expect(sent).toHaveLength(1);
  });

  it('never sends without a session id', () => {
    const ctx = makeCtx('running', 'never');
    const { state, sent } = wsState(ctx, null);
    load(state).signal();
    jest.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });

  it('a wait armed for an old session does not ack a newer one', () => {
    const ctx = makeCtx('suspended', 'never');
    const { state, sent } = wsState(ctx, 'old');
    load(state).signal();
    state.sessionId = 'new'; // reconnect happened inside the window
    jest.advanceTimersByTime(300);
    expect(sent).toHaveLength(0);
    expect(state._audioReadySignaled).toBe(false);
  });

  it('SSE transport (no open WS): POSTs the audio-ready endpoint at the bound', () => {
    const ctx = makeCtx('suspended', 'never');
    const state: Record<string, unknown> = { sessionId: 's-sse', playbackCtx: ctx, _audioReadySignaled: false, ws: null };
    const { signal, fetchCalls } = load(state);
    signal();
    expect(fetchCalls).toHaveLength(0);
    jest.advanceTimersByTime(300);
    expect(fetchCalls).toEqual(['https://gw.example/api/v1/orb/session/s-sse/audio-ready']);
  });
});
