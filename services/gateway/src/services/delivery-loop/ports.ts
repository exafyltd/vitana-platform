/**
 * Delivery loop: the ports. Everything the loop does to the world besides GitLab and the ledger goes through one of these, and each
 * production adapter is a governed path that already exists (Dev Autopilot's executor, the repair-pattern store, the dev memory, the
 * LLM router). The engine never builds a parallel execution path and never allocates a VTID: it hands a task to the executor and the
 * executor's own safety gates (kill switch, scope, budget, concurrency) apply unchanged.
 */
import type { GitlabDiffFile, GitlabMergeRequest } from './types';

// ---------------------------------------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------------------------------------

export type TaskKind = 'intake' | 'repair' | 'rework';

export interface TaskRequest {
  /** The work key: one key never starts two executions, however often it is dispatched. */
  key: string;
  kind: TaskKind;
  project: string;
  /** A short title for the task and the merge request it opens. */
  title: string;
  /** What to do, in English. Text taken from GitLab (an issue, a log) is quoted as data inside it, never as an instruction to the executor's rules. */
  instructions: string;
  /** The branch the change is based on and merges into. */
  base_branch: string;
  /** An existing branch to continue on (a repair or rework of a merge request); absent for a new branch. */
  fix_branch: string | null;
  mr_iid: number | null;
  issue_iid: number | null;
  /** What is known that may help: the pattern of an earlier verified repair of the same failure. */
  hints: string[];
  /**
   * The attempt (the intent's key): an executor starts at most one execution per dispatch key. `key` is the work, shared by every
   * attempt at one failure, so deduplicating on `key` would turn attempt 2 into a no-op. Optional only for callers that predate it.
   */
  dispatch_key?: string;
  /** A repair: the pipeline that failed, its head and the merge request's address, as GitLab reported them when the attempt was decided. */
  repair?: { pipeline_id: number; sha: string | null; mr_url: string | null } | null;
}

export type DispatchResult =
  | { ok: true; task_id: string; vtid: string | null; execution_id: string | null }
  | { ok: false; error: string; /** True when the same dispatch may work later (the executor is busy or down). */ retryable: boolean };

export interface TaskPort {
  dispatch(request: TaskRequest): Promise<DispatchResult>;
}

/**
 * What the executor adapter needs from Dev Autopilot, as a small interface so the adapter is tested without it: `enqueue` hands the task
 * to Dev Autopilot's executor and answers the execution it made, or why it refused. The bound implementation is GitLab-native
 * (dev-autopilot-gateway.ts): a repair of a failed GitLab merge-request pipeline becomes an execution on that merge request's own
 * branch, run by the existing executor and agent runner, never a GitHub PR. Defined here, with the other ports, so the executor and
 * the runtime that binds it both depend on the engine and not on each other (plan delivery-loop-engine §5).
 */
export interface ExecutorGateway {
  enqueue(request: TaskRequest): Promise<{ ok: true; execution_id: string; vtid: string | null } | { ok: false; error: string; retryable: boolean }>;
}

// ---------------------------------------------------------------------------------------------------------
// The reviewer
// ---------------------------------------------------------------------------------------------------------

export interface ReviewVerdict {
  verdict: 'accept' | 'changes';
  summary: string;
  /** What must change, one item each, when the verdict is `changes`. */
  findings: string[];
  model: string | null;
  /** The head commit the verdict is about. A verdict on an older head means nothing. */
  reviewed_head: string;
}

export interface ReviewerPort {
  review(input: { project: string; mr: GitlabMergeRequest; diffs: GitlabDiffFile[] }): Promise<{ ok: true; data: ReviewVerdict } | { ok: false; error: string }>;
}

// ---------------------------------------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------------------------------------

export interface RepairLesson {
  project: string;
  fingerprint: string;
  failure_class: string;
  jobs: string[];
  excerpt: string[];
  attempts: number;
  /** The merge request that carries the fix. */
  mr_url: string | null;
  work_key: string | null;
}

export interface OutcomeLesson {
  project: string;
  /** `repair_exhausted`, `intake_delivered`, `review_rework`, `recurring_failure` ... */
  kind: string;
  /** A sentence for the next planner: what happened and what it means. */
  summary: string;
  tags: string[];
  refs: Record<string, string | number>;
}

export interface KnownFix {
  fingerprint: string;
  summary: string;
  success_count: number;
}

export interface LearnPort {
  /** A verified repair: the pattern is stored so the same failure meets its known fix. */
  recordRepair(lesson: RepairLesson): Promise<{ ok: boolean; error?: string }>;
  /** What happened, for the memory the planners read. */
  recordOutcome(lesson: OutcomeLesson): Promise<{ ok: boolean; error?: string }>;
  /** The verified repair of this failure, when one is known. */
  findKnownFix(project: string, fingerprint: string): Promise<KnownFix | null>;
}
