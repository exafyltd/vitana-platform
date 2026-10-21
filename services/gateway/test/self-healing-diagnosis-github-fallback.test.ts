/**
 * PR-C (VTID-02916): GitHub source fallback for diagnosis.
 *
 * Cloud Run revisions don't carry the source tree under REPO_ROOT, so the
 * legacy `fs.existsSync(absolutePath)` check produced false negatives like
 * "route file does not exist". Diagnosis now resolves files in this order:
 *
 *   1. local fs (fastest)
 *   2. GitHub Contents API at the SHA the running container was built from
 *   3. GitHub Contents API at ref=main (last resort, may be drifted)
 *
 * The full file content is held in-memory only during diagnosis. For
 * persistence we keep route_file_source / route_file_sha / route_file_excerpt;
 * the content itself is stripped by `redactDiagnosisForPersistence()`.
 */

// fs is a built-in module — `jest.spyOn(fs, 'existsSync')` fails with
// "Cannot redefine property". Use a virtual mock so each test can override
// the behavior via `mockImplementation`.
jest.mock('fs', () => ({
  __esModule: true,
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

import * as fs from 'fs';
import type { Diagnosis } from '../src/types/self-healing';

const mockExists = fs.existsSync as unknown as jest.Mock;
const mockRead = fs.readFileSync as unknown as jest.Mock;

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_DEPLOYED_GIT_SHA = process.env.DEPLOYED_GIT_SHA;
const ORIGINAL_BUILD_SHA = process.env.BUILD_SHA;

beforeEach(() => {
  process.env.GITHUB_SAFE_MERGE_TOKEN = 'fake-token';
  delete process.env.DEPLOYED_GIT_SHA;
  delete process.env.BUILD_SHA;
  mockExists.mockReset();
  mockRead.mockReset();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_DEPLOYED_GIT_SHA !== undefined) process.env.DEPLOYED_GIT_SHA = ORIGINAL_DEPLOYED_GIT_SHA;
  if (ORIGINAL_BUILD_SHA !== undefined) process.env.BUILD_SHA = ORIGINAL_BUILD_SHA;
});

function loadModule() {
  return require('../src/services/self-healing-diagnosis-service') as {
    loadSourceFile: (file: string, cache?: Map<string, any>) => Promise<any>;
    redactDiagnosisForPersistence: (d: Diagnosis) => Diagnosis;
  };
}

describe('loadSourceFile', () => {
  it('returns source=fs and skips fetch when file exists on disk', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue('// source from fs\n');

    const { loadSourceFile } = loadModule();
    const result = await loadSourceFile('services/gateway/src/routes/availability.ts');

    expect(result.found).toBe(true);
    expect(result.source).toBe('fs');
    expect(result.content).toContain('source from fs');
    expect(result.sha).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to GitHub at deployed SHA when fs misses + DEPLOYED_GIT_SHA is set', async () => {
    process.env.DEPLOYED_GIT_SHA = 'deadbeefcafef00ddeadbeefcafef00ddeadbeef';
    mockExists.mockReturnValue(false);

    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: Buffer.from('// fetched from github\n').toString('base64'),
        encoding: 'base64',
        sha: 'aaa1111bbb2222ccc3333',
      }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { loadSourceFile } = loadModule();
    const result = await loadSourceFile('services/gateway/src/routes/availability.ts');

    expect(result.found).toBe(true);
    expect(result.source).toBe('github_deployed_sha');
    expect(result.content).toContain('fetched from github');
    expect(result.sha).toBe('aaa1111bbb2222ccc3333');
    const calledUrl = String((fetchSpy.mock.calls[0] as any[])[0]);
    expect(calledUrl).toContain('ref=deadbeefcafef00ddeadbeefcafef00ddeadbeef');
  });

  it('reads BUILD_INFO from disk when no env var is set', async () => {
    const buildInfoPathSuffix = '/BUILD_INFO';
    mockExists.mockImplementation((p: any) => String(p).endsWith(buildInfoPathSuffix));
    mockRead.mockImplementation((p: any) => {
      if (String(p).endsWith(buildInfoPathSuffix)) {
        return '{"sha":"buildinfo-sha-1234","deployed_at":"2026-05-11T10:00:00Z","role":"gateway"}';
      }
      throw new Error('ENOENT');
    });

    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: Buffer.from('// via BUILD_INFO\n').toString('base64'),
        encoding: 'base64',
        sha: 'response-sha',
      }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { loadSourceFile } = loadModule();
    const result = await loadSourceFile('services/gateway/src/routes/availability.ts');

    expect(result.source).toBe('github_deployed_sha');
    expect(String((fetchSpy.mock.calls[0] as any[])[0])).toContain('ref=buildinfo-sha-1234');
  });

  it('falls back to ref=main when BUILD_INFO is missing', async () => {
    mockExists.mockReturnValue(false);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: Buffer.from('// from main\n').toString('base64'),
        encoding: 'base64',
        sha: 'main-head-sha',
      }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { loadSourceFile } = loadModule();
    const result = await loadSourceFile('services/gateway/src/routes/availability.ts');

    expect(result.found).toBe(true);
    expect(result.source).toBe('github_main');
    expect(result.content).toContain('from main');
    const calledUrl = String((fetchSpy.mock.calls[0] as any[])[0]);
    expect(calledUrl).toContain('ref=main');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fell back to ref=main'));

    warnSpy.mockRestore();
  });

  it('returns found=false when both GitHub fetches return non-OK', async () => {
    mockExists.mockReturnValue(false);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;

    const { loadSourceFile } = loadModule();
    const result = await loadSourceFile('services/gateway/src/routes/missing.ts');

    expect(result.found).toBe(false);
    expect(result.content).toBeUndefined();
  });

  it('uses the request-scoped cache to avoid double-fetching the same file', async () => {
    mockExists.mockReturnValue(false);
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: Buffer.from('// cached\n').toString('base64'),
        encoding: 'base64',
        sha: 'cached-sha',
      }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    const cache = new Map();

    const { loadSourceFile } = loadModule();
    await loadSourceFile('services/gateway/src/routes/x.ts', cache);
    await loadSourceFile('services/gateway/src/routes/x.ts', cache);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });
});

