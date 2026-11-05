// Tests of the merge queue of the cut (plan agentic-delivery §3.5, lane merge-queue): the queue mode of
// scripts/eng/gitlab-land.mjs. A project whose settings entry has `queue` is landed by a train of up to 8 positions in
// queue order (revert and fix-main first while `main` is red, then the oldest accept); a red `main` pauses the rest; a
// hot-file merge request waits for the previous hot-file STAGING-VERIFY result; plan merge requests land on their own
// gates; each landing's squash message carries the review facts; each queue label is set once per state.
// The git side is real (bare repositories play the GitLab projects; a pre-receive hook records push options); the GitLab
// API is the recording fake fetch of lane gitlab-client, answering like GitLab does for a fast-forward, squash project.
// Dependency-free Node (node:test), so UNIT.yml runs it with no install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeFetch } from './testing/fake-fetch.mjs';
import * as land from './gitlab-land.mjs';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const TOKEN = 'fixture-token-0123456789abcdef';
const REVIEWER = 'agent:vitana-lane-reviewer (claude-sonnet-5.5)';
const BUILDER = 'kiro-exafy-202611050900-aaaa';
const REQUIRED = ['lane-scope', 'gate'];

// ── git helpers ──────────────────────────────────────────────────────────────
const GIT_ENV = {
  ...process.env, GIT_AUTHOR_NAME: 'builder', GIT_AUTHOR_EMAIL: 'builder@test', GIT_COMMITTER_NAME: 'builder', GIT_COMMITTER_EMAIL: 'builder@test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gAt = (cwd, when, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...GIT_ENV, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const tree = (repo, rev) => g(repo, 'rev-parse', `${rev}^{tree}`);
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const HOOK = '#!/bin/sh\nopts=""\ni=0\nwhile [ "$i" -lt "${GIT_PUSH_OPTION_COUNT:-0}" ]; do eval "opts=\\"\\$opts \\$GIT_PUSH_OPTION_$i\\""; i=$((i+1)); done\nwhile read old new ref; do echo "$ref$opts" >> "$GIT_DIR/push.log"; done\nexit 0\n';

function newProject(root, name) {
  const remote = path.join(root, `${name}.git`);
  const work = path.join(root, `${name}-work`);
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { env: GIT_ENV });
  g(remote, 'config', 'receive.advertisePushOptions', 'true');
  fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), HOOK, { mode: 0o755 });
  execFileSync('git', ['clone', '-q', remote, work], { env: GIT_ENV, stdio: 'ignore' });
  g(work, 'checkout', '-q', '-b', 'main');
  write(work, 'README.md', `${name}\n`);
  g(work, 'add', '-A');
  gAt(work, '2026-11-05T08:00:00Z', 'commit', '-q', '-m', 'initial');
  g(work, 'push', '-q', 'origin', 'main');
  return { name, remote, work };
}
const pushLog = (p) => (fs.existsSync(path.join(p.remote, 'push.log')) ? fs.readFileSync(path.join(p.remote, 'push.log'), 'utf8').trim().split('\n').filter(Boolean) : []);
const remoteRefs = (p, prefix) => g(p.remote, 'for-each-ref', '--format=%(refname) %(objectname)', prefix).split('\n').filter(Boolean).map((l) => l.split(' '));

// ── the world: projects, lanes, merge requests ─────────────────────────────────
function newWorld(names = ['vitana-platform']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-queue-'));
  tmpDirs.push(root);
  const W = { root, p: {}, s: {}, minute: 0 };
  for (const name of [...new Set(['vitana-platform', ...names])]) {
    W.p[name] = newProject(root, name);
    W.s[name] = { mrs: [], events: [], pipelines: [], jobs: {}, notes: {}, statuses: {}, variables: {}, down: false, nextId: 100 };
  }
  return W;
}
const laneFile = (lane) => `.kiro/specs/demo/lanes/${lane}.md`;
function onMain(W, name, files, message = 'main moves') {
  const p = W.p[name];
  g(p.work, 'checkout', '-q', 'main');
  for (const [f, t] of Object.entries(files)) write(p.work, f, t);
  g(p.work, 'add', '-A');
  g(p.work, 'commit', '-q', '-m', message);
  g(p.work, 'push', '-q', 'origin', 'main');
  return g(p.work, 'rev-parse', 'HEAD');
}
const addLane = (W, lane) => onMain(W, 'vitana-platform', { [laneFile(lane)]: `---\nlane: ${lane}\nstate: in-review\n---\n# Lane ${lane}\n\n## Log\n` }, `lane ${lane}`);
const titleOf = (lane) => `VTID-05999 (demo/${lane}): add ${lane}`;
function feature(W, name, { lane, files, branch = `kiro/demo/${lane}`, from = 'origin/main' }) {
  const p = W.p[name];
  g(p.work, 'fetch', '-q', 'origin');
  g(p.work, 'checkout', '-q', '-B', branch, from);
  for (const [f, t] of Object.entries(files ?? { [`scripts/demo/${lane}.mjs`]: `export const ${lane.replace(/-/g, '_')} = 1;\n` })) write(p.work, f, t);
  g(p.work, 'add', '-A');
  g(p.work, 'commit', '-q', '-m', `${titleOf(lane)}\n\nCollab-Session: ${BUILDER}\nCollab-Lane: demo/${lane}`);
  return g(p.work, 'rev-parse', 'HEAD');
}
/** A same-repo review commit on the lane branch, pushed by the reviewer account (a project push event). */
function reviewHere(W, name, { lane, branch = `kiro/demo/${lane}`, reviewed, when, verdict = 'accept', reviewer = REVIEWER }) {
  const p = W.p[name];
  g(p.work, 'checkout', '-q', branch);
  const before = g(p.work, 'rev-parse', 'HEAD');
  const session = `agent-vitana-lane-reviewer-20261105${String(1000 + (W.minute += 1))}-abcd`;
  fs.appendFileSync(path.join(p.work, laneFile(lane)), `\n### ${when} · ${session} · review\nreview: ${verdict}\nhead: ${reviewed}\n`);
  g(p.work, 'add', '-A');
  gAt(p.work, when, 'commit', '-q', '-m', `review(demo/${lane}): ${verdict}\n\nCollab-Session: ${session}\nCollab-Review: demo/${lane}\nCollab-Verdict: ${verdict}\nCollab-Reviewer: ${reviewer}\nCollab-Reviewed-Head: ${reviewed}`);
  const R = g(p.work, 'rev-parse', 'HEAD');
  W.s[name].events.unshift({ author_username: 'agent-reviewer', push_data: { commit_from: before, commit_to: R, commit_count: 1, action: 'pushed', ref_type: 'branch' } });
  return R;
}
/** A cross-repo review entry for a vitana-v1 lane, on platform main. */
function reviewInPlatform(W, { lane, reviewed, when, session = 'agent-vitana-lane-reviewer-202611051100-ab12' }) {
  const p = W.p['vitana-platform'];
  g(p.work, 'checkout', '-q', 'main');
  g(p.work, 'pull', '-q', '--ff-only', 'origin', 'main');
  fs.appendFileSync(path.join(p.work, laneFile(lane)), `\n### ${when} · ${session} · review\nreview: accept\nhead: ${reviewed}\n`);
  g(p.work, 'add', '-A');
  gAt(p.work, when, 'commit', '-q', '-m', `review(demo/${lane}): accept\n\nCollab-Session: ${session}\nCollab-Review: demo/${lane}\nCollab-Verdict: accept\nCollab-Reviewer: ${REVIEWER}\nCollab-Reviewed-Head: ${reviewed}`);
  g(p.work, 'push', '-q', 'origin', 'main');
  return g(p.work, 'rev-parse', 'HEAD');
}
const publish = (W, name, branch) => g(W.p[name].work, 'push', '-q', 'origin', `${branch}:refs/heads/${branch}`);
function openMr(W, name, { iid, branch, title, description = `Body of !${iid}.`, createdAt, draft = false }) {
  W.s[name].mrs.push({ iid, title, description, source_branch: branch, target_branch: 'main', labels: [], draft, state: 'opened', created_at: createdAt ?? `2026-11-05T09:${String(iid).padStart(2, '0')}:00Z`, updated_at: '2026-11-05T11:00:00Z' });
  W.s[name].notes[iid] = [];
}
const greenJobs = (status = 'success') => REQUIRED.map((name, i) => ({ name, status, allow_failure: false, started_at: '2026-11-05T11:00:00Z', i }));
function pipeline(W, name, { sha, ref, status = 'success', source = 'push', jobs, createdAt = '2026-11-05T11:00:00Z' }) {
  const s = W.s[name];
  const id = (s.nextId += 1);
  s.pipelines.push({ id, sha, ref, status, source, created_at: createdAt });
  s.jobs[id] = (jobs ?? greenJobs(status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'success')).map((j, i) => ({ id: id * 10 + i, ...j }));
  return id;
}
const mrPipe = (W, name, iid, sha, status = 'success') => pipeline(W, name, { sha, ref: `refs/merge-requests/${iid}/head`, status, source: 'merge_request_event' });
/** CI for the train: a pipeline for every train ref that has none yet; positions in `fail` are red, in `pending` running. */
function ciTrain(W, name, { fail = [], pending = [], createdAt } = {}) {
  for (const [ref, sha] of remoteRefs(W.p[name], 'refs/heads/train/')) {
    const short = ref.replace('refs/heads/', '');
    if (W.s[name].pipelines.some((p) => p.sha === sha && p.ref === short)) continue;
    const k = Number(short.split('/')[1]);
    pipeline(W, name, { sha, ref: short, status: fail.includes(k) ? 'failed' : pending.includes(k) ? 'running' : 'success', ...(createdAt ? { createdAt } : {}) });
  }
}
/** A reviewed, green merge request of a same-repo lane in project `name`. */
function readyLane(W, name, { lane, iid, when, files, from }) {
  if (name === 'vitana-platform') addLane(W, lane);
  const F = feature(W, name, { lane, files, from });
  const R = reviewHere(W, name, { lane, reviewed: F, when });
  publish(W, name, `kiro/demo/${lane}`);
  openMr(W, name, { iid, branch: `kiro/demo/${lane}`, title: titleOf(lane) });
  mrPipe(W, name, iid, R);
  return { lane, iid, F, R, branch: `kiro/demo/${lane}` };
}

