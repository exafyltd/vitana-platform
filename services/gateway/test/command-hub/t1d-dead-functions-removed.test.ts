/**
 * VTID-04063: dead Command Hub functions in app.js stay deleted.
 *
 * A BFS reachability analysis from top-level references (plus a second,
 * independent grep pass re-run against the current file, since two earlier
 * cleanup PRs had already landed since that analysis) found 29 functions
 * whose ONLY occurrence in app.js was their own `function <name>(...)`
 * definition — no call site, no registration in a config/table/object
 * literal, no `window.<name>` export. A few were named in prose comments
 * (e.g. the VTID-0520 spec comment mentioning `stopCicdHealthPolling()`);
 * those comments were updated/removed as part of the deletion, since a
 * prose mention of a function that no longer exists is itself stale.
 *
 * Everything in the Memory Garden / old Intelligence panel block is
 * deliberately OUT of scope here — that block is gated pending a separate
 * product decision and must be left exactly as-is.
 *
 * This suite pins the deletion by source text (app.js is a plain script
 * with no build step and no render-test harness — see
 * dead-code-workflows-removed.test.ts for the same approach) so the dead
 * code cannot silently come back.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');

/** Every function actually verified zero-caller and deleted in this change. */
const REMOVED_FUNCTIONS = [
  'setTaskStatusOverride',
  'isApprovalDismissed',
  'dismissApproval',
  'getOperatorConversationId',
  'saveOperatorChatHistory',
  'updateVtidsTableBody',
  'createVtidRow',
  'startOasisEventsAutoRefresh',
  'stopOasisEventsAutoRefresh',
  'stopApprovalsBadgePolling',
  'loadVersionHistory',
  'formatVersionTimestamp',
  'handleSplitScreenToggle',
  'renderAdminDevUsersView',
  'renderOrchestratorSummaryCard',
  'renderSubagentsTable',
  'renderVtidFingerprints',
  'streamingFlag',
  'loadVoiceLabRuntimeControls',
  'renderVtidLedgerTable',
  'renderOasisVtidDetailPanel',
  'isDeployCommand',
  'generateCommandVtid',
  'formatCommandResult',
  'getMostRecentVersion',
  'getPendingActionState',
  'stopTelemetryAutoRefresh',
  'stopCicdHealthPolling',
  'formatCicdHealthTooltip',
];

/**
 * The gated Memory Garden / old Intelligence panel block. These must survive
 * this change untouched, so nothing in this suite may match them by accident
 * and a future cleanup must not sweep them up under the same VTID.
 */
const MUST_SURVIVE = [
  'renderMemoryGardenView',
  'renderMemoryGardenCard',
  'renderLongevityFocusPanel',
  'renderLongevitySignal',
  'renderDiaryEntryModal',
  'renderCategoryDetailModal',
  'getCategorySubcategories',
  'renderUnifiedIntelligencePanel',
  'escapeHtmlSafe',
  'renderKnowledgeGraphView',
  'getKnowledgeGraphIcon',
  'renderRecallView',
  'renderInspectorView',
  'renderEmbeddingsView',
];

describe('Command Hub — dead functions removed (VTID-04063)', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  it.each(REMOVED_FUNCTIONS)('no `function %s(` definition remains in app.js', (name) => {
    expect(src).not.toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
  });

  it('no reference — call site OR comment — to any removed function remains anywhere in app.js', () => {
    for (const name of REMOVED_FUNCTIONS) {
      // \b so `updateVtidsTableBody` does not match the surviving
      // `updateVtidsTableBodyFromProjection` and `streamingFlag` does not
      // match a longer identifier either.
      const matches = src.match(new RegExp('\\b' + name + '\\b', 'g')) || [];
      expect({ name, matches: matches.length }).toEqual({ name, matches: 0 });
    }
  });

  it('the gated Memory Garden / Intelligence panel block is untouched', () => {
    for (const name of MUST_SURVIVE) {
      expect(src).toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
    }
  });

  it('functions that were NOT on the deletion list are still present', () => {
    // Neighbours of deleted names, to catch an over-eager deletion.
    ['getOperatorChatHistory', 'startApprovalsBadgePolling', 'fetchApprovals', 'getSelectedVersion'].forEach((name) => {
      expect(src).toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
    });
  });

  it('the Command Hub cache-buster on index.html was bumped for this change', () => {
    const indexHtml = readFileSync(
      join(__dirname, '../../src/frontend/command-hub/index.html'),
      'utf8',
    );
    const appVersion = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(appVersion >= '20260918-vtid-04063-dead-functions-removed').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + appVersion);
  });
});
