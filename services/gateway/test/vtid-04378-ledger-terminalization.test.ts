/**
 * VTID-04378: every state that ends an execution for good also closes the
 * finding's ledger VTID — the bridge's escalation and the reject path used to
 * write their status with a raw PATCH that skipped the ledger.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ledgerStatusForExecution } from '../src/services/dev-autopilot-execute';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('ledgerStatusForExecution', () => {
  it('maps terminal execution statuses to a ledger outcome', () => {
    expect(ledgerStatusForExecution('completed')).toBe('completed');
    expect(ledgerStatusForExecution('failed')).toBe('failed');
    expect(ledgerStatusForExecution('cancelled')).toBe('cancelled');
    expect(ledgerStatusForExecution('failed_escalated')).toBe('failed');
  });
  it('leaves non-terminal states and `reverted` (a child continues the VTID) alone', () => {
    for (const s of ['reverted', 'running', 'cooling', 'ci', 'merging', 'deploying', 'verifying', 'awaiting_approval']) {
      expect(ledgerStatusForExecution(s)).toBeNull();
    }
  });
});

describe('wiring', () => {
  it('every failed_escalated PATCH in the bridge is followed by a ledger close', () => {
    const src = read('src/services/dev-autopilot-bridge.ts');
    const escalations = src.split("status: 'failed_escalated',").length - 1;
    const closes = src.split('closeLedgerForEscalation(s, exec.id);').length - 1;
    expect(escalations).toBeGreaterThanOrEqual(4);
    expect(closes).toBe(escalations);
    expect(src).toContain("applyExecTerminalSideEffects(s, executionId, 'failed_escalated')");
  });
  it('reject closes the ledger as cancelled', () => {
    expect(read('src/services/dev-autopilot-approval.ts')).toContain("applyExecTerminalSideEffects(s, execId, 'cancelled');");
  });
  it('the terminal side effects use the mapping, and a failed ledger write is an error, not a warning', () => {
    const src = read('src/services/dev-autopilot-execute.ts');
    // VTID-04472: a watcher failure handed to the bridge defers the ledger.
    expect(src).toContain('const ledgerStatus = opts.deferLedger ? null : ledgerStatusForExecution(status);');
    expect(src).toContain('vtid_ledger terminalize FAILED');
  });
});
