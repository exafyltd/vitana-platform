// VTID-05782 (plan autonomous-to-staging-r2, lane staging-db-provision): static tests of infra/staging-db/stack.yaml,
// the owner-applied staging database stack (design.md §4, §6). No AWS call, no credential, no install.
//   node --test scripts/ci/staging-db/stack.test.mjs
// The template is JSON (valid YAML), so it is read without a YAML parser. IAM statements are evaluated with the
// evaluator of infra/kiro-access/lib.mjs (explicit Deny wins, then Allow, else implicit deny; see its stated limits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, statementsOf } from '../../../infra/kiro-access/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STACK = path.join(ROOT, 'infra/staging-db/stack.yaml');
const tpl = JSON.parse(fs.readFileSync(STACK, 'utf8'));
const P = '472838866351';
const R = 'eu-central-1';
const params = { 'AWS::StackName': 'vitana-staging-db' };
const role = statementsOf(tpl, 'StagingDbRole', params);
const boundary = statementsOf(tpl, 'StagingBoundary', params);
const both = (action, arn, opts = {}) => (evaluate(role, action, arn, opts) === 'allow' && evaluate(boundary, action, arn, opts) === 'allow' ? 'allow' : 'deny');
const explicitDenyBoth = (action, arn, opts = {}) => evaluate(role, action, arn, { ...opts, explicitOnly: true }) === 'deny' && evaluate(boundary, action, arn, { ...opts, explicitOnly: true }) === 'deny';
const rds = (t) => `arn:aws:rds:${R}:${P}:${t}`;
const sec = (n) => `arn:aws:secretsmanager:${R}:${P}:secret:${n}`;
const RES = tpl.Resources;
const STAGING_TAG = { 'aws:RequestTag/vitana-env': 'staging' };

test('the stack is a product-account CloudFormation template with the resources of design.md §4', () => {
  assert.equal(tpl.AWSTemplateFormatVersion, '2010-09-09');
  assert.equal(tpl.Metadata.Account, 'product');
  assert.equal(RES.StagingDbKeyAlias.Properties.AliasName, 'alias/vitana-staging-db');
  assert.equal(RES.DbSubnetGroup.Properties.DBSubnetGroupName, 'vitana-aurora-staging');
  assert.equal(RES.DbSecurityGroup.Properties.GroupName, 'vitana-aurora-staging-sg');
  assert.equal(RES.StagingDbRole.Properties.RoleName, 'vitana-gha-staging-db');
  assert.equal(RES.StagingBoundary.Properties.ManagedPolicyName, 'vitana-staging-boundary');
  assert.deepEqual([RES.DatabaseUrlSecret, RES.PostgrestAuthenticatorUriSecret].map((s) => s.Properties.Name),
    ['vitana/aurora/staging-db/database-url', 'vitana/aurora/staging-db/postgrest-authenticator-uri']);
  for (const k of ['StagingDbRoleArn', 'KmsKeyArn', 'DbSecurityGroupId', 'DbClientSecurityGroupId', 'MinAcu', 'MaxAcu']) assert.ok(tpl.Outputs[k], k);
  for (const [n, r] of Object.entries(RES)) {
    const t = r.Properties?.Tags;
    if (t) assert.ok(t.some((x) => x.Key === 'vitana-env' && x.Value === 'staging'), `${n} is tagged vitana-env=staging`);
  }
});

test('capacity defaults are option A (min 0 ACU, auto-pause 300 s, max 2 ACU) and max 2 ACU is a hard cap', () => {
  const p = tpl.Parameters;
  assert.equal(String(p.MinAcu.Default), '0');
  assert.deepEqual(p.MinAcu.AllowedValues.map(String), ['0', '0.5']);
  assert.equal(String(p.MaxAcu.Default), '2');
  assert.equal(p.MaxAcu.MaxValue, 2);
  assert.equal(String(p.SecondsUntilAutoPause.Default), '300');
});

