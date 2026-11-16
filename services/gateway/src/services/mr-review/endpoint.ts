/**
 * Gateway review endpoint: POST /api/v1/mr-review. The handler is a pure
 * function over injected dependencies, so the Express route only adapts the
 * request. It refuses an unauthenticated caller, a malformed body, a head that
 * is no longer current, and any model output that is not a valid verdict.
 * Every verdict is signed, ACCEPT and CHANGES_REQUESTED alike; the merge gate
 * only ever acts on a verified ACCEPT.
 */
import { buildReviewContext, type GitLabMrReader } from './review-context';
import { reviewMrWithBedrock, type RunPass } from './bedrock-reviewer';
import { signAttestation, type AttestationSigner, type SignedAttestation } from './attestation';

export interface ReviewRequestBody {
  mr_iid: number;
  expected_head_sha: string;
}

export interface ReviewEndpointDeps {
  authorize(authorization: string | undefined): boolean;
  readerFor(project: string): GitLabMrReader;
  runPass: RunPass;
  signer: AttestationSigner;
  project: string;
  reviewer: string;
  model: string;
  now(): Date;
}

export interface ReviewResponse {
  status: number;
  body: Record<string, unknown>;
}

export async function handleReviewRequest(deps: ReviewEndpointDeps, input: { authorization?: string; body: unknown }): Promise<ReviewResponse> {
  if (!deps.authorize(input.authorization)) return { status: 401, body: { error: 'unauthorized' } };
  const b = input.body as Partial<ReviewRequestBody> | null;
  if (!b || typeof b !== 'object' || !Number.isInteger(b.mr_iid) || (b.mr_iid as number) < 1 || typeof b.expected_head_sha !== 'string') {
    return { status: 400, body: { error: 'body needs mr_iid (positive integer) and expected_head_sha (40-hex)' } };
  }
  const reader = deps.readerFor(deps.project);
  const ctx = await buildReviewContext({ reader, mr_iid: b.mr_iid as number, expectedHeadSha: b.expected_head_sha });
  if (!ctx.ok) return { status: 409, body: { error: 'review context refused', reason: ctx.reason } };

  const review = await reviewMrWithBedrock({ context: ctx.context, runPass: deps.runPass });
  if (!review.ok) return { status: 502, body: { error: review.reason, errors: review.errors } };

  // Re-check the head after the model call: the head may have moved while it ran.
  const after = await reader.getMr(b.mr_iid as number);
  if (after.sha !== b.expected_head_sha) return { status: 409, body: { error: 'head moved during review', reason: `now ${after.sha}` } };

  const attestation: SignedAttestation = await signAttestation({
    project: deps.project,
    mr_iid: b.mr_iid as number,
    head_sha: b.expected_head_sha,
    decision: review.verdict.decision,
    findings: review.verdict.findings,
    reviewer: deps.reviewer,
    model: deps.model,
    issued_at: deps.now().toISOString(),
    signer: deps.signer,
  });
  return { status: 200, body: { verdict: review.verdict, summary: review.summary, attestation } };
}