// ── the fake GitLab (fast-forward merge method, squash, heads follow pushes like GitLab's) ──
const sha40 = (s) => /^[0-9a-f]{40}$/.test(s || '');
function headOf(W, name, mr) {
  const p = W.p[name];
  let sha = null;
  try { sha = g(p.remote, 'rev-parse', '--verify', '-q', `refs/heads/${mr.source_branch}`); } catch { sha = null; }
  if (sha) { mr.sha = sha; g(p.remote, 'update-ref', `refs/merge-requests/${mr.iid}/head`, sha); }
  return mr.sha;
}
function handle(W, call) {
  const m = /^\/api\/v4\/projects\/vitana%2F([a-z0-9-]+)(\/.*)?$/.exec(call.path);
  const name = m[1];
  const sub = m[2] || '';
  const s = W.s[name];
  const p = W.p[name];
  if (!s) return { status: 404, json: { message: '404 Project Not Found' } };
  if (s.down) return { status: 503, json: { message: 'unavailable' } };
  const q = (k) => call.query[k]?.[0];
  const byIid = (iid) => s.mrs.find((x) => x.iid === Number(iid));
  let mm;
  if (call.method === 'GET' && sub === '') return { json: { id: 1, default_branch: 'main' } };
  if (call.method === 'GET' && sub === '/merge_requests') return { json: s.mrs.filter((x) => x.state === 'opened').map((x) => ({ ...x, sha: headOf(W, name, x), labels: [...x.labels] })) };
  if ((mm = /^\/merge_requests\/(\d+)$/.exec(sub))) {
    const mr = byIid(mm[1]);
    if (call.method === 'GET') return { json: { ...mr, sha: mr.state === 'opened' ? headOf(W, name, mr) : mr.sha, labels: [...mr.labels] } };
    if (call.method === 'PUT') {
      const add = String(call.body.add_labels || '').split(',').filter(Boolean);
      const remove = String(call.body.remove_labels || '').split(',').filter(Boolean);
      mr.labels = [...mr.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !mr.labels.includes(l))];
      return { json: { ...mr, labels: [...mr.labels] } };
    }
  }
  if ((mm = /^\/merge_requests\/(\d+)\/merge$/.exec(sub)) && call.method === 'PUT') {
    const mr = byIid(mm[1]);
    if (s.refuse?.has(mr.iid)) return { status: 405, json: { message: '405 Method Not Allowed' } }; // e.g. an unresolved thread
    const head = headOf(W, name, mr);
    if (call.body.sha !== head) return { status: 409, json: { message: 'SHA does not match HEAD of source branch' } };
    const main = g(p.remote, 'rev-parse', 'refs/heads/main');
    try { g(p.remote, 'merge-base', '--is-ancestor', main, head); } catch { return { status: 406, json: { message: 'Branch cannot be merged' } }; }
    const squash = execFileSync('git', ['-C', p.remote, 'commit-tree', `${head}^{tree}`, '-p', main, '-F', '-'], { input: call.body.squash_commit_message, encoding: 'utf8', env: { ...GIT_ENV, GIT_COMMITTER_NAME: 'bot-land', GIT_AUTHOR_NAME: 'bot-land' } }).trim();
    g(p.remote, 'update-ref', 'refs/heads/main', squash, main);
    if (call.body.should_remove_source_branch) g(p.remote, 'update-ref', '-d', `refs/heads/${mr.source_branch}`);
    mr.state = 'merged';
    mr.merge_commit_sha = squash;
    return { json: { iid: mr.iid, state: 'merged', squash_commit_sha: squash } };
  }
  if ((mm = /^\/merge_requests\/(\d+)\/notes$/.exec(sub))) {
    const mr = byIid(mm[1]);
    if (call.method === 'GET') return { json: [...s.notes[mr.iid]].reverse() };
    s.notes[mr.iid].push({ body: call.body.body, author: { username: 'bot-land' } });
    return { status: 201, json: { id: s.notes[mr.iid].length } };
  }
  if (call.method === 'GET' && sub === '/events') return { json: s.events };
  if (call.method === 'GET' && sub === '/pipelines') {
    return { json: s.pipelines.filter((x) => (!q('sha') || x.sha === q('sha')) && (!q('ref') || x.ref === q('ref'))).sort((a, b) => b.id - a.id) };
  }
  if ((mm = /^\/pipelines\/(\d+)\/jobs$/.exec(sub))) return { json: s.jobs[Number(mm[1])] ?? [] };
  if ((mm = /^\/pipelines\/(\d+)\/variables$/.exec(sub))) return { json: s.variables[Number(mm[1])] ?? [] };
  if (call.method === 'POST' && sub === '/pipeline') {
    const id = (s.nextId += 1);
    s.pipelines.push({ id, sha: g(p.remote, 'rev-parse', `refs/heads/${call.body.ref}`), ref: call.body.ref, status: 'created', source: 'api' });
    s.jobs[id] = [];
    s.variables[id] = call.body.variables;
    return { status: 201, json: { id, status: 'created' } };
  }
  if ((mm = /^\/repository\/commits\/([0-9a-f]{40})\/statuses$/.exec(sub))) return { json: s.statuses[mm[1]] ?? [] };
  throw new Error(`fake GitLab: no route for ${call.method} ${call.path}`);
}
function gitlab(W) {
  const f = fakeFetch();
  f.route('*', /^\/api\/v4\/projects\/vitana%2F[a-z0-9-]+(\/.*)?$/, (call) => handle(W, call));
  return f;
}
function context(W, f, { projects, extra = {}, env } = {}) {
  const tokenFile = path.join(W.root, 'token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const lines = [];
  const ctx = land.makeContext({
    workdir: path.join(W.root, 'land'), 'token-file': tokenFile, url: 'https://gitlab.test',
    projectsOverride: projects ?? [
      { name: 'vitana-platform', path: 'vitana/vitana-platform', landing: true, required_jobs: REQUIRED, queue: { positions: 8 } },
    ],
    remoteUrl: (proj) => W.p[proj.name].remote, services: path.join(W.root, 'services.json'), ...extra,
  }, { fetch: f, now: () => NOW, write: (l) => lines.push(l), ...(env ? { env } : {}) });
  return { ctx, lines, events: () => lines.map((l) => JSON.parse(l)) };
}
async function tickOnce(W, opts = {}) {
  const f = gitlab(W);
  const c = context(W, f, opts);
  if (opts.dryRun) c.ctx.dryRun = true;
  const out = await land.tick(c.ctx, opts.tick);
  return { f, ...c, ...out };
}
const merges = (f) => f.calls.filter((c) => c.method === 'PUT' && /\/merge$/.test(c.path));
const iidOf = (call) => Number(/merge_requests\/(\d+)/.exec(call.path)[1]);
const labelWrites = (f) => f.calls.filter((c) => c.method === 'PUT' && /\/merge_requests\/\d+$/.test(c.path));
const notePosts = (f) => f.calls.filter((c) => c.method === 'POST' && /\/notes$/.test(c.path));
const mrOf = (W, name, iid) => W.s[name].mrs.find((m) => m.iid === iid);
const trainRefs = (W, name = 'vitana-platform') => remoteRefs(W.p[name], 'refs/heads/train/').map(([ref, sha]) => [ref.replace('refs/heads/', ''), sha]);
const mainLog = (W, name = 'vitana-platform') => g(W.p[name].remote, 'log', '--format=%s', 'refs/heads/main').split('\n');
const trailer = (repo, rev, key) => g(repo, 'log', '-1', `--format=%(trailers:key=${key},valueonly)`, rev);

// ── pure functions ───────────────────────────────────────────────────────────
const item = (o) => ({ iid: 1, state: 'ready', fixFirst: false, acceptedAt: '2026-11-05T10:00:00Z', createdAt: '2026-11-05T09:00:00Z', files: [], hot: [], ...o });
test('queueOrder: the oldest accept first; while main is red only revert and fix-main go, first, and the rest are paused', () => {
  const a = item({ iid: 1, acceptedAt: '2026-11-05T10:30:00Z', createdAt: '2026-11-05T08:00:00Z' });
  const b = item({ iid: 2, acceptedAt: '2026-11-05T10:00:00Z', createdAt: '2026-11-05T09:30:00Z' });
  const fix = item({ iid: 3, acceptedAt: '2026-11-05T11:00:00Z', fixFirst: true });
  const revert = item({ iid: 4, acceptedAt: '2026-11-05T10:50:00Z', fixFirst: true });
  const waiting = item({ iid: 5, state: 'waiting', acceptedAt: '2026-11-05T09:00:00Z' });
  const green = land.queueOrder([a, b, fix, revert, waiting], { red: false });
  assert.deepEqual(green.order.map((x) => x.iid), [2, 1, 4, 3], 'the oldest accept, not the oldest merge request');
  assert.deepEqual(green.paused, []);
  const red = land.queueOrder([a, b, fix, revert, waiting], { red: true });
  assert.deepEqual(red.order.map((x) => x.iid), [4, 3], 'revert and fix-main first, by their accept');
  assert.deepEqual(red.paused.map((x) => x.iid).sort(), [1, 2], 'red main pauses the rest (a waiting one keeps waiting)');
  const tie = land.queueOrder([item({ iid: 9, createdAt: '2026-11-05T09:10:00Z' }), item({ iid: 8, createdAt: '2026-11-05T09:10:00Z' }), item({ iid: 7, createdAt: '2026-11-05T09:20:00Z' })], {});
  assert.deepEqual(tie.order.map((x) => x.iid), [8, 9, 7], 'same accept time: the older merge request, then the lower iid');
});

test('fixFirst names the revert and fix-main lanes; mainRed reads the newest finished landing pipeline of main', () => {
  for (const k of ['demo/revert', 'demo/revert-05999', 'demo/fix-main', 'demo/fix-main-2']) assert.equal(land.fixFirst(k), true, k);
  for (const k of ['demo/web-a', 'demo/reverted', 'demo/fixmain', 'demo/a-fix-main', null, '']) assert.equal(land.fixFirst(k), false, String(k));
  const p = (id, status, source = 'push') => ({ id, status, source });
  assert.equal(land.mainRed([]).red, false);
  assert.equal(land.mainRed([p(3, 'failed'), p(2, 'success')]).red, true);
  assert.equal(land.mainRed([p(4, 'running'), p(3, 'failed')]).red, true, 'a running pipeline does not clear red');
  assert.equal(land.mainRed([p(4, 'success'), p(3, 'failed')]).red, false, 'a newer green landing clears red');
  assert.equal(land.mainRed([p(5, 'failed', 'schedule'), p(4, 'success')]).red, false, 'the nightly is not a landing');
  assert.equal(land.mainRed([p(5, 'canceled'), p(4, 'success')]).red, false);
  assert.equal(land.mainRed([p(2, 'success'), p(3, 'failed')]).red, true, 'by id, in any order');
});

test('hotKeys: the hot files of collaboration.md §8a item 4, i18n shards by namespace', () => {
  assert.deepEqual(land.hotKeys(['supabase/migrations/20261105_x.sql', 'database/migrations/001.sql']), ['migrations']);
  assert.deepEqual(land.hotKeys(['DATABASE_SCHEMA.md', 'src/App.tsx', 'CLAUDE.md', 'apps/mobile/parity/ledger.json']).sort(), ['CLAUDE.md', 'DATABASE_SCHEMA.md', 'apps/mobile/parity/ledger.json', 'src/App.tsx']);
  assert.deepEqual(land.hotKeys(['src/navigation/registry/screens.json', 'src/navigation/registry/exclusions.json']), ['navigation-registry']);
  assert.deepEqual(land.hotKeys(['src/i18n/de/admin.json', 'src/i18n/en/admin.json', 'src/i18n/de/apply.json']), ['i18n:admin', 'i18n:apply']);
  assert.deepEqual(land.hotKeys(['src/i18n/index.ts', 'src/pages/App.tsx', 'scripts/eng/x.mjs', 'docs/migrations.md']), []);
});

test('labelChange sets exactly one queue label, once per state, and leaves other labels alone', () => {
  assert.deepEqual(land.labelChange([], 'queue-ready'), { add_labels: 'queue-ready' });
  assert.equal(land.labelChange(['queue-ready', 'frontend'], 'queue-ready'), null, 'already in that state: no write');
  assert.deepEqual(land.labelChange(['queue-waiting', 'frontend'], 'queue-ready'), { add_labels: 'queue-ready', remove_labels: 'queue-waiting' });
  assert.deepEqual(land.labelChange(['queue-ready', 'queue-paused'], 'queue-ready'), { remove_labels: 'queue-paused' });
  assert.deepEqual(land.labelChange(['queue-blocked'], null), { remove_labels: 'queue-blocked' }, 'a draft has no queue label');
  assert.equal(land.labelChange(['frontend'], null), null);
  assert.deepEqual([...land.QUEUE_LABELS], ['queue-ready', 'queue-updating', 'queue-waiting', 'queue-blocked', 'queue-paused']);
});

test('queueSquashMessage starts with the VTID and ends with the six trailers git reads as trailers; a plan merge request has two', () => {
  const mr = { iid: 7, title: '  VTID-05999 (demo/lane-a):   add  ', description: 'Body.\r\n\r\nFixes: nothing', source_branch: 'kiro/demo/lane-a' };
  const accept = { reviewedHead: 'b'.repeat(40), reviewer: REVIEWER, acceptedAt: '2026-11-05T10:01:00.000Z' };
  const msg = land.queueSquashMessage(mr, accept);
  assert.equal(msg.split('\n')[0], 'VTID-05999 (demo/lane-a): add');
  assert.ok(msg.endsWith([
    'Merge-Request: !7', 'Source-Branch: kiro/demo/lane-a', `Reviewed-Head: ${'b'.repeat(40)}`, 'Review-Verdict: accept', `Reviewer: ${REVIEWER}`, 'Accepted-At: 2026-11-05T10:01:00.000Z',
  ].join('\n')), msg);
  const parsed = execFileSync('git', ['interpret-trailers', '--parse'], { input: msg, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(parsed.map((l) => l.split(':')[0]), ['Merge-Request', 'Source-Branch', 'Reviewed-Head', 'Review-Verdict', 'Reviewer', 'Accepted-At'], 'the description\'s own trailer-like line is not the trailer block');
  assert.match(msg, /Body\.\n\nFixes: nothing\n\nMerge-Request/);
  const plan = land.queueSquashMessage({ iid: 9, title: 'plan(demo): the plan', description: '', source_branch: 'kiro/demo/plan' }, null);
  assert.equal(plan, 'plan(demo): the plan\n\nMerge-Request: !9\nSource-Branch: kiro/demo/plan');
});

test('trainSelect: up to the position count, in queue order; one merge request per hot key; overlapping files wait; nothing behind a governance file', () => {
  const it = (iid, files, hot = []) => item({ iid, files, hot });
  const order = [it(1, ['a']), it(2, ['b'], ['migrations']), it(3, ['c'], ['migrations']), it(4, ['a', 'd']), it(5, ['e']), it(6, ['f'])];
  assert.deepEqual(land.trainSelect(order, { capacity: 8 }).map((x) => x.iid), [1, 2, 5, 6], 'the second migration and the overlap wait');
  assert.deepEqual(land.trainSelect(order, { capacity: 2 }).map((x) => x.iid), [1, 2]);
  assert.deepEqual(land.trainSelect(order, { capacity: 8, kept: [it(1, ['a'])] }).map((x) => x.iid), [2, 5, 6], 'kept positions count as ahead');
  const gov = [it(1, ['a']), it(2, ['.github/workflows/X.yml']), it(3, ['c'])];
  assert.deepEqual(land.trainSelect(gov, { capacity: 8 }).map((x) => x.iid), [1, 2], 'a merge request behind a governance change would lose its review');
  assert.deepEqual(land.trainSelect([], { capacity: 8 }), []);
});

test('planSparVerdict and planGate: approved, a sparring_record and a successful gitlab/plan-spar or PLAN-SPAR status from a trusted account', () => {
  const st = (name, status, user = 'bot-land', id = 1) => ({ id, name, status, author: { username: user }, created_at: `2026-11-05T10:0${id}:00Z` });
  const users = ['bot-land'];
  assert.equal(land.planSparVerdict([st('gitlab/plan-spar', 'success')], { users }).state, 'pass');
  assert.equal(land.planSparVerdict([st('PLAN-SPAR', 'success')], { users }).state, 'pass');
  assert.equal(land.planSparVerdict([st('PLAN-SPAR', 'success', 'agent-kiro-exafy')], { users }).state, 'pending', 'a status anyone could post does not count');
  assert.equal(land.planSparVerdict([st('PLAN-SPAR', 'success', 'bot-land', 1), st('PLAN-SPAR', 'failed', 'bot-land', 2)], { users }).state, 'fail', 'the last run decides');
  assert.equal(land.planSparVerdict([st('PLAN-SPAR', 'failed', 'bot-land', 1), st('PLAN-SPAR', 'success', 'bot-land', 2)], { users }).state, 'pass');
  assert.equal(land.planSparVerdict([st('PLAN-SPAR', 'running')], { users }).state, 'pending');
  assert.equal(land.planSparVerdict([st('other', 'success')], { users }).state, 'pending');
  const handoff = (state, record = '.kiro/specs/demo/sparring/verdict.md') => `---\nslug: demo\nstate: ${state}\n${record ? `sparring_record: ${record}\n` : ''}---\n# Handoff\n`;
  const files = ['.kiro/specs/demo/plan.md', '.kiro/specs/demo/handoff.md', 'docs/programs/standalone/program.md'];
  assert.equal(land.planGate({ slug: 'demo', files, handoffText: handoff('approved') }).state, 'pass');
  assert.equal(land.planGate({ slug: 'demo', files, handoffText: handoff('drafted') }).state, 'pending');
  assert.equal(land.planGate({ slug: 'demo', files, handoffText: handoff('approved', '') }).state, 'pending');
  assert.equal(land.planGate({ slug: 'demo', files, handoffText: handoff('parked') }).code, 'plan_parked');
  assert.equal(land.planGate({ slug: 'demo', files, handoffText: null }).state, 'pending');
  const scope = land.planGate({ slug: 'demo', files: [...files, 'scripts/x.mjs', '.kiro/specs/other/plan.md'], handoffText: handoff('approved') });
  assert.equal(scope.code, 'plan_scope');
  assert.match(scope.reason, /scripts\/x\.mjs/);
});

test('a train position needs the checks and gate, not the governance jobs that judge one merge request', async () => {
  assert.deepEqual(land.trainRequiredJobs({ required_jobs: ['lane-scope', 'collab-handoff', 'change-suite', 'gate'] }), ['gate']);
  assert.deepEqual(land.trainRequiredJobs({ required_jobs: ['lane-scope', 'gate'], train_required_jobs: ['gate', 'full'] }), ['gate', 'full']);
  const gateOnly = (name) => [{ name, status: 'success', allow_failure: false, started_at: '2026-11-05T11:00:00Z' }];
  // the governance jobs run on each merge request's own head (scopeCheck refuses a range of two lanes); a train ref runs gate
  const { W } = threeReady();
  await tickOnce(W);
  for (const [ref, sha] of trainRefs(W)) pipeline(W, 'vitana-platform', { sha, ref, jobs: gateOnly('gate') });
  const r = await tickOnce(W);
  assert.deepEqual(merges(r.f).map((m) => Number(/merge_requests\/(\d+)\/merge/.exec(m.path)[1])), [8, 7, 9]);
  // a finished train pipeline without gate is not green: nothing lands
  const { W: W2 } = threeReady();
  await tickOnce(W2);
  for (const [ref, sha] of trainRefs(W2)) pipeline(W2, 'vitana-platform', { sha, ref, jobs: gateOnly('lane-scope') });
  const r2 = await tickOnce(W2);
  assert.equal(merges(r2.f).length, 0);
  assert.deepEqual(mrOf(W2, 'vitana-platform', 8).labels, ['queue-blocked'], 'position 1 failed closed and was dropped');
});

test('loadProjects reads the queue setting; normalizeQueue allows 1 to 12 positions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-q-settings-')); tmpDirs.push(dir);
  const file = path.join(dir, 's.json');
  fs.writeFileSync(file, JSON.stringify({ group: 'vitana', projects: { 'vitana-platform': { landing: true, required_jobs: ['gate'], queue: true }, rehearsal: { landing: true }, 'vitana-v1': { landing: true, queue: { positions: 4 } } } }));
  assert.deepEqual(land.loadProjects(file), [
    { name: 'vitana-platform', path: 'vitana/vitana-platform', landing: true, required_jobs: ['gate'], queue: { positions: 8 } },
    { name: 'rehearsal', path: 'vitana/rehearsal', landing: true, required_jobs: [] },
    { name: 'vitana-v1', path: 'vitana/vitana-v1', landing: true, required_jobs: [], queue: { positions: 4 } },
  ]);
  assert.deepEqual(land.normalizeQueue({ positions: 12 }), { positions: 12 });
  for (const bad of [{ positions: 0 }, { positions: 13 }, { positions: 2.5 }, 'yes', []]) assert.throws(() => land.normalizeQueue(bad), /queue/);
});

