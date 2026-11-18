// VTID-05782 (plan autonomous-to-staging-r2, lane staging-db-provision): static checks of AWS-STAGE-PROVISION-DB.yml and
// STAGING-DB-SCHEMA.yml. Line-based (no YAML parser in the no-install unit job); each check has a failing mutation.
//   node --test scripts/ci/staging-db/workflows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');
const PROVISION = read('AWS-STAGE-PROVISION-DB.yml');
const SCHEMA = read('STAGING-DB-SCHEMA.yml');

/** The top-level `on:` block. */
const onBlock = (y) => (y.match(/^on:\s*\n((?:[ \t]+.*\n|\s*\n)+)/m) || [])[1] || '';
/** Top-level trigger names in `on:`. */
const triggers = (y) => [...onBlock(y).matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
/** jobs: name -> text of the job. */
function jobs(y) {
  const body = y.split(/^jobs:\s*\n/m)[1] || '';
  const out = {};
  let cur = null;
  for (const line of body.split('\n')) {
    const m = line.match(/^ {2}([a-z0-9_-]+):\s*$/);
    if (m) { cur = m[1]; out[cur] = ''; continue; }
    if (cur) out[cur] += `${line}\n`;
  }
  return out;
}
/** Exact `permissions:` map of a job (or the top level when `text` is the whole file). */
function permissions(text, indent) {
  const re = new RegExp(`^${' '.repeat(indent)}permissions:\\s*\\n((?:${' '.repeat(indent + 2)}[a-z-]+: [a-z]+\\n)+)`, 'm');
  const m = text.match(re);
  if (!m) return null;
  return Object.fromEntries([...m[1].matchAll(/([a-z-]+): ([a-z]+)/g)].map((x) => [x[1], x[2]]));
}

export function checkProvision(y) {
  const p = [];
  const t = triggers(y);
  if (t.join(',') !== 'workflow_dispatch') p.push(`triggers must be workflow_dispatch only, got ${t.join(',')}`);
  if (!/options: \[plan, apply, load\]/.test(y)) p.push('mode input must offer plan, apply, load');
  if (/AWS_PROD_ROLE_ARN|AWS_STAGING_ROLE_ARN|secrets\./.test(y)) p.push('names a production/shared role or a secret');
  const top = permissions(y, 0);
  if (JSON.stringify(top) !== JSON.stringify({ contents: 'read' })) p.push(`top-level permissions must be contents: read, got ${JSON.stringify(top)}`);
  const j = jobs(y);
  for (const n of ['plan', 'gate', 'apply', 'load']) if (!j[n]) p.push(`job ${n} missing`);
  if (!j.gate) return p;
  if (!/if \[ "\$COST_APPROVED" != "yes" \]/.test(j.gate) || !/COST_APPROVED: \$\{\{ vars\.STAGING_DB_COST_APPROVED \}\}/.test(j.gate)) p.push('gate does not refuse without STAGING_DB_COST_APPROVED=yes');
  if (!/if \[ -z "\$ROLE_ARN" \]/.test(j.gate) || !/ROLE_ARN: \$\{\{ vars\.AWS_STAGING_DB_ROLE_ARN \}\}/.test(j.gate)) p.push('gate does not refuse without AWS_STAGING_DB_ROLE_ARN');
  if (!/role\/vitana-gha-staging-db\$/.test(j.gate)) p.push('gate does not pin the role to vitana-gha-staging-db');
  if (!/refs\/heads\/main/.test(j.gate)) p.push('gate does not require main');
  if (!/exit "\$fail"/.test(j.gate)) p.push('gate does not fail the run');
  if (/id-token/.test(j.gate) || /id-token/.test(j.plan || '')) p.push('plan/gate must not get id-token');
  if (/configure-aws-credentials/.test(j.plan || '')) p.push('plan must make no AWS call');
  for (const n of ['apply', 'load']) {
    const job = j[n] || '';
    if (!/needs: gate/.test(job)) p.push(`${n} must need gate`);
    if (JSON.stringify(permissions(job, 4)) !== JSON.stringify({ contents: 'read', 'id-token': 'write' })) p.push(`${n} permissions must be exactly contents: read + id-token: write`);
    const roles = [...job.matchAll(/role-to-assume: (.*)/g)].map((m) => m[1].trim());
    if (roles.length !== 1 || roles[0] !== '${{ vars.AWS_STAGING_DB_ROLE_ARN }}') p.push(`${n} must assume only vars.AWS_STAGING_DB_ROLE_ARN, got ${roles.join(',')}`);
    const guardAt = job.indexOf('staging-prod-ref-guard.mjs --enforce');
    const credsAt = job.indexOf('configure-aws-credentials');
    if (guardAt < 0 || credsAt < 0 || guardAt > credsAt) p.push(`${n} must run the guard in --enforce mode before the AWS credentials`);
    if (!/STAGING_DB_COST_APPROVED: \$\{\{ vars\.STAGING_DB_COST_APPROVED \}\}/.test(job)) p.push(`${n} must pass the cost approval to the script`);
  }
  if (/\$\{\{ inputs\.[a-z]+ \}\}"? --/.test(y) || /run: .*\$\{\{ inputs\./.test(y)) p.push('an input is interpolated into a run script (use env)');
  return p;
}

export function checkSchema(y) {
  const p = [];
  const t = triggers(y).sort().join(',');
  if (t !== 'push,workflow_dispatch') p.push(`triggers must be push + workflow_dispatch, got ${t}`);
  if (/^\s+pull_request/m.test(onBlock(y))) p.push('no pull_request trigger (plan §2)');
  if (!/branches:\s*\n\s+- main/.test(onBlock(y))) p.push('push must include main');
  if (!/- 'supabase\/migrations\/\*\*'/.test(onBlock(y))) p.push('push must run on supabase/migrations/**');
  if (/schedule:/.test(onBlock(y))) p.push('no schedule (loop catalog)');
  if (/id-token|configure-aws-credentials|secrets\.|role-to-assume/.test(y)) p.push('the schema build must make no AWS call and use no secret');
  if (JSON.stringify(permissions(y, 0)) !== JSON.stringify({ contents: 'read' })) p.push('top-level permissions must be contents: read');
  if (!/staging-prod-ref-guard\.mjs --report/.test(y)) p.push('guard must run in report mode');
  if (/staging-prod-ref-guard\.mjs --enforce/.test(y)) p.push('guard is report-only here');
  if (!/build-schema\.mjs --out/.test(y) || !/build-schema\.mjs --verify/.test(y)) p.push('must build and verify the bundle');
  if (!/upload-artifact/.test(y)) p.push('must upload the bundle artifact');
  if (!/node --test scripts\/ci\/staging-db\/\*\.test\.mjs/.test(y) || !/\^# skipped 0\$/.test(y)) p.push('must run the staging-db tests with PGlite and refuse skipped ones');
  return p;
}

test('AWS-STAGE-PROVISION-DB.yml: dispatch only, fail-closed owner gate, staging role only, guard first', () => {
  assert.deepEqual(checkProvision(PROVISION), []);
});

test('STAGING-DB-SCHEMA.yml: push/dispatch, no AWS, guard report-only, bundle artifact', () => {
  assert.deepEqual(checkSchema(SCHEMA), []);
});

for (const [label, mutate, re] of [
  ['a push trigger', (y) => y.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:'), /workflow_dispatch only/],
  ['no cost check', (y) => y.replace('if [ "$COST_APPROVED" != "yes" ]', 'if false'), /STAGING_DB_COST_APPROVED/],
  ['no role check', (y) => y.replace('if [ -z "$ROLE_ARN" ]', 'if false'), /AWS_STAGING_DB_ROLE_ARN/],
  ['a gate that never fails', (y) => y.replace('exit "$fail"', 'exit 0'), /does not fail the run/],
  ['the shared staging deploy role', (y) => y.replace('role-to-assume: ${{ vars.AWS_STAGING_DB_ROLE_ARN }}', 'role-to-assume: ${{ vars.AWS_STAGING_ROLE_ARN }}'), /names a production\/shared role|must assume only/],
  ['the production role', (y) => y.replace('role-to-assume: ${{ vars.AWS_STAGING_DB_ROLE_ARN }}', 'role-to-assume: ${{ secrets.' + 'AWS_PROD_ROLE_ARN }}'), /names a production\/shared role/],
  ['apply without the gate', (y) => y.replace(/needs: gate\n    if: inputs\.mode == 'apply'/, "if: inputs.mode == 'apply'"), /apply must need gate/],
  ['id-token at the top level', (y) => y.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  id-token: write\n'), /top-level permissions/],
  ['credentials before the guard', (y) => y.replace(/(  apply:[\s\S]*?)(      - name: Guard \(--enforce\)[^\n]*\n        run: [^\n]*\n)(      - uses: aws-actions\/configure-aws-credentials@v4\n        with:\n          role-to-assume: [^\n]*\n          aws-region: eu-central-1\n)/, '$1$3$2'), /guard in --enforce mode before/],
  ['an input in a run script', (y) => y.replace('run: bash scripts/aws/staging-db-provision.sh --plan --cluster "$CLUSTER"', 'run: bash scripts/aws/staging-db-provision.sh --plan --cluster "${{ inputs.cluster }}"'), /interpolated/],
]) {
  test(`mutation: AWS-STAGE-PROVISION-DB.yml with ${label} fails`, () => {
    const m = mutate(PROVISION);
    assert.notEqual(m, PROVISION, 'mutation applied');
    assert.ok(checkProvision(m).some((x) => re.test(x)), checkProvision(m).join('\n'));
  });
}

for (const [label, mutate, re] of [
  ['a pull_request trigger', (y) => y.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n'), /pull_request|triggers/],
  ['AWS credentials', (y) => y.replace('      - name: Install\n', '      - uses: aws-actions/configure-aws-credentials@v4\n      - name: Install\n'), /no AWS call/],
  ['the guard in enforce mode', (y) => y.replace('staging-prod-ref-guard.mjs --report', 'staging-prod-ref-guard.mjs --enforce'), /report/],
  ['no verify', (y) => y.replace('build-schema.mjs --verify', 'build-schema.mjs --check'), /build and verify/],
  ['no migrations path', (y) => y.replace("      - 'supabase/migrations/**'\n", ''), /supabase\/migrations/],
]) {
  test(`mutation: STAGING-DB-SCHEMA.yml with ${label} fails`, () => {
    const m = mutate(SCHEMA);
    assert.notEqual(m, SCHEMA, 'mutation applied');
    assert.ok(checkSchema(m).some((x) => re.test(x)), checkSchema(m).join('\n'));
  });
}
