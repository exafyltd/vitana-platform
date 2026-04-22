/**
 * Tests for the Dev Autopilot watchers (PR-9).
 *
 * Focuses on the pure analyzer functions — full tick flows depend on
 * Supabase + GitHub mocks and are exercised by integration tests.
 */

import {
  analyzeCiStatus,
  findDeployOutcomeForExecution,
  analyzeVerificationWindow,
  VERIFICATION_WINDOW_MS,
  shouldAutoMerge,
} from '../src/services/dev-autopilot-watcher';

describe('analyzeCiStatus', () => {
  it('reports pending when no checks have reported yet', () => {
    expect(analyzeCiStatus([])).toEqual({ state: 'pending', failedNames: [] });
  });

  it('reports passing when every check is success/neutral/skipped', () => {
    const checks = [
      { name: 'unit', status: 'success', conclusion: 'success' },
      { name: 'lint', status: 'neutral', conclusion: 'neutral' },
      { name: 'optional', status: 'skipped', conclusion: 'skipped' },
    ];
    expect(analyzeCiStatus(checks)).toEqual({ state: 'passing', failedNames: [] });
  });

  it('reports failing and lists the failing check names', () => {
    const checks = [
      { name: 'unit', status: 'success', conclusion: 'success' },
      { name: 'integration', status: 'failure', conclusion: 'failure' },
      { name: 'e2e', status: 'failure', conclusion: 'cancelled' },
    ];
    const r = analyzeCiStatus(checks);
    expect(r.state).toBe('failing');
    expect(r.failedNames).toEqual(['integration', 'e2e']);
  });

  it('reports pending when any check is in_progress / queued', () => {
    const checks = [
      { name: 'unit', status: 'success', conclusion: 'success' },
      { name: 'lint', status: 'in_progress' },
      { name: 'integration', status: 'queued' },
    ];
    expect(analyzeCiStatus(checks).state).toBe('pending');
  });

  it('failing trumps pending — if anything is red, we route to bridge', () => {
    const checks = [
      { name: 'unit', status: 'failure', conclusion: 'failure' },
      { name: 'lint', status: 'in_progress' },
    ];
    expect(analyzeCiStatus(checks).state).toBe('failing');
  });

  it('treats timed_out conclusion as failure', () => {
    const checks = [
      { name: 'integration', status: 'success', conclusion: 'timed_out' },
    ];
    expect(analyzeCiStatus(checks).state).toBe('failing');
  });
});

describe('findDeployOutcomeForExecution', () => {
  const exec = {
    pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9001',
    pr_number: 9001,
    branch: 'dev-autopilot/abc12345',
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  };

  it('returns pending when no events match', () => {
    const events = [
      { type: 'unrelated.thing', payload: {}, created_at: new Date().toISOString() },
    ];
    expect(findDeployOutcomeForExecution(events, exec)).toBe('pending');
  });

  it('matches by pr_url and returns success', () => {
    const events = [
      { type: 'deploy.gateway.success', payload: { pr_url: exec.pr_url }, created_at: new Date().toISOString() },
    ];
    expect(findDeployOutcomeForExecution(events, exec)).toBe('success');
  });

  it('matches by pr_number when pr_url missing on the event', () => {
    const events = [
      { type: 'deploy.gateway.success', payload: { pr_number: 9001 }, created_at: new Date().toISOString() },
    ];
    expect(findDeployOutcomeForExecution(events, exec)).toBe('success');
  });

  it('matches by branch when neither pr_url nor pr_number present', () => {
    const events = [
      { type: 'deploy.gateway.success', payload: { branch: exec.branch }, created_at: new Date().toISOString() },
    ];
    expect(findDeployOutcomeForExecution(events, exec)).toBe('success');
  });

  it('failed beats success in the same window', () => {
    const events = [
      { type: 'deploy.gateway.success', payload: { pr_url: exec.pr_url }, created_at: new Date().toISOString() },
      { type: 'deploy.gateway.failed', payload: { pr_url: exec.pr_url }, created_at: new Date().toISOString() },
    ];
    expect(findDeployOutcomeForExecution(events, exec)).toBe('failed');
  });

  it('ignores events older than the execution updated_at watermark', () => {
    const events = [
      { type: 'deploy.gateway.success', payload: { pr_url: exec.pr_url }, created_at: new Date(Date.now() - 60 * 60_000).toISOString() },
    ];
    expect(findDeployOutcomeForExecution(events, exec)).toBe('pending');
  });

  it('treats event.status="error" as failed even with non-failure topic', () => {
    const events = [
      { type: 'cicd.deploy.service.succeeded', payload: { pr_url: exec.pr_url }, status: 'error', created_at: new Date().toISOString() },
    ];
    expect(findDeployOutcomeForExecution(events, exec)).toBe('failed');
  });
});

