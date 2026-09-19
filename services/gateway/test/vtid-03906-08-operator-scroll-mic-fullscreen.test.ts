/**
 * VTID-03906 / VTID-03907 / VTID-03908 / VTID-03910 / VTID-03911 —
 * Command Hub Operator popup fixes.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard rather than an import-based
 * unit test — same pattern as vtid-03819-related-task-chip.test.ts.
 *
 * VTID-03906: the Operator chat scroll-restore block used to skip restoring
 *   scroll position whenever the chat textarea had focus (!savedChatFocus),
 *   which is the normal reading/typing state — snapping .chat-messages to
 *   the top on every re-render. Separately, the Overview auto-refresh timer
 *   (_actionRequiredTimer) kept calling a full renderApp() every 30s while
 *   Overview/system-overview was mounted underneath, even with the Operator
 *   popup open on top of it (isOperatorOpen is an independent overlay flag),
 *   tearing down and rebuilding the whole DOM unprompted — the flicker.
 * VTID-03907: adds a mic button beside the chat textarea using the Web
 *   Speech API for voice dictation.
 * VTID-03908: adds fullscreen/restore icon buttons beside the existing X
 *   close button on the Operator overlay header; the X's own behavior is
 *   unchanged.
 * VTID-03910: the fullscreen popup ran edge-to-edge with no visible margin
 *   on any side and reportedly couldn't scroll. Fixed with a symmetric
 *   2cm inset (real CSS length unit) plus a min-height:0 fix through the
 *   nested flex-column chain that was silently defeating overflow-y:auto.
 * VTID-03911: the mic's active/red state was reachable in code but a CSS
 *   specificity bug (:hover:not(:disabled) beating a bare active class)
 *   meant it silently stayed neutral while the cursor rested on the button
 *   after the click — the normal case with a mouse.
 * VTID-03918: once VTID-03911 made the red state actually visible, real
 *   testing surfaced the mic turning red and never reacting to speech,
 *   needing a second manual press to go neutral again. Root cause:
 *   recognition.start() was unguarded and the active class/state were set
 *   BEFORE it ran, so a synchronous throw (or any of the async
 *   not-allowed/audio-capture/network/no-speech onerror codes) left the
 *   button stuck red with no live recognition behind it and no visible
 *   explanation. Fixed by only marking active state after start() succeeds,
 *   wrapping it in try/catch, and surfacing a showToast() reason on every
 *   failure path instead of failing silently.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/app.js'),
  'utf8'
);

const CSS = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/styles.css'),
  'utf8'
);

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

describe('VTID-03906: Operator chat scroll-jump + flicker fix', () => {
  it('the .chat-messages scroll-restore block no longer requires !savedChatFocus', () => {
    const idx = SOURCE.indexOf("if (state.isOperatorOpen && state.operatorActiveTab === 'chat') {");
    expect(idx).toBeGreaterThan(-1);
    // The old, buggy gate must not appear anywhere in the file any more.
    expect(SOURCE).not.toMatch(/state\.operatorActiveTab === 'chat' && !savedChatFocus/);
  });

  it('the scroll-restore block still reads savedChatScroll to preserve position', () => {
    const idx = SOURCE.indexOf("if (state.isOperatorOpen && state.operatorActiveTab === 'chat') {");
    expect(idx).toBeGreaterThan(-1);
    // VTID-04106: was a fixed idx+900 byte slice — the exact VTID-04028
    // failure mode this repo's own tests have already been burned by
    // (a magic byte window silently excluding real content once a comment
    // grows) — scoped to the block's own end marker instead.
    const end = SOURCE.indexOf('// VTID-01002: Restore scroll positions after DOM rebuild', idx);
    expect(end).toBeGreaterThan(idx);
    const nearby = SOURCE.slice(idx, end);
    expect(nearby).toContain('savedChatScroll');
    expect(nearby).toContain('newMessagesContainer.scrollTop');
  });

  it('the independent textarea focus-restore block is untouched', () => {
    expect(SOURCE).toContain('// VTID-0526-E: Restore chat textarea focus after render');
    const idx = SOURCE.indexOf('// VTID-0526-E: Restore chat textarea focus after render');
    const nearby = SOURCE.slice(idx, idx + 300);
    expect(nearby).toContain('if (savedChatFocus) {');
  });

  it('_actionRequiredTimer skips its 30s poll while the Operator popup is open', () => {
    const idx = SOURCE.indexOf('state._actionRequiredTimer = setInterval(function () {');
    expect(idx).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('}, 30000);', idx);
    const body = SOURCE.slice(idx, end);
    expect(body).toContain("state.activeModule === 'overview' && state.activeTab === 'system-overview' && !state.isOperatorOpen");
  });
});

describe('VTID-03907: Operator chat voice dictation', () => {
  it('defines operatorDictationSupported() checking the Web Speech API', () => {
    const body = functionBody(SOURCE, 'function operatorDictationSupported() {');
    expect(body).toContain('window.SpeechRecognition || window.webkitSpeechRecognition');
  });

  it('startOperatorDictation() streams transcripts into state.chatInputValue without calling renderApp()', () => {
    const start = SOURCE.indexOf('function startOperatorDictation(textarea, micBtn) {');
    expect(start).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('\nfunction renderOperatorOverlay', start);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('recognition.onresult = function (event)');
    expect(body).toContain('state.chatInputValue = combined');
    expect(body).toContain('textarea.value = combined');
    // Must not force a full re-render per partial speech result — that would
    // reproduce the exact disruption VTID-03906 fixed for this same popup.
    expect(body).not.toMatch(/recognition\.onresult[\s\S]*?renderApp\(\)/);
  });

  it('startOperatorDictation() sets state.chatDictationActive and clears it on end/error', () => {
    const start = SOURCE.indexOf('function startOperatorDictation(textarea, micBtn) {');
    const end = SOURCE.indexOf('\nfunction renderOperatorOverlay', start);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('state.chatDictationActive = true;');
    // onerror delegates to stopOperatorDictation() (which itself clears the
    // flag); onend clears it directly.
    expect(body).toMatch(/recognition\.onerror = function \(event\) \{[\s\S]*?stopOperatorDictation\(\)/);
    expect(body).toMatch(/recognition\.onend = function \(\) \{[\s\S]*?state\.chatDictationActive = false;/);
  });

  it('the mic button is wired into the chat input row, disabled when unsupported', () => {
    const idx = SOURCE.indexOf("micBtn.className = 'chat-mic-btn'");
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx - 400, idx + 900);
    expect(nearby).toContain('operatorDictationSupported()');
    expect(nearby).toContain('micBtn.disabled = !dictationSupported');
    expect(nearby).toContain('startOperatorDictation(textarea, micBtn)');
    expect(nearby).toContain('stopOperatorDictation()');
    expect(nearby).toContain("inputContainer.appendChild(micBtn)");
  });

  it('sendChatMessage() stops any in-progress dictation before sending', () => {
    const body = functionBody(SOURCE, 'async function sendChatMessage() {');
    const idx = body.indexOf('if (state.chatDictationActive) stopOperatorDictation();');
    expect(idx).toBeGreaterThan(-1);
  });

  it('closing the Operator popup (X button and backdrop click) stops dictation', () => {
    const closeCount = (SOURCE.match(/if \(state\.chatDictationActive\) stopOperatorDictation\(\);/g) || []).length;
    // sendChatMessage + backdrop close + X close = 3 call sites
    expect(closeCount).toBeGreaterThanOrEqual(3);
  });

  it('.chat-mic-btn CSS exists with a recording/active state', () => {
    expect(CSS).toMatch(/\.chat-mic-btn\s*{/);
    expect(CSS).toMatch(/\.chat-mic-btn--active[,\s]/);
  });

  it('VTID-03911: the active/red state also wins while hovered, not just at rest', () => {
    // .chat-mic-btn:hover:not(:disabled) has specificity (0,3,0) — higher
    // than a bare .chat-mic-btn--active (0,1,0) — so without an explicit
    // :hover variant of the active rule, resting the cursor on the button
    // after clicking it (the normal case with a mouse) silently keeps the
    // neutral hover style and the button never visibly turns red.
    const idx = CSS.indexOf('.chat-mic-btn--active,');
    expect(idx).toBeGreaterThan(-1);
    const block = CSS.slice(idx, idx + 300);
    expect(block).toMatch(/\.chat-mic-btn--active:hover/);
    expect(block).toContain('#ef4444');
  });
});

describe('VTID-03918: dictation no longer gets stuck red with no live recognition', () => {
  it('recognition.start() is wrapped in try/catch, not called bare', () => {
    const start = SOURCE.indexOf('function startOperatorDictation(textarea, micBtn) {');
    const end = SOURCE.indexOf('\nfunction operatorDictationErrorMessage', start);
    const body = SOURCE.slice(start, end);
    expect(body).toMatch(/try\s*\{\s*recognition\.start\(\);\s*\}\s*catch/);
  });

  it('active state/class are only set AFTER a successful start(), not before', () => {
    const start = SOURCE.indexOf('function startOperatorDictation(textarea, micBtn) {');
    const end = SOURCE.indexOf('\nfunction operatorDictationErrorMessage', start);
    const body = SOURCE.slice(start, end);
    const startCallIdx = body.indexOf('recognition.start();');
    const activeStateIdx = body.indexOf('state.chatDictationActive = true;');
    const activeClassIdx = body.indexOf("micBtn.classList.add('chat-mic-btn--active')");
    expect(startCallIdx).toBeGreaterThan(-1);
    expect(activeStateIdx).toBeGreaterThan(startCallIdx);
    expect(activeClassIdx).toBeGreaterThan(startCallIdx);
  });

  it('a thrown start() is caught, cleaned up, and surfaced via showToast', () => {
    const start = SOURCE.indexOf('function startOperatorDictation(textarea, micBtn) {');
    const end = SOURCE.indexOf('\nfunction operatorDictationErrorMessage', start);
    const body = SOURCE.slice(start, end);
    const catchIdx = body.indexOf('} catch (e) {');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = body.slice(catchIdx, catchIdx + 300);
    expect(catchBlock).toContain('showToast(');
    expect(catchBlock).toContain("'error'");
    // Must not leave chatDictationActive/the active class set on a failed start.
    expect(body.slice(0, catchIdx)).not.toContain('state.chatDictationActive = true;');
  });

  it('onerror surfaces a human-readable reason via showToast, not just console.warn', () => {
    const idx = SOURCE.indexOf('recognition.onerror = function (event) {');
    expect(idx).toBeGreaterThan(-1);
    const body = SOURCE.slice(idx, idx + 800);
    expect(body).toContain('console.warn(');
    expect(body).toContain('showToast(operatorDictationErrorMessage(event.error), \'error\')');
  });

  it('operatorDictationErrorMessage() maps the real Web Speech API error codes', () => {
    const body = functionBody(SOURCE, 'function operatorDictationErrorMessage(errorCode) {');
    expect(body).toContain("case 'not-allowed':");
    expect(body).toContain("case 'service-not-allowed':");
    expect(body).toContain("case 'audio-capture':");
    expect(body).toContain("case 'network':");
    expect(body).toContain("case 'no-speech':");
    expect(body).toContain('default:');
  });
});

describe('VTID-03908: Operator popup fullscreen toggle', () => {
  it('renderOperatorOverlay() applies operator-overlay--fullscreen based on state.isOperatorFullscreen', () => {
    expect(SOURCE).toContain(
      "panel.className = 'overlay-panel operator-overlay' + (state.isOperatorFullscreen ? ' operator-overlay--fullscreen' : '');"
    );
  });

  it('a fullscreen toggle button sits beside the close button, both inside overlay-header-actions', () => {
    const idx = SOURCE.indexOf("headerActions.className = 'overlay-header-actions';");
    expect(idx).toBeGreaterThan(-1);
    // VTID-04089 widened this from 1200; VTID-04110 widened it again from
    // 1400 — the fullscreenBtn.onclick body grew by a localStorage.setItem
    // call, pushing headerActions.appendChild(closeBtn) past the old window.
    const nearby = SOURCE.slice(idx, idx + 1600);
    expect(nearby).toContain("fullscreenBtn.className = 'overlay-fullscreen-toggle';");
    expect(nearby).toContain('headerActions.appendChild(fullscreenBtn);');
    expect(nearby).toContain("closeBtn.className = 'overlay-close';");
    expect(nearby).toContain('headerActions.appendChild(closeBtn);');
  });

  it('the fullscreen button toggles state.isOperatorFullscreen and re-renders', () => {
    const idx = SOURCE.indexOf("fullscreenBtn.onclick = () => {");
    expect(idx).toBeGreaterThan(-1);
    // Widened from 200 by VTID-04110, which added a localStorage.setItem
    // persistence call inside this onclick body.
    const nearby = SOURCE.slice(idx, idx + 400);
    expect(nearby).toContain('state.isOperatorFullscreen = !state.isOperatorFullscreen;');
    expect(nearby).toContain('renderApp();');
  });

  it('the close button (X) still only closes the popup — behavior unchanged', () => {
    // Anchor on the Operator overlay's own header-actions block — there are
    // multiple unrelated closeBtn.innerHTML = '&times;' idioms elsewhere
    // (e.g. the task drawer), so scope the search to this popup's header.
    const anchorIdx = SOURCE.indexOf("headerActions.className = 'overlay-header-actions';");
    expect(anchorIdx).toBeGreaterThan(-1);
    // Widened alongside the sibling window above (VTID-04110).
    const nearby = SOURCE.slice(anchorIdx, anchorIdx + 1600);
    expect(nearby).toContain("closeBtn.innerHTML = '&times;';");
    expect(nearby).toContain('closeBtn.onclick = () => {');
    expect(nearby).toContain('state.isOperatorOpen = false;');
    const closeBtnBlockStart = nearby.indexOf('closeBtn.onclick = () => {');
    const closeBtnBlockEnd = nearby.indexOf('headerActions.appendChild(closeBtn);');
    expect(nearby.slice(closeBtnBlockStart, closeBtnBlockEnd)).not.toContain('state.isOperatorFullscreen');
  });

  it('state initializes isOperatorFullscreen from persisted localStorage, defaulting to false (VTID-04110)', () => {
    // VTID-04110: the hardcoded `isOperatorFullscreen: false,` this test
    // originally pinned was replaced with a self-invoking read of
    // localStorage so the choice survives a page reload — still defaulting
    // to false (the old behavior) when nothing is stored or the read
    // throws. Full coverage of the persistence mechanism lives in
    // vtid-04110-operator-console-flicker-fullscreen-persist.test.ts.
    const idx = SOURCE.indexOf('isOperatorFullscreen: (function () {');
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 250);
    expect(nearby).toContain("localStorage.getItem('vitana.operatorFullscreen') === 'true'");
    expect(nearby).toContain('return false;');
  });

  it('.operator-overlay--fullscreen CSS modifier exists', () => {
    expect(CSS).toMatch(/\.operator-overlay--fullscreen\s*{/);
  });
});

describe('VTID-03910: fullscreen symmetric edge spacing + scrollable content', () => {
  // VTID-03910's own deliberate 2cm-inset "bigger popup" design was
  // reversed by VTID-03949 at the platform owner's explicit request
  // ("the full screen is not full screen, it's just a bigger pop-up") —
  // see the VTID-03949 describe block below for the true-fullscreen
  // assertions that replace these two tests.

  it('the flex chain from .overlay-panel down to .chat-container sets min-height:0 so overflow-y:auto can actually engage', () => {
    // A flex column child defaults to min-height:auto, which lets it grow
    // past its own container instead of shrinking to fit — the classic
    // reason a nested flex layout like this one can silently break
    // scrolling regardless of an overflow-y:auto declared further down.
    const panelIdx = CSS.indexOf('.overlay-panel {');
    expect(panelIdx).toBeGreaterThan(-1);
    const panelEnd = CSS.indexOf('\n}', panelIdx);
    expect(CSS.slice(panelIdx, panelEnd)).toContain('min-height: 0;');

    const tabContentIdx = CSS.indexOf('.operator-tab-content {');
    expect(tabContentIdx).toBeGreaterThan(-1);
    const tabContentEnd = CSS.indexOf('\n}', tabContentIdx);
    expect(CSS.slice(tabContentIdx, tabContentEnd)).toContain('min-height: 0;');

    const chatContainerIdx = CSS.indexOf('.chat-container {');
    expect(chatContainerIdx).toBeGreaterThan(-1);
    const chatContainerEnd = CSS.indexOf('\n}', chatContainerIdx);
    expect(CSS.slice(chatContainerIdx, chatContainerEnd)).toContain('min-height: 0;');
  });

  it('.chat-messages drops its fixed 65vh cap in fullscreen mode so it fills the available space instead of leaving a dead gap', () => {
    expect(CSS).toMatch(/\.operator-overlay--fullscreen \.chat-messages\s*{\s*max-height:\s*none;/);
  });
});

describe('VTID-03949: fullscreen is real edge-to-edge fullscreen, not a bigger popup', () => {
  it('the fullscreen panel is literal 100vw/100vh with no border-radius', () => {
    const idx = CSS.indexOf('.operator-overlay--fullscreen {');
    expect(idx).toBeGreaterThan(-1);
    const block = CSS.slice(idx, CSS.indexOf('\n}', idx));
    expect(block).toMatch(/width:\s*100vw;/);
    expect(block).toMatch(/height:\s*100vh;/);
    expect(block).toMatch(/max-width:\s*100vw;/);
    expect(block).toMatch(/max-height:\s*100vh;/);
    expect(block).toMatch(/border-radius:\s*0;/);
    // The old VTID-03910 2cm inset must be gone.
    expect(block).not.toContain('calc(100vw - 4cm)');
    expect(block).not.toContain('calc(100vh - 4cm)');
  });

  it('no separate mobile inset override remains — 100vw/100vh already fits a narrow viewport', () => {
    const idx = CSS.indexOf('@media (max-width: 768px)');
    expect(idx).toBeGreaterThan(-1);
    const block = CSS.slice(idx, CSS.indexOf('\n}\n', idx + '@media (max-width: 768px) {'.length));
    expect(block).not.toContain('calc(100vw - 1.5rem)');
  });
});

describe('CSP compliance — no scripted inline styles introduced by these fixes', () => {
  it('none of the new fullscreen/mic/dictation code paths assign element.style', () => {
    const blocks = [
      SOURCE.slice(SOURCE.indexOf('var ICON_EXPAND_SVG'), SOURCE.indexOf('function renderOperatorOverlay(')),
    ];
    blocks.forEach((block) => {
      expect(block).not.toMatch(/\.style\s*[.=]/);
    });
  });
});
