/**
 * Delivery loop → Dev Autopilot: the GitLab-native executor gateway (the `dev-autopilot` executor of DELIVERY_LOOP_EXECUTOR).
 *
 * Owner instruction 2026-11-19: "Implement the GitLab failure adapter against the existing self-healing architecture, but make it
 * GitLab-native. Do not route GitLab failures through GitHub PRs."
 *
 * The loop decided that a failed GitLab merge-request pipeline needs a code repair (heal.ts) and carries the attempt out (drive.ts).
 * This turns that task into a Dev Autopilot execution on the merge request's own branch (services/dev-autopilot-gitlab-repair.ts),
 * which the existing executor claims and the existing agent runner runs (clone from GitLab, fix, checks, lease push), outside every
 * GitHub watcher. It writes nothing itself and refuses, without calling Dev Autopilot:
 *   - anything but a repair (an intake opens a new merge request and a rework answers a review: neither is a GitLab failure);
 *   - a repair without its merge request, branch, failing pipeline and head, or dispatch key;
 *   - `main`, `master`, the target branch, and any branch the delivery loop does not own (DELIVERY_LOOP_BRANCH_PREFIXES): the gateway
 *     never lets the executor change a branch that belongs to a person.
 *
 * Bound in runtime.ts, but bound is not on: executorFromEnv answers it only when the owner sets DELIVERY_LOOP_EXECUTOR=dev-autopilot,
 * and the executor needs its own GitLab token (DEV_AUTOPILOT_GITLAB_TOKEN). The loop acts only at L3 with execution armed.
 */
import type { GitlabRepairEnqueueResult, GitlabRepairRequest } from '../dev-autopilot-gitlab-repair';
import type { ExecutorGateway } from './adapters';
import { branchPrefixesFrom, ownsBranch } from './controls';
import type { TaskRequest } from './ports';

type Enqueue = (req: GitlabRepairRequest) => Promise<GitlabRepairEnqueueResult>;

const NEVER = new Set(['main', 'master']);

export function createDevAutopilotGitlabGateway(opts: { enqueue?: Enqueue; env?: NodeJS.ProcessEnv } = {}): ExecutorGateway {
  return {
    async enqueue(req: TaskRequest) {
      const refuse = (why: string) => ({ ok: false as const, error: `unsupported_request: ${why}`, retryable: false });
      if (req.kind !== 'repair') return refuse(`the GitLab-native executor runs repairs of failed pipelines only, not ${req.kind}`);
      const repair = req.repair;
      if (!req.fix_branch || !req.mr_iid || !repair || !repair.sha || !req.dispatch_key) {
        return refuse('a repair needs its merge request, its branch, the failing pipeline and head, and a dispatch key');
      }
      const branch = req.fix_branch;
      if (NEVER.has(branch) || branch === req.base_branch) return refuse(`${branch} is not a branch the delivery loop repairs`);
      const env = opts.env ?? process.env;
      if (!ownsBranch({ branchPrefixes: branchPrefixesFrom(env), healMain: false }, branch, 'heal')) {
        return refuse(`${branch} is not a branch the delivery loop owns (DELIVERY_LOOP_BRANCH_PREFIXES)`);
      }
      const enqueue: Enqueue = opts.enqueue ?? (require('../dev-autopilot-gitlab-repair') as typeof import('../dev-autopilot-gitlab-repair')).enqueueGitlabRepair;
      const r = await enqueue({
        dispatch_key: req.dispatch_key,
        work_key: req.key,
        project_path: req.project,
        mr_iid: req.mr_iid,
        mr_url: repair.mr_url,
        source_branch: branch,
        target_branch: req.base_branch,
        pipeline_id: repair.pipeline_id,
        sha: repair.sha,
        title: req.title,
        instructions: req.instructions,
        hints: req.hints,
      });
      return r.ok ? { ok: true as const, execution_id: r.execution_id, vtid: null } : { ok: false as const, error: r.error, retryable: r.retryable };
    },
  };
}