test('queue mode is on for the two projects of the cut by name (the settings schema has no queue key), off for any other project; an explicit setting wins', async () => {
  assert.deepEqual([...land.DEFAULTS.queueProjects], ['vitana-platform', 'vitana-v1']);
  const ctx = { queueProjects: land.DEFAULTS.queueProjects };
  assert.deepEqual(land.queueSetting({ name: 'vitana-platform', landing: true, required_jobs: ['gate'] }, ctx), { positions: 8 });
  assert.deepEqual(land.queueSetting({ name: 'vitana-v1', landing: true, required_jobs: [] }, ctx), { positions: 8 });
  assert.equal(land.queueSetting({ name: 'rehearsal', landing: true, required_jobs: ['unit'] }, ctx), null, 'M2\'s rehearsal project keeps the one-at-a-time loop');
  assert.deepEqual(land.queueSetting({ name: 'rehearsal', queue: { positions: 3 } }, ctx), { positions: 3 });
  assert.deepEqual(land.queueSetting({ name: 'vitana-v1', queue: { positions: 12 } }, ctx), { positions: 12 });
  assert.equal(land.queueSetting({ name: 'vitana-v1', queue: false }, ctx), null);
  assert.equal(land.queueSetting({ name: 'vitana-v1' }, { queueProjects: [] }), null);
  // makeContext: the default list, or --queue-projects (comma-separated; empty = none)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-q-names-')); tmpDirs.push(dir);
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const mk = (o = {}) => land.makeContext({ 'token-file': tokenFile, workdir: path.join(dir, 'land'), projectsOverride: [], ...o }, { fetch: fakeFetch(), write: () => {} });
  assert.deepEqual(mk().queueProjects, ['vitana-platform', 'vitana-v1']);
  assert.deepEqual(mk({ 'queue-projects': 'vitana-v1' }).queueProjects, ['vitana-v1']);
  assert.deepEqual(mk({ 'queue-projects': '' }).queueProjects, []);
  // a project entry without a queue key, as the settings loaders return it: the tick runs the train for vitana-platform
  const { W } = threeReady();
  const r = await tickOnce(W, { projects: [{ name: 'vitana-platform', path: 'vitana/vitana-platform', landing: true, required_jobs: REQUIRED }] });
  assert.equal(r.failed, false);
  assert.deepEqual(trainRefs(W).map(([ref]) => ref), ['train/1', 'train/2', 'train/3']);
});

