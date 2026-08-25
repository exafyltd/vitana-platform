import * as fs from 'fs';
import * as path from 'path';

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

describe('orb-widget audio playback queue', () => {
  it('removes the actual ended AudioBufferSource from scheduledSources', () => {
    const source = fs.readFileSync(WIDGET_PATH, 'utf8');
    const processQueueBody = extractFunctionBody(source, 'function _processQueue()');

    expect(processQueueBody).toMatch(
      /\(function\s*\(\s*endedSrc\s*\)\s*\{[\s\S]*src\.onended\s*=\s*function\s*\(\s*\)\s*\{[\s\S]*indexOf\(endedSrc\)[\s\S]*\}\s*;[\s\S]*\}\)\(src\);/,
    );
    expect(processQueueBody).toMatch(/indexOf\(endedSrc\)/);
    expect(processQueueBody).not.toMatch(/indexOf\(src\)/);
    expect(processQueueBody).not.toMatch(/var\s+endedSrc\s*=\s*src;/);
  });
});

describe('orb-widget German playback rate (VTID-03606)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('defines a German-specific rate above the baseline', () => {
    expect(source).toMatch(/var\s+_AUDIO_PLAYBACK_RATE\s*=\s*1\.05\s*;/);
    expect(source).toMatch(/var\s+_AUDIO_PLAYBACK_RATE_DE\s*=\s*1\.1\s*;/);
  });

  it('_currentPlaybackRate() selects the DE rate only when _cfg.lang starts with de', () => {
    const body = extractFunctionBody(source, 'function _currentPlaybackRate()');
    expect(body).toMatch(
      /_cfg\.lang\s*&&\s*_cfg\.lang\.startsWith\(\s*['"]de['"]\s*\)\s*\)[\s\S]*\?\s*_AUDIO_PLAYBACK_RATE_DE[\s\S]*:\s*_AUDIO_PLAYBACK_RATE/,
    );
  });

  it('_processQueue applies the SAME per-chunk rate to both playbackRate.value and the schedule-gap divisor', () => {
    // Regression guard: if a future edit reads _currentPlaybackRate() (or the
    // raw constants) independently at the two use sites instead of sharing
    // one `chunkRate` snapshot, DE and non-DE chunks can be scheduled at one
    // rate and played at another, drifting or gapping consecutive chunks.
    const processQueueBody = extractFunctionBody(source, 'function _processQueue()');
    expect(processQueueBody).toMatch(/var\s+chunkRate\s*=\s*_currentPlaybackRate\(\)\s*;/);
    expect(processQueueBody).toMatch(/src\.playbackRate\.value\s*=\s*chunkRate\s*;/);
    expect(processQueueBody).toMatch(/_s\.lastScheduledEnd\s*\+=\s*buf\.duration\s*\/\s*chunkRate\s*;/);
    // Neither assignment should fall back to the old flat global.
    expect(processQueueBody).not.toMatch(/playbackRate\.value\s*=\s*_AUDIO_PLAYBACK_RATE\s*;/);
    expect(processQueueBody).not.toMatch(/buf\.duration\s*\/\s*_AUDIO_PLAYBACK_RATE\s*;/);
  });
});

describe('orb-widget PCM playback rate honors the chunk mime (VTID-03711)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  // Regression: createBuffer() used to hardcode 24000 (Nova's native rate)
  // regardless of the chunk's actual mime, so any 16kHz Polly PCM (greeting
  // bridge, guided-topic narration, the cascaded-voice client — all three
  // correctly label their audio 'audio/pcm;rate=16000') decoded as 24kHz and
  // played back at 1.5x speed/pitch. Exposed live in production the moment
  // ORB_CASCADED_VOICE_ENABLED made a full Polly conversation (not just a
  // short greeting snippet) audible on this path.
  it('_pcmRateFromMime parses the rate out of the mime string', () => {
    const body = extractFunctionBody(source, 'function _pcmRateFromMime(mime)');
    expect(body).toMatch(/rate=\(\\d\+\)/);
  });

  it('_pcmRateFromMime falls back to 24000 only when the mime is missing/unparseable', () => {
    const body = extractFunctionBody(source, 'function _pcmRateFromMime(mime)');
    expect(body).toMatch(/24000/);
  });

  it('_processQueue passes the parsed per-chunk rate into createBuffer, not a hardcoded constant', () => {
    const processQueueBody = extractFunctionBody(source, 'function _processQueue()');
    expect(processQueueBody).toMatch(
      /var\s+pcmRate\s*=\s*_pcmRateFromMime\(\s*chunk\.mime\s*\)\s*;/,
    );
    expect(processQueueBody).toMatch(
      /ctx\.createBuffer\(\s*1\s*,\s*floats\.length\s*,\s*pcmRate\s*\)/,
    );
    // The exact regression: createBuffer's rate argument must never be the
    // bare literal 24000 again.
    expect(processQueueBody).not.toMatch(/ctx\.createBuffer\(\s*1\s*,\s*floats\.length\s*,\s*24000\s*\)/);
  });
});
