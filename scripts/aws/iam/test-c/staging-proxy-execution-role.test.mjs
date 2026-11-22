// Static checks for the staging proxy's replacement execution role: the template line, the iam:PassRole policy for
// vitana-gha-staging-deploy, the relayed inline policy fixture, and the owner verification commands.
// Run: node --test scripts/aws/iam/test-c/staging-proxy-execution-role.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const IAM_DIR = path.resolve(HERE, '..');
const TEMPLATE_REL = 'services/postgrest-aurora-proxy/task-definition.template.json';
const TEMPLATE_PATH = path.join(REPO, TEMPLATE_REL);
const PASSROLE_PATH = path.join(IAM_DIR, 'staging-proxy-passrole-policy.json');
const FIXTURE_PATH = path.join(IAM_DIR, 'staging-proxy-execution-role-policy.json');
const VERIFY_PATH = path.join(IAM_DIR, 'staging-proxy-owner-verify.md');

// The commit this change builds on. The template may differ from it only on the executionRoleArn line.
const BASE_COMMIT = '5560746ba9755ab57a4b5fc22b813c273e87c1b0';
const ACCOUNT = '472838866351';
const REGION = 'eu-central-1';
const NEW_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/vitana-postgrest-staging-execution-role`;
const SECRET_ARN_PREFIX = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:`;
const STAGING_PREFIX = `${SECRET_ARN_PREFIX}vitana/gateway/staging/`;
const GRANTED = [`${STAGING_PREFIX}postgrest-authenticator-uri-*`, `${STAGING_PREFIX}postgrest-jwt-secret-*`];
const GET_SECRET_VALUE = 'secretsmanager:GetSecretValue';
const PASS_CONDITION_KEY = 'iam:PassedToService';
const PASS_SERVICE = 'ecs-tasks.amazonaws.com';

const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readTemplate = () => fs.readFileSync(TEMPLATE_PATH, 'utf8');
const baseTemplate = () => execFileSync('git', ['-C', REPO, 'show', `${BASE_COMMIT}:${TEMPLATE_REL}`], { encoding: 'utf8' });

// Returns the violations of the iam:PassRole document. An empty list passes.
function passRoleViolations(doc) {
  const violations = [];
  const statements = asList(doc.Statement);
  if (doc.Version !== '2012-10-17') violations.push('Version is not 2012-10-17');
  if (statements.length !== 1) violations.push(`${statements.length} statements, expected 1`);
  for (const s of statements) {
    if (s.Effect !== 'Allow') violations.push('Effect is not Allow');
    if (s.NotAction !== undefined || s.NotResource !== undefined) violations.push('NotAction or NotResource is present');
    if (JSON.stringify(asList(s.Action)) !== JSON.stringify(['iam:PassRole'])) violations.push('Action is not exactly iam:PassRole');
    if (s.Resource !== NEW_ROLE_ARN) violations.push(`Resource is not exactly ${NEW_ROLE_ARN}`);
    const keys = s.Condition ? Object.keys(s.Condition) : [];
    const operands = s.Condition?.StringEquals ? Object.keys(s.Condition.StringEquals) : [];
    if (keys.length !== 1 || keys[0] !== 'StringEquals' || operands.length !== 1 ||
        s.Condition.StringEquals[PASS_CONDITION_KEY] !== PASS_SERVICE) {
      violations.push(`Condition is not StringEquals ${PASS_CONDITION_KEY} = ${PASS_SERVICE}`);
    }
  }
  return violations;
}

// Returns the violations of the relayed fixture. It may hold one statement that allows only GetSecretValue, on exactly
// the two vitana/gateway/staging/ secret ARNs. An empty list passes.
function fixtureViolations(doc) {
  const violations = [];
  const statements = asList(doc.Statement);
  if (doc.Version !== '2012-10-17') violations.push('Version is not 2012-10-17');
  if (statements.length !== 1) violations.push(`${statements.length} statements, expected 1`);
  for (const s of statements) {
    if (s.Effect !== 'Allow') violations.push(`Effect is ${s.Effect}`);
    if (s.NotAction !== undefined) violations.push('NotAction is present');
    if (s.NotResource !== undefined) violations.push('NotResource is present');
    const actions = asList(s.Action);
    if (actions.length !== 1 || actions[0] !== GET_SECRET_VALUE) violations.push(`Action is ${JSON.stringify(s.Action)}`);
    const resources = asList(s.Resource);
    for (const r of resources) if (!GRANTED.includes(r)) violations.push(`Resource outside the two staging secrets: ${r}`);
    for (const g of GRANTED) if (!resources.includes(g)) violations.push(`Resource missing: ${g}`);
  }
  return violations;
}

// Every fenced code block must be an owner-run command block: its first line is the marker and it holds an aws
// command. An aws command outside a code block is a violation too. An empty list passes.
function ownerRunViolations(text) {
  const violations = [];
  const blocks = [];
  let open = null;
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('```')) {
      if (open) {
        blocks.push(open);
        open = null;
      } else {
        open = { line: i + 1, lines: [] };
      }
    } else if (open) {
      open.lines.push(line);
    } else if (/^\s*aws\s/.test(line)) {
      violations.push(`aws command outside a code block at line ${i + 1}`);
    }
  });
  if (open) violations.push(`unclosed code block at line ${open.line}`);
  if (blocks.length < 6) violations.push(`${blocks.length} code blocks, expected at least 6`);
  for (const b of blocks) {
    if (b.lines[0] !== '# Owner-run') violations.push(`block at line ${b.line} is not marked owner-run`);
    if (!b.lines.some((l) => /^\s*aws\s/.test(l))) violations.push(`block at line ${b.line} has no aws command`);
  }
  return violations;
}

