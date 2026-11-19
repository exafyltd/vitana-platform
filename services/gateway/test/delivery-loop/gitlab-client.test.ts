/**
 * Delivery loop GitLab client (services/delivery-loop/gitlab-client.ts), against a fake fetch that behaves like the GitLab REST API:
 * what is sent (URL, method, headers, body), what comes back (parsed field by field from an untrusted response), pagination, and
 * the failures (HTTP errors, a server that echoes the token, a hung request, a log that is too large).
 *
 * The rules under test: a project outside the allowlist is refused before any request; the token is only ever in the PRIVATE-TOKEN
 * header and never in an error or a result; no method throws.
 */
import {
  DEFAULT_TRACE_TAIL_BYTES,
  MAX_BODY_CHARS,
  MAX_DIFF_FILES,
  MAX_PAGES,
  PER_PAGE,
  createGitlabClient,
  gitlabClientFromEnv,
  redactToken,
  toDiffFile,
  toIssue,
  toJob,
  toMergeRequest,
  toPipeline,
  type GitlabClient,
} from '../../src/services/delivery-loop/gitlab-client';

const TOKEN = 'glpat-SECRETSECRETSECRET1234';
const BASE = 'https://gitlab.example.invalid/api/v4';
const PROJECT = 'vitana/vitana-platform';
const ENC = 'vitana%2Fvitana-platform';

type Call = { url: URL; method: string; headers: Record<string, string>; body: any };
let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const fakeFetch = (async (input: string | URL, init: RequestInit = {}) => {
  const call: Call = {
    url: new URL(String(input)),
    method: String(init.method ?? 'GET'),
    headers: (init.headers ?? {}) as Record<string, string>,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  };
  calls.push(call);
  const signal = init.signal as AbortSignal | undefined;
  const response = handler(call);
  if (signal) {
    // A hung request ends when the client aborts it, as the real fetch does.
    return await Promise.race([
      Promise.resolve(response),
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    ]);
  }
  return response;
}) as unknown as typeof fetch;

function client(over: Partial<Parameters<typeof createGitlabClient>[0]> = {}): GitlabClient {
  return createGitlabClient({ baseUrl: BASE, token: TOKEN, allowedProjects: [PROJECT, 'vitana/rehearsal'], fetch: fakeFetch, timeoutMs: 1000, ...over });
}

beforeEach(() => {
  calls = [];
  handler = () => json({});
});

describe('configuration', () => {
  it('gitlabClientFromEnv is null without a URL or a token, or with a URL that is not http(s)', () => {
    const e = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;
    expect(gitlabClientFromEnv(e({}), [PROJECT])).toBeNull();
    expect(gitlabClientFromEnv(e({ GITLAB_API_URL: BASE }), [PROJECT])).toBeNull();
    expect(gitlabClientFromEnv(e({ GITLAB_API_TOKEN: TOKEN }), [PROJECT])).toBeNull();
    expect(gitlabClientFromEnv(e({ GITLAB_API_URL: 'ftp://x/api/v4', GITLAB_API_TOKEN: TOKEN }), [PROJECT])).toBeNull();
    expect(gitlabClientFromEnv(e({ GITLAB_API_URL: '  ', GITLAB_API_TOKEN: TOKEN }), [PROJECT])).toBeNull();
    expect(gitlabClientFromEnv(e({ GITLAB_API_URL: BASE, GITLAB_API_TOKEN: TOKEN }), [PROJECT])).not.toBeNull();
  });

  it('a trailing slash on the base URL does not double up', async () => {
    handler = () => json({ iid: 1, id: 1 });
    await client({ baseUrl: `${BASE}///` }).getIssue(PROJECT, 1);
    expect(calls[0].url.toString()).toBe(`${BASE}/projects/${ENC}/issues/1`);
  });
});

