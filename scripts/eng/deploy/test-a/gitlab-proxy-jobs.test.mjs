// Brief item 5 (B1, F3): the GitLab proxy deploy and rollback jobs still extend the gated templates, and they run only for
// a push to the default branch. This is a structure test over the two files as text. It runs no job and makes no AWS call.
// platform-delivery.gitlab-ci.yml is generated (scripts/eng/pipeline-gen.mjs), so this test does not edit it. The env
// variables PLATFORM_DELIVERY_FILE and TPL_DEPLOY_FILE let a mutation copy stand in for either file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CI = join(HERE, '..', '..', '..', '..', 'infra', 'gitlab-engineering', 'ci');
const PLATFORM = process.env.PLATFORM_DELIVERY_FILE || join(CI, 'platform-delivery.gitlab-ci.yml');
const TPL = process.env.TPL_DEPLOY_FILE || join(CI, 'tpl-deploy.yml');

const DEPLOY_JOB = '"deploy-staging:postgrest-aurora-proxy":';
const ROLLBACK_JOB = '"rollback-staging:postgrest-aurora-proxy":';
const DEFAULT_PUSH = '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"';
const FORBIDDEN_RULE = /merge_request_event|"web"|"api"|"schedule"|when:\s*"always"/;

// The lines of one column-0 block: from its header line to the next line that starts at column 0.
function topBlock(text, header) {
  const lines = text.split('\n');
  const i = lines.indexOf(header);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length && !/^\S/.test(lines[j]); j += 1) out.push(lines[j]);
  return out;
}

// The `rules:` entries of a job block: the lines indented four or more spaces, or blank, after `  rules:`.
function rulesOf(block) {
  const i = block.findIndex((l) => /^  rules:\s*$/.test(l));
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < block.length && (block[j] === '' || /^ {4,}/.test(block[j])); j += 1) out.push(block[j]);
  return out;
}

// The value of `extends:` in a job block, without the quotes.
function extendsOf(block) {
  const line = block.find((l) => /^  extends:/.test(l));
  return line ? line.replace(/^  extends:\s*/, '').replace(/^"|"$/g, '').trim() : null;
}

// The `if:` clauses of a rules list, with the YAML double-quote escapes undone.
function ifClauses(rules) {
  return rules
    .filter((l) => /^\s*- if:/.test(l))
    .map((l) => l.replace(/^\s*- if:\s*/, '').replace(/^"|"$/g, '').replace(/\\"/g, '"'));
}

test('proxy_jobs_extend_gated_templates', () => {
  const platform = readFileSync(PLATFORM, 'utf8');
  const tpl = readFileSync(TPL, 'utf8');
  const deployJob = topBlock(platform, DEPLOY_JOB);
  const rollbackJob = topBlock(platform, ROLLBACK_JOB);
  assert.ok(deployJob, 'deploy-staging:postgrest-aurora-proxy is missing');
  assert.ok(rollbackJob, 'rollback-staging:postgrest-aurora-proxy is missing');
  assert.equal(extendsOf(deployJob), '.deploy-staging', 'the deploy job does not extend .deploy-staging');
  assert.equal(extendsOf(rollbackJob), '.rollback-staging', 'the rollback job does not extend .rollback-staging');
  const deployTpl = topBlock(tpl, '.deploy-staging:');
  const rollbackTpl = topBlock(tpl, '.rollback-staging:');
  assert.ok(deployTpl && rollbackTpl, 'the deploy or rollback template is missing');
  assert.match(deployTpl.join('\n'), /deploy-ecs\.mjs" deploy /, '.deploy-staging does not run deploy-ecs.mjs deploy');
  assert.match(rollbackTpl.join('\n'), /deploy-ecs\.mjs" rollback /, '.rollback-staging does not run deploy-ecs.mjs rollback');
});

test('proxy_jobs_run_only_for_default_branch_push', () => {
  const platform = readFileSync(PLATFORM, 'utf8');
  for (const header of [DEPLOY_JOB, ROLLBACK_JOB]) {
    const block = topBlock(platform, header);
    assert.ok(block, `${header} is missing`);
    const rules = rulesOf(block);
    assert.ok(rules && rules.length > 0, `${header} has no rules`);
    const clauses = ifClauses(rules);
    assert.ok(clauses.length > 0, `${header} has no if clause`);
    assert.ok(clauses.includes(DEFAULT_PUSH), `${header} does not run only for a push to the default branch`);
    for (const c of clauses) assert.equal(c, DEFAULT_PUSH, `${header} has another run condition: ${c}`);
    assert.doesNotMatch(rules.join('\n').replace(/\\"/g, '"'), FORBIDDEN_RULE, `${header} runs for a merge request, the web, the API or a schedule`);
  }
});
