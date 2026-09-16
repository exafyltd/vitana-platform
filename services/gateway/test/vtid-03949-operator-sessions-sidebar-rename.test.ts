/**
 * VTID-03949 — Command Hub Operator Console: three requested fixes to the
 * chat cockpit UI, reported directly against a real screenshot:
 *
 *  1. The fullscreen toggle produced "just a bigger pop-up", not real
 *     fullscreen (VTID-03910's own deliberate 2cm-inset design, reversed
 *     here — see test/vtid-03906-08-operator-scroll-mic-fullscreen.test.ts
 *     for the CSS-side assertions).
 *  2. The thread <select> dropdown was "very bad UX" — it covered the
 *     transcript while open and only showed one session at a time.
 *     Replaced with a persistent, Claude-Code-style sessions sidebar
 *     listing every past conversation at once.
 *  3. No way to rename a session's title (Claude Code: double-click to
 *     edit, in both the main view and the sidebar). Added
 *     renderEditableThreadTitle(), shared by the sidebar row and the new
 *     title bar above the transcript.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard rather than an import-based
 * unit test — same pattern as the sibling vtid-0392x test files.
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

describe('VTID-03949: sessions sidebar replaces the thread dropdown', () => {
  it('renderOperatorOverlay() wraps the Chat tab in a sidebar + chat layout instead of rendering renderOperatorChat() bare', () => {
    const idx = SOURCE.indexOf("if (state.operatorActiveTab === 'chat') {");
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 400);
    expect(nearby).toContain("chatLayout.className = 'operator-chat-layout';");
    expect(nearby).toContain('chatLayout.appendChild(renderOperatorSessionsSidebar());');
    expect(nearby).toContain('chatLayout.appendChild(renderOperatorChat());');
  });

  it('renderOperatorSessionsSidebar() lists every thread, most-recently-updated first, and switches on click', () => {
    const body = functionBody(SOURCE, 'function renderOperatorSessionsSidebar() {');
    expect(body).toContain("sidebar.className = 'chat-sessions-sidebar'");
    expect(body).toContain('(b.updatedAt || 0) - (a.updatedAt || 0)');
    expect(body).toContain("row.className = 'chat-session-row'");
    expect(body).toContain('row.onclick = () => switchOperatorThread(thread.id);');
    expect(body).toContain("row.className = 'chat-session-row' + (thread.id === state.operatorActiveThreadId ? ' chat-session-row--active' : '');");
  });

  it('an empty thread list renders a plain empty state instead of a blank sidebar', () => {
    const body = functionBody(SOURCE, 'function renderOperatorSessionsSidebar() {');
    expect(body).toContain('if (sortedThreads.length === 0) {');
    expect(body).toContain("empty.className = 'chat-sessions-empty';");
  });

  it('the sidebar has its own "+ New chat" button wired to startNewOperatorThread', () => {
    const body = functionBody(SOURCE, 'function renderOperatorSessionsSidebar() {');
    expect(body).toContain("newBtn.className = 'chat-sessions-new-btn';");
    expect(body).toContain('newBtn.onclick = () => startNewOperatorThread();');
  });

  it('the sidebar can be collapsed via state.operatorSessionsSidebarCollapsed, toggled from the chat title bar', () => {
    expect(SOURCE).toMatch(/operatorSessionsSidebarCollapsed:\s*false,/);
    const body = functionBody(SOURCE, 'function renderOperatorSessionsSidebar() {');
    expect(body).toContain("state.operatorSessionsSidebarCollapsed ? ' chat-sessions-sidebar--collapsed' : ''");

    const titleBarIdx = SOURCE.indexOf("sidebarToggleBtn.className = 'chat-sessions-toggle-btn';");
    expect(titleBarIdx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(titleBarIdx, titleBarIdx + 500);
    expect(nearby).toContain('state.operatorSessionsSidebarCollapsed = !state.operatorSessionsSidebarCollapsed;');
    expect(nearby).toContain('renderApp();');
  });

  it('CSS defines the sidebar layout, including the collapsed modifier and the active-row highlight', () => {
    expect(CSS).toContain('.operator-chat-layout {');
    expect(CSS).toContain('.chat-sessions-sidebar {');
    expect(CSS).toContain('.chat-sessions-sidebar--collapsed {');
    expect(CSS).toContain('.chat-session-row--active {');
  });
});

describe('VTID-03949: double-click-to-rename, shared by the sidebar and the title bar', () => {
  it('renderEditableThreadTitle() shows a plain span with a dblclick handler when not renaming', () => {
    const body = functionBody(SOURCE, 'function renderEditableThreadTitle(thread, className) {');
    expect(body).toContain("span.title = 'Double-click to rename';");
    expect(body).toContain('span.ondblclick = (e) => {');
    expect(body).toContain('startRenamingOperatorThread(thread.id,');
  });

  it('renderEditableThreadTitle() swaps to a text input while state.operatorRenamingThreadId matches the thread', () => {
    const body = functionBody(SOURCE, 'function renderEditableThreadTitle(thread, className) {');
    expect(body).toContain('if (state.operatorRenamingThreadId === thread.id) {');
    expect(body).toContain("input.className = className + ' chat-session-title-input';");
    expect(body).toContain('input.value = state.operatorRenameDraftValue;');
  });

  it('the rename input commits on Enter, cancels on Escape, and commits on blur', () => {
    const body = functionBody(SOURCE, 'function renderEditableThreadTitle(thread, className) {');
    expect(body).toContain("if (e.key === 'Enter') {");
    expect(body).toContain('commitRenamingOperatorThread();');
    expect(body).toContain("if (e.key === 'Escape') {");
    expect(body).toContain('cancelRenamingOperatorThread();');
    expect(body).toContain('input.onblur = () => commitRenamingOperatorThread();');
  });

  it('a click inside the rename input does not bubble up to a sidebar row and switch threads mid-edit', () => {
    const body = functionBody(SOURCE, 'function renderEditableThreadTitle(thread, className) {');
    expect(body).toContain('input.onclick = (e) => e.stopPropagation();');
  });

  it("the input's own oninput syncs state without calling renderApp() itself, so an unrelated background re-render can't wipe focus mid-keystroke", () => {
    const body = functionBody(SOURCE, 'function renderEditableThreadTitle(thread, className) {');
    const oninputIdx = body.indexOf('input.oninput = (e) => {');
    expect(oninputIdx).toBeGreaterThan(-1);
    const oninputBlock = body.slice(oninputIdx, body.indexOf('};', oninputIdx));
    expect(oninputBlock).toContain('state.operatorRenameDraftValue = e.target.value;');
    expect(oninputBlock).not.toContain('renderApp()');
  });

  it('commitRenamingOperatorThread() discards a blank/whitespace-only draft instead of saving an empty title', () => {
    const body = functionBody(SOURCE, 'function commitRenamingOperatorThread() {');
    expect(body).toContain("var newTitle = (state.operatorRenameDraftValue || '').trim();");
    expect(body).toContain('if (thread && newTitle) {');
    expect(body).toContain('saveOperatorThreadsIndex(state.operatorThreads);');
  });

  it('commitRenamingOperatorThread() is a safe no-op if called twice (Enter then a trailing blur)', () => {
    const body = functionBody(SOURCE, 'function commitRenamingOperatorThread() {');
    expect(body).toContain('if (state.operatorRenamingThreadId === null) return;');
  });

  it('is used both in the sessions sidebar and in the chat title bar above the transcript', () => {
    const sidebarBody = functionBody(SOURCE, 'function renderOperatorSessionsSidebar() {');
    expect(sidebarBody).toContain("renderEditableThreadTitle(thread, 'chat-session-row-title')");

    const chatIdx = SOURCE.indexOf('function renderOperatorChat() {');
    expect(chatIdx).toBeGreaterThan(-1);
    const chatBody = SOURCE.slice(chatIdx, chatIdx + 2500);
    expect(chatBody).toContain("renderEditableThreadTitle(activeThread, 'chat-session-title-bar-text')");
  });

  it('CSS defines the shared rename input style', () => {
    expect(CSS).toContain('.chat-session-title-input {');
  });
});
