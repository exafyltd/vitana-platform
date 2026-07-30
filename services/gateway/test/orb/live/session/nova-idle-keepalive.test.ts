/**
 * BOOTSTRAP-NOVA-IDLE-KEEPALIVE — Nova's transport keepalive must never be
 * stopped by the conversation loop guard.
 *
 * PRODUCTION INCIDENT (2026-07-30): a Nova session healthy for 10 turns was
 * terminated by Bedrock with "Timed out waiting for audio bytes or interactive
 * content ... less than 295 seconds", ~292s after the last user input. Of 46
 * Nova sessions in 72h, 32 ended inside 60s (median 37.5s).
 *
 * ROOT CAUSE: VTID-LOOPGUARD clears session.silenceKeepaliveInterval after N
 * consecutive model turns, with the explicit intent (per its own comment) of
 * letting "Vertex's idle timeout stop the loop naturally". On Vertex that ends
 * a runaway loop. On Nova the idle deadline TERMINATES THE STREAM. The only
 * re-arm site is inside the input_transcription handler, so a user who goes
 * quiet after the guard fires never gets the keepalive back, and the session
 * dies deterministically. Rotation cannot rescue it either — rotationAfterMs
 * defaults to 435_000ms, well past the 295s deadline.
 *
 * These tests pin the provider gate so the fatal-for-Nova path cannot come
 * back. Asserted at source level because the two guard sites sit deep inside
 * two very large handler bodies with heavy transport/session dependencies;
 * isNovaProvider itself is exercised directly.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isNovaProvider } from '../../../../src/orb/live/session/upstream-message-handler';
import type { GeminiLiveSession } from '../../../../src/routes/orb-live';

const HANDLER_PATH = path.resolve(
  __dirname,
  '../../../../src/orb/live/session/upstream-message-handler.ts',
);

describe('isNovaProvider', () => {
  it('identifies a Nova session', () => {
    expect(isNovaProvider({ upstreamProvider: 'nova_sonic' } as unknown as GeminiLiveSession)).toBe(true);
  });

  it('does not treat Vertex as Nova', () => {
    expect(isNovaProvider({ upstreamProvider: 'vertex' } as unknown as GeminiLiveSession)).toBe(false);
  });

  it('defaults to NOT-Nova when the provider was never stamped', () => {
    // Matches the `?? 'vertex'` fallback used elsewhere in the handler, so an
    // unstamped session keeps the long-standing Vertex behaviour rather than
    // silently acquiring Nova's.
    expect(isNovaProvider({} as unknown as GeminiLiveSession)).toBe(false);
  });
});

describe('loop guard never starves the Nova transport', () => {
  const source = fs.readFileSync(HANDLER_PATH, 'utf8');

  it('every loop-guard branch that can clear the keepalive is provider-gated', () => {
    // Line-based: each guard condition sits on one line in this file.
    const guardLines = source
      .split('\n')
      .filter((l) => l.includes('consecutiveModelTurns > getMaxConsecutiveModelTurns()'));

    // Two known sites: the raw-Gemini turn handler and the shared
    // handleTurnComplete path. Each has a negated clearing branch plus an
    // affirmative Nova log branch → 4 lines. A new ungated site fails below.
    expect(guardLines.length).toBeGreaterThanOrEqual(2);

    // EVERY such condition must mention the provider gate. A line without it
    // is either a reinstated unconditional clear or a new unguarded site.
    const ungated = guardLines.filter((l) => !l.includes('isNovaProvider(session)'));
    expect(ungated).toEqual([]);

    // And the clearing variant specifically must use the NEGATED form.
    const clearingBranches = guardLines.filter((l) => l.includes('!isNovaProvider(session)'));
    expect(clearingBranches.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps a Nova-specific log so a suppressed loop-break is still visible', () => {
    // Silently doing nothing would make a real runaway loop invisible. The
    // guard still fires, it just no longer kills the transport.
    expect(source).toMatch(/keepalive PRESERVED \(nova_sonic/);
  });

  it('documents why this is fatal for Nova specifically', () => {
    // The next person to touch this must see the 295s deadline, otherwise the
    // "just pause the keepalive" instinct returns.
    expect(source).toMatch(/295s idle deadline|less than 295 seconds/);
  });
});
