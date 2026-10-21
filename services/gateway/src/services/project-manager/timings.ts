/**
 * VTID-05274 — per-plan timings (plan kiro-autonomy-fallback §4.6, §8b).
 *
 * Pure: the caller gathers the timestamps (observer, OASIS, GitHub); this turns
 * them into `docs/validation/<plan VTID>/timings.json` and the Gate 2 quote.
 * Every duration is `null` when a source is missing (never 0), and each missing
 * source is named in `sources_unavailable`.
 */
import type { PlanLaneTimings, PlanTimings } from './types';

export interface PlanTimingsLaneInput {
  lane: string;
  vtid: string;
  claimed_at: string | null;
  pr_opened_at: string | null;
  accepted_at: string | null;
  merged_at: string | null;
  staging_verified_at: string | null;
  review_rounds: number | null;
  ci_fix_attempts: number | null;
}

export interface PlanTimingsInput {
  plan_slug: string;
  /** The plan VTID: the VTID bound to the sparring session. */
  vtid: string;
  vtids: string[];
  generated_by: string;
  plan_pr_opened_at: string | null;
  converged_at: string | null;
  policy_approved_at: string | null;
  /** When the last lane VTID was allocated. */
  vtids_allocated_at: string | null;
  plan_merged_at: string | null;
  gate2_sent_at: string | null;
  lanes: PlanTimingsLaneInput[];
  merge_conflict_count: number | null;
  staging_verify_failure_count: number | null;
  sources_unavailable?: string[];
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? null : n;
}

/** b − a in ms when both exist and b ≥ a; else null. */
function between(a: string | null, b: string | null): number | null {
  const x = ms(a);
  const y = ms(b);
  if (x == null || y == null || y < x) return null;
  return y - x;
}

function latest(values: Array<string | null>): string | null {
  let best: string | null = null;
  for (const v of values) {
    const n = ms(v);
    if (n == null) continue;
    if (best == null || n > (ms(best) as number)) best = v;
  }
  return best;
}

const PLAN_FIELDS = ['plan_pr_opened_at', 'converged_at', 'policy_approved_at', 'vtids_allocated_at', 'plan_merged_at', 'gate2_sent_at'] as const;
const LANE_FIELDS = ['claimed_at', 'pr_opened_at', 'accepted_at', 'merged_at', 'staging_verified_at'] as const;

export function planTimings(input: PlanTimingsInput, generatedAt: string): PlanTimings {
  const missing = new Set<string>(input.sources_unavailable ?? []);
  for (const f of PLAN_FIELDS) if (!input[f]) missing.add(f);
  if (input.merge_conflict_count == null) missing.add('merge_conflict_count');
  if (input.staging_verify_failure_count == null) missing.add('staging_verify_failure_count');

  const lanes: PlanLaneTimings[] = input.lanes.map((l) => {
    for (const f of LANE_FIELDS) if (!l[f]) missing.add(`lanes.${l.lane}.${f}`);
    if (l.review_rounds == null) missing.add(`lanes.${l.lane}.review_rounds`);
    if (l.ci_fix_attempts == null) missing.add(`lanes.${l.lane}.ci_fix_attempts`);
    return {
      lane: l.lane,
      vtid: l.vtid,
      claimed_at: l.claimed_at,
      pr_opened_at: l.pr_opened_at,
      accepted_at: l.accepted_at,
      merged_at: l.merged_at,
      staging_verified_at: l.staging_verified_at,
      build_ms: between(l.claimed_at, l.pr_opened_at),
      review_ms: between(l.pr_opened_at, l.accepted_at),
      merge_ms: between(l.accepted_at, l.merged_at),
      review_rounds: l.review_rounds ?? 0,
      ci_fix_attempts: l.ci_fix_attempts ?? 0,
    };
  });

  const lastMerge = latest(input.lanes.map((l) => l.merged_at));
  const lastVerified = latest(input.lanes.map((l) => l.staging_verified_at));

  return {
    schema: 'vitana.plan-timings/v1',
    plan_slug: input.plan_slug,
    vtid: input.vtid,
    vtids: [...input.vtids],
    generated_at: generatedAt,
    generated_by: input.generated_by,
    plan_pr_opened_at: input.plan_pr_opened_at,
    converged_at: input.converged_at,
    policy_approved_at: input.policy_approved_at,
    vtids_allocated_at: input.vtids_allocated_at,
    plan_merged_at: input.plan_merged_at,
    gate2_sent_at: input.gate2_sent_at,
    convergence_ms: between(input.plan_pr_opened_at, input.converged_at),
    vtid_ms: between(input.policy_approved_at, input.vtids_allocated_at),
    plan_merge_ms: between(input.policy_approved_at, input.plan_merged_at),
    lanes,
    staging_verify_ms: between(lastMerge, lastVerified),
    approved_to_verified_ms: between(input.policy_approved_at, lastVerified),
    merge_conflict_count: input.merge_conflict_count ?? 0,
    staging_verify_failure_count: input.staging_verify_failure_count ?? 0,
    sources_unavailable: [...missing].sort(),
  };
}