describe('the project allowlist', () => {
  it('refuses a project that is not listed, before any request, on every method', async () => {
    const c = client();
    const other = 'vitana/vitana-v1';
    const results = await Promise.all([
      c.getIssue(other, 1),
      c.listIssues(other),
      c.commentIssue(other, 1, 'x'),
      c.updateIssueLabels(other, 1, { add: ['a'] }),
      c.getMergeRequest(other, 1),
      c.listMergeRequests(other),
      c.createMergeRequest(other, { sourceBranch: 'a', targetBranch: 'main', title: 't', description: 'd' }),
      c.commentMergeRequest(other, 1, 'x'),
      c.getMergeRequestDiffs(other, 1),
      c.getPipeline(other, 1),
      c.listPipelineJobs(other, 1),
      c.getJobTrace(other, 1),
      c.retryPipeline(other, 1),
    ]);
    expect(results.every((r) => r.ok === false && (r as { error: string }).error === 'project_not_allowed')).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses anything that is not a plain group/name path, even one on the list', async () => {
    const c = client({ allowedProjects: ['../etc/passwd', 'a b/c', 'x'] });
    for (const project of ['../etc/passwd', 'a b/c', 'x', '', 'a/b?x=1', 'a/../b', 'vitana/vitana-platform/', undefined as unknown as string]) {
      expect(await c.getIssue(project, 1)).toEqual({ ok: false, error: 'bad_project' });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses an iid that is not a positive integer', async () => {
    const c = client();
    for (const iid of [0, -1, 1.5, NaN, Infinity, '7' as unknown as number, null as unknown as number]) {
      expect(await c.getIssue(PROJECT, iid)).toEqual({ ok: false, error: 'bad_argument' });
      expect(await c.getMergeRequest(PROJECT, iid)).toEqual({ ok: false, error: 'bad_argument' });
      expect(await c.retryPipeline(PROJECT, iid)).toEqual({ ok: false, error: 'bad_argument' });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('what is sent', () => {
  it('puts the token in the PRIVATE-TOKEN header only, with the extra headers, and never in the URL or the body', async () => {
    handler = () => json({ iid: 3, id: 9 });
    await client({ headers: { environmentId: 'env-1' } }).commentIssue(PROJECT, 3, 'hello');
    const [call] = calls;
    expect(call.headers['PRIVATE-TOKEN']).toBe(TOKEN);
    expect(call.headers.environmentId).toBe('env-1');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.url.toString()).not.toContain(TOKEN);
    expect(JSON.stringify(call.body)).not.toContain(TOKEN);
  });

  it('extra headers cannot replace the token header', async () => {
    handler = () => json({ iid: 1 });
    await client({ headers: { 'PRIVATE-TOKEN': 'someone-elses' } }).getIssue(PROJECT, 1);
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe(TOKEN);
  });

  it('getIssue: GET projects/<encoded path>/issues/<iid>', async () => {
    handler = () => json({ iid: 17, id: 301, title: 'T', description: 'D', state: 'opened', labels: ['agent-task'], web_url: 'u', confidential: true, updated_at: 'x' });
    const r = await client().getIssue(PROJECT, 17);
    expect([calls[0].method, calls[0].url.pathname]).toEqual(['GET', `/api/v4/projects/${ENC}/issues/17`]);
    expect(r).toEqual({ ok: true, data: { id: 301, iid: 17, title: 'T', description: 'D', state: 'opened', labels: ['agent-task'], web_url: 'u', confidential: true, updated_at: 'x' } });
  });

  it('listIssues: state, labels and updated_after as query parameters, oldest update first', async () => {
    handler = () => json([]);
    await client().listIssues(PROJECT, { labels: ['agent-task', 'priority-high'], state: 'opened', updatedAfter: '2026-11-18T00:00:00Z' });
    const q = calls[0].url.searchParams;
    expect(Object.fromEntries(q)).toEqual({ state: 'opened', labels: 'agent-task,priority-high', updated_after: '2026-11-18T00:00:00Z', order_by: 'updated_at', sort: 'asc', per_page: String(PER_PAGE), page: '1' });
    await client().listIssues(PROJECT);
    expect(Object.fromEntries(calls[1].url.searchParams)).toMatchObject({ state: 'opened' });
    expect(calls[1].url.searchParams.has('labels')).toBe(false);
  });

  it('commentIssue and commentMergeRequest: POST notes with a body, cut at the limit', async () => {
    handler = () => json({ id: 55 });
    expect(await client().commentIssue(PROJECT, 4, 'x'.repeat(MAX_BODY_CHARS + 500))).toEqual({ ok: true, data: { id: 55 } });
    expect([calls[0].method, calls[0].url.pathname]).toEqual(['POST', `/api/v4/projects/${ENC}/issues/4/notes`]);
    expect(calls[0].body.body).toHaveLength(MAX_BODY_CHARS);
    await client().commentMergeRequest(PROJECT, 9, 'hello');
    expect([calls[1].method, calls[1].url.pathname, calls[1].body]).toEqual(['POST', `/api/v4/projects/${ENC}/merge_requests/9/notes`, { body: 'hello' }]);
  });

  it('updateIssueLabels: PUT with add_labels and remove_labels, only the ones given', async () => {
    handler = () => json({ iid: 4, labels: [] });
    await client().updateIssueLabels(PROJECT, 4, { add: ['delivery-accepted'], remove: ['agent-task', 'x'] });
    expect([calls[0].method, calls[0].url.pathname, calls[0].body]).toEqual(['PUT', `/api/v4/projects/${ENC}/issues/4`, { add_labels: 'delivery-accepted', remove_labels: 'agent-task,x' }]);
    await client().updateIssueLabels(PROJECT, 4, { add: ['only-add'] });
    expect(calls[1].body).toEqual({ add_labels: 'only-add' });
  });

  it('createMergeRequest: POST, a Draft: prefix for a draft, the source branch is kept', async () => {
    handler = () => json({ iid: 70, id: 700, title: 'Draft: t', source_branch: 's', target_branch: 'main' });
    const r = await client().createMergeRequest(PROJECT, { sourceBranch: 's', targetBranch: 'main', title: 't', description: 'd', draft: true, labels: ['delivery-heal'] });
    expect(calls[0].body).toEqual({ source_branch: 's', target_branch: 'main', title: 'Draft: t', description: 'd', labels: 'delivery-heal', remove_source_branch: false });
    expect(r.ok && r.data.iid).toBe(70);
    await client().createMergeRequest(PROJECT, { sourceBranch: 's', targetBranch: 'main', title: 't', description: 'd' });
    expect(calls[1].body.title).toBe('t');
    expect('labels' in calls[1].body).toBe(false);
  });

  it('listPipelineJobs: scope[]=failed only when asked; retryPipeline: POST pipelines/<id>/retry', async () => {
    handler = () => json([]);
    await client().listPipelineJobs(PROJECT, 31, { failedOnly: true });
    expect(calls[0].url.pathname).toBe(`/api/v4/projects/${ENC}/pipelines/31/jobs`);
    expect(calls[0].url.searchParams.get('scope[]')).toBe('failed');
    await client().listPipelineJobs(PROJECT, 31);
    expect(calls[1].url.searchParams.has('scope[]')).toBe(false);
    handler = () => json({ id: 31, status: 'running' });
    await client().retryPipeline(PROJECT, 31);
    expect([calls[2].method, calls[2].url.pathname]).toEqual(['POST', `/api/v4/projects/${ENC}/pipelines/31/retry`]);
  });
});

describe('what comes back is untrusted', () => {
  it('a field of the wrong type becomes its empty value, never an exception', () => {
    expect(toIssue({ iid: 1, id: 'x', title: 5, description: null, state: {}, labels: 'nope', web_url: [], confidential: 'yes', updated_at: 1 })).toEqual({
      id: 0, iid: 1, title: '', description: '', state: '', labels: [], web_url: '', confidential: false, updated_at: '',
    });
    expect(toIssue({ id: 1 })).toBeNull();
    expect(toIssue(null)).toBeNull();
    expect(toIssue([1])).toBeNull();
    expect(toIssue('x')).toBeNull();
  });

  it('labels come as strings or as {name} or {title} objects, capped and cut', () => {
    expect(toIssue({ iid: 1, labels: ['a', { name: 'b' }, { title: 'c' }, 4, null, {}, { name: 'x'.repeat(500) }] })?.labels).toEqual(['a', 'b', 'c', 'x'.repeat(200)]);
    expect(toIssue({ iid: 1, labels: Array.from({ length: 300 }, (_, i) => `l${i}`) })?.labels).toHaveLength(100);
  });

  it('a merge request: draft from draft or the old work_in_progress, the head pipeline id, a null sha', () => {
    expect(toMergeRequest({ iid: 1, draft: true })?.draft).toBe(true);
    expect(toMergeRequest({ iid: 1, work_in_progress: true })?.draft).toBe(true);
    expect(toMergeRequest({ iid: 1, head_pipeline: { id: 31 }, sha: 'abc' })).toMatchObject({ head_pipeline_id: 31, sha: 'abc', draft: false });
    expect(toMergeRequest({ iid: 1, head_pipeline: 'x', sha: 7 })).toMatchObject({ head_pipeline_id: null, sha: null });
    expect(toMergeRequest({ title: 'no iid' })).toBeNull();
  });

  it('a pipeline, a job and a diff file need their key field; the rest degrades', () => {
    expect(toPipeline({ id: 31, status: 'failed', ref: 'r', sha: 's', web_url: 'u', source: 'push' })).toEqual({ id: 31, status: 'failed', ref: 'r', sha: 's', web_url: 'u', source: 'push' });
    expect(toPipeline({ status: 'x' })).toBeNull();
    expect(toJob({ id: 5, name: 'unit', stage: 'test', status: 'failed', failure_reason: 'script_failure', allow_failure: true, web_url: 'u' })).toEqual({ id: 5, name: 'unit', stage: 'test', status: 'failed', failure_reason: 'script_failure', allow_failure: true, web_url: 'u' });
    expect(toJob({ id: 5, failure_reason: 3, allow_failure: 'yes' })).toMatchObject({ failure_reason: null, allow_failure: false });
    expect(toJob({ name: 'x' })).toBeNull();
    expect(toDiffFile({ new_path: 'a.ts', old_path: 'a.ts', diff: '@@', new_file: true })).toEqual({ old_path: 'a.ts', new_path: 'a.ts', new_file: true, deleted_file: false, diff: '@@' });
    expect(toDiffFile({ old_path: 'a' })).toBeNull();
  });

  it('a 200 that is not JSON, or has no key field, is bad_response', async () => {
    handler = () => new Response('<html>login</html>', { status: 200 });
    expect(await client().getIssue(PROJECT, 1)).toEqual({ ok: false, error: 'bad_response' });
    handler = () => json({ not: 'an issue' });
    expect(await client().getIssue(PROJECT, 1)).toEqual({ ok: false, error: 'bad_response' });
    handler = () => json({ not: 'a list' });
    expect(await client().listIssues(PROJECT)).toEqual({ ok: false, error: 'bad_response' });
  });

  it('list rows without their key field are skipped, the rest are kept', async () => {
    handler = () => json([{ iid: 1 }, { nope: true }, 'x', null, { iid: 2 }]);
    const r = await client().listIssues(PROJECT);
    expect(r.ok && r.data.map((i) => i.iid)).toEqual([1, 2]);
  });
});

describe('pagination', () => {
  const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ iid: from + i, id: from + i }));

  it('reads the next page while a page is full, and stops at the first short page', async () => {
    handler = (c) => json(c.url.searchParams.get('page') === '1' ? page(1, PER_PAGE) : page(PER_PAGE + 1, 30));
    const r = await client().listIssues(PROJECT);
    expect(r.ok && r.data).toHaveLength(PER_PAGE + 30);
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2']);
  });

  it('stops after MAX_PAGES however many pages there are', async () => {
    handler = (c) => json(page((Number(c.url.searchParams.get('page')) - 1) * PER_PAGE + 1, PER_PAGE));
    const r = await client().listIssues(PROJECT);
    expect(calls).toHaveLength(MAX_PAGES);
    expect(r.ok && r.data).toHaveLength(MAX_PAGES * PER_PAGE);
  });

  it('a failing later page fails the whole list, so the loop never acts on a partial one', async () => {
    handler = (c) => (c.url.searchParams.get('page') === '1' ? json(page(1, PER_PAGE)) : json({ message: 'nope' }, 500));
    const r = await client().listIssues(PROJECT);
    expect(r).toEqual({ ok: false, error: 'http_500: nope', status: 500 });
  });

  it('diffs are capped at MAX_DIFF_FILES files', async () => {
    handler = (c) => json(Array.from({ length: PER_PAGE }, (_, i) => ({ new_path: `f${c.url.searchParams.get('page')}-${i}.ts`, old_path: 'x', diff: '' })));
    const r = await client().getMergeRequestDiffs(PROJECT, 7);
    expect(r.ok && r.data).toHaveLength(MAX_DIFF_FILES);
    expect(calls.length).toBeLessThanOrEqual(MAX_PAGES);
  });
});

describe('job logs', () => {
  const text = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });

  it('returns the tail of a log: the last bytes, which is where a failure is', async () => {
    const log = `${'setup line\n'.repeat(5000)}Error: the thing failed\nexit code 1\n`;
    handler = () => text(log);
    const r = await client().getJobTrace(PROJECT, 12, { tailBytes: 200 });
    expect(r.ok && Buffer.byteLength(r.data)).toBeLessThanOrEqual(200);
    expect(r.ok && r.data.endsWith('Error: the thing failed\nexit code 1\n')).toBe(true);
    expect(calls[0].url.pathname).toBe(`/api/v4/projects/${ENC}/jobs/12/trace`);
    expect(calls[0].headers.Accept).toBe('text/plain');
  });

  it('a short log is returned whole, and the default tail is 16 KiB', async () => {
    handler = () => text('short log\n');
    expect(await client().getJobTrace(PROJECT, 12)).toEqual({ ok: true, data: 'short log\n' });
    handler = () => text('x'.repeat(DEFAULT_TRACE_TAIL_BYTES * 3));
    const r = await client().getJobTrace(PROJECT, 12);
    expect(r.ok && Buffer.byteLength(r.data)).toBe(DEFAULT_TRACE_TAIL_BYTES);
  });

  it('keeps the tail of a log that arrives in many chunks, without holding all of it', async () => {
    const chunk = Buffer.from('a'.repeat(1000));
    let sent = 0;
    handler = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (sent >= 200) return controller.close();
            sent += 1;
            controller.enqueue(sent === 200 ? Buffer.from('THE-END') : chunk);
          },
        }),
        { status: 200 },
      );
    const r = await client().getJobTrace(PROJECT, 12, { tailBytes: 500 });
    expect(r.ok && r.data.endsWith('THE-END')).toBe(true);
    expect(r.ok && Buffer.byteLength(r.data)).toBe(500);
  });

  it('a log larger than the read limit is response_too_large, and the read is cancelled', async () => {
    let cancelled = false;
    let sent = 0;
    const mib = Buffer.alloc(1024 * 1024, 97);
    handler = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            sent += 1;
            controller.enqueue(mib);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );
    const r = await client().getJobTrace(PROJECT, 12);
    expect(r).toEqual({ ok: false, error: 'response_too_large' });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(80);
  });

  it('a tail size is bounded to 256 KiB', async () => {
    handler = () => text('y'.repeat(1024 * 1024));
    const r = await client().getJobTrace(PROJECT, 12, { tailBytes: 50 * 1024 * 1024 });
    expect(r.ok && Buffer.byteLength(r.data)).toBe(256 * 1024);
  });
});

