// Tests of the GitHub bridge (plan agentic-delivery §3.13, lane github-bridge, VTID-05548).
// Git is real: every test builds temporary bare repositories that stand in for GitHub and GitLab, and the bridge copies
// between them with the git binary. Both APIs are one recording fake fetch (scripts/eng/testing/fake-fetch.mjs) that
// holds a small model of pull requests, commit statuses, comments, merge requests, pipelines and jobs, so a test can
// assert the exact writes ("the second tick made no write"). No network, no real token, no real waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './gitlab-api.mjs';
import { fakeFetch } from './testing/fake-fetch.mjs';
import {
  BRIDGE_REPOS, isBridgedBranch, jobToStatus, statusContext, mrTitle, mrDescription, makeRedactor, readTokenFile,
  GitHubApiError, createGitHubClient, createGit, emptyState, loadState, saveState, tick, assistPush, main,
} from './github-bridge.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAIRS = [
  { github: 'exafyltd/vitana-platform', gitlab: 'vitana/vitana-platform' },
  { github: 'exafyltd/vitana-v1', gitlab: 'vitana/vitana-v1' },
];
const PF = PAIRS[0];
const V1 = PAIRS[1];
// Test tokens without a real token shape (a real shape is built at run time where a test needs one).
const GH_TOKEN = ['test', 'github', 'token', '0123456789abcdef'].join('-');
const GL_TOKEN = ['test', 'gitlab', 'token', 'fedcba9876543210'].join('-');
const API_GH = 'https://api.github.test';
const GL_URL = 'https://gitlab.test';
const b64 = (s) => Buffer.from(s).toString('base64');
const SECRET_FORMS = [GH_TOKEN, GL_TOKEN, b64(`x-access-token:${GH_TOKEN}`), b64(`oauth2:${GL_TOKEN}`)];

const TEST_GIT_ENV = {
  PATH: process.env.PATH, HOME: process.env.HOME ?? tmpdir(), LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
  GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid',
};
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: TEST_GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`test git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
/** branch → sha of every branch of a (bare) repository. */
function branchesOn(url) {
  const out = git(tmpdir(), 'ls-remote', url, 'refs/heads/*');
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => l.split('\t')).map(([sha, ref]) => [ref.replace('refs/heads/', ''), sha]).sort(([a], [b]) => a.localeCompare(b)));
}
const headOn = (url, branch) => branchesOn(url)[branch] ?? null;

// ------------------------------------------------------------------------------------------------- the test world
/** Two GitHub and two GitLab bare repositories (main at the same base commit, as the mirror leaves them), a work
 * clone per repository to make commits, and the API model behind one fake fetch. */
function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'github-bridge-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const w = { dir, f: fakeFetch(), state: emptyState(), repos: [], gh: {}, gl: {}, failures: [], glUser: { id: 77, username: 'bridge-bot' }, nextJobId: 1000 };
  for (const { github, gitlab } of PAIRS) {
    const githubGitUrl = join(dir, 'github', `${github}.git`);
    const gitlabGitUrl = join(dir, 'gitlab', `${gitlab}.git`);
    const work = join(dir, 'work', github);
    for (const p of [dirname(githubGitUrl), dirname(gitlabGitUrl), work]) mkdirSync(p, { recursive: true });
    git(dir, 'init', '-q', '--bare', '-b', 'main', githubGitUrl);
    git(dir, 'init', '-q', '--bare', '-b', 'main', gitlabGitUrl);
    git(work, 'init', '-q', '-b', 'main');
    writeFileSync(join(work, 'README'), `${github}\n`);
    git(work, 'add', 'README');
    git(work, 'commit', '-q', '-m', 'base');
    const base = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', githubGitUrl, 'main');
    git(work, 'push', '-q', gitlabGitUrl, 'main');
    const repo = { github, gitlab, githubGitUrl, gitlabGitUrl };
    w.repos.push(repo);
    w.gh[github] = { repo, work, base, pulls: new Map(), statuses: new Map(), comments: new Map() };
    w.gl[gitlab] = { repo, mrs: [], nextIid: 1, pipelines: [] };
  }
  installRoutes(w);
  return w;
}

/** A commit on `branch` of the work clone (from `from`, default main); returns its sha. */
function commitOn(w, github, branch, msg, { from = 'main' } = {}) {
  const { work } = w.gh[github];
  git(work, 'checkout', '-q', '-B', branch, from);
  writeFileSync(join(work, 'file.txt'), `${branch}: ${msg}\n`);
  git(work, 'add', 'file.txt');
  git(work, 'commit', '-q', '-m', msg);
  return git(work, 'rev-parse', 'HEAD');
}
const pushTo = (w, github, url, ref, sha, force = false) => git(w.gh[github].work, 'push', '-q', ...(force ? ['--force'] : []), url, `${sha}:${ref}`);
const pushGitHub = (w, github, branch, sha, { force = false } = {}) => pushTo(w, github, w.gh[github].repo.githubGitUrl, `refs/heads/${branch}`, sha, force);
const pushGitLab = (w, github, branch, sha, { force = false } = {}) => pushTo(w, github, w.gh[github].repo.gitlabGitUrl, `refs/heads/${branch}`, sha, force);
const deleteOnGitLab = (w, github, branch) => git(w.dir, '--git-dir', w.gh[github].repo.gitlabGitUrl, 'update-ref', '-d', `refs/heads/${branch}`);
/** A new branch on GitHub with one commit; returns its sha. */
function mk(w, github, branch, msg = `work on ${branch}`) {
  const sha = commitOn(w, github, branch, msg);
  pushGitHub(w, github, branch, sha);
  return sha;
}
const glUrlOf = (w, pair) => w.gl[pair.gitlab].repo.gitlabGitUrl;
const ghUrlOf = (w, pair) => w.gh[pair.github].repo.githubGitUrl;

function addPr(w, github, { number, branch, sha, title = `PR ${number}`, body = `Body of PR ${number}`, draft = false, base = 'main', fork = false }) {
  const [owner, name] = github.split('/');
  const headRepo = fork ? { full_name: `someone/${name}`, owner: { login: 'someone' } } : { full_name: github, owner: { login: owner } };
  w.gh[github].pulls.set(number, { number, state: 'open', title, body, draft, head: { ref: branch, sha, repo: headRepo }, base: { ref: base, repo: { full_name: github } } });
}
function updatePr(w, github, number, { sha, base, ...rest }) {
  const p = w.gh[github].pulls.get(number);
  if (sha) p.head.sha = sha;
  if (base) p.base.ref = base;
  Object.assign(p, rest);
}
const openMrs = (w, pair) => w.gl[pair.gitlab].mrs.filter((m) => m.state === 'opened');
const mrFor = (w, pair, branch) => [...w.gl[pair.gitlab].mrs].reverse().find((m) => m.source_branch === branch);
/** The merge bot lands a merge request: a squash commit on GitLab main, the source branch removed after merge; GitLab
 * keeps refs/merge-requests/<iid>/head at the landed head. With mergeMain, the bot first merges GitLab main into the source
 * branch (eng-gitlab-m2 §3.4 "behind main", plan §3.5 train update), as it does whenever main moved. */
function landMr(w, pair, iid, { mergeMain = false } = {}) {
  const p = w.gl[pair.gitlab];
  const mr = p.mrs.find((m) => m.iid === iid);
  if (mergeMain) botMergesMain(w, pair, mr.source_branch);
  mr.sha = headOn(p.repo.gitlabGitUrl, mr.source_branch);
  git(w.dir, '--git-dir', p.repo.gitlabGitUrl, 'update-ref', `refs/merge-requests/${iid}/head`, mr.sha);
  const squash = commitOn(w, pair.github, 'main', `squash of !${iid}`, { from: headOn(p.repo.gitlabGitUrl, 'main') });
  pushTo(w, pair.github, p.repo.gitlabGitUrl, 'refs/heads/main', squash);
  deleteOnGitLab(w, pair.github, mr.source_branch);
  mr.state = 'merged';
  mr.squash_commit_sha = squash;
  return squash;
}
/** Another landing moves GitLab main; then the merge bot merges main into `branch` on GitLab (a clean merge, author
 * bot-land). Returns the bot's merge commit. */
function botMergesMain(w, pair, branch) {
  const { work } = w.gh[pair.github];
  const glUrl = w.gl[pair.gitlab].repo.gitlabGitUrl;
  git(work, 'fetch', '-q', glUrl, `+refs/heads/main:refs/remotes/gl/main`, `+refs/heads/${branch}:refs/remotes/gl/${branch}`);
  git(work, 'checkout', '-q', '-B', 'tmp-main', 'refs/remotes/gl/main');
  w.landings = (w.landings ?? 0) + 1;
  writeFileSync(join(work, `landing-${w.landings}.txt`), 'another landing\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'another landing on main');
  const main = git(work, 'rev-parse', 'HEAD');
  pushTo(w, pair.github, glUrl, 'refs/heads/main', main);
  git(work, 'checkout', '-q', '-B', 'tmp-bot', `refs/remotes/gl/${branch}`);
  git(work, 'merge', '-q', '--no-ff', '--no-edit', '-m', `Merge main into ${branch}`, main);
  const merge = git(work, 'rev-parse', 'HEAD');
  pushTo(w, pair.github, glUrl, `refs/heads/${branch}`, merge, true);
  return merge;
}
function addPipeline(w, pair, sha, jobs) {
  const p = w.gl[pair.gitlab];
  const pl = { id: 500 + p.pipelines.length + 1, sha, status: 'running', jobs: [] };
  for (const j of jobs) {
    const id = w.nextJobId++;
    pl.jobs.push({ id, name: j.name, status: j.status, allow_failure: Boolean(j.allow_failure), web_url: `${GL_URL}/${pair.gitlab}/-/jobs/${id}` });
  }
  p.pipelines.push(pl);
  return pl;
}
/** The next `times` calls of `method` whose path matches `re` get `response` instead of the model's answer. */
function failNext(w, method, re, response, times = 1) {
  w.failures.push({ method, re, response, times });
}
/** A pre-receive hook on a bare repository that refuses one ref. */
function rejectRef(url, ref) {
  const hook = join(url, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "${ref}" ]; then echo "refused by the test hook" >&2; exit 1; fi\ndone\nexit 0\n`, { mode: 0o755 });
  return () => rmSync(hook);
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const q1 = (call, k) => call.query[k]?.[0];
const page = (call, list, defPer) => {
  const per = Number(q1(call, 'per_page') ?? defPer);
  const n = Number(q1(call, 'page') ?? 1);
  return { items: list.slice((n - 1) * per, n * per), more: n * per < list.length, n };
};

