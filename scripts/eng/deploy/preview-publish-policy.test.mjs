// Static checks on the PROPOSED preview publishing infrastructure (infra/aws/preview-publish). Nothing is applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', '..', '..', 'infra', 'aws', 'preview-publish');
const load = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const PROVIDER = 'arn:aws:iam::472838866351:oidc-provider/gitlab.vitanaland.com';
const REPO_ARN = 'arn:aws:ecr:eu-central-1:472838866351:repository/vitana/gateway-preview';
const PUBLISH_ACTIONS = ['ecr:BatchCheckLayerAvailability', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage', 'ecr:DescribeImages', 'ecr:BatchGetImage'];

test('repository: dedicated name, IMMUTABLE, no exclusions, scan on push, AWS-managed KMS', () => {
  const r = load('ecr-repository.json');
  assert.equal(r.repositoryName, 'vitana/gateway-preview');
  assert.equal(r.imageTagMutability, 'IMMUTABLE');
  assert.equal(r.imageTagMutabilityExclusionFilters, undefined, 'no exclusion filters: every tag is immutable');
  assert.equal(r.imageScanningConfiguration.scanOnPush, true);
  assert.equal(r.encryptionConfiguration.encryptionType, 'KMS');
  assert.equal(r.encryptionConfiguration.kmsKey, undefined, 'no customer key named without governance approval');
  assert.equal(r.repositoryPolicy, undefined, 'no repository policy: access is by identity policy only');
});

test('lifecycle: keeps the latest 20 shadow-* images and expires untagged images after 7 days', () => {
  const l = load('lifecycle-policy.json');
  const tagged = l.rules.find((x) => x.selection.tagStatus === 'tagged');
  assert.deepEqual(tagged.selection.tagPrefixList, ['shadow-']);
  assert.equal(tagged.selection.countType, 'imageCountMoreThan');
  assert.equal(tagged.selection.countNumber, 20);
  const untagged = l.rules.find((x) => x.selection.tagStatus === 'untagged');
  assert.equal(untagged.selection.countType, 'sinceImagePushed');
  assert.equal(untagged.selection.countUnit, 'days');
  assert.equal(untagged.selection.countNumber, 7);
  assert.deepEqual(l.rules.map((x) => x.rulePriority), [1, 2], 'rule priorities are unique and ordered');
  for (const rule of l.rules) assert.equal(rule.action.type, 'expire', 'lifecycle only expires');
});

test('trust: only the GitLab OIDC provider can assume the role, with the web-token action only', () => {
  const t = load('trust-policy.json');
  assert.equal(t.Statement.length, 1);
  const s = t.Statement[0];
  assert.equal(s.Effect, 'Allow');
  assert.deepEqual(s.Principal, { Federated: PROVIDER });
  assert.equal(s.Action, 'sts:AssumeRoleWithWebIdentity');
});

test('trust: exact-match conditions only, pinned to the project, the preview branch and the audience', () => {
  const c = load('trust-policy.json').Statement[0].Condition;
  assert.deepEqual(Object.keys(c), ['StringEquals'], 'no StringLike and no wildcard matching');
  const e = c.StringEquals;
  assert.equal(e['gitlab.vitanaland.com:aud'], 'https://sts.amazonaws.com');
  assert.equal(e['gitlab.vitanaland.com:project_path'], 'vitana/vitana-platform');
  assert.equal(e['gitlab.vitanaland.com:ref_path'], 'refs/heads/claude/gateway-preview-safe-mode');
  for (const v of Object.values(e)) assert.doesNotMatch(String(v), /\*|\?/, 'no wildcard in any value');
  assert.equal(e['gitlab.vitanaland.com:sub'], undefined, 'sub is not used: its format is not verified');
});

test('trust: the CI configuration identity is still a placeholder, so this file cannot be applied as-is', () => {
  const e = load('trust-policy.json').Statement[0].Condition.StringEquals;
  assert.equal(e['gitlab.vitanaland.com:ci_config_ref_uri'], 'PENDING_VERIFIED_CLAIM');
});

test('trust: the proposal does not reuse or widen the staging trust', () => {
  const t = load('trust-policy.json');
  assert.doesNotMatch(JSON.stringify(t), /refs\/heads\/main|vitana-v1|gl-platform-staging|gl-v1-staging/);
});

test('role: ECR only; GetAuthorizationToken on *, everything else on the one repository', () => {
  const p = load('role-policy.json');
  const token = p.Statement.find((x) => x.Action.includes('ecr:GetAuthorizationToken'));
  assert.deepEqual(token.Resource, '*');
  assert.deepEqual(token.Action, ['ecr:GetAuthorizationToken']);
  const publish = p.Statement.find((x) => x.Sid === 'PreviewRepositoryPublishOnly');
  assert.equal(publish.Resource, REPO_ARN);
  assert.deepEqual([...publish.Action].sort(), [...PUBLISH_ACTIONS].sort());
});

test('role: no delete, no ECS, IAM, secrets, S3, KMS or wildcard actions', () => {
  const p = load('role-policy.json');
  const all = p.Statement.flatMap((x) => x.Action);
  for (const a of all) {
    assert.match(a, /^ecr:/, `${a} must be an ECR action`);
    assert.doesNotMatch(a, /Delete|\*/, `${a} must not delete or wildcard`);
  }
  assert.equal(p.Statement.some((x) => x.Action === '*' || x.Resource === '*' && !x.Action.includes('ecr:GetAuthorizationToken')), false);
});

test('role: no statement grants the staging repository or any other service repository', () => {
  const p = JSON.stringify(load('role-policy.json'));
  assert.doesNotMatch(p, /repository\/vitana\/gateway"/);
  assert.doesNotMatch(p, /repository\/vitana\/(?!gateway-preview)/);
});

test('provider: no change is proposed, and the audience is the one the provider already accepts', () => {
  const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
  assert.match(readme, /Provider: no change/);
  assert.equal(load('trust-policy.json').Statement[0].Condition.StringEquals['gitlab.vitanaland.com:aud'], 'https://sts.amazonaws.com');
});
