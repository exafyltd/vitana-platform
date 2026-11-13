// Tests of scripts/eng/parity-report.mjs (plan agentic-delivery §8.1 step 3 and the checklist, lane cutover, VTID-05545): GitHub results and
// GitLab shadow jobs are paired by SHA through the workflow-to-job map, every unexplained difference is listed, and a commit staging never
// served is "not comparable". Both hosts are recording fakes. Dependency-free Node (node:test), so UNIT.yml runs it with no install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from './testing/fake-fetch.mjs';
import * as parity from './parity-report.mjs';

const T0 = '2026-11-10T08:00:00Z';
const at = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();
// the shape lane pipelines writes in config/delivery/services.json (repositories.<repo>.github_workflows)
const MAP = {
  'UNIT-TESTS.yml': { fate: 't1', path_filter: false, jobs: ['vitest', 'vitest-union'] },
  'i18n-check.yml': { fate: 't1', path_filter: true, jobs: ['i18n-check'] },
  'AWS-STAGE-DEPLOY-FRONTEND.yml': { fate: 't2', path_filter: false, jobs: ['deploy-staging'] },
  'STAGING-VERIFY.yml': { fate: 't2', path_filter: false, jobs: ['staging-verify'] },
  'DEPLOY.yml': { fate: 'kept', path_filter: false, jobs: [] },
};
const gl = (id, jobs, extra = {}) => ({ id, sha: `sha${id}`, status: 'success', created_at: T0, finished_at: at(300), jobs: jobs.map(([name, status, stage = 'full-suite', fin = 120]) => ({ name, stage, status, created_at: T0, started_at: at(5), finished_at: status === 'running' ? null : at(fin) })), ...extra });
const ghRun = (workflow, conclusion, status = 'completed') => ({ workflow, conclusion, status, created_at: T0 });
/** A commit on which both hosts agree: every mapped workflow green on GitHub, every mapped job green on GitLab. */
const agreeing = (n) => ({
  sha: `sha${n}`, subject: `VTID-0${n} (x/y): change ${n}`,
  github: { runs: [ghRun('UNIT-TESTS.yml', 'success'), ghRun('i18n-check.yml', 'success'), ghRun('AWS-STAGE-DEPLOY-FRONTEND.yml', 'success'), ghRun('STAGING-VERIFY.yml', 'success'), ghRun('DEPLOY.yml', 'skipped')], stagingServed: true },
  gitlab: { pipeline: gl(n, [['full-suite:vitest', 'success', 'full-suite', 40], ['full-suite:vitest-union', 'success'], ['full-suite:i18n-check', 'success'], ['deploy-staging:community-app', 'success', 'deploy', 200], ['staging-verify:community-app', 'success', 'verify', 280]]) },
});
const report = (commits, extra = {}) => parity.buildReport({ repository: 'vitana-v1', map: MAP, commits, minShadow: 3, now: '2026-11-10T10:00:00Z', ...extra });
const kinds = (r) => r.differences.map((d) => `${d.kind}:${d.workflow ?? '-'}:${d.explained ? 'explained' : 'UNEXPLAINED'}`).sort();

test('map: reads the shape of config/delivery/services.json, a plain object, and refuses a document that has no map for the repository', () => {
  assert.deepEqual(parity.mapFrom({ repositories: { 'vitana-v1': { github_workflows: MAP } } }, 'vitana-v1'), MAP);
  assert.deepEqual(parity.mapFrom({ workflows: MAP }, 'vitana-v1'), MAP);
  assert.deepEqual(parity.mapFrom(MAP, 'vitana-v1'), MAP);
  assert.throws(() => parity.mapFrom({ repositories: { 'vitana-platform': {} } }, 'vitana-v1'), /no workflow map for vitana-v1/);
});

