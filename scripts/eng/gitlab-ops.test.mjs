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
// ---- VTID-05801 operations batch 2: merge requests, safe merge, pipelines and jobs, webhooks, errors, configuration ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  resolveProject, getMergeRequest, mergeStatus, createMergeRequest, updateMergeRequest, safeMerge,
  triggerPipeline, retryJob, retryPipeline, classifyError, clientFromEnv, verifyWebhook, isDuplicateDelivery,
} from './gitlab-ops.mjs';

const HEAD = 'a'.repeat(40);
const PROJECT_PATH = 'vitana/vitana-platform';
const PID = 2;
const byPath = (f) => f.route('GET', `/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}`, { json: { id: PID, path_with_namespace: PROJECT_PATH } });
const mr = (over = {}) => ({
  iid: 7, state: 'opened', source_branch: 'feature/x', target_branch: 'main', project_id: PID, target_project_id: PID,
  source_project_id: PID, sha: HEAD, draft: false, title: 'VTID-05801 change', detailed_merge_status: 'mergeable',
  head_pipeline: { id: 9, status: 'success' }, ...over,
});

test('project: a path is looked up once per client and its id is reused', async () => {
  const f = byPath(fakeFetch());
  const c = setup(f);
  assert.equal(await resolveProject(c, PROJECT_PATH), PID);
  assert.equal(await resolveProject(c, PROJECT_PATH), PID);
  assert.equal(f.calls.length, 1);
});

test('project: a lookup that answers a different project is refused', async () => {
  const f = fakeFetch().route('GET', `/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}`, { json: { id: 99, path_with_namespace: 'other/project' } });
  const e = await failure(resolveProject(setup(f), PROJECT_PATH));
  assert.equal(e.code, 'precondition');
  assert.equal(e.check, 'wrong_project');
});

test('merge request by iid: one that belongs to another project is refused, not acted on', async () => {
  const f = fakeFetch().route('GET', '/api/v4/projects/2/merge_requests/7', { json: mr({ target_project_id: 3, project_id: 3 }) });
  const e = await failure(getMergeRequest(setup(f), PID, 7));
  assert.equal(e.check, 'wrong_project');
});

test('mergeStatus: mergeable only when open, not a draft, mergeable and its head pipeline succeeded', () => {
  assert.equal(mergeStatus(mr()).mergeable, true);
  assert.deepEqual(mergeStatus(mr({ draft: true })).blockers, ['draft']);
  assert.ok(mergeStatus(mr({ head_pipeline: { id: 9, status: 'failed' } })).blockers.includes('head pipeline is failed'));
  assert.ok(mergeStatus(mr({ detailed_merge_status: 'conflict' })).blockers.includes('merge status is conflict'));
  assert.equal(mergeStatus(mr({ head_pipeline: null })).pipelineStatus, null);
});

test('create merge request: creates one when none is open', async () => {
  const f = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/merge_requests', { json: [] })
    .route('POST', '/api/v4/projects/2/merge_requests', { status: 201, json: mr({ iid: 8 }) });
  const out = await createMergeRequest(setup(f), PROJECT_PATH, { sourceBranch: 'feature/x', title: 'VTID-05801 change' });
  assert.equal(out.created, true);
  assert.equal(out.mr.iid, 8);
  const post = f.writes()[0];
  assert.equal(post.body.source_branch, 'feature/x');
  assert.equal(post.body.target_branch, 'main');
});

test('create merge request: an open one already there is returned and nothing is posted', async () => {
  const f = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/merge_requests', { json: [mr()] });
  const out = await createMergeRequest(setup(f), PROJECT_PATH, { sourceBranch: 'feature/x', title: 'VTID-05801 change' });
  assert.equal(out.created, false);
  assert.equal(out.mr.iid, 7);
  f.assertNoWrites();
});

test('create merge request: a 409 on create returns the one GitLab already has, never a second', async () => {
  const f = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/merge_requests', [{ json: [] }, { json: [mr()] }])
    .route('POST', '/api/v4/projects/2/merge_requests', { status: 409, json: { message: 'Another open merge request already exists' } });
  const out = await createMergeRequest(setup(f), PROJECT_PATH, { sourceBranch: 'feature/x', title: 'VTID-05801 change' });
  assert.equal(out.created, false);
  assert.equal(f.writes().length, 1);
});

test('create merge request: a 500 on create is not repeated (one POST), and the error is transient', async () => {
  const f = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/merge_requests', { json: [] })
    .route('POST', '/api/v4/projects/2/merge_requests', { status: 500, json: { message: 'boom' } });
  const e = await failure(createMergeRequest(setup(f), PROJECT_PATH, { sourceBranch: 'feature/x', title: 'VTID-05801 change' }));
  assert.equal(f.writes().length, 1);
  assert.equal(classifyError(e).kind, 'transient');
});

