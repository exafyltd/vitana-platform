// Tests for preview-build.mjs and the preview job in infra/gitlab-engineering/ci. Dependency-free node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkSource, previewTag, noClobberDecision, publishTarget, PREVIEW_REPOSITORY, FORBIDDEN_TAGS, verifyManifest, checkAccount, verifyPublishedDigest, PREVIEW_ACCOUNT } from './preview-build.mjs';
import { DeployError } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const JOB_FILE = join(ROOT, 'infra', 'gitlab-engineering', 'ci', 'preview-build.gitlab-ci.yml');
const MODULE_FILE = join(here, 'preview-build.mjs');

const HEAD = '3b620c761756d1933ce200ae75029e8e97ccf0e4';   // PR #5110 current head
const MAIN = '67897e6ce83853ff24f76432fb522c13c5f2fbf5';   // main, must never be substituted
const NOT_FOUND = 'An error occurred (ImageNotFoundException) when calling the DescribeImages operation: The image requested does not exist in the repository';

function refused(fn, pattern) {
  assert.throws(fn, (e) => e instanceof DeployError && e.exitCode === 2 && pattern.test(e.message));
}

// ---- source SHA ------------------------------------------------------------------------------------------------

test('source: the checked-out HEAD must be exactly the requested PR head', () => {
  assert.deepEqual(checkSource({ expected: HEAD, head: HEAD }), { source: HEAD });
});

test('source: main or any other commit is never substituted for the requested head', () => {
  refused(() => checkSource({ expected: HEAD, head: MAIN }), /not the requested source.*refusing to build a substitute/);
});

test('source: an abbreviated SHA is refused, not expanded', () => {
  refused(() => checkSource({ expected: HEAD.slice(0, 12), head: HEAD }), /full lowercase 40-hex/);
});

test('source: an uppercase SHA is refused (no silent normalisation)', () => {
  refused(() => checkSource({ expected: HEAD.toUpperCase(), head: HEAD }), /full lowercase 40-hex/);
});

test('source: a missing or non-string SHA is refused', () => {
  refused(() => checkSource({ expected: undefined, head: HEAD }), /full lowercase 40-hex/);
  refused(() => checkSource({ expected: HEAD, head: null }), /full lowercase 40-hex/);
});

// ---- tag isolation ---------------------------------------------------------------------------------------------

test('tag: the published tag is shadow-<first 12 chars of the SHA>', () => {
  assert.equal(previewTag(HEAD), `shadow-${HEAD.slice(0, 12)}`);
});

test('tag: staging-latest, latest and production can never be produced', () => {
  for (const forbidden of FORBIDDEN_TAGS) {
    for (const sha of [HEAD, MAIN, 'a'.repeat(40), '0'.repeat(40)]) {
      assert.notEqual(previewTag(sha), forbidden);
    }
  }
});

test('tag: every generated tag stays in the shadow family, which deploys never read', () => {
  for (const sha of [HEAD, MAIN, '1'.repeat(40), 'f'.repeat(40)]) {
    assert.match(previewTag(sha), /^shadow-[0-9a-f]{12}$/);
  }
});

test('tag: the publish target is only vitana/gateway with a shadow tag', () => {
  assert.equal(PREVIEW_REPOSITORY, 'vitana/gateway');
  assert.equal(publishTarget(previewTag(HEAD)), `472838866351.dkr.ecr.eu-central-1.amazonaws.com/vitana/gateway:shadow-${HEAD.slice(0, 12)}`);
  refused(() => publishTarget('staging-latest'), /outside shadow-/);
  refused(() => publishTarget(HEAD.slice(0, 12)), /outside shadow-/);
});

// ---- no-clobber ------------------------------------------------------------------------------------------------

test('no-clobber: an existing tag is refused, never overwritten', () => {
  refused(() => noClobberDecision({ tag: 'shadow-x', describeExit: 0 }), /already exists: refusing to overwrite/);
});

test('no-clobber: a confirmed not-found answer allows the single publish', () => {
  assert.deepEqual(noClobberDecision({ tag: 'shadow-x', describeExit: 254, describeStderr: NOT_FOUND }), { publish: true, tag: 'shadow-x' });
});

test('no-clobber: an unknown describe failure (e.g. access denied) refuses instead of guessing', () => {
  refused(
    () => noClobberDecision({ tag: 'shadow-x', describeExit: 255, describeStderr: 'AccessDeniedException: not authorized' }),
    /cannot verify that shadow-x is free/,
  );
});

test('no-clobber: an empty failure message also refuses', () => {
  refused(() => noClobberDecision({ tag: 'shadow-x', describeExit: 1, describeStderr: '' }), /cannot verify/);
});

