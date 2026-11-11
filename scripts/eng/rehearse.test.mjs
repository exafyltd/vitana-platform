// Tests of the rehearsal (plan eng-gitlab-m2 §3.8, lane rehearsal, tasks R1 to R4).
//
//  1. The pure parts: the plan of merge requests, the arguments, the refusals, the seed, the negative controls, the parsers, and the verdicts
//     A1, A2, A3, A4 and A8 with the failure cases of each.
//  2. The commits are checked against the merge bot itself: real temporary git repositories, and the functions of gitlab-land.mjs, land-guard.mjs
//     and queue.mjs are imported, not copied (commitsInRange, judgeReviewCommit, localAfter, reviewCurrent, decide, protectedTouched).
//  3. Whole runs against a fake GitLab (a recording fake fetch with state, a scripted merge bot, a fleet that boots machines), a fake aws runner
//     and a virtual clock: the happy path and the ways it can fail. No test reaches GitLab, AWS or the network.
// Files and modules are read when a case runs, never when this file loads, so that a missing implementation fails each case on its own.
// Dependency-free Node (node:test), so UNIT.yml runs it with no install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeFetch } from './testing/fake-fetch.mjs';
import * as R from './rehearse.mjs';
import * as land from './gitlab-land.mjs';
import { GitLabApiError } from './gitlab-api.mjs';
import { laneKeyOf, localAfter, reviewCurrent, protectedTouched } from '../collab/land-guard.mjs';
import { commitsInRange, PROTECTED_GATE_PATHS, GOVERNANCE_PATHS, isSessionId, agentOf } from '../collab/queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SEED = path.join(REPO, 'infra', 'gitlab-engineering', 'rehearsal', 'seed');
const SETTINGS = path.join(REPO, 'infra', 'gitlab-engineering', 'settings', 'gitlab-settings.json');
const SEATS = ['agent-kiro-exafy', 'agent-kiro-exafyltd', 'agent-kiro-jtadic', 'agent-kiro-hotmail'];
const NOW0 = Date.parse('2026-11-05T14:00:00Z');
const IP = '10.0.1.23';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix = 'rehearse-test-') => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
const baseConfig = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const writeSettings = (mutate) => { const c = baseConfig(); mutate?.(c); const f = path.join(tmp(), 'gitlab-settings.json'); fs.writeFileSync(f, JSON.stringify(c)); return f; };
const importSeed = (rel) => import(pathToFileURL(path.join(SEED, rel)).href);
const seedFiles = () => R.buildSeedFiles({ seedDir: SEED, platformRoot: REPO, gitlabPrivateIp: IP });
const lanePlan = (agents = 12, runId = 'r202611051400') => R.planMergeRequests({ agents, seats: SEATS, runId });

// ============================================================================================================================
// 1. THE PLAN OF MERGE REQUESTS
// ============================================================================================================================
test('plan: 12 landing merge requests lane-01 to lane-12, opened round robin by the four seat accounts, three each', () => {
  const plan = lanePlan(12);
  assert.deepEqual(plan.lanes.map((l) => l.id), Array.from({ length: 12 }, (_, i) => `lane-${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(plan.lanes.map((l) => l.seat), Array.from({ length: 12 }, (_, i) => SEATS[i % 4]));
  for (const s of SEATS) assert.equal(plan.lanes.filter((l) => l.seat === s).length, 3, `${s} opens three`);
  assert.ok(plan.lanes.every((l) => l.kind === 'land'));
});

test('plan: every title is "VTID-05540 (rehearsal/<lane>): …" and the laneKeyOf of the merge bot finds the lane in it', () => {
  const plan = lanePlan(12);
  for (const item of plan.order) {
    assert.match(item.title, /^VTID-05540 \(rehearsal\/[a-z0-9-]+\): /);
    assert.equal(laneKeyOf(item.title), `rehearsal/${item.id}`);
    assert.equal(item.laneKey, `rehearsal/${item.id}`);
    assert.equal(item.laneFile, `.kiro/specs/rehearsal/lanes/${item.id}.md`);
  }
  assert.equal(new Set(plan.order.map((i) => i.title)).size, plan.order.length, 'titles are distinct');
});

test('plan: five controls (no review, stale review, builder-pushed accept, red job, protected file), each with the reason code the bot must give', () => {
  const plan = lanePlan(12);
  assert.deepEqual(plan.controls.map((c) => [c.id, c.control, c.expect]), [
    ['ctl-no-review', 'no_review', 'no_review'],
    ['ctl-stale-review', 'stale_review', 'review_stale'],
    ['ctl-builder-accept', 'builder_accept', 'review_forged'],
    ['ctl-red-job', 'red_job', 'checks_failed'],
    ['ctl-protected-file', 'protected_file', 'protected_gate_file'],
  ]);
  assert.deepEqual(plan.controls.map((c) => c.seat), [SEATS[0], SEATS[1], SEATS[2], SEATS[3], SEATS[0]]);
  assert.ok(plan.controls.every((c) => c.kind === 'control'));
  assert.deepEqual(R.CONTROLS.map((c) => c.expect), plan.controls.map((c) => c.expect));
});

test('plan: the controls are opened first, so they are the oldest merge requests and the bot reads them before the lanes', () => {
  const plan = lanePlan(12);
  assert.deepEqual(plan.order.slice(0, 5).map((i) => i.kind), Array(5).fill('control'));
  assert.deepEqual(plan.order.slice(5).map((i) => i.id), plan.lanes.map((l) => l.id));
  assert.equal(plan.order.length, 17);
});

test('plan: --agents N opens N landing merge requests; a number outside 1 to 12, or not whole, is a usage error', () => {
  assert.equal(lanePlan(5).lanes.length, 5);
  assert.deepEqual(lanePlan(5).lanes.map((l) => l.seat), [SEATS[0], SEATS[1], SEATS[2], SEATS[3], SEATS[0]]);
  assert.deepEqual(lanePlan(5).controls.map((c) => c.seat), [SEATS[1], SEATS[2], SEATS[3], SEATS[0], SEATS[1]], 'the controls go on round robin after the lanes');
  assert.deepEqual(lanePlan(1).controls.map((c) => c.seat), [SEATS[1], SEATS[2], SEATS[3], SEATS[0], SEATS[1]]);
  assert.equal(lanePlan(1).lanes.length, 1);
  for (const bad of [0, 13, 1.5, -1, '12', NaN]) {
    assert.throws(() => lanePlan(bad), (e) => e instanceof R.UsageError, `agents ${bad}`);
  }
  assert.throws(() => R.planMergeRequests({ agents: 3, seats: [], runId: 'r1' }), (e) => e instanceof R.UsageError);
});

test('plan: branch names carry the run, are unique, and pass the branch pattern of the merge bot; session ids are valid collab session ids', () => {
  const BRANCH_OK = /^[A-Za-z0-9._/-]{1,200}$/; // gitlab-land.mjs BRANCH_OK
  const a = lanePlan(12, 'r202611051400');
  const b = lanePlan(12, 'r202611051500');
  const branches = a.order.map((i) => i.branch);
  assert.equal(new Set(branches).size, 17);
  assert.ok(branches.every((x) => BRANCH_OK.test(x) && x.startsWith('rehearsal/r202611051400/')));
  assert.equal(a.order.filter((i) => b.order.some((j) => j.branch === i.branch)).length, 0, 'two runs never share a branch');
  const seat = R.sessionIdFor('seat', 'agent-kiro-exafyltd', NOW0, 'ab12');
  const reviewer = R.sessionIdFor('reviewer', 'agent-reviewer', NOW0, 'cd34');
  assert.equal(seat, 'kiro-exafyltd-202611051400-ab12');
  assert.equal(reviewer, 'agent-vitana-lane-reviewer-202611051400-cd34');
  assert.ok(isSessionId(seat) && isSessionId(reviewer));
  assert.equal(agentOf(reviewer), 'agent:vitana-lane-reviewer');
});

// ============================================================================================================================
// 2. THE COMMAND LINE
// ============================================================================================================================
test('args: --project and --agents parse, with the defaults of the plan; --key=value works', () => {
  const o = R.parseArgs(['--project', 'rehearsal', '--agents', '12']);
  assert.equal(o.project, 'rehearsal');
  assert.equal(o.agents, 12);
  assert.equal(o.url, 'http://127.0.0.1');
  assert.equal(o.dryRun, false);
  assert.equal(o.maxMinutes, 110);
  assert.equal(o.pollSeconds, 15);
  const p = R.parseArgs(['--project=rehearsal', '--agents=5', '--dry-run', '--run-id=rabc123', '--gitlab-private-ip', '10.1.2.3', '--max-minutes', '60', '--poll-seconds', '5']);
  assert.deepEqual([p.agents, p.dryRun, p.runId, p.gitlabPrivateIp, p.maxMinutes, p.pollSeconds], [5, true, 'rabc123', '10.1.2.3', 60, 5]);
  assert.equal(R.parseArgs(['--project', 'rehearsal']).agents, 12, 'agents default to the 12 of the plan');
  assert.equal(R.parseArgs(['--help']).help, true);
});

test('args: usage mistakes throw UsageError (exit 2): no project, a bad number of agents, an unknown option, a missing value, bad run id, address, limits', () => {
  const bad = [
    [], ['--agents', '12'], ['--project', 'rehearsal', '--agents', '0'], ['--project', 'rehearsal', '--agents', '13'], ['--project', 'rehearsal', '--agents', 'twelve'],
    ['--project', 'rehearsal', '--agents'], ['--project', 'rehearsal', '--nope'], ['--project', 'rehearsal', 'extra'], ['--project', 'Bad Name'],
    ['--project', 'rehearsal', '--run-id', 'x'], ['--project', 'rehearsal', '--run-id', 'r1'], ['--project', 'rehearsal', '--gitlab-private-ip', '10.0.0.999'],
    ['--project', 'rehearsal', '--max-minutes', '10'], ['--project', 'rehearsal', '--max-minutes', '999'], ['--project', 'rehearsal', '--poll-seconds', '0'],
    ['--project', 'rehearsal', '--dry-run=yes'], ['--project', 'rehearsal', '--agents', '--dry-run'],
  ];
  for (const argv of bad) assert.throws(() => R.parseArgs(argv), (e) => e instanceof R.UsageError, JSON.stringify(argv));
});

test('args: the command line of m2.sh (--project rehearsal --agents 12) parses, and the CLI answers --help with exit 0 and a bad option with exit 2, without any network', () => {
  const ok = spawnSync(process.execPath, [path.join(HERE, 'rehearse.mjs'), '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /usage: node scripts\/eng\/rehearse\.mjs --project/);
  const bad = spawnSync(process.execPath, [path.join(HERE, 'rehearse.mjs'), '--project', 'rehearsal', '--agents', '99'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /--agents must be a whole number from 1 to 12/);
  const m2 = fs.readFileSync(path.join(REPO, 'infra', 'gitlab-engineering', 'm2.sh'), 'utf8');
  assert.match(m2, /node scripts\/eng\/rehearse\.mjs --project rehearsal --agents 12/);
  const o = R.parseArgs(['--project', 'rehearsal', '--agents', '12']);
  assert.equal(o.project, 'rehearsal');
});

// ============================================================================================================================
// 3. THE REFUSALS (pure parts; the whole-run refusals are in section 9)
// ============================================================================================================================
test('refusal: the project of the repository today (rehearsal: true, native, landing, no webhook) is accepted, and its accounts are the 4 seats, the reviewer, the bot and the reader', () => {
  const r = R.checkSettingsFile(baseConfig(), 'rehearsal');
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.project.rehearsal, true);
  assert.deepEqual(r.config.accounts.filter((a) => a.projects.includes('rehearsal') && a.username.startsWith('agent-kiro-')).map((a) => a.username), SEATS);
});

test('refusal: a project that is not in gitlab-settings.json, or is not marked rehearsal: true, is refused (vitana-platform and vitana-v1 are never rehearsed on)', () => {
  const none = R.checkSettingsFile(baseConfig(), 'nosuch');
  assert.equal(none.ok, false);
  assert.match(none.problems.join('\n'), /"nosuch" is not in gitlab-settings\.json/);
  for (const name of ['vitana-platform', 'vitana-v1']) {
    const r = R.checkSettingsFile(baseConfig(), name);
    assert.equal(r.ok, false, name);
    assert.match(r.problems.join('\n'), /is not marked rehearsal: true/);
  }
  const c = baseConfig();
  c.projects.rehearsal.rehearsal = false;
  assert.match(R.checkSettingsFile(c, 'rehearsal').problems.join('\n'), /is not marked rehearsal: true/);
});

test('refusal: a mirrored project is refused, also when it is marked rehearsal (the settings schema itself says native)', () => {
  const c = baseConfig();
  c.projects.rehearsal.profile = 'mirror';
  const r = R.checkSettingsFile(c, 'rehearsal');
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /native/);
  const d = baseConfig();
  d.projects['vitana-platform'].rehearsal = true; // a mirror marked rehearsal is invalid for the schema, which is itself a refusal
  assert.equal(R.checkSettingsFile(d, 'vitana-platform').ok, false);
  const e = baseConfig();
  e.projects.rehearsal.rehearsal = false;
  e.projects.rehearsal.profile = 'mirror';
  e.projects.rehearsal.landing = false;
  const rr = R.checkSettingsFile(e, 'rehearsal');
  assert.match(rr.problems.join('\n'), /profile "mirror", not native/);
});

test('refusal: a project with a webhook in the settings file, or with landing: false, is refused', () => {
  const c = baseConfig();
  c.projects.rehearsal.webhook = { url: 'https://gateway.test/hook', events: ['pipeline'] };
  const withHook = R.checkSettingsFile(c, 'rehearsal');
  assert.equal(withHook.ok, false);
  assert.match(withHook.problems.join('\n'), /webhook/);
  const d = baseConfig();
  d.projects.rehearsal.rehearsal = false;
  d.projects.rehearsal.webhook = { url: 'https://gateway.test/hook', events: ['pipeline'] };
  assert.match(R.checkSettingsFile(d, 'rehearsal').problems.join('\n'), /has a webhook in gitlab-settings\.json/);
  const e = baseConfig();
  e.projects.rehearsal.landing = false;
  assert.match(R.checkSettingsFile(e, 'rehearsal').problems.join('\n'), /landing: false/);
  assert.equal(R.checkSettingsFile({ schema_version: 2 }, 'rehearsal').ok, false, 'an invalid file is a refusal');
});

const protection = (over = {}) => ({ name: 'main', push_access_levels: [{ access_level: 0 }], merge_access_levels: [{ access_level: 40 }], allow_force_push: false, ...over });
const liveStub = (answers) => ({
  get: async (p) => {
    const rel = p.replace(/^\/projects\/[^/]+/, '') || '/';
    if (!(rel in answers)) throw new Error(`unexpected GET ${p}`);
    const v = answers[rel];
    if (v instanceof Error) throw v;
    return v;
  },
});
const cleanLive = () => ({ '/': { id: 42, default_branch: 'main', archived: false, mirror: false }, '/hooks': [], '/remote_mirrors': [], '/protected_branches/main': protection() });

test('refusal: the live project is accepted when it has no webhook, no mirror, and main is protected as the native profile says', async () => {
  assert.deepEqual(await R.liveProblems(liveStub(cleanLive()), '/projects/x'), []);
  assert.deepEqual(R.protectionProblems(protection()), []);
});

test('refusal: a live webhook, a live mirror (mirror: true or a remote mirror) and a project that is archived or has another default branch are refused', async () => {
  const run = (over) => R.liveProblems(liveStub({ ...cleanLive(), ...over }), '/projects/x');
  assert.match((await run({ '/hooks': [{ id: 1, url: 'https://gateway.test/h' }] })).join('\n'), /1 webhook/);
  assert.match((await run({ '/': { default_branch: 'main', mirror: true } })).join('\n'), /is a mirror/);
  assert.match((await run({ '/remote_mirrors': [{ id: 3, url: 'https://github.com/x.git' }] })).join('\n'), /1 remote mirror/);
  assert.match((await run({ '/': { default_branch: 'develop' } })).join('\n'), /default branch is "develop"/);
  assert.match((await run({ '/': { default_branch: 'main', archived: true } })).join('\n'), /archived/);
});

test('refusal: main must be push No one, merge Maintainers, no force push; a user or group entry, Maintainers pushing and force push are each refused', async () => {
  const bad = (pb) => R.protectionProblems(pb).join('\n');
  assert.match(bad(protection({ push_access_levels: [{ access_level: 40 }] })), /push to main is not "No one"/);
  assert.match(bad(protection({ push_access_levels: [{ access_level: 0 }, { access_level: 40 }] })), /push to main/);
  assert.match(bad(protection({ push_access_levels: [{ access_level: 0, user_id: 5 }] })), /push to main/);
  assert.match(bad(protection({ merge_access_levels: [{ access_level: 30 }] })), /merge to main is not "Maintainers"/);
  assert.match(bad(protection({ merge_access_levels: [{ access_level: 40 }, { access_level: 30 }] })), /merge to main/);
  assert.match(bad(protection({ allow_force_push: true })), /force push to main is allowed/);
  assert.match(bad(protection({ allow_force_push: undefined })), /force push to main is allowed/);
  assert.deepEqual(R.protectionProblems(null), ['main is not protected']);
  assert.match((await R.liveProblems(liveStub({ ...cleanLive(), '/protected_branches/main': protection({ push_access_levels: [{ access_level: 30 }] }) }), '/projects/x')).join('\n'), /the live project: push to main/);
});

test('refusal: what cannot be read is not assumed safe (a 403 on the webhooks, a missing protection)', async () => {
  const forbidden = new GitLabApiError('forbidden', { code: 'http', status: 403 });
  const hooks = await R.liveProblems(liveStub({ ...cleanLive(), '/hooks': forbidden }), '/projects/x');
  assert.match(hooks.join('\n'), /the webhooks could not be read \(HTTP 403\), so it was not proven safe/);
  const noPb = await R.liveProblems(liveStub({ ...cleanLive(), '/protected_branches/main': new GitLabApiError('nf', { code: 'http', status: 404 }) }), '/projects/x');
  assert.match(noPb.join('\n'), /the protection of main could not be read \(HTTP 404\)/);
  const notList = await R.liveProblems(liveStub({ ...cleanLive(), '/hooks': { message: 'odd' } }), '/projects/x');
  assert.match(notList.join('\n'), /unknown webhook/);
});

// ============================================================================================================================
// 4. THE SEED
// ============================================================================================================================
test('seed: the manifest maps spec/ to .kiro/specs/rehearsal/, holds 12 lane files and the lane seed, and copies the collab tooling to tools/collab', () => {
  const m = R.readManifest(SEED);
  assert.equal(m.schema, 'vitana.rehearsal-seed/v1');
  assert.deepEqual(m.map, { 'spec/': '.kiro/specs/rehearsal/' });
  assert.deepEqual(m.collab, { from: 'scripts/collab', to: 'tools/collab', files: ['queue.mjs', 'land-guard.mjs', 'protected-gate-files.json'] });
  const files = seedFiles();
  const lanes = [...files.keys()].filter((p) => p.startsWith('.kiro/specs/rehearsal/lanes/')).sort();
  assert.deepEqual(lanes, ['seed', ...Array.from({ length: 12 }, (_, i) => `lane-${String(i + 1).padStart(2, '0')}`)].sort().map((id) => `.kiro/specs/rehearsal/lanes/${id}.md`));
  for (const p of ['package.json', 'scripts/ci-test.mjs', 'scripts/negctl.mjs', 'test/spec.test.mjs', '.kiro/specs/rehearsal/plan.md', '.kiro/specs/rehearsal/handoff.md', 'rehearsal.config.json']) assert.ok(files.has(p), p);
  assert.equal(files.has('manifest.json'), false, 'the manifest is not part of the repository');
  assert.ok([...files.keys()].every((p) => !p.startsWith('spec/')), 'nothing is left under spec/');
});

test('seed: the collab tooling is copied from the platform checkout, byte for byte, and only to tools/collab (never scripts/collab: protected gate files)', () => {
  const files = seedFiles();
  for (const f of ['queue.mjs', 'land-guard.mjs', 'protected-gate-files.json']) {
    assert.equal(files.get(`tools/collab/${f}`), fs.readFileSync(path.join(REPO, 'scripts', 'collab', f), 'utf8'), f);
    assert.equal(files.has(`scripts/collab/${f}`), false);
  }
  assert.ok([...files.keys()].every((p) => !p.startsWith('scripts/collab/')));
  const root = tmp();
  fs.mkdirSync(path.join(root, 'scripts', 'collab'), { recursive: true });
  assert.throws(() => R.buildSeedFiles({ seedDir: SEED, platformRoot: root, gitlabPrivateIp: IP }), /collab tooling file scripts\/collab\/queue\.mjs is missing/);
});

test('seed: rehearsal.config.json carries the private address of the GitLab machine; without a valid address the seed cannot be built', () => {
  assert.deepEqual(JSON.parse(seedFiles().get('rehearsal.config.json')), { schema: 'vitana.rehearsal-config/v1', gitlabPrivateIp: IP });
  for (const bad of [undefined, '', '10.0.0', '10.0.0.256', 'gitlab.example.com']) {
    assert.throws(() => R.buildSeedFiles({ seedDir: SEED, platformRoot: REPO, gitlabPrivateIp: bad }), /private address of the GitLab machine is not known/, String(bad));
  }
});

test('seed: not one path of the seed is a protected gate file or a governance path, so the merge bot can land the seed merge request', () => {
  const paths = [...seedFiles().keys()];
  assert.deepEqual(R.seedRefusals(seedFiles(), PROTECTED_GATE_PATHS), []);
  assert.deepEqual(protectedTouched(paths, PROTECTED_GATE_PATHS), []);
  assert.deepEqual(protectedTouched(paths, GOVERNANCE_PATHS), []);
  assert.deepEqual(R.seedRefusals(new Map([['scripts/collab/queue.mjs', 'x']]), PROTECTED_GATE_PATHS), ['scripts/collab/queue.mjs'], 'the check does catch a protected file');
  assert.deepEqual(R.seedRefusals(new Map([['CLAUDE.md', 'x']]), PROTECTED_GATE_PATHS), ['CLAUDE.md']);
});

test('seed: blobId is the git blob id (what the repository tree reports), also for non-ASCII text', () => {
  for (const text of ['', 'hello\n', 'Größe · ü\n', 'x'.repeat(5000)]) {
    const git = execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim();
    assert.equal(R.blobId(text), git, JSON.stringify(text.slice(0, 12)));
  }
});

test('seed: diffSeed creates what main lacks, updates what differs, leaves what is equal, and never updates a file under a create-only prefix', () => {
  const files = new Map([['a.txt', 'one\n'], ['b.txt', 'two\n'], ['c.txt', 'three\n'], ['spec/l.md', 'seed text\n'], ['spec/new.md', 'new\n']]);
  const existing = new Map([['a.txt', R.blobId('one\n')], ['b.txt', R.blobId('OLD\n')], ['spec/l.md', R.blobId('grown by a run\n')]]);
  const d = R.diffSeed(files, existing, ['spec/']);
  assert.deepEqual(d, { create: ['c.txt', 'spec/new.md'], update: ['b.txt'], same: ['a.txt', 'spec/l.md'] });
  assert.deepEqual(R.seedActions(d, files), [
    { action: 'create', file_path: 'c.txt', content: 'three\n' }, { action: 'create', file_path: 'spec/new.md', content: 'new\n' }, { action: 'update', file_path: 'b.txt', content: 'two\n' },
  ]);
  const current = new Map([...files].map(([p, t]) => [p, R.blobId(t)]));
  assert.deepEqual(R.diffSeed(files, current, ['spec/']), { create: [], update: [], same: [...files.keys()] });
  const body = R.seedCommitBody({ branch: 'rehearsal/r1/seed', title: 'VTID-05540 (rehearsal/seed): seed', laneKey: 'rehearsal/seed' }, d, files, 'kiro-exafy-202611051400-0001');
  assert.deepEqual([body.branch, body.start_branch], ['rehearsal/r1/seed', 'main']);
  assert.match(body.commit_message, /Collab-Session: kiro-exafy-202611051400-0001\nCollab-Lane: rehearsal\/seed$/);
});

test('seed: pickPrivateIp takes the first private IPv4 of a real interface and skips loopback, docker, bridges and public addresses', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    'br-1a2b': [{ family: 'IPv4', address: '172.18.0.1', internal: false }],
    ens5: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '10.0.1.23', internal: false }],
    ens6: [{ family: 'IPv4', address: '203.0.113.9', internal: false }],
  };
  assert.equal(R.pickPrivateIp(ifaces), '10.0.1.23');
  assert.equal(R.pickPrivateIp({ ens5: [{ family: 4, address: '192.168.4.5', internal: false }] }), '192.168.4.5');
  assert.equal(R.pickPrivateIp({ ens5: [{ family: 'IPv4', address: '172.32.0.1', internal: false }] }), null, '172.32 is not private');
  assert.equal(R.pickPrivateIp({ lo: ifaces.lo, docker0: ifaces.docker0 }), null);
  assert.equal(R.pickPrivateIp(undefined), null);
});

// ---- the seed's own job: `npm test` with no install, then the three negative controls --------------------------------------------
function buildSeedTree(extra = {}) {
  const root = tmp('rehearse-seed-');
  for (const [p, text] of seedFiles()) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text); }
  for (const [p, text] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text); }
  return root;
}
const runSeedTest = (root, env = {}) => spawnSync(process.execPath, ['scripts/ci-test.mjs'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, NEGCTL_TIMEOUT_MS: '200', ...env }, timeout: 120_000 });
const negctlLines = (stdout) => stdout.split('\n').filter((l) => /^NEGCTL /.test(l));

test('seed: the required job of the project is `unit`, the central CI file runs `npm test` for it, and the package.json of the seed defines that script (the three files agree)', () => {
  const settings = baseConfig();
  assert.deepEqual(settings.projects.rehearsal.required_jobs, ['unit']);
  const ci = fs.readFileSync(path.join(REPO, 'infra', 'gitlab-engineering', 'ci', settings.projects.rehearsal.ci_file), 'utf8');
  assert.match(ci, /^unit:\n(?: {2}.*\n)*? {4}- npm test$/m, 'the job unit runs npm test');
  assert.equal(JSON.parse(seedFiles().get('package.json')).scripts.test, 'node scripts/ci-test.mjs');
  assert.match(ci, /image: public\.ecr\.aws\/docker\/library\/node:20/, 'the job image is Node 20: the seed needs no install');
});

test('seed: unit passes with no npm install (no node_modules, no dependency) and prints exactly three NEGCTL lines, one per control', () => {
  const root = buildSeedTree();
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/ci-test.mjs');
  assert.equal(pkg.dependencies, undefined);
  const r = runSeedTest(root);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const lines = negctlLines(r.stdout);
  assert.equal(lines.length, 3, r.stdout);
  assert.deepEqual(lines.map((l) => l.split(' ')[1]), ['imds', 'gitlab-host', 'aws-env']);
  assert.ok(lines.every((l) => /^NEGCTL (imds|gitlab-host|aws-env) (PASS|FAIL)$/.test(l)));
  assert.equal(lines[2], 'NEGCTL aws-env PASS', 'the child environment has no AWS_ variable');
  assert.match(r.stdout, /pass \d+|# pass \d+|✔/, 'the tests ran');
});

test('seed: a repository with no test files fails npm test (nothing proves nothing), and the negative controls are still printed', () => {
  const root = buildSeedTree();
  fs.rmSync(path.join(root, 'test'), { recursive: true, force: true });
  const r = runSeedTest(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ci-test: no test files found under test\//);
  assert.equal(negctlLines(r.stdout).length, 3);
});

test('seed: a failing test makes npm test fail, but the negative controls are still printed (they never change the exit code, and the report decides)', () => {
  const root = buildSeedTree({ 'test/lanes/red.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red', () => { assert.equal(1, 2); });\n" });
  const r = runSeedTest(root);
  assert.notEqual(r.status, 0);
  assert.equal(negctlLines(r.stdout).length, 3);
});

test('seed: a variable starting with AWS_ in the job makes aws-env print FAIL (names only, never the value); a missing address makes gitlab-host FAIL', () => {
  const root = buildSeedTree();
  const r = runSeedTest(root, { AWS_SECRET_ACCESS_KEY: 'never-print-this-value-0123', AWS_REGION: 'eu-central-1' });
  assert.equal(r.status, 0);
  assert.ok(negctlLines(r.stdout).includes('NEGCTL aws-env FAIL'));
  assert.doesNotMatch(r.stdout + r.stderr, /never-print-this-value-0123/);
  assert.match(r.stdout, /AWS_REGION, AWS_SECRET_ACCESS_KEY/);
  fs.rmSync(path.join(root, 'rehearsal.config.json'));
  const noIp = runSeedTest(root);
  assert.ok(negctlLines(noIp.stdout).includes('NEGCTL gitlab-host FAIL'), 'nothing proven without an address');
});

test('seed: a NEGCTL-INFO baseline line says whether the job reached GitLab (information only): it comes after the three controls and never changes a control line or the exit code', async () => {
  const root = buildSeedTree();
  const none = runSeedTest(root);
  assert.match(none.stdout, /^NEGCTL-INFO baseline gitlab: not checked \(CI_SERVER_URL is not set\)$/m);
  const closed = runSeedTest(root, { CI_SERVER_URL: 'http://127.0.0.1:9' }); // a closed port on the job's own loopback
  assert.match(closed.stdout, /^NEGCTL-INFO baseline gitlab: not reachable \(127\.0\.0\.1:9 [A-Z]+\)$/m);
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const open = runSeedTest(root, { CI_SERVER_URL: `http://127.0.0.1:${server.address().port}` });
    assert.match(open.stdout, /^NEGCTL-INFO baseline gitlab: reachable \(127\.0\.0\.1:\d+ accepted a connection\)$/m);
    for (const r of [none, closed, open]) {
      assert.equal(r.status, 0, r.stdout);
      assert.deepEqual(negctlLines(r.stdout).map((l) => l.split(' ').slice(0, 2).join(' ')), ['NEGCTL imds', 'NEGCTL gitlab-host', 'NEGCTL aws-env'], 'still exactly the three control lines');
      const lines = r.stdout.split('\n');
      assert.ok(lines.findIndex((l) => l.startsWith('NEGCTL-INFO')) > lines.findIndex((l) => l.startsWith('NEGCTL aws-env')), 'the baseline follows the controls');
    }
    assert.equal(negctlLines(open.stdout)[2], 'NEGCTL aws-env PASS');
  } finally { server.close(); }
  assert.deepEqual(R.parseNegctl(closed.stdout).map((l) => l.name), ['imds', 'gitlab-host', 'aws-env'], 'the report parser reads three control lines and ignores the baseline');
});

// ---- the controls with stand-ins for the network ----------------------------------------------------------------------------
const fakeRequest = (behaviour) => (options, cb) => {
  const handlers = {};
  const req = { on(ev, fn) { handlers[ev] = fn; return req; }, destroy() {}, end() { setImmediate(() => behaviour(options, cb, handlers)); } };
  return req;
};
const answers = (status) => (options, cb) => cb({ statusCode: status, resume() {} });
const fails = (code) => (options, cb, handlers) => handlers.error?.(Object.assign(new Error('x'), { code }));
const silent = () => {};

// The metadata service as a stand-in: `token` is what the token request meets, `read` what the plain read meets — a status, 'silent' (the
// request is never answered) or an error code.
const imdsStandIn = (token, read) => fakeRequest((options, cb, handlers) => {
  const how = options.method === 'PUT' ? token : read;
  if (how === 'silent') return silent();
  return (typeof how === 'number' ? answers(how) : fails(how))(options, cb, handlers);
});

test('negctl imds: PASS when no token is issued and no data is read — nothing answers (error or timeout), or the service answers 401, 403, 404 or 500; the statuses seen are in the detail', async () => {
  const { checkImds } = await importSeed('scripts/negctl.mjs');
  const run = (token, read) => checkImds({ timeoutMs: 20, request: imdsStandIn(token, read) });
  const gone = await run('EHOSTUNREACH', 'EHOSTUNREACH');
  assert.equal(gone.pass, true);
  assert.match(gone.detail, /PUT \/latest\/api\/token: failed \(EHOSTUNREACH\); GET \/latest\/meta-data\/: failed \(EHOSTUNREACH\)/);
  const quiet = await run('silent', 'silent');
  assert.equal(quiet.pass, true, 'no answer within the timeout');
  assert.match(quiet.detail, /PUT \/latest\/api\/token: no answer within 20 ms; GET \/latest\/meta-data\/: no answer within 20 ms/);
  for (const status of [302, 401, 403, 404, 500]) {
    const r = await run(status, status);
    assert.equal(r.pass, true, `HTTP ${status} to both: no token and no data reached the job`);
    assert.match(r.detail, new RegExp(`PUT /latest/api/token: HTTP ${status}; GET /latest/meta-data/: HTTP ${status}`));
    assert.match(r.detail, /no token and no data reached a job/);
  }
  // tokens required and hop limit 1, as AWS documents it: the answer to the token request never reaches the container, the plain read gets 401
  const hop = await run('silent', 401);
  assert.equal(hop.pass, true, 'this is the protection working');
  assert.match(hop.detail, /PUT \/latest\/api\/token: no answer within 20 ms; GET \/latest\/meta-data\/: HTTP 401/);
});

test('negctl imds: FAIL when a metadata token is issued to a job — the token request answers 2xx — whatever the plain read does', async () => {
  const { checkImds } = await importSeed('scripts/negctl.mjs');
  for (const [token, read] of [[200, 401], [201, 'EHOSTUNREACH'], [204, 403]]) {
    const r = await checkImds({ timeoutMs: 20, request: imdsStandIn(token, read) });
    assert.equal(r.pass, false, `the token request answered ${token}`);
    assert.match(r.detail, /a metadata token was issued/);
    assert.match(r.detail, new RegExp(`PUT /latest/api/token: HTTP ${token}`));
    assert.doesNotMatch(r.detail, /read without a token/);
  }
});

test('negctl imds: FAIL when a plain read without a token returns 2xx — the service gives data to an unauthenticated request — whatever the token request does; both together name both', async () => {
  const { checkImds } = await importSeed('scripts/negctl.mjs');
  for (const [token, read] of [['EHOSTUNREACH', 200], [401, 200], [403, 206]]) {
    const r = await checkImds({ timeoutMs: 20, request: imdsStandIn(token, read) });
    assert.equal(r.pass, false, `the plain read answered ${read}`);
    assert.match(r.detail, /metadata was read without a token/);
    assert.match(r.detail, new RegExp(`GET /latest/meta-data/: HTTP ${read}`));
    assert.doesNotMatch(r.detail, /token was issued/);
  }
  const both = await checkImds({ timeoutMs: 20, request: imdsStandIn(200, 200) });
  assert.equal(both.pass, false);
  assert.match(both.detail, /a metadata token was issued and metadata was read without a token/);
});

test('negctl imds: asks for a token with PUT (IMDSv2, with a TTL header) and reads with a GET that carries no token header; the control still prints exactly one line, with no detail on it', async () => {
  const { checkImds, formatLine, IMDS } = await importSeed('scripts/negctl.mjs');
  const seen = [];
  const request = fakeRequest((options, cb) => {
    seen.push({ line: `${options.method} ${options.host}:${options.port}${options.path}`, headers: options.headers ?? {} });
    cb({ statusCode: 401, resume() {} });
  });
  const r = await checkImds({ timeoutMs: 20, request });
  assert.deepEqual(seen.map((s) => s.line).sort(), [`GET ${IMDS.host}:80/latest/meta-data/`, `PUT ${IMDS.host}:80/latest/api/token`].sort());
  assert.equal(IMDS.host, '169.254.169.254');
  assert.equal(seen.find((s) => s.line.startsWith('PUT')).headers['X-aws-ec2-metadata-token-ttl-seconds'], '60');
  assert.deepEqual(Object.keys(seen.find((s) => s.line.startsWith('GET')).headers), [], 'the read carries no header at all, so no token');
  assert.equal(r.pass, true);
  assert.equal(formatLine(r), 'NEGCTL imds PASS');
  assert.equal(formatLine({ ...r, pass: false }), 'NEGCTL imds FAIL');
});

test('negctl imds: on a real local server — the token request never answered and the read answered 401 (tokens required, hop limit 1) is a PASS; a token issued is a FAIL and its body is never printed', async () => {
  const http = await import('node:http');
  const { checkImds } = await importSeed('scripts/negctl.mjs');
  const serve = async (handler) => {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { address: { host: '127.0.0.1', port: server.address().port }, close: () => { server.closeAllConnections?.(); server.close(); } };
  };
  const hop = await serve((req, res) => { if (req.method === 'PUT') return; res.statusCode = 401; res.end('401 - Unauthorized'); });
  try {
    const r = await checkImds({ timeoutMs: 600, address: hop.address });
    assert.equal(r.pass, true, r.detail);
    assert.match(r.detail, /PUT \/latest\/api\/token: no answer within 600 ms/);
    assert.match(r.detail, /GET \/latest\/meta-data\/: HTTP 401/);
  } finally { hop.close(); }
  const leaky = await serve((req, res) => { if (req.method === 'PUT') { res.statusCode = 200; res.end('AQAEA-the-token-body-that-must-never-be-printed'); return; } res.statusCode = 401; res.end(); });
  try {
    const r = await checkImds({ timeoutMs: 600, address: leaky.address });
    assert.equal(r.pass, false);
    assert.match(r.detail, /a metadata token was issued/);
    assert.doesNotMatch(r.detail, /the-token-body-that-must-never-be-printed/);
  } finally { leaky.close(); }
});

// ---- the baseline: can the job reach GitLab at all? (information only; a control never depends on it)
test('negctl baseline: tells whether the job can reach GitLab (the host and port of CI_SERVER_URL), as information only — reachable, not reachable, or not checked; never the URL itself', async () => {
  const { checkBaseline, formatInfo } = await importSeed('scripts/negctl.mjs');
  const tried = [];
  const connecting = (open) => (o) => { tried.push(`${o.host}:${o.port}`); return fakeConnect(open)(o); };
  const run = (url, open = []) => checkBaseline({ env: url === undefined ? {} : { CI_SERVER_URL: url }, timeoutMs: 50, connect: connecting(open) });
  const up = await run('https://gitlab.example.com', [443]);
  assert.deepEqual([up.name, up.state], ['gitlab', 'reachable']);
  assert.equal(formatInfo(up), 'NEGCTL-INFO baseline gitlab: reachable (gitlab.example.com:443 accepted a connection)');
  assert.equal((await run('http://gitlab.example.com', [80])).state, 'reachable');
  assert.equal((await run('https://gitlab.example.com:8443/', [8443])).state, 'reachable');
  assert.equal((await run('http://[::1]:8080', [8080])).state, 'reachable');
  assert.deepEqual(tried, ['gitlab.example.com:443', 'gitlab.example.com:80', 'gitlab.example.com:8443', '::1:8080'], 'default ports by scheme, the explicit port, no brackets on an IPv6 address');
  const down = await run('https://gitlab.example.com', []);
  assert.equal(down.state, 'not reachable');
  assert.match(formatInfo(down), /^NEGCTL-INFO baseline gitlab: not reachable \(gitlab\.example\.com:443 ECONNREFUSED\)$/);
  tried.length = 0;
  for (const url of [undefined, '', 'not a url', 'ftp://gitlab.example.com', 'https://']) {
    const r = await run(url, [443]);
    assert.equal(r.state, 'not checked', String(url));
    assert.match(formatInfo(r), /^NEGCTL-INFO baseline gitlab: not checked \(CI_SERVER_URL is (not set|not an http\(s\) URL)\)$/);
  }
  assert.deepEqual(tried, [], 'nothing is tried without a usable URL');
  const secret = formatInfo(await run('https://someone:hunter2-password@gitlab.example.com/x?token=abc123', [443]));
  assert.doesNotMatch(secret, /someone|hunter2|abc123|\/x/, 'only the host and port are printed');
});

const fakeConnect = (open) => ({ port }) => {
  const handlers = {};
  const s = { on(ev, fn) { handlers[ev] = fn; if (ev === 'connect' && open.includes(port)) setImmediate(fn); if (ev === 'error' && !open.includes(port)) setImmediate(() => fn(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))); return s; }, destroy() {} };
  return s;
};