// ── the train, with real git and the fake GitLab ─────────────────────────────
function threeReady() {
  const W = newWorld();
  const a = readyLane(W, 'vitana-platform', { lane: 'lane-a', iid: 7, when: '2026-11-05T10:20:00Z' });
  const b = readyLane(W, 'vitana-platform', { lane: 'lane-b', iid: 8, when: '2026-11-05T10:10:00Z' });
  const c = readyLane(W, 'vitana-platform', { lane: 'lane-c', iid: 9, when: '2026-11-05T10:30:00Z' });
  return { W, a, b, c };
}

test('the train: positions train/1..k in queue order, each the merge of main and the first k merge requests; queue labels set once', async () => {
  const { W, a, b, c } = threeReady();
  const main0 = g(W.p['vitana-platform'].remote, 'rev-parse', 'refs/heads/main');
  const r = await tickOnce(W);
  assert.equal(r.failed, false, JSON.stringify(r.events().filter((e) => /failed/.test(e.event))));
  assert.equal(merges(r.f).length, 0, 'no landing before the train is green');
  const refs = Object.fromEntries(trainRefs(W));
  assert.deepEqual(Object.keys(refs).sort(), ['train/1', 'train/2', 'train/3']);
  const remote = W.p['vitana-platform'].remote;
  const parents = (sha) => g(remote, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);
  assert.deepEqual(parents(refs['train/1']), [main0, b.R], 'position 1: main and the oldest accept (lane-b)');
  assert.deepEqual(parents(refs['train/2']), [refs['train/1'], a.R], 'position 2: position 1 and lane-a');
  assert.deepEqual(parents(refs['train/3']), [refs['train/2'], c.R]);
  for (const f of ['scripts/demo/lane-a.mjs', 'scripts/demo/lane-b.mjs', 'scripts/demo/lane-c.mjs']) g(remote, 'cat-file', '-e', `${refs['train/3']}:${f}`);
  assert.ok(pushLog(W.p['vitana-platform']).filter((l) => l.startsWith('refs/heads/train/')).every((l) => !l.includes('ci.skip')), 'train refs run their pipelines');
  assert.deepEqual([7, 8, 9].map((iid) => mrOf(W, 'vitana-platform', iid).labels), [['queue-ready'], ['queue-ready'], ['queue-ready']]);
  assert.equal(labelWrites(r.f).length, 3);
  const again = await tickOnce(W);
  assert.equal(labelWrites(again.f).length, 0, 'each queue label is set once per state');
  assert.deepEqual(Object.fromEntries(trainRefs(W)), refs, 'a train that is still valid is not rebuilt');
  assert.equal(merges(again.f).length, 0);
});

