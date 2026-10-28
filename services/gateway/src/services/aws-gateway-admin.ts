/**
 * AWS gateway introspection for the Command Hub publish flow — VTID-03420.
 *
 * AWS analogue of cloud-run-admin.ts's describeService()/listRevisions(),
 * used by /api/v1/operator/publish and /revisions when
 * PUBLISH_TARGET_CLOUD=aws (post-VTID-03419, gateway.vitanaland.com is
 * served by ECS `vitana-gateway-awsdr`, promoted from ECS staging
 * `vitana-gateway`).
 *
 * Deliberately resolves state over HTTP (/api/v1/admin/build-info on the
 * public hostnames) rather than the ECS API, for two reasons:
 *  1. `vitana-ecs-task-role` has no ecs:Describe* permissions, and adding
 *     them needs IAM admin rights this deployment path doesn't assume.
 *  2. Build-info reports what a stack is actually SERVING, not what ECS
 *     says it should run — the functional-verification discipline from
 *     the VTID-03419 cutover (ECS healthStatus and DMS task status both
 *     produced false greens during that migration).
 *
 * The ECS-side resolution (task-def image lookup, register, roll) lives in
 * AWS-PROD-DEPLOY-GATEWAY.yml's promote-staging mode, which runs under the
 * GitHub OIDC deploy role that already has those permissions.
 */

export const AWS_STAGING_GATEWAY_URL =
  process.env.AWS_STAGING_GATEWAY_URL || 'https://preview-aws-gateway.vitanaland.com';
export const AWS_PROD_GATEWAY_URL =
  process.env.AWS_PROD_GATEWAY_URL || 'https://gateway.vitanaland.com';

export interface AwsGatewaySummary {
  /** 'staging' | 'production' — as self-reported by the stack's health env. */
  env: string | null;
  /** Full git commit SHA the stack is serving (GIT_COMMIT_SHA). */
  commitSha: string | null;
  /** Short (12-char) commit marker (BUILD_INFO_MARKER). */
  marker: string | null;
  /** ISO timestamp the serving container booted — proxy for deploy time. */
  bootedAt: string | null;
  /** The URL the summary was resolved from. */
  url: string;
}

async function fetchBuildInfo(baseUrl: string): Promise<AwsGatewaySummary> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(`${baseUrl}/api/v1/admin/build-info`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`aws-gateway-admin: ${baseUrl} build-info HTTP ${resp.status}`);
    }
    const data = await resp.json() as {
      env?: string;
      git_commit?: string;
      marker?: string;
      booted_at?: string;
    };
    return {
      env: data.env ?? null,
      commitSha: data.git_commit ?? null,
      marker: data.marker ?? (data.git_commit ? data.git_commit.slice(0, 12) : null),
      bootedAt: data.booted_at ?? null,
      url: baseUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve what the AWS staging gateway (`vitana-gateway`) is serving.
 * Throws if unreachable or if it does not self-report env=staging —
 * promoting from a stack that isn't staging is never OK.
 */
export async function describeAwsStagingGateway(): Promise<AwsGatewaySummary> {
  const summary = await fetchBuildInfo(AWS_STAGING_GATEWAY_URL);
  if (summary.env !== 'staging') {
    throw new Error(
      `aws-gateway-admin: ${AWS_STAGING_GATEWAY_URL} self-reports env='${summary.env}', expected 'staging' — refusing to treat it as the promotion source`,
    );
  }
  return summary;
}

/**
 * Resolve what the AWS production gateway (`vitana-gateway-awsdr`, behind
 * the canonical hostname) is serving. Resolved over HTTP rather than from
 * this process's own env so the answer is correct no matter which stack
 * happens to run the code asking.
 */
export async function describeAwsProdGateway(): Promise<AwsGatewaySummary> {
  return fetchBuildInfo(AWS_PROD_GATEWAY_URL);
}

/**
 * Shape an AwsGatewaySummary into the RevisionSummary row format the
 * Command Hub publish popover already consumes from the GCP-backed
 * /api/v1/operator/revisions — one synthetic "revision" per stack (ECS
 * has no Cloud-Run-style revision list to enumerate over HTTP; the
 * currently-serving build is the only row that matters to the popover).
 */
export function toRevisionRow(summary: AwsGatewaySummary): {
  name: string;
  shortName: string;
  image: string | null;
  createdAt: string;
  isActive: boolean;
  trafficPercent: number;
  commitSha: string | null;
} {
  return {
    name: summary.url,
    shortName: summary.marker ?? 'unknown',
    image: null,
    createdAt: summary.bootedAt ?? new Date(0).toISOString(),
    isActive: true,
    trafficPercent: 100,
    commitSha: summary.commitSha,
  };
}
