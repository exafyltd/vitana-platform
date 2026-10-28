/**
 * VTID-04790: Dev Autopilot scope matching.
 *
 * Live on staging (FB-2026-10-000143) Devon's spec named a NEW test,
 * services/gateway/test/get-current-screen-auth-transition.test.ts. The old
 * matcher turned `**\/` into `.*` and dropped the slash, so the deny rule
 * `**\/auth*` matched any file NAME containing "auth": the test was dropped
 * and the safety gate refused the plan as tests_missing.
 *
 * Owner decision: correct the matcher, keep every auth file locked exactly
 * as before (deny rules rewritten to `**\/*auth*` etc.), and let a NEW test
 * file carry such a name. An existing test with such a name stays locked.
 */
import { execSync } from 'child_process';
import * as path from 'path';
import {
  matchGlob,
  isDeniedPath,
  isNameOnlyRule,
  newFileCandidates,
  evaluateSafetyGate,
  type SafetyContext,
} from '../src/services/dev-autopilot-safety';
import { checkChangedFilesScope } from '../src/services/autopilot-agent/agent-scope';
import { confirmNewFiles } from '../src/services/dev-autopilot-execute';

/** The live deny scope after the migration (20261001140000). */
const LIVE_DENY = [
  'supabase/migrations/**',
  '**/*auth*',
  '.github/workflows/**',
  'services/gateway/src/lib/supabase.ts',
  '**/*.env*',
  '**/*credentials*',
];
const LIVE_ALLOW = ['services/gateway/src/**', 'services/gateway/test/**', 'docs/**', 'scripts/**'];

const NEW_AUTH_TEST = 'services/gateway/test/get-current-screen-auth-transition.test.ts';

/** The matcher before VTID-04790, kept here only to prove equivalence. */
function oldMatch(p: string, pattern: string): boolean {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i += 2; if (pattern[i] === '/') i += 1; continue; }
      re += '[^/]*'; i += 1; continue;
    }
    if (c === '?') { re += '[^/]'; i += 1; continue; }
    if ('.+^$(){}|[]\\'.includes(c)) { re += '\\' + c; i += 1; continue; }
    re += c; i += 1;
  }
  return new RegExp('^' + re + '$').test(p);
}

describe('VTID-04790 matchGlob follows normal glob rules', () => {
  it('`**/` stands for whole directories, not part of a file name', () => {
    expect(matchGlob('services/gateway/src/routes/auth.ts', '**/auth*')).toBe(true);
    expect(matchGlob('auth.ts', '**/auth*')).toBe(true);
    expect(matchGlob('services/gateway/src/services/oauth2.ts', '**/auth*')).toBe(false);
    expect(matchGlob(NEW_AUTH_TEST, '**/auth*')).toBe(false);
  });

  it('`a/**/b` matches b directly under a and at any depth', () => {
    expect(matchGlob('a/b', 'a/**/b')).toBe(true);
    expect(matchGlob('a/x/y/b', 'a/**/b')).toBe(true);
    expect(matchGlob('a/xb', 'a/**/b')).toBe(false);
  });

  it('a trailing `**` still covers everything below', () => {
    expect(matchGlob('services/gateway/src/x/y.ts', 'services/gateway/src/**')).toBe(true);
    expect(matchGlob('services/gateway/srcx/y.ts', 'services/gateway/src/**')).toBe(false);
  });
});

describe('VTID-04790 every file the old rules locked is still locked', () => {
  // Real repository paths; the rewrite must deny exactly the same set.
  const repoRoot = path.resolve(__dirname, '../../..');
  let files: string[] = [];
  try {
    files = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean);
  } catch { /* no git in this environment: the fixed list below still runs */ }

  const rewrites: Array<[string, string]> = [
    ['**/auth*', '**/*auth*'],
    ['**/.env*', '**/*.env*'],
    ['**/credentials*', '**/*credentials*'],
    ['**/orb-live.ts', '**/*orb-live.ts'],
  ];

  it.each(rewrites)('%s (old matcher) and %s (new matcher) deny the same repository files', (oldRule, newRule) => {
    const sample = files.length > 0 ? files : [NEW_AUTH_TEST, 'services/gateway/src/lib/oauth-state.ts'];
    const before = sample.filter((f) => oldMatch(f, oldRule));
    const after = sample.filter((f) => matchGlob(f, newRule));
    expect(after).toEqual(before);
  });

  it.each([
    'services/gateway/src/connectors/runtime/oauth2.ts',
    'services/gateway/src/lib/oauth-state.ts',
    'services/gateway/src/lib/tenant-role-auth.ts',
    'services/gateway/src/routes/auth.ts',
    'services/gateway/src/routes/dev-auth.ts',
    'services/gateway/src/middleware/auth-supabase-jwt.ts',
    'services/gateway/src/services/cognito-auth-client.ts',
    'services/gateway/src/services/oauth-token-refresher.ts',
    'services/gateway/src/services/operator-execute-authz.ts',
    'services/gateway/src/services/operator-machine-auth.ts',
  ])('%s is denied, new or not', (file) => {
    expect(isDeniedPath(file, LIVE_DENY)).toBe(true);
    expect(isDeniedPath(file, LIVE_DENY, { isNewFile: true })).toBe(true);
  });
});

