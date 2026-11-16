/**
 * Review cycle with automatic remediation. On CHANGES_REQUESTED the
 * implementation agent receives the exact findings and the head they were
 * raised against, and it returns a new head. The cycle re-reviews that head.
 * It stops on a verified ACCEPT, escalates when the rounds run out or when
 * remediation fails, and never treats a missing review as an accept.
 */
export type CycleReview =
  | { kind: 'accept'; head: string; attestation: unknown }
  | { kind: 'changes'; head: string; findings: unknown[]; attestation: unknown }
  | { kind: 'failed'; reasons: string[] };

export type RemediationResult = { ok: true; newHead: string } | { ok: false; error: string };

export const MAX_REMEDIATION_ROUNDS = 3;

export interface CycleRound {
  round: number;
  head: string;
  outcome: CycleReview['kind'];
  correlation_id: string;
}

export type CycleOutcome =
  | { status: 'accepted'; head: string; rounds: CycleRound[]; attestation: unknown }
  | { status: 'escalated'; reason: 'max_rounds' | 'remediation_failed' | 'review_failed'; head: string; rounds: CycleRound[]; detail: string[] };

export async function runReviewCycle(input: {
  startHead: string;
  maxRounds: number;
  correlationId: string;
  review(head: string, correlationId: string): Promise<CycleReview>;
  remediate(head: string, findings: unknown[], correlationId: string): Promise<RemediationResult>;
}): Promise<CycleOutcome> {
  const rounds: CycleRound[] = [];
  const limit = Math.min(input.maxRounds, MAX_REMEDIATION_ROUNDS);
  let head = input.startHead;
  for (let round = 1; round <= limit; round++) {
    const correlation_id = `${input.correlationId}/r${round}`;
    const r = await input.review(head, correlation_id);
    rounds.push({ round, head, outcome: r.kind, correlation_id });
    if (r.kind === 'accept') return { status: 'accepted', head, rounds, attestation: r.attestation };
    if (r.kind === 'failed') return { status: 'escalated', reason: 'review_failed', head, rounds, detail: r.reasons };
    const fixed = await input.remediate(head, r.findings, correlation_id);
    if (!fixed.ok) return { status: 'escalated', reason: 'remediation_failed', head, rounds, detail: [fixed.error] };
    head = fixed.newHead;
  }
  return { status: 'escalated', reason: 'max_rounds', head, rounds, detail: [`no ACCEPT within ${limit} rounds`] };
}
