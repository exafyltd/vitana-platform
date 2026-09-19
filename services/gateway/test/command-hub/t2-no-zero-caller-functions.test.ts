/**
 * VTID-04082 (T2): standing guard — no zero-caller function in
 * services/gateway/src/frontend/command-hub/app.js.
 *
 * app.js is a plain script with no build step, no tree-shaking, and no
 * linter that flags unused top-level functions — dead code here only ever
 * gets found by someone manually grepping the whole file. That happened
 * five separate times now (T1a/T1c/T1d, the 12+4 functions this guard's own
 * PR found, and T1b/VTID-04093 below): dozens of functions whose only
 * occurrence in the file was their own `function name(...)` definition,
 * accumulating silently for months. This is the standing guard that stops
 * a NEW one from doing the same: it scans app.js the same way each of
 * those cleanups did by hand — for every top-level `function name(` (or
 * `async function name(`) declaration, count every textual occurrence of
 * that identifier in the whole file. A count of 1 means nothing but the
 * definition itself ever mentions the name: no call site, no
 * `window.name` export, no registration in a config/table object literal,
 * not even a stale comment.
 *
 * One structural exception, not name-based allowlisting:
 *
 *  - A function expression immediately wrapped in `(function name() {...})()`
 *    (an IIFE) is self-invoking by construction — it runs once at load
 *    time and needs no external call site. `installAuthFetchInterceptor`
 *    is exactly this shape. Detected structurally (a `(` immediately
 *    before `function`), not by name, so a future IIFE doesn't need a
 *    test change to be recognised correctly.
 *
 * T1b resolved (VTID-04093): the Memory Garden / old-Intelligence panel
 * block this guard used to allowlist by name (`refreshMemoryGarden`,
 * `renderMemoryGardenView`, `renderKnowledgeGraphView`, `renderRecallView`,
 * `renderInspectorView`, `renderEmbeddingsView`) was confirmed to be a
 * fabricated-mock-data duplicate of `renderMemoryOpsView` (VTID-02636) —
 * already real, already backend-wired to `/api/v1/admin/memory/*`, already
 * mounted live under the same `intelligence-memory-dev` nav slot. Deleted
 * instead of wired. The allowlist below is empty and no zero-caller
 * function is now tolerated in app.js.
 *
 * Scope note (same as every prior cleanup in this chain): this only
 * recognises the classic `function name(...)` / `async function name(...)`
 * declaration form, not `const name = () => {}` or object-literal method
 * shorthand — matching T1a/T1c/T1d's own methodology exactly, so this test
 * generalises what they already did by hand rather than inventing a new,
 * untested detection strategy.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');

/**
 * No names are gated behind an open product decision any more — T1b
 * resolved. If a future cleanup needs to gate something again, add it
 * here with the same "must currently be a genuine zero-caller function"
 * discipline the T1b entry followed.
 */
const T1B_GATED_ALLOWLIST: string[] = [];

/** Every function that was verified zero-caller and deleted by the T2 PR (VTID-04082). */
const REMOVED_BY_THIS_PR = [
  'fetchVtidsList',
  'extractLayer',
  'fetchVtidLedger',
  'approveApprovalItem',
  'denyApprovalItem',
  'fetchAdminDevUsers',
  'grantDevAccess',
  'revokeDevAccess',
  'toggleHeartbeatSession',
  'stopOperatorSse',
  'fetchOperatorHistory',
  'ensureLineageLoaded',
  'ensureStepsStreamOpened',
  'closeStepsStream',
  'renderDevAutopilotLineageView',
  'renderDevAutopilotStepsView',
];

/**
 * The whole dead Memory Garden / old-Intelligence panel block deleted by
 * T1b (VTID-04093) — 21 function declarations (the 6 the T2 guard used to
 * allowlist, plus every helper whose only callers lived inside that same
 * block: fetch functions, sub-view renderers, and icon/subcategory
 * helpers) plus the 2 constant object literals (`MEMORY_GARDEN_ICONS`,
 * `LONGEVITY_MESSAGES`) they referenced. Superseded by `renderMemoryOpsView`
 * (VTID-02636), which is real, backend-wired, and already live in the same
 * nav slot — see the file docstring above.
 */
const REMOVED_BY_VTID_04093 = [
  'refreshMemoryGarden',
  'renderMemoryGardenView',
  'renderKnowledgeGraphView',
  'renderRecallView',
  'renderInspectorView',
  'renderEmbeddingsView',
  'fetchMemoryGardenProgress',
  'fetchLongevitySummary',
  'fetchCategoryMemories',
  'fetchMemoryFacts',
  'fetchRelationshipGraph',
  'fetchBehavioralSignals',
  'renderMemoryGardenCard',
  'renderLongevityFocusPanel',
  'renderLongevitySignal',
  'renderDiaryEntryModal',
  'renderCategoryDetailModal',
  'getCategorySubcategories',
  'renderUnifiedIntelligencePanel',
  'escapeHtmlSafe',
  'getKnowledgeGraphIcon',
];

