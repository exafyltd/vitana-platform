// Tests of the assist trigger (plan agentic-delivery §3.9, lane merge-queue): scripts/eng/assist-trigger.mjs.
// The merge bot creates the protected ref `assist/<iid>-<rule>` at `main` and starts a pipeline on it with the merge
// request's id and head, once per head and rule, never after an accept and never for a protected-file merge request.
// The git side is a real bare repository (a pre-receive hook records the push options); the GitLab API is the recording
// fake fetch of lane gitlab-client. Dependency-free Node (node:test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeFetch } from './testing/fake-fetch.mjs';
import { createClient } from './gitlab-api.mjs';
import * as assist from './assist-trigger.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@test', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@test', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const P = '/api/v4/projects/vitana%2Fvitana-v1';
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const RULES = [{ rule: 'i18n-propagate', paths: ['src/i18n/de/**'] }, { rule: 'whats-new', paths: ['src/whats-new/entries/**'] }];

// ── pure ─────────────────────────────────────────────────────────────────────
test('assistRef and the rule names: assist/<iid>-<rule>, a rule id is a plain lowercase name', () => {
  assert.equal(assist.assistRef(7, 'i18n-propagate'), 'assist/7-i18n-propagate');
  assert.throws(() => assist.assistRef(7, 'Bad Rule'), /rule/);
  assert.throws(() => assist.assistRef('7', 'x'), /iid/);
  assert.throws(() => assist.assistRef(7, '../main'), /rule/);
});

test('matchingRules: a rule applies when the merge request changes one of its paths', () => {
  assert.deepEqual(assist.matchingRules(['src/i18n/de/admin.json', 'src/x.ts'], RULES).map((r) => r.rule), ['i18n-propagate']);
  assert.deepEqual(assist.matchingRules(['src/i18n/en/admin.json'], RULES), [], 'only the German source starts the propagation');
  assert.deepEqual(assist.matchingRules(['src/i18n/de/a.json', 'src/whats-new/entries/x.json'], RULES).map((r) => r.rule), ['i18n-propagate', 'whats-new']);
  assert.deepEqual(assist.matchingRules([], RULES), []);
});

test('assistActions: one trigger per head and rule; a run for this head is pending, done or failed; a new head triggers again', () => {
  const files = ['src/i18n/de/admin.json'];
  const none = assist.assistActions({ head: HEAD, files, rules: RULES, runs: {} });
  assert.deepEqual(none.trigger, ['i18n-propagate']);
  assert.equal(none.state, 'trigger');
  const running = assist.assistActions({ head: HEAD, files, rules: RULES, runs: { 'i18n-propagate': { head: HEAD, status: 'running' } } });
  assert.deepEqual(running.trigger, [], 'not a second time for the same head and rule');
  assert.equal(running.state, 'pending');
  assert.equal(assist.assistActions({ head: HEAD, files, rules: RULES, runs: { 'i18n-propagate': { head: HEAD, status: 'created' } } }).state, 'pending');
  assert.equal(assist.assistActions({ head: HEAD, files, rules: RULES, runs: { 'i18n-propagate': { head: HEAD, status: 'success' } } }).state, 'done');
  assert.equal(assist.assistActions({ head: HEAD, files, rules: RULES, runs: { 'i18n-propagate': { head: HEAD, status: 'failed' } } }).state, 'failed');
  assert.equal(assist.assistActions({ head: HEAD, files, rules: RULES, runs: { 'i18n-propagate': { head: HEAD, status: 'canceled' } } }).state, 'failed');
  const moved = assist.assistActions({ head: HEAD2, files, rules: RULES, runs: { 'i18n-propagate': { head: HEAD, status: 'success' } } });
  assert.deepEqual(moved.trigger, ['i18n-propagate'], 'a new head is a new trigger');
  assert.equal(assist.assistActions({ head: HEAD, files: ['src/x.ts'], rules: RULES, runs: {} }).state, 'none', 'no rule applies');
});

test('assistActions: never after an accept, never for a protected-file merge request', () => {
  const files = ['src/i18n/de/admin.json'];
  const accepted = assist.assistActions({ head: HEAD, files, rules: RULES, runs: {}, accepted: true });
  assert.deepEqual(accepted.trigger, []);
  assert.equal(accepted.state, 'none');
  assert.match(accepted.reason, /accept/);
  const prot = assist.assistActions({ head: HEAD, files: [...files, 'CLAUDE.md'], rules: RULES, runs: {}, protectedFiles: ['CLAUDE.md'] });
  assert.deepEqual(prot.trigger, []);
  assert.equal(prot.state, 'none');
  assert.match(prot.reason, /protected/);
  const acceptedWhileRunning = assist.assistActions({ head: HEAD, files, rules: RULES, runs: { 'i18n-propagate': { head: HEAD, status: 'running' } }, accepted: true });
  assert.equal(acceptedWhileRunning.state, 'pending', 'an assist already started for this head is still waited for');
});

