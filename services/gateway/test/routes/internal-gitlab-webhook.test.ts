/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5, tasks.md W1/W2) — POST /api/v1/internal/gitlab/webhook.
 *
 * Pins the route contract:
 *   - GitLab's Standard Webhooks signature (webhook-id / webhook-timestamp / webhook-signature) over the
 *     raw bytes, checked by the shared verifySvix with the key GITLAB_WEBHOOK_SIGNING_TOKEN (whsec_…);
 *     svix-* headers alone are refused.
 *   - 401 for a missing, bad or stale signature; an unsigned request is refused 401 whether or not the
 *     key is configured (the STAGING-VERIFY probe); a signed request with no key is 500 not_configured.
 *   - 200 and one OASIS event per mapped delivery; a duplicate webhook-id records nothing (200);
 *     unmapped or VTID-less events are acknowledged and ignored (202); malformed JSON 400; an oversized
 *     body 413; the OASIS write failing is 502 and leaves the id open for GitLab's retry.
 *   - Every reply is JSON.
 *   - index.ts mounts express.raw for this path before express.json(), and the router under
 *     /api/v1/internal/gitlab with the route guard.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true, event_id: 'evt-1' })),
}));

import { emitOasisEvent } from '../../src/services/oasis-event-service';
import {
  GITLAB_WEBHOOK_BODY_LIMIT,
  createGitlabWebhookRouter,
  gitlabWebhookBodyErrors,
} from '../../src/routes/internal-gitlab-webhook';
import { DeliveryDedupe } from '../../src/services/gitlab-events/dedupe';

const emit = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;
const URL_PATH = '/api/v1/internal/gitlab/webhook';
const KEY_BYTES = Buffer.from('vitana-gitlab-webhook-test-key-0123456789');
const KEY = `whsec_${KEY_BYTES.toString('base64')}`;
const OTHER_KEY = `whsec_${Buffer.from('a-different-key-entirely-0123456789').toString('base64')}`;

function sig(id: string, ts: string, raw: string, key = KEY): string {
  const k = Buffer.from(key.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', k).update(`${id}.${ts}.${raw}`).digest('base64')}`;
}
const nowTs = () => String(Math.floor(Date.now() / 1000));
let seq = 0;
const newId = () => `msg_test_${process.pid}_${++seq}`;

function app() {
  // Mounted the way index.ts mounts it: raw bytes for this path, then the JSON parser, then the router.
  const a = express();
  a.use(URL_PATH, express.raw({ type: '*/*', limit: GITLAB_WEBHOOK_BODY_LIMIT }), gitlabWebhookBodyErrors);
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/v1/internal/gitlab', createGitlabWebhookRouter({ dedupe: new DeliveryDedupe() }));
  return a;
}

function mr(action: string, title = 'VTID-05541 (eng-gitlab-m2/scm-webhook): route') {
  return JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 42, path_with_namespace: 'vitana/rehearsal' },
    object_attributes: { iid: 12, title, action, state: 'opened', source_branch: 'b', target_branch: 'main', url: 'https://gitlab.example/mr/12', last_commit: { id: 'abc' } },
  });
}
function pipe(status: string, title = 'VTID-05541 (eng-gitlab-m2/scm-webhook): route') {
  return JSON.stringify({
    object_kind: 'pipeline',
    project: { id: 42, path_with_namespace: 'vitana/rehearsal' },
    object_attributes: { id: 31, ref: 'b', sha: 'abc', source: 'merge_request_event', status, duration: 5 },
    merge_request: { iid: 12, title },
    commit: { id: 'abc', title: 'commit' },
  });
}

function signedPost(a: express.Express, raw: string, opts: { id?: string; ts?: string; key?: string; sigOverride?: string } = {}) {
  const id = opts.id ?? newId();
  const ts = opts.ts ?? nowTs();
  return request(a)
    .post(URL_PATH)
    .set('Content-Type', 'application/json')
    .set('webhook-id', id)
    .set('webhook-timestamp', ts)
    .set('webhook-signature', opts.sigOverride ?? sig(id, ts, raw, opts.key ?? KEY))
    .send(raw);
}

