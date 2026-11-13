// VTID-05782 (plan autonomous-to-staging-r2, lane staging-db-provision): scripts/aws/staging-db-provision.sh and
// scripts/aws/staging-db-load.sh against a stub AWS CLI (fixtures/bin/aws). No AWS call is ever made.
//   node --test scripts/ci/staging-db/aws-scripts.test.mjs        (needs bash, jq, python3; UNIT.yml runners have them)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanText } from '../staging-prod-ref-guard.mjs';
import { bundleText, sha256 } from './build-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const PROVISION = path.join(ROOT, 'scripts/aws/staging-db-provision.sh');
const LOAD = path.join(ROOT, 'scripts/aws/staging-db-load.sh');
const STUB_BIN = path.join(HERE, 'fixtures/bin');

function sh(script, args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-aws-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${STUB_BIN}:${process.env.PATH}`, HOME: dir, STUB_LOG: log, ...env },
  });
  return { ...r, calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

/** A small valid bundle in a temp dir; returns { dir, hash }. */
function bundle({ parts = [{ name: 'supabase/migrations/20990101000000_x.sql', sql: 'CREATE TABLE public.t (id int);\nINSERT INTO public.t VALUES (1);\n' }] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-bundle-'));
  const text = bundleText(parts);
  const hash = 'b'.repeat(64);
  fs.writeFileSync(path.join(dir, 'bundle.sql'), text);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 'vitana.staging-db-bundle/v1', schema_hash: hash, bundle_sha256: sha256(text), production_references: [],
    files: parts.map((p, n) => ({ n, name: p.name, sha256: sha256(p.sql) })),
  }));
  return { dir, hash };
}

// ---- provision --------------------------------------------------------------------------------------------------
test('provision --plan makes no AWS call and prints no production identifier', () => {
  const r = sh(PROVISION, ['--plan', '--cluster', 'vitana-aurora-staging']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [], 'no aws call in --plan');
  assert.deepEqual(scanText(r.stdout + r.stderr, 'plan-output.txt'), []);
  assert.match(r.stdout, /create-db-cluster .*--db-cluster-identifier vitana-aurora-staging .*--engine aurora-postgresql --engine-version 16\.4/);
  assert.match(r.stdout, /--manage-master-user-password/);
  assert.match(r.stdout, /--serverless-v2-scaling-configuration MinCapacity=0,MaxCapacity=2,SecondsUntilAutoPause=300/);
  assert.match(r.stdout, /--backup-retention-period 1 --deletion-protection/);
  assert.match(r.stdout, /--storage-encrypted --kms-key-id <StackOutput:KmsKeyArn>/);
  assert.match(r.stdout, /Key=vitana-env,Value=staging/);
  assert.match(r.stdout, /enable-http-endpoint/);
  assert.match(r.stdout, /db\.serverless --no-publicly-accessible/);
});

test('provision --plan option B: min 0.5 ACU, no auto-pause', () => {
  const r = sh(PROVISION, ['--plan', '--cluster', 'vitana-aurora-staging', '--min-acu', '0.5']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MinCapacity=0\.5,MaxCapacity=2(\s|$)/);
});

for (const name of ['vitana-aurora-prod', 'vitana-aurora-staging-prod', 'vitana-aurora', 'my-db', 'vitana-aurora-stagingx', 'VITANA-AURORA-STAGING', 'vitana-aurora-staging;rm']) {
  test(`provision refuses cluster "${name}" before any AWS call (plan and apply)`, () => {
    for (const mode of ['--plan', '--apply']) {
      const r = sh(PROVISION, [mode, '--cluster', name], { STAGING_DB_COST_APPROVED: 'yes' });
      assert.equal(r.status, 1, `${mode} ${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /refused: cluster/);
      assert.deepEqual(r.calls, []);
    }
  });
}

