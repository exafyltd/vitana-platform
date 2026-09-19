/**
 * VTID-04106: the Operator Console chat did not scroll to a newly-sent
 * exchange when the user was scrolled up reading older history — reported
 * live with screenshots: "I have entered a fresh message into the chat
 * inbox... but the cursor, instead of jumping to the latest input I just
 * entered, the cursor stay with the oldest message."
 *
 * Root cause: the VTID-0539 scroll-anchor logic in _renderAppCore() decides
 * whether to scroll-to-bottom purely from whether the user was within 80px
 * of the bottom at the START of a render (wasNearBottom) — it has no way to
 * tell a render triggered by the user's OWN send() apart from a passive
 * background update (an SSE follow-step event, a ticker poll). The existing
 * VTID-0526-D explicit force-scroll rAF calls could be overridden by an
 * unrelated background render's own anchor-restore rAF firing around the
 * same time.
 *
 * Fix: a new, authoritative state.chatStickToBottom flag — set true on every
 * send() regardless of prior scroll position, ORed into the anchor decision,
 * and kept in sync with the user's own manual scrolling via a scroll
 * listener on .chat-messages (same 80px threshold as wasNearBottom).
 *
 * app.js is a plain script (no export surface) — pinned by source text, the
 * same convention vtid-04033's/vtid-04104's own suites use.
 */

import * as fs from 'fs';
import * as path from 'path';

const FE = path.resolve(__dirname, '../src/frontend/command-hub');
const APP_JS = fs.readFileSync(path.join(FE, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
const GUARD_JS = fs.readFileSync(path.resolve(__dirname, '../../../scripts/ci/command-hub-ownership-guard.js'), 'utf8');

function fnBody(name: string): string {
  const start = APP_JS.indexOf(`\nfunction ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = APP_JS.indexOf('\nfunction ', start + 1);
  return APP_JS.slice(start, next === -1 ? undefined : next);
}

function asyncFnBody(name: string): string {
  const start = APP_JS.indexOf(`\nasync function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = APP_JS.slice(start + 1);
  const next = rest.search(/\n(?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('VTID-04106: chat always jumps to a newly-sent message, even when scrolled up in history', () => {
  it('declares state.chatStickToBottom, defaulting true', () => {
    expect(APP_JS).toMatch(/chatStickToBottom:\s*true,/);
  });

  it('sendChatMessage() re-arms chatStickToBottom on every send, before any message push', () => {
    const send = asyncFnBody('sendChatMessage');
    const rearmIdx = send.indexOf('state.chatStickToBottom = true;');
    const pushIdx = send.indexOf('state.chatMessages.push({');
    expect(rearmIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(rearmIdx).toBeLessThan(pushIdx);
  });

  it('the VTID-0539 anchor logic in _renderAppCore() scrolls to bottom when EITHER wasNearBottom OR chatStickToBottom is true', () => {
    expect(APP_JS).toContain('if (savedChatScroll.wasNearBottom || state.chatStickToBottom) {');
  });

  it('the .chat-messages scroll listener keeps chatStickToBottom in sync with the user\'s own manual scrolling, using the same 80px threshold as wasNearBottom', () => {
    const render = fnBody('renderOperatorChat');
    const listenerIdx = render.indexOf("messages.addEventListener('scroll', function () {");
    expect(listenerIdx).toBeGreaterThan(-1);
    const listenerBlock = render.slice(listenerIdx, render.indexOf('});', listenerIdx) + 3);
    expect(listenerBlock).toContain('messages.scrollHeight - messages.scrollTop - messages.clientHeight');
    expect(listenerBlock).toContain('state.chatStickToBottom = distanceFromBottom <= 80;');
  });

  it('the scroll listener is attached to the messages container before any message rendering, so it is live for every render', () => {
    const render = fnBody('renderOperatorChat');
    const classNameIdx = render.indexOf("messages.className = 'chat-messages';");
    const listenerIdx = render.indexOf("messages.addEventListener('scroll'");
    const emptyStateIdx = render.indexOf('chat-empty-state');
    expect(classNameIdx).toBeGreaterThan(-1);
    expect(listenerIdx).toBeGreaterThan(classNameIdx);
    expect(emptyStateIdx).toBeGreaterThan(listenerIdx);
  });

  it('ships the cache-bust and the ownership-guard allowlist together', () => {
    const ver = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260919-vtid-04106-chat-stick-bottom').toBe(true);
    expect(INDEX_HTML).toContain('styles.css?v=' + ver);
    expect(GUARD_JS).toMatch(/ALLOWED_VTID_PATTERN = \/[^\n]*VTID-04106/);
  });
});