test('role and boundary carry the same statements; the role has the boundary attached', () => {
  assert.deepEqual(RES.StagingDbRole.Properties.Policies[0].PolicyDocument.Statement, RES.StagingBoundary.Properties.PolicyDocument.Statement);
  assert.deepEqual(RES.StagingDbRole.Properties.PermissionsBoundary, { Ref: 'StagingBoundary' });
  assert.equal(RES.StagingDbRole.Properties.ManagedPolicyArns, undefined, 'no managed policy beyond the inline one');
});

test('trust: GitHub OIDC only, this repository, main only, audience sts', () => {
  const st = RES.StagingDbRole.Properties.AssumeRolePolicyDocument.Statement;
  assert.equal(st.length, 1);
  assert.equal(st[0].Action, 'sts:AssumeRoleWithWebIdentity');
  assert.ok(st[0].Principal.Federated, 'federated principal only');
  assert.deepEqual(Object.keys(st[0].Principal), ['Federated']);
  assert.deepEqual(st[0].Condition, { StringEquals: {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': 'repo:exafyltd/vitana-platform:ref:refs/heads/main',
  } });
});

test('staging: create, modify, Data API and staging secrets are allowed; create needs the staging tag', () => {
  assert.equal(both('rds:CreateDBCluster', rds('cluster:vitana-aurora-staging'), { context: STAGING_TAG }), 'allow');
  assert.equal(both('rds:CreateDBInstance', rds('db:vitana-aurora-staging-writer'), { context: STAGING_TAG }), 'allow');
  assert.ok(explicitDenyBoth('rds:CreateDBCluster', rds('cluster:vitana-aurora-staging'), { context: { 'aws:RequestTag/vitana-env': 'production' } }));
  assert.equal(both('rds:ModifyDBCluster', rds('cluster:vitana-aurora-staging')), 'allow');
  assert.equal(both('rds:EnableHttpEndpoint', rds('cluster:vitana-aurora-staging')), 'allow');
  assert.equal(both('rds-data:ExecuteStatement', rds('cluster:vitana-aurora-staging')), 'allow');
  assert.equal(both('secretsmanager:GetSecretValue', sec('vitana/aurora/staging-db/database-url-AbC123')), 'allow');
  assert.equal(both('secretsmanager:GetSecretValue', sec('rds!cluster-1234-AbC'), { context: { 'aws:ResourceTag/aws:rds:primaryDBClusterArn': rds('cluster:vitana-aurora-staging') } }), 'allow');
  assert.equal(both('secretsmanager:GetSecretValue', sec('rds!cluster-9999-AbC'), { context: { 'aws:ResourceTag/aws:rds:primaryDBClusterArn': rds('cluster:some-other') } }), 'deny');
  assert.equal(both('cloudformation:DescribeStacks', `arn:aws:cloudformation:${R}:${P}:stack/vitana-staging-db/abc`), 'allow');
  assert.equal(both('cloudformation:DescribeStacks', `arn:aws:cloudformation:${R}:${P}:stack/other-stack/abc`), 'deny');
});

test('any cluster other than vitana-aurora-staging cannot be created or changed', () => {
  for (const c of ['vitana-aurora-staging2', 'vitana-aurora-other', 'vitana-aurora']) {
    assert.equal(both('rds:CreateDBCluster', rds(`cluster:${c}`), { context: STAGING_TAG }), 'deny', c);
    assert.equal(both('rds:ModifyDBCluster', rds(`cluster:${c}`)), 'deny', c);
    assert.equal(both('rds-data:ExecuteStatement', rds(`cluster:${c}`)), 'deny', c);
  }
});

