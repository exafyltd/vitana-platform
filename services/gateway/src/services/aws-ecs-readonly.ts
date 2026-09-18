/**
 * AWS ECS read-only status client — VTID-03836.
 *
 * Backs the Operator Console's `dev_aws_ecs_status` tool: "what's the state
 * of ECS service X" for the services in CLAUDE.md §1b's table, resolved
 * dynamically via `DescribeServicesCommand` — never a hardcoded task count,
 * IP, or URL (CLAUDE.md §1b hard rule).
 *
 * DELIBERATELY a separate module and a separate cached client from
 * `aws-ecs-admin.ts`, kept as two files so a future narrower credential
 * path is a one-line change here rather than a refactor. This client runs
 * under the gateway task's own IAM role — the SAME broad role
 * `aws-ecs-admin.ts` uses, which already grants `ecs:RunTask` (it
 * dispatches the autopilot-executor job). A dedicated, narrower role
 * assumed via STS was proposed and deliberately rejected by the platform
 * owner (VTID-03929): "No way to do a narrow role. It must have the
 * maximum broad one... otherwise we are stuck in the process, repeating
 * unnecessary blockers." The operator is treated as a daily internal
 * development tool, not a customer-facing surface, and broad access is an
 * explicit, recorded product decision — not an oversight. Every call this
 * client makes is still read-only (`DescribeServicesCommand` only, never
 * `UpdateService`/`RunTask`/`RegisterTaskDefinition`) and still refuses any
 * service name outside `ALLOWED_ECS_SERVICES` before making an AWS call.
 * `OPERATOR_AWS_READONLY_ENABLED=true` is pinned on
 * `AWS-STAGE-DEPLOY-GATEWAY.yml` (VTID-03929) — staging only; enabling it
 * on prod is a separate, later decision.
 */

