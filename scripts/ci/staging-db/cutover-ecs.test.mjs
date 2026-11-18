// VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover): staging-cutover-select.sh and staging-cutover-ecs.sh
// against a stubbed AWS CLI (fixtures/cutover/bin/aws, state in a temp directory). Never calls AWS.
//   node --test scripts/ci/staging-db/cutover-ecs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const FX = path.join(HERE, 'fixtures', 'cutover');
const SELECT = path.join(ROOT, 'scripts/aws/staging-cutover-select.sh');
const ECS = path.join(ROOT, 'scripts/aws/staging-cutover-ecs.sh');
const C = 'Vitana-ECS-Cluster';
const NET = (sgs) => ({ awsvpcConfiguration: { subnets: ['subnet-0ff45a2051c5e5482', 'subnet-0c786864a28a5a821'], securityGroups: sgs, assignPublicIp: 'DISABLED' } });
const CLIENT_SG = 'sg-0abc1234def567890';
const APP_SG = 'sg-0fbcf7b59b1f0d685';
const arnOf = (fam, rev) => `arn:aws:ecs:eu-central-1:472838866351:task-definition/${fam}:${rev}`;

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-ecs-'));
  fs.mkdirSync(path.join(dir, 'services')); fs.mkdirSync(path.join(dir, 'td'));
  fs.writeFileSync(path.join(dir, 'log'), '');
  const put = (fam, rev, file) => {
    const td = JSON.parse(fs.readFileSync(path.join(FX, file), 'utf8'));
    fs.writeFileSync(path.join(dir, 'td', `${fam}:${rev}.json`), JSON.stringify({ ...td, family: fam, taskDefinitionArn: arnOf(fam, rev), revision: rev, status: 'ACTIVE', registeredAt: 'x' }));
  };
  for (let r = 1; r <= 41; r++) put('vitana-gateway', r, 'taskdef-gateway.json');
  for (let r = 1; r <= 7; r++) put('vitana-postgrest-aurora-staging', r, 'taskdef-postgrest.json');
  const svc = (name, td, count = 1) => fs.writeFileSync(path.join(dir, 'services', `${name}.json`), JSON.stringify({
    serviceName: name, status: 'ACTIVE', desiredCount: count, runningCount: count, networkConfiguration: NET([APP_SG]),
    deployments: [{ status: 'PRIMARY', taskDefinition: td, rolloutState: 'COMPLETED' }],
  }));
  svc('vitana-gateway', arnOf('vitana-gateway', 41));
  svc('vitana-postgrest-aurora-proxy', arnOf('vitana-postgrest-aurora-staging', 7));
  svc('vitana-gateway-iso', arnOf('vitana-gateway', 41), 0);
  svc('vitana-postgrest-aurora-staging-iso', arnOf('vitana-postgrest-aurora-staging', 7), 0);
  svc('vitana-gateway-awsdr', 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway-awsdr:9');
  return dir;
}
const env = (dir, extra = {}) => ({ ...process.env, PATH: `${path.join(FX, 'bin')}:${process.env.PATH}`, STUB_STATE: dir, AWS_REGION: 'eu-central-1', CUTOVER_WAIT_TIMEOUT_S: '2', CUTOVER_POLL_S: '0', ...extra });
const run = (dir, script, args, extra = {}, input) => spawnSync('bash', [script, ...args], { env: env(dir, extra), encoding: 'utf8', input });
const log = (dir) => fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n').filter(Boolean);
const service = (dir, s) => JSON.parse(fs.readFileSync(path.join(dir, 'services', `${s}.json`), 'utf8'));
const primary = (dir, s) => service(dir, s).deployments.find((d) => d.status === 'PRIMARY').taskDefinition;
const updates = (dir) => log(dir).filter((l) => l.startsWith('aws ecs update-service'));
const updatedServices = (dir) => updates(dir).map((l) => l.match(/--service (\S+)/)[1]);
const gwText = fs.readFileSync(path.join(FX, 'taskdef-gateway.json'), 'utf8');