function installRoutes(w) {
  const route = (method, re, handler) => w.f.route(method, re, (call) => {
    const injected = w.failures.find((x) => x.method === call.method && x.re.test(call.path) && x.times > 0);
    if (injected) { injected.times -= 1; return injected.response; }
    return handler(call, re.exec(call.path));
  });
  const ghRepo = (m) => w.gh[`${m[1]}/${m[2]}`];
  // ---- GitHub
  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls$/, (call, m) => {
    let list = [...ghRepo(m).pulls.values()].sort((a, b) => a.number - b.number);
    const state = q1(call, 'state') ?? 'open';
    if (state !== 'all') list = list.filter((p) => p.state === state);
    if (q1(call, 'base')) list = list.filter((p) => p.base.ref === q1(call, 'base'));
    if (q1(call, 'head')) list = list.filter((p) => `${p.head.repo?.owner?.login}:${p.head.ref}` === q1(call, 'head'));
    const pg = page(call, list, 30);
    const headers = {};
    if (pg.more) { const u = new URL(call.url); u.searchParams.set('page', String(pg.n + 1)); headers.link = `<${u.href}>; rel="next"`; }
    return { json: pg.items.map(clone), headers };
  });
  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, (call, m) => {
    const p = ghRepo(m).pulls.get(Number(m[3]));
    return p ? { json: clone(p) } : { status: 404, json: { message: 'Not Found' } };
  });
  route('PATCH', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, (call, m) => {
    const p = ghRepo(m).pulls.get(Number(m[3]));
    if (call.body?.state) p.state = call.body.state;
    return { json: clone(p) };
  });
  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{40})\/status$/, (call, m) => {
    const latest = new Map();
    for (const s of ghRepo(m).statuses.get(m[3]) ?? []) latest.set(s.context, s);
    const list = [...latest.values()];
    const pg = page(call, list, 30);
    return { json: { state: 'pending', sha: m[3], total_count: list.length, statuses: pg.items.map(clone) } };
  });
  route('POST', /^\/repos\/([^/]+)\/([^/]+)\/statuses\/([0-9a-f]{40})$/, (call, m) => {
    const repo = ghRepo(m);
    const list = repo.statuses.get(m[3]) ?? [];
    const { state, target_url, description, context } = call.body;
    list.push({ id: list.length + 1, state, target_url, description, context });
    repo.statuses.set(m[3], list);
    return { status: 201, json: clone(list[list.length - 1]) };
  });
  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, (call, m) => {
    const pg = page(call, ghRepo(m).comments.get(Number(m[3])) ?? [], 30);
    return { json: pg.items.map(clone) };
  });
  route('POST', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, (call, m) => {
    const repo = ghRepo(m);
    const list = repo.comments.get(Number(m[3])) ?? [];
    list.push({ id: list.length + 1, body: call.body.body });
    repo.comments.set(Number(m[3]), list);
    return { status: 201, json: clone(list[list.length - 1]) };
  });
  installGitLabRoutes(w, route);
}

function installGitLabRoutes(w, route) {
  const project = (m) => w.gl[decodeURIComponent(m[1])];
  const view = (p, mr) => {
    if (mr.state === 'opened') { const h = headOn(p.repo.gitlabGitUrl, mr.source_branch); if (h) mr.sha = h; } // GitLab moves only open ones
    return {
      id: 9000 + mr.iid, iid: mr.iid, project_id: 1, source_project_id: 1, target_project_id: 1, title: mr.title,
      description: mr.description, state: mr.state, source_branch: mr.source_branch, target_branch: mr.target_branch,
      sha: mr.sha, author: mr.author, closed_by: mr.closed_by ?? null, squash_commit_sha: mr.squash_commit_sha ?? null,
      merge_commit_sha: null, web_url: `${GL_URL}/${p.repo.gitlab}/-/merge_requests/${mr.iid}`,
    };
  };
  route('GET', /^\/api\/v4\/user$/, () => ({ json: w.glUser }));
  route('GET', /^\/api\/v4\/projects\/([^/]+)\/merge_requests$/, (call, m) => {
    const p = project(m);
    let list = p.mrs.map((mr) => view(p, mr));
    for (const k of ['state', 'source_branch', 'target_branch']) if (q1(call, k)) list = list.filter((x) => x[k] === q1(call, k));
    const pg = page(call, list, 20);
    return { json: pg.items, headers: pg.more ? { 'x-next-page': String(pg.n + 1) } : {} };
  });
  route('POST', /^\/api\/v4\/projects\/([^/]+)\/merge_requests$/, (call, m) => {
    const p = project(m);
    const b = call.body;
    if (p.mrs.some((x) => x.state === 'opened' && x.source_branch === b.source_branch && x.target_branch === b.target_branch)) {
      return { status: 409, json: { message: ['Another open merge request already exists for this source branch'] } };
    }
    const mr = { iid: p.nextIid++, title: b.title, description: b.description ?? '', source_branch: b.source_branch, target_branch: b.target_branch, state: 'opened', author: { id: w.glUser.id }, sha: null };
    p.mrs.push(mr);
    return { status: 201, json: view(p, mr) };
  });
  route('GET', /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)$/, (call, m) => {
    const p = project(m);
    const mr = p.mrs.find((x) => x.iid === Number(m[2]));
    if (!mr) return { status: 404, json: { message: '404 Not found' } };
    const v = view(p, mr);
    const pl = [...p.pipelines].reverse().find((x) => x.sha === v.sha);
    return { json: { ...v, head_pipeline: pl ? { id: pl.id, sha: pl.sha, status: pl.status } : null } };
  });
  route('PUT', /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)$/, (call, m) => {
    const p = project(m);
    const mr = p.mrs.find((x) => x.iid === Number(m[2]));
    const b = call.body ?? {};
    if (b.title !== undefined) mr.title = b.title;
    if (b.description !== undefined) mr.description = b.description;
    if (b.state_event === 'close') { mr.state = 'closed'; mr.closed_by = { id: w.glUser.id }; }
    return { json: view(p, mr) };
  });
  route('GET', /^\/api\/v4\/projects\/([^/]+)\/pipelines\/(\d+)\/jobs$/, (call, m) => {
    const pl = project(m).pipelines.find((x) => x.id === Number(m[2]));
    const pg = page(call, pl ? pl.jobs : [], 20);
    return { json: pg.items.map(clone), headers: pg.more ? { 'x-next-page': String(pg.n + 1) } : {} };
  });
}

