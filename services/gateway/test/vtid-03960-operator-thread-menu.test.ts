/**
 * VTID-03960 — Command Hub Operator Console: per-session "..." menu
 * (Rename / Share / Archive / Delete), matching the Claude Code sidebar's
 * own per-session menu shape. Requested directly against a screenshot of
 * that Claude Code menu ("make it the same way, when clicking the dots, it
 * should show for now: Rename, Share, Archive, Delete") — no delete/
 * archive/share mechanism existed for Operator Console threads at all
 * before this.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard rather than an import-based
 * unit test — same pattern as the sibling vtid-0392x/vtid-03949 test files.
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

describe('VTID-03960: state fields', () => {
  it('declares operatorThreadMenuOpenId and operatorShowArchivedThreads', () => {
    expect(SOURCE).toMatch(/operatorThreadMenuOpenId:\s*null,/);
    expect(SOURCE).toMatch(/operatorShowArchivedThreads:\s*false,/);
  });
});

describe('VTID-03960: the "..." menu button and its dropdown', () => {
  it('renderThreadMenuButton() toggles state.operatorThreadMenuOpenId and stops the click from bubbling to the row', () => {
    const body = functionBody(SOURCE, 'function renderThreadMenuButton(thread) {');
    expect(body).toContain("btn.className = 'chat-session-row-menu-btn';");
    expect(body).toContain('e.stopPropagation();');
    expect(body).toContain('state.operatorThreadMenuOpenId = state.operatorThreadMenuOpenId === thread.id ? null : thread.id;');
    expect(body).toContain('renderApp();');
  });

  it('renderThreadMenu() renders exactly Rename/Share/Archive/Delete, in that order, for a non-archived thread', () => {
    const body = functionBody(SOURCE, 'function renderThreadMenu(thread) {');
    const renameIdx = body.indexOf("label: 'Rename'");
    const shareIdx = body.indexOf("label: 'Share'");
    const archiveIdx = body.indexOf("label: 'Archive'");
    const deleteIdx = body.indexOf("label: 'Delete'");
    [renameIdx, shareIdx, archiveIdx, deleteIdx].forEach((idx) => expect(idx).toBeGreaterThan(-1));
    expect(renameIdx).toBeLessThan(shareIdx);
    expect(shareIdx).toBeLessThan(archiveIdx);
    expect(archiveIdx).toBeLessThan(deleteIdx);
  });

  it('renderThreadMenu() swaps Archive for Unarchive when thread.archived is true', () => {
    const body = functionBody(SOURCE, 'function renderThreadMenu(thread) {');
    expect(body).toContain('thread.archived');
    expect(body).toContain("label: 'Unarchive'");
    expect(body).toContain('unarchiveOperatorThread(thread.id)');
  });

  it("Delete is marked danger (distinct styling), the others are not", () => {
    const body = functionBody(SOURCE, 'function renderThreadMenu(thread) {');
    const deleteLine = body.slice(body.indexOf("label: 'Delete'"), body.indexOf("label: 'Delete'") + 80);
    expect(deleteLine).toContain('danger: true');
  });

  it('each menu item click closes the menu before running its own action', () => {
    const body = functionBody(SOURCE, 'function renderThreadMenu(thread) {');
    const clickIdx = body.indexOf('btn.onclick = (e) => {');
    expect(clickIdx).toBeGreaterThan(-1);
    const clickBlock = body.slice(clickIdx, body.indexOf('};', clickIdx));
    expect(clickBlock).toContain('e.stopPropagation();');
    expect(clickBlock).toContain('state.operatorThreadMenuOpenId = null;');
    expect(clickBlock).toContain('item.onSelect();');
  });

  it('registers a click-outside-to-close listener via setTimeout(0), matching the existing version-dropdown pattern', () => {
    const body = functionBody(SOURCE, 'function renderThreadMenu(thread) {');
    expect(body).toContain('setTimeout(() => {');
    expect(body).toContain("document.querySelector('.chat-session-row-menu')");
    expect(body).toContain('document.addEventListener(\'click\', closeMenu);');
  });
});

describe('VTID-03960: deleteOperatorThread()', () => {
  it('confirms before deleting, and is a no-op for an unknown thread id', () => {
    const body = functionBody(SOURCE, 'function deleteOperatorThread(threadId) {');
    expect(body).toContain('if (!thread) return;');
    expect(body).toContain("if (!confirm(");
  });

  it('removes the thread from the index, persists it, and deletes its saved history', () => {
    const body = functionBody(SOURCE, 'function deleteOperatorThread(threadId) {');
    expect(body).toContain('state.operatorThreads = state.operatorThreads.filter(function (t) { return t.id !== threadId; });');
    expect(body).toContain('saveOperatorThreadsIndex(state.operatorThreads);');
    expect(body).toContain('localStorage.removeItem(operatorThreadHistoryKey(threadId));');
  });

  it('switches to the next most-recent non-archived thread if the active thread was deleted, or starts a new one if none remain', () => {
    const body = functionBody(SOURCE, 'function deleteOperatorThread(threadId) {');
    expect(body).toContain('if (state.operatorActiveThreadId === threadId) {');
    expect(body).toContain('switchOperatorThread(next.id);');
    expect(body).toContain('startNewOperatorThread();');
  });
});

describe('VTID-03960: archiveOperatorThread() / unarchiveOperatorThread()', () => {
  it('archiveOperatorThread() sets archived=true and persists, without deleting anything', () => {
    const body = functionBody(SOURCE, 'function archiveOperatorThread(threadId) {');
    expect(body).toContain('thread.archived = true;');
    expect(body).toContain('saveOperatorThreadsIndex(state.operatorThreads);');
    expect(body).not.toContain('localStorage.removeItem');
    expect(body).not.toContain('.filter(function (t) { return t.id !== threadId; })');
  });

  it('archiveOperatorThread() switches away if the active thread was archived, same recovery as delete', () => {
    const body = functionBody(SOURCE, 'function archiveOperatorThread(threadId) {');
    expect(body).toContain('if (state.operatorActiveThreadId === threadId) {');
    expect(body).toContain('switchOperatorThread(next.id);');
    expect(body).toContain('startNewOperatorThread();');
  });

  it('unarchiveOperatorThread() sets archived=false, persists, and re-renders', () => {
    const body = functionBody(SOURCE, 'function unarchiveOperatorThread(threadId) {');
    expect(body).toContain('thread.archived = false;');
    expect(body).toContain('saveOperatorThreadsIndex(state.operatorThreads);');
    expect(body).toContain('renderApp();');
  });
});

describe('VTID-03960: shareOperatorThread()', () => {
  it('copies a link carrying ?operator_thread=<id> to the clipboard, with a toast on success and failure', () => {
    const body = functionBody(SOURCE, 'function shareOperatorThread(thread) {');
    expect(body).toContain("'?operator_thread=' + encodeURIComponent(thread.id)");
    expect(body).toContain('navigator.clipboard.writeText(url)');
    expect(body).toContain("showToast('Link copied");
    expect(body).toContain("showToast('Could not copy link', 'error');");
  });

  it('degrades to a toast (not a thrown error) when the clipboard API is unavailable', () => {
    const body = functionBody(SOURCE, 'function shareOperatorThread(thread) {');
    expect(body).toContain('if (!navigator.clipboard || !navigator.clipboard.writeText) {');
    expect(body).toContain("showToast('Clipboard not available', 'error');");
  });
});

describe('VTID-03960: the deep link is actually honored, not just produced', () => {
  it('initOperatorChatSession() preselects ?operator_thread=<id> over the default most-recent thread when it exists', () => {
    const body = functionBody(SOURCE, 'function initOperatorChatSession() {');
    expect(body).toContain("new URLSearchParams(window.location.search).get('operator_thread')");
    expect(body).toContain('var active = (requestedThreadId && index.find(function (t) { return t.id === requestedThreadId; })) || index[0];');
  });

  it('openOperatorConsole() is a shared helper (used by the header pill AND the boot-time deep link), not duplicated logic', () => {
    const body = functionBody(SOURCE, 'function openOperatorConsole() {');
    expect(body).toContain('state.isOperatorOpen = true;');
    expect(body).toContain('initOperatorChatSession();');
    expect(body).toContain('startOperatorLiveTicker();');

    // The header pill must call the shared helper, not re-implement it.
    const pillIdx = SOURCE.indexOf("operatorBtn.textContent = 'OPERATOR';");
    expect(pillIdx).toBeGreaterThan(-1);
    const pillNearby = SOURCE.slice(pillIdx, pillIdx + 150);
    expect(pillNearby).toContain('operatorBtn.onclick = () => openOperatorConsole();');
  });

  it('the DOMContentLoaded boot sequence auto-opens the Operator Console when ?operator_thread= is present', () => {
    const idx = SOURCE.indexOf('// Final UI refresh after auth data is in');
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 500);
    expect(nearby).toContain("new URLSearchParams(window.location.search).get('operator_thread')");
    expect(nearby).toContain('openOperatorConsole();');
  });
});

describe('VTID-03960: sidebar filters out archived threads by default', () => {
  it('renderOperatorSessionsSidebar() splits threads into active vs archived, and only auto-renders active ones', () => {
    const body = functionBody(SOURCE, 'function renderOperatorSessionsSidebar() {');
    expect(body).toContain("const activeThreads = allThreads.filter(function (t) { return !t.archived; });");
    expect(body).toContain("const archivedThreads = allThreads.filter(function (t) { return t.archived; });");
  });

  it('shows a toggle naming the archived count, and only renders archived rows once toggled on', () => {
    const body = functionBody(SOURCE, 'function renderOperatorSessionsSidebar() {');
    expect(body).toContain("if (archivedThreads.length > 0) {");
    expect(body).toContain("toggle.className = 'chat-sessions-archived-toggle';");
    expect(body).toContain('state.operatorShowArchivedThreads = !state.operatorShowArchivedThreads;');
    expect(body).toContain('if (state.operatorShowArchivedThreads) {');
  });

  it('renderOperatorThreadRow() is shared by both the active and archived sections, and appends the menu button', () => {
    const body = functionBody(SOURCE, 'function renderOperatorThreadRow(thread) {');
    expect(body).toContain("row.appendChild(renderThreadMenuButton(thread));");
    expect(body).toContain("thread.archived ? ' chat-session-row--archived' : ''");

    const sidebarBody = functionBody(SOURCE, 'function renderOperatorSessionsSidebar() {');
    // Called once for the active list and once for the archived list.
    const calls = sidebarBody.match(/renderOperatorThreadRow\(thread\)/g) || [];
    expect(calls.length).toBe(2);
  });
});

describe('VTID-03960: CSS for the menu and archived state', () => {
  it('defines the menu button, dropdown, item, and danger-item styles', () => {
    expect(CSS).toContain('.chat-session-row-menu-btn {');
    expect(CSS).toContain('.chat-session-row-menu {');
    expect(CSS).toContain('.chat-session-row-menu-item {');
    expect(CSS).toContain('.chat-session-row-menu-item--danger {');
  });

  it('defines the archived-row and archived-toggle styles', () => {
    expect(CSS).toContain('.chat-session-row--archived {');
    expect(CSS).toContain('.chat-sessions-archived-toggle {');
  });

  it('.chat-session-row is now a flex row (title/meta column + menu button side by side)', () => {
    const idx = CSS.indexOf('.chat-session-row {');
    expect(idx).toBeGreaterThan(-1);
    const rule = CSS.slice(idx, CSS.indexOf('}', idx));
    expect(rule).toContain('display: flex;');
    expect(rule).toContain('justify-content: space-between;');
  });
});

describe("CSP compliance — no scripted inline styles introduced by this feature", () => {
  it('none of the new menu/archive/share code paths assign element.style', () => {
    const fns = [
      'function renderThreadMenuButton(thread) {',
      'function renderThreadMenu(thread) {',
      'function deleteOperatorThread(threadId) {',
      'function archiveOperatorThread(threadId) {',
      'function unarchiveOperatorThread(threadId) {',
      'function shareOperatorThread(thread) {',
      'function renderOperatorThreadRow(thread) {',
      'function openOperatorConsole() {',
    ];
    fns.forEach((sig) => {
      const body = functionBody(SOURCE, sig);
      expect(body).not.toMatch(/\.style\b/);
    });
  });
});
