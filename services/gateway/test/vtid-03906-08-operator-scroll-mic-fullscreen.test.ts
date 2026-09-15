/**
 * VTID-03906 / VTID-03907 / VTID-03908 — Command Hub Operator popup fixes.
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
    const nearby = SOURCE.slice(idx, idx + 900);
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
    expect(CSS).toMatch(/\.chat-mic-btn--active\s*{/);
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
    const nearby = SOURCE.slice(idx, idx + 1200);
    expect(nearby).toContain("fullscreenBtn.className = 'overlay-fullscreen-toggle';");
    expect(nearby).toContain('headerActions.appendChild(fullscreenBtn);');
    expect(nearby).toContain("closeBtn.className = 'overlay-close';");
    expect(nearby).toContain('headerActions.appendChild(closeBtn);');
  });

  it('the fullscreen button toggles state.isOperatorFullscreen and re-renders', () => {
    const idx = SOURCE.indexOf("fullscreenBtn.onclick = () => {");
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 200);
    expect(nearby).toContain('state.isOperatorFullscreen = !state.isOperatorFullscreen;');
    expect(nearby).toContain('renderApp();');
  });

  it('the close button (X) still only closes the popup — behavior unchanged', () => {
    // Anchor on the Operator overlay's own header-actions block — there are
    // multiple unrelated closeBtn.innerHTML = '&times;' idioms elsewhere
    // (e.g. the task drawer), so scope the search to this popup's header.
    const anchorIdx = SOURCE.indexOf("headerActions.className = 'overlay-header-actions';");
    expect(anchorIdx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(anchorIdx, anchorIdx + 1200);
    expect(nearby).toContain("closeBtn.innerHTML = '&times;';");
    expect(nearby).toContain('closeBtn.onclick = () => {');
    expect(nearby).toContain('state.isOperatorOpen = false;');
    const closeBtnBlockStart = nearby.indexOf('closeBtn.onclick = () => {');
    const closeBtnBlockEnd = nearby.indexOf('headerActions.appendChild(closeBtn);');
    expect(nearby.slice(closeBtnBlockStart, closeBtnBlockEnd)).not.toContain('state.isOperatorFullscreen');
  });

  it('state initializes isOperatorFullscreen to false', () => {
    expect(SOURCE).toMatch(/isOperatorFullscreen:\s*false,/);
  });

  it('.operator-overlay--fullscreen CSS modifier exists', () => {
    expect(CSS).toMatch(/\.operator-overlay--fullscreen\s*{/);
    expect(CSS).toContain('width: 100vw;');
    expect(CSS).toContain('height: 100vh;');
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
