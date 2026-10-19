/**
 * VTID-05216 — Project Manager: the pure DECIDE step (plan §6.2).
 *
 * Every function here is PURE: it takes the observed state and the current
 * time (`nowMs`) and returns typed decisions with NO side effects. This is the
 * heart of P3 and is exhaustively table-tested. No DB, no GitHub, no clock, no
 * randomness is read inside — all of it is passed in.
 *
 * The merge rule is the one that matters most: a lane PR is merge-eligible ONLY
 * when every precondition in `mergeDecision` holds. Each precondition is checked
 * in a single place so the mutation tests can flip one at a time.
 */

import {
  CheckRun,
  CI_FAIL_PARK_THRESHOLD,
  CLAUDE_APPROVALS_CHECK,
  GATE2_BATCH_AFTER_MS,
  Gate2Decision,
  MergeDecision,
  ObservedLane,
  ObservedState,
  ParkDecision,
  PmDecision,
  REASSIGN_AFTER_MS,
  REQUIRED_MERGE_CHECKS,
  ReassignDecision,
  ReviewEntry,
  STALE_CLAIM_AFTER_MS,
} from './types';

/** Parse an ISO timestamp to epoch ms; NaN-safe (returns null on bad input). */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? null : n;
}

/** The newest review entry on a lane, or null. */
export function latestReview(lane: ObservedLane): ReviewEntry | null {
  if (lane.reviews.length === 0) return null;
  // reviews are stored newest-last; pick the max `at`, stable to array order.
  let newest = lane.reviews[0];
  for (const r of lane.reviews) {
    if ((toMs(r.at) ?? 0) >= (toMs(newest.at) ?? 0)) newest = r;
  }
  return newest;
}

/** True when a named check is `success` on the given head sha. */
function checkIsSuccess(checks: CheckRun[], name: string, headSha: string): boolean {
  const run = checks.find((c) => c.name === name && c.head_sha === headSha);
  return run != null && run.conclusion === 'success';
}

/** True when a named check run exists at all on the given head sha. */
function checkExists(checks: CheckRun[], name: string, headSha: string): boolean {
  return checks.some((c) => c.name === name && c.head_sha === headSha);
}

/**
 * Is this lane's PR eligible to MERGE? Returns a MergeDecision or null.
 * ALL of plan §6.2's merge preconditions must hold.
 */
export function mergeDecision(lane: ObservedLane, allLanes: ObservedLane[]): MergeDecision | null {
  // 1. lane is `verified`
  if (lane.state !== 'verified') return null;

  // There must be a PR with a VTID.
  const pr = lane.pr;
  if (!pr) return null;
  if (!lane.vtid) return null;

  const head = pr.head_sha;

  // 2. last review entry: from the lane's reviewer_seat, on the PR's CURRENT
  //    head sha, verdict 'approve'.
  const review = latestReview(lane);
  if (!review) return null;
  if (review.reviewer_seat !== lane.reviewer_seat) return null;
  if (review.head_sha !== head) return null;
  if (review.verdict !== 'approve') return null;

  // 3. all required checks green on that head (incl. Lane scope + Collab handoff).
  for (const name of REQUIRED_MERGE_CHECKS) {
    if (!checkIsSuccess(pr.checks, name, head)) return null;
  }

  // 4. IF a "Claude Approvals" App check run exists on the head, it must be success.
  if (checkExists(pr.checks, CLAUDE_APPROVALS_CHECK, head)) {
    if (!checkIsSuccess(pr.checks, CLAUDE_APPROVALS_CHECK, head)) return null;
  }

  // 5. no merge conflict.
  if (!pr.mergeable) return null;

  // 6. depends_on lanes are all `done`.
  for (const depId of lane.depends_on) {
    const dep = allLanes.find((l) => l.lane === depId);
    if (!dep || dep.state !== 'done') return null;
  }

  // 7. PR title carries the lane's VTID.
  if (!pr.title.includes(lane.vtid)) return null;

  // 8. lane declares paths.
  if (!lane.paths || lane.paths.length === 0) return null;

  // 9. residual self-review guard: the review commit's session id must differ
  //    from every session id in the lane's executing-log entries.
  if (lane.executing_log.some((e) => e.session_id === review.session_id)) return null;

  return {
    kind: 'merge',
    slug: lane.slug,
    lane: lane.lane,
    vtid: lane.vtid,
    pr_url: pr.url,
    head_sha: head,
  };
}

/**
 * REASSIGN rule (plan §6.2): a lane `ready` for >24h whose seat ran no
 * automation in that window moves to the next seat for the area, else
 * `next_actor: claude`. The same for a review waiting >24h.
 */
