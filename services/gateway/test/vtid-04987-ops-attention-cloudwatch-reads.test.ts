/**
 * VTID-04987 — createAttentionReads().cloudwatchAlarms() delegates to
 * ops-attention-cloudwatch.ts (round-2 F9) and passes a failure through as a
 * throw (never "no alarms"). Every dependency is mocked; no network, no AWS,
 * no database.
 */

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));
jest.mock('../src/services/health-summary-builder', () => ({ buildHealthSummary: jest.fn() }));
jest.mock('../src/services/voice-supervisor-overview', () => ({ buildVoiceOverview: jest.fn() }));
jest.mock('../src/services/dev-autopilot-supervisor', () => ({ buildSupervisorSnapshot: jest.fn() }));
jest.mock('../src/services/system-controls-service', () => ({ getAllSystemControls: jest.fn(async () => []) }));
jest.mock('../src/routes/worker-orchestrator', () => ({ isAutonomousExecutionTask: jest.fn(() => false) }));
jest.mock('../src/routes/approvals', () => ({ fetchApprovalEligibleVtids: jest.fn(), fetchPrInfoForVtids: jest.fn() }));
jest.mock('../src/routes/ops-runtime-health', () => ({ runRuntimeCheckCached: jest.fn() }));
jest.mock('../src/services/ops-attention-cloudwatch', () => ({ describeAlarmsInAlarm: jest.fn() }));

import { createAttentionReads } from '../src/services/ops-attention-reads';
import { describeAlarmsInAlarm } from '../src/services/ops-attention-cloudwatch';

const mocked = describeAlarmsInAlarm as jest.MockedFunction<typeof describeAlarmsInAlarm>;

describe('createAttentionReads().cloudwatchAlarms()', () => {
  beforeEach(() => mocked.mockReset());

  it('delegates to describeAlarmsInAlarm() with its defaults and returns its result unchanged', async () => {
    const result = {
      truncated: false,
      alarms: [{ name: 'vitana-gateway-prod-no-healthy-targets', type: 'metric' as const, namespace: 'AWS/ApplicationELB', metric_name: 'HealthyHostCount', state_reason: 'x', state_updated_at: '2026-10-04T11:55:00.000Z' }],
    };
    mocked.mockResolvedValue(result);
    await expect(createAttentionReads().cloudwatchAlarms()).resolves.toBe(result);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith();
  });

  it('a failed read throws through (the aggregator maps it to UNKNOWN)', async () => {
    mocked.mockRejectedValue(new Error('cloudwatch: AccessDenied: not authorized'));
    await expect(createAttentionReads().cloudwatchAlarms()).rejects.toThrow('cloudwatch: AccessDenied');
  });
});
