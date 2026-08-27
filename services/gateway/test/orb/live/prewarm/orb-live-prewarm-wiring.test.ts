/**
 * VTID-03779 — session pre-establishment ("warm start") wiring in
 * src/routes/orb-live.ts.
 *
 * `connectToLiveAPI` is an unexported async function reachable only by
 * driving a full WS session through `initializeOrbWebSocket` (auth,
 * DB-backed bootstrap context, a real Nova upstream connect) — genuinely
 * un-isolable without a refactor, the same conclusion
 * `orb-live-nova-incident-regressions.test.ts` already reached for this
 * file's Nova connect branch. `nova-session-prewarm.test.ts` covers the
 * registry module in isolation (register/claim/expire/supersede) and
 * `nova-sonic-live-client.test.ts` covers `rebindSessionDeps()` in
 * isolation; what's left, and what this suite pins, is the WIRING between
 * them inside this file: the WS `'prewarm'` message actually reaches the
 * handler, the handler is feature-flag gated and never throws back to the
 * client, and the reuse branch inside `connectToLiveAPI` actually claims a
 * prewarmed client (and rebinds its callbacks) instead of always cold
 * connecting.
 */
import fs from 'fs';
import path from 'path';

const SRC_PATH = path.join(__dirname, '../../../../src/routes/orb-live.ts');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const code = src
  .split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n');

describe('VTID-03779 orb-live.ts prewarm wiring', () => {
  it('the WS message union includes prewarm and the switch dispatches it fire-and-forget', () => {
    expect(code).toMatch(/type:\s*'start'\s*\|\s*'audio'[\s\S]{0,120}\|\s*'prewarm'/);
    // Fire-and-forget: never awaited inline in the switch (would block the
    // WS message loop on a full Nova connect), and its rejection is caught
    // so a slow/failed prewarm can never surface as a WS-level error.
    const prewarmCase = code.match(/case 'prewarm':[\s\S]{0,400}?break;/)?.[0];
    expect(prewarmCase).toBeDefined();
    expect(prewarmCase).toMatch(/void handleWsPrewarmMessage\(clientSession\)\.catch\(/);
  });

  it('handleWsPrewarmMessage is gated on the ORB_NOVA_PREWARM feature flag and bails with no identity/active session', () => {
    const fn = code.match(/async function handleWsPrewarmMessage\([\s\S]*?\n\}/)?.[0];
    expect(fn).toBeDefined();
    expect(fn).toMatch(/isFeatureLive\('ORB_NOVA_PREWARM'\)/);
    // Never prewarm on top of (or instead of) an already-active real session.
    expect(fn).toMatch(/clientSession\.liveSession\?\.active/);
    // Registers into the SAME registry the claim path (below) reads from.
    expect(fn).toMatch(/registerPrewarmedNovaSession\(/);
  });

  it('connectToLiveAPI claims a prewarmed client by user_id before falling back to a cold connect', () => {
    expect(code).toMatch(
      /const prewarmedNova = session\.identity\?\.user_id\s*\n\s*\? consumePrewarmedNovaSession\(session\.identity\.user_id\)/,
    );
    expect(code).toMatch(/const reusedWarmNova = !!prewarmedNova;/);
    // Both branches must exist: reuse (if) and cold connect (else).
    expect(code).toMatch(/if \(prewarmedNova\) \{/);
  });

  it('the reuse branch rebinds the four Nova-specific callbacks before the session can rotate/idle/diagnose', () => {
    const reuseBranch = code.match(/if \(prewarmedNova\) \{[\s\S]*?\} else \{/)?.[0];
    expect(reuseBranch).toBeDefined();
    expect(reuseBranch).toMatch(/\(novaClient as NovaSonicLiveClient\)\.rebindSessionDeps\(\{/);
    expect(reuseBranch).toMatch(/onRotationDue: handleNovaRotationDue/);
    expect(reuseBranch).toMatch(/onIdleDeadlineApproaching: handleNovaIdleDeadlineApproaching/);
    expect(reuseBranch).toMatch(/onFirstRawChunk: handleNovaFirstRawChunk/);
    expect(reuseBranch).toMatch(/onEarlyNormalizedEvent: handleNovaEarlyNormalizedEvent/);
  });

  it('a claimed warm connection skips the real connect() call — the whole point of reuse', () => {
    // novaClient.connect(...) must be conditioned on !reusedWarmNova; an
    // unconditional call would pay the exact connect cost prewarm exists
    // to avoid, silently making the whole feature a no-op.
    expect(code).toMatch(/if \(!reusedWarmNova\) \{\s*\n\s*await novaClient\.connect\(/);
  });

  it('reused_warm_start is threaded into both the latency mark and the connect_succeeded OASIS event', () => {
    expect(code).toMatch(/establishLatency\?\.mark\('upstream_connected',\s*reusedWarmNova \? \{ reused_warm_start: true \} : undefined\)/);
    expect(code).toMatch(/reused_warm_start: reusedWarmNova,/);
  });
});
