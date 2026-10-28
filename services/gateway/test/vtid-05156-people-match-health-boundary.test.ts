/**
 * VTID-05156 (Health Hub Phase 0 fix-ups, Defect 2) — the people-match tool
 * never reads health data.
 *
 * find_perfect_match used to read the member's latest Vitana Index, take the
 * weakest pillar, build a default people-ask from it ("an accountability
 * partner for a better evening and sleep routine") and hand it to
 * runFindMatch — whose matched path posts the request to the community
 * intent board without a confirm step. A health-derived request could become
 * community-visible without the member ever saying it.
 *
 * This is a source scan in the style of the VTID-05025 commerce boundary
 * suite. It does NOT change that suite's commerce module list (people-match is
 * community, not commerce); it pins the two discovery-tool modules separately.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'src');

// Same table list as test/vtid-05025-commerce-health-boundary.test.ts.
const HEALTH_TABLES = /['"`](wearable_daily_metrics|wearable_rollup_7d|wearable_samples|health_features_daily|biomarker_results|lab_reports|vitana_index_scores|vitana_pillar_agent_outputs)['"`]/;
const WEARABLE_ANALYZER_IMPORT = /from\s+['"][^'"]*wearable-analyzer['"]/;
const WEARABLE_BRIDGE_IMPORT = /from\s+['"][^'"]*wearable-features-bridge(-repository)?['"]/;

const MODULES = [
  'services/orb-tools/discovery-tools.ts',
  'services/orb-tools/discovery-tools-repository.ts',
];

describe('people-match / health purpose boundary — source scan (VTID-05156)', () => {
  it.each(MODULES)('%s touches no health-data table and imports no wearable module', (rel) => {
    const file = path.join(SRC, rel);
    expect(fs.existsSync(file)).toBe(true);
    const src = fs.readFileSync(file, 'utf8');
    expect(src).not.toMatch(HEALTH_TABLES);
    expect(src).not.toMatch(WEARABLE_ANALYZER_IMPORT);
    expect(src).not.toMatch(WEARABLE_BRIDGE_IMPORT);
  });

  it('the removed Index helpers and the pillar-derived ask are gone', () => {
    const tools = fs.readFileSync(path.join(SRC, 'services/orb-tools/discovery-tools.ts'), 'utf8');
    const repo = fs.readFileSync(path.join(SRC, 'services/orb-tools/discovery-tools-repository.ts'), 'utf8');
    expect(tools).not.toContain('getCompassAndWeakestPillar');
    expect(tools).not.toContain('PILLAR_DEFAULT_ASK');
    expect(tools).not.toContain('fetchLatestVitanaIndexScore');
    expect(repo).not.toContain('fetchLatestVitanaIndexScore');
  });

  it('the scan pattern catches the old read', () => {
    expect(".from('vitana_index_scores')").toMatch(HEALTH_TABLES);
    expect(".from('wearable_samples')").toMatch(HEALTH_TABLES);
  });
});