// ---- absence of deployment actions -----------------------------------------------------------------------------

const DEPLOY_OR_SHARED_TAG = [
  /update-service/, /register-task-definition/, /describe-task-definition/, /describe-services/,
  /deploy-ecs/, /desired-count/, /services-stable/, /run-task/, /start-task/,
  /staging-latest/, /:latest\b/, /production/i, /vitana-gateway(?!-preview)/,
];

test('no deploy: the preview module names no deploy, ECS or shared-tag operation', () => {
  const src = readFileSync(MODULE_FILE, 'utf8');
  for (const pattern of DEPLOY_OR_SHARED_TAG) {
    // The module may mention FORBIDDEN_TAGS as data, so check only executable code paths.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const withoutForbiddenList = code.replace(/export const FORBIDDEN_TAGS[^\n]*\n/, '');
    assert.doesNotMatch(withoutForbiddenList, pattern, `module must not match ${pattern}`);
  }
});

test('no deploy: the preview job defines no deploy, ECS, task or shared-tag step', () => {
  const job = readFileSync(JOB_FILE, 'utf8');
  const code = job.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  for (const pattern of DEPLOY_OR_SHARED_TAG) {
    assert.doesNotMatch(code, pattern, `preview job must not match ${pattern}`);
  }
});

test('no deploy: the preview job is gated on an explicit web trigger and a full PREVIEW_SOURCE_SHA', () => {
  const job = readFileSync(JOB_FILE, 'utf8');
  assert.match(job, /\$CI_PIPELINE_SOURCE == "web"/);
  assert.match(job, /\$PREVIEW_SOURCE_SHA/);
  assert.doesNotMatch(job, /CI_COMMIT_BRANCH == "main"/);
});

test('isolation: the preview job never publishes from the main-trusted deploy role', () => {
  const job = readFileSync(JOB_FILE, 'utf8');
  assert.doesNotMatch(job, /gl-platform-staging/);
  assert.doesNotMatch(job, /aws:platform:staging/);
  assert.match(job, /PREVIEW_PUBLISH_ROLE_ARN/);
});

// ---- artifact binding (publish side) --------------------------------------------------------------------------

const ARCH = 'c'.repeat(64);
const PIPE = '987654';
const manifest = (over = {}) => ({ source_sha: HEAD, archive_sha256: ARCH, ref: 'claude/gateway-preview-safe-mode', pipeline_id: PIPE, ...over });

test('binding: a manifest that matches source, archive hash and pipeline passes', () => {
  assert.deepEqual(verifyManifest({ manifest: manifest(), expectedSource: HEAD, archiveSha256: ARCH, pipelineId: PIPE }), { source: HEAD, archive_sha256: ARCH });
});

test('binding: a manifest for another source (e.g. main) is refused', () => {
  refused(() => verifyManifest({ manifest: manifest({ source_sha: MAIN }), expectedSource: HEAD, archiveSha256: ARCH, pipelineId: PIPE }), /not the requested source/);
});

test('binding: an archive altered after the build is refused', () => {
  refused(() => verifyManifest({ manifest: manifest(), expectedSource: HEAD, archiveSha256: 'd'.repeat(64), pipelineId: PIPE }), /altered between build and publish/);
});

test('binding: an artifact from another pipeline is refused', () => {
  refused(() => verifyManifest({ manifest: manifest({ pipeline_id: '1' }), expectedSource: HEAD, archiveSha256: ARCH, pipelineId: PIPE }), /foreign artifact/);
});

test('binding: a malformed archive hash or a missing manifest is refused', () => {
  refused(() => verifyManifest({ manifest: manifest(), expectedSource: HEAD, archiveSha256: 'XYZ', pipelineId: PIPE }), /64 lowercase hex/);
  refused(() => verifyManifest({ manifest: null, expectedSource: HEAD, archiveSha256: ARCH, pipelineId: PIPE }), /missing or not an object/);
});

// ---- identity pin and race-safe digest --------------------------------------------------------------------------

test('identity: only the Vitana account can publish', () => {
  assert.equal(checkAccount(PREVIEW_ACCOUNT), PREVIEW_ACCOUNT);
  refused(() => checkAccount('123456789012'), /is not 472838866351/);
});

test('race: the tag must still hold the digest that was pushed', () => {
  const d = `sha256:${'e'.repeat(64)}`;
  assert.deepEqual(verifyPublishedDigest({ pushed: d, now: d }), { digest: d });
  assert.throws(() => verifyPublishedDigest({ pushed: d, now: `sha256:${'f'.repeat(64)}` }), (e) => e instanceof DeployError && e.exitCode === 1 && /overwritten during publish/.test(e.message));
});

