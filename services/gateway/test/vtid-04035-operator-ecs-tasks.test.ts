/**
 * VTID-04035 (W5c): dev_ecs_tasks — the Operator Console's read-only ECS
 * task-level view (ListTasks + DescribeTasks) over one documented service
 * or the autopilot-executor task family. Pins the pure query normalisation
 * (allowlisted targets, status enum, clamped limit), the task summary
 * shape, the SDK call shape (read-only, two commands, bounded), and the
 * tool wiring: kill switch, role gate, argument validation, honest error
 * on an AWS/IAM failure.
 */

jest.mock('node-fetch');
jest.mock('../src/services/github-service', () => ({ searchCode: jest.fn(), getFileContents: jest.fn(), listOpenPrsWithStatus: jest.fn(), listOpenPrsBare: jest.fn() }));

const sendMock = jest.fn();
jest.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
  DescribeServicesCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'DescribeServices', input })),
  ListTasksCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'ListTasks', input })),
  DescribeTasksCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'DescribeTasks', input })),
  StopTaskCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'StopTask', input })),
  RunTaskCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'RunTask', input })),
}));

import { executeTool, setThreadIdentity } from '../src/services/gemini-operator';
import {
  ALLOWED_ECS_SERVICES, ALLOWED_ECS_TASK_FAMILIES, TASKS_DEFAULT_LIMIT, TASKS_MAX_LIMIT,
  normalizeTasksQuery, summarizeEcsTask, listEcsTasks,
} from '../src/services/aws-ecs-readonly';

const RUNNING_TASK = {
  taskArn: 'arn:aws:ecs:eu-central-1:472838866351:task/Vitana-ECS-Cluster/dabb2bb6aaaa',
  lastStatus: 'RUNNING', desiredStatus: 'RUNNING', healthStatus: 'UNKNOWN',
  taskDefinitionArn: 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-autopilot-executor:10',
  group: 'family:vitana-autopilot-executor', launchType: 'FARGATE', cpu: '2048', memory: '4096',
  createdAt: new Date('2026-09-18T00:30:00Z'), startedAt: new Date('2026-09-18T00:30:40Z'),
  containers: [{ name: 'executor', lastStatus: 'RUNNING', image: '472838866351.dkr.ecr.eu-central-1.amazonaws.com/vitana-autopilot-executor:8131af9' }],
};
const STOPPED_TASK = {
  taskArn: 'arn:aws:ecs:eu-central-1:472838866351:task/Vitana-ECS-Cluster/0f3a9c1e2b4d',
  lastStatus: 'STOPPED', desiredStatus: 'STOPPED', taskDefinitionArn: 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-autopilot-executor:2',
  group: 'family:vitana-autopilot-executor', createdAt: new Date('2026-09-17T23:00:00Z'), startedAt: new Date('2026-09-17T23:00:30Z'), stoppedAt: new Date('2026-09-17T23:01:00Z'),
  stopCode: 'EssentialContainerExited', stoppedReason: 'Essential container in task exited' + 'x'.repeat(400),
  containers: [{ name: 'executor', lastStatus: 'STOPPED', exitCode: 2, reason: 'exit 2', image: 'repo/vitana-autopilot-executor:old' }],
};

describe('VTID-04035 normalizeTasksQuery (pure)', () => {
  it('accepts every §1b service by name and the executor family, refusing anything else before an AWS call', () => {
    for (const svc of ALLOWED_ECS_SERVICES) expect(normalizeTasksQuery({ target: svc })).toMatchObject({ target: svc, kind: 'service' });
    for (const fam of ALLOWED_ECS_TASK_FAMILIES) expect(normalizeTasksQuery({ target: fam })).toMatchObject({ target: fam, kind: 'family' });
    for (const bad of ['', 'vitana-mcp-gateway', 'vitana-gateway-awsdr ', 'Vitana-Gateway', 'family:vitana-autopilot-executor']) {
      if (bad === 'vitana-gateway-awsdr ') { expect(normalizeTasksQuery({ target: bad }).target).toBe('vitana-gateway-awsdr'); continue; }
      expect(() => normalizeTasksQuery({ target: bad })).toThrow(/Unknown\/undocumented ECS target/);
    }
  });

  it('defaults and clamps: RUNNING unless STOPPED (case-insensitive), limit default/max, garbage limit → default', () => {
    expect(normalizeTasksQuery({ target: 'vitana-gateway' })).toEqual({ target: 'vitana-gateway', kind: 'service', desiredStatus: 'RUNNING', limit: TASKS_DEFAULT_LIMIT });
    expect(normalizeTasksQuery({ target: 'vitana-gateway', desiredStatus: 'stopped', limit: 999 })).toMatchObject({ desiredStatus: 'STOPPED', limit: TASKS_MAX_LIMIT });
    expect(normalizeTasksQuery({ target: 'vitana-gateway', limit: 0 }).limit).toBe(TASKS_DEFAULT_LIMIT);
    expect(normalizeTasksQuery({ target: 'vitana-gateway', limit: 3.9 }).limit).toBe(3);
    expect(() => normalizeTasksQuery({ target: 'vitana-gateway', desiredStatus: 'PENDING' })).toThrow(/desired_status must be one of RUNNING, STOPPED/);
  });
});

