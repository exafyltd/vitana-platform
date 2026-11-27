// Brief item 4 (B1): the production-credential gate in deploy-ecs.mjs refuses the rehearsal clone and every other
// refused name, on the deploy path (shadow and live) and on the rollback path, before any register-task-definition or
// update-service. No AWS and no network: the AWS CLI and the build stamp are injected fakes. Its own fake answers per
// task-definition ARN, so a test can give the captured and the live revision different content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploy, rollback, productionCredentialNames, PROD_CREDENTIAL_RE } from '../deploy-ecs.mjs';

const REG = '472838866351.dkr.ecr.eu-central-1.amazonaws.com';
const SM = 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:';
const OLD = 'a'.repeat(40);
const SHA = 'b'.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;
const CAPTURED = 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:41';
const NEW = 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:42';
const LIVE_PROD = 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:43';
const quiet = () => {};

// A staging gateway definition. `secrets` and `envExtra` add entries to its one container.
function gatewayTd(rev, { secrets = [], envExtra = [] } = {}) {
  return {
    taskDefinitionArn: `arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:${rev}`,
    family: 'vitana-gateway', revision: rev, status: 'ACTIVE',
    networkMode: 'awsvpc', cpu: '1024', memory: '2048', requiresCompatibilities: ['FARGATE'],
    containerDefinitions: [{
      name: 'gateway', image: `${REG}/vitana/gateway:${OLD.slice(0, 12)}`, essential: true,
      environment: [
        { name: 'GIT_COMMIT_SHA', value: OLD }, { name: 'COMMIT_SHA', value: OLD },
        { name: 'BUILD_INFO_MARKER', value: OLD.slice(0, 12) }, { name: 'VITANA_ENV', value: 'staging' }, ...envExtra,
      ],
      secrets: [{ name: 'SUPABASE_SERVICE_ROLE', valueFrom: `${SM}vitana/gateway/staging/service-role-AbCdEf` }, ...secrets],
    }],
  };
}

// A fake AWS CLI for the gateway service. `tds` maps a task-definition ARN to its definition. `live` is the ARN the
// service runs. update-service moves the service, so a later read sees the new revision.
function fakeAws({ tds, live }) {
  const calls = [];
  let service = live;
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args.slice(0, 2).join(' ');
    if (key === 'sts get-caller-identity') return { code: 0, stdout: JSON.stringify({ Account: '472838866351' }) };
    if (key === 'ecs describe-services') {
      return { code: 0, stdout: JSON.stringify({ services: [{ status: 'ACTIVE', taskDefinition: service, deployments: [{ status: 'PRIMARY', taskDefinition: service, rolloutState: 'COMPLETED', runningCount: 1, desiredCount: 1 }] }] }) };
    }
    if (key === 'ecs describe-task-definition') {
      const arn = args[args.indexOf('--task-definition') + 1];
      return tds[arn]
        ? { code: 0, stdout: JSON.stringify({ taskDefinition: tds[arn] }) }
        : { code: 254, stdout: '', stderr: `no fixture for ${arn}` };
    }
    if (key === 'ecs register-task-definition') return { code: 0, stdout: JSON.stringify({ taskDefinition: { taskDefinitionArn: NEW } }) };
    if (key === 'ecs update-service') {
      service = args[args.indexOf('--task-definition') + 1];
      return { code: 0, stdout: '{}' };
    }
    if (key === 'ecs wait') return { code: 0, stdout: '' };
    return { code: 1, stdout: '', stderr: `unexpected aws ${args.join(' ')}` };
  };
  const writes = () => calls.filter((c) => c[2] === 'register-task-definition' || c[2] === 'update-service');
  return { run, calls, writes, service: () => service };
}

