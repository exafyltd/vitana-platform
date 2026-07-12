import { ConnectionIssueDebouncer } from '../src/services/connection-issue-debouncer';

describe('ConnectionIssueDebouncer', () => {
  let debouncer: ConnectionIssueDebouncer;

  beforeEach(() => {
    jest.useFakeTimers();
    debouncer = new ConnectionIssueDebouncer();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('executes callback after timeout', () => {
    const callback = jest.fn();
    debouncer.reportIssue('conn-1', 2000, callback);
    
    expect(callback).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not execute callback if resolveIssue is called before timeout', () => {
    const callback = jest.fn();
    debouncer.reportIssue('conn-1', 2000, callback);
    
    jest.advanceTimersByTime(1000);
    debouncer.resolveIssue('conn-1');
    jest.advanceTimersByTime(1000);
    
    expect(callback).not.toHaveBeenCalled();
  });

  it('resets the timer if reportIssue is called multiple times', () => {
    const callback = jest.fn();
    debouncer.reportIssue('conn-1', 2000, callback);
    
    jest.advanceTimersByTime(1000);
    debouncer.reportIssue('conn-1', 2000, callback);
    jest.advanceTimersByTime(1000);
    
    expect(callback).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cleanup removes the timer', () => {
    const callback = jest.fn();
    debouncer.reportIssue('conn-1', 2000, callback);

    debouncer.cleanup('conn-1');
    jest.advanceTimersByTime(2000);

    expect(callback).not.toHaveBeenCalled();
  });
});

/**
 * FB-2026-05-000061 — pins the orb-live.ts wiring contract for the debouncer.
 *
 * orb-live's upstream ws 'error' handler arms a debounced connection_issue
 * alert instead of emitting immediately. Recovery signals (any upstream
 * message, successful transparent reconnect, session stop) resolve the
 * pending alert. A genuine disconnect is announced immediately by the close
 * handler, which sets session.connectionIssueEmitted — so the debounced
 * callback, which re-checks that flag, becomes a no-op and the user hears
 * exactly one alert.
 */
describe('FB-2026-05-000061 — orb-live wiring contract', () => {
  const GRACE_MS = 2000;
  let debouncer: ConnectionIssueDebouncer;
  let session: { sessionId: string; active: boolean; connectionIssueEmitted: boolean };
  let emitted: string[];

  // Mirrors the debounced callback wired in orb-live's ws 'error' handler.
  function armAlert() {
    if (session.active && !session.connectionIssueEmitted) {
      debouncer.reportIssue(session.sessionId, GRACE_MS, () => {
        if (!session.active || session.connectionIssueEmitted) return;
        session.connectionIssueEmitted = true;
        emitted.push('debounced_alert');
      });
    }
  }

  // Mirrors the close handler's immediate emit on a genuine disconnect.
  function genuineDisconnect() {
    if (!session.connectionIssueEmitted) {
      session.connectionIssueEmitted = true;
      emitted.push('close_alert');
    }
  }

  beforeEach(() => {
    jest.useFakeTimers();
    debouncer = new ConnectionIssueDebouncer();
    session = { sessionId: 'sess-1', active: true, connectionIssueEmitted: false };
    emitted = [];
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('transient error that recovers via upstream traffic → user hears nothing', () => {
    armAlert();
    jest.advanceTimersByTime(500);
    debouncer.resolveIssue(session.sessionId); // upstream message arrived
    jest.advanceTimersByTime(GRACE_MS);
    expect(emitted).toEqual([]);
  });

  it('error followed by successful transparent reconnect → user hears nothing', () => {
    armAlert();
    jest.advanceTimersByTime(1500);
    debouncer.resolveIssue(session.sessionId); // reconnected === true
    jest.advanceTimersByTime(GRACE_MS);
    expect(emitted).toEqual([]);
  });

  it('genuine disconnect (error then close) → exactly one alert, from the close handler', () => {
    armAlert();
    genuineDisconnect(); // close handler fires within the grace window
    jest.advanceTimersByTime(GRACE_MS);
    expect(emitted).toEqual(['close_alert']);
  });

  it('error with no recovery and no close → debounced alert fires once after grace', () => {
    armAlert();
    jest.advanceTimersByTime(GRACE_MS);
    expect(emitted).toEqual(['debounced_alert']);
    // A later close does not alert again.
    genuineDisconnect();
    expect(emitted).toEqual(['debounced_alert']);
  });

  it('user stops the session during the grace window → no alert', () => {
    armAlert();
    session.active = false;
    debouncer.cleanup(session.sessionId); // /session/stop path
    jest.advanceTimersByTime(GRACE_MS);
    expect(emitted).toEqual([]);
  });
});