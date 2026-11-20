/**
 * VTID-05547 — the OASIS side of the boundary: a signed GitLab delivery through the stage and the REAL
 * emitOasisEvent (services/oasis-event-service.ts) produces one INSERT into oasis_events per event, with the
 * topic, VTID, service, status, stage and the metadata (dedupe_key, plane, host, mode, env) the mapper chose.
 * Only the network is faked (the global fetch of setup-tests.ts); nothing is sent anywhere.
 */
import express from 'express';
import request from 'supertest';
import { GITLAB_WEBHOOK_BODY_LIMIT, gitlabWebhookBodyErrors } from '../../src/routes/internal-gitlab-webhook';
import { MemoryBranchVtidIndex } from '../../src/services/gitlab-events/delivery-mapper';
import { createGitlabDeliveryStage } from '../../src/services/gitlab-events/delivery-stage';
import { VITANA_ENV } from '../../src/env';
import { idempotentEventId } from '../../src/services/oasis-event-service';
import { LIVE_ENV, REVIEW_COMMIT, SIGNING_KEY, issue, mergeRequest, pipeline, push, signedHeaders } from './fixtures';

const URL_PATH = '/api/v1/internal/gitlab/webhook';
const fetchMock = global.fetch as unknown as jest.Mock;
type Insert = { url: string; method: string; headers: Record<string, string>; body: Record<string, any> };
let inserts: Insert[];
/** The rows of the fake oasis_events table by primary key: what PostgREST would hold after the inserts. */
let table: Map<string, Record<string, any>>;
let insertStatus: number;
const ENV0 = { ...process.env };

function app() {
  const a = express();
  a.use(URL_PATH, express.raw({ type: '*/*', limit: GITLAB_WEBHOOK_BODY_LIMIT }), gitlabWebhookBodyErrors);
  a.use(express.json({ limit: '2mb' }));
  a.use(URL_PATH, createGitlabDeliveryStage({ map: { env: LIVE_ENV, branches: new MemoryBranchVtidIndex() } }));
  return a;
}
function post(a: express.Express, payload: unknown, id: string) {
  const raw = JSON.stringify(payload);
  return request(a).post(URL_PATH).set('Content-Type', 'application/json').set(signedHeaders(raw, id)).send(raw);
}

