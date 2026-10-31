/**
 * VTID-05217 — Project Manager: the ACT layer (plan §6.3 "Act (live only)").
 *
 * P3 produced the decisions (observe + decide, pure). P4 ACTS on them, and ONLY
 * when `PM_MODE=live`. In `off` and `dry_run` the act layer performs NO action
 * at all — it is the decide step's reporting that runs in dry_run, never this.
 *
 * For each decision P3 produced:
 *   - MERGE:    call the in-process safe-merge function (routes/cicd.ts →
 *               `safeMerge`). NEVER a direct GitHub merge API call, NEVER a
 *               workflow dispatch, NEVER a deploy. After a merge, set the lane
 *               and plan `done`.
 *   - REASSIGN: write the lane-file state change (seat / next_actor) per P3.
 *   - PARK:     write the lane-file state change (and release the claim when
 *               P3 says so) per P3.
 *   - GATE-2:   POST the Operator Chat message using the EXISTING run-view
 *               question, with the evidence AND every commit between production
 *               and the verified commit. Posting the message ONLY — never a
 *               deploy dispatch.
 * VTID-05274 (plan kiro-autonomy-fallback §4.5, §5 C3/C4) adds:
 *   - VERIFY (W1):        lane `in-review → verified` on the lane PR branch;
 *   - UPDATE_BRANCH:      `PUT /pulls/{n}/update-branch` with the expected head;
 *   - MERGE_PLAN / MERGE_BOOKKEEPING: through the same safe-merge function;
 *   - LEDGER:             the lane VTID's row → in_progress / approved.
 *
 * HARD CONSTRAINTS IN CODE (plan §6.3 "Never"). The act layer must NEVER:
 *   - deploy, dispatch a workflow, allocate a VTID, or edit application code;
 *   - merge a PR that the governance guard (governance.ts) refuses: a protected
 *     gate file without a legacy `claude` review, or a governance path without
 *     the reviewer agent's accept on the current head (defence in depth — P3's
 *     decide already excludes it).
 *
 * A Postgres `pm_lease` is taken per tick (lease.ts) so several ECS tasks never
 * act twice. When the lease is not taken (table absent, held by another task,
 * any error) the tick safely NO-OPS — it never crashes, and never acts without
 * a lease.
 *
 * This layer is deterministic and side-effects only through its injected seams,
 * which is what makes the integration tests (fake GitHub + in-memory DB) able to
 * assert that deploy / dispatch / allocate are NEVER invoked.
 */

import { SafeMergeRequest } from '../../types/cicd';
import type { SafeMergeOutcome } from '../../routes/cicd';
import { pmMode } from './config';
import { LeaseManager, defaultLeaseManager, recordLease } from './lease';
import { latestReview, repoFromPrUrl } from './decide';
import { governanceMergeAllowed as governanceCheck } from './governance';
import {
  ActResult,
  Gate2Decision,
  Gate2Evidence,
  GATE2_QUESTION,
  LedgerDecision,
  MergeBookkeepingDecision,
  MergeDecision,
  MergePlanDecision,
  ObservedLane,
  ObservedState,
  ParkDecision,
  PmDecision,
  ReassignDecision,
  ReviewEntry,
  UpdateBranchDecision,
  VerifyDecision,
} from './types';

export { laneTouchesGovernance } from './governance';

/** The repo the PM merges in (both Vitana repos go through safe-merge's own allow-list). */
export type PmRepo = string;

/**
 * The in-process safe-merge seam. In live it is `safeMerge` from routes/cicd.ts;
 * in tests it is a fake over a fake GitHub client. It is the ONLY path to a
 * merge — the act layer never calls a GitHub merge API directly.
 */
export interface SafeMergeFn {
  (input: SafeMergeRequest): Promise<SafeMergeOutcome>;
}

/** A lane-file state change the PM commits (reassign / park / done / verified). */
export interface LaneFileChange {
  slug: string;
  lane: string;
  /** New lane `state`, if changed. */
  state?: string;
  /** New `next_actor`, if changed. */
  next_actor?: string;
  /** New `seat`, if changed (reassign). */
  seat?: string;
  /** True to release the claim ref (stale-claim park). */
  release_claim?: boolean;
  /** A one-line log entry describing why. */
  log: string;
  /** VTID-05274: the lane's repository (default the platform repo). */
  repo?: string;
  /**
   * VTID-05274 (plan §4.5): `pr_branch` = W1 on the lane PR branch before merge
   * (needs `pr_url`); default = W2 on the bookkeeping PR `pm-agent/<slug>`.
   */
  target?: 'pr_branch' | 'bookkeeping';
  pr_url?: string;
}

