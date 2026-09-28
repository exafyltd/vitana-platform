/**
 * VTID-04664 — Service Health Phase 3: checks for systems that had none
 * (routes/ops-runtime-health.ts).
 */

import express from 'express';
import request from 'supertest';

const mockDescribe = jest.fn();
jest.mock('../src/services/aws-ecs-readonly', () => {
  const actual = jest.requireActual('../src/services/aws-ecs-readonly');
  return { ...actual, describeEcsServices: (...a: unknown[]) => mockDescribe(...a) };
});
jest.mock('../src/services/redis-client', () => ({ getRedisClient: () => null, isRedisHealthy: async () => false }));
jest.mock('../src/services/github-service', () => ({ getWorkflowRuns: jest.fn() }));

let tableRows: Record<string, unknown[]> = {};
let tableCount = 0;
jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const b: any = {};
      for (const m of ['select', 'in', 'eq', 'is', 'gte', 'order']) b[m] = () => b;
      b.limit = () => Promise.resolve({ data: tableRows[table] ?? [], error: null });
      b.then = (resolve: (v: unknown) => void) => resolve({ count: tableCount, data: null, error: null });
      return b;
    },
  }),
}));

import {
  opsRuntimeHealthRouter,
  resetOpsRuntimeCacheForTests,
  evalLatestEvent,
  evalEcsService,
  evalStuckRuns,
  evalApprovalBacklog,
  evalSuccessRate,
  evalScanFreshness,
  evalPollyConfig,
  evalSerbianBridge,
  evalTitanConfig,
  evalVoiceErrors,
  evalOasisLag,
  evalScheduledWorkflows,
  evalStuckTickets,
  parseTargets,
  RUNTIME_CHECKS,
} from '../src/routes/ops-runtime-health';
import { SERVICE_HEALTH_REGISTRY } from '../src/constants/service-health-registry';
import { ALLOWED_ECS_SERVICES } from '../src/services/aws-ecs-readonly';
import { classifyHealthResponse, summarize } from '../src/services/service-health-probe';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();

function app() {
  const a = express();
  a.use('/api/v1/ops/runtime', opsRuntimeHealthRouter);
  return a;
}

beforeEach(() => {
  resetOpsRuntimeCacheForTests();
  mockDescribe.mockReset();
  tableRows = {};
  tableCount = 0;
});

