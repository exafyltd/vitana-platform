/**
 * VTID-04116: dev_repowise / dev_graphify — the Operator Console's read-only
 * RepoWise + Graphify bridge. Pins the pure command/repo allowlists, the
 * not_configured shape on a missing binary, and the tool wiring: kill
 * switch, argument validation, honest error passthrough.
 */

jest.mock('node-fetch');
jest.mock('../src/services/github-service', () => ({ searchCode: jest.fn(), getFileContents: jest.fn(), listOpenPrsWithStatus: jest.fn() }));
jest.mock('../src/services/aws-ecs-readonly', () => ({ describeEcsServices: jest.fn(), ALLOWED_ECS_SERVICES: ['vitana-gateway'], ALLOWED_ECS_TASK_FAMILIES: ['vitana-autopilot-executor'], TASKS_DEFAULT_LIMIT: 10, TASKS_MAX_LIMIT: 25, listEcsTasks: jest.fn() }));
jest.mock('../src/services/aws-cloudwatch-logs-readonly', () => ({ filterVitanaLogs: jest.fn(), ALLOWED_LOG_GROUP_RE: /^\/ecs\/vitana-[a-z0-9-]{2,60}$/, LOGS_DEFAULT_MINUTES: 30, LOGS_MAX_MINUTES: 1440, LOGS_DEFAULT_LIMIT: 50, LOGS_MAX_LIMIT: 200 }));

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: unknown[]) => (execFileMock as any)(...args) }));

import { executeTool, setThreadIdentity } from '../src/services/gemini-operator';
import { isRepowiseCommand, isGraphifyCommand, resolveCodeintelRepoDir, ALLOWED_CODEINTEL_REPOS, runRepowise, runGraphify } from '../src/services/codeintel-readonly';

function mockExecFileResult(stdout: string) {
  execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: unknown, res: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout, stderr: '' });
  });
}

function mockExecFileEnoent() {
  execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
    cb(Object.assign(new Error('spawn repowise ENOENT'), { code: 'ENOENT' }));
  });
}

describe('VTID-04116 command/repo allowlists (pure)', () => {
  it('accepts only the documented repowise subcommands', () => {
    for (const good of ['ask', 'search', 'context', 'risk', 'health', 'why', 'status']) expect(isRepowiseCommand(good)).toBe(true);
    for (const bad of ['generate', 'init', 'delete', '', 'ASK']) expect(isRepowiseCommand(bad)).toBe(false);
  });

  it('accepts only the documented graphify subcommands', () => {
    for (const good of ['query', 'path', 'explain']) expect(isGraphifyCommand(good)).toBe(true);
    for (const bad of ['update', 'merge-graphs', '', 'QUERY']) expect(isGraphifyCommand(bad)).toBe(false);
  });

  it('resolves only the two documented repos, defaulting to vitana-platform', () => {
    expect(Object.keys(ALLOWED_CODEINTEL_REPOS)).toEqual(['exafyltd/vitana-platform', 'exafyltd/vitana-v1']);
    expect(resolveCodeintelRepoDir(undefined)).toBe(ALLOWED_CODEINTEL_REPOS['exafyltd/vitana-platform']);
    expect(resolveCodeintelRepoDir('exafyltd/vitana-v1')).toBe(ALLOWED_CODEINTEL_REPOS['exafyltd/vitana-v1']);
    expect(resolveCodeintelRepoDir('some/other-repo')).toBeNull();
  });
});

describe('VTID-04116 runRepowise / runGraphify (execFile boundary)', () => {
  beforeEach(() => execFileMock.mockReset());

  it('reports not_configured when the binary is not installed (ENOENT), never throws', async () => {
    mockExecFileEnoent();
    const result = await runRepowise('health', undefined, '/app');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not_configured/);
  });

  it('passes the free-text argument through to an allowlisted repowise subcommand, bounded', async () => {
    mockExecFileResult('some real repowise output');
    const result = await runRepowise('ask', 'why does X do Y', '/app');
    expect(result.ok).toBe(true);
    expect(result.output).toBe('some real repowise output');
    // VTID-04125: `--no-prose` is not a real option on any of the 7
    // allowlisted subcommands (confirmed live against `repowise --help`
    // for ask/search/context/risk/health/why/status — it exists only on
    // `init`) — appending it made every real invocation fail outright
    // with a CLI usage error, so it must never be on this argv again.
    expect(execFileMock).toHaveBeenCalledWith('repowise', ['ask', 'why does X do Y'], expect.any(Object), expect.any(Function));
  });

  it('graphify path requires two space-separated node names', async () => {
    const result = await runGraphify('path', 'OnlyOneNode', '/app');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/requires two node names/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('graphify path splits into source/target argv, never a shell string', async () => {
    mockExecFileResult('shortest path: A -> B');
    const result = await runGraphify('path', 'UserService DatabasePool', '/app');
    expect(result.ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith('graphify', ['path', 'UserService', 'DatabasePool'], expect.any(Object), expect.any(Function));
  });

  it('graphify query/explain refuse an empty argument before touching execFile', async () => {
    const result = await runGraphify('query', '  ', '/app');
    expect(result.ok).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('VTID-04116 dev_repowise / dev_graphify tool wiring', () => {
  const threadId = 'thread-codeintel-test';
  const prevEnabled = process.env.OPERATOR_CODEINTEL_ENABLED;

  beforeEach(() => {
    execFileMock.mockReset();
    setThreadIdentity(threadId, { tenant_id: 't1', user_id: 'u1', role: 'developer' });
  });

  afterAll(() => {
    if (prevEnabled === undefined) delete process.env.OPERATOR_CODEINTEL_ENABLED;
    else process.env.OPERATOR_CODEINTEL_ENABLED = prevEnabled;
  });

  it('refuses both tools when OPERATOR_CODEINTEL_ENABLED is not "true"', async () => {
    delete process.env.OPERATOR_CODEINTEL_ENABLED;
    const repowiseResult = await executeTool('dev_repowise', { command: 'health' }, threadId);
    expect(repowiseResult.ok).toBe(false);
    expect(repowiseResult.error).toMatch(/operator_codeintel_disabled/);
    const graphifyResult = await executeTool('dev_graphify', { command: 'query', argument: 'x' }, threadId);
    expect(graphifyResult.ok).toBe(false);
    expect(graphifyResult.error).toMatch(/operator_codeintel_disabled/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown command before calling the CLI, once enabled', async () => {
    process.env.OPERATOR_CODEINTEL_ENABLED = 'true';
    const result = await executeTool('dev_repowise', { command: 'rm -rf /' }, threadId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/command must be one of/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects an unlisted repo before calling the CLI', async () => {
    process.env.OPERATOR_CODEINTEL_ENABLED = 'true';
    const result = await executeTool('dev_graphify', { command: 'query', argument: 'auth', repo: 'someone/else' }, threadId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/repo must be one of/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns a real CLI result end to end once enabled and configured', async () => {
    process.env.OPERATOR_CODEINTEL_ENABLED = 'true';
    mockExecFileResult('God nodes: gemini-operator.ts (fan-in 42)');
    const result = await executeTool('dev_graphify', { command: 'explain', argument: 'gemini-operator.ts' }, threadId);
    expect(result.ok).toBe(true);
    expect((result.data as any).output).toContain('God nodes');
  });
});
