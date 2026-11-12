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
import { LIVE_ENV, REVIEW_COMMIT, SIGNING_KEY, mergeRequest, pipeline, push, signedHeaders } from './fixtures';

const URL_PATH = '/api/v1/internal/gitlab/webhook';
const fetchMock = global.fetch as unknown as jest.Mock;
type Insert = { url: string; method: string; headers: Record<string, string>; body: Record<string, any> };
let inserts: Insert[];
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
  insertStatus = 201;
  fetchMock.mockImplementation(async (url: string, init: any = {}) => {
    if (String(url).includes('/rest/v1/oasis_events')) {
      inserts.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: insertStatus < 300, status: insertStatus, text: async () => (insertStatus < 300 ? '[]' : 'upstream unavailable'), json: async () => [] };
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
