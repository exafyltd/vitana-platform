// Tests of the CI metrics job (plan eng-gitlab-m2 §3.6, lane monitoring).
//
// scripts/eng/ci-metrics.mjs runs once a minute on the GitLab host. It reads the job queue from GitLab with the read-only
// account bot-metrics, reads when the merge bot and the settings sync last completed a tick (systemd), reads how old the newest
// backup is (S3), and publishes all of it to CloudWatch in one call. What the alarms of monitoring.tf can trust is pinned here:
//   - a GitLab read that fails publishes the failure metric and NEVER a queue number (no zeros),
//   - the oldest pending age and the counts are right over several pages and several projects,
//   - a failed or still running tick does not reset the age of the last good tick,
//   - the token is in no log line, error, state file or command line.
// No network, no AWS, no systemd and no real clock: fetch, exec, now and the uptime are injected. The metric names, the unit
// names and the namespace are written out here on purpose, so that renaming one in the module or in monitoring.tf fails a case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from './gitlab-api.mjs';
import { fakeFetch } from './testing/fake-fetch.mjs';
import * as M from './ci-metrics.mjs';

// A made-up value with the shape of a GitLab token, so that the redaction by shape can be tested; assembled here so that no token-shaped literal is in the file.
const TOKEN = ['glpat', 'ABCDEFGHIJKLMNOPQRSTUV'].join('-');
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const UPTIME = 100_000; // seconds since boot
const REGION = 'eu-central-1';
const BUCKET = 'vitana-engineering-gitlab-backups-123456789012';
const API = '/api/v4';
const SCOPES = ['pending', 'preparing', 'running'];

const iso = (secondsFromNow) => new Date(NOW + secondsFromNow * 1000).toISOString();

// ------------------------------------------------------------------ GitLab fakes
let nextJobId = 1000;
function job(over = {}) {
  return {
    id: nextJobId++, name: 'unit', stage: 'test', status: 'pending', created_at: iso(-60), started_at: null, finished_at: null,
    tag_list: ['vitana-eng'], pipeline: { id: 50, project_id: 1, ref: 'main', sha: 'a'.repeat(40), status: 'pending' }, runner: null, ...over,
  };
}

/** Registers `items` on `path` as pages of `size`, linked with X-Next-Page the way GitLab does. */
function paged(fetch, routePath, items, size, extraQuery = {}) {
  const pages = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  if (pages.length === 0) pages.push([]);
  pages.forEach((page, i) => {
    const headers = i + 1 < pages.length ? { 'x-next-page': String(i + 2) } : {};
    fetch.route('GET', routePath, { json: page, headers }, { query: { ...extraQuery, page: String(i + 1) } });
  });
}

const PROJECT = (id) => ({ id, path_with_namespace: `vitana/project-${id}` });

/** A GitLab with the given projects, each with its running/pending jobs, and pipelines with their jobs. */
function gitlab(fetch, { projects = [PROJECT(1)], jobs = {}, pipelines = {}, pageSize = 100 } = {}) {
  paged(fetch, `${API}/projects`, projects, pageSize, { membership: 'true' });
  for (const p of projects) paged(fetch, `${API}/projects/${p.id}/jobs`, jobs[p.id] ?? [], pageSize);
  for (const [key, list] of Object.entries(pipelines)) {
    const [projectId, pipelineId] = key.split('/');
    paged(fetch, `${API}/projects/${projectId}/pipelines/${pipelineId}/jobs`, list, pageSize);
  }
  return fetch;
}

const clientFor = (fetch) => createClient({ baseUrl: 'http://127.0.0.1', token: TOKEN, fetch, sleep: async () => {}, retries: 0 });

// ------------------------------------------------------------------ exec fake (systemctl, aws)
const unitDone = (secondsAgo) => ({ ActiveState: 'inactive', Result: 'success', InactiveEnterTimestampMonotonic: String((UPTIME - secondsAgo) * 1e6) });
const unitFailed = (secondsAgo) => ({ ActiveState: 'failed', Result: 'exit-code', InactiveEnterTimestampMonotonic: String((UPTIME - secondsAgo) * 1e6) });
// while a oneshot runs again, systemd shows Result=success (reset at the start) and keeps the END of the run before it, which may have failed
const unitRunning = (previousEndSecondsAgo = 3000) => ({ ActiveState: 'activating', Result: 'success', InactiveEnterTimestampMonotonic: String((UPTIME - previousEndSecondsAgo) * 1e6) });
const unitInactiveNotSuccess = (secondsAgo) => ({ ActiveState: 'inactive', Result: 'exit-code', InactiveEnterTimestampMonotonic: String((UPTIME - secondsAgo) * 1e6) });
const unitNeverRan = () => ({ ActiveState: 'inactive', Result: 'success', InactiveEnterTimestampMonotonic: '0' });

