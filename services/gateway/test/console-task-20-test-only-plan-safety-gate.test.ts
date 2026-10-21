/**
 * VTID-04184 — Operator Console safety gate: a TEST-ONLY plan must never be
 * blocked by the gate's own `tests_missing` rule.
 *
 * Question this suite answers explicitly: given a plan whose `files_to_modify`
 * contains ONLY a single test file (e.g. a brand-new
 * `services/gateway/test/some-new.test.ts` adding coverage for existing code,
 * with no other file changed), does `tests_missing` fire?
 *
 * Reading of the current implementation (dev-autopilot-safety.ts, rule 4):
 *
 *   const nonDeletionEdits = plan.files_to_modify.filter(f => !deletions.has(f));
 *   if (nonDeletionEdits.length > 0) {
 *     const hasTestFile = plan.files_to_modify.some(isTestFile);
 *     if (!hasTestFile) violations.push({ code: 'tests_missing', ... });
 *   }
 *
 * The rule asks "are there any non-deletion edits?" and then "is at least one
 * of the modified files a test file?" — it never asks whether at least one of
 * the non-deletion edits is a NON-test file. So a plan whose only entry is
 * itself a test file satisfies `hasTestFile` on its own entry and passes. The
 * bug is therefore NOT real: no source change is needed for VTID-04184. This
 * suite pins that behaviour so a future rewrite of the rule (e.g. one that
 * inverts the check to "there must be a test file covering a source change")
 * cannot silently start blocking legitimate test-only plans.
 *
 * Config mirrors the live `dev_autopilot_config` allow/deny scopes
 * (docs/validation/VTID-04005/outputs/allow_scope_after.json) so the scope rule
 * is evaluated exactly as production does.
 */

import {
  evaluateSafetyGate,
  isTestFile,
  SafetyConfig,
  SafetyContext,
  SafetyPlan,
} from '../src/services/dev-autopilot-safety';

const LIVE_CONFIG: SafetyConfig = {
  kill_switch: false,
  daily_budget: 500,
  concurrency_cap: 2,
  max_auto_fix_depth: 2,
  allow_scope: [
    'config/**',
    'DATABASE_SCHEMA.md',
    'docs/**',
    'scripts/**',
    'services/agents/**',
    'services/autopilot-worker/**',
    'services/gateway/Dockerfile',
    'services/gateway/Dockerfile.job',
    'services/gateway/src/**',
    'services/gateway/src/frontend/command-hub/**',
    'services/gateway/src/lib/**',
    'services/gateway/src/orb/**',
    'services/gateway/src/routes/**',
    'services/gateway/src/services/**',
    'services/gateway/src/types/**',
    'services/gateway/test/**',
    'services/gateway/tests/**',
    'services/oasis-operator/**',
    'services/oasis-projector/**',
    'services/worker-runner/**',
  ],
  deny_scope: [
    'supabase/migrations/**',
    '**/auth*',
    '.github/workflows/**',
    'services/gateway/src/lib/supabase.ts',
    '**/.env*',
    '**/credentials*',
  ],
};

const ctx = (overrides: Partial<SafetyContext> = {}): SafetyContext => ({
  config: { ...LIVE_CONFIG },
  approved_today: 0,
  auto_fix_depth: 0,
  ...overrides,
});

const plan = (overrides: Partial<SafetyPlan> = {}): SafetyPlan => ({
  risk_class: 'low',
  files_to_modify: [],
  ...overrides,
});

const codesOf = (p: SafetyPlan, c: SafetyContext = ctx()): string[] =>
  evaluateSafetyGate(p, c).violations.map((v) => v.code);

describe('VTID-04184: test-only plan vs the tests_missing safety-gate rule', () => {
  it('AC-1: a plan whose files_to_modify is a single brand-new test file does NOT trigger tests_missing', () => {
    const onlyTestFile = 'services/gateway/test/some-new.test.ts';

    // Sanity: the path really is classified as a test file by the same
    // heuristic the rule uses — otherwise this test would pass vacuously for
    // a path that "looks" like a test but is not recognised as one.
    expect(isTestFile(onlyTestFile)).toBe(true);

    const decision = evaluateSafetyGate(plan({ files_to_modify: [onlyTestFile] }), ctx());

    expect(decision.violations.map((v) => v.code)).not.toContain('tests_missing');
    expect(decision.ok).toBe(true);
    expect(decision.violations).toHaveLength(0);
  });

  it('AC-1: holds for the pre-existing plan-based path (is_open_ended omitted) and when explicitly false', () => {
    const onlyTestFile = 'services/gateway/test/console-task-20-test-only-plan-safety-gate.test.ts';

    expect(codesOf(plan({ files_to_modify: [onlyTestFile] }))).not.toContain('tests_missing');
    expect(
      codesOf(plan({ files_to_modify: [onlyTestFile] }), ctx({ is_open_ended: false })),
    ).not.toContain('tests_missing');
  });

  it('AC-1: holds for `.spec.tsx` and `__tests__/` test-file shapes too', () => {
    for (const path of [
      'services/gateway/src/services/__tests__/helper.ts',
      'services/gateway/src/frontend/command-hub/thing.spec.tsx',
      'services/gateway/tests/legacy.test.js',
    ]) {
      expect(isTestFile(path)).toBe(true);
      expect(codesOf(plan({ files_to_modify: [path] }))).not.toContain('tests_missing');
    }
  });

  it('AC-1: a test-only plan with no source file is not blocked by scope or deny rules either', () => {
    const decision = evaluateSafetyGate(
      plan({ files_to_modify: ['services/gateway/test/a.test.ts'] }),
      ctx(),
    );
    expect(decision.ok).toBe(true);
  });

  it('regression: the rule is still live — adding one non-test path alongside the test file is not required, but a plan with ONLY a source file is still blocked', () => {
    expect(codesOf(plan({ files_to_modify: ['services/gateway/src/services/foo.ts'] }))).toContain(
      'tests_missing',
    );
  });

  it('regression: a non-test file alongside the test file keeps the test-coverage rule satisfied', () => {
    const codes = codesOf(
      plan({
        files_to_modify: [
          'services/gateway/src/services/foo.ts',
          'services/gateway/test/foo.test.ts',
        ],
      }),
    );
    expect(codes).not.toContain('tests_missing');
  });

  it('heuristic boundary: any path under a `test/` directory counts as a test file, so it satisfies the rule', () => {
    // Documented behaviour of TEST_FILE_PATTERNS: the /tests?/ directory
    // pattern is intentionally permissive. A helper under test/ is treated as
    // a test file and therefore satisfies the coverage rule — recorded here so
    // the boundary is explicit rather than accidental.
    const helper = 'services/gateway/test/helpers/test-fixture-data.ts';
    expect(isTestFile(helper)).toBe(true);
    expect(codesOf(plan({ files_to_modify: [helper] }))).not.toContain('tests_missing');
  });

  it('operational context: budget/fix-depth/kill-switch rules are unaffected by a test-only plan', () => {
    const onlyTestFile = 'services/gateway/test/some-new.test.ts';
    expect(
      codesOf(plan({ files_to_modify: [onlyTestFile] }), ctx({ approved_today: 500 })),
    ).toContain('daily_budget_exhausted');
    expect(
      codesOf(plan({ files_to_modify: [onlyTestFile] }), ctx({ auto_fix_depth: 2 })),
    ).toContain('max_auto_fix_depth_reached');
    expect(
      codesOf(
        plan({ files_to_modify: [onlyTestFile] }),
        ctx({ config: { ...LIVE_CONFIG, kill_switch: true } }),
      ),
    ).toContain('kill_switch_engaged');
  });
});
