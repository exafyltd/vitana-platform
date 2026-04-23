/**
 * Tests for the worker's GitHub REST client. We mock global fetch so the
 * tests don't actually talk to api.github.com — they verify URLs, methods,
 * headers, body encoding (especially the base64 content for PUT /contents),
 * and the error-recovery branches.
 */

import { fetchFileContent, getBranchSha, createBranch, putFileToBranch, deleteFileOnBranch, openPullRequest } from '../src/github';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];
let nextResponses: Array<{ status: number; body: unknown }>;
const realFetch = global.fetch;

beforeEach(() => {
  calls = [];
  nextResponses = [];
  process.env.GITHUB_SAFE_MERGE_TOKEN = 'test-token';
  // Re-implement fetch as a queue: each call pops the next response.
  global.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = nextResponses.shift();
    if (!next) throw new Error(`unexpected fetch call to ${String(url)} — no mock response queued`);
    const status = next.status;
    // Per spec, 204 responses cannot have a body — the Response constructor
    // will throw if you pass one.
    if (status === 204) return new Response(null, { status });
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(body, { status });
  }) as typeof fetch;
});

afterEach(() => { global.fetch = realFetch; });

function queueResponse(status: number, body: unknown) {
  nextResponses.push({ status, body });
}

describe('fetchFileContent', () => {
  it('decodes base64 content + returns sha when file exists', async () => {
    const content = 'export const x = 1;\n';
    queueResponse(200, {
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
      sha: 'abc123',
    });
    const r = await fetchFileContent('services/gateway/src/foo.ts', 'main');
    expect(r.exists).toBe(true);
    expect(r.content).toBe(content);
    expect(r.sha).toBe('abc123');
    expect(calls[0].url).toContain('/contents/services/gateway/src/foo.ts');
    expect(calls[0].url).toContain('ref=main');
  });

  it('returns exists:false on 404 (file not yet created)', async () => {
    queueResponse(404, 'Not Found');
    const r = await fetchFileContent('services/gateway/src/new.ts', 'main');
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('surfaces error on non-404 failure', async () => {
    queueResponse(500, 'oops');
    const r = await fetchFileContent('a.ts', 'main');
    expect(r.exists).toBe(false);
    expect(r.error).toContain('500');
  });

  it('URL-encodes path segments', async () => {
    queueResponse(200, { content: '', encoding: 'base64', sha: 'x' });
    await fetchFileContent('services/gateway/src/with space.ts', 'main');
    expect(calls[0].url).toContain('with%20space.ts');
  });
});

describe('createBranch', () => {
  it('looks up base sha, creates branch when target does not exist', async () => {
    queueResponse(200, { object: { sha: 'base-sha-deadbeef' } }); // base lookup
    queueResponse(404, 'Not Found');                               // target lookup → doesn't exist
    queueResponse(201, { ref: 'refs/heads/test', object: { sha: 'base-sha-deadbeef' } });
    const r = await createBranch('test', 'main');
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2].init.method).toBe('POST');
    expect(JSON.parse(calls[2].init.body as string)).toEqual({
      ref: 'refs/heads/test',
      sha: 'base-sha-deadbeef',
    });
  });

  it('deletes a stale branch + recreates when target already exists', async () => {
    queueResponse(200, { object: { sha: 'base' } }); // base lookup
    queueResponse(200, { object: { sha: 'stale' } }); // target exists
    queueResponse(204, '');                            // DELETE
    queueResponse(201, { ref: 'refs/heads/test', object: { sha: 'base' } }); // create
    const r = await createBranch('test', 'main');
    expect(r.ok).toBe(true);
    expect(calls[2].init.method).toBe('DELETE');
  });

  it('errors clearly when base lookup fails', async () => {
    queueResponse(404, 'Not Found');
    const r = await createBranch('test', 'doesnt-exist');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('base branch lookup');
  });
});

describe('putFileToBranch', () => {
  it('base64-encodes content and includes branch + message', async () => {
    queueResponse(201, { content: { sha: 'new-sha' } });
    const r = await putFileToBranch('test', 'a.ts', 'export {};\n', 'commit msg', undefined);
    expect(r.ok).toBe(true);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.message).toBe('commit msg');
    expect(body.branch).toBe('test');
    expect(Buffer.from(body.content, 'base64').toString('utf-8')).toBe('export {};\n');
    expect(body.sha).toBeUndefined();
  });

  it('passes existingSha when modifying a file', async () => {
    queueResponse(200, { content: { sha: 'updated' } });
    const r = await putFileToBranch('test', 'a.ts', 'new', 'msg', 'old-sha');
    expect(r.ok).toBe(true);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.sha).toBe('old-sha');
  });

  it('surfaces error on 4xx/5xx', async () => {
    queueResponse(409, 'conflict');
    const r = await putFileToBranch('test', 'a.ts', 'x', 'msg');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('409');
  });
});

describe('deleteFileOnBranch', () => {
  it('sends DELETE with sha', async () => {
    queueResponse(200, { commit: { sha: 'x' } });
    const r = await deleteFileOnBranch('test', 'old.ts', 'msg', 'old-sha');
    expect(r.ok).toBe(true);
    expect(calls[0].init.method).toBe('DELETE');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.sha).toBe('old-sha');
    expect(body.branch).toBe('test');
  });
});

describe('openPullRequest', () => {
  it('returns the PR url + number on success', async () => {
    queueResponse(201, { html_url: 'https://github.com/foo/bar/pull/42', number: 42 });
    const r = await openPullRequest('test-branch', 'main', 'My PR', 'PR body markdown');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://github.com/foo/bar/pull/42');
    expect(r.number).toBe(42);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.head).toBe('test-branch');
    expect(body.base).toBe('main');
    expect(body.title).toBe('My PR');
  });

  it('clamps a very long title to 240 chars (GitHub limit)', async () => {
    queueResponse(201, { html_url: 'x', number: 1 });
    const longTitle = 'x'.repeat(500);
    await openPullRequest('b', 'main', longTitle, 'body');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.title.length).toBe(240);
  });

  it('surfaces error on 422 (invalid request)', async () => {
    queueResponse(422, 'no commits between branches');
    const r = await openPullRequest('b', 'main', 't', 'b');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('422');
  });
});

describe('auth', () => {
  it('refuses to make requests when no token is set', async () => {
    delete process.env.GITHUB_SAFE_MERGE_TOKEN;
    delete process.env.DEV_AUTOPILOT_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const r = await fetchFileContent('a.ts', 'main');
    expect(r.exists).toBe(false);
    expect(r.error).toMatch(/GITHUB_SAFE_MERGE_TOKEN not set/);
    expect(calls).toHaveLength(0); // never called fetch
  });
});