beforeEach(() => {
  process.env = { ...ENV0, GITLAB_WEBHOOK_SIGNING_TOKEN: SIGNING_KEY, VITANA_ENV: 'staging' };
  inserts = [];
  table = new Map();
  insertStatus = 201;
  fetchMock.mockImplementation(async (url: string, init: any = {}) => {
    if (String(url).includes('/rest/v1/oasis_events')) {
      const insert = { url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) };
      inserts.push(insert);
      if (insertStatus >= 300) return { ok: false, status: insertStatus, text: async () => 'upstream unavailable', json: async () => ({}) };
      // PostgREST on the primary key: a new id inserts and returns the row; a known id is skipped under ignore-duplicates
      // (an empty array comes back), and is a 409 without it.
      if (table.has(insert.body.id)) {
        if (/resolution=ignore-duplicates/.test(insert.headers.Prefer)) return { ok: true, status: 201, text: async () => '[]', json: async () => [] };
        return { ok: false, status: 409, text: async () => 'duplicate key value violates unique constraint "oasis_events_pkey"', json: async () => ({}) };
      }
      table.set(insert.body.id, insert.body);
      return { ok: true, status: 201, text: async () => JSON.stringify([insert.body]), json: async () => [insert.body] };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterAll(() => {
  process.env = ENV0;
});

describe('VTID-05547 stage → emitOasisEvent → oasis_events INSERT', () => {
  it('a main pipeline: three rows, each with the delivery metadata and the right stage', async () => {
    const res = await post(
      app(),
      pipeline('success', { builds: [{ id: 2, name: 'deploy-staging:gateway', status: 'success', duration: 200, queued_duration: 5 }] }),
      'msg_w_1',
    );
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(3);
    expect(inserts.every((i) => i.url === 'http://localhost:54321/rest/v1/oasis_events' && i.method === 'POST')).toBe(true);
    expect(inserts.map((i) => [i.body.topic, i.body.vtid, i.body.service, i.body.status, i.body.task_stage])).toEqual([
      ['scm.gitlab.pipeline.succeeded', 'VTID-05547', 'gitlab-webhook', 'success', undefined],
      ['delivery.landed', 'VTID-05547', 'gitlab-webhook', 'success', undefined],
      ['staging.deploy.completed', 'VTID-05547', 'gitlab-webhook', 'success', 'DEPLOY'],
    ]);
    for (const i of inserts) {
      expect(i.body.metadata).toMatchObject({ plane: 'delivery', host: 'gitlab', mode: 'live', repo: 'vitana-platform', env: expect.stringMatching(/^(staging|production)$/) });
      expect(typeof i.body.metadata.dedupe_key).toBe('string');
    }
    expect(inserts[2].body.metadata).toMatchObject({ env: 'staging', git_commit: 'c0ffee0000000000000000000000000000000001', workflow: expect.stringContaining('deploy-staging:gateway') });
    expect(inserts[1].body.metadata).toMatchObject({ merge_request: '!12', accept_to_land_s: 330, reviewer_model: 'claude-sonnet-5.5' });
  });

  it('the merge request topics are written with the VALIDATOR stage, never an inferred Deploy stage', async () => {
    await post(app(), mergeRequest('merge'), 'msg_w_2');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].body).toMatchObject({ topic: 'scm.gitlab.merge_request.merged', task_stage: 'VALIDATOR', status: 'info' });
  });

  it('a push with a review entry: push, review and lane rows; the review row names the lane, verdict and model', async () => {
    await post(app(), push({ commits: [REVIEW_COMMIT] }), 'msg_w_3');
    expect(inserts.map((i) => i.body.topic)).toEqual(['scm.gitlab.push', 'delivery.review.recorded', 'delivery.lane.updated']);
    expect(inserts[1].body.metadata).toMatchObject({ lane_key: 'agentic-delivery/prerequisites', verdict: 'accept', reviewer_model: 'claude-sonnet-5.5', plane: 'delivery' });
  });

  it('a shadow delivery is written, marked shadow, with no deploy and no landing row', async () => {
    const a = express();
    a.use(URL_PATH, express.raw({ type: '*/*', limit: GITLAB_WEBHOOK_BODY_LIMIT }), gitlabWebhookBodyErrors);
    a.use(express.json({ limit: '2mb' }));
    a.use(URL_PATH, createGitlabDeliveryStage({ map: { env: {} as NodeJS.ProcessEnv, branches: new MemoryBranchVtidIndex() } }));
    await post(a, pipeline('success', { builds: [{ id: 2, name: 'deploy-staging:gateway', status: 'success' }] }), 'msg_w_4');
    expect(inserts.map((i) => i.body.topic)).toEqual(['scm.gitlab.pipeline.succeeded']);
    expect(inserts[0].body.metadata.mode).toBe('shadow');
  });

  it('the OASIS write failing answers 502 and the retry records the row', async () => {
    const a = app();
    insertStatus = 503;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await post(a, pipeline('running', { attrs: { ref: 'kiro/x/y' }, merge_request: { iid: 12, title: 'VTID-05547 x' } }), 'msg_w_5');
    spy.mockRestore();
    expect(first.status).toBe(502);
    insertStatus = 201;
    const retry = await post(a, pipeline('running', { attrs: { ref: 'kiro/x/y' }, merge_request: { iid: 12, title: 'VTID-05547 x' } }), 'msg_w_5');
    expect(retry.status).toBe(200);
    expect(retry.body.events).toHaveLength(1);
  });

  describe('durable recording: the dedupe_key is the row\'s idempotency key', () => {
    it('every delivery row is written with a deterministic id and Prefer ignore-duplicates', async () => {
      await post(app(), mergeRequest('open'), 'msg_d_1');
      expect(inserts).toHaveLength(1);
      expect(inserts[0].headers.Prefer).toBe('return=representation,resolution=ignore-duplicates');
      // VITANA_ENV is read once, when the module loads; the row id is scoped to it, as metadata.env is.
      expect(inserts[0].body.metadata.env).toBe(VITANA_ENV);
      expect(inserts[0].body.id).toBe(idempotentEventId(VITANA_ENV, 'scm.gitlab.merge_request.opened', inserts[0].body.metadata.dedupe_key));
    });

    it('the same fact reaching two gateway tasks is one row, and the second task answers duplicate', async () => {
      const taskA = app();
      const taskB = app(); // its own in-memory dedupe: it has never seen this delivery
      const first = await post(taskA, pipeline('failed', { attrs: { ref: 'kiro/x/y' }, merge_request: { iid: 12, title: 'VTID-05547 x' }, builds: [{ id: 5, name: 'unit', status: 'failed', failure_reason: 'script_failure', exit_code: 1 }] }), 'msg_d_2');
      const second = await post(taskB, pipeline('failed', { attrs: { ref: 'kiro/x/y' }, merge_request: { iid: 12, title: 'VTID-05547 x' }, builds: [{ id: 5, name: 'unit', status: 'failed', failure_reason: 'script_failure', exit_code: 1 }] }), 'msg_d_2');
      expect(first.status).toBe(200);
      expect(first.body.events).toHaveLength(1);
      expect(inserts).toHaveLength(2); // task B did try to write
      expect(table.size).toBe(1); // and OASIS holds one row
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ ok: true, duplicate: true });
      expect([...table.values()][0].metadata.failed_jobs).toEqual([{ id: 5, name: 'unit', stage: null, failure_reason: 'script_failure', exit_code: 1 }]);
    });

    it('a different delivery of the same fact (a new webhook id) is also one row', async () => {
      await post(app(), mergeRequest('open'), 'msg_d_3');
      const again = await post(app(), mergeRequest('open'), 'msg_d_4');
      expect(table.size).toBe(1);
      expect(again.body).toEqual({ ok: true, duplicate: true });
    });

    it('a different state of the same object is a different row: a pipeline that failed, then succeeded on a retry', async () => {
      const mr = { iid: 12, title: 'VTID-05547 x' };
      await post(app(), pipeline('failed', { attrs: { ref: 'kiro/x/y' }, merge_request: mr }), 'msg_d_5');
      const retried = await post(app(), pipeline('success', { attrs: { ref: 'kiro/x/y' }, merge_request: mr }), 'msg_d_6');
      expect(table.size).toBe(2);
      expect(retried.body.events).toHaveLength(1);
    });

    it('a partly recorded delivery completes on its retry: the rows already there are skipped, the rest are written', async () => {
      const a = app();
      // The first attempt gets the first row of a three-row delivery in, then OASIS goes away.
      let n = 0;
      const base = fetchMock.getMockImplementation() as (url: string, init: any) => Promise<any>;
      fetchMock.mockImplementation(async (url: string, init: any) => {
        n += 1;
        if (n === 2) return { ok: false, status: 503, text: async () => 'upstream unavailable', json: async () => ({}) };
        return base(url, init);
      });
      const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const landed = () => pipeline('success', { builds: [{ id: 2, name: 'deploy-staging:gateway', status: 'success', duration: 200, queued_duration: 5 }] });
      const first = await post(a, landed(), 'msg_d_7');
      spy.mockRestore();
      expect(first.status).toBe(502);
      expect(table.size).toBe(1);
      // The retry goes to ANOTHER gateway task (no in-memory memory of the first row): the first row is a duplicate, the other two land.
      fetchMock.mockImplementation(base);
      const retry = await post(app(), landed(), 'msg_d_7');
      expect(retry.status).toBe(200);
      expect(retry.body.events.map((e: { topic: string }) => e.topic)).toEqual(['delivery.landed', 'staging.deploy.completed']);
      expect(table.size).toBe(3);
    });
  });

  describe('the delivery loop events through the stage', () => {
    it('an issue with the intake label is recorded as scm.gitlab.issue.opened under BOOTSTRAP-DELIVERY, with the issue and no text', async () => {
      const res = await post(app(), issue('open', ['agent-task', 'priority-high']), 'msg_i_1');
      expect(res.status).toBe(200);
      expect(inserts).toHaveLength(1);
      expect(inserts[0].body).toMatchObject({ topic: 'scm.gitlab.issue.opened', vtid: 'BOOTSTRAP-DELIVERY', service: 'gitlab-webhook', status: 'info' });
      expect(inserts[0].body.metadata).toMatchObject({ issue_iid: 17, labels: ['agent-task', 'priority-high'], intake_label: 'agent-task', plane: 'delivery', host: 'gitlab', mode: 'live', env: VITANA_ENV });
      const text = JSON.stringify(inserts[0].body);
      for (const leak of ['secret-issue-title', 'secret-description-text', 'agent@example.invalid', 'Agent Kiro']) expect(text).not.toContain(leak);
    });

    it('an issue without the intake label is answered 202 not_intake and writes nothing', async () => {
      const res = await post(app(), issue('open', ['bug']), 'msg_i_2');
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true, ignored: true, reason: 'not_intake' });
      expect(inserts).toHaveLength(0);
    });

    it('a failed pipeline row carries the failed jobs, and its status is warning, never error', async () => {
      await post(app(), pipeline('failed', { attrs: { ref: 'kiro/x/y' }, merge_request: { iid: 12, title: 'VTID-05547 x', source_branch: 'kiro/x/y', target_branch: 'main' }, builds: [{ id: 5, name: 'unit', stage: 'test', status: 'failed', failure_reason: 'script_failure', exit_code: 1 }] }), 'msg_i_3');
      expect(inserts[0].body).toMatchObject({ topic: 'scm.gitlab.pipeline.failed', status: 'warning', vtid: 'VTID-05547' });
      expect(inserts[0].body.metadata).toMatchObject({
        mr_source_branch: 'kiro/x/y',
        mr_target_branch: 'main',
        failed_jobs: [{ id: 5, name: 'unit', stage: 'test', failure_reason: 'script_failure', exit_code: 1 }],
      });
    });
  });

  it('the stored metadata never holds the description, the user, a variable or a raw build', async () => {
    await post(app(), mergeRequest('open', { description: 'Moved from https://github.com/exafyltd/vitana-platform/pull/9\nsecret-description-text' }), 'msg_w_6');
    await post(app(), pipeline('success', { builds: [{ id: 2, name: 'lint', status: 'success', user: { name: 'secret-user' }, runner: { description: 'secret-runner' } }] }), 'msg_w_7');
    expect(inserts.map((i) => i.body.topic)).toEqual(['scm.gitlab.merge_request.opened', 'scm.migration.pr_moved', 'scm.gitlab.pipeline.succeeded', 'delivery.landed']);
    const text = JSON.stringify(inserts.map((i) => i.body));
    for (const leak of ['secret-description-text', 'agent@example.invalid', 'Agent Kiro', 'secret-label', 'SECRET_VARIABLE', 'secret-variable-value', 'secret-user', 'secret-runner']) {
      expect(text).not.toContain(leak);
    }
  });
});
