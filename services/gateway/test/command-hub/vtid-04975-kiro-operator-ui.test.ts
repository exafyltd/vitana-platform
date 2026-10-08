/**
 * VTID-04975 — the Kiro engine in the Operator Console.
 *
 * AC-1 an empty thread offers Operator | Kiro; Kiro is disabled until the
 *      gateway reports the engine connected; the choice is stored on the thread.
 * AC-2 once a thread has messages the engine is fixed (a Kiro badge, no switch).
 * AC-3 kiro.* frames build the live transcript: streamed text, tool lines with
 *      status, approval cards; other frames are left to the existing handler.
 * AC-4 Allow/Deny posts to /kiro/permissions/:id with the auth headers and
 *      shows the outcome; an expired card reads "Expired".
 * AC-5 Stop and End session call the cancel / close routes for the active thread.
 * AC-6 wiring: the request carries engine 'kiro' only for a Kiro thread, a
 *      server thread's engine is kept, Kiro frames route to their handler.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const CSS = readFileSync(join(FE, 'styles.css'), 'utf8');
const START = APP_JS.indexOf('var KIRO_TOOL_STATUS');
const END = APP_JS.indexOf('function renderOperatorLiveTranscript() {');
const BLOCK = APP_JS.slice(START, END);

class El {
  tag: string; className = ''; textContent = ''; title = ''; type = ''; disabled = false;
  children: El[] = []; attrs: Record<string, string> = {}; onclick: null | (() => void) = null;
  constructor(tag: string) { this.tag = tag; }
  appendChild(c: El) { this.children.push(c); return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  all(): El[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  find(cls: string) { return this.all().filter((e) => e.className.split(' ').includes(cls)); }
  text(): string { return [this.textContent, ...this.children.map((c) => c.text())].join(' '); }
}

function load(over: { kiroStatus?: any; messages?: number; sending?: boolean; engine?: string; fetchImpl?: any } = {}) {
  const thread: any = { id: 'T1', title: 'New conversation' };
  if (over.engine) thread.engine = over.engine;
  const state: any = {
    authToken: 'tok', operatorThreads: [thread], operatorActiveThreadId: 'T1',
    chatMessages: new Array(over.messages ?? 0).fill({}), chatSending: !!over.sending,
    kiroStatus: over.kiroStatus === undefined ? { ok: true, enabled: true } : over.kiroStatus,
    chatLiveKiro: { text: '', tools: [], permissions: [] },
  };
  const calls = { renders: 0, saves: 0, liveUpdates: 0, toasts: [] as string[] };
  const fetchMock = jest.fn(over.fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'state', 'document', 'fetch', 'buildContextHeaders', 'renderApp', 'saveOperatorThreadsIndex',
    'updateOperatorLiveTranscriptDom', 'showToast', 'console',
    BLOCK + '\nreturn { activeOperatorEngine, setActiveOperatorEngine, renderOperatorEngineSwitch, renderKiroThreadPanel, applyKiroTurnFrame, appendKiroLiveTranscript, answerKiroPermission, stopKiroTurn, endKiroSession, kiroLiveHasContent, resetKiroLiveTranscript, fetchKiroStatus };',
  )(
    state, { createElement: (t: string) => new El(t) }, fetchMock, (h: any) => ({ Authorization: 'Bearer tok', ...h }),
    () => { calls.renders++; }, () => { calls.saves++; }, () => { calls.liveUpdates++; },
    (m: string) => { calls.toasts.push(m); }, { warn: () => undefined },
  );
  return { api, state, thread, calls, fetchMock };
}

describe('VTID-04975 engine switch', () => {
  it('offers Operator | Kiro on an empty thread and stores the choice', () => {
    const { api, thread, calls } = load();
    const sw: El = api.renderOperatorEngineSwitch();
    const opts = sw.find('chat-engine-option');
    expect(opts.map((o) => o.textContent)).toEqual(['Operator', 'Kiro']);
    expect(sw.attrs['aria-label']).toBe('Answer this thread with');
    expect(opts[0].attrs['aria-pressed']).toBe('true');
    opts[1].onclick!();
    expect(thread.engine).toBe('kiro');
    expect(calls.saves).toBe(1);
    expect(api.activeOperatorEngine()).toBe('kiro');
    api.setActiveOperatorEngine('llm');
    expect(thread.engine).toBeUndefined();
  });

  it('disables Kiro until the gateway reports it connected, and refuses to switch to it', () => {
    for (const status of [null, { ok: true, enabled: false }, { ok: false, enabled: false, error: 401 }]) {
      const { api, thread } = load({ kiroStatus: status });
      const kiro = api.renderOperatorEngineSwitch().find('chat-engine-option')[1];
      expect(kiro.disabled).toBe(true);
      expect(kiro.title).toMatch(status ? /not connected/ : /Checking/);
      api.setActiveOperatorEngine('kiro');
      expect(thread.engine).toBeUndefined();
    }
  });

  it('fixes the engine once the thread has messages: a Kiro badge, no switch', () => {
    const { api, thread } = load({ messages: 2, engine: 'kiro' });
    const fixed: El = api.renderOperatorEngineSwitch();
    expect(fixed.find('chat-engine-option')).toHaveLength(0);
    expect(fixed.find('chat-engine-badge')[0].textContent).toBe('Kiro');
    expect(fixed.find('chat-engine-end-btn')).toHaveLength(1);
    api.setActiveOperatorEngine('llm');
    expect(thread.engine).toBe('kiro');
    expect(load({ messages: 2 }).api.renderOperatorEngineSwitch()).toBeNull();
    expect(load({ messages: 2, engine: 'kiro', sending: true }).api.renderOperatorEngineSwitch().find('chat-engine-end-btn')).toHaveLength(0);
  });
});

describe('VTID-04975 Kiro workspace card', () => {
  it('shows the status and what Kiro may do on its own vs. only after asking', () => {
    const on: El = load().api.renderKiroThreadPanel();
    expect(on.find('kiro-panel-status')[0].textContent).toBe('Connected');
    expect(on.text()).toMatch(/Reads & searches/);
    expect(on.text()).toMatch(/asks you first/);
    // VTID-04999: the key row shows the user's real key status (checking until it is read).
    expect(on.text()).toMatch(/Your Kiro API key checking/);
    expect(load({ kiroStatus: { enabled: false } }).api.renderKiroThreadPanel().find('kiro-panel-status')[0].textContent).toBe('Not connected');
    expect(load({ kiroStatus: null }).api.renderKiroThreadPanel().find('kiro-panel-status')[0].textContent).toMatch(/Checking/);
  });
});

describe('VTID-04975 live Kiro transcript', () => {
  it('builds streamed text, tool lines and approval cards from kiro.* frames', () => {
    const { api, state, calls } = load({ engine: 'kiro' });
    api.applyKiroTurnFrame({ event: 'kiro.message_chunk', data: { text: 'Hello ' } });
    api.applyKiroTurnFrame({ event: 'kiro.tool_call', data: { tool_call_id: 'a', title: 'Read src/x.ts', kind: 'read', status: 'pending' } });
    api.applyKiroTurnFrame({ event: 'kiro.tool_update', data: { tool_call_id: 'a', status: 'completed' } });
    api.applyKiroTurnFrame({ event: 'kiro.permission_request', data: { request_id: 'r1', title: 'Edit src/x.ts', kind: 'edit', expires_at: 'x' } });
    api.applyKiroTurnFrame({ event: 'kiro.message_chunk', data: { text: 'world' } });
    api.applyKiroTurnFrame({ event: 'kiro.turn_end', data: { stop_reason: 'end_turn' } });
    expect(calls.liveUpdates).toBe(5);
    expect(state.chatLiveKiro.text).toBe('Hello world');
    expect(state.chatLiveKiro.tools[0]).toMatchObject({ title: 'Read src/x.ts', status: 'ok' });
    const wrap = new El('div');
    api.appendKiroLiveTranscript(wrap);
    expect(wrap.find('chat-tool-activity-line--ok')[0].textContent).toMatch(/Read src\/x\.ts/);
    const card = wrap.find('kiro-approval')[0];
    expect(card.text()).toMatch(/Kiro wants to edit: Edit src\/x\.ts/);
    expect(card.find('kiro-approval-btn').map((b) => b.textContent)).toEqual(['Allow', 'Deny']);
    expect(wrap.find('kiro-live-text')[0].textContent).toBe('Hello world');
    expect(wrap.find('kiro-stop-btn')).toHaveLength(1);
    expect(api.kiroLiveHasContent()).toBe(true);
    api.resetKiroLiveTranscript();
    expect(api.kiroLiveHasContent()).toBe(false);
  });

  it('adds nothing to an Operator thread', () => {
    const { api } = load();
    const wrap = new El('div');
    api.appendKiroLiveTranscript(wrap);
    expect(wrap.children).toHaveLength(0);
  });
});

describe('VTID-04975 Kiro actions', () => {
  it('Allow posts the answer with auth headers and shows the outcome', async () => {
    const { api, state, fetchMock } = load({ engine: 'kiro' });
    api.applyKiroTurnFrame({ event: 'kiro.permission_request', data: { request_id: 'r 1', title: 'Run tests', kind: 'execute' } });
    await api.answerKiroPermission('r 1', true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/operator/kiro/permissions/r%201');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ allow: true });
    expect(state.chatLiveKiro.permissions[0].answer).toBe('allowed');
    await api.answerKiroPermission('r 1', false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an expired card reads Expired, a network error reads as denied', async () => {
    const gone = load({ engine: 'kiro', fetchImpl: async () => ({ ok: false, status: 404 }) });
    gone.api.applyKiroTurnFrame({ event: 'kiro.permission_request', data: { request_id: 'r', title: 't' } });
    await gone.api.answerKiroPermission('r', false);
    expect(gone.state.chatLiveKiro.permissions[0].answer).toBe('expired');
    const down = load({ engine: 'kiro', fetchImpl: async () => { throw new Error('offline'); } });
    down.api.applyKiroTurnFrame({ event: 'kiro.permission_request', data: { request_id: 'r', title: 't' } });
    await down.api.answerKiroPermission('r', true);
    const wrap = new El('div');
    down.api.appendKiroLiveTranscript(wrap);
    expect(wrap.find('kiro-approval-result')[0].textContent).toMatch(/Kiro will deny it/);
  });

  it('Stop and End session call the cancel and close routes for the active thread', async () => {
    const { api, fetchMock, calls } = load({ engine: 'kiro' });
    await api.stopKiroTurn();
    await api.endKiroSession();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/operator/kiro/sessions/T1/cancel');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/operator/kiro/sessions/T1');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
    expect(calls.toasts).toEqual(['Kiro session ended']);
  });

  it('fetches the Kiro status once per page load', async () => {
    const { api, state, fetchMock } = load({ kiroStatus: null, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, enabled: false, open_sessions: 0 }) }) });
    await api.fetchKiroStatus();
    await api.fetchKiroStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/operator/kiro/status');
    expect(state.kiroStatus).toEqual({ ok: true, enabled: false, open_sessions: 0 });
  });
});

describe('VTID-04975 wiring (source check)', () => {
  it('the request names the engine only for a Kiro thread', () => {
    expect(APP_JS).toContain("engine: activeOperatorEngine() === 'kiro' ? 'kiro' : undefined,");
  });
  it('Kiro frames go to their own handler and reset with each turn', () => {
    expect(APP_JS).toContain("if (frame.event && frame.event.indexOf('kiro.') === 0) { applyKiroTurnFrame(frame); return; }");
    expect(APP_JS.indexOf('resetKiroLiveTranscript();')).toBeGreaterThan(APP_JS.indexOf('async function requestOperatorTurn(payload) {'));
  });
  it('a server thread keeps its engine, and a Kiro thread shows its tag and workspace card', () => {
    expect(APP_JS).toContain("if (st.engine === 'kiro') local.engine = 'kiro';");
    expect(APP_JS).toContain("if (st.engine === 'kiro') thread.engine = 'kiro';");
    expect(APP_JS).toContain("tag.className = 'chat-engine-tag';");
    expect(APP_JS).toContain("messages.appendChild(renderKiroThreadPanel());");
  });
  it('every class the block uses has a rule in styles.css', () => {
    const classes = new Set<string>();
    for (const m of BLOCK.matchAll(/'((?:kiro|chat-engine)-[a-z-]+)/g)) classes.add(m[1]);
    for (const c of ['chat-engine-tag', 'kiro-approval--allowed', 'kiro-approval--denied']) classes.add(c);
    for (const c of classes) {
      if (c.endsWith('-')) continue;
      expect(CSS).toContain(`.${c}`);
    }
  });
  it('index.html loads app.js and styles.css at (or after) the VTID-04975 version', () => {
    const html = readFileSync(join(FE, 'index.html'), 'utf8');
    const app = (html.match(/app\.js\?v=([^"']+)/) || [])[1] || '';
    const css = (html.match(/styles\.css\?v=([^"']+)/) || [])[1] || '';
    expect(app >= '20261031-vtid-04975').toBe(true);
    expect(css).toBe(app);
  });
});
