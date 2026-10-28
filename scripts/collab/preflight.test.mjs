// VTID-05336 — tests for scripts/collab/preflight.mjs (plan pipeline-speed, lane preflight).
// Run: node --test scripts/collab/preflight.test.mjs
// Fixtures follow queue.test.mjs: a bare origin + a clone in tmpdir, identity via env only (no git config writes).
// The fixture carries this repository's own CI scripts (queue.mjs, gate.mjs, lib.mjs), so preflight is proven to spawn
// them rather than to re-implement them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PREFLIGHT = path.join(HERE, 'preflight.mjs');
const S1 = 'kiro-exafy-202610221200-ab12';
const TITLE = 'VTID-00001 (cards/card-01): add a card';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
delete ENV.GITHUB_STEP_SUMMARY;

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim();
}
function write(work, rel, text) {
  mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  writeFileSync(path.join(work, rel), text);
}
function commit(work, msg, trailers = {}) {
  sh(work, 'add', '-A');
  const t = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`).join('\n');
  sh(work, 'commit', '-q', '-m', msg, ...(t ? ['-m', t] : []));
  return sh(work, 'rev-parse', 'HEAD');
}
const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n## Log\n### 2026-10-22 · start\n`;
const lane = (o = {}) => fm({ lane: 'card-01', state: 'ready', next_actor: 'kiro', executor: 'kiro', seat: 'exafy', paths: ['src/**'], vtid: 'VTID-00001', updated: '2026-10-22T10:00Z', ...o });
const SPARRING_OK = '# Plan sparring\nVerdict: CONVERGED\nOwner approval: policy converged-auto-v1\nPlan hash: abc123\n';

/**
 * Base on main: the repo's CI scripts, docs/programs registry, the `cards` spec with lane card-01 `ready`.
 * Head on kiro/cards/card-01: the lane moves to `executing` with the work and its validation folder.
 * `bad` turns on independent errors: `trailer` (a commit without trailers), `seat` (lane seat not in areas.yaml),
 * `hash` (plan-sparring.md without plan hash), `program` (spec slug in no program.md), `scope` (invalid scope.json).
 * VTID-05360: `vc` puts a VALIDATOR-CHECK.yml on the base ('real' = this repository's own workflow with the guard and
 * ruleset it runs, or the text of a test workflow) and an evidence pack on the head; `noOutputs` leaves out `outputs/`.
 */
function fixture(bad = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'preflight-'));
  const origin = path.join(dir, 'origin.git');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const work = path.join(dir, 'work');
  // A file:// URL gives the same repository name ("origin") on every OS (queue.mjs repoNameOf).
  sh(dir, 'clone', '-q', pathToFileURL(origin).href, work);
  sh(work, 'checkout', '-q', '-b', 'main');
  for (const rel of ['scripts/collab/queue.mjs', 'scripts/collab/protected-gate-files.json',
    'scripts/ci/pr-gate/gate.mjs', 'scripts/ci/pr-gate/lib.mjs', 'scripts/ci/pr-gate/config.json']) {
    mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    copyFileSync(path.join(ROOT, rel), path.join(work, rel));
  }
  write(work, 'docs/programs/areas.yaml', `seats:\n  ${bad.seat ? 'other' : 'exafy'}:\n    owner: t\n`);
  write(work, 'docs/programs/core/program.md', fm({ id: 'core', title: 'Core', status: 'active', priority: 1, specs: [bad.program ? 'origin:elsewhere' : 'origin:cards'] }));
  write(work, '.kiro/specs/cards/handoff.md', fm({ slug: 'cards', author: 'kiro', executor: 'kiro', next_actor: 'kiro', state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00001'], updated: '2026-10-22T10:00Z' }));
  write(work, '.kiro/specs/cards/lanes/card-01.md', lane());
  if (bad.vc === 'real') {
    for (const rel of [VC, 'scripts/ci/validator-path-guard.cjs', 'gov/validator-rules.yaml']) {
      mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      copyFileSync(path.join(ROOT, rel), path.join(work, rel));
    }
  } else if (bad.vc) write(work, VC, bad.vc);
  commit(work, 'seed', { 'Collab-Session': 'session_01ABCdef', 'Collab-Lane': 'cards/_plan' });
  sh(work, 'push', '-q', 'origin', 'main');
  sh(work, 'remote', 'set-head', 'origin', 'main');
  sh(work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
  write(work, '.kiro/specs/cards/lanes/card-01.md', lane({ state: 'executing', claimed_by: S1, updated: '2026-10-22T11:00Z' }));
  write(work, 'src/a.js', 'export const a = 1;\n');
  write(work, 'docs/validation/VTID-00001/scope.json', `${JSON.stringify({ vtid: 'VTID-00001', kind: bad.scope ? 'bogus' : 'feature', paths: ['src/**', '.kiro/specs/cards/**'] })}\n`);
  write(work, 'docs/validation/VTID-00001/plan-sparring.md', bad.hash ? SPARRING_OK.replace(/Plan hash.*\n/, '') : SPARRING_OK);
  if (bad.vc) {
    write(work, 'docs/validation/VTID-00001/acceptance.md', 'AC-1: a card exists\nTEST: scripts/collab/preflight.test.mjs\n');
    write(work, 'docs/validation/VTID-00001/commands.log', 'node --test (1 pass)\n');
    if (!bad.noOutputs) write(work, 'docs/validation/VTID-00001/outputs/test.txt', 'ok\n');
  }
  commit(work, 'feat: card', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
  if (bad.trailer) {
    write(work, 'src/b.js', 'export const b = 2;\n');
    commit(work, 'feat: b without trailers');
  }
  sh(work, 'fetch', '-q', 'origin');
  return { dir, work, done: () => rmSync(dir, { recursive: true, force: true }) };
}
function preflight(work, extra = [], env = {}) {
  const r = spawnSync(process.execPath, [PREFLIGHT, '--repo', work, '--base', 'origin/main', '--head', 'HEAD',
    '--branch', 'kiro/cards/card-01', '--title', TITLE, '--no-tests', ...extra], { encoding: 'utf8', env: { ...ENV, ...env } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
function preflightJson(work, extra = [], env = {}) {
  const r = preflight(work, ['--json', ...extra], env);
  return { status: r.status, report: JSON.parse(r.out.slice(r.out.indexOf('{'))) };
}
const failed = (report) => report.checks.filter((c) => c.status === 'fail').map((c) => c.id);

test('clean lane range → every check passes, exit 0', () => {
  const f = fixture();
  try {
    const { status, report } = preflightJson(f.work);
    assert.deepEqual(failed(report), [], JSON.stringify(report, null, 2));
    assert.equal(status, 0);
    assert.equal(report.ok, true);
    for (const id of ['collab-handoff', 'lane-scope', 'pr-gate-scope', 'pr-gate-sparring', 'pr-gate-weakening', 'pr-gate-red-green']) {
      assert.ok(report.checks.some((c) => c.id === id), `check ${id} ran`);
    }
    const label = (id) => report.checks.find((c) => c.id === id).ci;
    assert.equal(label('collab-handoff'), 'required');
    assert.equal(label('lane-scope'), 'required');
    assert.match(label('pr-gate-scope'), /report-only in CI/);
  } finally { f.done(); }
});

test('three independent errors (missing trailer, unknown seat, no plan hash) → all reported in one run, exit 1', () => {
  const f = fixture({ trailer: true, seat: true, hash: true });
  try {
    const { status, out } = preflight(f.work);
    assert.equal(status, 1, out);
    assert.match(out, /needs Collab-Session and Collab-Lane trailers/);
    assert.match(out, /seat "exafy" is not a seat of docs\/programs\/areas\.yaml/);
    assert.match(out, /no plan hash/);
    // Grouped per check with the CI label.
    assert.match(out, /collab handoff.*\[required\]/i);
    assert.match(out, /sparring.*\[report-only in CI/i);
  } finally { f.done(); }
});

test('spec slug listed by no program.md → reported', () => {
  const f = fixture({ program: true });
  try {
    const { status, out } = preflight(f.work);
    assert.equal(status, 1, out);
    assert.match(out, /\.kiro\/specs\/cards: not listed by any docs\/programs\/<id>\/program\.md/);
  } finally { f.done(); }
});

test('invalid scope.json → reported', () => {
  const f = fixture({ scope: true });
  try {
    const { status, report } = preflightJson(f.work);
    assert.equal(status, 1);
    const scope = report.checks.find((c) => c.id === 'pr-gate-scope');
    assert.equal(scope.status, 'fail');
    assert.match(scope.output, /invalid scope\.json/);
    assert.match(scope.output, /kind must be/);
  } finally { f.done(); }
});

test('parity: preflight reports every error queue.mjs validate prints for the same range', () => {
  const f = fixture({ trailer: true, seat: true, program: true });
  try {
    const direct = spawnSync(process.execPath, [path.join(f.work, 'scripts/collab/queue.mjs'), 'validate', '--repo', f.work,
      '--base', 'origin/main', '--head', 'HEAD', '--branch', 'kiro/cards/card-01'], { encoding: 'utf8', env: ENV });
    assert.equal(direct.status, 1);
    const errors = direct.stdout.split(/\r?\n/).filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    assert.ok(errors.length >= 3, direct.stdout);
    const { report } = preflightJson(f.work);
    const mine = report.checks.find((c) => c.id === 'collab-handoff');
    assert.equal(mine.status, 'fail');
    for (const e of errors) assert.ok(mine.output.includes(e), `preflight misses: ${e}`);
  } finally { f.done(); }
});

test('scope-check runs the BASE revision of queue.mjs, validate the HEAD revision', () => {
  const f = fixture();
  try {
    // Break queue.mjs on the lane head only: validate (head copy) fails, Lane scope (base copy) still passes.
    write(f.work, 'scripts/collab/queue.mjs', 'process.stdout.write("head copy ran\\n"); process.exit(1);\n');
    commit(f.work, 'chore: head queue', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    const { report } = preflightJson(f.work);
    const by = (id) => report.checks.find((c) => c.id === id);
    assert.equal(by('collab-handoff').status, 'fail');
    assert.match(by('collab-handoff').output, /head copy ran/);
    assert.doesNotMatch(by('lane-scope').output, /head copy ran/);
  } finally { f.done(); }
});

test('plan-PR lane lookup without gh → reported as not checked, never a silent pass', () => {
  const f = fixture();
  try {
    // A lane file that exists only on the lane head forces Lane scope to look for an open plan( PR through gh.
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-02', 'origin/main');
    write(f.work, '.kiro/specs/cards/lanes/card-02.md', lane({ lane: 'card-02', vtid: 'VTID-00002' }));
    write(f.work, 'src/c.js', 'export const c = 3;\n');
    commit(f.work, 'feat: c', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-02' });
    const r = spawnSync(process.execPath, [PREFLIGHT, '--repo', f.work, '--base', 'origin/main', '--head', 'HEAD',
      '--branch', 'kiro/cards/card-02', '--title', 'VTID-00002 (cards/card-02): c', '--no-tests', '--json'],
    { encoding: 'utf8', env: { ...ENV, PREFLIGHT_GH: path.join(f.dir, 'no-such-gh') } });
    assert.equal(r.status, 1);
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    const gh = report.checks.find((c) => c.id === 'plan-pr-lane');
    assert.equal(gh.status, 'fail');
    assert.match(gh.output, /plan-PR lane not checked/);
  } finally { f.done(); }
});

test('no --title → the PR-GATE part is reported as not checked', () => {
  const f = fixture();
  try {
    const r = spawnSync(process.execPath, [PREFLIGHT, '--repo', f.work, '--base', 'origin/main', '--head', 'HEAD',
      '--branch', 'kiro/cards/card-01', '--no-tests', '--json'], { encoding: 'utf8', env: ENV });
    assert.equal(r.status, 1);
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    assert.match(report.checks.find((c) => c.id === 'title').output, /no --title/);
  } finally { f.done(); }
});

test('preflight writes nothing outside its temp dir (fixture tree and refs unchanged)', () => {
  const f = fixture();
  try {
    const before = [sh(f.work, 'status', '--porcelain'), sh(f.work, 'for-each-ref'), sh(f.work, 'worktree', 'list', '--porcelain')];
    preflight(f.work);
    assert.deepEqual([sh(f.work, 'status', '--porcelain'), sh(f.work, 'for-each-ref'), sh(f.work, 'worktree', 'list', '--porcelain')], before);
  } finally { f.done(); }
});

// ── Runbooks: every push point runs preflight first (plan P3) ──
/** Items of a markdown runbook: a heading, a list item (with its continuation lines) or a paragraph. */
function items(md) {
  const out = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim()) { cur = null; continue; }
    if (/^\s*(?:#|- |\d+\. )/.test(line) || !cur) { cur = { text: line }; out.push(cur); } else cur.text += ` ${line.trim()}`;
  }
  return out.map((i) => i.text);
}
const PUSH = /\bpush(?:es|ed|ing)?\b/i;
// Deleting a ref (`git push origin --delete …`, the driver's heartbeat) pushes no work, so it is no push point.
const REF_DELETE = /git push origin --delete/g;
function pushPointsWithoutPreflight(md) {
  return items(md).filter((t) => {
    const s = t.replace(REF_DELETE, '');
    const m = PUSH.exec(s);
    if (!m) return false;
    const pre = s.toLowerCase().indexOf('preflight');
    return pre === -1 || pre > m.index;
  });
}
function section(md, heading) {
  const start = md.indexOf(heading);
  assert.ok(start >= 0, `section ${heading}`);
  const next = md.indexOf('\n## ', start + heading.length);
  return md.slice(start, next === -1 ? undefined : next);
}
const runbook = (name) => readFileSync(path.join(ROOT, '.kiro/pipeline', name), 'utf8');

test('lane-code.md names preflight.mjs and runs it before every push', () => {
  const md = runbook('lane-code.md');
  assert.match(md, /scripts\/collab\/preflight\.mjs/);
  assert.deepEqual(pushPointsWithoutPreflight(md), []);
});

test('planning.md names preflight.mjs and runs it before every push (§3, §4, §5)', () => {
  const md = runbook('planning.md');
  assert.match(md, /scripts\/collab\/preflight\.mjs/);
  assert.deepEqual(pushPointsWithoutPreflight(md), []);
  for (const h of ['## 3.', '## 4.', '## 5.']) assert.match(section(md, h), /preflight/, h);
});

test('driver.md runs preflight before every push of the loop', () => {
  const md = runbook('driver.md');
  assert.match(md, /scripts\/collab\/preflight\.mjs/);
  assert.deepEqual(pushPointsWithoutPreflight(section(md, '## Loop')), []);
});

test('the runbook text check catches a push point without preflight', () => {
  assert.equal(pushPointsWithoutPreflight('- commit, push (protocol)\n- run preflight, fix every error, then push\n').length, 1);
  assert.ok(existsSync(path.join(ROOT, '.kiro/pipeline/lane-code.md')));
});

// ── VALIDATOR-CHECK (VTID-05360, plan kiro-web-reliability §3.1) ──
const VC = '.github/workflows/VALIDATOR-CHECK.yml';
const BODY_OK = ['VALIDATION_PROFILE: gateway_backend', 'SCOPE_ALLOWLIST: src/**, docs/validation/**',
  'ACCEPTANCE: docs/validation/VTID-00001/acceptance.md', 'MERGE_PAYLOAD_PREVIEW: none (deploys nothing)', 'OASIS_IMPACT: no', ''].join('\n');
/** A test workflow: `paths` of on.pull_request and the steps of job validate-pr after a Checkout step. */
function workflow(steps, paths = ["'docs/validation/**'"]) {
  return ['name: VALIDATOR-CHECK', 'on:', '  pull_request:', '    paths:', ...paths.map((p) => `      - ${p}`),
    'jobs:', '  validate-pr:', '    runs-on: ubuntu-latest', '    steps:', '      - name: Checkout', '        uses: actions/checkout@v4',
    ...steps.map(({ name, id, env, run, shell }) => [`      - name: ${name}`, ...(id ? [`        id: ${id}`] : []),
      ...(shell ? [`        shell: ${shell}`] : []),
      ...(env ? ['        env:', ...Object.entries(env).map(([k, v]) => `          ${k}: ${v}`)] : []),
      '        run: |', ...run.split('\n').map((l) => (l ? `          ${l}` : ''))].join('\n')), ''].join('\n');
}
function bodyFile(f, text, name = 'body.md') {
  const file = path.join(f.dir, name);
  writeFileSync(file, text);
  return file;
}
const vcCheck = (report) => report.checks.find((c) => c.id === 'validator-check');

test('VALIDATOR-CHECK: PR body missing a declaration → fails with the --pr-body-check message naming it', () => {
  const f = fixture({ vc: 'real' });
  try {
    const { status, report } = preflightJson(f.work, ['--body-file', bodyFile(f, BODY_OK.replace(/OASIS_IMPACT.*\n/, ''))]);
    assert.equal(status, 1);
    const vc = vcCheck(report);
    assert.equal(vc.status, 'fail', JSON.stringify(vc));
    assert.equal(vc.ci, 'required');
    assert.match(vc.output, /REJECTED: PR body is missing 1 required declaration\(s\): OASIS_IMPACT/);
  } finally { f.done(); }
});

test('VALIDATOR-CHECK: evidence dir without outputs/ → fails "missing …/outputs/"', () => {
  const f = fixture({ vc: 'real', noOutputs: true });
  try {
    const { status, report } = preflightJson(f.work, ['--body-file', bodyFile(f, BODY_OK)]);
    assert.equal(status, 1);
    assert.equal(vcCheck(report).status, 'fail');
    assert.match(vcCheck(report).output, /REJECTED: missing docs\/validation\/VTID-00001\/outputs\//);
  } finally { f.done(); }
});

test('VALIDATOR-CHECK: declarations and evidence complete → passes; Build Gate is reported as not run', () => {
  const f = fixture({ vc: 'real' });
  try {
    const { status, report } = preflightJson(f.work, ['--body-file', bodyFile(f, BODY_OK)]);
    assert.deepEqual(failed(report), [], JSON.stringify(report, null, 2));
    assert.equal(status, 0);
    const vc = vcCheck(report);
    assert.equal(vc.status, 'pass');
    assert.match(vc.output, /Merge Deploy Gate/);
    assert.doesNotMatch(vc.output, /npm ci/);
    const nc = report.checks.find((c) => c.id === 'not-covered-validator');
    assert.ok(nc, 'a not-covered entry for the Build Gate');
    assert.match(nc.output, /Not run by preflight: VALIDATOR-CHECK Build Gate \(`npm run build`/);
    assert.match(nc.output, /command_hub_frontend/);
  } finally { f.done(); }
});

test('VALIDATOR-CHECK: no changed file in the workflow paths (read from the file) → skip', () => {
  const f = fixture({ vc: workflow([{ name: 'Never', run: 'echo "REJECTED: ran"; exit 3' }], ["'services/gateway/src/**'"]) });
  try {
    const { report } = preflightJson(f.work);
    const vc = vcCheck(report);
    assert.equal(vc.status, 'skip');
    assert.match(vc.output, /not in VALIDATOR-CHECK's paths/);
    assert.ok(!report.checks.some((c) => c.id === 'not-covered-validator'));
  } finally { f.done(); }
});

const COLLECT = [
  { name: 'Collect PR text', env: { PR_BODY: '${{ github.event.pull_request.body }}' }, run: 'printf "%s" "$PR_BODY" > /tmp/pr_body.txt' },
  { name: 'Body marker', run: 'grep -q "OASIS_IMPACT: no" /tmp/pr_body.txt || (echo "REJECTED: no marker" && exit 15)' },
];
test('VALIDATOR-CHECK: without --body-file the open PR body is read through gh; no body at all → fails naming PR_BODY_FILE', () => {
  const f = fixture({ vc: workflow(COLLECT) });
  try {
    sh(f.work, 'remote', 'set-url', 'origin', 'https://github.com/exafyltd/fixture.git');
    const log = path.join(f.dir, 'gh.log');
    const gh = path.join(f.dir, 'gh');
    writeFileSync(gh, `#!/bin/sh\necho "$@" >> '${log}'\nprintf 'Body\\nOASIS_IMPACT: no\\n'\n`);
    chmodSync(gh, 0o755);
    const { report } = preflightJson(f.work, [], { PREFLIGHT_GH: gh });
    assert.equal(vcCheck(report).status, 'pass', JSON.stringify(vcCheck(report)));
    assert.match(readFileSync(log, 'utf8'), /repos\/exafyltd\/fixture\/pulls\?head=exafyltd:kiro\/cards\/card-01&state=open/);

    const none = preflightJson(f.work, [], { PREFLIGHT_GH: path.join(f.dir, 'no-such-gh') }).report;
    assert.equal(vcCheck(none).status, 'fail');
    assert.match(vcCheck(none).output, /no --body-file: VALIDATOR-CHECK reads the declarations from the PR body; on a first push pass PR_BODY_FILE=<file>/);
  } finally { f.done(); }
});

test('VALIDATOR-CHECK: `shell: bash` → a failing stage inside a pipeline fails the step (bash -eo pipefail)', () => {
  const f = fixture({ vc: workflow([{ name: 'Pipe', shell: 'bash', run: 'false | cat\necho "after the pipe"' }]) });
  try {
    const vc = vcCheck(preflightJson(f.work, ['--body-file', bodyFile(f, BODY_OK)]).report);
    assert.equal(vc.status, 'fail');
    assert.match(vc.output, /Pipe/);
    assert.doesNotMatch(vc.output, /after the pipe/);
  } finally { f.done(); }
});

test('VALIDATOR-CHECK: a step without `shell:` runs in `bash -e` as on GitHub (a failing command fails, a pipe stage does not)', () => {
  const f = fixture({ vc: workflow([
    { name: 'Pipe', run: 'X="$(false | cat)"\necho "after the pipe"' },
    { name: 'Errexit', run: 'false\necho "after false"' },
  ]) });
  try {
    const vc = vcCheck(preflightJson(f.work, ['--body-file', bodyFile(f, BODY_OK)]).report);
    assert.equal(vc.status, 'fail');
    assert.match(vc.output, /after the pipe/);
    assert.match(vc.output, /step "Errexit" failed/);
    assert.doesNotMatch(vc.output, /after false/);
  } finally { f.done(); }
});

test('VALIDATOR-CHECK: the workflow is read from the head revision', () => {
  const f = fixture({ vc: workflow([{ name: 'Base step', run: 'echo "base copy ran"' }]) });
  try {
    write(f.work, VC, workflow([{ name: 'Head step', run: 'echo "REJECTED: head copy ran"; exit 7' }]));
    commit(f.work, 'chore: head workflow', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    const vc = vcCheck(preflightJson(f.work, ['--body-file', bodyFile(f, BODY_OK)]).report);
    assert.equal(vc.status, 'fail');
    assert.match(vc.output, /head copy ran/);
    assert.doesNotMatch(vc.output, /base copy ran/);
  } finally { f.done(); }
});

function preflightAsync(work, extra) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [PREFLIGHT, '--repo', work, '--base', 'origin/main', '--head', 'HEAD',
      '--branch', 'kiro/cards/card-01', '--no-tests', '--json', ...extra], { env: ENV });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(JSON.parse(out.slice(out.indexOf('{')))));
  });
}
test('VALIDATOR-CHECK: /tmp/ paths are rewritten to the preflight temp dir (two parallel runs do not collide)', async () => {
  const probe = `/tmp/vc-probe-${process.pid}-${Date.now()}.txt`;
  const f = fixture({ vc: workflow([
    { name: 'Write', env: { T: '${{ github.event.pull_request.title }}' }, run: `printf "%s" "$T" > ${probe}\nsleep 1` },
    { name: 'Read', env: { T: '${{ github.event.pull_request.title }}' }, run: `test "$(cat ${probe})" = "$T" || (echo "REJECTED: collided" && exit 9)` },
  ]) });
  try {
    const body = bodyFile(f, BODY_OK);
    const [a, b] = await Promise.all([preflightAsync(f.work, ['--title', TITLE, '--body-file', body]),
      preflightAsync(f.work, ['--title', `${TITLE} (second run)`, '--body-file', body])]);
    assert.equal(vcCheck(a).status, 'pass', JSON.stringify(vcCheck(a)));
    assert.equal(vcCheck(b).status, 'pass', JSON.stringify(vcCheck(b)));
    assert.ok(!existsSync(probe), `${probe} must not be written`);
  } finally { f.done(); }
});

test('VALIDATOR-CHECK: ${{ github.base_ref }} and ${{ steps.<id>.outputs.<K> }} are substituted', () => {
  const f = fixture({ vc: workflow([
    { name: 'Meta', id: 'meta', run: 'echo "VTID=VTID-00001" >> $GITHUB_OUTPUT\necho "NOTE<<EOF" >> $GITHUB_OUTPUT\necho "two" >> $GITHUB_OUTPUT\necho "lines" >> $GITHUB_OUTPUT\necho "EOF" >> $GITHUB_OUTPUT' },
    { name: 'Use', env: { VTID: '${{ steps.meta.outputs.VTID }}', NOTE: '${{ steps.meta.outputs.NOTE }}' },
      run: 'BASE="${{ github.base_ref }}"\necho "base=$BASE vtid=$VTID"\ntest "$BASE" = main && test "$VTID" = VTID-00001 && test "$NOTE" = "$(printf \'two\\nlines\')" || (echo "REJECTED: substitution" && exit 4)' },
  ]) });
  try {
    const vc = vcCheck(preflightJson(f.work, ['--body-file', bodyFile(f, BODY_OK)]).report);
    assert.equal(vc.status, 'pass', JSON.stringify(vc));
    assert.match(vc.output, /base=main vtid=VTID-00001/);
  } finally { f.done(); }
});

test('VALIDATOR-CHECK: an unsupported ${{ }} expression or an unparsable workflow fails loudly', () => {
  const f = fixture({ vc: workflow([{ name: 'Secret', env: { T: '${{ secrets.TOKEN }}' }, run: 'echo "$T"' }]) });
  try {
    const vc = vcCheck(preflightJson(f.work, ['--body-file', bodyFile(f, BODY_OK)]).report);
    assert.equal(vc.status, 'fail');
    assert.match(vc.output, /unsupported expression \$\{\{ secrets\.TOKEN \}\}/);
    write(f.work, VC, 'on:\n  pull_request:\n    paths:\n      - docs/validation/**\njobs:\n  validate-pr:\n    steps:\n      - name: A\n     bad: indent\n');
    commit(f.work, 'chore: broken workflow', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    const broken = vcCheck(preflightJson(f.work, ['--body-file', bodyFile(f, BODY_OK)]).report);
    assert.equal(broken.status, 'fail');
    assert.match(broken.output, /cannot parse \.github\/workflows\/VALIDATOR-CHECK\.yml/);
  } finally { f.done(); }
});
