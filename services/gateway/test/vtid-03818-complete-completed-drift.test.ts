/**
 * VTID-03818: `vtid_ledger.status` had two live values for "done" —
 * 'complete' (47 rows, confirmed live) and 'completed'. The Command Hub's
 * own board-adapter.ts already normalized both server-side, but three
 * places in the frontend (app.js — a plain script with no module exports,
 * so this is a source-text regression guard rather than an import-based
 * unit test) only ever checked for 'completed', stranding a bare 'complete'
 * row that reached the client without a server-computed oasisColumn.
 *
 * A one-time migration (applied live, same VTID) normalized every existing
 * 'complete' row to 'completed'; these three fixes are defense-in-depth so
 * a future 'complete' row (however it gets created) still renders/behaves
 * correctly instead of silently stranding in the wrong column/state again.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/app.js'),
  'utf8'
);

describe("'complete' / 'completed' status drift fix (VTID-03818)", () => {
  it("mapStatusToColumn()'s Completed-column check recognizes 'complete' alongside 'completed'", () => {
    const start = SOURCE.indexOf('function mapStatusToColumn(status)');
    expect(start).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('\n}', start);
    const body = SOURCE.slice(start, end);
    expect(body).toMatch(/'deployed',\s*'completed',\s*'complete',/);
  });

  it("renderTaskDrawer()'s isFinalMode check recognizes 'complete' alongside 'completed'", () => {
    const idx = SOURCE.indexOf("taskStatus === 'completed' ||\n        taskStatus === 'complete' ||");
    expect(idx).toBeGreaterThan(-1);
  });

  it("renderTaskDrawer()'s isInconsistentState check recognizes 'complete' alongside 'completed'", () => {
    expect(SOURCE).toMatch(/isInconsistentState = \(taskStatus === 'completed' \|\| taskStatus === 'complete' \|\| taskStatus === 'failed'\)/);
  });

  it("renderTaskDrawer()'s isCompleted check recognizes 'complete' alongside 'completed'", () => {
    expect(SOURCE).toMatch(/isCompleted = taskStatus === 'completed' \|\| taskStatus === 'complete' \|\|/);
  });
});
