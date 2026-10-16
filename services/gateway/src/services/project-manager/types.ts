/**
 * VTID-05216 — Project Manager agent (P3: observe + decide, dry_run).
 *
 * Typed shapes for the OBSERVE inputs the pure DECIDE step consumes, and the
 * typed decisions it returns. The PM is a DETERMINISTIC loop — rules in code,
 * no LLM decides. P3 delivers observe + decide only; P4 adds act. P3 performs
 * NO GitHub writes, NO merges, NO deploys — in dry_run it only runs decide and
 * reports the decision list.
 *
 * The decision rules are plan `.kiro/specs/pm-agent/plan-sparring.md` §6.2.
 * Every decide function here is PURE (no I/O, no clock, no randomness): the
 * current time is passed in as `nowMs`, the observed state is passed in whole.
 * That is what makes the exhaustive table tests possible without a DB or
 * GitHub.
 */

/** PM run mode (plan §6). `off` disables everything; `dry_run` decides + reports; `live` (P4) acts. */
export type PmMode = 'off' | 'dry_run' | 'live';

/** Lane lifecycle states that the PM reasons about (collaboration.md §2). */
export type LaneState =
  | 'ready'
  | 'executing'
  | 'in-review'
  | 'verified'
  | 'done'
  | 'parked';

/** A review verdict recorded by the reviewer seat (collaboration.md §7). */
export type ReviewVerdict = 'approve' | 'changes' | 'risk';

/** Conclusion of a single CI check run on a commit. */
export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'skipped'
  | 'stale'
  | 'pending';

/** One required CI check on a PR head sha. */
export interface CheckRun {
  /** Check name, e.g. "Lane scope", "Collab handoff", "Claude Approvals". */
  name: string;
  conclusion: CheckConclusion;
  /** The head sha this check ran against. */
  head_sha: string;
}

/** A review entry parsed from a lane log (carries a `Collab-Review` trailer). */
export interface ReviewEntry {
  /** The reviewer's session id (from the `Collab-Session` on the review commit). */
  session_id: string;
  /** The seat that authored the review (from `reviewer_seat`/the review trailer). */
  reviewer_seat: string;
  verdict: ReviewVerdict;
  /** The PR head sha this review was made against. */
  head_sha: string;
  /** ISO timestamp of the review. */
  at: string;
}

/** One entry in a lane's executing log (used for the self-review residual guard). */
export interface ExecutingLogEntry {
  session_id: string;
  seat: string;
  at: string;
}

/** The open PR backing a lane, with its CI + merge state. */
export interface ObservedPr {
  url: string;
  /** The PR title (must carry the lane's VTID to be merge-eligible). */
  title: string;
  /** Current head sha of the PR branch. */
  head_sha: string;
  /** All check runs seen on the current head. */
  checks: CheckRun[];
  /** True when GitHub reports the PR mergeable (no conflict). */
  mergeable: boolean;
  /** True once the PR is already merged (act is a no-op then; P4). */
  merged: boolean;
  /**
   * Count of consecutive pushes whose CI failed (for the PARK rule). The
   * observer computes this from the PR's check-run history.
   */
  consecutive_ci_failures: number;
}

/** A lane as the PM observes it. */
export interface ObservedLane {
  slug: string;
  lane: string;
  vtid: string | null;
  state: LaneState;
  /** The seat that builds the lane. */
  seat: string;
  /** The seat (or `claude`) that reviews the lane. Never equal to `seat`. */
  reviewer_seat: string;
  /** The area the lane belongs to (used to pick the next seat on reassign). */
  area: string | null;
  /** Path globs the lane may change — required for merge eligibility. */
  paths: string[];
  /** Lane ids that must be `done` before this lane may merge. */
  depends_on: string[];
  /** The open PR for the lane, if any. */
  pr: ObservedPr | null;
  /** Review entries on the lane, newest last. */
  reviews: ReviewEntry[];
  /** Executing-log entries, for the self-review residual guard. */
  executing_log: ExecutingLogEntry[];
  /**
   * ISO timestamp the lane entered its current state (used for the 24h
   * reassign / 48h stale-claim timers).
   */
  state_since: string;
  /** ISO timestamp of the last commit on the lane's branch, if any. */
  last_branch_activity: string | null;
  /** ISO timestamp the lane was claimed, if any (stale-claim rule). */
  claimed_at: string | null;
  /**
   * True when an automation run for this lane's seat happened within the
   * reassign window. The observer derives it; false means "no automation ran".
   */
  seat_ran_automation_in_window: boolean;
  /** `verified` on staging (STAGING-VERIFY passed on the merged commit)? Gate-2 input. */
  staging_verified: boolean;
  /** Does this lane deploy anything? A non-deploying lane needs no Gate 2. */
  deploys: boolean;
  /** ISO timestamp this lane's merged commit first passed STAGING-VERIFY (Gate-2 timer). */
  staging_verified_at: string | null;
  /** True once a Gate 2 message has already been sent for this lane's plan. */
  gate2_sent: boolean;
}

