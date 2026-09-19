/**
 * Deployment live-status + commit-pinned redeploy — VTID-04117.
 *
 * The three existing Command Hub deployment-history screens (Overview >
 * Release Feed, Operator > Deployments, Infrastructure > Deployments) all
 * render rows from `software_versions` — the deploy LOG. None of them asks
 * AWS "what is actually running right now", which is the exact gap that let
 * PR #1114 sit broken on 100% of `vitana-community-app-awsdr` production
 * with a green-looking deploy history and no screen able to show the
 * mismatch (VTID-04115).
 *
 * This module holds the pure, testable pieces backing
 * `GET /operator/deployments/live-status` and
 * `POST /operator/deployments/redeploy` (`routes/operator.ts`) — the route
 * handlers themselves only wire these to the AWS/Supabase calls.
 *
 * Gateway is deliberately NOT wired for `/redeploy`: AWS-PROD-DEPLOY-
 * GATEWAY.yml has no "rebuild an arbitrary past commit" `deploy_mode`
 * (only promote-staging / rebuild-main / env-only), and its task-def build
 * step is already near GitHub Actions' ~21,000-char per-step expression
 * limit (VTID-03709's own comment) — adding a fourth mode there is a
 * separate, more careful change.
 */

export type LiveStatusKind = 'gateway' | 'frontend';

export interface LiveStatusTarget {
  service: string;
  environment: 'production' | 'staging';
  ecsService: string;
  kind: LiveStatusKind;
}

/** The §1b services this strip covers. `service` matches `software_versions.service` verbatim. */
export const LIVE_STATUS_TARGETS: LiveStatusTarget[] = [
  { service: 'gateway', environment: 'production', ecsService: 'vitana-gateway-awsdr', kind: 'gateway' },
  { service: 'gateway-staging', environment: 'staging', ecsService: 'vitana-gateway', kind: 'gateway' },
  { service: 'vitana-community-app-awsdr', environment: 'production', ecsService: 'vitana-community-app-awsdr', kind: 'frontend' },
  { service: 'vitana-community-app-staging', environment: 'staging', ecsService: 'vitana-community-app-staging', kind: 'frontend' },
];

/**
 * Frontend (community-app) has no build-info endpoint, so `resolvedCommit`
 * is only ever populated for `kind: 'gateway'` — drift can only be computed
 * there. This is intentional, not a gap this function papers over: a
 * frontend deploy is verified by sampling the served JS chunk hash (see
 * CLAUDE.md "Verifying a frontend deploy actually shipped"), not by a
 * live-commit endpoint that does not exist.
 */
export function computeCommitDrift(
  kind: LiveStatusKind,
  resolvedCommit: string | null,
  loggedCommit: string | null,
): boolean {
  if (kind !== 'gateway') return false;
  if (!resolvedCommit || !loggedCommit) return false;
  return resolvedCommit.slice(0, 12) !== loggedCommit.slice(0, 12);
}

export interface EcsStatusSummary {
  status: string;
  desired_count: number;
  running_count: number;
  pending_count: number;
  rollout_state: string | null;
  task_definition: string;
}

export interface LiveStatusTargetResult {
  service: string;
  environment: 'production' | 'staging';
  ecs: EcsStatusSummary | null;
  resolved_commit: string | null;
  resolve_error: string | null;
  logged_commit: string | null;
  logged_at: string | null;
  drift: boolean;
  commit_verification: 'build-info' | 'not_available_here — static SPA has no build-info endpoint; sample the served JS chunk hash instead (see CLAUDE.md "Verifying a frontend deploy actually shipped")';
}

/** Pure assembly of one target's response shape from already-fetched data. */
export function buildLiveStatusTargetResult(
  target: LiveStatusTarget,
  ecs: EcsStatusSummary | null,
  resolvedCommit: string | null,
  resolveError: string | null,
  loggedCommit: string | null,
  loggedAt: string | null,
): LiveStatusTargetResult {
  return {
    service: target.service,
    environment: target.environment,
    ecs,
    resolved_commit: resolvedCommit,
    resolve_error: resolveError,
    logged_commit: loggedCommit,
    logged_at: loggedAt,
    drift: computeCommitDrift(target.kind, resolvedCommit, loggedCommit),
    commit_verification:
      target.kind === 'frontend'
        ? 'not_available_here — static SPA has no build-info endpoint; sample the served JS chunk hash instead (see CLAUDE.md "Verifying a frontend deploy actually shipped")'
        : 'build-info',
  };
}

/** Only community-app production supports a commit-pinned redeploy today (see module header). */
export const REDEPLOY_ALLOWED_SERVICE = 'vitana-community-app-awsdr';
export const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
export const REDEPLOY_REASON_MAX_LEN = 300;

export interface RedeployValidationResult {
  ok: boolean;
  error?: 'invalid_service' | 'invalid_commit' | 'missing_reason';
  detail?: string;
}

export function validateRedeployRequest(service: string, commit: string, reason: string): RedeployValidationResult {
  if (service !== REDEPLOY_ALLOWED_SERVICE) {
    return {
      ok: false,
      error: 'invalid_service',
      detail: `Only "${REDEPLOY_ALLOWED_SERVICE}" supports commit-pinned redeploy today — AWS-PROD-DEPLOY-GATEWAY.yml has no arbitrary-commit rebuild mode, and there is no staging workflow_dispatch input for this either.`,
    };
  }
  if (!COMMIT_SHA_RE.test(commit)) {
    return { ok: false, error: 'invalid_commit', detail: 'commit must be a 7-40 char hex SHA' };
  }
  if (!reason.trim()) {
    return { ok: false, error: 'missing_reason' };
  }
  return { ok: true };
}
