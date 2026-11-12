/**
 * VTID-05547 (plan agentic-delivery §3.11) — the GitLab delivery stage in front of
 * POST /api/v1/internal/gitlab/webhook, mounted the way index.ts mounts it.
 *
 * Pins:
 *   - the signature check is the one of routes/internal-gitlab-webhook.ts, unchanged (same replies);
 *   - a signed delivery records every event it maps to, in order, once: by webhook-id, and by dedupe_key
 *     (so the same fact from another delivery, or a retry after a partial failure, writes nothing twice);
 *   - the stage answers the delivery itself, so the M2 router behind it never emits a second, plain event;
 *   - replies are always JSON: 200 / 202 / 400 / 401 / 413 / 500 / 502;
 *   - index.ts mounts the stage as middleware just before the unchanged M2 router, and mounts the Delivery routes.
 */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true, event_id: 'evt-default' })),
}));

import { emitOasisEvent } from '../../src/services/oasis-event-service';
import { GITLAB_WEBHOOK_BODY_LIMIT, createGitlabWebhookRouter, gitlabWebhookBodyErrors } from '../../src/routes/internal-gitlab-webhook';
import { DeliveryDedupe } from '../../src/services/gitlab-events/dedupe';
import { MemoryBranchVtidIndex } from '../../src/services/gitlab-events/delivery-mapper';
import { createGitlabDeliveryStage, oasisBranchVtidLookup, type OasisEmit } from '../../src/services/gitlab-events/delivery-stage';
import { LIVE_ENV, REVIEW_COMMIT, SIGNING_KEY, mergeRequest, pipeline, push, signedHeaders } from './fixtures';

const defaultEmit = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;
const URL_PATH = '/api/v1/internal/gitlab/webhook';
const ENV0 = { ...process.env };
let seq = 0;
const newId = () => `msg_delivery_${process.pid}_${++seq}`;

function app(options: Parameters<typeof createGitlabDeliveryStage>[0] = {}) {
  // The way index.ts mounts it: raw bytes for the path, then the JSON parser, then the stage, then the M2 router.
  const a = express();
  a.use(URL_PATH, express.raw({ type: '*/*', limit: GITLAB_WEBHOOK_BODY_LIMIT }), gitlabWebhookBodyErrors);
  a.use(express.json({ limit: '2mb' }));
  a.use(URL_PATH, createGitlabDeliveryStage({ map: { env: LIVE_ENV, branches: new MemoryBranchVtidIndex() }, ...options }));
  a.use('/api/v1/internal/gitlab', createGitlabWebhookRouter({ dedupe: new DeliveryDedupe() }));
  return a;
}

function post(a: express.Express, payload: unknown, id = newId(), headers: Record<string, string> | null = null) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return request(a)
    .post(URL_PATH)
    .set('Content-Type', 'application/json')
    .set(headers ?? signedHeaders(raw, id))
    .send(raw);
}

class FakeEmit {
  calls: Array<{ type: string; vtid: string; key: string }> = [];
  failOn = new Set<number>();
  throwOn = new Set<number>();
  n = 0;
  fn: OasisEmit = async (event) => {
    this.n += 1;
    if (this.throwOn.has(this.n)) throw new Error('oasis exploded with a secret detail');
    if (this.failOn.has(this.n)) return { ok: false, error: 'down' };
    this.calls.push({ type: event.type, vtid: event.vtid, key: String((event.payload as { dedupe_key?: string }).dedupe_key) });
    return { ok: true, event_id: `evt-${this.calls.length}` };
  };
}

beforeEach(() => {
  process.env = { ...ENV0, GITLAB_WEBHOOK_SIGNING_TOKEN: SIGNING_KEY };
  defaultEmit.mockClear();
  defaultEmit.mockResolvedValue({ ok: true, event_id: 'evt-default' });
});
afterAll(() => {
  process.env = ENV0;
});