test('provision refuses capacity above the 2 ACU cap and an engine below 16.3', () => {
  assert.equal(sh(PROVISION, ['--plan', '--cluster', 'vitana-aurora-staging', '--max-acu', '4']).status, 1);
  assert.equal(sh(PROVISION, ['--plan', '--cluster', 'vitana-aurora-staging', '--min-acu', '1']).status, 1);
  assert.equal(sh(PROVISION, ['--plan', '--cluster', 'vitana-aurora-staging', '--engine-version', '15.4']).status, 1);
  assert.equal(sh(PROVISION, ['--plan', '--cluster', 'vitana-aurora-staging', '--engine-version', '16.2']).status, 1);
  assert.equal(sh(PROVISION, ['--plan', '--cluster', 'vitana-aurora-staging', '--engine-version', '16.6']).status, 0);
});

test('provision --apply refuses without the cost approval, with no AWS call', () => {
  for (const v of [undefined, '', 'no', 'YES', 'true']) {
    const r = sh(PROVISION, ['--apply', '--cluster', 'vitana-aurora-staging'], v === undefined ? {} : { STAGING_DB_COST_APPROVED: v });
    assert.equal(r.status, 1, String(v));
    assert.match(r.stderr, /STAGING_DB_COST_APPROVED/);
    assert.deepEqual(r.calls, []);
  }
});

