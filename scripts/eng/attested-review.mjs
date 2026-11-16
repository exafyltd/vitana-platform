// Bedrock reviewer attestations, verified on the merge side. Plain JavaScript
// so the Node 20 land bot can import it. Mirrors
// services/gateway/src/services/mr-review/attestation.ts and merge-gate.ts;
// test/attested-review.cross.test.ts checks that both agree on the same input.
import { createHash, verify as cryptoVerify } from 'node:crypto';

export const ATTESTATION_MARKER = '<!-- bedrock-attestation:v1';
const SHA = /^[0-9a-f]{40}$/;

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function findingsDigest(findings) {
  return createHash('sha256').update(canonicalJson(findings)).digest('hex');
}

/** Reads the newest attestation note. A note that does not parse is ignored, never trusted. */
export function attestationFromNotes(notes) {
  const candidates = (Array.isArray(notes) ? notes : [])
    .filter((n) => typeof n.body === 'string' && n.body.includes(ATTESTATION_MARKER) && !n.system)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const n of candidates) {
    const m = /<!-- bedrock-attestation:v1 ([A-Za-z0-9+/=]+) -->/.exec(n.body);
    if (!m) continue;
    try {
      const att = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      if (att && typeof att === 'object' && att.payload) return att;
    } catch {
      /* ignore an unparseable note */
    }
  }
  return null;
}

export function verifyAttestation(att, exp) {
  const reasons = [];
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
  if (p.findings_sha256 !== findingsDigest(exp.findings ?? [])) reasons.push('findings digest does not match the attested findings');
  const issued = Date.parse(p.issued_at);
  const now = exp.now.getTime();
  if (!Number.isFinite(issued)) reasons.push('issued_at is not a timestamp');
  else if (now - issued > exp.maxAgeMs) reasons.push('attestation is too old');
  else if (issued - now > 60_000) reasons.push('attestation is dated in the future');
  let sigOk = false;
  try {
    sigOk = cryptoVerify('sha256', Buffer.from(canonicalJson(p), 'utf8'), { key: exp.publicKeyPem, dsaEncoding: 'der' }, Buffer.from(att.signature, 'base64'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) reasons.push('signature does not verify against the trusted reviewer key');
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Same shape as judgeReviewCommit() so decide() takes it unchanged.
 * CHANGES_REQUESTED is never an accept. A new head makes a prior accept stale.
 */
export function judgeAttestedReview(input) {
  if (!SHA.test(input.head_sha || '')) return { ok: false, code: 'no_review', reason: 'the merge head is not a full SHA' };
  if (!input.attestation) return { ok: false, code: 'no_review', reason: 'there is no signed reviewer attestation for this merge request' };
  if (input.attestation.payload?.decision === 'CHANGES_REQUESTED') return { ok: false, code: 'review_changes', reason: 'the newest signed review asks for changes' };
  const check = verifyAttestation(input.attestation, input);
  if (check.ok) return { ok: true, code: 'review_found', reason: 'verified signed ACCEPT for the exact merge head' };
  const reasons = check.reasons.join('; ');
  if (/merge head|too old|future/.test(reasons)) return { ok: false, code: 'review_stale', reason: reasons };
  return { ok: false, code: 'review_forged', reason: reasons };
}
