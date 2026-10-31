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

/**
 * A review verdict recorded by the reviewer seat (collaboration.md §7).
 * VTID-05274: `accept` is the reviewer agent's verdict (`Collab-Verdict`, plan
 * kiro-autonomy-fallback §4.1); `approve` stays the legacy seat verdict.
 */
export type ReviewVerdict = 'approve' | 'accept' | 'changes' | 'risk';

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
  /**
   * VTID-05274: the `Collab-Reviewer` value, e.g.
   * `agent:vitana-lane-reviewer (claude-sonnet-5.5)`; null/absent for a legacy seat review.
   */
  reviewer?: string | null;
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
  /**
   * VTID-05274: earlier heads H such that every commit in H..head only appends
   * review entries / PM lane-state lines to this lane's file (plan §4.1
   * "current head"). Observer-computed; absent = none.
   */
  review_only_since?: string[];
  /** VTID-05274: files changed by the PR (protected-file check). Absent = unknown (lane paths are checked). */
  files?: string[];
  /** VTID-05274: commits the PR head is behind `main` (merge-queue semantics). Absent = 0. */
  behind_by?: number;
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
  /** True once a Gate 2 message has already been sent for this lane (its verified commit). */
  gate2_sent: boolean;
  /** VTID-05274: the repository the lane lives in (`owner/name`). */
  repo?: string;
  /**
   * VTID-05274: committer date of the plan driver's heartbeat ref
   * `refs/heads/collab-driver/<slug>` (plan §4.7). `null` = no driver ref;
   * absent = not observed (treated like a live driver: today's 24 h / 48 h).
   */
  driver_heartbeat_at?: string | null;
  /** VTID-05274: the lane VTID's `vtid_ledger.status`, when observed. */
  ledger_status?: string | null;
  /** VTID-05274: "Decisions taken" lines from the lane log (quoted in Gate 2). */
  decisions_taken?: string[];
}

/**
 * VTID-05274 — inputs to the Claude availability rule (plan §3), read by the
 * observer each tick. The rule itself is pure (`claudeAvailability`).
 */
export interface ObservedClaude {
  /** The `CLAUDE_AVAILABLE` repo variable (`false` → false, `true` → true), env fallback; null when unknown. */
  flag: boolean | null;
  /** `updated` of the oldest open item with `next_actor: claude`, ISO; null when none. */
  oldest_assigned_at: string | null;
  /** Newest commit with a `Collab-Session: session_…` trailer (main or an open PR head), ISO; null when none seen. */
  last_action_at: string | null;
}

export type ClaudeUnavailableReason = 'flag_false' | 'no_action_4h';
export type ClaudeAvailability =
  | { available: true; reason: null }
  | { available: false; reason: ClaudeUnavailableReason };

/** VTID-05274: the sparring session a `plan(` PR's head points at (read-only). */
export interface ObservedPlanSparring {
  session_id: string;
  producer: string | null;
  verdict: string | null;
  policy_approved_at: string | null;
  final_plan_hash: string | null;
}

/** VTID-05274: an open `plan(<slug>)` PR (merge_plan rule, plan §5 C3). */
export interface ObservedPlanPr {
  slug: string;
  url: string;
  title: string;
  head_sha: string;
  /** `Collab-Session` trailer of the head commit (`ci-plan-spar` for PLAN-SPAR's own commit). */
  head_commit_session: string | null;
  files: string[];
  checks: CheckRun[];
  mergeable: boolean;
  merged: boolean;
  behind_by?: number;
  /** `state` of the spec's handoff.md at the PR head. */
  handoff_state: string | null;
  /** `vtids` of the spec's handoff.md at the PR head. */
  vtids: string[];
  /** Canonical hash of the head `plan.md` (plan-sparring/canonical-hash.ts). */
  head_plan_hash: string | null;
  sparring: ObservedPlanSparring | null;
}

/** VTID-05274: an open W2 bookkeeping PR `pm-agent/<slug>` (plan §4.5). */
export interface ObservedBookkeepingPr {
  slug: string;
  url: string;
  title: string;
  head_sha: string;
  files: string[];
  checks: CheckRun[];
  mergeable: boolean;
  merged: boolean;
  behind_by?: number;
  /** `Collab-Session` of every commit on the PR. */
  commit_sessions: string[];
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
  /** VTID-05274: Claude availability inputs. Absent = Claude available (today's routing). */
  claude?: ObservedClaude;
  /** VTID-05274: open `plan(` PRs. */
  plan_prs?: ObservedPlanPr[];
  /** VTID-05274: open PM bookkeeping PRs. */
  bookkeeping_prs?: ObservedBookkeepingPr[];
}