// ---- staging-cutover-select.sh
test('select: unset / empty / shared + unmarked = the same bytes, no AWS call', () => {
  for (const plane of [undefined, '', 'shared']) {
    const dir = stage();
    const extra = plane === undefined ? {} : { STAGING_DATA_PLANE: plane };
    const r = run(dir, SELECT, ['--service', 'gateway'], extra, gwText);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, gwText);
    assert.deepEqual(log(dir), []);
  }
});

test('select: isolated refuses without STAGING_CUTOVER_APPROVED=yes; nothing on stdout, no AWS call', () => {
  const dir = stage();
  const r = run(dir, SELECT, ['--service', 'gateway'], { STAGING_DATA_PLANE: 'isolated', STAGING_CUTOVER_APPROVED: 'no' }, gwText);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /STAGING_CUTOVER_APPROVED/);
  assert.deepEqual(log(dir), []);
});

test('select: an unknown plane value is refused (fail closed)', () => {
  const dir = stage();
  const r = run(dir, SELECT, ['--service', 'gateway'], { STAGING_DATA_PLANE: 'Isolated' }, gwText);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
});

test('select: isolated with approval resolves only the staging-db secret ARNs (describe-secret, never get-secret-value)', () => {
  const dir = stage();
  const r = run(dir, SELECT, ['--service', 'gateway'], { STAGING_DATA_PLANE: 'isolated', STAGING_CUTOVER_APPROVED: 'yes' }, gwText);
  assert.equal(r.status, 0, r.stderr);
  const td = JSON.parse(r.stdout);
  assert.match(td.containerDefinitions[0].secrets.find((e) => e.name === 'AURORA_DATABASE_URL').valueFrom, /staging-db\/database-url-AbCdEf$/);
  assert.deepEqual(log(dir).map((l) => l.replace(/--secret-id (\S+).*/, '$1')), [
    'aws secretsmanager describe-secret vitana/aurora/staging-db/postgrest-authenticator-uri',
    'aws secretsmanager describe-secret vitana/aurora/staging-db/database-url',
  ]);
});

test('select: a staging-db secret that cannot be described refuses; nothing on stdout', () => {
  const dir = stage();
  const r = run(dir, SELECT, ['--service', 'postgrest'], { STAGING_DATA_PLANE: 'isolated', STAGING_CUTOVER_APPROVED: 'yes', STUB_MISSING_SECRETS: 'vitana/aurora/staging-db/postgrest-authenticator-uri' }, fs.readFileSync(path.join(FX, 'taskdef-postgrest.json'), 'utf8'));
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
});

