/**
 * VTID-05071 — a missed Allow is visible and honestly labelled (kiro-console.js).
 *
 * AC-C6 while a run of a thread waits on an unanswered approval card, the sidebar gets a
 *       "Needs your OK" badge (app.js hook) and the tab title is prefixed "(!) "; both clear
 *       once the card is answered.
 * AC-C7 a run that ended refused/incomplete right after an approval timed out says
 *       "Stopped — your approval for "<title>" timed out." with Continue (newest run only);
 *       any other refusal keeps "Kiro stopped early: <reason>". A past run that stopped early
 *       loads its events so the label is right after a reload.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { FakeEl, fakeDocument } from './fake-dom';
import { readCommandHubBundle } from './bundle';

const FE = join(__dirname, '../../src/frontend/command-hub');
const MODULE = readFileSync(join(FE, 'kiro-console.js'), 'utf8');
const KCSS = readFileSync(join(FE, 'kiro-console.css'), 'utf8');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const INDEX_HTML = readFileSync(join(FE, 'index.html'), 'utf8');
const GUARD = readFileSync(join(__dirname, '../../../../scripts/ci/command-hub-ownership-guard.js'), 'utf8');

const THREAD = 'a5071000-0000-4000-8000-000000000001';
const R1 = 'b5071000-0000-4000-8000-000000000001';
const R2 = 'b5071000-0000-4000-8000-000000000002';

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => 'application/json' } };
}

/** An SSE body that replays the given frames and ends. */
function replay(frames: Array<{ id: number; event: string; data: any }>) {
  const enc = new TextEncoder();
  const chunks = frames.map((f) => enc.encode(`id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify({ seq: f.id, ...f.data })}\n\n`));
  return { ok: true, status: 200, body: { getReader: () => ({ read: () => Promise.resolve(chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } };
}

/** An SSE body that stays open after the given frames (a live run). */
function live(frames: Array<{ id: number; event: string; data: any }>) {
  const enc = new TextEncoder();
  const chunks = frames.map((f) => enc.encode(`id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify({ seq: f.id, ...f.data })}\n\n`));
  let push: ((v: any) => void) | null = null;
  return {
    res: { ok: true, status: 200, body: { getReader: () => ({ read: () => (chunks.length ? Promise.resolve({ done: false, value: chunks.shift() }) : new Promise((r) => { push = r; })) }) } },
    send(f: { id: number; event: string; data: any }) { const p = push; push = null; p?.({ done: false, value: enc.encode(`id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify({ seq: f.id, ...f.data })}\n\n`) }); },
  };
}

function load(routes: Record<string, (url: string) => any>) {
  const win: any = { document: fakeDocument(), TextDecoder, AbortController, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} } };
  win.document.title = 'Vitana Command Hub';
  const state = { renders: 0 };
  // eslint-disable-next-line no-new-func
  new Function('window', MODULE)(win);
  const KC = win.KiroConsole;
  KC.init({
    fetch: async (url: string, init: any = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const path = url.split('?')[0];
      const key = Object.keys(routes).find((k) => k === `${method} ${path}`);
      return key ? routes[key](url) : json(404, { ok: false });
    },
    headers: (extra: any) => ({ Authorization: 'Bearer tok', ...(extra || {}) }),
    renderApp: () => { state.renders += 1; },
    activeThreadId: () => THREAD,
    getDraft: () => '', setDraft: () => {},
    renderEmptyPanel: () => new FakeEl('div'),
    onSent: () => {}, onRunFinished: () => {},
    kiroModelName: (id: string) => id,
    setTimeout: () => 0, clearTimeout: () => {},
    createObjectURL: () => 'blob:x', revokeObjectURL: () => {},
    now: () => Date.parse('2026-10-11T12:00:00Z'),
  });
  return { KC, win, state };
}

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const row = (over: Record<string, any>) => ({
  id: R1, thread_id: THREAD, user_id: 'u1', status: 'completed', message: 'm', reply: null, stop_reason: null,
  kiro_model: null, workspace: null, error: null, created_at: '2026-10-11T11:00:00Z', ...over,
});
const SHELL = 'Running: cd /tmp && grep -noE "/api/v1/[a-zA-Z0-9/_:{}-]+" app.js | grep -iE "operator|approv|execution|deploy|oasis" | sort -u | head -60';

describe('VTID-05071 AC-C7: an expired approval is named, not called a refusal', () => {
  it('a past run that stopped after an approval timed out says so, with Continue on the newest run', async () => {
    const h = load({
      'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [row({ id: R1, status: 'refused', stop_reason: 'refusal', message: 'agreed' })] }),
      [`GET /api/v1/operator/kiro/runs/${R1}/stream`]: () => replay([
        { id: 1, event: 'run.status', data: { status: 'running' } },
        { id: 2, event: 'kiro.permission_request', data: { request_id: 'q1', title: SHELL, kind: 'other' } },
        { id: 3, event: 'kiro.permission_answer', data: { request_id: 'q1', allow: false, by: 'timeout' } },
        { id: 4, event: 'kiro.turn_end', data: { stop_reason: 'refusal' } },
        { id: 5, event: 'run.status', data: { status: 'refused', stop_reason: 'refusal' } },
      ]),
    });
    h.KC.renderPane(THREAD, { legacyMessages: [] });
    await flush();
    const p: FakeEl = h.KC.renderPane(THREAD, { legacyMessages: [] });
    const marker = p.one('kiro-run-marker--approval-timeout');
    const text = marker.one('kiro-run-marker-text').textContent;
    expect(text.startsWith('Stopped — your approval for "Running: cd /tmp && grep')).toBe(true);
    expect(text.endsWith('…" timed out.')).toBe(true); // title cut to 80 chars
    expect(text.length).toBeLessThanOrEqual('Stopped — your approval for "" timed out.'.length + 80);
    expect(marker.one('kiro-continue-btn').textContent).toBe('Continue');
    expect(p.find('kiro-stopped-early')).toHaveLength(0);
  });

  it('a refusal without a timed-out approval keeps the old label; only the newest run gets Continue', async () => {
    const h = load({
      'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [
        row({ id: R2, status: 'refused', stop_reason: 'refusal', message: 'second', created_at: '2026-10-11T11:10:00Z' }),
        row({ id: R1, status: 'refused', stop_reason: 'refusal', message: 'first', created_at: '2026-10-11T11:00:00Z' }),
      ] }),
      [`GET /api/v1/operator/kiro/runs/${R1}/stream`]: () => replay([
        { id: 1, event: 'kiro.permission_request', data: { request_id: 'q1', title: 'Running: npm test', kind: 'execute' } },
        { id: 2, event: 'kiro.permission_answer', data: { request_id: 'q1', allow: false, by: 'timeout' } },
        { id: 3, event: 'run.status', data: { status: 'refused', stop_reason: 'refusal' } },
      ]),
      [`GET /api/v1/operator/kiro/runs/${R2}/stream`]: () => replay([
        { id: 1, event: 'kiro.permission_request', data: { request_id: 'q2', title: 'Running: rm -rf x', kind: 'execute' } },
        { id: 2, event: 'kiro.permission_answer', data: { request_id: 'q2', allow: false, by: 'user' } },
        { id: 3, event: 'run.status', data: { status: 'refused', stop_reason: 'refusal' } },
      ]),
    });
    h.KC.renderPane(THREAD, { legacyMessages: [] });
    await flush();
    const p: FakeEl = h.KC.renderPane(THREAD, { legacyMessages: [] });
    const runs = p.find('kiro-run');
    // Older run: timed out → named, but no Continue (not the newest).
    expect(runs[0].one('kiro-run-marker-text').textContent).toBe('Stopped — your approval for "Running: npm test" timed out.');
    expect(runs[0].find('kiro-continue-btn')).toHaveLength(0);
    // Newest run: the user denied → the old label stays.
    expect(runs[1].one('kiro-stopped-early').textContent).toBe('Kiro stopped early: refusal');
  });
});

