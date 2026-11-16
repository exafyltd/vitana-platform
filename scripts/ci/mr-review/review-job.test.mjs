// MOCK-ONLY: the gateway and GitLab are fake fetch functions. No live call is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { runMrReviewJob, EXIT } from './review-job.mjs';
import { canonicalJson, findingsDigest } from '../../eng/attested-review.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HEAD = 'a'.repeat(40);
const NOW = new Date('2026-11-16T10:00:00Z');
const cfg = {
  gatewayUrl: 'https://gw.example', gatewayToken: 'caller-token', gitlabApi: 'https://gl.example/api/v4', gitlabToken: 'gl-token',
  projectId: '3', project: 'vitana/vitana-v1', mrIid: 5, headSha: HEAD, publicKeyPem, keyId: 'alias/mr-reviewer',
  reviewer: 'bedrock-plan-sparring', correlationId: 'pipe-job',
};

function att(decision = 'ACCEPT', findings = [], over = {}) {
  const payload = { project: 'vitana/vitana-v1', mr_iid: 5, head_sha: HEAD, decision, findings_sha256: findingsDigest(findings), reviewer: 'bedrock-plan-sparring', model: 'bedrock-opus', issued_at: NOW.toISOString(), key_id: 'alias/mr-reviewer', ...over };
  const signature = cryptoSign('sha256', Buffer.from(canonicalJson(payload), 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
  return { payload, signature, alg: 'ECDSA_SHA_256' };
}

function fetchWith(gatewayStatus, gatewayJson, noteStatus = 201) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/v1/mr-review')) return { status: gatewayStatus, json: async () => gatewayJson };
    return { status: noteStatus, json: async () => ({}) };
  };
  return { fetchFn, calls };
}

test('a verified ACCEPT: exit 0, the signed note is recorded on the MR, correlation id sent to the gateway', async () => {
  const { fetchFn, calls } = fetchWith(200, { verdict: { findings: [] }, attestation: att('ACCEPT') });
  const r = await runMrReviewJob({ cfg, fetchFn, now: () => NOW });
  assert.equal(r.exit, EXIT.accept);
  assert.equal(calls[0].init.headers['x-correlation-id'], 'pipe-job');
  assert.match(calls[1].url, /merge_requests\/5\/notes$/);
});

test('a verified CHANGES_REQUESTED: exit 1 with its findings recorded, never an accept', async () => {
  const f = [{ id: 'R1-F1', severity: 'blocking', file: 'a.ts', line: 1, claim: 'c', evidence: 'a.ts:1' }];
  const { fetchFn } = fetchWith(200, { verdict: { findings: f }, attestation: att('CHANGES_REQUESTED', f) });
  const r = await runMrReviewJob({ cfg, fetchFn, now: () => NOW });
  assert.equal(r.exit, EXIT.changes);
});

test('a gateway refusal or outage is a failure (exit 2), not an accept', async () => {
  for (const status of [401, 409, 502, 503]) {
    const { fetchFn } = fetchWith(status, {});
    assert.equal((await runMrReviewJob({ cfg, fetchFn, now: () => NOW })).exit, EXIT.failed, `status ${status}`);
  }
});

test('an attestation for another head, or with a bad signature, is a failure', async () => {
  const wrongHead = att('ACCEPT', [], { head_sha: 'b'.repeat(40) });
  assert.equal((await runMrReviewJob({ cfg, fetchFn: fetchWith(200, { verdict: { findings: [] }, attestation: wrongHead }).fetchFn, now: () => NOW })).exit, EXIT.failed);
  const forged = att('ACCEPT');
  forged.payload.reviewer = 'someone';
  assert.equal((await runMrReviewJob({ cfg, fetchFn: fetchWith(200, { verdict: { findings: [] }, attestation: forged }).fetchFn, now: () => NOW })).exit, EXIT.failed);
});

test('an expired attestation is a failure', async () => {
  const { fetchFn } = fetchWith(200, { verdict: { findings: [] }, attestation: att('ACCEPT') });
  const r = await runMrReviewJob({ cfg, fetchFn, now: () => new Date(NOW.getTime() + 3 * 3600_000) });
  assert.equal(r.exit, EXIT.failed);
});

test('a response without an attestation is a failure', async () => {
  const { fetchFn } = fetchWith(200, { verdict: { findings: [] } });
  assert.equal((await runMrReviewJob({ cfg, fetchFn, now: () => NOW })).exit, EXIT.failed);
});

test('a failed note write is a failure: a review nobody can see does not count as a merge reason', async () => {
  const { fetchFn } = fetchWith(200, { verdict: { findings: [] }, attestation: att('ACCEPT') }, 500);
  assert.equal((await runMrReviewJob({ cfg, fetchFn, now: () => NOW })).exit, EXIT.failed);
});
