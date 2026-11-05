/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5, lane scm-webhook): POST /api/v1/internal/gitlab/webhook.
 *
 * The app is built exactly like index.ts builds the path: mountGitlabWebhookParsers() first, then express.json(), then
 * the router. Deliveries are signed the way GitLab signs them (Standard Webhooks: `webhook-id`, `webhook-timestamp`,
 * `webhook-signature` = `v1,<base64 HMAC-SHA256 over ${id}.${timestamp}.${raw}>`, key = base64 of `whsec_<base64>`).
 */
import { createHmac, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  createGitlabWebhookRouter,
  mountGitlabWebhookParsers,
  GITLAB_WEBHOOK_PATH,
  GitlabWebhookDeps,
} from '../../src/routes/internal-gitlab-webhook';
import { createDeliveryIdStore } from '../../src/services/gitlab-events/delivery-ids';

const KEY_BYTES = randomBytes(32);
const KEY = `whsec_${KEY_BYTES.toString('base64')}`;
const NOW = Date.UTC(2026, 10, 5, 0, 30, 0);

function sign(id: string, ts: string, raw: string, keyBytes: Buffer = KEY_BYTES): string {
  return `v1,${createHmac('sha256', keyBytes).update(`${id}.${ts}.${raw}`).digest('base64')}`;
}

function makeDeps(over: Partial<GitlabWebhookDeps> = {}) {
  const emit = jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' });
  const deps: GitlabWebhookDeps = {
    emit,
    deliveries: createDeliveryIdStore({ now: () => NOW }),
    signingKey: () => KEY,
    now: () => NOW,
    ...over,
  };
  return { deps, emit: deps.emit as jest.Mock };
}

function makeApp(deps: GitlabWebhookDeps) {
  const app = express();
  mountGitlabWebhookParsers(app);
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v1/internal/gitlab', createGitlabWebhookRouter(deps));
  return app;
}

let seq = 0;
function post(app: express.Express, raw: string, opts: { id?: string; ts?: string; sig?: string; headers?: Record<string, string>; contentType?: string } = {}) {
  const id = opts.id ?? `msg_${++seq}`;
  const ts = opts.ts ?? String(Math.floor(NOW / 1000));
  const sig = opts.sig ?? sign(id, ts, raw);
  const r = request(app).post(GITLAB_WEBHOOK_PATH).set('content-type', opts.contentType ?? 'application/json');
  if (!opts.headers) r.set('webhook-id', id).set('webhook-timestamp', ts).set('webhook-signature', sig);
  else for (const [k, v] of Object.entries(opts.headers)) r.set(k, v);
  return r.send(raw);
}

const PROJECT = { id: 3, path_with_namespace: 'vitana/rehearsal' };
const mrEvent = (action: string, title = 'VTID-05541 (eng-gitlab-m2/scm-webhook): signed route') => ({
  object_kind: 'merge_request',
  project: PROJECT,
  object_attributes: {
    iid: 7, action, state: action === 'merge' ? 'merged' : 'opened', title,
    url: 'https://gitlab.vitanaland.com/vitana/rehearsal/-/merge_requests/7',
    source_branch: 'kiro/eng-gitlab-m2/scm-webhook', target_branch: 'main',
    last_commit: { id: 'a'.repeat(40) }, merge_commit_sha: action === 'merge' ? 'b'.repeat(40) : null,
    description: 'a long description that must not be copied into OASIS',
  },
});
const pipelineEvent = (status: string, mrTitle: string | null = 'VTID-05541 (eng-gitlab-m2/scm-webhook): signed route', commitTitle = 'no vtid here') => ({
  object_kind: 'pipeline',
  project: PROJECT,
  object_attributes: { id: 901, status, ref: 'main', sha: 'c'.repeat(40), source: 'merge_request_event', duration: 312, queued_duration: 4 },
  merge_request: mrTitle === null ? null : { iid: 7, title: mrTitle, url: 'https://gitlab.vitanaland.com/vitana/rehearsal/-/merge_requests/7' },
  commit: { id: 'c'.repeat(40), title: commitTitle },
});