test('loadAssistRules reads the assist rules of a project from the service list; no file is no rules; a bad file fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-rules-')); tmpDirs.push(dir);
  const file = path.join(dir, 'services.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: 'vitana.delivery-services/v1',
    repositories: {
      'vitana-v1': { services: [{ id: 'community-app', paths: ['src/**'], assist: [{ rule: 'i18n-propagate', paths: ['src/i18n/de/**'], tool: 'scripts/translate-keys.mjs' }] }, { id: 'mobile', paths: ['apps/mobile/**'] }] },
      'vitana-platform': { services: [{ id: 'gateway', paths: ['services/gateway/**'] }] },
    },
  }));
  assert.deepEqual(assist.loadAssistRules(file, 'vitana-v1'), [{ rule: 'i18n-propagate', paths: ['src/i18n/de/**'] }]);
  assert.deepEqual(assist.loadAssistRules(file, 'vitana-platform'), []);
  assert.deepEqual(assist.loadAssistRules(file, 'rehearsal'), []);
  assert.deepEqual(assist.loadAssistRules(path.join(dir, 'absent.json'), 'vitana-v1'), []);
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => assist.loadAssistRules(file, 'vitana-v1'), /services/);
  fs.writeFileSync(file, JSON.stringify({ repositories: { 'vitana-v1': { services: [{ id: 'x', assist: [{ rule: 'Bad Rule', paths: ['a'] }] }] } } }));
  assert.throws(() => assist.loadAssistRules(file, 'vitana-v1'), /rule/);
});

