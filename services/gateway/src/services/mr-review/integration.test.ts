// MOCK-ONLY integration: Bedrock partner stub → gateway handler → review job →
// merge gate. The GitLab reader is a fake. Verification uses a real local P-256 key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { handleReviewRequest, type ReviewEndpointDeps } from './endpoint.ts';
import { runReviewJob } from './review-job.ts';
import { judgeAttestedReview } from './merge-gate.ts';
import { runReviewCycle } from './remediation.ts';
import { KmsEcdsaSigner } from './kms-signer.ts';
import type { GitLabMrReader } from './review-context.ts';
import type { RunPass } from './bedrock-reviewer.ts';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KEY_ID = 'alias/mr-reviewer';
const PROJECT = 'exafyltd/vitana-v1';
const REVIEWER = 'bedrock-plan-sparring';
const HEAD = '2'.repeat(40);
const NOW = new Date('2026-11-16T10:00:00Z');

function fakeReader(headSeq: string[] = [HEAD]): GitLabMrReader {
  let i = 0;
  return {
    async getMr() { const sha = headSeq[Math.min(i, headSeq.length - 1)]; i += 1; return { sha, state: 'opened' }; },
    async getChanges() { return { files: [{ old_path: 'src/x.ts', new_path: 'src/x.ts', diff: '+ const a = 1;\n' }] }; },
  };
}

