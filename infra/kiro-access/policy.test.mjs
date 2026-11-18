// VTID-05764 (plan autonomous-to-staging, lane kiro-aws-access): static policy tests for the Kiro AWS roles.
//
//   node --test infra/kiro-access/*.test.mjs        (AWS-KIRO-ACCESS.yml; no AWS call, no credential)
//
// The CloudFormation templates are JSON so they can be read without a YAML parser. Each test evaluates the role's
// statements with a small IAM evaluator (explicit Deny wins, then Allow, else implicit deny) for the actions and ARNs
// that matter: every production resource is denied write in kiro-staging-operator, staging resources are the only
// write targets, the boundary blocks IAM changes to the role itself, and kiro-engineering-admin can never delete the
// GitLab instances, volumes or backups or read the GitLab credential secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, statementsOf, staticDrift } from './lib.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const ids = load('identifiers.json');
const P = ids.accounts.product;
const E = ids.accounts.engineering;
const R = ids.region;
const op = load('staging-operator.json');
const adm = load('engineering-admin.json');
const src = load('source-principal.json');
const opRole = statementsOf(op, 'StagingOperatorRole');
const opBoundary = statementsOf(op, 'StagingBoundary');
const both = (action, arn, opts = {}) => {
  const a = evaluate(opRole, action, arn, opts);
  const b = evaluate(opBoundary, action, arn, opts);
  return a === 'allow' && b === 'allow' ? 'allow' : 'deny';
};

const svc = (n) => `arn:aws:ecs:${R}:${P}:service/${ids.ecs_cluster}/${n}`;
const PROD_WRITES = [
  ['ecs:UpdateService', svc('vitana-gateway-awsdr')],
  ['ecs:UpdateService', svc('vitana-kiro-runner-awsdr')],
  ['ecs:UpdateService', svc('vitana-postgrest-aurora-proxy-prod')],
  ['ecs:DeleteService', svc('vitana-gateway-awsdr')],
  ['rds:ModifyDBCluster', `arn:aws:rds:${R}:${P}:cluster:vitana-aurora-prod`],
  ['rds:DeleteDBCluster', `arn:aws:rds:${R}:${P}:cluster:vitana-aurora-prod`],
  ['rds-data:ExecuteStatement', `arn:aws:rds:${R}:${P}:cluster:vitana-aurora-prod`],
  ['rds:ModifyDBProxy', `arn:aws:rds:${R}:${P}:db-proxy:vitana-rds-proxy-prod`],
  ['elasticloadbalancing:ModifyListener', `arn:aws:elasticloadbalancing:${R}:${P}:loadbalancer/app/vitana-alb-prod/abc`],
  ['secretsmanager:GetSecretValue', `arn:aws:secretsmanager:${R}:${P}:secret:vitana/aurora/prod/database-url-URDvEh`],
  ['secretsmanager:PutSecretValue', `arn:aws:secretsmanager:${R}:${P}:secret:vitana/supabase/prod/service-role-key-abc`],
  ['kms:Decrypt', ids.production.kms_keys[0]],
  ['kms:ScheduleKeyDeletion', ids.production.kms_keys[0]],
];

test('kiro-staging-operator: every production resource is denied (role and boundary)', () => {
  for (const [a, arn] of PROD_WRITES) {
    assert.equal(evaluate(opRole, a, arn), 'deny', `role allows ${a} on ${arn}`);
    assert.equal(both(a, arn), 'deny', `${a} on ${arn}`);
  }
});

test('kiro-staging-operator: production denies are explicit, not only implicit', () => {
  for (const [a, arn] of PROD_WRITES) assert.equal(evaluate(opRole, a, arn, { explicitOnly: true }), 'deny', `no explicit Deny for ${a} on ${arn}`);
});

test('kiro-staging-operator: staging writes are allowed only on the pinned staging ARNs', () => {
  // Review 2026-11-12 (round 2): no ECS write at all, staging services included (shared cluster, task role, ALB, Cloud Map).
  for (const n of [...ids.staging.ecs_services, 'vitana-oasis-operator-awsdr', 'some-new-service']) {
    for (const a of ['ecs:UpdateService', 'ecs:RunTask', 'ecs:StartTask', 'ecs:ExecuteCommand']) {
      assert.equal(both(a, svc(n)), 'deny', `${a} ${n}`);
      assert.equal(evaluate(opRole, a, svc(n), { explicitOnly: true }), 'deny', `no explicit Deny for ${a} ${n}`);
    }
  }
  const cl = `arn:aws:rds:${R}:${P}:cluster:${ids.staging.rds_cluster}`;
  assert.equal(both('rds-data:ExecuteStatement', cl), 'allow');
  assert.equal(both('rds:ModifyDBCluster', cl), 'allow');
  assert.equal(both('rds:DeleteDBCluster', cl), 'deny', 'deleting the staging cluster stays an owner action');
  assert.equal(both('secretsmanager:PutSecretValue', `arn:aws:secretsmanager:${R}:${P}:secret:vitana/gateway/staging/internal-token-abc`), 'allow');
  assert.equal(both('secretsmanager:PutSecretValue', `arn:aws:secretsmanager:${R}:${P}:secret:vitana/github/pat-abc`), 'deny');
});

