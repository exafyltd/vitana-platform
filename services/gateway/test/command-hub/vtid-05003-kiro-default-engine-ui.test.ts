/**
 * VTID-05003 — Command Hub: Kiro is the default engine of a new Operator thread
 * when the gateway says so; the switch still overrides; a Kiro reply that could
 * not be served offers "Continue in Operator" (pre-filled, not sent).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const CSS = readFileSync(join(FE, 'styles.css'), 'utf8');
const BLOCK = APP_JS.slice(APP_JS.indexOf('var KIRO_TOOL_STATUS'), APP_JS.indexOf('function renderOperatorLiveTranscript() {'));

class El {
  tag: string; className = ''; textContent = ''; title = ''; type = ''; onclick: null | (() => void) = null;
  constructor(tag: string) { this.tag = tag; }
  appendChild(c: El) { return c; }
  setAttribute() {}
}

function load(over: any = {}, statusBody: any = { ok: true, enabled: true, default_engine: 'kiro' }) {
  const state: any = { authToken: 'tok', operatorThreads: [{ id: 'T1' }], operatorActiveThreadId: 'T1', chatMessages: [], chatSending: false, chatInputValue: '', ...over };
  const calls = { started: [] as any[], saved: 0, renders: 0 };
  const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => statusBody }));
  const startNewOperatorThread = (opts: any) => { calls.started.push(opts); state.chatMessages = []; };
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'state', 'document', 'fetch', 'buildContextHeaders', 'renderApp', 'saveOperatorThreadsIndex',
    'updateOperatorLiveTranscriptDom', 'showToast', 'confirm', 'console', 'startNewOperatorThread',
    BLOCK + '\nreturn { fetchKiroStatus, applyDefaultOperatorEngine, renderKiroFallbackAction, continueInOperator, setActiveOperatorEngine, operatorThreadEngine, waitForKiroDefault, kiroReplyMeta };',
  )(
    state, { createElement: (t: string) => new El(t) }, fetchMock, (h: any) => h, () => { calls.renders++; }, () => { calls.saved++; },
    () => {}, () => {}, () => true, { warn: () => undefined }, startNewOperatorThread,
  );
  return { api, state, calls, fetchMock };
}

describe('VTID-05003 default engine', () => {
  it('a new thread takes the gateway default; forced engine wins', () => {
    const { api, state } = load({ kiroStatus: { enabled: true, default_engine: 'kiro' } });
    const t: any = {}; api.applyDefaultOperatorEngine(t); expect(t.engine).toBe('kiro');
    const t2: any = { engine: 'kiro' }; api.applyDefaultOperatorEngine(t2, 'llm'); expect(t2.engine).toBeUndefined();
    state.kiroStatus = { enabled: true, default_engine: 'llm' };
    const t3: any = {}; api.applyDefaultOperatorEngine(t3); expect(t3.engine).toBeUndefined();
    state.kiroStatus = null;
    const t4: any = {}; api.applyDefaultOperatorEngine(t4); expect(t4.engine).toBeUndefined();
  });

  it('a forced re-read applies the fresh default to the empty, unchosen active thread', async () => {
    const { api, state, fetchMock } = load();
    await api.fetchKiroStatus();
    await api.fetchKiroStatus(); // one-shot guard
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.operatorThreads[0].engine).toBe('kiro');
    await api.fetchKiroStatus(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never re-applies over the user\'s own choice or a thread that has messages', async () => {
    const chosen = load({ operatorThreads: [{ id: 'T1', engineChosen: true }] });
    await chosen.api.fetchKiroStatus(true);
    expect(chosen.state.operatorThreads[0].engine).toBeUndefined();
    const busy = load({ chatMessages: [{ type: 'user', content: 'x' }] });
    await busy.api.fetchKiroStatus(true);
    expect(busy.state.operatorThreads[0].engine).toBeUndefined();
  });

  it('the switch marks the thread as chosen', () => {
    const { api, state } = load({ kiroStatus: { enabled: true } });
    api.setActiveOperatorEngine('llm');
    expect(state.operatorThreads[0].engineChosen).toBe(true);
  });
});

describe('VTID-05003 first send waits for the default', () => {
  it('a send on an empty, unchosen thread waits for the status in flight and then sees the Kiro default', async () => {
    let release: (v: any) => void = () => {};
    const gate = new Promise((r) => { release = r; });
    // a status read that has not answered yet
    const slowFetch = async () => { await gate; return { ok: true, status: 200, json: async () => ({ ok: true, enabled: true, default_engine: 'kiro' }) }; };
    const h = load({}, null as any);
    (h.fetchMock as any).mockImplementation(slowFetch);
    h.api.fetchKiroStatus(true);
    let done = false;
    const wait = h.api.waitForKiroDefault().then((v: boolean) => { done = true; return v; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(await h.api.waitForKiroDefault()).toBe(false); // a second send while waiting is dropped
    release(null);
    expect(await wait).toBe(true);
    expect(h.state.operatorThreads[0].engine).toBe('kiro');
  });
  it('does not wait when nothing is in flight or the user already chose', async () => {
    const { api } = load({ operatorThreads: [{ id: 'T1', engineChosen: true }] });
    expect(await api.waitForKiroDefault()).toBe(true);
  });
});

describe('VTID-05003 fallback survives reloads', () => {
  it('keeps only the Kiro fields the fallback and badge need', () => {
    const { api } = load();
    expect(api.kiroReplyMeta({ engine: 'kiro', kiro_status: 'no_credits', kiro_model: null, error: 'x', kiro_message: 'secret-ish' }))
      .toEqual({ engine: 'kiro', kiro_status: 'no_credits', kiro_model: null });
    expect(api.kiroReplyMeta({ provider: 'bedrock' })).toBeUndefined();
  });
  it('history entries carry it and both restore paths put it back on the message', () => {
    expect(APP_JS).toContain('kiroMeta: kiroReplyMeta(result.meta)');
    expect(APP_JS).toContain('kiroMeta: kiroReplyMeta(m.meta)');
    expect(APP_JS.match(/meta: msg\.kiroMeta/g)).toHaveLength(2);
    expect(APP_JS).toContain('if (!(await waitForKiroDefault())) return;');
  });
});

describe('VTID-05003 no silent fallback', () => {
  it('offers "Continue in Operator" only on a Kiro reply that could not be served', () => {
    const { api } = load();
    expect(api.renderKiroFallbackAction({ meta: { engine: 'kiro', kiro_status: 'no_credits' } }).textContent).toBe('Continue in Operator');
    expect(api.renderKiroFallbackAction({ meta: { engine: 'kiro', kiro_status: 'not_connected' } })).not.toBeNull();
    expect(api.renderKiroFallbackAction({ meta: { engine: 'kiro', kiro_status: 'ok' } })).toBeNull();
    expect(api.renderKiroFallbackAction({ meta: { engine: 'kiro', kiro_status: 'error' } })).toBeNull();
    expect(api.renderKiroFallbackAction({ meta: { provider: 'bedrock' } })).toBeNull();
  });

  it('opens a new Operator thread with the last message pre-filled, and sends nothing', () => {
    const reply = { type: 'system', meta: { engine: 'kiro', kiro_status: 'no_credits' } };
    const { api, state, calls, fetchMock } = load({ chatMessages: [{ type: 'user', content: 'first' }, { type: 'system' }, { type: 'user', content: 'fix the login test' }, reply] });
    api.continueInOperator(reply);
    expect(calls.started).toEqual([{ engine: 'llm' }]);
    expect(state.chatInputValue).toBe('fix the login test');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('VTID-05003 wiring (source check)', () => {
  it('new threads apply the default and re-read the status; replies render the fallback', () => {
    const start = APP_JS.slice(APP_JS.indexOf('function startNewOperatorThread(opts) {'), APP_JS.indexOf('function startNewOperatorThread(opts) {') + 1500);
    expect(start).toContain('applyDefaultOperatorEngine(thread, opts && opts.engine);');
    expect(start).toContain('if (!(opts && opts.engine)) fetchKiroStatus(true);');
    expect(APP_JS).toContain('var kiroFallback = !isSent ? renderKiroFallbackAction(msg) : null;');
  });
  it('styles and cache-bust', () => {
    expect(CSS).toContain('.kiro-fallback-btn');
    const html = readFileSync(join(FE, 'index.html'), 'utf8');
    // Bumped past VTID-05003 by later Command Hub changes (VTID-05004); never back to an older build.
    expect(html).not.toContain('app.js?v=20261109-vtid-05003');
    expect(html).toMatch(/app\.js\?v=2026\d{4}-vtid-\d{5}/);
    expect(html).toMatch(/styles\.css\?v=2026\d{4}-vtid-\d{5}/);
  });
});