describe('VTID-05541 POST /api/v1/internal/gitlab/webhook', () => {
  test('a signed merge request event is recorded once as an OASIS event with its VTID', async () => {
    const { deps, emit } = makeDeps();
    const res = await post(makeApp(deps), JSON.stringify(mrEvent('open')), { id: 'msg_open', headers: undefined })
      .set('x-gitlab-event', 'Merge Request Hook');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ ok: true, topic: 'scm.gitlab.merge_request.opened', vtid: 'VTID-05541', event_id: 'evt-1' });
    expect(emit).toHaveBeenCalledTimes(1);
    const ev = emit.mock.calls[0][0];
    expect(ev).toMatchObject({ vtid: 'VTID-05541', type: 'scm.gitlab.merge_request.opened', source: 'gitlab-webhook', status: 'info' });
    expect(ev.payload).toMatchObject({ host: 'gitlab', project: 'vitana/rehearsal', iid: 7, webhook_id: 'msg_open', gitlab_event: 'Merge Request Hook' });
    expect(JSON.stringify(ev)).not.toContain('long description');
  });

  test.each([
    ['merge_request open', mrEvent('open'), 'scm.gitlab.merge_request.opened'],
    ['merge_request reopen', mrEvent('reopen'), 'scm.gitlab.merge_request.opened'],
    ['merge_request merge', mrEvent('merge'), 'scm.gitlab.merge_request.merged'],
    ['merge_request close', mrEvent('close'), 'scm.gitlab.merge_request.closed'],
    ['pipeline success', pipelineEvent('success'), 'scm.gitlab.pipeline.succeeded'],
    ['pipeline failed', pipelineEvent('failed'), 'scm.gitlab.pipeline.failed'],
  ])('%s → %s', async (_name, event, topic) => {
    const { deps, emit } = makeDeps();
    const res = await post(makeApp(deps), JSON.stringify(event));
    expect(res.status).toBe(200);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].type).toBe(topic);
  });

  test('a bad signature is refused with 401 JSON and records nothing', async () => {
    const { deps, emit } = makeDeps();
    const raw = JSON.stringify(mrEvent('open'));
    const res = await post(makeApp(deps), raw, { sig: sign('msg_x', String(Math.floor(NOW / 1000)), raw, randomBytes(32)) });
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ ok: false, error: 'signature_invalid' });
    expect(emit).not.toHaveBeenCalled();
  });

  test('a signature over other bytes is refused (the exact raw body is what is checked)', async () => {
    const { deps, emit } = makeDeps();
    const signed = JSON.stringify(mrEvent('open'));
    const id = 'msg_tamper';
    const ts = String(Math.floor(NOW / 1000));
    const res = await post(makeApp(deps), signed.replace('"open"', '"merge"'), { id, ts, sig: sign(id, ts, signed) });
    expect(res.status).toBe(401);
    expect(emit).not.toHaveBeenCalled();
  });

  test('bytes that JSON re-serialization would change still verify, because the raw parser runs first', async () => {
    const { deps, emit } = makeDeps();
    const raw = `{ "object_kind" : "merge_request",\n  "project": ${JSON.stringify(PROJECT)},\n  "object_attributes": ${JSON.stringify(mrEvent('close').object_attributes)} }`;
    const res = await post(makeApp(deps), raw);
    expect(res.status).toBe(200);
    expect(emit.mock.calls[0][0].type).toBe('scm.gitlab.merge_request.closed');
  });

  test('a stale timestamp is refused with 401', async () => {
    const { deps, emit } = makeDeps();
    const res = await post(makeApp(deps), JSON.stringify(mrEvent('open')), { ts: String(Math.floor(NOW / 1000) - 3600) });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'timestamp_out_of_tolerance' });
    expect(emit).not.toHaveBeenCalled();
  });

  test('a request that carries only svix-* headers is refused with 401', async () => {
    const { deps, emit } = makeDeps();
    const raw = JSON.stringify(mrEvent('open'));
    const ts = String(Math.floor(NOW / 1000));
    const res = await post(makeApp(deps), raw, { headers: { 'svix-id': 'msg_s', 'svix-timestamp': ts, 'svix-signature': sign('msg_s', ts, raw) } });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'signature_missing' });
    expect(emit).not.toHaveBeenCalled();
  });

  test('an unsigned request gets 401 JSON whether or not a key is set (the staging probe)', async () => {
    for (const key of [KEY, undefined]) {
      const { deps, emit } = makeDeps({ signingKey: () => key });
      const res = await post(makeApp(deps), '{}', { headers: { authorization: 'Bearer staging-verify.invalid.probe' } });
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(emit).not.toHaveBeenCalled();
    }
  });

  test('a signed delivery with no signing key configured fails closed with 500 not_configured JSON', async () => {
    const { deps, emit } = makeDeps({ signingKey: () => undefined });
    const res = await post(makeApp(deps), JSON.stringify(mrEvent('open')));
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ ok: false, error: 'not_configured' });
    expect(emit).not.toHaveBeenCalled();
  });

  test('a key that decodes to nothing is treated as not configured', async () => {
    const { deps } = makeDeps({ signingKey: () => 'whsec_' });
    const res = await post(makeApp(deps), JSON.stringify(mrEvent('open')));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('not_configured');
  });

  test('the same webhook-id twice records one event; the second answer says duplicate', async () => {
    const { deps, emit } = makeDeps();
    const app = makeApp(deps);
    const raw = JSON.stringify(mrEvent('merge'));
    const first = await post(app, raw, { id: 'msg_dup' });
    const second = await post(app, raw, { id: 'msg_dup' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, duplicate: true });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['an event without a VTID', mrEvent('open', 'no vtid in this title')],
    ['an unmapped event kind (push)', { object_kind: 'push', project: PROJECT, commits: [] }],
    ['an unmapped merge request action (update)', mrEvent('update')],
    ['an unmapped pipeline status (running)', pipelineEvent('running')],
    ['a pipeline with no VTID in the merge request or the commit', pipelineEvent('success', null, 'chore: tidy')],
  ])('%s is acknowledged with 202 and records nothing', async (_name, event) => {
    const { deps, emit } = makeDeps();
    const res = await post(makeApp(deps), JSON.stringify(event));
    expect(res.status).toBe(202);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.ok).toBe(true);
    expect(res.body.ignored).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  test('a signed body that is not JSON gets 400 JSON', async () => {
    const { deps, emit } = makeDeps();
    const res = await post(makeApp(deps), '{"object_kind": "merge_request",');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_json' });
    expect(emit).not.toHaveBeenCalled();
  });

  test('a body over 1 MB gets 413 JSON, not an HTML error page', async () => {
    const { deps, emit } = makeDeps();
    const raw = JSON.stringify({ object_kind: 'merge_request', pad: 'x'.repeat(1024 * 1024 + 10) });
    const res = await post(makeApp(deps), raw);
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ ok: false, error: 'payload_too_large' });
    expect(emit).not.toHaveBeenCalled();
  });

  test('any content type is read raw (GitLab labels its bodies application/json, but the signature covers the bytes)', async () => {
    const { deps, emit } = makeDeps();
    const res = await post(makeApp(deps), JSON.stringify(pipelineEvent('failed')), { contentType: 'text/plain' });
    expect(res.status).toBe(200);
    expect(emit.mock.calls[0][0].type).toBe('scm.gitlab.pipeline.failed');
  });

  test('when OASIS cannot record the event the answer is 503 and a resend of the same delivery is processed', async () => {
    const emit = jest.fn()
      .mockResolvedValueOnce({ ok: false, error: 'insert failed' })
      .mockResolvedValueOnce({ ok: true, event_id: 'evt-2' });
    const { deps } = makeDeps({ emit });
    const app = makeApp(deps);
    const raw = JSON.stringify(pipelineEvent('success'));
    const first = await post(app, raw, { id: 'msg_retry' });
    expect(first.status).toBe(503);
    expect(first.body).toEqual({ ok: false, error: 'oasis_unavailable' });
    const resend = await post(app, raw, { id: 'msg_retry' });
    expect(resend.status).toBe(200);
    expect(resend.body.event_id).toBe('evt-2');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  test('an emitter that throws gives 503, never an unhandled error', async () => {
    const emit = jest.fn().mockRejectedValue(new Error('boom'));
    const { deps } = makeDeps({ emit });
    const res = await post(makeApp(deps), JSON.stringify(mrEvent('open')));
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  test('the default router reads GITLAB_WEBHOOK_SIGNING_TOKEN and records through emitOasisEvent', async () => {
    const saved = process.env.GITLAB_WEBHOOK_SIGNING_TOKEN;
    process.env.GITLAB_WEBHOOK_SIGNING_TOKEN = KEY;
    const emitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-default' });
    try {
      let mod: typeof import('../../src/routes/internal-gitlab-webhook') | undefined;
      jest.isolateModules(() => {
        jest.doMock('../../src/services/oasis-event-service', () => ({ emitOasisEvent }));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        mod = require('../../src/routes/internal-gitlab-webhook');
      });
      const app = express();
      mod!.mountGitlabWebhookParsers(app);
      app.use(express.json());
      app.use('/api/v1/internal/gitlab', mod!.default);
      const raw = JSON.stringify(mrEvent('open'));
      const id = 'msg_default';
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await request(app).post(GITLAB_WEBHOOK_PATH).set('content-type', 'application/json')
        .set('webhook-id', id).set('webhook-timestamp', ts).set('webhook-signature', sign(id, ts, raw)).send(raw);
      expect(res.status).toBe(200);
      expect(emitOasisEvent).toHaveBeenCalledTimes(1);
    } finally {
      if (saved === undefined) delete process.env.GITLAB_WEBHOOK_SIGNING_TOKEN;
      else process.env.GITLAB_WEBHOOK_SIGNING_TOKEN = saved;
    }
  });

  test('index.ts mounts the raw parser for the path before express.json() and mounts the router', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');
    const parsers = src.indexOf('internalGitlabWebhook.mountGitlabWebhookParsers(app)');
    const json = src.indexOf("app.use(express.json({ limit: '2mb' }))");
    expect(parsers).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(-1);
    expect(parsers).toBeLessThan(json);
    expect(src).toContain("mountRouterSync(app, '/api/v1/internal/gitlab', internalGitlabWebhook.default, { owner: 'internal-gitlab-webhook' })");
  });
});