import { ECSClient, DescribeServicesCommand, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';

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

// ---------------------------------------------------------------------------
// VTID-04035 (W5c): task-level reads — ListTasks + DescribeTasks, read-only.
// The service-level view above answers "is the rollout healthy"; this one
// answers "which tasks are actually running / why did that one stop" — the
// question the VTID-04011 watchdog incident (a live agent task reclaimed as
// dead) and every one-shot executor run (no service, only a task family)
// could not be asked from the console. Same client, same broad task role
// (the recorded VTID-03929 decision), never StopTask/RunTask here.
// ---------------------------------------------------------------------------

/**
 * Task families this tool may list by `family` (one-shot tasks that have no
 * ECS service — CLAUDE.md §1b's autopilot-executor row). Services are still
 * addressed by name through ALLOWED_ECS_SERVICES.
 */
export const ALLOWED_ECS_TASK_FAMILIES = ['vitana-autopilot-executor'] as const;

export const TASKS_DEFAULT_LIMIT = 10;
export const TASKS_MAX_LIMIT = 25;
export const TASK_DESIRED_STATUSES = ['RUNNING', 'STOPPED'] as const;
export type TaskDesiredStatus = (typeof TASK_DESIRED_STATUSES)[number];

export interface EcsTasksQuery {
  /** Either a service name (ALLOWED_ECS_SERVICES) or a task family (ALLOWED_ECS_TASK_FAMILIES). */
  target: string;
  desiredStatus?: string;
  limit?: number;
}

export interface NormalizedEcsTasksQuery {
  target: string;
  kind: 'service' | 'family';
  desiredStatus: TaskDesiredStatus;
  limit: number;
}

/** Validate + bound the query before any AWS call. Throws on an unlisted target. */
export function normalizeTasksQuery(q: EcsTasksQuery): NormalizedEcsTasksQuery {
  const target = String(q.target || '').trim();
  const kind: NormalizedEcsTasksQuery['kind'] | null =
    (ALLOWED_ECS_SERVICES as readonly string[]).includes(target) ? 'service'
    : (ALLOWED_ECS_TASK_FAMILIES as readonly string[]).includes(target) ? 'family'
    : null;
  if (!kind) {
    throw new Error(`Unknown/undocumented ECS target: ${target || '(empty)'} — not a CLAUDE.md §1b service (${ALLOWED_ECS_SERVICES.join(', ')}) nor a listed task family (${ALLOWED_ECS_TASK_FAMILIES.join(', ')})`);
  }
  const ds = String(q.desiredStatus || 'RUNNING').trim().toUpperCase();
  if (!(TASK_DESIRED_STATUSES as readonly string[]).includes(ds)) {
    throw new Error(`desired_status must be one of ${TASK_DESIRED_STATUSES.join(', ')} (got ${q.desiredStatus})`);
  }
  const rawLimit = typeof q.limit === 'number' && Number.isFinite(q.limit) ? Math.floor(q.limit) : TASKS_DEFAULT_LIMIT;
  const limit = rawLimit < 1 ? TASKS_DEFAULT_LIMIT : Math.min(rawLimit, TASKS_MAX_LIMIT);
  return { target, kind, desiredStatus: ds as TaskDesiredStatus, limit };
}

export interface EcsTaskContainer {
  name: string;
  last_status: string;
  exit_code: number | null;
  reason: string | null;
  image: string | null;
}

export interface EcsTaskSummary {
  task_id: string;
  task_arn: string;
  last_status: string;
  desired_status: string;
  health_status: string | null;
  task_definition: string;
  group: string | null;
  launch_type: string | null;
  cpu: string | null;
  memory: string | null;
  created_at: string | null;
  started_at: string | null;
  stopped_at: string | null;
  stop_code: string | null;
  stopped_reason: string | null;
  containers: EcsTaskContainer[];
}

export interface EcsTasksResult {
  target: string;
  kind: 'service' | 'family';
  desired_status: TaskDesiredStatus;
  tasks: EcsTaskSummary[];
  truncated: boolean;
  note?: string;
}

const arnTail = (arn: string | undefined | null): string => (arn ? String(arn).split('/').pop() || String(arn) : '');
const iso = (d: Date | undefined | null): string | null => (d ? new Date(d).toISOString() : null);

/** Pure: the bounded, operator-facing shape of one described task. */
export function summarizeEcsTask(t: {
  taskArn?: string; lastStatus?: string; desiredStatus?: string; healthStatus?: string; taskDefinitionArn?: string; group?: string;
  launchType?: string; cpu?: string; memory?: string; createdAt?: Date; startedAt?: Date; stoppedAt?: Date; stopCode?: string; stoppedReason?: string;
  containers?: Array<{ name?: string; lastStatus?: string; exitCode?: number; reason?: string; image?: string }>;
}): EcsTaskSummary {
  return {
    task_id: arnTail(t.taskArn),
    task_arn: t.taskArn || '',
    last_status: t.lastStatus || 'UNKNOWN',
    desired_status: t.desiredStatus || 'UNKNOWN',
    health_status: t.healthStatus ?? null,
    task_definition: arnTail(t.taskDefinitionArn),
    group: t.group ?? null,
    launch_type: t.launchType ?? null,
    cpu: t.cpu ?? null,
    memory: t.memory ?? null,
    created_at: iso(t.createdAt),
    started_at: iso(t.startedAt),
    stopped_at: iso(t.stoppedAt),
    stop_code: t.stopCode ?? null,
    stopped_reason: t.stoppedReason ? String(t.stoppedReason).slice(0, 300) : null,
    containers: (t.containers || []).map((c) => ({
      name: c.name || '',
      last_status: c.lastStatus || 'UNKNOWN',
      exit_code: typeof c.exitCode === 'number' ? c.exitCode : null,
      reason: c.reason ? String(c.reason).slice(0, 300) : null,
      image: c.image ? String(c.image).split('/').pop() || c.image : null,
    })),
  };
}

/**
 * List + describe the tasks of one documented service or task family.
 * Read-only: ListTasksCommand + DescribeTasksCommand only. Refuses an
 * unlisted target before any AWS call; an IAM denial propagates verbatim.
 */
export async function listEcsTasks(q: EcsTasksQuery): Promise<EcsTasksResult> {
  const n = normalizeTasksQuery(q);
  const client = getReadonlyClient();
  const listed = await client.send(new ListTasksCommand({
    cluster: CLUSTER,
    ...(n.kind === 'service' ? { serviceName: n.target } : { family: n.target }),
    desiredStatus: n.desiredStatus,
    maxResults: n.limit,
  }));
  const arns = listed.taskArns || [];
  if (arns.length === 0) {
    return { target: n.target, kind: n.kind, desired_status: n.desiredStatus, tasks: [], truncated: false, note: `no ${n.desiredStatus} tasks for ${n.target} right now` };
  }
  const described = await client.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: arns }));
  const tasks = (described.tasks || []).map(summarizeEcsTask)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { target: n.target, kind: n.kind, desired_status: n.desiredStatus, tasks, truncated: Boolean(listed.nextToken) };
}