test('negctl gitlab-host: PASS when 22, 80, 443 and 8080 all refuse; FAIL when any accepts a connection; FAIL when no valid address is configured', async () => {
  const { checkGitlabHost, HOST_PORTS } = await importSeed('scripts/negctl.mjs');
  assert.deepEqual([...HOST_PORTS], [22, 80, 443, 8080]);
  assert.equal((await checkGitlabHost({ ip: IP, timeoutMs: 50, connect: fakeConnect([]) })).pass, true);
  for (const port of HOST_PORTS) {
    const r = await checkGitlabHost({ ip: IP, timeoutMs: 50, connect: fakeConnect([port]) });
    assert.equal(r.pass, false, `port ${port} open`);
    assert.match(r.detail, new RegExp(`${port}: connected`));
  }
  for (const ip of [undefined, '', 'gitlab.example.com', '10.0.0.999']) assert.equal((await checkGitlabHost({ ip, timeoutMs: 50, connect: fakeConnect([]) })).pass, false, String(ip));
  const timedOut = () => { const s = { on: () => s, destroy() {} }; return s; };
  assert.equal((await checkGitlabHost({ ip: IP, timeoutMs: 30, connect: timedOut })).pass, true, 'a connection that never completes is not a connection');
});

test('negctl aws-env: PASS without a variable starting AWS_; FAIL with one, naming the variables sorted and never their values; lines are exactly NEGCTL <name> PASS|FAIL', async () => {
  const { checkAwsEnv, formatLine, runAll, NAMES } = await importSeed('scripts/negctl.mjs');
  assert.deepEqual([...NAMES], R.NEGCTL);
  assert.equal(checkAwsEnv({ PATH: '/bin', MY_AWS_THING: '1', aws_lower: '1' }).pass, true, 'only names that start with AWS_');
  const bad = checkAwsEnv({ AWS_SESSION_TOKEN: 'hush-sess1', AWS_ACCESS_KEY_ID: 'hush-key01' });
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /AWS_ACCESS_KEY_ID, AWS_SESSION_TOKEN/);
  assert.doesNotMatch(bad.detail, /hush-/);
  assert.equal(formatLine({ name: 'gitlab-host', pass: true }), 'NEGCTL gitlab-host PASS');
  assert.equal(formatLine({ name: 'imds', pass: false }), 'NEGCTL imds FAIL');
  const all = await runAll({ env: { PATH: '/bin' }, config: { gitlabPrivateIp: IP }, timeoutMs: 20, request: fakeRequest(fails('EHOSTUNREACH')), connect: fakeConnect([]) });
  assert.deepEqual(all.map((r) => r.name), ['imds', 'gitlab-host', 'aws-env']);
  assert.ok(all.every((r) => r.pass));
});

// ============================================================================================================================
// 5. THE COMMITS, AGAINST THE MERGE BOT ITSELF (real git; the functions of gitlab-land.mjs, land-guard.mjs and queue.mjs, imported)
// ============================================================================================================================
const RUN = 'r202611051400';
const GIT_ENV = {
  ...process.env, GIT_AUTHOR_NAME: 'builder', GIT_AUTHOR_EMAIL: 'builder@test', GIT_COMMITTER_NAME: 'builder', GIT_COMMITTER_EMAIL: 'builder@test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const writeFile = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

/** A bare "GitLab project" and a clone, holding the real seed on main. */
function gitWorld() {
  const root = tmp('rehearse-git-');
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { env: GIT_ENV });
  execFileSync('git', ['clone', '-q', remote, work], { env: GIT_ENV, stdio: 'ignore' });
  g(work, 'checkout', '-q', '-b', 'main');
  for (const [p, t] of seedFiles()) writeFile(work, p, t);
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'seed');
  g(work, 'push', '-q', 'origin', 'main');
  return { root, remote, work };
}
/** Applies a Commits API body the way GitLab does: a new branch from start_branch, create refuses an existing file, update needs one. */
function applyBody(w, body, who = 'builder') {
  let exists = true;
  try { g(w.work, 'rev-parse', '--verify', '-q', `refs/heads/${body.branch}`); } catch { exists = false; }
  if (!exists) g(w.work, 'checkout', '-q', '-B', body.branch, `origin/${body.start_branch ?? 'main'}`); else g(w.work, 'checkout', '-q', body.branch);
  for (const a of body.actions) {
    const there = fs.existsSync(path.join(w.work, a.file_path));
    assert.equal(a.action === 'create' ? !there : there, true, `${a.action} ${a.file_path}: the file ${there ? 'already exists' : 'does not exist'}`);
    writeFile(w.work, a.file_path, a.content);
  }
  g(w.work, 'add', '-A');
  execFileSync('git', ['-C', w.work, 'commit', '-q', '-F', '-'], { input: body.commit_message, env: { ...GIT_ENV, GIT_AUTHOR_NAME: who, GIT_COMMITTER_NAME: who } });
  return g(w.work, 'rev-parse', 'HEAD');
}
const SEAT_SESSION = 'kiro-exafy-202611051400-0001';
const REVIEWER_SESSION = 'agent-vitana-lane-reviewer-202611051400-0002';
function builtAndReviewed(w, item, { review = true } = {}) {
  const built = applyBody(w, R.builderCommitBody(item, { runId: RUN, session: SEAT_SESSION }));
  if (!review) return { built, head: built };
  const laneText = fs.readFileSync(path.join(w.work, item.laneFile), 'utf8');
  const head = applyBody(w, R.reviewCommitBody(item, { session: REVIEWER_SESSION, reviewedHead: built, laneText, ms: NOW0 }), 'agent-reviewer');
  return { built, head };
}
/** What the bot concludes about a head, from the same functions evaluate() uses (gitlab-land.mjs). */
function botVerdict(w, item, head, { pushed = true, checks = { state: 'pass', detail: 'green' } } = {}) {
  const files = g(w.work, 'diff', '--name-only', '--no-renames', `origin/main...${head}`).split('\n').filter(Boolean);
  const protectedFiles = protectedTouched(files, PROTECTED_GATE_PATHS);
  const behindBy = Number(g(w.work, 'rev-list', '--count', `${head}..origin/main`));
  const commits = commitsInRange(w.work, 'origin/main', head);
  const judged = land.judgeReviewCommit(commits, item.laneKey, { pushed, reviewerUser: land.DEFAULTS.reviewerUser });
  let review = { ok: judged.ok, reason: judged.reason, code: judged.code };
  if (judged.ok) {
    const walk = localAfter(w.work, judged.commit.reviewedHead, head, item.laneKey);
    const current = reviewCurrent(judged.commit.reviewedHead, head, walk.after, item.laneKey, walk.prDiffSame);
    review = { ...current, code: current.ok ? 'review_found' : 'review_stale' };
  }
  return { commits, judged, review, protectedFiles, behindBy, decision: land.decide({ review, checks, behindBy, protectedFiles }) };
}