test('(a) template executionRoleArn is the new role, and only that line differs from the base commit', () => {
  assert.equal(readJson(TEMPLATE_PATH).executionRoleArn, NEW_ROLE_ARN);
  const before = baseTemplate().split('\n');
  const after = readTemplate().split('\n');
  assert.equal(after.length, before.length, 'the template has the same number of lines as the base');
  const changed = before.map((line, i) => (line === after[i] ? -1 : i)).filter((i) => i >= 0);
  assert.equal(changed.length, 1, `lines that differ from ${BASE_COMMIT.slice(0, 12)}: ${changed.map((i) => i + 1).join(', ')}`);
  assert.equal(before[changed[0]].trim(), '"executionRoleArn": "REPLACE_WITH_ECS_EXECUTION_ROLE_ARN",');
  assert.equal(after[changed[0]].trim(), `"executionRoleArn": "${NEW_ROLE_ARN}",`);
});

test('(b) the iam:PassRole policy names only the new role, for ecs-tasks.amazonaws.com', () => {
  assert.deepEqual(passRoleViolations(readJson(PASSROLE_PATH)), []);
});

test('(b) negative: a wildcard Resource, another role, a missing condition or another service fails the check', () => {
  const cases = {
    'wildcard Resource': (d) => { d.Statement[0].Resource = '*'; },
    'another role': (d) => { d.Statement[0].Resource = `arn:aws:iam::${ACCOUNT}:role/vitana-ecs-task-execution-role`; },
    'no condition': (d) => { delete d.Statement[0].Condition; },
    'another service': (d) => { d.Statement[0].Condition.StringEquals[PASS_CONDITION_KEY] = 'ecs.amazonaws.com'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const doc = readJson(PASSROLE_PATH);
    mutate(doc);
    assert.notDeepEqual(passRoleViolations(doc), [], name);
  }
});

test('(c) the relayed fixture grants only GetSecretValue on the two vitana/gateway/staging/ secrets', () => {
  const doc = readJson(FIXTURE_PATH);
  assert.ok(asList(doc.Statement).some((s) => asList(s.Action).includes(GET_SECRET_VALUE)),
    'the fixture grants GetSecretValue, so the check is not vacuous');
  assert.deepEqual(fixtureViolations(doc), []);
});

test('(c) the fixture is labelled as relayed and not verified by the parent', () => {
  const { description } = readJson(FIXTURE_PATH);
  assert.match(description, /relayed from a live check by ChatGPT/);
  assert.match(description, /not yet verified by the parent/);
});

test('(d) negative: a production or rehearsal secret, a wildcard, or an extra action fails the fixture check', () => {
  const cases = {
    'vitana/ secret outside vitana/gateway/staging/': (d) => d.Statement[0].Resource.push(`${SECRET_ARN_PREFIX}vitana/supabase/prod/jwt-secret-*`),
    'production authenticator': (d) => d.Statement[0].Resource.push(`${SECRET_ARN_PREFIX}vitana/aurora/prod/postgrest-authenticator-uri-*`),
    'rehearsal authenticator': (d) => d.Statement[0].Resource.push(`${SECRET_ARN_PREFIX}vitana/aurora/rehearsal/postgrest-authenticator-uri-*`),
    'wildcard Resource': (d) => { d.Statement[0].Resource = '*'; },
    'wildcard over the staging prefix': (d) => d.Statement[0].Resource.push(`${STAGING_PREFIX}*`),
    'wildcard over vitana/': (d) => d.Statement[0].Resource.push(`${SECRET_ARN_PREFIX}vitana/*`),
    'extra action (PutSecretValue)': (d) => { d.Statement[0].Action = [GET_SECRET_VALUE, 'secretsmanager:PutSecretValue']; },
    'action wildcard (GetSecret*)': (d) => { d.Statement[0].Action = 'secretsmanager:GetSecret*'; },
    'NotResource in place of Resource': (d) => { d.Statement[0].NotResource = GRANTED; delete d.Statement[0].Resource; },
    'extra statement on a production secret': (d) => d.Statement.push({
      Effect: 'Allow', Action: GET_SECRET_VALUE, Resource: `${SECRET_ARN_PREFIX}vitana/supabase/prod/jwt-secret-*`,
    }),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const doc = readJson(FIXTURE_PATH);
    mutate(doc);
    assert.notDeepEqual(fixtureViolations(doc), [], name);
  }
});

test('(d) control: the two granted ARNs in either order pass the fixture check', () => {
  const doc = readJson(FIXTURE_PATH);
  doc.Statement[0].Resource.reverse();
  assert.deepEqual(fixtureViolations(doc), []);
});

test('(e) every command block in staging-proxy-owner-verify.md is marked owner-run', () => {
  assert.deepEqual(ownerRunViolations(fs.readFileSync(VERIFY_PATH, 'utf8')), []);
});

test('(e) the verify file covers both secrets, the image and log actions, and states what the simulation does not cover', () => {
  const text = fs.readFileSync(VERIFY_PATH, 'utf8');
  for (const needle of [
    'vitana/gateway/staging/postgrest-authenticator-uri',
    'vitana/gateway/staging/postgrest-jwt-secret',
    'ecr:BatchGetImage',
    'logs:PutLogEvents',
    'secretsmanager:GetSecretValue',
    'implicitDeny',
    'trust policy',
  ]) {
    assert.ok(text.includes(needle), `missing: ${needle}`);
  }
});

test('(e) negative: an unmarked block or a bare aws line fails the owner-run check', () => {
  const text = fs.readFileSync(VERIFY_PATH, 'utf8');
  assert.notDeepEqual(ownerRunViolations(text.replace('# Owner-run\n', '')), []);
  assert.notDeepEqual(ownerRunViolations(`${text}\naws iam list-roles\n`), []);
});
