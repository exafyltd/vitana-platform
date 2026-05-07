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