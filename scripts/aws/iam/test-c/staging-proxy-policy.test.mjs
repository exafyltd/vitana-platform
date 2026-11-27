// Static checks for the staging-only proxy task-execution policy draft.
// Run: node --test scripts/aws/iam/test-c/staging-proxy-policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.resolve(HERE, '..', 'staging-proxy-task-execution-policy.json');
const POLICY_TEXT = fs.readFileSync(POLICY_PATH, 'utf8');

const GET_SECRET_VALUE = 'secretsmanager:GetSecretValue';
// A non-staging secret path. The negative tests add grants on it in memory.
const DEV_ARN = 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/dev/supabase-jwt-secret*';

// Production and rehearsal secret paths that the shared execution policy grants GetSecretValue on.
const NAMED_PROD_OR_REHEARSAL = [
  'vitana/aurora/prod',
  'vitana/supabase/prod',
  'vitana/realtime/prod',
  'vitana/aurora/rehearsal',
];
// A production or rehearsal marker as its own token in an ARN: prod, production, awsdr or rehearsal.
const PROD_OR_REHEARSAL_TOKEN = /(^|[/:.-])(prod|production|awsdr|rehearsal)($|[/:.*-])/i;
// A staging secret path: vitana/<service>/staging/... or vitana/<service>/staging-db/...
const STAGING_SECRET_NAME = /^vitana\/[a-z0-9-]+\/staging(-db)?\//;

const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

// IAM action patterns: '*' matches any run of characters and '?' matches one character. IAM action names
// are case-insensitive, so the match is too.
const patternMatches = (pattern, text) => {
  const source = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(text);
};
const listCoversGetSecretValue = (actions) => asList(actions).some((action) => patternMatches(action, GET_SECRET_VALUE));
// A statement grants GetSecretValue when Action lists it, or when NotAction does not list it.
const grantsGetSecretValue = (statement) =>
  listCoversGetSecretValue(statement.Action) ||
  (statement.NotAction !== undefined && !listCoversGetSecretValue(statement.NotAction));

const secretNameOf = (arn) => {
  const at = arn.indexOf(':secret:');
  return at < 0 ? '' : arn.slice(at + ':secret:'.length);
};

// Every Resource in every statement that names a production or rehearsal path.
function prodOrRehearsalResources(doc) {
  const found = [];
  for (const statement of asList(doc.Statement)) {
    for (const resource of asList(statement.Resource)) {
      const text = String(resource);
      if (NAMED_PROD_OR_REHEARSAL.some((p) => text.includes(p)) || PROD_OR_REHEARSAL_TOKEN.test(text)) {
        found.push(text);
      }
    }
  }
  return found;
}

// Every resource of a statement that grants GetSecretValue (any effect) and is not a staging secret path.
// A NotResource on such a statement is reported too, because it covers every secret outside its list.
function nonStagingGetSecretValueResources(doc) {
  const found = [];
  for (const statement of asList(doc.Statement)) {
    if (!grantsGetSecretValue(statement)) continue;
    if (statement.NotResource !== undefined) found.push('NotResource');
    for (const resource of asList(statement.Resource)) {
      const text = String(resource);
      if (!STAGING_SECRET_NAME.test(secretNameOf(text))) found.push(text);
    }
  }
  return found;
}

function assertNoProdOrRehearsal(doc) {
  assert.deepEqual(prodOrRehearsalResources(doc), [], 'production or rehearsal resource in the policy');
}

function assertStagingOnlyGetSecretValue(doc) {
  assert.deepEqual(nonStagingGetSecretValueResources(doc), [], 'GetSecretValue on a non-staging resource');
}

test('(a) the draft parses as JSON', () => {
  const doc = JSON.parse(POLICY_TEXT);
  assert.equal(doc.Version, '2012-10-17');
  assert.ok(asList(doc.Statement).length > 0, 'the policy has at least one statement');
});

test('(b) no Resource names a production or rehearsal secret path', () => {
  assertNoProdOrRehearsal(JSON.parse(POLICY_TEXT));
});

test('(c) every GetSecretValue statement names only staging paths', () => {
  const doc = JSON.parse(POLICY_TEXT);
  assert.ok(asList(doc.Statement).some(grantsGetSecretValue), 'the draft grants GetSecretValue somewhere, so the check is not vacuous');
  assertStagingOnlyGetSecretValue(doc);
});

test('(d) negative: a production or rehearsal ARN added in memory fails checks (b) and (c)', () => {
  const added = [
    'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/aurora/prod/postgrest-authenticator-uri*',
    'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/supabase/prod/jwt-secret*',
    'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/realtime/prod/*',
    'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/aurora/rehearsal/postgrest-authenticator-uri*',
  ];
  for (const arn of added) {
    const mutated = JSON.parse(POLICY_TEXT); // an in-memory copy; the file on disk is not changed
    const statement = mutated.Statement.find(grantsGetSecretValue);
    statement.Resource = [...asList(statement.Resource), arn];
    assert.throws(() => assertNoProdOrRehearsal(mutated), /production or rehearsal/, `check (b) missed ${arn}`);
    assert.throws(() => assertStagingOnlyGetSecretValue(mutated), /non-staging/, `check (c) missed ${arn}`);
  }
});

test('(e) negative: GetSecret*, *Value and NotAction grants on a non-staging ARN fail check (c)', () => {
  const forms = [
    { Action: 'secretsmanager:GetSecret*' },
    { Action: 'secretsmanager:*Value' },
    { NotAction: 'secretsmanager:DeleteSecret' },
  ];
  for (const form of forms) {
    const mutated = JSON.parse(POLICY_TEXT); // an in-memory copy with one extra statement
    mutated.Statement.push({ Effect: 'Allow', ...form, Resource: DEV_ARN });
    assert.throws(() => assertStagingOnlyGetSecretValue(mutated), /non-staging/, `check (c) missed ${JSON.stringify(form)}`);
  }
});

test('(f) control: statements that do not grant GetSecretValue pass check (c) on a non-staging ARN', () => {
  const forms = [{ Action: 'secretsmanager:DescribeSecret' }, { NotAction: GET_SECRET_VALUE }];
  for (const form of forms) {
    const mutated = JSON.parse(POLICY_TEXT);
    mutated.Statement.push({ Effect: 'Allow', ...form, Resource: DEV_ARN });
    assert.doesNotThrow(() => assertStagingOnlyGetSecretValue(mutated), JSON.stringify(form));
  }
});
