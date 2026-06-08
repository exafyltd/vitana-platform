/**
 * Tests for the Autonomy Trace aggregator (PR-12).
 */

import { aggregateTrace } from '../src/routes/autonomy-trace';

const nowIso = () => new Date().toISOString();
const agoIso = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function execRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    finding_id: 'f-1',
    status: 'cooling',
    pr_url: null,
    pr_number: null,
    branch: 'dev-autopilot/aa',
    execute_after: new Date(Date.now() + 10 * 60_000).toISOString(),
    auto_fix_depth: 0,
    self_healing_vtid: null,
    parent_execution_id: null,
    triage_report: null,
    created_at: agoIso(2),
    updated_at: agoIso(2),
    completed_at: null,
    ...overrides,
  } as any;
}

function healRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'h-1',
    vtid: 'VTID-01999',
    endpoint: '/api/v1/orb/health',
    failure_class: 'timeout',
    outcome: 'pending',
    created_at: agoIso(5),
    resolved_at: null,
    diagnosis: { confidence: 0.8, summary: 'VERTEX drift' },
    attempt_number: 1,
    ...overrides,
  } as any;
}

function oasisRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'o-1',
    topic: 'deploy.gateway.success',
    vtid: 'VTID-02042',
    status: 'success',
    message: 'Deploy ok',
    metadata: { pr_number: 42 },
    created_at: nowIso(),
    ...overrides,
  } as any;
}

