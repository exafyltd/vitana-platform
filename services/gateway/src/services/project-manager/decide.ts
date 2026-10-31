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
 *
 * VTID-05274 (plan kiro-autonomy-fallback §3, §5 C2-C4): Claude is optional —
 * when it is unavailable (`claudeAvailability`) every job that went to Claude
 * goes to the exceptions seat; the review precondition is the governance guard
 * (governance.ts: reviewer-agent accept on the current head); timers shorten
 * without a live plan driver; one merge per repo per tick; behind PRs are
 * updated first; W1 `verify`; spec-only plan PRs and the PM's bookkeeping PRs
 * merge; ledger rows move to in_progress.
 */
import {
  ClaudeAvailability,
  CheckRun,
  CI_FAIL_PARK_THRESHOLD,
  CLAUDE_APPROVALS_CHECK,
  CLAUDE_NO_ACTION_AFTER_MS,
  DRIVER_ALIVE_MS,
  EXCEPTIONS_SEAT,
  GATE2_BATCH_AFTER_MS,
  Gate2Decision,
  LedgerDecision,
  MAX_BUILD_LANES_PER_PLAN,
  MergeBookkeepingDecision,
  MergeDecision,
  MergePlanDecision,
  ObservedBookkeepingPr,
  ObservedClaude,
  ObservedLane,
  ObservedPlanPr,
  ObservedState,
  ParkDecision,
  PmDecision,
  REASSIGN_AFTER_MS,
  REASSIGN_NO_DRIVER_AFTER_MS,
  REQUIRED_MERGE_CHECKS,
  ReassignDecision,
  ReviewEntry,
  STALE_CLAIM_AFTER_MS,
  STALE_CLAIM_NO_DRIVER_AFTER_MS,
  UpdateBranchDecision,
  VerifyDecision,
} from './types';
import { governanceMergeAllowed, isAgentReview, reviewOnCurrentHead, reviewSatisfiesLane } from './governance';

/** Parse an ISO timestamp to epoch ms; NaN-safe (returns null on bad input). */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? null : n;
}

const AVAILABLE: ClaudeAvailability = { available: true, reason: null };

/**
 * VTID-05274 — Claude availability (plan §3). A level, not an edge: evaluated
 * every tick from the observed inputs.
 *  - `flag === false` (repo variable CLAUDE_AVAILABLE) → unavailable, `flag_false`;
 *  - the oldest open item with `next_actor: claude` is older than 4 h and no
 *    Claude Code session committed after it → unavailable, `no_action_4h`
 *    (`flag === true` does not override this);
 *  - otherwise (or nothing observed) → available.
 */
export function claudeAvailability(c: ObservedClaude | null | undefined, nowMs: number): ClaudeAvailability {
  if (!c) return AVAILABLE;
  if (c.flag === false) return { available: false, reason: 'flag_false' };
  const assigned = toMs(c.oldest_assigned_at);
  if (assigned != null && nowMs - assigned > CLAUDE_NO_ACTION_AFTER_MS) {
    const acted = toMs(c.last_action_at);
    if (acted == null || acted <= assigned) return { available: false, reason: 'no_action_4h' };
  }
  return AVAILABLE;
}

/** Who gets a job that goes to Claude today: Claude when available, else the exceptions seat. */
function claudeOrExceptions(claude: ClaudeAvailability): { actor: string; fallback: boolean } {
  return claude.available ? { actor: 'claude', fallback: false } : { actor: EXCEPTIONS_SEAT, fallback: true };
}

/**
 * Is the plan's driver alive (plan §4.7)? `true` heartbeat < 45 min old,
 * `false` no ref or older, `null` not observed (treated like alive: today's windows).
 */
export function driverAlive(lane: ObservedLane, nowMs: number): boolean | null {
  if (lane.driver_heartbeat_at === undefined) return null;
  const hb = toMs(lane.driver_heartbeat_at);
  if (hb == null) return false;
  return nowMs - hb < DRIVER_ALIVE_MS;
}

