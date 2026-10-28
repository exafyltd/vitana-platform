/**
 * VTID-03835/03836/03837: Operator Console read-only tools —
 * dev_search_codebase / dev_read_file (GitHub-backed codebase read),
 * dev_aws_ecs_status (read-only ECS status), dev_db_query (allowlisted
 * Supabase read). All four are role-gated dev_ tools (developer/admin
 * only) and each has its own independent kill switch defaulting OFF.
 */

jest.mock('node-fetch');
jest.mock('../src/services/github-service', () => ({
  searchCode: jest.fn(),
  getFileContents: jest.fn(),
}));
jest.mock('../src/services/aws-ecs-readonly', () => ({
  describeEcsServices: jest.fn(),
  ALLOWED_ECS_SERVICES: ['vitana-gateway-awsdr', 'vitana-gateway'], ALLOWED_ECS_TASK_FAMILIES: ['vitana-autopilot-executor'], TASKS_DEFAULT_LIMIT: 10, TASKS_MAX_LIMIT: 25, listEcsTasks: jest.fn(),
}));
// gemini-operator.ts's own fetch calls (executeDevDbQuery included) go
// through its module-scoped `import fetch from 'node-fetch'` — NOT the
// global fetch that other services (e.g. oasis-event-service's telemetry)
// use. Mocking global.fetch alone would leave this file's own calls
// hitting the unconfigured node-fetch auto-mock instead. See the sibling
// vtid-03819-create-operator-task-dedup.test.ts for the same pattern.
import fetch from 'node-fetch';
import { executeTool, setThreadIdentity } from '../src/services/gemini-operator';
import { searchCode, getFileContents } from '../src/services/github-service';
import { describeEcsServices } from '../src/services/aws-ecs-readonly';

const mockedFetch = fetch as unknown as jest.Mock;
const mockedSearchCode = searchCode as jest.Mock;
const mockedGetFileContents = getFileContents as jest.Mock;
const mockedDescribeEcsServices = describeEcsServices as jest.Mock;

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as any;
}

