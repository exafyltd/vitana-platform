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
 *
 * HARD CONSTRAINTS IN CODE (plan §6.3 "Never"). The act layer must NEVER:
 *   - deploy, dispatch a workflow, allocate a VTID, or edit application code;
 *   - merge a PR that touches a governance path unless the lane's reviewer is
 *     `claude` (the final guard, checked here even though P3's decide already
 *     excludes it — defence in depth).
 *
 * A Postgres `pm_lease` is taken per tick (lease.ts) so several ECS tasks never
 * act twice. The `pm_lease` table comes from P1's migration, which is NOT merged
 * yet; so when the table is absent the lease acquirer reports `table_absent` and
 * this tick safely NO-OPS — it never crashes, and never acts without a lease.
 *
 * This layer is deterministic and side-effects only through its injected seams,
 * which is what makes the integration tests (fake GitHub + in-memory DB) able to
 * assert that deploy / dispatch / allocate are NEVER invoked.
 */

import { SafeMergeRequest } from '../../types/cicd';
import type { SafeMergeOutcome } from '../../routes/cicd';
import { pmMode } from './config';
import { LeaseManager, defaultLeaseManager } from './lease';
import {
  ActResult,
  Gate2Decision,
  Gate2Evidence,
  GATE2_QUESTION,
  GOVERNANCE_PATHS,
  GOVERNANCE_REVIEWER,
  MergeDecision,
  ObservedLane,
  ObservedState,
  ParkDecision,
  PM_SESSION,
  PmDecision,
  ReassignDecision,
} from './types';

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

/** A lane-file state change the PM commits (reassign / park / done). */
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
}

/**
 * Writes lane-file state changes to GitHub, committed as `pm-agent` with the
 * `Collab-Session: pm-agent` and `Collab-Lane` trailers (plan §6.3). Injected so
 * tests use an in-memory recorder.
 */
