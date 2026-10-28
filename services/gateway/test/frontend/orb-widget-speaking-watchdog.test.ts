import * as fs from 'fs';
import * as path from 'path';

// DEV-COMHU-0501 — ORB Recovery 0.1: static checks that the cross-provider
// speaking-state watchdog exists in orb-widget.js and is wired into the
// session lifecycle. Mirrors the static-analysis style of
// orb-widget-audio-playback.test.ts (the widget runs in the browser; we assert
// on its source so CI catches accidental removal/regression).

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

describe('orb-widget cross-provider speaking-state watchdog (DEV-COMHU-0501)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('defines _speakingStateWatchdog gating on quiet + no sources + empty queue', () => {
    const body = extractFunctionBody(source, 'function _speakingStateWatchdog()');
    expect(body).toMatch(/if \(!_s\.audioPlaying\) return;/);
    expect(body).toMatch(/lastAudioReceivedAt/);
    expect(body).toMatch(/scheduledSources\.length === 0/);
    expect(body).toMatch(/audioQueue\.length === 0/);
    expect(body).toMatch(/audioPlaying = false/);
    expect(body).toMatch(/SPEAKING_WATCHDOG_QUIET_MS/);
  });

  it('uses a 2-second quiet window', () => {
    expect(source).toMatch(/SPEAKING_WATCHDOG_QUIET_MS = 2000/);
  });

  it('stamps lastAudioReceivedAt on every inbound audio frame', () => {
    const playAudioBody = extractFunctionBody(source, 'function _playAudio(base64Data, mimeType)');
    expect(playAudioBody).toMatch(/_s\.lastAudioReceivedAt = Date\.now\(\);/);
  });

  it('starts the watchdog on SSE open and stops it on session stop', () => {
    expect(source).toMatch(/_startSpeakingWatchdog\(\)/);
    expect(source).toMatch(/_stopSpeakingWatchdog\(\)/);
  });

  it('emits a session-shape diagnostic line on session open', () => {
    expect(source).toMatch(/session diagnostics: ACstate=/);
  });
});
