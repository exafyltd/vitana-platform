/**
 * Queueing a GitLab-native repair (services/dev-autopilot-gitlab-repair.ts).
 *
 * The delivery loop hands a failed GitLab merge-request pipeline to Dev Autopilot's existing executor. This module writes the rows the
 * executor already knows how to run (a finding, a plan version, a cooling execution) and nothing else. The tests pin:
 *   - nothing is written for a request that is not a valid GitLab target, or while the executor's kill switch is on;
 *   - one dispatch key is one execution, however often it is sent (an attempt that is dispatched again after a crash starts nothing new);
 *   - the execution is GitLab-hosted and has no GitHub PR field, so no GitHub watcher, reconciler or bridge path can take it;
 *   - the carrier finding can never be auto-approved, reaped into a GitHub execution or close a VTID (inert status, no VTID);
 *   - one merge request is one finding, so the executor's in-flight index allows one repair per merge request at a time.
 */
import { enqueueGitlabRepair, GITLAB_REPAIR_SCANNER, findingDedupeKey, type GitlabRepairRequest } from '../src/services/dev-autopilot-gitlab-repair';

const S = { url: 'https://supa.test', key: 'service-role-key' };
const SHA = '0123456789abcdef0123456789abcdef01234567';
const NOW = new Date('2026-11-19T20:00:00.000Z');

function request(over: Partial<GitlabRepairRequest> = {}): GitlabRepairRequest {
  return {
    dispatch_key: 'intent:repair:vitana/vitana-platform|delivery-loop/fix-greeting|0123456789abcdef:1',
    work_key: 'repair:vitana/vitana-platform|delivery-loop/fix-greeting|0123456789abcdef',
    project_path: 'vitana/vitana-platform',
    mr_iid: 12,
    mr_url: 'https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/12',
    source_branch: 'delivery-loop/fix-greeting',
    target_branch: 'main',
    pipeline_id: 31,
    sha: SHA,
    title: 'Repair delivery-loop/fix-greeting: unit:script_failure',
    instructions: 'Pipeline 31 failed.\n--- log ---\n    AssertionError: expected "Hello, Ada"\n--- end of log ---',
    hints: ['An earlier repair of this same failure was verified.'],
    ...over,
  };
}

type Call = { method: string; url: string; body: any };
let calls: Call[];
let world: { killSwitch: boolean; existingExecution: { id: string; status: string } | null; finding: string | null; maxVersion: number | null; executionInsertStatus: number; configStatus: number };

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => (body === null ? '' : JSON.stringify(body)), json: async () => body } as Response;
}

beforeEach(() => {
  calls = [];
  world = { killSwitch: false, existingExecution: null, finding: null, maxVersion: null, executionInsertStatus: 201, configStatus: 200 };
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: decodeURIComponent(url), body });
    const u = decodeURIComponent(url);
    if (u.includes('/dev_autopilot_config')) return respond(world.configStatus, [{ kill_switch: world.killSwitch }]);
    if (u.includes('/dev_autopilot_executions?') && method === 'GET') return respond(200, world.existingExecution ? [world.existingExecution] : []);
    if (u.includes('/autopilot_recommendations?') && method === 'GET') return respond(200, world.finding ? [{ id: world.finding }] : []);
    if (u.endsWith('/autopilot_recommendations') && method === 'POST') return respond(201, [{ id: 'f0000000-0000-4000-8000-000000000012' }]);
    if (u.includes('/dev_autopilot_plan_versions?') && method === 'GET') return respond(200, world.maxVersion ? [{ version: world.maxVersion }] : []);
    if (u.endsWith('/dev_autopilot_plan_versions') && method === 'POST') return respond(201, null);
    if (u.endsWith('/dev_autopilot_executions') && method === 'POST') return respond(world.executionInsertStatus, world.executionInsertStatus === 409 ? { code: '23505' } : null);
    return respond(404, { message: `unexpected ${method} ${u}` });
  }) as unknown as typeof fetch;
});

const deps = { s: S, now: () => NOW, newId: () => 'e0000000-0000-4000-8000-000000000001' };
const writes = () => calls.filter((c) => c.method !== 'GET');
const post = (table: string) => calls.find((c) => c.method === 'POST' && c.url.endsWith(`/rest/v1/${table}`));

