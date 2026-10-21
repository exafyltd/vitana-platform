/**
 * VTID-04060: dead Workflows-module Command Hub views stay deleted.
 *
 * app.js carried five Workflows render functions plus four paired fetch
 * helpers that nothing could reach: NAVIGATION_CONFIG (navigation-config.js)
 * has no `workflows` section at all, so no route can select those tabs, and
 * — verified by grepping the whole file before deletion — the only
 * occurrence of each name was its own definition (the other definitions
 * only called each other: each render view called its own fetch helper).
 *
 * They were a whole module of dead DOM-building code, including three
 * `refreshWorkflow*Content()` calls into helpers that no longer exist
 * anywhere in the file (so the append branch of each fetch would have
 * thrown a ReferenceError had it ever run).
 *
 * This suite pins the deletion by source text — app.js is a plain script
 * with no build step and no render-test harness (see
 * memory-garden-placeholder-banner.test.ts for the same approach) — so the
 * dead code cannot silently come back.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');

const REMOVED_FUNCTIONS = [
  'renderWorkflowsListView',
  'renderWorkflowsTriggersView',
  'renderWorkflowsActionsView',
  'renderWorkflowsSchedulesView',
  'renderWorkflowsHistoryView',
  'fetchWorkflowRuns',
  'fetchWorkflowTriggers',
  'fetchWorkflowSchedules',
  'fetchWorkflowHistory',
];

describe('Command Hub — dead Workflows-module code removed (VTID-04060)', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  it.each(REMOVED_FUNCTIONS)('no `function %s(` definition remains in app.js', (name) => {
    expect(src).not.toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
  });

  it('no reference to any removed function remains anywhere in app.js', () => {
    for (const name of REMOVED_FUNCTIONS) {
      expect(src).not.toContain(name);
    }
  });

  it('the module they belonged to is still unroutable (no `workflows` section in the navigation config)', () => {
    const navConfig = readFileSync(
      join(__dirname, '../../src/frontend/command-hub/navigation-config.js'),
      'utf8',
    );
    expect(navConfig).not.toMatch(/workflows/i);
  });

  it('the Command Hub cache-buster on index.html was bumped for this change', () => {
    const indexHtml = readFileSync(
      join(__dirname, '../../src/frontend/command-hub/index.html'),
      'utf8',
    );
    const appVersion = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(appVersion >= '20260918-vtid-04060-dead-workflows-removed').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + appVersion);
  });
});