// ---- staging-cutover-ecs.sh
test('ecs: record writes both live PRIMARY revisions and network configurations, and changes nothing', () => {
  const dir = stage();
  const rec = path.join(dir, 'rec.json');
  const r = run(dir, ECS, ['record', '--out', rec]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(fs.readFileSync(rec, 'utf8'));
  assert.equal(j.cluster, C);
  assert.deepEqual(j.services.map((s) => [s.service, s.taskDefinition]), [
    ['vitana-postgrest-aurora-proxy', arnOf('vitana-postgrest-aurora-staging', 7)], ['vitana-gateway', arnOf('vitana-gateway', 41)]]);
  assert.deepEqual(j.services[0].networkConfiguration, NET([APP_SG]));
  assert.deepEqual(updates(dir), []);
});

function recordAndFlip(dir, extra = {}) {
  const rec = path.join(dir, 'rec.json');
  assert.equal(run(dir, ECS, ['record', '--out', rec]).status, 0);
  return { rec, r: run(dir, ECS, ['flip', '--record', rec, '--client-sg', CLIENT_SG, '--out', path.join(dir, 'flipped.json')], { STAGING_CUTOVER_APPROVED: 'yes', ...extra }) };
}

test('ecs: flip rolls only the two live staging services to isolated revisions with the client SG added', () => {
  const dir = stage();
  const { r } = recordAndFlip(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(updatedServices(dir), ['vitana-postgrest-aurora-proxy', 'vitana-gateway']);
  assert.equal(primary(dir, 'vitana-gateway'), arnOf('vitana-gateway', 42));
  assert.deepEqual(service(dir, 'vitana-gateway').networkConfiguration.awsvpcConfiguration.securityGroups, [APP_SG, CLIENT_SG].sort());
  const reg = JSON.parse(fs.readFileSync(path.join(dir, 'registered-vitana-gateway.json'), 'utf8'));
  assert.equal(reg.containerDefinitions[0].environment.find((e) => e.name === 'VTID_ALLOCATOR_ENABLED').value, 'false');
  assert.equal(primary(dir, 'vitana-gateway-awsdr'), 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway-awsdr:9', 'production untouched');
});

test('ecs: rollback after a forced post-flip failure restores both recorded revisions and network configurations', () => {
  const dir = stage();
  const { rec, r } = recordAndFlip(dir);
  assert.equal(r.status, 0, r.stderr);
  // forced failure: the workflow's smoke step fails here; the rollback step runs because the record step succeeded
  const rb = run(dir, ECS, ['rollback', '--record', rec]);
  assert.equal(rb.status, 0, rb.stderr);
  assert.equal(primary(dir, 'vitana-gateway'), arnOf('vitana-gateway', 41));
  assert.equal(primary(dir, 'vitana-postgrest-aurora-proxy'), arnOf('vitana-postgrest-aurora-staging', 7));
  for (const s of ['vitana-gateway', 'vitana-postgrest-aurora-proxy']) assert.deepEqual(service(dir, s).networkConfiguration, NET([APP_SG]));
  assert.match(rb.stderr, /verified vitana-gateway on .*vitana-gateway:41/);
  assert.ok(updatedServices(dir).every((s) => ['vitana-gateway', 'vitana-postgrest-aurora-proxy'].includes(s)));
});

test('ecs: a failed flip half-way (gateway rollout FAILED) is still rolled back to the record', () => {
  const dir = stage();
  const { rec, r } = recordAndFlip(dir, { STUB_ROLL_FAIL: 'vitana-gateway' });
  assert.equal(r.status, 1, 'flip fails when the gateway does not stabilize');
  assert.equal(primary(dir, 'vitana-postgrest-aurora-proxy'), arnOf('vitana-postgrest-aurora-staging', 8), 'the proxy was already flipped');
  const rb = run(dir, ECS, ['rollback', '--record', rec]);
  assert.equal(rb.status, 0, rb.stderr);
  assert.equal(primary(dir, 'vitana-gateway'), arnOf('vitana-gateway', 41));
  assert.equal(primary(dir, 'vitana-postgrest-aurora-proxy'), arnOf('vitana-postgrest-aurora-staging', 7));
});

test('ecs: verify fails when a service is not on the expected revision', () => {
  const dir = stage();
  const { rec } = recordAndFlip(dir);
  const v = run(dir, ECS, ['verify', '--record', rec]);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /PRIMARY is .*vitana-gateway:42, expected .*vitana-gateway:41/);
  assert.equal(run(dir, ECS, ['verify', '--record', rec, '--flipped', path.join(dir, 'flipped.json')]).status, 0);
});

test('ecs: flip refuses without approval, with a bad SG, or when a service moved since the record (no update-service)', () => {
  for (const [extra, sg, mutate, re] of [
    [{ STAGING_CUTOVER_APPROVED: 'no' }, CLIENT_SG, null, /STAGING_CUTOVER_APPROVED/],
    [{ STAGING_CUTOVER_APPROVED: 'yes' }, 'sg-x', null, /security group/],
    [{ STAGING_CUTOVER_APPROVED: 'yes' }, CLIENT_SG, (dir) => { const s = service(dir, 'vitana-postgrest-aurora-proxy'); s.deployments[0].taskDefinition = arnOf('vitana-postgrest-aurora-staging', 6); fs.writeFileSync(path.join(dir, 'services', 'vitana-postgrest-aurora-proxy.json'), JSON.stringify(s)); }, /moved since it was recorded/],
  ]) {
    const dir = stage();
    const rec = path.join(dir, 'rec.json');
    run(dir, ECS, ['record', '--out', rec]);
    if (mutate) mutate(dir);
    const r = run(dir, ECS, ['flip', '--record', rec, '--client-sg', sg], extra);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, re);
    assert.deepEqual(updates(dir), []);
  }
});

test('ecs: wrong AWS account is refused before any ECS call', () => {
  const dir = stage();
  const r = run(dir, ECS, ['record', '--out', path.join(dir, 'rec.json')], { STUB_ACCOUNT: '111111111111' });
  assert.equal(r.status, 2);
  assert.deepEqual(log(dir).filter((l) => l.startsWith('aws ecs')), []);
});

test('ecs: candidate-register registers -iso families only and changes no service', () => {
  const dir = stage();
  const out = path.join(dir, 'reg.json');
  const r = run(dir, ECS, ['candidate-register', '--candidate-url', 'https://preview-iso-gateway.vitanaland.com', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(j.services.map((s) => s.taskDefinition), [arnOf('vitana-postgrest-aurora-staging-iso', 1), arnOf('vitana-gateway-iso', 1)]);
  assert.deepEqual(updates(dir), []);
  const reg = JSON.parse(fs.readFileSync(path.join(dir, 'registered-vitana-gateway-iso.json'), 'utf8'));
  assert.equal(reg.containerDefinitions[0].environment.find((e) => e.name === 'GATEWAY_URL').value, 'https://preview-iso-gateway.vitanaland.com');
});

test('ecs: candidate start/stop touch only the -iso services; stop leaves desired count 0', () => {
  const dir = stage();
  const out = path.join(dir, 'reg.json');
  run(dir, ECS, ['candidate-register', '--candidate-url', 'https://preview-iso-gateway.vitanaland.com', '--out', out]);
  assert.equal(run(dir, ECS, ['candidate-start', '--registered', out]).status, 0);
  assert.equal(service(dir, 'vitana-gateway-iso').desiredCount, 1);
  assert.equal(run(dir, ECS, ['candidate-stop']).status, 0);
  for (const s of ['vitana-gateway-iso', 'vitana-postgrest-aurora-staging-iso']) assert.equal(service(dir, s).desiredCount, 0);
  assert.deepEqual([...new Set(updatedServices(dir))].sort(), ['vitana-gateway-iso', 'vitana-postgrest-aurora-staging-iso']);
  assert.equal(primary(dir, 'vitana-gateway'), arnOf('vitana-gateway', 41), 'live staging untouched');
});

test('ecs: candidate-start refuses a registered revision of a live family', () => {
  const dir = stage();
  const reg = path.join(dir, 'reg.json');
  fs.writeFileSync(reg, JSON.stringify({ services: [{ service: 'vitana-postgrest-aurora-staging-iso', taskDefinition: arnOf('vitana-postgrest-aurora-staging', 7) }] }));
  const r = run(dir, ECS, ['candidate-start', '--registered', reg]);
  assert.equal(r.status, 2);
  assert.deepEqual(updates(dir), []);
});

test('ecs: name guard (guard subcommand) — production names refused, live and candidate scopes are disjoint', () => {
  const dir = stage();
  const g = (s, scope) => run(dir, ECS, ['guard', s, scope]).status;
  for (const s of ['vitana-gateway-awsdr', 'vitana-postgrest-aurora-proxy-prod', 'vitana-postgrest-aurora-prod']) {
    assert.equal(g(s, 'live'), 2, s); assert.equal(g(s, 'candidate'), 2, s);
  }
  assert.equal(g('vitana-gateway', 'live'), 0);
  assert.equal(g('vitana-gateway', 'candidate'), 2);
  assert.equal(g('vitana-gateway-iso', 'candidate'), 0);
  assert.equal(g('vitana-gateway-iso', 'live'), 2);
  assert.equal(g('vitana-kiro-runner', 'live'), 2);
  // a production name is refused even when someone puts it on an allow list
  assert.equal(run(dir, ECS, ['guard', 'vitana-gateway-awsdr', 'list', 'vitana-gateway vitana-gateway-awsdr']).status, 2);
  assert.equal(run(dir, ECS, ['guard', 'vitana-gateway', 'list', 'vitana-gateway vitana-gateway-awsdr']).status, 0);
});

// ---- staging-cutover-secrets.sh
const SECRETS = path.join(ROOT, 'scripts/aws/staging-cutover-secrets.sh');
const clusterState = (dir, over = {}) => fs.writeFileSync(path.join(dir, 'cluster.json'), JSON.stringify({
  DBClusterIdentifier: 'vitana-aurora-staging', Endpoint: 'vitana-aurora-staging.cluster-abc123.eu-central-1.rds.amazonaws.com',
  MasterUserSecret: { SecretArn: 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:rds!cluster-abc-XyZ' },
  TagList: [{ Key: 'vitana-env', Value: 'staging' }], ...over }));
const secretOf = (dir, name) => { const f = path.join(dir, 'secrets', encodeURIComponent(name)); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };

test('secrets: --plan makes no AWS call; a non-staging cluster and a missing cost approval are refused before any AWS call', () => {
  const dir = stage();
  assert.equal(run(dir, SECRETS, ['--plan', '--cluster', 'vitana-aurora-staging']).status, 0);
  assert.notEqual(run(dir, SECRETS, ['--cluster', 'vitana-aurora-prod'], { STAGING_DB_COST_APPROVED: 'yes' }).status, 0);
  assert.notEqual(run(dir, SECRETS, ['--cluster', 'vitana-aurora-staging']).status, 0);
  assert.deepEqual(log(dir), []);
});

test('secrets: fills both placeholders from the cluster endpoint with dedicated roles; never prints a password', () => {
  const dir = stage();
  clusterState(dir);
  const r = run(dir, SECRETS, ['--cluster', 'vitana-aurora-staging'], { STAGING_DB_COST_APPROVED: 'yes' });
  assert.equal(r.status, 0, r.stderr);
  const db = secretOf(dir, 'vitana/aurora/staging-db/database-url');
  const auth = secretOf(dir, 'vitana/aurora/staging-db/postgrest-authenticator-uri');
  assert.match(db, /^postgresql:\/\/vitana_staging_app:[0-9a-f]{48}@vitana-aurora-staging\.cluster-abc123\.eu-central-1\.rds\.amazonaws\.com:5432\/vitana\?sslmode=require$/);
  assert.match(auth, /^postgres:\/\/authenticator:[0-9a-f]{48}@vitana-aurora-staging\.cluster-abc123/);
  for (const pw of [db.split(':')[2].split('@')[0], auth.split(':')[2].split('@')[0]]) {
    assert.ok(!r.stdout.includes(pw) && !r.stderr.includes(pw), 'password printed');
  }
  const sql = log(dir).filter((l) => l.startsWith('aws rds-data execute-statement')).join('\n');
  assert.match(sql, /--resource-arn arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-staging /);
  assert.match(sql, /GRANT anon, authenticated, service_role TO authenticator/);
  assert.match(sql, /NOSUPERUSER NOBYPASSRLS/);
});

test('secrets: idempotent (already set = nothing changed); untagged or foreign-endpoint clusters are refused', () => {
  const dir = stage();
  clusterState(dir);
  assert.equal(run(dir, SECRETS, ['--cluster', 'vitana-aurora-staging'], { STAGING_DB_COST_APPROVED: 'yes' }).status, 0);
  const before = secretOf(dir, 'vitana/aurora/staging-db/database-url');
  const again = run(dir, SECRETS, ['--cluster', 'vitana-aurora-staging'], { STAGING_DB_COST_APPROVED: 'yes' });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already set; nothing changed/);
  assert.equal(secretOf(dir, 'vitana/aurora/staging-db/database-url'), before);
  for (const over of [{ TagList: [{ Key: 'vitana-env', Value: 'production' }] }, { Endpoint: 'vitana-aurora-prod.cluster-cfk.eu-central-1.rds.amazonaws.com' }]) {
    const d = stage();
    clusterState(d, over);
    assert.notEqual(run(d, SECRETS, ['--cluster', 'vitana-aurora-staging'], { STAGING_DB_COST_APPROVED: 'yes' }).status, 0);
    assert.equal(secretOf(d, 'vitana/aurora/staging-db/database-url'), null);
  }
});
