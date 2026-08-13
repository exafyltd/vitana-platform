/**
 * VTID-03636 — pins the Nova onClose handler's WIRING: the stall-recovery
 * branch must run BEFORE the VTID-03557 retry / VTID-03502 fallback
 * branches, and must consume the same `_stallRecoveryPending` flag
 * `startResponseWatchdog` sets right before it terminates the stream.
 *
 * A unit test on `shouldReconnectNovaOnStall` alone (see
 * nova-stall-recovery-reconnect.test.ts) cannot catch a future edit that
 * calls the predicate but places the branch AFTER the retry/fallback
 * checks — those two `return` on match, so ordering after them would make
 * the stall-recovery branch dead code whenever a retry had already been
 * spent (the exact real-world case this VTID fixes). This is a source
 * characterization test, matching this codebase's established pattern for
 * orb-live.ts (see vertex-wake-opener-v2.characterization.test.ts and
 * zero-turn-greeting-recovery-not-silenced.characterization.test.ts).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const orbLive = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');

describe('VTID-03636 — Nova stall-recovery reconnect is wired ahead of the retry/fallback gates', () => {
  it('novaClient.onClose reads _stallRecoveryPending and calls shouldReconnectNovaOnStall', () => {
    const onCloseStart = orbLive.indexOf('novaClient.onClose((closeEvent) => {');
    expect(onCloseStart).toBeGreaterThan(-1);

    const stallFlagIdx = orbLive.indexOf(
      "const stallRecoveryPending = (session as any)._stallRecoveryPending === true;",
      onCloseStart,
    );
    const predicateCallIdx = orbLive.indexOf('shouldReconnectNovaOnStall({', onCloseStart);
    expect(stallFlagIdx).toBeGreaterThan(onCloseStart);
    expect(predicateCallIdx).toBeGreaterThan(stallFlagIdx);
  });

  it('the stall-recovery branch is positioned BEFORE shouldRetryNovaOnPrematureClose in source order', () => {
    const onCloseStart = orbLive.indexOf('novaClient.onClose((closeEvent) => {');
    const stallBranchIdx = orbLive.indexOf('shouldReconnectNovaOnStall({', onCloseStart);
    const retryBranchIdx = orbLive.indexOf('shouldRetryNovaOnPrematureClose({', onCloseStart);
    expect(stallBranchIdx).toBeGreaterThan(-1);
    expect(retryBranchIdx).toBeGreaterThan(-1);
    expect(stallBranchIdx).toBeLessThan(retryBranchIdx);
  });

  it('the stall-recovery branch is positioned BEFORE shouldFallbackToVertexOnNovaClose in source order', () => {
    const onCloseStart = orbLive.indexOf('novaClient.onClose((closeEvent) => {');
    const stallBranchIdx = orbLive.indexOf('shouldReconnectNovaOnStall({', onCloseStart);
    const fallbackBranchIdx = orbLive.indexOf('shouldFallbackToVertexOnNovaClose({', onCloseStart);
    expect(stallBranchIdx).toBeGreaterThan(-1);
    expect(fallbackBranchIdx).toBeGreaterThan(-1);
    expect(stallBranchIdx).toBeLessThan(fallbackBranchIdx);
  });

  it('the stall-recovery branch resets the flag (one-shot) and returns without falling through', () => {
    const onCloseStart = orbLive.indexOf('novaClient.onClose((closeEvent) => {');
    const stallBranchIdx = orbLive.indexOf('shouldReconnectNovaOnStall({', onCloseStart);
    const retryBranchIdx = orbLive.indexOf('shouldRetryNovaOnPrematureClose({', onCloseStart);
    const branchBody = orbLive.slice(stallBranchIdx, retryBranchIdx);

    expect(branchBody).toMatch(/\(session as any\)\._stallRecoveryPending = false;/);
    // Must reconnect NOVA — never set _novaFallbackToVertex in this branch.
    expect(branchBody).not.toMatch(/_novaFallbackToVertex\s*=\s*true/);
    expect(branchBody).toMatch(/attemptTransparentReconnect\(/);
    expect(branchBody).toMatch(/\n\s*return;\s*\n/);
  });

  it('shouldReconnectNovaOnStall does not accept a hasProducedAudio input, unlike its siblings', () => {
    const fnStart = orbLive.indexOf('export function shouldReconnectNovaOnStall(args: {');
    const fnEnd = orbLive.indexOf('\n}', fnStart);
    const fnSrc = orbLive.slice(fnStart, fnEnd);
    expect(fnSrc).not.toMatch(/hasProducedAudio/);
    expect(fnSrc).toMatch(/stallRecoveryPending/);
  });
});