test('commits: the builder commit and the accept of the reviewer are read by commitsInRange of the bot itself, with the trailers it trusts', () => {
  const w = gitWorld();
  const item = lanePlan().lanes[0];
  const { built, head } = builtAndReviewed(w, item);
  const [review, builder] = commitsInRange(w.work, 'origin/main', head);
  assert.equal(builder.lane, 'rehearsal/lane-01');
  assert.equal(builder.session, SEAT_SESSION);
  assert.equal(review.review, 'rehearsal/lane-01');
  assert.equal(review.verdict, 'accept');
  assert.match(review.reviewer, /^agent:vitana-lane-reviewer \(/);
  assert.equal(review.reviewedHead, built);
  assert.match(review.reviewedHead, /^[0-9a-f]{40}$/);
  assert.equal(review.session, REVIEWER_SESSION);
  assert.deepEqual(review.files, [item.laneFile], 'the review commit changes the lane file and nothing else');
});

test('commits: an accept pushed by agent-reviewer is judged ok by judgeReviewCommit, still counts for the head (reviewCurrent), and with green checks the bot decides to land', () => {
  const w = gitWorld();
  const item = lanePlan().lanes[0];
  const { head } = builtAndReviewed(w, item);
  const v = botVerdict(w, item, head);
  assert.equal(v.judged.ok, true, JSON.stringify(v.judged));
  assert.equal(v.judged.code, 'review_found');
  assert.equal(v.review.ok, true, v.review.reason);
  assert.deepEqual(v.protectedFiles, []);
  assert.equal(v.behindBy, 0);
  assert.equal(v.decision.action, 'land');
});

test('control no_review: a merge request with only the commit of the builder has no review for its lane; the bot answers no_review', () => {
  const w = gitWorld();
  const item = lanePlan().controls[0];
  const { head } = builtAndReviewed(w, item, { review: false });
  const v = botVerdict(w, item, head, { pushed: false });
  assert.equal(v.judged.code, 'no_review');
  assert.equal(v.decision.action, 'skip');
  assert.equal(v.decision.reasonCode, 'no_review');
});

test('control builder_accept: the same words written by the account of the builder are read as an accept, but since agent-reviewer did not push them the bot answers review_forged', () => {
  const w = gitWorld();
  const item = lanePlan().controls[2];
  const built = applyBody(w, R.builderCommitBody(item, { runId: RUN, session: SEAT_SESSION }));
  const laneText = fs.readFileSync(path.join(w.work, item.laneFile), 'utf8');
  const head = applyBody(w, R.forgedAcceptBody(item, { session: SEAT_SESSION, reviewedHead: built, laneText, ms: NOW0 }), 'agent-kiro-hotmail');
  const forged = botVerdict(w, item, head, { pushed: false });
  assert.equal(forged.judged.code, 'review_forged');
  assert.equal(forged.decision.reasonCode, 'review_forged');
  const real = botVerdict(w, item, head, { pushed: true });
  assert.equal(real.decision.action, 'land', 'only the missing push event makes the difference');
});

test('control stale_review: code written after the accept ends the review (reviewCurrent) and the bot answers review_stale', () => {
  const w = gitWorld();
  const item = lanePlan().controls[1];
  const { head: reviewed } = builtAndReviewed(w, item);
  assert.equal(botVerdict(w, item, reviewed).decision.action, 'land', 'before the change it would land');
  const changed = applyBody(w, R.staleChangeBody(item, { runId: RUN, session: SEAT_SESSION }));
  const v = botVerdict(w, item, changed);
  assert.equal(v.judged.ok, true, 'the accept is still the newest review of the lane');
  assert.equal(v.review.ok, false);
  assert.equal(v.decision.action, 'skip');
  assert.equal(v.decision.reasonCode, 'review_stale');
});

test('control red_job: a reviewed merge request whose required job `unit` failed is refused with checks_failed (checksFor and decide of the bot)', () => {
  const w = gitWorld();
  const item = lanePlan().controls[3];
  const { head } = builtAndReviewed(w, item);
  const jobs = [{ id: 7, name: 'unit', status: 'failed', allow_failure: false, started_at: '2026-11-05T14:10:00Z' }];
  const checks = land.checksFor({ id: 9, status: 'failed', sha: head }, jobs, ['unit']);
  const v = botVerdict(w, item, head, { checks });
  assert.equal(v.review.ok, true);
  assert.equal(v.decision.action, 'skip');
  assert.equal(v.decision.reasonCode, 'checks_failed');
});

test('control protected_file: a merge request that adds CLAUDE.md, even with a valid review and green checks, is refused with protected_gate_file', () => {
  const w = gitWorld();
  const item = lanePlan().controls[4];
  const { head } = builtAndReviewed(w, item);
  const v = botVerdict(w, item, head);
  assert.deepEqual(v.protectedFiles, ['CLAUDE.md']);
  assert.equal(v.decision.action, 'skip');
  assert.equal(v.decision.reasonCode, 'protected_gate_file');
});

test('commits: the review survives the merge of main into the branch by the bot after another lane landed (the files of two lanes are disjoint), and the bot then lands it', () => {
  const w = gitWorld();
  const [one, two] = lanePlan().lanes;
  const first = builtAndReviewed(w, one);
  const second = builtAndReviewed(w, two);
  // lane 01 lands: GitLab squashes it into main
  g(w.work, 'checkout', '-q', 'main');
  g(w.work, 'merge', '--squash', '-q', first.head);
  g(w.work, 'commit', '-q', '-m', one.title);
  g(w.work, 'push', '-q', 'origin', 'main');
  g(w.work, 'fetch', '-q', 'origin');
  const behind = botVerdict(w, two, second.head);
  assert.equal(behind.behindBy, 1);
  assert.equal(behind.decision.action, 'update', 'behind main: the bot updates the branch first');
  // the update, as updateOne() of gitlab-land.mjs does it
  g(w.work, 'checkout', '-q', two.branch);
  execFileSync('git', ['-C', w.work, 'merge', '--no-ff', '-q', '-m', `Merge branch 'main' into ${two.branch}\n\nCollab-Session: bot-land`, 'origin/main'], { env: { ...GIT_ENV, GIT_AUTHOR_NAME: 'bot-land', GIT_COMMITTER_NAME: 'bot-land' } });
  const head = g(w.work, 'rev-parse', 'HEAD');
  const v = botVerdict(w, two, head);
  assert.equal(v.behindBy, 0);
  assert.equal(v.judged.ok, true);
  assert.equal(v.review.ok, true, `the review must survive the merge of main: ${v.review.reason}`);
  assert.deepEqual(v.protectedFiles, []);
  assert.equal(v.decision.action, 'land');
});

test('commits: no two merge requests of a run touch the same path (so no conflict and the PR diff of a review never changes), and only the protected control touches a protected path', () => {
  const plan = lanePlan(12);
  const seen = new Map();
  for (const item of plan.order) {
    for (const p of [...Object.keys(R.builderFiles(item, RUN)), item.laneFile, R.staleChangeBody(item, { runId: RUN, session: 's' }).actions[0].file_path]) {
      if (p === item.laneFile && item.kind === 'land') { /* lane file of a lane is in the seed; only its owner appends */ }
      assert.equal(seen.has(p) && seen.get(p) !== item.id, false, `${p} is touched by ${seen.get(p)} and ${item.id}`);
      seen.set(p, item.id);
    }
  }
  const touched = [...seen.keys()];
  assert.deepEqual(protectedTouched(touched, PROTECTED_GATE_PATHS), ['CLAUDE.md']);
  assert.deepEqual(protectedTouched(touched.filter((p) => p !== 'CLAUDE.md'), GOVERNANCE_PATHS), []);
  assert.equal(seen.get('CLAUDE.md'), 'ctl-protected-file');
  const seedPaths = new Set(seedFiles().keys());
  for (const item of plan.lanes) assert.ok(seedPaths.has(item.laneFile), `${item.laneFile} is in the seed`);
  for (const item of plan.controls) assert.equal(seedPaths.has(item.laneFile), false, `${item.laneFile} is created by its control, not by the seed`);
});

test('commits: the review commit is one update of the lane file that keeps its old text and appends an entry; the reviewer and the builder never put the same session in a commit', () => {
  const item = lanePlan().lanes[2];
  const old = '---\nlane: lane-03\n---\n# Lane\n\n## Log\n### t · seed · ready\nLane created.\n';
  const body = R.reviewCommitBody(item, { session: REVIEWER_SESSION, reviewedHead: 'a'.repeat(40), laneText: old, ms: NOW0 });
  assert.equal(body.actions.length, 1);
  assert.equal(body.actions[0].action, 'update');
  assert.equal(body.actions[0].file_path, item.laneFile);
  assert.ok(body.actions[0].content.startsWith(old));
  assert.match(body.actions[0].content, /### 2026-11-05T14:00Z · agent-vitana-lane-reviewer-202611051400-0002 · review\nverdict: accept\nreviewed head: a{40}\n$/);
  assert.equal(body.branch, item.branch);
  assert.equal(body.start_branch, undefined, 'it goes on top of the existing branch');
  assert.equal(R.appendLaneEntry('no newline', { ts: 't', session: 's', verdict: 'accept', reviewedHead: 'h' }).startsWith('no newline\n\n###'), true);
  const builder = R.builderCommitBody(item, { runId: RUN, session: SEAT_SESSION });
  assert.deepEqual([builder.branch, builder.start_branch], [item.branch, 'main']);
  assert.ok(builder.actions.every((a) => a.action === 'create'));
});

test('commits: the test of a lane passes and the test of the red-job control fails (the generated files really behave so)', () => {
  const run = (item) => {
    const root = tmp('rehearse-lane-');
    for (const [p, t] of Object.entries(R.builderFiles(item, RUN))) writeFile(root, p, t);
    // an explicit env: a child `node --test` that inherits NODE_TEST_CONTEXT from this runner reports through its parent and exits 0
    return spawnSync(process.execPath, ['--test', `test/lanes/${RUN}-${item.id}.test.mjs`], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  };
  const plan = lanePlan();
  assert.equal(run(plan.lanes[0]).status, 0);
  assert.equal(run(plan.controls[0]).status, 0);
  const red = run(plan.controls[3]);
  assert.notEqual(red.status, 0);
  assert.match(red.stdout, /red-job control of the rehearsal fails on purpose/);
});

test('bot: the real evaluate() of the merge bot, run on branches made from the commit bodies of the rehearsal in a local git remote with a fake GitLab, lands a reviewed lane and gives each control the reason the report expects — and shows when a lane is refused only because GitLab has not recorded the push yet', async () => {
  const w = gitWorld();
  const plan = lanePlan();
  const item = (id) => plan.order.find((i) => i.id === id);
  const PID = 'vitana%2Frehearsal';
  const project = { name: 'rehearsal', path: 'vitana/rehearsal', landing: true, required_jobs: ['unit'] };
  const tokenFile = path.join(w.root, 'token');
  fs.writeFileSync(tokenFile, 'fixture-token-0123456789abcdef\n');
  const workdir = path.join(w.root, 'botdir');
  const botRepo = path.join(workdir, 'rehearsal.git');
  const push = (branch) => g(w.work, 'push', '-q', '-f', 'origin', branch);
  const laneTextOf = (it) => fs.readFileSync(path.join(w.work, it.laneFile), 'utf8');
  const built = (it) => { const sha = applyBody(w, R.builderCommitBody(it, { runId: RUN, session: SEAT_SESSION })); push(it.branch); return sha; };
  const reviewed = (it, head) => { const sha = applyBody(w, R.reviewCommitBody(it, { session: REVIEWER_SESSION, reviewedHead: head, laneText: laneTextOf(it), ms: NOW0 }), 'agent-reviewer'); push(it.branch); return sha; };
  let eventId = 0;
  // a push event as the GitLab Events API documents it: commit_from is the old tip, null when the push created the branch
  const pushEvent = (user, from, to, branch) => ({ id: ++eventId, action_name: 'pushed to', author_username: user, push_data: { commit_count: 1, action: from ? 'pushed' : 'created', ref_type: 'branch', commit_from: from, commit_to: to, ref: branch, commit_title: 't' } });
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  let iidSeq = 0;
  async function judge(it, head, events, { red = false } = {}) {
    const iid = ++iidSeq;
    g(w.remote, 'update-ref', `refs/merge-requests/${iid}/head`, head);
    const fetch = async (url) => {
      const u = new URL(url);
      const p = u.pathname.replace('/api/v4', '');
      if (p === `/projects/${PID}/events`) return json(events);
      if (p === `/projects/${PID}/pipelines`) return json([{ id: 900 + iid, sha: u.searchParams.get('sha'), status: red ? 'failed' : 'success', created_at: '2026-11-05T14:00:00Z' }]);
      if (/\/pipelines\/\d+\/jobs$/.test(p)) return json([{ id: 1, name: 'unit', status: red ? 'failed' : 'success', allow_failure: false, started_at: '2026-11-05T14:01:00Z' }]);
      if (/\/merge_requests\/\d+\/notes$/.test(p)) return json([]);
      return new Response('{"message":"404 Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    };
    const ctx = land.makeContext({ projectsOverride: [project], workdir, 'token-file': tokenFile, remoteUrl: () => w.remote }, { fetch, write: () => {}, now: () => NOW0 + 300_000 });
    if (!fs.existsSync(botRepo)) { fs.mkdirSync(workdir, { recursive: true }); execFileSync('git', ['init', '--bare', '-q', botRepo], { env: GIT_ENV }); g(botRepo, 'remote', 'add', 'origin', w.remote); }
    g(botRepo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const mr = { iid, title: it.title, sha: head, source_branch: it.branch, created_at: '2026-11-05T14:00:00Z', updated_at: '2026-11-05T14:00:00Z', description: '', draft: false };
    const v = await land.evaluate(ctx, project, botRepo, mr);
    return `${v.action}/${v.reasonCode}`;
  }
  const got = [];
  { // a lane, reviewed by agent-reviewer
    const it = item('lane-01');
    const b = built(it);
    const r = reviewed(it, b);
    got.push(['a reviewed lane', await judge(it, r, [pushEvent('agent-reviewer', b, r, it.branch), pushEvent(it.seat, null, b, it.branch)])]);
    got.push(['the same, GitLab has not recorded the push of the review yet', await judge(it, r, [pushEvent(it.seat, null, b, it.branch)])]);
    got.push(['the same, the event reports the push as a branch creation', await judge(it, r, [pushEvent('agent-reviewer', null, r, it.branch)])]);
  }
  { // the accept written by the account of the builder
    const it = item('ctl-builder-accept');
    const b = built(it);
    const forged = applyBody(w, R.forgedAcceptBody(it, { session: SEAT_SESSION, reviewedHead: b, laneText: laneTextOf(it), ms: NOW0 }), it.seat);
    push(it.branch);
    got.push(['an accept pushed by the builder', await judge(it, forged, [pushEvent(it.seat, b, forged, it.branch), pushEvent(it.seat, null, b, it.branch)])]);
  }
  { // code pushed after the review
    const it = item('ctl-stale-review');
    const b = built(it);
    const r = reviewed(it, b);
    const later = applyBody(w, R.staleChangeBody(it, { runId: RUN, session: SEAT_SESSION }));
    push(it.branch);
    got.push(['code pushed after the accept', await judge(it, later, [pushEvent(it.seat, r, later, it.branch), pushEvent('agent-reviewer', b, r, it.branch), pushEvent(it.seat, null, b, it.branch)])]);
  }
  { // a reviewed lane whose required job is red
    const it = item('ctl-red-job');
    const b = built(it);
    const r = reviewed(it, b);
    got.push(['a reviewed lane with a red job', await judge(it, r, [pushEvent('agent-reviewer', b, r, it.branch)], { red: true })]);
  }
  { // a reviewed lane that adds CLAUDE.md
    const it = item('ctl-protected-file');
    const b = built(it);
    const r = reviewed(it, b);
    got.push(['a reviewed lane that adds CLAUDE.md', await judge(it, r, [pushEvent('agent-reviewer', b, r, it.branch)])]);
  }
  { // no review at all
    const it = item('ctl-no-review');
    const b = built(it);
    got.push(['no review', await judge(it, b, [pushEvent(it.seat, null, b, it.branch)])]);
  }
  { // another lane lands first: the bot brings this one up to date, and the review survives the merge of main
    const it = item('lane-02');
    const b = built(it);
    const r = reviewed(it, b);
    const other = item('lane-03');
    const ob = built(other);
    const orv = reviewed(other, ob);
    g(w.work, 'checkout', '-q', 'main');
    g(w.work, 'merge', '-q', '--squash', orv);
    execFileSync('git', ['-C', w.work, 'commit', '-q', '-m', other.title], { env: GIT_ENV });
    push('main');
    got.push(['lane-02 after lane-03 landed on main', await judge(it, r, [pushEvent('agent-reviewer', b, r, it.branch)])]);
    g(w.work, 'checkout', '-q', it.branch);
    execFileSync('git', ['-C', w.work, 'merge', '--no-ff', '-q', '-m', `Merge branch 'main' into ${it.branch}\n\nCollab-Session: bot-land`, 'origin/main'], { env: { ...GIT_ENV, GIT_AUTHOR_NAME: 'bot-land', GIT_COMMITTER_NAME: 'bot-land' } });
    const merged = g(w.work, 'rev-parse', 'HEAD');
    push(it.branch);
    got.push(['lane-02 after the bot merged main into it', await judge(it, merged, [pushEvent('bot-land', r, merged, it.branch), pushEvent('agent-reviewer', b, r, it.branch)])]);
  }
  assert.deepEqual(got, [
    ['a reviewed lane', 'land/ready'],
    ['the same, GitLab has not recorded the push of the review yet', 'skip/review_forged'],
    ['the same, the event reports the push as a branch creation', 'land/ready'],
    ['an accept pushed by the builder', 'skip/review_forged'],
    ['code pushed after the accept', 'skip/review_stale'],
    ['a reviewed lane with a red job', 'skip/checks_failed'],
    ['a reviewed lane that adds CLAUDE.md', 'skip/protected_gate_file'],
    ['no review', 'skip/no_review'],
    ['lane-02 after lane-03 landed on main', 'update/behind'],
    ['lane-02 after the bot merged main into it', 'land/ready'],
  ]);
});

// ============================================================================================================================
// 6. THE PARSERS
// ============================================================================================================================
test('parseNegctl: reads the three lines from a GitLab trace with ANSI codes, CRLF and lone carriage returns; look-alikes are not lines', () => {
  const trace = [
    '\x1b[0KRunning with gitlab-runner 17', '$ npm test', '$ echo NEGCTL imds PASS', '  NEGCTL imds PASS', 'xNEGCTL imds PASS', 'NEGCTL imds PASSED', 'NEGCTL other PASS', 'negctl imds pass', 'NEGCTL imds  PASS',
    'NEGCTL-INFO imds PASS', 'NEGCTL-INFO baseline gitlab: reachable (gitlab.example.com:443 accepted a connection)',
    '\x1b[32;1mNEGCTL imds PASS\x1b[0;m', 'NEGCTL gitlab-host FAIL\r', 'progress 1\rNEGCTL aws-env PASS', 'NEGCTL aws-env PASS ', '',
  ].join('\r\n');
  assert.deepEqual(R.parseNegctl(trace), [{ name: 'imds', result: 'PASS' }, { name: 'gitlab-host', result: 'FAIL' }, { name: 'aws-env', result: 'PASS' }], 'a NEGCTL-INFO line is never a control line');
  assert.deepEqual(R.parseNegctl(''), []);
  assert.deepEqual(R.parseNegctl(undefined), []);
  assert.deepEqual(R.parseNegctl('NEGCTL imds PASS'), [{ name: 'imds', result: 'PASS' }]);
});

test('parseNegctlFailures: for each control that printed FAIL, the detail line the job printed just before it (`negctl: <name>: <detail>`), or an empty detail when the job printed none', () => {
  const trace = [
    'ci-test: negative controls (plan eng-gitlab-m2, acceptance A2)',
    'negctl: imds: a metadata token was issued to a job (PUT /latest/api/token: HTTP 200; GET /latest/meta-data/: HTTP 401)', 'NEGCTL imds FAIL',
    'negctl: gitlab-host: 10.0.1.23 accepted no connection (22: ECONNREFUSED)', 'NEGCTL gitlab-host PASS',
    'NEGCTL aws-env FAIL',
  ].join('\r\n');
  assert.deepEqual(R.parseNegctlFailures(trace), [
    { name: 'imds', detail: 'a metadata token was issued to a job (PUT /latest/api/token: HTTP 200; GET /latest/meta-data/: HTTP 401)' },
    { name: 'aws-env', detail: '' },
  ]);
  assert.deepEqual(R.parseNegctlFailures('negctl: imds: x\nNEGCTL imds PASS'), []);
  assert.deepEqual(R.parseNegctlFailures('negctl: imds: x\nNEGCTL-INFO imds FAIL\nNEGCTL imds FAIL extra'), [], 'a look-alike is not a control line');
  assert.deepEqual(R.parseNegctlFailures('negctl: gitlab-host: not mine\nNEGCTL imds FAIL'), [{ name: 'imds', detail: '' }], 'a detail belongs to its own control');
  assert.deepEqual(R.parseNegctlFailures('\x1b[32;1mnegctl: imds: coloured\x1b[0;m\nNEGCTL imds FAIL'), [{ name: 'imds', detail: 'coloured' }]);
  assert.deepEqual(R.parseNegctlFailures(undefined), []);
});

test('parseBaseline: reads the NEGCTL-INFO baseline lines (reachable, not reachable, not checked) and nothing that only looks like one', () => {
  const trace = [
    'NEGCTL-INFO baseline gitlab: reachable (gitlab.example.com:443 accepted a connection)', 'NEGCTL-INFO baseline gitlab: not reachable (gitlab.example.com:443 ECONNREFUSED)',
    '\x1b[32;1mNEGCTL-INFO baseline gitlab: not checked (CI_SERVER_URL is not set)\x1b[0;m', 'NEGCTL-INFO baseline gitlab: unknown (x)', ' NEGCTL-INFO baseline gitlab: reachable (indented)', 'NEGCTL baseline gitlab: reachable (x)', 'NEGCTL-INFO other gitlab: reachable (x)',
  ].join('\r\n');
  assert.deepEqual(R.parseBaseline(trace), [
    { name: 'gitlab', state: 'reachable' }, { name: 'gitlab', state: 'not reachable' }, { name: 'gitlab', state: 'not checked' },
  ]);
  assert.deepEqual(R.parseBaseline(''), []);
  assert.deepEqual(R.parseBaseline(undefined), []);
});

test('parseBotNote: reads the reason code and the head from the comment of bot-land; the same marker from anyone else, a bad head or no marker is nothing', () => {
  const head = 'b'.repeat(40);
  const body = `Not landed: there is no reviewer accept for this lane on the merge request.\n\n<!-- vitana-land:no_review:${head} -->`;
  assert.deepEqual(R.parseBotNote({ body, author: { username: 'bot-land' } }), { code: 'no_review', head, text: 'Not landed: there is no reviewer accept for this lane on the merge request.' });
  assert.equal(R.parseBotNote({ body, author: { username: 'agent-kiro-exafy' } }), null, 'a builder pasting the marker proves nothing');
  assert.equal(R.parseBotNote({ body: body.replace(head, 'zz'), author: { username: 'bot-land' } }), null);
  assert.equal(R.parseBotNote({ body: body.replace(head, 'abcd'), author: { username: 'bot-land' } }), null, 'a head is 40 hex characters');
  assert.equal(R.parseBotNote({ body: body.replace(head, 'b'.repeat(41)), author: { username: 'bot-land' } }), null);
  assert.equal(R.parseBotNote({ body: 'Merged.', author: { username: 'bot-land' } }), null);
  assert.equal(R.parseBotNote({ body, author: null }), null);
  assert.equal(R.parseBotNote(null), null);
  for (const code of ['no_review', 'review_stale', 'review_forged', 'checks_failed', 'protected_gate_file']) {
    assert.equal(R.parseBotNote({ body: `x\n\n<!-- vitana-land:${code}:${head} -->`, author: { username: 'bot-land' } }).code, code);
  }
});

test('parseBotNote: the codes the controls expect are comments the bot really writes (COMMENT_TEXT of gitlab-land.mjs is read from its source)', () => {
  const src = fs.readFileSync(path.join(HERE, 'gitlab-land.mjs'), 'utf8');
  for (const c of R.CONTROLS) assert.match(src, new RegExp(`\\n  ${c.expect}: '`), `${c.expect} is a COMMENT_TEXT entry`);
});

test('parseFleetSample: a machine counts as active when it is Pending or InService and not while Terminating; total counts every machine; an empty group has 0', () => {
  const group = (states, desired = 3) => ({ AutoScalingGroups: [{ DesiredCapacity: desired, Instances: states.map((s, i) => ({ InstanceId: `i-${i}`, LifecycleState: s })) }] });
  assert.deepEqual(R.parseFleetSample(group(['InService', 'Pending', 'Pending:Wait', 'Terminating', 'Terminating:Wait', 'Detaching']), 5), { t: 5, ok: true, total: 6, active: 3, desired: 3 });
  assert.deepEqual(R.parseFleetSample(group([], 0), 7), { t: 7, ok: true, total: 0, active: 0, desired: 0 });
  assert.equal(R.parseFleetSample({ AutoScalingGroups: [] }, 1).ok, false);
  assert.equal(R.parseFleetSample({}, 1).ok, false);
  assert.equal(R.parseFleetSample({ AutoScalingGroups: [{ Instances: [] }] }, 1).desired, null);
});

test('countLaunches: counts launch activities since the start of the run; a Failed or Cancelled launch is not a machine; terminations and older activities are ignored', () => {
  const since = Date.parse('2026-11-05T14:00:00Z');
  const act = (desc, code, start, msg) => ({ Description: desc, StatusCode: code, StartTime: start, StatusMessage: msg });
  const list = [
    act('Launching a new EC2 instance: i-1', 'Successful', '2026-11-05T14:05:00Z'),
    act('Launching a new EC2 instance: i-2', 'InProgress', '2026-11-05T14:06:00Z'),
    act('Launching a new EC2 instance: i-3', 'Failed', '2026-11-05T14:07:00Z', 'We currently do not have sufficient m6i.xlarge capacity'),
    act('Launching a new EC2 instance: i-4', 'Cancelled', '2026-11-05T14:08:00Z', 'cancelled'),
    act('Terminating EC2 instance: i-1', 'Successful', '2026-11-05T14:09:00Z'),
    act('Launching a new EC2 instance: i-0', 'Successful', '2026-11-05T13:59:59Z'),
    act('Launching a new EC2 instance: i-5', 'Successful', '2026-11-05T14:00:00Z'),
  ];
  assert.deepEqual(R.countLaunches(list, since), { launched: 3, failed: 2, failures: ['We currently do not have sufficient m6i.xlarge capacity', 'cancelled'] });
  assert.deepEqual(R.countLaunches([], since), { launched: 0, failed: 0, failures: [] });
  assert.deepEqual(R.countLaunches(null, since), { launched: 0, failed: 0, failures: [] });
});

// ============================================================================================================================
// 7. THE VERDICTS: A1, A2, A3, A4, A8
// ============================================================================================================================
const T0 = NOW0;
const at = (sec) => T0 + sec * 1000;
const iso = (sec) => new Date(at(sec)).toISOString();
const sample = (sec, total, active = total, desired = total) => ({ t: at(sec), ok: true, total, active, desired });
const job = (id, over = {}) => ({ id, name: 'unit', status: 'success', created_at: iso(10), started_at: iso(60), finished_at: iso(120), runner: { description: 'vitana-eng-fleet' }, ...over });
const launches = (n, sec = 30) => Array.from({ length: n }, (_, i) => ({ Description: `Launching a new EC2 instance: i-${i}`, StatusCode: 'Successful', StartTime: iso(sec + i) }));
const goodA1 = (over = {}) => ({
  agents: 12, runStartMs: T0, fleetRunner: 'vitana-eng-fleet',
  samples: [sample(0, 0), sample(100, 12), sample(160, 24), sample(400, 4), sample(520, 0)],
  activities: launches(30), jobs: Array.from({ length: 29 }, (_, i) => job(i + 1, { finished_at: iso(300) })), ...over,
});

test('A1 PASS: the fleet reached 24 machines, 30 machines were launched for 29 jobs, and the group was back at 0 after 220 seconds', () => {
  const a = R.evalA1(goodA1());
  assert.equal(a.verdict, 'PASS', JSON.stringify(a.checks));
  assert.deepEqual([a.peak, a.jobsRun, a.launched, a.secondsToZero], [24, 29, 30, 220]);
  assert.deepEqual(a.checks.map((c) => c.name), ['peak', 'own', 'zero']);
});

test('A1 peak: 20 machines is enough, 19 is not (12 agents); the peak counts every machine in the group, Terminating ones too, and reports how many were active', () => {
  assert.equal(R.evalA1(goodA1({ samples: [sample(100, 20), sample(400, 0)] })).verdict, 'PASS');
  const low = R.evalA1(goodA1({ samples: [sample(100, 19), sample(520, 0)] }));
  assert.equal(low.verdict, 'FAIL');
  assert.match(low.checks[0].detail, /peak fleet size 19/);
  const mixed = R.evalA1(goodA1({ samples: [sample(100, 22, 14), sample(520, 0)] }));
  assert.equal(mixed.peak, 22);
  assert.equal(mixed.peakActive, 14);
  assert.equal(mixed.verdict, 'PASS');
  assert.match(mixed.checks[0].detail, /14 of them booting or serving/);
});

test('A1 with fewer than 12 agents: the 20-machine peak is not checked (and the report says why); the other two checks still decide', () => {
  const a = R.evalA1(goodA1({ agents: 5, samples: [sample(100, 6), sample(520, 0)] }));
  assert.equal(a.verdict, 'PASS');
  assert.equal(a.checks[0].ok, 'skip');
  assert.match(a.checks[0].detail, /checked with 12 agents; this run had 5/);
  assert.equal(R.evalA1(goodA1({ agents: 5, samples: [sample(100, 6), sample(520, 0)], activities: launches(3) })).verdict, 'FAIL', 'machines launched < jobs still fails');
});

test('A1 own machine: machines launched must be at least the jobs run (29 jobs: 29 pass, 28 fail); launches before the run and failed launches are not machines; jobs from before the run are not counted', () => {
  assert.equal(R.evalA1(goodA1({ activities: launches(29) })).verdict, 'PASS');
  const few = R.evalA1(goodA1({ activities: launches(28) }));
  assert.equal(few.verdict, 'FAIL');
  assert.match(few.checks.find((c) => c.name === 'own').detail, /29 job\(s\) ran, 28 machine\(s\) launched/);
  const failed = [...launches(28), { Description: 'Launching a new EC2 instance: i-x', StatusCode: 'Failed', StartTime: iso(40), StatusMessage: 'no capacity' }];
  assert.equal(R.evalA1(goodA1({ activities: failed })).verdict, 'FAIL');
  const old = [...launches(28), { Description: 'Launching a new EC2 instance: i-old', StatusCode: 'Successful', StartTime: new Date(T0 - 3600_000).toISOString() }];
  assert.equal(R.evalA1(goodA1({ activities: old })).verdict, 'FAIL');
  const before = [...goodA1().jobs, job(99, { started_at: new Date(T0 - 7200_000).toISOString(), finished_at: new Date(T0 - 7100_000).toISOString() })];
  assert.equal(R.evalA1(goodA1({ jobs: before })).jobsRun, 29);
});

test('A1 back to zero: 900 seconds after the last job passes, 901 fails; a group that never returns to 0 fails once the wait is over and is unproven before; a zero from before the last job does not count', () => {
  const zeroAt = (s) => goodA1({ samples: [sample(100, 24), sample(300 + s, 0)] });
  assert.equal(R.evalA1(zeroAt(900)).verdict, 'PASS');
  assert.equal(R.evalA1(zeroAt(901)).verdict, 'FAIL');
  assert.equal(R.evalA1(zeroAt(0)).secondsToZero, 0);
  const never = R.evalA1(goodA1({ samples: [sample(100, 24), sample(300, 3), sample(1300, 3)] }));
  assert.equal(never.verdict, 'FAIL');
  assert.match(never.checks.find((c) => c.name === 'zero').detail, /not back at 0 within 15 minutes/);
  const early = R.evalA1(goodA1({ samples: [sample(100, 24), sample(300, 3), sample(500, 3)] }));
  assert.equal(early.verdict, 'NOT_PROVEN', 'not enough time has passed to say');
  const beforeLast = R.evalA1(goodA1({ samples: [sample(0, 0), sample(100, 24), sample(299, 0), sample(1300, 3)] }));
  assert.equal(beforeLast.verdict, 'FAIL', 'the zero at 299 s was before the last job finished at 300 s');
  const desiredLeft = R.evalA1(goodA1({ samples: [sample(100, 24), sample(400, 0, 0, 2), sample(1300, 0, 0, 2)] }));
  assert.equal(desiredLeft.verdict, 'FAIL', 'no machine but a desired capacity of 2 is not scaled to zero');
});

test('A1 not proven: when the ASG cannot be read (AccessDenied) the verdict is NOT PROVEN and names the two IAM actions; the activity history unreadable is NOT PROVEN too', () => {
  const denied = R.evalA1(goodA1({ samples: [{ t: at(0), ok: false, error: 'An error occurred (AccessDenied) when calling the DescribeAutoScalingGroups operation' }] }));
  assert.equal(denied.verdict, 'NOT_PROVEN');
  assert.match(denied.checks[0].detail, /AccessDenied/);
  assert.match(denied.checks[0].detail, /autoscaling:DescribeAutoScalingGroups and autoscaling:DescribeScalingActivities/);
  const noHistory = R.evalA1(goodA1({ activities: null, activitiesError: 'AccessDenied: DescribeScalingActivities' }));
  assert.equal(noHistory.verdict, 'NOT_PROVEN');
  assert.match(noHistory.checks.find((c) => c.name === 'own').detail, /machines launched are unknown/);
  assert.equal(R.evalA1(goodA1({ jobs: [] })).verdict, 'NOT_PROVEN', 'no job seen on the fleet runner');
});

test('A1 runner: a job that ran on another runner than the fleet runner fails A1 (the fleet must run the jobs of agent branches)', () => {
  const jobs = [...goodA1().jobs, job(100, { runner: { description: 'vitana-eng-1' } })];
  const a = R.evalA1(goodA1({ jobs }));
  assert.equal(a.verdict, 'FAIL');
  assert.equal(a.jobsElsewhere, 1);
  assert.match(a.checks.find((c) => c.name === 'runner').detail, /1 job\(s\) did not run on the fleet runner vitana-eng-fleet/);
});

const trace = (lines) => ({ jobId: 1, name: 'unit', status: 'success', text: lines.join('\n') });
const allPass = ['NEGCTL imds PASS', 'NEGCTL gitlab-host PASS', 'NEGCTL aws-env PASS'];

test('A2 PASS: every successful job printed the three negative controls and all passed; the counts are per control', () => {
  const a = R.evalA2({ traces: [trace(allPass), { ...trace(allPass), jobId: 2 }, { ...trace(allPass), jobId: 3, status: 'failed' }] });
  assert.equal(a.verdict, 'PASS');
  assert.deepEqual(a.per, { imds: { pass: 3, fail: 0 }, 'gitlab-host': { pass: 3, fail: 0 }, 'aws-env': { pass: 3, fail: 0 } });
  assert.equal(a.jobsComplete, 3);
});

test('A2 FAIL: one FAIL line in any job fails the acceptance, whichever control it is', () => {
  for (const [i, name] of R.NEGCTL.entries()) {
    const lines = allPass.map((l, j) => (i === j ? l.replace('PASS', 'FAIL') : l));
    const a = R.evalA2({ traces: [trace(allPass), { ...trace(lines), jobId: 2 }] });
    assert.equal(a.verdict, 'FAIL', name);
    assert.equal(a.per[name].fail, 1);
    assert.match(a.checks.find((c) => c.name === name).detail, new RegExp(`${name}: 1 FAIL, 1 PASS`));
  }
});

test('A2: a succeeded job that did not print all three lines fails; a failed job without them does not by itself; a control never seen, no traces and unreadable traces are NOT PROVEN', () => {
  const missing = R.evalA2({ traces: [trace(allPass), { ...trace(['NEGCTL imds PASS']), jobId: 2 }] });
  assert.equal(missing.verdict, 'FAIL');
  assert.match(missing.checks.find((c) => c.name === 'complete').detail, /job #2 succeeded but printed only imds/);
  assert.equal(R.evalA2({ traces: [trace(allPass), { ...trace([]), jobId: 2, status: 'failed' }] }).verdict, 'PASS');
  assert.equal(R.evalA2({ traces: [trace(['NEGCTL imds PASS', 'NEGCTL aws-env PASS'])].map((t) => ({ ...t, status: 'failed' })) }).verdict, 'NOT_PROVEN');
  assert.equal(R.evalA2({ traces: [] }).verdict, 'NOT_PROVEN');
  const unreadable = R.evalA2({ traces: [{ jobId: 1, name: 'unit', status: 'success', error: 'HTTP 403' }] });
  assert.equal(unreadable.verdict, 'NOT_PROVEN');
  assert.equal(unreadable.unreadable, 1);
});

test('A2 FAIL: the line of a failing control shows the first detail the job printed for it (from the first trace that failed it), cut to one line; a failing control with no detail line has none to show', () => {
  const failing = (jobId, detail, over = {}) => ({ jobId, name: 'unit', status: 'success', text: ['negctl: imds: ' + detail, 'NEGCTL imds FAIL', 'negctl: gitlab-host: fine', 'NEGCTL gitlab-host PASS', 'negctl: aws-env: fine', 'NEGCTL aws-env PASS'].join('\n'), ...over });
  const a = R.evalA2({ traces: [trace(allPass), failing(7, 'a metadata token was issued to a job (PUT /latest/api/token: HTTP 200)'), failing(8, 'the second detail')] });
  assert.equal(a.verdict, 'FAIL');
  const imds = a.checks.find((c) => c.name === 'imds');
  assert.match(imds.detail, /^imds: 2 FAIL, 1 PASS \(job #7: a metadata token was issued to a job \(PUT \/latest\/api\/token: HTTP 200\)\)$/);
  assert.doesNotMatch(imds.detail, /second detail/, 'only the first');
  assert.equal(a.checks.find((c) => c.name === 'gitlab-host').detail, 'gitlab-host: 3 PASS, 0 FAIL', 'a control that passed has no detail');
  const long = R.evalA2({ traces: [failing(9, 'x'.repeat(900))] });
  assert.ok(long.checks.find((c) => c.name === 'imds').detail.length < 330, 'the detail is cut');
  const bare = R.evalA2({ traces: [{ jobId: 3, name: 'unit', status: 'success', text: 'NEGCTL imds FAIL\nNEGCTL gitlab-host PASS\nNEGCTL aws-env PASS' }] });
  assert.equal(bare.checks.find((c) => c.name === 'imds').detail, 'imds: 1 FAIL, 0 PASS');
});

test('A2 baseline: the job traces say whether GitLab could be reached from the job; that is information only (a skipped check, never a verdict), and where it was not reached the report says the network controls prove nothing', () => {
  const withBaseline = (state, jobId = 1) => ({ ...trace([...allPass, `NEGCTL-INFO baseline gitlab: ${state} (gitlab.example.com:443 x)`]), jobId });
  const ok = R.evalA2({ traces: [withBaseline('reachable'), withBaseline('reachable', 2), withBaseline('not checked', 3)] });
  assert.equal(ok.verdict, 'PASS');
  const base = ok.checks.find((c) => c.name === 'baseline');
  assert.equal(base.ok, 'skip');
  assert.match(base.detail, /^baseline \(information only\): GitLab was reached from the job in 2 of 3 trace\(s\), not checked in 1$/);
  assert.deepEqual(ok.baseline, { reachable: 2, notReachable: 0, notChecked: 1 });
  const none = R.evalA2({ traces: [withBaseline('reachable'), withBaseline('not reachable', 2)] });
  assert.equal(none.verdict, 'PASS', 'a baseline that was not reached never fails A2');
  assert.match(none.checks.find((c) => c.name === 'baseline').detail, /GitLab was reached from the job in 1 of 2 trace\(s\), NOT reached in 1: the two network controls prove nothing there/);
  assert.equal(R.evalA2({ traces: [trace(allPass)] }).checks.some((c) => c.name === 'baseline'), false, 'no baseline line in any trace: nothing to say');
  assert.equal(R.evalA2({ traces: [withBaseline('reachable')] }).per.imds.pass, 1);
});

const goodA3 = (over = {}) => ({
  protection: protection(), owners: ['root'], nowMs: T0, settingsCheck: { exitCode: 0 },
  members: [{ username: 'root', access_level: 50 }, { username: 'bot-land', access_level: 40 }, { username: 'agent-kiro-exafy', access_level: 30 }, { username: 'bot-metrics', access_level: 20 }],
  tokens: [{ user: 'agent-kiro-exafy', expires_at: '2027-02-02', active: true }, { user: 'bot-land', expires_at: '2027-02-01', active: true }], ...over,
});

test('A3 PASS: main is push No one, the Maintainers are bot-land and the owner, every token expires within 90 days, and the settings check exits 0', () => {
  const a = R.evalA3(goodA3());
  assert.equal(a.verdict, 'PASS', JSON.stringify(a.checks));
  assert.deepEqual(a.checks.map((c) => c.name), ['protection', 'maintainers', 'tokens', 'settings check']);
  assert.match(a.checks[2].detail, /2 token\(s\) checked, the latest expires in 89 day\(s\)/);
});

test('A3 FAIL: Maintainers may push, force push is allowed, an extra Maintainer or Owner exists, bot-land is not a Maintainer, or the settings check reports drift', () => {
  assert.equal(R.evalA3(goodA3({ protection: protection({ push_access_levels: [{ access_level: 40 }] }) })).verdict, 'FAIL');
  assert.equal(R.evalA3(goodA3({ protection: protection({ allow_force_push: true }) })).verdict, 'FAIL');
  const extra = R.evalA3(goodA3({ members: [...goodA3().members, { username: 'agent-kiro-hotmail', access_level: 40 }] }));
  assert.equal(extra.verdict, 'FAIL');
  assert.match(extra.checks[1].detail, /not allowed: agent-kiro-hotmail/);
  assert.equal(R.evalA3(goodA3({ members: [...goodA3().members, { username: 'a-person', access_level: 50 }] })).verdict, 'FAIL');
  const noBot = R.evalA3(goodA3({ members: [{ username: 'root', access_level: 50 }] }));
  assert.equal(noBot.verdict, 'FAIL');
  assert.match(noBot.checks[1].detail, /bot-land is not a Maintainer/);
  const drift = R.evalA3(goodA3({ settingsCheck: { exitCode: 3 } }));
  assert.equal(drift.verdict, 'FAIL');
  assert.match(drift.checks[3].detail, /exit 3 \(drift\)/);
  assert.equal(R.evalA3(goodA3({ settingsCheck: { exitCode: 1 } })).verdict, 'FAIL');
});

test('A3 tokens: 90 days left is the most allowed (91 fails); a token without expiry, an expired one, an inactive one and a revoked one fail', () => {
  const tok = (expires_at, over = {}) => ({ tokens: [{ user: 'x', expires_at, active: true, ...over }] });
  assert.equal(R.evalA3(goodA3(tok('2027-02-03'))).verdict, 'PASS', 'T0 is 2026-11-05: 2027-02-03 is 90 days away');
  assert.equal(R.evalA3(goodA3(tok('2027-02-04'))).verdict, 'FAIL', '91 days');
  assert.equal(R.evalA3(goodA3(tok(null))).verdict, 'FAIL');
  assert.match(R.evalA3(goodA3(tok(null))).checks[2].detail, /no expiry/);
  assert.equal(R.evalA3(goodA3(tok('2026-11-05'))).verdict, 'FAIL', 'expires today');
  assert.equal(R.evalA3(goodA3(tok('2026-12-01', { active: false }))).verdict, 'FAIL');
  assert.equal(R.evalA3(goodA3(tok('2026-12-01', { revoked: true }))).verdict, 'FAIL');
});

test('A3 NOT PROVEN: a token, the members, the protection or the settings check that could not be read is not assumed fine; a definite failure still wins over an unknown', () => {
  assert.equal(R.evalA3(goodA3({ protection: null })).verdict, 'NOT_PROVEN');
  assert.equal(R.evalA3(goodA3({ members: null })).verdict, 'NOT_PROVEN');
  assert.equal(R.evalA3(goodA3({ tokens: null })).verdict, 'NOT_PROVEN');
  assert.equal(R.evalA3(goodA3({ settingsCheck: null })).verdict, 'NOT_PROVEN');
  assert.equal(R.evalA3(goodA3({ tokens: [{ user: 'x', error: 'HTTP 401' }] })).verdict, 'NOT_PROVEN');
  assert.equal(R.evalA3(goodA3({ tokens: [{ user: 'x', error: 'HTTP 401' }], settingsCheck: { exitCode: 3 } })).verdict, 'FAIL');
});

const lanesOf = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => ({ id: `lane-${String(i + 1).padStart(2, '0')}`, title: `VTID-05540 (rehearsal/lane-${String(i + 1).padStart(2, '0')}): rehearsal lane ${i + 1} of ${n}`, state: 'merged', mergedAt: iso(1000 + i * 240), ...over(i) }));
const commitsOf = (lanes) => lanes.map((l) => ({ title: l.title, parent_ids: ['p'] }));
const controlsOk = () => R.CONTROLS.map((c) => ({ id: c.id, expect: c.expect, state: 'opened', codes: [c.expect] }));
const goodA4 = (over = {}) => { const lanes = lanesOf(12); return { lanes, commits: commitsOf(lanes), controls: controlsOk(), ...over }; };

test('A4 PASS: 12 lanes landed one at a time, each one commit with the VTID in the subject and one parent, in landing order, and every control refused with its reason', () => {
  const a = R.evalA4(goodA4());
  assert.equal(a.verdict, 'PASS', JSON.stringify(a.checks.filter((c) => c.ok !== true)));
  assert.equal(a.landed, 12);
  assert.ok(a.checks.length >= 4 + 5);
});

test('A4 FAIL: a lane that did not land, an extra commit on main, a missing commit, a subject without a VTID, a merge commit, or commits out of landing order', () => {
  const lanes = lanesOf(12);
  const fail = (over, re) => { const a = R.evalA4(goodA4(over)); assert.equal(a.verdict, 'FAIL', re); assert.match(a.checks.filter((c) => c.ok === false).map((c) => c.detail).join('\n'), re); };
  fail({ lanes: lanesOf(12, (i) => (i === 11 ? { state: 'opened', mergedAt: null } : {})) }, /11 of 12 lane merge request\(s\) landed/);
  fail({ commits: [...commitsOf(lanes), { title: 'VTID-05540 (rehearsal/ctl-red-job): control', parent_ids: ['p'] }] }, /13 commit\(s\) on main since the run began, 12 expected/);
  fail({ commits: commitsOf(lanes).slice(1) }, /11 commit\(s\) on main/);
  fail({ commits: commitsOf(lanes).slice(0, 11) }, /11 commit\(s\) on main since the run began, 12 expected/);
  fail({ commits: commitsOf(lanes).map((c, i) => (i === 3 ? { ...c, title: 'rehearsal lane 4 of 12' } : c)) }, /subjects are the merge request titles|VTID/);
  fail({ commits: commitsOf(lanes).map((c, i) => (i === 3 ? { ...c, parent_ids: ['p', 'q'] } : c)) }, /exactly one parent/);
  fail({ commits: [...commitsOf(lanes).slice(0, 2).reverse(), ...commitsOf(lanes).slice(2)] }, /order the merge requests landed/);
  fail({ lanes: lanesOf(12, () => ({ mergedAt: iso(1000) })) }, /strictly increase/);
});

test('A4 VTID: a subject without a VTID fails on its own, even when it is the title of the merge request (the check is about the commit, not the match)', () => {
  const lanes = lanesOf(12, (i) => ({ title: `rehearsal lane ${i + 1} of 12` }));
  const a = R.evalA4({ lanes, commits: commitsOf(lanes), controls: controlsOk() });
  assert.equal(a.verdict, 'FAIL');
  assert.deepEqual(a.checks.filter((c) => c.ok === false).map((c) => c.name), ['VTID']);
});

test('A4 controls: a control that landed fails; a control whose refusal reason is wrong or missing fails; the lane comments of the bot do not matter', () => {
  const controls = controlsOk();
  const wrong = R.evalA4(goodA4({ controls: controls.map((c, i) => (i === 1 ? { ...c, codes: ['no_review'] } : c)) }));
  assert.equal(wrong.verdict, 'FAIL');
  assert.match(wrong.checks.find((c) => c.name === 'ctl-stale-review').detail, /no refusal with reason review_stale \(the bot said: no_review\)/);
  const none = R.evalA4(goodA4({ controls: controls.map((c, i) => (i === 2 ? { ...c, codes: [] } : c)) }));
  assert.match(none.checks.find((c) => c.name === 'ctl-builder-accept').detail, /the bot said: nothing/);
  const landed = R.evalA4(goodA4({ controls: controls.map((c, i) => (i === 4 ? { ...c, state: 'merged' } : c)) }));
  assert.equal(landed.verdict, 'FAIL');
  assert.match(landed.checks.find((c) => c.name === 'ctl-protected-file').detail, /LANDED/);
  assert.equal(R.evalA4(goodA4({ controls: controls.map((c) => ({ ...c, codes: ['no_review', c.expect] })) })).verdict, 'PASS', 'an extra earlier reason is fine when the expected one was given');
});

test('A4 NOT PROVEN: when the commits on main could not be read; with no lanes at all it fails', () => {
  assert.equal(R.evalA4(goodA4({ commits: null })).verdict, 'NOT_PROVEN');
  const none = R.evalA4({ lanes: [], commits: [], controls: [] });
  assert.equal(none.verdict, 'FAIL');
  assert.equal(none.checks.find((c) => c.name === 'landed').ok, false, 'no lanes is not "all lanes landed"');
});

const goodA8 = (over = {}) => ({
  runStartMs: T0, legacyRunner: 'vitana-eng-1', fleetRunner: 'vitana-eng-fleet', settingsCheck: { exitCode: 0 }, legacyPausedInFile: false,
  jobs: [job(1), job(2), job(3, { started_at: new Date(T0 - 3600_000).toISOString(), runner: { description: 'vitana-eng-1' } })], ...over,
});

test('A8 PASS: no job of the run ran on the legacy runner, the fleet ran them, the settings check (tags and pause) is clean; the pause is only noted as the step of the owner after A1', () => {
  const a = R.evalA8(goodA8());
  assert.equal(a.verdict, 'PASS', JSON.stringify(a.checks));
  assert.match(a.pauseNote, /owner step after A1/);
  assert.match(R.evalA8(goodA8({ legacyPausedInFile: true })).pauseNote, /is paused in gitlab-settings\.json/);
});

test('A8 FAIL: a job of the run on the legacy runner, or a settings check that is not clean; NOT PROVEN when no job ran on the fleet or the check did not run', () => {
  const onLegacy = R.evalA8(goodA8({ jobs: [job(1), job(2, { runner: { description: 'vitana-eng-1' } })] }));
  assert.equal(onLegacy.verdict, 'FAIL');
  assert.match(onLegacy.checks[0].detail, /1 job\(s\) ran on the legacy runner vitana-eng-1/);
  assert.equal(R.evalA8(goodA8({ settingsCheck: { exitCode: 3 } })).verdict, 'FAIL');
  assert.equal(R.evalA8(goodA8({ jobs: [] })).verdict, 'NOT_PROVEN');
  assert.equal(R.evalA8(goodA8({ settingsCheck: null })).verdict, 'NOT_PROVEN');
});

test('settle and the exit code: FAIL beats NOT PROVEN beats PASS; a skipped check is neither; exit 0 only when all five acceptances PASS and the run did not stop', () => {
  assert.equal(R.settle([{ ok: true }, { ok: 'skip' }]), 'PASS');
  assert.equal(R.settle([{ ok: true }, { ok: null }]), 'NOT_PROVEN');
  assert.equal(R.settle([{ ok: null }, { ok: false }]), 'FAIL');
  const pass = { verdict: 'PASS' };
  const all = { a1: pass, a2: pass, a3: pass, a4: pass, a8: pass, stop: null };
  assert.equal(R.exitCodeOf(all), 0);
  for (const k of ['a1', 'a2', 'a3', 'a4', 'a8']) {
    assert.equal(R.exitCodeOf({ ...all, [k]: { verdict: 'FAIL' } }), 1, k);
    assert.equal(R.exitCodeOf({ ...all, [k]: { verdict: 'NOT_PROVEN' } }), 1, k);
    assert.equal(R.exitCodeOf({ ...all, [k]: undefined }), 1, k);
  }
  assert.equal(R.exitCodeOf({ ...all, stop: { phase: 'seed', message: 'x' } }), 1);
});

test('safety: the aws runner of the rehearsal reads the agent secrets and describes the fleet group, and refuses every other call', async () => {
  const calls = [];
  const aws = R.guardAws(async (args) => { calls.push(args); return { stdout: '' }; });
  const secret = (id) => ['secretsmanager', 'get-secret-value', '--secret-id', id, '--query', 'SecretString', '--output', 'text', '--region', 'eu-central-1'];
  await aws(secret('vitana/engineering/gitlab/agents/agent-kiro-exafy'));
  await aws(['autoscaling', 'describe-auto-scaling-groups', '--auto-scaling-group-names', 'vitana-eng-fleet']);
  await aws(['autoscaling', 'describe-scaling-activities', '--auto-scaling-group-name', 'vitana-eng-fleet']);
  assert.equal(calls.length, 3);
  const refused = [
    secret('vitana/engineering/gitlab/fleet-runner-token'), secret('vitana/engineering/gitlab/agents/../fleet-runner-token'), secret('prod/db-password'),
    ['secretsmanager', 'put-secret-value', '--secret-id', 'vitana/engineering/gitlab/agents/x', '--secret-string', 'v'],
    ['secretsmanager', 'create-secret', '--name', 'vitana/engineering/gitlab/agents/x'],
    ['autoscaling', 'set-desired-capacity', '--auto-scaling-group-name', 'vitana-eng-fleet', '--desired-capacity', '0'],
    ['autoscaling', 'terminate-instance-in-auto-scaling-group', '--instance-id', 'i-1'],
    ['ec2', 'describe-instances'], ['s3', 'ls'], [],
  ];
  for (const args of refused) {
    assert.throws(() => aws(args), /refusing an AWS call the rehearsal does not make/, JSON.stringify(args).slice(0, 80));
  }
  assert.equal(calls.length, 3, 'a refused call is never made');
});

test('safety: the writes of the rehearsal are four, below the project (open or add a commit, open a merge request, close one, delete a branch); a merge, a comment, a setting, a member, a hook, a variable, a project, main — anything else — is refused', () => {
  const onBranch = { branch: 'rehearsal/r1/lane-01', start_branch: 'main' };
  const ok = [['POST', '/repository/commits', onBranch], ['POST', '/merge_requests'], ['PUT', '/merge_requests/12'], ['DELETE', '/repository/branches/rehearsal%2Fr1%2Fctl-red-job'], ['DELETE', '/repository/branches/plain-name']];
  for (const [m, p, body] of ok) assert.equal(R.isAllowedWrite(m, p, body), true, `${m} ${p}`);
  const no = [
    ['PUT', '/merge_requests/12/merge'], ['PUT', '/merge_requests/12/rebase'], ['POST', '/merge_requests/12/notes'], ['POST', '/merge_requests/12/approve'], ['DELETE', '/merge_requests/12'], ['PUT', '/merge_requests'],
    ['PUT', '/repository/branches/main'], ['DELETE', '/repository/branches/a/b'], ['DELETE', '/repository/branches/'], ['POST', '/repository/branches'], ['POST', '/repository/files/x'], ['POST', '/repository/tags'],
    ['POST', '/hooks'], ['PUT', '/hooks/3'], ['POST', '/members'], ['PUT', '/members/4'], ['POST', '/variables'], ['PUT', '/protected_branches/main'], ['DELETE', '/protected_branches/main'], ['PUT', ''], ['POST', '/'],
    ['GET', '/repository/commits'], ['GET', '/merge_requests'], ['POST', '/repository/commits/extra'], ['POST', '/../projects'],
  ];
  for (const [m, p] of no) assert.equal(R.isAllowedWrite(m, p, { branch: 'rehearsal/r1/lane-01' }), false, `${m} ${p}`);
});

test('safety: no write is ever aimed at the branch main — a commit to it (also as refs/heads/main, or with no branch named), and a delete of it (also percent-encoded) are refused, whatever the path shape allows', async () => {
  for (const branch of ['main', 'refs/heads/main', '', undefined, null, 42]) assert.equal(R.isAllowedWrite('POST', '/repository/commits', { branch }), false, `commit to ${JSON.stringify(branch)}`);
  assert.equal(R.isAllowedWrite('POST', '/repository/commits'), false, 'a commit with no body names no branch');
  assert.equal(R.isAllowedWrite('POST', '/repository/commits', { branch: 'main-x', start_branch: 'main' }), true, 'main as the start of a new branch is a read, and a branch that only starts with main is another branch');
  for (const name of ['main', 'ma%69n', 'refs%2Fheads%2Fmain', '%6Dain']) assert.equal(R.isAllowedWrite('DELETE', `/repository/branches/${name}`), false, `delete ${name}`);
  assert.equal(R.isAllowedWrite('DELETE', '/repository/branches/%zz'), false, 'a name that cannot be decoded is not trusted');
  assert.equal(R.isAllowedWrite('DELETE', '/repository/branches/mainline'), true);
  // the writer of an account applies the same rule before any request leaves
  const sent = [];
  const client = { request: async (method, p, o) => { sent.push([method, p, o.body?.branch ?? null]); return { id: 'c1' }; } };
  const w = R.writer({ P: '/projects/x', clients: new Map([['agent-reviewer', client]]) }, 'agent-reviewer');
  assert.throws(() => w.commit({ branch: 'main', commit_message: 'x', actions: [] }), /refusing a write the rehearsal does not make: POST \/repository\/commits/);
  assert.throws(() => w.deleteBranch('main'), /refusing a write the rehearsal does not make: DELETE/);
  assert.deepEqual(sent, [], 'nothing was sent');
  await w.commit({ branch: 'rehearsal/r1/lane-01', start_branch: 'main', commit_message: 'x', actions: [] });
  await w.deleteBranch('rehearsal/r1/ctl-red-job');
  assert.deepEqual(sent, [['POST', '/projects/x/repository/commits', 'rehearsal/r1/lane-01'], ['DELETE', '/projects/x/repository/branches/rehearsal%2Fr1%2Fctl-red-job', null]]);
});

// ============================================================================================================================
// 9. WHOLE RUNS: a fake GitLab with a scripted merge bot and a fleet that boots machines, a fake aws runner, a virtual clock
// ============================================================================================================================
// The world keeps the project as data (commits with their trees, branches, merge requests, events, pipelines, jobs, comments) and moves on
// when the run sleeps: every 5 virtual seconds the fleet boots, starts and ends jobs, and every 60 seconds the bot looks at the merge
// requests oldest first and does one thing, with the same order of reasons as gitlab-land.mjs (protected file, review, checks, behind).
// The bot's own code is tested in gitlab-land.test.mjs and section 5 above; here it is only the other side of the conversation.
const USERS = ['agent-kiro-exafy', 'agent-kiro-exafyltd', 'agent-kiro-jtadic', 'agent-kiro-hotmail', 'agent-reviewer', 'bot-land', 'bot-metrics'];
const TOKENS = Object.fromEntries(USERS.map((u, i) => [u, `fixture${i}-${u.replace(/[^a-z]/g, '')}-0123456789abcdef`]));
const PRJ = '/api/v4/projects/vitana%2Frehearsal';
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const gitBlob = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const trailersOf = (message) => Object.fromEntries([...message.matchAll(/^(Collab-[A-Za-z-]+): (.+)$/gm)].map((m) => [m[1], m[2]]));
const isoAt = (ms) => new Date(ms).toISOString();

function makeWorld(options = {}) {
  const o = { bootSec: 45, bootSpreadSec: 3, runSec: 40, idleSec: 600, maxInstances: 24, botEverySec: 60, ...options };
  const w = {
    o, t: NOW0, seq: 0, lastBot: NOW0, commits: new Map(), branches: new Map(), mrs: [], events: [], pipelines: [], jobs: [], instances: [], activities: [],
    notes: new Map(), writeLog: [], readLog: [], awsCalls: [], asgCalls: 0, startedJobs: 0, landed: 0, mrSeq: 0, jobSeq: 100, pipelineSeq: 500, instSeq: 0, noteSeq: 0, reviewSnapshots: [], lastFailedLaunch: -1e12,
  };
  const userByToken = Object.fromEntries(USERS.map((u) => [o.tokens?.[u] ?? TOKENS[u], u]));
  const addCommit = ({ parents, message, tree, author }) => {
    const id = sha1(`${++w.seq}:${message}`);
    w.commits.set(id, { id, parents, message, tree, author, title: message.split('\n')[0] });
    return id;
  };
  const initial = addCommit({ parents: [], message: 'initial commit', tree: new Map([['README.md', '# rehearsal\n']]), author: 'root' });
  w.branches.set('main', { name: 'main', head: initial });
  if (o.seeded) {
    const tree = new Map(seedFiles());
    tree.set('README.md', '# rehearsal\n');
    for (const [p, t] of Object.entries(o.seedChanges ?? {})) tree.set(p, t);
    const id = addCommit({ parents: [initial], message: 'seed', tree, author: 'root' });
    w.branches.set('main', { name: 'main', head: id });
  }
  const mainHead = () => w.branches.get('main').head;
  const ancestors = (sha) => { const seen = new Set(); const stack = [sha]; while (stack.length) { const s = stack.pop(); if (seen.has(s)) continue; seen.add(s); stack.push(...w.commits.get(s).parents); } return seen; };
  const changedFiles = (c) => { const parent = c.parents[0] ? w.commits.get(c.parents[0]).tree : new Map(); return [...c.tree.keys()].filter((p) => parent.get(p) !== c.tree.get(p)); };
  const ownCommits = (head, mainAnc) => { const out = []; const seen = new Set(); const stack = [head]; while (stack.length) { const s = stack.pop(); if (mainAnc.has(s) || seen.has(s)) continue; seen.add(s); const c = w.commits.get(s); out.push(c); stack.push(...c.parents); } return out; };
  const nonMerge = (cs) => cs.filter((c) => c.parents.length === 1);
  w.mainHead = mainHead;
  w.ancestors = ancestors;

  const pushEvent = (user, branch, from, to) => { if (!o.noPushEvents) w.events.unshift({ author_username: user, action_name: 'pushed to', push_data: { commit_count: 1, action: from ? 'pushed' : 'created', ref_type: 'branch', commit_from: from, commit_to: to, ref: branch } }); };

  // ---- jobs and the fleet
  const pendingFirst = () => w.jobs.filter((j) => j.status === 'pending').sort((a, b) => a.id - b.id);
  const isRed = (sha) => [...w.commits.get(sha).tree].some(([p, t]) => /^test\/lanes\/.+\.test\.mjs$/.test(p) && t.includes("'red', 'green'"));
  const newPipeline = (ref, sha, mrIid) => {
    if (mrIid && o.autoCancel !== false) for (const j of w.jobs.filter((x) => x.mrIid === mrIid && ['pending', 'running'].includes(x.status))) cancelJob(j);
    const pipeline = { id: ++w.pipelineSeq, ref, sha };
    w.pipelines.push(pipeline);
    w.jobs.push({
      id: ++w.jobSeq, name: 'unit', status: 'pending', created_at: isoAt(w.t), started_at: null, finished_at: null, runner: null, allow_failure: false, pipeline, mrIid: mrIid ?? null, instance: null, finishAt: null,
    });
  };
  const terminate = (inst) => { inst.state = 'Terminating'; inst.removeAt = w.t + 30_000; w.activities.push({ Description: `Terminating EC2 instance: ${inst.id}`, StatusCode: 'Successful', StartTime: isoAt(w.t) }); };
  const releaseInstance = (job) => { const inst = w.instances.find((i) => i.id === job.instance); if (inst) { inst.job = null; inst.idleSince = w.t; } job.instance = null; };
  function cancelJob(j) {
    if (j.status === 'running') { const inst = w.instances.find((i) => i.id === j.instance); j.status = 'canceled'; j.finished_at = isoAt(w.t); if (inst) terminate(inst); return; }
    j.status = 'canceled';
    releaseInstance(j);
  }
  const trace = (j) => {
    const red = j.red;
    const lines = ['Running with gitlab-runner 17.0 (fixture)', '$ node --version', 'v20.20.2', '$ npm test', '# tests 4', `# pass ${red ? 3 : 4}`, `# fail ${red ? 1 : 0}`, 'ci-test: negative controls (plan eng-gitlab-m2, acceptance A2)'];
    if (!o.omitNegctl) for (const n of R.NEGCTL) { lines.push(`negctl: ${n}: ${o.negctlDetail?.[n] ?? 'fixture detail'}`, `NEGCTL ${n} ${o.negctl?.[n] ?? 'PASS'}`); }
    if (!o.omitNegctl && o.baseline !== null) lines.push(`NEGCTL-INFO baseline gitlab: ${o.baseline ?? 'reachable'} (gitlab.example.com:443 fixture)`);
    lines.push(red ? 'ERROR: Job failed: exit code 1' : 'Job succeeded');
    return lines.join('\r\n');
  };
  const startJob = (j, inst) => {
    j.status = 'running'; j.started_at = isoAt(w.t); j.finishAt = w.t + o.runSec * 1000; j.red = isRed(j.pipeline.sha);
    w.startedJobs += 1;
    const legacy = o.legacyJobIds?.includes(j.id) || o.legacyNth === w.startedJobs; // the nth job that gets a machine runs on the legacy runner
    j.runner = { id: legacy ? 1 : 2, description: legacy ? 'vitana-eng-1' : 'vitana-eng-fleet' };
    j.instance = inst.id;
  };
  const fleetStep = () => {
    for (const i of w.instances) if (i.state === 'Pending' && w.t >= i.readyAt) i.state = 'InService';
    for (const j of w.jobs.filter((x) => x.status === 'running' && w.t >= x.finishAt)) {
      j.status = j.red ? 'failed' : 'success'; j.finished_at = isoAt(w.t); j.traceText = trace(j);
      const inst = w.instances.find((i) => i.id === j.instance);
      if (inst) terminate(inst);
    }
    for (const i of w.instances) if (i.state === 'InService' && !i.job && w.t - i.idleSince >= o.idleSec * 1000) terminate(i);
    w.instances = w.instances.filter((i) => !(i.state === 'Terminating' && w.t >= i.removeAt));
    for (const j of w.jobs.filter((x) => x.status === 'pending' && x.instance)) {
      const inst = w.instances.find((i) => i.id === j.instance);
      if (inst?.state === 'InService') startJob(j, inst);
    }
    for (const j of pendingFirst().filter((x) => !x.instance)) {
      if (o.mrJobsNeverStart && j.mrIid) continue; // only the jobs of pipelines on main get a machine
      const idle = w.instances.find((i) => i.state === 'InService' && !i.job);
      if (idle) { idle.job = j.id; startJob(j, idle); continue; }
      if (o.fleetStuck) {
        if (w.t - w.lastFailedLaunch >= 300_000) { w.lastFailedLaunch = w.t; w.activities.push({ Description: 'Launching a new EC2 instance', StatusCode: 'Failed', StatusMessage: o.launchFailureMessage ?? 'We currently do not have sufficient m6i.xlarge capacity in the Availability Zone you requested', StartTime: isoAt(w.t) }); }
        continue;
      }
      if (w.instances.length >= o.maxInstances) continue;
      const inst = { id: `i-${String(++w.instSeq).padStart(8, '0')}`, state: 'Pending', readyAt: w.t + (o.bootSec + (w.instSeq % 9) * o.bootSpreadSec) * 1000, job: j.id, idleSince: w.t };
      w.instances.push(inst);
      j.instance = inst.id;
      w.activities.push({ Description: `Launching a new EC2 instance: ${inst.id}`, StatusCode: 'Successful', StartTime: isoAt(w.t) });
    }
  };

  // ---- the merge bot (one thing per tick, oldest merge request first; reasons in the order of mergeDecision)
  const addNote = (mr, code, head) => {
    const list = w.notes.get(mr.iid);
    const marker = `<!-- vitana-land:${code}:${head} -->`;
    if (list.some((n) => n.body.includes(marker))) return;
    list.push({ id: ++w.noteSeq, body: `Not landed (${code}).\n\n${marker}`, author: { username: 'bot-land' }, created_at: isoAt(w.t) });
  };
  const mrFiles = (own) => [...new Set(nonMerge(own).flatMap(changedFiles))];
  function judge(mr) {
    const head = w.branches.get(mr.source_branch).head;
    const mainAnc = ancestors(mainHead());
    const own = ownCommits(head, mainAnc);
    const files = mrFiles(own);
    const key = laneKeyOf(mr.title);
    const skip = (code) => ({ action: 'skip', code, head });
    if (protectedTouched(files, PROTECTED_GATE_PATHS).length) return skip('protected_gate_file');
    const rc = own.find((c) => { const t = trailersOf(c.message); return t['Collab-Review'] === key && ['accept', 'changes'].includes(t['Collab-Verdict']); });
    if (!rc) return skip('no_review');
    const tr = trailersOf(rc.message);
    if (tr['Collab-Verdict'] !== 'accept') return skip('review_changes');
    if (!/^agent:vitana-lane-reviewer \(/.test(tr['Collab-Reviewer'] ?? '') || !/^[0-9a-f]{40}$/.test(tr['Collab-Reviewed-Head'] ?? '')) return skip('review_forged');
    if (!o.botLandsForged && w.events.find((e) => e.push_data?.commit_to === rc.id)?.author_username !== 'agent-reviewer') return skip('review_forged');
    const laneFile = `.kiro/specs/rehearsal/lanes/${key.split('/')[1]}.md`;
    let cur = head;
    for (let guard = 0; cur !== tr['Collab-Reviewed-Head']; guard++) {
      const c = w.commits.get(cur);
      if (!c || guard > 200) return skip('review_stale');
      if (c.parents.length === 2) { if (!mainAnc.has(c.parents[1])) return skip('review_stale'); } else if (changedFiles(c).some((p) => p !== laneFile)) return skip('review_stale');
      cur = c.parents[0];
    }
    const pipe = [...w.pipelines].reverse().find((p) => p.sha === head && p.ref.startsWith('refs/merge-requests/'));
    const jobs = pipe ? w.jobs.filter((j) => j.pipeline === pipe) : [];
    if (!pipe || jobs.some((j) => ['pending', 'running', 'created'].includes(j.status))) return { action: 'wait', head };
    if (jobs.some((j) => j.status !== 'success')) return skip('checks_failed');
    if (!ancestors(head).has(mainHead())) return { action: 'update', head, own };
    return { action: 'land', head, own };
  }
  const withOwn = (own, head) => { const tree = new Map(w.commits.get(mainHead()).tree); for (const p of mrFiles(own)) tree.set(p, w.commits.get(head).tree.get(p)); return tree; };
  const botTick = () => {
    if (o.botDead || (o.botDiesAfterLandings !== undefined && w.landed >= o.botDiesAfterLandings)) return;
    const open = w.mrs.filter((m) => m.state === 'opened').sort((a, b) => a.created_at.localeCompare(b.created_at) || a.iid - b.iid);
    for (const mr of open) {
      const v = judge(mr);
      if (v.action === 'skip') { addNote(mr, v.code, v.head); continue; }
      if (v.action === 'wait') return;
      if (v.action === 'update') {
        const id = addCommit({ parents: [v.head, mainHead()], message: `Merge branch 'main' into ${mr.source_branch}\n\nCollab-Session: bot-land`, tree: withOwn(v.own, v.head), author: 'bot-land' });
        w.branches.set(mr.source_branch, { name: mr.source_branch, head: id });
        pushEvent('bot-land', mr.source_branch, v.head, id);
        newPipeline(`refs/merge-requests/${mr.iid}/head`, id, mr.iid);
        return;
      }
      const id = addCommit({ parents: [mainHead()], message: `${mr.title}\n\n${mr.description}`, tree: withOwn(v.own, v.head), author: 'bot-land' });
      w.branches.set('main', { name: 'main', head: id });
      w.branches.delete(mr.source_branch);
      Object.assign(mr, { state: 'merged', merged_at: isoAt(w.t) });
      w.landed += 1;
      newPipeline('main', id, null);
      return;
    }
  };
  w.advance = (ms) => {
    const end = w.t + ms;
    while (w.t < end) {
      w.t = Math.min(end, w.t + 5000);
      fleetStep();
      if (w.t - w.lastBot >= o.botEverySec * 1000) { w.lastBot = w.t; botTick(); }
    }
  };

  // ---- GitLab's API
  const f = fakeFetch();
  w.fetch = f;
  const who = (call) => userByToken[call.headers['private-token']] ?? null;
  const reply = (fn) => (call) => {
    const user = who(call);
    if (!user) return { status: 401, json: { message: '401 Unauthorized' } };
    (call.method === 'GET' ? w.readLog : w.writeLog).push({ user, method: call.method, path: call.path, body: call.body });
    return fn(call, user);
  };
  const mrView = (mr) => ({ iid: mr.iid, title: mr.title, description: mr.description, source_branch: mr.source_branch, target_branch: 'main', state: mr.state, created_at: mr.created_at, merged_at: mr.merged_at, sha: w.branches.get(mr.source_branch)?.head ?? mr.lastSha, web_url: `https://gitlab.test/vitana/rehearsal/-/merge_requests/${mr.iid}` });
  const bySource = (name) => w.mrs.find((m) => m.source_branch === name && m.state === 'opened');
  f.route('GET', '/api/v4/user', reply((c, user) => (o.badUserCall === user ? { status: 401, json: { message: `The token ${c.headers['private-token']} is not valid` } } : { json: { id: 1, username: o.identity?.[user] ?? user } })));
  f.route('GET', '/api/v4/personal_access_tokens/self', reply((c, user) => ({ json: { id: 9, active: o.tokenActive?.[user] ?? true, revoked: false, expires_at: o.expires && user in o.expires ? o.expires[user] : '2027-01-20', scopes: ['api'] } })));
  f.route('GET', PRJ, reply(() => ({ json: { id: 42, path_with_namespace: 'vitana/rehearsal', default_branch: 'main', archived: false, mirror: o.mirror === true, ...o.projectInfo } })));
  f.route('GET', `${PRJ}/hooks`, reply(() => ({ json: o.hooks ?? [] })));
  f.route('GET', `${PRJ}/remote_mirrors`, reply(() => ({ json: o.remoteMirrors ?? [] })));
  f.route('GET', `${PRJ}/protected_branches/main`, reply(() => ({ json: o.protectionChange && w.landed >= o.protectionChange.afterLandings ? o.protectionChange.value : (o.protection ?? protection()) })));
  f.route('GET', `${PRJ}/members/all`, reply(() => ({ json: o.members ?? [{ username: 'root', access_level: 50 }, { username: 'bot-land', access_level: 40 }, ...['agent-kiro-exafy', 'agent-kiro-exafyltd', 'agent-kiro-jtadic', 'agent-kiro-hotmail', 'agent-reviewer'].map((u) => ({ username: u, access_level: 30 })), { username: 'bot-metrics', access_level: 20 }] })));
  f.route('GET', `${PRJ}/merge_requests`, reply((c) => {
    const ids = (c.query['iids[]'] ?? []).map(Number);
    const state = c.query.state?.[0] ?? 'all';
    return { json: w.mrs.filter((m) => (state === 'all' || m.state === state) && (ids.length === 0 || ids.includes(m.iid))).map(mrView) };
  }));
  f.route('GET', /\/merge_requests\/\d+$/, reply((c) => ({ json: mrView(w.mrs.find((m) => m.iid === Number(/merge_requests\/(\d+)$/.exec(c.path)[1]))) })));
  f.route('GET', /\/merge_requests\/\d+\/notes$/, reply((c) => ({ json: w.notes.get(Number(/merge_requests\/(\d+)\/notes$/.exec(c.path)[1])) ?? [] })));
  f.route('POST', `${PRJ}/merge_requests`, reply((c, user) => {
    const b = c.body;
    if (!w.branches.has(b.source_branch)) return { status: 400, json: { message: 'source branch does not exist' } };
    const mr = { iid: ++w.mrSeq, title: b.title, description: b.description, source_branch: b.source_branch, state: 'opened', created_at: isoAt(w.t), merged_at: null, author: user };
    w.mrs.push(mr);
    w.notes.set(mr.iid, []);
    newPipeline(`refs/merge-requests/${mr.iid}/head`, w.branches.get(b.source_branch).head, mr.iid);
    return { status: 201, json: mrView(mr) };
  }));
  f.route('PUT', /\/merge_requests\/\d+$/, reply((c) => {
    if (o.putFailsOnce && !w.putFailed) { w.putFailed = true; return { status: 503, json: { message: 'busy' } }; }
    const mr = w.mrs.find((m) => m.iid === Number(/merge_requests\/(\d+)$/.exec(c.path)[1]));
    if (c.body?.state_event === 'close') { mr.state = 'closed'; mr.lastSha = w.branches.get(mr.source_branch)?.head; }
    return { json: mrView(mr) };
  }));
  f.route('POST', `${PRJ}/repository/commits`, reply((c, user) => {
    const b = c.body;
    if (b.branch === 'main') return { status: 400, json: { message: 'You are not allowed to push into this branch' } };
    let br = w.branches.get(b.branch);
    const existed = Boolean(br);
    const parent = existed ? br.head : w.branches.get(b.start_branch)?.head;
    if (!parent) return { status: 400, json: { message: `Invalid start branch ${b.start_branch}` } };
    const tree = new Map(w.commits.get(parent).tree);
    for (const a of b.actions) {
      if (a.action === 'create' && tree.has(a.file_path)) return { status: 400, json: { message: `A file with this name already exists: ${a.file_path}` } };
      if (a.action === 'update' && !tree.has(a.file_path)) return { status: 400, json: { message: `A file with this name doesn't exist: ${a.file_path}` } };
      tree.set(a.file_path, a.content);
    }
    const id = addCommit({ parents: [parent], message: b.commit_message, tree, author: user });
    w.branches.set(b.branch, { name: b.branch, head: id });
    pushEvent(user, b.branch, existed ? parent : null, id);
    if (/Collab-Verdict: accept/.test(b.commit_message)) w.reviewSnapshots.push({ user, branch: b.branch, jobsStarted: w.jobs.filter((j) => j.started_at).length, mrJobsStarted: w.jobs.filter((j) => j.mrIid && j.started_at).length, mrJobsPending: w.jobs.filter((j) => j.mrIid && j.status === 'pending').length, mrsOpen: w.mrs.filter((m) => m.state === 'opened').length, t: w.t });
    const mr = bySource(b.branch);
    if (mr) newPipeline(`refs/merge-requests/${mr.iid}/head`, id, mr.iid);
    return { status: 201, json: { id, short_id: id.slice(0, 8), title: b.commit_message.split('\n')[0] } };
  }));
  f.route('GET', `${PRJ}/repository/branches/main`, reply(() => ({ json: { name: 'main', commit: { id: mainHead() } } })));
  f.route('DELETE', /\/repository\/branches\/[^/]+$/, reply((c) => { w.branches.delete(decodeURIComponent(/branches\/([^/]+)$/.exec(c.path)[1])); return { status: 204 }; }));
  f.route('GET', `${PRJ}/repository/tree`, reply(() => ({ json: [...w.commits.get(mainHead()).tree].map(([p, t]) => ({ id: gitBlob(t), name: p.split('/').pop(), type: 'blob', path: p, mode: '100644' })) })));
  f.route('GET', /\/repository\/files\/.+\/raw$/, reply((c) => {
    const file = decodeURIComponent(/files\/(.+)\/raw$/.exec(c.path)[1]);
    const br = w.branches.get(c.query.ref?.[0]);
    const text = br && w.commits.get(br.head).tree.get(file);
    return text === undefined ? { status: 404, json: { message: '404 File Not Found' } } : { text };
  }));
  f.route('GET', `${PRJ}/repository/commits`, reply(() => {
    const out = []; let cur = mainHead();
    while (cur) { const c = w.commits.get(cur); out.push({ id: c.id, title: c.title, parent_ids: c.parents }); cur = c.parents[0]; }
    return { json: out };
  }));
  f.route('GET', `${PRJ}/jobs`, reply(() => ({ json: [...w.jobs].reverse().map((j) => ({ id: j.id, name: j.name, status: j.status, created_at: j.created_at, started_at: j.started_at, finished_at: j.finished_at, runner: j.runner, allow_failure: false, pipeline: { id: j.pipeline.id, ref: j.pipeline.ref, sha: j.pipeline.sha } })) })));
  f.route('GET', /\/jobs\/\d+\/trace$/, reply((c) => {
    const j = w.jobs.find((x) => x.id === Number(/jobs\/(\d+)\/trace$/.exec(c.path)[1]));
    if (o.traceForbidden) return { status: 403, json: { message: '403 Forbidden' } };
    return { text: j?.traceText ?? '' };
  }));
  f.route('GET', `${PRJ}/events`, reply(() => ({ json: w.events })));

  // ---- AWS
  const asgJson = () => ({ AutoScalingGroups: [{ AutoScalingGroupName: 'vitana-eng-fleet', DesiredCapacity: w.instances.filter((i) => i.state !== 'Terminating').length, Instances: w.instances.map((i) => ({ InstanceId: i.id, LifecycleState: i.state })) }] });
  w.aws = async (args) => {
    w.awsCalls.push(args);
    if (args[0] === 'secretsmanager') {
      const user = args[args.indexOf('--secret-id') + 1].split('/').pop();
      if (o.noTokenFor === user) return { stdout: 'None\n' };
      if (o.unreadableFor === user) throw Object.assign(new Error('aws secretsmanager get-secret-value failed (exit 254): AccessDeniedException'), { stderr: '' });
      return { stdout: `${o.tokens?.[user] ?? TOKENS[user]}\n` };
    }
    w.asgCalls += 1;
    const failure = o.asgFail?.(w.asgCalls, args); // the text AWS would answer with, or nothing
    if (failure) throw Object.assign(new Error(`aws autoscaling ${args[1]} failed (exit 254): ${failure}`), { stderr: '' });
    if (args[1] === 'describe-auto-scaling-groups') return { stdout: JSON.stringify(asgJson()) };
    if (args[1] === 'describe-scaling-activities') return { stdout: JSON.stringify({ Activities: [...w.activities].reverse() }) };
    throw new Error(`unexpected aws call ${args.join(' ')}`);
  };
  o.setup?.(w);
  return w;
}

/** An open merge request from an earlier run (or from someone else) that is already in the world. */
function addOpenMr(w, { branch, title = 'VTID-05540 (rehearsal/lane-01): left over' }) {
  const parent = w.branches.get('main').head;
  const id = sha1(`old:${branch}`);
  w.commits.set(id, { id, parents: [parent], message: title, tree: new Map(w.commits.get(parent).tree), author: 'x', title });
  w.branches.set(branch, { name: branch, head: id });
  const mr = { iid: ++w.mrSeq, title, description: '', source_branch: branch, state: 'opened', created_at: isoAt(w.t), merged_at: null, author: 'x' };
  w.mrs.push(mr);
  w.notes.set(mr.iid, []);
  return mr;
}

async function runWorld(options = {}, runOpts = {}, depsOver = {}) {
  const w = makeWorld(options);
  const out = [];
  const err = [];
  const says = [];
  let n = 0;
  const deps = {
    fetch: w.fetch, sleep: async (ms) => w.advance(ms), now: () => w.t, env: { REGION: 'eu-central-1' }, aws: w.aws, stdout: (l) => out.push(l), stderr: (l) => { err.push(l); says.push({ line: l, calls: w.fetch.calls.length, instances: w.instances.length }); },
    networkInterfaces: () => ({ ens5: [{ family: 'IPv4', address: IP, internal: false }] }), seedDir: SEED, platformRoot: REPO, protectedGlobs: PROTECTED_GATE_PATHS,
    settingsCheck: async () => ({ exitCode: w.o.settingsExit ?? 0, lines: w.o.settingsLines ?? [] }), random: () => (++n).toString(16).padStart(4, '0'),
    seedSelfTest: async () => ({ ok: true, output: '' }), // the real one runs the seed's tests in a child process; the cases that need it say so
    ...depsOver,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('a test must not use the network'); };
  try {
    const r = await R.run({ project: 'rehearsal', agents: 12, settings: SETTINGS, url: 'https://gitlab.test', runId: 'r202611051400', ...runOpts }, deps);
    return { w, r, out, err, says, report: out.join('\n'), errText: err.join('\n') };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const nonGet = (w) => w.fetch.calls.filter((c) => c.method !== 'GET');

test('whole run, happy path: the seed lands, 12 lanes land one at a time, 5 controls are refused; A1, A2, A3, A4 and A8 PASS; exit 0; the report is on stdout', async () => {
  const { w, r, report } = await runWorld();
  assert.equal(r.exitCode, 0, report);
  assert.match(report, /^REHEARSAL REPORT \(plan eng-gitlab-m2, section 3\.8\)/);
  assert.match(report, /RESULT: PASS   A1 PASS \| A2 PASS \| A3 PASS \| A4 PASS \| A8 PASS/);
  for (const a of ['A1 FLEET', 'A2 ISOLATION', 'A3 ACCESS', 'A4 LANDING', 'A8 LEGACY']) assert.match(report, new RegExp(`\\n${a}\\s+PASS\\n`), a);
  assert.equal(w.mrs.filter((m) => m.state === 'merged').length, 13, 'the seed and the 12 lanes');
  const mainTitles = [];
  for (let cur = w.mainHead(); w.commits.get(cur).parents.length; cur = w.commits.get(cur).parents[0]) mainTitles.push(w.commits.get(cur).title);
  assert.equal(mainTitles.length, 13);
  assert.equal(mainTitles.filter((t) => /^VTID-05540 \(rehearsal\/lane-\d\d\): rehearsal lane \d+ of 12$/.test(t)).length, 12);
  assert.match(report, /SEED          landed through !1 in \d+ min/);
  assert.match(report, /COMMITS ON MAIN \(oldest first\)\n {2} 1\. VTID-05540 \(rehearsal\/lane-\d\d\)/);
  for (const c of R.CONTROLS) assert.match(report, new RegExp(`${c.id}\\s+expected ${c.expect}\\s+bot said: [a-z_, ]*${c.expect}`), c.id);
  assert.match(report, /NEGATIVE CONTROLS[\s\S]*imds {9}PASS \d+ {2}FAIL 0/);
});

test('whole run: the report is the only thing on stdout (one block, well under the 24,000 characters Systems Manager keeps), progress goes to stderr (a line a minute, one per write)', async () => {
  const { out, err, says, report, r } = await runWorld();
  assert.equal(out.length, 1, 'stdout is the report and nothing else');
  assert.equal(r.report, report);
  assert.ok(report.length < 10_000, `the report is ${report.length} characters`);
  assert.ok(err.length > 20 && err.every((l) => l.startsWith('rehearse: ')), 'progress and announcements are on stderr');
  assert.ok(err.some((l) => /^rehearse: t\+\d+m landed \d+\/12, controls refused \d\/5, fleet /.test(l)), 'a progress line');
  assert.ok(err.some((l) => /fleet \d+ \(peak 24\)/.test(l)), 'the progress line shows the machines in the group, the same measure as A1');
  const progress = says.filter((s) => /fleet \d+ \(peak/.test(s.line));
  assert.ok(progress.length > 20);
  for (const s of progress) assert.equal(Number(/fleet (\d+) \(peak/.exec(s.line)[1]), s.instances, `the fleet size in "${s.line}" is the number of machines in the group, Terminating ones included`);
  assert.ok(err.join('\n').length < 12_000, 'stderr is a line a minute and one per write, not a flood');
});

test('whole run: every write is announced on stderr just before it is made (opening, reviewing, writing an accept, changing code, closing, deleting)', async () => {
  const { w, says } = await runWorld();
  const writes = nonGet(w);
  assert.ok(writes.length > 60);
  for (const c of writes) {
    const last = [...says].reverse().find((s) => s.calls <= c.n);
    assert.ok(last && /^rehearse: (opening|reviewing|closing|deleting|\S+: \S+ (writes an accept itself|changes code after the review))/.test(last.line), `write #${c.n} ${c.method} ${c.path} follows: ${last?.line}`);
  }
});

test('whole run: who writes what — builders and the seats of the controls open and change their own merge requests, only agent-reviewer pushes accepts, bot-land and bot-metrics write nothing, every read is made by bot-land', async () => {
  const { w } = await runWorld();
  const plan = lanePlan(12);
  const bySeat = Object.fromEntries(plan.order.map((i) => [i.branch, i.seat]));
  const commits = w.writeLog.filter((e) => e.method === 'POST' && /repository\/commits$/.test(e.path));
  const accepts = commits.filter((e) => /Collab-Verdict: accept/.test(e.body.commit_message));
  const builders = commits.filter((e) => e.body.start_branch === 'main' && bySeat[e.body.branch]);
  assert.equal(builders.length, 17);
  for (const e of builders) assert.equal(e.user, bySeat[e.body.branch], `${e.body.branch} is built by its seat`);
  assert.equal(accepts.filter((e) => e.user === 'agent-reviewer').length, 1 + 12 + 3, 'the seed, 12 lanes, stale + red + protected');
  const forged = accepts.filter((e) => e.user !== 'agent-reviewer');
  assert.deepEqual(forged.map((e) => [e.user, e.body.branch]), [[bySeat[plan.controls[2].branch], plan.controls[2].branch]], 'the one accept not pushed by the reviewer is the forged one of the builder');
  for (const e of w.writeLog) assert.ok(!['bot-land', 'bot-metrics'].includes(e.user), `${e.user} wrote ${e.method} ${e.path}`);
  assert.ok(w.writeLog.filter((e) => e.method !== 'POST' || !/commits$/.test(e.path)).every((e) => USERS.slice(0, 4).includes(e.user)), 'merge requests are opened, closed and cleaned up by seat accounts');
  const reads = w.readLog.filter((e) => !['/api/v4/user', '/api/v4/personal_access_tokens/self'].includes(e.path));
  assert.ok(reads.length > 200);
  assert.deepEqual([...new Set(reads.map((e) => e.user))], ['bot-land'], 'every read goes through the observer, which is bot-land and has no write method');
  const own = w.readLog.filter((e) => e.path === '/api/v4/user');
  assert.deepEqual(own.map((e) => e.user).sort(), [...USERS].sort(), 'each account is asked who it is once');
  assert.deepEqual(w.readLog.filter((e) => e.path === '/api/v4/personal_access_tokens/self').map((e) => e.user).sort(), [...USERS].sort(), 'each token is asked for its expiry once');
});

test('whole run: nothing but the rehearsal project is written — four kinds of write, all under /projects/vitana%2Frehearsal, never main; AWS is only read', async () => {
  const { w } = await runWorld();
  const allowed = [
    ['POST', new RegExp(`^${PRJ}/repository/commits$`)], ['POST', new RegExp(`^${PRJ}/merge_requests$`)],
    ['PUT', new RegExp(`^${PRJ}/merge_requests/\\d+$`)], ['DELETE', new RegExp(`^${PRJ}/repository/branches/[^/]+$`)],
  ];
  for (const c of nonGet(w)) assert.ok(allowed.some(([m, re]) => m === c.method && re.test(c.path)), `${c.method} ${c.path}`);
  assert.ok(nonGet(w).every((c) => !(c.method === 'POST' && /repository\/commits$/.test(c.path)) || c.body.branch !== 'main'), 'no commit is ever aimed at main');
  assert.ok(nonGet(w).filter((c) => c.method === 'PUT').every((c) => JSON.stringify(c.body) === '{"state_event":"close"}'));
  assert.ok(w.fetch.calls.every((c) => c.url.startsWith('https://gitlab.test/api/v4/')), 'one origin');
  const aws = w.awsCalls.map((a) => `${a[0]} ${a[1]}`);
  assert.deepEqual([...new Set(aws)].sort(), ['autoscaling describe-auto-scaling-groups', 'autoscaling describe-scaling-activities', 'secretsmanager get-secret-value']);
  const secrets = w.awsCalls.filter((a) => a[0] === 'secretsmanager').map((a) => a[a.indexOf('--secret-id') + 1]).sort();
  assert.deepEqual(secrets, USERS.map((u) => `vitana/engineering/gitlab/agents/${u}`).sort());
  assert.ok(w.awsCalls.every((a) => !a.some((x) => /put-|create-|delete-|set-desired|terminate/.test(x))));
  const history = w.awsCalls.filter((a) => a[0] === 'autoscaling' && a[1] === 'describe-scaling-activities');
  assert.equal(history.length, 2, 'once before anything is written (the preflight) and once at the end');
  const maxItems = (a) => a[a.indexOf('--max-items') + 1];
  assert.equal(maxItems(history[0]), '1', 'the preflight asks for one activity');
  assert.equal(maxItems(history[1]), '500', 'the history at the end is capped so that the output of the AWS CLI stays far below the 1 MB the aws runner keeps');
  for (const a of w.awsCalls) assert.equal(a[a.indexOf('--region') + 1], 'eu-central-1', `region of ${a[1]}`);
  for (const a of w.awsCalls.filter((c) => c[0] === 'autoscaling')) assert.ok(a.includes('vitana-eng-fleet'), `${a[1]} asks for the group vitana-eng-fleet`);
});

test('whole run: the fleet group is vitana-eng-fleet unless FLEET_ASG_NAME says otherwise (the environment of the machine)', async () => {
  const { w, r } = await runWorld({}, {}, { env: { REGION: 'eu-central-1', FLEET_ASG_NAME: 'other-fleet' } });
  assert.equal(r.exitCode, 0);
  const groups = w.awsCalls.filter((a) => a[0] === 'autoscaling').map((a) => a[Math.max(a.indexOf('--auto-scaling-group-names'), a.indexOf('--auto-scaling-group-name')) + 1]);
  assert.ok(groups.length > 10);
  assert.deepEqual([...new Set(groups)], ['other-fleet']);
});

test('whole run: secrets are never printed — no token in stdout, stderr, or the report', async () => {
  const { out, err, report } = await runWorld();
  const all = `${out.join('\n')}\n${err.join('\n')}`;
  for (const [user, token] of Object.entries(TOKENS)) assert.equal(all.includes(token), false, `the token of ${user}`);
  assert.doesNotMatch(all, /fixture\d-/, 'not even the start of a token');
  assert.ok(report.length > 1000);
});

test('whole run: a GitLab error that echoes a token does not leak it (a 401 for the token of the reviewer): refused before any write', async () => {
  const { out, err, r, w } = await runWorld({ badUserCall: 'agent-reviewer' });
  assert.equal(r.exitCode, 2);
  const all = `${out.join('\n')}\n${err.join('\n')}`;
  assert.match(all, /the token of agent-reviewer was not accepted by GitLab/);
  for (const token of Object.values(TOKENS)) assert.equal(all.includes(token), false);
  assert.equal(nonGet(w).length, 0);
});

test('whole run, wave 2: the reviewer pushes the accepts as soon as the first job of the first wave has started (not when the last one has), all together, and after all 17 merge requests were opened', async () => {
  const { w, r } = await runWorld({ bootSpreadSec: 20 });
  const snaps = w.reviewSnapshots.filter((s) => s.user === 'agent-reviewer');
  const wave2 = snaps.slice(1);
  assert.equal(wave2.length, 15);
  assert.ok(wave2[0].mrJobsStarted >= 1, 'a job of the first wave had started');
  assert.ok(wave2[0].mrJobsPending > 0, 'other first-wave jobs were still waiting for a machine: the second wave does not wait for them, so those machines are still in the group when its pipelines ask for theirs');
  assert.ok(wave2[0].mrJobsStarted < 17);
  assert.equal(r.exitCode, 0, 'and the run is as good as before');
  assert.ok(r.model.a1.peak >= 20, `the group reached ${r.model.a1.peak} machines`);
  assert.ok(wave2.every((s) => s.mrsOpen >= 17));
  const span = wave2.at(-1).t - wave2[0].t;
  assert.ok(span <= 15_000, `the 15 accepts of the burst took ${span} ms of virtual time`);
  const idx = (pred) => w.writeLog.findIndex(pred);
  const lastOpen = w.writeLog.map((e, i) => (e.method === 'POST' && /merge_requests$/.test(e.path) ? i : -1)).filter((i) => i >= 0).at(-1);
  const firstWave2 = idx((e) => /Collab-Verdict: accept/.test(e.body?.commit_message ?? '') && e.body.branch === wave2[0].branch);
  assert.ok(firstWave2 > lastOpen, 'wave 2 starts after the last merge request of wave 1 was opened');
});

test('whole run, wave 2: only a job of a merge request of this run releases the second wave — a job on a pipeline of main (the one a landing starts) does not; when no such job starts, the reviewer waits 8 minutes, says so, and pushes anyway', async () => {
  const mainJob = (w) => w.jobs.push({
    id: ++w.jobSeq, name: 'unit', status: 'pending', created_at: isoAt(w.t), started_at: null, finished_at: null, runner: null, allow_failure: false,
    pipeline: { id: ++w.pipelineSeq, ref: 'main', sha: w.mainHead() }, mrIid: null, instance: null, finishAt: null,
  });
  const { w, report, r } = await runWorld({ seeded: true, mrJobsNeverStart: true, setup: mainJob }, { maxMinutes: 60 });
  assert.ok(w.jobs.some((j) => !j.mrIid && j.started_at), 'the job on main did start');
  assert.ok(w.jobs.filter((j) => j.mrIid).every((j) => !j.started_at), 'no job of a merge request started');
  assert.match(report, /no first-wave job had started after 8 minutes; the review commits were pushed anyway/);
  const firstReview = w.reviewSnapshots.find((s) => s.user === 'agent-reviewer');
  assert.ok(firstReview.t - NOW0 >= 8 * 60_000, `the first review came ${(firstReview.t - NOW0) / 60_000} minutes into the run`);
  assert.equal(r.exitCode, 1);
});

test('whole run: the commit main has before the lanes is read after the seed landed and before the first lane commit (the commits on main are counted from it)', async () => {
  const { w } = await runWorld();
  const calls = w.fetch.calls;
  const baseRead = calls.find((c) => c.method === 'GET' && c.path === `${PRJ}/repository/branches/main`);
  const seedLanded = w.mrs[0].merged_at;
  const firstLane = calls.find((c) => c.method === 'POST' && /repository\/commits$/.test(c.path) && /ctl-no-review$/.test(c.body.branch));
  assert.ok(baseRead && firstLane);
  assert.ok(baseRead.n < firstLane.n, 'the base is read before wave 1 starts');
  assert.ok(Date.parse(seedLanded) <= NOW0 + 60 * 60_000);
  assert.equal(calls.filter((c) => c.method === 'GET' && c.path === `${PRJ}/repository/branches/main`).length, 1);
});

test('whole run: jobs that take 7 minutes are waited for — the report is written only when every job of the run has finished, and the run still passes', async () => {
  const { r, report } = await runWorld({ runSec: 400 }, { maxMinutes: 240 });
  assert.equal(r.exitCode, 0, report);
  assert.doesNotMatch(report, /is still (pending|running)|had not finished/);
  assert.ok(r.model.jobs.length > 40 && r.model.jobs.every((j) => ['success', 'failed', 'canceled'].includes(j.status)), 'no job was left running when the report was made');
});

test('whole run, fleet: the second wave overlaps the first, the group reaches the 24 machines of its maximum, and every job got a machine of its own', async () => {
  const { w, r } = await runWorld();
  const a1 = r.model.a1;
  assert.equal(a1.verdict, 'PASS');
  assert.equal(a1.peak, 24);
  assert.ok(a1.launched >= a1.jobsRun, `${a1.launched} machines for ${a1.jobsRun} jobs`);
  assert.equal(w.instances.length, 0, 'the group is back at 0');
  assert.ok(a1.secondsToZero <= 900);
});

test('dry run: reads and checks everything, writes nothing (no non-GET call), reads only the seven token secrets and the two preflight reads of the fleet group from AWS, and prints the plan: the seed and 17 merge requests with their seats', async () => {
  const { w, r, out } = await runWorld({}, { dryRun: true });
  assert.equal(r.exitCode, 0);
  assert.equal(nonGet(w).length, 0);
  assert.equal(w.mrs.length, 0);
  assert.deepEqual(w.awsCalls.filter((a) => a[0] !== 'secretsmanager').map((a) => `${a[0]} ${a[1]}`), ['autoscaling describe-auto-scaling-groups', 'autoscaling describe-scaling-activities']);
  assert.equal(w.awsCalls.length, 7 + 2);
  const text = out.join('\n');
  assert.match(text, /dry run for vitana\/rehearsal, run r202611051400; every check passed; nothing will be written/);
  assert.match(text, /seed: a merge request of lane rehearsal\/seed would create 26 and update 0 file\(s\)/);
  const rows = out.filter((l) => /^ {2}(control|lane) /.test(l));
  assert.equal(rows.length, 17);
  assert.match(rows[0], /control ctl-no-review {8}agent-kiro-exafy {5}rehearsal\/r202611051400\/ctl-no-review {2}\(the bot must answer no_review\)/);
  assert.match(text, /agent-reviewer pushes the review commits, bot-land lands the lanes/);
});

test('dry run, current seed: says so; a run needs no seed merge request', async () => {
  const { out, r } = await runWorld({ seeded: true }, { dryRun: true });
  assert.equal(r.exitCode, 0);
  assert.match(out.join('\n'), /seed: already current on main/);
});

// ---- the refusals of a whole run: exit 2, nothing written --------------------------------------------------------------------
const refused = (res, pattern) => {
  assert.equal(res.r.exitCode, 2, res.report);
  assert.match(res.report, /rehearse: refusing to start; nothing was written:/);
  assert.match(res.report, pattern);
  assert.equal(nonGet(res.w).length, 0, 'nothing was written');
  assert.equal(res.w.mrs.filter((m) => m.state !== 'opened' || m.source_branch.startsWith('rehearsal/r202611051400')).length, 0);
};

test('refusal, whole run: a project that is not marked rehearsal (vitana-platform) is refused before GitLab or AWS is touched at all', async () => {
  const res = await runWorld({}, { project: 'vitana-platform' });
  refused(res, /project "vitana-platform" is not marked rehearsal: true in gitlab-settings\.json/);
  assert.equal(res.w.fetch.calls.length, 0);
  assert.equal(res.w.awsCalls.length, 0);
  assert.match(res.report, /has profile "mirror", not native/);
});

test('refusal, whole run: a project with a settings webhook or without landing: refused from the file alone', async () => {
  const withHook = writeSettings((c) => { c.projects.rehearsal.webhook = { url: 'https://gateway.test/h', events: ['pipeline'] }; });
  const a = await runWorld({}, { settings: withHook });
  refused(a, /webhook/);
  assert.equal(a.w.fetch.calls.length, 0);
  const noLanding = writeSettings((c) => { c.projects.rehearsal.landing = false; });
  refused(await runWorld({}, { settings: noLanding }), /landing: false/);
});

test('refusal, whole run: a live webhook on the project is refused, with the number of hooks', async () => {
  refused(await runWorld({ hooks: [{ id: 1, url: 'https://gateway.test/hook' }] }), /the live project has 1 webhook\(s\)/);
});

test('refusal, whole run: a live mirror (mirror: true, or a remote mirror) is refused', async () => {
  refused(await runWorld({ mirror: true }), /the live project is a mirror/);
  refused(await runWorld({ remoteMirrors: [{ id: 1, url: 'https://github.com/exafyltd/x.git' }] }), /1 remote mirror\(s\)/);
});

test('refusal, whole run: a live main that is not the native profile (Maintainers can push, force push on) is refused', async () => {
  refused(await runWorld({ protection: protection({ push_access_levels: [{ access_level: 40 }] }) }), /the live project: push to main is not "No one"/);
  refused(await runWorld({ protection: protection({ allow_force_push: true }) }), /force push to main is allowed/);
});

test('refusal, whole run: an open merge request that is not from a rehearsal run is refused (the bot would land it), and so is a default branch that is not main', async () => {
  refused(await runWorld({ setup: (w) => addOpenMr(w, { branch: 'feature/someone-else' }) }), /1 open merge request\(s\) are not from a rehearsal run \(for example !1, branch feature\/someone-else\)/);
  refused(await runWorld({ projectInfo: { default_branch: 'develop' } }), /the default branch is "develop"/);
});

test('refusal, whole run: a token that belongs to another account, a missing secret and an unreadable secret are each refused', async () => {
  refused(await runWorld({ identity: { 'agent-reviewer': 'agent-kiro-exafy' } }), /the token in the secret of agent-reviewer belongs to agent-kiro-exafy/);
  refused(await runWorld({ noTokenFor: 'agent-kiro-jtadic' }), /the secret vitana\/engineering\/gitlab\/agents\/agent-kiro-jtadic is empty: the settings sync has not stored a token for agent-kiro-jtadic yet/);
  refused(await runWorld({ unreadableFor: 'bot-land' }), /the secret vitana\/engineering\/gitlab\/agents\/bot-land could not be read/);
  refused(await runWorld({ tokens: { 'bot-land': 'short' } }), /does not hold a token/);
});

test('refusal, whole run: no REGION, a protected-file control that would prove nothing, an unknown private address and an unreachable GitLab are each refused', async () => {
  refused(await runWorld({}, {}, { env: {} }), /REGION is not set to an AWS region/);
  refused(await runWorld({}, {}, { protectedGlobs: ['scripts/collab/queue.mjs'] }), /CLAUDE\.md is not a protected gate file under the rules of this machine/);
  refused(await runWorld({}, {}, { protectedGlobs: [...PROTECTED_GATE_PATHS, 'package.json'] }), /the seed contains protected gate file\(s\) the bot would refuse: package\.json/);
  refused(await runWorld({}, {}, { networkInterfaces: () => ({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }) }), /private address of the GitLab machine is not known/);
  const down = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const res = await runWorld({}, {}, { fetch: down });
  assert.equal(res.r.exitCode, 2);
  assert.match(res.report, /the token of agent-kiro-exafy was not accepted by GitLab/);
  assert.match(res.report, /could not be reached \(ECONNREFUSED\)/);
});

test('refusal, whole run: a refusal that names a value the user gave (a --url with a token in it) does not print the token once the run has read it', async () => {
  const token = TOKENS['bot-land'];
  const { out, err, r } = await runWorld({}, { url: `http://${token}.example.com` });
  assert.equal(r.exitCode, 2);
  assert.match(out.join('\n'), /--url http:\/\/\[redacted\]\.example\.com/);
  assert.equal(`${out.join('\n')}${err.join('\n')}`.includes(token), false);
});

test('refusal, whole run: a bad --url (plain http to a remote host) is refused; a missing or invalid settings file is refused', async () => {
  const res = await runWorld({}, { url: 'http://gitlab.example.com' });
  assert.equal(res.r.exitCode, 2);
  assert.match(res.report, /--url http:\/\/gitlab\.example\.com: .*https/);
  assert.equal((await runWorld({}, { settings: '/nonexistent/gitlab-settings.json' })).r.exitCode, 2);
  const bad = path.join(tmp(), 'bad.json');
  fs.writeFileSync(bad, '{"schema_version": 9}');
  const res2 = await runWorld({}, { settings: bad });
  assert.equal(res2.r.exitCode, 2);
  assert.match(res2.report, /the settings file is not valid/);
});

test('preflight, whole run: the built seed must pass its own tests on this machine or the run is refused (exit 2, nothing written) — otherwise the job unit fails and the seed merge request never lands', async () => {
  const seen = [];
  const res = await runWorld({}, {}, { seedSelfTest: async (files) => { seen.push(files); return { ok: false, output: 'not ok 1 - the copied land-guard finds the lane of a merge request title\n  error: Cannot find module ./nope.mjs\n# fail 1' }; } });
  refused(res, /the seed does not pass its own tests on this machine \(the job unit would fail, so the seed merge request would never land\): .*Cannot find module/);
  assert.equal(seen.length, 1, 'run once');
  assert.ok(seen[0] instanceof Map && seen[0].has('test/collab.test.mjs') && seen[0].has('tools/collab/land-guard.mjs'), 'on the files the seed would put on main');
  const dry = await runWorld({}, { dryRun: true }, { seedSelfTest: async () => ({ ok: false, output: 'not ok 1 - x' }) });
  assert.equal(dry.r.exitCode, 2, 'a dry run is refused too');
  const broken = await runWorld({}, {}, { seedSelfTest: async () => { throw new Error('EACCES: the temporary directory cannot be made'); } });
  refused(broken, /the tests of the seed could not be run on this machine: EACCES/);
  const fine = await runWorld({}, { dryRun: true }, { seedSelfTest: async () => ({ ok: true, output: '' }) });
  assert.equal(fine.r.exitCode, 0);
});

test('preflight, whole run: a copy of the collab tooling that drifted from the seed (a new local import in land-guard.mjs) is refused before the first write — with the real self-test, in a temporary directory', async () => {
  const platformRoot = tmp('rehearse-drift-');
  fs.mkdirSync(path.join(platformRoot, 'scripts', 'collab'), { recursive: true });
  for (const f of ['queue.mjs', 'land-guard.mjs', 'protected-gate-files.json']) fs.copyFileSync(path.join(REPO, 'scripts', 'collab', f), path.join(platformRoot, 'scripts', 'collab', f));
  const guard = path.join(platformRoot, 'scripts', 'collab', 'land-guard.mjs');
  fs.writeFileSync(guard, `${fs.readFileSync(guard, 'utf8')}\nimport './a-new-helper-the-seed-does-not-have.mjs';\n`); // an import may stand anywhere at the top level (the file starts with a shebang)
  const real = R.defaultDeps({}).seedSelfTest;
  const drifted = await runWorld({}, {}, { platformRoot, seedSelfTest: real });
  refused(drifted, /the seed does not pass its own tests on this machine/);
  assert.match(drifted.report, /a-new-helper-the-seed-does-not-have/);
  const sound = await runWorld({}, { dryRun: true }, { seedSelfTest: real });
  assert.equal(sound.r.exitCode, 0, sound.report);
});

test('seed self-test (real): runs the tests of the built seed in a temporary directory with a clean environment and removes the directory; passes on the real seed, fails on a broken one or on one with no tests', async () => {
  const base = tmp('rehearse-selftest-base-');
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = base;
  const { seedSelfTest } = R.defaultDeps({});
  try {
    const ok = await seedSelfTest(seedFiles());
    assert.equal(ok.ok, true, ok.output);
    assert.deepEqual(fs.readdirSync(base), [], 'the temporary directory is gone');
    const broken = new Map(seedFiles());
    broken.set('tools/collab/queue.mjs', `${broken.get('tools/collab/queue.mjs')}\nimport './does-not-exist.mjs';\n`);
    const bad = await seedSelfTest(broken);
    assert.equal(bad.ok, false);
    assert.match(bad.output, /does-not-exist/);
    assert.deepEqual(fs.readdirSync(base), [], 'also when it fails');
    const none = await seedSelfTest(new Map([...seedFiles()].filter(([p]) => !p.startsWith('test/'))));
    assert.deepEqual([none.ok, none.output], [false, 'the seed has no test files under test/']);
    assert.deepEqual(fs.readdirSync(base), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
});

test('seed self-test (real): the child gets no secret of this machine — only a PATH and a temporary directory, not the environment of the run', async () => {
  const files = new Map(seedFiles());
  files.set('test/env.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the environment of the self-test', () => { assert.equal(process.env.GATEWAY_SERVICE_TOKEN, undefined); assert.equal(process.env.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(process.env.REGION, undefined); });\n");
  const leak = ['must', 'not', 'reach', 'the', 'seed', 'tests'].join('-');
  process.env.GATEWAY_SERVICE_TOKEN = leak;
  process.env.AWS_SECRET_ACCESS_KEY = `${leak}-either`;
  process.env.REGION = 'eu-central-1';
  try {
    const r = await R.defaultDeps({}).seedSelfTest(files);
    assert.equal(r.ok, true, r.output);
  } finally {
    delete process.env.GATEWAY_SERVICE_TOKEN; delete process.env.AWS_SECRET_ACCESS_KEY; delete process.env.REGION;
  }
});

test('hygiene: a merge request left open by an earlier run (branch rehearsal/…) is closed first; nothing else is touched; the run then goes on and passes', async () => {
  const res = await runWorld({ setup: (w) => addOpenMr(w, { branch: 'rehearsal/r202610310900/lane-01' }) });
  assert.equal(res.r.exitCode, 0, res.report);
  assert.equal(res.w.mrs[0].state, 'closed');
  const first = nonGet(res.w)[0];
  assert.equal(`${first.method} ${first.path}`, `PUT ${PRJ}/merge_requests/1`);
  assert.deepEqual(first.body, { state_event: 'close' });
  assert.match(res.errText, /closing !1 left open by an earlier run \(rehearsal\/r202610310900\/lane-01\)/);
  assert.deepEqual(res.r.model.closedAtStart, [1]);
});

test('whole run: a secret that reaches a line on stderr by a path the client does not guard is redacted too (here: the name of a leftover branch)', async () => {
  const token = TOKENS['agent-reviewer'];
  const { err, out, r } = await runWorld({ setup: (w) => addOpenMr(w, { branch: `rehearsal/${token}/lane-01` }) });
  assert.equal(r.exitCode, 0);
  assert.ok(err.some((l) => /closing !1 left open by an earlier run \(rehearsal\/\[redacted\]\/lane-01\)/.test(l)));
  assert.equal(`${err.join('\n')}${out.join('\n')}`.includes(token), false);
});

test('cleanup: at the end the five control merge requests are closed and their branches deleted; the lane branches are left to GitLab (removed on merge); nothing else is deleted', async () => {
  const { w } = await runWorld();
  const controls = w.mrs.filter((m) => /ctl-/.test(m.title));
  assert.equal(controls.length, 5);
  assert.ok(controls.every((m) => m.state === 'closed' && !w.branches.has(m.source_branch)));
  const deletes = nonGet(w).filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 5);
  assert.ok(deletes.every((c) => /ctl-/.test(decodeURIComponent(c.path))));
  assert.ok(w.mrs.filter((m) => /lane-/.test(m.title)).every((m) => m.state === 'merged'));
  assert.equal([...w.branches.keys()].filter((b) => b.startsWith('rehearsal/')).length, 0);
});

// ---- the seed, whole run ---------------------------------------------------------------------------------------------------
test('seed, whole run: on a project that holds only a README the seed goes through a merge request of lane rehearsal/seed — built by a seat, accepted by the reviewer, landed by the bot — before any lane is opened', async () => {
  const { w, report } = await runWorld();
  const seedMr = w.mrs[0];
  assert.equal(seedMr.title, 'VTID-05540 (rehearsal/seed): seed the rehearsal repository');
  assert.equal(seedMr.state, 'merged');
  assert.ok(w.mrs.slice(1).every((m) => Date.parse(m.created_at) >= Date.parse(seedMr.merged_at)), 'no other merge request was opened before the seed landed');
  const mainTitles = [];
  for (let cur = w.mainHead(); w.commits.get(cur).parents.length; cur = w.commits.get(cur).parents[0]) mainTitles.push(w.commits.get(cur).title);
  assert.equal(mainTitles.at(-1), seedMr.title, 'the seed is the first commit after the README');
  const tree = w.commits.get(w.mainHead()).tree;
  for (const p of ['package.json', 'scripts/ci-test.mjs', 'rehearsal.config.json', 'tools/collab/land-guard.mjs']) assert.ok(tree.has(p), p);
  assert.equal(JSON.parse(tree.get('rehearsal.config.json')).gitlabPrivateIp, IP);
  assert.match(report, /created, 0 updated\)/);
});

test('seed, whole run: a project whose main already holds the current seed gets no seed merge request, and the 17 merge requests of the run are the only ones', async () => {
  const { w, r, report } = await runWorld({ seeded: true });
  assert.equal(r.exitCode, 0, report);
  assert.match(report, /SEED {10}present \(26 file\(s\) already on main\)/);
  assert.equal(w.mrs.length, 17);
  assert.ok(w.mrs.every((m) => !/rehearsal\/seed/.test(m.title)));
});

test('seed, whole run: an outdated seed is updated through the same route; a lane file that earlier runs grew is not rewritten (create-only)', async () => {
  const grown = 'grown by an earlier run\n';
  const { w, r, report } = await runWorld({ seeded: true, seedChanges: { 'package.json': '{"old":true}\n', '.kiro/specs/rehearsal/lanes/lane-01.md': grown } });
  assert.equal(r.exitCode, 0, report);
  const seedCommit = w.writeLog.find((e) => /repository\/commits$/.test(e.path) && /\/seed$/.test(e.body.branch));
  assert.deepEqual(seedCommit.body.actions.map((a) => [a.action, a.file_path]), [['update', 'package.json']]);
  assert.match(report, /SEED {10}landed through !1 .*\(0 file\(s\) created, 1 updated\)/);
  assert.equal(JSON.parse(w.commits.get(w.mainHead()).tree.get('package.json')).name, 'vitana-rehearsal-seed');
  assert.ok(w.commits.get(w.mainHead()).tree.get('.kiro/specs/rehearsal/lanes/lane-01.md').startsWith(grown), 'the grown lane file is kept and the new entry is added to it');
});

test('seed, whole run: if the seed merge request does not land (the bot is down) the run stops there after 25 minutes, opens nothing else, still prints the report, and exits 1', async () => {
  const { w, r, report } = await runWorld({ botDead: true });
  assert.equal(r.exitCode, 1);
  assert.match(report, /RESULT: INCOMPLETE/);
  assert.match(report, /STOPPED in seed: the seed merge request !1 did not land within 25 minutes/);
  assert.equal(w.mrs.length, 1);
  assert.match(report, /A4 LANDING +(FAIL|NOT PROVEN)/);
});

test('seed, whole run: if GitLab shows no push event of agent-reviewer for the commit of the reviewer the run stops after two minutes with the reason (the bot would refuse every accept), and exits 1', async () => {
  const { w, r, report } = await runWorld({ noPushEvents: true });
  assert.equal(r.exitCode, 1);
  assert.match(report, /STOPPED in seed: agent-reviewer committed [0-9a-f]{8}, but GitLab shows no push event of agent-reviewer for it after 2 minutes/);
  assert.match(report, /the review commit has to be pushed with git/);
  assert.equal(w.mrs.length, 1);
  assert.ok(w.t - NOW0 < 10 * 60_000, 'it stopped quickly');
});

// ---- the failures of a landing run: the report names them ------------------------------------------------------------------------
test('failure: the bot goes down after the seed — the lanes do not land, the report lists each with what the bot said, A4 FAIL, exit 1; the controls are still cleaned up', async () => {
  const { w, r, report } = await runWorld({ botDiesAfterLandings: 1 }, { maxMinutes: 60 });
  assert.equal(r.exitCode, 1);
  assert.match(report, /RESULT: FAIL/);
  assert.equal((report.match(/lane-\d\d \(!\d+\) did not land \(opened\)/g) ?? []).length, 12);
  assert.match(report, /stopped waiting for the bot after 40 minutes/);
  assert.match(report, /A4 LANDING +FAIL/);
  assert.match(report, /0 of 12 lane merge request\(s\) landed/);
  assert.ok(w.mrs.filter((m) => /ctl-/.test(m.title)).every((m) => m.state === 'closed'));
});

test('failure: the landing budget ends while the bot is still landing lanes — the note says the bot was working and the budget was too short; a bot that landed nothing is not described so', async () => {
  const slow = await runWorld({ botEverySec: 120 }, { maxMinutes: 45 });
  const note = slow.r.model.notes.find((n) => /^stopped waiting for the bot/.test(n));
  assert.ok(note, slow.report);
  const landed = Number(/(\d+) of 12 lanes had landed/.exec(note)?.[1]);
  assert.ok(landed > 0 && landed < 12, `${landed} of 12 lanes had landed when the budget ended: ${note}`);
  assert.match(note, new RegExp(`^stopped waiting for the bot after 25 minutes; ${landed} of 12 lanes had landed, the last one less than ${R.STILL_LANDING_MIN} minutes before: the bot was still landing, so the budget was too short, not the bot broken`));
  assert.equal(slow.r.exitCode, 1);
  assert.match(slow.report, /A4 LANDING +FAIL/);
  const dead = await runWorld({ botDiesAfterLandings: 1 }, { maxMinutes: 60 });
  const deadNote = dead.r.model.notes.find((n) => /^stopped waiting for the bot/.test(n));
  assert.equal(deadNote, 'stopped waiting for the bot after 40 minutes; 0 of 12 lanes had landed');
});

test('failure: the fleet does not scale (no machine can be launched) — the report names the jobs still waiting and the launch failures AWS gave; nothing lands; exit 1', async () => {
  const { r, report } = await runWorld({ seeded: true, fleetStuck: true }, { maxMinutes: 60 });
  assert.equal(r.exitCode, 1);
  assert.match(report, /PROBLEMS AND NOTES/);
  assert.match(report, /job #\d+ unit is still pending \(created [0-9T:.Z-]+, merge request !\d+\)/);
  assert.match(report, /machine launch\(es\) failed: We currently do not have sufficient m6i\.xlarge capacity/);
  assert.match(report, /no first-wave job had started after 8 minutes; the review commits were pushed anyway/);
  assert.match(report, /A1 FLEET +FAIL/);
  assert.match(report, /peak fleet size 0 machine\(s\) in the group/);
  assert.match(report, /no job of the run was seen on the fleet runner/);
  assert.match(report, /A8 LEGACY +NOT PROVEN/);
});

// ---- the fleet group, read before the run and during it -------------------------------------------------------------------------
const opName = (op) => op.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('');
const deniedText = (op) => `An error occurred (AccessDenied) when calling the ${opName(op)} operation: User: arn:aws:sts::123456789012:assumed-role/vitana-eng-gitlab/i-0abc is not authorized to perform: autoscaling:${opName(op)} because no identity-based policy allows the autoscaling:${opName(op)} action`;
const denying = (...ops) => (n, args) => (ops.includes(args[1]) ? deniedText(args[1]) : null);
const ASG_OPS = ['describe-auto-scaling-groups', 'describe-scaling-activities'];

test('preflight, whole run: the role of the GitLab machine may not read the fleet group (either operation denied, or both) — refused with exit 2 before anything is written, naming both actions and the one that was denied', async () => {
  for (const ops of [[ASG_OPS[0]], [ASG_OPS[1]], ASG_OPS]) {
    const res = await runWorld({ asgFail: denying(...ops) });
    refused(res, /the role of the GitLab machine may not read the fleet group vitana-eng-fleet/);
    assert.match(res.report, /it needs both autoscaling:DescribeAutoScalingGroups and autoscaling:DescribeScalingActivities \(infra\/gitlab-engineering\/terraform\/settings\.tf grants them/);
    for (const op of ops) assert.match(res.report, new RegExp(`autoscaling:${opName(op)} is denied \\(An error occurred \\(AccessDenied\\)`), `${op} is named as denied`);
    for (const op of ASG_OPS.filter((o) => !ops.includes(o))) assert.doesNotMatch(res.report, new RegExp(`autoscaling:${opName(op)} is denied`), `${op} was not denied`);
    assert.equal(res.w.mrs.length, 0);
    assert.deepEqual(res.w.awsCalls.slice(7).map((a) => `${a[0]} ${a[1]}`), ASG_OPS.map((o) => `autoscaling ${o}`), 'after the seven secrets, each operation was read once and nothing else was asked');
    assert.equal(res.w.awsCalls.slice(7).every((a) => a.includes('vitana-eng-fleet') && a[a.indexOf('--region') + 1] === 'eu-central-1'), true);
  }
});

test('fleetReadProblems: reads each operation once for the named group (one activity), tells a denial from another failure by the message or by stderr, strips the runner prefix, and removes secrets from what it returns', async () => {
  const calls = [];
  const leaked = ['s3cr3t', 'value', '0123456789'].join('-');
  const redactor = (s) => s.split(leaked).join('[redacted]');
  const failing = (byOp) => async (args) => { calls.push(args); const f = byOp[args[1]]; if (f) throw Object.assign(new Error(f.message), { stderr: f.stderr ?? '' }); return { stdout: '{}' }; };
  const r = await R.fleetReadProblems(failing({
    'describe-scaling-activities': { message: `aws autoscaling describe-scaling-activities failed (exit 254): An error occurred (AccessDenied) when calling the DescribeScalingActivities operation ${leaked}` },
    'describe-auto-scaling-groups': { message: 'aws autoscaling describe-auto-scaling-groups failed (exit 255): Rate exceeded', stderr: '' },
  }), { region: 'eu-central-1', asgName: 'a-fleet', redactor });
  assert.deepEqual(calls.map((a) => a.slice(0, 4)), [['autoscaling', 'describe-auto-scaling-groups', '--auto-scaling-group-names', 'a-fleet'], ['autoscaling', 'describe-scaling-activities', '--auto-scaling-group-name', 'a-fleet']]);
  assert.deepEqual(calls.map((a) => a[a.indexOf('--region') + 1]), ['eu-central-1', 'eu-central-1']);
  assert.equal(calls[1][calls[1].indexOf('--max-items') + 1], '1');
  assert.deepEqual(r, {
    denied: ['autoscaling:DescribeScalingActivities is denied (An error occurred (AccessDenied) when calling the DescribeScalingActivities operation [redacted])'],
    failed: ['describe-auto-scaling-groups: Rate exceeded'],
  });
  // a denial is also recognised in stderr when the first line of the message says nothing, and by the other names AWS uses
  const viaStderr = await R.fleetReadProblems(failing({ 'describe-auto-scaling-groups': { message: 'aws autoscaling describe-auto-scaling-groups failed (exit 254): ', stderr: 'An error occurred (UnauthorizedOperation) when calling the operation' } }), { region: 'eu-central-1', asgName: 'a-fleet', redactor });
  assert.deepEqual(viaStderr.denied.map((d) => d.split(' ')[0]), ['autoscaling:DescribeAutoScalingGroups']);
  assert.deepEqual(viaStderr.failed, []);
  const clean = await R.fleetReadProblems(failing({}), { region: 'eu-central-1', asgName: 'a-fleet', redactor });
  assert.deepEqual(clean, { denied: [], failed: [] });
});

test('preflight, whole run: a dry run refuses in the same way (it is how the owner finds out before the run), and a role that may read the group passes it with the two reads as the only extra AWS calls', async () => {
  const dry = await runWorld({ asgFail: denying(ASG_OPS[1]) }, { dryRun: true });
  assert.equal(dry.r.exitCode, 2);
  assert.match(dry.report, /autoscaling:DescribeScalingActivities is denied/);
  assert.equal(nonGet(dry.w).length, 0);
  const fine = await runWorld({}, { dryRun: true });
  assert.equal(fine.r.exitCode, 0);
  assert.equal(fine.w.awsCalls.length, 9);
});

test('preflight, whole run: a read of the fleet group that fails for another reason than a denial (a throttled call) does not refuse — it is noted, and the run goes on and passes', async () => {
  const { r, report } = await runWorld({ asgFail: (n) => (n <= 2 ? 'An error occurred (Throttling) when calling the operation: Rate exceeded' : null) });
  assert.equal(r.exitCode, 0, report);
  assert.match(report, /PROBLEMS AND NOTES[\s\S]*the fleet group could not be read before the run \(.*Throttling.*\); the run goes on, and A1 is NOT PROVEN if the reads keep failing/);
});

test('failure: the first reads of the fleet group during the run fail (a transient AWS error) — sampling goes on with the next polls instead of stopping, A1 is decided from the samples that were read, and the failed reads are noted', async () => {
  // calls 1 and 2 are the preflight; calls 3 to 6 are the first four polls (a run of four failures), and calls 20 to 22 are three more later on
  const throttled = (n) => ((n >= 3 && n <= 6) || (n >= 20 && n <= 22) ? 'An error occurred (Throttling) when calling the operation: Rate exceeded' : null);
  const { w, r, report } = await runWorld({ asgFail: throttled });
  assert.equal(r.exitCode, 0, report);
  assert.match(report, /A1 FLEET +PASS/);
  assert.match(report, /the fleet group could not be read 3 times in a row \(.*Throttling.*\); it is read again on every poll/);
  assert.equal((report.match(/could not be read 3 times in a row/g) ?? []).length, 2, 'said once for each run of failures (not at every poll of a longer run, and again for a later run)');
  assert.ok(w.awsCalls.filter((a) => a[1] === 'describe-auto-scaling-groups').length > 30, 'it kept asking');
  assert.equal(r.model.samples.filter((s) => !s.ok).length, 7);
});

test('failure: the fleet group stays unreadable during the run for another reason than a denial — A1 is NOT PROVEN with the error and the two IAM actions, the rest of the run goes on and is decided, the wait at the end gives up after three failed reads, exit 1', async () => {
  const { w, r, report } = await runWorld({ asgFail: (n) => (n >= 3 ? 'An error occurred (ServiceUnavailable) when calling the operation: try later' : null) });
  assert.equal(r.exitCode, 1);
  assert.match(report, /A1 FLEET +NOT PROVEN/);
  assert.match(report, /the ASG could not be read \(.*ServiceUnavailable.*\); the role of the GitLab machine needs autoscaling:DescribeAutoScalingGroups and autoscaling:DescribeScalingActivities/);
  assert.match(report, /the fleet group could not be read 3 times in a row/);
  assert.match(report, /machines launched are unknown/);
  for (const a of ['A2 ISOLATION', 'A3 ACCESS', 'A4 LANDING', 'A8 LEGACY']) assert.match(report, new RegExp(`\\n${a}\\s+PASS\\n`), a);
  assert.equal(w.mrs.filter((m) => m.state === 'merged').length, 13, 'the landing run itself was not affected');
  const reads = w.awsCalls.filter((a) => a[1] === 'describe-auto-scaling-groups').length;
  assert.ok(reads > 30, `${reads} reads: it never stopped asking during the run`);
  const lastRead = r.model.samples.at(-1).t;
  const lastJob = Math.max(...r.model.jobs.map((j) => Date.parse(j.finished_at ?? '')).filter(Number.isFinite));
  assert.ok(lastRead - lastJob < 5 * 60_000, 'the wait for the group to reach 0 gave up after three failed reads instead of waiting the 16 minutes');
});

test('failure: a negative control prints FAIL in a job — A2 FAIL and exit 1, but the rest of the rehearsal still runs and passes (the control never blocks the job)', async () => {
  const { r, report } = await runWorld({ negctl: { imds: 'FAIL' }, negctlDetail: { imds: 'a metadata token was issued to a job (PUT /latest/api/token: HTTP 200; GET /latest/meta-data/: HTTP 401)' } });
  assert.equal(r.exitCode, 1);
  assert.match(report, /A2 ISOLATION +FAIL/);
  assert.match(report, /imds: \d+ FAIL, 0 PASS \(job #\d+: a metadata token was issued to a job \(PUT \/latest\/api\/token: HTTP 200; GET \/latest\/meta-data\/: HTTP 401\)\)/, 'the report says why the control failed');
  assert.doesNotMatch(report, /gitlab-host: \d+ (PASS|FAIL), \d+ (PASS|FAIL) \(job/, 'only a failing control shows a detail');
  assert.match(report, /\n {2}imds {9}PASS 0 {2}FAIL \d+/);
  for (const a of ['A1 FLEET', 'A3 ACCESS', 'A4 LANDING', 'A8 LEGACY']) assert.match(report, new RegExp(`\\n${a}\\s+PASS\\n`), a);
});

test('A2 baseline, whole run: the report says whether GitLab was reached from the jobs — as a skipped line, so it can never fail the run — and flags the traces where it was not', async () => {
  const ok = await runWorld();
  assert.match(ok.report, /\n {2}\[skip\] baseline \(information only\): GitLab was reached from the job in (\d+) of \1 trace\(s\)\n/);
  const cut = await runWorld({ baseline: 'not reachable' });
  assert.equal(cut.r.exitCode, 0, 'the baseline never fails the run');
  assert.match(cut.report, /\[skip\] baseline \(information only\): GitLab was reached from the job in 0 of \d+ trace\(s\), NOT reached in \d+: the two network controls prove nothing there/);
  assert.doesNotMatch((await runWorld({ baseline: null })).report, /baseline \(information only\)/);
});

test('failure: the job traces cannot be read, or the jobs print no controls — A2 is NOT PROVEN, never a quiet pass', async () => {
  const forbidden = await runWorld({ traceForbidden: true });
  assert.equal(forbidden.r.exitCode, 1);
  assert.match(forbidden.report, /A2 ISOLATION +NOT PROVEN/);
  assert.match(forbidden.report, /not seen in any job trace/);
  const none = await runWorld({ omitNegctl: true });
  assert.match(none.report, /A2 ISOLATION +FAIL/, 'succeeded jobs that printed no controls fail');
  assert.match(none.report, /succeeded but printed only no negative control line/);
});

test('failure: a job runs on the legacy runner — A8 FAIL and A1 FAIL (the retag did not hold), exit 1', async () => {
  const { r, report } = await runWorld({ legacyNth: 12 });
  assert.equal(r.exitCode, 1);
  assert.match(report, /A8 LEGACY +FAIL/);
  assert.match(report, /1 job\(s\) ran on the legacy runner vitana-eng-1/);
  assert.match(report, /A1 FLEET +FAIL/);
  assert.match(report, /1 job\(s\) did not run on the fleet runner vitana-eng-fleet/);
});

test('failure: the settings check reports drift — A3 and A8 FAIL, exit 1', async () => {
  const { r, report } = await runWorld({ settingsExit: 3 });
  assert.equal(r.exitCode, 1);
  assert.match(report, /A3 ACCESS +FAIL/);
  assert.match(report, /gitlab-settings\.mjs check exit 3 \(drift\)/);
  assert.match(report, /A8 LEGACY +FAIL/);
});

test('failure: when the settings check reports drift the report shows what it said (first lines), and a token in those lines is redacted', async () => {
  const token = TOKENS['bot-land'];
  const { r, report, out, err } = await runWorld({ settingsExit: 3, settingsLines: ['drift: protected branch: main push is Maintainers', `warning: something with ${token} inside`, 'gitlab-settings: 2 drift(s)', 'not a drift line', '{"json":"log line"}'] });
  assert.equal(r.exitCode, 1);
  assert.match(report, /settings check said: drift: protected branch: main push is Maintainers/);
  assert.match(report, /settings check said: gitlab-settings: 2 drift\(s\)/);
  assert.doesNotMatch(report, /not a drift line|json/);
  assert.equal(`${out.join('\n')}${err.join('\n')}`.includes(token), false, 'the run redacts every secret it has read, whatever the source of the text');
  assert.match(report, /settings check said: warning: something with \[redacted\] inside/);
  assert.equal(r.report.includes(token), false, 'the report string that run() returns is redacted too, not only what it prints');
});

test('writes are sent once: a 503 while closing a control is not repeated by the client; the run reports it (STOPPED in cleanup) and exits 1', async () => {
  const { w, r, report } = await runWorld({ putFailsOnce: true });
  assert.equal(r.exitCode, 1);
  assert.match(report, /STOPPED in cleanup: .*PUT .* failed with 503/);
  assert.equal(nonGet(w).filter((c) => c.method === 'PUT').length, 1, 'one PUT, not repeated, and cleanup went no further');
});

test('failure: an extra Maintainer, a token that never expires, or main that lost its protection after the start fails A3 (re-read at the end)', async () => {
  const extra = await runWorld({ members: [{ username: 'root', access_level: 50 }, { username: 'bot-land', access_level: 40 }, { username: 'agent-kiro-hotmail', access_level: 40 }] });
  assert.match(extra.report, /A3 ACCESS +FAIL/);
  assert.match(extra.report, /not allowed: agent-kiro-hotmail/);
  const never = await runWorld({ expires: { 'agent-kiro-jtadic': null } });
  assert.match(never.report, /A3 ACCESS +FAIL/);
  assert.match(never.report, /agent-kiro-jtadic: no expiry/);
  const lost = await runWorld({ protectionChange: { afterLandings: 3, value: protection({ push_access_levels: [{ access_level: 40 }] }) } });
  assert.match(lost.report, /A3 ACCESS +FAIL/);
  assert.match(lost.report, /push to main is not "No one"/);
  assert.equal(lost.r.exitCode, 1);
  const far = await runWorld({ expires: { 'bot-metrics': '2027-06-01' } });
  assert.match(far.report, /bot-metrics: 208 day\(s\) left/);
  assert.equal(far.r.exitCode, 1);
});

test('failure: a control that the bot LANDS (here: it believes the accept of the builder) fails A4, named LANDED, and the commit count on main shows the extra commit', async () => {
  const { r, report } = await runWorld({ botLandsForged: true });
  assert.equal(r.exitCode, 1);
  assert.match(report, /A4 LANDING +FAIL/);
  assert.match(report, /ctl-builder-accept LANDED \(it must be refused: review_forged\)/);
  assert.match(report, /13 commit\(s\) on main since the run began, 12 expected/);
});

test('partial run: --agents 5 opens 5 lanes and 5 controls, does not check the 20-machine peak (and says so), and exits 0 when everything else holds', async () => {
  const { w, r, report } = await runWorld({}, { agents: 5 });
  assert.equal(r.exitCode, 0, report);
  assert.match(report, /5 agents \+ 5 controls/);
  assert.match(report, /\[skip\] peak fleet size \d+ machine\(s\) \(the plan's 20 is checked with 12 agents; this run had 5\)/);
  assert.equal(w.mrs.filter((m) => /lane-/.test(m.title) && m.state === 'merged').length, 5);
  assert.match(report, /RESULT: PASS/);
});

test('a report that cannot be made does not lose the run: it says what is known (the stop and the notes), exits 1, and never prints a token', async () => {
  const token = TOKENS['bot-land'];
  const { r, report, out } = await runWorld({ botDead: true }, {}, { settingsCheck: async () => ({ exitCode: 3, lines: `not a list, but holds ${token}` }) });
  assert.equal(r.exitCode, 1);
  assert.match(report, /^REHEARSAL REPORT could not be made \(/);
  assert.match(report, /stop: seed: the seed merge request !1 did not land within 25 minutes/);
  assert.equal(out.join('\n').includes(token), false);
  assert.equal(r.report, report);
});

test('last resort: an error that nothing caught is one redacted line on stderr (every token shape removed, cut to one line) and exit 1; inside a run the secrets it read are removed as well, and run() ends with exit 1 instead of throwing', async () => {
  const lines = [];
  const shaped = (prefix, c) => `${prefix}-${c.repeat(20)}`; // token-shaped, built here so that no such literal is in the file
  assert.equal(R.lastResort(new Error(`boom ${shaped('glpat', 'A')} tail`), { stderr: (l) => lines.push(l) }), 1);
  assert.deepEqual(lines, ['rehearse: unexpected error: boom [redacted] tail']);
  lines.length = 0;
  R.lastResort(new Error(`first line ${shaped('glrt', 'B')}\nsecond line ${'x'.repeat(600)}`), { stderr: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /\n|glrt-/);
  assert.ok(lines[0].length < 340);
  R.lastResort('a plain string', { stderr: (l) => lines.push(l) });
  assert.equal(lines.at(-1), 'rehearse: unexpected error: a plain string');
  // inside a run: tokens it has read are removed, and nothing was written before the error
  const token = TOKENS['bot-land'];
  const res = await runWorld({}, {}, { random: () => { throw new Error(`the random source broke while holding ${token}`); } });
  assert.equal(res.r.exitCode, 1);
  assert.match(res.errText, /rehearse: unexpected error: the random source broke while holding \[redacted\]/);
  assert.equal(`${res.out.join('\n')}\n${res.errText}`.includes(token), false);
  assert.equal(nonGet(res.w).length, 0);
});

test('the command line: main() runs a dry run to exit 0, refuses a usage mistake with exit 2 and the usage text, and prints --help with exit 0', async () => {
  const w = makeWorld();
  const out = [];
  const deps = {
    fetch: w.fetch, sleep: async (ms) => w.advance(ms), now: () => w.t, env: { REGION: 'eu-central-1' }, aws: w.aws, stdout: (l) => out.push(l), stderr: () => {},
    networkInterfaces: () => ({ ens5: [{ family: 'IPv4', address: IP, internal: false }] }), seedDir: SEED, platformRoot: REPO, protectedGlobs: PROTECTED_GATE_PATHS,
    settingsCheck: async () => ({ exitCode: 0, lines: [] }), random: () => 'abcd', seedSelfTest: async () => ({ ok: true, output: '' }),
  };
  assert.equal(await R.main(['--project', 'rehearsal', '--agents', '12', '--settings', SETTINGS, '--url', 'https://gitlab.test', '--dry-run'], deps), 0);
  assert.ok(out.some((l) => /dry run for vitana\/rehearsal, run r\d{12}abcd/.test(l)));
  out.length = 0;
  assert.equal(await R.main(['--project', 'rehearsal', '--bogus'], deps), 2);
  assert.match(out.join('\n'), /unknown option --bogus[\s\S]*usage: node scripts\/eng\/rehearse\.mjs/);
  out.length = 0;
  assert.equal(await R.main(['--help'], deps), 0);
  assert.match(out.join('\n'), /^usage: node scripts\/eng\/rehearse\.mjs/);
  assert.equal(await R.main(['--project', 'vitana-v1'], deps), 2);
});

test('the settings check of a run is gitlab-settings.mjs `check` with --config and --url: with no REGION it answers its usage exit 2 at once (no AWS, no GitLab is reached)', async () => {
  const d = R.defaultDeps({});
  const r = await d.settingsCheck({ configFile: SETTINGS, url: 'http://127.0.0.1', env: {} });
  assert.equal(r.exitCode, 2);
  assert.match(r.lines.join('\n'), /REGION is not set to an AWS region/);
});

test('README: says that terraform/settings.tf grants the two autoscaling actions and that the rehearsal refuses to start without them, carries no Terraform snippet or follow-up wording, and describes the imds control as no token and no data', () => {
  const text = fs.readFileSync(path.join(REPO, 'infra', 'gitlab-engineering', 'rehearsal', 'README.md'), 'utf8');
  assert.match(text, /terraform\/settings\.tf/);
  assert.match(text, /autoscaling:DescribeAutoScalingGroups/);
  assert.match(text, /autoscaling:DescribeScalingActivities/);
  assert.match(text, /refuses to start/);
  assert.doesNotMatch(text, /```hcl|aws_iam_policy_document|aws_iam_role_policy|follow-up change/);
  assert.match(text, /NEGCTL imds PASS` \| no metadata token is issued to a job container and a plain read returns no data/);
  assert.match(text, /`review_forged` on a lane/, 'a lane refused as review_forged can be the push event lag');
});

test('the default aws runner and settings check are wired to the real modules (nothing is called here): defaultDeps has the injection points the run needs', () => {
  const d = R.defaultDeps({ REGION: 'eu-central-1' });
  for (const k of ['fetch', 'sleep', 'now', 'aws', 'stdout', 'stderr', 'networkInterfaces', 'settingsCheck', 'random', 'seedSelfTest']) assert.equal(typeof d[k], 'function', k);
  assert.equal(d.seedDir, SEED);
  assert.equal(d.platformRoot, REPO);
  assert.match(d.random(), /^[0-9a-f]{4}$/);
  assert.deepEqual(d.protectedGlobs, PROTECTED_GATE_PATHS);
  assert.equal(R.defaultSeedDir(), SEED);
  assert.equal(R.defaultPlatformRoot(), REPO);
});
