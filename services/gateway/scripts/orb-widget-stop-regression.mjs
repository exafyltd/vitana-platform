#!/usr/bin/env node
/**
 * VTID-03098 regression: prove orb-widget.js cannot spawn a new session in
 * the background after the user presses X.
 *
 * The bug we fixed: _sessionStop closed the SSE EventSource WITHOUT first
 * detaching its onerror handler. On Android Appilix WebView, the manual
 * close fired onerror with readyState === CLOSED, which called
 * _announceDisconnect → started a 5s _recoveryWatchdog setInterval →
 * health-probed the gateway → called _resetAndReconnect → _sessionStart →
 * the user heard a brand-new wake-brief greeting "in the background" after
 * the overlay was gone.
 *
 * The fix is layered:
 *   1. _userInitiatedStop guard added to _s state, flipped true in
 *      _sessionStop and false in _sessionStart.
 *   2. _sessionStop now ALWAYS clears _recoveryWatchdog (the previous
 *      cleanup was gated on _disconnectActive being true, which it usually
 *      isn't during a healthy session).
 *   3. _sessionStop detaches SSE onopen/onmessage/onerror BEFORE close().
 *   4. _announceDisconnect short-circuits when _userInitiatedStop is set
 *      OR when overlayVisible is false.
 *   5. _resetAndReconnect short-circuits on the same conditions.
 *
 * This script greps the bundled widget source for each guard so a future
 * refactor can't silently regress the cascade.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourcePath = resolve(repoRoot, 'services/gateway/src/frontend/command-hub/orb-widget.js');
const source = readFileSync(sourcePath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`[orb-widget-stop-regression] FAIL: ${message}`);
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

// 1. _userInitiatedStop flag exists in _s state.
assert(
  /_userInitiatedStop\s*:\s*false/.test(source),
  '_s must declare _userInitiatedStop: false so the stop guard can be flipped at runtime.',
);

const stopBody = extractFunctionBody('async function _sessionStop()');
const startBody = extractFunctionBody('async function _sessionStart()');
const announceBody = extractFunctionBody('function _announceDisconnect(reason)');
const resetBody = extractFunctionBody('function _resetAndReconnect()');

// 2. _sessionStop sets the flag.
assert(
  /_s\._userInitiatedStop\s*=\s*true/.test(stopBody),
  '_sessionStop must set _s._userInitiatedStop = true before any teardown.',
);

// 3. _sessionStop unconditionally clears _recoveryWatchdog.
const stopRecoveryClearIdx = stopBody.indexOf('clearInterval(_s._recoveryWatchdog)');
assert(stopRecoveryClearIdx >= 0, '_sessionStop must clearInterval(_s._recoveryWatchdog).');
// The unconditional clear must appear OUTSIDE the legacy `if (_s._disconnectActive)` block.
// We check that there is at least one clearInterval call before the disconnect-active block
// (which we identify by its assignment `_s._disconnectActive = false`).
const disconnectActiveAssignIdx = stopBody.indexOf('_s._disconnectActive = false');
assert(
  disconnectActiveAssignIdx > 0 && stopRecoveryClearIdx < disconnectActiveAssignIdx,
  '_sessionStop must clearInterval(_s._recoveryWatchdog) UNCONDITIONALLY, before the _disconnectActive cleanup block.',
);

// 4. _sessionStop detaches SSE handlers before close.
assert(
  /__es\.onerror\s*=\s*null/.test(stopBody),
  '_sessionStop must null out eventSource.onerror BEFORE calling close() to suppress the auto-reconnect cascade.',
);
assert(
  /__es\.onmessage\s*=\s*null/.test(stopBody),
  '_sessionStop must null out eventSource.onmessage BEFORE calling close().',
);
const onerrorNullIdx = stopBody.indexOf('__es.onerror = null');
const closeIdx = stopBody.indexOf('__es.close()');
assert(
  onerrorNullIdx >= 0 && closeIdx >= 0 && onerrorNullIdx < closeIdx,
  '_sessionStop must null onerror BEFORE close() — order matters.',
);

// 5. _sessionStart clears the flag.
assert(
  /_s\._userInitiatedStop\s*=\s*false/.test(startBody),
  '_sessionStart must reset _s._userInitiatedStop = false so the next session is allowed.',
);

// 6. _announceDisconnect short-circuits on _userInitiatedStop AND on !overlayVisible.
assert(
  /if\s*\(\s*_s\._userInitiatedStop\s*\)\s*return/.test(announceBody),
  '_announceDisconnect must early-return when _userInitiatedStop is set.',
);
assert(
  /if\s*\(\s*!_s\.overlayVisible\s*\)\s*return/.test(announceBody),
  '_announceDisconnect must early-return when overlayVisible is false.',
);

// 7. _resetAndReconnect short-circuits on the same conditions.
assert(
  /_s\._userInitiatedStop\s*\|\|\s*!_s\.overlayVisible/.test(resetBody)
    || (/_s\._userInitiatedStop/.test(resetBody) && /!_s\.overlayVisible/.test(resetBody)),
  '_resetAndReconnect must early-return on _userInitiatedStop OR !overlayVisible.',
);

console.log('[orb-widget-stop-regression] OK: user X-close cannot spawn a background session.');
