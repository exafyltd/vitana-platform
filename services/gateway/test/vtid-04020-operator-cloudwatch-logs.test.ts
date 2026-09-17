/**
 * VTID-04020 (W5a): dev_cloudwatch_logs — the Operator Console's read-only
 * CloudWatch Logs tool. Pins the pure query normalisation + bounding
 * (allowlisted /ecs/vitana-* groups, clamped window/limit, clipped
 * messages, total budget), the FilterLogEvents call shape (read-only,
 * bounded window), and the tool wiring: kill switch, role gate, argument
 * validation, honest error on an AWS/IAM failure.
 */

jest.mock('node-fetch');
jest.mock('../src/services/github-service', () => ({ searchCode: jest.fn(), getFileContents: jest.fn(), listOpenPrsWithStatus: jest.fn() }));
jest.mock('../src/services/aws-ecs-readonly', () => ({ describeEcsServices: jest.fn(), ALLOWED_ECS_SERVICES: ['vitana-gateway'] }));

const sendMock = jest.fn();
jest.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
  FilterLogEventsCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { executeTool, setThreadIdentity } from '../src/services/gemini-operator';
import {
  ALLOWED_LOG_GROUP_RE, LOGS_DEFAULT_LIMIT, LOGS_DEFAULT_MINUTES, LOGS_MAX_LIMIT, LOGS_MAX_MINUTES, LOGS_MESSAGE_MAX_CHARS,
  boundLogEvents, filterVitanaLogs, normalizeLogsQuery,
} from '../src/services/aws-cloudwatch-logs-readonly';

describe('VTID-04020 normalizeLogsQuery (pure)', () => {
  it('accepts only /ecs/vitana-<service> groups', () => {
    expect(ALLOWED_LOG_GROUP_RE.test('/ecs/vitana-gateway')).toBe(true);
    expect(ALLOWED_LOG_GROUP_RE.test('/ecs/vitana-gateway-awsdr')).toBe(true);
    expect(ALLOWED_LOG_GROUP_RE.test('/ecs/vitana-autopilot-executor')).toBe(true);
    for (const bad of ['/ecs/other', '/aws/lambda/vitana-push-dispatch', 'vitana-gateway', '/ecs/vitana-', '/ecs/vitana-Gateway', '/ecs/vitana-x/y', '']) {
      expect(() => normalizeLogsQuery({ logGroup: bad })).toThrow(/not an \/ecs\/vitana-<service> log group/);
    }
  });

  it('clamps the window and the limit, defaults them, and trims/bounds the filter pattern', () => {
    expect(normalizeLogsQuery({ logGroup: '/ecs/vitana-gateway' })).toEqual({ logGroup: '/ecs/vitana-gateway', filterPattern: undefined, minutes: LOGS_DEFAULT_MINUTES, limit: LOGS_DEFAULT_LIMIT });
    expect(normalizeLogsQuery({ logGroup: ' /ecs/vitana-gateway ', minutes: 99_999, limit: 10_000, filterPattern: '  ERROR ' })).toEqual({ logGroup: '/ecs/vitana-gateway', filterPattern: 'ERROR', minutes: LOGS_MAX_MINUTES, limit: LOGS_MAX_LIMIT });
    expect(normalizeLogsQuery({ logGroup: '/ecs/vitana-gateway', minutes: -5, limit: 0 }).minutes).toBe(LOGS_DEFAULT_MINUTES);
    expect(normalizeLogsQuery({ logGroup: '/ecs/vitana-gateway', minutes: 7.9, limit: 3.2 })).toMatchObject({ minutes: 7, limit: 3 });
    expect(normalizeLogsQuery({ logGroup: '/ecs/vitana-gateway', filterPattern: 'x'.repeat(500) }).filterPattern!.length).toBe(200);
  });
});

describe('VTID-04020 boundLogEvents (pure)', () => {
  it('clips long messages, keeps the stream tail, and stops at the total budget', () => {
    const { events, truncated } = boundLogEvents([
      { timestamp: 1_758_000_000_000, logStreamName: 'ecs/gateway/abc123', message: 'short\n' },
      { timestamp: 1_758_000_001_000, logStreamName: 'ecs/gateway/abc123', message: 'y'.repeat(LOGS_MESSAGE_MAX_CHARS + 50) },
    ]);
    expect(truncated).toBe(false);
    expect(events[0]).toEqual({ timestamp: new Date(1_758_000_000_000).toISOString(), stream: 'abc123', message: 'short' });
    expect(events[1].message.length).toBe(LOGS_MESSAGE_MAX_CHARS + 1);
    expect(events[1].message.endsWith('…')).toBe(true);
    const big = boundLogEvents(Array.from({ length: 100 }, () => ({ message: 'z'.repeat(500) })), 1_200);
    expect(big.events).toHaveLength(2);
    expect(big.truncated).toBe(true);
  });
});

