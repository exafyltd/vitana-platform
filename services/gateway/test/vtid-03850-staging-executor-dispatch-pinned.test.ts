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

  it('is now ALSO declared on the prod gateway deploy workflow (VTID-04227 — was "deliberately NOT" until 2026-09-21)', () => {
    // VTID-04227 declares the same two values on prod, unconditionally, in
    // the always-pinned block; the prod-side assertions live in
    // vtid-04227-prod-dev-autopilot-flags-pinned.test.ts. This test keeps
    // asserting the staging side and that the two stacks agree.
    expect(prod).toMatch(/\{name:"DEV_AUTOPILOT_USE_JOB", value:"true"\}/);
    expect(prod).toMatch(/\{name:"DEV_AUTOPILOT_JOB_CLOUD", value:"aws"\}/);
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
    // VTID-03880: hardcoded as a literal ARN rather than resolved via
    // describe-secret at deploy time (the prod deploy role lacks
    // secretsmanager:DescribeSecret on this staging-prefixed path) — but
    // it's still the same underlying secret name the staging gateway
    // resolves for itself.
    expect(registerStep).toContain('DEEPSEEK_SECRET_ARN: arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/staging/deepseek-api-key');
    expect(registerStep).toMatch(/\{name:"DEEPSEEK_API_KEY", valueFrom:\$DS\}/);
    // The staging gateway resolves the identical secret name — one source of truth.
    expect(staging).toContain('vitana/gateway/staging/deepseek-api-key');
  });

  it('strips inherited copies before upserting, and tolerates a null environment/secrets array', () => {
    // VTID-04050: the strip list grew to also cover AGENT_MAX_TURNS/
    // AGENT_DEADLINE_MS (the Command Hub agent turn-budget raise) — the
    // env upsert still strips its own targets before re-adding them, just
    // four names instead of two now.
    expect(registerStep).toMatch(
      /select\(\.name \| IN\("BEDROCK_ROLE_ARN","AWS_BEDROCK_REGION","AGENT_MAX_TURNS","AGENT_DEADLINE_MS"\) \| not\)/,
    );
    expect(registerStep).toMatch(/select\(\.name \| IN\("DEEPSEEK_API_KEY"\) \| not\)/);
    expect(registerStep).toMatch(/\(\. \/\/ \[\]\)\[\]/);
  });

  it('sets AGENT_MAX_TURNS/AGENT_DEADLINE_MS for the Command Hub turn-budget raise (VTID-04050)', () => {
    // Run #6b measured ~38 of 60 turns spent just navigating the 2.6MB
    // Command Hub app.js bundle before making an edit — the default budget
    // starves that work before it can finish. Raised for every executor
    // run, not gated by any flag.
    expect(registerStep).toMatch(/\{name:"AGENT_MAX_TURNS", value:"120"\}/);
    expect(registerStep).toMatch(/\{name:"AGENT_DEADLINE_MS", value:"2100000"\}/);
  });

  it('still only builds + registers — no ECS service roll, next RunTask picks the new revision', () => {
    expect(executor).not.toMatch(/aws ecs update-service/);
    expect(registerStep).toMatch(/next RunTask dispatch/);
  });
});