describe('analyzeVerificationWindow', () => {
  const ourPrefix = 'VTID-DA-abc12345';
  const justNow = new Date().toISOString();
  const oneMinAgo = new Date(Date.now() - 60_000).toISOString();

  it('returns pending while window has not elapsed and no errors', () => {
    const r = analyzeVerificationWindow([], oneMinAgo, VERIFICATION_WINDOW_MS, ourPrefix);
    expect(r.state).toBe('pending');
    expect(r.blastRadiusEvents).toEqual([]);
  });

  it('passes once the verification window has elapsed cleanly', () => {
    const longAgo = new Date(Date.now() - VERIFICATION_WINDOW_MS - 60_000).toISOString();
    const r = analyzeVerificationWindow([], longAgo, VERIFICATION_WINDOW_MS, ourPrefix);
    expect(r.state).toBe('pass');
  });

  it('flags blast radius for unrelated error events during the window', () => {
    const events = [
      { type: 'orb.live.connection_failed', vtid: 'VTID-01155', status: 'error', created_at: justNow },
    ];
    const r = analyzeVerificationWindow(events, oneMinAgo, VERIFICATION_WINDOW_MS, ourPrefix);
    expect(r.state).toBe('fail');
    expect(r.blastRadiusEvents).toHaveLength(1);
    expect(r.blastRadiusEvents[0]).toEqual({ type: 'orb.live.connection_failed', vtid: 'VTID-01155' });
  });

  it('ignores error events whose VTID belongs to our own execution lineage', () => {
    const events = [
      { type: 'self-healing.something', vtid: ourPrefix + '-child', status: 'error', created_at: justNow },
    ];
    const r = analyzeVerificationWindow(events, oneMinAgo, VERIFICATION_WINDOW_MS, ourPrefix);
    expect(r.state).toBe('pending');
    expect(r.blastRadiusEvents).toEqual([]);
  });

  it('ignores error events from BEFORE the window started', () => {
    const before = new Date(Date.now() - 2 * 60_000).toISOString();
    const start = new Date(Date.now() - 60_000).toISOString();
    const events = [
      { type: 'random.fail', vtid: 'VTID-OTHER', status: 'error', created_at: before },
    ];
    const r = analyzeVerificationWindow(events, start, VERIFICATION_WINDOW_MS, ourPrefix);
    expect(r.state).toBe('pending');
  });

  it('ignores info / warning events — only status="error" counts as blast radius', () => {
    const events = [
      { type: 'random.info', vtid: 'VTID-OTHER', status: 'info', created_at: justNow },
      { type: 'random.warn', vtid: 'VTID-OTHER', status: 'warning', created_at: justNow },
    ];
    const r = analyzeVerificationWindow(events, oneMinAgo, VERIFICATION_WINDOW_MS, ourPrefix);
    expect(r.state).toBe('pending');
  });
});

describe('shouldAutoMerge', () => {
  it('allows low risk', () => {
    const r = shouldAutoMerge('low');
    expect(r.ok).toBe(true);
  });
  it('allows medium risk', () => {
    const r = shouldAutoMerge('medium');
    expect(r.ok).toBe(true);
  });
  it('blocks high risk even when CI is green (approve gate should already have rejected, belt-and-suspenders)', () => {
    const r = shouldAutoMerge('high');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/high/);
  });
  it('blocks on unknown risk class — refuse to auto-merge without explicit risk classification', () => {
    const r = shouldAutoMerge('unknown');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown/);
  });
});
