/**
 * VTID-ASSISTANT-ROLES — deterministic briefing ranking + next-step tests.
 *
 * The 4-part briefing protocol (status → since-last → attention → next
 * step) depends on ranking living in code, not in the prompt. These tests
 * pin the ordering rules so voice and text surfaces stay consistent.
 */

import {
  rankDeveloperAttention,
  deriveDeveloperNextStep,
} from '../src/services/assistant-briefing/developer-briefing-service';
import {
  rankAdminAttention,
  deriveAdminNextStep,
} from '../src/services/assistant-briefing/admin-briefing-service';

function devCounts(overrides: Record<string, unknown> = {}): any {
  return {
    pendingHeals: { count: 0, oldest: null, topEndpoint: null, topId: null },
    activeHealTasks: 0,
    newFindings: { count: 0, topTitle: null, topId: null },
    executions: { inflight: 0, failed24h: 0 },
    failingContracts: { count: 0, topCapability: null },
    approvals: { count: 0, topVtid: null, topTitle: null },
    controls: { executionArmed: true, allocatorEnabled: true },
    agents: { down: 0, degraded: 0, total: 5, topDown: null },
    terminalized: { total: 0, success: 0 },
    errorEvents: { count: 0, topMessage: null },
    ...overrides,
  };
}

function adminCounts(overrides: Record<string, unknown> = {}): any {
  return {
    insights: { open: 0, pendingApproval: 0, urgent: 0, topTitle: null, topId: null, topSeverity: null },
    moderation: { pending: 0, flagged: 0, oldest: null, topId: null },
    funnel: { stuck: 0, total7d: 0 },
    invitations: { pending: 0 },
    members: { total: 100, newInWindow: 2 },
    alerts: { count: 0, topMessage: null },
    healthIndex: { value: 80, delta: 1 },
    ...overrides,
  };
}

describe('developer briefing ranking', () => {
  it('returns empty attention when everything is green', () => {
    expect(rankDeveloperAttention(devCounts())).toEqual([]);
  });

  it('ranks down agents above pending heals above approvals', () => {
    const items = rankDeveloperAttention(devCounts({
      agents: { down: 1, degraded: 0, total: 5, topDown: 'orb-agent' },
      pendingHeals: { count: 2, oldest: new Date().toISOString(), topEndpoint: '/api/x', topId: 'a' },
      approvals: { count: 3, topVtid: 'VTID-00001', topTitle: 'x' },
    }));
    expect(items.map((i) => i.source)).toEqual(['agents', 'self_healing', 'approvals']);
  });

  it('escalates a pending heal past the 24h SLA to critical and above fresh agents-adjacent items', () => {
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    const items = rankDeveloperAttention(devCounts({
      pendingHeals: { count: 1, oldest: old, topEndpoint: '/api/y', topId: 'b' },
      approvals: { count: 1, topVtid: 'VTID-00002', topTitle: 'y' },
    }));
    expect(items[0].source).toBe('self_healing');
    expect(items[0].severity).toBe('critical');
    expect(items[0].sla_breach).toBe(true);
  });

  it('flags a disarmed execution control', () => {
    const items = rankDeveloperAttention(devCounts({
      controls: { executionArmed: false, allocatorEnabled: true },
    }));
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('governance');
    expect(items[0].line).toContain('DISARMED');
  });

  it('recommends the top attention item as the next step', () => {
    const c = devCounts({
      pendingHeals: { count: 1, oldest: new Date().toISOString(), topEndpoint: '/api/z', topId: 'c' },
    });
    const step = deriveDeveloperNextStep(rankDeveloperAttention(c), c);
    expect(step?.tool).toBe('dev_list_pending_heals');
    expect(step?.tier).toBe(0);
  });

  it('falls back to findings review, then pulse, when nothing needs attention', () => {
    const withFindings = devCounts({ newFindings: { count: 4, topTitle: 'Fix i18n drift', topId: 'f' } });
    expect(deriveDeveloperNextStep([], withFindings)?.tool).toBe('dev_list_findings');
    expect(deriveDeveloperNextStep([], devCounts())?.tool).toBe('dev_get_autonomy_pulse');
  });
});

describe('admin briefing ranking', () => {
  it('returns empty attention when the tenant is calm', () => {
    expect(rankAdminAttention(adminCounts())).toEqual([]);
  });

  it('puts SLA-breaching moderation above urgent insights', () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    const items = rankAdminAttention(adminCounts({
      moderation: { pending: 3, flagged: 1, oldest: old, topId: 'm' },
      insights: { open: 2, pendingApproval: 1, urgent: 1, topTitle: 'Engagement drop', topId: 'i', topSeverity: 'urgent' },
    }));
    expect(items[0].source).toBe('moderation');
    expect(items[0].sla_breach).toBe(true);
    expect(items[1].source).toBe('insights');
  });

  it('fresh moderation ranks below urgent insights', () => {
    const items = rankAdminAttention(adminCounts({
      moderation: { pending: 1, flagged: 0, oldest: new Date().toISOString(), topId: 'm' },
      insights: { open: 1, pendingApproval: 0, urgent: 1, topTitle: 'Churn spike', topId: 'i', topSeverity: 'urgent' },
    }));
    expect(items[0].source).toBe('insights');
  });

  it('flags a health-index drop of more than 3 points', () => {
    const items = rankAdminAttention(adminCounts({ healthIndex: { value: 70, delta: -8 } }));
    expect(items.map((i) => i.source)).toContain('health_index');
  });

  it('recommends clearing moderation when it tops attention', () => {
    const c = adminCounts({
      moderation: { pending: 2, flagged: 0, oldest: new Date(Date.now() - 30 * 3600_000).toISOString(), topId: 'm' },
    });
    const step = deriveAdminNextStep(rankAdminAttention(c), c);
    expect(step?.tool).toBe('admin_list_moderation_queue');
  });

  it('proposes KPI review when everything is calm', () => {
    expect(deriveAdminNextStep([], adminCounts())?.tool).toBe('admin_kpi_snapshot');
  });
});
