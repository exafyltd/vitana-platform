/**
 * AWS ECS admin client — VTID-03415.
 *
 * AWS analogue of the Cloud Run Job dispatch in dev-autopilot-execute.ts's
 * dispatchExecutorJob(). Cloud Run JOBS and ECS standalone RunTask both
 * express the same idea — launch one container to completion, no service,
 * no scaling, no recycling mid-run — which is why the autopilot executor
 * needs a Job/Task, not a long-running service: the gateway's own fire-
 * and-forget in-process fallback dies when its container recycles mid-LLM
 * call (see dev-autopilot-execute.ts's VTID-02703 comment block).
 *
 * Auth: relies on the gateway ECS task's own IAM task role (no static
 * keys) — the AWS SDK's default credential chain picks up the container
 * credentials the ECS agent injects automatically, same keyless pattern
 * as the GCP path's metadata-server token fetch.
 *
 * Only used when DEV_AUTOPILOT_JOB_CLOUD=aws — see dispatchExecutorJobAws()
 * in dev-autopilot-execute.ts for the provider switch. Never called on GCP.
 */

import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';

const REGION = process.env.AWS_ECS_REGION || process.env.AWS_REGION || 'eu-central-1';
const CLUSTER = process.env.AWS_ECS_CLUSTER || 'Vitana-ECS-Cluster';
const TASK_DEFINITION = process.env.AWS_AUTOPILOT_TASK_DEFINITION || 'vitana-autopilot-executor';
const CONTAINER_NAME = process.env.AWS_AUTOPILOT_CONTAINER_NAME || 'autopilot-executor';
// Same private subnets + security group the awsdr services already run in
// (Vitana-ECS-Cluster's shared VPC) — override via env if that ever changes.
const SUBNETS = (process.env.AWS_ECS_SUBNETS || 'subnet-0ff45a2051c5e5482,subnet-0c786864a28a5a821')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SECURITY_GROUPS = (process.env.AWS_ECS_SECURITY_GROUPS || 'sg-0fbcf7b59b1f0d685')
  .split(',').map((s) => s.trim()).filter(Boolean);

let cachedClient: ECSClient | null = null;

function getClient(): ECSClient {
  if (!cachedClient) {
    cachedClient = new ECSClient({ region: REGION });
  }
  return cachedClient;
}

/**
 * VTID-03415: dispatch a one-off ECS Fargate task for the given exec_id.
 *
 * Mirrors dispatchExecutorJob()'s contract exactly (same return shape) so
 * the caller in dev-autopilot-execute.ts doesn't need provider-specific
 * branching beyond picking which of the two to call.
 */
export async function dispatchExecutorJobAws(
  execId: string,
): Promise<{ ok: boolean; error?: string; operation?: string }> {
  try {
    const client = getClient();
    const command = new RunTaskCommand({
      cluster: CLUSTER,
      taskDefinition: TASK_DEFINITION,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNETS,
          securityGroups: SECURITY_GROUPS,
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: CONTAINER_NAME,
            environment: [{ name: 'EXEC_ID', value: execId }],
          },
        ],
      },
    });
    const res = await client.send(command);
    if (res.failures && res.failures.length > 0) {
      const detail = res.failures.map((f) => `${f.arn ?? '?'}: ${f.reason ?? '?'}`).join('; ');
      return { ok: false, error: `RunTask failure: ${detail}` };
    }
    const taskArn = res.tasks?.[0]?.taskArn;
    if (!taskArn) {
      return { ok: false, error: 'RunTask returned no task and no failure — unexpected empty response' };
    }
    console.log(`[aws-ecs-admin] dispatched task for exec=${execId.slice(0, 8)} taskArn=${taskArn}`);
    return { ok: true, operation: taskArn };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