test('pairing: a GitHub workflow is compared with the jobs of its map entry in the GitLab pipeline of the same SHA; a full-suite: prefix and a :service suffix belong to the job', () => {
  assert.equal(parity.jobKey('full-suite:vitest'), 'vitest');
  const p = gl(1, [['full-suite:vitest', 'success'], ['vitest-union', 'success'], ['deploy-staging:gateway', 'failed', 'deploy'], ['deploy-staging-preview', 'success']]);
  assert.deepEqual(parity.gitlabResult(p, ['vitest', 'vitest-union']), { result: 'success', jobs: ['full-suite:vitest=success', 'vitest-union=success'] });
  assert.equal(parity.gitlabResult(p, ['deploy-staging']).result, 'failure', 'deploy-staging:gateway is a job of deploy-staging, deploy-staging-preview is not');
  assert.equal(parity.gitlabResult(p, ['nothing']).result, 'missing');
  assert.equal(parity.gitlabResult(gl(2, [['a', 'skipped']]), ['a']).result, 'skipped');
  assert.equal(parity.gitlabResult(gl(3, [['a', 'running']]), ['a']).result, 'pending');
  assert.equal(parity.gitlabResult(gl(4, [['a', 'success'], ['a:b', 'skipped']]), ['a']).result, 'success');
  assert.equal(parity.githubResult({ status: 'completed', conclusion: 'timed_out' }), 'failure');
  assert.equal(parity.githubResult({ status: 'in_progress', conclusion: null }), 'pending');
  assert.equal(parity.githubResult({ status: 'completed', conclusion: 'cancelled' }), 'cancelled');
});

test('report: commits on which both hosts agree are compared, match, and make the checklist items true (10 commits, no unexplained difference)', () => {
  const r = report([1, 2, 3, 4].map(agreeing));
  assert.equal(r.schema, 'vitana.parity-report/v1');
  assert.deepEqual([r.summary.shadow_commits, r.summary.compared, r.summary.unexplained, r.summary.not_comparable], [4, 4, 0, 0]);
  assert.deepEqual(r.differences, []);
  assert.deepEqual(r.commits.map((c) => [c.sha, c.state, c.comparisons, c.matches]), [['sha1', 'compared', 4, 4], ['sha2', 'compared', 4, 4], ['sha3', 'compared', 4, 4], ['sha4', 'compared', 4, 4]], 'the kept workflow is not compared');
  assert.equal(r.summary.ready.commits, true);
  assert.equal(r.summary.ready.parity, true);
  assert.equal(r.summary.targets.first_result.samples, 4);
});

test('report: every unexplained difference is listed with its SHA, workflow, jobs, both results and a reason', () => {
  const a = agreeing(1);
  a.gitlab.pipeline.jobs.find((j) => j.name === 'full-suite:vitest').status = 'failed';                 // GitHub green, GitLab red
  const b = agreeing(2);
  b.github.runs.find((x) => x.workflow === 'i18n-check.yml').conclusion = 'failure';                    // GitHub red, GitLab green
  const c = agreeing(3);
  c.gitlab.pipeline.jobs = c.gitlab.pipeline.jobs.filter((j) => !j.name.includes('i18n-check'));        // GitLab has no job
  const d = agreeing(4);
  d.gitlab.pipeline.jobs.find((j) => j.name === 'full-suite:i18n-check').status = 'skipped';            // GitLab skipped what GitHub ran
  const r = report([a, b, c, d]);
  assert.deepEqual(kinds(r), [
    'github_failed_gitlab_passed:i18n-check.yml:UNEXPLAINED', 'gitlab_failed_github_passed:UNIT-TESTS.yml:UNEXPLAINED', 'gitlab_skipped_github_ran:i18n-check.yml:UNEXPLAINED', 'no_gitlab_job:i18n-check.yml:UNEXPLAINED',
  ]);
  assert.equal(r.summary.unexplained, 4);
  assert.equal(r.summary.ready.parity, false);
  assert.equal(r.summary.ready.all, false);
  const one = r.differences.find((x) => x.kind === 'gitlab_failed_github_passed');
  assert.deepEqual([one.sha, one.github, one.gitlab, one.jobs], ['sha1', 'success', 'failure', ['full-suite:vitest=failed', 'full-suite:vitest-union=success']]);
  assert.match(one.reason, /GitLab failed what GitHub passed/);
});

test('report: a difference with a reason is explained: GitHub cancelled or skipped the workflow, or both hosts are red; none of them counts against the cut', () => {
  const a = agreeing(1);
  a.github.runs.find((x) => x.workflow === 'UNIT-TESTS.yml').conclusion = 'cancelled';
  const b = agreeing(2);
  b.github.runs.find((x) => x.workflow === 'UNIT-TESTS.yml').conclusion = 'failure';
  b.gitlab.pipeline.jobs.find((j) => j.name === 'full-suite:vitest').status = 'failed';
  const r = report([a, b, agreeing(3)]);
  assert.deepEqual(kinds(r), ['both_failed:UNIT-TESTS.yml:explained', 'github_did_not_run:UNIT-TESTS.yml:explained']);
  assert.equal(r.summary.unexplained, 0);
  assert.equal(r.summary.explained, 2);
  assert.equal(r.summary.ready.parity, true);
});

