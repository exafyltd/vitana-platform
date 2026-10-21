/**
 * CI/CD & Pull Request voice tools (Wave 2, plan section C3) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  CICD_PR_TOOL_HANDLERS,
  CICD_PR_TOOL_DECLARATIONS,
  dev_create_pr,
  dev_list_open_prs,
  dev_merge_pr,
  dev_get_merge_lock,
  dev_release_merge_lock,
  dev_cicd_health,
  dev_trigger_workflow,
} from '../../src/services/orb-tools/cicd-pr-tools';

jest.mock('../../src/services/github-service', () => ({
  __esModule: true,
  default: {
    getPrStatus: jest.fn(),
    createRevertPullRequest: jest.fn(),
    triggerWorkflow: jest.fn(),
    getWorkflowRuns: jest.fn(),
    getWorkflowRunJobs: jest.fn(),
  },
}));

import githubServiceMock from '../../src/services/github-service';

const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'developer' };

function makeSb(): SupabaseClient {
  return {} as unknown as SupabaseClient;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('cicd-pr role gate', () => {
  const names = Object.keys(CICD_PR_TOOL_HANDLERS);

  it('exposes all 14 tools with matching declarations', () => {
    expect(names).toHaveLength(14);
    const declNames = CICD_PR_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const args = {
      vtid: 'VTID-0001', title: 'x', head: 'branch', pr_number: 1, merge_sha: 'abc',
      branch_name: 'revert-abc', workflow_id: 'STAGE-DEPLOY.yml', run_id: 1,
    };
    const r = await CICD_PR_TOOL_HANDLERS[name](args, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('developer_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await CICD_PR_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('dev_create_pr', () => {
  it('requires vtid/title/head', async () => {
    const r = await dev_create_pr({}, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await dev_create_pr({ vtid: 'VTID-1', title: 'x', head: 'branch' }, DEV_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('creates after confirm=true', async () => {
    mockFetch(201, { ok: true, pr_url: 'https://github.com/x/y/pull/5' });
    const r = await dev_create_pr({ vtid: 'VTID-1', title: 'x', head: 'branch', confirm: true }, DEV_ID, makeSb());
    expect(r.text).toContain('pull/5');
  });
});

describe('dev_list_open_prs', () => {
  it('speaks open PRs', async () => {
    mockFetch(200, { ok: true, items: [{ pr_number: 7, branch: 'feat', ci_state: 'pass' }] });
    const r = await dev_list_open_prs({}, DEV_ID, makeSb());
    expect(r.text).toContain('PR #7');
  });
});

describe('dev_merge_pr', () => {
  it('requires vtid and pr_number', async () => {
    const r = await dev_merge_pr({}, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await dev_merge_pr({ vtid: 'VTID-1', pr_number: 5 }, DEV_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('reports governance-blocked merges honestly', async () => {
    mockFetch(200, { ok: false, reason: 'governance_blocked' });
    const r = await dev_merge_pr({ vtid: 'VTID-1', pr_number: 5, confirm: true }, DEV_ID, makeSb());
    expect(r.text).toContain('governance_blocked');
  });
});

describe('dev_trigger_workflow', () => {
  it('validates workflow_id looks like a workflow file', async () => {
    const r = await dev_trigger_workflow({ workflow_id: 'not-a-workflow' }, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('dispatches after confirm=true', async () => {
    (githubServiceMock.triggerWorkflow as jest.Mock).mockResolvedValue(undefined);
    const r = await dev_trigger_workflow({ workflow_id: 'STAGE-DEPLOY.yml', confirm: true }, DEV_ID, makeSb());
    expect(r.ok).toBe(true);
    expect(githubServiceMock.triggerWorkflow).toHaveBeenCalledWith('exafyltd/vitana-platform', 'STAGE-DEPLOY.yml', 'main', {});
  });
});

describe('dev_get_merge_lock', () => {
  it('reports no locks', async () => {
    mockFetch(200, { ok: true, active_merges: [] });
    const r = await dev_get_merge_lock({}, DEV_ID, makeSb());
    expect(r.text).toContain('No merges are locked');
  });
});

describe('dev_release_merge_lock', () => {
  it('requires a vtid', async () => {
    const r = await dev_release_merge_lock({}, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await dev_release_merge_lock({ vtid: 'VTID-1' }, DEV_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });
});

describe('dev_cicd_health', () => {
  it('speaks pipeline status', async () => {
    mockFetch(200, { ok: true, status: 'ok' });
    const r = await dev_cicd_health({}, DEV_ID, makeSb());
    expect(r.text).toContain('ok');
  });
});
