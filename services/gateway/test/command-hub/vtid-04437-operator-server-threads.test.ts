/**
 * VTID-04437 — the Operator Console lists the caller's server-side threads.
 *
 * AC-1 server threads missing from the local index are added (newest activity
 *      as updatedAt), existing ones keep their local title unless untitled.
 * AC-2 a thread deleted locally is remembered and never re-added.
 * AC-3 the list is fetched once per page load, with the auth headers; a
 *      deep link to a server-only thread opens it once the list arrives.
 * AC-4 a thread with no local history loads its whole server transcript
 *      (typed + voice turns, tool rows skipped), unless something was typed
 *      meanwhile or the user switched away.
 * AC-5 wiring: switchOperatorThread loads from the server on an empty
 *      history, deleteOperatorThread dismisses, init starts the sync.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const START = APP_JS.indexOf('var OPERATOR_THREADS_DISMISSED_KEY');
const END = APP_JS.indexOf('/** Switch the active thread and restore its history into the UI. */');
const BLOCK = APP_JS.slice(START, END);

function load(opts: { state?: any; fetchImpl?: (url: string, init?: any) => Promise<any>; storage?: Record<string, string> } = {}) {
  const storage: Record<string, string> = opts.storage ?? {};
  const localStorage = {
    getItem: (k: string) => (k in storage ? storage[k] : null),
    setItem: (k: string, v: string) => { storage[k] = String(v); },
    removeItem: (k: string) => { delete storage[k]; },
  };
  const state: any = opts.state ?? { authToken: 't', operatorThreads: [], operatorActiveThreadId: 'a', operatorChatHistory: [], chatMessages: [] };
  const calls = { renders: 0, switched: [] as string[], savedIndex: null as any, savedHistory: {} as Record<string, any> };
  const fetchMock = jest.fn(opts.fetchImpl ?? (async () => ({ ok: true, json: async () => ({ threads: [] }) })));
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'state', 'localStorage', 'fetch', 'buildContextHeaders', 'renderApp', 'switchOperatorThread',
    'saveOperatorThreadsIndex', 'saveOperatorThreadHistory', 'window', 'console',
    BLOCK + '\nreturn { mergeServerOperatorThreads, syncOperatorThreadsFromServer, loadOperatorThreadFromServer, dismissOperatorThreadId, loadDismissedOperatorThreadIds };',
  )(
    state, localStorage, fetchMock, () => ({ Authorization: 'Bearer t' }), () => { calls.renders++; },
    (id: string) => { calls.switched.push(id); state.operatorActiveThreadId = id; },
    (idx: any) => { calls.savedIndex = idx; }, (id: string, h: any) => { calls.savedHistory[id] = h; },
    {}, { warn: () => undefined, log: () => undefined },
  );
  return { api, state, calls, fetchMock, storage };
}

describe('VTID-04437 mergeServerOperatorThreads', () => {
  const { api } = load();
  it('adds server-only threads and keeps local titles', () => {
    const local = [{ id: 'a', title: 'Mine', updatedAt: 1000 }, { id: 'b', title: 'New conversation', updatedAt: 1000 }];
    const r = api.mergeServerOperatorThreads(local, [
      { id: 'a', title: 'Server A', last_message_at: '2026-09-23T10:00:00Z', created_at: '2026-09-22T10:00:00Z' },
      { id: 'b', title: 'Server B', last_message_at: null, created_at: '2026-09-22T10:00:00Z' },
      { id: 'c', title: null, last_message_at: '2026-09-23T11:00:00Z', created_at: '2026-09-23T09:00:00Z' },
    ], []);
    expect(r.added).toBe(1);
    const byId = Object.fromEntries(r.index.map((t: any) => [t.id, t]));
    expect(byId.a.title).toBe('Mine');
    expect(byId.a.updatedAt).toBe(Date.parse('2026-09-23T10:00:00Z'));
    expect(byId.b.title).toBe('Server B');
    expect(byId.c).toMatchObject({ title: 'Conversation', conversationId: 'c', fromServer: true, updatedAt: Date.parse('2026-09-23T11:00:00Z') });
  });
  it('skips dismissed ids and malformed rows', () => {
    const r = api.mergeServerOperatorThreads([], [{ id: 'gone', title: 'x' }, null, { title: 'no id' }], ['gone']);
    expect(r.added).toBe(0);
    expect(r.index).toEqual([]);
  });
});

describe('VTID-04437 dismissed threads', () => {
  it('remembers a deleted id, newest first, without duplicates', () => {
    const { api, storage } = load();
    api.dismissOperatorThreadId('x');
    api.dismissOperatorThreadId('y');
    api.dismissOperatorThreadId('x');
    expect(api.loadDismissedOperatorThreadIds()).toEqual(['x', 'y']);
    expect(JSON.parse(storage.operator_console_threads_dismissed)).toEqual(['x', 'y']);
  });
});

