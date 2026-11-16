/**
 * Merge governance input. This turns a verified attestation into the same
 * shape judgeReviewCommit() returns in scripts/eng/gitlab-land.mjs, so decide()
 * can use it without changes. Only a fresh ACCEPT signed for the exact head
 * passes. The result is always code-coded, so a refusal names its reason.
 */
import { verifyAttestation, type SignedAttestation } from './attestation.ts';

export interface AttestedReviewInput {
  attestation: SignedAttestation;
  project: string;
  mr_iid: number;
  head_sha: string;
  publicKeyPem: string;
  keyId: string;
  reviewer: string;
  findings: unknown[];
  now: Date;
  maxAgeMs: number;
}

export type AttestedReviewVerdict =
  | { ok: true; code: 'review_found'; reason: string }
  | { ok: false; code: 'no_review' | 'review_changes' | 'review_forged' | 'review_stale'; reason: string };

export function judgeAttestedReview(input: AttestedReviewInput): AttestedReviewVerdict {
  if (!input.attestation) return { ok: false, code: 'no_review', reason: 'there is no signed reviewer attestation for this merge request' };
  if (input.attestation.payload.decision === 'CHANGES_REQUESTED') {
    return { ok: false, code: 'review_changes', reason: 'the newest signed review asks for changes' };
  }
  const check = verifyAttestation(input.attestation, {
    project: input.project,
    mr_iid: input.mr_iid,
    head_sha: input.head_sha,
    publicKeyPem: input.publicKeyPem,
    keyId: input.keyId,
    now: input.now,
    maxAgeMs: input.maxAgeMs,
    reviewer: input.reviewer,
    findings: input.findings,
  });
  if (check.ok) return { ok: true, code: 'review_found', reason: 'verified signed ACCEPT for the exact merge head' };
  const stale = check.reasons.some((r) => /too old|future/.test(r));
  return { ok: false, code: stale ? 'review_stale' : 'review_forged', reason: check.reasons.join('; ') };
}
