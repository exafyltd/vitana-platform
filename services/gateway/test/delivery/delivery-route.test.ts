/**
 * VTID-05547 (plan agentic-delivery §3.12, tasks.md G1) — GET /api/v1/delivery/summary and /metrics.
 *
 * Pins: no token → 401 JSON; a signed-in non-admin → 403; the service token and an exafy_admin → 200; the summary is built
 * only from vtid_ledger and oasis_events (the readers are fakes, and nothing else is fetched); the queue order comes from the
 * labels; a metric without a source is null, never 0; shadow rows are left out unless asked for; one row per dedupe_key;
 * the cut flag is reported per repository; an unreachable source answers 502 JSON with no error text.
 */
import express from 'express';
import request from 'supertest';

let identity: Record<string, unknown> | null = null;
jest.mock('../../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../../src/middleware/auth-supabase-jwt');
  return { ...actual, optionalAuth: (req: any, _res: any, next: () => void) => { if (identity) req.identity = identity; next(); } };
});

import { DEFAULT_WINDOW_HOURS, EVENT_READ_LIMIT, MAX_WINDOW_HOURS, createDeliveryRouter, postgrestReaders, type DeliveryReaders } from '../../src/routes/delivery';
import { DELIVERY_READ_TOPICS, buildMergeQueue, buildMetrics, buildPipelines, buildReleases, dedupeRows, spread, type EventRow, type LedgerRow } from '../../src/services/gitlab-events/delivery-summary';
import { base, row } from './fixtures';

const fetchMock = global.fetch as unknown as jest.Mock;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ENV0 = { ...process.env };

function readers(rows: EventRow[], ledger: LedgerRow[] = []) {
  const r = {
    readEvents: jest.fn(async (_q: { topics: readonly string[]; sinceIso: string; limit: number }) => rows),
    readLedger: jest.fn(async (_v: string[]) => ledger),
  };
  return r satisfies DeliveryReaders;
}

function appWith(deps: Parameters<typeof createDeliveryRouter>[0]) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/delivery', createDeliveryRouter({ now: () => NOW, env: {} as NodeJS.ProcessEnv, ...deps }));
  return a;
}
const asAdmin = () => { identity = { user_id: 'admin-1', exafy_admin: true }; };
const get = (a: express.Express, url: string, token = 'fake-jwt') => request(a).get(url).set('Authorization', `Bearer ${token}`);

// ---- fixture rows ---------------------------------------------------------------------------------------------

const mr = (topic: string, at: string, iid: number, label: string | null, over: Record<string, unknown> = {}, vtid = `VTID-0000${iid}`, repo = 'vitana-platform') =>
  row(`scm.gitlab.merge_request.${topic}`, at, base({ repo, merge_request_iid: iid, queue_label: label, lane_key: `plan/lane-${iid}`, head_sha: `sha${iid}`, url: `https://gitlab.example.invalid/${repo}/-/merge_requests/${iid}`, dedupe_key: `k:${repo}:${iid}:${topic}:${at}`, ...over }), { vtid });

const QUEUE_ROWS: EventRow[] = [
  mr('opened', '2026-11-05T11:00:00Z', 1, null),
  mr('updated', '2026-11-05T11:10:00Z', 1, 'queue-ready'),
  mr('updated', '2026-11-05T11:20:00Z', 1, 'queue-ready', { new_head: true }), // a new head, same label: since stays 11:10
  mr('opened', '2026-11-05T10:00:00Z', 2, 'queue-ready'),
  mr('opened', '2026-11-05T09:30:00Z', 3, 'queue-waiting'),
  mr('updated', '2026-11-05T11:30:00Z', 3, 'queue-updating'),
  mr('opened', '2026-11-05T09:00:00Z', 4, 'queue-waiting'),
  mr('opened', '2026-11-05T08:00:00Z', 5, 'queue-blocked'),
  mr('opened', '2026-11-05T08:30:00Z', 6, 'queue-paused'),
  mr('opened', '2026-11-05T07:00:00Z', 7, 'queue-ready'),
  mr('merged', '2026-11-05T07:30:00Z', 7, 'queue-ready'),
  mr('opened', '2026-11-05T07:00:00Z', 8, 'queue-ready'),
  mr('closed', '2026-11-05T07:40:00Z', 8, 'queue-ready'),
  mr('opened', '2026-11-05T06:00:00Z', 9, null),
  mr('opened', '2026-11-05T10:30:00Z', 1, 'queue-ready', {}, 'VTID-00011', 'vitana-v1'),
];

