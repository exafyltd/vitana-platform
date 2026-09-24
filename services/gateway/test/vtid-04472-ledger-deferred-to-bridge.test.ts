/**
 * VTID-04472 — a watcher failure handed to the self-heal bridge leaves the
 * VTID ledger to the bridge.
 *
 * AC-1 the watcher's `→ failed` transitions run the terminal side effects
 *      with `deferLedger`, so the ledger is not closed at the first red CI.
 * AC-2 `applyExecTerminalSideEffects(…, { deferLedger: true })` skips the
 *      ledger; without the option the mapping is unchanged.
 * AC-3 after the bridge, the watcher closes the ledger `failed` itself when
 *      the bridge does not own the outcome (already bridged, no row, a thrown
 *      call) — so no VTID is left open forever.
 * AC-4 end to end: a fix-mode lineage's VTID closes `success` when the fix
 *      lands (operator suite, VTID-04465).
 */

import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('watcher wiring (AC-1, AC-3)', () => {
  const src = read('src/services/dev-autopilot-watcher.ts');

  test('failed transitions defer the ledger', () => {
    expect(src).toContain("applyExecTerminalSideEffects(s, execId, toStatus, { deferLedger: toStatus === 'failed' })");
  });

  test('every → failed transition is followed by a bridge call', () => {
    const lines = src.split('\n');
    const failedAt = lines.map((l, i) => (/transitionStatus\(s, [\w.]+, '\w+', 'failed'/.test(l) ? i : -1)).filter((i) => i >= 0);
    expect(failedAt.length).toBeGreaterThanOrEqual(10);
    for (const i of failedAt) {
      const window = lines.slice(i, i + 30).join('\n');
      expect(window).toMatch(/await bridgeFailure\(/);
    }
  });

  test('bridge outcomes that do not own the ledger fall back to closing it failed', () => {
    const fn = src.slice(src.indexOf('async function bridgeFailure('), src.indexOf('// CI watcher: ci → merging → deploying'));
    expect(fn).toContain('if (outcome && BRIDGE_OWNS_LEDGER.has(outcome)) return;');
    expect(fn).toContain("await terminalizeVtidLedgerForExecution(s, execId, 'failed');");
  });
});

describe('bridge ownership set matches the bridge (AC-3)', () => {
  test('owned outcomes are exactly the ones that spawn a child or close the ledger', async () => {
    const { BRIDGE_OWNS_LEDGER } = await import('../src/services/dev-autopilot-watcher');
    expect([...BRIDGE_OWNS_LEDGER].sort()).toEqual(['env_blocker', 'escalated', 'self_heal_injected', 'triage_failed']);
    const bridge = read('src/services/dev-autopilot-bridge.ts');
    // every failed_escalated write (escalated/env_blocker/triage_failed paths) closes the ledger
    const escalations = bridge.split("status: 'failed_escalated',").length - 1;
    const closes = bridge.split('closeLedgerForEscalation(s, exec.id);').length - 1;
    expect(closes).toBe(escalations);
    // outcomes the watcher must close itself are not in the set
    for (const o of ['already_bridged', 'no_execution', 'no_supabase']) expect(BRIDGE_OWNS_LEDGER.has(o)).toBe(false);
  });
});

describe('applyExecTerminalSideEffects deferLedger (AC-2)', () => {
  test('source: the option short-circuits only the ledger mapping', () => {
    const src = read('src/services/dev-autopilot-execute.ts');
    expect(src).toContain('opts: { deferLedger?: boolean } = {},');
    expect(src).toContain('const ledgerStatus = opts.deferLedger ? null : ledgerStatusForExecution(status);');
  });
});
