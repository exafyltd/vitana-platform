/**
 * VTID-03704 — session-start telemetry must name the voice the user HEARD.
 *
 * `vtid.live.session.start` logged only `voice: getLiveApiVoice(lang)` — a
 * Gemini-era name Nova cannot use, resolved on a different code path from
 * the one that actually speaks. It was also identical for anonymous and
 * authenticated sessions, so when a user reported "German sounds different
 * before and after I log in", the telemetry could not distinguish the two
 * cases, let alone explain them. Diagnosis had to come from reading the
 * voice table instead.
 *
 * Two fields close that: `nova_voice` (what Nova actually speaks with, via
 * the fallback-reporting resolver, so a substitution is visible rather than
 * silent) and `nova_language_supported` (whether this language is on Nova at
 * all, which is what decides Nova-vs-cascade routing).
 *
 * Verified at source level, matching the sibling suites in this directory:
 * `orb-live.ts` is a very large, WebSocket-stateful module whose integration
 * setup (optionalAuth + Supabase + the live upstream spine) dwarfs the
 * wire-up being asserted, and the wire-up IS the contract here — a field
 * quietly dropped from the payload is exactly the regression this guards.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../src/routes/orb-live.ts');

let source: string;

beforeAll(() => {
  source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
});

/** The `emitLiveSessionEvent('vtid.live.session.start', {...})` payload. */
function sessionStartPayload(): string {
  const marker = "emitLiveSessionEvent('vtid.live.session.start'";
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  // Bounded window: far past the payload's end, but scoped to this one emit
  // so a match cannot be satisfied by an unrelated call site elsewhere.
  return source.slice(start, start + 2000);
}

describe('VTID-03704: session-start voice telemetry', () => {
  it('records the Nova voice that actually speaks', () => {
    expect(sessionStartPayload()).toMatch(/nova_voice:\s*resolveNovaSonicVoiceOrFallback\(/);
  });

  it('records whether the language is on Nova at all', () => {
    expect(sessionStartPayload()).toMatch(
      /nova_language_supported:\s*isNovaSonicLanguageSupported\(/,
    );
  });

  it('resolves the Nova voice through the fallback-REPORTING resolver', () => {
    // Not `resolveNovaSonicVoice(...) ?? 'tina'`. A bare `??` yields a
    // valid-looking id with no way to know it is a substitution — the exact
    // shape VTID-03578 (Portuguese read in English) and VTID-03682 both paid
    // for. The telemetry field exists to answer "what did they hear", so it
    // must not be the one place that silence creeps back in.
    const payload = sessionStartPayload();
    expect(payload).not.toMatch(/nova_voice:\s*resolveNovaSonicVoice\s*\([^)]*\)\s*\?\?/);
  });

  it('keeps the legacy live-api voice field rather than silently replacing it', () => {
    // The Gemini-era name is still emitted on purpose: dropping a field that
    // historical rows carry would make old and new sessions incomparable in
    // the same query. It is now accompanied, not substituted.
    expect(sessionStartPayload()).toMatch(/voice:\s*getLiveApiVoice\(/);
  });
});