const LANDED_PIPELINE = () =>
  pipeline('success', { builds: [{ id: 1, name: 'full-suite', status: 'success' }, { id: 2, name: 'deploy-staging:gateway', status: 'success', duration: 200, queued_duration: 5 }] });

describe('VTID-05547 the stage — the signature check is the M2 route\'s, unchanged', () => {
  it('the unsigned staging probe → 401 signature_missing JSON, with the key set and with no key configured', async () => {
    const emit = new FakeEmit();
    for (const key of [SIGNING_KEY, undefined]) {
      if (key) process.env.GITLAB_WEBHOOK_SIGNING_TOKEN = key;
      else delete process.env.GITLAB_WEBHOOK_SIGNING_TOKEN;
      const res = await request(app({ emit: emit.fn })).post(URL_PATH).set('Content-Type', 'application/json').send('{}');
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ ok: false, error: 'signature_missing' });
    }
    expect(emit.calls).toHaveLength(0);
  });

  it('a signed delivery with no key configured → 500 not_configured, nothing recorded', async () => {
    delete process.env.GITLAB_WEBHOOK_SIGNING_TOKEN;
    const emit = new FakeEmit();
    const res = await post(app({ emit: emit.fn }), pipeline('running'));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'not_configured' });
    expect(emit.calls).toHaveLength(0);
  });

  it('a signature made with another key, an altered body, a stale timestamp and svix-* headers only are refused 401', async () => {
    const emit = new FakeEmit();
    const a = app({ emit: emit.fn });
    const raw = JSON.stringify(pipeline('running'));
    const other = `whsec_${Buffer.from('a-different-key-entirely-0123456789').toString('base64')}`;
    const wrongKey = await post(a, raw, 'id-1', signedHeaders(raw, 'id-1', other));
    expect([wrongKey.status, wrongKey.body.error]).toEqual([401, 'signature_invalid']);
    const altered = await post(a, raw.replace('"id":31', '"id":32'), 'id-2', signedHeaders(raw, 'id-2'));
    expect([altered.status, altered.body.error]).toEqual([401, 'signature_invalid']);
    const stale = await post(a, raw, 'id-3', signedHeaders(raw, 'id-3', SIGNING_KEY, String(Math.floor(Date.now() / 1000) - 3600)));
    expect([stale.status, stale.body.error]).toEqual([401, 'timestamp_out_of_tolerance']);
    const h = signedHeaders(raw, 'id-4');
    const svix = await request(a).post(URL_PATH).set('Content-Type', 'application/json').set({ 'svix-id': h['webhook-id'], 'svix-timestamp': h['webhook-timestamp'], 'svix-signature': h['webhook-signature'] }).send(raw);
    expect([svix.status, svix.body.error]).toEqual([401, 'signature_missing']);
    expect(emit.calls).toHaveLength(0);
  });
});

