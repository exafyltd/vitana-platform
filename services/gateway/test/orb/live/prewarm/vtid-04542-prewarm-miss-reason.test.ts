/**
 * VTID-04542 — why a prewarm claim found nothing (telemetry only).
 *
 * `describePrewarmMiss(userId)` feeds the `nova_prewarm_missed` diag. It
 * must never change what a claim returns — only explain a null.
 */
import {
  registerPrewarmedNovaSession,
  consumePrewarmedNovaSession,
  describePrewarmMiss,
  __clearAllPrewarmedNovaSessionsForTest,
} from '../../../../src/orb/live/prewarm/nova-session-prewarm';

function fakeClient(initial: 'open' | 'closed' = 'open') {
  let state = initial;
  return {
    getState: () => state,
    sendAudioChunk: jest.fn(() => true),
    close: jest.fn(async () => { state = 'closed'; }),
    __setState: (s: 'open' | 'closed') => { state = s; },
  };
}

function entry(client: ReturnType<typeof fakeClient>) {
  return { client: client as any, systemInstruction: 'x', tools: [], voiceId: 'tina', lang: 'en' };
}

describe('VTID-04542 describePrewarmMiss', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __clearAllPrewarmedNovaSessionsForTest();
    process.env.ORB_NOVA_PREWARM_TTL_MS = '1000';
  });
  afterEach(() => {
    __clearAllPrewarmedNovaSessionsForTest();
    delete process.env.ORB_NOVA_PREWARM_TTL_MS;
    jest.useRealTimers();
  });

  it('never prewarmed → none_available', () => {
    expect(consumePrewarmedNovaSession('u-none')).toBeNull();
    expect(describePrewarmMiss('u-none')).toBe('none_available');
  });

  it('TTL expired → expired (and the claim still returns null as before)', () => {
    registerPrewarmedNovaSession('u-exp', entry(fakeClient()));
    jest.advanceTimersByTime(1001);
    expect(consumePrewarmedNovaSession('u-exp')).toBeNull();
    expect(describePrewarmMiss('u-exp')).toBe('expired');
  });

  it('found dead at claim → dead_on_claim', () => {
    const c = fakeClient();
    registerPrewarmedNovaSession('u-dead', entry(c));
    c.__setState('closed');
    expect(consumePrewarmedNovaSession('u-dead')).toBeNull();
    expect(describePrewarmMiss('u-dead')).toBe('dead_on_claim');
  });

  it('a new prewarm or a successful claim clears the recorded reason', () => {
    registerPrewarmedNovaSession('u-re', entry(fakeClient()));
    jest.advanceTimersByTime(1001);
    expect(describePrewarmMiss('u-re')).toBe('expired');
    registerPrewarmedNovaSession('u-re', entry(fakeClient()));
    expect(describePrewarmMiss('u-re')).toBe('none_available');
    expect(consumePrewarmedNovaSession('u-re')).not.toBeNull();
    expect(describePrewarmMiss('u-re')).toBe('none_available');
  });
});
