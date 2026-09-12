/**
 * VTID-03821: Execution observability — LLM-call telemetry tagged with the
 * real task VTID.
 *
 * Before this fix, runExecutionSession() tagged every LLM call
 * (llm.call.started/completed/failed, carrying provider/model/latency —
 * exactly "which LLM served this run") with a SYNTHETIC per-execution id
 * (`VTID-DA-<execId8>`), never the real `autopilot_recommendations
 * .activated_vtid` a human actually looks at on the Command Hub board/
 * drawer or the Agents Control Plane trace view. Both of those UIs filter
 * OASIS events by the real task vtid, so this telemetry was invisible on
 * every dev-autopilot execution, on-ramp-triggered or not — not a bug
 * specific to VTID-03820, but the same synthetic-id trap this VTID's own
 * `extractLlmOnRampOverride` metadata plumbing made newly worth fixing.
 *
 * runExecutionSession() itself needs a live Supabase connection and isn't
 * unit-testable in isolation (same established scope limit as this
 * module's other Supabase-dependent helpers). This is a source-level
 * regression guard, same pattern as vtid-03820's sibling test.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE: string = fs.readFileSync(
  path.join(__dirname, '../src/services/dev-autopilot-execute.ts'),
  'utf8'
);

describe('runExecutionSession telemetry vtid resolution (VTID-03821, source check)', () => {
  it('selects activated_vtid alongside spec_snapshot in the unconditional findingMetaR query', () => {
    const idx = SOURCE.indexOf('autopilot_recommendations?id=eq.${exec.finding_id}&select=spec_snapshot,activated_vtid&limit=1');
    expect(idx).toBeGreaterThan(-1);
  });

  it('computes telemetryVtid preferring activated_vtid, falling back to the synthetic id', () => {
    const idx = SOURCE.indexOf('const telemetryVtid = activatedVtid || `VTID-DA-${executionId.slice(0, 8)}`;');
    expect(idx).toBeGreaterThan(-1);
  });

  it('the direct-API path tags callMessagesApi with telemetryVtid, not a bare synthetic id', () => {
    expect(SOURCE).toContain('await callMessagesApi(prompt, telemetryVtid, onRampOverride);');
    // The old always-synthetic call shape must not remain anywhere in the file.
    expect(SOURCE).not.toContain('await callMessagesApi(prompt, `VTID-DA-${executionId.slice(0, 8)}`');
  });

  it('the worker-queue path tags vtid_like with telemetryVtid too (commit-message/trace consistency)', () => {
    const start = SOURCE.indexOf('await runWorkerTask(');
    const end = SOURCE.indexOf('await callMessagesApi(prompt, telemetryVtid, onRampOverride);');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SOURCE.slice(start, end);
    expect(block).toContain('vtid_like: telemetryVtid,');
  });

  it('telemetryVtid is computed before the worker-queue-vs-direct-API branch that consumes it', () => {
    const telemetryIdx = SOURCE.indexOf('const telemetryVtid = activatedVtid ||');
    const branchIdx = SOURCE.indexOf('isWorkerQueueEnabled() && !onRampOverride');
    expect(telemetryIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeGreaterThan(telemetryIdx);
  });
});
