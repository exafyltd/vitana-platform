// Tests for preview-build.mjs and the preview job in infra/gitlab-engineering/ci. Dependency-free node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkSource, previewTag, noClobberDecision, publishTarget, PREVIEW_REPOSITORY, FORBIDDEN_TAGS } from './preview-build.mjs';
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
