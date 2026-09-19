/**
 * VTID-03947 — Command Hub Operator Console: per-message copy-to-clipboard
 * icon + a Claude-Code-style relative timestamp under each chat bubble.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard rather than an import-based
 * unit test — same pattern as vtid-03917-overview-poll-no-full-rerender.test.ts
 * and vtid-03925-pipeline-summary-loop-fix.test.ts.
 *
 * Requested directly: "add in the command hub operator under each session
 * the copy paste icon for easy copy of the response block and add the
 * timestamp like claude code does" — a copy button next to a relative
 * timestamp ("3h ago") under every message bubble, sent and reply alike.
 *
 * Relative-time formatting deliberately reuses the existing
 * formatRelativeTime() helper (already used for version-history/event-feed
 * timestamps elsewhere in this file) instead of adding a third
 * near-duplicate of it — this file already carries two same-named
 * formatRelativeTime() declarations from an earlier, incompletely-fixed
 * duplication (see the 'fix-duplicate-formatRelativeTime' VTID marker in
 * scripts/ci/command-hub-ownership-guard.js), so a new helper would have
 * made that worse, not better.
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
  const end = source.indexOf('\nfunction ', start + signature.length);
  return end > -1 ? source.slice(start, end) : source.slice(start, start + 6000);
}

describe('VTID-03947: copy icon + relative timestamp constants exist', () => {
  it('declares ICON_COPY_SVG and ICON_CHECK_SVG as 14x14 stroke icons, matching ICON_MIC_SVG\'s style', () => {
    expect(SOURCE).toContain('var ICON_COPY_SVG =');
    expect(SOURCE).toContain('var ICON_CHECK_SVG =');
    expect(SOURCE).toContain('<rect x="9" y="9" width="13" height="13" rx="2" ry="2">');
    expect(SOURCE).toContain('<polyline points="20 6 9 17 4 12">');
  });
});

describe('VTID-03947: renderOperatorChat() message-meta row', () => {
  const body = functionBody(SOURCE, 'function renderOperatorChat() {');

  it('renders a message-meta row per message instead of the old bare timestamp div', () => {
    expect(body).toContain("meta.className = 'message-meta' + (isSent ? ' message-meta--sent' : '');");
    expect(body).toContain("messages.appendChild(meta);");
  });

  it('aligns the meta row via a CSS class, not an inline style write (avoids the CSP-surface guard)', () => {
    expect(body).not.toMatch(/meta\.style\./);
  });

  it('the copy button copies msg.content via navigator.clipboard.writeText', () => {
    expect(body).toContain("copyBtn.className = 'message-copy-btn';");
    expect(body).toContain('navigator.clipboard.writeText(textToCopy)');
    expect(body).toContain('var textToCopy = msg.content || msg.text || \'\';');
  });

  it('the copy button swaps to the check icon and back, so the click gives visible confirmation', () => {
    expect(body).toContain('copyBtn.innerHTML = ICON_CHECK_SVG;');
    expect(body).toContain("copyBtn.classList.add('message-copy-btn--copied');");
    expect(body).toContain('copyBtn.innerHTML = ICON_COPY_SVG;');
    expect(body).toContain("copyBtn.classList.remove('message-copy-btn--copied');");
  });

  it('a missing/failing clipboard API is a silent no-op, not a thrown error', () => {
    expect(body).toMatch(/catch \(e\) \{ \/\* clipboard API unavailable — no-op \*\/ \}/);
    expect(body).toContain('.catch(function () { /* ignore */ });');
  });

  it('the timestamp span shows a relative time via the existing formatRelativeTime() helper, with the absolute time as a hover title', () => {
    expect(body).toContain("time.className = 'timestamp';");
    expect(body).toContain('time.textContent = formatRelativeTime(msg.ts) || msg.timestamp || \'\';');
    expect(body).toContain("time.title = msg.timestamp || '';");
  });

  it('does not introduce a second formatRelativeTime-shaped helper (reuses the existing one)', () => {
    expect(body).not.toContain('function formatRelativeTimestamp');
  });
});

describe('VTID-03947: every state.chatMessages push carries a raw ts epoch for relative-time display', () => {
  it('every state.chatMessages.push({...}) block within sendChatMessage() carries a ts: field', () => {
    const idx = SOURCE.indexOf('async function sendChatMessage() {');
    expect(idx).toBeGreaterThan(-1);
    // VTID-04028: slice to the end of the function, not a fixed 8500 chars —
    // the streamed-turn path made sendChatMessage() longer and a fixed window
    // cut through a push block, reporting a ts: field that is there as missing.
    const rest = SOURCE.slice(idx + 1);
    const nextDef = rest.search(/\n(?:async )?function /);
    const body = nextDef === -1 ? SOURCE.slice(idx) : SOURCE.slice(idx, idx + 1 + nextDef);
    // Split on each push call and check the object literal that follows it
    // (up to the matching close) contains a ts: field — avoids miscounting
    // the unrelated userHistoryEntry/assistantHistoryEntry.ts assignments
    // that legitimately also appear in this function.
    const pushBlocks = body.split('state.chatMessages.push({').slice(1);
    expect(pushBlocks.length).toBeGreaterThan(0);
    pushBlocks.forEach((block) => {
      const objLiteral = block.slice(0, block.indexOf('});'));
      expect(objLiteral).toMatch(/ts: now\.getTime\(\)|ts: Date\.now\(\)/);
    });
  });

  it('switchOperatorThread() and initOperatorChatSession() restore ts from the saved thread history', () => {
    // VTID-04104: was a fixed-byte-offset slice (900 / 1500 chars) — the
    // exact VTID-04028 failure mode this file's own comment above already
    // names, reproduced here when VTID-04104 added a doc comment + a
    // closeAllOperatorExecutionFollows()/reattachFollowedExecutions() call
    // ahead of the `ts: msg.ts` line and pushed it past the fixed window.
    // Scoped to the actual function body instead, like functionBody() above.
    const switchBody = functionBody(SOURCE, 'function switchOperatorThread(threadId) {');
    expect(switchBody).toContain('ts: msg.ts');

    const initBody = functionBody(SOURCE, 'function initOperatorChatSession() {');
    expect(initBody).toContain('ts: msg.ts');
  });
});