// ── with git and the fake GitLab ─────────────────────────────────────────────
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-trigger-')); tmpDirs.push(root);
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { env: GIT_ENV });
  g(remote, 'config', 'receive.advertisePushOptions', 'true');
  execFileSync('git', ['clone', '-q', remote, work], { env: GIT_ENV, stdio: 'ignore' });
  g(work, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'README.md'), 'x\n');
  g(work, 'add', '-A'); g(work, 'commit', '-q', '-m', 'initial'); g(work, 'push', '-q', 'origin', 'main');
  // from here on every push to the project is recorded with its push options (the setup push above is not)
  const hook = path.join(remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nopts=""\ni=0\nwhile [ "$i" -lt "${GIT_PUSH_OPTION_COUNT:-0}" ]; do eval "opts=\\"\\$opts \\$GIT_PUSH_OPTION_$i\\""; i=$((i+1)); done\nwhile read old new ref; do echo "$ref$opts" >> "$GIT_DIR/push.log"; done\nexit 0\n', { mode: 0o755 });
  const repo = path.join(root, 'bot.git');
  execFileSync('git', ['init', '--bare', '-q', repo], { env: GIT_ENV });
  g(repo, 'remote', 'add', 'origin', remote);
  g(repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  return { root, remote, work, repo, main: g(repo, 'rev-parse', 'refs/remotes/origin/main') };
}
function fake(state) {
  const f = fakeFetch();
  f.route('GET', `${P}/pipelines`, (call) => ({ json: state.pipelines.filter((p) => p.ref === call.query.ref?.[0]).sort((a, b) => b.id - a.id) }));
  f.route('GET', /\/pipelines\/\d+\/variables$/, (call) => ({ json: state.variables[Number(/pipelines\/(\d+)\/variables/.exec(call.path)[1])] ?? [] }));
  f.route('POST', `${P}/pipeline`, (call) => {
    const id = 500 + state.pipelines.length;
    state.pipelines.push({ id, ref: call.body.ref, sha: 'f'.repeat(40), status: 'created', source: 'api' });
    state.variables[id] = call.body.variables;
    return { status: 201, json: { id, ref: call.body.ref, status: 'created' } };
  });
  return f;
}
function ctxFor(w, f, extra = {}) {
  const logs = [];
  const client = createClient({ baseUrl: 'https://gitlab.test', token: 'fixture-token-0123456789', fetch: f, sleep: async () => {} });
  const git = (args) => execFileSync('git', ['-C', w.repo, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { client, git, dryRun: false, log: (e) => logs.push(e), logs, ...extra };
}
const pushLog = (w) => (fs.existsSync(path.join(w.remote, 'push.log')) ? fs.readFileSync(path.join(w.remote, 'push.log'), 'utf8').trim().split('\n') : []);

test('assistRuns reads the newest api pipeline of each rule\'s assist ref and the head it was started for', async () => {
  const w = world();
  const state = {
    pipelines: [
      { id: 40, ref: 'assist/7-i18n-propagate', sha: w.main, status: 'success', source: 'api' },
      { id: 41, ref: 'assist/7-i18n-propagate', sha: w.main, status: 'skipped', source: 'push' },
      { id: 42, ref: 'assist/7-i18n-propagate', sha: w.main, status: 'running', source: 'api' },
    ],
    variables: { 40: [{ key: 'ASSIST_MR_HEAD', value: HEAD2 }], 42: [{ key: 'ASSIST_MR_IID', value: '7' }, { key: 'ASSIST_MR_HEAD', value: HEAD }, { key: 'ASSIST_RULE', value: 'i18n-propagate' }] },
  };
  const f = fake(state);
  const runs = await assist.assistRuns(ctxFor(w, f), 'vitana%2Fvitana-v1', 7, [RULES[0], RULES[1]]);
  assert.deepEqual(runs['i18n-propagate'], { pipeline: 42, head: HEAD, status: 'running' }, 'the push pipeline of the ref itself is not an assist run');
  assert.equal(runs['whats-new'], null);
  f.assertNoWrites();
});

test('triggerAssist moves assist/<iid>-<rule> to main with ci.skip, never by force, and starts one pipeline with the merge request\'s id and head', async () => {
  const w = world();
  const state = { pipelines: [], variables: {} };
  const f = fake(state);
  const ctx = ctxFor(w, f);
  const out = await assist.triggerAssist(ctx, { pid: 'vitana%2Fvitana-v1', iid: 7, head: HEAD, rule: 'i18n-propagate', mainSha: w.main, sourceBranch: 'kiro/demo/web-a' });
  assert.equal(out.triggered, true);
  assert.equal(g(w.remote, 'rev-parse', 'refs/heads/assist/7-i18n-propagate'), w.main);
  assert.deepEqual(pushLog(w), ['refs/heads/assist/7-i18n-propagate ci.skip']);
  const posts = f.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.ref, 'assist/7-i18n-propagate');
  assert.deepEqual(posts[0].body.variables, [
    { key: 'ASSIST_MR_IID', value: '7' }, { key: 'ASSIST_MR_HEAD', value: HEAD }, { key: 'ASSIST_RULE', value: 'i18n-propagate' }, { key: 'ASSIST_SOURCE_BRANCH', value: 'kiro/demo/web-a' },
  ]);
  // main moved: the ref is moved forward (a fast-forward), still with ci.skip
  fs.writeFileSync(path.join(w.work, 'more.md'), 'y\n');
  g(w.work, 'add', '-A'); g(w.work, 'commit', '-q', '-m', 'main moves'); g(w.work, 'push', '-q', 'origin', 'main');
  g(w.repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const main2 = g(w.repo, 'rev-parse', 'refs/remotes/origin/main');
  await assist.triggerAssist(ctx, { pid: 'vitana%2Fvitana-v1', iid: 7, head: HEAD2, rule: 'i18n-propagate', mainSha: main2, sourceBranch: 'kiro/demo/web-a' });
  assert.equal(g(w.remote, 'rev-parse', 'refs/heads/assist/7-i18n-propagate'), main2);
  const assistPushes = pushLog(w).filter((l) => l.startsWith('refs/heads/assist/'));
  assert.equal(assistPushes.length, 2);
  assert.ok(assistPushes.every((l) => l.endsWith(' ci.skip')));
  // the ref moved somewhere main never was: the push is refused (no force) and no pipeline is started
  g(w.work, 'checkout', '-q', '-b', 'other', 'HEAD~1');
  fs.writeFileSync(path.join(w.work, 'other.md'), 'z\n');
  g(w.work, 'add', '-A'); g(w.work, 'commit', '-q', '-m', 'elsewhere'); g(w.work, 'push', '-q', '--force', 'origin', 'other:refs/heads/assist/7-i18n-propagate');
  await assert.rejects(() => assist.triggerAssist(ctx, { pid: 'vitana%2Fvitana-v1', iid: 7, head: HEAD, rule: 'i18n-propagate', mainSha: main2, sourceBranch: 'kiro/demo/web-a' }), /git push/);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 2, 'no pipeline after a refused push');
});

test('triggerAssist --dry-run writes nothing', async () => {
  const w = world();
  const f = fake({ pipelines: [], variables: {} });
  const ctx = ctxFor(w, f, { dryRun: true });
  const out = await assist.triggerAssist(ctx, { pid: 'vitana%2Fvitana-v1', iid: 7, head: HEAD, rule: 'i18n-propagate', mainSha: w.main, sourceBranch: 'kiro/demo/web-a' });
  assert.equal(out.triggered, false);
  f.assertNoWrites();
  assert.deepEqual(pushLog(w), []);
  assert.ok(ctx.logs.some((e) => e.event === 'would_trigger_assist' && e.rule === 'i18n-propagate'));
});
