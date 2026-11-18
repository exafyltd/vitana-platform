// Tests of the GitLab governance job wrappers (plan agentic-delivery §3.4 and §4, lane merge-queue):
// scripts/eng/gitlab-gates.mjs. The `lane-scope` and `collab-handoff` jobs call queue.mjs `scopeCheck` and
// `validateRange` unchanged, with fetchers over a local clone of the vitana-platform project instead of the GitHub API.
// Real temporary git repositories play the platform project and a vitana-v1 project. Dependency-free Node (node:test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gates from './gitlab-gates.mjs';
import { scopeCheck, validateRange, planLaneQualifies } from '../collab/queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = path.resolve(HERE, '..', 'collab', 'queue.mjs');
const GATES = path.join(HERE, 'gitlab-gates.mjs');
const GIT_ENV = {
  ...process.env, GIT_AUTHOR_NAME: 'kiro-agent[bot]', GIT_AUTHOR_EMAIL: 'k@test', GIT_COMMITTER_NAME: 'kiro-agent[bot]', GIT_COMMITTER_EMAIL: 'k@test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
delete GIT_ENV.GITHUB_REPOSITORY; // queue.mjs would otherwise ask gh for plan PRs
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const BUILDER = 'kiro-exafy-202611051000-aaaa';
const laneText = (lane, { paths = ['src/**'], repos = '[exafyltd/vitana-v1]', claimedBy = BUILDER, vtid = 'VTID-05999', state = 'executing' } = {}) => [
  '---', `lane: ${lane}`, `state: ${state}`, 'next_actor: kiro', 'depends_on: []', 'executor: kiro', 'seat: exafy',
  'reviewer_seat: agent:vitana-lane-reviewer', 'reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)', `repos: ${repos}`,
  'paths:', ...paths.map((p) => `  - ${p}`), 'updated: 2026-11-05T10:00Z', `vtid: ${vtid}`, ...(claimedBy ? [`claimed_by: ${claimedBy}`] : []), '---',
  `# Lane ${lane}`, '', '## Log', `### 2026-11-05T09:00Z · ${BUILDER} · ready → executing`, 'Claimed.', '',
].join('\n');
const handoffText = (state, vtids) => ['---', 'slug: demo', 'author: kiro', 'author_seat: exafy', 'executor: kiro', 'next_actor: kiro', `state: ${state}`,
  'updated: 2026-11-05T09:00Z', 'sparring_record: .kiro/specs/demo/sparring/verdict.md', `vtids: [${vtids.join(', ')}]`, '---', '# Handoff', '', '## Log', ''].join('\n');

function project(root, name) {
  const remote = path.join(root, `${name}.git`);
  const work = path.join(root, name);
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { env: GIT_ENV });
  execFileSync('git', ['clone', '-q', remote, work], { env: GIT_ENV, stdio: 'ignore' });
  g(work, 'checkout', '-q', '-b', 'main');
  write(work, 'README.md', `${name}\n`);
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'initial');
  g(work, 'push', '-q', 'origin', 'main');
  return { remote, work };
}
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlab-gates-'));
  tmpDirs.push(root);
  const platform = project(root, 'vitana-platform');
  const v1 = project(root, 'vitana-v1');
  write(platform.work, '.kiro/specs/demo/handoff.md', handoffText('executing', ['VTID-05999', 'VTID-05998']));
  write(platform.work, '.kiro/specs/demo/lanes/web-a.md', laneText('web-a'));
  write(platform.work, '.kiro/specs/demo/lanes/lane-p.md', laneText('lane-p', { paths: ['scripts/demo/**'], repos: '[exafyltd/vitana-platform]', vtid: 'VTID-05998' }));
  g(platform.work, 'add', '-A');
  g(platform.work, 'commit', '-q', '-m', 'plan demo\n\nCollab-Session: ci-plan-spar\nCollab-Lane: demo/_plan');
  g(platform.work, 'push', '-q', 'origin', 'main');
  return { root, platform, v1, platformDir: path.join(root, 'platform-clone.git') };
}
/** A lane branch with one commit changing `files`; returns { base, head, branch }. */
function laneBranch(repo, { key, files, session = BUILDER, extraTrailers = '' }) {
  const branch = `kiro/${key}`;
  g(repo, 'checkout', '-q', '-B', branch, 'main');
  for (const [f, t] of Object.entries(files)) write(repo, f, t);
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', `VTID-05999 (${key}): work\n\nCollab-Session: ${session}\nCollab-Lane: ${key}${extraTrailers}`);
  return { base: g(repo, 'rev-parse', 'main'), head: g(repo, 'rev-parse', 'HEAD'), branch };
}
const fromPlatformMain = (w) => (p) => { try { return execFileSync('git', ['-C', w.platform.work, 'show', `main:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; } };
const prepared = (w) => gates.preparePlatform({ dir: w.platformDir, url: w.platform.remote });
const cli = (args, env = {}) => spawnSync(process.execPath, [GATES, ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...env } });

// ── vitana-v1 merge requests: the lane file lives in the platform project ───────
test('lane-scope for a vitana-v1 merge request gives the verdict of scopeCheck with the platform lane file', () => {
  const w = world();
  const r = laneBranch(w.v1.work, { key: 'demo/web-a', files: { 'src/web-a.ts': 'export const a = 1;\n' } });
  const platformRepo = prepared(w);
  const wrapped = gates.laneScope(w.v1.work, { ...r, platformRepo });
  const direct = scopeCheck(w.v1.work, { ...r, fetchLane: fromPlatformMain(w), fetchPlanLane: () => null });
  assert.deepEqual(wrapped, direct);
  assert.equal(wrapped.applies, true);
  assert.deepEqual(wrapped.errors, []);
  assert.equal(wrapped.source, 'vitana-platform');
  assert.equal(wrapped.trusted, 'vitana-platform');
});

test('lane-scope refuses a file outside the lane\'s paths exactly as scopeCheck does', () => {
  const w = world();
  const r = laneBranch(w.v1.work, { key: 'demo/web-a', files: { 'src/web-a.ts': 'x\n', 'supabase/functions/evil/index.ts': 'y\n' } });
  const platformRepo = prepared(w);
  const wrapped = gates.laneScope(w.v1.work, { ...r, platformRepo });
  const direct = scopeCheck(w.v1.work, { ...r, fetchLane: fromPlatformMain(w), fetchPlanLane: () => null });
  assert.deepEqual(wrapped, direct);
  assert.equal(wrapped.errors.length, 1);
  assert.match(wrapped.errors[0], /supabase\/functions\/evil\/index\.ts is outside lane demo\/web-a/);
});

test('collab-handoff for a vitana-v1 merge request gives the verdict of validateRange with the platform lane file', () => {
  const w = world();
  const platformRepo = prepared(w);
  const ok = laneBranch(w.v1.work, { key: 'demo/web-a', files: { 'src/web-a.ts': 'x\n' } });
  const a = gates.collabHandoff(w.v1.work, { ...ok, platformRepo });
  const b = validateRange(w.v1.work, { ...ok, fetchLane: fromPlatformMain(w), fetchPlanLane: () => null });
  assert.deepEqual(a.errors, b.errors);
  assert.deepEqual(a.warnings, b.warnings);
  assert.deepEqual(a.errors, []);
  const other = laneBranch(w.v1.work, { key: 'demo/web-a', files: { 'src/web-a.ts': 'y\n' }, session: 'kiro-exafy-202611051001-bbbb' });
  const c = gates.collabHandoff(w.v1.work, { ...other, platformRepo });
  const d = validateRange(w.v1.work, { ...other, fetchLane: fromPlatformMain(w), fetchPlanLane: () => null });
  assert.deepEqual(c.errors, d.errors);
  assert.ok(c.errors.some((e) => /claimed_by is kiro-exafy-202611051000-aaaa but the commits come from kiro-exafy-202611051001-bbbb/.test(e)), c.errors.join('\n'));
});

// ── vitana-platform merge requests: the same verdicts as the queue.mjs command line ─
test('in the platform project lane-scope and collab-handoff give the verdicts of `queue.mjs scope-check` and `queue.mjs validate`', () => {
  const w = world();
  const platformRepo = prepared(w);
  for (const files of [{ 'scripts/demo/x.mjs': 'export const x = 1;\n' }, { 'scripts/demo/x.mjs': 'x\n', 'services/gateway/src/index.ts': 'y\n' }]) {
    const r = laneBranch(w.platform.work, { key: 'demo/lane-p', files });
    const scope = gates.laneScope(w.platform.work, { ...r, platformRepo });
    const scopeCli = spawnSync(process.execPath, [QUEUE, 'scope-check', '--repo', w.platform.work, '--base', r.base, '--head', r.head, '--branch', r.branch], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(scope.errors.length ? 1 : 0, scopeCli.status, scopeCli.stdout + scopeCli.stderr);
    assert.equal(gates.scopeStatus(scope), scopeCli.stdout.trim());
    const handoff = gates.collabHandoff(w.platform.work, { ...r, platformRepo });
    const validateCli = spawnSync(process.execPath, [QUEUE, 'validate', '--repo', w.platform.work, '--base', r.base, '--head', r.head, '--branch', r.branch], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(handoff.errors.length ? 1 : 0, validateCli.status, validateCli.stdout + validateCli.stderr);
    for (const e of handoff.errors) assert.ok(validateCli.stdout.includes(e), `${e} is reported by queue.mjs validate too`);
  }
});

test('a lane that exists only in an approved plan( branch of the platform project is read as the plan-PR source', () => {
  const w = world();
  g(w.platform.work, 'checkout', '-q', '-b', 'kiro/demo2/plan', 'main');
  write(w.platform.work, '.kiro/specs/demo2/handoff.md', handoffText('approved', ['VTID-05997']).replace('slug: demo', 'slug: demo2'));
  write(w.platform.work, '.kiro/specs/demo2/lanes/web-c.md', laneText('web-c', { vtid: 'VTID-05997', claimedBy: '' }));
  g(w.platform.work, 'add', '-A');
  g(w.platform.work, 'commit', '-q', '-m', 'plan demo2\n\nCollab-Session: ci-plan-spar\nCollab-Lane: demo2/_plan');
  g(w.platform.work, 'push', '-q', 'origin', 'kiro/demo2/plan');
  const platformRepo = prepared(w);
  const { fetchPlanLane, fetchLane } = gates.platformFetchers(platformRepo);
  const plan = fetchPlanLane('demo2', '.kiro/specs/demo2/lanes/web-c.md');
  assert.equal(plan.lastSession, 'ci-plan-spar');
  assert.equal(planLaneQualifies(plan), true);
  assert.equal(fetchLane('.kiro/specs/demo2/lanes/web-c.md'), null, 'not on platform main');
  assert.equal(fetchPlanLane('nope', '.kiro/specs/nope/lanes/x.md'), null);
  const r = laneBranch(w.v1.work, { key: 'demo2/web-c', files: { 'src/web-c.ts': 'x\n' } });
  const wrapped = gates.laneScope(w.v1.work, { ...r, platformRepo });
  assert.equal(wrapped.source, 'plan-pr');
  assert.equal(wrapped.trusted, 'plan-pr');
  assert.deepEqual(wrapped, scopeCheck(w.v1.work, { ...r, fetchLane, fetchPlanLane }));
});

// ── the command line ─────────────────────────────────────────────────────────
test('the jobs read the GitLab CI variables and print the queue.mjs status line', () => {
  const w = world();
  const r = laneBranch(w.v1.work, { key: 'demo/web-a', files: { 'src/web-a.ts': 'x\n' } });
  const env = { CI_PROJECT_DIR: w.v1.work, CI_MERGE_REQUEST_DIFF_BASE_SHA: r.base, CI_COMMIT_SHA: r.head, CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: r.branch };
  const scope = cli(['lane-scope', '--platform-url', w.platform.remote, '--platform-dir', w.platformDir], env);
  assert.equal(scope.status, 0, scope.stdout + scope.stderr);
  assert.match(scope.stdout, /✅ \*\*lane scope\*\* — lane demo\/web-a: every change is inside its paths/);
  const handoff = cli(['collab-handoff', '--platform-url', w.platform.remote, '--platform-dir', w.platformDir], env);
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr);
  assert.match(handoff.stdout, /✅ \*\*collab handoff\*\*/);
  const bad = laneBranch(w.v1.work, { key: 'demo/web-a', files: { 'migrations/x.sql': 'y\n' } });
  const refused = cli(['lane-scope', '--repo', w.v1.work, '--base', bad.base, '--head', bad.head, '--branch', bad.branch, '--platform-url', w.platform.remote, '--platform-dir', w.platformDir]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /❌ \*\*lane scope\*\* — 1 problem\(s\) \(lane demo\/web-a\)/);
});

test('an unreachable platform project fails closed: exit 3 for both jobs, nothing passes', () => {
  const w = world();
  const r = laneBranch(w.v1.work, { key: 'demo/web-a', files: { 'src/web-a.ts': 'x\n' } });
  for (const job of ['lane-scope', 'collab-handoff']) {
    const out = cli([job, '--repo', w.v1.work, '--base', r.base, '--head', r.head, '--branch', r.branch, '--platform-url', path.join(w.root, 'missing.git'), '--platform-dir', path.join(w.root, 'clone.git')]);
    assert.equal(out.status, 3, `${job}: ${out.stdout}${out.stderr}`);
    assert.match(out.stdout + out.stderr, /vitana-platform.*unreachable.*fails closed/i);
    assert.doesNotMatch(out.stdout, /✅/);
  }
  assert.throws(() => gates.preparePlatform({ dir: path.join(w.root, 'c2.git'), url: path.join(w.root, 'missing.git') }), /unreachable/);
});

test('usage errors exit 2; the job token reaches git only through an askpass script, never a command line or the script text', () => {
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['frob']).status, 2);
  assert.equal(cli(['lane-scope', '--repo']).status, 2);
  const w = world();
  const env = gates.askpassEnv({ dir: path.join(w.root, 'askpass'), token: 'job-token-0123456789' });
  const script = env.GIT_ASKPASS;
  assert.equal(fs.readFileSync(script, 'utf8').includes('job-token-0123456789'), false);
  assert.equal(fs.statSync(script).mode & 0o077, 0);
  const ask = (prompt) => execFileSync(script, [prompt], { encoding: 'utf8', env: { ...env, PATH: process.env.PATH } }).trim();
  assert.equal(ask("Username for 'https://gitlab.test': "), 'gitlab-ci-token');
  assert.equal(ask("Password for 'https://gitlab-ci-token@gitlab.test': "), 'job-token-0123456789');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});