describe('VTID-05547 the stage — a signed delivery records every event it maps to', () => {
  it('a main pipeline records the pipeline, the landing and the staging deploy, in order, and replies with all three', async () => {
    const emit = new FakeEmit();
    const res = await post(app({ emit: emit.fn }), LANDED_PIPELINE());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(emit.calls.map((c) => c.type)).toEqual(['scm.gitlab.pipeline.succeeded', 'delivery.landed', 'staging.deploy.completed']);
    expect(res.body).toMatchObject({ ok: true, topic: 'scm.gitlab.pipeline.succeeded', vtid: 'VTID-05547', event_id: 'evt-1' });
    expect(res.body.events).toEqual([
      { topic: 'scm.gitlab.pipeline.succeeded', vtid: 'VTID-05547', event_id: 'evt-1' },
      { topic: 'delivery.landed', vtid: 'VTID-05547', event_id: 'evt-2' },
      { topic: 'staging.deploy.completed', vtid: 'VTID-05547', event_id: 'evt-3' },
    ]);
  });

  it('a push with a review entry records the push, the review and the lane update', async () => {
    const emit = new FakeEmit();
    const res = await post(app({ emit: emit.fn }), push({ commits: [REVIEW_COMMIT] }));
    expect(res.status).toBe(200);
    expect(emit.calls.map((c) => c.type)).toEqual(['scm.gitlab.push', 'delivery.review.recorded', 'delivery.lane.updated']);
  });

  it('a merge request opened and then pushed to: the push takes the VTID of the merge request seen by this task', async () => {
    const emit = new FakeEmit();
    const a = app({ emit: emit.fn });
    await post(a, mergeRequest('open'));
    const res = await post(a, push({ commits: [{ id: 'f'.repeat(40), title: 'wip', message: 'wip', modified: [] }], after: 'f'.repeat(40) }));
    expect(res.status).toBe(200);
    expect(emit.calls.map((c) => [c.type, c.vtid])).toEqual([['scm.gitlab.merge_request.opened', 'VTID-05547'], ['scm.gitlab.push', 'VTID-05547']]);
  });

  it('the stage answers the delivery itself: the M2 router behind it does not emit a second, plain event', async () => {
    const res = await post(app(), mergeRequest('open'));
    expect(res.status).toBe(200);
    expect(defaultEmit).toHaveBeenCalledTimes(1);
    const event = defaultEmit.mock.calls[0][0];
    expect(event.type).toBe('scm.gitlab.merge_request.opened');
    expect((event.payload as Record<string, unknown>).dedupe_key).toMatch(/^gitlab:vitana\/vitana-platform:merge_request:12:open:/);
  });
});

describe('VTID-05547 the stage — exactly once', () => {
  it('a duplicate webhook-id answers 200 duplicate and records nothing more', async () => {
    const emit = new FakeEmit();
    const a = app({ emit: emit.fn });
    const id = newId();
    expect((await post(a, LANDED_PIPELINE(), id)).status).toBe(200);
    const again = await post(a, LANDED_PIPELINE(), id);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, duplicate: true });
    expect(emit.calls).toHaveLength(3);
  });

  it('a webhook-id that was recorded is a duplicate for good: another body with that id records nothing and reads nothing', async () => {
    // The facts of a retried delivery are already known by their dedupe_key, so a retry cannot tell the id check from the
    // fact check. A request that reuses the id with a different body can: the id is answered before the body is mapped.
    const emit = new FakeEmit();
    const lookup = jest.fn(async () => 'VTID-00777');
    const a = app({ emit: emit.fn, map: { env: LIVE_ENV, branches: new MemoryBranchVtidIndex(), lookupBranchVtid: lookup } });
    const id = newId();
    expect((await post(a, LANDED_PIPELINE(), id)).status).toBe(200);
    expect(emit.calls).toHaveLength(3);
    const reused = await post(a, push(), id);
    expect([reused.status, reused.body]).toEqual([200, { ok: true, duplicate: true }]);
    expect(emit.calls).toHaveLength(3);
    expect(lookup).not.toHaveBeenCalled(); // nothing was mapped, so no branch was looked up in OASIS
    // The same push under a new id is a new delivery: it is mapped, looked up and recorded.
    const fresh = await post(a, push(), newId());
    expect(fresh.status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(emit.calls).toHaveLength(4);
  });

  it('the same fact from another delivery (another webhook-id) is one row: a duplicate dedupe_key records nothing', async () => {
    const emit = new FakeEmit();
    const a = app({ emit: emit.fn });
    await post(a, pipeline('running'));
    const second = await post(a, pipeline('running'));
    expect(second.body).toEqual({ ok: true, duplicate: true });
    expect(emit.calls.filter((c) => c.type === 'delivery.landed')).toHaveLength(1);
    // The landing seen again at success is the same fact; the success pipeline row is new.
    const ok = await post(a, pipeline('success'));
    expect(ok.body.events.map((e: { topic: string }) => e.topic)).toEqual(['scm.gitlab.pipeline.succeeded']);
    expect(emit.calls.filter((c) => c.type === 'delivery.landed')).toHaveLength(1);
  });

  it('the second event failing answers 502, and the retry of the same delivery writes only what is missing', async () => {
    const emit = new FakeEmit();
    emit.failOn.add(2); // the landing fails
    const a = app({ emit: emit.fn });
    const id = newId();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await post(a, LANDED_PIPELINE(), id);
    spy.mockRestore();
    expect(first.status).toBe(502);
    expect(first.body).toEqual({ ok: false, error: 'oasis_emit_failed' });
    expect(emit.calls.map((c) => c.type)).toEqual(['scm.gitlab.pipeline.succeeded']);
    const retry = await post(a, LANDED_PIPELINE(), id);
    expect(retry.status).toBe(200);
    expect(retry.body.events.map((e: { topic: string }) => e.topic)).toEqual(['delivery.landed', 'staging.deploy.completed']);
    expect(emit.calls.map((c) => c.type)).toEqual(['scm.gitlab.pipeline.succeeded', 'delivery.landed', 'staging.deploy.completed']);
    expect((await post(a, LANDED_PIPELINE(), id)).body).toEqual({ ok: true, duplicate: true });
  });

  it('the OASIS write throwing answers 502 without the error text', async () => {
    const emit = new FakeEmit();
    emit.throwOn.add(1);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await post(app({ emit: emit.fn }), pipeline('running'));
    spy.mockRestore();
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('secret detail');
  });
});