describe('aggregateTrace', () => {
  it('returns empty when all inputs are empty', () => {
    expect(aggregateTrace([], [], [])).toEqual({ nodes: [], groups: {} });
  });

  it('normalizes an execution into a trace node with the right kind', () => {
    const { nodes } = aggregateTrace([execRow({ status: 'verifying' })], [], []);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('execution_verifying');
    expect(nodes[0].source).toBe('execution');
    expect(nodes[0].status).toBe('progress');
    expect(nodes[0].group_id).toMatch(/^execution:/);
  });

  it('self-heal child execution uses parent group_id for lineage', () => {
    const { groups } = aggregateTrace(
      [execRow({ parent_execution_id: 'parent-id-123', auto_fix_depth: 1 })],
      [], [],
    );
    expect(Object.keys(groups)).toContain('execution:parent-id-123');
  });

  it('failed executions pull root_cause_hypothesis from triage_report', () => {
    const { nodes } = aggregateTrace(
      [execRow({
        status: 'failed',
        triage_report: { root_cause_hypothesis: 'Missing env var' },
      })],
      [], [],
    );
    expect(nodes[0].status).toBe('failure');
    expect(nodes[0].detail).toBe('Missing env var');
  });

  it('drops execution rows whose status is not trace-worthy (cancelled, queued)', () => {
    const { nodes } = aggregateTrace(
      [execRow({ status: 'cancelled' }), execRow({ id: 'x-2', status: 'queued' })],
      [], [],
    );
    expect(nodes).toEqual([]);
  });

  it('normalizes a self_heal row and maps outcome to status', () => {
    const { nodes } = aggregateTrace(
      [],
      [healRow({ outcome: 'reconciled', resolved_at: nowIso() })],
      [],
    );
    expect(nodes[0].source).toBe('self_healing');
    expect(nodes[0].kind).toBe('self_heal_reconciled');
    expect(nodes[0].status).toBe('success');
    expect(nodes[0].group_id).toBe('heal:VTID-01999');
  });

  it('escalated self-heal maps to failure', () => {
    const { nodes } = aggregateTrace(
      [],
      [healRow({ outcome: 'escalated' })],
      [],
    );
    expect(nodes[0].status).toBe('failure');
    expect(nodes[0].kind).toBe('self_heal_escalated');
  });

  it('maps OASIS deploy.gateway.success to deploy_succeeded with status=success', () => {
    const { nodes } = aggregateTrace([], [], [oasisRow()]);
    expect(nodes[0].kind).toBe('deploy_succeeded');
    expect(nodes[0].source).toBe('deploy_event');
    expect(nodes[0].status).toBe('success');
  });

  it('maps autopilot.verification.failed to verification source', () => {
    const { nodes } = aggregateTrace(
      [], [],
      [oasisRow({ topic: 'autopilot.verification.failed', vtid: 'VTID-01888' })],
    );
    expect(nodes[0].source).toBe('verification');
    expect(nodes[0].kind).toBe('verification_failed');
    expect(nodes[0].status).toBe('failure');
  });

  it('ignores unknown OASIS topics', () => {
    const { nodes } = aggregateTrace(
      [], [],
      [oasisRow({ topic: 'unrelated.topic' })],
    );
    expect(nodes).toEqual([]);
  });

  // VTID-02956 (PR-L1.5): test-contract events on the trace timeline.
  describe('test_contract source (PR-L1.5)', () => {
    it('maps test-contract.run.passed to contract_passed / status=success / source=test_contract', () => {
      const { nodes } = aggregateTrace(
        [], [],
        [oasisRow({
          id: 'o-tc-pass',
          topic: 'test-contract.run.passed',
          vtid: 'VTID-02954',
          status: 'success',
          message: 'Contract gateway_alive passed',
          metadata: { capability: 'gateway_alive', status_code: 200, duration_ms: 91 },
        })],
      );
      expect(nodes).toHaveLength(1);
      expect(nodes[0].source).toBe('test_contract');
      expect(nodes[0].kind).toBe('contract_passed');
      expect(nodes[0].status).toBe('success');
    });

    it('maps test-contract.run.failed to contract_failed / status=failure', () => {
      const { nodes } = aggregateTrace(
        [], [],
        [oasisRow({
          id: 'o-tc-fail',
          topic: 'test-contract.run.failed',
          status: 'warning',
          message: 'Contract canary_target_disarmed_health failed',
          metadata: { capability: 'canary_target_disarmed_health', failure_reason: 'status_mismatch: got 500, expected 200' },
        })],
      );
      expect(nodes[0].source).toBe('test_contract');
      expect(nodes[0].kind).toBe('contract_failed');
      expect(nodes[0].status).toBe('failure');
    });

    it('contract events group by capability so multiple runs form one lane', () => {
      const { groups } = aggregateTrace(
        [], [],
        [
          oasisRow({ id: 'o-1', topic: 'test-contract.run.passed', metadata: { capability: 'gateway_alive' } }),
          oasisRow({ id: 'o-2', topic: 'test-contract.run.failed', metadata: { capability: 'gateway_alive' }, created_at: agoIso(60) }),
          oasisRow({ id: 'o-3', topic: 'test-contract.run.passed', metadata: { capability: 'canary_target_status' } }),
        ],
      );
      expect(groups['contract:gateway_alive']).toHaveLength(2);
      expect(groups['contract:canary_target_status']).toHaveLength(1);
    });

    it('emits an "Open contract" link when metadata.capability is present', () => {
      const { nodes } = aggregateTrace(
        [], [],
        [oasisRow({ topic: 'test-contract.run.failed', metadata: { capability: 'gateway_alive' } })],
      );
      const link = nodes[0].links.find((l) => l.label === 'Open contract');
      expect(link).toBeDefined();
      expect(link?.url).toContain('capability=gateway_alive');
    });

    it('falls back to vtid groupId when contract event has no capability metadata', () => {
      const { nodes } = aggregateTrace(
        [], [],
        [oasisRow({ topic: 'test-contract.run.failed', metadata: {} })],
      );
      // No capability → no contract: group; should fall through to the vtid:
      // group (since the test row has vtid='VTID-02042').
      expect(nodes[0].group_id).toBe('vtid:VTID-02042');
    });
  });

  it('sorts nodes newest-first globally and oldest-first within a group', () => {
    const old = agoIso(30);
    const newer = agoIso(10);
    const { nodes, groups } = aggregateTrace(
      [
        execRow({ id: 'grp-a', status: 'ci',        updated_at: old,   created_at: old }),
        execRow({ id: 'grp-a', status: 'completed', updated_at: newer, created_at: old, completed_at: newer }),
      ],
      [], [],
    );
    // Global order: newer first
    expect(new Date(nodes[0].ts).getTime()).toBeGreaterThanOrEqual(new Date(nodes[1].ts).getTime());
    // Within the same group, lane reads start → end
    const groupKey = Object.keys(groups).find((k) => k.includes('grp-a'))!;
    expect(new Date(groups[groupKey][0].ts).getTime()).toBeLessThanOrEqual(new Date(groups[groupKey][1].ts).getTime());
  });

  it('pulls PR link from pr_url + pr_number onto links', () => {
    const { nodes } = aggregateTrace(
      [execRow({ pr_url: 'https://github.com/org/repo/pull/42', pr_number: 42 })],
      [], [],
    );
    expect(nodes[0].links[0].label).toMatch(/PR 42/);
    expect(nodes[0].links[0].url).toContain('pull/42');
  });

  it('every execution node always carries a Lineage link back to dev-autopilot', () => {
    const { nodes } = aggregateTrace([execRow()], [], []);
    const lineageLink = nodes[0].links.find((l) => l.label === 'Lineage');
    expect(lineageLink).toBeDefined();
    expect(lineageLink?.url).toContain('/command-hub/dev-autopilot');
  });
});