// ------------------------------------------------------------------------------------------------- running the bridge
/** A spawnSync that runs the real git and records every call (argv and environment). */
function gitSpy() {
  const calls = [];
  const fn = (cmd, args, opts) => { calls.push({ cmd, args: [...args], cwd: opts?.cwd, env: { ...(opts?.env ?? {}) } }); return spawnSync(cmd, args, opts); };
  fn.calls = calls;
  fn.verb = (verb) => calls.filter((c) => c.args[0] === verb);
  return fn;
}
function ctxFor(w, { dryRun = false, spy, ...extra } = {}) {
  const logs = [];
  return {
    ...extra,
    repos: w.repos,
    github: createGitHubClient({ token: GH_TOKEN, baseUrl: API_GH, fetch: w.f, sleep: async () => {} }),
    gitlab: createClient({ baseUrl: GL_URL, token: GL_TOKEN, fetch: w.f, sleep: async () => {} }),
    git: createGit({ cacheDir: join(w.dir, 'state', 'cache'), spawnSync: spy ?? spawnSync }),
    state: w.state,
    dryRun,
    gitlabWebUrl: GL_URL,
    log: (level, event, fields = {}) => logs.push({ level, event, ...fields }),
    logs,
  };
}
async function runTick(w, opts = {}) {
  const ctx = ctxFor(w, opts);
  const res = await tick(ctx);
  if (!opts.dryRun) w.state = res.state;
  return { ...res, logs: ctx.logs };
}
const events = (res, event) => res.logs.filter((l) => l.event === event);
const actionsOf = (res) => res.actions.map((a) => `${a.action} ${a.repo} ${a.branch ?? ''}${a.pr ? ` #${a.pr}` : ''}`.trim()).sort();

function tokenFiles(w) {
  const d = join(w.dir, 'tokens');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'github'), `${GH_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(d, 'gitlab'), `${GL_TOKEN}\n`, { mode: 0o600 });
  return { github: join(d, 'github'), gitlab: join(d, 'gitlab') };
}
/** Runs the CLI (main) against the test world; returns { code, stdout, stderr }. */
async function cli(w, [cmd, ...rest], { spy, stateDir = join(w.dir, 'state') } = {}) {
  const tf = tokenFiles(w);
  let stdout = '';
  let stderr = '';
  const args = [cmd, '--state-dir', stateDir, '--github-token-file', tf.github, '--gitlab-token-file', tf.gitlab,
    '--github-api-url', API_GH, '--gitlab-url', GL_URL, '--github-git-base', join(w.dir, 'github'), '--gitlab-git-base', join(w.dir, 'gitlab'), ...rest];
  const code = await main(args, {
    fetch: w.f, spawnSync: spy ?? spawnSync, sleep: async () => {},
    stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } },
  });
  return { code, stdout, stderr };
}
const jsonLines = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
function assistCtx(w, { dryRun = false, spy } = {}) {
  const logs = [];
  return { repo: w.repos[0], git: createGit({ cacheDir: join(w.dir, 'state', 'cache'), spawnSync: spy ?? spawnSync }), state: w.state, dryRun, log: (level, event, fields = {}) => logs.push({ level, event, ...fields }), logs };
}

// ------------------------------------------------------------------------------------------------- names and mappings
test('BRIDGE_REPOS pairs exafyltd/vitana-platform with vitana/vitana-platform and exafyltd/vitana-v1 with vitana/vitana-v1, nothing else', () => {
  assert.deepEqual(BRIDGE_REPOS.map(({ github, gitlab }) => ({ github, gitlab })), PAIRS);
});

test('isBridgedBranch: kiro/* and claude/* only; never main, assist/*, pm-agent/* or any other name; never a malformed ref', () => {
  for (const ok of ['kiro/agentic-delivery/github-bridge', 'kiro/x', 'claude/fix-123', 'kiro/agentic-delivery/_plan', 'claude/a.b/c-d_e']) {
    assert.equal(isBridgedBranch(ok), true, ok);
  }
  for (const no of ['main', 'assist/12-i18n', 'pm-agent/lane-x', 'feature/x', 'dependabot/npm/x', 'kiro', 'kiro/', 'claude', 'Kiro/x',
    'kirox/y', 'refs/heads/kiro/x', 'kiro/../main', 'kiro/x..y', 'kiro//x', 'kiro/x/', 'kiro/x.lock', 'kiro/x.lock/y', 'kiro/.x', 'kiro/x.',
    'kiro/x:main', 'kiro/x y', 'kiro/x~1', 'kiro/x^', 'kiro/x?', 'kiro/x*', 'kiro/x[', 'kiro/x\\y', 'kiro/x@{1}', '-kiro/x', `kiro/${'a'.repeat(300)}`,
    '', null, undefined, 42]) {
    assert.equal(isBridgedBranch(no), false, String(no));
  }
});

test('jobToStatus maps every GitLab job status to a GitHub commit status state with a short description', () => {
  const cases = [
    [{ status: 'success' }, 'success'], [{ status: 'failed' }, 'failure'], [{ status: 'failed', allow_failure: true }, 'success'],
    [{ status: 'canceled' }, 'error'], [{ status: 'skipped' }, 'success'], [{ status: 'manual', allow_failure: true }, 'success'],
    [{ status: 'manual', allow_failure: false }, 'pending'],
    ...['created', 'pending', 'scheduled', 'preparing', 'waiting_for_resource', 'waiting_for_callback', 'running', 'canceling'].map((s) => [{ status: s }, 'pending']),
    [{ status: 'a-status-gitlab-adds-later' }, 'pending'],
  ];
  const unsettled = new Set(['created', 'pending', 'scheduled', 'preparing', 'waiting_for_resource', 'waiting_for_callback', 'running', 'canceling']);
  for (const [job, state] of cases) {
    const s = jobToStatus(job);
    assert.equal(s.state, state, JSON.stringify(job));
    assert.equal(s.settled, !unsettled.has(job.status), `settled ${JSON.stringify(job)}`);
    assert.equal(typeof s.description, 'string');
    assert.ok(s.description.length > 0 && s.description.length <= 140, s.description);
  }
  assert.notEqual(jobToStatus({ status: 'failed', allow_failure: true }).description, jobToStatus({ status: 'success' }).description);
  assert.notEqual(jobToStatus({ status: 'skipped' }).description, jobToStatus({ status: 'success' }).description);
  assert.equal(statusContext('gate'), 'gitlab/gate');
  assert.equal(statusContext('gateway-jest 2/4'), 'gitlab/gateway-jest 2/4');
});

test('merge request title and description: the PR title and body, a draft PR as a GitLab draft, quick actions disarmed', () => {
  assert.equal(mrTitle({ title: 'VTID-05548 (s/l): x', draft: false }), 'VTID-05548 (s/l): x');
  assert.equal(mrTitle({ title: 'VTID-05548 (s/l): x', draft: true }), 'Draft: VTID-05548 (s/l): x');
  assert.equal(mrTitle({ title: 'a'.repeat(256), draft: false }).length, 255);
  assert.equal(mrDescription(null), '');
  assert.equal(mrDescription(undefined), '');
  assert.equal(mrDescription('line 1\r\nline 2\r\n'), 'line 1\nline 2\n');
  assert.equal(mrDescription('/merge\n  /label ~queue-ready\ntext /not-a-command\n'), '\\/merge\n  \\/label ~queue-ready\ntext /not-a-command\n');
  assert.equal(mrDescription('# Summary\n- [x] done\n'), '# Summary\n- [x] done\n');
});

// ------------------------------------------------------------------------------------------------- branches
test('a tick copies the kiro/* and claude/* branches of both repositories to GitLab, and never main, assist/*, pm-agent/* or another name', async (t) => {
  const w = world(t);
  const a = mk(w, PF.github, 'kiro/plan-x/lane-a');
  const c = mk(w, PF.github, 'claude/fix-123');
  for (const other of ['assist/12-i18n', 'pm-agent/lane-state', 'feature/x', 'Kiro/upper', 'kirox/y']) mk(w, PF.github, other);
  mk(w, PF.github, 'main', 'main moved on GitHub');
  const v = mk(w, V1.github, 'kiro/plan-y/lane-b');
  const res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(branchesOn(glUrlOf(w, PF)), { 'claude/fix-123': c, 'kiro/plan-x/lane-a': a, main: w.gh[PF.github].base });
  assert.deepEqual(branchesOn(glUrlOf(w, V1)), { 'kiro/plan-y/lane-b': v, main: w.gh[V1.github].base });
  assert.deepEqual(actionsOf(res), [
    'create_branch exafyltd/vitana-platform claude/fix-123',
    'create_branch exafyltd/vitana-platform kiro/plan-x/lane-a',
    'create_branch exafyltd/vitana-v1 kiro/plan-y/lane-b',
  ]);
  assert.equal(res.state.repos[PF.github].branches['kiro/plan-x/lane-a'].pushed, a);
  assert.equal(res.state.repos[V1.github].branches['kiro/plan-y/lane-b'].pushed, v);
  assert.equal(events(res, 'create_branch').length, 3);
});

test('a second tick with nothing new pushes nothing, fetches nothing and makes no API write', async (t) => {
  const w = world(t);
  const a = mk(w, PF.github, 'kiro/s/a');
  addPr(w, PF.github, { number: 1, branch: 'kiro/s/a', sha: a });
  const first = gitSpy();
  await runTick(w, { spy: first });
  assert.equal(first.verb('push').length, 1);
  assert.equal(openMrs(w, PF).length, 1);
  const mark = w.f.mark();
  const second = gitSpy();
  const res = await runTick(w, { spy: second });
  assert.deepEqual(res.errors, []);
  assert.deepEqual([...second.verb('push'), ...second.verb('fetch')], []);
  w.f.assertNoWrites(mark);
  assert.deepEqual(res.actions, []);
});

test('a new commit and a force-push on GitHub are copied to a branch the bridge owns', async (t) => {
  const w = world(t);
  const b = 'kiro/s/lane';
  const c1 = mk(w, PF.github, b);
  await runTick(w);
  const c2 = commitOn(w, PF.github, b, 'c2', { from: c1 });
  pushGitHub(w, PF.github, b, c2);
  let res = await runTick(w);
  assert.equal(headOn(glUrlOf(w, PF), b), c2);
  assert.deepEqual(actionsOf(res), [`update_branch exafyltd/vitana-platform ${b}`]);
  const c3 = commitOn(w, PF.github, b, 'c3, history rewritten', { from: w.gh[PF.github].base });
  pushGitHub(w, PF.github, b, c3, { force: true });
  res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.equal(headOn(glUrlOf(w, PF), b), c3);
  assert.deepEqual(actionsOf(res), [`update_branch exafyltd/vitana-platform ${b}`]);
  assert.equal(res.state.repos[PF.github].branches[b].pushed, c3);
});

test('a branch that already lives on GitLab with other history is refused, never overwritten, gets no merge request, and is reported once per GitLab head', async (t) => {
  const w = world(t);
  const b = 'kiro/two/writers';
  const x1 = commitOn(w, PF.github, 'tmp-x', 'written on GitLab by another writer');
  pushGitLab(w, PF.github, b, x1);
  const y1 = mk(w, PF.github, b, 'written on GitHub');
  addPr(w, PF.github, { number: 7, branch: b, sha: y1 });
  const spy = gitSpy();
  const reports = [];
  for (let i = 0; i < 3; i++) {
    const r = await runTick(w, { spy });
    assert.deepEqual(r.errors, []);
    reports.push(...events(r, 'branch_refused'));
  }
  assert.equal(headOn(glUrlOf(w, PF), b), x1);
  assert.equal(spy.verb('push').length, 0);
  assert.equal(reports.length, 1);
  assert.deepEqual({ level: reports[0].level, branch: reports[0].branch, gitlab_head: reports[0].gitlab_head, github_head: reports[0].github_head }, { level: 'warn', branch: b, gitlab_head: x1, github_head: y1 });
  assert.equal(w.gl[PF.gitlab].mrs.length, 0);
  const x2 = commitOn(w, PF.github, 'tmp-x', 'the other writer again', { from: x1 });
  pushGitLab(w, PF.github, b, x2);
  let r = await runTick(w);
  assert.equal(events(r, 'branch_refused').length, 1, 'a new GitLab head is reported again');
  const y2 = commitOn(w, PF.github, b, 'the agent again', { from: y1 });
  pushGitHub(w, PF.github, b, y2);
  updatePr(w, PF.github, 7, { sha: y2 });
  r = await runTick(w);
  assert.equal(events(r, 'branch_refused').length, 0, 'the same GitLab head is not reported twice');
  assert.equal(headOn(glUrlOf(w, PF), b), x2);
  deleteOnGitLab(w, PF.github, b); // a person resolves it (runbook): the GitLab copy goes, the GitHub branch is copied
  r = await runTick(w);
  assert.deepEqual(r.errors, []);
  assert.equal(headOn(glUrlOf(w, PF), b), y2);
  assert.equal(openMrs(w, PF).length, 1);
});

test('the same history already on GitLab (a mirror copy) is adopted without a push, and an older copy of it is fast-forwarded', async (t) => {
  const w = world(t);
  const m1 = mk(w, PF.github, 'kiro/m/one');
  pushGitLab(w, PF.github, 'kiro/m/one', m1);
  const n1 = commitOn(w, PF.github, 'kiro/n/one', 'n1');
  const n2 = commitOn(w, PF.github, 'kiro/n/one', 'n2', { from: n1 });
  pushGitLab(w, PF.github, 'kiro/n/one', n1);
  pushGitHub(w, PF.github, 'kiro/n/one', n2);
  const spy = gitSpy();
  const res = await runTick(w, { spy });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(actionsOf(res), ['adopt_and_update_branch exafyltd/vitana-platform kiro/n/one', 'adopt_branch exafyltd/vitana-platform kiro/m/one']);
  assert.equal(spy.verb('push').length, 1);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/n/one'), n2);
  const m2 = commitOn(w, PF.github, 'kiro/m/one', 'm2', { from: m1 });
  pushGitHub(w, PF.github, 'kiro/m/one', m2);
  const res2 = await runTick(w);
  assert.deepEqual(actionsOf(res2), ['update_branch exafyltd/vitana-platform kiro/m/one']);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/m/one'), m2);
});

test('a write on GitLab to a branch the bridge copied makes it refused: the GitLab commit stays and GitHub is not copied over it', async (t) => {
  const w = world(t);
  const b = 'kiro/w/lane';
  const c1 = mk(w, PF.github, b);
  await runTick(w);
  const z = commitOn(w, PF.github, 'tmp-z', 'pushed to GitLab directly', { from: c1 });
  pushGitLab(w, PF.github, b, z);
  const c2 = commitOn(w, PF.github, b, 'c2', { from: c1 });
  pushGitHub(w, PF.github, b, c2);
  const res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.equal(headOn(glUrlOf(w, PF), b), z);
  assert.equal(events(res, 'branch_refused').length, 1);
  assert.equal(res.state.repos[PF.github].branches[b].pushed, c1);
});

// ------------------------------------------------------------------------------------------------- merge requests
test('one merge request per open same-repository pull request from a bridged branch into main: same title, body and head; updated on change; none for forks, other branches or other bases', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a = mk(w, gh, 'kiro/s/a');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: a, title: 'VTID-05548 (s/a): first', body: 'Body of the first PR' });
  const b = mk(w, gh, 'claude/b');
  addPr(w, gh, { number: 2, branch: 'claude/b', sha: b, title: 'Second', body: 'Line one\r\n/merge\r\n', draft: true });
  const c = mk(w, gh, 'kiro/s/c');
  addPr(w, gh, { number: 3, branch: 'kiro/s/c', sha: c, fork: true });
  addPr(w, gh, { number: 4, branch: 'feature/d', sha: mk(w, gh, 'feature/d') });
  addPr(w, gh, { number: 5, branch: 'kiro/s/e', sha: mk(w, gh, 'kiro/s/e'), base: 'release' });
  addPr(w, gh, { number: 6, branch: 'pm-agent/g', sha: mk(w, gh, 'pm-agent/g') });
  const res = await runTick(w);
  assert.deepEqual(res.errors, []);
  const rows = w.gl[PF.gitlab].mrs.map((m) => [m.source_branch, m.target_branch, m.title, m.description, m.state]).sort();
  assert.deepEqual(rows, [
    ['claude/b', 'main', 'Draft: Second', 'Line one\n\\/merge\n', 'opened'],
    ['kiro/s/a', 'main', 'VTID-05548 (s/a): first', 'Body of the first PR', 'opened'],
  ]);
  assert.equal(mrFor(w, PF, 'kiro/s/a').sha, a, 'the merge request head is the pull request head');
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/c'), c, 'branches are copied whatever their pull requests are');
  let mark = w.f.mark();
  await runTick(w);
  w.f.assertNoWrites(mark);
  updatePr(w, gh, 1, { title: 'VTID-05548 (s/a): first, renamed', body: 'New body' });
  mark = w.f.mark();
  await runTick(w);
  const writes = w.f.writes(mark);
  assert.deepEqual(writes.map((x) => `${x.method} ${x.path}`), [`PUT /api/v4/projects/vitana%2Fvitana-platform/merge_requests/${mrFor(w, PF, 'kiro/s/a').iid}`]);
  assert.deepEqual(writes[0].body, { title: 'VTID-05548 (s/a): first, renamed', description: 'New body' });
  mark = w.f.mark();
  await runTick(w);
  w.f.assertNoWrites(mark);
  updatePr(w, gh, 2, { draft: false });
  await runTick(w);
  assert.equal(mrFor(w, PF, 'claude/b').title, 'Second');
  assert.equal(w.gl[PF.gitlab].mrs.length, 2);
});

test('a pull request that closes without landing, or leaves main, has its merge request closed once; a merge request the bridge did not open is left alone', async (t) => {
  const w = world(t);
  const gh = PF.github;
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: mk(w, gh, 'kiro/s/a') });
  addPr(w, gh, { number: 2, branch: 'kiro/s/b', sha: mk(w, gh, 'kiro/s/b') });
  await runTick(w);
  assert.equal(openMrs(w, PF).length, 2);
  const n = commitOn(w, gh, 'tmp-n', 'a native GitLab writer');
  pushGitLab(w, gh, 'kiro/native/lane', n);
  w.gl[PF.gitlab].mrs.push({ iid: w.gl[PF.gitlab].nextIid++, title: 'native', description: '', source_branch: 'kiro/native/lane', target_branch: 'main', state: 'opened', author: { id: 5 }, sha: n });
  updatePr(w, gh, 1, { state: 'closed' });
  updatePr(w, gh, 2, { base: 'release' });
  let mark = w.f.mark();
  const res = await runTick(w);
  assert.deepEqual(res.errors, []);
  const closes = w.f.writes(mark).filter((x) => x.method === 'PUT' && x.body?.state_event === 'close');
  assert.equal(closes.length, 2);
  const states = Object.fromEntries(w.gl[PF.gitlab].mrs.map((m) => [m.source_branch, m.state]));
  assert.deepEqual(states, { 'kiro/s/a': 'closed', 'kiro/s/b': 'closed', 'kiro/native/lane': 'opened' });
  mark = w.f.mark();
  await runTick(w);
  w.f.assertNoWrites(mark);
});

test('a merge request is closed only after GitHub confirms that no open pull request from its branch into main exists', async (t) => {
  const w = world(t);
  addPr(w, PF.github, { number: 1, branch: 'kiro/s/a', sha: mk(w, PF.github, 'kiro/s/a') });
  await runTick(w);
  failNext(w, 'GET', /^\/repos\/exafyltd\/vitana-platform\/pulls$/, { json: [] }, 1); // one list answer without the PR
  const mark = w.f.mark();
  const res = await runTick(w);
  w.f.assertNoWrites(mark);
  assert.equal(openMrs(w, PF).length, 1);
  assert.equal(events(res, 'pull_request_list_inconsistent').length, 1);
});

// ------------------------------------------------------------------------------------------------- statuses
test('statuses: one gitlab/<job> commit status per job result of the merge request head pipeline, on the GitHub commit, never posted twice', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a = mk(w, gh, 'kiro/s/a');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: a });
  await runTick(w);
  const pl = addPipeline(w, PF, a, [
    { name: 'lane-scope', status: 'success' }, { name: 'gate', status: 'running' }, { name: 'unit 1/2', status: 'failed' },
    { name: 'lint', status: 'failed', allow_failure: true }, { name: 'old', status: 'canceled' }, { name: 'docs', status: 'skipped' },
    { name: 'optional-manual', status: 'manual', allow_failure: true }, { name: 'blocking-manual', status: 'manual' },
    { name: 'future', status: 'a-status-gitlab-adds-later' },
  ]);
  let mark = w.f.mark();
  await runTick(w);
  const posted = w.f.writes(mark);
  assert.equal(posted.length, 8, 'the running job has no result yet');
  for (const x of posted) assert.equal(`${x.method} ${x.path}`, `POST /repos/${gh}/statuses/${a}`);
  const byContext = Object.fromEntries(posted.map((x) => [x.body.context, x.body]));
  assert.deepEqual(Object.fromEntries(Object.entries(byContext).map(([k, v]) => [k, v.state])), {
    'gitlab/lane-scope': 'success', 'gitlab/unit 1/2': 'failure', 'gitlab/lint': 'success', 'gitlab/old': 'error',
    'gitlab/docs': 'success', 'gitlab/optional-manual': 'success', 'gitlab/blocking-manual': 'pending', 'gitlab/future': 'pending',
  });
  assert.equal(byContext['gitlab/unit 1/2'].target_url, pl.jobs[2].web_url);
  assert.equal(byContext['gitlab/unit 1/2'].description, 'Failed on GitLab');
  mark = w.f.mark();
  await runTick(w);
  w.f.assertNoWrites(mark);
  assert.equal(w.f.since(mark).filter((x) => x.path.endsWith('/status')).length, 0, 'nothing changed: GitHub is not even asked');
  w.state = emptyState(); // the bridge lost its state: GitHub's latest statuses are compared, nothing is posted twice
  mark = w.f.mark();
  await runTick(w);
  w.f.assertNoWrites(mark);
  pl.jobs[1].status = 'success';
  mark = w.f.mark();
  await runTick(w);
  assert.deepEqual(w.f.writes(mark).map((x) => [x.body.context, x.body.state]), [['gitlab/gate', 'success']]);
});

test('status writes stay under GitHub content limits: a budget per tick and per hour, the rest posted at a later tick, none lost or doubled', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a = mk(w, gh, 'kiro/s/a');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: a });
  await runTick(w);
  addPipeline(w, PF, a, ['j1', 'j2', 'j3', 'j4', 'j5'].map((name) => ({ name, status: 'success' })));
  let clock = new Date('2026-11-05T10:15:00Z');
  const opts = { maxStatusWritesPerTick: 2, maxStatusWritesPerHour: 3, now: () => clock };
  const postsOf = async () => { const mark = w.f.mark(); const res = await runTick(w, opts); return { n: w.f.writes(mark).length, res }; };
  assert.equal((await postsOf()).n, 2, 'tick budget');
  assert.equal((await postsOf()).n, 1, 'hour budget: 3 in this hour');
  const third = await postsOf();
  assert.equal(third.n, 0);
  assert.equal(events(third.res, 'status_budget_reached').length, 1);
  clock = new Date('2026-11-05T11:05:00Z');
  assert.equal((await postsOf()).n, 0, 'a sliding hour: the 10:15 writes still count at 11:05');
  clock = new Date('2026-11-05T11:16:00Z');
  assert.equal((await postsOf()).n, 2, 'an hour after the first writes');
  assert.equal((await postsOf()).n, 0, 'all five are on GitHub');
  const contexts = (w.gh[gh].statuses.get(a) ?? []).map((s) => s.context).sort();
  assert.deepEqual(contexts, ['gitlab/j1', 'gitlab/j2', 'gitlab/j3', 'gitlab/j4', 'gitlab/j5']);
});

test('statuses are posted only for the head pipeline of the merge request at the pull request head', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a1 = mk(w, gh, 'kiro/s/a');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: a1 });
  await runTick(w);
  addPipeline(w, PF, a1, [{ name: 'gate', status: 'success' }]);
  const a2 = commitOn(w, gh, 'kiro/s/a', 'a2', { from: a1 });
  pushGitHub(w, gh, 'kiro/s/a', a2);
  updatePr(w, gh, 1, { sha: a2 });
  let mark = w.f.mark();
  await runTick(w);
  assert.deepEqual(w.f.writes(mark).filter((x) => x.path.includes('/statuses/')), []);
  addPipeline(w, PF, a2, [{ name: 'gate', status: 'failed' }]);
  mark = w.f.mark();
  await runTick(w);
  assert.deepEqual(w.f.writes(mark).map((x) => [x.path, x.body.state]), [[`/repos/${gh}/statuses/${a2}`, 'failure']]);
});

test('the status budget goes first to the jobs that gate a landing, and the next tick starts with the pull request that was left without a turn', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a = mk(w, gh, 'kiro/s/a');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: a });
  const b = mk(w, gh, 'kiro/s/b');
  addPr(w, gh, { number: 2, branch: 'kiro/s/b', sha: b });
  await runTick(w);
  addPipeline(w, PF, a, ['docs', 'unit', 'gate', 'lane-scope'].map((name) => ({ name, status: 'success' })));
  addPipeline(w, PF, b, ['gate', 'unit'].map((name) => ({ name, status: 'success' })));
  const opts = { maxStatusWritesPerTick: 2, maxStatusWritesPerHour: 1000 };
  const served = async () => { const mark = w.f.mark(); await runTick(w, opts); return w.f.writes(mark).map((x) => `${x.path.endsWith(a) ? 'a' : 'b'} ${x.body.context}`); };
  assert.deepEqual(await served(), ['a gitlab/gate', 'a gitlab/lane-scope']);
  addPipeline(w, PF, a, ['docs', 'unit', 'gate', 'lane-scope'].map((name) => ({ name, status: 'failed' }))); // new results for a
  assert.deepEqual(await served(), ['b gitlab/gate', 'b gitlab/unit'], 'b, left without a turn, goes first');
});

test('a GitHub rate limit stops every GitHub write for the rest of the tick and pauses them until it has passed', async (t) => {
  const w = world(t);
  const gh = PF.github;
  for (const n of [1, 2, 3]) addPr(w, gh, { number: n, branch: `kiro/s/p${n}`, sha: mk(w, gh, `kiro/s/p${n}`) });
  await runTick(w);
  for (const n of [1, 2, 3]) addPipeline(w, PF, w.gh[gh].pulls.get(n).head.sha, [{ name: 'gate', status: 'success' }]);
  failNext(w, 'POST', /\/statuses\//, { status: 403, json: { message: 'You have exceeded a secondary rate limit' } }, 100);
  let clock = new Date('2026-11-05T10:00:00Z');
  const opts = { now: () => clock };
  let mark = w.f.mark();
  let res = await runTick(w, opts);
  assert.equal(w.f.writes(mark).length, 1, 'one failed write, then no more in this tick');
  assert.equal(events(res, 'github_writes_paused').length, 1);
  clock = new Date('2026-11-05T10:00:30Z');
  mark = w.f.mark();
  await runTick(w, opts);
  assert.equal(w.f.writes(mark).length, 0, 'still paused 30 s later');
  w.failures.length = 0;
  clock = new Date('2026-11-05T10:01:05Z');
  mark = w.f.mark();
  await runTick(w, opts);
  assert.equal(w.f.writes(mark).length, 3, 'all three statuses after the pause');
});

test('a merge request someone else opened from a bridged branch is never rewritten; its pipeline results still come back', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const b = 'kiro/native/lane';
  const n = mk(w, gh, b);
  pushGitLab(w, gh, b, n);
  w.gl[PF.gitlab].mrs.push({ iid: w.gl[PF.gitlab].nextIid++, title: 'native title', description: 'native text', source_branch: b, target_branch: 'main', state: 'opened', author: { id: 5 }, sha: n });
  addPr(w, gh, { number: 9, branch: b, sha: n, title: 'GitHub title', body: 'GitHub body' });
  addPipeline(w, PF, n, [{ name: 'gate', status: 'success' }]);
  const mark = w.f.mark();
  const res = await runTick(w);
  assert.deepEqual(w.f.writes(mark).map((x) => `${x.method} ${x.path}`), [`POST /repos/${gh}/statuses/${n}`]);
  assert.equal(events(res, 'merge_request_not_ours').length, 1);
  assert.equal(w.gl[PF.gitlab].mrs[0].title, 'native title');
});

test('a branch deleted on GitHub stays the bridge\'s while GitLab has its copy: a new branch of that name is copied, not refused', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const b = 'kiro/s/again';
  mk(w, gh, b);
  await runTick(w);
  git(w.dir, '--git-dir', ghUrlOf(w, PF), 'update-ref', '-d', `refs/heads/${b}`);
  await runTick(w);
  const c3 = commitOn(w, gh, b, 'new history', { from: w.gh[gh].base });
  pushGitHub(w, gh, b, c3, { force: true });
  const res = await runTick(w);
  assert.equal(events(res, 'branch_refused').length, 0);
  assert.equal(headOn(glUrlOf(w, PF), b), c3);
});

// ------------------------------------------------------------------------------------------------- landing
test('after the merge request lands, the pull request is closed with one comment that links the landed commit; the removed branch is not copied again', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a = mk(w, gh, 'kiro/s/a');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: a });
  await runTick(w);
  const { iid } = mrFor(w, PF, 'kiro/s/a');
  const squash = landMr(w, PF, iid);
  failNext(w, 'PATCH', /^\/repos\/exafyltd\/vitana-platform\/pulls\/1$/, { status: 503, json: { message: 'unavailable' } }, 1);
  let res = await runTick(w);
  assert.equal(res.errors.length, 1, 'the close failed and is retried at the next tick');
  assert.equal(w.gh[gh].pulls.get(1).state, 'open');
  assert.equal(w.gh[gh].comments.get(1).length, 1);
  res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.equal(w.gh[gh].pulls.get(1).state, 'closed');
  const comments = w.gh[gh].comments.get(1);
  assert.equal(comments.length, 1, 'one comment, not one per attempt');
  assert.ok(comments[0].body.includes(`${GL_URL}/${PF.gitlab}/-/commit/${squash}`), comments[0].body);
  assert.ok(comments[0].body.includes(`${GL_URL}/${PF.gitlab}/-/merge_requests/${iid}`), comments[0].body);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), null);
  let mark = w.f.mark();
  await runTick(w);
  w.f.assertNoWrites(mark);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), null);
  assert.equal(w.gl[PF.gitlab].mrs.length, 1);
  w.state = emptyState(); // a lost state: the landed head is still not copied again
  mark = w.f.mark();
  const spy = gitSpy();
  await runTick(w, { spy });
  w.f.assertNoWrites(mark);
  assert.equal(spy.verb('push').length, 0);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), null);
});

test('the merge bot merging main into a bridged branch is not another writer: the branch stays bridged, results come back to the PR head, and the landing closes the PR', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a = mk(w, gh, 'kiro/s/a');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: a });
  await runTick(w);
  const { iid } = mrFor(w, PF, 'kiro/s/a');
  const m = botMergesMain(w, PF, 'kiro/s/a');
  let res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.equal(events(res, 'branch_refused').length, 0);
  assert.deepEqual(actionsOf(res), ['adopt_main_merge exafyltd/vitana-platform kiro/s/a']);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), m, 'the bot\'s merge stays on GitLab');
  addPipeline(w, PF, m, [{ name: 'gate', status: 'success' }]);
  let mark = w.f.mark();
  await runTick(w);
  assert.deepEqual(w.f.writes(mark).map((x) => [x.path, x.body.context, x.body.state]), [[`/repos/${gh}/statuses/${a}`, 'gitlab/gate', 'success']], 'posted on the PR head');
  const squash = landMr(w, PF, iid);
  mark = w.f.mark();
  res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.equal(w.gh[gh].pulls.get(1).state, 'closed');
  assert.ok(w.gh[gh].comments.get(1)[0].body.includes(squash));
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), null, 'not copied again');
  assert.equal(w.gl[PF.gitlab].mrs.length, 1, 'no second merge request');
});

test('a landing right after the merge bot merged main (a train update the bridge never saw) still closes the PR and is not copied again', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a = mk(w, gh, 'kiro/s/a');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: a });
  await runTick(w);
  const squash = landMr(w, PF, mrFor(w, PF, 'kiro/s/a').iid, { mergeMain: true });
  const spy = gitSpy();
  const res = await runTick(w, { spy });
  assert.deepEqual(res.errors, []);
  assert.equal(spy.verb('push').length, 0);
  assert.equal(w.gh[gh].pulls.get(1).state, 'closed');
  assert.ok(w.gh[gh].comments.get(1)[0].body.includes(squash));
  assert.equal(w.gl[PF.gitlab].mrs.length, 1);
});

test('a new GitHub head after the merge bot merged main is copied over the bot\'s merge; a merge with other changes is refused', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a = mk(w, gh, 'kiro/s/a');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: a });
  await runTick(w);
  botMergesMain(w, PF, 'kiro/s/a');
  await runTick(w);
  const fix = commitOn(w, gh, 'kiro/s/a', 'fix after a red pipeline', { from: a });
  pushGitHub(w, gh, 'kiro/s/a', fix);
  updatePr(w, gh, 1, { sha: fix });
  let res = await runTick(w);
  assert.deepEqual(actionsOf(res), ['update_branch exafyltd/vitana-platform kiro/s/a']);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), fix);
  const m2 = botMergesMain(w, PF, 'kiro/s/a');
  const { work } = w.gh[gh];
  git(work, 'checkout', '-q', '-B', 'tmp-dirty', m2);
  writeFileSync(join(work, 'smuggled.txt'), 'not from main\n');
  git(work, 'add', 'smuggled.txt');
  git(work, 'commit', '-q', '--amend', '--no-edit');
  pushGitLab(w, gh, 'kiro/s/a', git(work, 'rev-parse', 'HEAD'), { force: true });
  res = await runTick(w);
  assert.equal(events(res, 'branch_refused').length, 1, 'a merge that adds its own change is another writer');
});

test('a refused branch whose GitLab copy a person deleted is copied again, also when GitHub did not move', async (t) => {
  const w = world(t);
  const b = 'kiro/w/lane';
  const c1 = mk(w, PF.github, b);
  await runTick(w);
  const z = commitOn(w, PF.github, 'tmp-z', 'pushed to GitLab directly', { from: c1 });
  pushGitLab(w, PF.github, b, z);
  let res = await runTick(w);
  assert.equal(events(res, 'branch_refused').length, 1);
  deleteOnGitLab(w, PF.github, b);
  res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(actionsOf(res), [`create_branch exafyltd/vitana-platform ${b}`]);
  assert.equal(headOn(glUrlOf(w, PF), b), c1);
});

test('new commits pushed to a branch after its merge request landed are copied again and get a new merge request', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a = mk(w, gh, 'kiro/s/a');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: a });
  await runTick(w);
  landMr(w, PF, mrFor(w, PF, 'kiro/s/a').iid);
  const a2 = commitOn(w, gh, 'kiro/s/a', 'pushed after the landing', { from: a });
  pushGitHub(w, gh, 'kiro/s/a', a2);
  updatePr(w, gh, 1, { sha: a2 });
  const res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), a2);
  assert.equal(w.gh[gh].pulls.get(1).state, 'open', 'the landed head is not the pull request head');
  assert.deepEqual(w.gl[PF.gitlab].mrs.map((m) => m.state), ['merged', 'opened']);
});

test('a merge request someone closed on GitLab while its pull request is open is reported once and not opened again for that head', async (t) => {
  const w = world(t);
  const gh = PF.github;
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: mk(w, gh, 'kiro/s/a') });
  await runTick(w);
  const mr = mrFor(w, PF, 'kiro/s/a');
  mr.state = 'closed';
  mr.closed_by = { id: 5 };
  const reports = [];
  for (let i = 0; i < 2; i++) {
    const mark = w.f.mark();
    const res = await runTick(w);
    w.f.assertNoWrites(mark);
    reports.push(...events(res, 'merge_request_closed_on_gitlab'));
  }
  assert.equal(reports.length, 1);
  assert.equal(w.gl[PF.gitlab].mrs.length, 1);
  const a2 = commitOn(w, gh, 'kiro/s/a', 'a new head', { from: mr.sha });
  pushGitHub(w, gh, 'kiro/s/a', a2);
  updatePr(w, gh, 1, { sha: a2 });
  await runTick(w);
  assert.deepEqual(w.gl[PF.gitlab].mrs.map((m) => m.state), ['closed', 'opened'], 'a new head gets a new merge request');
});

// ------------------------------------------------------------------------------------------------- assist commits
test('assist push: one commit on top of the head of a bridged branch goes to the GitHub branch; anything else is refused and pushes nothing', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const b = 'kiro/s/a';
  const a = mk(w, gh, b);
  await runTick(w);
  const assist = commitOn(w, gh, 'tmp-assist', 'i18n: fill every language', { from: a });
  pushTo(w, gh, glUrlOf(w, PF), 'refs/heads/assist/1-i18n', assist); // the assist job's result, on GitLab
  const x = commitOn(w, gh, 'tmp-two', 'x', { from: a });
  const y = commitOn(w, gh, 'tmp-two', 'y', { from: x });
  pushTo(w, gh, glUrlOf(w, PF), 'refs/heads/assist/2-two', y);
  const sneaky = commitOn(w, gh, 'tmp-sneaky', 'one commit on top, from an ordinary branch', { from: a });
  pushTo(w, gh, glUrlOf(w, PF), 'refs/heads/kiro/s/sneaky', sneaky);
  const refusals = [
    { branch: 'main', commit: assist, fromRef: 'refs/heads/assist/1-i18n' },
    { branch: 'assist/1-i18n', commit: assist, fromRef: 'refs/heads/assist/1-i18n' },
    { branch: 'kiro/s/never-bridged', commit: assist, fromRef: 'refs/heads/assist/1-i18n' },
    { branch: b, commit: y, fromRef: 'refs/heads/assist/2-two' }, // two commits on top of the head
    { branch: b, commit: x, fromRef: 'refs/heads/assist/1-i18n' }, // the ref does not point at the commit
    { branch: b, commit: assist, fromRef: 'refs/heads/../x' }, // not a valid ref
    { branch: b, commit: sneaky, fromRef: 'refs/heads/kiro/s/sneaky' }, // a branch any agent can push: not an assist ref
  ];
  for (const c of refusals) {
    const spy = gitSpy();
    const r = await assistPush({ ...assistCtx(w, { spy }), ...c });
    assert.equal(r.ok, false, JSON.stringify(c));
    assert.equal(typeof r.refused, 'string');
    assert.equal(spy.verb('push').length, 0, JSON.stringify(c));
  }
  assert.equal(headOn(ghUrlOf(w, PF), b), a);
  const dry = await assistPush({ ...assistCtx(w, { dryRun: true }), branch: b, commit: assist, fromRef: 'refs/heads/assist/1-i18n' });
  assert.equal(dry.ok, true);
  assert.equal(headOn(ghUrlOf(w, PF), b), a, 'a dry run pushes nothing');
  const spy = gitSpy();
  const r = await assistPush({ ...assistCtx(w, { spy }), branch: b, commit: assist, fromRef: 'refs/heads/assist/1-i18n' });
  assert.deepEqual({ ok: r.ok, action: r.action }, { ok: true, action: 'assist_pushed' });
  assert.equal(headOn(ghUrlOf(w, PF), b), assist);
  const pushes = spy.verb('push');
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].args.includes(ghUrlOf(w, PF)), 'pushed to the GitHub branch');
  await runTick(w);
  assert.equal(headOn(glUrlOf(w, PF), b), assist, 'the next tick copies it to GitLab');
  const a2 = commitOn(w, gh, b, 'the agent pushed again', { from: assist });
  pushGitHub(w, gh, b, a2);
  const late = commitOn(w, gh, 'tmp-late', 'an assist commit on the old head', { from: assist });
  pushTo(w, gh, glUrlOf(w, PF), 'refs/heads/assist/3-late', late);
  const r2 = await assistPush({ ...assistCtx(w), branch: b, commit: late, fromRef: 'refs/heads/assist/3-late' });
  assert.equal(r2.ok, false);
  assert.equal(headOn(ghUrlOf(w, PF), b), a2);
});

test('assist push refuses a branch whose GitLab copy another writer changed, and a branch that is gone from GitHub', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const a = mk(w, gh, 'kiro/s/a');
  const c = mk(w, gh, 'kiro/s/c');
  await runTick(w);
  pushGitLab(w, gh, 'kiro/s/a', commitOn(w, gh, 'tmp-x', 'another writer', { from: a }));
  git(w.dir, '--git-dir', ghUrlOf(w, PF), 'update-ref', '-d', 'refs/heads/kiro/s/c');
  for (const [branch, parent, n] of [['kiro/s/a', a, 1], ['kiro/s/c', c, 2]]) {
    const commit = commitOn(w, gh, `tmp-assist-${n}`, 'assist', { from: parent });
    pushTo(w, gh, glUrlOf(w, PF), `refs/heads/assist/${n}-i18n`, commit);
    const spy = gitSpy();
    const r = await assistPush({ ...assistCtx(w, { spy }), branch, commit, fromRef: `refs/heads/assist/${n}-i18n` });
    assert.equal(r.ok, false, branch);
    assert.equal(spy.verb('push').length, 0);
  }
  assert.equal(headOn(ghUrlOf(w, PF), 'kiro/s/a'), a);
});

// ------------------------------------------------------------------------------------------------- dry run
test('a dry run that cannot judge a branch\'s history without a fetch plans check_history and fetches nothing', async (t) => {
  const w = world(t);
  pushGitLab(w, PF.github, 'kiro/s/x', commitOn(w, PF.github, 'tmp-x', 'on GitLab'));
  mk(w, PF.github, 'kiro/s/x', 'on GitHub');
  const spy = gitSpy();
  const res = await runTick(w, { dryRun: true, spy });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(actionsOf(res), ['check_history exafyltd/vitana-platform kiro/s/x']);
  assert.deepEqual(spy.calls.filter((x) => ['fetch', 'push', 'init'].includes(x.args[0])), []);
  assert.equal(existsSync(join(w.dir, 'state', 'cache')), false);
});

function snapshot(w) {
  const refs = w.repos.flatMap((r) => [r.githubGitUrl, r.gitlabGitUrl]).map((u) => JSON.stringify(branchesOn(u)));
  const cacheDir = join(w.dir, 'state', 'cache');
  const cache = existsSync(cacheDir) ? readdirSync(cacheDir).map((d) => git(join(cacheDir, d), 'for-each-ref', '--format=%(objectname) %(refname)')) : [];
  return JSON.stringify({ refs, cache });
}
test('--dry-run writes nothing anywhere (no git push or fetch, no API write, no state write) and prints the planned actions', async (t) => {
  const w = world(t);
  const gh = PF.github;
  const b1 = mk(w, gh, 'kiro/s/b');
  addPr(w, gh, { number: 2, branch: 'kiro/s/b', sha: b1 });
  const c = mk(w, gh, 'kiro/s/c');
  addPr(w, gh, { number: 3, branch: 'kiro/s/c', sha: c });
  addPr(w, gh, { number: 4, branch: 'kiro/s/d', sha: mk(w, gh, 'kiro/s/d') });
  assert.equal((await cli(w, ['run'])).code, 0); // a live tick first: three branches, three merge requests, a state file
  const stateFile = join(w.dir, 'state', 'state.json');
  const stateBefore = readFileSync(stateFile, 'utf8');
  addPr(w, gh, { number: 1, branch: 'kiro/s/a', sha: mk(w, gh, 'kiro/s/a') });
  const b2 = commitOn(w, gh, 'kiro/s/b', 'b2', { from: b1 });
  pushGitHub(w, gh, 'kiro/s/b', b2);
  updatePr(w, gh, 2, { sha: b2, title: 'renamed' });
  addPipeline(w, PF, c, [{ name: 'gate', status: 'success' }]);
  updatePr(w, gh, 4, { state: 'closed' });
  const before = snapshot(w);
  const mark = w.f.mark();
  const spy = gitSpy();
  const out = await cli(w, ['run', '--dry-run'], { spy });
  assert.equal(out.code, 0, out.stderr);
  w.f.assertNoWrites(mark);
  assert.equal(snapshot(w), before);
  assert.deepEqual(spy.calls.filter((x) => ['fetch', 'push'].includes(x.args[0])).map((x) => x.args.join(' ')), []);
  const cacheDir = join(w.dir, 'state', 'cache');
  assert.deepEqual(spy.calls.filter((x) => String(x.cwd ?? '').startsWith(cacheDir)).map((x) => x.args[0]), [], 'no git command runs in the service cache');
  assert.equal(readFileSync(stateFile, 'utf8'), stateBefore);
  assert.deepEqual(readdirSync(join(w.dir, 'state')).sort(), ['cache', 'state.json']);
  const planned = jsonLines(out.stdout).filter((l) => l.event === 'planned').map((l) => `${l.action} ${l.branch ?? ''}${l.pr ? ` #${l.pr}` : ''}${l.context ? ` ${l.context}` : ''}`.trim()).sort();
  assert.deepEqual(planned, [
    'close_merge_request kiro/s/d',
    'create_branch kiro/s/a',
    'create_merge_request kiro/s/a #1',
    'post_status kiro/s/c #3 gitlab/gate',
    'update_branch kiro/s/b',
    'update_merge_request kiro/s/b #2',
  ]);
});

// ------------------------------------------------------------------------------------------------- errors
test('GitHub API down: nothing changes for that repository in that tick, it is retried at the next tick, the other repository goes on', async (t) => {
  const w = world(t);
  const a = mk(w, PF.github, 'kiro/s/a');
  addPr(w, PF.github, { number: 1, branch: 'kiro/s/a', sha: a });
  const v = mk(w, V1.github, 'kiro/v/b');
  addPr(w, V1.github, { number: 1, branch: 'kiro/v/b', sha: v });
  failNext(w, 'GET', /^\/repos\/exafyltd\/vitana-platform\/pulls$/, { status: 503, json: { message: 'down' } }, 10);
  let res = await runTick(w);
  assert.deepEqual(res.errors.map((e) => e.repo), [PF.github]);
  assert.ok(res.logs.some((l) => l.level === 'error' && l.repo === PF.github));
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), null);
  assert.equal(w.gl[PF.gitlab].mrs.length, 0);
  assert.equal(res.state.repos[PF.github], undefined, 'the state of that repository is unchanged');
  assert.equal(headOn(glUrlOf(w, V1), 'kiro/v/b'), v);
  assert.equal(openMrs(w, V1).length, 1);
  w.failures.length = 0;
  res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), a);
  assert.equal(openMrs(w, PF).length, 1);
});

test('GitLab API down: nothing changes for that repository in that tick and it is retried at the next tick', async (t) => {
  const w = world(t);
  const v = mk(w, V1.github, 'kiro/v/b');
  addPr(w, V1.github, { number: 1, branch: 'kiro/v/b', sha: v });
  const a = mk(w, PF.github, 'kiro/s/a');
  failNext(w, 'GET', /^\/api\/v4\/projects\/vitana%2Fvitana-v1\/merge_requests$/, { status: 500, json: { message: 'down' } }, 10);
  let res = await runTick(w);
  assert.deepEqual(res.errors.map((e) => e.repo), [V1.github]);
  assert.equal(headOn(glUrlOf(w, V1), 'kiro/v/b'), null);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), a);
  w.failures.length = 0;
  res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.equal(headOn(glUrlOf(w, V1), 'kiro/v/b'), v);
  assert.equal(openMrs(w, V1).length, 1);
});

test('a git error on one branch changes nothing for that branch and is retried at the next tick; the other branches are copied', async (t) => {
  const w = world(t);
  const bad = mk(w, PF.github, 'kiro/s/bad');
  const good = mk(w, PF.github, 'kiro/s/good');
  const allow = rejectRef(glUrlOf(w, PF), 'refs/heads/kiro/s/bad');
  let res = await runTick(w);
  assert.deepEqual(res.errors.map((e) => [e.repo, e.branch]), [[PF.github, 'kiro/s/bad']]);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/bad'), null);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/good'), good);
  assert.equal(res.state.repos[PF.github].branches['kiro/s/bad'], undefined);
  allow();
  res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/bad'), bad);
});

test('a GitLab write that races a copy is never overwritten: every push carries the head it expects (lease)', async (t) => {
  const w = world(t);
  const b = 'kiro/s/race';
  const c1 = mk(w, PF.github, b);
  await runTick(w);
  const c2 = commitOn(w, PF.github, b, 'c2', { from: c1 });
  pushGitHub(w, PF.github, b, c2);
  const racer = commitOn(w, PF.github, 'tmp-racer', 'another writer, between the read and the push', { from: c1 });
  let raced = false;
  const spy = (cmd, args, opts) => {
    if (!raced && args[0] === 'push' && args.includes(glUrlOf(w, PF))) { raced = true; pushGitLab(w, PF.github, b, racer); }
    return spawnSync(cmd, args, opts);
  };
  const res = await runTick(w, { spy });
  assert.equal(raced, true);
  assert.deepEqual(res.errors.map((e) => e.branch), [b]);
  assert.equal(headOn(glUrlOf(w, PF), b), racer, 'the other writer\'s commit stays');
  assert.equal(res.state.repos[PF.github].branches[b].pushed, c1, 'state unchanged for that branch');
  const next = await runTick(w);
  assert.equal(events(next, 'branch_refused').length, 1, 'the next tick sees the other writer and refuses');
  assert.equal(headOn(glUrlOf(w, PF), b), racer);
});

test('an API error on one pull request leaves it for the next tick; the other pull request gets its merge request in the same tick', async (t) => {
  const w = world(t);
  addPr(w, PF.github, { number: 1, branch: 'kiro/s/a', sha: mk(w, PF.github, 'kiro/s/a') });
  addPr(w, PF.github, { number: 2, branch: 'kiro/s/b', sha: mk(w, PF.github, 'kiro/s/b') });
  failNext(w, 'POST', /\/merge_requests$/, { status: 500, json: { message: 'boom' } }, 1);
  let res = await runTick(w);
  assert.equal(res.errors.length, 1);
  assert.equal(openMrs(w, PF).length, 1);
  res = await runTick(w);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(openMrs(w, PF).map((m) => m.source_branch).sort(), ['kiro/s/a', 'kiro/s/b']);
});

// ------------------------------------------------------------------------------------------------- tokens
test('tokens come from files, never from argv, and appear in no log line or error, also when a server echoes them', async (t) => {
  const w = world(t);
  addPr(w, PF.github, { number: 1, branch: 'kiro/s/a', sha: mk(w, PF.github, 'kiro/s/a') });
  for (const opt of ['--github-token', '--gitlab-token', '--token']) {
    const out = await cli(w, ['run', opt, GH_TOKEN]);
    assert.equal(out.code, 2, opt);
    assert.match(out.stderr, /file/);
    assert.equal(`${out.stdout}${out.stderr}`.includes(GH_TOKEN), false);
  }
  failNext(w, 'GET', /^\/repos\/exafyltd\/vitana-platform\/pulls$/, { status: 500, json: { message: `bad credentials ${GH_TOKEN} (Bearer ${GH_TOKEN})` } }, 10);
  failNext(w, 'GET', /^\/api\/v4\/projects\/vitana%2Fvitana-v1\/merge_requests$/, { status: 500, json: { message: `token ${GL_TOKEN} is not valid` } }, 10);
  const out = await cli(w, ['run']);
  assert.equal(out.code, 1, 'a tick with errors exits 1');
  const lines = jsonLines(out.stdout);
  assert.ok(lines.filter((l) => l.level === 'error').length >= 2, 'both outages are logged');
  for (const l of lines) assert.equal(typeof l.at, 'string');
  const text = `${out.stdout}${out.stderr}`;
  for (const secret of SECRET_FORMS) assert.equal(text.includes(secret), false, 'a token form leaked into the output');
});

test('git gets each token only through the environment and only for its own host; never in argv or in a URL; git errors are redacted', () => {
  const calls = [];
  const sha = 'a'.repeat(40);
  const fake = (cmd, args, opts) => { calls.push({ args, env: opts.env }); return { status: 0, stdout: `${sha}\trefs/heads/kiro/x/y\n${sha}\trefs/heads/main\n`, stderr: '' }; };
  const credentials = [{ url: 'https://github.com', kind: 'github', token: GH_TOKEN }, { url: 'https://gitlab.vitanaland.com', kind: 'gitlab', token: GL_TOKEN }];
  const g = createGit({ cacheDir: join(tmpdir(), 'no-such-cache'), spawnSync: fake, credentials });
  assert.deepEqual([...g.lsRemote('https://github.com/exafyltd/vitana-platform.git')], [['kiro/x/y', sha]]);
  g.lsRemote('https://gitlab.vitanaland.com/vitana/vitana-platform.git');
  const config = (env) => Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  const [ghCall, glCall] = calls;
  for (const c of calls) assert.equal(c.args.some((a) => SECRET_FORMS.some((s) => a.includes(s)) || a.includes('@')), false, c.args.join(' '));
  assert.equal(config(ghCall.env)['http.https://github.com/.extraHeader'], `Authorization: Basic ${b64(`x-access-token:${GH_TOKEN}`)}`);
  assert.equal(config(glCall.env)['http.https://gitlab.vitanaland.com/.extraHeader'], `Authorization: Basic ${b64(`oauth2:${GL_TOKEN}`)}`);
  assert.equal(JSON.stringify(ghCall.env).includes(b64(`oauth2:${GL_TOKEN}`)), false);
  assert.equal(JSON.stringify(glCall.env).includes(b64(`x-access-token:${GH_TOKEN}`)), false);
  assert.equal(ghCall.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(ghCall.env.GIT_CONFIG_NOSYSTEM, '1');
  const leaky = () => ({ status: 128, stdout: '', stderr: `fatal: Authorization: Basic ${b64(`x-access-token:${GH_TOKEN}`)} ${GH_TOKEN}` });
  const g2 = createGit({ cacheDir: join(tmpdir(), 'no-such-cache'), spawnSync: leaky, credentials });
  assert.throws(() => g2.lsRemote('https://github.com/exafyltd/vitana-platform.git'), (e) => /ls-remote/.test(e.message) && !SECRET_FORMS.some((s) => e.message.includes(s) || String(e.stack).includes(s)));
  assert.throws(() => g.lsRemote('http://github.com/exafyltd/vitana-platform.git'), /https/);
  assert.throws(() => g.lsRemote(`https://x-access-token:${GH_TOKEN}@github.com/exafyltd/vitana-platform.git`), (e) => !e.message.includes(GH_TOKEN));
});

