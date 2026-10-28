/**
 * VTID-02641 — Tests for the plan-vs-diff coverage validator.
 *
 * The 2026-04-30 PR sweep had to close PR #1102: a "safety-gap-scanner-v1"
 * finding produced a plan that listed 4 files (approvals.ts, autopilot.ts,
 * admin/index.ts, safety-gap.ts) but the executor only created the empty
 * safety-gap.ts placeholder. The PR opened anyway as dead code.
 *
 * The existing 3a check inside runExecutionSession only catches the
 * inverse — files in the diff that are NOT in the plan. It is silent when
 * the diff covers a subset of the plan. This validator is the missing
 * fence: fail when coverage < 60%.
 */

import { validatePlanDiffCoverage } from '../src/services/dev-autopilot-execute';

describe('validatePlanDiffCoverage — VTID-02641', () => {
  it('passes when the diff covers every file in the plan', () => {
    const out = validatePlanDiffCoverage(
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    );
    expect(out.ok).toBe(true);
    expect(out.coverage).toBe(1);
    expect(out.coveredCount).toBe(3);
    expect(out.planCount).toBe(3);
    expect(out.missing).toEqual([]);
  });

  it('passes at exactly the threshold (3/5 = 0.6)', () => {
    const out = validatePlanDiffCoverage(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    );
    expect(out.ok).toBe(true);
    expect(out.coverage).toBeCloseTo(0.6);
    expect(out.missing).toEqual(['src/d.ts', 'src/e.ts']);
  });

  it('fails for the PR #1102 case: 4-file plan, 1-file diff (25% coverage)', () => {
    const out = validatePlanDiffCoverage(
      [
        'services/gateway/src/routes/approvals.ts',
        'services/gateway/src/routes/autopilot.ts',
        'services/gateway/src/routes/admin/index.ts',
        'services/gateway/src/services/safety-gap.ts',
      ],
      ['services/gateway/src/services/safety-gap.ts'],
    );
    expect(out.ok).toBe(false);
    expect(out.coverage).toBeCloseTo(0.25);
    expect(out.coveredCount).toBe(1);
    expect(out.missing).toHaveLength(3);
    expect(out.missing).toContain('services/gateway/src/routes/approvals.ts');
  });

  it('passes when 4/5 files covered (80%, the canonical "tests-only-skipped" case)', () => {
    const out = validatePlanDiffCoverage(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/d.test.ts'],
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
    );
    expect(out.ok).toBe(true);
    expect(out.coverage).toBeCloseTo(0.8);
  });

  it('fails when 1/3 files covered (33%)', () => {
    const out = validatePlanDiffCoverage(
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      ['src/a.ts'],
    );
    expect(out.ok).toBe(false);
    expect(out.coverage).toBeCloseTo(1 / 3);
    expect(out.missing).toEqual(['src/b.ts', 'src/c.ts']);
  });

  it('fails when no diff files match the plan (0% coverage)', () => {
    const out = validatePlanDiffCoverage(
      ['src/a.ts', 'src/b.ts'],
      ['src/x.ts'],
    );
    expect(out.ok).toBe(false);
    expect(out.coverage).toBe(0);
    expect(out.missing).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('passes for empty plan (defers to upstream "zero files" check)', () => {
    const out = validatePlanDiffCoverage([], ['src/x.ts']);
    expect(out.ok).toBe(true);
    expect(out.planCount).toBe(0);
  });

  it('passes for empty plan + empty diff', () => {
    const out = validatePlanDiffCoverage([], []);
    expect(out.ok).toBe(true);
  });

  it('extra files in the diff (beyond the plan) do not affect coverage in either direction', () => {
    // Out-of-scope files are caught by the existing 3a check, not this one.
    // This validator only measures plan->diff coverage, not the reverse.
    const out = validatePlanDiffCoverage(
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts', 'src/extra.ts'],
    );
    expect(out.ok).toBe(true);
    expect(out.coverage).toBe(1);
  });

  it('honors a custom threshold parameter', () => {
    // Strict 100% threshold rejects the canonical 80% pass case.
    const out = validatePlanDiffCoverage(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/d.test.ts'],
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      1.0,
    );
    expect(out.ok).toBe(false);
    expect(out.coverage).toBeCloseTo(0.8);
  });
});
