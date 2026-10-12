/**
 * VTID-05069: the Operator pipeline tree — services/operator-runs/run-view.ts and
 * routes/operator-runs.ts. buildRunView over fixture sources for the three mock
 * states (running in both repos; CI failed + fix attempt; staging verified awaiting
 * Gate 2) and a finished run; a failing source → only its nodes unknown + listed in
 * `unavailable`; the GitHub search budget; VTID validation; thread linking; the
 * SSE follow loop (change-only resend, close on terminal); auth on every route.
 */
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAdminAuth: (req: any, res: any, next: any) => {
    const user = req.header('x-test-user');
    if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    if (req.header('x-test-admin') !== 'yes') return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    req.identity = { user_id: user, exafy_admin: true };
    return next();
  },
}));

import {
  buildRunViewWith, buildRunView, buildThreadRuns, linkedVtidsFor, followRunView, prHitsFor,
  setRunViewDepsForTests, setRunViewClockForTests, resetRunViewCaches, summarizeCheckRuns, parseFrontendVersion,
  aggregateStatus, nextPollMs, RUN_VIEW_STREAM, type RunView, type RunNode, type ThreadLinkDeps,
} from '../src/services/operator-runs/run-view';
import { fixtureDeps, STATE_RUNNING, STATE_FIXING, STATE_GATE2, STATE_DONE, THREAD, T0, type FixtureState } from './fixtures/operator-runs-fixtures';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/operator-runs').default;

