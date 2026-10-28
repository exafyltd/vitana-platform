/**
 * VTID-04986 — the generated screen inventory and Command Hub navigation
 * config no longer list the four Overview tabs retired by VTID-04887, so a
 * stale regen fails CI even when REGEN-SCREENS-CATALOG.yml is skipped.
 */
import * as fs from 'fs';
import * as path from 'path';

const GATEWAY = path.resolve(__dirname, '..');
const RETIRED = ['live-metrics', 'recent-events', 'errors-violations', 'release-feed'];

describe('VTID-04986 generated screen catalog', () => {
  const inventory = fs.readFileSync(path.join(GATEWAY, 'specs/dev-screen-inventory-v1.json'), 'utf8');
  const navConfig = fs.readFileSync(path.join(GATEWAY, 'src/frontend/command-hub/navigation-config.js'), 'utf8');

  it.each(RETIRED)('the inventory lists no retired Overview tab: %s', (tab) => {
    expect(inventory).not.toContain(`/command-hub/overview/${tab}/`);
  });

  it.each(RETIRED)('navigation-config.js lists no retired Overview tab: %s', (tab) => {
    expect(navConfig).not.toMatch(new RegExp(`['"]${tab}['"]`));
  });

  it('the Overview keeps its live system view', () => {
    expect(inventory).toContain('/command-hub/overview/system-overview/');
  });
});
