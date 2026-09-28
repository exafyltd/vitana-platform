/**
 * VTID-04667 (P4, item 4): recommendation types with no executor show
 * "Create task" instead of "Activate" in the Command Hub. The Command Hub
 * mirrors MANUALLY_BRIDGEABLE_SOURCE_TYPES; this test fails if the two lists
 * drift, and pins that the listings carry source_type.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MANUALLY_BRIDGEABLE_SOURCE_TYPES } from '../src/services/autopilot-executable-source-types';

const APP = fs.readFileSync(path.resolve(__dirname, '../src/frontend/command-hub/app.js'), 'utf8');

function appList(): string[] {
  const m = APP.match(/var EXECUTABLE_REC_SOURCE_TYPES = \[([\s\S]*?)\];/);
  if (!m) throw new Error('EXECUTABLE_REC_SOURCE_TYPES not found in app.js');
  return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
}

function loadLabelFn(): (rec: unknown) => string {
  const list = APP.match(/var EXECUTABLE_REC_SOURCE_TYPES = \[[\s\S]*?\];/)![0];
  const fn = APP.match(/function recActivateLabel\(rec\) \{[\s\S]*?\n\}/)![0];
  // eslint-disable-next-line no-new-func
  return new Function(`${list}\n${fn}\nreturn recActivateLabel;`)() as (rec: unknown) => string;
}

describe('Command Hub executable source types', () => {
  it('app.js mirrors MANUALLY_BRIDGEABLE_SOURCE_TYPES exactly', () => {
    expect([...appList()].sort()).toEqual([...MANUALLY_BRIDGEABLE_SOURCE_TYPES].sort());
  });

  it('"Create task" for types with no executor, "Activate" otherwise and when unknown', () => {
    const label = loadLabelFn();
    for (const t of ['oasis', 'roadmap', 'behavior', 'system_health']) expect(label({ source_type: t })).toBe('Create task');
    for (const t of MANUALLY_BRIDGEABLE_SOURCE_TYPES) expect(label({ source_type: t })).toBe('Activate');
    expect(label({})).toBe('Activate');
    expect(label(null)).toBe('Activate');
  });

  it('both Activate call sites use the label (Pending Approvals modal and Overview card)', () => {
    const uses = APP.match(/var activateIdleLabel = recActivateLabel\(rec\);\s*activateBtn\.textContent = activateIdleLabel;/g) || [];
    expect(uses.length).toBe(2);
    // the four failure paths restore the same label, never a hardcoded 'Activate'
    expect((APP.match(/activateBtn\.textContent = activateIdleLabel;/g) || []).length).toBe(6);
  });

  it('the listings the cards read select source_type', () => {
    const recs = fs.readFileSync(path.resolve(__dirname, '../src/routes/autopilot-recommendations.ts'), 'utf8');
    const sel = recs.match(/const select = '([^']+)';/)![1].split(',');
    expect(sel).toContain('source_type');
    const pipeline = fs.readFileSync(path.resolve(__dirname, '../src/routes/autopilot.ts'), 'utf8');
    expect(pipeline).toMatch(/autopilot_recommendations\?status=eq\.pending[^`]*select=[^`]*\bsource_type\b/);
  });

  it('cache-bust is bumped for this change', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../src/frontend/command-hub/index.html'), 'utf8');
    // At or after this change's tag: a later change bumps it again (VTID-04661
    // relaxed the exact pin, same form as the VTID-04028/04033 pins).
    const app = html.match(/app\.js\?v=([^"]+)/)![1];
    const css = html.match(/styles\.css\?v=([^"]+)/)![1];
    expect(app >= '20261016-vtid-04667').toBe(true);
    expect(css >= '20261016-vtid-04667').toBe(true);
  });
});
