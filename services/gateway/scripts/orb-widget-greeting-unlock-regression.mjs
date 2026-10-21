#!/usr/bin/env node
/**
 * Regression: the ORB playback AudioContext must be unlocked (1-sample silent
 * buffer + resume) SYNCHRONOUSLY, before the first `await` in `_sessionStart()`.
 *
 * The bug (production first-greeting silence on mobile): `_sessionStart()` did
 * `await fetch(/orb/session/continuity)` BEFORE the silent-buffer unlock +
 * resume(). On iOS/Android the user-gesture activation token is consumed by the
 * first await, so the unlock landed outside the gesture window, the context
 * stayed suspended, and the FIRST greeting's PCM was dropped (the second press
 * worked because the context was already running). The fix hoists the unlock
 * above the continuity fetch. This guard fails if anything reorders an await
 * (the continuity fetch in particular) ahead of the unlock again.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourcePath = resolve(repoRoot, 'services/gateway/src/frontend/command-hub/orb-widget.js');
const source = readFileSync(sourcePath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`[orb-widget-greeting-unlock-regression] FAIL: ${message}`);
    process.exit(1);
  }
}

function extractFunctionBody(signature) {
  const sigIdx = source.indexOf(signature);
  assert(sigIdx >= 0, `missing function signature: ${signature}`);
  const openIdx = source.indexOf('{', sigIdx);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

const body = extractFunctionBody('async function _sessionStart()');

const unlockIdx = body.indexOf('createBuffer(1, 1, 22050)');
const resumeIdx = body.indexOf('playbackCtx.resume(');
const continuityIdx = body.indexOf('/orb/session/continuity');
// Match the first REAL awaited call (an `await fetch(`), not the word "await"
// that appears in explanatory comments above the unlock block.
const firstAwaitIdx = body.search(/await\s+fetch\s*\(/);

assert(unlockIdx >= 0, '_sessionStart must create the 1-sample silent unlock buffer.');
assert(resumeIdx >= 0, '_sessionStart must call playbackCtx.resume().');
assert(continuityIdx >= 0, '_sessionStart must still perform the continuity hydrate fetch.');
assert(firstAwaitIdx >= 0, '_sessionStart is expected to contain at least one awaited fetch.');

assert(
  unlockIdx < continuityIdx,
  'the silent-buffer AudioContext unlock MUST appear before the continuity fetch (gesture window).',
);
assert(
  resumeIdx < continuityIdx,
  'playbackCtx.resume() MUST run before the continuity fetch (gesture window).',
);
assert(
  unlockIdx < firstAwaitIdx && resumeIdx < firstAwaitIdx,
  'the AudioContext unlock + resume() MUST run before the FIRST await in _sessionStart.',
);

console.log('[orb-widget-greeting-unlock-regression] OK: audio unlock runs in-gesture, before the first await.');
