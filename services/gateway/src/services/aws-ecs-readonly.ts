/**
 * AWS ECS read-only status client — VTID-03836.
 *
 * Backs the Operator Console's `dev_aws_ecs_status` tool: "what's the state
 * of ECS service X" for the services in CLAUDE.md §1b's table, resolved
 * dynamically via `DescribeServicesCommand` — never a hardcoded task count,
 * IP, or URL (CLAUDE.md §1b hard rule).
 *
 * DELIBERATELY a separate module and a separate cached client from
 * `aws-ecs-admin.ts`. That module's `ECSClient` runs under the gateway
 * task's IAM role, which already grants `ecs:RunTask` (it dispatches the
 * autopilot-executor job) — reusing it here would mean this "read-only"
 * tool actually executes under a role broad enough to launch tasks, which
 * is exactly the credential-widening this tool must not do.
 *
 * KNOWN GAP, DO NOT ENABLE IN ANY REAL ENVIRONMENT UNTIL THIS IS CLOSED:
 * a truly narrower role needs either a dedicated IAM role assumed via STS
 * (this repo has no `@aws-sdk/client-sts` / `@aws-sdk/credential-providers`
 * dependency yet — adding one is a declared `DEPENDENCY_CHANGE` this VTID
 * deliberately does not make) or a distinct ECS task role attached to a
 * process that isn't also the deploy-capable gateway container. Absent
 * that, this client falls back to the SAME default credential chain as
 * `aws-ecs-admin.ts` and therefore the SAME broad role — so today it is
 * NOT yet the narrowly-scoped read-only surface CLAUDE.md's own AWS
 * hard rules require. `OPERATOR_AWS_READONLY_ENABLED` therefore ships
 * default-OFF and is NOT pinned on any deploy workflow by this VTID; the
 * IAM work is a separate, explicit follow-up before this can be turned on
 * anywhere, staging included.
 */

import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';

const REGION = process.env.AWS_ECS_REGION || process.env.AWS_REGION || 'eu-central-1';
const CLUSTER = process.env.AWS_ECS_CLUSTER || 'Vitana-ECS-Cluster';

// Allowlist of service names this tool may describe — matches CLAUDE.md
// §1b's table verbatim. An unlisted name is refused before any AWS call is
// made, so a typo or a name outside the documented fleet can't probe for
// undocumented infrastructure (CLAUDE.md: "never assume a service not in
// the §1b table has AWS infrastructure").
export const ALLOWED_ECS_SERVICES = [
  'vitana-gateway-awsdr',
  'vitana-gateway',
  'vitana-community-app-awsdr',
  'vitana-community-app-staging',
  'vitana-oasis-operator-awsdr',
  'vitana-oasis-projector',
  'vitana-worker-runner',
  'vitana-vitana-verification-engine',
  'vitana-orb-agent',
] as const;

let cachedReadonlyClient: ECSClient | null = null;

function getReadonlyClient(): ECSClient {
  if (!cachedReadonlyClient) {
    cachedReadonlyClient = new ECSClient({ region: REGION });
  }
  return cachedReadonlyClient;
}

export interface EcsServiceStatus {
  serviceName: string;
  status: string;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  taskDefinition: string;
  deployments: Array<{ status: string; desiredCount: number; runningCount: number; rolloutState?: string }>;
}

/**
 * Describe one or more ECS services by name. Read-only — never calls
 * UpdateService/RunTask/RegisterTaskDefinition. Rejects any name not in
 * `ALLOWED_ECS_SERVICES` without making an AWS call.
 */
export async function describeEcsServices(serviceNames: string[]): Promise<EcsServiceStatus[]> {
  const unknown = serviceNames.filter((s) => !(ALLOWED_ECS_SERVICES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw new Error(`Unknown/undocumented ECS service(s): ${unknown.join(', ')} — not in the CLAUDE.md §1b fleet`);
  }
  const client = getReadonlyClient();
  const res = await client.send(new DescribeServicesCommand({ cluster: CLUSTER, services: serviceNames }));
  return (res.services || []).map((svc) => ({
    serviceName: svc.serviceName || '',
    status: svc.status || 'UNKNOWN',
    desiredCount: svc.desiredCount ?? 0,
    runningCount: svc.runningCount ?? 0,
    pendingCount: svc.pendingCount ?? 0,
    taskDefinition: svc.taskDefinition || '',
    deployments: (svc.deployments || []).map((d) => ({
      status: d.status || '',
      desiredCount: d.desiredCount ?? 0,
      runningCount: d.runningCount ?? 0,
      rolloutState: d.rolloutState,
    })),
  }));
}
