/**
 * VTID-03835: github-service.ts's two new read-only functions —
 * searchCode() (GitHub Search Code API) and getFileContents() (GitHub
 * Contents API). Both back the Operator Console's dev_search_codebase /
 * dev_read_file tools tested separately in
 * vtid-03835-operator-console-read-tools.test.ts.
 */

// github-service.ts calls the Node built-in global `fetch` directly (it has
// no `import fetch from 'node-fetch'` of its own, unlike gemini-operator.ts)
// — mock global.fetch, not the node-fetch module.
import { searchCode, getFileContents } from '../src/services/github-service';

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  } as any;
}

describe('github-service read access (VTID-03835)', () => {
  const originalFetch = global.fetch;
  let mockedFetch: jest.Mock;

  beforeEach(() => {
    mockedFetch = jest.fn();
    global.fetch = mockedFetch as unknown as typeof fetch;
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'test-token';
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('searchCode', () => {
    it('builds a repo-scoped query and maps results', async () => {
      mockedFetch.mockResolvedValue(
        jsonRes(200, {
          total_count: 1,
          items: [{ path: 'services/gateway/src/x.ts', name: 'x.ts', html_url: 'https://github.com/x', score: 1.2 }],
        })
      );
      const results = await searchCode('exafyltd/vitana-platform', 'executeTool');
      const calledUrl = mockedFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/search/code?q=');
      expect(decodeURIComponent(calledUrl)).toContain('repo:exafyltd/vitana-platform');
      expect(results).toEqual([
        { path: 'services/gateway/src/x.ts', name: 'x.ts', html_url: 'https://github.com/x', score: 1.2 },
      ]);
    });

    it('adds an optional path qualifier', async () => {
      mockedFetch.mockResolvedValue(jsonRes(200, { total_count: 0, items: [] }));
      await searchCode('exafyltd/vitana-platform', 'foo', 'services/gateway/src/routes');
      const calledUrl = decodeURIComponent(mockedFetch.mock.calls[0][0] as string);
      expect(calledUrl).toContain('path:services/gateway/src/routes');
    });
  });

  describe('getFileContents', () => {
    it('decodes base64 file content', async () => {
      mockedFetch.mockResolvedValue(
        jsonRes(200, { content: Buffer.from('hello world').toString('base64'), encoding: 'base64', size: 11, sha: 'abc123' })
      );
      const result = await getFileContents('exafyltd/vitana-platform', 'README.md');
      expect(result).toEqual({ path: 'README.md', type: 'file', content: 'hello world', size: 11, sha: 'abc123' });
      const calledUrl = mockedFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/repos/exafyltd/vitana-platform/contents/README.md?ref=main');
    });

    it('defaults ref to main and strips a leading slash from the path', async () => {
      mockedFetch.mockResolvedValue(jsonRes(200, { content: Buffer.from('x').toString('base64'), encoding: 'base64', size: 1, sha: 's' }));
      await getFileContents('exafyltd/vitana-platform', '/README.md');
      const calledUrl = mockedFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/contents/README.md?ref=main');
    });

    it('returns a directory listing when the path is a directory', async () => {
      mockedFetch.mockResolvedValue(
        jsonRes(200, [
          { name: 'gemini-operator.ts', path: 'services/gateway/src/services/gemini-operator.ts', type: 'file' },
          { name: 'routes', path: 'services/gateway/src/routes', type: 'dir' },
        ])
      );
      const result = await getFileContents('exafyltd/vitana-platform', 'services/gateway/src');
      expect(result).toEqual({
        path: 'services/gateway/src',
        type: 'dir',
        entries: [
          { name: 'gemini-operator.ts', path: 'services/gateway/src/services/gemini-operator.ts', type: 'file' },
          { name: 'routes', path: 'services/gateway/src/routes', type: 'dir' },
        ],
      });
    });

    it('throws a clear error when the file is too large to inline', async () => {
      mockedFetch.mockResolvedValue(jsonRes(200, { size: 5_000_000, sha: 'big' }));
      await expect(getFileContents('exafyltd/vitana-platform', 'big.bin')).rejects.toThrow(/too large/);
    });
  });
});
