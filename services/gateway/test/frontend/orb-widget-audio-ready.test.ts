import * as fs from 'fs';
import * as path from 'path';

// DEV-COMHU-0504 — ORB Recovery 4: static checks that the widget signals
// audio-pipeline readiness (idempotent, gated on a running AudioContext) and
// posts to the audio-ready endpoint, and that the ack flag re-arms per session.

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

function extractFunctionBody(source: string, signature: string): string {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  expect(openIdx).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

describe('orb-widget audio-ready handshake (DEV-COMHU-0504)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('_signalAudioReady is idempotent and gated on a running context', () => {
    const body = extractFunctionBody(source, 'function _signalAudioReady()');
    expect(body).toMatch(/if \(_s\._audioReadySignaled\) return;/);
    expect(body).toMatch(/if \(!_s\.sessionId\) return;/);
    expect(body).toMatch(/ctx\.state !== 'running'/);
    expect(body).toMatch(/_s\._audioReadySignaled = true/);
  });

  it('_signalAudioReady POSTs to the audio-ready endpoint with keepalive', () => {
    const body = extractFunctionBody(source, 'function _signalAudioReady()');
    expect(body).toMatch(/\/api\/v1\/orb\/session\/'/);
    expect(body).toMatch(/\/audio-ready/);
    expect(body).toMatch(/keepalive: true/);
  });

  it('is invoked on session start and on ctx resume', () => {
    // called right after sessionId is set, and inside the resume() success path
    expect(source.match(/_signalAudioReady\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('re-arms the ack flag on session stop', () => {
    expect(source).toMatch(/_s\._audioReadySignaled = false;.*re-arm|_audioReadySignaled = false; \/\/ DEV-COMHU-0504/);
  });

  it('re-arms the ack flag at the top of _sessionStart so reconnect paths re-ack (review fix)', () => {
    // _attemptReconnect/_resetAndReconnect call _sessionStart without _sessionStop;
    // the reset must live in _sessionStart to cover those recovery paths.
    const body = extractFunctionBody(source, 'async function _sessionStart()');
    expect(body).toMatch(/_s\._audioReadySignaled = false/);
  });
});