describe('VTID-05547 the stage — every reply is JSON', () => {
  it('an event it does not map is acknowledged and ignored with the reason (202)', async () => {
    const emit = new FakeEmit();
    const a = app({ emit: emit.fn });
    const note = await post(a, { object_kind: 'note', object_attributes: { note: 'VTID-05547' } });
    expect([note.status, note.body]).toEqual([202, { ok: true, ignored: true, reason: 'unknown_event' }]);
    const other = await post(a, push({ ref: 'refs/heads/main' }));
    expect([other.status, other.body.reason]).toEqual([202, 'unmapped_ref']);
    const status = await post(a, pipeline('pending'));
    expect([status.status, status.body.reason]).toEqual([202, 'unmapped_status']);
    expect(emit.calls).toHaveLength(0);
  });

  it('malformed JSON with a valid signature → 400 invalid_json', async () => {
    const res = await post(app(), '{not json');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_json' });
  });

  it('a body over the limit → 413 payload_too_large, as JSON', async () => {
    const res = await request(app()).post(URL_PATH).set('Content-Type', 'application/json').set(signedHeaders('x', newId())).send('x'.repeat(2 * 1024 * 1024 + 10));
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ ok: false, error: 'payload_too_large' });
  });

  it('any method but POST falls through to Express (no GET handler, no HTML error page from the stage)', async () => {
    const res = await request(app()).get(URL_PATH);
    expect(res.status).toBe(404);
    expect(defaultEmit).not.toHaveBeenCalled();
  });
});