describe('evaluators', () => {
  it('latest event: pass is ok, fail uses the check-specific status, nothing is degraded', () => {
    const o = { okSuffix: '.passed', failStatus: 'down' as const, staleHours: 72, now: NOW };
    expect(evalLatestEvent({ topic: 'staging.verify.passed', created_at: ago(30) }, o).status).toBe('ok');
    expect(evalLatestEvent({ topic: 'staging.verify.failed', created_at: ago(30) }, o).status).toBe('down');
    expect(evalLatestEvent(null, o).status).toBe('degraded');
    expect(evalLatestEvent({ topic: 'staging.verify.passed', created_at: ago(80 * 60) }, o).reason).toBe('last_event_stale');
  });

  it('ECS: running == desired is ok; zero running is down; rollouts and shortfalls are degraded', () => {
    const svc = (over: object) => ({
      serviceName: 'x', status: 'ACTIVE', desiredCount: 2, runningCount: 2, pendingCount: 0,
      taskDefinition: 'arn:aws:ecs:eu-central-1:1:task-definition/vitana-gateway:491',
      deployments: [{ status: 'PRIMARY', desiredCount: 2, runningCount: 2, rolloutState: 'COMPLETED' }],
      ...over,
    });
    expect(evalEcsService(svc({}))).toMatchObject({ status: 'ok', task_definition: 'vitana-gateway:491' });
    expect(evalEcsService(svc({ runningCount: 0 })).status).toBe('down');
    expect(evalEcsService(svc({ runningCount: 1 })).reason).toBe('below_desired');
    expect(evalEcsService(svc({ desiredCount: 0, runningCount: 0 })).reason).toBe('scaled_to_zero');
    expect(evalEcsService(svc({ deployments: [{ status: 'PRIMARY', desiredCount: 2, runningCount: 2, rolloutState: 'IN_PROGRESS' }] })).reason).toBe('rollout_in_progress');
    expect(evalEcsService(svc({ status: 'DRAINING' })).status).toBe('down');
    expect(evalEcsService(undefined).status).toBe('down');
  });

  it('autopilot evaluators', () => {
    expect(evalStuckRuns([{ updated_at: ago(5) }], NOW).status).toBe('ok');
    expect(evalStuckRuns([{ updated_at: ago(45) }], NOW).status).toBe('degraded');
    expect(evalStuckRuns([{ updated_at: ago(200) }], NOW).status).toBe('down');
    expect(evalApprovalBacklog([{ updated_at: ago(60) }], NOW).status).toBe('ok');
    expect(evalApprovalBacklog([{ updated_at: ago(80 * 60) }], NOW).status).toBe('degraded');
    const many = (ok: number, bad: number) => [
      ...Array.from({ length: ok }, () => ({ status: 'completed' })),
      ...Array.from({ length: bad }, () => ({ status: 'failed_escalated' })),
    ];
    expect(evalSuccessRate(many(17, 488))).toMatchObject({ status: 'degraded', reason: 'low_success_rate' });
    expect(evalSuccessRate(many(8, 2)).status).toBe('ok');
    expect(evalSuccessRate(many(1, 3))).toMatchObject({ status: 'ok', reason: 'small_sample' });
    expect(evalScanFreshness(null, NOW).status).toBe('degraded');
    expect(evalScanFreshness({ started_at: ago(60), status: 'done' }, NOW).status).toBe('ok');
    expect(evalScanFreshness({ started_at: ago(60), status: 'failed' }, NOW).reason).toBe('last_scan_failed');
    expect(evalScanFreshness({ started_at: ago(30 * 60), status: 'done' }, NOW).reason).toBe('last_scan_stale');
  });

  it('voice, AI and media configuration', () => {
    expect(evalPollyConfig({ TTS_PROVIDER: 'polly', TTS_POLLY_STRICT: 'true' }).status).toBe('ok');
    expect(evalPollyConfig({ TTS_PROVIDER: 'polly' }).status).toBe('degraded');
    expect(evalPollyConfig({}).reason).toBe('tts_provider_not_polly');
    expect(evalSerbianBridge({}, false).status).toBe('not_configured');
    expect(evalSerbianBridge({ GOOGLE_CLOUD_PROJECT: 'lovable-vitana-vers1', GCP_SERVICE_ACCOUNT_JSON: '{}' }, true).status).toBe('down');
    expect(evalSerbianBridge({ GOOGLE_CLOUD_PROJECT: 'project-new' }, true).reason).toBe('bridge_enabled_without_credentials');
    expect(evalSerbianBridge({ GOOGLE_CLOUD_PROJECT: 'project-new', GCP_SERVICE_ACCOUNT_JSON: '{}' }, true).status).toBe('ok');
    expect(evalTitanConfig({ IMAGE_PROVIDER: 'bedrock', BEDROCK_ROLE_ARN: 'arn' }).status).toBe('ok');
    expect(evalTitanConfig({ IMAGE_PROVIDER: 'vertex' }).status).toBe('down');
    expect(evalVoiceErrors(419, 16).status).toBe('ok');
    expect(evalVoiceErrors(100, 15).status).toBe('degraded');
    expect(evalVoiceErrors(100, 40).status).toBe('down');
    expect(evalVoiceErrors(0, 0).status).toBe('ok');
  });

  it('data, scheduling and support', () => {
    expect(evalOasisLag(ago(1), NOW).status).toBe('ok');
    expect(evalOasisLag(ago(8), NOW).status).toBe('degraded');
    expect(evalOasisLag(ago(30), NOW).status).toBe('down');
    expect(evalOasisLag(null, NOW).status).toBe('down');
    expect(evalScheduledWorkflows([{ workflow: 'A.yml', conclusion: 'success' }]).status).toBe('ok');
    expect(evalScheduledWorkflows([{ workflow: 'A.yml', conclusion: 'failure' }])).toMatchObject({ status: 'degraded', failing: ['A.yml'] });
    expect(evalStuckTickets([{ created_at: ago(60), status: 'new' }], NOW).status).toBe('ok');
    expect(evalStuckTickets([{ created_at: ago(8 * 24 * 60), status: 'triaged' }], NOW).status).toBe('degraded');
    expect(parseTargets('staging=https://s/x,prod=https://p/x')).toEqual({ staging: 'https://s/x', prod: 'https://p/x' });
  });
});

