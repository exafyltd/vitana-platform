/**
 * VTID-04984 — model selection inside Kiro threads (Command Hub).
 *
 * AC-1 a Kiro thread with a session shows Kiro's own models in a dropdown,
 *      with the current one selected; before a session exists there is none.
 * AC-2 picking a model POSTs it with the auth headers and updates the list
 *      from Kiro's answer; Kiro's own error message is shown as is.
 * AC-3 the list is re-read after each Kiro turn; each Kiro reply shows the
 *      Kiro model that answered.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const CSS = readFileSync(join(FE, 'styles.css'), 'utf8');
const BLOCK = APP_JS.slice(APP_JS.indexOf('var KIRO_TOOL_STATUS'), APP_JS.indexOf('function renderOperatorLiveTranscript() {'));

class El {
  tag: string; className = ''; textContent = ''; title = ''; value = ''; disabled = false; selected = false;
  children: El[] = []; attrs: Record<string, string> = {}; onchange: null | (() => void) = null;
  constructor(tag: string) { this.tag = tag; }
  appendChild(c: El) { this.children.push(c); if (c.selected) this.value = c.value; return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
}

const MODELS = [{ id: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced' }, { id: 'claude-opus', name: 'Claude Opus' }];

function load(fetchImpl: any, over: any = {}) {
  const state: any = { authToken: 'tok', operatorActiveThreadId: 'T1', chatSending: false, kiroModels: {}, chatLiveKiro: { text: '', tools: [], permissions: [] }, ...over };
  const calls = { renders: 0, toasts: [] as string[] };
  const fetchMock = jest.fn(fetchImpl);
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'state', 'document', 'fetch', 'buildContextHeaders', 'renderApp', 'saveOperatorThreadsIndex',
    'updateOperatorLiveTranscriptDom', 'showToast', 'console',
    BLOCK + '\nreturn { ensureKiroModels, renderKiroModelSelect, selectKiroModel, kiroModelName, applyKiroTurnFrame };',
  )(
    state, { createElement: (t: string) => new El(t) }, fetchMock, (h: any) => ({ Authorization: 'Bearer tok', ...h }),
    () => { calls.renders++; }, () => {}, () => {}, (m: string) => { calls.toasts.push(m); }, { warn: () => undefined },
  );
  return { api, state, calls, fetchMock };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('VTID-04984 Kiro model dropdown', () => {
  it('reads Kiro’s list once and shows it with the current model selected', async () => {
    const { api, state, fetchMock } = load(async () => ({ ok: true, json: async () => ({ ok: true, models: MODELS, current_model: 'claude-opus' }) }));
    expect(api.renderKiroModelSelect('T1')).toBeNull(); // list on its way
    await flush(); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/operator/kiro/sessions/T1/models');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    const select: El = api.renderKiroModelSelect('T1');
    expect(select.attrs['aria-label']).toBe('Kiro model');
    expect(select.children.map((o) => o.textContent)).toEqual(['Claude Sonnet', 'Claude Opus']);
    expect(select.value).toBe('claude-opus');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.kiroModels.T1.current).toBe('claude-opus');
  });

  it('shows nothing before the thread has a Kiro session', async () => {
    const { api } = load(async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'not_found' }) }));
    api.renderKiroModelSelect('T1');
    await flush(); await flush();
    expect(api.renderKiroModelSelect('T1')).toBeNull();
  });

  it('is disabled while a turn runs', () => {
    const { api } = load(async () => ({}), { chatSending: true, kiroModels: { T1: { loaded: true, models: MODELS, current: 'claude-sonnet' } } });
    expect(api.renderKiroModelSelect('T1').disabled).toBe(true);
  });

  it('picking a model POSTs it and takes Kiro’s updated list', async () => {
    const { api, state, fetchMock, calls } = load(async () => ({ ok: true, json: async () => ({ ok: true, models: MODELS, current_model: 'claude-opus' }) }),
      { kiroModels: { T1: { loaded: true, models: MODELS, current: 'claude-sonnet' } } });
    const select: El = api.renderKiroModelSelect('T1');
    select.value = 'claude-opus';
    select.onchange!();
    await flush(); await flush();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/operator/kiro/sessions/T1/model');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ model_id: 'claude-opus' });
    expect(state.kiroModels.T1.current).toBe('claude-opus');
    expect(calls.toasts).toEqual([]);
  });

  it('shows Kiro’s own error message when Kiro refuses', async () => {
    const { api, state, calls } = load(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'kiro_error', message: 'Model not available on your plan' }) }),
      { kiroModels: { T1: { loaded: true, models: MODELS, current: 'claude-sonnet' } } });
    await api.selectKiroModel('T1', 'claude-opus');
    expect(calls.toasts).toEqual(['Model not available on your plan']);
    expect(state.kiroModels.T1.current).toBe('claude-sonnet');
  });

  it('re-reads the list after each Kiro turn and names the model that answered', () => {
    const { api, state } = load(async () => ({}), { kiroModels: { T1: { loaded: true, models: MODELS, current: 'claude-sonnet' } } });
    expect(api.kiroModelName('claude-opus')).toBe('Claude Opus');
    expect(api.kiroModelName('unknown-id')).toBe('unknown-id');
    api.applyKiroTurnFrame({ event: 'kiro.turn_end', data: { stop_reason: 'end_turn' } });
    expect(state.kiroModels.T1).toBeUndefined();
  });
});

describe('VTID-04984 wiring (source check)', () => {
  it('the fixed Kiro control holds the dropdown and each Kiro reply shows its model', () => {
    expect(APP_JS).toContain('var modelSelect = renderKiroModelSelect(state.operatorActiveThreadId);');
    expect(APP_JS).toContain("if (msg.meta && msg.meta.engine === 'kiro' && msg.meta.kiro_model) {");
  });
  it('the dropdown has its styles and the cache-bust is bumped', () => {
    expect(CSS).toContain('.chat-kiro-model-select');
    const html = readFileSync(join(FE, 'index.html'), 'utf8');
    // Bumped past VTID-04984 by later Command Hub changes (VTID-04999); never back to an older build.
    expect(html).not.toContain('app.js?v=20261101-vtid-04984');
    expect(html).toMatch(/app\.js\?v=2026\d{4}-vtid-\d{5}/);
  });
});
