/**
 * Tests for the Autonomy Pulse aggregator.
 * Focuses on the pure sort/normalize logic — full HTTP flow is an integration test.
 */

import { aggregatePulse } from '../src/routes/autonomy-pulse';

const nowIso = () => new Date().toISOString();
const agoIso = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe('aggregatePulse', () => {
  it('returns an empty list when all sources are empty', () => {
    expect(aggregatePulse([], [], [])).toEqual([]);
  });

  it('normalizes a dev_autopilot finding into a pulse item with the right actions', () => {
    const items = aggregatePulse(
      [{
        id: 'f-1',
        title: 'Remove dead code in foo.ts',
        summary: 'Unused export',
        risk_class: 'low',
        impact_score: 4,
        effort_score: 2,
        auto_exec_eligible: true,
        domain: 'services',
        first_seen_at: nowIso(),
        seen_count: 1,
        spec_snapshot: { file_path: 'services/gateway/src/services/foo.ts' },
      }],
      [],
      [],
    );
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('dev_autopilot_finding');
    expect(items[0].actions).toEqual(['approve', 'view_plan', 'snooze', 'reject']);
    expect(items[0].severity).toBe('info');
    expect(items[0].metadata.file_path).toBe('services/gateway/src/services/foo.ts');
  });

  it('high-risk findings are marked critical and drop the approve action if not auto-exec-eligible', () => {
    const items = aggregatePulse(
      [{
        id: 'f-2',
        title: 'Refactor massive file',
        summary: 'Over 2000 lines',
        risk_class: 'high',
        impact_score: 9,
        effort_score: 8,
        auto_exec_eligible: false,
        domain: 'services',
        first_seen_at: nowIso(),
        seen_count: 1,
        spec_snapshot: null,
      }],
      [],
      [],
    );
    expect(items[0].severity).toBe('critical');
    expect(items[0].actions).not.toContain('approve');
    expect(items[0].actions).toContain('view_plan');
  });

  it('normalizes self_healing rows and extracts confidence from diagnosis', () => {
    const items = aggregatePulse(
      [],
      [{
        id: 'h-1',
        vtid: 'VTID-01999',
        endpoint: '/api/v1/orb/health',
        failure_class: 'timeout',
        created_at: agoIso(5),
        diagnosis: { confidence: 0.9, summary: 'VERTEX_PROJECT_ID drift' },
        attempt_number: 2,
      }],
      [],
    );
    expect(items[0].source).toBe('self_healing');
    expect(items[0].severity).toBe('critical');            // timeout → critical
    expect(items[0].actions[0]).toBe('apply_heal');        // confidence >= 0.8
    expect(items[0].metadata.confidence).toBe(0.9);
  });

  it('low-confidence self_healing rows put investigate before apply_heal', () => {
    const items = aggregatePulse(
      [],
      [{
        id: 'h-2',
        vtid: 'VTID-02000',
        endpoint: '/api/v1/other',
        failure_class: '4xx',
        created_at: nowIso(),
        diagnosis: { confidence: 0.5 },
        attempt_number: 1,
      }],
      [],
    );
    expect(items[0].actions[0]).toBe('investigate');
  });

  it('normalizes active executions and only offers cancel during cooldown', () => {
    const items = aggregatePulse(
      [],
      [],
      [{
        id: 'e-1',
        finding_id: 'f-1',
        status: 'cooling',
        pr_url: null,
        pr_number: null,
        branch: 'dev-autopilot/abc',
        execute_after: nowIso(),
        auto_fix_depth: 0,
        self_healing_vtid: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      }, {
        id: 'e-2',
        finding_id: 'f-2',
        status: 'deploying',
        pr_url: 'https://github.com/x/y/pull/42',
        pr_number: 42,
        branch: 'dev-autopilot/def',
        execute_after: null,
        auto_fix_depth: 1,
        self_healing_vtid: 'VTID-DA-def12345',
        created_at: nowIso(),
        updated_at: nowIso(),
      }],
    );
    expect(items).toHaveLength(2);
    const cooling = items.find((i) => i.metadata.status === 'cooling')!;
    const deploying = items.find((i) => i.metadata.status === 'deploying')!;
    expect(cooling.actions).toContain('cancel');
    expect(deploying.actions).not.toContain('cancel');
    expect(deploying.severity).toBe('warning');            // self-heal child (depth>0) → warning
  });

  it('sorts items by severity then freshness', () => {
    const items = aggregatePulse(
      [{
        id: 'f-old-critical',
        title: 'high', summary: '',
        risk_class: 'high', impact_score: 9, effort_score: 7,
        auto_exec_eligible: false, domain: 'x',
        first_seen_at: agoIso(120), seen_count: 1, spec_snapshot: null,
      }, {
        id: 'f-new-info',
        title: 'low', summary: '',
        risk_class: 'low', impact_score: 3, effort_score: 2,
        auto_exec_eligible: true, domain: 'x',
        first_seen_at: agoIso(1), seen_count: 1, spec_snapshot: null,
      }, {
        id: 'f-new-critical',
        title: 'high recent', summary: '',
        risk_class: 'high', impact_score: 9, effort_score: 7,
        auto_exec_eligible: false, domain: 'x',
        first_seen_at: agoIso(5), seen_count: 1, spec_snapshot: null,
      }],
      [], [],
    );
    // Critical first, within critical the newer one wins
    expect(items[0].id).toContain('f-new-critical');
    expect(items[1].id).toContain('f-old-critical');
    expect(items[2].id).toContain('f-new-info');
  });

  it('computes age_minutes from created_at', () => {
    const [item] = aggregatePulse(
      [{
        id: 'f-age',
        title: 't', summary: '',
        risk_class: 'low', impact_score: 3, effort_score: 2,
        auto_exec_eligible: true, domain: 'x',
        first_seen_at: agoIso(37), seen_count: 1, spec_snapshot: null,
      }],
      [], [],
    );
    expect(item.age_minutes).toBeGreaterThanOrEqual(36);
    expect(item.age_minutes).toBeLessThanOrEqual(38);
  });

  // VTID-02956 (PR-L1.5): test-contract integration.
  describe('test_contract_failure source', () => {
    const failingContract = {
      id: 'c-uuid-1',
      capability: 'canary_target_disarmed_health',
      service: 'gateway',
      environment: 'dev',
      target_endpoint: '/api/v1/canary-target/health',
      target_file: 'services/gateway/src/routes/canary-target.ts',
      owner: 'self-healing',
      status: 'fail' as const,
      last_status: 'pass' as const, // regressed!
      last_run_at: agoIso(2),
      last_failure_signature: 'canary_target.disarmed_health:status_mismatch: got 500, expected 200',
    };

    it('a regressed contract (pass → fail) is severity=critical', () => {
      const items = aggregatePulse([], [], [], [failingContract]);
      expect(items).toHaveLength(1);
      expect(items[0].source).toBe('test_contract_failure');
      expect(items[0].severity).toBe('critical');
      expect(items[0].title).toContain('Contract failing');
      expect(items[0].title).toContain('regressed');
    });

    it('a quarantined contract is severity=critical regardless of previous status', () => {
      const items = aggregatePulse([], [], [], [{ ...failingContract, status: 'quarantined' as const, last_status: 'fail' }]);
      expect(items[0].severity).toBe('critical');
      expect(items[0].title).toContain('quarantined');
    });

    it('a still-failing contract (fail → fail) is severity=warning, not critical (already on the queue)', () => {
      const items = aggregatePulse([], [], [], [{ ...failingContract, last_status: 'fail' as const }]);
      expect(items[0].severity).toBe('warning');
      expect(items[0].title).not.toContain('regressed');
    });

    it('offers rerun_contract + open_contract + investigate actions', () => {
      const items = aggregatePulse([], [], [], [failingContract]);
      expect(items[0].actions).toContain('rerun_contract');
      expect(items[0].actions).toContain('open_contract');
      expect(items[0].actions).toContain('investigate');
    });

    it('source_url deep-links to the test-contracts panel filtered by capability', () => {
      const items = aggregatePulse([], [], [], [failingContract]);
      expect(items[0].source_url).toContain('/command-hub/voice/test-contracts');
      expect(items[0].source_url).toContain('capability=canary_target_disarmed_health');
    });

    it('passes structured metadata (capability, regressed flag, owner) for the UI', () => {
      const items = aggregatePulse([], [], [], [failingContract]);
      const m = items[0].metadata as Record<string, unknown>;
      expect(m.capability).toBe('canary_target_disarmed_health');
      expect(m.regressed).toBe(true);
      expect(m.owner).toBe('self-healing');
      expect(m.failure_signature).toContain('status_mismatch');
    });

    it('critical contracts sort before warning findings, then by recency within severity', () => {
      const items = aggregatePulse(
        [{
          id: 'f-info',
          title: 'minor finding', summary: '',
          risk_class: 'low', impact_score: 1, effort_score: 1,
          auto_exec_eligible: true, domain: 'x',
          first_seen_at: agoIso(1), seen_count: 1, spec_snapshot: null,
        }],
        [], [],
        [failingContract], // critical (regressed)
      );
      expect(items[0].source).toBe('test_contract_failure');
      expect(items[1].source).toBe('dev_autopilot_finding');
    });

    it('an empty contracts array (default param) does not break the existing aggregator signature', () => {
      // Backward compat — callers that don't pass contracts still work.
      const items = aggregatePulse([], [], []);
      expect(items).toEqual([]);
    });
  });
});
