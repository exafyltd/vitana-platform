// VTID-05546 — GitLab sign-in to AWS (plan agentic-delivery §7): the OIDC provider, the six roles, and the owner's
// setup script (dry run by default, prints every call, stops outside 472838866351 / eu-central-1).
// The setup-script checks run it against a stub `aws` on PATH: nothing here reaches AWS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IAM = join(ROOT, 'scripts', 'aws', 'iam');
const SETUP = join(ROOT, 'scripts', 'aws', 'setup-gitlab-oidc.sh');
const HOST = 'gitlab.vitanaland.com';
const PROVIDER_ARN = `arn:aws:iam::472838866351:oidc-provider/${HOST}`;
const V1 = 'project_path:vitana/vitana-v1:ref_type:branch:ref:';
const PF = 'project_path:vitana/vitana-platform:ref_type:branch:ref:';
const SM = 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:';

// Plan §7 roles table: role → audience, subjects, resources it may name.
const ROLES = {
  'gl-v1-staging': {
    file: 'v1-staging', aud: 'aws:v1:staging', sub: [`${V1}main`],
    resources: ['*', 'arn:aws:ecr:eu-central-1:472838866351:repository/vitana/community-app',
      'arn:aws:ecs:eu-central-1:472838866351:service/Vitana-ECS-Cluster/vitana-community-app-staging', '${STAGING_TASK_ROLE_ARNS}'],
  },
  'gl-platform-staging': {
    file: 'platform-staging', aud: 'aws:platform:staging', sub: [`${PF}main`],
    resources: ['*', ...['gateway', 'erp-bridge', 'kiro-runner', 'postgrest-aurora-proxy'].map((r) => `arn:aws:ecr:eu-central-1:472838866351:repository/vitana/${r}`),
      ...['vitana-gateway', 'vitana-erp-bridge', 'vitana-kiro-runner', 'vitana-postgrest-aurora-proxy'].map((s) => `arn:aws:ecs:eu-central-1:472838866351:service/Vitana-ECS-Cluster/${s}`),
      '${STAGING_TASK_ROLE_ARNS}'],
  },
  'gl-v1-preview': {
    file: 'v1-preview', aud: 'aws:v1:preview', sub: [`${V1}*`],
    resources: ['arn:aws:s3:::vitana-pr-previews', 'arn:aws:s3:::vitana-pr-previews/mr-*', 'arn:aws:s3:::vitana-pr-previews/gl-main/*',
      'arn:aws:cloudfront::472838866351:distribution/${PREVIEW_CF_DISTRIBUTION_ID}'],
  },
  'gl-verify': { file: 'verify', aud: 'aws:verify', sub: [`${V1}main`, `${PF}main`], resources: [`${SM}vitana/ci/test-user-??????`] },
  'gl-record': {
    file: 'record', aud: 'aws:record', sub: [`${V1}main`, `${PF}main`],
    resources: [`${SM}vitana/ci/oasis-recorder-??????`, `${SM}vitana/ci/gateway-service-token-??????`],
  },
  'gl-assist': { file: 'assist', aud: 'aws:assist', sub: [`${V1}assist/*`, `${V1}main`], resources: [`${SM}vitana/ci/llm-keys-??????`] },
};
// Actions IAM cannot scope to a resource; only these may use Resource "*".
const NO_RESOURCE_LEVEL = new Set(['ecr:GetAuthorizationToken', 'ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition']);

const load = (name) => JSON.parse(readFileSync(join(IAM, `gitlab-oidc-${name}.json`), 'utf8'));
const list = (v) => (Array.isArray(v) ? v : [v]);

test('the OIDC provider is gitlab.vitanaland.com with exactly the six audiences', () => {
  const p = load('provider');
  assert.equal(p.Url, `https://${HOST}`);
  assert.deepEqual([...p.ClientIDList].sort(), Object.values(ROLES).map((r) => r.aud).sort());
});

