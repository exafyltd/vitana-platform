/**
 * VTID-04552 — ORB latency J: the 300 ms mobile playback lead only on the
 * session's first burst, gated by a server-provided flag.
 *
 * _processQueue scheduled the first chunk of EVERY reply burst on a phone at
 * now + 0.3 s. That lead exists to absorb output-device start-up before the
 * greeting; paying it on every later reply is pure added latency. When the
 * server declares `playback_lead_first_only: true` (session_started /
 * live_api_ready / the SSE start response — the server reads it from
 * ORB_MOBILE_LEAD_FIRST_ONLY_ENABLED), only the first burst keeps 0.3 s and
 * later bursts get a 50 ms safety margin. Absent flag ⇒ unchanged. Desktop
 * never had a lead and still has none.
 *
 * The behavioural block runs the REAL _processQueue source against a fake
 * AudioContext and records the `start(when)` time of every scheduled chunk.
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

describe('VTID-04552 static wiring', () => {
  it('declares the two lead constants with the original 300 ms and the 50 ms margin', () => {
    expect(source).toMatch(/var _PLAYBACK_LEAD_FIRST_SEC = 0\.3;/);
    expect(source).toMatch(/var _PLAYBACK_LEAD_LATER_SEC = 0\.05;/);
  });

  it('_processQueue uses the later lead only when the server flag is on AND the first burst already went out', () => {
    const body = extractFunction('function _processQueue()').body;
    expect(body).toMatch(
      /if \(_s\.playbackLeadFirstOnly && _s\._firstBurstLeadUsed\) leadSec = _PLAYBACK_LEAD_LATER_SEC;/,
    );
    expect(body).toMatch(/_s\.lastScheduledEnd = \(isFirstChunk && isMobile\) \? now \+ leadSec : now;/);
    // The mobile test is the widget's existing UA regex, unchanged.
    expect(body).toMatch(/\/Android\|iPhone\|iPad\|iPod\/i\.test\(navigator\.userAgent\)/);
  });

  it('reads the flag from all three server handshakes and resets it per session start', () => {
    const wsStart = extractFunction('function _sessionStartWs(startPayload)').body;
    expect(wsStart).toMatch(/_s\.playbackLeadFirstOnly = msg\.playback_lead_first_only === true;/);
    const start = extractFunction('async function _sessionStart()').body;
    expect(start).toMatch(/_s\.playbackLeadFirstOnly = false;/);
    expect(start).toMatch(/_s\._firstBurstLeadUsed = false;/);
    expect(start).toMatch(/_s\.playbackLeadFirstOnly = data\.playback_lead_first_only === true;/);
    // live_api_ready only ever turns it on (absent must not undo a true).
    expect(source).toMatch(/if \(msg\.playback_lead_first_only === true\) _s\.playbackLeadFirstOnly = true;/);
    expect(source).not.toMatch(/_s\.playbackLeadFirstOnly = msg\.playback_lead_first_only === true;[\s\S]{0,40}_updateUI\(\);\s*\n\s*break;/);
  });
});

// ─── Behavioural ─────────────────────────────────────────────────────────────

class FakeSource {
  buffer: { duration: number } | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  constructor(private log: number[]) {}
  connect() {}
  start(when: number) {
    this.startedAt = when;
    this.log.push(when);
  }
}

function makeHarness(ua: string, flag: boolean) {
  const starts: number[] = [];
  const ctx = {
    state: 'running',
    currentTime: 10,
    destination: {},
    createBuffer: (_ch: number, len: number, rate: number) => ({
      duration: len / rate,
      copyToChannel: () => {},
    }),
    createBufferSource: () => new FakeSource(starts),
  };
  const state: Record<string, unknown> = {
    playbackCtx: ctx,
    audioQueue: [],
    scheduledSources: [],
    lastScheduledEnd: 0,
    audioPlaying: false,
    fullDuplex: false,
    playbackLeadFirstOnly: flag,
    _firstBurstLeadUsed: false,
    _resumeWatchdogTimer: null,
    _resumeRetryStartedAt: 0,
  };
  const stubs: Record<string, unknown> = {
    _s: state,
    navigator: { userAgent: ua },
    _PLAYBACK_LEAD_FIRST_SEC: 0.3,
    _PLAYBACK_LEAD_LATER_SEC: 0.05,
    _pcmRateFromMime: () => 24000,
    _currentPlaybackRate: () => 1,
  };
  const scope = new Proxy(stubs, {
    has: (_t, key) => typeof key === 'string' && (key in stubs || key.startsWith('_')),
    get: (_t, key) => {
      if (typeof key !== 'string') return undefined;
      if (key in stubs) return stubs[key];
      return () => undefined;
    },
  });
  const fn = extractFunction('function _processQueue()').full;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const processQueue = new Function('scope', `with (scope) { ${fn}\n return _processQueue; }`)(scope) as () => void;
  // 2400 samples of silence @24 kHz = 0.1 s per chunk.
  const chunk = Buffer.alloc(4800).toString('base64');
  return {
    starts,
    burst(n: number) {
      for (let i = 0; i < n; i++) (state.audioQueue as unknown[]).push({ data: chunk, mime: 'audio/pcm;rate=24000' });
      processQueue();
    },
    endAllAndAdvance(sec: number) {
      // Everything scheduled has played; time moves on past the last end.
      (state.scheduledSources as unknown[]).length = 0;
      ctx.currentTime = Math.max(ctx.currentTime, state.lastScheduledEnd as number) + sec;
    },
    now: () => ctx.currentTime,
  };
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)';
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('VTID-04552 _processQueue lead (behavioural)', () => {
  it('flag absent/false on mobile: every burst keeps the original 300 ms lead', () => {
    const h = makeHarness(IPHONE, false);
    let t = h.now();
    h.burst(2);
    close(h.starts[0], t + 0.3);
    close(h.starts[1], t + 0.3 + 0.1); // back-to-back within the burst
    h.endAllAndAdvance(1);
    t = h.now();
    h.burst(1);
    close(h.starts[2], t + 0.3);
  });

  it('flag true on mobile: greeting burst 300 ms, every later burst 50 ms', () => {
    const h = makeHarness(IPHONE, true);
    let t = h.now();
    h.burst(3);
    close(h.starts[0], t + 0.3);
    close(h.starts[2], t + 0.3 + 0.2);
    h.endAllAndAdvance(2);
    t = h.now();
    h.burst(2);
    close(h.starts[3], t + 0.05);
    close(h.starts[4], t + 0.05 + 0.1);
    h.endAllAndAdvance(2);
    t = h.now();
    h.burst(1);
    close(h.starts[5], t + 0.05);
  });

  it('desktop: no lead, flag or not', () => {
    for (const flag of [false, true]) {
      const h = makeHarness(DESKTOP, flag);
      const t = h.now();
      h.burst(1);
      close(h.starts[0], t);
      h.endAllAndAdvance(1);
      const t2 = h.now();
      h.burst(1);
      close(h.starts[1], t2);
    }
  });
});