describe('redactDiagnosisForPersistence', () => {
  function makeDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
    return {
      service_name: 'Availability Health',
      endpoint: '/api/v1/availability/health',
      vtid: 'VTID-99999',
      failure_class: 'route_not_registered' as any,
      confidence: 0.85,
      root_cause: 'r',
      suggested_fix: 'f',
      auto_fixable: true,
      evidence: [],
      codebase_analysis: {
        route_file: 'services/gateway/src/routes/availability.ts',
        route_file_exists: true,
        route_file_content: 'A'.repeat(20_000),
        route_file_source: 'github_deployed_sha',
        route_file_sha: 'abc1234',
        route_file_excerpt: 'export const router = ...',
        health_handler_exists: true,
        handler_has_errors: false,
        error_description: null,
        router_export_name: 'router',
        imports: [],
        env_vars_used: [],
        supabase_tables_used: [],
        related_service_files: [],
        files_read: ['services/gateway/src/routes/availability.ts'],
        evidence: [],
      },
      git_analysis: null,
      dependency_analysis: null,
      workflow_analysis: null,
      files_to_modify: [],
      files_read: [],
      ...overrides,
    };
  }

  it('strips route_file_content but keeps source / sha / excerpt', () => {
    const { redactDiagnosisForPersistence } = loadModule();
    const diag = makeDiagnosis();
    const redacted = redactDiagnosisForPersistence(diag);

    expect(redacted.codebase_analysis?.route_file_content).toBeNull();
    expect(redacted.codebase_analysis?.route_file_source).toBe('github_deployed_sha');
    expect(redacted.codebase_analysis?.route_file_sha).toBe('abc1234');
    expect(redacted.codebase_analysis?.route_file_excerpt).toBe('export const router = ...');
    expect(redacted.codebase_analysis?.route_file).toBe('services/gateway/src/routes/availability.ts');
  });

  it('does not mutate the original diagnosis object', () => {
    const { redactDiagnosisForPersistence } = loadModule();
    const diag = makeDiagnosis();
    const before = diag.codebase_analysis!.route_file_content;
    redactDiagnosisForPersistence(diag);
    expect(diag.codebase_analysis!.route_file_content).toBe(before);
  });

  it('passes through diagnoses without codebase_analysis untouched', () => {
    const { redactDiagnosisForPersistence } = loadModule();
    const diag = makeDiagnosis({ codebase_analysis: null });
    const redacted = redactDiagnosisForPersistence(diag);
    expect(redacted).toEqual(diag);
  });
});
