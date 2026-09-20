/**
 * VTID-04104: the Operator Console's live execution-follow panel
 * (VTID-04033) disappeared after a thread switch or a page reload, even
 * though the Dev Autopilot execution it was following kept running on the
 * backend the whole time — reported live: "I changed the title of the
 * task and now it stopped displaying the process." Confirmed against
 * production the execution itself never stopped (oasis_events showed a
 * fresh turn seconds before the report); the defect is purely client-side.
 *
 * Root cause: switchOperatorThread() and the page-load bootstrap
 * (initOperatorChatSession()) both rebuild state.chatMessages from the
 * PERSISTED state.operatorChatHistory ({role, content, ts} only,
 * saveOperatorThreadHistory()/getOperatorThreadHistory()) — followExecIds
 * was only ever set on the in-memory-only state.chatMessages entry in
 * sendChatMessage(), never on the history entry that actually survives a
 * reload. So a still-running execution's follow panel could never be
 * reattached once the thread was reloaded from storage.
 *
 * Fix: persist followExecIds on the history entry too, carry it through
 * both restore paths, and reopen a live SSE follow for each restored id via
 * a shared reattachFollowedExecutions() helper.
 *
 * app.js is a plain script (no export surface) — pinned by source text, the
 * same convention vtid-04033's own suite uses.
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

describe('VTID-04104: the followed execution survives a thread switch / reload', () => {
  it('sendChatMessage persists followExecIds onto the history entry that is actually saved to storage', () => {
    const send = asyncFnBody('sendChatMessage');
    const historyEntryIdx = send.indexOf('var assistantHistoryEntry = {');
    expect(historyEntryIdx).toBeGreaterThan(-1);
    const historyEntry = send.slice(historyEntryIdx, send.indexOf('};', historyEntryIdx));
    expect(historyEntry).toContain('followExecIds: turnFollowExecIds');
    // The persisted entry is what saveOperatorThreadHistory actually stores —
    // proves this isn't just a stray field nobody writes out.
    expect(send.indexOf('state.operatorChatHistory.push(assistantHistoryEntry);')).toBeGreaterThan(historyEntryIdx);
    expect(send).toContain('saveOperatorThreadHistory(state.operatorActiveThreadId, state.operatorChatHistory);');
  });

  it('defines a shared reattachFollowedExecutions() helper that reopens a live follow for every restored id', () => {
    const helper = fnBody('reattachFollowedExecutions');
    expect(helper).toContain('Array.isArray(msg.followExecIds)');
    expect(helper).toContain('followOperatorExecution(execId);');
  });

  it('switchOperatorThread carries followExecIds through the restore and reattaches them, after closing the OLD thread\'s follows', () => {
    const fn = fnBody('switchOperatorThread');
    const closeIdx = fn.indexOf('closeAllOperatorExecutionFollows();');
    const mapIdx = fn.indexOf('state.chatMessages = history.map(');
    const reattachIdx = fn.indexOf('reattachFollowedExecutions(state.chatMessages);');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(mapIdx).toBeGreaterThan(closeIdx);
    expect(fn).toContain('followExecIds: msg.followExecIds');
    expect(reattachIdx).toBeGreaterThan(mapIdx);
  });

  it('initOperatorChatSession (the page-load bootstrap) carries followExecIds through and reattaches them too', () => {
    const fn = fnBody('initOperatorChatSession');
    const mapIdx = fn.indexOf('state.chatMessages = history.map(');
    const reattachIdx = fn.indexOf('reattachFollowedExecutions(state.chatMessages);');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(fn).toContain('followExecIds: msg.followExecIds');
    expect(reattachIdx).toBeGreaterThan(mapIdx);
  });

  it('ships the cache-bust and the ownership-guard allowlist together', () => {
    const ver = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260919-vtid-04104-exec-follow-persist').toBe(true);
    expect(INDEX_HTML).toContain('styles.css?v=' + ver);
    expect(GUARD_JS).toMatch(/ALLOWED_VTID_PATTERN = \/[^\n]*VTID-04104/);
  });
});
