/**
 * VTID-05064 — an Operator Console turn stays bound to the thread it was sent in.
 *
 * AC-1 the reply (and an error) is saved into state.chatTurnThreadId; when
 *      another thread is on screen only the turn's stored history changes.
 * AC-2 the live transcript renders only in the turn's thread; any other thread
 *      shows a one-line "chat-turn-elsewhere" banner that opens it; the
 *      sidebar row of the turn's thread carries a spinner.
 * AC-3 Stop and the kiro.turn_end model reset act on the turn's thread.
 * AC-4 the thread sync merges EVERY server user/assistant row the browser
 *      lacks (not only voice rows), matched by server id, else by role + the
 *      first 500 chars of whitespace-normalised content; the server id is
 *      stored on matched entries.
 * AC-5 Kiro replies that stopped early / lost the workspace say so.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const CSS = readFileSync(join(FE, 'styles.css'), 'utf8');
const INDEX_HTML = readFileSync(join(FE, 'index.html'), 'utf8');
const GUARD = readFileSync(join(__dirname, '../../../../scripts/ci/command-hub-ownership-guard.js'), 'utf8');

function fnBody(name: string): string {
  const start = APP_JS.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start).toBeGreaterThan(-1);
  const rest = APP_JS.slice(start + 1);
  const next = rest.slice(1).search(/\n(?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

class El {
  tag: string; className = ''; textContent = ''; title = ''; type = ''; disabled = false;
  children: El[] = []; attrs: Record<string, string> = {}; onclick: null | (() => void) = null;
  constructor(tag: string) { this.tag = tag; }
  appendChild(c: El) { this.children.push(c); return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
}

// ---- the thread sync (mergeServerOperatorMessages + syncOperatorVoiceTurns) ----
const SYNC_BLOCK = APP_JS.slice(
  APP_JS.indexOf('var OPERATOR_MESSAGE_MATCH_CHARS'),
  APP_JS.indexOf('var OPERATOR_THREADS_DISMISSED_KEY'),
);

function loadSync(state: any, pages: any[][] = [[]]) {
  const calls = { renders: 0, saved: {} as Record<string, any>, touched: 0 };
  let page = 0;
  const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ messages: pages[Math.min(page++, pages.length - 1)] }) }));
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'state', 'fetch', 'buildContextHeaders', 'renderApp', 'saveOperatorThreadHistory', 'touchActiveOperatorThread', 'kiroReplyMeta', 'console',
    SYNC_BLOCK + '\nreturn { mergeServerOperatorMessages, operatorMessageMatchKey, syncOperatorVoiceTurns };',
  )(
    state, fetchMock, () => ({ Authorization: 'Bearer t' }), () => { calls.renders++; },
    (id: string, h: any) => { calls.saved[id] = JSON.parse(JSON.stringify(h)); }, () => { calls.touched++; },
    (meta: any) => (meta && meta.engine === 'kiro' ? { engine: 'kiro' } : undefined), { warn: () => undefined },
  );
  return { api, calls, fetchMock };
}

const row = (id: string, role: string, content: string, meta: any = {}, at = '2026-10-10T10:00:00Z') => ({ id, role, content, meta, created_at: at });

describe('VTID-05064 mergeServerOperatorMessages', () => {
  const { api } = loadSync({});

  it('adds typed (non-voice) server rows the browser lacks, in server order, with their server id', () => {
    const history: any[] = [];
    const r = api.mergeServerOperatorMessages(history, [row('s1', 'user', 'from my phone'), row('s2', 'assistant', 'reply', { engine: 'kiro' })]);
    expect(r.added.map((h: any) => [h.role, h.content, h.serverMessageId])).toEqual([['user', 'from my phone', 's1'], ['assistant', 'reply', 's2']]);
    expect(history[1].kiroMeta).toEqual({ engine: 'kiro' });
  });

  it('still merges voice and voice_delegate rows', () => {
    const r = api.mergeServerOperatorMessages([], [row('v1', 'user', 'spoken', { channel: 'voice' }), row('v2', 'assistant', 'handed', { channel: 'voice_delegate' })]);
    expect(r.added.map((h: any) => h.channel)).toEqual(['voice', 'voice_delegate']);
  });

  it('matches by stored server id first, and skips tool rows', () => {
    const history: any[] = [{ role: 'user', content: 'edited locally', serverMessageId: 's1' }];
    const r = api.mergeServerOperatorMessages(history, [row('s1', 'user', 'different text'), row('t1', 'tool', '{}')]);
    expect(r.added).toEqual([]);
    expect(history).toHaveLength(1);
  });

  it('matches an id-less local entry by role + whitespace-normalised content and stores the server id', () => {
    const history: any[] = [{ role: 'user', content: '  fix   the\nbug ', ts: 1 }];
    const r = api.mergeServerOperatorMessages(history, [row('s9', 'user', 'fix the bug', {}, '2026-10-10T11:00:00Z')]);
    expect(r.added).toEqual([]);
    expect(r.matched).toBe(1);
    expect(history[0]).toMatchObject({ serverMessageId: 's9', serverCreatedAt: '2026-10-10T11:00:00Z', ts: 1 });
  });

  it('compares only the first 500 characters (the server may clip), never timestamps or the other role', () => {
    const long = 'x'.repeat(700);
    const history: any[] = [{ role: 'assistant', content: long, ts: 5 }];
    const clipped = 'x'.repeat(600) + '\n…[clipped]';
    expect(api.mergeServerOperatorMessages(history, [row('a1', 'assistant', clipped, {}, '2030-01-01T00:00:00Z')]).added).toEqual([]);
    const other = api.mergeServerOperatorMessages([{ role: 'assistant', content: 'same' }], [row('u1', 'user', 'same')]);
    expect(other.added).toHaveLength(1);
  });

  it('matches a local reply that carries a console-appended confirmation after the server text', () => {
    const history: any[] = [{ role: 'assistant', content: 'Done.\n\n✅ Task created: **VTID-1** — "x" (Scheduled)' }];
    expect(api.mergeServerOperatorMessages(history, [row('a2', 'assistant', 'Done.')]).added).toEqual([]);
    expect(history[0].serverMessageId).toBe('a2');
  });

  it('lets each local entry absorb at most one server row (a repeated message is kept twice)', () => {
    const history: any[] = [{ role: 'user', content: 'again' }];
    const r = api.mergeServerOperatorMessages(history, [row('r1', 'user', 'again'), row('r2', 'user', 'again')]);
    expect(r.matched).toBe(1);
    expect(r.added.map((h: any) => h.serverMessageId)).toEqual(['r2']);
  });

  it('never matches a persisted error line', () => {
    const history: any[] = [{ role: 'assistant', content: 'boom', isError: true }];
    expect(api.mergeServerOperatorMessages(history, [row('e1', 'assistant', 'boom')]).added).toHaveLength(1);
  });
});

describe('VTID-05064 syncOperatorVoiceTurns', () => {
  const base = () => ({ authToken: 't', operatorActiveThreadId: 'A', operatorChatHistory: [] as any[], chatMessages: [] as any[], chatSending: false, chatTurnThreadId: null as any });

  it('reads the whole transcript first, then only newer rows, and shows typed rows from elsewhere', async () => {
    const state = base();
    state.operatorChatHistory = [{ role: 'user', content: 'mine' }];
    const { api, calls, fetchMock } = loadSync(state, [
      [row('s1', 'user', 'mine', {}, '2026-10-10T10:00:00Z'), row('s2', 'assistant', 'typed on phone', {}, '2026-10-10T10:01:00Z')],
      [],
    ]);
    await api.syncOperatorVoiceTurns();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/operator/threads/A/messages');
    expect(state.chatMessages.map((m: any) => [m.type, m.content])).toEqual([['system', 'typed on phone']]);
    expect(calls.saved.A.map((h: any) => h.serverMessageId)).toEqual(['s1', 's2']);
    expect(calls.renders).toBe(1);
    await api.syncOperatorVoiceTurns();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/operator/threads/A/messages?since=' + encodeURIComponent('2026-10-10T10:01:00Z'));
  });

  it('pages through a transcript longer than one 200-row page', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => row('p' + i, 'user', 'm' + i, {}, new Date(Date.UTC(2026, 9, 10, 0, i)).toISOString()));
    const state = base();
    const { api, fetchMock } = loadSync(state, [page1, [row('last', 'assistant', 'end', {}, '2026-10-10T12:00:00Z')]]);
    await api.syncOperatorVoiceTurns();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('?since=' + encodeURIComponent(page1[199].created_at));
    expect(state.operatorChatHistory).toHaveLength(201);
  });

  it('does not sync the thread whose turn is still running', async () => {
    const state = base();
    state.chatSending = true;
    state.chatTurnThreadId = 'A';
    const { api, fetchMock } = loadSync(state);
    await api.syncOperatorVoiceTurns();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no longer filters to voice channels (source contract)', () => {
    const body = fnBody('syncOperatorVoiceTurns');
    expect(body).not.toContain("channel !== 'voice'");
    expect(body).toContain('mergeServerOperatorMessages(history, serverMessages)');
  });
});

// ---- Kiro block: Stop, turn_end, stopped-early / workspace-lost, the banner ----
const KIRO_BLOCK = APP_JS.slice(APP_JS.indexOf('function operatorThreadEngine(thread) {'), APP_JS.indexOf('function renderOperatorLiveTranscript() {'));

function loadKiro(over: any = {}) {
  const state: any = {
    authToken: 'tok', operatorThreads: [{ id: 'T1', title: 'Fix login', engine: 'kiro' }, { id: 'T2', title: 'Other' }],
    operatorActiveThreadId: 'T2', chatTurnThreadId: 'T1', chatSending: true, chatMessages: [],
    kiroModels: { T1: { loaded: true }, T2: { loaded: true } }, ...over,
  };
  const switched: string[] = [];
  const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'state', 'document', 'fetch', 'buildContextHeaders', 'renderApp', 'saveOperatorThreadsIndex',
    'updateOperatorLiveTranscriptDom', 'showToast', 'console', 'switchOperatorThread',
    KIRO_BLOCK + '\nreturn { onKiroRunFinished, kiroReplyMeta, renderKiroStoppedEarly, renderKiroWorkspaceLost, renderChatTurnElsewhereBanner, appendReplyWithKiroNotices };',
  )(
    state, { createElement: (t: string) => new El(t) }, fetchMock, (h: any) => h, () => undefined, () => undefined,
    () => undefined, () => undefined, { warn: () => undefined }, (id: string) => { switched.push(id); },
  );
  return { api, state, fetchMock, switched };
}

describe('VTID-05064 Kiro actions follow the turn thread', () => {
  // VTID-05067: Stop now cancels the run itself (POST /runs/:id/cancel, kiro-console.js —
  // pinned in vtid-05067-kiro-console.test.ts), so it can never hit another thread.
  it('a finished run resets its own thread\'s model list only', () => {
    const { api, state } = loadKiro();
    api.onKiroRunFinished('T1');
    expect(Object.keys(state.kiroModels)).toEqual(['T2']);
  });

  it('the banner names the running thread and opens it', () => {
    const { api, switched } = loadKiro();
    const b = api.renderChatTurnElsewhereBanner();
    expect(b.className).toBe('chat-turn-elsewhere');
    expect(b.textContent).toBe('Kiro is working in “Fix login” — open it');
    b.onclick();
    expect(switched).toEqual(['T1']);
  });
});

describe('VTID-05064 Kiro stopped early / workspace lost', () => {
  const { api } = loadKiro();

  it('keeps stop_reason and kiro_workspace through history, only when they matter', () => {
    expect(api.kiroReplyMeta({ engine: 'kiro', kiro_status: 'incomplete', kiro_model: 'm', stop_reason: 'max_tokens', kiro_workspace: 'lost' }))
      .toEqual({ engine: 'kiro', kiro_status: 'incomplete', kiro_model: 'm', stop_reason: 'max_tokens', kiro_workspace: 'lost' });
    expect(api.kiroReplyMeta({ engine: 'kiro', kiro_status: 'ok', kiro_model: null, stop_reason: 'end_turn', kiro_workspace: 'kept' }))
      .toEqual({ engine: 'kiro', kiro_status: 'ok', kiro_model: null });
  });

  it('renders the stopped-early marker for refused / incomplete only', () => {
    const el = api.renderKiroStoppedEarly({ meta: { engine: 'kiro', kiro_status: 'refused', stop_reason: 'refusal' } });
    expect(el.className).toBe('kiro-stopped-early');
    expect(el.textContent).toBe('Kiro stopped early: refusal');
    expect(api.renderKiroStoppedEarly({ meta: { engine: 'kiro', kiro_status: 'incomplete', stop_reason: 'max_turn_requests' } })).not.toBeNull();
    expect(api.renderKiroStoppedEarly({ meta: { engine: 'kiro', kiro_status: 'ok', stop_reason: 'end_turn' } })).toBeNull();
  });

  it('renders the workspace-lost notice', () => {
    const el = api.renderKiroWorkspaceLost({ meta: { engine: 'kiro', kiro_status: 'ok', kiro_workspace: 'lost' } });
    expect(el.className).toBe('kiro-workspace-lost');
    expect(el.textContent).toMatch(/^Earlier uncommitted Kiro edits in this thread were lost/);
    expect(api.renderKiroWorkspaceLost({ meta: { engine: 'kiro', kiro_status: 'ok' } })).toBeNull();
  });

  it('puts the workspace notice above the reply and the stopped-early marker under it; a sent bubble gets neither', () => {
    const messages = new El('div');
    const bubble = new El('div');
    api.appendReplyWithKiroNotices(messages, bubble, { meta: { engine: 'kiro', kiro_status: 'incomplete', stop_reason: 'max_tokens', kiro_workspace: 'lost' } });
    expect(messages.children.map((c) => c === bubble ? 'bubble' : c.className)).toEqual(['kiro-workspace-lost', 'bubble', 'kiro-stopped-early']);
    const sent = new El('div');
    api.appendReplyWithKiroNotices(sent, bubble, null);
    expect(sent.children).toEqual([bubble]);
  });

  it('the transcript renderer appends every bubble through it', () => {
    expect(APP_JS).toContain('appendReplyWithKiroNotices(messages, bubble, isSent ? null : msg);');
  });
});

describe('VTID-05064 sendChatMessage binds the turn to its thread (source contract)', () => {
  const send = fnBody('sendChatMessage');

  it('records the turn thread at send time and clears it when the turn ends', () => {
    expect(APP_JS).toContain('chatTurnThreadId: null,');
    expect(send).toContain('state.chatTurnThreadId = state.operatorActiveThreadId;');
    expect(send).toContain('state.chatTurnThreadId = null;');
  });

  it('the completion path saves to the turn thread, and only to its stored history when off screen', () => {
    expect(send).toContain('saveOperatorThreadHistory(turnThreadId, state.operatorChatHistory);');
    expect(send).toContain('appendToStoredOperatorThread(turnThreadId, [assistantHistoryEntry]);');
    expect(send).toContain('var turnOnScreen = state.operatorActiveThreadId === turnThreadId;');
  });

  it('the error path persists to the turn thread too', () => {
    const errorPart = send.slice(send.indexOf('} catch (error) {'));
    expect(errorPart).toContain('isError: true };');
    expect(errorPart).toContain('saveOperatorThreadHistory(turnThreadId, state.operatorChatHistory);');
    expect(errorPart).toContain('appendToStoredOperatorThread(turnThreadId, [errorHistoryEntry]);');
  });

  it('the live transcript is gated on the turn thread; other threads get the banner', () => {
    expect(APP_JS).toContain('if (state.chatSending && state.operatorActiveThreadId === state.chatTurnThreadId) {\n        messages.appendChild(renderOperatorLiveTranscript());');
    expect(APP_JS).toContain('messages.appendChild(renderChatTurnElsewhereBanner());');
  });

  it('the sidebar row of the running thread carries a spinner', () => {
    const rowFn = fnBody('renderOperatorThreadRow');
    expect(rowFn).toContain('state.chatSending && state.chatTurnThreadId === thread.id');
    expect(rowFn).toContain("'chat-thread-running'");
  });

  it('thread open and page load both sync the server transcript', () => {
    expect(fnBody('switchOperatorThread')).toMatch(/if \(history\.length === 0\) loadOperatorThreadFromServer\(thread\.id\);\s*else syncOperatorVoiceTurns\(\);/);
    expect(fnBody('initOperatorChatSession')).toContain('syncOperatorVoiceTurns();');
  });
});

describe('VTID-05064 styles, cache bump, ownership guard', () => {
  it('styles every new class and stills the spinner under reduced motion', () => {
    ['.chat-turn-elsewhere', '.chat-thread-running', '.kiro-stopped-early', '.kiro-workspace-lost'].forEach((c) => expect(CSS).toContain(c + ' {'));
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-thread-running \{\s*animation: none;/);
  });

  // Bumped past VTID-05064 by later Command Hub changes (VTID-05067); never back to an older build.
  it('bumps app.js and styles.css together', () => {
    const app = (INDEX_HTML.match(/\/command-hub\/app\.js\?v=([^"']+)/) || [])[1] || '';
    const css = (INDEX_HTML.match(/\/command-hub\/styles\.css\?v=([^"']+)/) || [])[1] || '';
    expect(app >= '20261110-vtid-05064').toBe(true);
    expect(css).toBe(app);
  });

  it('is allowlisted in the Command Hub ownership guard', () => {
    expect(GUARD).toMatch(/ALLOWED_VTID_PATTERN = \/[^;\n]*VTID-05064\|/);
  });
});
