/**
 * VTID-05067 — the Kiro console module (kiro-console.js), Phase 2 of the sparred
 * "Kiro on one server-side run record" plan + the image-paste addendum.
 *
 * AC-1 a Kiro thread renders its runs: message, reply, collapsible steps, how a run
 *      ended (stopped early / failed / stopped / interrupted), the live run with Stop.
 * AC-2 the live run streams from /runs/:id/stream?after_seq= and a dropped stream
 *      reattaches from the last seen seq (nothing lost, nothing twice), with backoff.
 * AC-3 Send while a run runs queues the message (queued item + Cancel); 409 queue_full
 *      is shown inline and the draft is kept.
 * AC-4 Stop cancels the current run; Continue on an interrupted run starts a new one.
 * AC-5 approval cards answer through /kiro/permissions/:id.
 * AC-6 images: paste (Ctrl/Cmd+V), drop and the paperclip add chips; remove ✕; text
 *      paste is unchanged; Send uploads to /operator/media and starts the run with the
 *      media ids; type / size / count are checked before upload.
 * AC-7 Kiro without image input: "Kiro can't see images in this version".
 * AC-8 wiring: index.html loads the module (external, before app.js, ?v= bumped),
 *      every class it uses is styled, no inline styles / innerHTML.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { FakeEl, fakeDocument } from './fake-dom';

const FE = join(__dirname, '../../src/frontend/command-hub');
const MODULE = readFileSync(join(FE, 'kiro-console.js'), 'utf8');
const KCSS = readFileSync(join(FE, 'kiro-console.css'), 'utf8');
const CSS = readFileSync(join(FE, 'styles.css'), 'utf8');
const INDEX_HTML = readFileSync(join(FE, 'index.html'), 'utf8');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');

const THREAD = 'a5067000-0000-4000-8000-000000000001';
const R1 = 'b5067000-0000-4000-8000-000000000001';
const R2 = 'b5067000-0000-4000-8000-000000000002';
const R3 = 'b5067000-0000-4000-8000-000000000003';
const R4 = 'b5067000-0000-4000-8000-000000000004';

// ---------------------------------------------------------------------------
// Harness: the module on a fake window, a scripted fetch, manual timers
// ---------------------------------------------------------------------------

interface Stream { push(frame: { id?: number; event: string; data: any } | string): void; end(): void; body: any }
function sseStream(): Stream {
  const enc = new TextEncoder();
  const queue: Array<{ done: boolean; value?: Uint8Array }> = [];
  let waiting: ((v: any) => void) | null = null;
  const deliver = (item: { done: boolean; value?: Uint8Array }) => {
    if (waiting) { const w = waiting; waiting = null; w(item); } else queue.push(item);
  };
  return {
    push(frame) {
      const text = typeof frame === 'string' ? frame
        : `${frame.id !== undefined ? `id: ${frame.id}\n` : ''}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
      deliver({ done: false, value: enc.encode(text) });
    },
    end() { deliver({ done: true }); },
    body: { getReader: () => ({ read: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => { waiting = r; })) }) },
  };
}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => 'application/json' } };
}

type Route = (url: string, init: any) => any;

function load(opts: { routes?: Record<string, Route>; draft?: string; active?: string } = {}) {
  const calls: Array<{ method: string; url: string; init: any }> = [];
  const timers: Array<{ fn: () => void; ms: number; id: number; cancelled?: boolean }> = [];
  let nextTimer = 1;
  const state = { draft: opts.draft ?? '', renders: 0, sent: [] as string[], finished: [] as string[], revoked: [] as string[], active: opts.active ?? THREAD };
  const routes: Record<string, Route> = { ...(opts.routes || {}) };
  const fetchImpl = async (url: string, init: any = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url, init });
    const path = url.split('?')[0];
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      if (m !== method) return false;
      if (p.endsWith('*')) return path.startsWith(p.slice(0, -1));
      return p === path || p === url;
    });
    if (!key) return json(404, { ok: false, error: 'no_route_in_test' });
    return routes[key](url, init);
  };
  const win: any = { document: fakeDocument(), TextDecoder, AbortController, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} } };
  // eslint-disable-next-line no-new-func
  new Function('window', MODULE)(win);
  const KC = win.KiroConsole;
  KC.init({
    fetch: fetchImpl,
    headers: (extra: any) => ({ Authorization: 'Bearer tok', ...(extra || {}) }),
    renderApp: () => { state.renders += 1; },
    activeThreadId: () => state.active,
    getDraft: () => state.draft,
    setDraft: (v: string) => { state.draft = v; },
    renderEmptyPanel: () => { const e = new FakeEl('div'); e.className = 'kiro-panel'; e.textContent = 'Kiro workspace'; return e; },
    onSent: (_t: string, text: string) => { state.sent.push(text); },
    onRunFinished: (t: string) => { state.finished.push(t); },
    kiroModelName: (id: string) => `Model(${id})`,
    setTimeout: (fn: () => void, ms: number) => { const id = nextTimer++; timers.push({ fn, ms, id }); return id; },
    clearTimeout: (id: number) => { const t = timers.find((x) => x.id === id); if (t) t.cancelled = true; },
    createObjectURL: (f: any) => `blob:${f.name}`,
    revokeObjectURL: (u: string) => { state.revoked.push(u); },
    now: () => Date.parse('2026-10-11T09:00:00Z'),
  });
  /** Run the timers due now (one round; re-armed ones wait for the next call). */
  const runTimers = (filter?: (ms: number) => boolean) => {
    const due = timers.splice(0).filter((t) => !t.cancelled);
    const keep: typeof due = [];
    for (const t of due) { if (!filter || filter(t.ms)) t.fn(); else keep.push(t); }
    timers.push(...keep);
  };
  return { KC, win, calls, timers, runTimers, state, routes };
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function pane(h: ReturnType<typeof load>): FakeEl {
  return h.KC.renderPane(THREAD, { legacyMessages: [] });
}