describe('VTID-04020 filterVitanaLogs (SDK call shape)', () => {
  beforeEach(() => sendMock.mockReset());

  it('sends one FilterLogEvents for the bounded window and reports truncation from nextToken', async () => {
    sendMock.mockResolvedValue({ events: [{ timestamp: 1_000, logStreamName: 's/1', message: 'hello' }], nextToken: 'more' });
    const r = await filterVitanaLogs({ logGroup: '/ecs/vitana-gateway', filterPattern: 'ERROR', minutes: 10, limit: 5 }, () => 1_000_000);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].input).toEqual({ logGroupName: '/ecs/vitana-gateway', startTime: 1_000_000 - 10 * 60_000, endTime: 1_000_000, limit: 5, filterPattern: 'ERROR', interleaved: true });
    expect(r).toEqual({ log_group: '/ecs/vitana-gateway', window_minutes: 10, filter_pattern: 'ERROR', events: [{ timestamp: new Date(1_000).toISOString(), stream: '1', message: 'hello' }], truncated: true });
  });

  it('an empty window carries a note and no filterPattern key is sent when none was given', async () => {
    sendMock.mockResolvedValue({ events: [] });
    const r = await filterVitanaLogs({ logGroup: '/ecs/vitana-gateway' }, () => 5_000_000);
    expect(sendMock.mock.calls[0][0].input).not.toHaveProperty('filterPattern');
    expect(r.events).toEqual([]);
    expect(r.note).toMatch(/no events matched/);
    expect(r.truncated).toBe(false);
  });

  it('refuses a non-allowlisted group before any AWS call', async () => {
    await expect(filterVitanaLogs({ logGroup: '/aws/lambda/x' })).rejects.toThrow(/not an \/ecs\/vitana-<service> log group/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('VTID-04020 dev_cloudwatch_logs tool wiring', () => {
  const ORIGINAL_ENV = process.env;
  const DEV_THREAD = 'thread-dev-logs';
  const NON_DEV_THREAD = 'thread-community-logs';

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPERATOR_AWS_READONLY_ENABLED: 'true', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE: 'test-key' };
    sendMock.mockReset();
    setThreadIdentity(DEV_THREAD, { tenant_id: 't1', user_id: 'u1', role: 'developer' });
    setThreadIdentity(NON_DEV_THREAD, { tenant_id: 't1', user_id: 'u2', role: 'community' });
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('is blocked for a non-developer role', async () => {
    const r = await executeTool('dev_cloudwatch_logs', { log_group: '/ecs/vitana-gateway' }, NON_DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Access denied/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('is kill-switched off by default', async () => {
    delete process.env.OPERATOR_AWS_READONLY_ENABLED;
    const r = await executeTool('dev_cloudwatch_logs', { log_group: '/ecs/vitana-gateway' }, DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/operator_aws_readonly_disabled/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('requires log_group and refuses a group outside the documented shape without an AWS call', async () => {
    expect((await executeTool('dev_cloudwatch_logs', {}, DEV_THREAD)).error).toMatch(/log_group is required/);
    const r = await executeTool('dev_cloudwatch_logs', { log_group: '/aws/lambda/vitana-push-dispatch' }, DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/CloudWatch logs read failed: .*not an \/ecs\/vitana-<service> log group/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns the bounded events for a developer', async () => {
    sendMock.mockResolvedValue({ events: [{ timestamp: 1_758_000_000_000, logStreamName: 'ecs/gateway/t1', message: '[VTID-04007] run_task called (88 chars)' }] });
    const r = await executeTool('dev_cloudwatch_logs', { log_group: '/ecs/vitana-gateway', filter_pattern: '[VTID-04007]', minutes: 15, limit: 20 }, DEV_THREAD);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ log_group: '/ecs/vitana-gateway', window_minutes: 15, filter_pattern: '[VTID-04007]', truncated: false });
    expect((r.data as any).events[0].message).toContain('run_task called');
    expect(sendMock.mock.calls[0][0].input.limit).toBe(20);
  });

  it('surfaces an IAM/AWS failure verbatim instead of an empty result', async () => {
    sendMock.mockRejectedValue(new Error('AccessDeniedException: User is not authorized to perform: logs:FilterLogEvents'));
    const r = await executeTool('dev_cloudwatch_logs', { log_group: '/ecs/vitana-gateway' }, DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/CloudWatch logs read failed: AccessDeniedException.*logs:FilterLogEvents/);
  });
});
