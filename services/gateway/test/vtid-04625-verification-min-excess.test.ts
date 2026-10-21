/**
 * VTID-04625: verification no longer reverts a correct change for one or two
 * sporadic unrelated errors. Live case 2026-09-26: PR #3726 was reverted
 * (#3741) for one voice.latency.measured "errored" measurement and one
 * operator-console assistant.turn record.
 */
import { analyzeVerificationWindow, isVerificationNoiseTopic, verificationMinExcess } from '../src/services/dev-autopilot-watcher';

const W = 5 * 60_000;
const prefix = 'VTID-DA-abc12345';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const start = ago(60_000);
const err = (type: string, vtid: string, at: string) => ({ type, vtid, status: 'error', created_at: at });

describe('verificationMinExcess', () => {
  it('defaults to 3, honours a positive integer, ignores garbage', () => {
    expect(verificationMinExcess({} as NodeJS.ProcessEnv)).toBe(3);
    expect(verificationMinExcess({ DEV_AUTOPILOT_VERIFY_MIN_EXCESS: '5' } as NodeJS.ProcessEnv)).toBe(5);
    expect(verificationMinExcess({ DEV_AUTOPILOT_VERIFY_MIN_EXCESS: '0' } as NodeJS.ProcessEnv)).toBe(3);
    expect(verificationMinExcess({ DEV_AUTOPILOT_VERIFY_MIN_EXCESS: 'x' } as NodeJS.ProcessEnv)).toBe(3);
  });
});

describe('analyzeVerificationWindow with minExcess', () => {
  it('two of a new type is below an excess of 3; three is blast radius', () => {
    const two = [err('memory.write.failed', 'VTID-02000', ago(20_000)), err('memory.write.failed', 'VTID-02000', ago(10_000))];
    expect(analyzeVerificationWindow(two, start, W, prefix, { minExcess: 3 }).state).toBe('pending');
    const three = [...two, err('memory.write.failed', 'VTID-02000', ago(5_000))];
    const r = analyzeVerificationWindow(three, start, W, prefix, { minExcess: 3 });
    expect(r.state).toBe('fail');
    expect(r.blastRadiusEvents).toHaveLength(3);
  });

  it('the excess is measured against the baseline window', () => {
    const events = [
      err('orb.live.connection_failed', 'VTID-01155', ago(2 * 60_000)),
      err('orb.live.connection_failed', 'VTID-01155', ago(3 * 60_000)),
      ...[1, 2, 3, 4].map((i) => err('orb.live.connection_failed', 'VTID-01155', ago(i * 5_000))),
    ];
    expect(analyzeVerificationWindow(events, start, W, prefix, { minExcess: 3 }).state).toBe('pending');
    events.push(err('orb.live.connection_failed', 'VTID-01155', ago(1_000)));
    expect(analyzeVerificationWindow(events, start, W, prefix, { minExcess: 3 }).state).toBe('fail');
  });

  it('without the option the behaviour is unchanged: any rise fails', () => {
    expect(analyzeVerificationWindow([err('memory.write.failed', 'VTID-02000', ago(10_000))], start, W, prefix).state).toBe('fail');
  });
});

describe('telemetry is not blast radius', () => {
  it('voice latency measurements and console turn records are noise', () => {
    expect(isVerificationNoiseTopic('voice.latency.measured')).toBe(true);
    expect(isVerificationNoiseTopic('assistant.turn')).toBe(true);
    expect(isVerificationNoiseTopic('orb.live.connection_failed')).toBe(false);
    const events = [
      err('voice.latency.measured', 'VTID-03177', ago(20_000)),
      err('assistant.turn', 'VTID-0536', ago(10_000)),
    ];
    expect(analyzeVerificationWindow(events, start, W, prefix).state).toBe('pending');
  });
});