/** Lanes being built per plan slug (`executing` | `in-review`). */
export function buildLanesInFlight(state: ObservedState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of state.lanes) {
    if (l.state === 'executing' || l.state === 'in-review') out[l.slug] = (out[l.slug] ?? 0) + 1;
  }
  return out;
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

const PASSING = new Set(['success', 'neutral', 'skipped']);
/** Every check run on the head passed, and there is at least one. */
function allChecksGreen(checks: CheckRun[], headSha: string): boolean {
  const onHead = checks.filter((c) => c.head_sha === headSha);
  return onHead.length > 0 && onHead.every((c) => PASSING.has(c.conclusion));
}

/** `owner/name` from a GitHub PR url, or null. */
export function repoFromPrUrl(url: string): string | null {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  return m ? m[1] : null;
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
  // 2. last review entry satisfies the lane (VTID-05274 governance guard): the
  //    reviewer agent's accept on the current head, or a legacy seat approve
  //    from the lane's reviewer_seat on the exact head.
  const review = latestReview(lane);
  if (!review) return null;
  if (!reviewSatisfiesLane(lane, review)) return null;
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
    const dep = allLanes.find((l) => l.lane === depId && l.slug === lane.slug) ?? allLanes.find((l) => l.lane === depId);
    if (!dep || dep.state !== 'done') return null;
  }
  // 7. PR title carries the lane's VTID.
  if (!pr.title.includes(lane.vtid)) return null;
  // 8. lane declares paths.
  if (!lane.paths || lane.paths.length === 0) return null;
  // 9. residual self-review guard: the review commit's session id must differ
  //    from every session id in the lane's executing-log entries.
  if (lane.executing_log.some((e) => e.session_id === review.session_id)) return null;
  // 10. VTID-05274: protected gate files / governance paths (governance.ts).
  if (!governanceMergeAllowed(lane, pr, review).ok) return null;
  // 11. VTID-05274: up to date with main (else `update_branch` first).
  if ((pr.behind_by ?? 0) > 0) return null;
  return {
    kind: 'merge',
    slug: lane.slug,
    lane: lane.lane,
    vtid: lane.vtid,
    pr_url: pr.url,
    head_sha: head,
  };
}

/** VTID-05274: a merge-eligible PR that is behind main is updated first (next tick re-checks the new head). */
export function updateBranchDecision(lane: ObservedLane, allLanes: ObservedLane[]): UpdateBranchDecision | null {
  const pr = lane.pr;
  if (!pr || (pr.behind_by ?? 0) <= 0) return null;
  const upToDate: ObservedLane = { ...lane, pr: { ...pr, behind_by: 0 } };
  if (!mergeDecision(upToDate, allLanes)) return null;
  return { kind: 'update_branch', slug: lane.slug, lane: lane.lane, pr_url: pr.url, head_sha: pr.head_sha, behind_by: pr.behind_by as number };
}

/** VTID-05274 W1: an `in-review` lane whose latest review is the agent's accept on the current head → `verified`. */
export function verifyDecision(lane: ObservedLane): VerifyDecision | null {
  if (lane.state !== 'in-review') return null;
  const pr = lane.pr;
  if (!pr || pr.merged || !lane.vtid) return null;
  const review = latestReview(lane);
  if (!review || !isAgentReview(review) || !reviewOnCurrentHead(review, pr)) return null;
  if (lane.executing_log.some((e) => e.session_id === review.session_id)) return null;
  return { kind: 'verify', slug: lane.slug, lane: lane.lane, vtid: lane.vtid, pr_url: pr.url, head_sha: pr.head_sha };
}

/**
 * REASSIGN rule (plan §6.2): a lane `ready` past the window whose seat ran no
 * automation in it moves to the next seat for the area; at the end of the
 * rotation it goes to Claude — or, when Claude is unavailable (VTID-05274), to
 * the exceptions seat. The same for a review waiting past the window. Window:
 * 24 h with a live plan driver, 2 h without. A move to the same seat is no
 * decision (no self loop); no ready lane is reassigned into a plan that already
 * builds 6 lanes.
 */