describe('VTID-05547 auth — service token or exafy_admin', () => {
  it('no token → 401 JSON, and nothing is read', async () => {
    const r = readers([]);
    for (const url of ['/api/v1/delivery/summary', '/api/v1/delivery/metrics']) {
      const res = await request(appWith({ readers: r })).get(url);
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ ok: false, error: 'missing bearer token' });
    }
    expect(r.readEvents).not.toHaveBeenCalled();
    expect(r.readLedger).not.toHaveBeenCalled();
  });

  it('a wrong bearer → 401; a signed-in non-admin → 403', async () => {
    const r = readers([]);
    identity = null;
    expect((await get(appWith({ readers: r }), '/api/v1/delivery/summary', 'not-the-token')).status).toBe(401);
    identity = { user_id: 'u1', exafy_admin: false };
    const res = await get(appWith({ readers: r }), '/api/v1/delivery/summary', 'some.jwt.value');
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(r.readEvents).not.toHaveBeenCalled();
  });

  it('the gateway service token and an exafy_admin session → 200', async () => {
    process.env.GATEWAY_SERVICE_TOKEN = 'fake-svc';
    identity = null;
    expect((await get(appWith({ readers: readers([]) }), '/api/v1/delivery/summary', 'fake-svc')).status).toBe(200);
    asAdmin();
    expect((await get(appWith({ readers: readers([]) }), '/api/v1/delivery/summary')).status).toBe(200);
    expect((await get(appWith({ readers: readers([]) }), '/api/v1/delivery/metrics')).status).toBe(200);
    process.env = { ...ENV0 };
  });
});

