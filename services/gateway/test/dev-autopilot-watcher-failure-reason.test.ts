/**
 * VTID-04003 — unit tests for buildCiFailureReason().
 *
 * Regression context: PR #3351 (execution 0643b701). The CI gate used to
 * build its failure reason with an inline ternary whose `blocked` branch
 * returned the literal string 'branch-protection blocked' for every blocked
 * PR — even when the CI analyzer had already produced concrete failing check
 * names. GitHub reports `blocked` exactly when a REQUIRED check has failed,
 * so the real cause (e.g. `validate-pr`) was lost and the self-healing
 * triage agent invented a wrong root cause ("branch protection
 * misconfigured").
 *
 * The helper is pure, so we can exercise every branch directly.
 */

import { buildCiFailureReason } from '../src/services/dev-autopilot-watcher';

describe('buildCiFailureReason', () => {
  describe('blocked', () => {
    it('names every failing required check', () => {
      const reason = buildCiFailureReason('blocked', ['validate', 'validate-pr']);
      expect(reason).toContain('validate');
      expect(reason).toContain('validate-pr');
    });

    it('never blames branch protection when failing check names are available', () => {
      const reason = buildCiFailureReason('blocked', ['validate-pr']);
      expect(reason).not.toMatch(/branch protection/i);
    });

    it('falls back to the branch-protection explanation when no names are available', () => {
      const reason = buildCiFailureReason('blocked', []);
      expect(reason).toContain('branch protection');
    });
  });

  describe('dirty', () => {
    it('reports a merge conflict', () => {
      expect(buildCiFailureReason('dirty', [])).toBe('merge conflict (dirty)');
    });

    it('appends failing check names when present', () => {
      const reason = buildCiFailureReason('dirty', ['validate', 'lint']);
      expect(reason).toContain('merge conflict (dirty)');
      expect(reason).toContain('validate');
      expect(reason).toContain('lint');
    });
  });

  describe('unstable', () => {
    it('lists the failing names reported so far', () => {
      const reason = buildCiFailureReason('unstable', ['lint']);
      expect(reason).toContain('unstable');
      expect(reason).toContain('lint');
    });

    it('explains that no names have been reported yet', () => {
      const reason = buildCiFailureReason('unstable', []);
      expect(reason).toContain('unstable');
      expect(reason).toContain('(none reported yet — wait)');
    });
  });

  describe('other mergeable states', () => {
    it('names failing checks when a non-standard state has them', () => {
      expect(buildCiFailureReason('clean', ['validate'])).toBe('failing checks: validate');
    });

    it('describes an unrecognised state that has no failing checks', () => {
      expect(buildCiFailureReason('weird_state', [])).toBe('unexpected mergeable_state=weird_state');
    });
  });
});