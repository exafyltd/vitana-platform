/**
 * VTID-03966 — Command Hub Operator Console: rename input closes itself
 * instantly when renaming the ACTIVE thread (both via double-click and via
 * the kebab-menu "Rename" item) — a second, distinct defect from
 * VTID-03953, still uncaught by that fix.
 *
 * Reported live: "your 4th attempt to make rename work does still not
 * work... rename dont work. not in kebab dropdown and also not when
 * doubleclicking the title both dont work." Reproduced with a local
 * Playwright harness driving the real, unmodified app.js against a static
 * file server (no gateway/auth needed — the rename mechanism is 100%
 * client-side DOM/state logic) — screenshots and console traces confirmed
 * the actual root cause below before any fix was written.
 *
 * Root cause: renaming the ACTIVE thread renders
 * `renderEditableThreadTitle()` TWICE in the same pass — the sidebar row
 * AND the title bar above the transcript both show it (this is by design,
 * per VTID-03949's own doc comment: "Shared by the sidebar row and the
 * title bar so both places behave identically"). Both instances used to
 * independently schedule their own `setTimeout(() => input.focus(), 0)`.
 * Whichever fires second steals focus from the first — a genuine DOM blur,
 * not the involuntary removal-blur VTID-03953 already guards — so the
 * first input's `onblur` (unconditionally, since `_renameBlurSuppressed`
 * is only ever true around `root.innerHTML = ''`, not around this) fires
 * `commitRenamingOperatorThread()` and closes the rename within the same
 * frame the input opened.
 *
 * Measured live with the harness: renaming a genuinely non-active thread
 * (single rendered instance) worked correctly; renaming the active thread
 * (dual instance) closed itself every single time, regardless of entry
 * point (double-click or kebab menu — both ultimately call the same
 * startRenamingOperatorThread()).
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard rather than an import-based
 * unit test — same pattern as the sibling vtid-0392x/vtid-03949/
 * vtid-03953/vtid-03960 test files.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/app.js'),
  'utf8'
);

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

describe('VTID-03966: _renameAutoFocusClaimedForThreadId module state', () => {
  it('is declared alongside the other rename-focus module state', () => {
    expect(SOURCE).toMatch(/var _renameAutoFocusClaimedForThreadId = null;/);
  });

  it('_renderAppCore() resets it to null exactly once per render pass, alongside _renamePreserveFocusPending', () => {
    const body = functionBody(SOURCE, 'function _renderAppCore() {');
    const idx = body.indexOf('_renamePreserveFocusPending = !!savedRenameFocus;');
    expect(idx).toBeGreaterThan(-1);
    const nearby = body.slice(idx, idx + 300);
    expect(nearby).toContain('_renameAutoFocusClaimedForThreadId = null;');
  });
});

describe('VTID-03966: only the first rendered instance for a thread claims auto-focus', () => {
  it('renderEditableThreadTitle() gates the deferred focus() on BOTH _renamePreserveFocusPending and the claim tracker', () => {
    const body = functionBody(SOURCE, 'function renderEditableThreadTitle(thread, className) {');
    const guardIdx = body.indexOf('if (!_renamePreserveFocusPending && _renameAutoFocusClaimedForThreadId !== thread.id) {');
    expect(guardIdx).toBeGreaterThan(-1);
    const guardBlock = body.slice(guardIdx, body.indexOf('}', body.indexOf('input.select();', guardIdx)) + 1);
    expect(guardBlock).toContain('_renameAutoFocusClaimedForThreadId = thread.id;');
    expect(guardBlock).toContain('input.focus(); input.select();');
  });

  it('claims the thread id BEFORE scheduling the setTimeout, so a second instance rendered later in the same synchronous pass sees the claim', () => {
    const body = functionBody(SOURCE, 'function renderEditableThreadTitle(thread, className) {');
    const claimIdx = body.indexOf('_renameAutoFocusClaimedForThreadId = thread.id;');
    const setTimeoutIdx = body.indexOf('setTimeout(() => { input.focus(); input.select(); }, 0);');
    expect(claimIdx).toBeGreaterThan(-1);
    expect(setTimeoutIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(setTimeoutIdx);
  });

  it('does not touch the existing blur-suppression or preserve-focus-restore logic from VTID-03953', () => {
    // Regression guard: this fix must be additive, not a rewrite of the
    // VTID-03953 mechanism it sits alongside.
    const body = functionBody(SOURCE, 'function renderEditableThreadTitle(thread, className) {');
    expect(body).toContain('if (_renameBlurSuppressed) return;');
    expect(body).toContain('commitRenamingOperatorThread();');
  });
});

describe('VTID-03966: renderOperatorThreadRow() and the title bar both route through the same guarded renderEditableThreadTitle()', () => {
  it('the sidebar row and title bar both call renderEditableThreadTitle with the SAME shared function, not separate copies', () => {
    // If a thread is both the active thread and visible in the sidebar,
    // renderOperatorThreadRow() (sidebar) and the title-bar block both
    // call this exact function for the same thread.id — which is what
    // makes the dual-instance race possible, and is a deliberate, existing
    // design (VTID-03949), not something this fix changes.
    const rowBody = functionBody(SOURCE, 'function renderOperatorThreadRow(thread) {');
    expect(rowBody).toContain("renderEditableThreadTitle(thread, 'chat-session-row-title')");

    const chatIdx = SOURCE.indexOf('function renderOperatorChat() {');
    expect(chatIdx).toBeGreaterThan(-1);
    const chatBody = SOURCE.slice(chatIdx, chatIdx + 2500);
    expect(chatBody).toContain("renderEditableThreadTitle(activeThread, 'chat-session-title-bar-text')");
  });
});
