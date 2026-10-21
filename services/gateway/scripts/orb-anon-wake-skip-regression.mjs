#!/usr/bin/env node
/**
 * Regression: anonymous (pre-login) ORB sessions must NOT run the authenticated
 * wake-brief / journey / decision-context pipeline on the session-start critical
 * path.
 *
 * The bug (production pre-login regression): `handleLiveSessionStart` ran
 * `assembleWakeBriefAndJourney()` INLINE (awaited before the HTTP response) for
 * every non-fast-start session — including anonymous ones. `shouldDeferWakeWork`
 * returns false for anonymous, so the fast-start defer never applied to them, and
 * authenticated sessions (which DO defer) stayed fast — hence "post-login works,
 * pre-login is broken". The wake-brief result is discarded for anonymous sessions
 * anyway (every consumer in orb-live.ts is gated behind `!session.isAnonymous`),
 * but running it inline piled Supabase round-trips + an emission write onto the
 * pre-login path (session/start observed at ~4.5s), pushing slow/mobile clients
 * past the orb-widget's 8s session-start timeout. The orb opened, flipped to
 * "listening", and never received the greeting.
 *
 * The fix gates the inline call behind `!isAnonymousSession`. This guard fails if
 * that gate is removed and anonymous sessions start awaiting the wake-brief
 * assembly inline again.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourcePath = resolve(
  repoRoot,
  'services/gateway/src/orb/live/session/live-session-controller.ts',
);
const source = readFileSync(sourcePath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`[orb-anon-wake-skip-regression] FAIL: ${message}`);
    process.exit(1);
  }
}

const callIdx = source.indexOf('await assembleWakeBriefAndJourney()');
assert(callIdx >= 0, 'expected an inline `await assembleWakeBriefAndJourney()` call site.');

// The inline call must be guarded so it only runs for NON-anonymous sessions.
// We look at the branch keyword immediately preceding the call.
const preceding = source.slice(Math.max(0, callIdx - 400), callIdx);
assert(
  /else if \(!isAnonymousSession\)\s*\{[^}]*$/.test(preceding) ||
    preceding.includes('} else if (!isAnonymousSession) {'),
  'the inline wake-brief assembly MUST be gated behind `else if (!isAnonymousSession)` ' +
    'so anonymous (pre-login) sessions never await it on the session-start critical path.',
);

// And there must be exactly one inline call site (the guarded one).
const occurrences = source.split('await assembleWakeBriefAndJourney()').length - 1;
assert(
  occurrences === 1,
  `expected exactly 1 inline wake-brief call site, found ${occurrences}.`,
);

console.log('[orb-anon-wake-skip-regression] PASS: anonymous sessions skip inline wake-brief assembly.');
