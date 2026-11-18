// Q3 evidence of lane merge-queue (VTID-05549): a run of the queue mode of scripts/eng/gitlab-land.mjs over the fake GitLab
// with 12 merge requests: 9 in vitana-platform (7 same-repo lanes, 1 lane that changes a protected gate file, 1 plan) and 3
// cross-repo vitana-v1 lanes whose review entries are in the platform lane files. Tick 0 is a --dry-run (asserted to write
// nothing); tick 1 builds the trains and sets the labels; CI turns every train position green; tick 2 lands in queue order.
// The world (bare repositories, recording fake fetch) is the one of scripts/eng/gitlab-land-queue.test.mjs, copied here
// verbatim from its helper section. Run: node docs/validation/VTID-05549/outputs/dry-run-12.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeFetch } from '../../../../scripts/eng/testing/fake-fetch.mjs';
import * as land from '../../../../scripts/eng/gitlab-land.mjs';

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
function ciTrain(W, name, { fail = [], pending = [] } = {}) {
  for (const [ref, sha] of remoteRefs(W.p[name], 'refs/heads/train/')) {
    const short = ref.replace('refs/heads/', '');
    if (W.s[name].pipelines.some((p) => p.sha === sha && p.ref === short)) continue;
    const k = Number(short.split('/')[1]);
    pipeline(W, name, { sha, ref: short, status: fail.includes(k) ? 'failed' : pending.includes(k) ? 'running' : 'success' });
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
function context(W, f, { projects, extra = {} } = {}) {
  const tokenFile = path.join(W.root, 'token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const lines = [];
  const ctx = land.makeContext({
    workdir: path.join(W.root, 'land'), 'token-file': tokenFile, url: 'https://gitlab.test',
    projectsOverride: projects ?? [
      { name: 'vitana-platform', path: 'vitana/vitana-platform', landing: true, required_jobs: REQUIRED, queue: { positions: 8 } },
    ],
    remoteUrl: (proj) => W.p[proj.name].remote, services: path.join(W.root, 'services.json'), ...extra,
  }, { fetch: f, now: () => NOW, write: (l) => lines.push(l) });
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
const labelWrites = (f) => f.calls.filter((c) => c.method === 'PUT' && /\/merge_requests\/\d+$/.test(c.path));
const notePosts = (f) => f.calls.filter((c) => c.method === 'POST' && /\/notes$/.test(c.path));
const mrOf = (W, name, iid) => W.s[name].mrs.find((m) => m.iid === iid);
const trainRefs = (W, name = 'vitana-platform') => remoteRefs(W.p[name], 'refs/heads/train/').map(([ref, sha]) => [ref.replace('refs/heads/', ''), sha]);
const mainLog = (W, name = 'vitana-platform') => g(W.p[name].remote, 'log', '--format=%s', 'refs/heads/main').split('\n');
const trailer = (repo, rev, key) => g(repo, 'log', '-1', `--format=%(trailers:key=${key},valueonly)`, rev);


// ── the scenario ─────────────────────────────────────────────────────────────
const W = newWorld(['vitana-v1']);
const P = 'vitana-platform';
const V1 = 'vitana-v1';
const lanes = ['api-a', 'api-b', 'api-c', 'api-d', 'api-e', 'api-f', 'api-g'];
lanes.forEach((lane, i) => readyLane(W, P, { lane, iid: 10 + i, when: `2026-11-05T10:${String(50 - i * 5).padStart(2, '0')}:00Z` }));
readyLane(W, P, { lane: 'gate-x', iid: 17, when: '2026-11-05T10:01:00Z', files: { 'CLAUDE.md': 'a rule change\n' } });
// the plan merge request: spec files and the program entry, approved, PLAN-SPAR green from the trusted account
const pw = W.p[P].work;
g(pw, 'fetch', '-q', 'origin');
g(pw, 'checkout', '-q', '-B', 'kiro/demo2/plan', 'origin/main');
write(pw, '.kiro/specs/demo2/plan.md', '# plan\n');
write(pw, '.kiro/specs/demo2/handoff.md', '---\nslug: demo2\nstate: approved\nsparring_record: .kiro/specs/demo2/sparring/verdict.md\n---\n# Handoff\n');
write(pw, 'docs/programs/standalone/program.md', '---\nid: standalone\n---\n');
g(pw, 'add', '-A');
g(pw, 'commit', '-q', '-m', 'plan(demo2): the plan\n\nCollab-Session: ci-plan-spar\nCollab-Lane: demo2/_plan');
publish(W, P, 'kiro/demo2/plan');
const planHead = g(pw, 'rev-parse', 'HEAD');
openMr(W, P, { iid: 18, branch: 'kiro/demo2/plan', title: 'plan(demo2): the plan', description: '' });
mrPipe(W, P, 18, planHead);
W.s[P].statuses[planHead] = [{ id: 1, name: 'gitlab/plan-spar', status: 'success', author: { username: 'bot-land' }, created_at: '2026-11-05T10:40:00Z' }];
// three cross-repo vitana-v1 lanes, reviewed in the platform lane files
onMain(W, P, Object.fromEntries(['web-a', 'web-b', 'web-c'].map((l) => [laneFile(l), `---\nlane: ${l}\nstate: in-review\n---\n# Lane ${l}\n\n## Log\n`])));
const v1Heads = {};
['web-a', 'web-b', 'web-c'].forEach((lane, i) => {
  v1Heads[lane] = feature(W, V1, { lane });
  publish(W, V1, `kiro/demo/${lane}`);
  openMr(W, V1, { iid: 20 + i, branch: `kiro/demo/${lane}`, title: titleOf(lane) });
  mrPipe(W, V1, 20 + i, v1Heads[lane]);
  reviewInPlatform(W, { lane, reviewed: v1Heads[lane], when: `2026-11-05T10:${String(15 + i * 10)}:00Z`, session: `agent-vitana-lane-reviewer-20261105101${i}-c0d${i}` });
});
const projects = [
  { name: P, path: 'vitana/vitana-platform', landing: true, required_jobs: REQUIRED, queue: { positions: 8 } },
  { name: V1, path: 'vitana/vitana-v1', landing: true, required_jobs: REQUIRED, queue: { positions: 8 } },
];
const countMrs = Object.values(W.s).reduce((n, s) => n + s.mrs.length, 0);
assert.equal(countMrs, 12);
const show = (label, r) => {
  console.log(`\n== ${label}: failed=${r.failed}, API writes=${r.f.writes().length}`);
  for (const e of r.events()) {
    if (['queue_state', 'train_position', 'would_build_train', 'would_label', 'would_comment', 'landed', 'updated', 'train_dropped', 'commented', 'labelled'].includes(e.event)) {
      const { ts, ...rest } = e;
      console.log(JSON.stringify(rest));
    }
  }
};
console.log(`12 merge requests: ${W.s[P].mrs.length} in vitana-platform (iids ${W.s[P].mrs.map((m) => m.iid).join(', ')}), ${W.s[V1].mrs.length} cross-repo in vitana-v1 (iids ${W.s[V1].mrs.map((m) => m.iid).join(', ')})`);
const refsBefore = Object.fromEntries([P, V1].map((n) => [n, g(W.p[n].remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/')]));
const r0 = await tickOnce(W, { projects, dryRun: true });
r0.f.assertNoWrites();
for (const n of [P, V1]) assert.equal(g(W.p[n].remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'), refsBefore[n], `${n}: the dry run moved no branch`);
assert.equal(fs.existsSync(path.join(W.root, 'land', 'vitana-platform.train.json')), false);
show('tick 0 (--dry-run; asserted: no API write, no ref moved, no state file)', r0);
const r1 = await tickOnce(W, { projects });
show('tick 1 (trains built, labels set, the protected-file merge request refused once)', r1);
console.log(`train refs: ${P}: ${trainRefs(W, P).map(([r]) => r).join(' ')} | ${V1}: ${trainRefs(W, V1).map(([r]) => r).join(' ')}`);
ciTrain(W, P);
ciTrain(W, V1);
const r2 = await tickOnce(W, { projects });
show('tick 2 (every train position green: landed in queue order)', r2);
for (const n of [P, V1]) {
  const landedIids = merges(r2.f).filter((m) => m.path.includes(encodeURIComponent(`vitana/${n}`))).map((m) => Number(/merge_requests\/(\d+)\/merge/.exec(m.path)[1]));
  console.log(`\n${n}: landed in this order: ${landedIids.map((i) => `!${i}`).join(' ')}`);
  console.log(g(W.p[n].remote, 'log', '--first-parent', '--format=%h %s%n    %(trailers:separator=%x2c )', `-${landedIids.length}`, 'refs/heads/main'));
}
const landedP = merges(r2.f).filter((m) => m.path.includes('vitana%2Fvitana-platform')).length;
const landedV = merges(r2.f).filter((m) => m.path.includes('vitana%2Fvitana-v1')).length;
assert.equal(landedP, 8, 'the 7 lanes and the plan land; the protected-file merge request does not');
assert.equal(landedV, 3);
assert.deepEqual(mrOf(W, P, 17).labels, ['queue-blocked']);
assert.equal(W.s[P].notes[17].length, 1);
console.log(`\nresult: ${landedP} landed in vitana-platform, ${landedV} in vitana-v1; !17 (CLAUDE.md) refused with ${W.s[P].notes[17].length} comment; every assertion passed`);
