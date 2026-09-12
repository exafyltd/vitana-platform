/**
 * VTID-03818: Ledger hygiene — title-backfill regression tests.
 *
 * deriveAllocationTitle() used to return `null` whenever the caller didn't
 * pass an explicit `source` (the common case — `source` defaults to 'api'
 * on the /allocate route), leaving the row on the RPC's literal
 * "Allocated - Pending Title" default forever. Live DB check before this
 * fix: 703 ledger rows still on that placeholder, 184 of them non-terminal.
 *
 * The fix: deriveAllocationTitle() now ALWAYS returns a real string. These
 * tests pin that — no input shape may produce null/empty/placeholder again.
 */

import { deriveAllocationTitle } from '../src/routes/vtid';

describe('deriveAllocationTitle (VTID-03818)', () => {
  it('never returns null or an empty string, for any input combination', () => {
    const cases: Array<[string | undefined, string, string, string]> = [
      [undefined, 'api', 'TASK', 'VTID-04102'],
      ['', 'api', 'TASK', 'VTID-04102'],
      [undefined, '', 'TASK', 'VTID-04102'],
      [undefined, '', '', 'VTID-04102'],
      ['Allocated - Pending Title', 'api', 'TASK', 'VTID-04102'],
    ];
    for (const [title, source, module, vtid] of cases) {
      const result = deriveAllocationTitle(title, source, module, vtid);
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result).not.toBe('Allocated - Pending Title');
    }
  });

  it('prefers a real caller-supplied title over everything else', () => {
    expect(deriveAllocationTitle('Fix Stripe webhook retry storm', 'operator-chat', 'TASK', 'VTID-04102'))
      .toBe('Fix Stripe webhook retry storm');
  });

  it('ignores the literal placeholder title even if a caller passes it explicitly', () => {
    const result = deriveAllocationTitle('Allocated - Pending Title', 'phase-1-w3b1-acceptance-doc', 'DEV', 'VTID-03812');
    expect(result).not.toBe('Allocated - Pending Title');
  });

  it("derives a capitalized title from a meaningful source slug when no title is given", () => {
    expect(deriveAllocationTitle(undefined, 'phase-1-w3b1-acceptance-doc', 'DEV', 'VTID-03812'))
      .toBe('Phase 1 w3b1 acceptance doc');
  });

  it("falls back to '<Module> — <VTID>' when source is the generic 'api' default (the bug's exact trigger)", () => {
    // Only the first character is forced uppercase; an already-all-caps
    // module (as this codebase's real module slugs are, e.g. 'COMHU')
    // stays all-caps rather than being lowercased.
    expect(deriveAllocationTitle(undefined, 'api', 'COMHU', 'VTID-04102'))
      .toBe('COMHU — VTID-04102');
  });

  it("falls back to '<Module> — <VTID>' when source is empty/undefined too", () => {
    expect(deriveAllocationTitle(undefined, '', 'TASK', 'VTID-04102'))
      .toBe('TASK — VTID-04102');
  });

  it('falls back to a generic "Task — <VTID>" when neither source nor module is meaningful', () => {
    expect(deriveAllocationTitle(undefined, 'api', '', 'VTID-04102'))
      .toBe('Task — VTID-04102');
  });

  it('truncates any derived title to 200 characters', () => {
    const longSource = 'x'.repeat(300);
    const result = deriveAllocationTitle(undefined, longSource, 'TASK', 'VTID-04102');
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('truncates a caller-supplied title to 200 characters too', () => {
    const longTitle = 'y'.repeat(300);
    const result = deriveAllocationTitle(longTitle, 'api', 'TASK', 'VTID-04102');
    expect(result.length).toBeLessThanOrEqual(200);
  });
});