test('provision --apply refuses credentials of another account', () => {
  const r = sh(PROVISION, ['--apply', '--cluster', 'vitana-aurora-staging'], { STAGING_DB_COST_APPROVED: 'yes', STUB_ACCOUNT: '111111111111' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected 472838866351/);
  assert.deepEqual(r.calls, ['aws sts get-caller-identity --query Account --output text']);
});

test('provision --apply creates cluster and writer from the stack outputs, then enables the Data API', () => {
  const r = sh(PROVISION, ['--apply', '--cluster', 'vitana-aurora-staging'], { STAGING_DB_COST_APPROVED: 'yes' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const create = r.calls.find((c) => /rds create-db-cluster/.test(c));
  assert.ok(create, r.calls.join('\n'));
  assert.match(create, /--kms-key-id arn:aws:kms:eu-central-1:472838866351:key\/11111111/);
  assert.match(create, /--db-subnet-group-name vitana-aurora-staging --vpc-security-group-ids sg-0123456789abcdef0/);
  assert.match(create, /MinCapacity=0,MaxCapacity=2,SecondsUntilAutoPause=300/);
  assert.ok(r.calls.some((c) => /rds create-db-instance .*--db-instance-identifier vitana-aurora-staging-writer/.test(c)));
  assert.ok(r.calls.some((c) => /rds enable-http-endpoint .*cluster:vitana-aurora-staging( |$)/.test(c)));
  assert.deepEqual(scanText(r.calls.join('\n'), 'calls.txt'), [], 'no production identifier in any call');
  assert.ok(!r.calls.some((c) => /delete-|restore-|copy-db|create-db-cluster-snapshot/.test(c)), 'no delete, restore or copy');
});

test('provision --apply leaves an existing cluster as it is', () => {
  const r = sh(PROVISION, ['--apply', '--cluster', 'vitana-aurora-staging'], { STAGING_DB_COST_APPROVED: 'yes', STUB_CLUSTER_EXISTS: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /exists already: nothing is created/);
  assert.ok(!r.calls.some((c) => /create-db-cluster|modify-db-cluster/.test(c)));
});

// ---- load ---------------------------------------------------------------------------------------------------------
test('load --dry-run checks the bundle and makes no AWS call', () => {
  const { dir } = bundle();
  const r = sh(LOAD, ['--cluster', 'vitana-aurora-staging', '--bundle', dir, '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 part\(s\) split into 2 statement\(s\); no AWS call made/);
  assert.deepEqual(r.calls, []);
});

test('load refuses a non-staging cluster and a tampered bundle before any AWS call', () => {
  const { dir } = bundle();
  let r = sh(LOAD, ['--cluster', 'vitana-aurora-prod', '--bundle', dir], { STAGING_DB_COST_APPROVED: 'yes' });
  assert.equal(r.status, 1); assert.deepEqual(r.calls, []);
  fs.appendFileSync(path.join(dir, 'bundle.sql'), 'DROP TABLE public.t;\n');
  r = sh(LOAD, ['--cluster', 'vitana-aurora-staging', '--bundle', dir], { STAGING_DB_COST_APPROVED: 'yes' });
  assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /sha256/); assert.deepEqual(r.calls, []);
});

test('load refuses a bundle that names production outside the reviewed allow list', () => {
  const { dir } = bundle({ parts: [{ name: 'supabase/migrations/20990101000000_x.sql', sql: "SELECT 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';\n" }] });
  const r = sh(LOAD, ['--cluster', 'vitana-aurora-staging', '--bundle', dir], { STAGING_DB_COST_APPROVED: 'yes' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /supabase-project-ref/);
  assert.deepEqual(r.calls, []);
});

test('load refuses without the cost approval (verify-only needs none)', () => {
  const { dir, hash } = bundle();
  const r = sh(LOAD, ['--cluster', 'vitana-aurora-staging', '--bundle', dir]);
  assert.equal(r.status, 1); assert.match(r.stderr, /STAGING_DB_COST_APPROVED/); assert.deepEqual(r.calls, []);
  const v = sh(LOAD, ['--cluster', 'vitana-aurora-staging', '--bundle', dir, '--verify-only'], { STUB_CLUSTER_EXISTS: '1', STUB_HASH: hash });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.ok(!v.calls.some((c) => /begin-transaction/.test(c)), 'verify-only changes nothing');
});

test('load applies each part in one Data API transaction and passes when the cluster hash matches', () => {
  const { dir, hash } = bundle();
  const r = sh(LOAD, ['--cluster', 'vitana-aurora-staging', '--bundle', dir], { STAGING_DB_COST_APPROVED: 'yes', STUB_CLUSTER_EXISTS: '1', STUB_HASH: hash });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Schema hash matches the bundle/);
  assert.equal(r.calls.filter((c) => /begin-transaction/.test(c)).length, 1);
  assert.equal(r.calls.filter((c) => /commit-transaction/.test(c)).length, 1);
  assert.ok(r.calls.every((c) => !/cluster:vitana-aurora-(?!staging)/.test(c)));
});

test('load refuses a schema hash mismatch (stubbed Data API)', () => {
  const { dir } = bundle();
  for (const mode of [[], ['--verify-only']]) {
    const r = sh(LOAD, ['--cluster', 'vitana-aurora-staging', '--bundle', dir, ...mode], { STAGING_DB_COST_APPROVED: 'yes', STUB_CLUSTER_EXISTS: '1', STUB_HASH: 'c'.repeat(64) });
    assert.equal(r.status, 1, mode.join(' '));
    assert.match(r.stderr, /schema hash mismatch on vitana-aurora-staging: cluster c{64}, bundle b{64}/);
  }
});

test('load refuses a cluster whose public schema is not empty, or that is not tagged staging', () => {
  const { dir, hash } = bundle();
  let r = sh(LOAD, ['--cluster', 'vitana-aurora-staging', '--bundle', dir], { STAGING_DB_COST_APPROVED: 'yes', STUB_CLUSTER_EXISTS: '1', STUB_HASH: hash, STUB_PUBLIC_RELATIONS: '5' });
  assert.equal(r.status, 1); assert.match(r.stderr, /not empty/);
  assert.ok(!r.calls.some((c) => /begin-transaction/.test(c)));
  r = sh(LOAD, ['--cluster', 'vitana-aurora-staging', '--bundle', dir], { STAGING_DB_COST_APPROVED: 'yes', STUB_CLUSTER_EXISTS: '1', STUB_HASH: hash, STUB_TAG: 'production' });
  assert.equal(r.status, 1); assert.match(r.stderr, /not tagged vitana-env=staging/);
});

test('a failing statement rolls the part back and stops the load', () => {
  const { dir, hash } = bundle();
  const r = sh(LOAD, ['--cluster', 'vitana-aurora-staging', '--bundle', dir], { STAGING_DB_COST_APPROVED: 'yes', STUB_CLUSTER_EXISTS: '1', STUB_HASH: hash, STUB_FAIL_SQL: 'INSERT INTO public.t' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /statement 2 of 2 failed; the part was rolled back/);
  assert.ok(r.calls.some((c) => /rollback-transaction/.test(c)));
  assert.ok(!r.calls.some((c) => /commit-transaction/.test(c)));
});