describe('VTID-04437 syncOperatorThreadsFromServer', () => {
  it('fetches once with auth headers, merges, saves and renders', async () => {
    const { api, state, calls, fetchMock } = load({
      fetchImpl: async () => ({ ok: true, json: async () => ({ threads: [{ id: 's1', title: 'From phone', last_message_at: '2026-09-23T10:00:00Z' }] }) }),
    });
    await api.syncOperatorThreadsFromServer(null);
    await api.syncOperatorThreadsFromServer(null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/operator/threads?limit=50');
    expect((fetchMock.mock.calls[0] as any)[1].headers.Authorization).toBe('Bearer t');
    expect(state.operatorThreads.map((t: any) => t.id)).toEqual(['s1']);
    expect(calls.savedIndex).toBe(state.operatorThreads);
    expect(calls.renders).toBe(1);
  });
  it('opens a deep-linked thread only the server knows', async () => {
    const { api, calls } = load({
      fetchImpl: async () => ({ ok: true, json: async () => ({ threads: [{ id: 'deep', title: 'Shared' }] }) }),
    });
    await api.syncOperatorThreadsFromServer('deep');
    expect(calls.switched).toEqual(['deep']);
  });
  it('does nothing without a session and survives a failed request', async () => {
    const noAuth = load({ state: { authToken: null, operatorThreads: [] } });
    await noAuth.api.syncOperatorThreadsFromServer(null);
    expect(noAuth.fetchMock).not.toHaveBeenCalled();
    const bad = load({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
    await bad.api.syncOperatorThreadsFromServer(null);
    expect(bad.calls.renders).toBe(0);
  });
});

describe('VTID-04437 loadOperatorThreadFromServer', () => {
  const messages = [
    { id: 'm1', role: 'user', content: 'hi', created_at: '2026-09-23T10:00:00Z', meta: {} },
    { id: 'm2', role: 'tool', content: '{"x":1}', created_at: '2026-09-23T10:00:01Z', tool_name: 'dev_x' },
    { id: 'm3', role: 'assistant', content: 'hello', created_at: '2026-09-23T10:00:02Z', meta: { channel: 'voice' } },
  ];
  it('loads typed and voice turns, skips tool rows, saves and renders', async () => {
    const { api, state, calls, fetchMock } = load({ fetchImpl: async () => ({ ok: true, json: async () => ({ messages }) }) });
    await api.loadOperatorThreadFromServer('a');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/operator/threads/a/messages');
    expect(state.operatorChatHistory.map((h: any) => [h.role, h.content])).toEqual([['user', 'hi'], ['assistant', 'hello']]);
    expect(state.chatMessages.map((m: any) => m.type)).toEqual(['user', 'system']);
    expect(calls.savedHistory.a).toBe(state.operatorChatHistory);
    expect(calls.renders).toBe(1);
  });
  it('leaves the thread alone if the user switched away or typed meanwhile', async () => {
    const switched = load({ fetchImpl: async () => ({ ok: true, json: async () => ({ messages }) }) });
    switched.state.operatorActiveThreadId = 'other';
    await switched.api.loadOperatorThreadFromServer('a');
    expect(switched.state.operatorChatHistory).toEqual([]);

    const typed = load({ fetchImpl: async () => ({ ok: true, json: async () => ({ messages }) }) });
    typed.state.operatorChatHistory = [{ role: 'user', content: 'new' }];
    await typed.api.loadOperatorThreadFromServer('a');
    expect(typed.state.operatorChatHistory).toEqual([{ role: 'user', content: 'new' }]);
  });
});

describe('VTID-04437 wiring', () => {
  it('switchOperatorThread loads a server transcript on an empty history', () => {
    const fn = APP_JS.slice(APP_JS.indexOf('function switchOperatorThread('), APP_JS.indexOf('function switchOperatorThread(') + 2500);
    expect(fn).toMatch(/if \(history\.length === 0\) loadOperatorThreadFromServer\(thread\.id\);\s*else syncOperatorVoiceTurns\(\);/);
  });
  it('deleteOperatorThread dismisses the id', () => {
    const fn = APP_JS.slice(APP_JS.indexOf('function deleteOperatorThread('), APP_JS.indexOf('function archiveOperatorThread('));
    expect(fn).toContain('dismissOperatorThreadId(threadId);');
  });
  it('initOperatorChatSession starts the server sync with the deep-link id', () => {
    const fn = APP_JS.slice(APP_JS.indexOf('function initOperatorChatSession('), APP_JS.indexOf('function openOperatorConsole('));
    expect(fn).toContain('syncOperatorThreadsFromServer(requestedThreadId);');
  });
});
