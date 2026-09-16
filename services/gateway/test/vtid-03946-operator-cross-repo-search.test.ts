/**
 * VTID-03946 — dev_search_codebase/dev_read_file: cross-repo access to
 * exafyltd/vitana-v1, plus documenting GitHub code search's 384KB blind
 * spot on the Command Hub's own app.js.
 *
 * Reported live: a real Operator conversation asked to scope frontend work
 * searched only exafyltd/vitana-platform, found nothing under
 * services/gateway/src, and told the user "I don't yet see where the actual
 * console UI lives" — asking 8 clarifying questions for something the
 * codebase already answers. Two independent, stacked causes:
 *
 *   1. dev_search_codebase/dev_read_file were hardcoded to
 *      OPERATOR_DEFAULT_REPO ('exafyltd/vitana-platform') with no way to
 *      reach exafyltd/vitana-v1 at all — the repo holding most of the
 *      actual consumer-facing Vitana frontend.
 *   2. Even within vitana-platform, GitHub's Search Code API excludes any
 *      file over 384KB from its index. services/gateway/src/frontend/
 *      command-hub/app.js is ~2.5MB, so a search for literally anything
 *      inside it (confirmed live: searching "Operator Console" — a string
 *      the file itself contains — returned 263 hits across the repo and
 *      zero from app.js) always returns zero results, regardless of query
 *      wording. That is a tool limitation, not evidence the content is
 *      missing.
 *
 * Fix: both tools accept an optional allowlisted "repo" parameter
 * ('exafyltd/vitana-platform' default, or 'exafyltd/vitana-v1', reusing
 * the already-provisioned FRONTEND_DEPLOY_TOKEN rather than a new
 * credential) and the always-on codebase orientation block + both tool
 * descriptions now state the blind spot up front, so Operator doesn't
 * have to rediscover it turn after turn.
 */

jest.mock('node-fetch');
jest.mock('../src/services/github-service', () => ({
  searchCode: jest.fn(),
  getFileContents: jest.fn(),
}));
jest.mock('../src/services/aws-ecs-readonly', () => ({
  describeEcsServices: jest.fn(),
  ALLOWED_ECS_SERVICES: ['vitana-gateway-awsdr', 'vitana-gateway'],
}));

import { executeTool, setThreadIdentity } from '../src/services/gemini-operator';
import { searchCode, getFileContents } from '../src/services/github-service';

const mockedSearchCode = searchCode as jest.Mock;
const mockedGetFileContents = getFileContents as jest.Mock;

describe('VTID-03946: cross-repo dev_search_codebase/dev_read_file', () => {
  const ORIGINAL_ENV = process.env;
  const DEV_THREAD = 'thread-dev-1';

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      OPERATOR_CODEBASE_READ_ENABLED: 'true',
      FRONTEND_DEPLOY_TOKEN: 'test-v1-token',
    };
    mockedSearchCode.mockReset();
    mockedGetFileContents.mockReset();
    setThreadIdentity(DEV_THREAD, { tenant_id: 't1', user_id: 'u1', role: 'developer' });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('dev_search_codebase', () => {
    it('still defaults to vitana-platform with a 3-arg call when repo is omitted', async () => {
      mockedSearchCode.mockResolvedValue([]);
      await executeTool('dev_search_codebase', { query: 'foo' }, DEV_THREAD);
      expect(mockedSearchCode).toHaveBeenCalledWith('exafyltd/vitana-platform', 'foo', undefined);
    });

    it('routes to vitana-v1 with the FRONTEND_DEPLOY_TOKEN override when repo is passed', async () => {
      mockedSearchCode.mockResolvedValue([]);
      const result = await executeTool('dev_search_codebase', { query: 'CommandHubOperatorConsole', repo: 'exafyltd/vitana-v1' }, DEV_THREAD);
      expect(result.ok).toBe(true);
      expect(mockedSearchCode).toHaveBeenCalledWith('exafyltd/vitana-v1', 'CommandHubOperatorConsole', undefined, 'test-v1-token');
      expect((result.data as any).repo).toBe('exafyltd/vitana-v1');
    });

    it('rejects an unlisted repo without ever calling GitHub', async () => {
      const result = await executeTool('dev_search_codebase', { query: 'foo', repo: 'some-other-org/some-repo' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/unknown_repo/);
      expect(mockedSearchCode).not.toHaveBeenCalled();
    });

    it('fails loudly rather than silently using the wrong token when FRONTEND_DEPLOY_TOKEN is unset', async () => {
      delete process.env.FRONTEND_DEPLOY_TOKEN;
      const result = await executeTool('dev_search_codebase', { query: 'foo', repo: 'exafyltd/vitana-v1' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/repo_token_not_configured/);
      expect(mockedSearchCode).not.toHaveBeenCalled();
    });
  });

  describe('dev_read_file', () => {
    it('still defaults to vitana-platform with a 3-arg call when repo is omitted', async () => {
      mockedGetFileContents.mockResolvedValue({ path: 'README.md', type: 'file', content: 'hi', size: 2, sha: 'abc' });
      await executeTool('dev_read_file', { path: 'README.md' }, DEV_THREAD);
      expect(mockedGetFileContents).toHaveBeenCalledWith('exafyltd/vitana-platform', 'README.md', 'main');
    });

    it('routes to vitana-v1 with the FRONTEND_DEPLOY_TOKEN override when repo is passed', async () => {
      mockedGetFileContents.mockResolvedValue({ path: 'src/pages/Home.tsx', type: 'file', content: 'aGk=', size: 2, sha: 'def' });
      const result = await executeTool('dev_read_file', { path: 'src/pages/Home.tsx', repo: 'exafyltd/vitana-v1' }, DEV_THREAD);
      expect(result.ok).toBe(true);
      expect(mockedGetFileContents).toHaveBeenCalledWith('exafyltd/vitana-v1', 'src/pages/Home.tsx', 'main', 'test-v1-token');
    });

    it('rejects an unlisted repo without ever calling GitHub', async () => {
      const result = await executeTool('dev_read_file', { path: 'README.md', repo: 'not-allowlisted/repo' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/unknown_repo/);
      expect(mockedGetFileContents).not.toHaveBeenCalled();
    });

    it('fails loudly rather than silently using the wrong token when FRONTEND_DEPLOY_TOKEN is unset', async () => {
      delete process.env.FRONTEND_DEPLOY_TOKEN;
      const result = await executeTool('dev_read_file', { path: 'src/pages/Home.tsx', repo: 'exafyltd/vitana-v1' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/repo_token_not_configured/);
      expect(mockedGetFileContents).not.toHaveBeenCalled();
    });
  });
});
