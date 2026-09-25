/**
 * VTID-04542 (P0, client half) — tap-to-audio latency beacon.
 *
 * The widget records performance.now() marks relative to the tap and POSTs
 * them ONCE per tap cycle to `${gw}/api/v1/orb/live/client-latency` with the
 * exact body contract
 *   { session_id, entry: 'mobile'|'desktop'|'command_hub',
 *     transport: 'ws'|'sse', marks: { name: ms }, prewarm_socket_ready }
 * after first audio, or with what exists when the overlay closes before any
 * audio. Fire-and-forget (keepalive), never throws, never on the audio path.
 *
 * Static checks pin where each mark is taken; the behavioural block runs the
 * REAL beacon helpers (extracted from orb-widget.js) with a fake clock/fetch.
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

describe('VTID-04542 beacon wiring (static)', () => {
  it('posts to the client-latency route with keepalive and the widget Authorization header', () => {
    expect(source).toMatch(/var _LAT_BEACON_PATH = '\/api\/v1\/orb\/live\/client-latency';/);
    const flush = extractFunction('function _latFlush()').body;
    expect(flush).toMatch(/keepalive: true/);
    expect(flush).toMatch(/headers\['Authorization'\] = 'Bearer ' \+ _cfg\.token/);
    expect(flush).toMatch(/\.catch\(function \(\) \{/); // swallowed
    expect(flush).toMatch(/l\.posted = true;/); // once
  });

  it('starts the cycle at the tap (_show) and flushes on close (_hide)', () => {
    const show = extractFunction('function _show()').body;
    expect(show.indexOf('_latBegin()')).toBeGreaterThanOrEqual(0);
    expect(show.indexOf('_latBegin()')).toBeLessThan(show.indexOf('_sessionStart()'));
    const hide = extractFunction('function _hide()').body;
    expect(hide.indexOf('_latFlush()')).toBeGreaterThanOrEqual(0);
    expect(hide.indexOf('_latFlush()')).toBeLessThan(hide.indexOf('_sessionStop()'));
  });

  it('takes each mark at the right place in the session start', () => {
    const start = extractFunction('async function _sessionStart()').body;
    expect(start).toMatch(/_latSessionAttempt\(\);/);
    expect(start).toMatch(/_latMark\('continuity_done'\)/);
    expect(start).toMatch(/_latMark\('start_sent'\);\s*\n\s*var resp = await fetch\(_cfg\.gw \+ '\/api\/v1\/orb\/live\/session\/start'/);
    expect(start).toMatch(/_latMark\('session_started'\)/);
    expect(start).toMatch(/es\.onopen = function \(\) \{\s*\n\s*_latMark\('socket_open'\)/);
    const ws = extractFunction('function _sessionStartWs(startPayload)').body;
    expect(ws).toMatch(/_latNote\('ws', reused\);/);
    expect(ws).toMatch(/if \(reused\) _latMark\('socket_open'\);/);
    expect(ws).toMatch(/else w\.onopen = function \(\) \{ _latMark\('socket_open'\); \};/);
    expect(ws).toMatch(/_latMark\('session_started'\)/);
    expect(ws).toMatch(/_latMark\('start_sent'\)/);
  });

  it('marks first audio right after the first model-audio source.start in _processQueue', () => {
    const pq = extractFunction('function _processQueue()').body;
    expect(pq).toMatch(/src\.start\(_s\.lastScheduledEnd\);\s*\n\s*\/\/[^\n]*\n\s*_latFirstAudio\(ctx, _s\.lastScheduledEnd\);/);
    // Decoy sources (silent unlock, keep-alive, chime) never call it.
    expect((source.match(/(?<!function )_latFirstAudio\(/g) || []).length).toBe(1);
    const fa = extractFunction('function _latFirstAudio(ctx, startAt)').body;
    expect(fa).toMatch(/setTimeout\(_latFlush, 0\)/); // off the audio path
  });
});

// ─── Behavioural ─────────────────────────────────────────────────────────────

const HELPERS = [
  'function _latNow()',
  'function _latBegin()',
  'function _latSessionAttempt()',
  'function _latMark(name, unprefixed, atMs)',
  'function _latNote(transport, prewarmReady, sessionId)',
  'function _latFirstAudio(ctx, startAt)',
  'function _latEntry()',
  'function _latFlush()',
];

function load(opts: { pathname?: string; ua?: string; token?: string; useWs?: boolean; fetchThrows?: boolean } = {}) {
  let clock = 1000;
  const posts: { url: string; init: Record<string, unknown> }[] = [];
  const state: Record<string, unknown> = { sessionId: null, _lat: null };
  const perf = { now: () => clock };
  const stubs: Record<string, unknown> = {
    _s: state,
    _cfg: { gw: 'https://gw.example', token: opts.token },
    _LAT_BEACON_PATH: '/api/v1/orb/live/client-latency',
    _useWsTransport: () => opts.useWs !== false,
    window: { performance: perf, location: { pathname: opts.pathname ?? '/home' } },
    performance: perf,
    navigator: { userAgent: opts.ua ?? 'Mozilla/5.0 (Macintosh)' },
    fetch: (url: string, init: Record<string, unknown>) => {
      if (opts.fetchThrows) throw new Error('offline');
      posts.push({ url, init });
      return Promise.resolve({ ok: false, status: 404 });
    },
  };
  const scope = new Proxy(stubs, {
    has: (_t, key) => typeof key === 'string' && (key in stubs || key.startsWith('_')),
    get: (_t, key) => (typeof key === 'string' && key in stubs ? stubs[key] : undefined),
  });
  const src = HELPERS.map((h) => extractFunction(h).full).join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const api = new Function(
    'scope',
    `with (scope) { ${src}\n return { _latBegin, _latSessionAttempt, _latMark, _latNote, _latFirstAudio, _latFlush }; }`,
  )(scope);
  return {
    api,
    state,
    posts,
    tick: (ms: number) => { clock += ms; },
    body: () => JSON.parse(posts[0].init.body as string),
  };
}

describe('VTID-04542 beacon (behavioural)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('WS happy path: one POST after first audio, exact contract, marks relative to the tap', () => {
    const h = load({ token: 'jwt-1' });
    const { api } = h;
    api._latBegin(); // tap
    api._latSessionAttempt();
    api._latNote('ws', true);
    api._latMark('socket_open');
    h.tick(120); api._latMark('continuity_done');
    h.tick(5); api._latMark('start_sent');
    h.tick(300); api._latMark('session_started'); api._latNote('ws', null, 'sess-9');
    h.tick(900);
    api._latFirstAudio({ currentTime: 5 }, 5.3); // scheduled 300 ms ahead
    expect(h.posts).toHaveLength(0); // deferred off the audio path
    jest.runOnlyPendingTimers();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].url).toBe('https://gw.example/api/v1/orb/live/client-latency');
    expect(h.posts[0].init.method).toBe('POST');
    expect(h.posts[0].init.keepalive).toBe(true);
    expect((h.posts[0].init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    const b = h.body();
    expect(Object.keys(b).sort()).toEqual(['entry', 'marks', 'prewarm_socket_ready', 'session_id', 'transport']);
    expect(b).toEqual({
      session_id: 'sess-9',
      entry: 'desktop',
      transport: 'ws',
      prewarm_socket_ready: true,
      marks: {
        tap: 0,
        socket_open: 0,
        continuity_done: 120,
        start_sent: 125,
        session_started: 425,
        first_audio_scheduled: 1325,
        first_audio_played: 1625,
      },
    });
    // Only once, even if more audio / a close follows.
    api._latFirstAudio({ currentTime: 9 }, 9);
    api._latFlush();
    jest.runOnlyPendingTimers();
    expect(h.posts).toHaveLength(1);
  });

  it('reconnects get reconnect<N>_ prefixed marks; first-audio marks stay unprefixed', () => {
    const h = load();
    const { api } = h;
    api._latBegin();
    api._latSessionAttempt();
    api._latMark('start_sent');
    h.tick(2000);
    api._latSessionAttempt(); // reconnect 1
    h.tick(10); api._latMark('start_sent');
    h.tick(10); api._latMark('session_started');
    h.tick(10); api._latFirstAudio({ currentTime: 0 }, 0);
    jest.runOnlyPendingTimers();
    const m = h.body().marks;
    expect(m.start_sent).toBe(0);
    expect(m.reconnect1_start).toBe(2000);
    expect(m.reconnect1_start_sent).toBe(2010);
    expect(m.reconnect1_session_started).toBe(2020);
    expect(m.session_started).toBeUndefined();
    expect(m.first_audio_scheduled).toBe(2030);
    expect(m.first_audio_played).toBe(2030);
  });

  it('closed before any audio: flush sends what it has, once', () => {
    const h = load({ useWs: false });
    const { api } = h;
    api._latBegin();
    api._latSessionAttempt();
    h.tick(50); api._latMark('continuity_done');
    api._latFlush(); // _hide
    api._latFlush();
    expect(h.posts).toHaveLength(1);
    const b = h.body();
    expect(b.session_id).toBe(''); // no session yet
    expect(b.transport).toBe('sse'); // never chose ⇒ current preference
    expect(b.prewarm_socket_ready).toBe(false);
    expect(b.marks).toEqual({ tap: 0, continuity_done: 50 });
    expect((h.posts[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('entry: command_hub by path, mobile by the widget UA test, else desktop', () => {
    const cases: [Record<string, string>, string][] = [
      [{ pathname: '/command-hub/overview' }, 'command_hub'],
      [{ pathname: '/home', ua: 'Mozilla/5.0 (Linux; Android 14)' }, 'mobile'],
      [{ pathname: '/home', ua: 'Mozilla/5.0 (iPad; CPU OS 17_0)' }, 'mobile'],
      [{ pathname: '/home', ua: 'Mozilla/5.0 (Windows NT 10.0)' }, 'desktop'],
    ];
    for (const [o, want] of cases) {
      const h = load(o);
      h.api._latBegin();
      h.api._latFlush();
      expect(h.body().entry).toBe(want);
    }
  });

  it('marks outside a tap cycle, or after it was sent, are dropped silently', () => {
    const h = load();
    const { api } = h;
    expect(() => { api._latMark('continuity_done'); api._latSessionAttempt(); api._latFirstAudio(null, 0); }).not.toThrow();
    jest.runOnlyPendingTimers();
    expect(h.posts).toHaveLength(0);
  });

  it('never throws when fetch itself throws synchronously', () => {
    const h = load({ fetchThrows: true });
    h.api._latBegin();
    expect(() => h.api._latFlush()).not.toThrow();
  });
});
