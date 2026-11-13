// VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover): the STAGING_DATA_PLANE switch in the two existing
// staging deploy workflows, and the static shape of AWS-STAGE-CUTOVER-REHEARSAL.yml / AWS-STAGE-CUTOVER.yml.
// Line-based (no YAML parser in the no-install unit job). The step scripts are rendered and RUN with a stubbed AWS CLI:
// with STAGING_DATA_PLANE unset/empty/shared the task definition registered is byte-identical to the one the pinned
// (origin/main before this lane) step registers. Each static check has a failing mutation.
//   node --test scripts/ci/staging-db/cutover-workflows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const FX = path.join(HERE, 'fixtures', 'cutover');
const wf = (f) => fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');
const pinned = (f) => fs.readFileSync(path.join(FX, f.replace(/\.yml$/, '.pinned.yml')), 'utf8');
const GW = 'AWS-STAGE-DEPLOY-GATEWAY.yml';
const PX = 'AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml';
const ROLL = 'Register task-definition revision + roll the service';

/** The text of the step `- name: <name>` (indent 6) up to the next step or the end of the job. */
export function stepText(y, name) {
  const lines = y.split('\n');
  const i = lines.findIndex((l) => l === `      - name: ${name}`);
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^ {0,6}\S/.test(lines[j]) && !/^ {6}- /.test(lines[j])) j++;
  // trailing comment lines at indent 6 belong to the next step
  while (j > i + 1 && /^ {6}#/.test(lines[j - 1])) j--;
  return lines.slice(i, j).join('\n');
}
/** Drop every `# >>> VTID-05781` … `# <<< VTID-05781` block (inclusive). */
export const stripMarkers = (t) => t.split('\n').reduce((a, l) => {
  if (/# >>> VTID-05781/.test(l)) a.skip = true;
  else if (/# <<< VTID-05781/.test(l)) a.skip = false;
  else if (!a.skip) a.out.push(l);
  return a;
}, { out: [], skip: false }).out.join('\n');
/** The `run: |` script of a step, de-indented. */
export function runScript(step) {
  const lines = step.split('\n');
  const i = lines.findIndex((l) => /^ {8}run: \|\s*$/.test(l));
  if (i < 0) return null;
  const body = [];
  for (const l of lines.slice(i + 1)) { if (l.trim() && !/^ {10}/.test(l)) break; body.push(l.slice(10)); }
  return body.join('\n');
}
/** Replace ${{ … }} with ctx values; an expression without a value is an error (nothing silently empty). */
export function render(script, ctx) {
  return script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, e) => { if (!(e in ctx)) throw new Error(`no value for \${{ ${e} }}`); return ctx[e]; });
}