test('race: a pushed value that is not a digest is refused', () => {
  refused(() => verifyPublishedDigest({ pushed: 'latest', now: 'latest' }), /not a sha256 digest/);
});

// ---- job-level guarantees (static, against the job file) --------------------------------------------------------

function jobBlock(name) {
  const job = readFileSync(JOB_FILE, 'utf8');
  const start = job.indexOf(`\n${name}:\n`);
  assert.ok(start >= 0, `job ${name} must exist`);
  const rest = job.slice(start + 1);
  const next = rest.slice(name.length + 2).search(/\n[a-zA-Z.][^\n]*:\n/);
  return next < 0 ? rest : rest.slice(0, name.length + 2 + next);
}

test('source: the build demands CI_COMMIT_SHA, HEAD and PREVIEW_SOURCE_SHA are the same commit', () => {
  const b = jobBlock('build-image:gateway-preview');
  assert.match(b, /test "\$CI_COMMIT_SHA" = "\$PREVIEW_SOURCE_SHA"/);
  assert.match(b, /check-source --expected "\$PREVIEW_SOURCE_SHA" --head "\$HEAD_SHA"/);
});

test('trust: the publish job never checks out the PR and clones only the protected main branch', () => {
  const p = jobBlock('gateway-preview-publish');
  assert.match(p, /GIT_STRATEGY: none/);
  assert.match(p, /--branch main/);
  assert.match(p, /MOD="\$CENTRAL_DIR\/scripts\/eng\/deploy\/preview-build\.mjs"/);
  // No script path that is relative to the PR checkout: every module call goes through $MOD.
  assert.doesNotMatch(p, /node scripts\//);
  assert.doesNotMatch(p, /services\/gateway/);
});

test('trust: the build job has no AWS identity and no registry credential', () => {
  const b = jobBlock('build-image:gateway-preview');
  assert.doesNotMatch(b, /id_tokens|AWS_ROLE_ARN|ecr get-login|skopeo|docker push|sts get-caller/);
});

test('isolation: publication is hard-wired to vitana/gateway and the shadow- family', () => {
  const p = jobBlock('gateway-preview-publish');
  const repos = [...p.matchAll(/--repository-name (\S+)/g)].map((m) => m[1]);
  assert.ok(repos.length >= 2, 'both describe calls must name the repository');
  for (const r of repos) assert.equal(r, 'vitana/gateway', `every describe must target vitana/gateway, got ${r}`);
  assert.match(p, /docker:\/\/\$REGISTRY\/vitana\/gateway:\$TAG/);
  assert.match(p, /TAG="\$\(node "\$MOD" tag --sha "\$PREVIEW_SOURCE_SHA"\)"/);
  assert.doesNotMatch(p, /REPO[A-Z_]*=|ECR_REPOSITORY|\$\{?[A-Z_]*REPOSITORY/);
});

test('isolation: the publish role audience is the preview audience, not the main-trusted one', () => {
  const p = jobBlock('gateway-preview-publish');
  assert.match(p, /aud: aws:platform:preview/);
  assert.doesNotMatch(p, /aws:platform:staging|sts\.amazonaws\.com/);
});

test('race: every preview publish is serialised by a static resource_group', () => {
  const p = jobBlock('gateway-preview-publish');
  assert.match(p, /resource_group: preview-publish-gateway\n/);
  assert.doesNotMatch(p, /resource_group: .*\$/);
});

test('race: the no-clobber check and the post-push digest check both run in the publish job', () => {
  const p = jobBlock('gateway-preview-publish');
  assert.match(p, /node "\$MOD" check-tag/);
  assert.match(p, /node "\$MOD" verify-digest/);
  assert.ok(p.indexOf('check-tag') < p.indexOf('skopeo copy'), 'no-clobber must run before the push');
  assert.ok(p.indexOf('skopeo copy') < p.indexOf('verify-digest'), 'digest verification must run after the push');
});

test('binding: the publish job verifies the manifest and the archive hash before any registry call', () => {
  const p = jobBlock('gateway-preview-publish');
  assert.ok(p.indexOf('sha256sum -c') < p.indexOf('verify-manifest'));
  assert.ok(p.indexOf('verify-manifest') < p.indexOf('aws ecr get-login-password') || p.indexOf('verify-manifest') < p.indexOf('skopeo login'));
  assert.ok(p.indexOf('verify-manifest') < p.indexOf('skopeo copy'));
});