export function reassignDecision(
  lane: ObservedLane,
  state: ObservedState,
  nowMs: number,
): ReassignDecision | null {
  const nextActor = (): string => {
    const rotation = state.rotations.find((r) => r.area === lane.area);
    if (!rotation || rotation.seats.length === 0) return 'claude';
    const idx = rotation.seats.indexOf(lane.seat);
    // next seat in rotation; if the current seat isn't found or it's the last,
    // there is no further seat for the area → claude.
    if (idx < 0 || idx + 1 >= rotation.seats.length) return 'claude';
    return rotation.seats[idx + 1];
  };

  if (lane.state === 'ready') {
    const since = toMs(lane.state_since);
    if (since != null && nowMs - since > REASSIGN_AFTER_MS && !lane.seat_ran_automation_in_window) {
      return {
        kind: 'reassign',
        slug: lane.slug,
        lane: lane.lane,
        target: 'lane',
        from_seat: lane.seat,
        to_actor: nextActor(),
        reason: 'stale_ready_24h',
      };
    }
  }

  if (lane.state === 'in-review') {
    const review = latestReview(lane);
    // the review has been waiting since the lane entered in-review.
    const since = toMs(lane.state_since);
    const reviewed = review != null; // a completed review is not "waiting"
    if (!reviewed && since != null && nowMs - since > REASSIGN_AFTER_MS) {
      return {
        kind: 'reassign',
        slug: lane.slug,
        lane: lane.lane,
        target: 'review',
        from_seat: lane.reviewer_seat,
        to_actor: nextActor(),
        reason: 'stale_review_24h',
      };
    }
  }

  return null;
}

/**
 * PARK rules (plan §6.2):
 *  - a lane whose PR failed CI on 3 consecutive pushes;
 *  - a lane flagged `risk:` by its reviewer;
 *  - a claim older than 48h with no branch activity (released).
 * The first matching rule wins (checked in the plan's listed order).
 */
export function parkDecision(lane: ObservedLane, nowMs: number): ParkDecision | null {
  if (lane.state === 'parked' || lane.state === 'done') return null;

  // 1. PR failed CI on 3 consecutive pushes.
  if (lane.pr && lane.pr.consecutive_ci_failures >= CI_FAIL_PARK_THRESHOLD) {
    return {
      kind: 'park',
      slug: lane.slug,
      lane: lane.lane,
      reason: 'ci_failed_3_consecutive',
      release_claim: false,
    };
  }

  // 2. reviewer flagged risk.
  const review = latestReview(lane);
  if (review && review.verdict === 'risk') {
    return {
      kind: 'park',
      slug: lane.slug,
      lane: lane.lane,
      reason: 'reviewer_flagged_risk',
      release_claim: false,
    };
  }

  // 3. claim older than 48h with no branch activity → park + release.
  const claimedAt = toMs(lane.claimed_at);
  if (claimedAt != null && nowMs - claimedAt > STALE_CLAIM_AFTER_MS) {
    const activity = toMs(lane.last_branch_activity);
    const noActivity = activity == null || activity <= claimedAt;
    if (noActivity) {
      return {
        kind: 'park',
        slug: lane.slug,
        lane: lane.lane,
        reason: 'stale_claim_48h',
        release_claim: true,
      };
    }
  }

  return null;
}

/**
 * GATE-2 BATCH rule (plan §6.2): for a plan's deploying lanes that merged and
 * passed STAGING-VERIFY without a Gate 2, send when EVERY deploying lane of the
 * plan is verified on staging, OR 4h after the first was verified, whichever is
 * first. One decision per plan slug.
 */
export function gate2Decisions(state: ObservedState, nowMs: number): Gate2Decision[] {
  const out: Gate2Decision[] = [];

  // group deploying lanes by plan slug.
  const bySlug = new Map<string, ObservedLane[]>();
  for (const lane of state.lanes) {
    if (!lane.deploys) continue;
    const list = bySlug.get(lane.slug) ?? [];
    list.push(lane);
    bySlug.set(lane.slug, list);
  }

  for (const [slug, lanes] of bySlug) {
    // only consider lanes that merged (done) and have not had Gate 2 sent.
    const pending = lanes.filter((l) => !l.gate2_sent);
    if (pending.length === 0) continue;
    // every deploying lane of the plan must at least be merged/done to batch;
    // a plan still building a deploying lane is not ready for "all verified".
    const allVerified = lanes.every((l) => l.staging_verified);

    // the earliest staging_verified_at across the plan's verified lanes.
    const firstVerifiedMs = lanes
      .map((l) => toMs(l.staging_verified_at))
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b)[0];

    const fourHoursElapsed =
      firstVerifiedMs != null && nowMs - firstVerifiedMs > GATE2_BATCH_AFTER_MS;

    // nothing has been verified yet → not ready at all.
    if (firstVerifiedMs == null) continue;

    if (allVerified || fourHoursElapsed) {
      const vtids = lanes
        .filter((l) => l.staging_verified && l.vtid)
        .map((l) => l.vtid as string);
      out.push({
        kind: 'gate2',
        slug,
        vtids,
        reason: allVerified ? 'all_verified' : 'four_hours_elapsed',
      });
    }
  }

  return out;
}

/**
 * Run the whole deterministic decide step over the observed state. Pure.
 * Returns every decision the PM would act on (in `live`); in `dry_run` these
 * are only reported / emitted, never acted on.
 */
export function decide(state: ObservedState, nowMs: number): PmDecision[] {
  if (state.mode === 'off') return [];

  const decisions: PmDecision[] = [];

  for (const lane of state.lanes) {
    // Park takes precedence over merge/reassign for a troubled lane.
    const park = parkDecision(lane, nowMs);
    if (park) {
      decisions.push(park);
      continue;
    }

    const merge = mergeDecision(lane, state.lanes);
    if (merge) {
      decisions.push(merge);
      continue;
    }

    const reassign = reassignDecision(lane, state, nowMs);
    if (reassign) {
      decisions.push(reassign);
      continue;
    }
  }

  // Gate-2 batching is per-plan, not per-lane.
  decisions.push(...gate2Decisions(state, nowMs));

  return decisions;
}
