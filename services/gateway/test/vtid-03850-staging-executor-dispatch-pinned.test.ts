/**
 * VTID-03850 — staging dispatches Dev Autopilot executions to the ECS
 * executor task instead of running them in-process.
 *
 * Observed 2026-09-13 (VTID-03841): the staging gateway ran an operator
 * on-ramp execution as a fire-and-forget promise on its own task — no
 * GitHub token, and a 20-minute watchdog was the only thing that noticed
 * the run had died. The executor task (vitana-autopilot-executor) is the
 * runtime built for exactly this (VTID-02703 / VTID-03415): it carries
 * GITHUB_SAFE_MERGE_TOKEN and survives gateway container churn.
 *
 * Two workflows change together and both are pinned here:
 *   - AWS-STAGE-DEPLOY-GATEWAY.yml pins DEV_AUTOPILOT_USE_JOB=true and
 *     DEV_AUTOPILOT_JOB_CLOUD=aws (the code's own defaults are false/gcp).
 *   - AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml upserts BEDROCK_ROLE_ARN,
 *     AWS_BEDROCK_REGION and the DEEPSEEK_API_KEY secret onto the executor
 *     task definition — without these the executor had no LLM credential at
 *     all (its own header comment records that), so every dispatched
 *     execution would have failed at the worker call.
 */

import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
const executor = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml'), 'utf8');

describe('VTID-03850: staging gateway dispatches executions to the ECS executor', () => {
  it('pins DEV_AUTOPILOT_USE_JOB to the exact string "true"', () => {
    expect(staging).toMatch(/\{name:"DEV_AUTOPILOT_USE_JOB", value:"true"\}/);
  });

  it('pins DEV_AUTOPILOT_JOB_CLOUD to "aws" — the gcp branch is dead code', () => {
    expect(staging).toMatch(/\{name:"DEV_AUTOPILOT_JOB_CLOUD", value:"aws"\}/);
    expect(staging).not.toMatch(/\{name:"DEV_AUTOPILOT_JOB_CLOUD", value:"gcp"\}/);
  });

  it('strips both inherited values first, so a stale one cannot survive a deploy', () => {
    const stripBlock = staging.slice(
      staging.indexOf('.containerDefinitions[0].environment |='),
      staging.indexOf('.containerDefinitions[0].secrets |='),
    );
    const strip = stripBlock.slice(0, stripBlock.indexOf('| not) ]'));
    expect(strip).toContain('"DEV_AUTOPILOT_USE_JOB"');
    expect(strip).toContain('"DEV_AUTOPILOT_JOB_CLOUD"');
  });

  it('is deliberately NOT pinned on the prod gateway deploy workflow', () => {
    expect(prod).not.toContain('DEV_AUTOPILOT_USE_JOB');
    expect(prod).not.toContain('DEV_AUTOPILOT_JOB_CLOUD');
  });

  it('the on-ramp flag it feeds is still pinned on staging (VTID-03820) — this change is downstream of it', () => {
    expect(staging).toMatch(/\{name:"OPERATOR_EXECUTION_ONRAMP_ENABLED", value:"true"\}/);
  });
});

describe('VTID-03850: the executor task definition gets an LLM runtime of its own', () => {
  const registerStep = executor.slice(executor.indexOf('name: Register new task-definition revision'));

  it('sets BEDROCK_ROLE_ARN from the executor task definition\'s own taskRoleArn (gateway pattern)', () => {
    expect(registerStep).toMatch(/taskDefinition\.taskRoleArn/);
    expect(registerStep).toMatch(/\{name:"BEDROCK_ROLE_ARN", value:\$TASK_ROLE\}/);
    expect(registerStep).toMatch(/cannot set BEDROCK_ROLE_ARN/);
  });

  it('sets AWS_BEDROCK_REGION to the deploy region', () => {
    expect(registerStep).toMatch(/\{name:"AWS_BEDROCK_REGION", value:\$REGION\}/);
  });

  it('wires DEEPSEEK_API_KEY from the same Secrets Manager secret the staging gateway resolves', () => {
    expect(registerStep).toContain('DEEPSEEK_SECRET_NAME: vitana/gateway/staging/deepseek-api-key');
    expect(registerStep).toMatch(/\{name:"DEEPSEEK_API_KEY", valueFrom:\$DS\}/);
    // The staging gateway resolves the identical secret name — one source of truth.
    expect(staging).toContain('vitana/gateway/staging/deepseek-api-key');
  });

  it('strips inherited copies before upserting, and tolerates a null environment/secrets array', () => {
    expect(registerStep).toMatch(/select\(\.name \| IN\("BEDROCK_ROLE_ARN","AWS_BEDROCK_REGION"\) \| not\)/);
    expect(registerStep).toMatch(/select\(\.name \| IN\("DEEPSEEK_API_KEY"\) \| not\)/);
    expect(registerStep).toMatch(/\(\. \/\/ \[\]\)\[\]/);
  });

  it('still only builds + registers — no ECS service roll, next RunTask picks the new revision', () => {
    expect(executor).not.toMatch(/aws ecs update-service/);
    expect(registerStep).toMatch(/next RunTask dispatch/);
  });
});