export function reassignDecision(
  lane: ObservedLane,
  state: ObservedState,
  nowMs: number,
  claude: ClaudeAvailability = claudeAvailability(state.claude, nowMs),
): ReassignDecision | null {
  const nextActor = (fromSeat: string): { actor: string; fallback: boolean } => {
    const rotation = state.rotations.find((r) => r.area === lane.area);
    if (!rotation || rotation.seats.length === 0) return claudeOrExceptions(claude);
    const idx = rotation.seats.indexOf(fromSeat);
    // next seat in rotation; if the current seat isn't found or it's the last,
    // there is no further seat for the area → claude (or the exceptions seat).
    if (idx < 0 || idx + 1 >= rotation.seats.length) return claudeOrExceptions(claude);
    return { actor: rotation.seats[idx + 1], fallback: false };
  };
  const windowMs = driverAlive(lane, nowMs) === false ? REASSIGN_NO_DRIVER_AFTER_MS : REASSIGN_AFTER_MS;

  if (lane.state === 'ready') {
    const since = toMs(lane.state_since);
    if (since != null && nowMs - since > windowMs && !lane.seat_ran_automation_in_window) {
      if ((buildLanesInFlight(state)[lane.slug] ?? 0) >= MAX_BUILD_LANES_PER_PLAN) return null;
      // VTID-05414: the new seat is never the lane's reviewer_seat (queue.mjs validateLane
      // rejects seat == reviewer_seat): skip it in the rotation; if only it is left, no decision.
      const rotation = state.rotations.find((r) => r.area === lane.area)?.seats ?? [];
      const idx = rotation.indexOf(lane.seat);
      const seat = idx < 0 ? undefined : rotation.slice(idx + 1).find((s) => s !== lane.seat && s !== lane.reviewer_seat);
      const next = seat ? { actor: seat, fallback: false } : claudeOrExceptions(claude);
      if (next.actor === lane.seat) return null;
      if (next.actor !== 'claude' && lane.reviewer_seat && next.actor === lane.reviewer_seat) return null;
      return {
        kind: 'reassign',
        slug: lane.slug,
        lane: lane.lane,
        target: 'lane',
        from_seat: lane.seat,
        to_actor: next.actor,
        reason: 'stale_ready',
        window_ms: windowMs,
        fallback: next.fallback,
      };
    }
  }
  if (lane.state === 'in-review') {
    const review = latestReview(lane);
    // the review has been waiting since the lane entered in-review.
    const since = toMs(lane.state_since);
    const reviewed = review != null; // a completed review is not "waiting"
    if (!reviewed && since != null && nowMs - since > windowMs) {
      const next = nextActor(lane.reviewer_seat);
      if (next.actor === lane.reviewer_seat) return null;
      return {
        kind: 'reassign',
        slug: lane.slug,
        lane: lane.lane,
        target: 'review',
        from_seat: lane.reviewer_seat,
        to_actor: next.actor,
        reason: 'stale_review',
        window_ms: windowMs,
        fallback: next.fallback,
      };
    }
  }
  return null;
}

/**
 * PARK rules (plan §6.2):
 *  - a lane whose PR failed CI on 3 consecutive pushes;
 *  - a lane flagged `risk:` by its reviewer;
 *  - a claim older than the window with no branch activity (released) — 48 h
 *    with a live plan driver, 4 h without (VTID-05274).
 * The first matching rule wins (checked in the plan's listed order). A parked
 * lane goes to Claude, or to the exceptions seat when Claude is unavailable.
 */