describe('Operator Console read-only tools', () => {
  const ORIGINAL_ENV = process.env;
  const originalFetch = global.fetch;
  const DEV_THREAD = 'thread-dev-1';
  const NON_DEV_THREAD = 'thread-community-1';

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      OPERATOR_CODEBASE_READ_ENABLED: 'true',
      OPERATOR_AWS_READONLY_ENABLED: 'true',
      OPERATOR_DB_READONLY_ENABLED: 'true',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE: 'test-key',
    };
    mockedFetch.mockReset();
    mockedSearchCode.mockReset();
    mockedGetFileContents.mockReset();
    mockedDescribeEcsServices.mockReset();
    setThreadIdentity(DEV_THREAD, { tenant_id: 't1', user_id: 'u1', role: 'developer' });
    setThreadIdentity(NON_DEV_THREAD, { tenant_id: 't1', user_id: 'u2', role: 'community' });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    global.fetch = originalFetch;
  });

  describe('role gating (defense-in-depth, VTID-DEV-ASSIST pattern)', () => {
    it.each([
      ['dev_search_codebase', { query: 'foo' }],
      ['dev_read_file', { path: 'README.md' }],
      ['dev_aws_ecs_status', { service_name: 'vitana-gateway-awsdr' }],
      ['dev_db_query', { table: 'vtid_ledger' }],
    ])('blocks %s for a non-developer role', async (toolName, args) => {
      const result = await executeTool(toolName, args, NON_DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Access denied/);
    });
  });

  describe('dev_search_codebase (VTID-03835)', () => {
    it('rejects when the kill switch is not "true" (default OFF)', async () => {
      delete process.env.OPERATOR_CODEBASE_READ_ENABLED;
      const result = await executeTool('dev_search_codebase', { query: 'foo' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/operator_codebase_read_disabled/);
      expect(mockedSearchCode).not.toHaveBeenCalled();
    });

    it('searches the default repo and returns results', async () => {
      mockedSearchCode.mockResolvedValue([
        { path: 'services/gateway/src/x.ts', name: 'x.ts', html_url: 'https://github.com/x', score: 1 },
      ]);
      const result = await executeTool('dev_search_codebase', { query: 'executeTool', path_glob: 'services/gateway' }, DEV_THREAD);
      expect(result.ok).toBe(true);
      expect(mockedSearchCode).toHaveBeenCalledWith('exafyltd/vitana-platform', 'executeTool', 'services/gateway');
      expect((result.data as any).results).toHaveLength(1);
    });

    it('rejects an empty query without calling GitHub', async () => {
      const result = await executeTool('dev_search_codebase', { query: '  ' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(mockedSearchCode).not.toHaveBeenCalled();
    });

    it('surfaces a GitHub API failure as a tool error, not a throw', async () => {
      mockedSearchCode.mockRejectedValue(new Error('GitHub API error: 403 - rate limited'));
      const result = await executeTool('dev_search_codebase', { query: 'foo' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/rate limited/);
    });
  });

  describe('dev_read_file (VTID-03835)', () => {
    it('rejects when the kill switch is not "true" (default OFF)', async () => {
      delete process.env.OPERATOR_CODEBASE_READ_ENABLED;
      const result = await executeTool('dev_read_file', { path: 'README.md' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/operator_codebase_read_disabled/);
      expect(mockedGetFileContents).not.toHaveBeenCalled();
    });

    it('defaults ref to "main" when omitted', async () => {
      mockedGetFileContents.mockResolvedValue({ path: 'README.md', type: 'file', content: 'hi', size: 2, sha: 'abc' });
      const result = await executeTool('dev_read_file', { path: 'README.md' }, DEV_THREAD);
      expect(result.ok).toBe(true);
      expect(mockedGetFileContents).toHaveBeenCalledWith('exafyltd/vitana-platform', 'README.md', 'main');
    });

    it('passes an explicit ref through unchanged', async () => {
      mockedGetFileContents.mockResolvedValue({ path: 'README.md', type: 'file', content: 'hi', size: 2, sha: 'abc' });
      await executeTool('dev_read_file', { path: 'README.md', ref: 'a-feature-branch' }, DEV_THREAD);
      expect(mockedGetFileContents).toHaveBeenCalledWith('exafyltd/vitana-platform', 'README.md', 'a-feature-branch');
    });

    it('surfaces a file-too-large error as a tool error', async () => {
      mockedGetFileContents.mockRejectedValue(new Error('File too large or unsupported for inline read at big.bin (size=5000000)'));
      const result = await executeTool('dev_read_file', { path: 'big.bin' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/too large/);
    });
  });

  describe('dev_aws_ecs_status (VTID-03836)', () => {
    it('rejects when the kill switch is not "true" (default OFF) — the shipped default', async () => {
      delete process.env.OPERATOR_AWS_READONLY_ENABLED;
      const result = await executeTool('dev_aws_ecs_status', { service_name: 'vitana-gateway-awsdr' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/operator_aws_readonly_disabled/);
      expect(mockedDescribeEcsServices).not.toHaveBeenCalled();
    });

    it('returns the described service status', async () => {
      mockedDescribeEcsServices.mockResolvedValue([
        { serviceName: 'vitana-gateway-awsdr', status: 'ACTIVE', desiredCount: 2, runningCount: 2, pendingCount: 0, taskDefinition: 'vitana-gateway-awsdr:42', deployments: [] },
      ]);
      const result = await executeTool('dev_aws_ecs_status', { service_name: 'vitana-gateway-awsdr' }, DEV_THREAD);
      expect(result.ok).toBe(true);
      expect((result.data as any).runningCount).toBe(2);
    });

    it('reports not-found when AWS returns no matching service', async () => {
      mockedDescribeEcsServices.mockResolvedValue([]);
      const result = await executeTool('dev_aws_ecs_status', { service_name: 'vitana-gateway-awsdr' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });
  });

  describe('dev_db_query (VTID-03837)', () => {
    it('rejects when the kill switch is not "true" (default OFF)', async () => {
      delete process.env.OPERATOR_DB_READONLY_ENABLED;
      const result = await executeTool('dev_db_query', { table: 'vtid_ledger' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/operator_db_readonly_disabled/);
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('rejects a table not on the allowlist without ever calling Supabase', async () => {
      const result = await executeTool('dev_db_query', { table: 'app_users' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Table not allowed/);
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('queries the allowlisted table with a capped limit', async () => {
      mockedFetch.mockResolvedValue(jsonRes(200, [{ vtid: 'VTID-03835' }]));
      const result = await executeTool('dev_db_query', { table: 'vtid_ledger', limit: 500 }, DEV_THREAD);
      expect(result.ok).toBe(true);
      const calledUrl = mockedFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/rest/v1/vtid_ledger?');
      expect(calledUrl).toContain('limit=100'); // capped from 500
    });

    it('filters by vtid on vtid_ledger', async () => {
      mockedFetch.mockResolvedValue(jsonRes(200, []));
      await executeTool('dev_db_query', { table: 'vtid_ledger', vtid: 'VTID-03835' }, DEV_THREAD);
      const calledUrl = mockedFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('vtid=eq.VTID-03835');
    });

    it('refuses a vtid filter on a table with no vtid column', async () => {
      const result = await executeTool('dev_db_query', { table: 'dev_autopilot_plan_versions', vtid: 'VTID-03835' }, DEV_THREAD);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not support filtering by vtid/);
      expect(mockedFetch).not.toHaveBeenCalled();
    });
  });
});
