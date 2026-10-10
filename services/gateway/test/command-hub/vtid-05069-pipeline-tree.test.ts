/**
 * VTID-05069: the Operator Console run card (frontend/command-hub/pipeline-tree.js).
 * The renderer is exercised on the server's own views of the three mock states
 * (built from the same fixtures as test/operator-runs-view.test.ts), on a minimal
 * DOM; plus the SSE frame parser, the app.js hooks, index.html loading, CSP and
 * the stylesheet.
 */
import * as fs from 'fs';
import * as path from 'path';
import { FakeEl, fakeDocument } from './fixtures/fake-dom';
import { buildRunViewWith, resetRunViewCaches, type RunView } from '../../src/services/operator-runs/run-view';
import { fixtureDeps, STATE_RUNNING, STATE_FIXING, STATE_GATE2, STATE_DONE, THREAD, T0, type FixtureState } from '../fixtures/operator-runs-fixtures';

const HUB = path.resolve(__dirname, '../../src/frontend/command-hub');
const JS = fs.readFileSync(path.join(HUB, 'pipeline-tree.js'), 'utf8');
const CSS = fs.readFileSync(path.join(HUB, 'pipeline-tree.css'), 'utf8');
const INDEX = fs.readFileSync(path.join(HUB, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(HUB, 'app.js'), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PT = require('../../src/frontend/command-hub/pipeline-tree.js');

async function viewOf(s: FixtureState): Promise<RunView> {
  resetRunViewCaches();
  const r = await buildRunViewWith(fixtureDeps(s), s.vtid, { threadId: THREAD });
  if (!r.ok) throw new Error('view');
  return JSON.parse(JSON.stringify(r.view));
}

function render(v: RunView, extra: Record<string, unknown> = {}): FakeEl {
  return PT.renderCard(v, { doc: fakeDocument, now: T0 + 6 * 60_000 + 12_000, live: true, updatedAt: T0 + 6 * 60_000 + 10_000, state: { nodes: {}, showCommits: false, note: '' }, ...extra });
}

const texts = (els: FakeEl[]): string[] => els.map((e) => e.textContent);
const row = (card: FakeEl, id: string): FakeEl => {
  const r = card.all('pt-row').find((e) => e.getAttribute('data-node') === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};

describe('VTID-05069 run card — state 1 (running in both repos)', () => {
  it('header: spinner, VTID · title, step summary, started time + duration, Collapse and Stop', async () => {
    const card = render(await viewOf(STATE_RUNNING));
    expect(card.tagName).toBe('SECTION');
    expect(card.getAttribute('aria-label')).toBe('Pipeline VTID-05071');
    const head = card.one('pt-run-h');
    expect(head.one('pt-ic').className).toContain('pt-ic--running');
    expect(head.one('pt-ttl').textContent).toBe('VTID-05071 · Operator activity spinner');
    expect(head.one('pt-sum').textContent).toBe('2 repos · step 2 of 6');
    expect(head.one('pt-sum').getAttribute('aria-live')).toBe('polite');
    expect(head.one('pt-run-time').textContent).toMatch(/^started \d\d:\d\d · 36m 12s$/);
    expect(texts(head.byTag('button'))).toEqual(['Collapse', 'Stop']);
    expect(head.byTag('button')[0].getAttribute('aria-expanded')).toBe('true');
  });

  it('tree rows in order with status icons, the parallel chip and the live "now:" line', async () => {
    const card = render(await viewOf(STATE_RUNNING));
    expect(card.all('pt-row').map((r) => r.getAttribute('data-node'))).toEqual([
      'plan', 'repos',
      'repo:vitana-platform', 'repo:vitana-platform:implement', 'repo:vitana-platform:pr', 'repo:vitana-platform:ci', 'repo:vitana-platform:merge',
      'repo:vitana-v1', 'repo:vitana-v1:implement', 'repo:vitana-v1:pr', 'repo:vitana-v1:ci', 'repo:vitana-v1:merge',
      'staging', 'verify', 'gate2', 'production',
    ]);
    expect(row(card, 'plan').one('pt-ic').getAttribute('aria-label')).toBe('passed');
    expect(row(card, 'staging').one('pt-ic').getAttribute('aria-label')).toBe('waiting to start');
    expect(row(card, 'repos').one('pt-chip').textContent).toBe('parallel');
    expect(row(card, 'repo:vitana-platform').className).toContain('pt-lvl2');
    expect(row(card, 'repo:vitana-platform:implement').className).toContain('pt-lvl3');
    expect(texts(card.all('pt-live'))[0]).toBe('now: Editing app.js — renderOperatorLiveTranscript()');
    expect(card.one('pt-updated').textContent).toBe('Live · updated 2s ago');
  });

  it('a caret collapses a node through the callback; the card toggle and Stop call theirs', async () => {
    const calls: string[] = [];
    const card = render(await viewOf(STATE_RUNNING), {
      onToggleNode: (id: string, open: boolean) => calls.push(`node:${id}:${open}`),
      onToggleCard: () => calls.push('card'),
      onStop: () => calls.push('stop'),
    });
    const caret = row(card, 'repos').one('pt-car');
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(caret.getAttribute('aria-label')).toBe('Collapse Repositories');
    caret.click();
    card.one('pt-run-h').byTag('button')[0].click();
    card.one('pt-run-h').byTag('button')[1].click();
    expect(calls).toEqual(['node:repos:false', 'card', 'stop']);
  });

  it('a node collapsed by the viewer hides its children', async () => {
    const card = render(await viewOf(STATE_RUNNING), { state: { nodes: { repos: false }, showCommits: false, note: '' } });
    expect(card.all('pt-row').map((r) => r.getAttribute('data-node'))).toEqual(['plan', 'repos', 'staging', 'verify', 'gate2', 'production']);
  });
});

describe('VTID-05069 run card — state 2 (CI failed, fix forward)', () => {
  it('the failing check as a red line, the attempt chip, and the live step under the fix', async () => {
    const card = render(await viewOf(STATE_FIXING));
    expect(card.one('pt-sum').textContent).toBe('2 repos · fix attempt 1 of 3');
    expect(row(card, 'repo:vitana-platform:ci').one('pt-ic').getAttribute('aria-label')).toBe('failed');
    expect(row(card, 'repo:vitana-platform:ci').one('pt-det').textContent).toBe('11 of 12 checks passed');
    expect(texts(card.all('pt-err'))).toEqual(['✕ gateway-jest — vtid-04465 operator pipeline › "kiro attachment is stored" — expected 201, got 400']);
    expect(row(card, 'repo:vitana-platform:fix').one('pt-chip').textContent).toBe('attempt 1 of 3');
    expect(texts(card.all('pt-live'))).toEqual(['now: Running jest test/vtid-04465-operator-pipeline-regression.test.ts']);
    const pr = row(card, 'repo:vitana-platform:pr').byTag('a')[0];
    expect(pr.textContent).toBe('#4127');
    expect(pr.getAttribute('href')).toBe('https://github.com/exafyltd/vitana-platform/pull/4127');
    expect(pr.getAttribute('rel')).toBe('noopener noreferrer');
    // vitana-v1 merged: collapsed by the server, so its steps are hidden.
    expect(card.all('pt-row').some((r) => r.getAttribute('data-node') === 'repo:vitana-v1:merge')).toBe(false);
  });
});

describe('VTID-05069 run card — state 3 (Gate 2)', () => {
  it('waiting icon, Gate 2 box with the question, Show N commits and Yes, publish', async () => {
    const calls: string[] = [];
    const card = render(await viewOf(STATE_GATE2), { onPublish: (s: string) => calls.push(`publish:${s}`), onToggleCommits: () => calls.push('commits') });
    expect(card.one('pt-run-h').one('pt-ic').getAttribute('aria-label')).toBe('waiting for you');
    expect(card.one('pt-sum').textContent).toBe('waiting for you');
    expect(texts(card.one('pt-run-h').byTag('button'))).toEqual(['Collapse']);
    const gate = card.one('pt-gate');
    expect(gate.one('pt-gate-q').textContent).toBe('Staging verified — ready for deployment to production?');
    const buttons = gate.byTag('button');
    expect(texts(buttons)).toEqual(['Show 3 commits', 'Yes, publish gateway']);
    const frontend = gate.byTag('a')[0];
    expect(frontend.textContent).toBe('Publish community-app ↗');
    expect(frontend.getAttribute('href')).toBe('https://github.com/exafyltd/vitana-v1/actions/workflows/AWS-PROD-DEPLOY-FRONTEND.yml');
    buttons[0].click();
    buttons[1].click();
    expect(calls).toEqual(['commits', 'publish:gateway']);
    expect(row(card, 'gate2').one('pt-meta-t').textContent).toBe('waiting 21m 12s');
    expect(row(card, 'repos').byTag('a').map((a) => a.textContent)).toEqual(['#4127', '#2210']);
  });

  it('Show commits lists every commit PUBLISH would ship, this VTID\'s highlighted', async () => {
    const card = render(await viewOf(STATE_GATE2), { state: { nodes: {}, showCommits: true, note: '' } });
    const items = card.all('pt-commit');
    expect(items.map((i) => i.className)).toEqual(['pt-commit pt-commit--mine', 'pt-commit', 'pt-commit pt-commit--mine']);
    expect(items.map((i) => i.one('pt-commit-tag').textContent)).toEqual(['this VTID', 'also ships', 'this VTID']);
    expect(items[1].one('pt-sha').textContent).toBe('5e5e5e5');
    expect(card.one('pt-gate').byTag('button')[0].textContent).toBe('Hide 3 commits');
  });

  it('a finished run is collapsed to its header (Expand), unknown sources are listed in the footer', async () => {
    const v = await viewOf(STATE_DONE);
    v.unavailable = ['gateway production compare: timeout'];
    const card = render(v, { live: false });
    expect(card.className).toContain('pt-run--collapsed');
    expect(card.all('pt-tree')).toHaveLength(0);
    expect(texts(card.one('pt-run-h').byTag('button'))).toEqual(['Expand']);
    expect(card.one('pt-sum').textContent).toBe('in production');
    expect(card.one('pt-warn').textContent).toBe('Unavailable: gateway production compare: timeout');
    expect(card.one('pt-updated').textContent).toMatch(/^Not live/);
  });
});

describe('VTID-05069 SSE frame parser', () => {
  it('splits complete frames, keeps the partial tail, skips heartbeats', () => {
    const r = PT.parseSse(': heartbeat x\n\nevent: view\ndata: {"a":1}\n\nevent: end\ndata: {"reason":"terminal"}\n\nevent: view\ndata: {"b"');
    expect(r.events).toEqual([{ event: 'view', data: '{"a":1}' }, { event: 'end', data: '{"reason":"terminal"}' }]);
    expect(r.rest).toBe('event: view\ndata: {"b"');
  });
  it('formats durations', () => {
    expect(PT._format.duration(372_000)).toBe('6m 12s');
    expect(PT._format.duration(78 * 60_000)).toBe('1h 18m');
    expect(PT._format.ago(4_000)).toBe('4s ago');
  });
});

describe('VTID-05069 wiring, CSP and styles', () => {
  it('index.html loads pipeline-tree.css and pipeline-tree.js (before app.js), cache-busted', () => {
    expect(INDEX).toContain('<link rel="stylesheet" href="/command-hub/pipeline-tree.css?v=20261112-vtid-05069" />');
    const pt = INDEX.indexOf('<script src="/command-hub/pipeline-tree.js?v=20261112-vtid-05069"></script>');
    expect(pt).toBeGreaterThan(0);
    expect(pt).toBeLessThan(INDEX.indexOf('/command-hub/app.js?v='));
    expect(INDEX).toContain('/command-hub/app.js?v=20261112-vtid-05069');
    expect(INDEX).toContain('/command-hub/styles.css?v=20261112-vtid-05069');
  });

  it('app.js only calls the two hooks', () => {
    expect(APP).toContain('messages.appendChild(window.PipelineTree.renderThreadCards(state.operatorActiveThreadId));');
    expect(APP).toContain('meta.appendChild(window.PipelineTree.threadDot(thread.id));');
    expect((APP.match(/PipelineTree/g) || []).length).toBe(4);
  });

  it('CSP: no innerHTML, no inline styles, no eval, no external hosts; English admin text', () => {
    expect(JS).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(JS).not.toMatch(/\.style\.|cssText|setAttribute\('style'/);
    expect(JS).not.toMatch(/https?:\/\/(?!github\.com)/);
    expect(JS).toContain("'/api/v1/operator/runs'");
    expect(JS).toContain("'/api/v1/operator/kiro/runs/'");
    expect(JS).toContain("'/api/v1/dev-autopilot/executions/'");
  });

  it('stream: fetch with the hub auth headers (not EventSource), aborted when not wanted', () => {
    expect(JS).toContain('root.buildContextHeaders');
    expect(JS).not.toContain('new EventSource');
    expect(JS).toContain('controller.abort()');
  });

  it('styles: every status icon, reduced motion stills the spinners, phone layout', () => {
    for (const s of ['pending', 'running', 'passed', 'failed', 'waiting', 'skipped', 'unknown']) expect(CSS).toContain(`.pt-ic--${s}`);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.pt-ic--running,\s*\.pt-thread-dot--running \{\s*animation: none;/);
    expect(CSS).toContain('@media (max-width: 700px)');
    expect(CSS).not.toMatch(/@import|url\(/);
  });

  it('allowlisted in the Command Hub ownership guard', () => {
    const guard = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/ci/command-hub-ownership-guard.js'), 'utf8');
    expect(guard).toMatch(/ALLOWED_VTID_PATTERN = \/[^\n]*VTID-05069\|/);
  });
});