test('each trust policy: StringEquals on aud, sub pinned to the plan §7 project paths and refs, no * principal', () => {
  for (const [role, spec] of Object.entries(ROLES)) {
    const t = load(`${spec.file}-trust`);
    assert.equal(t.Statement.length, 1, role);
    const s = t.Statement[0];
    assert.equal(s.Effect, 'Allow', role);
    assert.deepEqual(s.Principal, { Federated: PROVIDER_ARN }, `${role}: only the GitLab provider, never *`);
    assert.equal(s.Action, 'sts:AssumeRoleWithWebIdentity', role);
    const ops = Object.keys(s.Condition).sort();
    const wild = spec.sub.some((x) => x.includes('*'));
    assert.deepEqual(ops, wild ? ['StringEquals', 'StringLike'] : ['StringEquals'], `${role}: condition operators`);
    assert.deepEqual(Object.keys(s.Condition.StringEquals).sort(), (wild ? [`${HOST}:aud`] : [`${HOST}:aud`, `${HOST}:sub`]).sort(), role);
    assert.equal(s.Condition.StringEquals[`${HOST}:aud`], spec.aud, `${role}: aud`);
    const sub = wild ? s.Condition.StringLike[`${HOST}:sub`] : s.Condition.StringEquals[`${HOST}:sub`];
    if (wild) assert.deepEqual(Object.keys(s.Condition.StringLike), [`${HOST}:sub`], role);
    assert.deepEqual(list(sub).sort(), [...spec.sub].sort(), `${role}: sub`);
    for (const x of list(sub)) assert.ok(x.startsWith('project_path:vitana/vitana-v1:') || x.startsWith('project_path:vitana/vitana-platform:'), x);
  }
});

test('each permission policy names only the resources of plan §7', () => {
  for (const [role, spec] of Object.entries(ROLES)) {
    const p = load(`${spec.file}-policy`);
    const seen = new Set();
    for (const s of p.Statement) {
      assert.equal(s.Effect, 'Allow', role);
      assert.equal('NotAction' in s || 'NotResource' in s, false, role);
      for (const a of list(s.Action)) assert.ok(/^[a-z0-9-]+:[A-Za-z]+$/.test(a), `${role}: no wildcard action (${a})`);
      for (const r of list(s.Resource)) {
        seen.add(r);
        if (r === '*') for (const a of list(s.Action)) assert.ok(NO_RESOURCE_LEVEL.has(a), `${role}: ${a} on * (only actions without resource-level permissions)`);
      }
    }
    assert.deepEqual([...seen].sort(), [...spec.resources].sort(), `${role}: resources`);
    const pass = p.Statement.find((s) => list(s.Action).includes('iam:PassRole'));
    if (pass) assert.deepEqual(pass.Condition, { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } }, role);
  }
});

test('there is no production role', () => {
  const files = readdirSync(IAM).filter((f) => f.startsWith('gitlab-oidc-')).sort();
  const expected = ['gitlab-oidc-provider.json', ...Object.values(ROLES).flatMap((r) => [`gitlab-oidc-${r.file}-policy.json`, `gitlab-oidc-${r.file}-trust.json`])].sort();
  assert.deepEqual(files, expected);
  for (const f of files) {
    const text = readFileSync(join(IAM, f), 'utf8');
    assert.equal(/prod/i.test(text), false, `${f} names nothing production`);
  }
  const setup = readFileSync(SETUP, 'utf8');
  assert.equal(/gl-prod|prod-publish/.test(setup), false, 'the setup script creates no production role');
});