function find(nodes: RunNode[], id: string): RunNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = find(n.children || [], id);
    if (c) return c;
  }
  return undefined;
}
const node = (v: RunView, id: string): RunNode => {
  const n = find(v.nodes, id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};

async function view(s: FixtureState, opts: { threadId?: string } = {}): Promise<RunView> {
  const r = await buildRunViewWith(fixtureDeps(s), s.vtid, { threadId: opts.threadId ?? THREAD });
  if (!r.ok) throw new Error(r.error);
  return r.view;
}

beforeEach(() => {
  resetRunViewCaches();
  setRunViewDepsForTests(null, null);
  setRunViewClockForTests(null);
});

describe('state 1 — work running in both repos', () => {
  it('plan passed, both repos implementing with the live Kiro step, everything after pending', async () => {
    const v = await view(STATE_RUNNING);
    expect(v.status).toBe('running');
    expect(v.terminal).toBe(false);
    expect(node(v, 'plan')).toMatchObject({ status: 'passed', detail: 'sparred 2 rounds · converged', meta: 'Gate 1 approved' });
    expect(node(v, 'repos')).toMatchObject({ status: 'running', chip: { text: 'parallel', kind: 'parallel' } });
    for (const repo of ['vitana-platform', 'vitana-v1']) {
      expect(node(v, `repo:${repo}`)).toMatchObject({ status: 'running', detail: 'kiro/0adc6ff6/operator-spinner' });
      expect(node(v, `repo:${repo}:implement`)).toMatchObject({ status: 'running', meta: 'Kiro · 14 tool calls', live: 'Editing app.js — renderOperatorLiveTranscript()' });
      expect(node(v, `repo:${repo}:pr`).status).toBe('pending');
      expect(node(v, `repo:${repo}:ci`).status).toBe('pending');
      expect(node(v, `repo:${repo}:merge`).status).toBe('pending');
    }
    for (const id of ['staging', 'verify', 'gate2', 'production']) expect(node(v, id).status).toBe('pending');
    expect(v.actions).toEqual({ kiro_run_id: 'b5069000-0000-4000-8000-000000000001', autopilot_execution_id: null });
    expect(v.summary).toBe('2 repos · step 2 of 6');
    expect(v.unavailable).toEqual([]);
    expect(v.gate2).toBeNull();
  });

  it('Kiro working before any push: one "Kiro workspace" node under Repositories, repos not started', async () => {
    const v = await view({ ...STATE_RUNNING, kiroEvents: [{ ...STATE_RUNNING.kiroEvents![0], topic: 'operator.kiro.write_tool_called', repo: null, branch: null }] });
    expect(node(v, 'repos:kiro')).toMatchObject({ status: 'running', live: 'Editing app.js — renderOperatorLiveTranscript()' });
    expect(node(v, 'repo:vitana-platform')).toMatchObject({ status: 'pending', detail: 'no branch or pull request yet' });
    expect(node(v, 'repos').status).toBe('running');
  });

  it('a Kiro approval card turns Implement into waiting-for-you', async () => {
    const v = await view({ ...STATE_RUNNING, kiroRuns: [{ ...STATE_RUNNING.kiroRuns![0], status: 'waiting_permission' }] });
    expect(node(v, 'repo:vitana-platform:implement')).toMatchObject({ status: 'waiting', detail: 'Kiro asks for your approval' });
  });
});

describe('state 2 — CI failed, fixed automatically', () => {
  it('CI failed with the failing check, fix forward attempt 1 of 3 running with the live step, v1 merged', async () => {
    const v = await view(STATE_FIXING);
    expect(v.status).toBe('running');
    expect(node(v, 'repo:vitana-platform:implement').status).toBe('passed');
    expect(node(v, 'repo:vitana-platform:pr')).toMatchObject({ status: 'passed', links: [{ href: 'https://github.com/exafyltd/vitana-platform/pull/4127', label: '#4127' }] });
    const ci = node(v, 'repo:vitana-platform:ci');
    expect(ci).toMatchObject({ status: 'failed', detail: '11 of 12 checks passed' });
    expect(ci.error).toBe('✕ gateway-jest — vtid-04465 operator pipeline › "kiro attachment is stored" — expected 201, got 400');
    expect(ci.links?.[0].label).toBe('run log');
    expect(node(v, 'repo:vitana-platform:fix')).toMatchObject({
      status: 'running', chip: { text: 'attempt 1 of 3', kind: 'loop' }, live: 'Running jest test/vtid-04465-operator-pipeline-regression.test.ts',
    });
    expect(node(v, 'repo:vitana-platform')).toMatchObject({ status: 'running' });
    expect(node(v, 'repo:vitana-v1')).toMatchObject({ status: 'passed', collapsed: true });
    expect(node(v, 'repo:vitana-v1:merge')).toMatchObject({ status: 'passed', meta: 'a91c0e2' });
    expect(node(v, 'staging').status).toBe('pending');
    expect(node(v, 'gate2').status).toBe('pending');
    expect(node(v, 'production').status).toBe('pending');
    expect(v.summary).toBe('2 repos · fix attempt 1 of 3');
  });

  it('counts pushes after the first failed CI and stops after 3 attempts (terminal, failed)', async () => {
    const shas = ['f0', 'f1', 'f2', 'f3'];
    const failing = { name: 'gateway-jest', summary: 'still red' };
    const s: FixtureState = {
      ...STATE_FIXING,
      kiroRuns: [{ ...STATE_FIXING.kiroRuns![0], status: 'completed' }],
      prDetail: { ...STATE_FIXING.prDetail, 'exafyltd/vitana-platform#4127': { ...STATE_FIXING.prDetail!['exafyltd/vitana-platform#4127'], head_sha: 'f3' } },
      prCommits: { 'exafyltd/vitana-platform#4127': shas },
      checks: Object.fromEntries(shas.map((x) => [x, { total: 12, passed: 11, failed: 1, running: 0, first_failure: { ...failing, url: null }, url: null }])),
    };
    const v = await view(s);
    expect(node(v, 'repo:vitana-platform:fix')).toMatchObject({ status: 'failed', chip: { text: 'attempt 3 of 3', kind: 'loop' }, error: '3 fix attempts failed — it stops and asks you' });
    expect(v.terminal).toBe(true);
    expect(v.status).toBe('failed');
    expect(v.actions.kiro_run_id).toBeNull();
  });

  it('a green head after a failure: fix forward passed, CI passed', async () => {
    const s: FixtureState = {
      ...STATE_FIXING,
      prDetail: { ...STATE_FIXING.prDetail, 'exafyltd/vitana-platform#4127': { ...STATE_FIXING.prDetail!['exafyltd/vitana-platform#4127'], head_sha: 'g2' } },
      prCommits: { 'exafyltd/vitana-platform#4127': ['g1', 'g2'] },
      checks: { g1: { total: 12, passed: 11, failed: 1, running: 0, first_failure: null, url: null }, g2: { total: 12, passed: 12, failed: 0, running: 0, first_failure: null, url: null } },
    };
    const v = await view(s);
    expect(node(v, 'repo:vitana-platform:ci')).toMatchObject({ status: 'passed', detail: '12 of 12 checks passed' });
    expect(node(v, 'repo:vitana-platform:fix')).toMatchObject({ status: 'passed', detail: 'fixed in attempt 1 of 3' });
  });
});

describe('state 3 — staging verified, waiting for your yes', () => {
  it('repos collapsed with both PRs, deploy + verify passed, Gate 2 waiting with every commit PUBLISH would ship', async () => {
    const v = await view(STATE_GATE2);
    expect(v.status).toBe('waiting');
    expect(v.summary).toBe('waiting for you');
    expect(v.terminal).toBe(false);
    expect(node(v, 'repos')).toMatchObject({ status: 'passed', collapsed: true, detail: '2 PRs merged' });
    expect(node(v, 'repos').links?.map((l) => l.label)).toEqual(['#4127', '#2210']);
    expect(node(v, 'staging')).toMatchObject({ status: 'passed', detail: 'gateway 7f3e1d0 · community-app a91c0e2' });
    expect(node(v, 'verify')).toMatchObject({ status: 'passed', detail: 'gateway 2/2 suites passed · community-app 1/1 suites passed' });
    expect(node(v, 'gate2')).toMatchObject({ status: 'waiting', chip: { text: 'your approval', kind: 'gate' } });
    expect(node(v, 'production').status).toBe('pending');
    expect(v.gate2).not.toBeNull();
    expect(v.gate2!.question).toBe('Staging verified — ready for deployment to production?');
    expect(v.gate2!.commits).toEqual([
      { sha: '7f3e1d0eeee', message: '[gateway] VTID-05072: paste images in the Operator chat (#4127)', mine: true },
      { sha: '5e5e5e5aaaa', message: '[gateway] VTID-05070: ORB widget copy fix (#4125)', mine: false },
      { sha: 'a91c0e2ffff', message: '[community-app] VTID-05072: paste images (community app) (#2210)', mine: true },
    ]);
    expect(v.gate2!.publish).toEqual([
      { service: 'gateway', kind: 'publish_flow' },
      { service: 'community-app', kind: 'link', href: 'https://github.com/exafyltd/vitana-v1/actions/workflows/AWS-PROD-DEPLOY-FRONTEND.yml' },
    ]);
    expect(v.actions).toEqual({ kiro_run_id: null, autopilot_execution_id: null });
  });

  it('STAGING-VERIFY failed: red line with the failing suite, no Gate 2', async () => {
    const s: FixtureState = {
      ...STATE_GATE2,
      verify: [{ ...STATE_GATE2.verify![0], topic: 'staging.verify.failed', results: [{ suite: 'VTID-05072', name: 'paste', ok: false, problems: ['expected 200, got 500'] }] }, STATE_GATE2.verify![1]],
    };
    const v = await view(s);
    expect(node(v, 'verify')).toMatchObject({ status: 'failed', error: '✕ gateway › VTID-05072 › paste — expected 200, got 500' });
    expect(node(v, 'gate2').status).toBe('pending');
    expect(v.gate2).toBeNull();
    expect(v.status).toBe('failed');
  });

  it('production contains both merges → Gate 2 + Production passed, terminal, done', async () => {
    const v = await view(STATE_DONE);
    expect(node(v, 'production')).toMatchObject({ status: 'passed' });
    expect(node(v, 'gate2').status).toBe('passed');
    expect(v).toMatchObject({ status: 'done', terminal: true, summary: 'in production' });
  });
});

describe('failing sources', () => {
  it('GitHub search down → PR/CI/Merge unknown and listed in unavailable; the plan still shows', async () => {
    const v = await view({ ...STATE_FIXING, fail: { searchPrs: 'GitHub API error: 502' } });
    expect(node(v, 'plan').status).toBe('passed');
    // vitana-platform is known from the Kiro push; its GitHub nodes are unknown.
    for (const id of ['pr', 'ci', 'merge']) expect(node(v, `repo:vitana-platform:${id}`).status).toBe('unknown');
    expect(node(v, 'repo:vitana-platform:implement').status).toBe('running');
    // vitana-v1 is known only from GitHub: the whole repo is unknown.
    expect(node(v, 'repo:vitana-v1').status).toBe('unknown');
    expect(v.unavailable.join(' ')).toContain('GitHub search: GitHub API error: 502');
    expect(v.stale).toBe(false);
  });

  it('check runs down → only CI unknown', async () => {
    const v = await view({ ...STATE_FIXING, fail: { checkSummary: 'GitHub API error: 403' } });
    expect(node(v, 'repo:vitana-platform:ci').status).toBe('unknown');
    expect(node(v, 'repo:vitana-platform:pr').status).toBe('passed');
    expect(v.unavailable.some((u) => u.startsWith('vitana-platform checks: GitHub API error: 403'))).toBe(true);
  });

  it('sparring store down → Plan unknown; production version down → Production + Gate 2 unknown', async () => {
    const v = await view({ ...STATE_GATE2, fail: { loadSparring: 'timeout', productionCommit: 'HTTP 503' } });
    expect(node(v, 'plan').status).toBe('unknown');
    expect(node(v, 'production').status).toBe('unknown');
    expect(node(v, 'gate2').status).toBe('unknown');
    expect(v.unavailable).toEqual(expect.arrayContaining(['plan sparring: timeout', 'gateway production version: HTTP 503']));
  });
});

describe('GitHub search budget (10/min) and the 30 s cache', () => {
  it('one search per VTID per 30 s; past 10 searches a minute the last result is reused and marked stale', async () => {
    const deps = fixtureDeps(STATE_FIXING, () => T0);
    let now = T0;
    for (let i = 0; i < 10; i++) {
      const r = await prHitsFor(deps, [`VTID-0${5100 + i}`], now);
      expect(r.failed.size).toBe(0);
    }
    expect(deps.calls.searchPrs).toBe(10);
    // An 11th VTID never searched: no cache → failed with the budget reason.
    const r11 = await prHitsFor(deps, ['VTID-05200'], now);
    expect(r11.failed.get('VTID-05200')).toBe('GitHub search budget reached (10/min)');
    expect(deps.calls.searchPrs).toBe(10);
    // A cached VTID past its 30 s: reused as stale while the budget is spent.
    now += 31_000;
    const again = await prHitsFor(deps, ['VTID-05100'], now);
    expect(again.stale.has('VTID-05100')).toBe(true);
    expect(deps.calls.searchPrs).toBe(10);
    // A minute later the budget is back.
    now += 60_000;
    const fresh = await prHitsFor(deps, ['VTID-05100'], now);
    expect(fresh.stale.size).toBe(0);
    expect(deps.calls.searchPrs).toBe(11);
  });

  it('buildRunView serves the cached view for 30 s to every viewer', async () => {
    let now = T0;
    const deps = fixtureDeps(STATE_FIXING, () => now);
    setRunViewDepsForTests(deps);
    await buildRunView('VTID-05072', { threadId: THREAD });
    await buildRunView('VTID-05072', { threadId: THREAD });
    expect(deps.calls.loadLedger).toBe(1);
    now += 31_000;
    await buildRunView('VTID-05072', { threadId: THREAD });
    expect(deps.calls.loadLedger).toBe(2);
  });
});

describe('validation', () => {
  it.each(['VTID-5069', 'vtid-05069', 'VTID-050690', 'VTID-05069; drop', ''])('rejects %p', async (bad) => {
    const r = await buildRunViewWith(fixtureDeps(STATE_RUNNING), bad);
    expect(r).toEqual({ ok: false, error: 'invalid_vtid' });
  });
});

describe('thread linking', () => {
  const link = (over: Partial<ThreadLinkDeps> = {}): ThreadLinkDeps => ({
    loadThreadOwner: async () => ({ exists: true, user_id: 'u1' }),
    loadThreadKiroVtids: async () => [{ vtid: 'VTID-05072', at: '2026-10-10T19:00:00Z' }, { vtid: 'VTID-05072', at: '2026-10-10T19:30:00Z' }],
    loadThreadAssistantTexts: async () => [
      { content: 'Working on VTID-05071 now. Tests live in test/vtid-04465-operator-pipeline-regression.test.ts (VTID-04465).', at: '2026-10-10T20:40:00Z' },
      { content: 'VTID-09999 does not exist', at: '2026-10-10T20:41:00Z' },
    ],
    ledgerExisting: async (v) => v.filter((x) => x !== 'VTID-09999'),
    ...over,
  });

  it('Kiro-event VTIDs and ledger-backed assistant mentions, newest first, unknown VTIDs dropped', async () => {
    expect(await linkedVtidsFor(link(), THREAD)).toEqual(['VTID-05071', 'VTID-04465', 'VTID-05072']);
  });

  it('at most 5', async () => {
    const texts = Array.from({ length: 8 }, (_, i) => ({ content: `VTID-0510${i}`, at: `2026-10-10T20:0${i}:00Z` }));
    const r = await linkedVtidsFor(link({ loadThreadKiroVtids: async () => [], loadThreadAssistantTexts: async () => texts }), THREAD);
    expect(r).toEqual(['VTID-05107', 'VTID-05106', 'VTID-05105', 'VTID-05104', 'VTID-05103']);
  });

  it('by-thread: one GitHub search for all of the thread\'s VTIDs; no linked VTID → no views', async () => {
    const deps = fixtureDeps(STATE_FIXING, () => T0);
    setRunViewDepsForTests(deps, link({ loadThreadAssistantTexts: async () => [{ content: 'VTID-05071 and VTID-05072', at: '2026-10-10T20:50:00Z' }] }));
    const r = await buildThreadRuns(THREAD, 'u1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vtids).toEqual(['VTID-05071', 'VTID-05072']);
    expect(r.views.map((v) => v.vtid)).toEqual(['VTID-05071', 'VTID-05072']);
    expect(deps.calls.searchPrs).toBe(1);

    resetRunViewCaches();
    setRunViewDepsForTests(deps, link({ loadThreadKiroVtids: async () => [], loadThreadAssistantTexts: async () => [] }));
    const empty = await buildThreadRuns(THREAD, 'u1');
    expect(empty).toEqual({ ok: true, thread_id: THREAD, vtids: [], views: [], unavailable: [] });
  });

  it('another user\'s thread → forbidden; a bad thread id → invalid', async () => {
    setRunViewDepsForTests(fixtureDeps(STATE_FIXING), link());
    expect(await buildThreadRuns(THREAD, 'someone-else')).toEqual({ ok: false, error: 'forbidden' });
    expect(await buildThreadRuns('../etc', 'u1')).toEqual({ ok: false, error: 'invalid_thread' });
  });
});

describe('live follow (SSE loop)', () => {
  function fakeClock(start = T0) {
    let t = start;
    const sleeps: number[] = [];
    return { clock: { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } }, sleeps, now: () => t };
  }

  it('sends the view, then only changes; polls 15 s while running; closes 60 s after terminal', async () => {
    const c = fakeClock();
    setRunViewClockForTests(c.clock);
    // Running for the first 2 minutes, then production has it.
    const state = (): FixtureState => (c.now() - T0 < 120_000 ? { ...STATE_FIXING } : STATE_DONE);
    const deps = new Proxy({}, { get: (_t, k) => (fixtureDeps(state(), c.now) as any)[k] }) as any;
    setRunViewDepsForTests(deps);
    const sent: RunView[] = [];
    const end = await followRunView('VTID-05072', THREAD, (v) => sent.push(v), () => false);
    expect(end).toBe('terminal');
    expect(sent.length).toBe(2);
    expect(sent[0].status).toBe('running');
    expect(sent[1].status).toBe('done');
    expect(c.sleeps.slice(0, 3)).toEqual([RUN_VIEW_STREAM.runningMs, RUN_VIEW_STREAM.runningMs, RUN_VIEW_STREAM.runningMs]);
    expect(c.sleeps[c.sleeps.length - 1]).toBe(RUN_VIEW_STREAM.terminalGraceMs);
  });

  it('waits 60 s between checks while only Gate 2 is open, and stops after 2 h', async () => {
    const c = fakeClock();
    setRunViewClockForTests(c.clock);
    setRunViewDepsForTests(fixtureDeps(STATE_GATE2, c.now));
    const sent: RunView[] = [];
    const end = await followRunView('VTID-05072', THREAD, (v) => sent.push(v), () => false);
    expect(end).toBe('max_time');
    expect(sent.length).toBe(1);
    expect(new Set(c.sleeps)).toEqual(new Set([RUN_VIEW_STREAM.idleMs]));
    expect(c.now() - T0).toBeGreaterThanOrEqual(RUN_VIEW_STREAM.maxMs);
  });

  it('stops when the listener is gone', async () => {
    const c = fakeClock();
    setRunViewClockForTests(c.clock);
    setRunViewDepsForTests(fixtureDeps(STATE_FIXING, c.now));
    let closed = false;
    const sent: RunView[] = [];
    const end = await followRunView('VTID-05072', THREAD, (v) => { sent.push(v); closed = true; }, () => closed);
    expect(end).toBe('closed');
    expect(sent.length).toBe(1);
  });
});

describe('helpers', () => {
  it('summarizes check runs (failed conclusions, running, first failure)', () => {
    const s = summarizeCheckRuns([
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'completed', conclusion: 'skipped' },
      { name: 'c', status: 'completed', conclusion: 'failure', output: { title: '2 tests failed' }, html_url: 'https://x/c' },
      { name: 'd', status: 'in_progress', conclusion: null },
    ]);
    expect(s).toEqual({ total: 4, passed: 2, failed: 1, running: 1, first_failure: { name: 'c', summary: '2 tests failed', url: 'https://x/c' }, url: null });
  });
  it('reads the community-app version stamp', () => {
    expect(parseFrontendVersion('<meta name="vitana-app-version" content="a91c0e2">')).toBe('a91c0e2');
    expect(parseFrontendVersion('<html></html>')).toBeNull();
  });
  it('a running child keeps the parent running even next to a failed one', () => {
    const n = (status: any): RunNode => ({ id: status, label: status, status });
    expect(aggregateStatus([n('failed'), n('running')])).toBe('running');
    expect(aggregateStatus([n('passed'), n('skipped')])).toBe('passed');
    expect(aggregateStatus([n('passed'), n('pending')])).toBe('pending');
    expect(nextPollMs({ nodes: [{ id: 'x', label: 'x', status: 'pending', children: [n('running')] }] } as RunView)).toBe(RUN_VIEW_STREAM.runningMs);
  });
});

