/** VTID-04876: fake AttentionReads — everything healthy/empty unless overridden. */
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
    ...over,
  };
}

