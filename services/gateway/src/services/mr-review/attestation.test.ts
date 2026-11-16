import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { signAttestation, verifyAttestation, findingsDigest, type AttestationSigner } from './attestation';

// Test-only key. Production signs with an AWS KMS ECC_NIST_P256 key.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KEY_ID = 'test-kms-key';
const HEAD = 'e'.repeat(40);
const findings: unknown[] = [];

const signer: AttestationSigner = {
  keyId: KEY_ID,
  async sign(message: Buffer) {
    return cryptoSign('sha256', message, { key: privateKey, dsaEncoding: 'der' });
  },
};

const issued = new Date('2026-11-16T10:00:00Z');
const expect = (over: Record<string, unknown> = {}) => ({
  project: 'exafyltd/vitana-v1',
  mr_iid: 5,
  head_sha: HEAD,
  publicKeyPem,
  keyId: KEY_ID,
  now: new Date('2026-11-16T10:05:00Z'),
  maxAgeMs: 30 * 60_000,
  reviewer: 'bedrock-plan-sparring',
  findings,
  ...over,
});

async function accept(over: Record<string, unknown> = {}) {
  return signAttestation({
    project: 'exafyltd/vitana-v1',
    mr_iid: 5,
    head_sha: HEAD,
    decision: 'ACCEPT',
    findings,
    reviewer: 'bedrock-plan-sparring',
    model: 'bedrock-opus',
    issued_at: issued.toISOString(),
    signer,
    ...over,
  } as never);
}

test('a valid ACCEPT for the exact head verifies', async () => {
  const att = await accept();
  assert.deepEqual(verifyAttestation(att, expect()), { ok: true });
});

test('an ACCEPT for another head is refused even with a valid signature', async () => {
  const att = await accept({ head_sha: 'f'.repeat(40) });
  const r = verifyAttestation(att, expect());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reasons.join(' '), /not the merge head/);
});

test('a tampered payload fails the signature check', async () => {
  const att = await accept();
  const tampered = { ...att, payload: { ...att.payload, reviewer: 'someone-else' } };
  const r = verifyAttestation(tampered, expect({ reviewer: 'someone-else' }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reasons.join(' '), /signature does not verify/);
});

test('a signature from a different key is refused', async () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const att = await signAttestation({
    project: 'exafyltd/vitana-v1', mr_iid: 5, head_sha: HEAD, decision: 'ACCEPT', findings,
    reviewer: 'bedrock-plan-sparring', model: 'm', issued_at: issued.toISOString(),
    signer: { keyId: KEY_ID, sign: async (m: Buffer) => cryptoSign('sha256', m, { key: other.privateKey, dsaEncoding: 'der' }) },
  });
  assert.equal(verifyAttestation(att, expect()).ok, false);
});

test('a CHANGES_REQUESTED attestation is never accepted by the merge gate', async () => {
  const att = await accept({ decision: 'CHANGES_REQUESTED' });
  const r = verifyAttestation(att, expect());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reasons.join(' '), /not ACCEPT/);
});

test('a stale attestation is refused', async () => {
  const att = await accept();
  const r = verifyAttestation(att, expect({ now: new Date('2026-11-16T12:00:00Z') }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reasons.join(' '), /too old/);
});

test('an attestation from another project or MR is refused', async () => {
  const att = await accept();
  assert.equal(verifyAttestation(att, expect({ project: 'exafyltd/vitana-platform' })).ok, false);
  assert.equal(verifyAttestation(att, expect({ mr_iid: 4 })).ok, false);
});

test('an attestation under an untrusted key id or reviewer is refused', async () => {
  const att = await accept();
  assert.equal(verifyAttestation(att, expect({ keyId: 'other-key' })).ok, false);
  assert.equal(verifyAttestation(att, expect({ reviewer: 'someone' })).ok, false);
});

test('findings digest is key-order stable and changes when the findings change', () => {
  const a = [{ id: 'F2', x: 1 }, { id: 'F1', x: 2 }];
  const b = [{ x: 1, id: 'F2' }, { x: 2, id: 'F1' }];
  assert.equal(findingsDigest(a), findingsDigest(b));
  assert.notEqual(findingsDigest(a), findingsDigest([{ id: 'F2', x: 9 }]));
});

test('an unsupported algorithm is refused', async () => {
  const att = await accept();
  assert.equal(verifyAttestation({ ...att, alg: 'RSA_PKCS1' as never }, expect()).ok, false);
});
