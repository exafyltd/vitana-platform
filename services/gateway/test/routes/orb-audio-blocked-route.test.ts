/**
 * VTID-04198 — `POST /api/v1/orb/session/:id/audio-blocked` source contract.
 *
 * The route makes a previously invisible failure observable: the gateway
 * streams a complete greeting (315 chunks measured on the reported iPhone
 * session), the widget discards it because the iOS AudioContext never
 * resumed, and NOTHING server-side recorded a fault.
 *
 * `orb-live.ts` is ~18k lines and pulls in the whole live stack on import, so
 * — matching the characterization-test pattern this repo already uses for
 * this module (see the VTID-03824 / VTID-04002 suites) — these assert the
 * route's source contract rather than booting an Express app.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROUTE_PATH = path.resolve(__dirname, '../../src/routes/orb-live.ts');
const source = fs.readFileSync(ROUTE_PATH, 'utf8');

function extractRouteBlock(signature: string): string {
  const idx = source.indexOf(signature);
  expect(idx).toBeGreaterThanOrEqual(0);
  // Route handlers here end at the next top-level `router.` registration.
  const next = source.indexOf('\nrouter.', idx + signature.length);
  return source.slice(idx, next === -1 ? source.length : next);
}

describe('POST /session/:id/audio-blocked (VTID-04198)', () => {
  const block = extractRouteBlock(
    "router.post('/session/:id/audio-blocked'",
  );

  it('is registered with optionalAuth', () => {
    expect(block).toMatch(/router\.post\('\/session\/:id\/audio-blocked', optionalAuth/);
  });

  it('accepts ANONYMOUS callers — the reported failure is pre-login', () => {
    // Its sibling /audio-ready early-returns `anonymous_no_ack` because it
    // writes user-keyed orb_session_state. Copying that here would have made
    // the route blind to the exact incident that motivated it: the iPhone
    // report was a pre-login session.
    expect(block).not.toMatch(/anonymous_no_ack/);
    expect(block).not.toMatch(/if \(!userId\) return/);
    // It must still RECORD whether the caller was anonymous.
    expect(block).toMatch(/anonymous:\s*!req\.identity\?\.user_id/);
  });

  it('emits an OASIS event so the failure is queryable', () => {
    expect(block).toMatch(/emitOasisEvent\(/);
    expect(block).toMatch(/orb\.live\.audio_blocked/);
    expect(block).toMatch(/vtid:\s*'VTID-04198'/);
    // A block is an error, not an info line — it is a user hearing silence.
    expect(block).toMatch(/status:\s*state === 'blocked' \? 'error' : 'info'/);
  });

  it('allowlists `state` instead of echoing client text into a topic', () => {
    // `state` reaches an OASIS topic suffix. Arbitrary client-supplied text
    // must not be able to mint new topics.
    expect(block).toMatch(/\['blocked', 'recovered', 'abandoned'\] as const\)\.includes\(/);
    expect(block).toMatch(/:\s*'blocked';/);
  });

  it('bounds every free-text field it records', () => {
    // Client-supplied strings are truncated rather than stored whole.
    expect(block).toMatch(/const str = \(v: unknown, max = 120\)/);
    expect(block).toMatch(/\.slice\(0, max\)/);
    expect(block).toMatch(/str\(req\.headers\['user-agent'\], 240\)/);
  });

  it('never hands the client an error while it is already degraded', () => {
    expect(block).toMatch(/return res\.json\(\{ ok: true \}\)/);
    // The catch answers 200, and the emit is fire-and-forget.
    expect(block).toMatch(/return res\.status\(200\)\.json\(\{ ok: false/);
    expect(block).toMatch(/\}\)\.catch\(\(\) => \{\}\)/);
  });

  it('carries the diagnostic fields the widget sends', () => {
    for (const field of ['reason', 'elapsed_ms', 'ctx_state', 'queued_chunks', 'unlocked_by_gesture', 'lang']) {
      expect(block).toContain(field);
    }
  });
});