export interface LaneFileWriter {
  write(change: LaneFileChange): Promise<void>;
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
 * Does a single lane path glob fall under a governance path? A lane path is
 * governance when, after stripping a leading `./` and any trailing `*` glob:
 *   - it equals a governance path, or
 *   - it starts with a governance prefix (the lane is inside it), or
 *   - a governance prefix starts with the lane path AND the lane path is a
 *     directory prefix (the lane is a parent dir that contains the gov path).
 */
function pathIsGovernance(p: string): boolean {
  const norm = p.replace(/^\.?\//, '').replace(/\*+$/g, '');
  return GOVERNANCE_PATHS.some((g) => {
    if (norm === g) return true;
    if (norm.startsWith(g)) return true;
    // lane path is a parent directory that contains a governance path
    if (norm.endsWith('/') && g.startsWith(norm)) return true;
    return false;
  });
}

/** True when any of the lane's declared paths is a governance path. */
export function laneTouchesGovernance(lane: ObservedLane): boolean {
  return lane.paths.some(pathIsGovernance);
}

/**
 * The governance-path final guard (plan §6.3 "Never: merge a PR that touches a
 * governance path unless its reviewer is `claude`"). Returns true when the merge
 * is allowed to proceed. Checked here as defence in depth even though P3's lane
 * schema already requires `executor: claude` for governance-path lanes.
 */
export function governanceMergeAllowed(lane: ObservedLane): boolean {
  if (!laneTouchesGovernance(lane)) return true;
  return lane.reviewer_seat === GOVERNANCE_REVIEWER;
}

function findLane(state: ObservedState, slug: string, lane: string): ObservedLane | undefined {
  return state.lanes.find((l) => l.slug === slug && l.lane === lane);
}

/**
 * Act on ONE decision. Pure control flow over the injected seams. Returns the
 * typed `ActResult`. Never deploys, never dispatches a workflow, never allocates
 * a VTID — those capabilities are not injected and not reachable from here.
 */
async function actOne(
  decision: PmDecision,
  state: ObservedState,
  deps: Required<Pick<ActDeps, 'safeMerge' | 'laneWriter' | 'gate2Poster' | 'gate2Evidence'>> & {
    repo: PmRepo;
  },
): Promise<ActResult> {
  switch (decision.kind) {
    case 'merge':
      return actMerge(decision, state, deps);
    case 'reassign':
      return actReassign(decision, deps);
    case 'park':
      return actPark(decision, deps);
    case 'gate2':
      return actGate2(decision, state, deps);
  }
}

async function actMerge(
  decision: MergeDecision,
  state: ObservedState,
  deps: { safeMerge: SafeMergeFn; laneWriter: LaneFileWriter; repo: PmRepo },
): Promise<ActResult> {
  const lane = findLane(state, decision.slug, decision.lane);

  // Final governance guard: a governance-path PR may only be merged when the
  // lane's reviewer is `claude`. Never merge otherwise.
  if (lane && !governanceMergeAllowed(lane)) {
    return {
      decision,
      status: 'governance_blocked',
      detail: `governance-path lane reviewer is ${lane.reviewer_seat}, not ${GOVERNANCE_REVIEWER}`,
    };
  }

  // The PR number must be parseable from the decision's PR url (…/pull/<n>).
  const prNumber = prNumberFromUrl(decision.pr_url);
  if (prNumber == null) {
    return { decision, status: 'merge_refused', detail: 'could not parse PR number from url' };
  }

  const outcome = await deps.safeMerge({
    vtid: decision.vtid,
    repo: deps.repo,
    pr_number: prNumber,
    require_checks: true,
    merge_strategy: 'squash',
  });

  if (outcome.result === 'merged') {
    // Set lane and plan done after a merge (plan §6.3).
    await deps.laneWriter.write({
      slug: decision.slug,
      lane: decision.lane,
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
      state: 'done',
      next_actor: '',
      log: `safe-merge reported already-merged (${outcome.body.reason}); lane done`,
    });
    return { decision, status: 'already_merged', detail: outcome.body.reason };
  }

  // refused — the gate was not met. Lane is NOT set done.
  return { decision, status: 'merge_refused', detail: outcome.body.reason };
}

async function actReassign(
  decision: ReassignDecision,
  deps: { laneWriter: LaneFileWriter },
): Promise<ActResult> {
  const isLane = decision.target === 'lane';
  await deps.laneWriter.write({
    slug: decision.slug,
    lane: decision.lane,
    // A reassigned lane moves its seat (lane) or its review (next_actor only).
    seat: isLane && decision.to_actor !== 'claude' ? decision.to_actor : undefined,
    next_actor: decision.to_actor,
    log: `reassign ${decision.target} ${decision.from_seat}→${decision.to_actor} (${decision.reason})`,
  });
  return { decision, status: 'reassigned', detail: `${decision.target}→${decision.to_actor}` };
}

async function actPark(
  decision: ParkDecision,
  deps: { laneWriter: LaneFileWriter },
): Promise<ActResult> {
  await deps.laneWriter.write({
    slug: decision.slug,
    lane: decision.lane,
    state: 'parked',
    next_actor: 'claude',
    release_claim: decision.release_claim,
    log: `park (${decision.reason})${decision.release_claim ? '; claim released' : ''}`,
  });
  return { decision, status: 'parked', detail: decision.reason };
}

async function actGate2(
  decision: Gate2Decision,
  state: ObservedState,
  deps: { gate2Poster: Gate2Poster; gate2Evidence: Gate2EvidenceResolver },
): Promise<ActResult> {
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
 * absent because P1 is not merged) the tick NO-OPS. In `off`/`dry_run` it also
 * no-ops. Returns a typed per-decision result list for the status snapshot and
 * the tests.
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

  // Take the per-tick lease. Absent table (P1 not merged) or held-by-other → no-op.
  const lease = deps.lease ?? defaultLeaseManager();
  const holder = deps.holder ?? `pm-${process.pid}`;
  const outcome = await lease.acquire(holder);
  if (!outcome.acquired) {
    return { mode, acted: false, skipped_reason: 'no_lease', results: [] };
  }

  const bound = {
    safeMerge: deps.safeMerge,
    laneWriter: deps.laneWriter,
    gate2Poster: deps.gate2Poster,
    gate2Evidence: deps.gate2Evidence,
    repo: deps.repo ?? DEFAULT_REPO,
  };

  const results: ActResult[] = [];
  for (const decision of decisions) {
    results.push(await actOne(decision, state, bound));
  }

  return { mode, acted: true, results };
}
