/**
 * Delivery loop: the shared types of the engine (services/delivery-loop).
 *
 * The loop closes observe -> reason -> plan -> execute -> verify -> learn -> improve over the GitLab delivery. It reads the facts
 * the GitLab webhook stage records in OASIS (services/gitlab-events), decides with pure policies, and acts only through ports,
 * each of which is a governed path that already exists (the operator on-ramp, self-healing intake, Dev Autopilot, the dev memory
 * and repair-pattern stores) or the GitLab REST API. Nothing here allocates a VTID or merges: VTIDs come from CI PLAN-SPAR, and
 * a merge is the merge bot's (scripts/eng/gitlab-land.mjs) or the Project Manager's.
 */

/** The repo's autonomy vocabulary (docs/autonomy/LOOP-ENGINEERING.md): observe, recommend, prepare for approval, act. */
export type Autonomy = 'L0' | 'L1' | 'L2' | 'L3';

/** What the loop may do at a level: `record` its decisions, `learn`, `prepare` work for approval, `act` on GitLab or the executor. */
export type LoopAction = 'record' | 'learn' | 'prepare' | 'act';

/** A GitLab project as `group/name`. */
export type ProjectPath = string;

/** One GitLab call's outcome. A failure never throws and never carries the token. */
export type GitlabResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

export interface GitlabIssue {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: 'opened' | 'closed' | string;
  labels: string[];
  web_url: string;
  confidential: boolean;
  updated_at: string;
}

export interface GitlabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  draft: boolean;
  source_branch: string;
  target_branch: string;
  sha: string | null;
  web_url: string;
  labels: string[];
  head_pipeline_id: number | null;
}

export interface GitlabPipeline {
  id: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  source: string | null;
}

export interface GitlabJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  failure_reason: string | null;
  allow_failure: boolean;
  web_url: string;
}

export interface GitlabDiffFile {
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  /** The unified diff of the file; GitLab leaves it empty for a diff it considers too large. */
  diff: string;
}

/** How a failed pipeline's jobs are classified: a retry fixes `infra`; only a change fixes `code`; `unknown` is not repaired. */
export type FailureClass = 'code' | 'infra' | 'unknown';

/** A job that failed its pipeline, as the webhook stage records it (failed_jobs of scm.gitlab.pipeline.failed). */
export interface FailedJobFact {
  id: number | null;
  name: string | null;
  stage: string | null;
  failure_reason: string | null;
  exit_code: number | null;
}