// ---------------------------------------------------------------------------
// Decisions (typed, pure outputs — no side effects)
// ---------------------------------------------------------------------------

export type PmDecisionKind =
  | 'merge'
  | 'reassign'
  | 'park'
  | 'gate2'
  // VTID-05274 (plan kiro-autonomy-fallback §5 C3/C4)
  | 'verify'
  | 'update_branch'
  | 'merge_plan'
  | 'merge_bookkeeping'
  | 'ledger';

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
  /** VTID-05274: the window is 24 h with a live plan driver, 2 h without (`window_ms`). */
  reason: 'stale_ready' | 'stale_review';
  window_ms: number;
  /** VTID-05274: true when the work went to the exceptions seat because Claude is unavailable. */
  fallback: boolean;
}

export type ParkReason =
  | 'ci_failed_3_consecutive'
  | 'reviewer_flagged_risk'
  | 'stale_claim';

export interface ParkDecision {
  kind: 'park';
  slug: string;
  lane: string;
  reason: ParkReason;
  /** True for the stale-claim rule — the claim is released. */
  release_claim: boolean;
  /** VTID-05274: who the parked lane goes to (`claude`, or the exceptions seat when Claude is unavailable). Absent = claude. */
  to_actor?: string;
  /** VTID-05274: true when `to_actor` is the exceptions seat because Claude is unavailable. */
  fallback?: boolean;
  /** VTID-05274: the stale-claim window applied (48 h with a live driver, 4 h without). */
  window_ms?: number;
}

export interface Gate2Decision {
  kind: 'gate2';
  /** The plan slug whose deploying lanes are ready for Gate 2. */
  slug: string;
  vtids: string[];
  reason: 'all_verified' | 'four_hours_elapsed';
}

/** VTID-05274 W1 (plan §4.5): an `in-review` lane with an agent accept on the current head → `verified`. */
export interface VerifyDecision {
  kind: 'verify';
  slug: string;
  lane: string;
  vtid: string;
  pr_url: string;
  head_sha: string;
}

/** VTID-05274: a merge-eligible PR that is behind `main` is brought up to date first (`PUT …/update-branch`). */
export interface UpdateBranchDecision {
  kind: 'update_branch';
  slug: string;
  lane: string;
  pr_url: string;
  head_sha: string;
  behind_by: number;
}

/** VTID-05274: a converged, policy-approved, spec-only `plan(<slug>)` PR is merged. */
export interface MergePlanDecision {
  kind: 'merge_plan';
  slug: string;
  vtid: string;
  pr_url: string;
  head_sha: string;
}

/** VTID-05274 W2: the PM's own bookkeeping PR `pm-agent/<slug>` is merged on green. */
export interface MergeBookkeepingDecision {
  kind: 'merge_bookkeeping';
  slug: string;
  vtid: string;
  pr_url: string;
  head_sha: string;
}

/** VTID-05274: a lane being built moves its ledger row to in_progress / approved (idempotent). */
export interface LedgerDecision {
  kind: 'ledger';
  slug: string;
  lane: string;
  vtid: string;
  set: { status: 'in_progress'; spec_status: 'approved' };
}

export type PmDecision =
  | MergeDecision
  | ReassignDecision
  | ParkDecision
  | Gate2Decision
  | VerifyDecision
  | UpdateBranchDecision
  | MergePlanDecision
  | MergeBookkeepingDecision
  | LedgerDecision;

/** Timing thresholds (plan §6.2), in milliseconds. Exported so tests pin them. */
export const REASSIGN_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
export const STALE_CLAIM_AFTER_MS = 48 * 60 * 60 * 1000; // 48h
export const GATE2_BATCH_AFTER_MS = 4 * 60 * 60 * 1000; // 4h
export const CI_FAIL_PARK_THRESHOLD = 3;