function expectJson(res: request.Response) {
  expect(res.headers['content-type']).toMatch(/^application\/json/);
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...OLD_ENV, GITLAB_WEBHOOK_SIGNING_TOKEN: KEY };
  emit.mockReset();
  emit.mockImplementation(async () => ({ ok: true, event_id: 'evt-1' }));
});
afterAll(() => {
  process.env = OLD_ENV;
});

describe('index.ts mounting (VTID-05541)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');

  it('mounts the raw body parser and its JSON error handler for the route before express.json()', () => {
    const raw = src.indexOf(`app.use('${URL_PATH}', express.raw({ type: '*/*', limit: GITLAB_WEBHOOK_BODY_LIMIT }), gitlabWebhookBodyErrors);`);
    const json = src.indexOf("app.use(express.json({ limit: '2mb' }))");
    expect(raw).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(raw);
  });

  it('mounts the router at /api/v1/internal/gitlab through the route guard', () => {
    expect(src).toContain("mountRouterSync(app, '/api/v1/internal/gitlab', internalGitlabWebhookRouter, { owner: 'internal-gitlab-webhook' });");
    expect(src).toContain("require('./routes/internal-gitlab-webhook')");
  });
});

describe('POST /api/v1/internal/gitlab/webhook — signed deliveries (VTID-05541)', () => {
  it.each([
    ['merge_request open', 'scm.gitlab.merge_request.opened', mr('open')],
    ['merge_request reopen', 'scm.gitlab.merge_request.opened', mr('reopen')],
    ['merge_request merge', 'scm.gitlab.merge_request.merged', mr('merge')],
    ['merge_request close', 'scm.gitlab.merge_request.closed', mr('close')],
    ['pipeline success', 'scm.gitlab.pipeline.succeeded', pipe('success')],
    ['pipeline failed', 'scm.gitlab.pipeline.failed', pipe('failed')],
  ])('%s → 200 and one %s event', async (_name, topic, raw) => {
    const res = await signedPost(app(), raw);
    expect(res.status).toBe(200);
    expectJson(res);
    expect(res.body).toEqual({ ok: true, topic, vtid: 'VTID-05541', event_id: 'evt-1' });
    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0][0];
    expect(event.type).toBe(topic);
    expect(event.vtid).toBe('VTID-05541');
    expect(event.type.startsWith('cicd.')).toBe(false);
  });

  it('carries the webhook-id into the event and verifies the exact bytes, not a re-serialization', async () => {
    const raw = '{ "object_kind" : "merge_request",  "object_attributes": { "iid": 3, "action": "open", "title": "VTID-05541 x" } }';
    expect(raw).not.toBe(JSON.stringify(JSON.parse(raw)));
    const res = await signedPost(app(), raw, { id: 'msg_exact_bytes' });
    expect(res.status).toBe(200);
    expect(emit.mock.calls[0][0].payload).toMatchObject({ webhook_id: 'msg_exact_bytes', merge_request_iid: 3 });
  });

  it('decides by the signed body, not by the unsigned X-Gitlab-Event header', async () => {
    const raw = mr('merge');
    const id = newId();
    const ts = nowTs();
    const res = await request(app())
      .post(URL_PATH)
      .set('Content-Type', 'application/json')
      .set('X-Gitlab-Event', 'Pipeline Hook')
      .set('webhook-id', id)
      .set('webhook-timestamp', ts)
      .set('webhook-signature', sig(id, ts, raw))
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body.topic).toBe('scm.gitlab.merge_request.merged');
  });

  it('a duplicate webhook-id answers 200 and records nothing more', async () => {
    const a = app();
    const raw = mr('open');
    const id = newId();
    const first = await signedPost(a, raw, { id });
    expect(first.status).toBe(200);
    const again = await signedPost(a, raw, { id, ts: nowTs() });
    expect(again.status).toBe(200);
    expectJson(again);
    expect(again.body).toEqual({ ok: true, duplicate: true });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('a retry is dropped by its webhook-id before its body is looked at', async () => {
    const a = app();
    const id = newId();
    expect((await signedPost(a, mr('open'), { id })).status).toBe(200);
    const retry = await signedPost(a, '{"object_kind": "merge_request",', { id }); // signed, but not JSON
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: true, duplicate: true });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('the OASIS write failing answers 502 and leaves the id open, so the retry records it', async () => {
    const a = app();
    const raw = pipe('failed');
    const id = newId();
    emit.mockResolvedValueOnce({ ok: false, error: 'Failed to emit event: 503' });
    const first = await signedPost(a, raw, { id });
    expect(first.status).toBe(502);
    expectJson(first);
    expect(first.body).toEqual({ ok: false, error: 'oasis_emit_failed' });
    const retry = await signedPost(a, raw, { id });
    expect(retry.status).toBe(200);
    expect(retry.body.topic).toBe('scm.gitlab.pipeline.failed');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('the OASIS write throwing answers 502 without the error text', async () => {
    emit.mockRejectedValueOnce(new Error('connect ECONNREFUSED password=hunter2'));
    const res = await signedPost(app(), mr('close'));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'oasis_emit_failed' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it.each([
    ['no VTID in the title', 'no_vtid', mr('open', 'chore: no ticket')],
    ['pipeline without a VTID', 'no_vtid', pipe('success', 'chore: no ticket')],
    ['an unknown event', 'unknown_event', JSON.stringify({ object_kind: 'push', ref: 'refs/heads/main' })],
    ['an unmapped action', 'unmapped_action', mr('update')],
    ['an unmapped pipeline status', 'unmapped_status', pipe('running')],
    ['a JSON value that is not an object', 'unknown_event', '[1,2,3]'],
  ])('%s → 202 (%s), acknowledged and ignored, nothing recorded', async (_name, reason, raw) => {
    const a = app();
    const id = newId();
    const res = await signedPost(a, raw, { id });
    expect(res.status).toBe(202);
    expectJson(res);
    expect(res.body).toEqual({ ok: true, ignored: true, reason });
    const again = await signedPost(a, raw, { id });
    expect(again.status).toBe(202);
    expect(emit).not.toHaveBeenCalled();
  });

  it('malformed JSON with a valid signature → 400 invalid_json', async () => {
    for (const raw of ['{"object_kind": "merge_request",', '']) {
      const res = await signedPost(app(), raw);
      expect(res.status).toBe(400);
      expectJson(res);
      expect(res.body).toEqual({ ok: false, error: 'invalid_json' });
    }
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/internal/gitlab/webhook — refused deliveries (VTID-05541)', () => {
  it('a signature made with another key → 401 signature_invalid', async () => {
    const res = await signedPost(app(), mr('open'), { key: OTHER_KEY });
    expect(res.status).toBe(401);
    expectJson(res);
    expect(res.body).toEqual({ ok: false, error: 'signature_invalid' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('a body altered after signing → 401 signature_invalid', async () => {
    const raw = mr('open');
    const id = newId();
    const ts = nowTs();
    const res = await request(app())
      .post(URL_PATH)
      .set('Content-Type', 'application/json')
      .set('webhook-id', id)
      .set('webhook-timestamp', ts)
      .set('webhook-signature', sig(id, ts, raw))
      .send(raw.replace('VTID-05541', 'VTID-09999'));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'signature_invalid' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('a signed webhook-id swapped for another → 401 signature_invalid', async () => {
    const raw = mr('open');
    const ts = nowTs();
    const res = await signedPost(app(), raw, { id: 'msg_other', ts, sigOverride: sig('msg_original', ts, raw) });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('signature_invalid');
  });

  it('a stale or future timestamp (over 300 s) → 401 timestamp_out_of_tolerance', async () => {
    for (const delta of [-301, 301]) {
      const res = await signedPost(app(), mr('open'), { ts: String(Math.floor(Date.now() / 1000) + delta) });
      expect(res.status).toBe(401);
      expectJson(res);
      expect(res.body).toEqual({ ok: false, error: 'timestamp_out_of_tolerance' });
    }
    expect(emit).not.toHaveBeenCalled();
  });

  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])('without %s → 401 signature_missing', async (missing) => {
    const raw = mr('open');
    const id = newId();
    const ts = nowTs();
    const headers: Record<string, string> = { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig(id, ts, raw) };
    delete headers[missing];
    const res = await request(app()).post(URL_PATH).set('Content-Type', 'application/json').set(headers).send(raw);
    expect(res.status).toBe(401);
    expectJson(res);
    expect(res.body).toEqual({ ok: false, error: 'signature_missing' });
  });

  it('a correctly signed request carrying only svix-* headers → 401 signature_missing', async () => {
    const raw = mr('open');
    const id = newId();
    const ts = nowTs();
    const res = await request(app())
      .post(URL_PATH)
      .set('Content-Type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', ts)
      .set('svix-signature', sig(id, ts, raw))
      .send(raw);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'signature_missing' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('a non-numeric timestamp → 401 signature_missing', async () => {
    const res = await signedPost(app(), mr('open'), { ts: 'yesterday' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'signature_missing' });
  });

  it('a body over the limit → 413 payload_too_large, as JSON', async () => {
    expect(GITLAB_WEBHOOK_BODY_LIMIT).toBe('2mb');
    const raw = JSON.stringify({ object_kind: 'merge_request', pad: 'x'.repeat(2 * 1024 * 1024) });
    const res = await signedPost(app(), raw);
    expect(res.status).toBe(413);
    expectJson(res);
    expect(res.body).toEqual({ ok: false, error: 'payload_too_large' });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/internal/gitlab/webhook — the key (VTID-05541)', () => {
  // The exact request STAGING-VERIFY's rejected probe sends (scripts/ci/staging-verify/lib.cjs httpRequestInit).
  const probe = (a: express.Express) =>
    request(a)
      .post(URL_PATH)
      .set('accept', 'application/json, text/html;q=0.9')
      .set('authorization', 'Bearer staging-verify.invalid.probe')
      .set('content-type', 'application/json')
      .send('{}');

  it('the unsigned staging probe → 401 signature_missing JSON with the key set', async () => {
    const res = await probe(app());
    expect(res.status).toBe(401);
    expectJson(res);
    expect(res.body).toEqual({ ok: false, error: 'signature_missing' });
  });

  it('the unsigned staging probe → 401 signature_missing JSON with no key configured', async () => {
    delete process.env.GITLAB_WEBHOOK_SIGNING_TOKEN;
    const res = await probe(app());
    expect(res.status).toBe(401);
    expectJson(res);
    expect(res.body).toEqual({ ok: false, error: 'signature_missing' });
  });

  it('a signed delivery with no key configured → 500 not_configured JSON, nothing recorded', async () => {
    for (const value of [undefined, '', 'whsec_']) {
      if (value === undefined) delete process.env.GITLAB_WEBHOOK_SIGNING_TOKEN;
      else process.env.GITLAB_WEBHOOK_SIGNING_TOKEN = value;
      const res = await signedPost(app(), mr('open'));
      expect(res.status).toBe(500);
      expectJson(res);
      expect(res.body).toEqual({ ok: false, error: 'not_configured' });
    }
    expect(emit).not.toHaveBeenCalled();
  });

  it('reads the key at request time (a rotated key applies without a restart)', async () => {
    const a = app();
    process.env.GITLAB_WEBHOOK_SIGNING_TOKEN = OTHER_KEY;
    expect((await signedPost(a, mr('open'))).status).toBe(401);
    expect((await signedPost(a, mr('open'), { key: OTHER_KEY })).status).toBe(200);
  });
});
