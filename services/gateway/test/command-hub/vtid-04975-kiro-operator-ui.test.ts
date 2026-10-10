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
 *
 * VTID-05067: AC-3/AC-4 and Stop moved with the Kiro view into kiro-console.js
 * (one owner of the Kiro view); their behaviour is pinned by
 * test/command-hub/vtid-05067-kiro-console.test.ts. This suite keeps what
 * stayed in app.js (engine switch, workspace card, End session, status) and
 * checks that the moved code is gone from app.js.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
// VTID-05067: the approval-card / Stop rules moved to kiro-console.css.
const CSS = readFileSync(join(FE, 'styles.css'), 'utf8') + readFileSync(join(FE, 'kiro-console.css'), 'utf8');
const START = APP_JS.indexOf('function operatorThreadEngine(thread) {');
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
  };
  const calls = { renders: 0, saves: 0, liveUpdates: 0, toasts: [] as string[] };
  const fetchMock = jest.fn(over.fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'state', 'document', 'fetch', 'buildContextHeaders', 'renderApp', 'saveOperatorThreadsIndex',
    'updateOperatorLiveTranscriptDom', 'showToast', 'console',
    BLOCK + '\nreturn { activeOperatorEngine, setActiveOperatorEngine, renderOperatorEngineSwitch, renderKiroThreadPanel, endKiroSession, fetchKiroStatus };',
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

describe('VTID-04975 live Kiro transcript (moved to kiro-console.js, VTID-05067)', () => {
  it('app.js no longer builds the live Kiro transcript, approval cards or Stop itself', () => {
    for (const gone of ['function applyKiroTurnFrame(', 'function appendKiroLiveTranscript(', 'function answerKiroPermission(', 'function stopKiroTurn(', 'function resetKiroLiveTranscript(', 'chatLiveKiro']) {
      expect(APP_JS).not.toContain(gone);
    }
    const mod = readFileSync(join(FE, 'kiro-console.js'), 'utf8');
    for (const kept of ['function foldRun(events)', 'function renderApproval(opts)', "'kiro-stop-btn'", "'/api/v1/operator/kiro/permissions/' + encodeURIComponent(requestId)"]) {
      expect(mod).toContain(kept);
    }
  });
});

describe('VTID-04975 Kiro actions', () => {
  // VTID-05067: Stop cancels the current RUN (kiro-console.js, POST /runs/:id/cancel).
  it('End session calls the close route for the active thread', async () => {
    const { api, fetchMock, calls } = load({ engine: 'kiro' });
    await api.endKiroSession();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/operator/kiro/sessions/T1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
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
  // VTID-05067: a Kiro thread's pane and sends belong to kiro-console.js; the LLM stream ignores kiro.* frames.
  it('a Kiro thread hands its chat pane and its sends to kiro-console.js', () => {
    expect(APP_JS).toContain("if (frame.event && frame.event.indexOf('kiro.') === 0) return;");
    expect(APP_JS).toContain("container.appendChild(window.KiroConsole.renderPane(state.operatorActiveThreadId, { legacyMessages: state.chatMessages }));");
    expect(APP_JS).toContain('window.KiroConsole.send(state.operatorActiveThreadId);');
  });
  it('a server thread keeps its engine, and a Kiro thread shows its tag and workspace card', () => {
    expect(APP_JS).toContain("if (st.engine === 'kiro') local.engine = 'kiro';");
    expect(APP_JS).toContain("if (st.engine === 'kiro') thread.engine = 'kiro';");
    expect(APP_JS).toContain("tag.className = 'chat-engine-tag';");
    expect(APP_JS).toContain("renderEmptyPanel: function () { return renderKiroThreadPanel(); },");
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