describe('VTID-04035 summarizeEcsTask (pure)', () => {
  it('reduces ARNs to ids, images to their tail, dates to ISO, clips reasons, and tolerates missing fields', () => {
    const r = summarizeEcsTask(RUNNING_TASK);
    expect(r).toMatchObject({ task_id: 'dabb2bb6aaaa', last_status: 'RUNNING', task_definition: 'vitana-autopilot-executor:10', launch_type: 'FARGATE', cpu: '2048', started_at: '2026-09-18T00:30:40.000Z', stopped_at: null, stop_code: null, stopped_reason: null });
    expect(r.containers).toEqual([{ name: 'executor', last_status: 'RUNNING', exit_code: null, reason: null, image: 'vitana-autopilot-executor:8131af9' }]);
    const s = summarizeEcsTask(STOPPED_TASK);
    expect(s.stopped_reason!.length).toBe(300);
    expect(s.containers[0]).toMatchObject({ exit_code: 2, reason: 'exit 2', image: 'vitana-autopilot-executor:old' });
    expect(summarizeEcsTask({})).toMatchObject({ task_id: '', last_status: 'UNKNOWN', containers: [], created_at: null });
  });
});

// VTID-04038: availability zone + Fargate platform version, only when ECS
// returns them (DescribeTasks omits both for EC2-launched tasks).
describe('VTID-04038 summarizeEcsTask availability zone + platform version', () => {
  it('reports availability_zone and platform_version after launch_type when ECS returns them', () => {
    const r = summarizeEcsTask({
      taskArn: RUNNING_TASK.taskArn, lastStatus: 'RUNNING', desiredStatus: 'RUNNING',
      taskDefinitionArn: RUNNING_TASK.taskDefinitionArn, group: RUNNING_TASK.group, launchType: 'FARGATE',
      availabilityZone: 'eu-central-1a', platformVersion: '1.4.0',
      createdAt: RUNNING_TASK.createdAt, containers: RUNNING_TASK.containers,
    });
    expect(r).toMatchObject({ launch_type: 'FARGATE', availability_zone: 'eu-central-1a', platform_version: '1.4.0', cpu: null, memory: null });
    // Bounded like every other ECS free-form string here.
    const bounded = summarizeEcsTask({ availabilityZone: 'z'.repeat(400), platformVersion: '9'.repeat(400) });
    expect(bounded.availability_zone!.length).toBe(300);
    expect(bounded.platform_version!.length).toBe(300);
    // Placement: immediately after launch_type, cpu/memory unchanged right behind them.
    expect(Object.keys(r)).toEqual([
      'task_id', 'task_arn', 'last_status', 'desired_status', 'health_status', 'task_definition', 'group', 'launch_type',
      'availability_zone', 'platform_version', 'cpu', 'memory', 'created_at', 'started_at', 'stopped_at', 'stop_code',
      'stopped_reason', 'containers',
    ]);
  });

  it('yields null for both when the described record does not carry them (EC2 launch type, or absent fields)', () => {
    expect(summarizeEcsTask({ launchType: 'EC2', availabilityZone: undefined, platformVersion: undefined })).toMatchObject({
      launch_type: 'EC2', availability_zone: null, platform_version: null,
    });
    expect(summarizeEcsTask({})).toMatchObject({ availability_zone: null, platform_version: null });
    expect(summarizeEcsTask({ availabilityZone: '', platformVersion: '' })).toMatchObject({ availability_zone: null, platform_version: null });
  });
});