export function parkDecision(
  lane: ObservedLane,
  nowMs: number,
  claude: ClaudeAvailability = AVAILABLE,
): ParkDecision | null {
  if (lane.state === 'parked' || lane.state === 'done') return null;
  const to = claudeOrExceptions(claude);
  const base = { kind: 'park' as const, slug: lane.slug, lane: lane.lane, to_actor: to.actor, fallback: to.fallback };
  // 1. PR failed CI on 3 consecutive pushes.
  if (lane.pr && lane.pr.consecutive_ci_failures >= CI_FAIL_PARK_THRESHOLD) {
    return { ...base, reason: 'ci_failed_3_consecutive', release_claim: false };
  }
  // 2. reviewer flagged risk.
  const review = latestReview(lane);
  if (review && review.verdict === 'risk') {
    return { ...base, reason: 'reviewer_flagged_risk', release_claim: false };
  }
  // 3. claim older than the window with no branch activity → park + release.
  const windowMs = driverAlive(lane, nowMs) === false ? STALE_CLAIM_NO_DRIVER_AFTER_MS : STALE_CLAIM_AFTER_MS;
  const claimedAt = toMs(lane.claimed_at);
  if (claimedAt != null && nowMs - claimedAt > windowMs) {
    const activity = toMs(lane.last_branch_activity);
    const noActivity = activity == null || activity <= claimedAt;
    if (noActivity) {
      return { ...base, reason: 'stale_claim', release_claim: true, window_ms: windowMs };
    }
  }
  return null;
}

/** VTID-05274: a lane being built moves its ledger row allocated|scheduled → in_progress (idempotent). */
export function ledgerDecision(lane: ObservedLane): LedgerDecision | null {
  if (!lane.vtid) return null;
  if (lane.state !== 'executing' && lane.state !== 'in-review') return null;
  if (lane.ledger_status !== 'allocated' && lane.ledger_status !== 'scheduled') return null;
  return { kind: 'ledger', slug: lane.slug, lane: lane.lane, vtid: lane.vtid, set: { status: 'in_progress', spec_status: 'approved' } };
}

/**
 * VTID-05274: merge a `plan(<slug>)` PR when it only changes `.kiro/specs/<slug>/`,
 * its handoff is `approved` with VTIDs, the sparring session (read-only) is
 * converged + policy-approved with `final_plan_hash` = the head plan's canonical
 * hash, the head commit is PLAN-SPAR's, every check is green and it is
 * mergeable and up to date.
 */
export function planMergeDecision(p: ObservedPlanPr): MergePlanDecision | null {
  if (p.merged || !p.mergeable) return null;
  if (!p.title.startsWith(`plan(${p.slug})`)) return null;
  const prefix = `.kiro/specs/${p.slug}/`;
  if (p.files.length === 0 || !p.files.every((f) => f.startsWith(prefix))) return null;
  if (p.handoff_state !== 'approved' || p.vtids.length === 0) return null;
  const s = p.sparring;
  if (!s || s.verdict !== 'converged' || !s.policy_approved_at) return null;
  if (!s.final_plan_hash || !p.head_plan_hash || s.final_plan_hash !== p.head_plan_hash) return null;
  if (p.head_commit_session !== 'ci-plan-spar') return null;
  if (!allChecksGreen(p.checks, p.head_sha)) return null;
  if ((p.behind_by ?? 0) > 0) return null;
  return { kind: 'merge_plan', slug: p.slug, vtid: p.vtids[0], pr_url: p.url, head_sha: p.head_sha };
}

const BOOKKEEPING_TITLE_RE = /^(VTID-\d{5}) \(([^)/]+)\/_plan\): PM bookkeeping/;
/** VTID-05274 W2: merge the PM's own bookkeeping PR (pm-agent commits only; spec + timings.json only; green). */
export function bookkeepingMergeDecision(b: ObservedBookkeepingPr): MergeBookkeepingDecision | null {
  if (b.merged || !b.mergeable) return null;
  const m = BOOKKEEPING_TITLE_RE.exec(b.title);
  if (!m || m[2] !== b.slug) return null;
  if (b.commit_sessions.length === 0 || !b.commit_sessions.every((s) => s === 'pm-agent')) return null;
  const okFile = (f: string) => f.startsWith(`.kiro/specs/${b.slug}/`) || /^docs\/validation\/VTID-\d{5}\/timings\.json$/.test(f);
  if (b.files.length === 0 || !b.files.every(okFile)) return null;
  if (!allChecksGreen(b.checks, b.head_sha)) return null;
  if ((b.behind_by ?? 0) > 0) return null;
  return { kind: 'merge_bookkeeping', slug: b.slug, vtid: m[1], pr_url: b.url, head_sha: b.head_sha };
}

