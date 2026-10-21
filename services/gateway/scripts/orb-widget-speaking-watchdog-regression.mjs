#!/usr/bin/env node
/**
 * Regression (DEV-COMHU-0501 — ORB Recovery 0.1): the cross-provider
 * speaking-state watchdog must exist and gate audioPlaying on cross-provider
 * quiet detection, independent of the Vertex-specific onended path.
 *
 * VTID-03185 fixed the Vertex scheduled-source leak. The watchdog is the
 * transport-agnostic backstop: when no audio frame has arrived for >= 2s AND
 * nothing is scheduled AND the queue is empty, it force-clears the speaking
 * state — covering the LiveKit WebRTC path (community surface) whose track
 * lifecycle differs from Vertex BufferSources.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourcePath = resolve(repoRoot, 'services/gateway/src/frontend/command-hub/orb-widget.js');
const source = readFileSync(sourcePath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`[orb-widget-speaking-watchdog-regression] FAIL: ${message}`);
    process.exit(1);
  }
}

function extractFunctionBody(signature) {
  const sigIdx = source.indexOf(signature);
  assert(sigIdx >= 0, `missing function signature: ${signature}`);
  const openIdx = source.indexOf('{', sigIdx);
  assert(openIdx >= 0, `missing function body open brace: ${signature}`);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

// 1. The watchdog method exists.
const body = extractFunctionBody('function _speakingStateWatchdog()');

// 2. It gates on all three transport-agnostic conditions.
assert(/lastAudioReceivedAt/.test(body), 'watchdog must compare against lastAudioReceivedAt.');
assert(/scheduledSources\.length === 0/.test(body), 'watchdog must require zero scheduled sources.');
assert(/audioQueue\.length === 0/.test(body), 'watchdog must require an empty audio queue.');
assert(/audioPlaying = false/.test(body), 'watchdog must clear audioPlaying when it fires.');
assert(/SPEAKING_WATCHDOG_QUIET_MS/.test(body), 'watchdog must use the quiet-window constant.');

// 3. It early-returns when not speaking (so it is a no-op outside TTS turns).
assert(/if \(!_s\.audioPlaying\) return;/.test(body), 'watchdog must no-op when audioPlaying is false.');

// 4. Lifecycle: started on session open, stopped on session stop.
assert(/_startSpeakingWatchdog\(\)/.test(source), 'watchdog must be started (on SSE open).');
assert(/_stopSpeakingWatchdog\(\)/.test(source), 'watchdog must be stopped (in _sessionStop).');

// 5. Every inbound frame stamps lastAudioReceivedAt (so healthy multi-chunk
//    TTS keeps the watchdog from firing).
const playAudioBody = extractFunctionBody('function _playAudio(base64Data, mimeType)');
assert(
  /_s\.lastAudioReceivedAt = Date\.now\(\);/.test(playAudioBody),
  '_playAudio must stamp lastAudioReceivedAt on every inbound frame.',
);

// 6. The quiet window is the spec'd 2 seconds.
assert(/SPEAKING_WATCHDOG_QUIET_MS = 2000/.test(source), 'quiet window must be 2000ms per spec.');

console.log('[orb-widget-speaking-watchdog-regression] OK: cross-provider speaking-state watchdog present and wired.');