function kmsMock() {
  return {
    send: async (cmd: { name: string; input: Record<string, unknown> }) => {
      if (cmd.name === 'SignCommand') return { Signature: new Uint8Array(cryptoSign('sha256', cmd.input.Message as Buffer, { key: privateKey, dsaEncoding: 'der' })) };
      return { KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', PublicKey: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })) };
    },
  };
}

function deps(runPass: RunPass, reader = fakeReader(), over: Partial<ReviewEndpointDeps> = {}): ReviewEndpointDeps {
  return {
    authorize: (h) => h === 'Bearer good',
    readerFor: () => reader,
    runPass,
    signer: new KmsEcdsaSigner({ kms: kmsMock(), keyId: KEY_ID }),
    project: PROJECT,
    reviewer: REVIEWER,
    model: 'bedrock-opus',
    now: () => NOW,
    ...over,
  };
}

const passWith = (findings: unknown[]): RunPass => async () => ({ ok: true, review: { summary: 'ok', findings: findings as never } });

function requestVia(d: ReviewEndpointDeps) {
  return (body: { mr_iid: number; expected_head_sha: string }) => handleReviewRequest(d, { authorization: 'Bearer good', body }).then((r) => ({ status: r.status, json: r.body }));
}

test('the gateway refuses an unauthenticated caller before any review runs', async () => {
  let ran = false;
  const r = await handleReviewRequest(deps(async () => { ran = true; return { ok: true, review: { summary: '', findings: [] } }; }, undefined, { authorize: () => false }), { body: { mr_iid: 5, expected_head_sha: HEAD } });
  assert.equal(r.status, 401);
  assert.equal(ran, false);
});

test('a malformed body is refused with 400', async () => {
  const r = await handleReviewRequest(deps(passWith([])), { authorization: 'Bearer good', body: { mr_iid: 'five' } });
  assert.equal(r.status, 400);
});

test('a head that is not current is refused with 409 and no review runs', async () => {
  let ran = false;
  const r = await handleReviewRequest(deps(async () => { ran = true; return { ok: true, review: { summary: '', findings: [] } }; }, fakeReader(['3'.repeat(40)])), { authorization: 'Bearer good', body: { mr_iid: 5, expected_head_sha: HEAD } });
  assert.equal(r.status, 409);
  assert.equal(ran, false);
});

test('a partner failure becomes 502 with no attestation', async () => {
  const r = await handleReviewRequest(deps(async () => ({ ok: false, reason: 'model_unavailable', error: 'down' })), { authorization: 'Bearer good', body: { mr_iid: 5, expected_head_sha: HEAD } });
  assert.equal(r.status, 502);
  assert.equal('attestation' in r.body, false);
});

test('Bedrock-to-gateway-to-job: a clean review yields a verified ACCEPT the merge gate can use', async () => {
  const d = deps(passWith([]));
  const job = await runReviewJob({
    mr_iid: 5, expected_head_sha: HEAD, project: PROJECT, reviewer: REVIEWER, publicKeyPem, keyId: KEY_ID, maxAgeMs: 30 * 60_000,
    now: () => new Date(NOW.getTime() + 60_000), requestReview: requestVia(d),
  });
  assert.equal(job.ok, true);
  if (!job.ok) return;
  const gate = judgeAttestedReview({
    attestation: job.attestation, project: PROJECT, mr_iid: 5, head_sha: HEAD, publicKeyPem, keyId: KEY_ID,
    reviewer: REVIEWER, findings: [], now: new Date(NOW.getTime() + 60_000), maxAgeMs: 30 * 60_000,
  });
  assert.deepEqual(gate.ok, true);
});

test('Bedrock-to-gateway-to-job: a blocker yields CHANGES_REQUESTED with the findings, never a merge', async () => {
  const finding = { id: 'R1-F1', severity: 'blocker', claim: 'wrong', evidence: 'src/x.ts:1', suggestion: '' };
  const d = deps(passWith([finding]));
  const job = await runReviewJob({
    mr_iid: 5, expected_head_sha: HEAD, project: PROJECT, reviewer: REVIEWER, publicKeyPem, keyId: KEY_ID, maxAgeMs: 30 * 60_000,
    now: () => new Date(NOW.getTime() + 60_000), requestReview: requestVia(d),
  });
  assert.equal(job.ok, false);
  assert.equal(job.decision, 'CHANGES_REQUESTED');
});

test('a forged gateway response (signature from another key) fails the job', async () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const forgingKms = { send: async (cmd: { name: string; input: Record<string, unknown> }) => cmd.name === 'SignCommand'
    ? { Signature: new Uint8Array(cryptoSign('sha256', cmd.input.Message as Buffer, { key: other.privateKey, dsaEncoding: 'der' })) }
    : { KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', PublicKey: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })) } };
  const d = deps(passWith([]), fakeReader(), { signer: new KmsEcdsaSigner({ kms: forgingKms, keyId: KEY_ID }) });
  const job = await runReviewJob({
    mr_iid: 5, expected_head_sha: HEAD, project: PROJECT, reviewer: REVIEWER, publicKeyPem, keyId: KEY_ID, maxAgeMs: 30 * 60_000,
    now: () => new Date(NOW.getTime() + 60_000), requestReview: requestVia(d),
  });
  assert.equal(job.decision, 'FAILED');
});

test('remediation loop: CHANGES_REQUESTED → remediate → re-review → ACCEPT', async () => {
  const NEW = '4'.repeat(40);
  const reviewsSeen: string[] = [];
  const out = await runReviewCycle({
    startHead: HEAD,
    maxRounds: 3,
    review: async (head) => {
      reviewsSeen.push(head);
      return head === HEAD
        ? { kind: 'changes', head, findings: [{ id: 'R1-F1' }], attestation: {} }
        : { kind: 'accept', head, attestation: {} };
    },
    remediate: async () => ({ ok: true, newHead: NEW }),
  });
  assert.equal(out.status, 'accepted');
  assert.deepEqual(reviewsSeen, [HEAD, NEW]);
});

test('remediation loop escalates after the round limit and never accepts silently', async () => {
  const out = await runReviewCycle({
    startHead: HEAD, maxRounds: 2,
    review: async (head) => ({ kind: 'changes', head, findings: [{}], attestation: {} }),
    remediate: async () => ({ ok: true, newHead: HEAD }),
  });
  assert.equal(out.status, 'escalated');
  if (out.status === 'escalated') assert.equal(out.reason, 'max_rounds');
});

test('a failed remediation escalates; a failed review is not an accept', async () => {
  const a = await runReviewCycle({ startHead: HEAD, maxRounds: 3, review: async (h) => ({ kind: 'changes', head: h, findings: [{}], attestation: {} }), remediate: async () => ({ ok: false, error: 'agent crashed' }) });
  assert.equal(a.status, 'escalated');
  const b = await runReviewCycle({ startHead: HEAD, maxRounds: 3, review: async () => ({ kind: 'failed', reasons: ['gateway 502'] }), remediate: async () => ({ ok: true, newHead: HEAD }) });
  assert.equal(b.status, 'escalated');
  if (b.status === 'escalated') assert.equal(b.reason, 'review_failed');
});

test('merge gate refuses a stale attestation and one for another head', async () => {
  const d = deps(passWith([]));
  const job = await runReviewJob({ mr_iid: 5, expected_head_sha: HEAD, project: PROJECT, reviewer: REVIEWER, publicKeyPem, keyId: KEY_ID, maxAgeMs: 30 * 60_000, now: () => NOW, requestReview: requestVia(d) });
  assert.equal(job.ok, true);
  if (!job.ok) return;
  const stale = judgeAttestedReview({ attestation: job.attestation, project: PROJECT, mr_iid: 5, head_sha: HEAD, publicKeyPem, keyId: KEY_ID, reviewer: REVIEWER, findings: [], now: new Date(NOW.getTime() + 3 * 3600_000), maxAgeMs: 30 * 60_000 });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'review_stale');
  const other = judgeAttestedReview({ attestation: job.attestation, project: PROJECT, mr_iid: 5, head_sha: '5'.repeat(40), publicKeyPem, keyId: KEY_ID, reviewer: REVIEWER, findings: [], now: NOW, maxAgeMs: 30 * 60_000 });
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.code, 'review_forged');
  const none = judgeAttestedReview({ attestation: undefined as never, project: PROJECT, mr_iid: 5, head_sha: HEAD, publicKeyPem, keyId: KEY_ID, reviewer: REVIEWER, findings: [], now: NOW, maxAgeMs: 1 });
  if (!none.ok) assert.equal(none.code, 'no_review');
});
