// MOCK-ONLY: the reviewer key is generated locally. No live KMS or GitLab call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { canonicalJson, findingsDigest, judgeAttestedReview, attestationFromNotes, ATTESTATION_MARKER } from './attested-review.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HEAD = 'a'.repeat(40);
const NOW = new Date('2026-11-16T10:00:00Z');
const base = { project: 'exafyltd/vitana-v1', reviewer: 'bedrock-plan-sparring', keyId: 'alias/mr-reviewer' };

function signed(over = {}, findings = []) {
  const payload = {
    project: base.project, mr_iid: 5, head_sha: HEAD, decision: 'ACCEPT',
    findings_sha256: findingsDigest(findings), reviewer: base.reviewer, model: 'bedrock-opus',
    issued_at: NOW.toISOString(), key_id: base.keyId, ...over,
  };
  const sig = cryptoSign('sha256', Buffer.from(canonicalJson(payload), 'utf8'), { key: privateKey, dsaEncoding: 'der' });
  return { payload, signature: sig.toString('base64'), alg: 'ECDSA_SHA_256', findings };
}

const judge = (att, over = {}) => judgeAttestedReview({
  attestation: att, project: base.project, mr_iid: 5, head_sha: HEAD, publicKeyPem, keyId: base.keyId,
  reviewer: base.reviewer, findings: att?.findings ?? [], now: NOW, maxAgeMs: 3600_000, ...over,
});

test('a verified ACCEPT for the exact merge head passes', () => {
  const v = judge(signed());
  assert.equal(v.ok, true);
  assert.equal(v.code, 'review_found');
});

test('CHANGES_REQUESTED is never an accept, even when genuinely signed', () => {
  const v = judge(signed({ decision: 'CHANGES_REQUESTED' }));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'review_changes');
});

test('a new commit (merge head changed after the accept) makes the accept stale', () => {
  const v = judge(signed(), { head_sha: 'b'.repeat(40) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'review_stale');
});

test('an accept older than the maximum age is stale; one dated in the future is refused', () => {
  assert.equal(judge(signed(), { now: new Date(NOW.getTime() + 2 * 3600_000) }).code, 'review_stale');
  assert.equal(judge(signed({ issued_at: new Date(NOW.getTime() + 10 * 60_000).toISOString() })).code, 'review_stale');
});

test('a forged payload (edited after signing) is refused as forged', () => {
  const att = signed();
  att.payload.reviewer = 'someone';
  assert.equal(judge(att, { reviewer: 'someone' }).code, 'review_forged');
});

test('an accept for another project or MR, or under another key id, is refused', () => {
  assert.equal(judge(signed()).ok, true);
  assert.equal(judge(signed(), { project: 'exafyltd/vitana-platform' }).ok, false);
  assert.equal(judge(signed(), { mr_iid: 4 }).ok, false);
  assert.equal(judge(signed(), { keyId: 'other' }).ok, false);
});

test('an accept signed by another key is refused', () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const att = signed();
  att.signature = cryptoSign('sha256', Buffer.from(canonicalJson(att.payload), 'utf8'), { key: other.privateKey, dsaEncoding: 'der' }).toString('base64');
  assert.equal(judge(att).code, 'review_forged');
});

test('findings changed after the accept invalidate it', () => {
  const att = signed({}, []);
  att.findings = [{ id: 'm', severity: 'minor', file: 'a.ts', line: 1, claim: 'x', evidence: 'a.ts:1' }];
  assert.equal(judge(att).ok, false);
});

test('no attestation means no review, so no merge', () => {
  const v = judge(null);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'no_review');
});

test('a malformed merge head is refused before any signature check', () => {
  assert.equal(judge(signed(), { head_sha: 'short' }).code, 'no_review');
});

const note = (body, created_at, system = false) => ({ body, created_at, system });
const wrap = (att) => `${ATTESTATION_MARKER} ${Buffer.from(JSON.stringify(att)).toString('base64')} -->`;

test('the newest attestation note is read; an unparseable or system note is ignored', () => {
  const older = signed({ head_sha: 'c'.repeat(40) });
  const newer = signed();
  const notes = [
    note(wrap(older), '2026-11-16T09:00:00Z'),
    note(wrap(newer), '2026-11-16T09:30:00Z'),
    note(`${ATTESTATION_MARKER} not-base64-json -->`, '2026-11-16T09:45:00Z'),
    note(wrap(signed({ decision: 'ACCEPT' })), '2026-11-16T09:50:00Z', true),
  ];
  const found = attestationFromNotes(notes);
  assert.equal(found.payload.head_sha, HEAD);
});

test('no attestation note at all reads as null', () => {
  assert.equal(attestationFromNotes([note('just a comment', '2026-11-16T09:00:00Z')]), null);
});