test('report: a commit staging never served is not comparable for the deploy and verification workflows (counted on its own), and its other workflows still count', () => {
  const a = agreeing(1);
  a.github.stagingServed = false;
  a.github.runs = a.github.runs.filter((x) => !/STAGE-DEPLOY|STAGING-VERIFY/.test(x.workflow));
  const b = agreeing(2);
  b.github.stagingServed = false;                                  // the runs exist, but staging never served this commit (superseded)
  b.github.runs.find((x) => x.workflow === 'STAGING-VERIFY.yml').conclusion = 'failure';
  b.gitlab.pipeline.jobs.find((j) => j.name === 'staging-verify:community-app').status = 'success';
  const onlyDeploy = { sha: 'sha3', github: { runs: [ghRun('STAGING-VERIFY.yml', 'success')], stagingServed: false }, gitlab: { pipeline: gl(3, [['staging-verify:gateway', 'success', 'verify']]) } };
  const r = report([a, b, onlyDeploy, agreeing(4)]);
  assert.deepEqual(r.differences, [], 'no difference is raised for a commit staging never served');
  assert.deepEqual(r.commits.map((c) => [c.sha, c.state, c.not_comparable]), [['sha1', 'compared', 0], ['sha2', 'compared', 2], ['sha3', 'not_comparable', 1], ['sha4', 'compared', 0]]);
  assert.equal(r.summary.not_comparable, 1);
  assert.equal(r.summary.compared, 3);
  assert.equal(r.summary.shadow_commits, 4);
  assert.equal(r.summary.staging_not_served, 3, 'three of the four commits were never served by staging');
  assert.deepEqual(r.commits.map((c) => c.staging_served), [false, false, false, true]);
});

test('report: the staging fates are t2 and t3: a commit staging never served is not comparable for the deploy workflows of both', () => {
  const MAP3 = { ...MAP, 'AWS-STAGE-DEPLOY-GATEWAY.yml': { fate: 't3', path_filter: false, jobs: ['deploy-staging'] } };
  const c = agreeing(1);
  c.github.stagingServed = false;
  c.github.runs.push(ghRun('AWS-STAGE-DEPLOY-GATEWAY.yml', 'failure'));   // would be "GitHub failed what GitLab passed" if it were compared
  const r = report([c, agreeing(2), agreeing(3)], { map: MAP3 });
  assert.deepEqual(r.differences, []);
  assert.equal(r.commits[0].not_comparable, 3, 'the t3 deploy, the t2 deploy and the t2 verification');
  assert.equal(r.commits[0].matches, 2, 'the two t1 workflows still match');
});

test('report: the default minimum is ten shadow commits', () => {
  const nine = Array.from({ length: 9 }, (_, i) => agreeing(i + 1));
  const base = { repository: 'vitana-v1', map: MAP, now: '2026-11-10T10:00:00Z' };
  const r9 = parity.buildReport({ ...base, commits: nine });
  assert.equal(r9.summary.min_shadow, 10);
  assert.equal(r9.summary.ready.commits, false, 'nine commits are not enough');
  assert.equal(parity.buildReport({ ...base, commits: [...nine, agreeing(10)] }).summary.ready.commits, true);
});

test('report: a commit older than the first GitLab pipeline is before the shadow period; a newer commit with no pipeline is an unexplained gap; a running pipeline is in progress', () => {
  const noPipe = (n) => ({ sha: `sha${n}`, github: { runs: [ghRun('UNIT-TESTS.yml', 'success')], stagingServed: true }, gitlab: { pipeline: null } });
  const running = agreeing(3);
  running.gitlab.pipeline.jobs.find((j) => j.name === 'staging-verify:community-app').status = 'running';
  const r = report([running, noPipe(2), agreeing(1), noPipe(0)]);   // newest first
  assert.deepEqual(r.commits.map((c) => [c.sha, c.state]), [['sha3', 'in_progress'], ['sha2', 'no_gitlab_pipeline'], ['sha1', 'compared'], ['sha0', 'before_shadow']]);
  assert.deepEqual(kinds(r), ['no_gitlab_pipeline:-:UNEXPLAINED']);
  assert.deepEqual([r.summary.shadow_commits, r.summary.before_shadow, r.summary.in_progress, r.summary.unexplained], [1, 1, 1, 1]);
  const ghPending = agreeing(5);
  ghPending.github.runs[0] = ghRun('UNIT-TESTS.yml', null, 'in_progress');
  assert.equal(report([ghPending, agreeing(4)]).commits[0].state, 'in_progress');
});

