/**
 * VTID-04241 — CODEINTEL-INDEX queues runs instead of cancelling the one in
 * flight.
 *
 * A full index build takes ~12 min. With `cancel-in-progress: true` every
 * push to main killed the previous run: on 2026-09-21 runs 3/4/5 were each
 * cancelled by the next merge, `latest/` stayed on run 2's sha through three
 * merges, and the executor (VTID-04229 `runner:code_index`) and the Operator
 * Console served a bundle three merges stale. The group must still serialise
 * publishes (one `latest/` writer at a time) — only the cancel is wrong.
 */
import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows/CODEINTEL-INDEX.yml');
const src = fs.readFileSync(WF, 'utf8');

describe('VTID-04241: CODEINTEL-INDEX concurrency', () => {
  it('keeps a single concurrency group so two runs never race on latest/', () => {
    expect(src).toMatch(/^concurrency:\n\s+group:\s*codeintel-index\n/m);
  });

  it('does NOT cancel the in-flight build on a new push (queues instead)', () => {
    const m = src.match(/^concurrency:\n(?:\s+.+\n)+/m);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/cancel-in-progress:\s*false/);
    expect(m![0]).not.toMatch(/cancel-in-progress:\s*true/);
  });

  it('records why, next to the setting', () => {
    expect(src).toMatch(/VTID-04241/);
    expect(src).toMatch(/cancelled by the next push/);
  });
});
