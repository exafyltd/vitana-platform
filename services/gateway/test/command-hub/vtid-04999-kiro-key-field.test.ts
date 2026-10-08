/**
 * VTID-04999 — the Kiro API key field in the Kiro workspace card (Command Hub).
 *
 * AC-1 not linked → a password field + Link; linked → "linked · date" + Replace + Revoke.
 * AC-2 Link PUTs the key once with the auth headers, clears the field at once,
 *      and keeps the key nowhere in state.
 * AC-3 Revoke asks first, DELETEs, and shows "not linked".
 * AC-4 a deployment without the runner shows "not available", no field.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const CSS = readFileSync(join(FE, 'styles.css'), 'utf8');
const BLOCK = APP_JS.slice(APP_JS.indexOf('var KIRO_TOOL_STATUS'), APP_JS.indexOf('function renderOperatorLiveTranscript() {'));

class El {
  tag: string; className = ''; textContent = ''; title = ''; value = ''; type = ''; placeholder = ''; autocomplete = '';
  disabled = false; spellcheck = true; children: El[] = []; attrs: Record<string, string> = {};
  onclick: null | (() => void) = null; onsubmit: null | ((e: any) => void) = null;
  constructor(tag: string) { this.tag = tag; }
  appendChild(c: El) { this.children.push(c); return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  all(): El[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  find(cls: string): El[] { return this.all().filter((e) => e.className.split(' ').includes(cls)); }
  text(): string { return this.all().map((e) => e.textContent).join(' '); }
}

function load(fetchImpl: any, over: any = {}, confirmAnswer = true) {
  const state: any = { authToken: 'tok', kiroStatus: { enabled: true }, operatorThreads: [], chatMessages: [], chatSending: false, kiroModels: {}, ...over };
  const calls = { renders: 0, toasts: [] as string[], confirms: 0 };
  const fetchMock = jest.fn(fetchImpl);
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'state', 'document', 'fetch', 'buildContextHeaders', 'renderApp', 'saveOperatorThreadsIndex',
    'updateOperatorLiveTranscriptDom', 'showToast', 'confirm', 'console',
    BLOCK + '\nreturn { renderKiroThreadPanel, renderKiroKeyControls, kiroKeyStatusText, linkKiroKey, revokeKiroKey, kiroKeyInput, fetchKiroKeyStatus };',
  )(
    state, { createElement: (t: string) => new El(t) }, fetchMock, (h: any) => ({ Authorization: 'Bearer tok', ...h }),
    () => { calls.renders++; }, () => {}, () => {}, (m: string) => { calls.toasts.push(m); },
    () => { calls.confirms++; return confirmAnswer; }, { warn: () => undefined },
  );
  return { api, state, calls, fetchMock };
}

const ok = (body: any) => async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ...body }) });

describe('VTID-04999 Kiro key field', () => {
  it('reads the caller’s key status once and shows it in the card', async () => {
    const { api, state, fetchMock } = load(ok({ linked: false, updated_at: null }));
    await api.fetchKiroKeyStatus();
    await api.fetchKiroKeyStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/operator/kiro/key');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(state.kiroKey).toEqual({ loaded: true, linked: false, updated_at: null });
    expect(api.renderKiroThreadPanel().text()).toMatch(/Your Kiro API key not linked/);
  });

  it('not linked → a password field and Link', () => {
    const { api } = load(ok({}), { kiroKey: { loaded: true, linked: false } });
    const box: El = api.renderKiroKeyControls();
    const input = box.find('kiro-key-input')[0];
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(input.attrs['aria-label']).toBe('Kiro API key');
    expect(box.find('kiro-key-btn--primary')[0].textContent).toBe('Link');
    expect(box.find('kiro-key-btn--danger')).toHaveLength(0);
  });

  it('Link sends the key once, clears the field at once and keeps it nowhere in state', async () => {
    const { api, state, fetchMock, calls } = load(ok({ linked: true, updated_at: '2026-10-08T10:00:00.000Z' }), { kiroKey: { loaded: true, linked: false } });
    const input: El = api.kiroKeyInput();
    input.value = '  ksk_my_secret_key  ';
    const pending = api.linkKiroKey();
    expect(input.value).toBe('');
    await pending;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/operator/kiro/key');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ key: 'ksk_my_secret_key' });
    expect(state.kiroKey).toEqual({ loaded: true, linked: true, updated_at: '2026-10-08T10:00:00.000Z' });
    expect(JSON.stringify(state)).not.toContain('ksk_my_secret_key');
    expect(calls.toasts).toEqual(['Kiro API key linked']);
  });

  it('an empty field sends nothing; a refused key says so', async () => {
    const empty = load(ok({}), { kiroKey: { loaded: true, linked: false } });
    await empty.api.linkKiroKey();
    expect(empty.fetchMock).not.toHaveBeenCalled();
    const bad = load(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'INVALID_KEY' }) }), { kiroKey: { loaded: true, linked: false } });
    bad.api.kiroKeyInput().value = 'x';
    await bad.api.linkKiroKey();
    expect(bad.calls.toasts).toEqual(['That does not look like a Kiro API key']);
    expect(bad.state.kiroKey.linked).toBe(false);
  });

  it('linked → the date, Replace and Revoke; Replace shows the field again', () => {
    const { api, state } = load(ok({}), { kiroKey: { loaded: true, linked: true, updated_at: '2026-10-08T10:00:00.000Z' } });
    expect(api.kiroKeyStatusText()).toMatch(/^linked · /);
    const box: El = api.renderKiroKeyControls();
    expect(box.find('kiro-key-input')).toHaveLength(0);
    const [replace, revoke] = box.find('kiro-key-btn');
    expect([replace.textContent, revoke.textContent]).toEqual(['Replace', 'Revoke']);
    replace.onclick!();
    expect(state.kiroKey.editing).toBe(true);
    expect(api.renderKiroKeyControls().find('kiro-key-btn--primary')[0].textContent).toBe('Replace');
  });

  it('Revoke asks first, DELETEs and shows not linked', async () => {
    const { api, state, fetchMock, calls } = load(ok({ linked: false }), { kiroKey: { loaded: true, linked: true } });
    await api.revokeKiroKey();
    expect(calls.confirms).toBe(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(state.kiroKey).toEqual({ loaded: true, linked: false, updated_at: null });
    const no = load(ok({}), { kiroKey: { loaded: true, linked: true } }, false);
    await no.api.revokeKiroKey();
    expect(no.fetchMock).not.toHaveBeenCalled();
  });

  it('without a runner the card says so and shows no field', async () => {
    const { api, state } = load(async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: 'kiro_runner_not_configured' }) }));
    await api.fetchKiroKeyStatus();
    expect(state.kiroKey.unavailable).toBe(true);
    expect(api.renderKiroKeyControls()).toBeNull();
    expect(api.kiroKeyStatusText()).toBe('not available on this deployment');
  });
});

describe('VTID-04999 wiring (source check)', () => {
  it('styles exist, no inline styles, and the cache-bust is bumped', () => {
    for (const cls of ['.kiro-key-input', '.kiro-key-btn--primary', '.kiro-key-btn--danger', '.kiro-key-note', '.kiro-key-form']) expect(CSS).toContain(cls);
    const keyBlock = BLOCK.slice(BLOCK.indexOf('var _kiroKeyRequested'), BLOCK.indexOf('function renderKiroThreadPanel'));
    expect(keyBlock).not.toMatch(/\.style\b|style=/);
    expect(keyBlock).not.toMatch(/localStorage|sessionStorage/);
    const html = readFileSync(join(FE, 'index.html'), 'utf8');
    expect(html).toContain('app.js?v=20261108-vtid-04999');
    expect(html).toContain('styles.css?v=20261108-vtid-04999');
  });
});