/**
 * Writes lane-file state changes to GitHub, committed as `pm-agent` with the
 * `Collab-Session: pm-agent` and `Collab-Lane` trailers (plan §6.3). Injected so
 * tests use an in-memory recorder.
 */
export interface LaneFileWriter {
  /** VTID-05414: `'noop'` when the branch already has the change (nothing committed). */
  write(change: LaneFileChange): Promise<'written' | 'noop'>;
}

/**
 * Posts the Gate-2 message to the Operator Chat. Posting ONLY — it never
 * dispatches a deploy. Injected so tests assert the message content and that no
 * deploy follows.
 */
export interface Gate2Poster {
  post(message: Gate2Message): Promise<void>;
}

export interface Gate2Message {
  slug: string;
  vtids: string[];
  /** The existing run-view question wording. */
  question: string;
  evidence: Gate2Evidence;
}

/** Resolves the production→verified commit range for a plan's Gate-2 message. */
export interface Gate2EvidenceResolver {
  resolve(decision: Gate2Decision, state: ObservedState): Promise<Gate2Evidence>;
}

/** VTID-05274: brings a PR up to date with its base (`PUT /pulls/{n}/update-branch`, expected head). */
export interface UpdateBranchFn {
  (repo: string, prNumber: number, expectedHeadSha: string): Promise<{ ok: boolean; status: number; detail?: string }>;
}

/** VTID-05274: the governed ledger write (status / spec_status of one VTID row). */
export interface LedgerWriter {
  patch(vtid: string, set: LedgerDecision['set']): Promise<{ ok: boolean; detail?: string }>;
}

export interface ActDeps {
  safeMerge: SafeMergeFn;
  laneWriter: LaneFileWriter;
  gate2Poster: Gate2Poster;
  gate2Evidence: Gate2EvidenceResolver;
  lease?: LeaseManager;
  /** The repo the lane PRs live in; defaults to the platform repo. */
  repo?: PmRepo;
  /** Lease holder id for this task/tick (ECS task arn or similar). */
  holder?: string;
  /** VTID-05274: update-branch seam (absent → `update_refused`). */
  updateBranch?: UpdateBranchFn;
  /** VTID-05274: ledger writer (absent → `ledger_failed`). */
  ledgerWriter?: LedgerWriter;
}

/** The result of acting on a whole tick's decisions. */
export interface ActTickResult {
  mode: ReturnType<typeof pmMode>;
  /** True when the lease was held and acting proceeded. */
  acted: boolean;
  /** Why the tick did not act, when `acted` is false. */
  skipped_reason?: 'not_live' | 'no_lease';
  results: ActResult[];
}

const DEFAULT_REPO: PmRepo = 'exafyltd/vitana-platform';

/**
 * The governance final guard as a boolean (kept for callers of the P4 API).
 * With no review given it applies the legacy rule (reviewer_seat `claude`).
 */
export function governanceMergeAllowed(lane: ObservedLane, review: ReviewEntry | null = null): boolean {
  return governanceCheck(lane, lane.pr, review).ok;
}

function findLane(state: ObservedState, slug: string, lane: string): ObservedLane | undefined {
  return state.lanes.find((l) => l.slug === slug && l.lane === lane);
}

type Bound = Required<Pick<ActDeps, 'safeMerge' | 'laneWriter' | 'gate2Poster' | 'gate2Evidence'>> &
  Pick<ActDeps, 'updateBranch' | 'ledgerWriter'> & { repo: PmRepo };

/**
 * Act on ONE decision. Pure control flow over the injected seams. Returns the
 * typed `ActResult`. Never deploys, never dispatches a workflow, never allocates
 * a VTID — those capabilities are not injected and not reachable from here.
 */
async function actOne(decision: PmDecision, state: ObservedState, deps: Bound): Promise<ActResult> {
  switch (decision.kind) {
    case 'merge':
      return actMerge(decision, state, deps);
    case 'reassign':
      return actReassign(decision, state, deps);
    case 'park':
      return actPark(decision, state, deps);
    case 'gate2':
      return actGate2(decision, state, deps);
    case 'verify':
      return actVerify(decision, state, deps);
    case 'update_branch':
      return actUpdateBranch(decision, deps);
    case 'merge_plan':
    case 'merge_bookkeeping':
      return actMergeSpecPr(decision, deps);
    case 'ledger':
      return actLedger(decision, deps);
  }
}

