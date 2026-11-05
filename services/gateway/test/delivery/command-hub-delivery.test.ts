/**
 * VTID-05547 (plan agentic-delivery §3.12, tasks.md G1/G2) — Command Hub → Delivery.
 *
 * Pins:
 *   - the Delivery module is in NAVIGATION_CONFIG (app.js), in the regenerated navigation-config.js and in the
 *     dev screen inventory, with tab keys that do not collide with an existing screen id;
 *   - its script has no inline script or style, no innerHTML, no handler attributes, no eval; the page keeps its script list
 *     (delivery.js is loaded on demand by app.js) and its cache-busters were bumped together;
 *   - delivery.js rendered on a minimal DOM from the REAL response of /api/v1/delivery/summary: the three tabs, the empty,
 *     loading and error states with a retry, the shadow toggle, named tables, real buttons, https-only links;
 *   - every class it uses is a class of styles.css (it ships no stylesheet of its own).
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import express from 'express';
import request from 'supertest';
import { FakeEl, fakeDocument } from '../command-hub/fixtures/fake-dom';

let identity: Record<string, unknown> | null = null;
jest.mock('../../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../../src/middleware/auth-supabase-jwt');
  return { ...actual, optionalAuth: (req: any, _res: any, next: () => void) => { if (identity) req.identity = identity; next(); } };
});

import { createDeliveryRouter } from '../../src/routes/delivery';
import type { EventRow } from '../../src/services/gitlab-events/delivery-summary';
import { base, row } from './fixtures';

const GATEWAY = path.resolve(__dirname, '../..');
const HUB = path.join(GATEWAY, 'src/frontend/command-hub');
const JS = fs.readFileSync(path.join(HUB, 'delivery.js'), 'utf8');
const APP = fs.readFileSync(path.join(HUB, 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(HUB, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(HUB, 'styles.css'), 'utf8');
const NAV_JS = fs.readFileSync(path.join(HUB, 'navigation-config.js'), 'utf8');
const SPEC = JSON.parse(fs.readFileSync(path.join(GATEWAY, 'specs/dev-screen-inventory-v1.json'), 'utf8'));
const MODULES = JSON.parse(fs.readFileSync(path.join(HUB, 'modules.json'), 'utf8'));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DS = require('../../src/frontend/command-hub/delivery.js').DeliveryScreen;

const NOW = Date.parse('2026-11-05T12:00:00Z');
const flush = () => new Promise((r) => setImmediate(r));

/** The NAVIGATION_CONFIG of navigation-config.js (an ES module that only exports the constant). */
function navigationConfig(): Array<{ module: string; label: string; tabs: Array<{ key: string; label: string }> }> {
  return new Function(`${NAV_JS.replace('export const NAVIGATION_CONFIG', 'const NAVIGATION_CONFIG')}\nreturn NAVIGATION_CONFIG;`)();
}

// ---- the summary, built by the real route from OASIS rows -------------------------------------------------------

const mr = (topic: string, at: string, iid: number, label: string | null, vtid: string, repo = 'vitana-platform') =>
  row(`scm.gitlab.merge_request.${topic}`, at, base({ repo, merge_request_iid: iid, queue_label: label, lane_key: `plan/lane-${iid}`, head_sha: `sha${iid}`, url: `https://gitlab.example.invalid/${repo}/-/merge_requests/${iid}`, dedupe_key: `k:${repo}:${iid}:${at}` }), { vtid });
const pipe = (topic: string, at: string, id: number, ref: string, iid: number | null, extra: Record<string, unknown> = {}, repo = 'vitana-platform') =>
  row(`scm.gitlab.pipeline.${topic}`, at, base({ repo, pipeline_id: id, ref, merge_request_iid: iid, sha: `s${id}`, duration_s: 61, queued_s: 4, url: `https://gitlab.example.invalid/p/${id}`, dedupe_key: `p:${id}:${topic}`, ...extra }));

const ROWS: EventRow[] = [
  mr('updated', '2026-11-05T11:30:00Z', 3, 'queue-updating', 'VTID-00003'),
  mr('opened', '2026-11-05T10:00:00Z', 2, 'queue-ready', 'VTID-00002'),
  mr('opened', '2026-11-05T09:00:00Z', 6, 'queue-paused', 'VTID-00006'),
  pipe('succeeded', '2026-11-05T11:50:00Z', 103, 'main', null),
  pipe('failed', '2026-11-05T10:56:00Z', 101, 'kiro/c/d', 2, { jobs: [{ name: 'a', status: 'failed' }] }),
  pipe('failed', '2026-11-05T11:00:00Z', 200, 'main', null, {}, 'vitana-v1'),
  row('staging.deploy.completed', '2026-11-05T10:00:00Z', { env: 'staging', git_commit: 'newcommit1234567890', workflow: 'AWS-STAGE-DEPLOY-GATEWAY.yml' }, { service: 'vitana-gateway-aws' }),
  row('staging.verify.passed', '2026-11-05T11:10:00Z', { env: 'staging', service: 'gateway', commit: 'newcommit1234567890', outcome: 'passed', run_url: 'https://gitlab.example.invalid/run/2' }, { service: 'staging-verify-gateway' }),
  row('staging.verify.failed', '2026-11-05T11:20:00Z', { env: 'staging', service: 'community-app', commit: 'v1sha', outcome: 'failed', run_url: 'javascript:alert(1)' }, { service: 'staging-verify-community-app' }),
  row('delivery.merge.refused', '2026-11-05T11:30:00Z', base({ dedupe_key: 'r1' })),
];
const LEDGER = [{ vtid: 'VTID-00003', title: 'Third lane title', status: 'in_progress', is_terminal: false, terminal_outcome: null }];

