/**
 * GitLab review job logic. The job asks the gateway for a review of one exact
 * head, then verifies the signed attestation itself with the pinned public key
 * before it reports anything. A response that cannot be verified is a failure.
 * The job never produces an accept of its own.
 */
import { verifyAttestation, type SignedAttestation } from './attestation.ts';

export interface JobInput {
  mr_iid: number;
  expected_head_sha: string;
  project: string;
  reviewer: string;
  publicKeyPem: string;
  keyId: string;
  maxAgeMs: number;
  now(): Date;
  requestReview(body: { mr_iid: number; expected_head_sha: string }): Promise<{ status: number; json: Record<string, unknown> }>;
}

export type JobResult =
  | { ok: true; decision: 'ACCEPT'; attestation: SignedAttestation }
  | { ok: false; decision: 'CHANGES_REQUESTED'; findings: unknown[]; attestation: SignedAttestation }
  | { ok: false; decision: 'FAILED'; reasons: string[] };

export async function runReviewJob(input: JobInput): Promise<JobResult> {
  const res = await input.requestReview({ mr_iid: input.mr_iid, expected_head_sha: input.expected_head_sha });
  if (res.status !== 200) return { ok: false, decision: 'FAILED', reasons: [`gateway answered ${res.status}`] };
  const att = res.json.attestation as SignedAttestation | undefined;
  const findings = (res.json.verdict as { findings?: unknown[] } | undefined)?.findings ?? [];
  if (!att) return { ok: false, decision: 'FAILED', reasons: ['response has no attestation'] };

  const common = {
    project: input.project,
    mr_iid: input.mr_iid,
    head_sha: input.expected_head_sha,
    publicKeyPem: input.publicKeyPem,
    keyId: input.keyId,
    now: input.now(),
    maxAgeMs: input.maxAgeMs,
    reviewer: input.reviewer,
    findings,
  };
  if (att.payload.decision === 'CHANGES_REQUESTED') {
    // A genuine, fresh CHANGES_REQUESTED is reported with its findings, not as a merge.
    const check = verifyAttestation(att, { ...common, expectDecision: 'CHANGES_REQUESTED' });
    if (check.ok) return { ok: false, decision: 'CHANGES_REQUESTED', findings, attestation: att };
    return { ok: false, decision: 'FAILED', reasons: check.reasons };
  }
  const check = verifyAttestation(att, common);
  if (!check.ok) return { ok: false, decision: 'FAILED', reasons: check.reasons };
  return { ok: true, decision: 'ACCEPT', attestation: att };
}