// VTID-05274 (plan kiro-autonomy-fallback §3, §4.7, §5 C3).
/** Reassign window when the plan's driver is not alive. */
export const REASSIGN_NO_DRIVER_AFTER_MS = 2 * 60 * 60 * 1000; // 2h
/** Stale-claim window when the plan's driver is not alive. */
export const STALE_CLAIM_NO_DRIVER_AFTER_MS = 4 * 60 * 60 * 1000; // 4h
/** A driver is alive while its heartbeat ref's committer date is younger than this. */
export const DRIVER_ALIVE_MS = 45 * 60 * 1000; // 45 min
/** Claude counts as unavailable when an item assigned to it has waited this long with no Claude action. */
export const CLAUDE_NO_ACTION_AFTER_MS = 4 * 60 * 60 * 1000; // 4h
/** Every job that goes to Claude today goes here when Claude is unavailable. */
export const EXCEPTIONS_SEAT = 'exafyltd';
/** No ready lane is reassigned into a plan that already builds this many lanes (executing|in-review). */
export const MAX_BUILD_LANES_PER_PLAN = 6;

/** Checks that must be green on the head for a merge (plan §6.2). */
export const REQUIRED_MERGE_CHECKS = ['Lane scope', 'Collab handoff'] as const;
/** The optional GitHub App check: when present on the head it must be success. */
export const CLAUDE_APPROVALS_CHECK = 'Claude Approvals';

// ---------------------------------------------------------------------------
// Act layer (VTID-05217 / P4) — the piece that ACTS on P3's decisions in `live`.
// ---------------------------------------------------------------------------

/**
 * Governance paths and the legacy governance reviewer moved to governance.ts
 * (VTID-05274, the protected PM governance guard); re-exported here so no
 * import breaks.
 */
export { GOVERNANCE_PATHS, GOVERNANCE_REVIEWER } from './governance';

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
  // VTID-05414: the writer found nothing to change (no commit, no push).
  | 'unchanged'
  | 'parked'
  | 'gate2_posted'
  | 'skipped_not_live'
  | 'skipped_no_lease'
  // VTID-05274
  | 'verified_written'
  | 'branch_updated'
  | 'update_refused'
  | 'plan_merged'
  | 'ledger_updated'
  | 'ledger_failed'
  | 'act_error';

/** The result of acting on one decision. */
export interface ActResult {
  decision: PmDecision;
  status: ActStatus;
  /** Human-readable detail (merge sha, refusal reason, park reason, etc.). */
  detail?: string;
}

/** VTID-05274 (plan §4.6): one plan's timings, `docs/validation/<plan VTID>/timings.json`. */
export interface PlanLaneTimings {
  lane: string;
  vtid: string;
  claimed_at: string | null;
  pr_opened_at: string | null;
  accepted_at: string | null;
  merged_at: string | null;
  staging_verified_at: string | null;
  build_ms: number | null;
  review_ms: number | null;
  merge_ms: number | null;
  review_rounds: number;
  ci_fix_attempts: number;
}
export interface PlanTimings {
  schema: 'vitana.plan-timings/v1';
  plan_slug: string;
  vtid: string;
  vtids: string[];
  generated_at: string;
  generated_by: string;
  plan_pr_opened_at: string | null;
  converged_at: string | null;
  policy_approved_at: string | null;
  vtids_allocated_at: string | null;
  plan_merged_at: string | null;
  gate2_sent_at: string | null;
  convergence_ms: number | null;
  vtid_ms: number | null;
  plan_merge_ms: number | null;
  lanes: PlanLaneTimings[];
  staging_verify_ms: number | null;
  approved_to_verified_ms: number | null;
  merge_conflict_count: number;
  staging_verify_failure_count: number;
  sources_unavailable: string[];
}

/** The commit list between production and the verified commit, for a Gate-2 message. */
export interface Gate2Evidence {
  /** The verified (staging) commit the Gate-2 message is pinned to. */
  verified_commit: string;
  /** The commit currently live in production. */
  production_commit: string;
  /** Every commit between production and the verified commit (oldest→newest). */
  commits: string[];
  // VTID-05274 (plan §5 C5): the rest of the owner's Gate 2 contract.
  /** Per service: the verified staging commit and the production commit. */
  services?: Array<{ service: 'gateway' | 'community-app'; repo: string; verified_commit: string | null; production_commit: string | null }>;
  /** Each STAGING-VERIFY pass: run link and test counts (null when the record has none). */
  staging_verify?: Array<{ service: string; run_url: string | null; passed: number | null; failed: number | null; total: number | null }>;
  /** `supabase/migrations/*` files in production..verified. */
  migrations?: string[];
  /** "Decisions taken" lines from the plan's lane logs (`<lane>: <text>`). */
  decisions_taken?: string[];
  /** The plan's timings (§4.6). */
  timings?: PlanTimings | null;
  /** Sources that failed open (run-view posture). */
  unavailable?: string[];
}
