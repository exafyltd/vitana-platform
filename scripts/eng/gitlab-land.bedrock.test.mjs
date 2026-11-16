// MOCK-ONLY: the GitLab client is a fake that returns MR notes. The reviewer key is generated locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { bedrockReviewFor } from './gitlab-land.mjs';
import { canonicalJson, findingsDigest, ATTESTATION_MARKER } from './attested-review.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HEAD = 'a'.repeat(40);
const NOW = new Date('2026-11-16T10:00:00Z');
const project = { path_with_namespace: 'vitana/vitana-v1' };
const mr = { iid: 5 };
const key = { publicKeyPem, keyId: 'alias/mr-reviewer', reviewer: 'bedrock-plan-sparring', maxAgeMs: 3600_000 };

function note(att, created = '2026-11-16T09:00:00Z') {
  return { body: `${ATTESTATION_MARKER} ${Buffer.from(JSON.stringify(att)).toString('base64')} -->`, created_at: created, system: false };
}
function att(over = {}, findings = []) {
  const payload = { project: 'vitana/vitana-v1', mr_iid: 5, head_sha: HEAD, decision: 'ACCEPT', findings_sha256: findingsDigest(findings), reviewer: 'bedrock-plan-sparring', model: 'bedrock-opus', issued_at: NOW.toISOString(), key_id: 'alias/mr-reviewer', ...over };
  const signature = cryptoSign('sha256', Buffer.from(canonicalJson(payload), 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
  return { payload, signature, alg: 'ECDSA_SHA_256', findings };
}
function ctxWith(notes, k = key) {
  return {
    attestationKey: k,
    now: () => NOW,
    client: { paginate: async (path) => (path.endsWith('/notes') ? notes : []) },
  };
}

test('no reviewer key configured: nothing merges, with the reason named', async () => {
  const v = await bedrockReviewFor(ctxWith([note(att())], null), 1, project, mr, HEAD);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'no_review');
});

test('a verified Bedrock ACCEPT note for the current head passes', async () => {
  const v = await bedrockReviewFor(ctxWith([note(att())]), 1, project, mr, HEAD);
  assert.equal(v.ok, true);
  assert.equal(v.code, 'review_found');
});

test('trailers alone are not a review: with no attestation note the bot refuses', async () => {
  const v = await bedrockReviewFor(ctxWith([{ body: 'Collab-Reviewer: agent-reviewer', created_at: '2026-11-16T09:00:00Z', system: false }]), 1, project, mr, HEAD);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'no_review');
});

test('a new commit after an accept: the accept is for the old head and is stale', async () => {
  const v = await bedrockReviewFor(ctxWith([note(att())]), 1, project, mr, 'b'.repeat(40));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'review_stale');
});

test('CHANGES_REQUESTED is never a merge', async () => {
  const f = [{ id: 'R1-F1', severity: 'blocking', file: 'a.ts', line: 1, claim: 'c', evidence: 'a.ts:1' }];
  const v = await bedrockReviewFor(ctxWith([note(att({ decision: 'CHANGES_REQUESTED' }, f))]), 1, project, mr, HEAD);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'review_changes');
});

test('an attestation edited after signing is forged and refused', async () => {
  const a = att();
  a.payload.reviewer = 'someone';
  const v = await bedrockReviewFor(ctxWith([note(a)]), 1, project, mr, HEAD);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'review_forged');
});

test('the newest note is the one judged: an old accept does not survive a later changes note', async () => {
  const f = [{ id: 'R1-F1', severity: 'blocking', file: 'a.ts', line: 1, claim: 'c', evidence: 'a.ts:1' }];
  const v = await bedrockReviewFor(ctxWith([note(att(), '2026-11-16T09:00:00Z'), note(att({ decision: 'CHANGES_REQUESTED' }, f), '2026-11-16T09:30:00Z')]), 1, project, mr, HEAD);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'review_changes');
});
