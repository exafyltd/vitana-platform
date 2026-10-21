/**
 * VTID-04215: the deploy-event contract between the AWS deploy workflows
 * and the Dev Autopilot deploy watcher / reconciler.
 *
 * Root cause this module closes: `AWS-STAGE-DEPLOY-GATEWAY.yml` records a
 * finished deploy in `oasis_events` under topic `staging.deploy.completed`
 * (`staging.deploy.failed` on failure; the prod workflow uses
 * `prod.deploy.completed` / `prod.deploy.failed`). The deploy watcher
 * (`dev-autopilot-watcher.ts`) and the deploying-stage reconciler
 * (`dev-autopilot-execute.ts`) only ever queried the GCP-era topics
 * (`deploy.gateway.success`, `cicd.deploy.service.succeeded`, …) that the
 * dead `EXEC-DEPLOY.yml` used to emit. No AWS deploy has ever produced one
 * of those, so no auto-merged execution could pass `deploying`: after the
 * 30-minute reconciler timeout every one was marked failed and the bridge
 * REVERTED the merge from `main`. Measured 2026-09-20: executions 141c4e4b
 * (VTID-04134) and f64f22e2 (VTID-04135) auto-merged at 20:06/20:11 UTC,
 * both staging deploys succeeded by 20:23 UTC (runs 473/474), both were
 * reverted at 20:38/20:43 UTC with "no deploy success event observed".
 *
 * Contract:
 *   - `deployTopicsForEnv(env)` is the ONLY list of topics either consumer
 *     queries: the AWS topics for the process's own environment (a staging
 *     gateway must never take a production deploy as proof its merge
 *     shipped, and vice versa) plus the legacy topics, kept so a still-
 *     stored legacy event keeps working.
 *   - `normalizeDeployEvent()` maps an `oasis_events` row onto the shape
 *     `findDeployOutcomeForExecution()` already understands (`type`
 *     `deploy.gateway.success` / `deploy.gateway.failed`, payload carrying
 *     `git_commit`), defaulting `branch` to `main` for the AWS topics —
 *     both AWS workflows only ever deploy `main`, and the watcher's
 *     queued-merge fallback keys on `branch === 'main'`.
 *   - `resolveDeployOutcome()` is the reconciler's pure decision: an exact
 *     `git_commit === merge_sha` match first, then the same queued-merge
 *     fallback the watcher applies (a later successful `main` deploy after
 *     the merge means the merge is in it — git is linear), fail beating
 *     success in the window.
 *
 * `test/vtid-04215-deploy-event-contract.test.ts` reads both workflow
 * files and fails if the topic strings there drift from this module.
 */

export const LEGACY_DEPLOY_SUCCESS_TOPICS: readonly string[] = [
  'deploy.gateway.success',
  'cicd.deploy.service.succeeded',
  'deploy.success',
  'vtid.lifecycle.deployed',
];
export const LEGACY_DEPLOY_FAILURE_TOPICS: readonly string[] = [
  'deploy.gateway.failed',
  'cicd.deploy.service.failed',
];

export type DeployEnv = 'staging' | 'production';

/** Topic strings exactly as the AWS deploy workflows write them. */
export const AWS_DEPLOY_TOPICS: Record<DeployEnv, { success: string; failure: string; workflow: string }> = {
  staging: { success: 'staging.deploy.completed', failure: 'staging.deploy.failed', workflow: 'AWS-STAGE-DEPLOY-GATEWAY.yml' },
  production: { success: 'prod.deploy.completed', failure: 'prod.deploy.failed', workflow: 'AWS-PROD-DEPLOY-GATEWAY.yml' },
};

export const NORMALIZED_SUCCESS_TYPE = 'deploy.gateway.success';
export const NORMALIZED_FAILURE_TYPE = 'deploy.gateway.failed';

export function toDeployEnv(env: string | undefined | null): DeployEnv {
  return env === 'staging' ? 'staging' : 'production';
}

/** Every topic a consumer running in `env` should query. */
export function deployTopicsForEnv(env: string | undefined | null): string[] {
  const aws = AWS_DEPLOY_TOPICS[toDeployEnv(env)];
  return [aws.success, aws.failure, ...LEGACY_DEPLOY_SUCCESS_TOPICS, ...LEGACY_DEPLOY_FAILURE_TOPICS];
}

/** PostgREST `topic=in.(…)` filter value for `deployTopicsForEnv`. */
export function deployTopicsInFilter(env: string | undefined | null): string {
  return `in.(${deployTopicsForEnv(env).join(',')})`;
}

export interface DeployEventRow {
  topic: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  status?: string;
  id?: string;
}

