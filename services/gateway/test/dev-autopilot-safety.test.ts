/**
 * Tests for Developer Autopilot Safety Gate
 *
 * The gate is a pure function — unit tests cover every violation code and the
 * composite ok=true happy path.
 */

import {
  evaluateSafetyGate,
  matchGlob,
  isTestFile,
  SafetyConfig,
  SafetyContext,
  SafetyPlan,
} from '../src/services/dev-autopilot-safety';

const DEFAULT_CONFIG: SafetyConfig = {
  kill_switch: false,
  daily_budget: 10,
  concurrency_cap: 2,
  max_auto_fix_depth: 2,
  allow_scope: [
    'services/gateway/src/routes/**',
    'services/gateway/src/services/**',
    'services/gateway/src/types/**',
    'services/gateway/src/frontend/command-hub/**',
    'services/gateway/test/**',
    'services/gateway/tests/**',
    'services/agents/**',
  ],
  deny_scope: [
    'supabase/migrations/**',
    '**/auth*',
    '**/orb-live.ts',
    '.github/workflows/**',
    'services/gateway/src/lib/supabase.ts',
    '**/.env*',
    '**/credentials*',
  ],
};

const okCtx = (overrides: Partial<SafetyContext> = {}): SafetyContext => ({
  config: { ...DEFAULT_CONFIG },
  approved_today: 0,
  auto_fix_depth: 0,
  ...overrides,
});

const okPlan = (overrides: Partial<SafetyPlan> = {}): SafetyPlan => ({
  risk_class: 'low',
  files_to_modify: [
    'services/gateway/src/services/foo.ts',
    'services/gateway/test/foo.test.ts',
  ],
  ...overrides,
});

describe('matchGlob', () => {
  it('matches ** across segments', () => {
    expect(matchGlob('services/gateway/src/routes/x.ts', 'services/gateway/src/routes/**')).toBe(true);
    expect(matchGlob('services/gateway/src/routes/sub/x.ts', 'services/gateway/src/routes/**')).toBe(true);
  });

  it('rejects paths outside the pattern', () => {
    expect(matchGlob('services/agents/src/x.ts', 'services/gateway/src/routes/**')).toBe(false);
  });

  it('** matches zero segments too', () => {
    expect(matchGlob('services/agents/x.ts', 'services/agents/**')).toBe(true);
  });

  it('single * does not cross slashes', () => {
    expect(matchGlob('a/b', 'a/*')).toBe(true);
    expect(matchGlob('a/b/c', 'a/*')).toBe(false);
  });

  it('handles **/ prefix for deep deny patterns', () => {
    expect(matchGlob('services/gateway/src/routes/auth.ts', '**/auth*')).toBe(true);
    expect(matchGlob('services/gateway/src/lib/supabase.ts', 'services/gateway/src/lib/supabase.ts')).toBe(true);
  });
});

describe('isTestFile', () => {
  it('detects .test.ts and .spec.ts', () => {
    expect(isTestFile('services/gateway/test/foo.test.ts')).toBe(true);
    expect(isTestFile('src/bar.spec.tsx')).toBe(true);
  });

  it('detects __tests__ folders', () => {
    expect(isTestFile('src/__tests__/x.ts')).toBe(true);
    expect(isTestFile('src/tests/helper.ts')).toBe(true);
  });

  it('rejects normal sources', () => {
    expect(isTestFile('src/service.ts')).toBe(false);
    expect(isTestFile('src/routes/auth.ts')).toBe(false);
  });
});

describe('evaluateSafetyGate', () => {
  it('passes the happy path', () => {
    const d = evaluateSafetyGate(okPlan(), okCtx());
    expect(d.ok).toBe(true);
    expect(d.violations).toHaveLength(0);
  });

  it('short-circuits on kill switch', () => {
    const d = evaluateSafetyGate(okPlan(), okCtx({ config: { ...DEFAULT_CONFIG, kill_switch: true } }));
    expect(d.ok).toBe(false);
    expect(d.violations).toHaveLength(1);
    expect(d.violations[0].code).toBe('kill_switch_engaged');
  });

  it('blocks high-risk plans', () => {
    const d = evaluateSafetyGate(okPlan({ risk_class: 'high' }), okCtx());
    expect(d.ok).toBe(false);
    expect(d.violations.map(v => v.code)).toContain('risk_class_too_high');
  });

  it('blocks files outside allow-scope', () => {
    const d = evaluateSafetyGate(
      okPlan({
        files_to_modify: [
          'services/agents-new/x.ts',
          'services/gateway/test/foo.test.ts',
        ],
      }),
      okCtx(),
    );
    expect(d.ok).toBe(false);
    expect(d.violations.map(v => v.code)).toContain('file_outside_allow_scope');
  });

  it('blocks files in deny-scope (auth, migrations, orb-live, secrets)', () => {
    const d = evaluateSafetyGate(
      okPlan({
        files_to_modify: [
          'services/gateway/src/routes/auth.ts',
          'services/gateway/test/foo.test.ts',
        ],
      }),
      okCtx(),
    );
    expect(d.ok).toBe(false);
    expect(d.violations.map(v => v.code)).toContain('file_in_deny_scope');
  });

  it('requires a test file when there are non-deletion edits', () => {
    const d = evaluateSafetyGate(
      okPlan({
        files_to_modify: ['services/gateway/src/services/foo.ts'],
      }),
      okCtx(),
    );
    expect(d.ok).toBe(false);
    expect(d.violations.map(v => v.code)).toContain('tests_missing');
  });

  it('allows pure deletions without a new test file', () => {
    const d = evaluateSafetyGate(
      okPlan({
        files_to_modify: ['services/gateway/src/services/dead.ts'],
        files_to_delete: ['services/gateway/src/services/dead.ts'],
      }),
      okCtx(),
    );
    expect(d.ok).toBe(true);
  });

  it('blocks when daily budget is exhausted', () => {
    const d = evaluateSafetyGate(okPlan(), okCtx({ approved_today: 10 }));
    expect(d.ok).toBe(false);
    expect(d.violations.map(v => v.code)).toContain('daily_budget_exhausted');
  });

  it('blocks when auto_fix_depth cap is reached', () => {
    const d = evaluateSafetyGate(okPlan(), okCtx({ auto_fix_depth: 2 }));
    expect(d.ok).toBe(false);
    expect(d.violations.map(v => v.code)).toContain('max_auto_fix_depth_reached');
  });

  it('aggregates multiple violations when several rules fail', () => {
    const d = evaluateSafetyGate(
      okPlan({
        risk_class: 'high',
        files_to_modify: [
          'services/gateway/src/routes/auth.ts',
          'services/gateway/src/lib/supabase.ts',
        ],
      }),
      okCtx({ approved_today: 99 }),
    );
    expect(d.ok).toBe(false);
    const codes = d.violations.map(v => v.code).sort();
    expect(codes).toEqual(
      expect.arrayContaining([
        'risk_class_too_high',
        'file_in_deny_scope',
        'tests_missing',
        'daily_budget_exhausted',
      ]),
    );
  });
});