const row = (over: Record<string, any>) => ({
  id: R1, thread_id: THREAD, user_id: 'u1', status: 'completed', message: 'm', reply: null, stop_reason: null,
  kiro_model: null, workspace: null, error: null, pending_permission: null, created_at: '2026-10-11T08:00:00Z', ...over,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('VTID-05067 foldRun / parseSse', () => {
  it('folds a run\'s events into text, steps (tools + approval cards with answers), status and images', () => {
    const h = load();
    const { foldRun } = h.KC._internals;
    const v = foldRun([
      { seq: 1, type: 'run.status', data: { status: 'running' } },
      { seq: 2, type: 'kiro.images', data: { count: 2, delivery: 'unsupported', sent: 0 } },
      { seq: 3, type: 'kiro.message_chunk', data: { text: 'Looking ' } },
      { seq: 4, type: 'kiro.tool_call', data: { tool_call_id: 't1', title: 'Read app.js', kind: 'read', status: 'pending' } },
      { seq: 5, type: 'kiro.tool_update', data: { tool_call_id: 't1', status: 'completed' } },
      { seq: 6, type: 'kiro.permission_request', data: { request_id: 'q1', title: 'Edit app.js', kind: 'edit' } },
      { seq: 7, type: 'kiro.permission_answer', data: { request_id: 'q1', allow: false, by: 'timeout' } },
      { seq: 8, type: 'kiro.message_chunk', data: { text: 'done' } },
      { seq: 9, type: 'run.status', data: { status: 'incomplete', stop_reason: 'max_tokens' } },
    ]);
    expect(v.text).toBe('Looking done');
    expect(v.steps).toEqual([
      expect.objectContaining({ kind: 'tool', title: 'Read app.js', status: 'ok' }),
      expect.objectContaining({ kind: 'permission', title: 'Edit app.js', answer: 'expired' }),
    ]);
    expect(v).toMatchObject({ status: 'incomplete', stopReason: 'max_tokens', images: { count: 2, delivery: 'unsupported', sent: 0 } });
  });

  it('parses SSE frames with id/event/data, skips heartbeats, keeps a partial frame for later', () => {
    const { parseSse } = load().KC._internals;
    const r = parseSse(': heartbeat\n\nid: 4\nevent: kiro.message_chunk\ndata: {"seq":4,"text":"hi"}\n\nid: 5\nevent: run.st');
    expect(r.frames).toEqual([{ id: 4, event: 'kiro.message_chunk', data: { seq: 4, text: 'hi' } }]);
    expect(r.rest).toBe('id: 5\nevent: run.st');
  });
});

// ---------------------------------------------------------------------------
// AC-1 / AC-2: runs list, past runs, the live run, reattach
// ---------------------------------------------------------------------------

describe('VTID-05067 a Kiro thread is shown as its runs', () => {
  it('lists the thread\'s runs and renders past runs + the live run (steps, reply, markers, Stop)', async () => {
    const live = sseStream();
    const h = load({
      routes: {
        'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [
          row({ id: R3, status: 'running', message: 'now this', created_at: '2026-10-11T08:30:00Z' }),
          row({ id: R2, status: 'refused', message: 'second', reply: 'I will not do that.', stop_reason: 'refusal', created_at: '2026-10-11T08:20:00Z' }),
          row({ id: R1, status: 'completed', message: 'first', reply: 'Done: the upload has a size limit.', kiro_model: 'claude-sonnet', created_at: '2026-10-11T08:10:00Z' }),
        ] }),
        [`GET /api/v1/operator/kiro/runs/${R3}/stream`]: () => ({ ok: true, status: 200, body: live.body }),
      },
    });
    pane(h);
    await flush();
    expect(h.calls[0].url).toBe(`/api/v1/operator/kiro/runs?thread_id=${THREAD}`);
    expect(h.calls[0].init.headers.Authorization).toBe('Bearer tok');
    live.push({ id: 1, event: 'run.status', data: { seq: 1, status: 'running' } });
    live.push({ id: 2, event: 'kiro.tool_call', data: { seq: 2, tool_call_id: 't1', title: 'Search code', kind: 'search', status: 'pending' } });
    live.push({ id: 3, event: 'kiro.message_chunk', data: { seq: 3, text: 'Working on it' } });
    live.push({ id: 4, event: 'kiro.permission_request', data: { seq: 4, request_id: 'q1', title: 'Edit services/a.ts', kind: 'edit' } });
    live.push({ id: 5, event: 'run.status', data: { seq: 5, status: 'waiting_permission' } });
    await flush();
    const p = pane(h);
    const runs = p.find('kiro-run');
    expect(runs.map((r) => r.getAttribute('data-run-id'))).toEqual([R1, R2, R3]);
    // Past run 1: message, reply, model badge, collapsed steps (loaded on open).
    expect(runs[0].one('kiro-run-message').textContent).toBe('first');
    expect(runs[0].one('kiro-run-reply').textContent).toBe('Done: the upload has a size limit.');
    expect(runs[0].one('message-cost-badge').textContent).toBe('Kiro · Model(claude-sonnet)');
    expect(runs[0].one('kiro-run-steps').open).toBeFalsy();
    expect(runs[0].one('kiro-run-steps-summary').textContent).toBe('Show steps');
    // Past run 2: stopped early.
    expect(runs[1].one('kiro-stopped-early').textContent).toBe('Kiro stopped early: refusal');
    // Live run 3: steps open, live text, the open approval card outside the steps, Stop.
    expect(runs[2].className).toContain('kiro-run--waiting_permission');
    expect(runs[2].one('kiro-run-steps').open).toBe(true);
    expect(runs[2].one('kiro-run-steps').find('chat-tool-activity-line--running')[0].textContent).toBe('… Search code (running)');
    expect(runs[2].one('kiro-run-reply--live').textContent).toBe('Working on it');
    const card = runs[2].children.find((c) => c.className.startsWith('kiro-approval'))!;
    expect(card.textContent).toContain('Kiro wants to edit: Edit services/a.ts');
    expect(card.find('kiro-approval-btn').map((b) => b.textContent)).toEqual(['Allow', 'Deny']);
    expect(runs[2].find('kiro-stop-btn')).toHaveLength(1);
    // The thread is busy → the sidebar spinner hook says so.
    expect(h.KC.isThreadBusy(THREAD)).toBe(true);
    expect(h.KC.hasRuns(THREAD)).toBe(true);
  });

  it('opening a past run\'s steps replays its events once from the store', async () => {
    const replay = sseStream();
    const h = load({
      routes: {
        'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [row({ id: R1, status: 'completed', reply: 'ok' })] }),
        [`GET /api/v1/operator/kiro/runs/${R1}/stream`]: () => ({ ok: true, status: 200, body: replay.body }),
      },
    });
    pane(h);
    await flush();
    const steps = pane(h).one('kiro-run-steps');
    steps.open = true;
    steps.dispatch('toggle');
    expect(h.calls.filter((c) => c.url.includes('/stream')).map((c) => c.url)).toEqual([`/api/v1/operator/kiro/runs/${R1}/stream?after_seq=0`]);
    replay.push({ id: 1, event: 'run.status', data: { status: 'running' } });
    replay.push({ id: 2, event: 'kiro.tool_call', data: { tool_call_id: 't', title: 'Read a.ts', kind: 'read', status: 'completed' } });
    replay.push({ id: 3, event: 'run.status', data: { status: 'completed' } });
    replay.end();
    await flush();
    const again = pane(h).one('kiro-run-steps');
    expect(again.open).toBe(true);
    expect(again.one('kiro-run-steps-summary').textContent).toBe('1 step');
    expect(again.find('chat-tool-activity-line--ok')[0].textContent).toBe('✓ Read a.ts');
  });

  it('a dropped stream reattaches with after_seq after a backoff: nothing lost, nothing twice; the end reloads the run', async () => {
    const s1 = sseStream();
    const s2 = sseStream();
    const streams = [s1, s2];
    const h = load({
      routes: {
        'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [row({ id: R1, status: 'running', message: 'go' })] }),
        [`GET /api/v1/operator/kiro/runs/${R1}/stream`]: () => ({ ok: true, status: 200, body: streams.shift()!.body }),
        [`GET /api/v1/operator/kiro/runs/${R1}`]: () => json(200, { ok: true, run: row({ id: R1, status: 'completed', message: 'go', reply: 'one two' }) }),
      },
    });
    pane(h);
    await flush();
    s1.push({ id: 1, event: 'run.status', data: { status: 'running' } });
    s1.push({ id: 2, event: 'kiro.message_chunk', data: { text: 'one ' } });
    s1.end(); // the connection drops mid-run
    await flush();
    // The reconnect backoff (1 s first) — not the 10 s list refresh.
    const backoff = h.timers.filter((t) => !t.cancelled && t.ms >= 1000 && t.ms < 10_000);
    expect(backoff.map((t) => t.ms)).toEqual([1000]);
    expect(pane(h).find('kiro-reconnecting')).toHaveLength(1);
    h.runTimers((ms) => ms >= 1000 && ms < 10_000);
    await flush();
    const streamUrls = h.calls.filter((c) => c.url.includes('/stream')).map((c) => c.url);
    expect(streamUrls).toEqual([`/api/v1/operator/kiro/runs/${R1}/stream?after_seq=0`, `/api/v1/operator/kiro/runs/${R1}/stream?after_seq=2`]);
    // The server never resends, but a duplicate would be dropped anyway.
    s2.push({ id: 2, event: 'kiro.message_chunk', data: { text: 'one ' } });
    s2.push({ id: 3, event: 'kiro.message_chunk', data: { text: 'two' } });
    s2.push({ id: 4, event: 'run.status', data: { status: 'completed' } });
    s2.end();
    await flush(12);
    const t = h.KC._internals.threadState(THREAD);
    expect(t.byId[R1].events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(t.byId[R1].view.text).toBe('one two');
    expect(h.state.finished).toEqual([THREAD]);
    const p = pane(h);
    expect(p.one('kiro-run-reply').textContent).toBe('one two');
    expect(p.find('kiro-stop-btn')).toHaveLength(0);
    expect(h.KC.isThreadBusy(THREAD)).toBe(false);
  });

  it('a reload (fresh module state) lists the runs again and reattaches from the start of the live run', async () => {
    const live = sseStream();
    const h = load({
      routes: {
        'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [row({ id: R1, status: 'waiting_permission' })] }),
        [`GET /api/v1/operator/kiro/runs/${R1}/stream`]: () => ({ ok: true, status: 200, body: live.body }),
      },
    });
    pane(h);
    await flush();
    expect(h.calls.map((c) => c.url)).toEqual([`/api/v1/operator/kiro/runs?thread_id=${THREAD}`, `/api/v1/operator/kiro/runs/${R1}/stream?after_seq=0`]);
    expect(h.calls[1].init.headers.Accept).toBe('text/event-stream');
  });

  it('shows earlier turns (before the oldest run) through the host, then the empty Kiro card when there is nothing', async () => {
    const h = load({ routes: { 'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [] }) } });
    pane(h);
    await flush();
    expect(pane(h).find('kiro-panel')).toHaveLength(1);
    const seen: any[] = [];
    h.KC.init({ renderLegacyMessage: (region: FakeEl, m: any) => { seen.push(m.content); const b = new FakeEl('div'); b.className = 'legacy'; region.appendChild(b); } });
    const p = h.KC.renderPane(THREAD, { legacyMessages: [{ type: 'user', content: 'old q', ts: 1 }, { type: 'system', content: 'old a', ts: 2 }] });
    expect(seen).toEqual(['old q', 'old a']);
    expect(p.find('kiro-panel')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-3 / AC-4 / AC-5: queue, cancel, stop, continue, approval
// ---------------------------------------------------------------------------

describe('VTID-05067 composer, queue, Stop, Continue, approvals', () => {
  function busyThread(extraRoutes: Record<string, Route> = {}) {
    const live = sseStream();
    return {
      live,
      h: load({
        draft: 'and then add a test',
        routes: {
          'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [row({ id: R1, status: 'running', message: 'first' })] }),
          [`GET /api/v1/operator/kiro/runs/${R1}/stream`]: () => ({ ok: true, status: 200, body: live.body }),
          ...extraRoutes,
        },
      }),
    };
  }

  it('the composer stays enabled while a run runs; Send queues the message, shown with Cancel', async () => {
    const queued = sseStream();
    const { h } = busyThread({
      'POST /api/v1/operator/kiro/runs': () => json(202, { ok: true, run_id: R2, status: 'queued' }),
      [`GET /api/v1/operator/kiro/runs/${R2}/stream`]: () => ({ ok: true, status: 200, body: queued.body }),
      [`POST /api/v1/operator/kiro/runs/${R2}/cancel`]: () => json(200, { ok: true, status: 'cancelled' }),
    });
    pane(h);
    await flush();
    const p = pane(h);
    const send = p.one('kiro-send-btn');
    expect(send.disabled).toBe(false);
    expect(send.title).toMatch(/waits in the queue/);
    expect(p.one('kiro-composer-textarea').placeholder).toMatch(/waits in the queue/);
    send.click();
    await flush();
    const post = h.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/operator/kiro/runs')!;
    expect(JSON.parse(post.init.body)).toEqual({ thread_id: THREAD, message: 'and then add a test', engine: 'kiro', attachments: [] });
    expect(h.state.draft).toBe('');
    expect(h.state.sent).toEqual(['and then add a test']);
    const q = pane(h).find('kiro-run--queued')[0];
    expect(q.one('kiro-queued-label').textContent).toMatch(/^Queued/);
    q.one('kiro-queued-cancel').click();
    await flush();
    expect(h.calls.some((c) => c.method === 'POST' && c.url === `/api/v1/operator/kiro/runs/${R2}/cancel`)).toBe(true);
    expect(pane(h).find('kiro-run--queued')).toHaveLength(0);
    expect(pane(h).find('kiro-run--cancelled')).toHaveLength(1);
    expect(pane(h).one('kiro-run-marker--cancelled').textContent).toBe('Stopped');
  });

  it('a third queued message gets queue_full inline; the draft is kept', async () => {
    const { h } = busyThread({ 'POST /api/v1/operator/kiro/runs': () => json(409, { ok: false, error: 'queue_full' }) });
    pane(h);
    await flush();
    await h.KC.send(THREAD);
    expect(h.state.draft).toBe('and then add a test');
    const notice = pane(h).one('kiro-composer-notice');
    expect(notice.textContent).toMatch(/already waiting/);
    expect(notice.getAttribute('role')).toBe('alert');
  });

  it('Stop cancels the current run (its own id), not a thread session', async () => {
    const { h } = busyThread({ [`POST /api/v1/operator/kiro/runs/${R1}/cancel`]: () => json(200, { ok: true, status: 'cancelling' }) });
    pane(h);
    await flush();
    pane(h).one('kiro-stop-btn').click();
    await flush();
    expect(h.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`/api/v1/operator/kiro/runs/${R1}/cancel`]);
  });

  it('an interrupted newest run offers Continue, which starts a new run with a short continue message', async () => {
    const next = sseStream();
    const h = load({
      routes: {
        'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [row({ id: R1, status: 'interrupted', error: 'gateway_shutdown', message: 'long job' })] }),
        'POST /api/v1/operator/kiro/runs': () => json(202, { ok: true, run_id: R2, status: 'running' }),
        [`GET /api/v1/operator/kiro/runs/${R2}/stream`]: () => ({ ok: true, status: 200, body: next.body }),
      },
    });
    pane(h);
    await flush();
    const marker = pane(h).one('kiro-run-marker--interrupted');
    expect(marker.textContent).toMatch(/Interrupted — the gateway restarted/);
    marker.one('kiro-continue-btn').click();
    await flush();
    const post = h.calls.find((c) => c.method === 'POST')!;
    expect(JSON.parse(post.init.body)).toMatchObject({ thread_id: THREAD, message: h.KC._internals.CONTINUE_MESSAGE, attachments: [] });
    // Continue lives only on the newest run.
    expect(pane(h).find('kiro-continue-btn')).toHaveLength(0);
  });

  it('Allow answers the open card through the permissions route and shows the outcome', async () => {
    const { h, live } = busyThread({ 'POST /api/v1/operator/kiro/permissions/*': () => json(200, { ok: true }) });
    pane(h);
    await flush();
    live.push({ id: 1, event: 'kiro.permission_request', data: { request_id: 'q 1', title: 'Run tests', kind: 'execute' } });
    await flush();
    const card = pane(h).find('kiro-approval')[0];
    card.find('kiro-approval-btn--allow')[0].click();
    await flush();
    const ans = h.calls.find((c) => c.method === 'POST')!;
    expect(ans.url).toBe('/api/v1/operator/kiro/permissions/q%201');
    expect(JSON.parse(ans.init.body)).toEqual({ allow: true });
    expect(pane(h).find('kiro-approval-result')[0].textContent).toBe('Allowed');
  });
});

// ---------------------------------------------------------------------------
// AC-6 / AC-7: images
// ---------------------------------------------------------------------------

describe('VTID-05067 paste / drop images', () => {
  const png = (name = 'shot.png', size = 1200) => ({ name, type: 'image/png', size });

  it('Ctrl/Cmd+V of an image adds a chip; a text paste is left alone', async () => {
    const h = load({ routes: { 'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [] }) } });
    pane(h);
    await flush();
    const textarea = pane(h).one('kiro-composer-textarea');
    const textPaste = textarea.dispatch('paste', { clipboardData: { items: [{ kind: 'string', type: 'text/plain' }], files: [] } });
    expect(textPaste.defaultPrevented).toBe(false);
    expect(h.KC.imageTray(THREAD).items).toHaveLength(0);
    const file = png();
    const imgPaste = textarea.dispatch('paste', { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
    expect(imgPaste.defaultPrevented).toBe(true);
    const chips = pane(h).find('kiro-image-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].one('kiro-image-chip-thumb').src).toBe('blob:shot.png');
    expect(chips[0].one('kiro-image-chip-thumb').alt).toBe('Image 1: shot.png');
    expect(chips[0].one('kiro-image-chip-remove').getAttribute('aria-label')).toBe('Remove image 1');
  });

  it('dropping image files adds chips; ✕ removes one (and frees its preview); type, size and count are checked', async () => {
    const h = load({ routes: { 'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [] }) } });
    const p = pane(h);
    await flush();
    const over = p.dispatch('dragover', { dataTransfer: { types: ['Files'] } });
    expect(over.defaultPrevented).toBe(true);
    const drop = p.dispatch('drop', { dataTransfer: { types: ['Files'], files: [png('a.png'), png('b.png'), { name: 'notes.txt', type: 'text/plain', size: 10 }] } });
    expect(drop.defaultPrevented).toBe(true);
    const tray = h.KC.imageTray(THREAD);
    expect(tray.items.map((i: any) => i.name)).toEqual(['a.png', 'b.png']);
    expect(pane(h).one('kiro-image-error').textContent).toMatch(/notes\.txt is not a PNG, JPEG, WebP or GIF image/);
    // A text drag (no files) is not taken.
    expect(p.dispatch('dragover', { dataTransfer: { types: ['text/plain'] } }).defaultPrevented).toBe(false);
    pane(h).find('kiro-image-chip-remove')[0].click();
    expect(tray.items.map((i: any) => i.name)).toEqual(['b.png']);
    expect(h.state.revoked).toEqual(['blob:a.png']);
    tray.addFiles([png('big.png', 6 * 1024 * 1024)]);
    expect(tray.error).toMatch(/larger than 5 MB/);
    tray.addFiles([png('c.png'), png('d.png'), png('e.png'), png('f.png')]);
    expect(tray.items).toHaveLength(4);
    expect(tray.error).toMatch(/At most 4 images/);
  });

  it('the paperclip opens a file picker limited to the four image types', async () => {
    const h = load({ routes: { 'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [] }) } });
    const input = pane(h).one('kiro-attach-input');
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/png,image/jpeg,image/webp,image/gif');
    expect(input.multiple).toBe(true);
    let opened = 0;
    input.click = () => { opened += 1; };
    pane(h).find('kiro-attach-btn')[0].click();
    // The freshly rendered pane's input is the one clicked; re-check on that render.
    const p2 = pane(h);
    p2.one('kiro-attach-input').click = () => { opened += 1; };
    p2.one('kiro-attach-btn').click();
    expect(opened).toBe(1);
    expect(p2.one('kiro-attach-btn').getAttribute('aria-label')).toBe('Attach images');
  });

  it('Send uploads every image to /operator/media, then starts the run with their media ids; chips clear', async () => {
    const live = sseStream();
    const uploads: any[] = [];
    let n = 0;
    const h = load({
      draft: 'what is wrong on this screen?',
      routes: {
        'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [] }),
        'POST /api/v1/operator/media': (url: string, init: any) => { uploads.push({ url, type: init.headers['Content-Type'], body: init.body }); n += 1; return json(201, { ok: true, media_id: `c5067000-0000-4000-8000-00000000000${n}`, oasis_ref: `OASIS-MEDIA-${n}`, url: `https://x.supabase.co/sign/${n}`, mime_type: 'image/png' }); },
        'POST /api/v1/operator/kiro/runs': () => json(202, { ok: true, run_id: R4, status: 'running' }),
        [`GET /api/v1/operator/kiro/runs/${R4}/stream`]: () => ({ ok: true, status: 200, body: live.body }),
      },
    });
    pane(h);
    await flush();
    const f1 = { name: 'a.png', type: 'image/png', size: 100 };
    const f2 = { name: 'b.png', type: 'image/png', size: 200 };
    h.KC.imageTray(THREAD).addFiles([f1, f2]);
    expect(await h.KC.send(THREAD)).toBe(true);
    expect(uploads.map((u) => [u.url, u.type, u.body])).toEqual([
      [`/api/v1/operator/media?thread_id=${THREAD}`, 'image/png', f1],
      [`/api/v1/operator/media?thread_id=${THREAD}`, 'image/png', f2],
    ]);
    const post = h.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/operator/kiro/runs')!;
    expect(JSON.parse(post.init.body).attachments).toEqual(['c5067000-0000-4000-8000-000000000001', 'c5067000-0000-4000-8000-000000000002']);
    expect(h.KC.imageTray(THREAD).items).toHaveLength(0);
    // The sent run shows its images through the signed URLs (memory only).
    const thumbs = pane(h).one('kiro-run-media').find('kiro-media-thumb-img');
    await flush();
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0].src).toBe('https://x.supabase.co/sign/1');
  });

  it('a refused upload keeps the draft and the chips and says why; no run is started', async () => {
    const h = load({
      draft: 'look',
      routes: {
        'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [] }),
        'POST /api/v1/operator/media': () => json(415, { ok: false, error: 'type_mismatch' }),
      },
    });
    pane(h);
    await flush();
    h.KC.imageTray(THREAD).addFiles([{ name: 'fake.png', type: 'image/png', size: 10 }]);
    expect(await h.KC.send(THREAD)).toBe(false);
    expect(h.state.draft).toBe('look');
    expect(h.KC.imageTray(THREAD).items).toHaveLength(1);
    expect(pane(h).one('kiro-composer-notice').textContent).toBe('fake.png is not a PNG, JPEG, WebP or GIF image.');
    expect(h.calls.some((c) => c.url === '/api/v1/operator/kiro/runs' && c.method === 'POST')).toBe(false);
  });

  it('a past run with images re-signs them per view and says when Kiro could not see them', async () => {
    const replay = sseStream();
    const h = load({
      routes: {
        'GET /api/v1/operator/kiro/runs': () => json(200, { ok: true, runs: [row({ id: R1, reply: 'ok', attachments: [{ media_id: 'm1', mime_type: 'image/png' }] })] }),
        'GET /api/v1/operator/media/m1': () => json(200, { ok: true, media_id: 'm1', url: 'https://x.supabase.co/sign/m1' }),
        [`GET /api/v1/operator/kiro/runs/${R1}/stream`]: () => ({ ok: true, status: 200, body: replay.body }),
      },
    });
    pane(h);
    await flush();
    // Runs with images replay their events at once (no click needed for the note).
    replay.push({ id: 1, event: 'kiro.images', data: { count: 1, delivery: 'unsupported', sent: 0 } });
    replay.push({ id: 2, event: 'run.status', data: { status: 'completed' } });
    replay.end();
    await flush();
    const p = pane(h);
    await flush();
    expect(p.one('kiro-images-note').textContent).toBe('Kiro can’t see images in this version');
    expect(p.one('kiro-media-thumb-img').src).toBe('https://x.supabase.co/sign/m1');
    expect(h.calls.filter((c) => c.url === '/api/v1/operator/media/m1')).toHaveLength(1); // cached in memory
  });
});

// ---------------------------------------------------------------------------
// AC-8: wiring, CSP, styles
// ---------------------------------------------------------------------------

describe('VTID-05067 wiring', () => {
  it('index.html loads the module and its styles (external, before app.js) with the bumped ?v=', () => {
    expect(INDEX_HTML).toContain('<link rel="stylesheet" href="/command-hub/kiro-console.css?v=20261111-vtid-05067" />');
    expect(INDEX_HTML).toContain('<script src="/command-hub/kiro-console.js?v=20261111-vtid-05067"></script>');
    expect(INDEX_HTML).toContain('/command-hub/app.js?v=20261111-vtid-05067');
    expect(INDEX_HTML).toContain('/command-hub/styles.css?v=20261111-vtid-05067');
    expect(INDEX_HTML.indexOf('kiro-console.js')).toBeLessThan(INDEX_HTML.indexOf('/command-hub/app.js'));
  });

  it('CSP: no inline styles, no innerHTML, no external URLs in the module', () => {
    expect(MODULE).not.toMatch(/\.style\./);
    expect(MODULE).not.toMatch(/\.innerHTML/);
    expect(MODULE).not.toMatch(/https?:\/\//);
  });

  it('every class the module uses is styled (kiro-console.css or styles.css)', () => {
    const css = KCSS + CSS;
    const classes = new Set<string>();
    // Every kiro-/chat-/message- token inside a string literal (multi-class strings included);
    // a token ending in '-' is a prefix completed at runtime (e.g. 'kiro-run--' + status).
    for (const lit of MODULE.matchAll(/'([^'\n]*)'/g)) {
      for (const tok of lit[1].split(/\s+/)) if (/^(kiro|chat|message)-[a-z0-9-]+$/.test(tok) && !tok.endsWith('-')) classes.add(tok);
    }
    expect(classes.size).toBeGreaterThan(40);
    const missing = [...classes].filter((c) => !new RegExp(`\\.${c}(?![a-z0-9-])`).test(css));
    expect(missing).toEqual([]);
  });

  it('app.js hands a Kiro thread to the module and keeps the thread list, engine switch, model picker and LLM path', () => {
    expect(APP_JS).toContain("if (activeOperatorEngine() === 'kiro' && window.KiroConsole && state.operatorActiveThreadId) {");
    expect(APP_JS).toContain('function initKiroConsoleHost() {');
    expect(APP_JS).toContain('|| kiroThreadBusy(thread.id)');
    expect(APP_JS).toContain('!kiroConsoleHasRuns(state.operatorActiveThreadId)');
    expect(APP_JS).toContain('function renderOperatorEngineSwitch() {');
    expect(APP_JS).toContain('function renderKiroModelSelect(threadId) {');
    // The Operator composer uses the same image helper and sends media ids.
    expect(APP_JS).toContain('window.KiroConsole.imageTray(state.operatorActiveThreadId)');
    expect(APP_JS).toContain("attachments.push({ oasis_ref: m.oasis_ref, kind: 'image', media_id: m.media_id });");
    expect(APP_JS).toContain('if (window.KiroConsole) window.KiroConsole.reset();');
  });
});