describe('failures never throw and never carry the token', () => {
  it('an HTTP error carries the status and GitLab\'s message', async () => {
    handler = () => json({ message: '404 Not found' }, 404);
    expect(await client().getIssue(PROJECT, 99)).toEqual({ ok: false, error: 'http_404: 404 Not found', status: 404 });
    handler = () => new Response('Bad Gateway', { status: 502 });
    expect(await client().getIssue(PROJECT, 99)).toEqual({ ok: false, error: 'http_502: Bad Gateway', status: 502 });
    handler = () => new Response('', { status: 503 });
    expect(await client().getIssue(PROJECT, 99)).toEqual({ ok: false, error: 'http_503', status: 503 });
  });

  it('a server that echoes the token into its error message does not get it into ours', async () => {
    handler = () => json({ message: `401 Unauthorized: invalid token ${TOKEN} for user; also glpat-ANOTHERLEAKEDTOKEN99` }, 401);
    const r = await client().getIssue(PROJECT, 1);
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('glpat-ANOTHERLEAKEDTOKEN99');
    expect(text).toContain('[token]');
  });

  it('a network error is network_error, with nothing of the error in it', async () => {
    handler = () => {
      throw new Error(`connect ECONNREFUSED https://x/?private_token=${TOKEN}`);
    };
    const r = await client().getIssue(PROJECT, 1);
    expect(r).toEqual({ ok: false, error: 'network_error' });
  });

  it('a request that hangs is aborted after the timeout', async () => {
    handler = () => new Promise<Response>(() => undefined);
    const started = Date.now();
    const r = await client({ timeoutMs: 30 }).getIssue(PROJECT, 1);
    expect(r).toEqual({ ok: false, error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('no method throws, whatever fetch does', async () => {
    handler = () => {
      throw new TypeError('boom');
    };
    const c = client();
    const results = await Promise.all([
      c.getIssue(PROJECT, 1), c.listIssues(PROJECT), c.commentIssue(PROJECT, 1, 'x'), c.updateIssueLabels(PROJECT, 1, {}), c.getMergeRequest(PROJECT, 1),
      c.listMergeRequests(PROJECT), c.createMergeRequest(PROJECT, { sourceBranch: 'a', targetBranch: 'b', title: 't', description: 'd' }),
      c.commentMergeRequest(PROJECT, 1, 'x'), c.getMergeRequestDiffs(PROJECT, 1), c.getPipeline(PROJECT, 1), c.listPipelineJobs(PROJECT, 1),
      c.getJobTrace(PROJECT, 1), c.retryPipeline(PROJECT, 1),
    ]);
    expect(results.every((r) => r.ok === false)).toBe(true);
  });
});

describe('redactToken', () => {
  it('removes the configured token and anything that looks like a GitLab token', () => {
    expect(redactToken(`a ${TOKEN} b glpat-abcdefghij12 c`, TOKEN)).toBe('a [token] b [token] c');
    expect(redactToken('nothing here', TOKEN)).toBe('nothing here');
    expect(redactToken('glpat-abcdefghij12', '')).toBe('[token]');
  });
});
