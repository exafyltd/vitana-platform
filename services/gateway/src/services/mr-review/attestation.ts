/**
 * Signed reviewer attestation for one exact MR head. The payload is canonical
 * JSON (sorted keys), signed with ECDSA P-256 / SHA-256 — the algorithm AWS KMS
 * uses for an ECC_NIST_P256 key with ECDSA_SHA_256 — and verified against the
 * key's public half. Verification refuses anything that is not an ACCEPT for
 * the exact head, project and MR the merge gate asked about.
 */
import { createHash, verify as cryptoVerify } from 'node:crypto';

export interface AttestationPayload {
  project: string;
  mr_iid: number;
  head_sha: string;
  decision: 'ACCEPT' | 'CHANGES_REQUESTED';
  findings_sha256: string;
  reviewer: string;
  model: string;
  issued_at: string;
  key_id: string;
}

export interface SignedAttestation {
  payload: AttestationPayload;
  signature: string; // base64, DER-encoded ECDSA signature over canonicalJson(payload)
  alg: 'ECDSA_SHA_256';
}

/** Signs raw bytes and returns a DER ECDSA signature (the KMS Sign output). */
export interface AttestationSigner {
  readonly keyId: string;
  sign(message: Buffer): Promise<Buffer>;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function findingsDigest(findings: unknown): string {
  return createHash('sha256').update(canonicalJson(findings)).digest('hex');
}

export async function signAttestation(input: {
  project: string;
  mr_iid: number;
  head_sha: string;
  decision: 'ACCEPT' | 'CHANGES_REQUESTED';
  findings: unknown;
  reviewer: string;
  model: string;
  issued_at: string;
  signer: AttestationSigner;
}): Promise<SignedAttestation> {
  const payload: AttestationPayload = {
    project: input.project,
    mr_iid: input.mr_iid,
    head_sha: input.head_sha,
    decision: input.decision,
    findings_sha256: findingsDigest(input.findings),
    reviewer: input.reviewer,
    model: input.model,
    issued_at: input.issued_at,
    key_id: input.signer.keyId,
  };
  const sig = await input.signer.sign(Buffer.from(canonicalJson(payload), 'utf8'));
  return { payload, signature: sig.toString('base64'), alg: 'ECDSA_SHA_256' };
}

export interface VerifyExpectation {
  project: string;
  mr_iid: number;
  head_sha: string;
  publicKeyPem: string;
  keyId: string;
  now: Date;
  maxAgeMs: number;
  reviewer: string;
  findings: unknown;
  /** Default ACCEPT (the merge gate). The review job asks for CHANGES_REQUESTED to read its findings. */
  expectDecision?: 'ACCEPT' | 'CHANGES_REQUESTED';
}

export type AttestationCheck = { ok: true } | { ok: false; reasons: string[] };

/** The merge gate calls this. Only a valid, fresh ACCEPT for the exact head passes. */
export function verifyAttestation(att: SignedAttestation, exp: VerifyExpectation): AttestationCheck {
  const reasons: string[] = [];
  const p = att?.payload;
  if (!p || typeof p !== 'object') return { ok: false, reasons: ['attestation has no payload'] };
  if (att.alg !== 'ECDSA_SHA_256') reasons.push(`unsupported alg ${String(att.alg)}`);
  if (p.project !== exp.project) reasons.push(`project ${p.project} is not ${exp.project}`);
  if (p.mr_iid !== exp.mr_iid) reasons.push(`MR !${p.mr_iid} is not !${exp.mr_iid}`);
  if (p.head_sha !== exp.head_sha) reasons.push(`attested head ${p.head_sha} is not the merge head ${exp.head_sha}`);
  if (p.key_id !== exp.keyId) reasons.push('attested key id does not match the trusted reviewer key');
  if (p.reviewer !== exp.reviewer) reasons.push(`reviewer ${p.reviewer} is not the trusted reviewer`);
  const want = exp.expectDecision ?? 'ACCEPT';
  if (p.decision !== want) reasons.push(`decision is ${p.decision}, not ${want}`);
  if (p.findings_sha256 !== findingsDigest(exp.findings)) reasons.push('findings digest does not match the attested findings');
  const issued = Date.parse(p.issued_at);
  if (!Number.isFinite(issued)) reasons.push('issued_at is not a timestamp');
  else if (exp.now.getTime() - issued > exp.maxAgeMs) reasons.push('attestation is too old');
  else if (issued - exp.now.getTime() > 60_000) reasons.push('attestation is dated in the future');

  let sigOk = false;
  try {
    sigOk = cryptoVerify('sha256', Buffer.from(canonicalJson(p), 'utf8'), { key: exp.publicKeyPem, dsaEncoding: 'der' }, Buffer.from(att.signature, 'base64'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) reasons.push('signature does not verify against the trusted reviewer key');
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
