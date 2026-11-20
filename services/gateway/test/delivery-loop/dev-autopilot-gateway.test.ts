/**
 * Delivery loop → Dev Autopilot, the GitLab-native executor gateway (services/delivery-loop/dev-autopilot-gateway.ts).
 *
 * The loop's repair of a failed GitLab merge-request pipeline becomes a Dev Autopilot execution on that merge request's own branch.
 * The gateway only translates and refuses: it never writes itself (Dev Autopilot's enqueue does), it runs repairs only, and it hands
 * nothing over for a branch the loop does not own or for `main`. Switched on only by DELIVERY_LOOP_EXECUTOR=dev-autopilot.
 */
import { createDevAutopilotGitlabGateway } from '../../src/services/delivery-loop/dev-autopilot-gateway';
import type { TaskRequest } from '../../src/services/delivery-loop/ports';
// The owner switch (DELIVERY_LOOP_EXECUTOR) is the runtime's: its test with this gateway bound is in adapters.test.ts.

const SHA = '0123456789abcdef0123456789abcdef01234567';
const ENV = { DELIVERY_LOOP_BRANCH_PREFIXES: 'dev-autopilot/,delivery-loop/' } as NodeJS.ProcessEnv;

function repair(over: Partial<TaskRequest> = {}): TaskRequest {
  return {
    key: 'repair:vitana/vitana-platform|delivery-loop/fix-greeting|0123456789abcdef',
    dispatch_key: 'intent:repair:vitana/vitana-platform|delivery-loop/fix-greeting|0123456789abcdef:2',
    kind: 'repair',
    project: 'vitana/vitana-platform',
    title: 'Repair delivery-loop/fix-greeting: unit:script_failure',
    instructions: 'Pipeline 31 failed.',
    base_branch: 'main',
    fix_branch: 'delivery-loop/fix-greeting',
    mr_iid: 12,
    issue_iid: null,
    hints: ['known fix'],
    repair: { pipeline_id: 31, sha: SHA, mr_url: 'https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/12' },
    ...over,
  };
}

describe('a repair', () => {
  it('becomes one GitLab-native enqueue, field by field, and the execution comes back', async () => {
    const enqueue = jest.fn().mockResolvedValue({ ok: true, execution_id: 'e1', created: true });
    const g = createDevAutopilotGitlabGateway({ enqueue, env: ENV });
    expect(await g.enqueue(repair())).toEqual({ ok: true, execution_id: 'e1', vtid: null });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      dispatch_key: repair().dispatch_key,
      work_key: repair().key,
      project_path: 'vitana/vitana-platform',
      mr_iid: 12,
      mr_url: 'https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/12',
      source_branch: 'delivery-loop/fix-greeting',
      target_branch: 'main',
      pipeline_id: 31,
      sha: SHA,
      title: repair().title,
      instructions: 'Pipeline 31 failed.',
      hints: ['known fix'],
    });
  });

  it('passes Dev Autopilot\'s refusals through unchanged, retryable or not', async () => {
    const busy = createDevAutopilotGitlabGateway({ enqueue: jest.fn().mockResolvedValue({ ok: false, error: 'executor_busy: x', retryable: true }), env: ENV });
    expect(await busy.enqueue(repair())).toEqual({ ok: false, error: 'executor_busy: x', retryable: true });
    const bad = createDevAutopilotGitlabGateway({ enqueue: jest.fn().mockResolvedValue({ ok: false, error: 'invalid_request: y', retryable: false }), env: ENV });
    expect(await bad.enqueue(repair())).toEqual({ ok: false, error: 'invalid_request: y', retryable: false });
  });
});

describe('what it refuses without calling Dev Autopilot (not retryable)', () => {
  it.each<[string, Partial<TaskRequest>]>([
    ['an intake (a new merge request is not a repair)', { kind: 'intake', fix_branch: null, mr_iid: null, issue_iid: 17, repair: null }],
    ['a rework', { kind: 'rework' }],
    ['a repair without the branch', { fix_branch: null }],
    ['a repair without the merge request', { mr_iid: null }],
    ['a repair without the failing pipeline', { repair: null }],
    ['a repair without the failing head', { repair: { pipeline_id: 31, sha: null, mr_url: null } }],
    ['a repair without a dispatch key', { dispatch_key: undefined }],
    ['a repair of main', { fix_branch: 'main' }],
    ['a repair of the target branch', { fix_branch: 'release/1', base_branch: 'release/1' }],
    ['a repair of a branch the loop does not own', { fix_branch: 'kiro/some-lane/build' }],
  ])('%s', async (_why, over) => {
    const enqueue = jest.fn();
    const r = await createDevAutopilotGitlabGateway({ enqueue, env: ENV }).enqueue(repair(over));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryable).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