export interface NormalizedDeployEvent {
  type: string;
  payload: Record<string, unknown>;
  created_at?: string;
  status?: string;
  id?: string;
  /** The topic as stored, for telemetry. */
  topic: string;
}

/**
 * Map a stored row onto the watcher's event shape. AWS topics become the
 * normalized success/failure types with `branch` defaulted to `main` and
 * `env` carried from the workflow's metadata; legacy topics pass through
 * unchanged (their payload IS their metadata, as before).
 */
export function normalizeDeployEvent(row: DeployEventRow): NormalizedDeployEvent {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const base = { created_at: row.created_at, status: row.status, id: row.id, topic: row.topic };
  for (const env of Object.keys(AWS_DEPLOY_TOPICS) as DeployEnv[]) {
    const t = AWS_DEPLOY_TOPICS[env];
    if (row.topic === t.success || row.topic === t.failure) {
      return {
        ...base,
        type: row.topic === t.success ? NORMALIZED_SUCCESS_TYPE : NORMALIZED_FAILURE_TYPE,
        payload: { ...metadata, branch: typeof metadata.branch === 'string' ? metadata.branch : 'main', env: typeof metadata.env === 'string' ? metadata.env : env },
      };
    }
  }
  return { ...base, type: row.topic, payload: { ...metadata } };
}

export function isDeploySuccessType(type: string): boolean {
  return type === NORMALIZED_SUCCESS_TYPE || LEGACY_DEPLOY_SUCCESS_TOPICS.includes(type);
}

export function isDeployFailureType(type: string, status?: string): boolean {
  return type === NORMALIZED_FAILURE_TYPE || LEGACY_DEPLOY_FAILURE_TOPICS.includes(type) || status === 'error';
}

export type DeployOutcome = 'success' | 'failed' | 'pending';

export interface ResolveDeployOutcomeInput {
  /** The squash-merge commit the watcher stamped on the execution. */
  mergeSha?: string | null;
  /** Watermark: events created before this instant cannot be this merge's deploy. */
  sinceIso?: string | null;
}

/**
 * The reconciler's decision for a `deploying` row, pure. Returns which event
 * proved it so the caller can record `matched_by` / the event id.
 */
export function resolveDeployOutcome(
  events: NormalizedDeployEvent[],
  input: ResolveDeployOutcomeInput,
): { outcome: DeployOutcome; matched?: NormalizedDeployEvent; matched_by?: 'merge_sha' | 'post_merge_main' | 'recency' } {
  const since = input.sinceIso ? new Date(input.sinceIso).getTime() : 0;
  const fresh = events.filter((e) => {
    const created = e.created_at ? new Date(e.created_at).getTime() : 0;
    return created >= since;
  });
  const mergeSha = input.mergeSha || null;
  if (mergeSha) {
    const exact = fresh.filter((e) => typeof e.payload.git_commit === 'string' && e.payload.git_commit === mergeSha);
    const exactFail = exact.find((e) => isDeployFailureType(e.type, e.status));
    if (exactFail) return { outcome: 'failed', matched: exactFail, matched_by: 'merge_sha' };
    const exactOk = exact.find((e) => isDeploySuccessType(e.type));
    if (exactOk) return { outcome: 'success', matched: exactOk, matched_by: 'merge_sha' };
    // Queued-merge fallback (VTID-02700's reasoning, now applied here too):
    // GitHub Actions `concurrency` cancels the intermediate deploy runs when
    // several merges land close together (run 478 on 2026-09-20 was
    // cancelled exactly this way), so the exact SHA may never deploy on its
    // own. A later successful `main` deploy after the merge carries it.
    const postMerge = fresh.filter((e) => e.payload.branch === 'main' || e.payload.head_branch === 'main');
    const fail = postMerge.find((e) => isDeployFailureType(e.type, e.status));
    if (fail) return { outcome: 'failed', matched: fail, matched_by: 'post_merge_main' };
    const ok = postMerge.find((e) => isDeploySuccessType(e.type));
    if (ok) return { outcome: 'success', matched: ok, matched_by: 'post_merge_main' };
    return { outcome: 'pending' };
  }
  // No merge_sha (a row from before VTID-02697): the original "any recent
  // deploy success" behaviour, unchanged.
  const anyFail = fresh.find((e) => isDeployFailureType(e.type, e.status));
  if (anyFail) return { outcome: 'failed', matched: anyFail, matched_by: 'recency' };
  const anyOk = fresh.find((e) => isDeploySuccessType(e.type));
  if (anyOk) return { outcome: 'success', matched: anyOk, matched_by: 'recency' };
  return { outcome: 'pending' };
}
