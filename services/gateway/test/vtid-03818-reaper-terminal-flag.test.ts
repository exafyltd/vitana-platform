/**
 * VTID-03818: allocatedOrphanReaperTick() used to tombstone an orphaned
 * "allocated" shell row by setting status='deleted' WITHOUT is_terminal or
 * terminal_outcome — unlike the Command Hub's own manual delete endpoint
 * (routes/oasis-tasks.ts), which sets both alongside status. That mismatch
 * was the direct cause of 204 live vtid_ledger rows sitting at
 * status='deleted' with is_terminal not true, confirmed by direct query
 * before this fix.
 *
 * allocatedOrphanReaperTick() itself needs a live Supabase connection (it
 * isn't exported and isn't unit-testable in isolation, matching this test
 * file's own stated scope: "Full approve/cancel flows require Supabase;
 * covered by integration tests"). This is a source-level regression guard
 * instead — it fails if the PATCH body this function sends ever drops the
 * terminal fields again, without requiring a Supabase mock harness.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/services/dev-autopilot-execute.ts'),
  'utf8'
);

function reaperFunctionBody(): string {
  const start = SOURCE.indexOf('async function allocatedOrphanReaperTick');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\nlet backgroundTickerStarted', start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('allocatedOrphanReaperTick terminal-flag regression (VTID-03818)', () => {
  it("sets is_terminal: true on the tombstoning PATCH", () => {
    expect(reaperFunctionBody()).toMatch(/is_terminal:\s*true/);
  });

  it("sets terminal_outcome: 'deleted' on the tombstoning PATCH", () => {
    expect(reaperFunctionBody()).toMatch(/terminal_outcome:\s*['"]deleted['"]/);
  });

  it('still sets status: deleted (unchanged behavior)', () => {
    expect(reaperFunctionBody()).toMatch(/status:\s*['"]deleted['"]/);
  });
});