/** The seat rotation for an area, used by the reassign rule. */
export interface AreaSeatRotation {
  area: string;
  /** Seats for the area, in rotation order. */
  seats: string[];
}

/** The whole observed world the pure decide step consumes. */
export interface ObservedState {
  mode: PmMode;
  lanes: ObservedLane[];
  /** Seat rotation per area (from docs/programs/areas.yaml). */
  rotations: AreaSeatRotation[];
}

// ---------------------------------------------------------------------------
// Decisions (typed, pure outputs — no side effects)
// ---------------------------------------------------------------------------

export type PmDecisionKind = 'merge' | 'reassign' | 'park' | 'gate2';

export interface MergeDecision {
  kind: 'merge';
  slug: string;
  lane: string;
  vtid: string;
  pr_url: string;
  head_sha: string;
}

export interface ReassignDecision {
  kind: 'reassign';
  slug: string;
  lane: string;
  /** 'lane' = a stale ready lane; 'review' = a stale pending review. */
  target: 'lane' | 'review';
  from_seat: string;
  /** The seat (or `claude`) the work moves to. */
  to_actor: string;
  reason: 'stale_ready_24h' | 'stale_review_24h';
}

export type ParkReason =
  | 'ci_failed_3_consecutive'
  | 'reviewer_flagged_risk'
  | 'stale_claim_48h';

export interface ParkDecision {
  kind: 'park';
  slug: string;
  lane: string;
  reason: ParkReason;
  /** True for the stale-claim rule — the claim is released. */
  release_claim: boolean;
}

export interface Gate2Decision {
  kind: 'gate2';
  /** The plan slug whose deploying lanes are ready for Gate 2. */
  slug: string;
  vtids: string[];
  reason: 'all_verified' | 'four_hours_elapsed';
}

export type PmDecision =
  | MergeDecision
  | ReassignDecision
  | ParkDecision
  | Gate2Decision;

/** Timing thresholds (plan §6.2), in milliseconds. Exported so tests pin them. */
export const REASSIGN_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
export const STALE_CLAIM_AFTER_MS = 48 * 60 * 60 * 1000; // 48h
export const GATE2_BATCH_AFTER_MS = 4 * 60 * 60 * 1000; // 4h
export const CI_FAIL_PARK_THRESHOLD = 3;

/** Checks that must be green on the head for a merge (plan §6.2). */
export const REQUIRED_MERGE_CHECKS = ['Lane scope', 'Collab handoff'] as const;
/** The optional GitHub App check: when present on the head it must be success. */
export const CLAUDE_APPROVALS_CHECK = 'Claude Approvals';

// ---------------------------------------------------------------------------
// Act layer (VTID-05217 / P4) — the piece that ACTS on P3's decisions in `live`.
// ---------------------------------------------------------------------------

/**
 * Governance paths (plan §1). A lane whose `paths` match any of these may only
 * be merged by the PM when its reviewer is `claude` — the act layer's final
 * guard (plan §6.3 "Never: merge a PR that touches a governance path unless its
 * reviewer is claude"). Prefix match against each lane path glob.
 */
export const GOVERNANCE_PATHS = [
  '.github/',
  '.claude/',
  '.kiro/steering/',
  '.kiro/automations/',
  'scripts/collab/',
  'CLAUDE.md',
  'docs/programs/areas.yaml',
] as const;

/** The reviewer value that unlocks a governance-path merge. */
export const GOVERNANCE_REVIEWER = 'claude';

/** The session trailer the PM stamps on its own lane-file commits (plan §6.3, R1 F6). */
export const PM_SESSION = 'pm-agent';

/** The Operator Chat Gate-2 question (the existing run-view wording, plan §6.3). */
export const GATE2_QUESTION = 'Staging verified — ready for deployment to production?';

/** Per-decision act outcome, reported back for the status snapshot and tests. */
export type ActStatus =
  | 'merged'
  | 'already_merged'
  | 'merge_refused'
  | 'governance_blocked'
  | 'reassigned'
  | 'parked'
  | 'gate2_posted'
  | 'skipped_not_live'
  | 'skipped_no_lease';

/** The result of acting on one decision. */
export interface ActResult {
  decision: PmDecision;
  status: ActStatus;
  /** Human-readable detail (merge sha, refusal reason, park reason, etc.). */
  detail?: string;
}

/** The commit list between production and the verified commit, for a Gate-2 message. */
export interface Gate2Evidence {
  /** The verified (staging) commit the Gate-2 message is pinned to. */
  verified_commit: string;
  /** The commit currently live in production. */
  production_commit: string;
  /** Every commit between production and the verified commit (oldest→newest). */
  commits: string[];
}