test('makeRedactor removes the tokens, their Basic-auth forms, GitHub and GitLab token shapes, bearer and basic values', () => {
  const ghShape = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
  const fineGrained = ['github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789'].join('');
  const glShape = ['gl', 'pat-', 'abcdefghij1234567890'].join('');
  const r = makeRedactor([GH_TOKEN, GL_TOKEN]);
  const text = `a ${GH_TOKEN} b ${GL_TOKEN} c ${b64(`x-access-token:${GH_TOKEN}`)} d ${b64(`oauth2:${GL_TOKEN}`)} e ${ghShape} f ${fineGrained} g ${glShape} h Bearer abc.def-ghi i Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==`;
  const out = r(text);
  for (const s of [...SECRET_FORMS, ghShape, fineGrained, glShape, 'abc.def-ghi', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ==']) assert.equal(out.includes(s), false, s);
  assert.match(out, /^a \[redacted\] b \[redacted\] c/);
  assert.equal(r(undefined), '');
});

test('readTokenFile: trims the token; a missing, empty or malformed file is an error that names the file and never its content', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'github-bridge-token-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(join(d, 'ok'), `  ${GH_TOKEN}\n`, { mode: 0o600 });
  assert.equal(readTokenFile(join(d, 'ok')), GH_TOKEN);
  writeFileSync(join(d, 'empty'), '\n', { mode: 0o600 });
  writeFileSync(join(d, 'bad'), 'not a token: has spaces and a secret-ish word\n', { mode: 0o600 });
  for (const name of ['missing', 'empty', 'bad']) {
    assert.throws(() => readTokenFile(join(d, name)), (e) => e.message.includes(join(d, name)) && !e.message.includes('secret-ish'), name);
  }
});

// ------------------------------------------------------------------------------------------------- GitHub client
const ghClient = (f, extra = {}) => createGitHubClient({ token: GH_TOKEN, baseUrl: API_GH, fetch: f, sleep: async () => {}, ...extra });

test('GitHub client: the token goes in one Authorization header to one origin; redirects are not followed; paths are plain paths', async () => {
  const f = fakeFetch();
  f.route('GET', '/repos/o/r/pulls', { json: [] });
  const c = ghClient(f);
  await c.get('/repos/o/r/pulls', { query: { state: 'open', per_page: 100 } });
  const call = f.calls[0];
  assert.equal(call.url, `${API_GH}/repos/o/r/pulls?state=open&per_page=100`);
  assert.equal(call.headers.authorization, `Bearer ${GH_TOKEN}`);
  assert.equal(call.headers.accept, 'application/vnd.github+json');
  assert.equal(call.headers['x-github-api-version'], '2022-11-28');
  assert.match(call.headers['user-agent'], /^vitana-github-bridge\//);
  assert.equal(call.redirect, 'manual');
  for (const bad of ['https://evil.test/x', '//evil.test/x', 'repos/o/r', '/repos/../x', '/repos/%2e%2e/x', '/repos/o/r?x=1', '/a#b', 42]) {
    await assert.rejects(c.get(bad), (e) => e instanceof GitHubApiError && e.code === 'bad_path', String(bad));
  }
  assert.equal(f.calls.length, 1);
  f.route('GET', '/repos/o/r/moved', { status: 301, headers: { location: 'https://evil.test/steal' } });
  await assert.rejects(c.get('/repos/o/r/moved'), (e) => e.code === 'redirect' && e.status === 301);
  assert.equal(f.calls.some((x) => x.url.startsWith('https://evil.test')), false);
  assert.throws(() => createGitHubClient({ token: GH_TOKEN, baseUrl: 'http://api.github.test', fetch: f }), (e) => e instanceof GitHubApiError);
  assert.throws(() => createGitHubClient({ token: 'short', baseUrl: API_GH, fetch: f }), (e) => e instanceof GitHubApiError && !e.message.includes('short'));
});

test('GitHub client: paginate follows rel="next" links on the same origin only', async () => {
  const f = fakeFetch();
  f.route('GET', '/repos/o/r/pulls', { json: [1, 2], headers: { link: `<${API_GH}/repositories/9/pulls?page=2>; rel="next", <${API_GH}/repositories/9/pulls?page=3>; rel="last"` } });
  f.route('GET', '/repositories/9/pulls', (call) => (q1(call, 'page') === '2'
    ? { json: [3], headers: { link: `<${API_GH}/repositories/9/pulls?page=3>; rel="next"` } }
    : { json: [4] }));
  const c = ghClient(f);
  assert.deepEqual(await c.paginate('/repos/o/r/pulls', { query: { state: 'open' } }), [1, 2, 3, 4]);
  f.route('GET', '/repos/o/r/other', { json: [1], headers: { link: '<https://evil.test/repos/o/r/other?page=2>; rel="next"' } });
  await assert.rejects(c.paginate('/repos/o/r/other'), (e) => e.code === 'bad_link');
  assert.equal(f.calls.some((x) => x.url.startsWith('https://evil.test')), false);
  f.route('GET', '/repos/o/r/object', { json: { not: 'a list' } });
  await assert.rejects(c.paginate('/repos/o/r/object'), (e) => e.code === 'paginate_non_array');
});

test('GitHub client: a GET is retried on 5xx and network errors, a write never; a rate limit is an error that is not retried', async () => {
  const f = fakeFetch();
  const sleeps = [];
  const c = ghClient(f, { sleep: async (ms) => { sleeps.push(ms); } });
  f.route('GET', '/a', [{ status: 503 }, { networkError: 'ECONNRESET' }, { json: { ok: 1 } }]);
  assert.deepEqual(await c.get('/a'), { ok: 1 });
  assert.equal(f.calls.length, 3);
  assert.equal(sleeps.length, 2);
  for (const [method, path] of [['POST', '/b'], ['PATCH', '/c'], ['PUT', '/d'], ['DELETE', '/e']]) {
    f.route(method, path, [{ status: 502 }, { json: {} }]);
    const n = f.calls.length;
    await assert.rejects(c.request(method, path, method === 'DELETE' ? {} : { body: { x: 1 } }), (e) => e.status === 502);
    assert.equal(f.calls.length - n, 1, `${method} is sent once`);
  }
  f.route('GET', '/f', [{ status: 429, headers: { 'retry-after': '60' } }, { json: {} }]);
  await assert.rejects(c.get('/f'), (e) => e.code === 'rate_limited');
  f.route('GET', '/g', [{ status: 403, headers: { 'x-ratelimit-remaining': '0' }, json: { message: 'API rate limit exceeded' } }, { json: {} }]);
  await assert.rejects(c.get('/g'), (e) => e.code === 'rate_limited');
  f.route('GET', '/h', [{ status: 404, json: { message: 'Not Found' } }, { json: {} }]);
  const n = f.calls.length;
  await assert.rejects(c.get('/h'), (e) => e.status === 404 && e.code === 'http');
  assert.equal(f.calls.length - n, 1);
});

test('GitHub client: an error carries status, method and the path without its query, and never the token', async () => {
  const f = fakeFetch();
  f.route('GET', '/repos/o/r/pulls', { status: 401, json: { message: `Bad credentials for ${GH_TOKEN}`, documentation_url: `x Bearer ${GH_TOKEN}` } });
  const c = ghClient(f);
  const e = await c.get('/repos/o/r/pulls', { query: { state: 'open' } }).then(() => null, (err) => err);
  assert.ok(e instanceof GitHubApiError);
  assert.deepEqual({ status: e.status, method: e.method, path: e.path }, { status: 401, method: 'GET', path: '/repos/o/r/pulls' });
  const all = [e.message, e.stack, String(e), JSON.stringify(e), e.bodyExcerpt ?? ''].join('\n');
  assert.equal(all.includes(GH_TOKEN), false);
  assert.match(e.message, /401/);
});

// ------------------------------------------------------------------------------------------------- host units and runbook
/** Key=Value lines of a unit file (comments and section headers left out); a key may repeat. */
function unitKeys(text) {
  const keys = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (m) (keys[m[1]] ??= []).push(m[2].trim());
  }
  return keys;
}
test('systemd units: the timer fires every minute; the service runs one tick through flock, niced and capped and hardened, with the tokens as credentials and never in the unit', () => {
  const dir = join(ROOT, 'infra', 'gitlab-engineering', 'host', 'units');
  const timerText = readFileSync(join(dir, 'vitana-github-bridge.timer'), 'utf8');
  const serviceText = readFileSync(join(dir, 'vitana-github-bridge.service'), 'utf8');
  const timer = unitKeys(timerText);
  const svc = unitKeys(serviceText);
  assert.deepEqual(timer.OnCalendar, ['minutely']);
  assert.deepEqual(timer.Unit, ['vitana-github-bridge.service']);
  assert.deepEqual(timer.WantedBy, ['timers.target']);
  assert.match(timer.AccuracySec?.[0] ?? '', /^[1-5]s$/);
  assert.deepEqual(svc.Type, ['oneshot']);
  assert.equal(svc.ExecStart.length, 1);
  const exec = svc.ExecStart[0];
  assert.match(exec, /^\/usr\/bin\/flock --nonblock --conflict-exit-code 75 \/var\/lib\/vitana\/github-bridge\/tick\.lock node \/opt\/vitana\/platform\/scripts\/eng\/github-bridge\.mjs run /);
  assert.ok(exec.includes('--github-token-file %d/github-token') && exec.includes('--gitlab-token-file %d/gitlab-token'), exec);
  assert.ok(!exec.includes('--dry-run'));
  assert.deepEqual(svc.SuccessExitStatus, ['75']);
  assert.deepEqual([...svc.LoadCredential].sort(), ['github-token:/etc/vitana/github-bridge-token', 'gitlab-token:/etc/vitana/gitlab-bridge-token']);
  assert.deepEqual(svc.StateDirectory, ['vitana/github-bridge']);
  assert.ok(Number(svc.Nice?.[0]) > 0, 'Nice');
  assert.match(svc.CPUQuota?.[0] ?? '', /^\d+%$/);
  assert.match(svc.MemoryMax?.[0] ?? '', /^\d+[KMG]$/);
  for (const [k, v] of [['NoNewPrivileges', 'yes'], ['DynamicUser', 'yes'], ['ProtectSystem', 'strict'], ['ProtectHome', 'yes'], ['PrivateTmp', 'yes'], ['PrivateDevices', 'yes']]) {
    assert.deepEqual(svc[k], [v], k);
  }
  assert.ok(existsSync(join(ROOT, 'scripts', 'eng', 'github-bridge.mjs')), 'ExecStart runs a script of this repository');
  for (const text of [timerText, serviceText]) {
    assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{10,}|github_pat_|glpat-|PRIVATE-TOKEN|Authorization/);
    for (const v of (unitKeys(text).Environment ?? [])) assert.doesNotMatch(v, /token|secret|password/i);
  }
});