test('every production resource is denied explicitly, in the role and in the boundary', () => {
  const prod = [
    ['rds:ModifyDBCluster', rds('cluster:vitana-aurora-prod')],
    ['rds:CreateDBClusterSnapshot', rds('cluster:vitana-aurora-prod')],
    ['rds:RestoreDBClusterToPointInTime', rds('cluster:vitana-aurora-prod')],
    ['rds:ModifyDBInstance', rds('db:vitana-aurora-prod-writer')],
    ['rds:CopyDBClusterSnapshot', rds('cluster-snapshot:rds:vitana-aurora-prod-2026-11-12')],
    ['rds-data:ExecuteStatement', rds('cluster:vitana-aurora-prod')],
    ['secretsmanager:GetSecretValue', sec('vitana/aurora/prod/postgrest-authenticator-uri-AbC')],
    ['secretsmanager:DescribeSecret', sec('vitana/aurora/prod/database-url-AbC')],
    ['secretsmanager:GetSecretValue', sec('vitana/supabase/prod/service-role-key-AbC')],
    ['secretsmanager:GetSecretValue', sec('vitana/gateway-awsdr/env-AbC')],
  ];
  for (const [a, arn] of prod) assert.ok(explicitDenyBoth(a, arn), `${a} ${arn} must be an explicit Deny`);
  // The RDS-managed master secret of vitana-aurora-prod (rds!cluster-…, docs/AURORA-MIGRATION-STATUS-2026-09-10.md:336-338,
  // 860-872; restored cluster rds!cluster-4dab93b8-…, docs/AURORA-CUTOVER-RUNBOOK-2026-09-20.md:7): denied by its
  // production cluster tag and, independently, by its name.
  const PROD_TAG = { 'aws:ResourceTag/aws:rds:primaryDBClusterArn': rds('cluster:vitana-aurora-prod') };
  const managedActs = ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:RotateSecret',
    'secretsmanager:TagResource', 'secretsmanager:CreateSecret', 'secretsmanager:UpdateSecret', 'secretsmanager:DeleteSecret'];
  for (const a of managedActs) {
    assert.ok(explicitDenyBoth(a, sec('rds!cluster-0000aaaa-unknown-name-XyZ12'), { context: PROD_TAG }), `${a} on a secret tagged vitana-aurora-prod`);
    for (const n of ['rds!cluster-4dab93b8-0000-0000-0000-000000000000-AbCdEf', 'rds!cluster-eba8a4f2-3caa-4f11-88f0-c3102c3c176a-QR8ox2']) {
      assert.ok(explicitDenyBoth(a, sec(n)), `${a} ${n} by name, without any tag`);
    }
  }
  assert.ok(explicitDenyBoth('secretsmanager:CreateSecret', sec('rds!cluster-new-AbC'), { context: { 'aws:RequestTag/aws:rds:primaryDBClusterArn': rds('cluster:vitana-aurora-prod') } }),
    'a new secret labelled for vitana-aurora-prod');
});

test('RDS-managed master secrets: only the staging cluster\'s, only through RDS, no rotation grant', () => {
  const st = role.filter((s) => s.Sid === 'ManagedMasterSecretCreate');
  assert.equal(st.length, 1);
  assert.deepEqual(st[0].Action, ['secretsmanager:CreateSecret', 'secretsmanager:TagResource'], 'no RotateSecret');
  assert.deepEqual(st[0].Condition, { Bool: { 'aws:ViaAWSService': 'true' } }, 'only RDS, on the caller\'s behalf, creates or tags it');
  const allowed = role.filter((s) => s.Effect === 'Allow').flatMap((s) => [].concat(s.Action));
  assert.ok(!allowed.some((a) => /^secretsmanager:(RotateSecret|CancelRotateSecret|UpdateSecret|DeleteSecret|PutResourcePolicy|\*)$/i.test(a)), allowed.join(','));
  // The staging cluster's own secret stays readable; any other cluster's tagged rds!cluster secret is denied.
  const other = role.find((s) => s.Sid === 'DenyOtherClustersManagedSecrets');
  assert.deepEqual(other.Condition, {
    Null: { 'aws:ResourceTag/aws:rds:primaryDBClusterArn': 'false' },
    StringNotEquals: { 'aws:ResourceTag/aws:rds:primaryDBClusterArn': rds('cluster:vitana-aurora-staging') },
  });
  assert.equal(other.Action, 'secretsmanager:*');
  assert.equal(both('secretsmanager:GetSecretValue', sec('rds!cluster-1234-AbC'), { context: { 'aws:ResourceTag/aws:rds:primaryDBClusterArn': rds('cluster:vitana-aurora-staging') } }), 'allow');
  for (const sid of ['DenyProdManagedSecretByName', 'DenyProdManagedSecretByTag', 'DenyProdManagedSecretRequestTag', 'DenyOtherClustersManagedSecrets']) {
    assert.ok(boundary.some((s) => s.Sid === sid && s.Effect === 'Deny'), `${sid} in the boundary`);
  }
});

