// Static checks for the staging proxy's replacement execution role: the template lines, the iam:PassRole policy for
// vitana-gha-staging-deploy, the relayed inline policy fixture and its grant coverage of the template, and the owner
// verification commands.
// Run: node --test scripts/aws/iam/test-c/staging-proxy-execution-role.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

// The commit this change builds on. The template may differ from it only on the lines in EXPECTED_CHANGES.
const BASE_COMMIT = '5560746ba9755ab57a4b5fc22b813c273e87c1b0';
// The base template as committed at BASE_COMMIT (git show), so the check reads no git history and runs on a depth-1 checkout.
const BASE_SNAPSHOT_PATH = path.join(HERE, 'base-task-definition.snapshot.json');
const ACCOUNT = '472838866351';
const REGION = 'eu-central-1';
const NEW_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/vitana-postgrest-staging-execution-role`;
const SECRET_ARN_PREFIX = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:`;
const STAGING_PREFIX = `${SECRET_ARN_PREFIX}vitana/gateway/staging/`;
const GRANTED = [`${STAGING_PREFIX}postgrest-authenticator-uri-*`, `${STAGING_PREFIX}postgrest-jwt-secret-*`];
const GET_SECRET_VALUE = 'secretsmanager:GetSecretValue';
const PASS_CONDITION_KEY = 'iam:PassedToService';
const PASS_SERVICE = 'ecs-tasks.amazonaws.com';
const JWT_ARN = `${SECRET_ARN_PREFIX}vitana/gateway/staging/postgrest-jwt-secret`;
const BASE_JWT_ARN = `${SECRET_ARN_PREFIX}vitana/gateway/staging/supabase-jwt-secret`;
const AUTH_URI_ARN = `${STAGING_PREFIX}postgrest-authenticator-uri`;
// The only two lines that may differ from the base commit, as [base, changed] pairs of trimmed text, in file order.
const EXPECTED_CHANGES = [
  ['"executionRoleArn": "REPLACE_WITH_ECS_EXECUTION_ROLE_ARN",', `"executionRoleArn": "${NEW_ROLE_ARN}",`],
  [`{ "name": "PGRST_JWT_SECRET", "valueFrom": "${BASE_JWT_ARN}" }`, `{ "name": "PGRST_JWT_SECRET", "valueFrom": "${JWT_ARN}" }`],
];

const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readTemplate = () => fs.readFileSync(TEMPLATE_PATH, 'utf8');
const baseTemplate = () => fs.readFileSync(BASE_SNAPSHOT_PATH, 'utf8');

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

// Every entry of every container's secrets list in the template. The entries are the parsed objects, so a caller can
// change one in place.
const secretEntries = (template) => (template.containerDefinitions ?? []).flatMap((c) => asList(c.secrets));
const secretRef = (template, name) => secretEntries(template).find((s) => s.name === name);

const escapeRegex = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
// IAM resource matching: '*' matches any run of characters. Secrets Manager appends a random suffix to a secret ARN, so
// a bare reference (the form the template uses) also matches a "name-*" grant.
function resourceMatches(pattern, arn) {
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
  return regex.test(arn) || (pattern.endsWith('-*') && pattern.slice(0, -2) === arn);
}

// The resources of the Allow statements that grant GetSecretValue. This is what the relayed role may read.
function grantedSecretResources(fixture) {
  return asList(fixture.Statement)
    .filter((s) => s.Effect === 'Allow' && asList(s.Action).includes(GET_SECRET_VALUE))
    .flatMap((s) => asList(s.Resource));
}

// Returns the violations of the template's secret references against the fixture. A value that is an ARN must match a
// granted resource. A value still set to a REPLACE_WITH_ placeholder is pending, and only PGRST_DB_URI may stay pending,
// because the owner renders it (procedure step 1.7). An empty list passes.
function secretCoverageViolations(template, fixture) {
  const granted = grantedSecretResources(fixture);
  const violations = [];
  for (const { name, valueFrom } of secretEntries(template)) {
    const value = String(valueFrom);
    if (value.startsWith('REPLACE_WITH_')) {
      if (name !== 'PGRST_DB_URI') violations.push(`${name} is an unrendered placeholder`);
    } else if (!value.startsWith('arn:aws:secretsmanager:')) {
      violations.push(`${name} is not a Secrets Manager ARN`);
    } else if (!granted.some((pattern) => resourceMatches(pattern, value))) {
      violations.push(`${name} is not granted by the role's policy: ${value}`);
    }
  }
  return violations;
}

test('(a) template: executionRoleArn and PGRST_JWT_SECRET are the only lines that differ from the base commit, with exact values', () => {
  const template = readJson(TEMPLATE_PATH);
  assert.equal(template.executionRoleArn, NEW_ROLE_ARN);
  assert.equal(secretRef(template, 'PGRST_JWT_SECRET').valueFrom, JWT_ARN);
  const before = baseTemplate().split('\n');
  const after = readTemplate().split('\n');
  assert.equal(after.length, before.length, 'the template has the same number of lines as the base');
  const changed = before.map((line, i) => (line === after[i] ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual(
    changed.map((i) => [before[i].trim(), after[i].trim()]),
    EXPECTED_CHANGES,
    `lines that differ from ${BASE_COMMIT.slice(0, 12)}: ${changed.map((i) => i + 1).join(', ')}`,
  );
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

test('(f) grant coverage: every secret the template references is granted by the relayed policy', () => {
  assert.deepEqual(secretCoverageViolations(readJson(TEMPLATE_PATH), readJson(FIXTURE_PATH)), []);
});

test('(f) control: a rendered PGRST_DB_URI for the staging authenticator passes the coverage check', () => {
  const rendered = readJson(TEMPLATE_PATH);
  secretRef(rendered, 'PGRST_DB_URI').valueFrom = AUTH_URI_ARN;
  assert.deepEqual(secretCoverageViolations(rendered, readJson(FIXTURE_PATH)), []);
});

test('(f) negative: an old JWT name, a production or rehearsal reference, another placeholder, or an SSM reference fails the coverage check', () => {
  const cases = {
    'old JWT name supabase-jwt-secret': (t) => { secretRef(t, 'PGRST_JWT_SECRET').valueFrom = BASE_JWT_ARN; },
    'production JWT secret': (t) => { secretRef(t, 'PGRST_JWT_SECRET').valueFrom = `${SECRET_ARN_PREFIX}vitana/supabase/prod/jwt-secret`; },
    'rehearsal authenticator as DB URI': (t) => { secretRef(t, 'PGRST_DB_URI').valueFrom = `${SECRET_ARN_PREFIX}vitana/aurora/rehearsal/postgrest-authenticator-uri-AbCdEf`; },
    'production authenticator as DB URI': (t) => { secretRef(t, 'PGRST_DB_URI').valueFrom = `${SECRET_ARN_PREFIX}vitana/aurora/prod/postgrest-authenticator-uri`; },
    'another unrendered placeholder': (t) => { secretRef(t, 'PGRST_JWT_SECRET').valueFrom = 'REPLACE_WITH_JWT_SECRET_ARN'; },
    'SSM parameter reference': (t) => { secretRef(t, 'PGRST_JWT_SECRET').valueFrom = 'arn:aws:ssm:eu-central-1:472838866351:parameter/vitana/jwt'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const template = readJson(TEMPLATE_PATH);
    mutate(template);
    assert.notDeepEqual(secretCoverageViolations(template, readJson(FIXTURE_PATH)), [], name);
  }
});