// A stub `aws` that answers reads and logs every call. Writes would be logged too, so a dry run must log none.
function stubAws({ account = '472838866351' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stub-aws-'));
  const log = join(dir, 'calls.log');
  const script = `#!/usr/bin/env bash
echo "aws $*" >> "${log}"
case "$1 $2" in
  "sts get-caller-identity") echo "${account}" ;;
  "configure get") echo "" ;;
  "iam get-open-id-connect-provider") echo "NoSuchEntity" >&2; exit 254 ;;
  "iam get-role") echo "NoSuchEntity" >&2; exit 254 ;;
  "ecs describe-services")
    if [[ "$*" == *loadBalancers* ]]; then echo '["arn:aws:elasticloadbalancing:eu-central-1:472838866351:targetgroup/vitana-gateway-staging/1","arn:aws:elasticloadbalancing:eu-central-1:472838866351:targetgroup/vitana-community-staging/2"]';
    else for a in "$@"; do last="$a"; done; svc=""; prev=""; for a in "$@"; do [ "$prev" = "--services" ] && svc="$a"; prev="$a"; done; echo "arn:aws:ecs:eu-central-1:472838866351:task-definition/$svc:7"; fi ;;
  "ecs describe-task-definition") echo '["arn:aws:iam::472838866351:role/vitana-staging-task","arn:aws:iam::472838866351:role/vitana-ecs-exec"]' ;;
  "secretsmanager describe-secret")
    if [[ "$*" == *vitana/ci/test-user* ]]; then echo '{"Name":"vitana/ci/test-user","VersionIdsToStages":{"v1":["AWSCURRENT"]}}'; else echo "ResourceNotFoundException" >&2; exit 254; fi ;;
  "elbv2 describe-target-group-attributes") echo "300" ;;
  *) echo "{}" ;;
esac
`;
  writeFileSync(join(dir, 'aws'), script);
  chmodSync(join(dir, 'aws'), 0o755);
  return { dir, log };
}

function runSetup(args, { account, region = 'eu-central-1' } = {}) {
  const stub = stubAws({ account });
  const env = { PATH: `${stub.dir}:${process.env.PATH}`, HOME: stub.dir };
  if (region) env.AWS_REGION = region;
  const r = spawnSync('bash', [SETUP, ...args], { encoding: 'utf8', env });
  const calls = existsSync(stub.log) ? readFileSync(stub.log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { ...r, calls };
}

const WRITE_VERBS = /^aws \S+ (create-|put-|update-|add-|modify-|attach-|delete-|tag-)/;

test('the setup script is a dry run by default and prints every call it would make', () => {
  const r = runSetup(['--preview-distribution-id', 'E1PREVIEW2DIST3']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.filter((c) => WRITE_VERBS.test(c)), [], 'the dry run makes no write call');
  const out = r.stdout;
  assert.match(out, /\[DRY-RUN\] aws iam create-open-id-connect-provider --cli-input-json file:\/\/\S+gitlab-oidc-provider\.json/);
  for (const role of Object.keys(ROLES)) {
    assert.match(out, new RegExp(`\\[DRY-RUN\\] aws iam create-role --role-name ${role} --assume-role-policy-document file://\\S+gitlab-oidc-[a-z0-9-]+-trust\\.json`), role);
    assert.match(out, new RegExp(`\\[DRY-RUN\\] aws iam put-role-policy --role-name ${role} --policy-name ${role} --policy-document file://`), role);
  }
  assert.match(out, /policy gl-v1-staging: .*"Resource":\["arn:aws:iam::472838866351:role\/vitana-ecs-exec","arn:aws:iam::472838866351:role\/vitana-staging-task"\]/);
  assert.match(out, /policy gl-v1-preview: .*distribution\/E1PREVIEW2DIST3/);
  for (const c of r.calls) assert.match(out, new RegExp(`\\[READ\\] ${c.split(' ').slice(0, 3).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `printed: ${c}`);
  assert.match(out, /vitana\/ci\/test-user: exists, has a value/);
  for (const s of ['oasis-recorder', 'gateway-service-token', 'llm-keys']) {
    assert.match(out, new RegExp(`vitana/ci/${s}: missing, NEEDS A VALUE`));
    assert.match(out, new RegExp(`\\[DRY-RUN\\] aws secretsmanager create-secret --name vitana/ci/${s} `));
  }
  assert.match(out, /\[DRY-RUN\] aws elbv2 modify-target-group-attributes --target-group-arn \S+vitana-gateway-staging\/1 --attributes Key=deregistration_delay\.timeout_seconds\\?,Value=30/);
});

test('the setup script skips the preview role without a distribution id', () => {
  const r = runSetup([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /role gl-v1-preview: SKIPPED/);
  assert.equal(/create-role --role-name gl-v1-preview/.test(r.stdout), false);
});

test('the setup script stops outside account 472838866351 or region eu-central-1', () => {
  const wrongAccount = runSetup([], { account: '111111111111' });
  assert.equal(wrongAccount.status, 4);
  assert.match(wrongAccount.stderr, /expected 472838866351/);
  assert.deepEqual(wrongAccount.calls.filter((c) => !/^aws (sts get-caller-identity|configure get)/.test(c)), []);
  const wrongRegion = runSetup(['--apply'], { region: 'us-east-1' });
  assert.equal(wrongRegion.status, 4);
  assert.match(wrongRegion.stderr, /expected eu-central-1/);
  assert.deepEqual(wrongRegion.calls, [], 'no AWS call at all');
});