describe('VTID-05547 the branch lookup in OASIS (read only)', () => {
  const env = { SUPABASE_URL: 'http://oasis.invalid', SUPABASE_SERVICE_ROLE: 'fake-role' } as NodeJS.ProcessEnv;

  it('asks the merge request rows of the branch and returns the VTID of the newest', async () => {
    const fetchFake = jest.fn(async () => ({ ok: true, json: async () => [{ vtid: 'VTID-05547' }] })) as unknown as typeof fetch;
    const vtid = await oasisBranchVtidLookup({ fetch: fetchFake, env })('vitana/vitana-platform', 'kiro/a/b c');
    expect(vtid).toBe('VTID-05547');
    const [url, init] = (fetchFake as unknown as jest.Mock).mock.calls[0];
    expect(String(url)).toContain('http://oasis.invalid/rest/v1/oasis_events?select=vtid');
    expect(String(url)).toContain('topic=in.(scm.gitlab.merge_request.opened,scm.gitlab.merge_request.updated,scm.gitlab.merge_request.merged,scm.gitlab.merge_request.closed)');
    expect(String(url)).toContain('metadata->>project_path=eq.vitana%2Fvitana-platform');
    expect(String(url)).toContain('metadata->>source_branch=eq.kiro%2Fa%2Fb%20c');
    expect(String(url)).toContain('order=created_at.desc&limit=1');
    expect(init).toEqual({ headers: { apikey: 'fake-role', Authorization: 'Bearer fake-role' } });
    expect((init as { method?: string }).method).toBeUndefined(); // a GET
  });

  it('answers null for no row, an upstream error, a throw, a VTID that is not VTID-\\d{5}, no project and no credentials', async () => {
    const lookup = (f: unknown, e = env) => oasisBranchVtidLookup({ fetch: f as typeof fetch, env: e });
    expect(await lookup(async () => ({ ok: true, json: async () => [{ vtid: 'VTID-00001' }] }))('p', 'b')).toBe('VTID-00001'); // the same lookup does answer
    expect(await lookup(async () => ({ ok: true, json: async () => [] }))('p', 'b')).toBeNull();
    expect(await lookup(async () => ({ ok: false, json: async () => [] }))('p', 'b')).toBeNull();
    expect(await lookup(async () => { throw new Error('x'); })('p', 'b')).toBeNull();
    expect(await lookup(async () => ({ ok: true, json: async () => [{ vtid: 'BOOTSTRAP-DELIVERY' }] }))('p', 'b')).toBeNull();
    const never = jest.fn();
    expect(await lookup(never)(null, 'b')).toBeNull();
    expect(await lookup(never, {} as NodeJS.ProcessEnv)('p', 'b')).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it('a push handled by a task that has not seen the merge request uses the lookup', async () => {
    const emit = new FakeEmit();
    const lookup = jest.fn(async () => 'VTID-00777');
    const res = await post(app({ emit: emit.fn, map: { env: LIVE_ENV, branches: new MemoryBranchVtidIndex(), lookupBranchVtid: lookup } }), push());
    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledWith('vitana/vitana-platform', 'kiro/agentic-delivery/gateway-delivery');
    expect(emit.calls[0]).toMatchObject({ type: 'scm.gitlab.push', vtid: 'VTID-00777' });
  });
});

describe('VTID-05547 index.ts — how the stage and the Delivery routes are mounted', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');

  it('mounts the stage as middleware on the webhook path, just before the unchanged M2 router mount, after the raw body parser', () => {
    const raw = src.indexOf(`app.use('${URL_PATH}', express.raw({ type: '*/*', limit: GITLAB_WEBHOOK_BODY_LIMIT }), gitlabWebhookBodyErrors);`);
    const json = src.indexOf("app.use(express.json({ limit: '2mb' }))");
    const stage = src.indexOf(`app.use('${URL_PATH}', createGitlabDeliveryStage(`);
    const router = src.indexOf("mountRouterSync(app, '/api/v1/internal/gitlab', internalGitlabWebhookRouter, { owner: 'internal-gitlab-webhook' });");
    expect(raw).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(raw);
    expect(stage).toBeGreaterThan(json);
    expect(router).toBeGreaterThan(stage);
    expect(src.slice(stage, router)).not.toContain('mountRouterSync'); // nothing else between them: the router mount follows the stage
    expect(src).toContain("require('./services/gitlab-events/delivery-stage')");
    expect(src).toContain('lookupBranchVtid: oasisBranchVtidLookup()');
    expect(src).toContain("require('./routes/internal-gitlab-webhook')");
    expect(src.split('internalGitlabWebhookRouter, {').length).toBe(2); // mounted once
  });

  it('mounts the Delivery read routes once, through the route guard', () => {
    expect(src).toContain("const deliveryRouter = require('./routes/delivery').default;");
    expect(src).toContain("mountRouterSync(app, '/api/v1/delivery', deliveryRouter, { owner: 'delivery' });");
    expect(src.split("'/api/v1/delivery'").length).toBe(2);
  });
});
