/**
 * VTID-03516: Autonomous-execution ownership gate
 *
 * Regression cover for the OASIS ledger-integrity incident: the worker-runner
 * was claiming VTIDs that Claude Code sessions had allocated for their OWN
 * in-session work, failing instantly (no ANTHROPIC_API_KEY on the AWS task
 * defs), and terminalizing them status='rejected' / terminal_outcome='failed'.
 * 24 of the last 80 VTIDs were recorded as failures for work that shipped.
 *
 * The eligibility tuple the worker-runner polls on — in_progress +
 * spec_status=approved + not terminal + unclaimed — is EXACTLY what CLAUDE.md
 * §4.1 tells every Claude Code session to write onto its own VTID. So the
 * gate below must be an allowlist ("is this the autonomous plane's own
 * work?"), never a denylist of session-looking rows.
 */

import { isAutonomousExecutionTask } from '../src/routes/worker-orchestrator';

describe('VTID-03516: isAutonomousExecutionTask', () => {
  describe('claims autonomous-plane work', () => {
    it('accepts the established self-healing producer', () => {
      expect(isAutonomousExecutionTask({ metadata: { source: 'self-healing' } })).toBe(true);
    });

    it('accepts an explicit autonomous_execution opt-in', () => {
      expect(isAutonomousExecutionTask({ metadata: { autonomous_execution: true } })).toBe(true);
    });

    it('accepts self-healing work carrying an autopilot bridge id', () => {
      expect(isAutonomousExecutionTask({
        metadata: { source: 'self-healing', autopilot_execution_id: 'exec-123' },
      })).toBe(true);
    });
  });

  describe('withholds session-owned work — the incident cases', () => {
    // These are the real metadata.source values observed on rejected rows.
    it.each([
      ['claude-code', 'VTID-03480 — orb_session_state fix, verified live in prod'],
      ['claude-code-session', 'VTID-03448 — CLAUDE.md governance rule, merged as PR #3016'],
      ['claude-session', 'VTID-03513 — AWS staging deploy fix'],
    ])('withholds metadata.source=%s (%s)', (source) => {
      expect(isAutonomousExecutionTask({ metadata: { source } })).toBe(false);
    });

    /**
     * The reason this gate cannot be a claude-* denylist. `metadata.source` is
     * free text and sessions write an ad-hoc label describing the task, so most
     * session-owned VTIDs never mention Claude at all. A denylist would have
     * withheld three strings and kept sweeping everything else.
     */
    it.each([
      'orb-voice',
      'aws-sns-gchat-alerts',
      'news-feed-newest-first',
      'gcp-aws-cutover-execution',
      'publish.api',
      'operator-chat',
      'api',
    ])('withholds ad-hoc session source %s (no claude marker to match on)', (source) => {
      expect(isAutonomousExecutionTask({ metadata: { source } })).toBe(false);
    });
  });

  describe('fails closed on absent or malformed metadata', () => {
    it.each([
      ['missing metadata', {}],
      ['null metadata', { metadata: null }],
      ['undefined metadata', { metadata: undefined }],
      ['empty metadata', { metadata: {} }],
      ['string metadata', { metadata: 'self-healing' as any }],
    ])('withholds on %s', (_label, task) => {
      expect(isAutonomousExecutionTask(task as any)).toBe(false);
    });

    it('does not accept a truthy non-true autonomous_execution value', () => {
      // Guards against a stringly-typed 'false' being read as opt-in.
      expect(isAutonomousExecutionTask({ metadata: { autonomous_execution: 'false' } })).toBe(false);
      expect(isAutonomousExecutionTask({ metadata: { autonomous_execution: 1 } })).toBe(false);
    });

    it('does not accept a source that merely contains self-healing', () => {
      expect(isAutonomousExecutionTask({ metadata: { source: 'not-self-healing' } })).toBe(false);
      expect(isAutonomousExecutionTask({ metadata: { source: 'self-healing-diagnosis' } })).toBe(false);
    });
  });

  describe('the gate is orthogonal to the pre-existing eligibility tuple', () => {
    /**
     * A session VTID satisfies every one of the old criteria. That is the whole
     * bug — the old predicate could not tell the two planes apart, so this test
     * pins that the new gate is what separates them.
     */
    const sessionVtidMeetingEveryOldCriterion = {
      vtid: 'VTID-03480',
      status: 'in_progress',
      spec_status: 'approved',
      is_terminal: false,
      claimed_by: null,
      metadata: { source: 'claude-code', allocated_at: '2026-08-03T20:08:23Z' },
    };

    it('withholds a row that passes every legacy eligibility check', () => {
      expect(sessionVtidMeetingEveryOldCriterion.status).toBe('in_progress');
      expect(sessionVtidMeetingEveryOldCriterion.spec_status).toBe('approved');
      expect(sessionVtidMeetingEveryOldCriterion.is_terminal).toBe(false);
      expect(sessionVtidMeetingEveryOldCriterion.claimed_by).toBeNull();

      expect(isAutonomousExecutionTask(sessionVtidMeetingEveryOldCriterion)).toBe(false);
    });

    it('still admits self-healing work with the same tuple', () => {
      expect(isAutonomousExecutionTask({
        ...sessionVtidMeetingEveryOldCriterion,
        metadata: { source: 'self-healing', autopilot_execution_id: 'exec-1' },
      })).toBe(true);
    });
  });
});