describe('VTID-05547 the summary — built only from the ledger and OASIS', () => {
  beforeEach(() => { asAdmin(); fetchMock.mockClear(); });

  it('reads the delivery topics of the window from OASIS and the ledger rows of the VTIDs it shows, and nothing else', async () => {
    const r = readers(QUEUE_ROWS, [{ vtid: 'VTID-00003', title: 'Third lane title', status: 'in_progress', is_terminal: false, terminal_outcome: null }]);
    const res = await get(appWith({ readers: r }), '/api/v1/delivery/summary');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sources).toEqual(['vtid_ledger', 'oasis_events']);
    expect(r.readEvents).toHaveBeenCalledTimes(1);
    const q = r.readEvents.mock.calls[0][0];
    expect(q.topics).toEqual(DELIVERY_READ_TOPICS);
    expect(q.limit).toBe(EVENT_READ_LIMIT);
    expect(q.sinceIso).toBe(new Date(NOW - DEFAULT_WINDOW_HOURS * 3600 * 1000).toISOString());
    expect(r.readLedger).toHaveBeenCalledTimes(1);
    expect(r.readLedger.mock.calls[0][0].sort()).toEqual(['VTID-00001', 'VTID-00002', 'VTID-00003', 'VTID-00004', 'VTID-00005', 'VTID-00006', 'VTID-00011']);
    expect(res.body.ledger['VTID-00003']).toEqual({ title: 'Third lane title', status: 'in_progress', is_terminal: false, terminal_outcome: null });
    expect(fetchMock).not.toHaveBeenCalled(); // no other source was read
    expect(res.body.window_hours).toBe(168);
    expect(res.body.generated_at).toBe('2026-11-05T12:00:00.000Z');
  });

  it('the queue order comes from the labels: updating, then ready by accept time, then waiting; blocked and paused last with no position', async () => {
    const res = await get(appWith({ readers: readers(QUEUE_ROWS) }), '/api/v1/delivery/summary');
    const q = res.body.merge_queue['vitana-platform'];
    expect(q.items.map((i: any) => [i.merge_request_iid, i.state_label, i.position])).toEqual([
      [3, 'queue-updating', 1],
      [2, 'queue-ready', 2],
      [1, 'queue-ready', 3],
      [4, 'queue-waiting', 4],
      [5, 'queue-blocked', null],
      [6, 'queue-paused', null],
    ]);
    expect(q.paused).toBe(true);
    // Waiting time runs from the start of the current label, not from the last event.
    const byIid = Object.fromEntries(q.items.map((i: any) => [i.merge_request_iid, i]));
    expect(byIid[1].since).toBe('2026-11-05T11:10:00Z');
    expect(byIid[1].wait_s).toBe(50 * 60);
    expect(byIid[3].since).toBe('2026-11-05T11:30:00Z'); // the label changed from waiting to updating
    expect(byIid[3].wait_s).toBe(30 * 60);
    expect(byIid[2]).toMatchObject({ vtid: 'VTID-00002', lane_key: 'plan/lane-2', head_sha: 'sha2', url: 'https://gitlab.example.invalid/vitana-platform/-/merge_requests/2', mode: 'live' });
  });

  it('a merged or closed merge request, and one with no queue label, are not in the queue; each repository has its own queue', async () => {
    const res = await get(appWith({ readers: readers(QUEUE_ROWS) }), '/api/v1/delivery/summary');
    const iids = res.body.merge_queue['vitana-platform'].items.map((i: any) => i.merge_request_iid);
    for (const gone of [7, 8, 9]) expect(iids).not.toContain(gone);
    expect(res.body.merge_queue['vitana-v1'].items.map((i: any) => [i.merge_request_iid, i.position])).toEqual([[1, 1]]);
    expect(res.body.merge_queue['vitana-v1'].paused).toBe(false);
  });

  it('both repositories are always present, empty when there are no events (the empty state)', async () => {
    const res = await get(appWith({ readers: readers([]) }), '/api/v1/delivery/summary');
    for (const repo of ['vitana-platform', 'vitana-v1']) {
      expect(res.body.merge_queue[repo]).toEqual({ paused: false, items: [] });
      expect(res.body.pipelines[repo]).toEqual({ main: { state: 'unknown', pipeline_id: null, sha: null, since: null, url: null }, items: [] });
    }
    expect(res.body.releases).toEqual({ deploys: [], verifications: [], latest_verify: null });
    expect(res.body.refused_merges).toEqual({ count: 0, last_at: null });
    expect(res.body.truncated).toBe(false);
  });

  it('the latest pipeline per merge request, the state of main, and the job counts', async () => {
    const pipe = (topic: string, at: string, id: number, ref: string, iid: number | null, extra: Record<string, unknown> = {}, repo = 'vitana-platform') =>
      row(`scm.gitlab.pipeline.${topic}`, at, base({ repo, pipeline_id: id, ref, merge_request_iid: iid, sha: `s${id}`, duration_s: 60 + id, queued_s: id % 7, url: `https://gitlab.example.invalid/p/${id}`, dedupe_key: `p:${repo}:${id}:${topic}`, ...extra }));
    const rows = [
      pipe('started', '2026-11-05T10:50:00Z', 100, 'kiro/a/b', 1),
      pipe('succeeded', '2026-11-05T10:55:00Z', 100, 'kiro/a/b', 1),
      pipe('failed', '2026-11-05T10:56:00Z', 101, 'kiro/c/d', 2, { jobs: [{ name: 'a', status: 'failed' }, { name: 'b', status: 'success' }, { name: 'c', status: 'failed' }] }),
      pipe('failed', '2026-11-05T10:57:00Z', 102, 'main', null),
      pipe('succeeded', '2026-11-05T11:50:00Z', 103, 'main', null),
      pipe('failed', '2026-11-05T11:00:00Z', 200, 'main', null, {}, 'vitana-v1'),
    ];
    const res = await get(appWith({ readers: readers(rows) }), '/api/v1/delivery/summary');
    const p = res.body.pipelines['vitana-platform'];
    expect(p.main).toEqual({ state: 'green', pipeline_id: 103, sha: 's103', since: '2026-11-05T11:50:00Z', url: 'https://gitlab.example.invalid/p/103' });
    expect(p.items.map((i: any) => [i.merge_request_iid, i.ref, i.status, i.pipeline_id, i.jobs_failed])).toEqual([
      [null, 'main', 'succeeded', 103, 0],
      [2, 'kiro/c/d', 'failed', 101, 2],
      [1, 'kiro/a/b', 'succeeded', 100, 0],
    ]);
    expect(p.items[2]).toMatchObject({ run_s: 160, wait_s: 2, url: 'https://gitlab.example.invalid/p/100', mode: 'live' });
    expect(res.body.pipelines['vitana-v1'].main.state).toBe('red');
  });

  it('releases: the latest staging deploy per service (GitHub-era and GitLab rows) and the latest STAGING-VERIFY per service', async () => {
    const rows = [
      row('staging.deploy.completed', '2026-11-05T09:00:00Z', { env: 'staging', platform: 'aws-ecs', git_commit: 'oldcommit', workflow: 'AWS-STAGE-DEPLOY-GATEWAY.yml' }, { service: 'vitana-gateway-aws', vtid: 'BOOTSTRAP-AWS-STAGE-DEPLOY' }),
      row('staging.deploy.completed', '2026-11-05T10:00:00Z', { env: 'staging', platform: 'aws-ecs', git_commit: 'newcommit', workflow: 'AWS-STAGE-DEPLOY-GATEWAY.yml' }, { service: 'vitana-gateway-aws', vtid: 'BOOTSTRAP-AWS-STAGE-DEPLOY' }),
      row('staging.deploy.failed', '2026-11-05T10:30:00Z', base({ service: 'gateway', git_commit: 'gl1', workflow: 'gitlab:vitana/vitana-platform/deploy-staging:gateway', dedupe_key: 'd1' })),
      row('staging.deploy.rolled_back', '2026-11-05T10:40:00Z', base({ service: 'gateway', git_commit: 'gl1', workflow: 'gitlab:vitana/vitana-platform/rollback-staging:gateway', dedupe_key: 'd2' })),
      row('staging.verify.failed', '2026-11-05T10:10:00Z', { env: 'staging', service: 'gateway', commit: 'newcommit', outcome: 'failed', run_url: 'https://github.com/run/1', workflow: 'STAGING-VERIFY.yml' }, { service: 'staging-verify-gateway' }),
      row('staging.verify.passed', '2026-11-05T11:10:00Z', { env: 'staging', service: 'gateway', commit: 'newcommit', outcome: 'passed', run_url: 'https://gitlab.example.invalid/run/2', workflow: 'gitlab:vitana/vitana-platform/staging-verify' }, { service: 'staging-verify-gateway' }),
      row('staging.verify.superseded', '2026-11-05T11:20:00Z', { env: 'staging', service: 'community-app', commit: 'v1sha', outcome: 'superseded' }, { service: 'staging-verify-community-app' }),
    ];
    const res = await get(appWith({ readers: readers(rows) }), '/api/v1/delivery/summary');
    expect(res.body.releases.deploys).toEqual([
      { service: 'gateway', commit: 'gl1', status: 'rolled_back', at: '2026-11-05T10:40:00Z', host: 'gitlab', workflow: 'gitlab:vitana/vitana-platform/rollback-staging:gateway' },
      { service: 'vitana-gateway-aws', commit: 'newcommit', status: 'completed', at: '2026-11-05T10:00:00Z', host: 'github', workflow: 'AWS-STAGE-DEPLOY-GATEWAY.yml' },
    ]);
    expect(res.body.releases.verifications).toEqual([
      { service: 'community-app', commit: 'v1sha', outcome: 'superseded', at: '2026-11-05T11:20:00Z', run_url: null, workflow: null },
      { service: 'gateway', commit: 'newcommit', outcome: 'passed', at: '2026-11-05T11:10:00Z', run_url: 'https://gitlab.example.invalid/run/2', workflow: 'gitlab:vitana/vitana-platform/staging-verify' },
    ]);
    expect(res.body.releases.latest_verify.service).toBe('community-app');
  });

  it('shadow rows are left out unless ?include_shadow=1; a duplicate dedupe_key is one row', async () => {
    const rows = [
      mr('opened', '2026-11-05T11:00:00Z', 1, 'queue-ready'),
      mr('opened', '2026-11-05T11:00:00Z', 20, 'queue-ready', { mode: 'shadow' }),
      mr('opened', '2026-11-05T11:05:00Z', 30, 'queue-ready', { dedupe_key: 'same' }),
      mr('opened', '2026-11-05T11:06:00Z', 30, 'queue-ready', { dedupe_key: 'same' }),
    ];
    const a = appWith({ readers: readers(rows) });
    const hidden = await get(a, '/api/v1/delivery/summary');
    expect(hidden.body.include_shadow).toBe(false);
    expect(hidden.body.merge_queue['vitana-platform'].items.map((i: any) => i.merge_request_iid)).toEqual([1, 30]);
    const shown = await get(a, '/api/v1/delivery/summary?include_shadow=1');
    expect(shown.body.include_shadow).toBe(true);
    expect(shown.body.merge_queue['vitana-platform'].items.map((i: any) => i.merge_request_iid)).toEqual([1, 20, 30]);
    expect(shown.body.merge_queue['vitana-platform'].items.find((i: any) => i.merge_request_iid === 20).mode).toBe('shadow');
    // The first row of the key is the one kept.
    expect(shown.body.merge_queue['vitana-platform'].items.find((i: any) => i.merge_request_iid === 30).since).toBe('2026-11-05T11:05:00Z');
  });

  it('reports the host of each repository from the cut flag, and the refused GitHub merges', async () => {
    const env = { DELIVERY_HOST_VITANA_V1: 'gitlab' } as NodeJS.ProcessEnv;
    const rows = [
      row('delivery.merge.refused', '2026-11-05T11:00:00Z', base({ pr_number: 7, dedupe_key: 'github:x:pull:7:refused_merge' })),
      row('delivery.merge.refused', '2026-11-05T11:30:00Z', base({ pr_number: 8, dedupe_key: 'github:x:pull:8:refused_merge' })),
    ];
    const res = await get(appWith({ readers: readers(rows), env }), '/api/v1/delivery/summary');
    expect(res.body.hosts).toEqual({ 'vitana-platform': 'github', 'vitana-v1': 'gitlab' });
    expect(res.body.refused_merges).toEqual({ count: 2, last_at: '2026-11-05T11:30:00Z' });
  });

  it('the window: ?hours is clamped to 1..720 and a bad value uses the default; a full page is reported as truncated', async () => {
    const r = readers(Array.from({ length: EVENT_READ_LIMIT }, (_v, i) => mr('opened', '2026-11-05T11:00:00Z', 1000 + i, null)));
    const a = appWith({ readers: r });
    expect((await get(a, '/api/v1/delivery/summary?hours=99999')).body.window_hours).toBe(MAX_WINDOW_HOURS);
    expect((await get(a, '/api/v1/delivery/summary?hours=0')).body.window_hours).toBe(1);
    const res = await get(a, '/api/v1/delivery/summary?hours=abc');
    expect(res.body.window_hours).toBe(168);
    expect(res.body.truncated).toBe(true);
    expect(r.readEvents.mock.calls[0][0].sinceIso).toBe(new Date(NOW - MAX_WINDOW_HOURS * 3600 * 1000).toISOString());
  });

  it('one read is a bounded page of the newest 3000 events: a full page is reported as truncated, a page short of it is not', async () => {
    const page = (size: number) => Array.from({ length: size }, (_v, i) => mr('opened', '2026-11-05T11:00:00Z', 1000 + i, null));
    const full = readers(page(3000));
    expect((await get(appWith({ readers: full }), '/api/v1/delivery/summary')).body.truncated).toBe(true);
    expect(full.readEvents.mock.calls[0][0].limit).toBe(3000);
    expect((await get(appWith({ readers: readers(page(2999)) }), '/api/v1/delivery/summary')).body.truncated).toBe(false);
    expect((await get(appWith({ readers: readers(page(3000)) }), '/api/v1/delivery/metrics')).body.truncated).toBe(true);
    expect((await get(appWith({ readers: readers(page(2999)) }), '/api/v1/delivery/metrics')).body.truncated).toBe(false);
  });

  it('an unreachable source answers 502 JSON with no error text, for both routes', async () => {
    const down = { readEvents: jest.fn(async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:5432 secret-host'); }), readLedger: jest.fn(async () => []) };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const url of ['/api/v1/delivery/summary', '/api/v1/delivery/metrics']) {
      const res = await get(appWith({ readers: down }), url);
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ ok: false, error: 'delivery_source_unavailable' });
    }
    const ledgerDown = { readEvents: jest.fn(async () => QUEUE_ROWS), readLedger: jest.fn(async () => { throw new Error('x'); }) };
    expect((await get(appWith({ readers: ledgerDown }), '/api/v1/delivery/summary')).status).toBe(502);
    spy.mockRestore();
  });
});