test('lands merge request k only when its position is green and every earlier position has landed; main merged in with ci.skip; the tree on main is the tested tree', async () => {
  const { W, a, b, c } = threeReady();
  await tickOnce(W);
  const tested = Object.fromEntries(trainRefs(W).map(([ref, sha]) => [ref, tree(W.p['vitana-platform'].remote, sha)]));
  ciTrain(W, 'vitana-platform', { pending: [1] });
  const r1 = await tickOnce(W);
  assert.equal(merges(r1.f).length, 0, 'position 2 and 3 are green, but position 1 is still running');
  W.s['vitana-platform'].pipelines.find((p) => p.ref === 'train/1').status = 'success';
  for (const j of W.s['vitana-platform'].jobs[W.s['vitana-platform'].pipelines.find((p) => p.ref === 'train/1').id]) j.status = 'success';
  const mark = pushLog(W.p['vitana-platform']).length;
  const r2 = await tickOnce(W);
  assert.deepEqual(merges(r2.f).map((m) => Number(/merge_requests\/(\d+)\/merge/.exec(m.path)[1])), [8, 7, 9], 'in queue order, one at a time');
  const remote = W.p['vitana-platform'].remote;
  const mainShas = g(remote, 'rev-list', '--first-parent', 'refs/heads/main', '-n', '3').split('\n').reverse();
  assert.deepEqual(mainShas.map((s) => tree(remote, s)), [tested['train/1'], tested['train/2'], tested['train/3']], 'every state of main is a tested tree');
  assert.deepEqual(mainLog(W).slice(0, 3), [titleOf('lane-c'), titleOf('lane-a'), titleOf('lane-b')]);
  const updates = pushLog(W.p['vitana-platform']).slice(mark).filter((l) => /^refs\/heads\/kiro\//.test(l));
  assert.ok(updates.length >= 2, `lane-a and lane-c were behind main after the first landing: ${updates.join(' | ')}`);
  assert.ok(updates.every((l) => l.endsWith(' ci.skip')), 'the update merge of main skips its pipeline');
  const landedA = mainShas[1];
  assert.equal(trailer(remote, landedA, 'Merge-Request'), '!7');
  assert.equal(trailer(remote, landedA, 'Source-Branch'), 'kiro/demo/lane-a');
  assert.equal(trailer(remote, landedA, 'Reviewed-Head'), a.F);
  assert.equal(trailer(remote, landedA, 'Review-Verdict'), 'accept');
  assert.equal(trailer(remote, landedA, 'Reviewer'), REVIEWER);
  assert.equal(trailer(remote, landedA, 'Accepted-At'), '2026-11-05T10:20:00.000Z');
  assert.deepEqual(trainRefs(W), [], 'the train refs are gone after the cycle');
  assert.ok(b && c);
});

test('a failed position drops its merge request (one comment, queue-blocked) and the positions behind it are rebuilt without it', async () => {
  const { W } = threeReady();
  await tickOnce(W);
  const before = Object.fromEntries(trainRefs(W));
  ciTrain(W, 'vitana-platform', { fail: [2] });
  const r = await tickOnce(W);
  assert.deepEqual(merges(r.f).map((m) => /merge_requests\/(\d+)/.exec(m.path)[1]), ['8'], 'position 1 lands; position 2 failed');
  assert.deepEqual(mrOf(W, 'vitana-platform', 7).labels, ['queue-blocked']);
  assert.equal(W.s['vitana-platform'].notes[7].length, 1);
  assert.match(W.s['vitana-platform'].notes[7][0].body, /failed in the landing train/);
  const after = Object.fromEntries(trainRefs(W));
  assert.deepEqual(Object.keys(after), ['train/1'], 'the cycle ended (1 landed, 2 dropped): lane-c is rebuilt as position 1 of the next one; train/2 and train/3 are gone');
  assert.notEqual(after['train/1'], before['train/1']);
  const remote = W.p['vitana-platform'].remote;
  assert.deepEqual(g(remote, 'rev-list', '--parents', '-n', '1', after['train/1']).split(' ').slice(1), [g(remote, 'rev-parse', 'refs/heads/main'), g(remote, 'rev-parse', 'refs/heads/kiro/demo/lane-c')], 'main (with lane-b landed) and lane-c, without lane-a');
  ciTrain(W, 'vitana-platform');
  const r2 = await tickOnce(W);
  assert.deepEqual(merges(r2.f).map((m) => /merge_requests\/(\d+)/.exec(m.path)[1]), ['9']);
  assert.equal(notePosts(r2.f).length, 0, 'the drop is explained once per head');
  assert.equal(mrOf(W, 'vitana-platform', 7).state, 'opened', 'the dropped merge request is back with its builder');
});

test('a conflicting position (a file where another adds a directory) is dropped with one comment; the next merge request takes the position', async () => {
  const W = newWorld();
  readyLane(W, 'vitana-platform', { lane: 'lane-a', iid: 7, when: '2026-11-05T10:10:00Z', files: { 'docs/thing': 'a file\n' } });
  readyLane(W, 'vitana-platform', { lane: 'lane-b', iid: 8, when: '2026-11-05T10:20:00Z', files: { 'docs/thing/inner.md': 'in a directory\n' } });
  readyLane(W, 'vitana-platform', { lane: 'lane-c', iid: 9, when: '2026-11-05T10:30:00Z' });
  const r = await tickOnce(W);
  assert.deepEqual(trainRefs(W).map(([ref]) => ref), ['train/1', 'train/2']);
  const remote = W.p['vitana-platform'].remote;
  assert.equal(g(remote, 'rev-list', '--parents', '-n', '1', 'refs/heads/train/2').split(' ')[2], g(remote, 'rev-parse', 'refs/heads/kiro/demo/lane-c'));
  assert.deepEqual(mrOf(W, 'vitana-platform', 8).labels, ['queue-blocked']);
  assert.match(W.s['vitana-platform'].notes[8][0].body, /conflicts with a merge request ahead of it/);
  assert.equal(notePosts(r.f).length, 1);
});

test('a merge request whose merge of main conflicts is skipped with one comment, and the younger ones go on in the same tick (M2\'s conflict rule, in queue mode)', async () => {
  const W = newWorld();
  readyLane(W, 'vitana-platform', { lane: 'lane-a', iid: 7, when: '2026-11-05T10:10:00Z', files: { 'docs/shared.md': 'from lane-a\n' } });
  onMain(W, 'vitana-platform', { 'docs/shared.md': 'from main\n' }, 'main changes the same file');
  readyLane(W, 'vitana-platform', { lane: 'lane-b', iid: 8, when: '2026-11-05T10:20:00Z' });
  const r1 = await tickOnce(W);
  assert.equal(r1.failed, false);
  assert.deepEqual(mrOf(W, 'vitana-platform', 7).labels, ['queue-blocked'], 'the older merge request is skipped, not waited for');
  assert.equal(W.s['vitana-platform'].notes[7].length, 1);
  assert.match(W.s['vitana-platform'].notes[7][0].body, /merging `main` into this branch conflicts/);
  const remote = W.p['vitana-platform'].remote;
  assert.deepEqual(trainRefs(W).map(([ref]) => ref), ['train/1'], 'the younger one takes position 1 in the same tick');
  assert.equal(g(remote, 'rev-list', '--parents', '-n', '1', 'refs/heads/train/1').split(' ')[2], g(remote, 'rev-parse', 'refs/heads/kiro/demo/lane-b'));
  ciTrain(W, 'vitana-platform');
  const r2 = await tickOnce(W);
  assert.deepEqual(merges(r2.f).map(iidOf), [8]);
  assert.equal(notePosts(r2.f).length, 0, 'the conflict is not commented twice');
  assert.equal(mrOf(W, 'vitana-platform', 7).state, 'opened');
});

test('a position whose merge GitLab keeps refusing holds the train for at most 60 minutes from its pipeline\'s creation; then it is dropped and the positions behind it are rebuilt without it', async () => {
  const { W } = threeReady(); // queue order: !8 (lane-b), !7 (lane-a), !9 (lane-c)
  await tickOnce(W);
  ciTrain(W, 'vitana-platform', { createdAt: '2026-11-05T11:30:00Z' }); // 30 minutes before NOW
  W.s['vitana-platform'].refuse = new Set([8]);
  const r1 = await tickOnce(W);
  assert.deepEqual(merges(r1.f).map(iidOf), [8], 'GitLab refuses position 1; nothing behind it lands');
  assert.deepEqual(trainRefs(W).map(([ref]) => ref), ['train/1', 'train/2', 'train/3'], 'within 60 minutes the train keeps its positions');
  assert.equal(notePosts(r1.f).length, 0);
  assert.deepEqual(mrOf(W, 'vitana-platform', 8).labels, ['queue-ready'], 'still in the train; tried again at the next tick');
  for (const p of W.s['vitana-platform'].pipelines) if (p.ref.startsWith('train/')) p.created_at = '2026-11-05T10:30:00Z'; // 90 minutes
  const r2 = await tickOnce(W);
  assert.deepEqual(merges(r2.f).map(iidOf), [8], 'one more try, refused again');
  assert.ok(r2.events().some((e) => e.event === 'train_dropped' && e.mr === 8 && e.reason === 'merge_refused_too_long'));
  assert.deepEqual(mrOf(W, 'vitana-platform', 8).labels, ['queue-blocked']);
  assert.equal(W.s['vitana-platform'].notes[8].length, 1);
  assert.match(W.s['vitana-platform'].notes[8][0].body, /refused the merge/);
  const remote = W.p['vitana-platform'].remote;
  const refs = Object.fromEntries(trainRefs(W));
  assert.deepEqual(Object.keys(refs), ['train/1', 'train/2'], 'rebuilt without it: lane-a and lane-c');
  assert.deepEqual(g(remote, 'rev-list', '--parents', '-n', '1', refs['train/1']).split(' ').slice(1), [g(remote, 'rev-parse', 'refs/heads/main'), g(remote, 'rev-parse', 'refs/heads/kiro/demo/lane-a')]);
  ciTrain(W, 'vitana-platform');
  const r3 = await tickOnce(W);
  assert.deepEqual(merges(r3.f).map(iidOf), [7, 9]);
  assert.equal(notePosts(r3.f).length, 0, 'the drop is explained once per head');
});

test('a merge request dropped in the tick in which the bot merged main into it stays out for the head the bot made, with one comment', async () => {
  const { W } = threeReady(); // !8 (lane-b) is behind main: landing it first merges main into it (ci.skip)
  await tickOnce(W);
  ciTrain(W, 'vitana-platform', { createdAt: '2026-11-05T10:30:00Z' }); // 90 minutes before NOW: the first refusal is past the bound
  W.s['vitana-platform'].refuse = new Set([8]);
  const before = g(W.p['vitana-platform'].remote, 'rev-parse', 'refs/heads/kiro/demo/lane-b');
  const r1 = await tickOnce(W);
  assert.deepEqual(merges(r1.f).map(iidOf), [8]);
  const updated = g(W.p['vitana-platform'].remote, 'rev-parse', 'refs/heads/kiro/demo/lane-b');
  assert.notEqual(updated, before, 'main was merged into lane-b in this tick');
  assert.deepEqual(mrOf(W, 'vitana-platform', 8).labels, ['queue-blocked']);
  assert.equal(W.s['vitana-platform'].notes[8].length, 1);
  assert.ok(W.s['vitana-platform'].notes[8][0].body.includes(`vitana-land:merge_refused_too_long:${updated}`), 'the comment is for the head the merge request has now');
  const r2 = await tickOnce(W);
  assert.deepEqual(mrOf(W, 'vitana-platform', 8).labels, ['queue-blocked'], 'still out: its head is the one it was dropped with');
  assert.equal(notePosts(r2.f).length, 0, 'no second comment');
  assert.equal(trainRefs(W).some(([, sha]) => g(W.p['vitana-platform'].remote, 'rev-list', '--parents', '-n', '1', sha).split(' ')[2] === updated), false, 'not back in the train');
});

test('every git command of a queue tick starts with -c credential.helper=, as M2\'s bot does, so no configured helper can store the token', async () => {
  const { W } = threeReady();
  const bin = path.join(W.root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(W.root, 'git-calls.log');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // a recording `git` in front of the real one, for the commands the bot runs with its git environment (as in gitlab-land.test.mjs)
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\037' "$@" >> "${log}"\nprintf '\\036' >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  await tickOnce(W, { env }); // clones, fetches, builds the train (merge-tree, commit-tree), lists and pushes train refs
  ciTrain(W, 'vitana-platform');
  const r = await tickOnce(W, { env }); // lands: merges main into the branches behind (merge-tree, commit-tree, push -o ci.skip), fetches main
  assert.deepEqual(merges(r.f).map(iidOf), [8, 7, 9]);
  const calls = fs.readFileSync(log, 'utf8').split('\u001e').filter(Boolean).map((rec) => rec.split('\u001f').slice(0, -1));
  assert.ok(calls.length >= 20, `commands recorded: ${calls.length}`);
  for (const argv of calls) assert.deepEqual(argv.slice(0, 2), ['-c', 'credential.helper='], `git ${argv.join(' ').slice(0, 80)} starts with the flag`);
  const verbs = new Set(calls.map((argv) => argv.find((a, i) => i >= 2 && !a.startsWith('-') && argv[i - 1] !== '-C')));
  for (const verb of ['init', 'fetch', 'merge-tree', 'commit-tree', 'ls-remote', 'push', 'rev-parse']) assert.ok(verbs.has(verb), `git ${verb} was run (seen: ${[...verbs].join(' ')})`);
});

test('the update\'s tree must equal the tested tree: a mismatch lands nothing and rebuilds the train; so does main moved by someone else', async () => {
  const { W } = threeReady();
  await tickOnce(W);
  ciTrain(W, 'vitana-platform');
  const stateFile = path.join(W.root, 'land', 'vitana-platform.train.json');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  st.positions[0].tree = '0'.repeat(40);
  fs.writeFileSync(stateFile, JSON.stringify(st));
  const r = await tickOnce(W);
  assert.equal(merges(r.f).length, 0);
  assert.ok(r.events().some((e) => e.event === 'train_tree_mismatch'));
  const rebuilt = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(rebuilt.positions[0].tree, tree(W.p['vitana-platform'].remote, 'refs/heads/train/1'), 'rebuilt on the current main, with the tree it really has');
  // main moves outside the bot (the owner merges a protected file): the whole train is rebuilt, nothing lands
  ciTrain(W, 'vitana-platform');
  const tip = onMain(W, 'vitana-platform', { 'docs/owner.md': 'owner\n' }, 'the owner merges something');
  const r2 = await tickOnce(W);
  assert.equal(merges(r2.f).length, 0);
  const remote = W.p['vitana-platform'].remote;
  assert.equal(g(remote, 'rev-list', '--parents', '-n', '1', 'refs/heads/train/1').split(' ')[1], tip, 'position 1 starts from the new main');
});

test('a red main pauses the rest (queue-paused); a fix-main lane lands first; landing resumes when main is green', async () => {
  const W = newWorld();
  readyLane(W, 'vitana-platform', { lane: 'lane-a', iid: 7, when: '2026-11-05T10:10:00Z' });
  const main0 = g(W.p['vitana-platform'].remote, 'rev-parse', 'refs/heads/main');
  pipeline(W, 'vitana-platform', { sha: main0, ref: 'main', status: 'failed' });
  readyLane(W, 'vitana-platform', { lane: 'fix-main', iid: 8, when: '2026-11-05T10:40:00Z' });
  const r = await tickOnce(W);
  assert.deepEqual(mrOf(W, 'vitana-platform', 7).labels, ['queue-paused']);
  assert.deepEqual(trainRefs(W).map(([ref]) => ref), ['train/1']);
  const remote = W.p['vitana-platform'].remote;
  assert.equal(g(remote, 'rev-list', '--parents', '-n', '1', 'refs/heads/train/1').split(' ')[2], g(remote, 'rev-parse', 'refs/heads/kiro/demo/fix-main'), 'only the fix is in the train');
  ciTrain(W, 'vitana-platform');
  const r2 = await tickOnce(W);
  assert.deepEqual(merges(r2.f).map((m) => /merge_requests\/(\d+)/.exec(m.path)[1]), ['8'], 'the fix lands while main is red');
  assert.equal(merges(r2.f).some((m) => /merge_requests\/7\//.test(m.path)), false);
  assert.deepEqual(mrOf(W, 'vitana-platform', 7).labels, ['queue-paused'], 'still paused until main is green again');
  pipeline(W, 'vitana-platform', { sha: g(remote, 'rev-parse', 'refs/heads/main'), ref: 'main', status: 'success' });
  await tickOnce(W);
  assert.deepEqual(mrOf(W, 'vitana-platform', 7).labels, ['queue-ready']);
  assert.deepEqual(trainRefs(W).map(([ref]) => ref), ['train/1']);
  assert.ok(r);
});

test('a hot-file merge request waits until the previous hot-file landing has its STAGING-VERIFY result', async () => {
  const W = newWorld();
  const prev = onMain(W, 'vitana-platform', { 'supabase/migrations/20261105090000_first.sql': 'select 1;\n' }, 'VTID-05990 (demo/old): first migration');
  const verify = pipeline(W, 'vitana-platform', { sha: prev, ref: 'main', status: 'running', jobs: [{ name: 'full-suite', status: 'success' }, { name: 'staging-verify', status: 'running' }] });
  readyLane(W, 'vitana-platform', { lane: 'lane-m', iid: 7, when: '2026-11-05T10:10:00Z', files: { 'supabase/migrations/20261105100000_second.sql': 'select 2;\n' } });
  readyLane(W, 'vitana-platform', { lane: 'lane-a', iid: 8, when: '2026-11-05T10:20:00Z' });
  await tickOnce(W);
  assert.deepEqual(mrOf(W, 'vitana-platform', 7).labels, ['queue-waiting']);
  const remote = W.p['vitana-platform'].remote;
  assert.deepEqual(trainRefs(W).map(([ref]) => ref), ['train/1'], 'the other merge request does not wait for it');
  assert.equal(g(remote, 'rev-list', '--parents', '-n', '1', 'refs/heads/train/1').split(' ')[2], g(remote, 'rev-parse', 'refs/heads/kiro/demo/lane-a'));
  for (const j of W.s['vitana-platform'].jobs[verify]) j.status = 'success';
  W.s['vitana-platform'].pipelines.find((p) => p.id === verify).status = 'success';
  await tickOnce(W);
  assert.deepEqual(mrOf(W, 'vitana-platform', 7).labels, ['queue-ready'], 'the result exists now');
  assert.deepEqual(trainRefs(W).map(([ref]) => ref), ['train/1', 'train/2']);
});

test('a plan( merge request lands only with approved, a sparring_record and a successful plan-spar status on its head', async () => {
  const W = newWorld();
  const p = W.p['vitana-platform'];
  g(p.work, 'checkout', '-q', '-b', 'kiro/demo/plan', 'main');
  write(p.work, '.kiro/specs/demo/plan.md', '# plan\n');
  write(p.work, '.kiro/specs/demo/handoff.md', '---\nslug: demo\nstate: sparred\n---\n# Handoff\n');
  write(p.work, 'docs/programs/standalone/program.md', '---\nid: standalone\n---\n');
  g(p.work, 'add', '-A');
  g(p.work, 'commit', '-q', '-m', 'plan(demo): the plan\n\nCollab-Session: kiro-exafy-202611050800-pppp\nCollab-Lane: demo/_plan');
  publish(W, 'vitana-platform', 'kiro/demo/plan');
  openMr(W, 'vitana-platform', { iid: 5, branch: 'kiro/demo/plan', title: 'plan(demo): the plan', description: '' });
  let head = g(p.work, 'rev-parse', 'HEAD');
  mrPipe(W, 'vitana-platform', 5, head);
  await tickOnce(W);
  assert.deepEqual(mrOf(W, 'vitana-platform', 5).labels, ['queue-waiting'], 'not approved yet');
  write(p.work, '.kiro/specs/demo/handoff.md', '---\nslug: demo\nstate: approved\nsparring_record: .kiro/specs/demo/sparring/verdict.md\n---\n# Handoff\n');
  g(p.work, 'add', '-A');
  g(p.work, 'commit', '-q', '-m', 'plan(demo): approved\n\nCollab-Session: ci-plan-spar\nCollab-Lane: demo/_plan');
  publish(W, 'vitana-platform', 'kiro/demo/plan');
  head = g(p.work, 'rev-parse', 'HEAD');
  mrPipe(W, 'vitana-platform', 5, head);
  W.s['vitana-platform'].statuses[head] = [{ id: 1, name: 'PLAN-SPAR', status: 'success', author: { username: 'agent-kiro-exafy' }, created_at: '2026-11-05T10:00:00Z' }];
  await tickOnce(W);
  assert.deepEqual(mrOf(W, 'vitana-platform', 5).labels, ['queue-waiting'], 'a status from an untrusted account does not count');
  assert.deepEqual(trainRefs(W), []);
  W.s['vitana-platform'].statuses[head].push({ id: 2, name: 'gitlab/plan-spar', status: 'success', author: { username: 'bot-land' }, created_at: '2026-11-05T10:05:00Z' });
  await tickOnce(W);
  assert.deepEqual(mrOf(W, 'vitana-platform', 5).labels, ['queue-ready']);
  ciTrain(W, 'vitana-platform');
  const r = await tickOnce(W);
  assert.equal(merges(r.f).length, 1);
  assert.equal(merges(r.f)[0].body.squash_commit_message, 'plan(demo): the plan\n\nMerge-Request: !5\nSource-Branch: kiro/demo/plan');
  assert.equal(mainLog(W)[0], 'plan(demo): the plan');
});

test('a plan( merge request that changes more than its spec folder and the program entry is refused once', async () => {
  const W = newWorld();
  const p = W.p['vitana-platform'];
  g(p.work, 'checkout', '-q', '-b', 'kiro/demo/plan', 'main');
  write(p.work, '.kiro/specs/demo/handoff.md', '---\nslug: demo\nstate: approved\nsparring_record: x\n---\n');
  write(p.work, 'scripts/sneaky.mjs', 'x\n');
  g(p.work, 'add', '-A');
  g(p.work, 'commit', '-q', '-m', 'plan(demo): the plan');
  publish(W, 'vitana-platform', 'kiro/demo/plan');
  openMr(W, 'vitana-platform', { iid: 5, branch: 'kiro/demo/plan', title: 'plan(demo): the plan' });
  const r = await tickOnce(W);
  assert.deepEqual(mrOf(W, 'vitana-platform', 5).labels, ['queue-blocked']);
  assert.equal(notePosts(r.f).length, 1);
  assert.match(W.s['vitana-platform'].notes[5][0].body, /only its spec folder and the program entry/);
  assert.equal(notePosts((await tickOnce(W)).f).length, 0);
});

test('a protected gate file is refused with one comment and never enters the train; an accept on an old head is refused', async () => {
  const W = newWorld();
  readyLane(W, 'vitana-platform', { lane: 'lane-p', iid: 7, when: '2026-11-05T10:10:00Z', files: { 'CLAUDE.md': 'changed rule\n' } });
  const old = readyLane(W, 'vitana-platform', { lane: 'lane-o', iid: 8, when: '2026-11-05T10:20:00Z' });
  const p = W.p['vitana-platform'];
  g(p.work, 'checkout', '-q', old.branch);
  write(p.work, 'scripts/demo/more.mjs', 'export const more = 1;\n');
  g(p.work, 'add', '-A');
  g(p.work, 'commit', '-q', '-m', `more code after the accept\n\nCollab-Session: ${BUILDER}\nCollab-Lane: demo/lane-o`);
  publish(W, 'vitana-platform', old.branch);
  mrPipe(W, 'vitana-platform', 8, g(p.work, 'rev-parse', 'HEAD'));
  const r = await tickOnce(W);
  assert.deepEqual(trainRefs(W), []);
  assert.deepEqual(mrOf(W, 'vitana-platform', 7).labels, ['queue-blocked']);
  assert.deepEqual(mrOf(W, 'vitana-platform', 8).labels, ['queue-blocked']);
  assert.match(W.s['vitana-platform'].notes[7][0].body, /protected gate file/);
  assert.match(W.s['vitana-platform'].notes[8][0].body, /no longer counts for this head/);
  assert.equal(notePosts(r.f).length, 2);
  assert.equal(notePosts((await tickOnce(W)).f).length, 0, 'one comment per head and reason');
});

test('assist: one assist/<iid>-<rule> pipeline per head and rule; the merge request waits for it; never after an accept', async () => {
  const W = newWorld(['vitana-v1']);
  fs.writeFileSync(path.join(W.root, 'services.json'), JSON.stringify({ repositories: { 'vitana-v1': { services: [{ id: 'community-app', assist: [{ rule: 'i18n-propagate', paths: ['src/i18n/de/**'] }] }] } } }));
  onMain(W, 'vitana-platform', { [laneFile('web-a')]: '---\nlane: web-a\nstate: executing\n---\n# Lane web-a\n\n## Log\n', [laneFile('web-b')]: '---\nlane: web-b\nstate: executing\n---\n# Lane web-b\n\n## Log\n' });
  const F = feature(W, 'vitana-v1', { lane: 'web-a', files: { 'src/i18n/de/admin.json': '{"a":"b"}\n' } });
  publish(W, 'vitana-v1', 'kiro/demo/web-a');
  openMr(W, 'vitana-v1', { iid: 7, branch: 'kiro/demo/web-a', title: titleOf('web-a') });
  mrPipe(W, 'vitana-v1', 7, F);
  const Fb = feature(W, 'vitana-v1', { lane: 'web-b', files: { 'src/i18n/de/apply.json': '{"c":"d"}\n' } });
  publish(W, 'vitana-v1', 'kiro/demo/web-b');
  openMr(W, 'vitana-v1', { iid: 8, branch: 'kiro/demo/web-b', title: titleOf('web-b') });
  mrPipe(W, 'vitana-v1', 8, Fb);
  reviewInPlatform(W, { lane: 'web-b', reviewed: Fb, when: '2026-11-05T10:30:00Z' });
  const projects = [
    { name: 'vitana-platform', path: 'vitana/vitana-platform', landing: false, required_jobs: REQUIRED },
    { name: 'vitana-v1', path: 'vitana/vitana-v1', landing: true, required_jobs: REQUIRED, queue: { positions: 8 } },
  ];
  const r1 = await tickOnce(W, { projects });
  assert.equal(r1.failed, false, JSON.stringify(r1.events().filter((e) => /failed/.test(e.event))));
  const posts = (f) => f.calls.filter((c) => c.method === 'POST' && /\/pipeline$/.test(c.path));
  assert.equal(posts(r1.f).length, 1, 'web-b already has an accept: no assist for it');
  assert.equal(posts(r1.f)[0].body.ref, 'assist/7-i18n-propagate');
  assert.deepEqual(posts(r1.f)[0].body.variables.find((v) => v.key === 'ASSIST_MR_HEAD'), { key: 'ASSIST_MR_HEAD', value: F });
  assert.deepEqual(mrOf(W, 'vitana-v1', 7).labels, ['queue-waiting']);
  assert.deepEqual(mrOf(W, 'vitana-v1', 8).labels, ['queue-ready']);
  const r2 = await tickOnce(W, { projects });
  assert.equal(posts(r2.f).length, 0, 'once per head and rule');
  assert.deepEqual(mrOf(W, 'vitana-v1', 7).labels, ['queue-waiting'], 'the assist is still running');
  W.s['vitana-v1'].pipelines.find((x) => x.ref === 'assist/7-i18n-propagate' && x.source === 'api').status = 'success';
  await tickOnce(W, { projects });
  assert.deepEqual(mrOf(W, 'vitana-v1', 7).labels, ['queue-blocked'], 'the assist is done; now it waits for its review');
  assert.match(W.s['vitana-v1'].notes[7].at(-1).body, /no reviewer accept/);
});

test('cross-repo: vitana-v1 lanes land on their platform review entries; a reviewer session on a merge-request commit is refused; an unreachable platform lands nothing', async () => {
  const W = newWorld(['vitana-v1']);
  onMain(W, 'vitana-platform', Object.fromEntries(['web-a', 'web-b', 'web-c'].map((l) => [laneFile(l), `---\nlane: ${l}\nstate: in-review\n---\n# Lane ${l}\n\n## Log\n`])));
  const heads = {};
  ['web-a', 'web-b', 'web-c'].forEach((lane, i) => {
    heads[lane] = feature(W, 'vitana-v1', { lane });
    publish(W, 'vitana-v1', `kiro/demo/${lane}`);
    openMr(W, 'vitana-v1', { iid: 7 + i, branch: `kiro/demo/${lane}`, title: titleOf(lane) });
    mrPipe(W, 'vitana-v1', 7 + i, heads[lane]);
  });
  // web-c's reviewer also committed to the merge request, and then accepted that head (so only the builder rule refuses it)
  const v1 = W.p['vitana-v1'];
  g(v1.work, 'checkout', '-q', 'kiro/demo/web-c');
  write(v1.work, 'scripts/demo/helper.mjs', 'x\n');
  g(v1.work, 'add', '-A');
  g(v1.work, 'commit', '-q', '-m', 'help\n\nCollab-Session: agent-vitana-lane-reviewer-202611051130-cccc\nCollab-Lane: demo/web-c');
  publish(W, 'vitana-v1', 'kiro/demo/web-c');
  heads['web-c'] = g(v1.work, 'rev-parse', 'HEAD');
  mrPipe(W, 'vitana-v1', 9, heads['web-c']);
  reviewInPlatform(W, { lane: 'web-a', reviewed: heads['web-a'], when: '2026-11-05T10:10:00Z' });
  reviewInPlatform(W, { lane: 'web-b', reviewed: heads['web-b'], when: '2026-11-05T10:20:00Z', session: BUILDER.replace('kiro-exafy', 'agent-vitana-lane-reviewer') });
  reviewInPlatform(W, { lane: 'web-c', reviewed: heads['web-c'], when: '2026-11-05T10:30:00Z', session: 'agent-vitana-lane-reviewer-202611051130-cccc' });
  const projects = [
    { name: 'vitana-platform', path: 'vitana/vitana-platform', landing: false, required_jobs: REQUIRED },
    { name: 'vitana-v1', path: 'vitana/vitana-v1', landing: true, required_jobs: REQUIRED, queue: { positions: 8 } },
  ];
  W.s['vitana-platform'].down = true;
  fs.renameSync(W.p['vitana-platform'].remote, `${W.p['vitana-platform'].remote}.away`);
  const down = await tickOnce(W, { projects });
  assert.equal(down.failed, true, 'the platform project is unreachable: the tick fails');
  assert.equal(merges(down.f).length, 0);
  assert.deepEqual(trainRefs(W, 'vitana-v1'), [], 'nothing was built');
  fs.renameSync(`${W.p['vitana-platform'].remote}.away`, W.p['vitana-platform'].remote);
  W.s['vitana-platform'].down = false;
  await tickOnce(W, { projects });
  assert.deepEqual(trainRefs(W, 'vitana-v1').map(([ref]) => ref), ['train/1', 'train/2']);
  assert.deepEqual(mrOf(W, 'vitana-v1', 9).labels, ['queue-blocked']);
  assert.match(W.s['vitana-v1'].notes[9][0].body, /reviewer.*also committed/i);
  ciTrain(W, 'vitana-v1');
  const r = await tickOnce(W, { projects });
  assert.deepEqual(merges(r.f).map((m) => /merge_requests\/(\d+)/.exec(m.path)[1]), ['7', '8']);
  const remote = W.p['vitana-v1'].remote;
  const landed = g(remote, 'rev-parse', 'refs/heads/main');
  assert.equal(trailer(remote, landed, 'Reviewed-Head'), heads['web-b']);
  assert.equal(trailer(remote, landed, 'Merge-Request'), '!8');
  assert.equal(trailer(remote, landed, 'Accepted-At'), '2026-11-05T10:20:00.000Z');
});

test('--dry-run writes nothing: no train ref, no label, no comment, no merge, no state file', async () => {
  const { W } = threeReady();
  readyLane(W, 'vitana-platform', { lane: 'lane-p', iid: 10, when: '2026-11-05T10:40:00Z', files: { 'CLAUDE.md': 'x\n' } });
  const refsBefore = g(W.p['vitana-platform'].remote, 'for-each-ref', '--format=%(refname) %(objectname)');
  const r = await tickOnce(W, { dryRun: true });
  r.f.assertNoWrites();
  const withoutMrRefs = (text) => text.replace(/refs\/merge-requests\/\S+ \S+\n?/g, '').trim(); // the fake GitLab writes refs/merge-requests/* on reads
  assert.equal(withoutMrRefs(g(W.p['vitana-platform'].remote, 'for-each-ref', '--format=%(refname) %(objectname)')), withoutMrRefs(refsBefore));
  assert.equal(fs.existsSync(path.join(W.root, 'land', 'vitana-platform.train.json')), false);
  const ev = r.events();
  assert.ok(ev.some((e) => e.event === 'would_build_train' && e.position === 1 && e.mr === 8));
  assert.ok(ev.some((e) => e.event === 'would_label' && e.mr === 7 && e.label === 'queue-ready'));
  assert.ok(ev.some((e) => e.event === 'would_comment' && e.mr === 10));
});

test('run and status read the projects through loadEffectiveProjects of gitlab-settings.mjs (the cut configuration) when it exports it, else the settings file as M2 does; a loader error lands nothing', async () => {
  // the bot names the function where the cut checklist item bot-config looks for it (gitlab-land.mjs on main)
  const src = fs.readFileSync(new URL('./gitlab-land.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \* as gitlabSettings from '\.\/gitlab-settings\.mjs';/);
  assert.match(src, /gitlabSettings\.loadEffectiveProjects|lib\.loadEffectiveProjects/);
  const { W } = threeReady();
  const tokenFile = path.join(W.root, 'token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const settingsFile = path.join(W.root, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ group: 'vitana', projects: { 'vitana-platform': { landing: false, required_jobs: [] } } }));
  const run = async (settingsLib, extra = []) => {
    const f = gitlab(W);
    const out = [];
    const code = await land.main(['status', '--settings', settingsFile, '--url', 'https://gitlab.test', '--token-file', tokenFile, '--workdir', path.join(W.root, 'land'), ...extra], {
      fetch: f, now: () => NOW, stdout: (t) => out.push(t), settingsLib,
      overrides: { remoteUrl: (p) => W.p[p.name].remote, services: path.join(W.root, 'none.json') },
    });
    return { code, out: out.join(''), f };
  };
  const rowsOf = (out) => out.split('\n').filter((l) => /^vitana-platform!/.test(l)).map((l) => l.split('\t').slice(0, 2));
  // the cut configuration (marker live) says vitana-platform lands: the queue reports its merge requests
  const calls = [];
  const cut = { loadEffectiveProjects: async (file, opts) => { calls.push([file, opts]); return [{ name: 'vitana-platform', path: 'vitana/vitana-platform', landing: true, required_jobs: REQUIRED }]; } };
  const marker = path.join(W.root, 'delivery-cutover');
  const ciDir = path.join(W.root, 'ci');
  const r1 = await run(cut, ['--marker-file', marker, '--ci-dir', ciDir]);
  assert.equal(r1.code, 0, r1.out);
  assert.deepEqual(calls, [[settingsFile, { markerFile: marker, ciDir }]]);
  assert.deepEqual(rowsOf(r1.out), [['vitana-platform!7', 'ready'], ['vitana-platform!8', 'ready'], ['vitana-platform!9', 'ready']]);
  r1.f.assertNoWrites();
  await run(cut);
  assert.deepEqual(calls[1], [settingsFile, {}], 'without the options the module\'s own defaults apply');
  // a settings module without the function (lane settings before lane cutover): the file itself, as M2 reads it
  const r2 = await run({});
  assert.equal(r2.code, 0, r2.out);
  assert.deepEqual(rowsOf(r2.out), [], 'vitana-platform is not a landing project in the file');
  // the loader fails (for example an invalid settings file): nothing is asked of GitLab, exit 1
  const r3 = await run({ loadEffectiveProjects: async () => { throw new Error('projects.vitana-v1.cutover: unknown key'); } });
  assert.equal(r3.code, 1);
  assert.match(r3.out, /gitlab-land: projects\.vitana-v1\.cutover: unknown key/);
  assert.equal(r3.f.calls.length, 0);
});

test('status in queue mode prints each merge request\'s queue state and writes nothing', async () => {
  const { W } = threeReady();
  const f = gitlab(W);
  const out = [];
  const tokenFile = path.join(W.root, 'token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const code = await land.main(['status', '--url', 'https://gitlab.test', '--token-file', tokenFile, '--workdir', path.join(W.root, 'land')], {
    fetch: f, now: () => NOW, stdout: (t) => out.push(t),
    overrides: { projectsOverride: [{ name: 'vitana-platform', path: 'vitana/vitana-platform', landing: true, required_jobs: REQUIRED, queue: { positions: 8 } }], remoteUrl: (p) => W.p[p.name].remote, services: path.join(W.root, 'none.json') },
  });
  assert.equal(code, 0, out.join(''));
  f.assertNoWrites();
  const rows = out.join('').split('\n').filter((l) => /^vitana-platform!/.test(l)).map((l) => l.split('\t').slice(0, 2));
  assert.deepEqual(rows, [['vitana-platform!7', 'ready'], ['vitana-platform!8', 'ready'], ['vitana-platform!9', 'ready']]);
});