async function actMerge(decision: MergeDecision, state: ObservedState, deps: Bound): Promise<ActResult> {
  const lane = findLane(state, decision.slug, decision.lane);

  // Final governance guard (governance.ts): protected gate files need a legacy
  // claude review; governance paths need the agent accept on the current head.
  if (lane) {
    const g = governanceCheck(lane, lane.pr, latestReview(lane));
    if (!g.ok) {
      return {
        decision,
        status: 'governance_blocked',
        detail: `${g.reason}: lane reviewer_seat ${lane.reviewer_seat}`,
      };
    }
  }

  // The PR number must be parseable from the decision's PR url (…/pull/<n>).
  const prNumber = prNumberFromUrl(decision.pr_url);
  if (prNumber == null) {
    return { decision, status: 'merge_refused', detail: 'could not parse PR number from url' };
  }
  const repo = repoFromPrUrl(decision.pr_url) ?? deps.repo;

  const outcome = await deps.safeMerge({
    vtid: decision.vtid,
    repo,
    pr_number: prNumber,
    require_checks: true,
    merge_strategy: 'squash',
  });

  if (outcome.result === 'merged') {
    // Set lane and plan done after a merge (plan §6.3).
    await deps.laneWriter.write({
      slug: decision.slug,
      lane: decision.lane,
      repo: lane?.repo ?? repo,
      state: 'done',
      next_actor: '',
      log: `merged ${decision.pr_url} @ ${decision.head_sha}; lane done`,
    });
    return { decision, status: 'merged', detail: outcome.body.details?.head };
  }

  if (outcome.result === 'already_merged') {
    // No-op success (plan Risks): the PR was not open. Still mark the lane done,
    // but do not treat it as a failure.
    await deps.laneWriter.write({
      slug: decision.slug,
      lane: decision.lane,
      repo: lane?.repo ?? repo,
      state: 'done',
      next_actor: '',
      log: `safe-merge reported already-merged (${outcome.body.reason}); lane done`,
    });
    return { decision, status: 'already_merged', detail: outcome.body.reason };
  }

  // refused — the gate was not met. Lane is NOT set done.
  return { decision, status: 'merge_refused', detail: outcome.body.reason };
}

async function actReassign(decision: ReassignDecision, state: ObservedState, deps: Bound): Promise<ActResult> {
  const isLane = decision.target === 'lane';
  const written = await deps.laneWriter.write({
    slug: decision.slug,
    lane: decision.lane,
    repo: findLane(state, decision.slug, decision.lane)?.repo,
    // A reassigned lane moves its seat (lane) or its review (next_actor only).
    seat: isLane && decision.to_actor !== 'claude' ? decision.to_actor : undefined,
    next_actor: decision.to_actor,
    log: `reassign ${decision.target} ${decision.from_seat}→${decision.to_actor} (${decision.reason}${decision.fallback ? ', Claude unavailable' : ''})`,
  });
  if (written === 'noop') return { decision, status: 'unchanged', detail: `${decision.target}→${decision.to_actor} already set` };
  return { decision, status: 'reassigned', detail: `${decision.target}→${decision.to_actor}` };
}

async function actPark(decision: ParkDecision, state: ObservedState, deps: Bound): Promise<ActResult> {
  const to = decision.to_actor ?? 'claude';
  await deps.laneWriter.write({
    slug: decision.slug,
    lane: decision.lane,
    repo: findLane(state, decision.slug, decision.lane)?.repo,
    state: 'parked',
    next_actor: to,
    // VTID-05274: parked with the exceptions seat → that seat builds it next.
    seat: to !== 'claude' ? to : undefined,
    release_claim: decision.release_claim,
    log: `park (${decision.reason})${decision.release_claim ? '; claim released' : ''}${decision.fallback ? `; Claude unavailable → ${to}` : ''}`,
  });
  return { decision, status: 'parked', detail: decision.reason };
}

async function actGate2(decision: Gate2Decision, state: ObservedState, deps: Bound): Promise<ActResult> {
  const evidence = await deps.gate2Evidence.resolve(decision, state);
  await deps.gate2Poster.post({
    slug: decision.slug,
    vtids: decision.vtids,
    question: GATE2_QUESTION,
    evidence,
  });
  return {
    decision,
    status: 'gate2_posted',
    detail: `${decision.vtids.join(', ')} (${evidence.commits.length} commits prod→verified)`,
  };
}