describe('VTID-05071 AC-C6: "Needs your OK" and the tab title while a card waits', () => {
  it('shows the badge and "(!) " while the card is open, clears both when it is answered', async () => {
    const stream = live([
      { id: 1, event: 'run.status', data: { status: 'running' } },
      { id: 2, event: 'kiro.permission_request', data: { request_id: 'q1', title: 'Running: npm test', kind: 'execute' } },
      { id: 3, event: 'run.status', data: { status: 'waiting_permission' } },
    ]);
    const h = load({
      'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [row({ id: R1, status: 'waiting_permission' })] }),
      [`GET /api/v1/operator/kiro/runs/${R1}/stream`]: () => stream.res,
    });
    expect(h.KC.waitingBadge(THREAD).className).toContain('kiro-waiting-badge--none');
    h.KC.renderPane(THREAD, { legacyMessages: [] });
    await flush();
    expect(h.KC.isThreadWaiting(THREAD)).toBe(true);
    const badge = h.KC.waitingBadge(THREAD);
    expect(badge.textContent).toBe('Needs your OK');
    expect(badge.className).toBe('kiro-waiting-badge');
    expect(badge.getAttribute('role')).toBe('status');
    expect(h.win.document.title).toBe('(!) Vitana Command Hub');

    stream.send({ id: 4, event: 'kiro.permission_answer', data: { request_id: 'q1', allow: true, by: 'user' } });
    stream.send({ id: 5, event: 'run.status', data: { status: 'running' } });
    await flush();
    h.KC.renderPane(THREAD, { legacyMessages: [] });
    expect(h.KC.isThreadWaiting(THREAD)).toBe(false);
    expect(h.KC.waitingBadge(THREAD).className).toContain('kiro-waiting-badge--none');
    expect(h.win.document.title).toBe('Vitana Command Hub');
  });
});

describe('VTID-05071 wiring', () => {
  it('app.js adds the badge to each thread row next to the pipeline-tree dot', () => {
    // VTID-05073: the thread-row badge wiring moved to operator-console.js (renderOperatorThreadRow).
    expect(readCommandHubBundle()).toContain('if (window.KiroConsole && window.KiroConsole.waitingBadge) meta.appendChild(window.KiroConsole.waitingBadge(thread.id));');
  });
  it('styles: badge, hidden empty badge, the timeout marker, and a reduced-motion still', () => {
    expect(KCSS).toMatch(/\.kiro-waiting-badge \{[^}]*animation: kiro-waiting-pulse/);
    expect(KCSS).toMatch(/\.kiro-waiting-badge--none \{\s*display: none;/);
    expect(KCSS).toMatch(/\.kiro-run-marker--approval-timeout \{/);
    expect(KCSS).toMatch(/prefers-reduced-motion[\s\S]*\.kiro-waiting-badge \{ animation: none;/);
  });
  it('index.html serves the module at the new version; the ownership guard allowlists VTID-05071', () => {
    expect(INDEX_HTML).toContain('/command-hub/kiro-console.js?v=20261114-vtid-05071');
    expect(INDEX_HTML).toContain('/command-hub/app.js?v=20261121-vtid-05082');
    expect(GUARD).toMatch(/ALLOWED_VTID_PATTERN = \/[^\n]*VTID-05071\|/);
  });
});