test('deletes are denied everywhere, staging included (deletion stays an owner action)', () => {
  for (const a of ['rds:DeleteDBCluster', 'rds:DeleteDBInstance', 'rds:DeleteDBClusterSnapshot']) {
    assert.ok(explicitDenyBoth(a, rds('cluster:vitana-aurora-staging')), a);
  }
});

test('no IAM change is possible, except the RDS service-linked role', () => {
  for (const a of ['iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:DeleteRolePermissionsBoundary', 'iam:UpdateAssumeRolePolicy', 'iam:PassRole', 'iam:CreateRole']) {
    assert.ok(explicitDenyBoth(a, `arn:aws:iam::${P}:role/vitana-gha-staging-db`), a);
  }
  assert.equal(both('iam:CreateServiceLinkedRole', `arn:aws:iam::${P}:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS`, { context: { 'iam:AWSServiceName': 'rds.amazonaws.com' } }), 'allow');
  assert.equal(both('iam:CreateServiceLinkedRole', `arn:aws:iam::${P}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`, { context: { 'iam:AWSServiceName': 'ecs.amazonaws.com' } }), 'deny');
});

test('no write to ECS, EC2 or any other service: the role only creates and loads the staging cluster', () => {
  for (const [a, arn] of [
    ['ecs:UpdateService', `arn:aws:ecs:${R}:${P}:service/Vitana-ECS-Cluster/vitana-gateway`],
    ['ec2:AuthorizeSecurityGroupIngress', `arn:aws:ec2:${R}:${P}:security-group/sg-0fbcf7b59b1f0d685`],
    ['s3:GetObject', 'arn:aws:s3:::any/any'],
    ['secretsmanager:PutSecretValue', sec('vitana/gateway/staging/env-AbC')],
    ['kms:Decrypt', `arn:aws:kms:${R}:${P}:key/any`],
  ]) assert.equal(both(a, arn), 'deny', `${a} ${arn}`);
  const allowActs = role.filter((s) => s.Effect === 'Allow').flatMap((s) => [].concat(s.Action));
  assert.ok(allowActs.every((a) => /^(rds|rds-data|secretsmanager|kms|ec2:Describe|iam:CreateServiceLinkedRole|cloudformation:DescribeStacks)/.test(a)), allowActs.join(','));
});

test('KMS: own key, rotated, retained; role use only through RDS and Secrets Manager', () => {
  const k = RES.StagingDbKey;
  assert.equal(k.Type, 'AWS::KMS::Key');
  assert.equal(k.Properties.EnableKeyRotation, true);
  assert.equal(k.DeletionPolicy, 'Retain');
  const st = RES.StagingDbRole.Properties.Policies[0].PolicyDocument.Statement.find((s) => s.Sid === 'Kms');
  assert.deepEqual(st.Resource, { 'Fn::GetAtt': ['StagingDbKey', 'Arn'] });
  assert.deepEqual(st.Condition.StringEquals['kms:ViaService'].map((x) => x['Fn::Sub']), ['rds.${AWS::Region}.amazonaws.com', 'secretsmanager.${AWS::Region}.amazonaws.com']);
  for (const s of ['DatabaseUrlSecret', 'PostgrestAuthenticatorUriSecret']) assert.deepEqual(RES[s].Properties.KmsKeyId, { Ref: 'StagingDbKey' });
});