test('the runbook names the token scopes, where the tokens live, how to read a refused branch, how to stop and start the bridge, and the dry run', () => {
  const rb = readFileSync(join(ROOT, 'infra', 'gitlab-engineering', 'RUNBOOK-github-bridge.md'), 'utf8');
  for (const needle of ['Contents: Read and write', 'Pull requests: Read and write', 'Commit statuses: Read and write', 'Secrets Manager',
    '/etc/vitana/github-bridge-token', '/etc/vitana/gitlab-bridge-token', 'branch_refused', 'systemctl disable --now vitana-github-bridge.timer',
    'systemctl enable --now vitana-github-bridge.timer', '--dry-run', 'assist-push']) {
    assert.ok(rb.includes(needle), needle);
  }
});

// ------------------------------------------------------------------------------------------------- state and CLI
test('state: saved atomically with mode 0600 and loaded back; a missing file is an empty state; a corrupt file is refused', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'github-bridge-state-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const file = join(d, 'state.json');
  assert.deepEqual(loadState(file), emptyState());
  const s = emptyState();
  s.repos[PF.github] = { branches: { 'kiro/x/y': { pushed: 'a'.repeat(40) } }, prs: {} };
  saveState(file, s);
  assert.deepEqual(loadState(file), s);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(d), ['state.json'], 'no temporary file is left');
  writeFileSync(file, '{not json');
  assert.throws(() => loadState(file), /state/);
  writeFileSync(file, JSON.stringify({ schema: 'something-else/v9', repos: {} }));
  assert.throws(() => loadState(file), /schema/);
});