/** Constant object literals deleted alongside REMOVED_BY_VTID_04093 (not functions, so the zero-caller scan below never covered them — checked by their own assertion instead). */
const CONSTANTS_REMOVED_BY_VTID_04093 = [
  'MEMORY_GARDEN_ICONS',
  'LONGEVITY_MESSAGES',
];

/**
 * Finds every `[async ]function name(` declaration in `src` and returns the
 * names whose total textual occurrence count in the file is <= 1 — i.e. the
 * definition is the ONLY mention of the name anywhere. A function preceded
 * immediately by `(` (an IIFE) is excluded structurally, not by name.
 */
function findZeroCallerFunctions(src: string): string[] {
  const defRe = /(\(\s*)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  const candidates = new Map<string, boolean /* isIife */>();
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(src))) {
    const isIife = !!m[1];
    const name = m[2];
    // A name could legitimately be declared more than once (shouldn't
    // happen, but never let a later non-IIFE match un-flag an IIFE, or
    // vice versa, silently) — once seen as an IIFE, stays excluded.
    if (!candidates.has(name) || isIife) candidates.set(name, isIife || candidates.get(name) === true);
  }

  const zeroCaller: string[] = [];
  for (const [name, isIife] of candidates) {
    if (isIife) continue;
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
    const count = (src.match(re) || []).length;
    if (count <= 1) zeroCaller.push(name);
  }
  return zeroCaller.sort();
}

describe('Command Hub app.js — standing guard: no zero-caller functions (VTID-04082 / T2)', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  it('there are no zero-caller functions in app.js', () => {
    const found = findZeroCallerFunctions(src);
    expect(found).toEqual([...T1B_GATED_ALLOWLIST].sort());
  });

  it('the IIFE detector actually recognises a real IIFE (installAuthFetchInterceptor is not flagged)', () => {
    // Guards the guard: if the IIFE exclusion ever silently stops working,
    // this well-known self-invoking function would start failing the test
    // above for the wrong reason (mistaken for real dead code) — this
    // assertion makes that failure mode explicit and diagnosable on its own.
    expect(src).toMatch(/\(function\s+installAuthFetchInterceptor\s*\(/);
    const found = findZeroCallerFunctions(src);
    expect(found).not.toContain('installAuthFetchInterceptor');
  });

  it.each(REMOVED_BY_THIS_PR)('no `function %s(` definition remains in app.js', (name) => {
    expect(src).not.toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
  });

  it('no reference — call site OR comment — to any function removed by T2 (VTID-04082) remains anywhere in app.js', () => {
    for (const name of REMOVED_BY_THIS_PR) {
      const matches = src.match(new RegExp('\\b' + name + '\\b', 'g')) || [];
      expect({ name, matches: matches.length }).toEqual({ name, matches: 0 });
    }
  });

  it.each(REMOVED_BY_VTID_04093)('no `function %s(` definition remains in app.js (T1b, VTID-04093)', (name) => {
    expect(src).not.toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
  });

  it('no reference — call site OR comment — to any function deleted by T1b (VTID-04093) remains anywhere in app.js', () => {
    for (const name of REMOVED_BY_VTID_04093) {
      const matches = src.match(new RegExp('\\b' + name + '\\b', 'g')) || [];
      expect({ name, matches: matches.length }).toEqual({ name, matches: 0 });
    }
  });

  it('no reference to either constant object literal deleted by T1b (VTID-04093) remains anywhere in app.js', () => {
    for (const name of CONSTANTS_REMOVED_BY_VTID_04093) {
      const matches = src.match(new RegExp('\\b' + name + '\\b', 'g')) || [];
      expect({ name, matches: matches.length }).toEqual({ name, matches: 0 });
    }
  });

  it('the moduleKey===\'memory-garden\' dead branch in triggerGlobalRefresh is gone', () => {
    expect(src).not.toContain("moduleKey === 'memory-garden'");
  });

  it('renderMemoryOpsView — the real replacement (VTID-02636) — is untouched and still mounted', () => {
    expect(src).toMatch(/function\s+renderMemoryOpsView\s*\(/);
    expect(src).toContain("moduleKey === 'intelligence-memory-dev'");
  });

  it('the Command Hub cache-buster on index.html was bumped for this change', () => {
    const indexHtml = readFileSync(join(__dirname, '../../src/frontend/command-hub/index.html'), 'utf8');
    const appVersion = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    // "at or after", not exact-match — VTID-04028/VTID-04031/VTID-04074's
    // own lesson: a later sibling PR legitimately re-bumping this marker
    // must not break this assertion.
    expect(appVersion >= '20260918-vtid-04093-t1b-delete-dead-memory-block').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + appVersion);
  });
});