test('network isolation: the database SG admits 5432 only from the staging-only client SG', () => {
  const ing = RES.DbSecurityGroup.Properties.SecurityGroupIngress;
  assert.equal(ing.length, 1);
  assert.deepEqual(ing[0], { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: { Ref: 'DbClientSecurityGroup' }, Description: 'staging tasks only' });
  assert.equal(RES.DbClientSecurityGroup.Properties.SecurityGroupIngress, undefined);
  assert.ok(!JSON.stringify(RES.DbSecurityGroup).includes('CidrIp'), 'no CIDR ingress');
  assert.ok(!JSON.stringify(RES.DbSecurityGroup).includes('sg-'), 'no shared app-tier SG');
});

test('budget alarm: 60 USD a month on tag vitana-env=staging, actual and forecast, to the owner e-mail', () => {
  const b = RES.StagingBudget.Properties;
  assert.equal(String(tpl.Parameters.BudgetLimitUsd.Default), '60');
  assert.equal(b.Budget.TimeUnit, 'MONTHLY');
  assert.equal(b.Budget.BudgetType, 'COST');
  assert.deepEqual(b.Budget.CostFilters, { TagKeyValue: ['user:vitana-env$staging'] });
  assert.deepEqual(b.NotificationsWithSubscribers.map((n) => n.Notification.NotificationType), ['ACTUAL', 'FORECASTED']);
  assert.ok(b.NotificationsWithSubscribers.every((n) => n.Subscribers[0].Address.Ref === 'BudgetAlertEmail'));
  assert.equal(tpl.Parameters.BudgetAlertEmail.Default, undefined, 'the owner names the address at apply');
});

test('candidate services are optional, at desired count 0, and can only run the -iso task-definition families', () => {
  for (const n of ['CandidateGatewayService', 'CandidatePostgrestService', 'CandidateGatewayTargetGroup', 'CandidateGatewayListenerRule']) {
    assert.equal(RES[n].Condition, 'CreateCandidates', n);
  }
  assert.equal(RES.CandidateGatewayService.Properties.DesiredCount, 0);
  assert.equal(RES.CandidatePostgrestService.Properties.DesiredCount, 0);
  assert.equal(RES.CandidateGatewayService.Properties.ServiceName, 'vitana-gateway-iso');
  assert.equal(RES.CandidatePostgrestService.Properties.ServiceName, 'vitana-postgrest-aurora-staging-iso');
  const gw = new RegExp(tpl.Parameters.CandidateGatewayTaskDefinitionArn.AllowedPattern);
  assert.ok(gw.test('') && gw.test(`arn:aws:ecs:${R}:${P}:task-definition/vitana-gateway-iso:3`));
  assert.ok(!gw.test(`arn:aws:ecs:${R}:${P}:task-definition/vitana-gateway:3`), 'the shared staging family is refused');
  assert.ok(!gw.test(`arn:aws:ecs:${R}:${P}:task-definition/vitana-gateway-awsdr:3`), 'the production family is refused');
  assert.match(tpl.Parameters.CandidateHostName.Default, /^preview-iso-/);
});

test('no credential or secret value in the template', () => {
  const text = fs.readFileSync(STACK, 'utf8');
  assert.ok(!/AKIA[0-9A-Z]{16}/.test(text));
  assert.ok(!/postgres(ql)?:\/\/[^"]*:[^"]*@/.test(text), 'no connection string with a password');
  for (const s of ['DatabaseUrlSecret', 'PostgrestAuthenticatorUriSecret']) assert.equal(RES[s].Properties.SecretString, 'unset');
  assert.ok(!Object.values(RES).some((r) => r.Type === 'AWS::RDS::DBCluster'), 'the cluster is created by the cost-gated provision run, not the stack');
});