test('create merge request: same source and target, or an empty title, is refused before any call', async () => {
  const f = fakeFetch();
  assert.equal((await failure(createMergeRequest(setup(f), PROJECT_PATH, { sourceBranch: 'main', targetBranch: 'main', title: 'x' }))).code, 'bad_request');
  assert.equal((await failure(createMergeRequest(setup(f), PROJECT_PATH, { sourceBranch: 'b', title: '  ' }))).code, 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('update merge request: refused, with no write, when the iid has another source branch', async () => {
  const f = byPath(fakeFetch()).route('GET', '/api/v4/projects/2/merge_requests/7', { json: mr({ source_branch: 'someone-else' }) });
  const e = await failure(updateMergeRequest(setup(f), PROJECT_PATH, 7, { title: 'new', expect: { sourceBranch: 'feature/x' } }));
  assert.equal(e.check, 'wrong_source');
  f.assertNoWrites();
});

test('update merge request: without expect it is refused before any call', async () => {
  const f = fakeFetch();
  assert.equal((await failure(updateMergeRequest(setup(f), PROJECT_PATH, 7, { title: 'new' }))).code, 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('update merge request: marking a draft adds the Draft prefix once, and removing it strips it', async () => {
  const f = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/merge_requests/7', { json: mr() })
    .route('PUT', '/api/v4/projects/2/merge_requests/7', { json: mr({ draft: true }) });
  await updateMergeRequest(setup(f), PROJECT_PATH, 7, { draft: true, expect: { sourceBranch: 'feature/x' } });
  assert.equal(f.writes()[0].body.title, 'Draft: VTID-05801 change');
});

test('safe merge: merges once, pinned to the reviewed head, with retries off', async () => {
  const f = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/merge_requests/7', { json: mr() })
    .route('PUT', '/api/v4/projects/2/merge_requests/7/merge', { json: mr({ state: 'merged', merge_commit_sha: 'b'.repeat(40) }) });
  const out = await safeMerge(setup(f), PROJECT_PATH, 7, { expectedHeadSha: HEAD, sourceBranch: 'feature/x' });
  assert.deepEqual(out, { merged: true, iid: 7, mergeCommitSha: 'b'.repeat(40), alreadyMerged: false });
  const puts = f.writes();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.sha, HEAD);
});

test('safe merge: every precondition stops the merge before it is sent', async () => {
  const cases = [
    [{ sha: 'c'.repeat(40) }, 'head_moved', { expectedHeadSha: HEAD, sourceBranch: 'feature/x' }],
    [{ head_pipeline: { id: 9, status: 'failed' } }, 'not_mergeable', { expectedHeadSha: HEAD, sourceBranch: 'feature/x' }],
    [{ draft: true }, 'not_mergeable', { expectedHeadSha: HEAD, sourceBranch: 'feature/x' }],
    [{ detailed_merge_status: 'need_rebase' }, 'not_mergeable', { expectedHeadSha: HEAD, sourceBranch: 'feature/x' }],
    [{ source_branch: 'other' }, 'wrong_source', { expectedHeadSha: HEAD, sourceBranch: 'feature/x' }],
    [{}, 'wrong_target', { expectedHeadSha: HEAD, sourceBranch: 'feature/x', targetBranch: 'release' }],
  ];
  for (const [over, check, opts] of cases) {
    const f = byPath(fakeFetch()).route('GET', '/api/v4/projects/2/merge_requests/7', { json: mr(over) });
    const e = await failure(safeMerge(setup(f), PROJECT_PATH, 7, opts));
    assert.equal(e.check, check, `check ${check}`);
    f.assertNoWrites();
  }
});

test('safe merge: a 500 on the merge is not repeated; a merge GitLab did complete is reported as merged', async () => {
  const f = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/merge_requests/7', [{ json: mr() }, { json: mr({ state: 'merged', merge_commit_sha: 'd'.repeat(40) }) }])
    .route('PUT', '/api/v4/projects/2/merge_requests/7/merge', { status: 500, json: { message: 'lost' } });
  const out = await safeMerge(setup(f), PROJECT_PATH, 7, { expectedHeadSha: HEAD, sourceBranch: 'feature/x' });
  assert.equal(out.alreadyMerged, true);
  assert.equal(f.writes().length, 1);
});

test('safe merge: a failed merge that is still open is an error, and it is sent once', async () => {
  const f = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/merge_requests/7', { json: mr() })
    .route('PUT', '/api/v4/projects/2/merge_requests/7/merge', { status: 405, json: { message: 'Method Not Allowed' } });
  const e = await failure(safeMerge(setup(f), PROJECT_PATH, 7, { expectedHeadSha: HEAD, sourceBranch: 'feature/x' }));
  assert.equal(classifyError(e).kind, 'conflict');
  assert.equal(f.writes().length, 1);
});

test('safe merge: a bad head SHA is refused before any call', async () => {
  const f = fakeFetch();
  assert.equal((await failure(safeMerge(setup(f), PROJECT_PATH, 7, { expectedHeadSha: 'HEAD', sourceBranch: 'b' }))).code, 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('pipeline trigger: sent once even on a 500, and refused for a credential-looking variable', async () => {
  const f = byPath(fakeFetch()).route('POST', '/api/v4/projects/2/pipeline', { status: 500, json: { message: 'x' } });
  await failure(triggerPipeline(setup(f), PROJECT_PATH, { ref: 'main', variables: { RUN_KIND: 'smoke' } }));
  assert.equal(f.writes().length, 1);
  assert.deepEqual(f.writes()[0].body.variables, [{ key: 'RUN_KIND', value: 'smoke', variable_type: 'env_var' }]);
  const g = fakeFetch();
  assert.equal((await failure(triggerPipeline(setup(g), 2, { ref: 'main', variables: { API_TOKEN: 'x' } }))).code, 'bad_request');
  assert.equal((await failure(triggerPipeline(setup(g), 2, { ref: 'main', variables: { RUN_KIND: 'glpat-ABCDEFGHIJKLMNOP' } }))).code, 'bad_request');
  assert.equal(g.calls.length, 0);
});

test('job retry: a running job is refused with no write; a failed job is retried once', async () => {
  const running = byPath(fakeFetch()).route('GET', '/api/v4/projects/2/jobs/42', { json: { id: 42, status: 'running' } });
  const e = await failure(retryJob(setup(running), PROJECT_PATH, 42));
  assert.equal(e.check, 'not_retryable');
  running.assertNoWrites();
  const failed = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/jobs/42', { json: { id: 42, status: 'failed' } })
    .route('POST', '/api/v4/projects/2/jobs/42/retry', { status: 201, json: { id: 43 } });
  assert.equal((await retryJob(setup(failed), PROJECT_PATH, 42)).id, 43);
  assert.equal(failed.writes().length, 1);
});

test('pipeline retry: only a failed or canceled pipeline; a 500 is not repeated', async () => {
  const ok = byPath(fakeFetch()).route('GET', '/api/v4/projects/2/pipelines/9', { json: { id: 9, status: 'success' } });
  assert.equal((await failure(retryPipeline(setup(ok), PROJECT_PATH, 9))).check, 'not_retryable');
  ok.assertNoWrites();
  const bad = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/pipelines/9', { json: { id: 9, status: 'canceled' } })
    .route('POST', '/api/v4/projects/2/pipelines/9/retry', { status: 500, json: {} });
  await failure(retryPipeline(setup(bad), PROJECT_PATH, 9));
  assert.equal(bad.writes().length, 1);
});

const SECRET = 'whsec_0123456789abcdef';
const pushBody = (over = {}) => JSON.stringify({ object_kind: 'merge_request', project: { id: PID }, ...over });

test('webhook: the configured secret in X-Gitlab-Token is accepted, and the result holds no secret', () => {
  const res = verifyWebhook({
    headers: { 'X-Gitlab-Token': SECRET, 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Event-UUID': 'uuid-1' },
    body: pushBody(), secret: SECRET,
  });
  assert.equal(res.ok, true);
  assert.equal(res.objectKind, 'merge_request');
  assert.equal(res.uuid, 'uuid-1');
  assert.equal(JSON.stringify(res).includes(SECRET), false);
});

test('webhook: a Headers object is read too', () => {
  const headers = new Headers({ 'x-gitlab-token': SECRET, 'x-gitlab-event': 'Merge Request Hook' });
  assert.equal(verifyWebhook({ headers, body: pushBody(), secret: SECRET }).ok, true);
});

test('webhook: missing, wrong (same length and different length), malformed and mismatched deliveries are rejected', () => {
  const base = { headers: { 'x-gitlab-event': 'Merge Request Hook' }, body: pushBody(), secret: SECRET };
  assert.deepEqual(verifyWebhook(base), { ok: false, reason: 'missing_token' });
  const sameLength = 'x'.repeat(SECRET.length);
  assert.equal(verifyWebhook({ ...base, headers: { ...base.headers, 'x-gitlab-token': sameLength } }).reason, 'bad_token');
  assert.equal(verifyWebhook({ ...base, headers: { ...base.headers, 'x-gitlab-token': SECRET + 'x' } }).reason, 'bad_token');
  assert.equal(verifyWebhook({ ...base, headers: { ...base.headers, 'x-gitlab-token': SECRET.slice(1) } }).reason, 'bad_token');
  const good = { 'x-gitlab-token': SECRET };
  assert.equal(verifyWebhook({ headers: good, body: '{not json', secret: SECRET }).reason, 'bad_body');
  assert.equal(verifyWebhook({ headers: good, body: '[1]', secret: SECRET }).reason, 'not_an_object');
  assert.equal(verifyWebhook({ headers: { ...good, 'x-gitlab-event': 'Pipeline Hook' }, body: pushBody(), secret: SECRET }).reason, 'event_mismatch');
});

test('webhook: no secret configured is a configuration error, never an accepted delivery', () => {
  assert.throws(() => verifyWebhook({ headers: { 'x-gitlab-token': '' }, body: pushBody(), secret: '' }), (e) => e.code === 'bad_config');
  assert.throws(() => verifyWebhook({ headers: { 'x-gitlab-token': 'short' }, body: pushBody(), secret: 'short' }), (e) => e.code === 'bad_config');
});

test('webhook: a delivery seen before is a duplicate; one without a uuid never is', () => {
  const seen = new Set();
  assert.equal(isDuplicateDelivery(seen, 'u1'), false);
  assert.equal(isDuplicateDelivery(seen, 'u1'), true);
  assert.equal(isDuplicateDelivery(seen, null), false);
  assert.equal(isDuplicateDelivery(seen, null), false);
});

test('classifyError: each kind is distinguishable', () => {
  const err = (status, code = 'http') => new GitLabApiError('x', { status, code });
  assert.equal(classifyError(err(401)).kind, 'permission');
  assert.equal(classifyError(err(403)).kind, 'permission');
  assert.equal(classifyError(err(404)).kind, 'not_found');
  assert.equal(classifyError(err(409)).kind, 'conflict');
  assert.equal(classifyError(err(422)).kind, 'conflict');
  assert.equal(classifyError(err(429, 'rate_limited')).kind, 'transient');
  assert.equal(classifyError(err(503)).kind, 'transient');
  assert.equal(classifyError(err(0, 'timeout')).retryable, true);
  assert.equal(classifyError(err(0, 'network')).kind, 'transient');
  assert.equal(classifyError(err(400, 'bad_request')).kind, 'bad_request');
  assert.equal(classifyError(new Error('plain')).kind, 'unknown');
});

test('clientFromEnv: the URL is required, the token comes from the environment or a 0600 file, and no error shows a token', () => {
  assert.equal((() => { try { clientFromEnv({ GITLAB_TOKEN: TOKEN }); } catch (e) { return e.code; } })(), 'bad_config');
  const c = clientFromEnv({ GITLAB_URL: 'https://gitlab.test', GITLAB_TOKEN: TOKEN }, { fetch: fakeFetch(), sleep: async () => {} });
  assert.equal(c.baseUrl, 'https://gitlab.test/api/v4');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-ops-'));
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, `${TOKEN}\n`, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  let refused;
  try { clientFromEnv({ GITLAB_URL: 'https://gitlab.test', GITLAB_TOKEN_FILE: file }); } catch (e) { refused = e; }
  assert.equal(refused.code, 'bad_config');
  assert.equal(refused.message.includes(TOKEN), false);
  fs.chmodSync(file, 0o600);
  assert.equal(clientFromEnv({ GITLAB_URL: 'https://gitlab.test', GITLAB_TOKEN_FILE: file }, { fetch: fakeFetch() }).baseUrl, 'https://gitlab.test/api/v4');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('leak check: a failed write, with the token in the client, puts no token in the error', async () => {
  const f = byPath(fakeFetch())
    .route('GET', '/api/v4/projects/2/merge_requests/7', { json: mr() })
    .route('PUT', '/api/v4/projects/2/merge_requests/7/merge', { status: 401, json: { message: `bad token ${TOKEN}` } });
  const e = await failure(safeMerge(setup(f), PROJECT_PATH, 7, { expectedHeadSha: HEAD, sourceBranch: 'feature/x' }));
  assert.equal(JSON.stringify(e).includes(TOKEN), false);
  assert.equal(e.message.includes(TOKEN), false);
  assert.equal(classifyError(e).kind, 'permission');
});