test('kiro-staging-operator: reads are allowed, secret values are not read', () => {
  assert.equal(both('ecs:DescribeServices', '*'), 'allow');
  assert.equal(both('rds:DescribeDBClusters', '*'), 'allow');
  assert.equal(both('logs:FilterLogEvents', `arn:aws:logs:${R}:${P}:log-group:/ecs/vitana-gateway:*`), 'allow');
  assert.equal(both('secretsmanager:GetSecretValue', `arn:aws:secretsmanager:${R}:${P}:secret:vitana/gateway/staging/openai-api-key-abc`), 'deny');
  assert.equal(both('secretsmanager:DescribeSecret', `arn:aws:secretsmanager:${R}:${P}:secret:vitana/gateway/staging/openai-api-key-abc`), 'allow');
});

test('kiro-staging-operator: the boundary blocks IAM changes, including to the role itself', () => {
  const self = `arn:aws:iam::${P}:role/kiro-staging-operator`;
  for (const a of ['iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:DeleteRolePermissionsBoundary', 'iam:UpdateAssumeRolePolicy', 'iam:CreateUser', 'iam:CreateAccessKey']) {
    assert.equal(both(a, self), 'deny', a);
    assert.equal(evaluate(opBoundary, a, self, { explicitOnly: true }), 'deny', `boundary has no explicit Deny for ${a}`);
  }
  const role = op.Resources.StagingOperatorRole.Properties;
  assert.deepEqual(role.PermissionsBoundary, { Ref: 'StagingBoundary' });
  assert.equal(role.RoleName, 'kiro-staging-operator');
});

test('kiro-staging-operator: trust is the engineering source principal with an external id and a session tag', () => {
  const trust = op.Resources.StagingOperatorRole.Properties.AssumeRolePolicyDocument.Statement;
  const s = trust.find((x) => (x.Action || []).includes('sts:AssumeRole'));
  assert.ok(s, 'sts:AssumeRole statement');
  assert.deepEqual(s.Principal, { AWS: `arn:aws:iam::${E}:user/kiro-agent-source` });
  assert.ok(s.Condition?.StringEquals?.['sts:ExternalId'], 'external id condition');
  assert.ok(s.Condition?.StringLike?.['aws:RequestTag/kiro-session'], 'kiro-session tag required');
  assert.ok(trust.some((x) => (x.Action || []).includes('sts:TagSession')), 'sts:TagSession allowed');
});