describe('what is written for a repair', () => {
  it('a carrier finding, a plan version and ONE cooling, GitLab-hosted execution with no GitHub PR field', async () => {
    const r = await enqueueGitlabRepair(request(), deps);
    expect(r).toEqual({ ok: true, execution_id: 'e0000000-0000-4000-8000-000000000001', created: true });

    const finding = post('autopilot_recommendations')!.body;
    expect(finding).toEqual(expect.objectContaining({ source_type: 'dev_autopilot', status: 'auto_archived', activated_vtid: null }));
    expect(finding.spec_snapshot).toEqual(expect.objectContaining({ scanner: GITLAB_REPAIR_SCANNER, host: 'gitlab', dedupe_key: findingDedupeKey('vitana/vitana-platform', 12) }));

    const plan = post('dev_autopilot_plan_versions')!.body;
    expect(plan).toEqual(expect.objectContaining({ finding_id: 'f0000000-0000-4000-8000-000000000012', version: 1, files_referenced: [] }));
    expect(plan.plan_markdown).toContain('merge request !12');
    expect(plan.plan_markdown).toContain('An earlier repair of this same failure was verified.');

    const ex = post('dev_autopilot_executions')!.body;
    expect(ex).toEqual(expect.objectContaining({
      id: 'e0000000-0000-4000-8000-000000000001', finding_id: 'f0000000-0000-4000-8000-000000000012', plan_version: 1, status: 'cooling',
      auto_fix_depth: 0, approved_at: NOW.toISOString(), execute_after: NOW.toISOString(),
    }));
    for (const githubField of ['branch', 'pr_url', 'pr_number', 'revert_pr_url', 'parent_execution_id']) expect(ex).not.toHaveProperty(githubField);
    expect(ex.metadata).toEqual(expect.objectContaining({
      host: 'gitlab', executor: 'agent', source: 'delivery-loop',
      delivery_dispatch_key: request().dispatch_key, delivery_work_key: request().work_key,
      gitlab: {
        project_path: 'vitana/vitana-platform', mr_iid: 12, mr_url: request().mr_url, source_branch: 'delivery-loop/fix-greeting', target_branch: 'main',
        pipeline_id: 31, sha: SHA, work_key: request().work_key, dispatch_key: request().dispatch_key,
      },
    }));
    expect(ex.metadata.parent_failure).toContain('AssertionError: expected "Hello, Ada"');
  });

  it('reuses the merge request\'s finding and numbers the next plan version after the last one', async () => {
    world.finding = 'f0000000-0000-4000-8000-0000000000aa';
    world.maxVersion = 2;
    const r = await enqueueGitlabRepair(request(), deps);
    expect(r.ok).toBe(true);
    expect(post('autopilot_recommendations')).toBeUndefined();
    expect(post('dev_autopilot_plan_versions')!.body).toEqual(expect.objectContaining({ finding_id: 'f0000000-0000-4000-8000-0000000000aa', version: 3 }));
    expect(post('dev_autopilot_executions')!.body).toEqual(expect.objectContaining({ finding_id: 'f0000000-0000-4000-8000-0000000000aa', plan_version: 3 }));
  });

  it('cuts a very long failure text to the bound the executor keeps', async () => {
    await enqueueGitlabRepair(request({ instructions: 'x'.repeat(20_000) }), deps);
    expect(post('dev_autopilot_executions')!.body.metadata.parent_failure.length).toBeLessThanOrEqual(8000);
  });
});

describe('one dispatch key is one execution', () => {
  it('a dispatch key that already has an execution answers it and writes nothing', async () => {
    world.existingExecution = { id: 'e0000000-0000-4000-8000-0000000000bb', status: 'running' };
    const r = await enqueueGitlabRepair(request(), deps);
    expect(r).toEqual({ ok: true, execution_id: 'e0000000-0000-4000-8000-0000000000bb', created: false });
    expect(writes()).toEqual([]);
    expect(calls.some((c) => c.url.includes(`metadata->>delivery_dispatch_key=eq.${request().dispatch_key}`))).toBe(true);
  });

  it('a repair of the same merge request already in flight is busy, worth trying again later', async () => {
    world.executionInsertStatus = 409;
    const r = await enqueueGitlabRepair(request(), deps);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/^executor_busy/), retryable: true });
  });
});

describe('what is refused, with nothing written', () => {
  it.each<[string, Partial<GitlabRepairRequest>]>([
    ['the target branch main as the branch to repair', { source_branch: 'main' }],
    ['a source branch equal to the target', { source_branch: 'main', target_branch: 'main' }],
    ['a short sha', { sha: 'abc' }],
    ['no merge request', { mr_iid: 0 }],
    ['no pipeline', { pipeline_id: 0 }],
    ['no dispatch key', { dispatch_key: '' }],
    ['a project path that climbs', { project_path: 'vitana/../x' }],
  ])('%s: not retryable', async (_why, over) => {
    const r = await enqueueGitlabRepair(request(over), deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
      expect(r.error).toMatch(/^invalid_request/);
    }
    expect(calls).toEqual([]);
  });

  it('while the executor kill switch is on: retryable, and nothing is written', async () => {
    world.killSwitch = true;
    const r = await enqueueGitlabRepair(request(), deps);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/^executor_kill_switch/), retryable: true });
    expect(writes()).toEqual([]);
  });

  it('when the executor config cannot be read: retryable, nothing written (never assumed off)', async () => {
    world.configStatus = 503;
    const r = await enqueueGitlabRepair(request(), deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryable).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('without Supabase: not configured, not retryable', async () => {
    const r = await enqueueGitlabRepair(request(), { ...deps, s: null });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/^dev_autopilot_not_configured/), retryable: false });
    expect(calls).toEqual([]);
  });
});