describe('VTID-04790 the new-test-file exemption', () => {
  it('a NEW test file caught only by a name rule is not denied', () => {
    expect(isDeniedPath(NEW_AUTH_TEST, LIVE_DENY, { isNewFile: true })).toBe(false);
  });

  it('the same test file is denied when it already exists', () => {
    expect(isDeniedPath(NEW_AUTH_TEST, LIVE_DENY, { isNewFile: false })).toBe(true);
    expect(isDeniedPath('services/gateway/test/vtid-03851-execute-task-requires-auth.test.ts', LIVE_DENY)).toBe(true);
  });

  it('directory and exact-path rules have no exemption', () => {
    expect(isDeniedPath('supabase/migrations/x.test.ts', LIVE_DENY, { isNewFile: true })).toBe(true);
    expect(isDeniedPath('.github/workflows/auth.test.ts', LIVE_DENY, { isNewFile: true })).toBe(true);
  });

  it('only `**/<name>` rules count as name-only', () => {
    expect(LIVE_DENY.filter(isNameOnlyRule)).toEqual(['**/*auth*', '**/*.env*', '**/*credentials*']);
  });

  it('only test files caught by name rules alone need a repository lookup', () => {
    expect(newFileCandidates([
      NEW_AUTH_TEST,
      'services/gateway/src/services/oauth2.ts',
      'services/gateway/test/diary.test.ts',
      'supabase/migrations/auth.test.ts',
    ], LIVE_DENY)).toEqual([NEW_AUTH_TEST]);
  });
});

describe('VTID-04790 safety gate', () => {
  const ctx = (newFiles: string[] = []): SafetyContext => ({
    config: { kill_switch: false, daily_budget: 10, concurrency_cap: 2, max_auto_fix_depth: 2, allow_scope: LIVE_ALLOW, deny_scope: LIVE_DENY },
    approved_today: 0,
    auto_fix_depth: 0,
    new_files: newFiles,
  });
  const plan = {
    risk_class: 'medium' as const,
    files_to_modify: ['services/gateway/src/services/screen-context.ts', NEW_AUTH_TEST],
  };

  it('passes the FB-2026-10-000143 plan when its test file is confirmed new', () => {
    expect(evaluateSafetyGate(plan, ctx([NEW_AUTH_TEST]))).toEqual({ ok: true, violations: [] });
  });

  it('refuses it when the test file is not confirmed new', () => {
    const d = evaluateSafetyGate(plan, ctx());
    expect(d.ok).toBe(false);
    expect(d.violations.map((v) => v.code)).toContain('file_in_deny_scope');
  });

  it('a confirmed-new auth SOURCE file is still refused', () => {
    const p = { risk_class: 'medium' as const, files_to_modify: ['services/gateway/src/services/new-auth-helper.ts', 'services/gateway/test/x.test.ts'] };
    const d = evaluateSafetyGate(p, ctx(['services/gateway/src/services/new-auth-helper.ts']));
    expect(d.violations.map((v) => v.code)).toContain('file_in_deny_scope');
  });
});

describe('VTID-04790 post-hoc check on the agent diff', () => {
  it('a test file the agent created passes; editing an existing one does not', () => {
    expect(checkChangedFilesScope([{ path: NEW_AUTH_TEST, action: 'create' }], LIVE_ALLOW, LIVE_DENY).ok).toBe(true);
    const edited = checkChangedFilesScope([{ path: NEW_AUTH_TEST, action: 'modify' }], LIVE_ALLOW, LIVE_DENY);
    expect(edited.ok).toBe(false);
    expect(edited.in_deny).toEqual([NEW_AUTH_TEST]);
  });

  it('a created auth source file is still refused', () => {
    const r = checkChangedFilesScope([{ path: 'services/gateway/src/services/new-auth.ts', action: 'create' }], LIVE_ALLOW, LIVE_DENY);
    expect(r.in_deny).toEqual(['services/gateway/src/services/new-auth.ts']);
  });
});

describe('VTID-04790 confirmNewFiles', () => {
  it('reports a file as new only when the lookup says it does not exist', async () => {
    const lookup = jest.fn(async (p: string) => (p === NEW_AUTH_TEST ? { exists: false } : { exists: true }));
    expect(await confirmNewFiles([NEW_AUTH_TEST, 'services/gateway/test/a-auth.test.ts'], LIVE_DENY, lookup))
      .toEqual([NEW_AUTH_TEST]);
  });

  it('fails closed on a lookup error or exception', async () => {
    expect(await confirmNewFiles([NEW_AUTH_TEST], LIVE_DENY, async () => ({ exists: false, error: 'GitHub 500' }))).toEqual([]);
    expect(await confirmNewFiles([NEW_AUTH_TEST], LIVE_DENY, async () => { throw new Error('network'); })).toEqual([]);
  });

  it('does not look up files whose verdict cannot change', async () => {
    const lookup = jest.fn(async () => ({ exists: false }));
    await confirmNewFiles(['services/gateway/src/services/oauth2.ts', 'services/gateway/test/diary.test.ts'], LIVE_DENY, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});