test('report: the latest run of a workflow counts when GitHub re-ran it', () => {
  const a = agreeing(1);
  a.github.runs.unshift({ workflow: 'UNIT-TESTS.yml', conclusion: 'failure', status: 'completed', created_at: '2026-11-10T07:00:00Z' });
  assert.deepEqual(report([a]).differences, [], 'the failed first attempt is superseded by the green re-run');
});

test('report: the checklist verdict needs enough shadow commits, no unexplained difference and the §5 targets for first result and required checks', () => {
  const many = [1, 2, 3].map(agreeing);
  assert.equal(report(many).summary.ready.all, true);
  assert.equal(report(many.slice(0, 2)).summary.ready.commits, false, 'two commits are fewer than the minimum of three');
  assert.equal(report(many.slice(0, 2)).summary.ready.all, false);
  const slow = [1, 2, 3].map((n) => { const c = agreeing(n); c.gitlab.pipeline.jobs.forEach((j) => { if (j.stage === 'full-suite') j.finished_at = at(700); }); return c; });
  const r = report(slow);
  assert.equal(r.summary.targets.required_checks.met, false, 'the checks took longer than 10 minutes');
  assert.equal(r.summary.ready.targets, false);
  assert.equal(r.summary.ready.all, false);
  const noTiming = report([{ sha: 'x', github: { runs: [], stagingServed: true }, gitlab: { pipeline: gl(9, [['full-suite:a', 'skipped']]) } }]);
  assert.equal(noTiming.summary.ready.targets, null, 'no timing sample, no verdict');
});

// ── end to end on fake GitHub and fake GitLab ──────────────────────────────────────────────────────────────────────────────────
const GH_TOKEN = ['github', 'pat', '11PARITYAAAAAAAAAAAA'].join('_');
const GL_TOKEN = ['glp', 'at-parityAAAAAAAAAAAAA'].join('');
function world({ servedAll = true, breakSha = null } = {}) {
  const f = fakeFetch();
  const shas = ['aaa111', 'bbb222', 'ccc333'];
  f.route('GET', '/repos/exafyltd/vitana-v1/commits', (call) => { assert.equal(call.query.sha[0], 'main'); return { json: shas.map((sha, i) => ({ sha, commit: { message: `VTID-0${i} (x/y): change\n\nbody` } })) }; });
  f.route('GET', '/repos/exafyltd/vitana-v1/actions/runs', (call) => {
    const sha = call.query.head_sha[0];
    const runs = [{ path: '.github/workflows/UNIT-TESTS.yml', conclusion: 'success', status: 'completed', created_at: T0 }, { path: '.github/workflows/DEPLOY.yml', conclusion: 'skipped', status: 'completed', created_at: T0 }];
    if (servedAll || sha !== 'bbb222') runs.push({ path: '.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml', conclusion: 'success', status: 'completed', created_at: T0 });
    return { json: { workflow_runs: runs } };
  });
  f.route('GET', '/api/v4/projects/vitana%2Fvitana-v1/pipelines', (call) => ({ json: [{ id: { aaa111: 11, bbb222: 12, ccc333: 13 }[call.query.sha[0]] }] }));
  for (const [id, sha] of [[11, 'aaa111'], [12, 'bbb222'], [13, 'ccc333']]) {
    f.route('GET', `/api/v4/projects/vitana%2Fvitana-v1/pipelines/${id}`, { json: { id, sha, status: 'success', created_at: T0, finished_at: at(300) } });
    f.route('GET', `/api/v4/projects/vitana%2Fvitana-v1/pipelines/${id}/jobs`, { json: [{ name: 'full-suite:vitest', stage: 'full-suite', status: sha === breakSha ? 'failed' : 'success', created_at: T0, started_at: at(4), finished_at: at(40) }, { name: 'full-suite:vitest-union', stage: 'full-suite', status: 'success', created_at: T0, started_at: at(4), finished_at: at(110) }, { name: 'deploy-staging:community-app', stage: 'deploy', status: 'success', created_at: T0, started_at: at(120), finished_at: at(200) }] });
  }
  return f;
}
const FILES = { '/map.json': JSON.stringify({ repositories: { 'vitana-v1': { github_workflows: MAP } } }), '/gh': `${GH_TOKEN}\n`, '/gl': `${GL_TOKEN}\n` };
async function cli(argv, f, files = FILES) {
  const out = [];
  const written = {};
  const code = await parity.main(argv, { stdout: (t) => out.push(t), readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; }, writeFile: (p, t) => { written[p] = t; }, fetch: f, sleep: async () => {}, now: '2026-11-10T10:00:00Z' });
  return { code, out: out.join(''), written };
}
const ARGS = ['--repo', 'vitana-v1', '--limit', '3', '--min-shadow', '3', '--map', '/map.json', '--github-token-file', '/gh', '--gitlab-token-file', '/gl', '--gitlab-url', 'https://gitlab.test'];