test('kiro-engineering-admin: AdministratorAccess with the GitLab deletes and credential secrets denied', () => {
  const st = statementsOf(adm, 'EngineeringAdminRole');
  const inst = `arn:aws:ec2:${R}:${E}:instance/i-0123456789abcdef0`;
  const tag = { 'aws:ResourceTag/Name': 'vitana-eng-gitlab' };
  assert.equal(evaluate(st, 'ec2:TerminateInstances', inst, { context: tag }), 'deny');
  assert.equal(evaluate(st, 'ec2:DeleteVolume', `arn:aws:ec2:${R}:${E}:volume/vol-0abc`, { context: tag }), 'deny');
  assert.equal(evaluate(st, 'ec2:StartInstances', inst, { context: tag }), 'allow', 'admin otherwise');
  const b = ids.engineering_protected.buckets[0];
  for (const a of ['s3:DeleteBucket', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutLifecycleConfiguration', 's3:PutBucketPolicy']) {
    assert.equal(evaluate(st, a, a === 's3:DeleteBucket' || a.startsWith('s3:PutB') || a === 's3:PutLifecycleConfiguration' ? `arn:aws:s3:::${b}` : `arn:aws:s3:::${b}/x.tar`), 'deny', a);
  }
  for (const s of ids.engineering_protected.secrets) for (const a of ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:DeleteSecret']) {
    assert.equal(evaluate(st, a, `arn:aws:secretsmanager:${R}:${E}:secret:${s}-AbCdEf`), 'deny', `${a} ${s}`);
  }
  assert.equal(evaluate(st, 'iam:DeleteRolePermissionsBoundary', `arn:aws:iam::${E}:role/kiro-engineering-admin`), 'deny');
  assert.equal(evaluate(st, 'iam:DeleteRolePolicy', `arn:aws:iam::${E}:role/kiro-engineering-admin`), 'deny', 'cannot remove its own denies');
  const role = adm.Resources.EngineeringAdminRole.Properties;
  assert.ok(role.ManagedPolicyArns.includes('arn:aws:iam::aws:policy/AdministratorAccess'));
});

test('source principal: may only assume the two Kiro roles; no inline admin, no console', () => {
  const st = statementsOf(src, 'KiroAgentSource');
  const context = { 'aws:RequestTag/kiro-session': 'kiro-exafy-202611121900-abcd' };
  assert.equal(evaluate(st, 'sts:AssumeRole', `arn:aws:iam::${P}:role/kiro-staging-operator`, { context }), 'allow');
  assert.equal(evaluate(st, 'sts:AssumeRole', `arn:aws:iam::${E}:role/kiro-engineering-admin`, { context }), 'allow');
  assert.equal(evaluate(st, 'sts:AssumeRole', `arn:aws:iam::${E}:role/kiro-engineering-admin`), 'deny', 'no kiro-session tag, no assumption');
  assert.equal(evaluate(st, 'sts:AssumeRole', `arn:aws:iam::${P}:role/vitana-gha-prod-deploy`, { context }), 'deny');
  assert.equal(evaluate(st, 's3:ListBucket', '*'), 'deny');
  assert.equal(src.Resources.KiroAgentSource.Properties.LoginProfile, undefined, 'no console password');
  assert.equal(JSON.stringify(src).includes('AccessKey'), false, 'the template creates no access key (the owner creates it, §handoff)');
});

test('static drift: no allow-list entry names a production resource', () => {
  assert.deepEqual(staticDrift(op, ids), []);
  const bad = JSON.parse(JSON.stringify(op));
  bad.Resources.StagingOperatorRole.Properties.Policies[0].PolicyDocument.Statement.push({ Sid: 'Oops', Effect: 'Allow', Action: ['ecs:UpdateService'], Resource: [svc('vitana-gateway-awsdr')] });
  assert.ok(staticDrift(bad, ids).some((f) => /vitana-gateway-awsdr/.test(f)));
});

test('no static credential in the templates or docs', () => {
  for (const f of fs.readdirSync(DIR)) {
    const t = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.doesNotMatch(t, /AKIA[0-9A-Z]{16}/, `${f} holds an access key id`);
    assert.doesNotMatch(t, /aws_secret_access_key\s*=\s*\S{20,}/i, `${f} holds a secret key`);
  }
});

// ── Review findings of 2026-11-12 (agent-vitana-lane-reviewer-202611121915-6516) ─────────────────────────────────
test('kiro-staging-operator: no iam:PassRole at all (staging shares the production gateway task role)', () => {
  for (const r of [...ids.production.shared_task_roles, `arn:aws:iam::${P}:role/vitana-ecs-execution-role`, `arn:aws:iam::${P}:role/anything`]) {
    assert.equal(both('iam:PassRole', r), 'deny', r);
  }
  assert.ok(opRole.filter((s) => s.Effect === 'Allow').every((s) => ![].concat(s.Action).some((a) => /^iam:(PassRole|\*)$|^\*$/.test(a))), 'no Allow statement names iam:PassRole');
  assert.equal(both('ecs:RegisterTaskDefinition', '*'), 'deny', 'no task-definition registration without PassRole');
});

test('kiro-staging-operator: no service can be pointed at any task definition (no family deny-list to bypass)', () => {
  for (const td of [`arn:aws:ecs:${R}:${P}:task-definition/vitana-autopilot-executor:7`, 'vitana-gateway-awsdr', 'vitana-gateway:900']) {
    assert.equal(both('ecs:UpdateService', svc('vitana-gateway'), { context: { 'ecs:task-definition': td } }), 'deny', td);
  }
});

test('kiro-staging-operator: every production secret prefix is denied explicitly', () => {
  for (const pre of ids.production.secret_prefixes) {
    const arn = `arn:aws:secretsmanager:${R}:${P}:secret:${pre}x-AbCdEf`;
    for (const a of ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue']) {
      assert.equal(evaluate(opRole, a, arn, { explicitOnly: true }), 'deny', `${a} ${pre}`);
      assert.equal(evaluate(opBoundary, a, arn, { explicitOnly: true }), 'deny', `boundary ${a} ${pre}`);
    }
  }
});

test('kiro-engineering-admin: no IAM escalation path (create, attach, pass, chain)', () => {
  const st = statementsOf(adm, 'EngineeringAdminRole');
  for (const [a, r] of [['iam:CreateRole', `arn:aws:iam::${E}:role/x`], ['iam:CreatePolicyVersion', `arn:aws:iam::${E}:policy/x`], ['iam:AttachRolePolicy', `arn:aws:iam::${E}:role/vitana-eng-gitlab`], ['iam:PutUserPolicy', `arn:aws:iam::${E}:user/x`], ['iam:CreateUser', `arn:aws:iam::${E}:user/x`], ['iam:PassRole', `arn:aws:iam::${E}:role/vitana-eng-runner`], ['sts:AssumeRole', `arn:aws:iam::${E}:role/OrganizationAccountAccessRole`], ['iam:UpdateAssumeRolePolicy', `arn:aws:iam::${E}:role/x`]]) {
    assert.equal(evaluate(st, a, r), 'deny', `${a} ${r}`);
  }
});

test('kiro-engineering-admin: KMS keys cannot be disabled, deleted or re-policied', () => {
  const st = statementsOf(adm, 'EngineeringAdminRole');
  const k = `arn:aws:kms:${R}:${E}:key/1111-2222`;
  for (const a of ['kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy', 'kms:DeleteAlias', 'kms:DisableKeyRotation']) assert.equal(evaluate(st, a, k), 'deny', a);
  assert.equal(evaluate(st, 'kms:Decrypt', k), 'allow', 'use stays allowed');
});

test('kiro-engineering-admin: no shell or re-root on the GitLab host; no volume or snapshot deletion anywhere', () => {
  const st = statementsOf(adm, 'EngineeringAdminRole');
  const inst = `arn:aws:ec2:${R}:${E}:instance/i-0123456789abcdef0`;
  const tag = { 'aws:ResourceTag/Name': 'vitana-eng-gitlab' };
  for (const a of ['ssm:SendCommand', 'ssm:StartSession', 'ec2-instance-connect:SendSSHPublicKey', 'ec2:CreateReplaceRootVolumeTask', 'ec2:ModifyInstanceAttribute']) assert.equal(evaluate(st, a, inst, { context: tag }), 'deny', a);
  for (const [a, r] of [['ec2:DeleteVolume', `arn:aws:ec2:${R}:${E}:volume/vol-untagged`], ['ec2:DeleteSnapshot', `arn:aws:ec2:${R}::snapshot/snap-untagged`], ['ec2:CreateSnapshot', `arn:aws:ec2:${R}:${E}:volume/vol-untagged`], ['ec2:CopySnapshot', `arn:aws:ec2:${R}::snapshot/snap-untagged`], ['ec2:CreateVolume', `arn:aws:ec2:${R}:${E}:volume/*`]]) assert.equal(evaluate(st, a, r), 'deny', `${a} without any tag`);
  assert.equal(evaluate(st, 'ec2:AttachVolume', inst, { context: tag }), 'deny', 'no volume swapped into the GitLab host');
  assert.equal(evaluate(st, 'ssm:SendCommand', inst, { context: { 'aws:ResourceTag/Name': 'vitana-eng-runner' } }), 'allow', 'runners stay operable');
});

test('kiro-engineering-admin: every GitLab runner token, including fleet class tokens, is denied', () => {
  const st = statementsOf(adm, 'EngineeringAdminRole');
  for (const n of ['runner-token', 'docker-runner-token', 'heavy-runner-token', 'github-bridge-token', 'root-password']) {
    assert.equal(evaluate(st, 'secretsmanager:GetSecretValue', `arn:aws:secretsmanager:${R}:${E}:secret:vitana/engineering/gitlab/${n}-AbCdEf`), 'deny', n);
  }
});

test('evaluator: resources match case-sensitively, actions case-insensitively', () => {
  const st = [{ Effect: 'Allow', Action: 'S3:GetObject', Resource: 'arn:aws:s3:::Bucket/*' }];
  assert.equal(evaluate(st, 's3:getobject', 'arn:aws:s3:::Bucket/x'), 'allow');
  assert.equal(evaluate(st, 's3:GetObject', 'arn:aws:s3:::bucket/x'), 'deny');
});
