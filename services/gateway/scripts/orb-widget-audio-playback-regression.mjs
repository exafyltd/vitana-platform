#!/usr/bin/env node
/**
 * Regression: the ORB playback queue must remove the exact AudioBufferSource
 * that fired `onended`.
 *
 * The previous code captured `var src` inside a loop. Every onended callback
 * then pointed at the final source scheduled by that loop, so earlier chunks
 * did not remove themselves from `_s.scheduledSources`. The widget could stay
 * stuck in "Vitana speaking..." after audio had ended, gating the mic and
 * making the conversation look like TTS had gone silent.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourcePath = resolve(repoRoot, 'services/gateway/src/frontend/command-hub/orb-widget.js');
const source = readFileSync(sourcePath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`[orb-widget-audio-playback-regression] FAIL: ${message}`);
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

const processQueueBody = extractFunctionBody('function _processQueue()');

assert(
  /\(function\s*\(\s*endedSrc\s*\)\s*\{[\s\S]*src\.onended\s*=\s*function\s*\(\s*\)\s*\{[\s\S]*indexOf\(endedSrc\)[\s\S]*\}\s*;[\s\S]*\}\)\(src\);/.test(processQueueBody),
  '_processQueue must wrap each onended handler in a per-source closure.',
);
assert(
  /indexOf\(endedSrc\)/.test(processQueueBody),
  'onended must remove endedSrc from _s.scheduledSources.',
);
assert(
  !/indexOf\(src\)/.test(processQueueBody),
  'onended must not remove the loop-scoped var src.',
);
assert(
  !/var\s+endedSrc\s*=\s*src;/.test(processQueueBody),
  'endedSrc must not be declared with var inside the loop; var is function-scoped and preserves the bug.',
);

console.log('[orb-widget-audio-playback-regression] OK: scheduledSources drains per ended source.');
