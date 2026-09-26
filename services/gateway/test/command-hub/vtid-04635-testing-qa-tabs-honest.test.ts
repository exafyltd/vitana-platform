/**
 * VTID-04635 — Testing & QA tabs tell the truth.
 *
 * P0 of the Testing & QA rebuild removed a hand-typed coverage table, the dead
 * GCP Cloud Run host, three run buttons the backend always refused and a fake
 * CI Reports row, and put a "being rebuilt" notice on every tab until the new
 * screens landed (VTID-04642). This pins what must stay gone. (The served bytes are not a usable check: the function sits past
 * the first megabyte of a 2.5 MB file, and Cloudflare caches the unversioned
 * /command-hub/app.js path.)
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '../../src/frontend/command-hub/app.js'), 'utf8');

describe('VTID-04635 Testing & QA tabs', () => {
  it('replaced the stale tabs with the rebuilt screens (the P0 notice was temporary; VTID-04642 removed it)', () => {
    expect(APP).toMatch(/function renderTestingOverviewView\(/);
    expect(APP).not.toMatch(/function renderTestingUnitView\(/);
    expect(APP).not.toMatch(/function renderTestingCiReportsView\(/);
  });

  it('no longer carries the hand-typed coverage table or the Cloud Run URL state', () => {
    expect(APP).not.toMatch(/GATEWAY_COVERAGE_PHASES/);
    expect(APP).not.toMatch(/renderGatewayCoveragePhasesTable/);
    expect(APP).not.toMatch(/state\.cloudRunUrl/);
  });

  it('offers no run buttons for suites the backend refuses', () => {
    for (const id of ['frontend-vitest', 'integration-full', 'validator-governance']) {
      expect(APP).not.toContain(`'${id}'`);
    }
  });
});