describe('VTID-05547 the metrics — a figure with no source is null, never 0', () => {
  beforeEach(() => { asAdmin(); fetchMock.mockClear(); });

  it('with no events every figure is null', async () => {
    const res = await get(appWith({ readers: readers([]) }), '/api/v1/delivery/metrics');
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual(['oasis_events']);
    expect(res.body.metrics).toEqual({
      window_hours: 168,
      first_result_s: null,
      required_checks_s: null,
      accept_to_main_s: null,
      landings_per_hour: null,
      queue_depth: null,
      landing_to_verify_s: null,
      staging_verify_pass_rate: null,
      change_failure_rate: null,
      time_to_restore_s: null,
      cost_per_day: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const landed = (at: string, vtid: string, repo: string, acceptToLand: number | null, key: string) =>
    row('delivery.landed', at, base({ repo, accept_to_land_s: acceptToLand, dedupe_key: key }), { vtid });
  const pipe = (topic: string, at: string, id: number, ref: string, iid: number | null, extra: Record<string, unknown>, repo = 'vitana-platform') =>
    row(`scm.gitlab.pipeline.${topic}`, at, base({ repo, pipeline_id: id, ref, merge_request_iid: iid, dedupe_key: `p${id}${topic}`, ...extra }));
  const verify = (topic: 'passed' | 'failed', at: string, vtids: string[], n: number) =>
    row(`staging.verify.${topic}`, at, { env: 'staging', service: 'gateway', commit: `c${n}`, outcome: topic, vtids }, { service: 'staging-verify-gateway' });

  const ROWS: EventRow[] = [
    landed('2026-11-05T10:00:00Z', 'VTID-00001', 'vitana-platform', 60, 'l1'),
    landed('2026-11-05T10:30:00Z', 'VTID-00002', 'vitana-platform', 120, 'l2'),
    landed('2026-11-05T11:00:00Z', 'VTID-00003', 'vitana-v1', 300, 'l3'),
    landed('2026-11-05T11:10:00Z', 'VTID-00004', 'vitana-v1', null, 'l4'), // no accept time: not a number
    verify('passed', '2026-11-05T10:20:00Z', ['VTID-00001'], 1),
    verify('failed', '2026-11-05T10:50:00Z', ['VTID-00002'], 2),
    pipe('failed', '2026-11-05T10:40:00Z', 50, 'main', null, {}),
    pipe('succeeded', '2026-11-05T10:55:00Z', 51, 'main', null, {}),
    pipe('succeeded', '2026-11-05T09:00:00Z', 60, 'kiro/a/b', 1, { duration_s: 60, jobs: [{ name: 'x', status: 'success', wait_s: 2, run_s: 30 }] }),
    pipe('failed', '2026-11-05T09:10:00Z', 61, 'kiro/c/d', 2, { duration_s: 90, jobs: [{ name: 'y', status: 'success', wait_s: 1, run_s: 10 }, { name: 'z', status: 'failed', wait_s: 5, run_s: 3 }, { name: 'skipped', status: 'skipped' }] }),
    ...QUEUE_ROWS,
  ];

  it('computes the figures that have a source', async () => {
    const res = await get(appWith({ readers: readers(ROWS) }), '/api/v1/delivery/metrics');
    const m = res.body.metrics;
    expect(m.accept_to_main_s).toEqual({ p50: 120, p95: 300, n: 3 });
    expect(m.landings_per_hour).toEqual({ 'vitana-platform': 0.0119, 'vitana-v1': 0.0119 });
    expect(m.queue_depth).toEqual({ 'vitana-platform': 6, 'vitana-v1': 1 });
    expect(m.landing_to_verify_s).toEqual({ p50: 1200, p95: 1200, n: 2 });
    expect(m.staging_verify_pass_rate).toEqual({ value: 0.5, n: 2 });
    expect(m.time_to_restore_s).toEqual({ p50: 900, p95: 900, n: 1 });
    expect(m.required_checks_s).toEqual({ p50: 60, p95: 90, n: 2 });
    expect(m.first_result_s).toEqual({ p50: 8, p95: 32, n: 2 });
    expect(m.cost_per_day).toBeNull();
  });

  it('change failure: a landing followed within 24 hours by a red main or a failed STAGING-VERIFY of its VTID', async () => {
    const m = (await get(appWith({ readers: readers(ROWS) }), '/api/v1/delivery/metrics')).body.metrics;
    // VTID-00001 and VTID-00002 are followed by the red main of 10:40 (platform); VTID-00002 also by its failed verify.
    expect(m.change_failure_rate).toEqual({ value: 0.5, landings: 4, signals: ['red_main', 'staging_verify_failed'], missing_signals: ['revert', 'production_rollback'] });
  });

  it('shadow rows never count in a figure', async () => {
    const shadow = ROWS.map((r) => (r.topic === 'delivery.landed' ? { ...r, metadata: { ...r.metadata, mode: 'shadow' } } : r));
    const m = (await get(appWith({ readers: readers(shadow) }), '/api/v1/delivery/metrics')).body.metrics;
    expect(m.accept_to_main_s).toBeNull();
    expect(m.landings_per_hour).toBeNull();
    expect(m.change_failure_rate).toBeNull();
    expect(m.landing_to_verify_s).toBeNull();
  });

  it('spread is nearest-rank and null for nothing', () => {
    expect(spread([])).toBeNull();
    expect(spread([NaN as number])).toBeNull();
    expect(spread([5])).toEqual({ p50: 5, p95: 5, n: 1 });
    expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ p50: 5, p95: 10, n: 10 });
    expect(spread([300, 60, 120])).toEqual({ p50: 120, p95: 300, n: 3 });
  });

  it('buildMetrics on its own takes rows, now and the window', () => {
    expect(buildMetrics([], NOW, 24).window_hours).toBe(24);
  });
});

describe('VTID-05547 the metrics — the edges of each figure (plan §10)', () => {
  const T0 = Date.parse('2026-11-01T00:00:00Z');
  const at = (hours: number) => new Date(T0 + hours * 3600 * 1000).toISOString();
  const landing = (when: string, vtid: string, repo = 'vitana-platform') => row('delivery.landed', when, base({ repo, dedupe_key: `landed:${vtid}` }), { vtid });
  const mainRun = (topic: 'failed' | 'succeeded', when: string, id: number, repo = 'vitana-platform', extra: Record<string, unknown> = {}) =>
    row(`scm.gitlab.pipeline.${topic}`, when, base({ repo, pipeline_id: id, ref: 'main', merge_request_iid: null, dedupe_key: `main:${id}`, ...extra }));
  const verifyRow = (topic: 'passed' | 'failed', when: string, vtids: unknown, n: number) =>
    row(`staging.verify.${topic}`, when, { env: 'staging', service: 'gateway', commit: `c${n}`, outcome: topic, ...(vtids === undefined ? {} : { vtids }) }, { service: 'staging-verify-gateway' });

  it('change failure: a red main of the same repository from the landing to 24 hours after it, or a failed STAGING-VERIFY naming its VTID', () => {
    const rows = [
      mainRun('failed', at(0), 1), //                                            before the landing of VTID-00001: not a failure of it
      landing(at(1), 'VTID-00001'),
      landing(at(30), 'VTID-00002'),
      mainRun('failed', at(55), 2), //                                           25 hours after VTID-00002: too late
      landing(at(60), 'VTID-00003'),
      mainRun('failed', at(83), 3), //                                           23 hours after VTID-00003: a failure
      landing(at(100), 'VTID-00004'),
      mainRun('failed', at(101), 4, 'vitana-v1'), //                             another repository's main
      mainRun('failed', at(102), 5, 'vitana-platform', { ref: 'kiro/a/b' }), //  a branch pipeline
      mainRun('failed', at(103), 6, 'vitana-platform', { ref: 'delivery/cutover-vitana-platform', tag: true }), // a tag pipeline
      mainRun('succeeded', at(104), 7), //                                       a green main
      landing(at(110), 'VTID-00005'),
      verifyRow('failed', at(111), ['VTID-00005'], 1), //                        a failed verify naming it: a failure
      landing(at(120), 'VTID-00006'),
      verifyRow('failed', at(121), ['VTID-00005'], 2), //                        names another VTID
      verifyRow('failed', at(119), ['VTID-00006'], 3), //                        before the landing
      verifyRow('passed', at(122), ['VTID-00006'], 4), //                        passed
      landing(at(130), 'VTID-00007'),
      verifyRow('failed', at(156), ['VTID-00007'], 5), //                        26 hours after: too late
      landing(at(140), 'VTID-00008'),
      mainRun('failed', at(164), 8), //                                          exactly 24 hours after: still within
    ];
    expect(buildMetrics(rows, NOW, 168).change_failure_rate).toEqual({
      value: 0.375, // VTID-00003, VTID-00005 and VTID-00008 of 8 landings
      landings: 8,
      signals: ['red_main', 'staging_verify_failed'],
      missing_signals: ['revert', 'production_rollback'],
    });
  });

  it('landing to verify: the first STAGING-VERIFY result at or after the landing that names its VTID', () => {
    const rows = [
      landing(at(0), 'VTID-00001'),
      verifyRow('passed', at(0.1), ['VTID-00099'], 1), //               names another VTID
      verifyRow('failed', at(0.2), [], 2), //                           names none
      verifyRow('passed', at(0.3), undefined, 3), //                    carries no list
      verifyRow('passed', at(0.5), ['VTID-00099', 'VTID-00001'], 4), // its result: 30 minutes
      verifyRow('passed', at(0.9), ['VTID-00001'], 5), //               a later one for it is not the first
      landing(at(2), 'VTID-00002'),
      verifyRow('passed', at(1.5), ['VTID-00002'], 6), //               before its landing: not its result
    ];
    expect(buildMetrics(rows, NOW, 168).landing_to_verify_s).toEqual({ p50: 1800, p95: 1800, n: 1 });
  });

  it('time to restore: the first failed main pipeline of a repository to its next successful one; other refs and other repositories do not restore it', () => {
    const rows = [
      mainRun('succeeded', at(9), 1), //                                    green with no red before it: nothing to restore
      mainRun('failed', at(10), 2), //                                      red starts
      mainRun('failed', at(10.5), 3), //                                    still red: the start stays at 10
      mainRun('succeeded', at(10.6), 4, 'vitana-platform', { ref: 'kiro/a/b' }), // a branch pipeline does not restore main
      mainRun('succeeded', at(10.7), 5, 'vitana-v1'), //                    another repository's green does not restore it
      mainRun('succeeded', at(11), 6), //                                   restored: one hour after the first red
      mainRun('failed', at(12), 7, 'vitana-v1'),
      mainRun('succeeded', at(12.25), 8, 'vitana-v1'), //                   restored: 15 minutes
    ];
    expect(buildMetrics(rows, NOW, 168).time_to_restore_s).toEqual({ p50: 900, p95: 3600, n: 2 });
  });
});

describe('VTID-05547 the builders and the PostgREST readers', () => {
  it('dedupeRows keeps the earliest row of a key, and every row with no key', () => {
    const rows = [row('t', '2026-11-05T10:05:00Z', { dedupe_key: 'a' }), row('t', '2026-11-05T10:00:00Z', { dedupe_key: 'a' }), row('t', '2026-11-05T10:01:00Z', {}), row('t', '2026-11-05T10:02:00Z', {})];
    expect(dedupeRows(rows).map((r) => r.created_at)).toEqual(['2026-11-05T10:00:00Z', '2026-11-05T10:01:00Z', '2026-11-05T10:02:00Z']);
  });

  it('the builders tolerate rows with missing or odd metadata', () => {
    const odd = [row('scm.gitlab.merge_request.opened', '2026-11-05T10:00:00Z', {}), row('scm.gitlab.pipeline.failed', 'not a date', { repo: 5 }), { created_at: '2026-11-05T10:00:00Z', topic: 'staging.deploy.completed', metadata: null } as EventRow];
    expect(buildMergeQueue(odd, NOW)).toEqual({});
    expect(buildPipelines(odd)).toEqual({});
    expect(buildReleases(odd).deploys).toEqual([{ service: null, commit: null, status: 'completed', at: '2026-11-05T10:00:00Z', host: 'github', workflow: null }]);
  });

  it('postgrestReaders reads with GET, the service role and the topic and window filters; the ledger only for the VTIDs asked', async () => {
    const env = { SUPABASE_URL: 'http://oasis.invalid', SUPABASE_SERVICE_ROLE: 'role-test' } as NodeJS.ProcessEnv;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [{ id: 1 }] });
    const r = postgrestReaders(env);
    expect(await r.readEvents({ topics: ['a.b', 'c.d'], sinceIso: '2026-11-01T00:00:00.000Z', limit: 7 })).toEqual([{ id: 1 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://oasis.invalid/rest/v1/oasis_events?select=id,created_at,vtid,topic,status,message,service,metadata&topic=in.(a.b,c.d)&created_at=gte.2026-11-01T00%3A00%3A00.000Z&order=created_at.desc&limit=7');
    expect(init).toEqual({ headers: { apikey: 'role-test', Authorization: 'Bearer role-test' } });
    expect(await r.readLedger([])).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await r.readLedger(['VTID-00001', 'VTID-00002']);
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://oasis.invalid/rest/v1/vtid_ledger?select=vtid,title,status,is_terminal,terminal_outcome&vtid=in.(VTID-00001,VTID-00002)&limit=200');
  });

  it('postgrestReaders fails closed: no credentials, or an upstream error status, is an error (the route turns it into 502)', async () => {
    await expect(postgrestReaders({} as NodeJS.ProcessEnv).readEvents({ topics: ['x'], sinceIso: 'z', limit: 1 })).rejects.toThrow('not_configured');
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => [] });
    await expect(postgrestReaders({ SUPABASE_URL: 'http://x.invalid', SUPABASE_SERVICE_ROLE: 'k' } as NodeJS.ProcessEnv).readLedger(['VTID-00001'])).rejects.toThrow('upstream_503');
  });

  it('the default router answers 401 without a token and never reads anything', async () => {
    identity = null;
    fetchMock.mockClear();
    const { default: deliveryRouter } = await import('../../src/routes/delivery');
    const a = express();
    a.use('/api/v1/delivery', deliveryRouter);
    const res = await request(a).get('/api/v1/delivery/summary');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
