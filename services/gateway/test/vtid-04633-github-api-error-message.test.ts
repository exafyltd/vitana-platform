/**
 * VTID-04633: GitHub API errors carry GitHub's own message.
 *
 * Command Hub PUBLISH showed a bare "GitHub API error: 403 - Forbidden" after
 * the gateway's token moved to vitana/github/pat, which lacked permission to
 * dispatch workflows. The cause sat in GitHub's response body, which was
 * logged but never shown.
 */
import { formatGitHubApiError, triggerWorkflow } from '../src/services/github-service';

describe('VTID-04633 formatGitHubApiError', () => {
  it('appends GitHub message to the status line', () => {
    const msg = formatGitHubApiError(
      403,
      'Forbidden',
      JSON.stringify({ message: 'Resource not accessible by personal access token', status: '403' }),
    );
    expect(msg).toBe('GitHub API error: 403 - Forbidden: Resource not accessible by personal access token');
  });

  it('keeps the prefix callers match on', () => {
    expect(formatGitHubApiError(404, 'Not Found', '{"message":"Not Found"}')).toBe('GitHub API error: 404 - Not Found');
    expect(formatGitHubApiError(404, 'Not Found', '{"message":"Not Found"}')).toContain('404');
  });

  it('falls back to the status line for non-JSON or empty bodies', () => {
    expect(formatGitHubApiError(502, 'Bad Gateway', '<html>oops</html>')).toBe('GitHub API error: 502 - Bad Gateway');
    expect(formatGitHubApiError(500, '', '')).toBe('GitHub API error: 500 - error');
  });

  it('bounds a long message', () => {
    const msg = formatGitHubApiError(422, 'Unprocessable Entity', JSON.stringify({ message: 'x'.repeat(1000) }));
    expect(msg.length).toBeLessThan(400);
  });
});

describe('VTID-04633 triggerWorkflow surfaces the 403 reason', () => {
  const realFetch = global.fetch;
  const realToken = process.env.GITHUB_SAFE_MERGE_TOKEN;
  afterEach(() => {
    global.fetch = realFetch;
    if (realToken === undefined) delete process.env.GITHUB_SAFE_MERGE_TOKEN;
    else process.env.GITHUB_SAFE_MERGE_TOKEN = realToken;
  });

  it('rejects with GitHub message', async () => {
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'test-token';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => JSON.stringify({ message: 'Resource not accessible by personal access token' }),
    }) as unknown as typeof fetch;

    await expect(
      triggerWorkflow('exafyltd/vitana-platform', 'AWS-PROD-DEPLOY-GATEWAY.yml', 'main', { reason: 'x' }),
    ).rejects.toThrow('GitHub API error: 403 - Forbidden: Resource not accessible by personal access token');
  });
});
