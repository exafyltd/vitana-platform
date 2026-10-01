/**
 * VTID-04377: the verification window compares each error type against the
 * same-length span before the merge, and never counts the execution's own
 * ledger VTID, BOOTSTRAP-* rows or deploy topics as blast radius.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  analyzeVerificationWindow,
  isVerificationNoiseTopic,
  VERIFICATION_WINDOW_MS,
} from '../src/services/dev-autopilot-watcher';

const W = VERIFICATION_WINDOW_MS;
const prefix = 'VTID-DA-abc12345';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const start = ago(60_000);
const err = (type: string, vtid: string, at: string) => ({ type, vtid, status: 'error', created_at: at });

describe('baseline comparison', () => {
  it('an error type already firing before the merge at the same rate is not blast radius', () => {
    const events = [
      err('orb.live.connection_failed', 'VTID-01155', ago(3 * 60_000)),
      err('orb.live.connection_failed', 'VTID-01155', ago(2 * 60_000)),
      err('orb.live.connection_failed', 'VTID-01155', ago(30_000)),
      err('orb.live.connection_failed', 'VTID-01155', ago(10_000)),
    ];
    expect(analyzeVerificationWindow(events, start, W, prefix).state).toBe('pending');
  });
  it('the same type above its baseline fails', () => {
    const events = [
      err('orb.live.connection_failed', 'VTID-01155', ago(2 * 60_000)),
      err('orb.live.connection_failed', 'VTID-01155', ago(30_000)),
      err('orb.live.connection_failed', 'VTID-01155', ago(20_000)),
    ];
    const r = analyzeVerificationWindow(events, start, W, prefix);
    expect(r.state).toBe('fail');
    expect(r.blastRadiusEvents).toHaveLength(2);
  });
  it('a type that is new after the merge fails even when others were noisy before', () => {
    const events = [
      err('orb.live.connection_failed', 'VTID-01155', ago(2 * 60_000)),
      err('memory.write.failed', 'VTID-02000', ago(10_000)),
    ];
    const r = analyzeVerificationWindow(events, start, W, prefix);
    expect(r.state).toBe('fail');
    expect(r.blastRadiusEvents).toEqual([{ type: 'memory.write.failed', vtid: 'VTID-02000' }]);
  });
  it('events older than one window before the start are not baseline', () => {
    const events = [
      err('orb.live.connection_failed', 'VTID-01155', ago(W + 5 * 60_000)),
      err('orb.live.connection_failed', 'VTID-01155', ago(10_000)),
    ];
    expect(analyzeVerificationWindow(events, start, W, prefix).state).toBe('fail');
  });
});

describe('exclusions', () => {
  it('the execution\'s own ledger VTID is never blast radius', () => {
    const events = [err('vtid.stage.worker.failed', 'VTID-04300', ago(10_000))];
    expect(analyzeVerificationWindow(events, start, W, prefix).state).toBe('fail');
    expect(analyzeVerificationWindow(events, start, W, prefix, { ownVtids: ['VTID-04300'] }).state).toBe('pending');
  });
  it('BOOTSTRAP-* rows and deploy topics are ignored', () => {
    const events = [
      err('orb.live.connection_failed', 'BOOTSTRAP-SOMETHING', ago(10_000)),
      err('staging.deploy.failed', 'VTID-04111', ago(10_000)),
      err('prod.deploy.failed', 'VTID-04111', ago(10_000)),
      err('deploy.gateway.failed', 'VTID-04111', ago(10_000)),
    ];
    expect(analyzeVerificationWindow(events, start, W, prefix).state).toBe('pending');
  });
  it('isVerificationNoiseTopic keeps the VTID-02699/04043 exclusions', () => {
    for (const t of ['dev_autopilot.execution.ci_failed', 'self_healing.x', 'cicd.y', 'vtid.lifecycle.failed', 'operator.execution_onramp.failed']) {
      expect(isVerificationNoiseTopic(t)).toBe(true);
    }
    expect(isVerificationNoiseTopic('orb.live.connection_failed')).toBe(false);
    expect(isVerificationNoiseTopic(undefined)).toBe(false);
  });
});

describe('wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-watcher.ts'), 'utf8');
  it('the loader reads one window before the start and the tick passes the finding VTID', () => {
    expect(src).toMatch(/getTime\(\) - VERIFICATION_WINDOW_MS\)\.toISOString\(\)/);
    expect(src).toMatch(/ownVtids: ownVtid \? \[ownVtid\] : \[\]/);
  });
});
