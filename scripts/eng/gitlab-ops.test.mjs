// Tests of the GitLab operations (plan gitlab-client-hardening). Offline: the recording fake fetch, no token needed beyond a test value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, GitLabApiError } from './gitlab-api.mjs';
import { findMergeRequestBySource, listPipelineJobs, failedJobs, getJobLog, getPipeline } from './gitlab-ops.mjs';
import { fakeFetch } from './testing/fake-fetch.mjs';

const TOKEN = 'glpat-ABCDEFGHIJKLMNOPQRSTUV';
const setup = (f) => createClient({ baseUrl: 'https://gitlab.test', token: TOKEN, fetch: f, sleep: async () => {}, random: () => 1 });
const failure = async (p) => { try { await p; } catch (e) { return e; } assert.fail('expected a failure'); };

test('merge request by source branch: the one open MR from that branch, not by number', async () => {
  const f = fakeFetch().route('GET', /^\/api\/v4\/projects\/1\/merge_requests$/, () => ({ json: [
    { iid: 7, source_branch: 'feature/x', target_branch: 'main', source_project_id: 1, target_project_id: 1 },
    { iid: 8, source_branch: 'other', target_branch: 'main', source_project_id: 1, target_project_id: 1 },
  ] }));
  const mr = await findMergeRequestBySource(setup(f), 1, 'feature/x');
  assert.equal(mr.iid, 7);
  assert.equal(String(f.calls[0].query.source_branch), 'feature/x');
});

test('merge request by source branch: none found gives null; two gives an error', async () => {
  const none = fakeFetch().route('GET', /merge_requests$/, () => ({ json: [] }));
  assert.equal(await findMergeRequestBySource(setup(none), 1, 'feature/x'), null);
  const two = fakeFetch().route('GET', /merge_requests$/, () => ({ json: [
    { iid: 1, source_branch: 'b', target_branch: 'main', source_project_id: 1, target_project_id: 1 },
    { iid: 2, source_branch: 'b', target_branch: 'main', source_project_id: 1, target_project_id: 1 },
  ] }));
  const e = await failure(findMergeRequestBySource(setup(two), 1, 'b'));
  assert.equal(e.code, 'ambiguous');
});

test('jobs: a pipeline lists every job, across pages', async () => {
  const f = fakeFetch().route('GET', /^\/api\/v4\/projects\/1\/pipelines\/9\/jobs$/, (call) => {
    const page = String(call.query.page ?? '1');
    return page === '1' ? { json: [{ id: 1 }], headers: { 'x-next-page': '2' } } : { json: [{ id: 2 }] };
  });
  const jobs = await listPipelineJobs(setup(f), 1, 9);
  assert.deepEqual(jobs.map((j) => j.id), [1, 2]);
});

test('jobs: failedJobs asks GitLab for the failed scope only', async () => {
  const f = fakeFetch().route('GET', /^\/api\/v4\/projects\/1\/pipelines\/9\/jobs$/, () => ({ json: [{ id: 4, status: 'failed' }] }));
  const jobs = await failedJobs(setup(f), 1, 9);
  assert.equal(jobs[0].id, 4);
  assert.deepEqual(f.calls[0].query.scope ?? f.calls[0].query['scope[]'], ['failed']);
});

test('job log: returns the trace text of the exact job', async () => {
  const f = fakeFetch().route('GET', '/api/v4/projects/1/jobs/42/trace', { text: 'line one\nFAILED test x\n' });
  const { jobId, log } = await getJobLog(setup(f), 1, 42);
  assert.equal(jobId, 42);
  assert.equal(log, 'line one\nFAILED test x\n');
});

test('job log: an oversize trace is refused, not truncated', async () => {
  const f = fakeFetch().route('GET', '/api/v4/projects/1/jobs/42/trace', { text: 'x'.repeat(5000) });
  const e = await failure(getJobLog(setup(f), 1, 42, { maxBytes: 100 }));
  assert.equal(e.code, 'body_too_large');
});

test('ids: a bad job or pipeline id is refused before any call', async () => {
  const f = fakeFetch();
  for (const bad of [0, -1, 'abc', 1.5]) {
    assert.equal((await failure(getJobLog(setup(f), 1, bad))).code, 'bad_request');
    assert.equal((await failure(listPipelineJobs(setup(f), 1, bad))).code, 'bad_request');
  }
  assert.equal((await failure(findMergeRequestBySource(setup(f), 1, ''))).code, 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('errors: a failed log read names the status, never the token', async () => {
  const f = fakeFetch().route('GET', '/api/v4/projects/1/jobs/42/trace', { status: 404, json: { message: '404 Job Not Found' } });
  const e = await failure(getJobLog(setup(f), 1, 42));
  assert.equal(e.status, 404);
  assert.equal(JSON.stringify(e).includes(TOKEN), false);
  assert.equal(e.message.includes(TOKEN), false);
});

test('pipeline: status comes from GitLab as the pipeline object', async () => {
  const f = fakeFetch().route('GET', '/api/v4/projects/1/pipelines/9', { json: { id: 9, status: 'failed' } });
  assert.equal((await getPipeline(setup(f), 1, 9)).status, 'failed');
});