async function actVerify(decision: VerifyDecision, state: ObservedState, deps: Bound): Promise<ActResult> {
  await deps.laneWriter.write({
    slug: decision.slug,
    lane: decision.lane,
    repo: findLane(state, decision.slug, decision.lane)?.repo ?? repoFromPrUrl(decision.pr_url) ?? undefined,
    state: 'verified',
    target: 'pr_branch',
    pr_url: decision.pr_url,
    log: `reviewer agent accept on ${decision.head_sha}; verified (${decision.pr_url})`,
  });
  return { decision, status: 'verified_written', detail: decision.head_sha };
}

async function actUpdateBranch(decision: UpdateBranchDecision, deps: Bound): Promise<ActResult> {
  const n = prNumberFromUrl(decision.pr_url);
  if (n == null) return { decision, status: 'update_refused', detail: 'could not parse PR number from url' };
  if (!deps.updateBranch) return { decision, status: 'update_refused', detail: 'no update-branch seam' };
  const repo = repoFromPrUrl(decision.pr_url) ?? deps.repo;
  const r = await deps.updateBranch(repo, n, decision.head_sha);
  return r.ok
    ? { decision, status: 'branch_updated', detail: `${decision.behind_by} behind` }
    : { decision, status: 'update_refused', detail: r.detail ?? `status ${r.status}` };
}

async function actMergeSpecPr(decision: MergePlanDecision | MergeBookkeepingDecision, deps: Bound): Promise<ActResult> {
  const n = prNumberFromUrl(decision.pr_url);
  if (n == null) return { decision, status: 'merge_refused', detail: 'could not parse PR number from url' };
  const outcome = await deps.safeMerge({
    vtid: decision.vtid,
    repo: repoFromPrUrl(decision.pr_url) ?? deps.repo,
    pr_number: n,
    require_checks: true,
    merge_strategy: 'squash',
  });
  if (outcome.result === 'merged') return { decision, status: 'plan_merged', detail: decision.head_sha };
  if (outcome.result === 'already_merged') return { decision, status: 'already_merged', detail: outcome.body.reason };
  return { decision, status: 'merge_refused', detail: outcome.body.reason };
}

async function actLedger(decision: LedgerDecision, deps: Bound): Promise<ActResult> {
  if (!deps.ledgerWriter) return { decision, status: 'ledger_failed', detail: 'no ledger writer' };
  const r = await deps.ledgerWriter.patch(decision.vtid, decision.set);
  return r.ok
    ? { decision, status: 'ledger_updated', detail: `${decision.vtid} in_progress` }
    : { decision, status: 'ledger_failed', detail: r.detail };
}

/** Parse the PR number from a GitHub PR url like …/pull/123. */
export function prNumberFromUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Act on a whole tick's decisions, in `live` only. Takes the per-tick lease
 * first; if the lease is not held (another task has it, or the pm_lease table is
 * absent) the tick NO-OPS. In `off`/`dry_run` it also no-ops. Returns a typed
 * per-decision result list for the status snapshot and the tests. One failing
 * decision does not stop the others (`act_error`).
 */
export async function actOnDecisions(
  decisions: PmDecision[],
  state: ObservedState,
  deps: ActDeps,
): Promise<ActTickResult> {
  const mode = pmMode();

  // Act ONLY in live. off/dry_run perform no action at all.
  if (mode !== 'live') {
    return { mode, acted: false, skipped_reason: 'not_live', results: [] };
  }

  // Take the per-tick lease. Absent table, held-by-other or any error → no-op.
  const lease = deps.lease ?? defaultLeaseManager();
  const holder = deps.holder ?? `pm-${process.pid}`;
  const outcome = await lease.acquire(holder);
  recordLease(outcome);
  if (!outcome.acquired) {
    return { mode, acted: false, skipped_reason: 'no_lease', results: [] };
  }

  const bound: Bound = {
    safeMerge: deps.safeMerge,
    laneWriter: deps.laneWriter,
    gate2Poster: deps.gate2Poster,
    gate2Evidence: deps.gate2Evidence,
    updateBranch: deps.updateBranch,
    ledgerWriter: deps.ledgerWriter,
    repo: deps.repo ?? DEFAULT_REPO,
  };

  const results: ActResult[] = [];
  for (const decision of decisions) {
    try {
      results.push(await actOne(decision, state, bound));
    } catch (err) {
      results.push({ decision, status: 'act_error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    }
  }

  return { mode, acted: true, results };
}
