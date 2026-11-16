// MOCK-ONLY: checks that the gateway's TypeScript signer and the merge bot's JavaScript verifier agree
// on the same attestation. Both run locally with a generated P-256 key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { signAttestation } from './attestation';
// @ts-ignore: plain JavaScript module shared with the merge bot
import * as mjs from '../../../../../scripts/eng/attested-review.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HEAD = '3'.repeat(40);
const NOW = new Date('2026-11-16T10:00:00Z');
const signer = { keyId: 'k1', sign: async (m: Buffer) => cryptoSign('sha256', m, { key: privateKey, dsaEncoding: 'der' }) };

test('a TypeScript-signed ACCEPT verifies under the JavaScript merge verifier, and both reject the same tampering', async () => {
  const findings = [{ id: 'm1', severity: 'minor', file: 'a.ts', line: 2, claim: 'nit', evidence: 'a.ts:2' }];
  const att = await signAttestation({ project: 'vitana/vitana-v1', mr_iid: 5, head_sha: HEAD, decision: 'ACCEPT', findings, reviewer: 'bedrock-plan-sparring', model: 'm', issued_at: NOW.toISOString(), signer } as never);
  const exp = { project: 'vitana/vitana-v1', mr_iid: 5, head_sha: HEAD, publicKeyPem, keyId: 'k1', reviewer: 'bedrock-plan-sparring', findings, now: NOW, maxAgeMs: 3600_000 };
  assert.equal(mjs.verifyAttestation(att, exp).ok, true);
  const tampered = { ...att, payload: { ...att.payload, head_sha: 'b'.repeat(40) } };
  assert.equal(mjs.verifyAttestation(tampered, exp).ok, false);
});

test('the canonical JSON of both implementations is byte-identical', async () => {
  const { canonicalJson: tsCanon } = await import('./attestation');
  const sample = { b: [3, { z: 1, a: 'x' }], a: null, c: 'é' };
  assert.equal(tsCanon(sample), mjs.canonicalJson(sample));
});
