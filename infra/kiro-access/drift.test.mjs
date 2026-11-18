// VTID-05764: the live drift check on fixture inventories (no AWS call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drift } from './drift.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ids = JSON.parse(fs.readFileSync(path.join(DIR, 'identifiers.json'), 'utf8'));
const tpl = JSON.parse(fs.readFileSync(path.join(DIR, 'staging-operator.json'), 'utf8'));
const clean = {
  services: ['vitana-gateway', 'vitana-gateway-awsdr', 'vitana-kiro-runner', 'vitana-kiro-runner-awsdr', 'vitana-postgrest-aurora-proxy', 'vitana-postgrest-aurora-proxy-prod', 'vitana-oasis-operator-awsdr'],
  clusters: ['vitana-aurora-prod', 'vitana-aurora-staging'],
  secrets: ['vitana/aurora/prod/database-url', 'vitana/supabase/prod/jwt-secret', 'vitana/gateway/staging/internal-token', 'vitana/github/pat'],
};

test('a clean inventory has no finding', () => {
  assert.deepEqual(drift(clean, ids, tpl), []);
});

test('an unclassified service is reported', () => {
  const f = drift({ ...clean, services: [...clean.services, 'vitana-new-thing'] }, ids, tpl);
  assert.ok(f.some((x) => /vitana-new-thing.*unclassified/.test(x)), f.join('\n'));
});

test('a production secret or cluster without an explicit Deny is reported', () => {
  const weak = JSON.parse(JSON.stringify(tpl));
  const stmts = weak.Resources.StagingOperatorRole.Properties.Policies[0].PolicyDocument.Statement;
  weak.Resources.StagingOperatorRole.Properties.Policies[0].PolicyDocument.Statement = stmts.filter((s) => !['DenyProdSecrets', 'DenyProdData'].includes(s.Sid));
  const f = drift(clean, ids, weak);
  assert.ok(f.some((x) => /production secret vitana\/aurora\/prod\/database-url/.test(x)), f.join('\n'));
  assert.ok(f.some((x) => /production cluster vitana-aurora-prod/.test(x)), f.join('\n'));
});

test('a production service without an explicit Deny is reported', () => {
  const weak = JSON.parse(JSON.stringify(tpl));
  const p = weak.Resources.StagingOperatorRole.Properties.Policies[0].PolicyDocument;
  p.Statement = p.Statement.filter((s) => !['DenyProdEcs', 'NoEcsWrites'].includes(s.Sid));
  assert.ok(drift(clean, ids, weak).some((x) => /production service vitana-gateway-awsdr/.test(x)));
});
