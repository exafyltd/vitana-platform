import {
  summariseDevAutopilotDay,
  DevAutopilotExecutionRow,
  DevAutopilotFindingRow,
} from '../../src/routes/routine-audits';

const SINCE = '2026-09-21T06:30:00.000Z';
const IN = '2026-09-21T12:00:00.000Z';
const BEFORE = '2026-09-19T12:00:00.000Z';

function exec(p: Partial<DevAutopilotExecutionRow>): DevAutopilotExecutionRow {
  return {
    id: 'e',
    finding_id: 'f',
    status: 'running',
    pr_url: null,
    pr_number: null,
    parent_execution_id: null,
    created_at: IN,
    updated_at: IN,
    completed_at: null,
    ...p,
  };
}

describe('summariseDevAutopilotDay (VTID-04292)', () => {
  it('counts new findings by risk class', () => {
    const findings: DevAutopilotFindingRow[] = [
      { id: 'a', title: 'A', risk_class: 'low', created_at: IN },
      { id: 'b', title: 'B', risk_class: 'low', created_at: IN },
      { id: 'c', title: 'C', risk_class: null, created_at: IN },
    ];
    const s = summariseDevAutopilotDay(findings, [], SINCE);
    expect(s.new_findings).toBe(3);
    expect(s.new_findings_by_risk).toEqual({ low: 2, unclassified: 1 });
    expect(s.new_findings_sample).toHaveLength(3);
  });

  it('counts a fix on the day it completed, not the day it started', () => {
    const s = summariseDevAutopilotDay(
      [],
      [
        exec({ id: '1', status: 'completed', created_at: BEFORE, completed_at: IN, pr_url: 'u1' }),
        exec({ id: '2', status: 'self_healed', created_at: IN, completed_at: IN }),
        exec({ id: '3', status: 'completed', created_at: BEFORE, completed_at: BEFORE, updated_at: IN }),
      ],
      SINCE,
    );
    expect(s.fixes_completed).toBe(2);
    expect(s.fixes.map((f) => f.execution_id)).toEqual(['1', '2']);
    expect(s.executions_started).toBe(1);
  });

  it('falls back to updated_at when completed_at was never stamped', () => {
    const s = summariseDevAutopilotDay([], [exec({ status: 'completed', completed_at: null, updated_at: IN })], SINCE);
    expect(s.fixes_completed).toBe(1);
  });

  it('separates failures, cancellations, retries, PRs, in-flight and held rows', () => {
    const s = summariseDevAutopilotDay(
      [],
      [
        exec({ status: 'failed' }),
        exec({ status: 'reverted' }),
        exec({ status: 'failed_escalated', updated_at: BEFORE }),
        exec({ status: 'cancelled' }),
        exec({ status: 'ci', pr_url: 'u', parent_execution_id: 'p' }),
        exec({ status: 'awaiting_approval', created_at: BEFORE, updated_at: BEFORE }),
      ],
      SINCE,
    );
    expect(s.fixes_failed).toBe(2);
    expect(s.fixes_cancelled).toBe(1);
    expect(s.self_heal_retries_started).toBe(1);
    expect(s.prs_opened).toBe(1);
    expect(s.in_flight_now).toBe(1);
    expect(s.awaiting_approval_now).toBe(1);
    expect(s.fixes_completed).toBe(0);
  });
});

describe('ROUTINE_INGEST_TOKEN on the staging task def (VTID-04292)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  const staging: string = fs.readFileSync(
    path.resolve(__dirname, '../../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'),
    'utf8',
  );

  it('reads the repo secret, strips any stale value and sets it once', () => {
    expect(staging).toContain('ROUTINE_INGEST_TOKEN_VALUE: ${{ secrets.ROUTINE_INGEST_TOKEN }}');
    expect(staging).toContain('"DEV_AUTOPILOT_SCAN_TOKEN","ROUTINE_INGEST_TOKEN",');
    expect(staging.match(/\{name:"ROUTINE_INGEST_TOKEN", value:\$ROUTINE_TOKEN\}/g)).toHaveLength(1);
  });
});
