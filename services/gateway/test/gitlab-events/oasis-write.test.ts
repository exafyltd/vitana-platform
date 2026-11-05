/**
 * VTID-05541 — the OASIS side of the boundary: a signed GitLab delivery through the route and the
 * REAL emitOasisEvent (services/oasis-event-service.ts) produces exactly one INSERT into
 * oasis_events with the topic, VTID, service, status, stage and metadata the mapper chose.
 * Only the network is faked (global fetch, as every gateway Jest suite does via setup-tests.ts);
 * nothing is sent anywhere.
 */

import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import {
  GITLAB_WEBHOOK_BODY_LIMIT,
  createGitlabWebhookRouter,
  gitlabWebhookBodyErrors,
} from '../../src/routes/internal-gitlab-webhook';
import { DeliveryDedupe } from '../../src/services/gitlab-events/dedupe';

const KEY = `whsec_${Buffer.from('vitana-gitlab-webhook-oasis-write-key').toString('base64')}`;
const URL_PATH = '/api/v1/internal/gitlab/webhook';
const fetchMock = global.fetch as unknown as jest.Mock;

type Insert = { url: string; method: string; headers: Record<string, string>; body: Record<string, any> };
let inserts: Insert[];
let insertStatus: number;

function app() {
  const a = express();
  a.use(URL_PATH, express.raw({ type: '*/*', limit: GITLAB_WEBHOOK_BODY_LIMIT }), gitlabWebhookBodyErrors);
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/v1/internal/gitlab', createGitlabWebhookRouter({ dedupe: new DeliveryDedupe() }));
  return a;
}

function post(a: express.Express, raw: string, id: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const k = Buffer.from(KEY.slice(6), 'base64');
  const s = createHmac('sha256', k).update(`${id}.${ts}.${raw}`).digest('base64');
  return request(a)
    .post(URL_PATH)
    .set('Content-Type', 'application/json')
    .set('webhook-id', id)
    .set('webhook-timestamp', ts)
    .set('webhook-signature', `v1,${s}`)
    .send(raw);
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...OLD_ENV, GITLAB_WEBHOOK_SIGNING_TOKEN: KEY };
  inserts = [];
  insertStatus = 201;
  fetchMock.mockImplementation(async (url: string, init: any = {}) => {
    if (String(url).includes('/rest/v1/oasis_events')) {
      inserts.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: insertStatus < 300,
        status: insertStatus,
        text: async () => (insertStatus < 300 ? '[]' : 'upstream unavailable'),
        json: async () => [],
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterAll(() => {
  process.env = OLD_ENV;
});

describe('VTID-05541 route → emitOasisEvent → oasis_events INSERT', () => {
  it('a failed pipeline: one row, topic scm.gitlab.pipeline.failed, status warning, no stage', async () => {
    const raw = JSON.stringify({
      object_kind: 'pipeline',
      project: { id: 42, path_with_namespace: 'vitana/rehearsal' },
      object_attributes: { id: 31, ref: 'main', sha: 'abc', source: 'push', status: 'failed', duration: 9, variables: [{ key: 'K', value: 'secret-variable-value' }] },
      merge_request: null,
      commit: { id: 'abc', title: 'VTID-05541 (eng-gitlab-m2/scm-webhook): route', message: 'secret commit body' },
    });
    const res = await post(app(), raw, 'msg_oasis_1');
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row.url).toBe(`${process.env.SUPABASE_URL}/rest/v1/oasis_events`);
    expect(row.method).toBe('POST');
    expect(row.body).toMatchObject({
      vtid: 'VTID-05541',
      topic: 'scm.gitlab.pipeline.failed',
      service: 'gitlab-webhook',
      status: 'warning',
      message: 'GitLab pipeline 31 failed on main in vitana/rehearsal',
      metadata: { gitlab_event: 'pipeline', webhook_id: 'msg_oasis_1', pipeline_id: 31, status: 'failed', ref: 'main' },
    });
    expect(typeof row.body.metadata.env).toBe('string');
    expect(row.body).not.toHaveProperty('task_stage');
    expect(row.body).not.toHaveProperty('actor_id');
    expect(JSON.stringify(row.body)).not.toContain('secret-variable-value');
    expect(JSON.stringify(row.body)).not.toContain('secret commit body');
    expect(res.body.event_id).toBe(row.body.id);
  });

  it('a merged merge request: topic scm.gitlab.merge_request.merged, status info, stage VALIDATOR (not the inferred DEPLOY)', async () => {
    const raw = JSON.stringify({
      object_kind: 'merge_request',
      project: { id: 42, path_with_namespace: 'vitana/rehearsal' },
      object_attributes: { iid: 12, title: 'VTID-05541 x', action: 'merge', state: 'merged', merge_commit_sha: 'def' },
    });
    const res = await post(app(), raw, 'msg_oasis_2');
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].body).toMatchObject({
      vtid: 'VTID-05541',
      topic: 'scm.gitlab.merge_request.merged',
      status: 'info',
      task_stage: 'VALIDATOR',
      metadata: { gitlab_event: 'merge_request', action: 'merge', merge_request_iid: 12, merge_commit_sha: 'def' },
    });
  });

  it('the database refusing the row → 502, and the same delivery retried writes one row', async () => {
    const a = app();
    const raw = JSON.stringify({ object_kind: 'merge_request', object_attributes: { iid: 1, title: 'VTID-05541 y', action: 'open' } });
    insertStatus = 503;
    const first = await post(a, raw, 'msg_oasis_3');
    expect(first.status).toBe(502);
    expect(first.body).toEqual({ ok: false, error: 'oasis_emit_failed' });
    insertStatus = 201;
    const retry = await post(a, raw, 'msg_oasis_3');
    expect(retry.status).toBe(200);
    const dup = await post(a, raw, 'msg_oasis_3');
    expect(dup.body).toEqual({ ok: true, duplicate: true });
    expect(inserts).toHaveLength(2); // the refused attempt and the successful retry; the duplicate wrote nothing
  });

  it('an ignored or refused delivery writes nothing', async () => {
    const a = app();
    const noVtid = await post(a, JSON.stringify({ object_kind: 'merge_request', object_attributes: { action: 'open', title: 'no ticket' } }), 'msg_oasis_4');
    const push = await post(a, JSON.stringify({ object_kind: 'push' }), 'msg_oasis_5');
    const unsigned = await request(a).post(URL_PATH).set('Content-Type', 'application/json').send('{"object_kind":"merge_request"}');
    expect([noVtid.status, push.status, unsigned.status]).toEqual([202, 202, 401]);
    expect(inserts).toHaveLength(0);
  });
});
