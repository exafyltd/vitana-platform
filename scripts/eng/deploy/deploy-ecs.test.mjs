// VTID-05546 — deploy-ecs.mjs: staging deploy and rollback on ECS (plan agentic-delivery §3.6 step 2, §3.8, §3.10).
// No network and no AWS: the AWS CLI, the build stamp and git ancestry are injected fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deploy, rollback, diffTaskDefinitions } from './deploy-ecs.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'deploy-ecs.mjs');

const REG = '472838866351.dkr.ecr.eu-central-1.amazonaws.com';
const OLD = 'a'.repeat(40);
const SHA = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;
const LIVE_ARN = 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:41';
const NEW_ARN = 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:42';
const OVERRIDES = { PM_AGENT_ENABLED: 'false', DELIVERY_HOST_VITANA_PLATFORM: 'gitlab', DELIVERY_HOST_VITANA_V1: 'gitlab' };

function gatewayTd() {
  return {
    taskDefinitionArn: LIVE_ARN, family: 'vitana-gateway', revision: 41, status: 'ACTIVE',
    requiresAttributes: [{ name: 'ecs.capability.secrets.asm.environment-variables' }], compatibilities: ['EC2', 'FARGATE'],
    registeredAt: '2026-11-01T10:00:00Z', registeredBy: 'arn:aws:sts::472838866351:assumed-role/x/y',
    taskRoleArn: 'arn:aws:iam::472838866351:role/vitana-gateway-staging-task', executionRoleArn: 'arn:aws:iam::472838866351:role/vitana-ecs-exec',
    networkMode: 'awsvpc', cpu: '1024', memory: '2048', requiresCompatibilities: ['FARGATE'],
    containerDefinitions: [
      {
        name: 'gateway', image: `${REG}/vitana/gateway:${OLD.slice(0, 12)}`, essential: true,
        portMappings: [{ containerPort: 8080 }],
        environment: [
          { name: 'GIT_COMMIT_SHA', value: OLD }, { name: 'COMMIT_SHA', value: OLD },
          { name: 'BUILD_INFO_MARKER', value: OLD.slice(0, 12) }, { name: 'PM_AGENT_ENABLED', value: 'true' },
          { name: 'VITANA_ENV', value: 'staging' },
        ],
        secrets: [{ name: 'SUPABASE_SERVICE_ROLE', valueFrom: 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:x' }],
      },
      { name: 'log-router', image: 'public.ecr.aws/aws-observability/aws-for-fluent-bit:stable', essential: false },
    ],
  };
}

function communityTd() {
  return {
    taskDefinitionArn: 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-community-app:7', family: 'vitana-community-app',
    revision: 7, status: 'ACTIVE', containerDefinitions: [{ name: 'community-app', image: `${REG}/vitana/community-app:${OLD.slice(0, 12)}`, essential: true }],
  };
}

// A fake AWS CLI. `stable` is a list of exit codes for successive `ecs wait services-stable` calls.
function fakeAws({ td = gatewayTd(), stable = [0], sts = true, current = LIVE_ARN } = {}) {
  const calls = [];
  let registered = null;
  let service = current;
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args.slice(0, 2).join(' ');
    if (key === 'sts get-caller-identity') return sts ? { code: 0, stdout: JSON.stringify({ Account: '472838866351' }) } : { code: 254, stdout: '', stderr: 'An error occurred (AccessDenied) when calling the AssumeRoleWithWebIdentity operation: Not authorized' };
    if (key === 'ecs describe-services') return { code: 0, stdout: JSON.stringify({ services: [{ status: 'ACTIVE', taskDefinition: service, deployments: [{ status: 'PRIMARY', taskDefinition: service, rolloutState: 'COMPLETED', runningCount: 1, desiredCount: 1 }] }] }) };
    if (key === 'ecs describe-task-definition') return { code: 0, stdout: JSON.stringify({ taskDefinition: td }) };
    if (key === 'ecs register-task-definition') {
      const file = args[args.indexOf('--cli-input-json') + 1].replace(/^file:\/\//, '');
      registered = JSON.parse(readFileSync(file, 'utf8'));
      return { code: 0, stdout: JSON.stringify({ taskDefinition: { taskDefinitionArn: td.family === 'vitana-gateway' ? NEW_ARN : 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-community-app:8' } }) };
    }
    if (key === 'ecs update-service') {
      service = args[args.indexOf('--task-definition') + 1];
      return { code: 0, stdout: '{}' };
    }
    if (key === 'ecs wait') {
      const code = stable.length ? stable.shift() : 0;
      return code === 0 ? { code: 0, stdout: '' } : { code, stdout: '', stderr: 'Waiter ServicesStable failed: Max attempts exceeded' };
    }
    return { code: 1, stdout: '', stderr: `unexpected aws ${args.join(' ')}` };
  };
  return { run, calls, registered: () => registered, service: () => service };
}

// Build-info stamps served in turn (the last one repeats).
function stamps(...seq) {
  const list = [...seq];
  return async () => {
    const sha = list.length > 1 ? list.shift() : list[0];
    return { status: 200, body: JSON.stringify({ env: 'staging', git_commit: sha }) };
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-ecs-'));
  return { runsFile: join(dir, 'deploy-runs.json'), stateFile: join(dir, 'deploy-state.json'), outDir: join(dir, 'out'), dir };
}

function opts(files, extra = {}) {
  return {
    service: 'gateway', cluster: 'Vitana-ECS-Cluster', ecsService: 'vitana-gateway', sha: SHA,
    push: { service: 'gateway', registry: REG, repository: 'vitana/gateway', tag: SHA.slice(0, 12), digest: DIGEST },
    mode: 'live', envOverrides: JSON.stringify(OVERRIDES), stampAttempts: 2, stampIntervalMs: 0, ...files, ...extra,
  };
}

const writes = (calls) => calls.filter((c) => c[0] === 'aws' && ['register-task-definition', 'update-service'].includes(c[2]));
const quiet = () => {};

test('live mode changes only the image digest, the commit variables and the env overrides', async () => {
  const f = setup();
  const a = fakeAws();
  const r = await deploy(opts(f), { run: a.run, fetchText: stamps(OLD, SHA), isAncestor: () => false, log: quiet });
  assert.equal(r.outcome, 'success');
  assert.equal(r.code, 0);
  const reg = a.registered();
  for (const k of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy']) assert.equal(k in reg, false, `${k} is not sent back`);
  assert.deepEqual(diffTaskDefinitions(gatewayTd(), reg).sort(), [
    `container gateway env BUILD_INFO_MARKER: ${OLD.slice(0, 12)} -> ${SHA.slice(0, 12)}`,
    `container gateway env COMMIT_SHA: ${OLD} -> ${SHA}`,
    'container gateway env DELIVERY_HOST_VITANA_PLATFORM: <unset> -> gitlab',
    'container gateway env DELIVERY_HOST_VITANA_V1: <unset> -> gitlab',
    `container gateway env GIT_COMMIT_SHA: ${OLD} -> ${SHA}`,
    'container gateway env PM_AGENT_ENABLED: true -> false',
    `container gateway image: ${REG}/vitana/gateway:${OLD.slice(0, 12)} -> ${REG}/vitana/gateway@${DIGEST}`,
  ].sort());
  assert.deepEqual(reg.containerDefinitions[0].secrets, gatewayTd().containerDefinitions[0].secrets, 'secrets untouched');
  assert.deepEqual(reg.containerDefinitions[1], gatewayTd().containerDefinitions[1], 'sidecar untouched');
  assert.equal(a.service(), NEW_ARN);
});

test('shadow mode renders the definition and makes no ECS write', async () => {
  const f = setup();
  const a = fakeAws();
  const r = await deploy(opts(f, { mode: 'shadow' }), { run: a.run, fetchText: stamps(OLD), isAncestor: () => false, log: quiet });
  assert.equal(r.outcome, 'skipped');
  assert.equal(r.code, 0);
  assert.deepEqual(writes(a.calls), [], 'no register-task-definition, no update-service');
  const rendered = JSON.parse(readFileSync(join(f.outDir, 'task-definition.json'), 'utf8'));
  const diff = diffTaskDefinitions(gatewayTd(), rendered);
  assert.equal(diff.some((l) => l.includes('PM_AGENT_ENABLED') || l.includes('DELIVERY_HOST')), false, 'env_overrides only in live mode');
  assert.equal(diff.length, 4, 'image + three commit variables');
  assert.ok(existsSync(join(f.outDir, 'task-definition.diff.json')));
  const runs = JSON.parse(readFileSync(f.runsFile, 'utf8'));
  assert.equal(runs[0].outcome, 'skipped');
});

test('a service outside the plan §3.10 allowlist is refused before any AWS call', async () => {
  const f = setup();
  for (const extra of [
    { service: 'gateway-prod' },
    { ecsService: 'vitana-gateway-prod' },
    { cluster: 'Vitana-Prod-Cluster' },
    { service: 'community-app', ecsService: 'vitana-community-app' },
  ]) {
    const a = fakeAws();
    await assert.rejects(deploy(opts(f, extra), { run: a.run, fetchText: stamps(OLD), log: quiet }), (e) => e.exitCode === 2 && /refused/.test(e.message));
    assert.equal(a.calls.length, 0, `no AWS call for ${JSON.stringify(extra)}`);
  }
});

test('an image outside the service ECR repository is refused before any AWS call', async () => {
  const f = setup();
  const a = fakeAws();
  const push = { service: 'gateway', registry: REG, repository: 'vitana/community-app', digest: DIGEST };
  await assert.rejects(deploy(opts(f, { push }), { run: a.run, fetchText: stamps(OLD), log: quiet }), (e) => e.exitCode === 2);
  const push2 = { service: 'gateway', registry: '111111111111.dkr.ecr.eu-central-1.amazonaws.com', repository: 'vitana/gateway', digest: DIGEST };
  await assert.rejects(deploy(opts(f, { push: push2 }), { run: a.run, fetchText: stamps(OLD), log: quiet }), (e) => e.exitCode === 2);
  assert.equal(a.calls.length, 0);
});

test('a deploy that finds a newer descendant served ends superseded and writes nothing', async () => {
  const f = setup();
  const a = fakeAws();
  const r = await deploy(opts(f), { run: a.run, fetchText: stamps(NEWER), isAncestor: (x, y) => x === SHA && y === NEWER, log: quiet });
  assert.equal(r.outcome, 'superseded');
  assert.equal(r.code, 0);
  assert.deepEqual(writes(a.calls), []);
  assert.equal(existsSync(join(f.outDir, 'task-definition.json')), false, 'nothing rendered');
  assert.equal(JSON.parse(readFileSync(f.runsFile, 'utf8'))[0].outcome, 'superseded');
});

test('a served commit that is not a descendant does not supersede', async () => {
  const f = setup();
  const a = fakeAws();
  const r = await deploy(opts(f), { run: a.run, fetchText: stamps(NEWER, SHA), isAncestor: () => false, log: quiet });
  assert.equal(r.outcome, 'success');
});

test('a stabilise failure re-points to the captured revision and ends red', async () => {
  const f = setup();
  const a = fakeAws({ stable: [255, 0] });
  const r = await deploy(opts(f), { run: a.run, fetchText: stamps(OLD), isAncestor: () => false, log: quiet });
  assert.equal(r.outcome, 'rolled_back');
  assert.equal(r.code, 1);
  const updates = a.calls.filter((c) => c[2] === 'update-service').map((c) => c[c.indexOf('--task-definition') + 1]);
  assert.deepEqual(updates, [NEW_ARN, LIVE_ARN]);
  assert.equal(a.service(), LIVE_ARN);
  assert.equal(JSON.parse(readFileSync(f.runsFile, 'utf8'))[0].outcome, 'rolled_back');
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).phase, 'rolled_back');
});

test('a wrong build stamp re-points to the captured revision and ends red', async () => {
  const f = setup();
  const a = fakeAws();
  const r = await deploy(opts(f), { run: a.run, fetchText: stamps(OLD), isAncestor: () => false, log: quiet });
  assert.equal(r.outcome, 'rolled_back');
  assert.equal(r.code, 1);
  assert.equal(a.service(), LIVE_ARN);
});

test('a missing role fails the job and names the role', async () => {
  const f = setup();
  const a = fakeAws({ sts: false });
  await assert.rejects(deploy(opts(f), { run: a.run, fetchText: stamps(OLD), log: quiet }), (e) => e.exitCode === 4 && e.message.includes('gl-platform-staging'));
  assert.deepEqual(writes(a.calls), []);
});

test('the rollback job re-points when the deploy job stopped after the update', async () => {
  const f = setup();
  writeFileSync(f.stateFile, JSON.stringify({ service: 'gateway', cluster: 'Vitana-ECS-Cluster', ecs_service: 'vitana-gateway', sha: SHA, started_at: '2026-11-05T10:00:00.000Z', captured_task_definition: LIVE_ARN, captured_commit: OLD, new_task_definition: NEW_ARN, phase: 'updated' }));
  const a = fakeAws({ current: NEW_ARN });
  const r = await rollback({ stateFile: f.stateFile, runsFile: f.runsFile, stampAttempts: 2, stampIntervalMs: 0 }, { run: a.run, fetchText: stamps(OLD), log: quiet });
  assert.equal(r.outcome, 'rolled_back');
  assert.equal(a.service(), LIVE_ARN);
  assert.equal(JSON.parse(readFileSync(f.runsFile, 'utf8'))[0].outcome, 'rolled_back');
});

test('the rollback job changes nothing when the deploy job changed nothing or already rolled back', async () => {
  const f = setup();
  for (const phase of ['captured', 'superseded', 'skipped', 'done']) {
    writeFileSync(f.stateFile, JSON.stringify({ service: 'gateway', cluster: 'Vitana-ECS-Cluster', ecs_service: 'vitana-gateway', sha: SHA, captured_task_definition: LIVE_ARN, phase }));
    const a = fakeAws();
    const r = await rollback({ stateFile: f.stateFile, runsFile: f.runsFile }, { run: a.run, fetchText: stamps(OLD), log: quiet });
    assert.equal(r.outcome, 'nothing', phase);
    assert.equal(a.calls.length, 0, phase);
  }
  writeFileSync(f.stateFile, JSON.stringify({ service: 'gateway', cluster: 'Vitana-ECS-Cluster', ecs_service: 'vitana-gateway', sha: SHA, captured_task_definition: LIVE_ARN, phase: 'rolled_back' }));
  const a = fakeAws({ current: LIVE_ARN });
  const r = await rollback({ stateFile: f.stateFile, runsFile: f.runsFile }, { run: a.run, fetchText: stamps(OLD), log: quiet });
  assert.equal(r.outcome, 'nothing');
  assert.deepEqual(writes(a.calls), []);
  const none = await rollback({ stateFile: join(f.dir, 'absent.json'), runsFile: f.runsFile }, { run: fakeAws().run, log: quiet });
  assert.equal(none.outcome, 'nothing');
});

test('it writes the deploy-runs file of the contract lane verify-on-gitlab reads', async () => {
  const f = setup();
  await deploy(opts(f), { run: fakeAws().run, fetchText: stamps(OLD, SHA), isAncestor: () => false, log: quiet });
  const c = fakeAws({ td: communityTd(), current: communityTd().taskDefinitionArn });
  const html = (sha) => async () => ({ status: 200, body: `<html><head><meta name="vitana-app-version" content="${sha.slice(0, 12)}"></head></html>` });
  let n = 0;
  const frontend = async (url) => (n++ === 0 ? html(OLD)(url) : html(SHA)(url));
  const r = await deploy(opts(f, {
    service: 'community-app', ecsService: 'vitana-community-app-staging', envOverrides: undefined,
    push: { service: 'community-app', registry: REG, repository: 'vitana/community-app', digest: DIGEST },
  }), { run: c.run, fetchText: frontend, isAncestor: () => false, log: quiet });
  assert.equal(r.outcome, 'success');
  assert.deepEqual(diffTaskDefinitions(communityTd(), c.registered()), [`container community-app image: ${REG}/vitana/community-app:${OLD.slice(0, 12)} -> ${REG}/vitana/community-app@${DIGEST}`]);
  const runs = JSON.parse(readFileSync(f.runsFile, 'utf8'));
  assert.equal(runs.length, 2);
  for (const e of runs) {
    assert.deepEqual(Object.keys(e), ['service', 'sha', 'started_at', 'finished_at', 'outcome']);
    assert.ok(['gateway', 'community-app'].includes(e.service));
    assert.equal(e.sha, SHA);
    assert.ok(Number.isFinite(Date.parse(e.started_at)) && Number.isFinite(Date.parse(e.finished_at)));
    assert.ok(Date.parse(e.finished_at) >= Date.parse(e.started_at));
    assert.equal(e.outcome, 'success');
  }
});

test('an env override cannot replace a secret or a commit variable', async () => {
  const f = setup();
  for (const ov of [{ SUPABASE_SERVICE_ROLE: 'x' }, { GIT_COMMIT_SHA: OLD }, { 'bad-name': 'x' }]) {
    const a = fakeAws();
    await assert.rejects(deploy(opts(f, { envOverrides: JSON.stringify(ov) }), { run: a.run, fetchText: stamps(OLD), isAncestor: () => false, log: quiet }), (e) => e.exitCode === 2);
    assert.deepEqual(writes(a.calls), []);
  }
});

test('the CLI refuses a service outside the allowlist (exit 2) and its rollback without a state does nothing', () => {
  const f = setup();
  const env = { PATH: dirname(process.execPath), HOME: f.dir };
  const bad = spawnSync(process.execPath, [CLI, 'deploy', '--service', 'gateway-prod', '--cluster', 'Vitana-ECS-Cluster', '--ecs-service', 'vitana-gateway', '--sha', SHA, '--runs-file', f.runsFile, '--state-file', f.stateFile], { encoding: 'utf8', env, cwd: f.dir });
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /outside the staging allowlist of plan §3\.10/);
  assert.equal(existsSync(f.stateFile), false, 'nothing captured');
  const none = spawnSync(process.execPath, [CLI, 'rollback', '--state-file', join(f.dir, 'absent.json'), '--runs-file', f.runsFile], { encoding: 'utf8', env, cwd: f.dir });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /nothing to roll back/);
});
