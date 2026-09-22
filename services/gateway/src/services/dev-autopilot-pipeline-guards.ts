/**
 * VTID-04280: pure helpers that keep the Dev Autopilot pipeline from
 * starving itself. Two defects, both measured on the live queue 2026-09-22:
 *
 * 1. Planner starvation. lazyPlanTick() read the top 12 candidates by
 *    impact_score and skipped the ones that already had a plan. Once 12
 *    higher-impact rows were planned-but-blocked (9 operator_onramp rows and
 *    3 dev_autopilot rows held by the PR-flood guard), no planless finding
 *    was ever reached again — and autoApproveTick() only approves findings
 *    that HAVE a plan, so 5 low/medium findings from allowlisted scanners
 *    sat at status='new' indefinitely. `selectPlanlessCandidates` filters
 *    against the plan table in one batch so the window can be wide.
 *
 * 2. A closed PR counted as "stranded" forever. The PR-flood guard blocks a
 *    finding while any prior execution has a pr_url and is not
 *    completed/self_healed/auto_archived. The self-heal bridge closes a
 *    CI-failed PR itself (revertExecutionPR, stage 'ci') and records the row
 *    as `reverted` — so the guard then refused that finding's own self-heal
 *    child ("already has an unmerged PR …/pull/3543") and every later
 *    auto-approve. Only the `ci`-status reconciler ever mapped a closed PR to
 *    auto_archived. `pr_closed_unmerged_at` on the row's metadata is the
 *    fact "this PR is closed and was not merged"; every guard excludes it.
 *    A merged PR is never stamped — it still blocks (the change landed).
 */

export const PR_CLOSED_UNMERGED_KEY = 'pr_closed_unmerged_at';
export const PR_STATE_CHECKED_KEY = 'pr_state_checked_at';

/**
 * PostgREST filter fragment (leading '&') selecting executions whose PR is
 * still a reason to block a new attempt for the same finding.
 */
export const STRANDED_PR_FILTER =
  '&pr_url=not.is.null'
  + '&status=not.in.(completed,self_healed,auto_archived)'
  + `&metadata->>${PR_CLOSED_UNMERGED_KEY}=is.null`;

/**
 * VTID-04293: execution statuses that still own their finding. Mirrors the
 * autoApproveTick baseline pass. `awaiting_approval` is deliberately here
 * even though the partial unique index
 * `dev_autopilot_executions_finding_inflight_uniq` does not cover it: a held
 * run waits for a human, and without this the impact pass re-approved the
 * same finding every time the prior run reached the hold (staging,
 * 2026-09-22: finding b560c306 approved at 21:03, 21:09 and 21:24).
 */
export const INFLIGHT_EXECUTION_STATUSES = [
  'cooling', 'running', 'awaiting_approval', 'ci', 'merging', 'deploying', 'verifying',
] as const;

/** PostgREST filter fragment (leading '&') for an in-flight execution. */
export const INFLIGHT_EXECUTION_FILTER = `&status=in.(${INFLIGHT_EXECUTION_STATUSES.join(',')})`;

/** Keep candidate order; drop ids that already have a plan. */
export function selectPlanlessCandidates<T extends { id: string }>(
  candidates: T[],
  plannedFindingIds: Iterable<string>,
): T[] {
  const planned = new Set(plannedFindingIds);
  return candidates.filter((c) => !planned.has(c.id));
}

/** Keep candidate order; keep only ids that already have a plan. */
export function selectPlannedCandidates<T extends { id: string }>(
  candidates: T[],
  plannedFindingIds: Iterable<string>,
): T[] {
  const planned = new Set(plannedFindingIds);
  return candidates.filter((c) => planned.has(c.id));
}

/**
 * True when revertExecutionPR() really closed the PR (not a dry-run stub and
 * not a merged-PR revert). `#closed` is the suffix its CI-stage path returns
 * after a successful PATCH state=closed; the dry-run stub is `#closed-dry-run`.
 */
export function isRealCiClose(stage: string, revertPrUrl: string | null | undefined): boolean {
  return stage === 'ci' && typeof revertPrUrl === 'string' && revertPrUrl.endsWith('#closed');
}

export type PrLifecycle = 'open' | 'merged' | 'closed_unmerged' | 'unknown';

export function classifyPrState(
  pr: { state?: string | null; merged?: boolean | null } | null | undefined,
): PrLifecycle {
  if (!pr || typeof pr.state !== 'string') return 'unknown';
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed_unmerged';
  if (pr.state === 'open') return 'open';
  return 'unknown';
}

/** PR number from the row, else parsed from its pr_url (some rows carry only the URL). */
export function prNumberOf(row: { pr_number?: number | null; pr_url?: string | null }): number | null {
  if (typeof row.pr_number === 'number' && row.pr_number > 0) return row.pr_number;
  const m = typeof row.pr_url === 'string' ? row.pr_url.match(/\/pull\/(\d+)(?:[#/?]|$)/) : null;
  return m ? Number(m[1]) : null;
}

/** Chunk ids for PostgREST in.(...) lists so a URL never grows unbounded. */
export function chunkIds(ids: string[], size = 50): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