async function summary(rows: EventRow[] = ROWS, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv): Promise<any> {
  identity = { user_id: 'admin-1', exafy_admin: true };
  const a = express();
  a.use('/api/v1/delivery', createDeliveryRouter({ now: () => NOW, env, readers: { readEvents: async () => rows, readLedger: async () => LEDGER } }));
  const res = await request(a).get('/api/v1/delivery/summary').set('Authorization', 'Bearer admin.jwt');
  expect(res.status).toBe(200);
  return res.body;
}

async function mount(tab: string, body: unknown, extra: Record<string, unknown> = {}): Promise<{ el: FakeEl; calls: Array<{ url: string; init: any }> }> {
  DS.reset();
  const calls: Array<{ url: string; init: any }> = [];
  const fetch = (url: string, init: any) => { calls.push({ url, init }); return Promise.resolve({ json: () => Promise.resolve(body) }); };
  const el: FakeEl = DS.render({ tab, doc: fakeDocument, fetch, headers: (x: Record<string, string>) => ({ ...x, Authorization: 'Bearer t' }), now: () => NOW, ...extra });
  await flush();
  await flush();
  return { el, calls };
}

const table = (el: FakeEl, label: string): FakeEl => {
  const t = el.byTag('table').find((x) => x.getAttribute('aria-label') === label);
  if (!t) throw new Error(`no table "${label}" among ${el.byTag('table').map((x) => x.getAttribute('aria-label'))}`);
  return t;
};
const bodyRows = (t: FakeEl): string[][] => t.byTag('tbody')[0].byTag('tr').map((tr) => tr.byTag('td').map((td) => td.textContent));
const headers = (t: FakeEl): string[] => t.byTag('thead')[0].byTag('th').map((th) => th.textContent);

// ---------------------------------------------------------------------------------------------------------------

