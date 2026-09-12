/**
 * VTID-03822: Operator Console chat cockpit UI — regression tests.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard rather than an import-based
 * unit test — same pattern as vtid-03818/vtid-03819's sibling test files.
 *
 * Three independent pieces, per this VTID's spec:
 *  (1) a client-side, localStorage-backed multi-thread conversation layer
 *      with a safe one-time migration from the pre-existing single-thread
 *      operator_console_history storage (there is no backend conversation
 *      table to build against);
 *  (2) renderOperatorChat() rendering markdown instead of raw text, and
 *      surfacing the toolResults already pushed onto chatMessages;
 *  (3) the identical markdown fix applied to the Live Console's message
 *      rendering, which hits the same /api/v1/operator/chat reply shape.
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

describe('Multi-thread conversation state (VTID-03822)', () => {
  it('state carries operatorThreads and operatorActiveThreadId', () => {
    expect(SOURCE).toContain('operatorThreads: [],');
    expect(SOURCE).toContain('operatorActiveThreadId: null,');
  });

  it('defines the thread-index and per-thread-history localStorage keys', () => {
    expect(SOURCE).toContain("var OPERATOR_THREADS_INDEX_KEY = 'operator_console_threads_index';");
    expect(SOURCE).toMatch(/function operatorThreadHistoryKey\(threadId\)/);
  });

  it('migrateOperatorHistoryToThreads() no-ops once threads already exist and otherwise wraps legacy history into thread 1', () => {
    const start = SOURCE.indexOf('function migrateOperatorHistoryToThreads()');
    const end = SOURCE.indexOf('\n}', start);
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, end);
    expect(body).toMatch(/if \(index\.length > 0\) return index;/);
    expect(body).toContain('getOperatorChatHistory()');
    expect(body).toContain('saveOperatorThreadsIndex(index);');
  });

  it('startNewOperatorThread() creates a fresh thread, clears legacy single-thread keys, and re-renders', () => {
    const start = SOURCE.indexOf('function startNewOperatorThread()');
    const end = SOURCE.indexOf('\n}', start);
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('state.operatorThreads.unshift(thread);');
    expect(body).toContain('clearOperatorChatSession();');
    expect(body).toContain('renderApp();');
  });

  it('switchOperatorThread() restores the target thread\'s saved history into chatMessages', () => {
    const start = SOURCE.indexOf('function switchOperatorThread(threadId)');
    const end = SOURCE.indexOf('\n}', start);
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('getOperatorThreadHistory(thread.id)');
    expect(body).toContain('state.chatMessages = history.map(');
    expect(body).toContain('renderApp();');
  });

  it('initOperatorChatSession() is idempotent per session load (guards on operatorActiveThreadId)', () => {
    const start = SOURCE.indexOf('function initOperatorChatSession()');
    const end = SOURCE.indexOf('\n}', start);
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, end);
    expect(body).toMatch(/if \(state\.operatorActiveThreadId\) return;/);
    expect(body).toContain('migrateOperatorHistoryToThreads()');
  });

  it('sendChatMessage saves both the user and assistant turns into the ACTIVE thread\'s history, not the legacy single key', () => {
    expect(SOURCE).toContain(
      'saveOperatorThreadHistory(state.operatorActiveThreadId, state.operatorChatHistory);\n    touchActiveOperatorThread();'
    );
    // The old single-thread save call must not remain as the live save path
    // for a new message (it may still exist as a helper function definition).
    const sendChatMessageStart = SOURCE.indexOf('async function sendChatMessage(');
    expect(sendChatMessageStart).toBeGreaterThan(-1);
    const sendChatMessageBody = SOURCE.slice(sendChatMessageStart, sendChatMessageStart + 20000);
    expect(sendChatMessageBody).not.toContain('saveOperatorChatHistory(state.operatorChatHistory);');
  });
});

describe('Operator chat message rendering (VTID-03822)', () => {
  it('renders bubbles through renderManualMarkdown instead of raw textContent', () => {
    expect(SOURCE).toContain("bubble.appendChild(renderManualMarkdown(msg.content || msg.text || ''));");
    expect(SOURCE).not.toContain('bubble.textContent = msg.content || msg.text;');
  });

  it('surfaces msg.toolResults via describeToolActivity() instead of leaving it unread', () => {
    const start = SOURCE.indexOf('function renderOperatorChat()');
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, start + 4000);
    expect(body).toContain('if (msg.toolResults && msg.toolResults.length > 0)');
    expect(body).toContain('describeToolActivity(tr)');
  });

  it('describeToolActivity() falls back gracefully for an unmapped tool name', () => {
    const start = SOURCE.indexOf('function describeToolActivity(tr)');
    const end = SOURCE.indexOf('\n}', start);
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, end);
    expect(body).toContain("if (!tr || !tr.name) return 'Ran a tool';");
    expect(body).toContain('TOOL_ACTIVITY_LABELS[tr.name]');
  });

  it('renderOperatorChat() includes a thread-switcher select wired to switchOperatorThread', () => {
    const start = SOURCE.indexOf('function renderOperatorChat()');
    const end = SOURCE.indexOf('\n}', SOURCE.indexOf('const messages = document.createElement', start));
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, start + 3000);
    expect(body).toContain("threadSelect.className = 'chat-thread-select';");
    expect(body).toContain('switchOperatorThread(threadSelect.value);');
    expect(body).toContain('startNewOperatorThread();');
  });
});

describe('Live Console markdown rendering parity (VTID-03822)', () => {
  it('renders console content through renderManualMarkdown, not raw textContent', () => {
    expect(SOURCE).toContain("contentSpan.appendChild(renderManualMarkdown(msg.content || ''));");
    expect(SOURCE).not.toContain("contentSpan.textContent = msg.content || '';");
  });
});

describe('CSS additions (VTID-03822)', () => {
  it('defines the thread bar and tool-activity classes', () => {
    expect(CSS).toContain('.chat-thread-bar {');
    expect(CSS).toContain('.chat-thread-select {');
    expect(CSS).toContain('.chat-new-thread-btn {');
    expect(CSS).toContain('.chat-tool-activity {');
    expect(CSS).toContain('.chat-tool-activity-line {');
  });
});
