/**
 * VTID-04006: post-hoc scope, jest target selection, porcelain parsing,
 * executor-mode resolution.
 */

import { checkChangedFilesScope, hasTestCoverage } from '../src/services/autopilot-agent/agent-scope';
import { projectDirFor, selectJestTargets } from '../src/services/autopilot-agent/agent-validate';
import { parsePorcelain, scrubSecret } from '../src/services/autopilot-agent/agent-workspace';
import { resolveExecutorMode } from '../src/services/autopilot-agent/executor-mode';
import { isTestFile } from '../src/services/dev-autopilot-safety';

const ALLOW = ['services/gateway/src/**', 'services/gateway/test/**', 'docs/**'];
const DENY = ['supabase/migrations/**', '**/auth*', '.github/workflows/**', '**/.env*'];

describe('VTID-04006 checkChangedFilesScope', () => {
  it('passes changes inside allow and outside deny', () => {
    const r = checkChangedFilesScope([
      { path: 'services/gateway/src/services/x.ts', action: 'modify' },
      { path: 'services/gateway/test/x.test.ts', action: 'create' },
    ], ALLOW, DENY);
    expect(r).toEqual({ ok: true, outside_allow: [], in_deny: [], reason: '' });
  });

  it('deny wins over allow; outside-allow is reported separately', () => {
    const r = checkChangedFilesScope([
      { path: 'services/gateway/src/middleware/auth.ts', action: 'modify' },   // allowed tree but **/auth* denied
      { path: '.github/workflows/X.yml', action: 'modify' },
      { path: 'services/worker-runner/index.ts', action: 'modify' },          // not in allow
      { path: 'services/gateway/src/services/ok.ts', action: 'modify' },
    ], ALLOW, DENY);
    expect(r.ok).toBe(false);
    expect(r.in_deny).toEqual(['services/gateway/src/middleware/auth.ts', '.github/workflows/X.yml']);
    expect(r.outside_allow).toEqual(['services/worker-runner/index.ts']);
    expect(r.reason).toMatch(/file_in_deny_scope: .*auth\.ts/);
    expect(r.reason).toMatch(/file_outside_allow_scope: services\/worker-runner\/index\.ts/);
  });

  it('runner-owned paths (evidence pack) are always permitted', () => {
    const r = checkChangedFilesScope([{ path: 'docs/validation/VTID-04006/acceptance.md', action: 'create' }], ['services/gateway/src/**'], DENY, ['docs/validation/VTID-04006/**']);
    expect(r.ok).toBe(true);
  });
});

describe('VTID-04006 hasTestCoverage', () => {
  it('requires a test file when there is any non-deletion edit', () => {
    expect(hasTestCoverage([{ path: 'services/gateway/src/a.ts', action: 'modify' }], isTestFile)).toBe(false);
    expect(hasTestCoverage([{ path: 'services/gateway/src/a.ts', action: 'modify' }, { path: 'services/gateway/test/a.test.ts', action: 'modify' }], isTestFile)).toBe(true);
    expect(hasTestCoverage([{ path: 'services/gateway/src/dead.ts', action: 'delete' }], isTestFile)).toBe(true);
  });
});

describe('VTID-04006 selectJestTargets / projectDirFor', () => {
  it('groups by project and pairs source files with their conventional test by basename', () => {
    expect(projectDirFor('services/gateway/src/x.ts')).toBe('services/gateway');
    expect(projectDirFor('docs/x.md')).toBeNull();
    const t = selectJestTargets([
      'services/gateway/src/services/dev-autopilot-watcher.ts',
      'services/gateway/test/dev-autopilot-watcher-failure-reason.test.ts',
      'docs/validation/VTID-1/acceptance.md',
      'services/worker-runner/src/services/execution-service.ts',
    ]);
    expect(t).toEqual([
      { project: 'services/gateway', patterns: ['dev-autopilot-watcher\\.(test|spec)\\.[jt]sx?$', 'test/dev-autopilot-watcher-failure-reason.test.ts'] },
      { project: 'services/worker-runner', patterns: ['execution-service\\.(test|spec)\\.[jt]sx?$'] },
    ]);
  });
});

describe('VTID-04006 parsePorcelain / scrubSecret', () => {
  it('maps git status codes to create/modify/delete and handles renames + quotes', () => {
    expect(parsePorcelain(' M services/gateway/src/a.ts\n?? services/gateway/test/new.test.ts\n D old.ts\nR  from.ts -> to.ts\n?? "sp ace.ts"\n')).toEqual([
      { path: 'services/gateway/src/a.ts', action: 'modify' },
      { path: 'services/gateway/test/new.test.ts', action: 'create' },
      { path: 'old.ts', action: 'delete' },
      { path: 'to.ts', action: 'modify' },
      { path: 'sp ace.ts', action: 'create' },
    ]);
    expect(parsePorcelain('')).toEqual([]);
  });
  it('scrubs the token from error text', () => {
    expect(scrubSecret('fatal: https://x-access-token:ghp_abc@github.com failed', 'ghp_abc')).toBe('fatal: https://x-access-token:***@github.com failed');
    expect(scrubSecret('x', undefined)).toBe('x');
  });
});

describe('VTID-04006 resolveExecutorMode', () => {
  it('defaults to single-shot; env selects agent; the row wins over env', () => {
    expect(resolveExecutorMode(null, {})).toBe('single-shot');
    expect(resolveExecutorMode({}, { DEV_AUTOPILOT_EXECUTOR: 'agent' })).toBe('agent');
    expect(resolveExecutorMode({ executor: 'agent' }, {})).toBe('agent');
    expect(resolveExecutorMode({ executor: 'single-shot' }, { DEV_AUTOPILOT_EXECUTOR: 'agent' })).toBe('single-shot');
    expect(resolveExecutorMode({ executor: 'weird' }, { DEV_AUTOPILOT_EXECUTOR: 'nope' })).toBe('single-shot');
  });
});