test('CLI: a corrupt state file, a missing token file, an unknown command or option stop with exit 2 before any call', async (t) => {
  const w = world(t);
  mk(w, PF.github, 'kiro/s/a');
  mkdirSync(join(w.dir, 'state'), { recursive: true });
  writeFileSync(join(w.dir, 'state', 'state.json'), '{broken');
  let out = await cli(w, ['run']);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /state/);
  assert.equal(w.f.calls.length, 0);
  rmSync(join(w.dir, 'state', 'state.json'));
  out = await cli(w, ['run', '--github-token-file', join(w.dir, 'nope')]);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /nope/);
  for (const args of [['frobnicate'], ['run', '--frobnicate'], ['run', '--gitlab-url', 'http://gitlab.test'], ['assist-push', '--branch', 'kiro/s/a']]) {
    out = await cli(w, args);
    assert.equal(out.code, 2, args.join(' '));
  }
  assert.equal(w.f.calls.length, 0);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), null);
  out = await cli(w, ['run']);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(headOn(glUrlOf(w, PF), 'kiro/s/a'), branchesOn(ghUrlOf(w, PF))['kiro/s/a']);
  const done = jsonLines(out.stdout).find((l) => l.event === 'tick_done');
  assert.equal(done.errors, 0);
  assert.equal(done.dry_run, false);
  assert.deepEqual(loadState(join(w.dir, 'state', 'state.json')).repos[PF.github].branches['kiro/s/a'].pushed, branchesOn(ghUrlOf(w, PF))['kiro/s/a']);
});

test('CLI assist-push uses the saved state: a bridged branch gets the commit, and a refusal exits 3', async (t) => {
  const w = world(t);
  const a = mk(w, PF.github, 'kiro/s/a');
  assert.equal((await cli(w, ['run'])).code, 0);
  const assist = commitOn(w, PF.github, 'tmp-assist', 'assist', { from: a });
  pushTo(w, PF.github, glUrlOf(w, PF), 'refs/heads/assist/1-i18n', assist);
  let out = await cli(w, ['assist-push', '--repo', PF.github, '--branch', 'kiro/s/other', '--commit', assist, '--from-ref', 'refs/heads/assist/1-i18n']);
  assert.equal(out.code, 3);
  out = await cli(w, ['assist-push', '--repo', PF.github, '--branch', 'kiro/s/a', '--commit', assist, '--from-ref', 'refs/heads/assist/1-i18n']);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(headOn(ghUrlOf(w, PF), 'kiro/s/a'), assist);
  assert.ok(jsonLines(out.stdout).some((l) => l.event === 'assist_pushed'));
});