function fakeExec({ units = {}, backup = null, backupError, putError, systemctlError } = {}) {
  const calls = [];
  async function exec(file, args) {
    calls.push({ file, args: [...args] });
    if (file === 'systemctl') {
      if (systemctlError) throw Object.assign(new Error('Failed to connect to bus'), { code: 1 });
      const unit = String(args[1]).replace(/\.service$/, '');
      const u = units[unit] ?? unitNeverRan();
      return { stdout: `${Object.entries(u).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, stderr: '' };
    }
    if (file === 'aws' && args[0] === 's3api') {
      if (backupError) throw backupError;
      return { stdout: `${JSON.stringify(backup)}\n`, stderr: '' };
    }
    if (file === 'aws' && args[0] === 'cloudwatch') {
      if (putError) throw putError;
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  }
  exec.calls = calls;
  exec.puts = () => calls.filter((c) => c.file === 'aws' && c.args[0] === 'cloudwatch');
  return exec;
}

// ------------------------------------------------------------------ harness for run() and main()
function harness({ token = TOKEN, execOptions, state } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-metrics-'));
  const tokenFile = path.join(dir, 'bot-metrics-token');
  if (token !== null) writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const stateDir = path.join(dir, 'state');
  if (state) { mkdirSync(stateDir, { recursive: true }); writeFileSync(path.join(stateDir, 'ticks.json'), typeof state === 'string' ? state : JSON.stringify(state)); }
  const fetch = fakeFetch();
  const exec = fakeExec(execOptions);
  const out = [];
  const errs = [];
  const deps = { fetch, exec, now: () => NOW, readUptime: async () => UPTIME, sleep: async () => {}, stdout: (s) => out.push(String(s)), stderr: (s) => errs.push(String(s)) };
  const options = { url: 'http://127.0.0.1', tokenFile, stateDir, region: REGION, bucket: BUCKET, dryRun: false, gitlabDeadlineMs: 5000, requestTimeoutMs: 2000 };
  const stateFile = path.join(stateDir, 'ticks.json');
  return {
    dir, tokenFile, stateDir, stateFile, fetch, exec, out, errs, deps, options,
    logs: () => out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    savedState: () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null),
    everything: () => [out.join(''), errs.join(''), JSON.stringify(exec.calls), existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''].join('\n'),
  };
}

/** The one put-metric-data call of a run: { args, data }. */
function published(h) {
  const puts = h.exec.puts();
  assert.equal(puts.length, 1, `exactly one put-metric-data call, got ${puts.length}`);
  const args = puts[0].args;
  return { args, data: JSON.parse(args[args.indexOf('--metric-data') + 1]) };
}
const find = (data, name, unit) => data.find((d) => d.MetricName === name && (unit === undefined ? !d.Dimensions : d.Dimensions?.some((x) => x.Name === 'Unit' && x.Value === unit)));
const valueOf = (data, name, unit) => find(data, name, unit)?.Value;
const names = (data) => data.map((d) => d.MetricName);

// ================================================================== names that other files depend on
test('the namespace, metric names, unit names and fleet tag are the ones the alarms and the plan use', () => {
  assert.equal(M.NAMESPACE, 'Vitana/Engineering');
  assert.deepEqual({ ...M.METRIC }, {
    pendingJobs: 'PendingJobs',
    oldestPendingJobAge: 'OldestPendingJobAgeSeconds',
    runningJobs: 'RunningJobs',
    fleetRunningJobs: 'FleetRunningJobs',
    gitlabReadFailed: 'GitLabReadFailed',
    tickAge: 'TickAgeSeconds',
    backupAge: 'BackupAgeSeconds',
  });
  // plan §3.4 (the merge bot) and §3.3 (the settings sync); plan §3.2 (the tag of the fleet runner)
  assert.deepEqual([...M.TICK_UNITS], ['vitana-land', 'vitana-settings']);
  assert.equal(M.FLEET_TAG, 'vitana-eng');
  assert.equal(M.BACKUP_PREFIX, 'backups/');
});

// ================================================================== queue: counts and ages
test('collectQueue: counts and the oldest pending age are right over three pages of jobs', async () => {
  const fetch = fakeFetch();
  const jobs = [
    job({ id: 1, created_at: iso(-30) }),
    job({ id: 2, created_at: iso(-600) }), // the oldest: exactly 10 minutes
    job({ id: 3, created_at: iso(-120) }),
    job({ id: 4, status: 'running', started_at: iso(-50), tag_list: ['vitana-eng'] }),
    job({ id: 5, status: 'running', started_at: iso(-50), tag_list: ['docker'] }),
    job({ id: 6, created_at: iso(-5) }),
    job({ id: 7, status: 'preparing', tag_list: ['vitana-eng'] }),
    job({ id: 8, created_at: iso(-61) }),
  ];
  gitlab(fetch, { jobs: { 1: jobs }, pageSize: 3 }); // 8 jobs, 3 pages
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.equal(q.pendingJobs, 5);
  assert.equal(q.oldestPendingJobAgeSeconds, 600);
  assert.equal(q.runningJobs, 3, 'running and preparing');
  assert.equal(q.fleetRunningJobs, 2, 'only running/preparing jobs that carry the fleet tag vitana-eng');
  const jobCalls = fetch.calls.filter((c) => c.path === `${API}/projects/1/jobs`);
  assert.deepEqual(jobCalls.map((c) => c.query.page[0]), ['1', '2', '3'], 'one request per page, none after the last');
  assert.deepEqual(jobCalls[0].query['scope[]'], SCOPES, 'pending, preparing and running in one list');
  assert.deepEqual(jobCalls[0].query.per_page, ['100']);
});

test('collectQueue: the numbers of all projects add up and the oldest job of all projects wins', async () => {
  const fetch = fakeFetch();
  gitlab(fetch, {
    projects: [PROJECT(1), PROJECT(2), PROJECT(3)],
    jobs: {
      1: [job({ created_at: iso(-100) }), job({ status: 'running', tag_list: ['vitana-eng'] })],
      2: [job({ created_at: iso(-900) }), job({ created_at: iso(-10) })],
      3: [job({ status: 'running', tag_list: ['vitana-eng'] }), job({ status: 'running', tag_list: ['vitana-legacy'] })],
    },
  });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.deepEqual([q.pendingJobs, q.oldestPendingJobAgeSeconds, q.runningJobs, q.fleetRunningJobs], [3, 900, 3, 2]);
});

test('collectQueue: the project list is read page by page, only the projects the account belongs to, not archived ones', async () => {
  const fetch = fakeFetch();
  const projects = [1, 2, 3, 4, 5].map(PROJECT);
  gitlab(fetch, { projects, jobs: { 1: [job({ created_at: iso(-10) })], 5: [job({ created_at: iso(-20) })] }, pageSize: 2 });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.equal(q.pendingJobs, 2);
  const listCalls = fetch.calls.filter((c) => c.path === `${API}/projects`);
  assert.deepEqual(listCalls.map((c) => c.query.page[0]), ['1', '2', '3']);
  assert.deepEqual(listCalls[0].query.membership, ['true']);
  assert.deepEqual(listCalls[0].query.archived, ['false']);
  for (const p of projects) assert.ok(fetch.calls.some((c) => c.path === `${API}/projects/${p.id}/jobs`), `project ${p.id} was read`);
});

test('collectQueue: an empty queue is a real zero, read from GitLab', async () => {
  const fetch = fakeFetch();
  gitlab(fetch, { jobs: { 1: [] } });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.deepEqual([q.pendingJobs, q.oldestPendingJobAgeSeconds, q.runningJobs, q.fleetRunningJobs], [0, 0, 0, 0]);
});

test('collectQueue: only GET requests are made (the account is read only)', async () => {
  const fetch = fakeFetch();
  gitlab(fetch, { jobs: { 1: [job({ pipeline: { id: 9, project_id: 1, status: 'running' } })] }, pipelines: { '1/9': [] } });
  await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.ok(fetch.calls.length >= 3);
  fetch.assertNoWrites();
  for (const c of fetch.calls) assert.equal(c.method, 'GET');
});

test('collectQueue: a job of a pipeline that has not started counts from its own creation', async () => {
  const fetch = fakeFetch();
  gitlab(fetch, { jobs: { 1: [job({ created_at: iso(-700), pipeline: { id: 11, project_id: 1, status: 'pending' } })] } });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.equal(q.oldestPendingJobAgeSeconds, 700);
  assert.equal(fetch.calls.some((c) => /\/pipelines\//.test(c.path)), false, 'no pipeline lookup for a pipeline that has not started');
});

test('collectQueue: a job of a running pipeline waits from the last finish in its pipeline, not from the creation of the whole pipeline', async () => {
  // GitLab creates every job when the pipeline is created; created_at of a job in a later stage is 40 minutes old, but it only
  // became pending when the stage before it finished 2 minutes ago. Counting from created_at would raise the alarm for a healthy
  // pipeline whose first stage takes long.
  const fetch = fakeFetch();
  const pipeline = { id: 7, project_id: 1, ref: 'main', status: 'running' };
  const waiting = job({ id: 10, created_at: iso(-2400), stage: 'test', pipeline });
  const done = job({ id: 9, status: 'success', stage: 'build', created_at: iso(-2400), started_at: iso(-2300), finished_at: iso(-120), pipeline });
  const older = job({ id: 8, status: 'success', stage: 'lint', created_at: iso(-2400), started_at: iso(-2390), finished_at: iso(-1800), pipeline });
  gitlab(fetch, { jobs: { 1: [waiting] }, pipelines: { '1/7': [waiting, done, older] } });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.equal(q.pendingJobs, 1);
  assert.equal(q.oldestPendingJobAgeSeconds, 120, 'from the newest finish (120 s ago), not from created_at (2400 s ago)');
});

test('collectQueue: a pending job in a running pipeline where nothing has finished yet counts from its creation', async () => {
  const fetch = fakeFetch();
  const pipeline = { id: 8, project_id: 1, status: 'running' };
  const waiting = job({ created_at: iso(-650), pipeline });
  const busy = job({ status: 'running', started_at: iso(-600), pipeline });
  gitlab(fetch, { jobs: { 1: [waiting, busy] }, pipelines: { '1/8': [waiting, busy] } });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.equal(q.oldestPendingJobAgeSeconds, 650);
});

test('collectQueue: a pipeline is looked up once however many of its jobs are pending', async () => {
  const fetch = fakeFetch();
  const pipeline = { id: 21, project_id: 1, status: 'running' };
  const a = job({ created_at: iso(-500), pipeline });
  const b = job({ created_at: iso(-500), pipeline });
  const c = job({ created_at: iso(-500), pipeline });
  const done = job({ status: 'success', finished_at: iso(-90), pipeline });
  gitlab(fetch, { jobs: { 1: [a, b, c] }, pipelines: { '1/21': [a, b, c, done] } });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.equal(q.pendingJobs, 3);
  assert.equal(q.oldestPendingJobAgeSeconds, 90);
  assert.equal(fetch.calls.filter((x) => x.path === `${API}/projects/1/pipelines/21/jobs`).length, 1);
});

test('collectQueue: past the lookup cap the jobs are still counted, only their age is left out, and it is logged', async () => {
  const fetch = fakeFetch();
  const p1 = { id: 31, project_id: 1, status: 'running' };
  const p2 = { id: 32, project_id: 1, status: 'running' };
  const j1 = job({ created_at: iso(-3000), pipeline: p1 });
  const j2 = job({ created_at: iso(-3000), pipeline: p2 });
  gitlab(fetch, { jobs: { 1: [j1, j2] }, pipelines: { '1/31': [j1, job({ status: 'success', finished_at: iso(-45), pipeline: p1 })], '1/32': [j2, job({ status: 'success', finished_at: iso(-30), pipeline: p2 })] } });
  const events = [];
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW, maxPipelineLookups: 1, log: (e) => events.push(e) });
  assert.equal(q.pendingJobs, 2, 'both jobs counted');
  assert.equal(q.oldestPendingJobAgeSeconds, 45, 'only the pipeline that was looked up is aged');
  assert.equal(fetch.calls.filter((x) => /\/pipelines\/\d+\/jobs$/.test(x.path)).length, 1);
  assert.ok(events.some((e) => e.event === 'pipeline_lookup_skipped'), 'the skipped lookup is logged');
});

test('collectQueue: when pending jobs exist but none can be aged the oldest age is null, never 0', async () => {
  const fetch = fakeFetch();
  gitlab(fetch, { jobs: { 1: [job({ created_at: 'not a date' }), job({ created_at: null })] } });
  const events = [];
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW, log: (e) => events.push(e) });
  assert.equal(q.pendingJobs, 2);
  assert.equal(q.oldestPendingJobAgeSeconds, null);
  assert.ok(events.some((e) => e.event === 'job_without_timestamp'));
});

test('collectQueue: a job without tag_list or pipeline is still counted and aged from its creation', async () => {
  const fetch = fakeFetch();
  const bare = { id: 5000, name: 'bare', status: 'pending', created_at: iso(-77) };
  const bareRunning = { id: 5001, name: 'bare2', status: 'running', created_at: iso(-77) };
  gitlab(fetch, { jobs: { 1: [bare, bareRunning] } });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.deepEqual([q.pendingJobs, q.oldestPendingJobAgeSeconds, q.runningJobs, q.fleetRunningJobs], [1, 77, 1, 0]);
});

test('collectQueue: an age is whole seconds, rounded down (never more than the job has waited)', async () => {
  const fetch = fakeFetch();
  gitlab(fetch, { jobs: { 1: [job({ created_at: iso(-600.9) })] } });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.equal(q.oldestPendingJobAgeSeconds, 600);
});

test('collectQueue: under the lookup cap the pipeline of the OLDEST waiting job is the one that is looked up', async () => {
  const fetch = fakeFetch();
  const young = { id: 41, project_id: 1, status: 'running' };
  const old = { id: 42, project_id: 1, status: 'running' };
  const jYoung = job({ created_at: iso(-100), pipeline: young }); // listed first, as GitLab lists the newest first
  const jOld = job({ created_at: iso(-3000), pipeline: old });
  gitlab(fetch, { jobs: { 1: [jYoung, jOld] }, pipelines: { '1/41': [jYoung], '1/42': [jOld, job({ status: 'success', finished_at: iso(-700), pipeline: old })] } });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW, maxPipelineLookups: 1 });
  assert.deepEqual(fetch.calls.filter((c) => /\/pipelines\/\d+\/jobs$/.test(c.path)).map((c) => c.path), [`${API}/projects/1/pipelines/42/jobs`]);
  assert.equal(q.oldestPendingJobAgeSeconds, 700);
});

test('collectQueue: a pipeline that vanished between two requests (404) is skipped and logged; any other error fails the read', async () => {
  const pipeline = { id: 61, project_id: 1, status: 'running' };
  const f1 = fakeFetch();
  gitlab(f1, { jobs: { 1: [job({ created_at: iso(-500), pipeline })] } });
  f1.route('GET', `${API}/projects/1/pipelines/61/jobs`, { status: 404, json: { message: '404 Not found' } });
  const events = [];
  const q = await M.collectQueue({ client: clientFor(f1), now: NOW, log: (e) => events.push(e) });
  assert.deepEqual([q.pendingJobs, q.oldestPendingJobAgeSeconds], [1, null]);
  assert.ok(events.some((e) => e.event === 'pipeline_lookup_skipped' && e.status === 404));
  const f2 = fakeFetch();
  gitlab(f2, { jobs: { 1: [job({ created_at: iso(-500), pipeline })] } });
  f2.route('GET', `${API}/projects/1/pipelines/61/jobs`, { status: 500, json: {} });
  await assert.rejects(M.collectQueue({ client: clientFor(f2), now: NOW }), (e) => e.status === 500);
});

test('collectQueue: a finish time in the future (clock skew) never gives a negative age', async () => {
  const fetch = fakeFetch();
  const pipeline = { id: 71, project_id: 1, status: 'running' };
  const waiting = job({ created_at: iso(-2400), pipeline });
  gitlab(fetch, { jobs: { 1: [waiting] }, pipelines: { '1/71': [waiting, job({ status: 'success', finished_at: iso(+90), pipeline })] } });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.equal(q.oldestPendingJobAgeSeconds, 0);
});

test('collectQueue: a creation time in the future (clock skew) gives age 0, never a negative number', async () => {
  const fetch = fakeFetch();
  gitlab(fetch, { jobs: { 1: [job({ created_at: iso(+90) })] } });
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW });
  assert.equal(q.oldestPendingJobAgeSeconds, 0);
});

// ================================================================== queue: failures
test('collectQueue: a server error on one project fails the whole read (no partial numbers)', async () => {
  const fetch = fakeFetch();
  fetch.route('GET', `${API}/projects`, { json: [PROJECT(1), PROJECT(2)] });
  fetch.route('GET', `${API}/projects/1/jobs`, { json: [job()] });
  fetch.route('GET', `${API}/projects/2/jobs`, { status: 500, json: { message: '500 Internal Server Error' } });
  await assert.rejects(M.collectQueue({ client: clientFor(fetch), now: NOW }), (e) => e.name === 'GitLabApiError' && e.status === 500);
});

test('collectQueue: a project that forbids reading its jobs is skipped and logged; the others are counted', async () => {
  const fetch = fakeFetch();
  fetch.route('GET', `${API}/projects`, { json: [PROJECT(1), PROJECT(2)] });
  fetch.route('GET', `${API}/projects/1/jobs`, { status: 403, json: { message: '403 Forbidden' } });
  fetch.route('GET', `${API}/projects/2/jobs`, { json: [job({ created_at: iso(-42) })] });
  const events = [];
  const q = await M.collectQueue({ client: clientFor(fetch), now: NOW, log: (e) => events.push(e) });
  assert.deepEqual([q.pendingJobs, q.oldestPendingJobAgeSeconds], [1, 42]);
  const skipped = events.find((e) => e.event === 'project_skipped');
  assert.ok(skipped);
  assert.equal(skipped.status, 403);
});

test('collectQueue: when no project can be read at all it is a failure, not an empty queue', async () => {
  const fetch = fakeFetch();
  fetch.route('GET', `${API}/projects`, { json: [PROJECT(1), PROJECT(2)] });
  fetch.route('GET', `${API}/projects/1/jobs`, { status: 403, json: {} });
  fetch.route('GET', `${API}/projects/2/jobs`, { status: 404, json: {} });
  await assert.rejects(M.collectQueue({ client: clientFor(fetch), now: NOW }), (e) => e.code === 'no_readable_project');
});

test('collectQueue: an account that sees no project is a failure, not an empty queue', async () => {
  const fetch = fakeFetch();
  gitlab(fetch, { projects: [] });
  await assert.rejects(M.collectQueue({ client: clientFor(fetch), now: NOW }), (e) => e.code === 'no_projects');
});

// ================================================================== run(): the whole minute
test('a healthy minute: one put-metric-data call with every metric, the failure metric at 0', async () => {
  const h = harness({
    execOptions: {
      units: { 'vitana-land': unitDone(20), 'vitana-settings': unitDone(400) },
      backup: [iso(-3 * 3600), iso(-27 * 3600), iso(-51 * 3600)],
    },
  });
  gitlab(h.fetch, {
    projects: [PROJECT(1), PROJECT(2)],
    jobs: {
      1: [job({ created_at: iso(-125) }), job({ status: 'running', tag_list: ['vitana-eng'] })],
      2: [job({ created_at: iso(-15) })],
    },
  });
  const { exitCode } = await M.run(h.options, h.deps);
  assert.equal(exitCode, 0);
  const { args, data } = published(h);
  assert.deepEqual(args.slice(0, 4), ['cloudwatch', 'put-metric-data', '--namespace', 'Vitana/Engineering']);
  assert.equal(args[args.indexOf('--region') + 1], REGION);
  assert.deepEqual(data.map((d) => [d.MetricName, d.Dimensions?.[0]?.Value ?? null, d.Value, d.Unit]).sort(), [
    ['BackupAgeSeconds', null, 3 * 3600, 'Seconds'],
    ['FleetRunningJobs', null, 1, 'Count'],
    ['GitLabReadFailed', null, 0, 'Count'],
    ['OldestPendingJobAgeSeconds', null, 125, 'Seconds'],
    ['PendingJobs', null, 2, 'Count'],
    ['RunningJobs', null, 1, 'Count'],
    ['TickAgeSeconds', 'vitana-land', 20, 'Seconds'],
    ['TickAgeSeconds', 'vitana-settings', 400, 'Seconds'],
  ].sort());
  const tick = find(data, 'TickAgeSeconds', 'vitana-land');
  assert.deepEqual(tick.Dimensions, [{ Name: 'Unit', Value: 'vitana-land' }]);
  assert.equal(Object.hasOwn(find(data, 'PendingJobs'), 'Dimensions'), false, 'queue metrics have no dimension');
});

test('GitLab answers 500: the failure metric is published, no queue number is, and the host metrics still go out', async () => {
  const h = harness({ execOptions: { units: { 'vitana-land': unitDone(10), 'vitana-settings': unitDone(100) }, backup: [iso(-7200)] } });
  h.fetch.route('GET', `${API}/projects`, { status: 500, json: { message: 'GitLab is not responding' } });
  const { exitCode } = await M.run(h.options, h.deps);
  assert.equal(exitCode, 0, 'the run did its job: it reported the failure');
  const { data } = published(h);
  assert.equal(valueOf(data, 'GitLabReadFailed'), 1);
  for (const n of ['PendingJobs', 'OldestPendingJobAgeSeconds', 'RunningJobs', 'FleetRunningJobs']) {
    assert.equal(find(data, n), undefined, `${n} must not be published when GitLab could not be read (a zero would say the queue is empty)`);
  }
  assert.equal(valueOf(data, 'TickAgeSeconds', 'vitana-land'), 10);
  assert.equal(valueOf(data, 'TickAgeSeconds', 'vitana-settings'), 100);
  assert.equal(valueOf(data, 'BackupAgeSeconds'), 7200);
  assert.ok(h.logs().some((l) => l.event === 'gitlab_read_failed' && l.status === 500));
});

test('a GitLab that answers 503 once and then well is read after a retry, not reported as failed', async () => {
  const h = harness();
  h.fetch.route('GET', `${API}/projects`, [{ status: 503, json: {} }, { json: [PROJECT(1)] }]);
  h.fetch.route('GET', `${API}/projects/1/jobs`, { json: [job({ created_at: iso(-12) })] });
  await M.run(h.options, h.deps);
  const { data } = published(h);
  assert.equal(valueOf(data, 'GitLabReadFailed'), 0);
  assert.equal(valueOf(data, 'PendingJobs'), 1);
  assert.ok(h.logs().some((l) => l.event === 'gitlab_retry' && l.status === 503));
});

test('GitLab is unreachable (connection refused): failure metric, no queue numbers', async () => {
  const h = harness();
  h.fetch.route('GET', `${API}/projects`, { networkError: 'ECONNREFUSED' });
  const { exitCode } = await M.run(h.options, h.deps);
  assert.equal(exitCode, 0);
  const { data } = published(h);
  assert.equal(valueOf(data, 'GitLabReadFailed'), 1);
  assert.equal(names(data).includes('PendingJobs'), false);
});

test('the token is refused (401): failure metric, no queue numbers', async () => {
  const h = harness();
  h.fetch.route('GET', `${API}/projects`, { status: 401, json: { message: '401 Unauthorized' } });
  await M.run(h.options, h.deps);
  const { data } = published(h);
  assert.equal(valueOf(data, 'GitLabReadFailed'), 1);
  assert.equal(names(data).filter((n) => ['PendingJobs', 'OldestPendingJobAgeSeconds', 'RunningJobs', 'FleetRunningJobs'].includes(n)).length, 0);
});

test('a read that fails half-way (second project) publishes the failure metric only, not the numbers of the first project', async () => {
  const h = harness();
  h.fetch.route('GET', `${API}/projects`, { json: [PROJECT(1), PROJECT(2)] });
  h.fetch.route('GET', `${API}/projects/1/jobs`, { json: [job({ created_at: iso(-30) }), job({ created_at: iso(-30) })] });
  h.fetch.route('GET', `${API}/projects/2/jobs`, { status: 502, json: {} });
  await M.run(h.options, h.deps);
  const { data } = published(h);
  assert.equal(valueOf(data, 'GitLabReadFailed'), 1);
  assert.equal(find(data, 'PendingJobs'), undefined);
});

test('the token file is missing: failure metric, GitLab is not asked, nothing else breaks', async () => {
  const h = harness({ token: null, execOptions: { units: { 'vitana-land': unitDone(5), 'vitana-settings': unitDone(5) }, backup: [iso(-60)] } });
  const { exitCode } = await M.run(h.options, h.deps);
  assert.equal(exitCode, 0);
  assert.equal(h.fetch.calls.length, 0);
  const { data } = published(h);
  assert.equal(valueOf(data, 'GitLabReadFailed'), 1);
  assert.equal(names(data).includes('PendingJobs'), false);
  assert.equal(valueOf(data, 'BackupAgeSeconds'), 60);
  assert.ok(h.logs().some((l) => l.event === 'gitlab_read_failed' && l.code === 'token_unreadable'));
});

test('an empty or malformed token file is the same failure, and the file content is never printed', async () => {
  for (const content of ['', '   \n', 'short', 'has a space in it 12345678', 'glpat-ABCDEFGHIJ"KLMNOPQRSTUV']) {
    const h = harness({ token: content });
    await M.run(h.options, h.deps);
    const { data } = published(h);
    assert.equal(valueOf(data, 'GitLabReadFailed'), 1, JSON.stringify(content));
    assert.equal(h.fetch.calls.length, 0);
    assert.ok(h.logs().some((l) => l.event === 'gitlab_read_failed' && l.code === 'token_unreadable'), `${JSON.stringify(content)} is refused by this module with its own code`);
    if (content.trim().length >= 8) assert.equal(h.everything().includes(content.trim()), false, `content ${JSON.stringify(content)} leaked`);
  }
});

test('GitLab hangs: after the deadline the failure metric is published instead of nothing', async () => {
  const h = harness({ execOptions: { units: { 'vitana-land': unitDone(5), 'vitana-settings': unitDone(5) } } });
  h.fetch.route('GET', `${API}/projects`, { hang: true });
  const started = Date.now();
  const { exitCode } = await M.run({ ...h.options, gitlabDeadlineMs: 60, requestTimeoutMs: 600 }, h.deps);
  assert.ok(Date.now() - started < 400, 'did not wait for the request timeout');
  assert.equal(exitCode, 0);
  const { data } = published(h);
  assert.equal(valueOf(data, 'GitLabReadFailed'), 1);
  assert.equal(valueOf(data, 'TickAgeSeconds', 'vitana-land'), 5, 'host metrics were not held back by the hanging GitLab');
  assert.ok(h.logs().some((l) => l.event === 'gitlab_read_failed' && l.code === 'deadline'));
});

test('GitLab hangs: the late failure of the abandoned request is not an unhandled rejection', async () => {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const h = harness();
    h.fetch.route('GET', `${API}/projects`, { hang: true });
    const { exitCode } = await M.run({ ...h.options, gitlabDeadlineMs: 20, requestTimeoutMs: 20 }, h.deps);
    assert.equal(exitCode, 0);
    assert.equal(valueOf(published(h).data, 'GitLabReadFailed'), 1, 'the run reported the hang');
    await new Promise((resolve) => setTimeout(resolve, 200)); // the client times out (three attempts of 20 ms) long after run() returned
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen.map((e) => e?.message), []);
});

test('publishing fails: exit code 1, the error is logged, and nothing is thrown', async () => {
  const h = harness({ execOptions: { putError: Object.assign(new Error('Unable to locate credentials'), { code: 255 }) } });
  gitlab(h.fetch, { jobs: { 1: [] } });
  const { exitCode } = await M.run(h.options, h.deps);
  assert.equal(exitCode, 1);
  assert.ok(h.logs().some((l) => l.event === 'publish_failed' && /credentials/.test(l.message)));
});

test('--dry-run reads, prints the metrics it would publish, and writes nothing: no AWS call, no state file', async () => {
  const h = harness({ execOptions: { units: { 'vitana-land': unitDone(30), 'vitana-settings': unitDone(30) }, backup: [iso(-100)] } });
  gitlab(h.fetch, { jobs: { 1: [job({ created_at: iso(-20) })] } });
  const { exitCode } = await M.run({ ...h.options, dryRun: true }, h.deps);
  assert.equal(exitCode, 0);
  assert.equal(h.exec.puts().length, 0, 'no put-metric-data in a dry run');
  assert.equal(existsSync(h.stateFile), false, 'no state file in a dry run');
  const line = h.logs().find((l) => l.event === 'dry_run');
  assert.ok(line, 'the metrics are printed');
  assert.equal(line.metrics.find((m) => m.MetricName === 'PendingJobs').Value, 1);
});

// ================================================================== run(): the token never leaks
test('the token appears in no log line, error, command line or state file, also when GitLab and AWS echo it back', async () => {
  const h = harness({
    execOptions: {
      units: { 'vitana-land': unitDone(5), 'vitana-settings': unitFailed(5) },
      backupError: new Error(`aws failed for ${TOKEN}`),
      putError: new Error(`put failed: ${TOKEN} and Bearer ${TOKEN}`),
    },
  });
  h.fetch.route('GET', `${API}/projects`, { status: 500, json: { message: `upstream said ${TOKEN}` } });
  const { exitCode } = await M.run(h.options, h.deps);
  assert.equal(exitCode, 1);
  const all = h.everything();
  assert.equal(all.includes(TOKEN), false, 'the token must not be anywhere');
  assert.equal(/glpat-/.test(all), false, 'no GitLab token shape either');
  assert.ok(all.length > 200, 'the run logged something to scan');
});

test('the logger itself removes the exact token, also when it has no GitLab token shape', async () => {
  const plain = 'plain-fixture-value-0123456789abcdef';
  const h = harness({ token: plain, execOptions: { putError: new Error(`put failed with ${plain} in the message`), backupError: new Error(`listing failed with ${plain}`) } });
  gitlab(h.fetch, { jobs: { 1: [] } });
  const { exitCode } = await M.run(h.options, h.deps);
  assert.equal(exitCode, 1);
  const all = h.everything();
  assert.equal(all.includes(plain), false);
  assert.ok(all.includes('[redacted]'), 'and it says that it removed something');
});

test('main: the token is sent to GitLab only in the PRIVATE-TOKEN header', async () => {
  const h = harness();
  gitlab(h.fetch, { jobs: { 1: [] } });
  await M.main(['run', '--url', h.options.url, '--token-file', h.tokenFile, '--state-dir', h.stateDir, '--region', REGION, '--bucket', BUCKET], {}, h.deps);
  assert.ok(h.fetch.calls.length >= 2);
  for (const c of h.fetch.calls) {
    assert.equal(c.headers['private-token'], TOKEN);
    assert.equal(c.url.includes(TOKEN), false);
  }
  assert.equal(h.exec.calls.some((c) => c.args.some((a) => String(a).includes(TOKEN))), false, 'no command line carries the token');
});

// ================================================================== ticks (systemd)
test('collectTicks: the age of a unit that finished well is now minus its finish time (monotonic stamp and uptime)', async () => {
  const exec = fakeExec({ units: { 'vitana-land': unitDone(60), 'vitana-settings': unitDone(540) } });
  const r = await M.collectTicks({ exec, now: NOW, uptimeSeconds: UPTIME, state: {}, units: M.TICK_UNITS, log: () => {} });
  assert.deepEqual(r.ticks, [{ unit: 'vitana-land', ageSeconds: 60 }, { unit: 'vitana-settings', ageSeconds: 540 }]);
  const asked = exec.calls.filter((c) => c.file === 'systemctl');
  assert.deepEqual(asked.map((c) => c.args[1]), ['vitana-land.service', 'vitana-settings.service']);
  assert.deepEqual(asked[0].args, ['show', 'vitana-land.service', '-p', 'ActiveState', '-p', 'Result', '-p', 'InactiveEnterTimestampMonotonic']);
});

test('collectTicks: a run that failed does not count; the age keeps growing from the last good tick', async () => {
  const lastGood = NOW - 300 * 1000;
  const exec = fakeExec({ units: { 'vitana-land': unitFailed(10), 'vitana-settings': unitFailed(10) } });
  const r = await M.collectTicks({ exec, now: NOW, uptimeSeconds: UPTIME, state: { 'vitana-land': lastGood, 'vitana-settings': NOW - 1000 * 1000 }, units: M.TICK_UNITS, log: () => {} });
  assert.deepEqual(r.ticks, [{ unit: 'vitana-land', ageSeconds: 300 }, { unit: 'vitana-settings', ageSeconds: 1000 }]);
  assert.equal(r.state['vitana-land'], lastGood, 'the failure did not overwrite the last good tick');
});

test('collectTicks: a tick that is running right now is bridged by the last good tick (no gap, no reset), whatever the run before it was', async () => {
  // the previous run ended 5 s ago and may have failed: only the stored time of a GOOD tick counts
  const exec = fakeExec({ units: { 'vitana-land': unitRunning(5), 'vitana-settings': unitRunning(5) } });
  const r = await M.collectTicks({ exec, now: NOW, uptimeSeconds: UPTIME, state: { 'vitana-land': NOW - 45_000, 'vitana-settings': NOW - 500_000 }, units: M.TICK_UNITS, log: () => {} });
  assert.deepEqual(r.ticks, [{ unit: 'vitana-land', ageSeconds: 45 }, { unit: 'vitana-settings', ageSeconds: 500 }]);
});

test('collectTicks: an inactive unit whose Result is not success is not a good tick either', async () => {
  const exec = fakeExec({ units: { 'vitana-land': unitInactiveNotSuccess(10), 'vitana-settings': unitInactiveNotSuccess(10) } });
  const r = await M.collectTicks({ exec, now: NOW, uptimeSeconds: UPTIME, state: { 'vitana-land': NOW - 300_000 }, units: M.TICK_UNITS, log: () => {} });
  assert.deepEqual(r.ticks, [{ unit: 'vitana-land', ageSeconds: 300 }], 'the stored time, and no datapoint for the unit with none');
});

test('collectTicks: a unit that never ran, or does not exist, gives no datapoint at all (never 0)', async () => {
  const exec = fakeExec({ units: {} });
  const events = [];
  const r = await M.collectTicks({ exec, now: NOW, uptimeSeconds: UPTIME, state: {}, units: M.TICK_UNITS, log: (e) => events.push(e) });
  assert.deepEqual(r.ticks, []);
  assert.deepEqual(r.state, {});
  assert.equal(events.filter((e) => e.event === 'tick_unknown').length, 2);
});

test('collectTicks: a newer good tick replaces the stored one; an older observation never moves it back', async () => {
  const exec = fakeExec({ units: { 'vitana-land': unitDone(10), 'vitana-settings': unitDone(900) } });
  const r = await M.collectTicks({ exec, now: NOW, uptimeSeconds: UPTIME, state: { 'vitana-land': NOW - 500_000, 'vitana-settings': NOW - 100_000 }, units: M.TICK_UNITS, log: () => {} });
  assert.equal(r.state['vitana-land'], NOW - 10_000);
  assert.equal(r.state['vitana-settings'], NOW - 100_000);
  assert.deepEqual(r.ticks.map((t) => t.ageSeconds), [10, 100]);
});

test('collectTicks: when systemctl itself fails the stored tick is used and the failure is logged', async () => {
  const exec = fakeExec({ systemctlError: true });
  const events = [];
  const r = await M.collectTicks({ exec, now: NOW, uptimeSeconds: UPTIME, state: { 'vitana-land': NOW - 70_000 }, units: M.TICK_UNITS, log: (e) => events.push(e) });
  assert.deepEqual(r.ticks, [{ unit: 'vitana-land', ageSeconds: 70 }]);
  assert.ok(events.some((e) => e.event === 'systemctl_failed'));
});

test('collectTicks: without a readable uptime nothing is observed, and the stored ticks still give an age', async () => {
  const exec = fakeExec({ units: { 'vitana-land': unitDone(5), 'vitana-settings': unitDone(5) } });
  const events = [];
  const r = await M.collectTicks({ exec, now: NOW, uptimeSeconds: null, state: { 'vitana-land': NOW - 33_000 }, units: M.TICK_UNITS, log: (e) => events.push(e) });
  assert.deepEqual(r.ticks, [{ unit: 'vitana-land', ageSeconds: 33 }]);
  assert.equal(exec.calls.length, 0, 'systemctl is not asked when the observation could not be used');
  assert.ok(events.some((e) => e.event === 'uptime_unreadable'));
});

test('run: the last good tick is kept in the state file across runs, so a failing bot is seen growing older', async () => {
  const h = harness({ execOptions: { units: { 'vitana-land': unitDone(20), 'vitana-settings': unitDone(200) } } });
  gitlab(h.fetch, { jobs: { 1: [] } });
  await M.run(h.options, h.deps);
  assert.equal(h.savedState().lastSuccessMs['vitana-land'], NOW - 20_000);
  // ten minutes later both units fail, systemd still reports the old run as the last exit
  const later = harness({ execOptions: { units: { 'vitana-land': unitFailed(5), 'vitana-settings': unitFailed(5) } } });
  mkdirSync(later.stateDir, { recursive: true });
  writeFileSync(later.stateFile, readFileSync(h.stateFile));
  gitlab(later.fetch, { jobs: { 1: [] } });
  await M.run(later.options, { ...later.deps, now: () => NOW + 600_000 });
  const { data } = published(later);
  assert.equal(valueOf(data, 'TickAgeSeconds', 'vitana-land'), 620);
  assert.equal(valueOf(data, 'TickAgeSeconds', 'vitana-settings'), 800);
});

test('run: a corrupt or foreign state file is ignored (and replaced), not a crash', async () => {
  for (const state of ['{ not json', '[]', '{"version":1,"lastSuccessMs":"nope"}', '{"version":1,"lastSuccessMs":{"vitana-land":"yesterday"}}']) {
    const h = harness({ state, execOptions: { units: { 'vitana-land': unitDone(30), 'vitana-settings': unitDone(30) } } });
    gitlab(h.fetch, { jobs: { 1: [] } });
    const { exitCode } = await M.run(h.options, h.deps);
    assert.equal(exitCode, 0, state);
    assert.equal(valueOf(published(h).data, 'TickAgeSeconds', 'vitana-land'), 30, state);
    assert.equal(h.savedState().lastSuccessMs['vitana-land'], NOW - 30_000, state);
  }
});

test('run: a state file of another version, or without a version, is not believed even when it holds a recent time', async () => {
  for (const state of [{ version: 2, lastSuccessMs: { 'vitana-land': NOW - 60_000 } }, { lastSuccessMs: { 'vitana-land': NOW - 60_000 } }]) {
    const h = harness({ state, execOptions: { units: { 'vitana-land': unitFailed(5), 'vitana-settings': unitFailed(5) } } });
    gitlab(h.fetch, { jobs: { 1: [] } });
    await M.run(h.options, h.deps);
    const { data } = published(h);
    assert.equal(find(data, 'TickAgeSeconds', 'vitana-land'), undefined, JSON.stringify(state));
    assert.ok(h.logs().some((l) => l.event === 'state_unreadable'));
  }
});

test('run: a state directory that cannot be written is logged and the metrics are still published', async () => {
  const h = harness({ execOptions: { units: { 'vitana-land': unitDone(30), 'vitana-settings': unitDone(30) } } });
  writeFileSync(path.join(h.dir, 'blocker'), 'a file where the state directory should be');
  gitlab(h.fetch, { jobs: { 1: [] } });
  const { exitCode } = await M.run({ ...h.options, stateDir: path.join(h.dir, 'blocker', 'state') }, h.deps);
  assert.equal(exitCode, 0);
  assert.equal(valueOf(published(h).data, 'TickAgeSeconds', 'vitana-land'), 30);
  assert.ok(h.logs().some((l) => l.event === 'state_not_saved'));
});

// ================================================================== backup age (S3)
test('collectBackupAge: the age of the newest object under backups/ and the exact aws command', async () => {
  const exec = fakeExec({ backup: [iso(-30 * 3600), iso(-5 * 3600), iso(-90 * 3600)] });
  const age = await M.collectBackupAge({ exec, region: REGION, bucket: BUCKET, now: NOW, log: () => {} });
  assert.equal(age, 5 * 3600);
  assert.deepEqual(exec.calls[0], {
    file: 'aws',
    args: ['s3api', 'list-objects-v2', '--bucket', BUCKET, '--prefix', 'backups/', '--query', 'Contents[].LastModified', '--output', 'json', '--region', REGION],
  });
});

test('collectBackupAge: an empty bucket gives null (no datapoint, so the alarm sees missing data), never 0', async () => {
  for (const backup of [null, []]) {
    const exec = fakeExec({ backup });
    const events = [];
    const age = await M.collectBackupAge({ exec, region: REGION, bucket: BUCKET, now: NOW, log: (e) => events.push(e) });
    assert.equal(age, null);
    assert.equal(exec.calls.length, 1, 'the bucket was listed');
    assert.ok(events.some((e) => e.event === 'backup_none_found'), 'and the empty answer is logged');
  }
});

test('collectBackupAge: a listing that fails gives null and is logged', async () => {
  const events = [];
  const age = await M.collectBackupAge({ exec: fakeExec({ backupError: new Error('AccessDenied') }), region: REGION, bucket: BUCKET, now: NOW, log: (e) => events.push(e) });
  assert.equal(age, null);
  assert.ok(events.some((e) => e.event === 'backup_listing_failed' && /AccessDenied/.test(e.message)));
});

test('collectBackupAge: a bucket name that could be read as an option is refused before aws is called', async () => {
  const exec = fakeExec({ backup: [iso(-10)] });
  const events = [];
  const age = await M.collectBackupAge({ exec, region: REGION, bucket: '--endpoint-url=http://evil', now: NOW, log: (e) => events.push(e) });
  assert.equal(age, null);
  assert.equal(exec.calls.length, 0);
  assert.ok(events.some((e) => e.event === 'backup_skipped'));
});

test('run: a failing backup listing or a missing bucket leaves the other metrics alone', async () => {
  const h = harness({ execOptions: { backupError: new Error('boom'), units: { 'vitana-land': unitDone(1), 'vitana-settings': unitDone(1) } } });
  gitlab(h.fetch, { jobs: { 1: [] } });
  await M.run(h.options, h.deps);
  let { data } = published(h);
  assert.equal(find(data, 'BackupAgeSeconds'), undefined);
  assert.equal(valueOf(data, 'GitLabReadFailed'), 0);
  const noBucket = harness({ execOptions: { units: { 'vitana-land': unitDone(1), 'vitana-settings': unitDone(1) } } });
  gitlab(noBucket.fetch, { jobs: { 1: [] } });
  await M.run({ ...noBucket.options, bucket: undefined }, noBucket.deps);
  ({ data } = published(noBucket));
  assert.equal(find(data, 'BackupAgeSeconds'), undefined);
  assert.equal(noBucket.exec.calls.some((c) => c.args[0] === 's3api'), false);
});

// ================================================================== building and publishing the metric data
test('buildMetricData: a failed read gives the failure metric (1) and no queue metric; the host metrics stay', () => {
  const data = M.buildMetricData({ queue: null, ticks: [{ unit: 'vitana-land', ageSeconds: 12 }], backupAgeSeconds: 99, gitlabFailed: true });
  assert.deepEqual(data.map((d) => d.MetricName).sort(), ['BackupAgeSeconds', 'GitLabReadFailed', 'TickAgeSeconds']);
  assert.equal(valueOf(data, 'GitLabReadFailed'), 1);
});

test('buildMetricData: a failed read wins over a queue that is still around', () => {
  const stale = { pendingJobs: 5, runningJobs: 2, fleetRunningJobs: 1, oldestPendingJobAgeSeconds: 77 };
  const data = M.buildMetricData({ queue: stale, ticks: [], backupAgeSeconds: null, gitlabFailed: true });
  assert.deepEqual(data.map((d) => [d.MetricName, d.Value]), [['GitLabReadFailed', 1]]);
});

test('buildMetricData: a good read gives the queue metrics and the failure metric at 0; a null age is left out', () => {
  const queue = { pendingJobs: 4, runningJobs: 2, fleetRunningJobs: 1, oldestPendingJobAgeSeconds: null };
  const data = M.buildMetricData({ queue, ticks: [], backupAgeSeconds: null, gitlabFailed: false });
  assert.deepEqual(data.map((d) => d.MetricName).sort(), ['FleetRunningJobs', 'GitLabReadFailed', 'PendingJobs', 'RunningJobs']);
  assert.equal(valueOf(data, 'GitLabReadFailed'), 0);
  assert.equal(valueOf(data, 'PendingJobs'), 4);
});

test('buildMetricData: a number that is not finite or is negative is never published', () => {
  const queue = { pendingJobs: Number.NaN, runningJobs: -1, fleetRunningJobs: Infinity, oldestPendingJobAgeSeconds: 5 };
  const data = M.buildMetricData({ queue, ticks: [{ unit: 'vitana-land', ageSeconds: Number.NaN }], backupAgeSeconds: -5, gitlabFailed: false });
  assert.deepEqual(data.map((d) => d.MetricName).sort(), ['GitLabReadFailed', 'OldestPendingJobAgeSeconds']);
  for (const d of data) assert.ok(Number.isFinite(d.Value) && d.Value >= 0, JSON.stringify(d));
});

test('publishMetrics: one aws cloudwatch put-metric-data with the namespace, the region and the data as JSON', async () => {
  const exec = fakeExec();
  const data = [{ MetricName: 'PendingJobs', Value: 3, Unit: 'Count' }];
  await M.publishMetrics({ exec, region: REGION, data });
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].file, 'aws');
  assert.deepEqual(exec.calls[0].args, ['cloudwatch', 'put-metric-data', '--namespace', 'Vitana/Engineering', '--region', REGION, '--metric-data', JSON.stringify(data)]);
});

test('publishMetrics: nothing to publish means no call', async () => {
  const exec = fakeExec();
  await M.publishMetrics({ exec, region: REGION, data: [{ MetricName: 'PendingJobs', Value: 0, Unit: 'Count' }] });
  assert.equal(exec.calls.length, 1);
  await M.publishMetrics({ exec, region: REGION, data: [] });
  assert.equal(exec.calls.length, 1, 'an empty list adds no second call');
});

// ================================================================== command line
test('parseArgs: defaults are the paths of the units and the values from the environment file', () => {
  const o = M.parseArgs(['run'], { REGION, BACKUP_BUCKET: BUCKET });
  assert.deepEqual({ ...o }, {
    command: 'run', url: 'http://127.0.0.1', tokenFile: '/etc/vitana/bot-metrics-token', stateDir: '/var/lib/vitana-ci-metrics',
    region: REGION, bucket: BUCKET, dryRun: false, gitlabDeadlineMs: 40_000, requestTimeoutMs: 15_000,
  });
});

test('parseArgs: the --option=value form works too', () => {
  const o = M.parseArgs(['run', '--url=https://gitlab.test', '--bucket=my-bucket', '--region=eu-west-1'], {});
  assert.deepEqual([o.url, o.bucket, o.region], ['https://gitlab.test', 'my-bucket', 'eu-west-1']);
});

test('parseArgs: options override the environment; --dry-run and the knobs are read', () => {
  const o = M.parseArgs(['run', '--url', 'https://gitlab.test', '--token-file', '/x/t', '--state-dir', '/x/s', '--region', 'eu-west-1', '--bucket', 'my-bucket', '--dry-run', '--gitlab-deadline-ms', '500', '--request-timeout-ms', '100'], { REGION, BACKUP_BUCKET: BUCKET });
  assert.equal(o.url, 'https://gitlab.test');
  assert.equal(o.tokenFile, '/x/t');
  assert.equal(o.stateDir, '/x/s');
  assert.equal(o.region, 'eu-west-1');
  assert.equal(o.bucket, 'my-bucket');
  assert.equal(o.dryRun, true);
  assert.equal(o.gitlabDeadlineMs, 500);
  assert.equal(o.requestTimeoutMs, 100);
});

test('parseArgs: a usage mistake is a UsageError (unknown command or option, missing value, no region, bad number)', () => {
  const bad = (argv, env = { REGION }) => assert.throws(() => M.parseArgs(argv, env), (e) => e.name === 'UsageError', JSON.stringify(argv));
  bad([]);
  bad(['status']);
  bad(['run', '--nope']);
  bad(['run', '--url']);
  bad(['run', '--gitlab-deadline-ms', 'soon']);
  bad(['run', '--gitlab-deadline-ms', '0']);
  bad(['run'], {});
  bad(['run', '--region', 'nowhere']);
  bad(['run', '--bucket', '--endpoint-url=x']);
  bad(['run', '--dry-run=false']); // would otherwise switch dry-run ON
  bad(['run', '--token-file', '--dry-run']); // a value that is an option is a missing value, also where it would be a valid path
  bad(['run', '--state-dir', '--dry-run']);
  bad(['run', '--bucket', 'Not_A_Bucket']);
  bad(['run', '--bucket', 'ab']);
  bad(['run', '--url', 'ftp://gitlab.test']);
  bad(['run', '--url', 'not a url']);
});

test('main: exit 0 for a good run, 2 for a usage mistake (usage text on stderr), and the usage mistake touches nothing', async () => {
  const h = harness();
  gitlab(h.fetch, { jobs: { 1: [] } });
  assert.equal(await M.main(['run', '--url', h.options.url, '--token-file', h.tokenFile, '--state-dir', h.stateDir, '--region', REGION], {}, h.deps), 0);
  const bad = harness();
  assert.equal(await M.main(['run', '--nope'], {}, bad.deps), 2);
  assert.match(bad.errs.join(''), /usage/i);
  assert.equal(bad.fetch.calls.length + bad.exec.calls.length, 0);
});

test('main --help prints the usage on stdout and touches nothing', async () => {
  const h = harness();
  assert.equal(await M.main(['--help'], {}, h.deps), 0);
  assert.match(h.out.join(''), /usage: ci-metrics\.mjs run/i);
  assert.equal(h.fetch.calls.length + h.exec.calls.length, 0);
});

test('main: exit 1 when publishing fails', async () => {
  const h = harness({ execOptions: { putError: new Error('no route to host') } });
  gitlab(h.fetch, { jobs: { 1: [] } });
  assert.equal(await M.main(['run', '--url', h.options.url, '--token-file', h.tokenFile, '--state-dir', h.stateDir, '--region', REGION], {}, h.deps), 1);
});