describe('routes', () => {
  it('every registered /ops/runtime URL has a handler, and every handler is registered', () => {
    const registered = SERVICE_HEALTH_REGISTRY.map((e) => e.url).filter((u) => u.startsWith('/api/v1/ops/runtime/'));
    const served = [
      ...Object.keys(RUNTIME_CHECKS).map((k) => `/api/v1/ops/runtime/${k}`),
      ...ALLOWED_ECS_SERVICES.map((s) => `/api/v1/ops/runtime/aws/ecs/${s}`),
    ];
    expect([...registered].sort()).toEqual([...served].sort());
  });

  it('one DescribeServices call serves all nine ECS checks', async () => {
    mockDescribe.mockResolvedValue(
      ALLOWED_ECS_SERVICES.map((serviceName) => ({
        serviceName, status: 'ACTIVE', desiredCount: 1, runningCount: 1, pendingCount: 0,
        taskDefinition: `${serviceName}:1`, deployments: [{ status: 'PRIMARY', desiredCount: 1, runningCount: 1, rolloutState: 'COMPLETED' }],
      })),
    );
    const a = app();
    for (const s of ALLOWED_ECS_SERVICES) {
      const res = await request(a).get(`/api/v1/ops/runtime/aws/ecs/${s}`);
      expect(res.body).toMatchObject({ status: 'ok', service: s });
    }
    expect(mockDescribe).toHaveBeenCalledTimes(1);
  });

  it('an AWS AccessDenied is no_access (grey), not an outage', async () => {
    const err = new Error('User is not authorized to perform: ecs:DescribeServices');
    err.name = 'AccessDeniedException';
    mockDescribe.mockRejectedValue(err);
    const res = await request(app()).get('/api/v1/ops/runtime/aws/ecs/vitana-gateway');
    expect(res.body.status).toBe('no_access');
    const c = classifyHealthResponse(res.status, res.body);
    expect(c).toEqual({ status: 'no_access', healthy: false });
  });

  it('a deliberately-off capability is not_configured and counted as not checked', async () => {
    delete process.env.ERP_BRIDGE_URL;
    const res = await request(app()).get('/api/v1/ops/runtime/business/erp-bridge');
    expect(res.body).toMatchObject({ status: 'not_configured', reason: 'erp_bridge_url_unset' });
    const c = classifyHealthResponse(res.status, res.body);
    const s = summarize([{ name: 'ERP', url: '/x', group: 'g', ...c, http_status: 200, latency_ms: 1, details: null }], ['g'], 'now');
    expect(s).toMatchObject({ healthy: 0, failing: 0, no_access: 1 });
  });

  it('dev autopilot success rate reads the 7-day terminal rows', async () => {
    tableRows.dev_autopilot_executions = [
      ...Array.from({ length: 3 }, () => ({ status: 'completed' })),
      ...Array.from({ length: 20 }, () => ({ status: 'failed' })),
    ];
    const res = await request(app()).get('/api/v1/ops/runtime/autopilot/success-rate');
    expect(res.body).toMatchObject({ status: 'degraded', succeeded: 3, failed: 20 });
  });

  it('voice/fish reports not_configured without a key', async () => {
    delete process.env.FISH_API_KEY;
    const res = await request(app()).get('/api/v1/ops/runtime/voice/fish');
    expect(res.body.status).toBe('not_configured');
  });
});