describe('VTID-05547 navigation — the Delivery module is registered', () => {
  it('the Delivery module is in NAVIGATION_CONFIG: app.js, the regenerated navigation-config.js and the screen inventory agree', () => {
    expect(APP).toContain('"section": "delivery"');
    expect(APP).toContain('"basePath": "/command-hub/delivery/"');
    expect(APP).toContain('{ "key": "merge-queue", "path": "/command-hub/delivery/merge-queue/" }');
    expect(APP).toContain('{ "key": "pipeline-runs", "label": "Pipelines", "path": "/command-hub/delivery/pipeline-runs/" }');
    expect(APP).toContain('{ "key": "releases", "path": "/command-hub/delivery/releases/" }');
    expect(APP).toMatch(/const SECTION_LABELS = \{[\s\S]*'delivery': 'Delivery',/);

    const mod = navigationConfig().find((m) => m.module === 'delivery');
    expect(mod).toEqual({ module: 'delivery', label: 'Delivery', tabs: [{ key: 'merge-queue', label: 'Merge Queue' }, { key: 'pipeline-runs', label: 'Pipeline Runs' }, { key: 'releases', label: 'Releases' }] });

    expect(SPEC.sidebar_navigation).toContain('delivery');
    expect(SPEC.module_catalog.delivery).toEqual(['merge-queue', 'pipeline-runs', 'releases']);
    const screens = SPEC.screen_inventory.screens.filter((s: any) => s.module === 'Delivery');
    expect(screens.map((s: any) => [s.screen_id, s.url_path, s.role])).toEqual([
      ['DEV-MERGE_QUEUE', '/command-hub/delivery/merge-queue/', 'DEVELOPER'],
      ['DEV-PIPELINE_RUNS', '/command-hub/delivery/pipeline-runs/', 'DEVELOPER'],
      ['DEV-RELEASES', '/command-hub/delivery/releases/', 'DEVELOPER'],
    ]);
  });

  it('the Delivery tab keys do not collide with any other screen id (the key "pipelines" would be DEV-PIPELINES of Agents)', () => {
    const ids: string[] = SPEC.screen_inventory.screens.map((s: any) => s.screen_id);
    expect(ids).toEqual(expect.arrayContaining(['DEV-MERGE_QUEUE', 'DEV-PIPELINE_RUNS', 'DEV-RELEASES']));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('DEV-DELIVERY_PIPELINES');
    expect(ids.filter((i) => i === 'DEV-PIPELINES')).toHaveLength(1);
    expect(SPEC.screen_inventory.total_screens).toBe(SPEC.screen_inventory.screens.filter((s: any) => s.role === 'DEVELOPER').length);
  });

  it('the dev frontend spec validator accepts the module (the same check the CI runs)', () => {
    const r = spawnSync('node', [path.join(GATEWAY, 'scripts/validate-dev-frontend-spec.mjs')], { encoding: 'utf8', cwd: GATEWAY });
    expect(r.stderr).not.toContain('VIOLATION');
    expect(r.status).toBe(0);
  });

  it('the render switch hands every Delivery tab to deliveryModule.view, which loads delivery.js on demand from the same origin', () => {
    expect(APP).toMatch(/function renderModuleContent\(moduleKey, tab\) \{[\s\S]{0,400}if \(moduleKey === 'delivery'\) \{[\s\S]{0,200}container\.appendChild\(deliveryModule\.view\(tab\)\);/);
    // One object, not top-level function declarations: VTID-05073 (b) pins the function set of the bundle.
    expect(APP).toMatch(/\nvar deliveryModule = \{/);
    expect(APP).not.toMatch(/\nfunction (loadDeliveryScreen|renderDeliveryView)\b/);
    expect(APP).toContain("script.src = '/command-hub/delivery.js?v=20261105-vtid-05547';");
    expect(APP).toContain('screen.render({ tab: tab, headers: buildContextHeaders })');
    expect(APP).toContain('The Delivery module did not load. Reload the page.');
    expect(fs.existsSync(path.join(HUB, 'delivery.js'))).toBe(true);
  });
});

describe('VTID-05547 app.js — the on-demand loader of delivery.js', () => {
  /** The `var deliveryModule = {…};` statement of app.js, run against a fake window and document. */
  function glue(win: Record<string, unknown>, doc: unknown): any {
    const start = APP.indexOf('\nvar deliveryModule = {');
    const end = APP.indexOf('\n};\n', start);
    if (start < 0 || end < 0) throw new Error('var deliveryModule not found in app.js');
    const buildContextHeaders = (extra: unknown) => extra;
    const mod = new Function('window', 'document', 'buildContextHeaders', `${APP.slice(start, end + 3)}\nreturn deliveryModule;`)(win, doc, buildContextHeaders);
    return { mod, buildContextHeaders };
  }
  function setup(win: Record<string, unknown> = {}) {
    const head = new FakeEl('head');
    const doc = { head, createElement: (tag: string) => new FakeEl(tag) };
    return { win, head, ...glue(win, doc) };
  }
  const screenStub = (rendered: Array<{ tab: string; headers: unknown }>) => ({
    render: (o: { tab: string; headers: unknown }) => { rendered.push(o); const el = new FakeEl('div'); el.textContent = `screen:${o.tab}`; return el; },
  });

  it('the first tab adds one same-origin script element; a tab opened while it loads adds none; both draw when it has loaded', async () => {
    const rendered: Array<{ tab: string; headers: unknown }> = [];
    const { win, head, mod, buildContextHeaders } = setup();
    const a: FakeEl = mod.view('merge-queue');
    const b: FakeEl = mod.view('releases');
    expect(head.children).toHaveLength(1);
    const script = head.children[0] as any;
    expect(script.tagName).toBe('SCRIPT');
    expect(script.src).toBe('/command-hub/delivery.js?v=20261105-vtid-05547');
    expect(a.className).toBe('content-container');
    expect(a.byTag('p')[0].textContent).toBe('Loading Delivery…');
    expect(a.byTag('p')[0].getAttribute('role')).toBe('status');
    win.DeliveryScreen = screenStub(rendered);
    script.onload();
    await flush(); await flush();
    expect(rendered.map((r) => r.tab)).toEqual(['merge-queue', 'releases']);
    expect(rendered[0].headers).toBe(buildContextHeaders); // the Command Hub's own auth headers
    expect(a.textContent).toBe('screen:merge-queue');
    expect(b.textContent).toBe('screen:releases');
  });

  it('once loaded no element is added again; the screen is drawn at once', async () => {
    const rendered: Array<{ tab: string; headers: unknown }> = [];
    const { head, mod } = setup({ DeliveryScreen: screenStub(rendered) });
    const el: FakeEl = mod.view('pipeline-runs');
    await flush();
    expect(head.children).toHaveLength(0);
    expect(rendered.map((r) => r.tab)).toEqual(['pipeline-runs']);
    expect(el.textContent).toBe('screen:pipeline-runs');
  });

  it('a script that does not load shows an alert, and the next tab that opens tries again', async () => {
    const rendered: Array<{ tab: string; headers: unknown }> = [];
    const { win, head, mod } = setup();
    const el: FakeEl = mod.view('releases');
    (head.children[0] as any).onerror();
    await flush(); await flush();
    const note = el.byTag('p')[0];
    expect(note.getAttribute('role')).toBe('alert');
    expect(note.textContent).toBe('The Delivery module did not load. Reload the page.');
    expect(rendered).toHaveLength(0);
    const again: FakeEl = mod.view('releases');
    expect(head.children).toHaveLength(2); // a second attempt, not a cached failure
    win.DeliveryScreen = screenStub(rendered);
    (head.children[1] as any).onload();
    await flush(); await flush();
    expect(again.textContent).toBe('screen:releases');
  });
});

describe('VTID-05547 CSP and the page — no inline script or style, a bumped cache-buster', () => {
  it('delivery.js: no innerHTML, no inline handler, no eval, no inline style, no embedded script or style tag', () => {
    expect(JS.length).toBeGreaterThan(5000); // the module itself, not an empty file
    expect(JS).toContain('root.DeliveryScreen');
    expect(JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(['"]on/);
    expect(JS).not.toMatch(/\.on[a-z]+\s*=/);
    expect(JS).not.toMatch(/<script|<style|setAttribute\(['"]style|\.style\.|cssText|javascript:/);
    expect(JS).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no absolute URL: it calls its own origin
  });

  it('index.html keeps its script list and has no inline script or style; delivery.js is not a tag of it and not in modules.json', () => {
    expect(INDEX).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(INDEX).not.toMatch(/<style|\son[a-z]+=/);
    expect(INDEX).not.toContain('delivery.js');
    expect(MODULES.bundle.map((b: any) => b.file)).not.toContain('delivery.js');
  });

  it('app.js and styles.css were bumped together, to a new value that keeps the old marker as its prefix', () => {
    const appV = /\/command-hub\/app\.js\?v=([^"]+)"/.exec(INDEX)?.[1];
    const cssV = /\/command-hub\/styles\.css\?v=([^"]+)"/.exec(INDEX)?.[1];
    expect(appV).toBe('20261121-vtid-05082-vtid-05547');
    expect(cssV).toBe(appV);
    expect(appV!.startsWith('20261121-vtid-05082')).toBe(true);
    expect(appV).not.toBe('20261121-vtid-05082'); // the URL changed: browsers and the CDN fetch the new app.js
  });
});

describe('VTID-05547 Delivery → Merge queue', () => {
  it('draws one section and one named table per repository from the real summary, in queue order, with the VTID title from the ledger', async () => {
    const body = await summary(ROWS, { DELIVERY_HOST_VITANA_PLATFORM: 'gitlab' } as NodeJS.ProcessEnv);
    const { el, calls } = await mount('merge-queue', body);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/delivery/summary');
    expect(calls[0].init.headers.Authorization).toBe('Bearer t');
    expect(el.all('section-title').map((n) => n.textContent)).toEqual(['Merge queue', 'vitana-platform · GitLab', 'vitana-v1 · GitHub']);
    const t = table(el, 'vitana-platform merge queue');
    expect(headers(t)).toEqual(['Position', 'VTID', 'Title', 'Lane', 'State', 'Waiting', 'Merge request']);
    expect(bodyRows(t)).toEqual([
      ['1', 'VTID-00003', 'Third lane title', 'plan/lane-3', 'Updating', '30 min', '!3'],
      ['2', 'VTID-00002', '—', 'plan/lane-2', 'Ready', '2 h', '!2'],
      ['—', 'VTID-00006', '—', 'plan/lane-6', 'Paused', '3 h', '!6'],
    ]);
    expect(el.all('tq-pill').map((b) => b.textContent)).toEqual(expect.arrayContaining(['Landing paused', 'Updating', 'Ready', 'Paused']));
    const link = t.byTag('a')[0] as any;
    expect(link.href).toBe('https://gitlab.example.invalid/vitana-platform/-/merge_requests/3');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.target).toBe('_blank');
  });

  it('a repository that still delivers on GitHub says so instead of drawing an empty table (the empty state)', async () => {
    const { el } = await mount('merge-queue', await summary([]));
    expect(el.byTag('table')).toHaveLength(0);
    const notes = el.all('placeholder-content').map((n) => n.textContent);
    expect(notes.filter((n) => n === 'This repository still delivers on GitHub. Its merge queue fills after the cut.')).toHaveLength(2);
  });

  it('a repository on GitLab with nothing waiting says "Nothing is waiting to land."', async () => {
    const { el } = await mount('merge-queue', await summary([], { DELIVERY_HOST_VITANA_PLATFORM: 'gitlab', DELIVERY_HOST_VITANA_V1: 'gitlab' } as NodeJS.ProcessEnv));
    expect(el.all('placeholder-content').map((n) => n.textContent).filter((n) => n === 'Nothing is waiting to land.')).toHaveLength(2);
  });
});

describe('VTID-05547 Delivery → Pipelines', () => {
  it('shows the state of main per repository and the latest pipeline per merge request', async () => {
    const { el } = await mount('pipeline-runs', await summary(ROWS, { DELIVERY_HOST_VITANA_PLATFORM: 'gitlab', DELIVERY_HOST_VITANA_V1: 'gitlab' } as NodeJS.ProcessEnv));
    expect(el.all('section-title').map((n) => n.textContent)).toEqual(['Pipelines', 'vitana-platform · GitLab', 'vitana-v1 · GitLab']);
    const badges = el.all('tq-pill').map((b) => b.textContent);
    expect(badges).toEqual(expect.arrayContaining(['Green', 'Red', 'Failed', 'Passed']));
    const t = table(el, 'vitana-platform latest pipeline per merge request');
    expect(headers(t)).toEqual(['Merge request', 'Ref', 'Status', 'Waited', 'Ran', 'Failed jobs', 'VTID', 'Pipeline']);
    expect(bodyRows(t)).toEqual([
      ['—', 'main', 'Passed', '4 s', '1 min 1 s', '0', 'VTID-05547', '#103'],
      ['!2', 'kiro/c/d', 'Failed', '4 s', '1 min 1 s', '1', 'VTID-05547', '#101'],
    ]);
    expect(el.all('delivery-repo').map((s) => s.getAttribute('aria-label'))).toEqual(['vitana-platform pipelines', 'vitana-v1 pipelines']);
  });

  it('a repository still on GitHub says its pipelines appear after the cut', async () => {
    const { el } = await mount('pipeline-runs', await summary([]));
    expect(el.all('placeholder-content').map((n) => n.textContent)).toContain('This repository still delivers on GitHub. Its pipelines appear after the cut.');
    expect(el.all('tq-pill').map((b) => b.textContent)).toEqual(['No pipeline yet', 'No pipeline yet']);
  });
});

describe('VTID-05547 Delivery → Releases', () => {
  it('lists the staging deploys and the STAGING-VERIFY results, links only https run URLs, and points at PUBLISH', async () => {
    const { el } = await mount('releases', await summary());
    expect(el.all('section-title').map((n) => n.textContent)).toEqual(['Releases', 'Staging deploys', 'STAGING-VERIFY']);
    expect(headers(table(el, 'Staging deploys'))).toEqual(['Service', 'Commit', 'Status', 'Host', 'When']);
    expect(bodyRows(table(el, 'Staging deploys'))).toEqual([['vitana-gateway-aws', 'newcommit123', 'Deployed', 'GitHub', '2 h ago']]);
    const v = table(el, 'STAGING-VERIFY results');
    expect(bodyRows(v)).toEqual([
      ['community-app', 'v1sha', 'Failed', '40 min ago', 'Open run'],
      ['gateway', 'newcommit123', 'Passed', '50 min ago', 'Open run'],
    ]);
    const anchors = v.byTag('a');
    expect(anchors).toHaveLength(1); // the javascript: URL is shown as text, never a link
    expect((anchors[0] as any).href).toBe('https://gitlab.example.invalid/run/2');
    expect(el.all('placeholder-content').map((n) => n.textContent)).toContain('Production stays the PUBLISH button in the header: it promotes the build that passed STAGING-VERIFY.');
  });

  it('says so when there is no deploy and no verification in the window', async () => {
    const { el } = await mount('releases', await summary([]));
    const notes = el.all('placeholder-content').map((n) => n.textContent);
    expect(notes).toEqual(expect.arrayContaining(['No staging deploy in this window.', 'No STAGING-VERIFY result in this window.']));
    expect(el.byTag('table')).toHaveLength(0);
  });
});

describe('VTID-05547 Delivery — loading, error, retry, refresh, shadow', () => {
  it('shows a loading state with role status until the data arrives', async () => {
    DS.reset();
    const el: FakeEl = DS.render({ tab: 'merge-queue', doc: fakeDocument, fetch: () => new Promise(() => undefined), now: () => NOW });
    const loading = el.all('placeholder-content')[0];
    expect(loading.textContent).toBe('Loading delivery data…');
    expect(loading.getAttribute('role')).toBe('status');
  });

  it('an error shows an alert with the reason and a Retry button that fetches again', async () => {
    const { el, calls } = await mount('merge-queue', { ok: false, error: 'delivery_source_unavailable' });
    const alert = el.all('placeholder-content').find((n) => n.getAttribute('role') === 'alert')!;
    expect(alert.textContent).toBe('Could not load delivery data: delivery_source_unavailable');
    const retry = el.byTag('button').find((b) => b.textContent === 'Retry')!;
    retry.click();
    await flush();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('opening a tab again after an error tries again, without a click on Retry', async () => {
    const good = await summary();
    let n = 0;
    const fetch = () => { n += 1; return Promise.resolve({ json: () => Promise.resolve(n === 1 ? { ok: false, error: 'delivery_source_unavailable' } : good) }); };
    DS.reset();
    DS.render({ tab: 'merge-queue', doc: fakeDocument, fetch, now: () => NOW });
    await flush(); await flush();
    expect(DS._internals.state.error).toBe('delivery_source_unavailable');
    const again: FakeEl = DS.render({ tab: 'releases', doc: fakeDocument, fetch, now: () => NOW });
    await flush(); await flush();
    expect(n).toBe(2);
    expect(again.all('section-title')[0].textContent).toBe('Releases');
    expect(again.all('placeholder-content').some((x) => x.getAttribute('role') === 'alert')).toBe(false);
  });

  it('opening a tab after a failed refresh tries again even within 30 seconds, while the data of the first load is still held', async () => {
    const good = await summary();
    const answers: unknown[] = [good, { ok: false, error: 'delivery_source_unavailable' }, good];
    const calls: string[] = [];
    const fetch = (url: string) => { calls.push(url); return Promise.resolve({ json: () => Promise.resolve(answers[calls.length - 1]) }); };
    let clock = NOW;
    DS.reset();
    const first: FakeEl = DS.render({ tab: 'merge-queue', doc: fakeDocument, fetch, now: () => clock });
    await flush(); await flush();
    expect(DS._internals.state.error).toBeNull();
    clock += 5_000;
    first.byTag('button').find((b) => b.textContent === 'Refresh')!.click();
    await flush(); await flush();
    expect(calls).toHaveLength(2);
    expect(DS._internals.state.error).toBe('delivery_source_unavailable');
    expect(DS._internals.state.data).not.toBeNull(); // the first load's data is kept; its age (5 s) is still inside the 30 s window
    clock += 5_000;
    const again: FakeEl = DS.render({ tab: 'releases', doc: fakeDocument, fetch, now: () => clock });
    await flush(); await flush();
    expect(calls).toHaveLength(3); // the error, not the age of the data, made it fetch
    expect(DS._internals.state.error).toBeNull();
    expect(again.all('section-title')[0].textContent).toBe('Releases');
    expect(again.all('placeholder-content').some((x) => x.getAttribute('role') === 'alert')).toBe(false);
  });

  it('a network failure is shown as an error too', async () => {
    DS.reset();
    const el: FakeEl = DS.render({ tab: 'releases', doc: fakeDocument, fetch: () => Promise.reject(new Error('Failed to fetch')), now: () => NOW });
    await flush();
    await flush();
    expect(el.all('placeholder-content').find((n) => n.getAttribute('role') === 'alert')!.textContent).toBe('Could not load delivery data: Failed to fetch');
  });

  it('the Refresh button fetches again; the shadow toggle fetches with include_shadow=1 and says so', async () => {
    const body = await summary();
    const { el, calls } = await mount('merge-queue', body);
    el.byTag('button').find((b) => b.textContent === 'Refresh')!.click();
    await flush(); await flush();
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/delivery/summary', '/api/v1/delivery/summary']);
    const toggle = DS._internals.state.el.byTag('input')[0] as any;
    toggle.checked = true;
    toggle.listeners.change[0]();
    await flush(); await flush();
    expect(calls[2].url).toBe('/api/v1/delivery/summary?include_shadow=1');
    expect(DS._internals.state.includeShadow).toBe(true);
  });

  it('a second render of a tab within 30 seconds reuses the data; after that it fetches again; an unknown tab shows the merge queue', async () => {
    const body = await summary();
    let clock = NOW;
    const calls: string[] = [];
    const fetch = (url: string) => { calls.push(url); return Promise.resolve({ json: () => Promise.resolve(body) }); };
    DS.reset();
    DS.render({ tab: 'merge-queue', doc: fakeDocument, fetch, now: () => clock });
    await flush(); await flush();
    clock += 10_000;
    const again: FakeEl = DS.render({ tab: 'releases', doc: fakeDocument, fetch, now: () => clock });
    expect(calls).toHaveLength(1);
    expect(again.all('section-title')[0].textContent).toBe('Releases'); // painted at once from the data it has
    clock += 40_000;
    DS.render({ tab: 'releases', doc: fakeDocument, fetch, now: () => clock });
    await flush(); await flush();
    expect(calls).toHaveLength(2);
    const unknown: FakeEl = DS.render({ tab: 'no-such-tab', doc: fakeDocument, fetch, now: () => clock });
    expect(unknown.all('section-title')[0].textContent).toBe('Merge queue');
  });

  it('notes the refused GitHub merges, a truncated read, and where the numbers come from', async () => {
    const body = { ...(await summary()), truncated: true };
    const { el } = await mount('merge-queue', body);
    const notes = el.all('placeholder-content').map((n) => n.textContent);
    expect(notes).toEqual(expect.arrayContaining([
      'Only the newest events of the window were read; older ones are not shown.',
      '1 GitHub merge refused since the cut; the last 30 min ago.',
      'From the VTID ledger and OASIS · window 168 h · shadow runs hidden',
    ]));
  });
});

describe('VTID-05547 accessibility and the existing stylesheet', () => {
  const TABS = ['merge-queue', 'pipeline-runs', 'releases'];

  it('every table is named and has column headers with scope; controls are real buttons and a labelled checkbox', async () => {
    for (const tab of TABS) {
      const { el } = await mount(tab, await summary());
      for (const t of el.byTag('table')) {
        expect(t.getAttribute('aria-label')).toBeTruthy();
        for (const th of t.byTag('th')) expect(th.getAttribute('scope')).toBe('col');
      }
      for (const b of el.byTag('button')) {
        expect((b as any).type).toBe('button');
        expect(b.textContent).toMatch(/^(Refresh|Retry)$/);
      }
      const label = el.byTag('label')[0];
      expect(label.byTag('input')[0].getAttribute('type') ?? (label.byTag('input')[0] as any).type).toBe('checkbox');
      expect(label.textContent).toBe('Include shadow runs');
      for (const s of el.all('delivery-repo')) expect(s.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('every class it draws with is a class of styles.css, except its two hooks delivery-view and delivery-repo', async () => {
    const used = new Set<string>();
    const collect = (e: FakeEl) => { e.className.split(/\s+/).filter(Boolean).forEach((c) => used.add(c)); e.children.forEach(collect); };
    for (const tab of TABS) {
      collect((await mount(tab, await summary())).el);
      collect((await mount(tab, { ok: false, error: 'x' })).el);
    }
    const missing = [...used].filter((c) => !['delivery-view', 'delivery-repo'].includes(c) && !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}(?![\\w-])`).test(CSS));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(8);
  });

  it('every row is one line: identifiers use the monospace no-wrap cell, a ledger title is clipped with its full text in the tooltip', async () => {
    const { el } = await mount('merge-queue', await summary(ROWS, { DELIVERY_HOST_VITANA_PLATFORM: 'gitlab' } as NodeJS.ProcessEnv));
    const first = table(el, 'vitana-platform merge queue').byTag('tbody')[0].byTag('tr')[0].byTag('td');
    expect(first.map((td) => td.className)).toEqual(['', 'gov-eval-timestamp', 'gov-eval-action', 'gov-eval-timestamp gov-eval-action', '', 'event-timestamp', '']);
    expect(first[2].textContent).toBe('Third lane title');
    expect(first[2].getAttribute('title')).toBe('Third lane title');
    expect(first[3].getAttribute('title')).toBe('plan/lane-3'); // a long lane or ref is clipped; the tooltip has all of it
    expect(first[1].getAttribute('title')).toBeNull();
  });

  /** The declarations of the single-class rules `.name { … }` in styles.css, merged in file order (the last one wins). */
  function effectiveRule(name: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = new RegExp('(?:^|\\n)\\.' + name.replace(/-/g, '\\-') + '\\s*\\{([^}]*)\\}', 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(CSS)) !== null) {
      for (const decl of m[1].split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
      }
    }
    return out;
  }
  const THEME: Record<string, string> = Object.fromEntries([...CSS.slice(0, 2500).matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  const rgb = (v: string | undefined): [number, number, number] => {
    if (!v) throw new Error('no colour declared');
    const x = v.trim().replace(/var\(--([a-z-]+)\)/, (_m, n) => THEME[n]);
    if (x.startsWith('#')) return [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16)) as [number, number, number];
    throw new Error(`cannot read colour ${v}`);
  };
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  /** The colour of a text class over the table background, with the class's own tint blended in when it has one. */
  function contrastOnTable(cls: string): number {
    const r = effectiveRule(cls);
    let bg = rgb(THEME['color-sidebar-bg']);
    const tint = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(r.background ?? '');
    if (tint) bg = [1, 2, 3].map((i) => Math.round(Number(tint[i]) * Number(tint[4]) + bg[i - 1] * (1 - Number(tint[4])))) as [number, number, number];
    return ratio(rgb(r.color), bg);
  }

  /** One row of every state the screen can show, so every pill class is drawn. */
  const EVERY_STATE: EventRow[] = [
    mr('updated', '2026-11-05T11:30:00Z', 1, 'queue-updating', 'VTID-00001'),
    mr('opened', '2026-11-05T11:00:00Z', 2, 'queue-ready', 'VTID-00002'),
    mr('opened', '2026-11-05T10:00:00Z', 3, 'queue-waiting', 'VTID-00003'),
    mr('opened', '2026-11-05T09:00:00Z', 4, 'queue-blocked', 'VTID-00004'),
    mr('opened', '2026-11-05T08:00:00Z', 5, 'queue-paused', 'VTID-00005'),
    pipe('started', '2026-11-05T11:50:00Z', 301, 'kiro/a/a', 1),
    pipe('succeeded', '2026-11-05T11:40:00Z', 302, 'kiro/b/b', 2),
    pipe('failed', '2026-11-05T11:30:00Z', 303, 'kiro/c/c', 3),
    pipe('canceled', '2026-11-05T11:20:00Z', 304, 'kiro/d/d', 4),
    pipe('succeeded', '2026-11-05T11:55:00Z', 305, 'main', null),
    pipe('failed', '2026-11-05T11:55:00Z', 306, 'main', null, {}, 'vitana-v1'),
    row('staging.deploy.completed', '2026-11-05T10:00:00Z', base({ service: 'a', git_commit: 'c1', dedupe_key: 'x1' })),
    row('staging.deploy.failed', '2026-11-05T10:01:00Z', base({ service: 'b', git_commit: 'c2', dedupe_key: 'x2' })),
    row('staging.deploy.rolled_back', '2026-11-05T10:02:00Z', base({ service: 'c', git_commit: 'c3', dedupe_key: 'x3' })),
    row('staging.verify.passed', '2026-11-05T10:03:00Z', { service: 'a', commit: 'c1', outcome: 'passed', run_url: 'https://gitlab.example.invalid/r/1' }),
    row('staging.verify.failed', '2026-11-05T10:04:00Z', { service: 'b', commit: 'c2', outcome: 'failed', run_url: 'https://gitlab.example.invalid/r/2' }),
    row('staging.verify.superseded', '2026-11-05T10:05:00Z', { service: 'c', commit: 'c3', outcome: 'superseded' }),
  ];

  it('every state draws with a pill of the AA family: five variants, each shown with its label', async () => {
    const seen: Record<string, string[]> = {};
    for (const tab of TABS) {
      const { el } = await mount(tab, await summary(EVERY_STATE, { DELIVERY_HOST_VITANA_PLATFORM: 'gitlab', DELIVERY_HOST_VITANA_V1: 'gitlab' } as NodeJS.ProcessEnv));
      for (const pill of el.all('tq-pill')) (seen[pill.className] ??= []).push(pill.textContent);
    }
    expect(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...new Set(v)].sort()]))).toEqual({
      'tq-pill tq-pill-env': ['Running', 'Updating'],
      'tq-pill tq-pill-ok': ['Deployed', 'Green', 'Passed', 'Ready'],
      'tq-pill tq-pill-bad': ['Blocked', 'Failed', 'Red'],
      'tq-pill tq-pill-neutral': ['Canceled', 'Superseded', 'Waiting'],
      'tq-pill tq-pill-warn': ['Landing paused', 'Paused', 'Rolled back'],
    });
  });

  it('AA contrast (ALWAYS 40): the text colour of every pill, link and secondary cell it draws with is at least 4.5:1 on the table background', async () => {
    const used = new Set<string>();
    const collect = (e: FakeEl) => { e.className.split(/\s+/).filter(Boolean).forEach((c) => used.add(c)); e.children.forEach(collect); };
    for (const tab of TABS) collect((await mount(tab, await summary(EVERY_STATE, { DELIVERY_HOST_VITANA_PLATFORM: 'gitlab', DELIVERY_HOST_VITANA_V1: 'gitlab' } as NodeJS.ProcessEnv))).el);
    const colored = ['tq-pill-ok', 'tq-pill-bad', 'tq-pill-warn', 'tq-pill-env', 'tq-pill-neutral', 'approvals-pr-link', 'gov-eval-timestamp', 'event-timestamp'];
    const measured: Record<string, string> = {};
    for (const cls of colored) {
      if (!used.has(cls)) continue;
      const c = contrastOnTable(cls);
      measured[cls] = c.toFixed(2);
      expect({ cls, ok: c >= 4.5 }).toEqual({ cls, ok: true });
    }
    // The classes of the stylesheet that fail AA there are not used.
    for (const bad of ['status-success', 'status-error', 'status-info', 'status-badge']) expect(used.has(bad)).toBe(false);
    expect(Object.keys(measured).sort()).toEqual(['approvals-pr-link', 'event-timestamp', 'gov-eval-timestamp', 'tq-pill-bad', 'tq-pill-env', 'tq-pill-neutral', 'tq-pill-ok', 'tq-pill-warn']);
    // The measurement agrees with the figures quoted in delivery.js and with the classes it avoids.
    expect(contrastOnTable('status-success')).toBeLessThan(4.5);
    expect(contrastOnTable('status-error')).toBeLessThan(4.5);
    expect(contrastOnTable('status-info')).toBeLessThan(4.5);
  });

  it('only https URLs become links; fmtDuration and fmtAgo read as text', () => {
    const i = DS._internals;
    expect(i.safeUrl('https://gitlab.example.invalid/x')).toBe('https://gitlab.example.invalid/x');
    for (const bad of ['http://x', 'javascript:alert(1)', '//x', '/relative', '', null, undefined, 7]) expect(i.safeUrl(bad)).toBeNull();
    expect([i.fmtDuration(null), i.fmtDuration(0), i.fmtDuration(59.6), i.fmtDuration(60), i.fmtDuration(125), i.fmtDuration(3600), i.fmtDuration(5400)]).toEqual(['—', '0 s', '1 min', '1 min', '2 min 5 s', '1 h', '1 h 30 min']);
    expect(i.shortSha('0123456789abcdef')).toBe('0123456789ab');
    expect(i.shortSha(null)).toBe('—');
  });
});
