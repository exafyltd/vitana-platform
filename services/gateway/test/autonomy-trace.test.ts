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