describe('VTID-04035 listEcsTasks (SDK call shape)', () => {
  beforeEach(() => sendMock.mockReset());

  it('a service lists by serviceName, describes the listed ARNs, sorts newest first and reports truncation from nextToken', async () => {
    sendMock.mockResolvedValueOnce({ taskArns: [STOPPED_TASK.taskArn, RUNNING_TASK.taskArn], nextToken: 'more' });
    sendMock.mockResolvedValueOnce({ tasks: [STOPPED_TASK, RUNNING_TASK] });
    const r = await listEcsTasks({ target: 'vitana-gateway', limit: 2 });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0]).toEqual({ kind: 'ListTasks', input: { cluster: 'Vitana-ECS-Cluster', serviceName: 'vitana-gateway', desiredStatus: 'RUNNING', maxResults: 2 } });
    expect(sendMock.mock.calls[1][0]).toEqual({ kind: 'DescribeTasks', input: { cluster: 'Vitana-ECS-Cluster', tasks: [STOPPED_TASK.taskArn, RUNNING_TASK.taskArn] } });
    expect(r.kind).toBe('service');
    expect(r.truncated).toBe(true);
    expect(r.tasks.map(t => t.task_id)).toEqual(['dabb2bb6aaaa', '0f3a9c1e2b4d']);
  });

  it('a family lists by family, and an empty listing skips DescribeTasks with a note', async () => {
    sendMock.mockResolvedValueOnce({ taskArns: [] });
    const r = await listEcsTasks({ target: 'vitana-autopilot-executor', desiredStatus: 'STOPPED' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].input).toEqual({ cluster: 'Vitana-ECS-Cluster', family: 'vitana-autopilot-executor', desiredStatus: 'STOPPED', maxResults: TASKS_DEFAULT_LIMIT });
    expect(r).toEqual({ target: 'vitana-autopilot-executor', kind: 'family', desired_status: 'STOPPED', tasks: [], truncated: false, note: 'no STOPPED tasks for vitana-autopilot-executor right now' });
  });

  it('refuses an unlisted target before any AWS call', async () => {
    await expect(listEcsTasks({ target: 'vitana-mcp-gateway' })).rejects.toThrow(/Unknown\/undocumented ECS target/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('VTID-04035 dev_ecs_tasks tool wiring', () => {
  const ORIGINAL_ENV = process.env;
  const DEV_THREAD = 'thread-dev-tasks';
  const NON_DEV_THREAD = 'thread-community-tasks';

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPERATOR_AWS_READONLY_ENABLED: 'true', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE: 'test-key' };
    sendMock.mockReset();
    setThreadIdentity(DEV_THREAD, { tenant_id: 't1', user_id: 'u1', role: 'developer' });
    setThreadIdentity(NON_DEV_THREAD, { tenant_id: 't1', user_id: 'u2', role: 'community' });
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('is blocked for a non-developer role and kill-switched off by default', async () => {
    const r = await executeTool('dev_ecs_tasks', { target: 'vitana-gateway' }, NON_DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Access denied/);
    delete process.env.OPERATOR_AWS_READONLY_ENABLED;
    const off = await executeTool('dev_ecs_tasks', { target: 'vitana-gateway' }, DEV_THREAD);
    expect(off.error).toMatch(/operator_aws_readonly_disabled/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('requires target and refuses an undocumented one without an AWS call', async () => {
    expect((await executeTool('dev_ecs_tasks', {}, DEV_THREAD)).error).toMatch(/target is required/);
    const r = await executeTool('dev_ecs_tasks', { target: 'vitana-mcp-gateway' }, DEV_THREAD);
    expect(r.error).toMatch(/ECS tasks read failed: Unknown\/undocumented ECS target/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns the bounded task list for a developer', async () => {
    sendMock.mockResolvedValueOnce({ taskArns: [RUNNING_TASK.taskArn] });
    sendMock.mockResolvedValueOnce({ tasks: [RUNNING_TASK] });
    const r = await executeTool('dev_ecs_tasks', { target: 'vitana-autopilot-executor', limit: 5 }, DEV_THREAD);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ target: 'vitana-autopilot-executor', kind: 'family', desired_status: 'RUNNING', truncated: false });
    expect((r.data as any).tasks[0]).toMatchObject({ task_id: 'dabb2bb6aaaa', task_definition: 'vitana-autopilot-executor:10' });
    expect(sendMock.mock.calls[0][0].input.maxResults).toBe(5);
  });

  it('surfaces an IAM/AWS failure verbatim instead of an empty result', async () => {
    sendMock.mockRejectedValue(new Error('AccessDeniedException: User is not authorized to perform: ecs:ListTasks'));
    const r = await executeTool('dev_ecs_tasks', { target: 'vitana-gateway' }, DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECS tasks read failed: AccessDeniedException.*ecs:ListTasks/);
  });
});