describe('routes /api/v1/operator/runs', () => {
  function app() {
    const a = express();
    a.use('/api/v1/operator/runs', router);
    return a;
  }
  const admin = (r: request.Test) => r.set('x-test-user', 'u1').set('x-test-admin', 'yes');

  beforeEach(() => {
    setRunViewDepsForTests(fixtureDeps(STATE_GATE2), {
      loadThreadOwner: async () => ({ exists: true, user_id: 'u1' }),
      loadThreadKiroVtids: async () => [{ vtid: 'VTID-05072', at: '2026-10-10T19:00:00Z' }],
      loadThreadAssistantTexts: async () => [],
      ledgerExisting: async (v) => v,
    });
  });

  it.each(['/VTID-05072', '/VTID-05072/stream', `/by-thread/${THREAD}`])('GET %s without a caller → 401 JSON; non-admin → 403', async (p) => {
    const r1 = await request(app()).get(`/api/v1/operator/runs${p}`);
    expect(r1.status).toBe(401);
    expect(r1.headers['content-type']).toMatch(/application\/json/);
    const r2 = await request(app()).get(`/api/v1/operator/runs${p}`).set('x-test-user', 'u1');
    expect(r2.status).toBe(403);
  });

  it('every route is behind requireAdminAuth', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/operator-runs.ts'), 'utf8');
    const routes = src.match(/router\.(get|post|put|patch|delete)\(/g) || [];
    expect(routes.length).toBe(3);
    expect((src.match(/router\.get\('[^']+', requireAdminAuth,/g) || []).length).toBe(3);
  });

  it('GET /:vtid → the view; invalid VTID or thread id → 400', async () => {
    const ok = await admin(request(app()).get('/api/v1/operator/runs/VTID-05072?thread_id=' + THREAD));
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.view.vtid).toBe('VTID-05072');
    expect(ok.body.view.status).toBe('waiting');
    expect((await admin(request(app()).get('/api/v1/operator/runs/VTID-5072'))).status).toBe(400);
    expect((await admin(request(app()).get('/api/v1/operator/runs/VTID-05072?thread_id=a%2Fb'))).status).toBe(400);
    expect((await admin(request(app()).get('/api/v1/operator/runs/VTID-5072/stream'))).status).toBe(400);
  });

  it('GET /by-thread/:threadId → linked VTIDs + views; another user\'s thread → 403', async () => {
    const ok = await admin(request(app()).get(`/api/v1/operator/runs/by-thread/${THREAD}`));
    expect(ok.status).toBe(200);
    expect(ok.body.vtids).toEqual(['VTID-05072']);
    expect(ok.body.views[0].gate2.question).toBe('Staging verified — ready for deployment to production?');
    const other = await request(app()).get(`/api/v1/operator/runs/by-thread/${THREAD}`).set('x-test-user', 'u2').set('x-test-admin', 'yes');
    expect(other.status).toBe(403);
  });

  it('GET /:vtid/stream → SSE view frame, then end after the terminal grace', async () => {
    let t = T0;
    setRunViewClockForTests({ now: () => t, sleep: async (ms) => { t += ms; } });
    setRunViewDepsForTests(fixtureDeps(STATE_DONE, () => t));
    const r = await admin(request(app()).get('/api/v1/operator/runs/VTID-05072/stream'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    const frames = r.text.split('\n\n').filter((f) => f.startsWith('event:'));
    expect(frames.map((f) => f.split('\n')[0])).toEqual(['event: view', 'event: end']);
    expect(JSON.parse(frames[0].split('\n')[1].slice(6)).status).toBe('done');
    expect(frames[1]).toContain('"reason":"terminal"');
  });
});

describe('wiring', () => {
  const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  it('mounted at /api/v1/operator/runs before the operator router; atlas agents domain owns it', () => {
    const index = src('src/index.ts');
    const mount = index.indexOf("'/api/v1/operator/runs', require('./routes/operator-runs').default");
    expect(mount).toBeGreaterThan(0);
    expect(mount).toBeLessThan(index.indexOf("mountRouterSync(app, '/api/v1/operator', operatorRouter"));
    expect(src('src/orb/developer/domain-atlas.ts')).toMatch(/\/\^operator-runs\$\//);
  });
  it('run-view writes nothing (GET-only REST reads)', () => {
    const rv = src('src/services/operator-runs/run-view.ts');
    expect(rv).not.toMatch(/method:\s*'(POST|PATCH|PUT|DELETE)'/);
    expect(rv).not.toMatch(/emitOasisEvent/);
  });
});