/**
 * GATE-2 BATCH rule (plan §6.2): for a plan's deploying lanes that merged and
 * passed STAGING-VERIFY without a Gate 2, send when EVERY (non-parked)
 * deploying lane of the plan is verified on staging, OR 4h after the first
 * unsent lane was verified while a sibling is still in flight. One decision per
 * plan slug; `vtids` = verified lanes not sent yet (VTID-05274: per lane).
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
    // a parked deploying lane does not block the plan's Gate 2.
    const live = lanes.filter((l) => l.state !== 'parked');
    const toSend = live.filter((l) => l.staging_verified && !l.gate2_sent && l.vtid);
    if (toSend.length === 0) continue;
    const allVerified = live.every((l) => l.staging_verified);
    const firstVerifiedMs = toSend
      .map((l) => toMs(l.staging_verified_at))
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b)[0];
    // nothing has a verification time → not ready on the 4h path.
    const fourHoursElapsed = firstVerifiedMs != null && nowMs - firstVerifiedMs > GATE2_BATCH_AFTER_MS;
    if (firstVerifiedMs == null && !allVerified) continue;
    if (allVerified || fourHoursElapsed) {
      out.push({
        kind: 'gate2',
        slug,
        vtids: toSend.map((l) => l.vtid as string),
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
  const claude = claudeAvailability(state.claude, nowMs);
  const decisions: PmDecision[] = [];
  const mergeCandidates: Array<{ lane: ObservedLane; d: MergeDecision }> = [];

  for (const lane of state.lanes) {
    // Park takes precedence over merge/reassign for a troubled lane.
    const park = parkDecision(lane, nowMs, claude);
    if (park) {
      decisions.push(park);
      continue;
    }
    const merge = mergeDecision(lane, state.lanes);
    if (merge) {
      mergeCandidates.push({ lane, d: merge });
      continue;
    }
    const update = updateBranchDecision(lane, state.lanes);
    if (update) {
      decisions.push(update);
      continue;
    }
    const verify = verifyDecision(lane);
    if (verify) {
      decisions.push(verify);
      continue;
    }
    const reassign = reassignDecision(lane, state, nowMs, claude);
    if (reassign) {
      decisions.push(reassign);
      continue;
    }
  }

  // Ledger rows of lanes being built (independent of the lane's other decision).
  for (const lane of state.lanes) {
    const l = ledgerDecision(lane);
    if (l) decisions.push(l);
  }

  // Merge queue: at most one merge per repo per tick, oldest `state_since` first;
  // a plan / bookkeeping PR only merges when no lane merge took its repo.
  const mergedRepos = new Set<string>();
  const repoOf = (url: string) => repoFromPrUrl(url) ?? 'exafyltd/vitana-platform';
  mergeCandidates.sort((a, b) => (toMs(a.lane.state_since) ?? 0) - (toMs(b.lane.state_since) ?? 0));
  for (const c of mergeCandidates) {
    const repo = repoOf(c.d.pr_url);
    if (mergedRepos.has(repo)) continue;
    mergedRepos.add(repo);
    decisions.push(c.d);
  }
  for (const p of state.plan_prs ?? []) {
    const d = planMergeDecision(p);
    if (!d || mergedRepos.has(repoOf(d.pr_url))) continue;
    mergedRepos.add(repoOf(d.pr_url));
    decisions.push(d);
  }
  for (const b of state.bookkeeping_prs ?? []) {
    const d = bookkeepingMergeDecision(b);
    if (!d || mergedRepos.has(repoOf(d.pr_url))) continue;
    mergedRepos.add(repoOf(d.pr_url));
    decisions.push(d);
  }

  // Gate-2 batching is per-plan, not per-lane.
  decisions.push(...gate2Decisions(state, nowMs));
  return decisions;
}