// Build-info stamps served in turn; the last one repeats.
function stamps(...seq) {
  const list = [...seq];
  return async () => {
    const sha = list.length > 1 ? list.shift() : list[0];
    return { status: 200, body: JSON.stringify({ env: 'staging', git_commit: sha }) };
  };
}

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'prod-cred-gate-'));
  return { runsFile: join(dir, 'deploy-runs.json'), stateFile: join(dir, 'deploy-state.json'), outDir: join(dir, 'out') };
}

function deployOpts(f, mode) {
  return {
    service: 'gateway', cluster: 'Vitana-ECS-Cluster', ecsService: 'vitana-gateway', sha: SHA,
    push: { service: 'gateway', registry: REG, repository: 'vitana/gateway', tag: SHA.slice(0, 12), digest: DIGEST },
    mode, stampAttempts: 2, stampIntervalMs: 0, ...f,
  };
}

// The state the deploy job leaves when it stops after the update (phase `updated`), or another phase.
function writeState(f, phase) {
  writeFileSync(f.stateFile, JSON.stringify({
    service: 'gateway', cluster: 'Vitana-ECS-Cluster', ecs_service: 'vitana-gateway', sha: SHA, mode: 'live',
    started_at: '2026-11-05T10:00:00.000Z', captured_task_definition: CAPTURED, captured_commit: OLD,
    new_task_definition: NEW, phase,
  }));
}

const REHEARSAL_DB_URI = `${SM}vitana/aurora/rehearsal/postgrest-authenticator-uri-AbCdEf`;

test('staging_definition_passes_in_shadow_and_live', async () => {
  for (const mode of ['shadow', 'live']) {
    const f = files();
    const a = fakeAws({ tds: { [CAPTURED]: gatewayTd(41) }, live: CAPTURED });
    const r = await deploy(deployOpts(f, mode), { run: a.run, fetchText: stamps(OLD, SHA), isAncestor: () => false, log: quiet });
    assert.equal(r.outcome, mode === 'live' ? 'success' : 'skipped', mode);
  }
});

test('rehearsal_clone_arn_is_refused_in_shadow_and_live', async () => {
  for (const mode of ['shadow', 'live']) {
    const f = files();
    const td = gatewayTd(41, { secrets: [{ name: 'PGRST_DB_URI', valueFrom: REHEARSAL_DB_URI }] });
    const a = fakeAws({ tds: { [CAPTURED]: td }, live: CAPTURED });
    await assert.rejects(
      deploy(deployOpts(f, mode), { run: a.run, fetchText: stamps(OLD), isAncestor: () => false, log: quiet }),
      (e) => e.exitCode === 2 && /binds production credentials \(PGRST_DB_URI\)/.test(e.message),
      mode,
    );
    assert.deepEqual(a.writes(), [], `${mode}: no register-task-definition, no update-service`);
  }
});

test('rehearsal_bare_name_in_env_is_refused', async () => {
  const f = files();
  const td = gatewayTd(41, { envExtra: [{ name: 'DB_SECRET_NAME', value: 'vitana/aurora/rehearsal/postgrest-authenticator-uri' }] });
  const a = fakeAws({ tds: { [CAPTURED]: td }, live: CAPTURED });
  await assert.rejects(
    deploy(deployOpts(f, 'shadow'), { run: a.run, fetchText: stamps(OLD), isAncestor: () => false, log: quiet }),
    (e) => e.exitCode === 2 && /binds production credentials \(DB_SECRET_NAME\)/.test(e.message),
  );
  assert.deepEqual(a.writes(), []);
});

