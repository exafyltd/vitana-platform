/**
 * VTID-05141 (P3) — the data/scheduled-workflows check reads its workflow
 * list from the published test catalog, capped, with the fixed five as the
 * fallback when the catalog cannot be read.
 */

jest.mock('../../src/services/aws-ecs-readonly', () => {
  const actual = jest.requireActual('../../src/services/aws-ecs-readonly');
  return { ...actual, describeEcsServices: jest.fn() };
});
jest.mock('../../src/services/redis-client', () => ({ getRedisClient: () => null, isRedisHealthy: async () => false }));
jest.mock('../../src/services/github-service', () => ({ getWorkflowRuns: jest.fn() }));
jest.mock('../../src/services/testing/test-catalog', () => ({ loadTestCatalog: jest.fn() }));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => null }));

import { getWorkflowRuns } from '../../src/services/github-service';
import { loadTestCatalog } from '../../src/services/testing/test-catalog';
import {
  FALLBACK_SCHEDULED_WORKFLOWS,
  MAX_SCHEDULED_WORKFLOWS,
  RUNTIME_CHECKS,
  resetOpsRuntimeCacheForTests,
  resolveScheduledWorkflows,
  scheduledWorkflowsFromCatalog,
} from '../../src/routes/ops-runtime-health';

const REPO = 'exafyltd/vitana-platform';
const mockRuns = getWorkflowRuns as jest.Mock;
const mockLoad = loadTestCatalog as jest.Mock;

const sched = [{ cron: '0 6 * * *', human: 'daily 06:00' }];
const fixture = {
  workflows: [
    { id: 'platform:NIGHTLY-E2E.yml', repo: REPO, file: 'NIGHTLY-E2E.yml', schedules: sched },
    { id: 'platform:GATEWAY-CI.yml', repo: REPO, file: 'GATEWAY-CI.yml', schedules: [] },
    { id: 'frontend:FRONTEND-NIGHTLY.yml', repo: 'exafyltd/vitana-v1', file: 'FRONTEND-NIGHTLY.yml', schedules: sched },
    { id: 'platform:AUDIT.yml', repo: REPO, file: 'AUDIT.yml', schedules: sched },
  ],
  other_workflows: [
    { id: 'platform:MORNING-SYSTEM-HEALTH-CHECK.yml', file: 'MORNING-SYSTEM-HEALTH-CHECK.yml', kind: 'other', schedules: sched },
    { id: 'platform:DEPLOY.yml', file: 'DEPLOY.yml', kind: 'job', schedules: [] },
    { id: 'frontend:SYNC.yml', file: 'SYNC.yml', kind: 'other', schedules: sched },
    // Same file listed twice must be checked once.
    { id: 'platform:AUDIT.yml', file: 'AUDIT.yml', kind: 'other', schedules: sched },
  ],
};

describe('scheduledWorkflowsFromCatalog', () => {
  it('takes every scheduled workflow of the repo from both lists, sorted and de-duplicated', () => {
    expect(scheduledWorkflowsFromCatalog(fixture as any, REPO)).toEqual([
      'AUDIT.yml',
      'MORNING-SYSTEM-HEALTH-CHECK.yml',
      'NIGHTLY-E2E.yml',
    ]);
  });

  it('caps the list at MAX_SCHEDULED_WORKFLOWS in stable file order', () => {
    const many = Array.from({ length: 45 }, (_, i) => {
      const file = `WF-${String(44 - i).padStart(2, '0')}.yml`;
      return { id: `platform:${file}`, repo: REPO, file, schedules: sched };
    });
    const out = scheduledWorkflowsFromCatalog({ workflows: many } as any, REPO);
    expect(MAX_SCHEDULED_WORKFLOWS).toBe(30);
    expect(out).toHaveLength(30);
    expect(out[0]).toBe('WF-00.yml');
    expect(out[29]).toBe('WF-29.yml');
  });
});

describe('resolveScheduledWorkflows', () => {
  it('uses the catalog when it yields workflows', async () => {
    const r = await resolveScheduledWorkflows(REPO, async () => ({ catalog: fixture as any }));
    expect(r.source).toBe('catalog');
    expect(r.workflows).toContain('NIGHTLY-E2E.yml');
  });

  it('falls back to the fixed five when the catalog read throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await resolveScheduledWorkflows(REPO, async () => { throw new Error('test catalog is malformed'); });
    expect(r).toEqual({ workflows: [...FALLBACK_SCHEDULED_WORKFLOWS], source: 'fallback' });
    expect(FALLBACK_SCHEDULED_WORKFLOWS).toHaveLength(5);
    warn.mockRestore();
  });

  it('falls back when filtering a malformed catalog throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await resolveScheduledWorkflows(REPO, async () => ({ catalog: { workflows: [null] } as any }));
    expect(r.source).toBe('fallback');
    warn.mockRestore();
  });

  it('falls back when the catalog has no scheduled workflow for the repo', async () => {
    const r = await resolveScheduledWorkflows(REPO, async () => ({ catalog: { workflows: [] } as any }));
    expect(r.source).toBe('fallback');
  });
});

describe('data/scheduled-workflows check', () => {
  const env = { ...process.env };
  beforeEach(() => {
    resetOpsRuntimeCacheForTests();
    mockRuns.mockReset();
    mockLoad.mockReset();
    process.env.GITHUB_TOKEN = 'x';
    delete process.env.GITHUB_REPO;
  });
  afterAll(() => { process.env = env; });

  it('checks the catalog workflows sequentially and reports source=catalog', async () => {
    mockLoad.mockResolvedValue({ catalog: fixture });
    let active = 0;
    let maxActive = 0;
    mockRuns.mockImplementation(async (_repo: string, wf: string) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 2));
      active -= 1;
      return { workflow_runs: [{ status: 'completed', conclusion: wf === 'AUDIT.yml' ? 'failure' : 'success' }] };
    });
    const out = await RUNTIME_CHECKS['data/scheduled-workflows']();
    expect(maxActive).toBe(1);
    expect(mockRuns.mock.calls.map((c) => c[1])).toEqual(['AUDIT.yml', 'MORNING-SYSTEM-HEALTH-CHECK.yml', 'NIGHTLY-E2E.yml']);
    expect(out.source).toBe('catalog');
    expect(out.status).toBe('degraded');
    expect(out.failing).toEqual(['AUDIT.yml']);
  });

  it('checks the fixed five and reports source=fallback when the catalog is unavailable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockLoad.mockRejectedValue(new Error('test catalog not published'));
    mockRuns.mockResolvedValue({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] });
    const out = await RUNTIME_CHECKS['data/scheduled-workflows']();
    expect(mockRuns.mock.calls.map((c) => c[1])).toEqual([...FALLBACK_SCHEDULED_WORKFLOWS]);
    expect(out).toMatchObject({ status: 'ok', source: 'fallback' });
    warn.mockRestore();
  });
});
