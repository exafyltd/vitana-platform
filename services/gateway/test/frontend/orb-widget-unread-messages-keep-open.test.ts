import * as fs from 'fs';
import * as path from 'path';

// BOOTSTRAP-ORB-UNREAD-MESSAGES-NAV — a deterministic greeting-effect
// navigate (see routes/orb-live.ts's `_renderSync` / compute-greeting-
// decision.ts's `GreetingEffects.navigateEffect`) can ask the client widget
// to keep the ORB session open after navigating, instead of the normal
// hide-then-navigate teardown — e.g. "you have new messages" -> open the
// inbox -> stay listening so a dictated reply can follow immediately.
//
// Static source checks (same approach as the sibling orb-widget suites): the
// widget is a plain browser IIFE with no export surface.

const WIDGET_PATH = path.resolve(__dirname, '../../src/frontend/command-hub/orb-widget.js');

function extractBlockFrom(source: string, marker: string): string {
  const idx = source.indexOf(marker);
  expect(idx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', idx);
  expect(openIdx).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(idx, i + 1);
  }
  throw new Error(`unclosed block: ${marker}`);
}

describe('orb-widget keep_orb_open on navigate (BOOTSTRAP-ORB-UNREAD-MESSAGES-NAV)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const navigateBlock = extractBlockFrom(source, "if (msg.directive === 'navigate') {");

  it('skips _hide() and clears navigationPending when keep_orb_open is true', () => {
    expect(navigateBlock).toMatch(/msg\.keep_orb_open === true/);
    expect(navigateBlock).toMatch(/_s\.navigationPending = false/);
  });

  it('still calls _hide() on the normal (keep_orb_open absent) path', () => {
    // The branch must be an if/else — _hide() still exists in this block
    // for the default case, unconditionally reachable when the flag isn't set.
    expect(navigateBlock).toMatch(/\}\s*else\s*\{\s*_hide\(\);\s*\}/);
  });

  it('onNavigationRequest is still called in both branches (navigation itself is unaffected)', () => {
    const afterHideDecision = navigateBlock.slice(navigateBlock.indexOf('_s.navigationPending = false'));
    expect(afterHideDecision).toMatch(/onNavigationRequest/);
  });

  it('the audio/audio_out handler still drops audio while navigationPending — unaffected by this change', () => {
    // Sanity: the keep_orb_open reset relies on this guard being read AFTER
    // navigationPending flips back to false. If this guard were ever removed
    // or the reset were dropped, audio after a keep-open navigate would be
    // silently swallowed forever — the exact regression this suite exists to
    // catch, mirrored from the widget's own inline comment at the call site.
    // VTID-03800: this used to slice a fixed 700 characters after the case
    // label, which silently made the assertion a function of how much COMMENT
    // sat above the guard — adding an explanatory comment to the handler
    // pushed the guard out of the window and failed a test about code that
    // had not changed. Bound the search by the handler's own extent instead,
    // so it tracks the structure it is actually asserting about.
    const idx = source.indexOf("case 'audio':");
    expect(idx).toBeGreaterThanOrEqual(0);
    const nextCase = source.indexOf("\n      case '", idx + 'case \'audio\':'.length + 1);
    expect(nextCase).toBeGreaterThan(idx);
    const handler = source.slice(idx, nextCase);
    expect(handler).toMatch(/if \(_s\.navigationPending\) break;/);
  });
});
