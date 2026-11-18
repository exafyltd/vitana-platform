// Staging gateway deploys never carry production credentials (owner instruction 2026-11-18).
// AWS-STAGE-DEPLOY-GATEWAY.yml resolves only staging-named secrets, and its render step refuses to register a task
// definition that binds a production Supabase/Aurora secret. AWS-PROD-DEPLOY-GATEWAY.yml is not touched.
//   node --test scripts/ci/staging-db/stage-deploy-no-prod-secrets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const wf = (f) => fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');
/** Text of the step `- name: <name>` up to the next step of the same job (the run block has column-0 lines). */
const stepText = (y, name) => {
  const L = y.split('\n');
  const i = L.findIndex((l) => l === `      - name: ${name}`);
  if (i < 0) return null;
  let j = i + 1;
  while (j < L.length && !/^ {6}- name: /.test(L[j]) && !/^ {2}[a-z_-]+:\s*$/.test(L[j])) j++;
  return L.slice(i, j).join('\n');
};
const RENDER = 'Register task-definition revision + roll the service (1/2 — build the task definition)';
const code = (y) => y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const SM = 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:';

test('staging gateway deploy resolves no production Supabase or Aurora secret', () => {
  const y = code(wf('AWS-STAGE-DEPLOY-GATEWAY.yml'));
  const ids = [...y.matchAll(/"SEC_[A-Z_]+:([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, 'secret resolution list found');
  for (const id of ids) assert.doesNotMatch(id, /^vitana\/(supabase|aurora)\/prod\//, id);
  assert.ok(ids.includes('vitana/supabase/staging/jwt-secret'));
  assert.ok(ids.includes('vitana/supabase/staging/anon-key'));
  assert.ok(ids.includes('vitana/gateway/staging/service-token'));
  assert.doesNotMatch(y.replace(/test\("[^"]*"\)/g, ''), /secret-id\s+vitana\/(supabase|aurora)\/prod\//);
});

test('the render step refuses a task definition carrying production credentials', () => {
  const step = stepText(wf('AWS-STAGE-DEPLOY-GATEWAY.yml'), RENDER);
  assert.ok(step, 'render step found');
  const m = step.match(/PROD_LEAK=\$\(printf '%s' "\$NEW_DEF" \| jq -r '([\s\S]*?)'\)\n/);
  assert.ok(m, 'production-credential gate found');
  assert.ok(step.indexOf('PROD_LEAK=') < step.indexOf('new-task-def.json'), 'gate runs before the definition is written');
  const leak = (c) => {
    const r = spawnSync('jq', ['-r', m[1]], { input: JSON.stringify({ containerDefinitions: [{ name: 'g', ...c }] }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(leak({ secrets: [{ name: 'SUPABASE_JWT_SECRET', valueFrom: `${SM}vitana/supabase/staging/jwt-secret-AbCdEf` }] }), '');
  assert.equal(leak({ secrets: [{ name: 'GATEWAY_SERVICE_TOKEN', valueFrom: `${SM}vitana/gateway/staging/service-token-AbCdEf` }] }), '');
  assert.equal(leak({ environment: [{ name: 'SUPABASE_PUBLIC_URL', value: 'https://inmkhvwdcuyhnxkgfvsb.supabase.co' }] }), '');
  for (const [n, v] of [
    ['SUPABASE_SERVICE_ROLE', `${SM}vitana/supabase/prod/service-role-key-AbCdEf`],
    ['SUPABASE_JWT_SECRET', `${SM}vitana/supabase/prod/jwt-secret-AbCdEf`],
    ['DATABASE_URL', `${SM}vitana/aurora/prod/database-url-AbCdEf`],
    ['X', `${SM}rds!cluster-4dab93b8-1111-2222-3333-444444444444-AbCdEf`],
  ]) assert.equal(leak({ secrets: [{ name: n, valueFrom: v }] }), n, v);
  assert.equal(leak({ environment: [{ name: 'PGHOST', value: 'vitana-aurora-prod.cluster-x.eu-central-1.rds.amazonaws.com' }] }), 'PGHOST');
  assert.match(step, /refusing to register: production credentials on a staging task definition/);
});

test('production gateway deploy keeps its production secrets (unchanged by this rule)', () => {
  const y = wf('AWS-PROD-DEPLOY-GATEWAY.yml');
  assert.match(y, /vitana\/supabase\/prod\//);
  assert.doesNotMatch(y, /Production-credential gate/);
});