test('each_refused_name_is_detected', () => {
  const names = [
    'vitana/supabase/prod/jwt-secret',
    'vitana/aurora/prod/master-xyz',
    'vitana/aurora/rehearsal/postgrest-authenticator-uri',
    'vitana-aurora-prod.cluster-x.eu-central-1.rds.amazonaws.com',
    'rds!cluster-4dab93b8-aaaa:password::',
  ];
  for (const n of names) {
    assert.equal(PROD_CREDENTIAL_RE.test(n), true, `bare name ${n}`);
    const td = gatewayTd(41, { secrets: [{ name: 'X', valueFrom: `${SM}${n}` }] });
    assert.deepEqual(productionCredentialNames(td), ['X'], `secret ARN of ${n}`);
  }
  const staging = gatewayTd(41, { secrets: [{ name: 'SUPABASE_JWT_SECRET', valueFrom: `${SM}vitana/supabase/staging/jwt-secret-abc` }] });
  assert.deepEqual(productionCredentialNames(staging), [], 'staging-named secrets pass');
});

test('rollback_refuses_captured_rehearsal_revision', async () => {
  const f = files();
  writeState(f, 'updated');
  const td = gatewayTd(41, { secrets: [{ name: 'PGRST_DB_URI', valueFrom: REHEARSAL_DB_URI }] });
  const a = fakeAws({ tds: { [CAPTURED]: td, [NEW]: gatewayTd(42) }, live: NEW });
  await assert.rejects(
    rollback({ stateFile: f.stateFile, runsFile: f.runsFile, stampAttempts: 2, stampIntervalMs: 0 }, { run: a.run, fetchText: stamps(OLD), log: quiet }),
    (e) => e.exitCode === 2 && /refusing to rollback vitana-gateway: its task definition binds production credentials \(PGRST_DB_URI\)/.test(e.message),
  );
  assert.deepEqual(a.writes(), [], 'no update-service');
});

test('rollback_refuses_live_production_revision', async () => {
  const f = files();
  writeState(f, 'updated');
  const live = gatewayTd(43, { secrets: [{ name: 'SUPABASE_JWT_SECRET', valueFrom: `${SM}vitana/supabase/prod/jwt-secret-k2UAbI` }] });
  const a = fakeAws({ tds: { [CAPTURED]: gatewayTd(41), [LIVE_PROD]: live }, live: LIVE_PROD });
  await assert.rejects(
    rollback({ stateFile: f.stateFile, runsFile: f.runsFile, stampAttempts: 2, stampIntervalMs: 0 }, { run: a.run, fetchText: stamps(OLD), log: quiet }),
    (e) => e.exitCode === 2 && /refusing to rollback vitana-gateway: its task definition binds production credentials \(SUPABASE_JWT_SECRET\)/.test(e.message),
  );
  assert.deepEqual(a.writes(), [], 'no update-service');
});

test('rollback_repoints_clean_revisions', async () => {
  const f = files();
  writeState(f, 'updated');
  const a = fakeAws({ tds: { [CAPTURED]: gatewayTd(41), [NEW]: gatewayTd(42) }, live: NEW });
  const r = await rollback({ stateFile: f.stateFile, runsFile: f.runsFile, stampAttempts: 2, stampIntervalMs: 0 }, { run: a.run, fetchText: stamps(OLD), log: quiet });
  assert.equal(r.outcome, 'rolled_back');
  assert.equal(a.service(), CAPTURED);
  assert.equal(a.writes().filter((c) => c[2] === 'update-service').length, 1);
});

test('rollback_of_a_phase_that_changed_nothing_makes_no_aws_call', async () => {
  // The early returns come before the new checks, so a phase that changed nothing stays free of AWS calls even when
  // the captured revision would be refused.
  for (const phase of ['captured', 'superseded', 'skipped', 'done']) {
    const f = files();
    writeState(f, phase);
    const td = gatewayTd(41, { secrets: [{ name: 'PGRST_DB_URI', valueFrom: REHEARSAL_DB_URI }] });
    const a = fakeAws({ tds: { [CAPTURED]: td }, live: CAPTURED });
    const r = await rollback({ stateFile: f.stateFile, runsFile: f.runsFile }, { run: a.run, fetchText: stamps(OLD), log: quiet });
    assert.equal(r.outcome, 'nothing', phase);
    assert.equal(a.calls.length, 0, phase);
  }
});
