// VTID-05782 (plan autonomous-to-staging-r2, lane staging-db-provision): the staging production-reference guard.
//   node --test scripts/ci/staging-db/prod-ref-guard.test.mjs        (UNIT.yml; no install, no AWS)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_IDENTIFIERS, scanText, defaultFiles, run } from '../staging-prod-ref-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const GUARD = path.join(ROOT, 'scripts/ci/staging-prod-ref-guard.mjs');
const FIX = 'scripts/ci/staging-db/fixtures/guard';
const cli = (...args) => spawnSync(process.execPath, [GUARD, ...args], { cwd: ROOT, encoding: 'utf8' });

test('guard lists every production identifier of plan §3.3 and the gate invariant', () => {
  const literals = PRODUCTION_IDENTIFIERS.map((p) => p.literal).filter(Boolean);
  for (const id of ['inmkhvwdcuyhnxkgfvsb', 'vitana-aurora-prod', 'AWS_PROD_ROLE_ARN', 'vitana/aurora/prod/',
    'vitana/aurora/prod/postgrest-authenticator-uri', 'vitana/supabase/prod/', 'vitana-alb-prod',
    'arn:aws:kms:eu-central-1:472838866351:key/1cd1f8d1-fc05-4de8-acdd-76e76b8a39d1']) {
    assert.ok(literals.includes(id), `missing ${id}`);
  }
  assert.ok(scanText('svc vitana-kiro-runner-awsdr', 'x.sh').some((f) => f.id === 'awsdr-service'));
});

for (const [file, id] of [
  ['config.json', 'supabase-project-ref'],
  ['workflow.yml', 'prod-role-secret'],
  ['taskdef.json', 'aurora-prod-secret'],
  ['cluster.sh', 'aurora-cluster'],
  ['awsdr-service.sh', 'awsdr-service'],
  ['supabase-secret.yml', 'supabase-prod-secret-prefix'],
  ['kms-allow.json', 'kms-key'],
]) {
  test(`--enforce fails on the ${file} fixture (${id})`, () => {
    const r = cli('--enforce', '--files', `${FIX}/${file}`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /ERROR /);
    const findings = scanText(fs.readFileSync(path.join(ROOT, FIX, file), 'utf8'), file);
    assert.ok(findings.some((f) => f.id === id), JSON.stringify(findings));
  });
}

test('--report lists the same findings and exits 0 (default mode)', () => {
  const r = cli('--files', `${FIX}/cluster.sh`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /REPORT .*cluster\.sh:3: production Aurora cluster \(vitana-aurora-prod\)/);
});

test('a clean staging file passes --enforce', () => {
  const r = cli('--enforce', '--files', `${FIX}/clean.sh`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 production reference/);
});

test('CloudFormation: an identifier inside an Effect=Deny statement is not a finding; the same outside is', () => {
  assert.equal(cli('--enforce', '--files', `${FIX}/deny-only.json`).status, 0);
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, FIX, 'deny-only.json'), 'utf8'));
  const st = tpl.Resources.R.Properties.PolicyDocument.Statement;
  st[1].Effect = 'Allow';
  const f = scanText(JSON.stringify(tpl, null, 2), 'mut.json');
  assert.ok(f.some((x) => x.id === 'aurora-cluster'), JSON.stringify(f));
  // A Deny-only exception applies to JSON templates only, never to a script line that says Deny.
  assert.ok(scanText('# "Effect": "Deny" vitana-aurora-prod', 'x.sh').length > 0);
});

test('usage errors exit 2', () => {
  assert.equal(cli('--bogus').status, 2);
  assert.equal(cli('--files').status, 2);
  assert.equal(cli('--files', 'does/not/exist').status, 2);
});

test('the default set covers staging workflows, staging scripts and infra/staging-db, never fixtures or tests', () => {
  const files = defaultFiles(ROOT);
  assert.ok(files.includes('.github/workflows/AWS-STAGE-PROVISION-DB.yml'));
  assert.ok(files.includes('.github/workflows/STAGING-DB-SCHEMA.yml'));
  assert.ok(files.includes('.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'));
  assert.ok(files.includes('scripts/aws/staging-db-provision.sh'));
  assert.ok(files.includes('scripts/aws/staging-db-load.sh'));
  assert.ok(files.includes('infra/staging-db/stack.yaml'));
  assert.ok(files.includes('scripts/ci/staging-db/build-schema.mjs'));
  assert.ok(!files.some((f) => /fixtures\//.test(f) || /\.test\.mjs$/.test(f) || f === 'scripts/ci/staging-prod-ref-guard.mjs'));
});

test('report mode over the default set exits 0 even though today\'s shared staging deploy names production', () => {
  const lines = [];
  assert.equal(run([], { root: ROOT, log: (l) => lines.push(l) }), 0);
  assert.ok(lines.some((l) => /AWS-STAGE-DEPLOY-GATEWAY\.yml/.test(l)), 'the shared staging plane is reported');
});

test('the isolated staging plane of this lane has no production reference (--enforce over its own files)', () => {
  const own = ['infra/staging-db', 'scripts/aws/staging-db-provision.sh', 'scripts/aws/staging-db-load.sh',
    'scripts/aws/staging-db-common.sh', '.github/workflows/AWS-STAGE-PROVISION-DB.yml', '.github/workflows/STAGING-DB-SCHEMA.yml',
    'scripts/ci/staging-db/build-schema.mjs'];
  const r = cli('--enforce', '--files', ...own);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /0 production reference/);
});