test('cli: reads GitHub and GitLab with GET only, pairs the three commits by SHA, treats the commit staging did not serve as not comparable, and prints the report', async () => {
  const f = world({ servedAll: false });
  const r = await cli(ARGS, f);
  assert.equal(r.code, 0, r.out);
  const doc = JSON.parse(r.out);
  assert.equal(doc.repository, 'vitana-v1');
  assert.deepEqual(doc.commits.map((c) => [c.sha, c.subject.slice(0, 9), c.state]), [['aaa111', 'VTID-00 (', 'compared'], ['bbb222', 'VTID-01 (', 'compared'], ['ccc333', 'VTID-02 (', 'compared']]);
  assert.deepEqual(doc.commits.map((c) => c.staging_served), [true, false, true], 'bbb222 has no successful staging deploy on GitHub: staging never served it');
  assert.equal(doc.summary.staging_not_served, 1);
  assert.deepEqual(doc.differences, [], 'no difference is raised for the deploy and verification of a commit staging never served');
  assert.equal(doc.summary.unexplained, 0);
  assert.equal(doc.summary.ready.all, true);
  assert.deepEqual(f.writes(), [], 'read only');
  assert.equal(f.calls.every((c) => c.method === 'GET'), true);
  assert.equal(f.calls.filter((c) => c.path.startsWith('/repos/')).every((c) => c.headers.authorization === `Bearer ${GH_TOKEN}`), true);
  assert.equal(f.calls.filter((c) => c.path.startsWith('/api/v4/')).every((c) => c.headers['private-token'] === GL_TOKEN), true);
  for (const s of [GH_TOKEN, GL_TOKEN]) assert.equal(r.out.includes(s), false, 'no token in the output');
});

test('cli: --gate exits 3 when the report is not ready and 0 when it is; --out writes the report to a file and prints nothing', async () => {
  const bad = await cli([...ARGS, '--gate'], world({ breakSha: 'ccc333' }));
  assert.equal(bad.code, 3);
  assert.equal(JSON.parse(bad.out).summary.unexplained, 1);
  assert.equal(JSON.parse(bad.out).differences[0].sha, 'ccc333');
  const good = await cli([...ARGS, '--gate'], world());
  assert.equal(good.code, 0);
  const file = await cli([...ARGS, '--out', '/report.json'], world());
  assert.equal(file.out, '');
  assert.equal(JSON.parse(file.written['/report.json']).schema, 'vitana.parity-report/v1');
});

test('cli: a GitHub or GitLab that refuses a token, a missing file and a map without the repository are exit 1 and the tokens are not printed; usage mistakes are exit 2', async () => {
  const f = fakeFetch();
  f.route('GET', /.*/, { status: 401, json: { message: `Bad credentials ${GH_TOKEN} ${GL_TOKEN}` } });
  const refused = await cli(ARGS, f);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /401/);
  for (const s of [GH_TOKEN, GL_TOKEN]) assert.equal(refused.out.includes(s), false);
  assert.equal((await cli(ARGS, world(), { ...FILES, '/map.json': JSON.stringify({ repositories: {} }) })).code, 1);
  assert.equal((await cli(ARGS.map((a) => (a === '/gh' ? '/missing' : a)), world())).code, 1);
  for (const argv of [[], ['--repo', 'nope'], ['--repo', 'vitana-v1', '--limit'], ['--repo', 'vitana-v1', '--limit', 'x'], ['--repo', 'vitana-v1', '--wat']]) {
    const r = await cli(argv, world());
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.out, /usage: parity-report\.mjs/);
  }
  assert.equal((await cli(['--help'], world())).code, 0);
});
