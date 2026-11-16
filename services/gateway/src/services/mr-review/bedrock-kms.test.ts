// MOCK-ONLY: the Bedrock partner pass and the AWS KMS client are stubs here.
// The P-256 key is generated locally. No live AWS call is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { reviewMrWithBedrock, partnerToVerdict, parseEvidenceRef, buildMrReviewPrompt } from './bedrock-reviewer';
import { KmsEcdsaSigner } from './kms-signer';
import type { ReviewContext } from './review-context';

const HEAD = '1'.repeat(40);
const ctx: ReviewContext = { mr_iid: 5, head_sha: HEAD, files: [{ old_path: 'a.ts', new_path: 'a.ts', diff: '+x\n' }], diff_bytes: 3 };

test('partner findings map to a verdict: blocker → CHANGES_REQUESTED', async () => {
  const r = await reviewMrWithBedrock({
    project: 'vitana/vitana-v1',
    context: ctx,
    runPass: async () => ({ ok: true, review: { summary: 's', findings: [{ id: 'R1-F1', severity: 'blocker', claim: 'bad', evidence: 'a.ts:3', suggestion: 'fix' }] } }),
  });
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.verdict.decision, 'CHANGES_REQUESTED'); assert.equal(r.verdict.findings[0].line, 3); }
});

test('no findings maps to ACCEPT; minor-only maps to ACCEPT', async () => {
  const none = await reviewMrWithBedrock({ project: 'vitana/vitana-v1', context: ctx, runPass: async () => ({ ok: true, review: { summary: 's', findings: [] } }) });
  assert.equal(none.ok && none.verdict.decision, 'ACCEPT');
  const minor = await reviewMrWithBedrock({ project: 'vitana/vitana-v1', context: ctx, runPass: async () => ({ ok: true, review: { summary: 's', findings: [{ id: 'm', severity: 'minor', claim: 'nit', evidence: { path: 'a.ts', line: 1 }, suggestion: '' }] } }) });
  assert.equal(minor.ok && minor.verdict.decision, 'ACCEPT');
});

test('a finding with no file and line in its evidence is refused, not guessed', async () => {
  const r = await reviewMrWithBedrock({ project: 'vitana/vitana-v1', context: ctx, runPass: async () => ({ ok: true, review: { summary: 's', findings: [{ id: 'x', severity: 'blocker', claim: 'c', evidence: 'looks wrong', suggestion: '' }] } }) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'invalid_verdict');
});

test('a failed partner pass is reported as pass_failed', async () => {
  const r = await reviewMrWithBedrock({ project: 'vitana/vitana-v1', context: ctx, runPass: async () => ({ ok: false, reason: 'model_unavailable', error: 'all tiers failed' }) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'pass_failed');
});

test('evidence parsing accepts {path,line} and "path:line" only', () => {
  assert.equal(parseEvidenceRef({ path: 'a.ts', line: 2 })?.line, 2);
  assert.equal(parseEvidenceRef('src/x.ts:14')?.file, 'src/x.ts');
  assert.equal(parseEvidenceRef('nowhere'), null);
  assert.equal(parseEvidenceRef({ path: 'a.ts' }), null);
});

test('the prompt names the exact head and marks the diff as untrusted', () => {
  const p = buildMrReviewPrompt(ctx);
  assert.match(p, new RegExp(HEAD));
  assert.match(p, /untrusted data/);
});

test('partnerToVerdict drops nothing silently: a bad head is refused', () => {
  const r = partnerToVerdict({ summary: '', findings: [] }, 'not-a-sha');
  assert.equal(r.ok, false);
});

// KMS adapter, mocked client, real P-256 key pair.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

function mockKms(over: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    send: async (cmd: { name: string; input: Record<string, unknown> }) => {
      calls.push(cmd);
      if (cmd.name === 'SignCommand') {
        const sig = cryptoSign('sha256', cmd.input.Message as Buffer, { key: privateKey, dsaEncoding: 'der' });
        return { Signature: new Uint8Array(sig), ...over };
      }
      return { KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', PublicKey: new Uint8Array(spkiDer), ...over };
    },
  };
}

test('KMS signer sends an ECDSA_SHA_256 RAW sign request and returns the DER signature', async () => {
  const kms = mockKms();
  const signer = new KmsEcdsaSigner({ kms, keyId: 'alias/reviewer' });
  const sig = await signer.sign(Buffer.from('payload'));
  assert.ok(sig.length > 60);
  assert.deepEqual(kms.calls[0].input, { KeyId: 'alias/reviewer', Message: Buffer.from('payload'), MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' });
});

test('KMS public key is exported as PEM only for an ECC_NIST_P256 SIGN_VERIFY key', async () => {
  const signer = new KmsEcdsaSigner({ kms: mockKms(), keyId: 'k' });
  assert.match(await signer.publicKeyPem(), /BEGIN PUBLIC KEY/);
  const wrongSpec = new KmsEcdsaSigner({ kms: mockKms({ KeySpec: 'RSA_2048' }), keyId: 'k' });
  await assert.rejects(() => wrongSpec.publicKeyPem(), /not ECC_NIST_P256/);
  const wrongUse = new KmsEcdsaSigner({ kms: mockKms({ KeyUsage: 'ENCRYPT_DECRYPT' }), keyId: 'k' });
  await assert.rejects(() => wrongUse.publicKeyPem(), /not SIGN_VERIFY/);
});

test('KMS returning no signature is an error, not an empty attestation', async () => {
  const signer = new KmsEcdsaSigner({ kms: { send: async () => ({}) }, keyId: 'k' });
  await assert.rejects(() => signer.sign(Buffer.from('x')), /no signature/);
});
