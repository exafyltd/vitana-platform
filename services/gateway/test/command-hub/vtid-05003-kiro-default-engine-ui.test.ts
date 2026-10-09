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
    BLOCK + '\nreturn { fetchKiroStatus, applyDefaultOperatorEngine, renderKiroFallbackAction, continueInOperator, setActiveOperatorEngine, operatorThreadEngine };',
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
    expect(html).toContain('app.js?v=20261109-vtid-05003');
    expect(html).toContain('styles.css?v=20261109-vtid-05003');
  });
});