// ---- 1. the deploy workflows: shared path unchanged
test('deploy workflows: exactly the marked blocks were added to the roll step; without them the step is the pinned one', () => {
  for (const f of [GW, PX]) {
    const cur = stepText(wf(f), ROLL);
    const pin = stepText(pinned(f), ROLL);
    assert.ok(cur && pin, `${f}: step "${ROLL}" found`);
    assert.equal(stripMarkers(cur), pin, `${f}: the roll step differs from the pinned step outside the VTID-05781 blocks`);
    assert.equal((wf(f).match(/# >>> VTID-05781/g) || []).length, 2, `${f}: two marked blocks`);
    assert.equal(stripMarkers(wf(f)).includes('STAGING_DATA_PLANE'), false, `${f}: STAGING_DATA_PLANE only inside the marked blocks`);
    assert.equal(stripMarkers(wf(f)).includes('staging-cutover'), false, `${f}: the cutover scripts only inside the marked blocks`);
  }
});

test('deploy workflows: the switch reads the repository variables and calls the select script only off the shared path', () => {
  const g = stepText(wf(GW), ROLL); const p = stepText(wf(PX), ROLL);
  for (const s of [g, p]) {
    assert.match(s, /STAGING_DATA_PLANE: \$\{\{ vars\.STAGING_DATA_PLANE \}\}/);
    assert.match(s, /STAGING_CUTOVER_APPROVED: \$\{\{ vars\.STAGING_CUTOVER_APPROVED \}\}/);
    assert.match(s, /if \[ "\$\{STAGING_DATA_PLANE:-shared\}" != shared \] \|\| printf '%s' "\$NEW_DEF" \| grep -q '"STAGING_DATA_PLANE"'; then/);
  }
  assert.match(g, /bash scripts\/aws\/staging-cutover-select\.sh --service gateway\)/);
  assert.match(p, /bash scripts\/aws\/staging-cutover-select\.sh --service postgrest\)/);
  // the switch runs after data_backend and before register (gateway) / after the jq build and before register (proxy)
  for (const s of [g, p]) assert.ok(s.indexOf('staging-cutover-select.sh') < s.indexOf('aws ecs register-task-definition'));
  assert.ok(g.indexOf('taskdef-data-backend.py') < g.indexOf('staging-cutover-select.sh'));
});

const TDGW = fs.readFileSync(path.join(FX, 'taskdef-gateway.json'), 'utf8');
const TDPG = fs.readFileSync(path.join(FX, 'taskdef-postgrest.json'), 'utf8');
const arnOf = (fam, rev) => `arn:aws:ecs:eu-central-1:472838866351:task-definition/${fam}:${rev}`;

/** Run the roll step of `file` (text `y`) against a stubbed AWS. Returns { status, registered (raw JSON text or null) }. */
function runRoll(y, file, envExtra = {}, liveTd = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-wf-'));
  for (const d of ['services', 'td', 'runner']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, 'log'), '');
  const isGw = file === GW;
  const fam = isGw ? 'vitana-gateway' : 'vitana-postgrest-aurora-staging';
  const svc = isGw ? 'vitana-gateway' : 'vitana-postgrest-aurora-proxy';
  const td = liveTd ?? (isGw ? TDGW : TDPG);
  fs.writeFileSync(path.join(dir, 'td', `${fam}:5.json`), JSON.stringify({ ...JSON.parse(td), taskDefinitionArn: arnOf(fam, 5), revision: 5, status: 'ACTIVE' }));
  fs.writeFileSync(path.join(dir, 'services', `${svc}.json`), JSON.stringify({ serviceName: svc, status: 'ACTIVE', desiredCount: 1, runningCount: 1, deployments: [{ status: 'PRIMARY', taskDefinition: arnOf(fam, 5), rolloutState: 'COMPLETED' }] }));
  if (isGw) fs.writeFileSync(path.join(dir, 'runner', 'new-task-def.json'), td);
  const script = render(runScript(stepText(y, ROLL)), {
    'env.ECS_CLUSTER': 'Vitana-ECS-Cluster', 'env.ECS_SERVICE': svc, 'env.PROXY_CONTAINER': 'proxy',
    'steps.build.outputs.image': '472838866351.dkr.ecr.eu-central-1.amazonaws.com/vitana/postgrest-aurora-proxy:staging-new',
  });
  const r = spawnSync('bash', ['-e', '-c', script], {
    cwd: ROOT, encoding: 'utf8',
    env: { PATH: `${path.join(FX, 'bin')}:${process.env.PATH}`, HOME: process.env.HOME, STUB_STATE: dir, RUNNER_TEMP: path.join(dir, 'runner'),
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'), DATA_BACKEND: 'keep', ...envExtra },
  });
  const reg = path.join(dir, `registered-${fam}.json`);
  return { status: r.status, stderr: r.stderr, registered: fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8') : null };
}

for (const f of [GW, PX]) {
  test(`${f}: with STAGING_DATA_PLANE unset, empty or shared the registered task definition is byte-identical to the pinned step's`, () => {
    const base = runRoll(pinned(f), f);
    assert.equal(base.status, 0, base.stderr);
    assert.ok(base.registered);
    for (const plane of [undefined, '', 'shared']) {
      const extra = plane === undefined ? {} : { STAGING_DATA_PLANE: plane };
      for (const appr of [undefined, '', 'yes']) {
        const cur = runRoll(wf(f), f, { ...extra, ...(appr === undefined ? {} : { STAGING_CUTOVER_APPROVED: appr }) });
        assert.equal(cur.status, 0, cur.stderr);
        assert.equal(cur.registered, base.registered, `${f} plane=${plane} approved=${appr}`);
      }
    }
  });

  test(`${f}: STAGING_DATA_PLANE=isolated without STAGING_CUTOVER_APPROVED=yes fails the step and registers nothing`, () => {
    const r = runRoll(wf(f), f, { STAGING_DATA_PLANE: 'isolated' });
    assert.notEqual(r.status, 0);
    assert.equal(r.registered, null);
  });

  test(`${f}: STAGING_DATA_PLANE=isolated with approval registers the staging-db references; shared afterwards restores the shared plane`, () => {
    const iso = runRoll(wf(f), f, { STAGING_DATA_PLANE: 'isolated', STAGING_CUTOVER_APPROVED: 'yes' });
    assert.equal(iso.status, 0, iso.stderr);
    assert.match(iso.registered, /vitana\/aurora\/staging-db\/postgrest-authenticator-uri-AbCdEf/);
    assert.doesNotMatch(iso.registered, /vitana\/aurora\/prod\//);
    // the live task definition is now the isolated one; a later push deploy with the variable unset restores shared
    const back = runRoll(wf(f), f, {}, iso.registered);
    assert.equal(back.status, 0, back.stderr);
    assert.doesNotMatch(back.registered, /STAGING_DATA_PLANE/);
    assert.doesNotMatch(back.registered, /staging-db\//);
  });

  test(`${f}: an unknown STAGING_DATA_PLANE value fails closed`, () => {
    const r = runRoll(wf(f), f, { STAGING_DATA_PLANE: 'isolated-please', STAGING_CUTOVER_APPROVED: 'yes' });
    assert.notEqual(r.status, 0);
    assert.equal(r.registered, null);
  });
}

test('gateway: isolated needs data_backend=keep', () => {
  const r = runRoll(wf(GW), GW, { STAGING_DATA_PLANE: 'isolated', STAGING_CUTOVER_APPROVED: 'yes', DATA_BACKEND: 'aurora' });
  assert.notEqual(r.status, 0);
  assert.equal(r.registered, null);
});

// ---- 2. the rehearsal and cutover workflows (static)
const onBlock = (y) => (y.match(/^on:\s*\n((?:[ \t]+.*\n|\s*\n)+)/m) || [])[1] || '';
const triggers = (y) => [...onBlock(y).matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
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
function permissions(text, indent) {
  const re = new RegExp(`^${' '.repeat(indent)}permissions:\\s*\\n((?:${' '.repeat(indent + 2)}[a-z-]+: [a-z]+\\n)+)`, 'm');
  const m = text.match(re);
  return m ? Object.fromEntries([...m[1].matchAll(/([a-z-]+): ([a-z]+)/g)].map((x) => [x[1], x[2]])) : null;
}
const roles = (t) => [...t.matchAll(/role-to-assume: (.*)/g)].map((m) => m[1].trim());
const ecsCalls = (t) => [...t.matchAll(/bash scripts\/aws\/staging-cutover-ecs\.sh ([a-z-]+)/g)].map((m) => m[1]);

function common(y) {
  const p = [];
  if (triggers(y).join(',') !== 'workflow_dispatch') p.push(`triggers must be workflow_dispatch only, got ${triggers(y).join(',')}`);
  if (/^\s*schedule:/m.test(y)) p.push('no schedule trigger');
  if (/AWS_PROD_ROLE_ARN|AWS_STAGING_ACCESS_KEY_ID|AWS_STAGING_SECRET_ACCESS_KEY|\bsecrets\.[A-Z_]/.test(y)) p.push('names the production role, the static staging keys or a repository secret');
  if (JSON.stringify(permissions(y, 0)) !== JSON.stringify({ contents: 'read' })) p.push('top-level permissions must be exactly contents: read');
  if (/run: .*\$\{\{ inputs\./.test(y) || /^\s+.*\$\{\{ inputs\.[a-z_]+ \}\}.*--/m.test(y.split('\n').filter((l) => !/^\s*(run-name|description|[a-z_]+: \$\{\{ inputs)/.test(l)).join('\n'))) p.push('an input is interpolated into a run script (use env)');
  if (!/^concurrency:\n {2}group: aws-stage-cutover\n {2}cancel-in-progress: false$/m.test(y)) p.push('must share the aws-stage-cutover concurrency group, never cancelling');
  for (const [n, j] of Object.entries(jobs(y))) {
    for (const r of roles(j)) if (!['${{ vars.AWS_STAGING_ROLE_ARN }}', '${{ vars.AWS_STAGING_DB_ROLE_ARN }}'].includes(r)) p.push(`${n}: role ${r} is not a staging role`);
    if (/configure-aws-credentials/.test(j) && permissions(j, 4)?.['id-token'] !== 'write') p.push(`${n}: credentials without id-token`);
    if (!/configure-aws-credentials/.test(j) && permissions(j, 4)?.['id-token']) p.push(`${n}: id-token without credentials`);
  }
  return p;
}

export function checkRehearsal(y) {
  const p = common(y);
  const j = jobs(y);
  if (!/^run-name: 'Staging cutover rehearsal \$\{\{ inputs\.mode \}\} @ \$\{\{ github\.sha \}\} \[VTID: VTID-05781\]'$/m.test(y)) p.push('run-name must be "Staging cutover rehearsal <mode> @ <sha>" (the cutover gate matches it)');
  if (!/options: \[secrets, register, run\]/.test(y)) p.push('mode input must offer secrets, register, run');
  if (!j.gate || /configure-aws-credentials/.test(j.gate)) p.push('gate job must exist and make no AWS call');
  if (j.gate && !/\[ "\$COST_APPROVED" = yes \] \|\|/.test(j.gate)) p.push('gate does not refuse without STAGING_DB_COST_APPROVED=yes');
  if (j.gate && !/\[ "\$REF" = refs\/heads\/main \] \|\|/.test(j.gate)) p.push('gate does not require main');
  if (j.gate && !/exit "\$fail"/.test(j.gate)) p.push('gate does not fail the run');
  for (const n of ['secrets', 'register', 'run']) if (!j[n]) p.push(`job ${n} missing`);
  if (j.secrets && (roles(j.secrets).join() !== '${{ vars.AWS_STAGING_DB_ROLE_ARN }}' || !/needs: gate/.test(j.secrets))) p.push('secrets must need gate and assume only the staging database role');
  for (const n of ['register', 'run']) if (j[n] && roles(j[n]).join() !== '${{ vars.AWS_STAGING_ROLE_ARN }}') p.push(`${n} must assume only the staging deploy role`);
  if (j.register && !/needs: gate/.test(j.register)) p.push('register must need gate');
  if (j.run && !/needs: register/.test(j.run)) p.push('run must need register');
  const calls = ecsCalls(y);
  if (calls.some((c) => !c.startsWith('candidate-'))) p.push(`the rehearsal may only call candidate-* ECS subcommands, got ${calls.join(',')}`);
  if (j.run && !/- name: Scale candidates to 0 \(always\)\n {8}if: always\(\)\n {8}run: bash scripts\/aws\/staging-cutover-ecs\.sh candidate-stop/.test(j.run)) p.push('candidates must always be scaled back to 0');
  if (j.run && !/staging-cutover-smoke\.mjs --base "\$CANDIDATE_URL"/.test(j.run)) p.push('the smoke must run against the candidate host');
  if (!/^ {2}CANDIDATE_URL: https:\/\/preview-iso-[a-z0-9.-]+$/m.test(y)) p.push('CANDIDATE_URL must be a preview-iso host');
  if (/preview-aws-gateway/.test(y)) p.push('the rehearsal must not name the live staging host');
  return p;
}

export function checkCutover(y) {
  const p = common(y);
  const j = jobs(y);
  if (!/options: \[flip, rollback\]/.test(y)) p.push('action input must offer flip, rollback');
  if (!j.gate || /configure-aws-credentials/.test(j.gate)) p.push('gate job must exist and make no AWS call');
  if (j.gate && !/node scripts\/aws\/staging-cutover-gate\.mjs --sha "\$SHA" --runs "\$R\/runs\.json" --impact "\$R\/impact\.json" --busy "\$R\/busy\.txt"/.test(j.gate)) p.push('gate must run staging-cutover-gate.mjs with rehearsal runs, impact and busy list');
  for (const v of ['STAGING_CUTOVER_APPROVED', 'PLAN_SPAR_GATEWAY_URL', 'STAGING_DATA_PLANE', 'STAGING_DB_CLIENT_SG_ID']) {
    if (j.gate && !new RegExp(`${v}: \\$\\{\\{ vars\\.${v} \\}\\}`).test(j.gate)) p.push(`gate must map vars.${v}`);
  }
  if (j.gate && !/git merge-base --is-ancestor "\$SHA" origin\/main/.test(j.gate)) p.push('gate must require the commit on main');
  if (!j.flip || !/needs: gate/.test(j.flip)) p.push('flip must need gate');
  if (j.flip) {
    const f = j.flip;
    if (roles(f).join() !== '${{ vars.AWS_STAGING_ROLE_ARN }}') p.push('flip must assume only the staging deploy role');
    const order = ['record', 'flip', 'verify', 'rollback'].map((c) => f.indexOf(`staging-cutover-ecs.sh ${c}`));
    if (order.some((x) => x < 0) || !(order[0] < order[1] && order[1] < order[2] && order[2] < order[3])) p.push('flip job must record, flip, verify, then roll back (in that order)');
    if (!/id: rollback\n {8}if: failure\(\) && steps\.record\.outcome == 'success'\n/.test(f)) p.push('automatic rollback must run on any failure after the record');
    if (!/id: recheck\n {8}if: failure\(\) && steps\.rollback\.outcome == 'success'\n/.test(f)) p.push('the recovery check must run after a rollback');
    if (!/staging-cutover-smoke\.mjs --base "\$STAGING_URL" --out "\$RUNNER_TEMP\/smoke-flipped\.json"/.test(f)) p.push('the STAGING-VERIFY smoke must run after the flip');
    if (!/name: cutover-record/.test(f)) p.push('the record must be uploaded (manual rollback)');
    if (!/ref: \$\{\{ inputs\.commit_sha \}\}/.test(f)) p.push('the flip must run the rehearsed commit');
  }
  if (!/^ {2}STAGING_URL: https:\/\/preview-aws-gateway\.vitanaland\.com$/m.test(y)) p.push('STAGING_URL must be the staging host');
  if (/https:\/\/gateway\.vitanaland\.com/.test(y)) p.push('the cutover workflow must not name the production gateway URL');
  if (!j.recover || !/if: failure\(\) && needs\.flip\.outputs\.recorded == 'success' && needs\.flip\.outputs\.recovered != 'success'/.test(j.recover)) p.push('recover must run only when the rollback did not recover');
  if (j.recover) {
    const dispatched = [...j.recover.matchAll(/gh workflow run (\S+)/g)].map((m) => m[1]).sort();
    if (dispatched.join() !== 'AWS-STAGE-DEPLOY-GATEWAY.yml,AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml') p.push(`recover may dispatch only the two staging deploys, got ${dispatched.join(',')}`);
    if (JSON.stringify(permissions(j.recover, 4)) !== JSON.stringify({ actions: 'write', contents: 'read' })) p.push('recover permissions must be exactly actions: write, contents: read');
    if (/configure-aws-credentials/.test(j.recover)) p.push('recover makes no AWS call');
  }
  if (!j.rollback || !/staging-cutover-ecs\.sh rollback/.test(j.rollback) || !/run-id: \$\{\{ inputs\.record_run_id \}\}/.test(j.rollback)) p.push('manual rollback must restore the record of record_run_id');
  const calls = ecsCalls(y);
  if (calls.some((c) => c.startsWith('candidate-'))) p.push('the cutover must not touch the candidates');
  if (!/^ +- name: Guard \(--enforce\) over the cutover scripts\n +run: node scripts\/ci\/staging-prod-ref-guard\.mjs --enforce/m.test(j.flip || '')) p.push('flip must run the guard first');
  return p;
}

test('AWS-STAGE-CUTOVER-REHEARSAL.yml: dispatch only, owner gate, staging roles only, candidates only, always scaled to 0', () => {
  assert.deepEqual(checkRehearsal(wf('AWS-STAGE-CUTOVER-REHEARSAL.yml')), []);
});
test('AWS-STAGE-CUTOVER.yml: dispatch only, gate, record → flip → verify → smoke → automatic rollback, recover, manual rollback', () => {
  assert.deepEqual(checkCutover(wf('AWS-STAGE-CUTOVER.yml')), []);
});

const R = wf('AWS-STAGE-CUTOVER-REHEARSAL.yml');
const X = wf('AWS-STAGE-CUTOVER.yml');
const mutations = [
  ['rehearsal: a schedule trigger', checkRehearsal, R.replace('  workflow_dispatch:\n', '  schedule:\n    - cron: "0 3 * * *"\n  workflow_dispatch:\n')],
  ['rehearsal: a push trigger', checkRehearsal, R.replace('on:\n', 'on:\n  push:\n    branches: [main]\n')],
  ['rehearsal: cost gate removed', checkRehearsal, R.replace('[ "$COST_APPROVED" = yes ] || ', '')],
  ['rehearsal: main gate removed', checkRehearsal, R.replace('[ "$REF" = refs/heads/main ] || ', '')],
  ['rehearsal: the production role', checkRehearsal, R.replace('role-to-assume: ${{ vars.AWS_STAGING_ROLE_ARN }}', 'role-to-assume: ${{ secrets.AWS_PROD_ROLE_ARN }}')],
  ['rehearsal: static keys', checkRehearsal, R.replace('          aws-region: eu-central-1\n', '          aws-access-key-id: ${{ secrets.AWS_STAGING_ACCESS_KEY_ID }}\n          aws-region: eu-central-1\n')],
  ['rehearsal: a live-service ECS call', checkRehearsal, R.replace('candidate-stop', 'rollback --record x')],
  ['rehearsal: scale-to-0 not always', checkRehearsal, R.replace('        if: always()\n        run: bash scripts/aws/staging-cutover-ecs.sh candidate-stop', '        run: bash scripts/aws/staging-cutover-ecs.sh candidate-stop')],
  ['rehearsal: smoke on the live staging host', checkRehearsal, R.replace('--base "$CANDIDATE_URL"', '--base https://preview-aws-gateway.vitanaland.com')],
  ['rehearsal: run-name changed (gate would never match)', checkRehearsal, R.replace("run-name: 'Staging cutover rehearsal", "run-name: 'Rehearsal")],
  ['rehearsal: secrets job on the deploy role', checkRehearsal, R.replace('role-to-assume: ${{ vars.AWS_STAGING_DB_ROLE_ARN }}', 'role-to-assume: ${{ vars.AWS_STAGING_ROLE_ARN }}')],
  ['rehearsal: wider top-level permissions', checkRehearsal, R.replace('permissions:\n  contents: read\n\nconcurrency', 'permissions:\n  contents: write\n\nconcurrency')],
  ['cutover: a push trigger', checkCutover, X.replace('on:\n', 'on:\n  push:\n    branches: [main]\n')],
  ['cutover: gate script removed', checkCutover, X.replace('node scripts/aws/staging-cutover-gate.mjs', 'echo')],
  ['cutover: PLAN_SPAR_GATEWAY_URL not passed', checkCutover, X.replace('          PLAN_SPAR_GATEWAY_URL: ${{ vars.PLAN_SPAR_GATEWAY_URL }}\n', '')],
  ['cutover: approval not passed', checkCutover, X.replace('          STAGING_CUTOVER_APPROVED: ${{ vars.STAGING_CUTOVER_APPROVED }}\n          PLAN_SPAR', '          PLAN_SPAR')],
  ['cutover: flip without the gate', checkCutover, X.replace("    needs: gate\n    if: inputs.action == 'flip'", "    if: inputs.action == 'flip'")],
  ['cutover: automatic rollback removed', checkCutover, X.replace("        id: rollback\n        if: failure() && steps.record.outcome == 'success'\n", "        id: rollback\n        if: false\n")],
  ['cutover: smoke after flip removed', checkCutover, X.replace('--out "$RUNNER_TEMP/smoke-flipped.json"', '')],
  ['cutover: flip before record', checkCutover, X.replace('bash scripts/aws/staging-cutover-ecs.sh record', 'bash scripts/aws/staging-cutover-ecs.sh describe')],
  ['cutover: the production role', checkCutover, X.replace('role-to-assume: ${{ vars.AWS_STAGING_ROLE_ARN }}', 'role-to-assume: ${{ secrets.AWS_PROD_ROLE_ARN }}')],
  ['cutover: recover dispatches a production deploy', checkCutover, X.replace('gh workflow run AWS-STAGE-DEPLOY-GATEWAY.yml', 'gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml')],
  ['cutover: recover with id-token', checkCutover, X.replace('    permissions:\n      actions: write\n      contents: read\n', '    permissions:\n      actions: write\n      contents: read\n      id-token: write\n')],
  ['cutover: smoke against production', checkCutover, X.replace('  STAGING_URL: https://preview-aws-gateway.vitanaland.com', '  STAGING_URL: https://gateway.vitanaland.com')],
  ['cutover: touches the candidates', checkCutover, X.replace('staging-cutover-ecs.sh verify', 'staging-cutover-ecs.sh candidate-stop; bash scripts/aws/staging-cutover-ecs.sh verify')],
  ['cutover: flip runs main instead of the rehearsed commit', checkCutover, X.replace('          ref: ${{ inputs.commit_sha }}\n', '')],
];
for (const [name, check, text] of mutations) {
  test(`mutation fails: ${name}`, () => {
    assert.notEqual(text, name.startsWith('rehearsal') ? R : X, 'mutation applied');
    assert.ok(check(text).length > 0, 'the check must report the mutation');
  });
}

test('mutation fails: a deploy-workflow edit outside the marked blocks, or a switch without the marker-restore', () => {
  for (const f of [GW, PX]) {
    const y = wf(f);
    const step = stepText(y, ROLL);
    const outside = step.replace('          set -e\n', '          set -e\n          echo extra\n');
    assert.notEqual(stripMarkers(outside), stepText(pinned(f), ROLL));
  }
  // without the `grep -q '"STAGING_DATA_PLANE"'` arm, an isolated live task definition is never restored by a shared deploy
  const noRestore = wf(PX).replace(` || printf '%s' "$NEW_DEF" | grep -q '"STAGING_DATA_PLANE"'`, '');
  const iso = runRoll(wf(PX), PX, { STAGING_DATA_PLANE: 'isolated', STAGING_CUTOVER_APPROVED: 'yes' });
  const back = runRoll(noRestore, PX, {}, iso.registered);
  assert.match(back.registered, /STAGING_DATA_PLANE/, 'the mutant leaves the isolated marker in place');
});
