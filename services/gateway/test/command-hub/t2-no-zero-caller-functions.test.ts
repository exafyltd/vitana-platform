/**
 * VTID-04082 (T2): standing guard — no zero-caller function in
 * services/gateway/src/frontend/command-hub/app.js.
 *
 * app.js is a plain script with no build step, no tree-shaking, and no
 * linter that flags unused top-level functions — dead code here only ever
 * gets found by someone manually grepping the whole file. That happened
 * four separate times (T1a/T1c/T1d, and again as a byproduct of this very
 * PR — deleting 12 clearly-dead functions exposed 4 more that had only ever
 * been called BY the ones just removed): dozens of functions whose only
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
 * Two structural exceptions, not name-based allowlisting:
 *
 *  - A function expression immediately wrapped in `(function name() {...})()`
 *    (an IIFE) is self-invoking by construction — it runs once at load
 *    time and needs no external call site. `installAuthFetchInterceptor`
 *    is exactly this shape. Detected structurally (a `(` immediately
 *    before `function`), not by name, so a future IIFE doesn't need a
 *    test change to be recognised correctly.
 *
 *  - The Memory Garden / old-Intelligence panel block (`refreshMemoryGarden`,
 *    `renderMemoryGardenView`, `renderKnowledgeGraphView`, `renderRecallView`,
 *    `renderInspectorView`, `renderEmbeddingsView`) is GENUINELY dead today,
 *    but is deliberately gated pending a separate product decision (T1b:
 *    wire it up vs. delete it) — see the CLAUDE.md task list. Removing it
 *    here would preempt that decision. These six names are the one
 *    allowlist this guard carries, and each one is a name T1b's own scope
 *    must account for; if T1b ships (either direction) and any of these
 *    six survives it while genuinely gaining/losing callers, this
 *    allowlist needs updating in the same PR.
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
 * Names deliberately excluded from this guard because they belong to the
 * Memory Garden / old-Intelligence panel block gated behind T1b (see the
 * docstring above). Every name here MUST currently be a genuine zero-caller
 * function — if one of these gains a real caller (or is deleted), remove it
 * from this list in the same change, so the allowlist can never silently
 * grow to cover something new and unrelated.
 */
const T1B_GATED_ALLOWLIST = [
  'refreshMemoryGarden',
  'renderMemoryGardenView',
  'renderKnowledgeGraphView',
  'renderRecallView',
  'renderInspectorView',
  'renderEmbeddingsView',
];

/** Every function that was verified zero-caller and deleted by this PR. */
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

  it('the only zero-caller functions in app.js are the T1b-gated Memory Garden block', () => {
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

  it('no reference — call site OR comment — to any function removed by this PR remains anywhere in app.js', () => {
    for (const name of REMOVED_BY_THIS_PR) {
      const matches = src.match(new RegExp('\\b' + name + '\\b', 'g')) || [];
      expect({ name, matches: matches.length }).toEqual({ name, matches: 0 });
    }
  });

  it('the gated Memory Garden / Intelligence panel block is untouched', () => {
    for (const name of T1B_GATED_ALLOWLIST) {
      expect(src).toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
    }
  });

  it('the Command Hub cache-buster on index.html was bumped for this change', () => {
    const indexHtml = readFileSync(join(__dirname, '../../src/frontend/command-hub/index.html'), 'utf8');
    const appVersion = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    // "at or after", not exact-match — VTID-04028/VTID-04031/VTID-04074's
    // own lesson: a later sibling PR legitimately re-bumping this marker
    // must not break this assertion.
    expect(appVersion >= '20260918-vtid-04082-zero-caller-guard').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + appVersion);
  });
});
