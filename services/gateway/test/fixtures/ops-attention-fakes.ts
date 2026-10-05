/** VTID-04876 (+ VTID-04885): fake AttentionReads — everything healthy/empty unless overridden. */
import type { AttentionReads, LedgerRow } from '../../src/services/ops-attention-adapters';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

export function fakeReads(over: Partial<AttentionReads> = {}): AttentionReads {
  return {
    healthSummary: async () => ({ checked_at: ago(0), items: [] }),
    latestEvent: async () => null,
    buildInfo: async () => ({ status: 'ok', commit: 'abc123' }),
    voiceOverview: async () => ({ verdict_summary: 'healthy', verdicts: [], window: '1h', generated_at: ago(0) }),
    voiceQuarantines: async () => [],
    voiceArchitectureReports: async () => [],
    supervisorAlerts: async () => [],
    selfHealOutcomes: async () => [],
    pipelineBrokenVtids: async () => [],
    inProgressLedger: async () => [],
    isAutonomous: (r: LedgerRow) => (r.metadata as any)?.autonomous_execution === true || (r.metadata as any)?.source === 'self-healing',
    systemControls: async () => [
      { key: 'autopilot_execution_enabled', enabled: true, updated_by: null, updated_at: null },
      { key: 'vtid_allocator_enabled', enabled: true, updated_by: null, updated_at: null },
    ],
    devAutopilotKillSwitch: async () => ({ engaged: false }),
    openViolations: async () => [],
    devAutopilotAwaitingApproval: async () => [],
    selfHealPendingApproval: async () => [],
    prApprovalsPending: async () => [],
    // VTID-04885 (Phase 2)
    llmBudgetLines: async () => ({
      since: '2026-10-04T00:00:00.000Z',
      truncated: false,
      lines: [{ scope: 'platform', key: 'platform', spent_usd: 10, limit_usd: 200, used_pct: 5, over: false }],
    }),
    jevBudgetAlerts: async () => [],
    ciTestRuns: async () => ({ rows: [], last_synced_at: ago(10 * 60_000) }),
    failingTestContracts: async () => [],
    routines: async () => [],
    openSupportTickets: async () => [],
    llmGoogleCalls: async () => [],
    ...over,
  };
}


/**
 * VTID-04885: Phase 2 reads that make every new adapter report at least one
 * candidate (for deeplink walks and the cockpit render). `now` is the clock.
 */
export function phase2Everything(now: number): Partial<AttentionReads> {
  const H = 3_600_000;
  const at = (ms: number) => new Date(now - ms).toISOString();
  return {
    llmBudgetLines: async () => ({
      since: at(10 * H),
      truncated: false,
      lines: [
        { scope: 'platform', key: 'platform', spent_usd: 210, limit_usd: 200, used_pct: 105, over: true },
        { scope: 'agent', key: 'autopilot-agent', spent_usd: 50, limit_usd: 60, used_pct: 83.3, over: false },
        { scope: 'run', key: 'VTID-05000', spent_usd: 9, limit_usd: 8, used_pct: 112.5, over: true },
      ],
    }),
    jevBudgetAlerts: async () => [
      { topic: 'jev.budget.threshold_crossed', created_at: at(5 * H), metadata: { tenant_id: 't1', level_pct: 80, month: '2026-10-01', spent_usd: 80, budget_usd: 100 } },
      { topic: 'jev.budget.threshold_crossed', created_at: at(2 * H), metadata: { tenant_id: 't1', level_pct: 100, month: '2026-10-01', spent_usd: 100, budget_usd: 100 } },
    ],
    ciTestRuns: async () => ({
      last_synced_at: at(H / 2),
      rows: [
        { repo: 'exafyltd/vitana-platform', workflow_file: 'TEST-SUITE.yml', workflow_name: 'Test Suite', branch: 'main', conclusion: 'failure', html_url: 'u1', run_created_at: at(H) },
        { repo: 'exafyltd/vitana-platform', workflow_file: 'TEST-SUITE.yml', workflow_name: 'Test Suite', branch: 'main', conclusion: 'failure', html_url: 'u2', run_created_at: at(3 * H) },
        { repo: 'exafyltd/vitana-platform', workflow_file: 'TEST-SUITE.yml', workflow_name: 'Test Suite', branch: 'main', conclusion: 'success', html_url: 'u3', run_created_at: at(6 * H) },
      ],
    }),
    failingTestContracts: async () => [{ id: 'c1', capability: 'orb.greeting', service: 'gateway', status: 'fail', last_run_at: at(H), last_failure_signature: 'x' }],
    routines: async () => [
      { name: 'daily-a', display_name: 'Daily A', cron_schedule: '0 4 * * *', last_run_at: at(2 * H), last_run_status: 'failure', consecutive_failures: 3, created_at: at(900 * H) },
      { name: 'daily-b', display_name: 'Daily B', cron_schedule: '30 4 * * *', last_run_at: at(40 * H), last_run_status: 'success', consecutive_failures: 0, created_at: at(900 * H) },
    ],
    openSupportTickets: async () => [
      { id: 'tk-1', ticket_number: 'FB-1', kind: 'bug', status: 'new', priority: 'p0', created_at: at(2 * H) },
      { id: 'tk-2', ticket_number: 'FB-2', kind: 'support_question', status: 'triaged', priority: 'p2', created_at: at(100 * H) },
    ],
    llmGoogleCalls: async () => [
      { created_at: at(3 * H), provider: 'vertex', model: 'gemini-x', stage: 'worker', service: 'autopilot-agent', fallback_used: true },
    ],
  };
}
