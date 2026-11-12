/** Bedrock lane reviewer — route tests: auth, body validation and the verdict response. No AWS. */
import express from 'express';
import request from 'supertest';
import { createLaneReviewRouter, parseLaneReviewBody } from '../src/routes/lane-review';
import type { CallReviewModel } from '../src/services/lane-review/review-pass';

const SHA = 'b'.repeat(40);
const good = {
  repo: 'exafyltd/vitana-platform',
  pr: 7,
  head_sha: SHA,
  lane_key: 'x/y',
  acceptance: 'criteria',
  diff: 'diff text',
  changed_files: ['services/gateway/src/x.ts'],
};

function app(callModel: CallReviewModel) {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/v1/lane-review', createLaneReviewRouter(callModel));
  return a;
}

describe('POST /api/v1/lane-review', () => {
  const OLD = process.env.GATEWAY_SERVICE_TOKEN;
  beforeAll(() => { process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token'; });
  afterAll(() => { process.env.GATEWAY_SERVICE_TOKEN = OLD; });

  it('refuses a call without auth', async () => {
    const r = await request(app(async () => ({ ok: true, toolInput: { verdict: 'accept', findings: [] } })))
      .post('/api/v1/lane-review').send(good);
    expect([401, 403]).toContain(r.status);
  });

  it('rejects a body with a bad head sha', async () => {
    const r = await request(app(async () => ({ ok: true, toolInput: { verdict: 'accept', findings: [] } })))
      .post('/api/v1/lane-review').set('Authorization', 'Bearer test-service-token').send({ ...good, head_sha: 'nope' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('head_sha_invalid');
  });

  it('returns the verdict and model for a valid call', async () => {
    const r = await request(app(async () => ({ ok: true, toolInput: { verdict: 'accept', findings: [] } })))
      .post('/api/v1/lane-review').set('Authorization', 'Bearer test-service-token').send(good);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, verdict: 'accept', model: 'claude-opus-4.6', headSha: SHA });
  });

  it('returns 503 model_unavailable when every tier fails', async () => {
    const r = await request(app(async () => ({ ok: false, error: 'throttled' })))
      .post('/api/v1/lane-review').set('Authorization', 'Bearer test-service-token').send(good);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('model_unavailable');
  });
});

describe('parseLaneReviewBody', () => {
  it('accepts a complete body', () => {
    expect(typeof parseLaneReviewBody(good)).toBe('object');
  });
  it('names the first missing field', () => {
    expect(parseLaneReviewBody({ ...good, pr: 0 })).toBe('pr_required');
    expect(parseLaneReviewBody({ ...good, changed_files: 'x' })).toBe('changed_files_required');
  });
});
