/**
 * Developer voice tools — CI/CD & Pull Requests (Wave 2, plan section C3).
 *
 * Some tools map to existing Express routes (self-called via gatewayApiCall);
 * others have no dedicated route and call services/github-service.ts exports
 * directly (getPullRequest/getPrStatus/createRevertPullRequest/
 * triggerWorkflow/getWorkflowRuns/getWorkflowRunJobs), same functions the
 * existing cicd.ts routes already call — no new backend behaviour.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { developerGate, clampLimit, relAge, gatewayApiCall } from './developer-tools';
import githubService from '../github-service';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const DEFAULT_REPO = 'exafyltd/vitana-platform';

function repoArg(args: OrbToolArgs): string {
  return String(args.repo ?? DEFAULT_REPO);
}

// ---------------------------------------------------------------------------
// 29. dev_create_pr — POST /api/v1/github/create-pr
// ---------------------------------------------------------------------------

export const dev_create_pr: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const vtid = String(args.vtid ?? '').trim();
  const title = String(args.title ?? '').trim();
  const head = String(args.head ?? '').trim();
  if (!vtid || !title || !head) return { ok: false, error: 'dev_create_pr requires vtid, title and head branch.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid, title, head },
      text: `About to open a PR "${title}" from ${head} into main for ${vtid}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/github/create-pr', {
    method: 'POST',
    body: { vtid, title, body: String(args.body ?? ''), head, base: 'main' },
  });
  if (!ok) return { ok: true, result: { created: false, status, detail: body }, text: `Could not create the PR: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { created: true, detail: body }, text: `PR opened for ${vtid}${body.pr_url ? `: ${String(body.pr_url)}` : ''}.` };
};

// ---------------------------------------------------------------------------
// 30. dev_get_pr_status — no route; githubService.getPrStatus() directly
// ---------------------------------------------------------------------------

export const dev_get_pr_status: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const prNumber = Number(args.pr_number);
  if (!Number.isFinite(prNumber)) return { ok: false, error: 'dev_get_pr_status requires pr_number.' };
  try {
    const { pr, allPassed } = await githubService.getPrStatus(repoArg(args), prNumber);
    return {
      ok: true,
      result: { pr, allPassed },
      text: `PR #${prNumber} "${pr.title}" — ${pr.state}, mergeable: ${String(pr.mergeable)}, checks ${allPassed ? 'passing' : 'not all passing'}.`,
    };
  } catch (err) {
    return { ok: false, error: `dev_get_pr_status failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// 31. dev_get_pr_checks — no route; githubService.getPrStatus() .checks
// ---------------------------------------------------------------------------

export const dev_get_pr_checks: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const prNumber = Number(args.pr_number);
  if (!Number.isFinite(prNumber)) return { ok: false, error: 'dev_get_pr_checks requires pr_number.' };
  try {
    const { checks, allPassed } = await githubService.getPrStatus(repoArg(args), prNumber);
    if (checks.length === 0) return { ok: true, result: { checks: [] }, text: `PR #${prNumber} has no check runs yet.` };
    const lines = checks.slice(0, 10).map((c: { name: string; status: string; conclusion?: string | null }) => `${c.name} — ${c.conclusion ?? c.status}`);
    return { ok: true, result: { checks, allPassed }, text: `${checks.length} checks (${allPassed ? 'all passing' : 'not all passing'}): ${lines.join('. ')}` };
  } catch (err) {
    return { ok: false, error: `dev_get_pr_checks failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// 32/42. dev_list_open_prs / dev_approvals_feed — GET /api/v1/approvals/feed
// (identical backing route; kept as two tools per the plan, different framing)
// ---------------------------------------------------------------------------

async function fetchApprovalsFeed(args: OrbToolArgs): Promise<OrbToolResult> {
  const limit = clampLimit(args.limit, 20, 100);
  const repo = repoArg(args);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/approvals/feed?limit=${limit}&repo=${encodeURIComponent(repo)}`);
  if (!ok || body.ok !== true) return { ok: false, error: `approvals feed unavailable (${status}): ${String(body.error ?? 'unknown')}` };
  const items = (Array.isArray(body.items) ? body.items : []) as Array<{ vtid?: string; pr_number: number; branch: string; ci_state: string; mergeable?: boolean }>;
  if (items.length === 0) return { ok: true, result: { items: [] }, text: 'No open PRs found.' };
  const lines = items.slice(0, 10).map((it) => `PR #${it.pr_number}${it.vtid ? ` (${it.vtid})` : ''} — branch ${it.branch}, CI ${it.ci_state}`);
  return { ok: true, result: { items }, text: `${items.length} open PR${items.length === 1 ? '' : 's'}: ${lines.join('. ')}` };
}

export const dev_list_open_prs: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  return fetchApprovalsFeed(args);
};

export const dev_approvals_feed: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  return fetchApprovalsFeed(args);
};

// ---------------------------------------------------------------------------
// 33. dev_merge_pr — POST /api/v1/cicd/merge
// ---------------------------------------------------------------------------

export const dev_merge_pr: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const vtid = String(args.vtid ?? '').trim();
  const prNumber = Number(args.pr_number);
  if (!vtid || !Number.isFinite(prNumber)) return { ok: false, error: 'dev_merge_pr requires vtid and pr_number.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid, pr_number: prNumber },
      text: `About to merge PR #${prNumber} for ${vtid} through the governed pipeline. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/cicd/merge', {
    method: 'POST',
    body: { vtid, pr_number: prNumber, repo: repoArg(args) },
  });
  if (!ok || body.ok !== true) {
    return { ok: true, result: { merged: false, status, detail: body }, text: `Merge blocked: ${String(body.reason ?? body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { merged: true, detail: body }, text: `PR #${prNumber} merged for ${vtid}.` };
};

// ---------------------------------------------------------------------------
// 34. dev_safe_merge — POST /api/v1/github/safe-merge
// ---------------------------------------------------------------------------

export const dev_safe_merge: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const vtid = String(args.vtid ?? '').trim();
  const prNumber = Number(args.pr_number);
  if (!vtid || !Number.isFinite(prNumber)) return { ok: false, error: 'dev_safe_merge requires vtid and pr_number.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid, pr_number: prNumber },
      text: `About to safe-merge PR #${prNumber} for ${vtid}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/github/safe-merge', {
    method: 'POST',
    body: {
      vtid,
      pr_number: prNumber,
      repo: repoArg(args),
      require_checks: args.require_checks !== false,
      merge_strategy: String(args.merge_strategy ?? 'squash'),
    },
  });
  if (!ok || body.ok !== true) {
    return { ok: true, result: { merged: false, status, detail: body }, text: `Safe-merge blocked: ${String(body.reason ?? body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { merged: true, detail: body }, text: `PR #${prNumber} safe-merged for ${vtid}.` };
};

// ---------------------------------------------------------------------------
// 35. dev_revert_pr — no route; githubService.createRevertPullRequest() directly
// ---------------------------------------------------------------------------

export const dev_revert_pr: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const mergeSha = String(args.merge_sha ?? '').trim();
  const branchName = String(args.branch_name ?? '').trim();
  const title = String(args.title ?? `Revert ${mergeSha.slice(0, 7)}`);
  if (!mergeSha || !branchName) return { ok: false, error: 'dev_revert_pr requires merge_sha and branch_name.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, merge_sha: mergeSha, branch_name: branchName },
      text: `About to open a revert PR for merge ${mergeSha.slice(0, 7)} on branch ${branchName}. Confirm, then call again with confirm=true.`,
    };
  }
  try {
    const pr = await githubService.createRevertPullRequest(
      repoArg(args),
      mergeSha,
      branchName,
      title,
      String(args.body ?? `Automated revert of ${mergeSha}`),
    );
    return { ok: true, result: { created: true, pr }, text: `Revert PR #${pr.number} opened: ${pr.html_url}` };
  } catch (err) {
    return { ok: false, error: `dev_revert_pr failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// 36. dev_trigger_workflow — no generic route; githubService.triggerWorkflow()
// ---------------------------------------------------------------------------

export const dev_trigger_workflow: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const workflowId = String(args.workflow_id ?? '').trim();
  if (!workflowId.endsWith('.yml') && !workflowId.endsWith('.yaml')) {
    return { ok: false, error: 'dev_trigger_workflow requires workflow_id, e.g. "STAGE-DEPLOY.yml".' };
  }
  const ref = String(args.ref ?? 'main');
  const inputs = (args.inputs ?? {}) as Record<string, string>;
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, workflow_id: workflowId, ref, inputs },
      text: `About to dispatch workflow ${workflowId} on ${ref}. Confirm, then call again with confirm=true.`,
    };
  }
  try {
    await githubService.triggerWorkflow(repoArg(args), workflowId, ref, inputs);
    return { ok: true, result: { triggered: true, workflow_id: workflowId, ref }, text: `Dispatched ${workflowId} on ${ref}.` };
  } catch (err) {
    return { ok: false, error: `dev_trigger_workflow failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// 37. dev_list_workflow_runs — no route; githubService.getWorkflowRuns()
// ---------------------------------------------------------------------------

export const dev_list_workflow_runs: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const workflowId = String(args.workflow_id ?? '').trim();
  if (!workflowId) return { ok: false, error: 'dev_list_workflow_runs requires workflow_id.' };
  try {
    const { workflow_runs } = await githubService.getWorkflowRuns(repoArg(args), workflowId);
    if (workflow_runs.length === 0) return { ok: true, result: { runs: [] }, text: `No runs found for ${workflowId}.` };
    const lines = workflow_runs.map((r) => `run ${r.id} — ${r.conclusion ?? r.status} (${relAge(r.created_at)})`);
    return { ok: true, result: { runs: workflow_runs }, text: `Recent runs of ${workflowId}: ${lines.join('. ')}` };
  } catch (err) {
    return { ok: false, error: `dev_list_workflow_runs failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// 38. dev_get_run_jobs — no route; githubService.getWorkflowRunJobs()
// ---------------------------------------------------------------------------

export const dev_get_run_jobs: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const runId = Number(args.run_id);
  if (!Number.isFinite(runId)) return { ok: false, error: 'dev_get_run_jobs requires run_id.' };
  try {
    const { jobs } = await githubService.getWorkflowRunJobs(repoArg(args), runId);
    if (jobs.length === 0) return { ok: true, result: { jobs: [] }, text: `No jobs found for run ${runId}.` };
    const failed = jobs.filter((j) => j.conclusion === 'failure');
    const lines = jobs.map((j) => `${j.name} — ${j.conclusion ?? j.status}`);
    return {
      ok: true,
      result: { jobs, failed },
      text: `${jobs.length} jobs (${failed.length} failed): ${lines.join('. ')}`,
    };
  } catch (err) {
    return { ok: false, error: `dev_get_run_jobs failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// 39. dev_get_merge_lock — GET /api/v1/cicd/lock-status
// ---------------------------------------------------------------------------

export const dev_get_merge_lock: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/cicd/lock-status');
  if (!ok || body.ok !== true) return { ok: false, error: `dev_get_merge_lock failed (${status}): ${String(body.error ?? 'unknown')}` };
  const active = (Array.isArray(body.active_merges) ? body.active_merges : []) as string[];
  return {
    ok: true,
    result: body,
    text: active.length === 0 ? 'No merges are locked right now.' : `${active.length} active merge lock(s): ${active.join(', ')}.`,
  };
};

// ---------------------------------------------------------------------------
// 40. dev_release_merge_lock — POST /api/v1/cicd/lock-release
// ---------------------------------------------------------------------------

export const dev_release_merge_lock: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const vtid = String(args.vtid ?? '').trim();
  if (!vtid) return { ok: false, error: 'dev_release_merge_lock requires a vtid.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid },
      text: `About to release the merge lock held by ${vtid}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/cicd/lock-release', {
    method: 'POST',
    body: { vtid, reason: typeof args.reason === 'string' ? args.reason : 'released via voice' },
  });
  if (!ok || body.ok !== true) return { ok: true, result: { released: false, status, detail: body }, text: `Could not release the lock: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { released: true, detail: body }, text: `Merge lock for ${vtid} released.` };
};

// ---------------------------------------------------------------------------
// 41. dev_cicd_health — GET /api/v1/cicd/health
// ---------------------------------------------------------------------------

export const dev_cicd_health: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/cicd/health');
  if (!ok || body.ok !== true) return { ok: false, error: `dev_cicd_health failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `CI/CD pipeline is ${String(body.status ?? 'unknown')}.${body.notes ? ` ${String(body.notes)}` : ''}` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const CICD_PR_TOOL_HANDLERS: Record<string, Handler> = {
  dev_create_pr,
  dev_get_pr_status,
  dev_get_pr_checks,
  dev_list_open_prs,
  dev_merge_pr,
  dev_safe_merge,
  dev_revert_pr,
  dev_trigger_workflow,
  dev_list_workflow_runs,
  dev_get_run_jobs,
  dev_get_merge_lock,
  dev_release_merge_lock,
  dev_cicd_health,
  dev_approvals_feed,
};

export const CICD_PR_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_create_pr',
    description: 'DEVELOPER ONLY. Create a PR from a branch into main. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'Required.' },
        title: { type: 'string', description: 'Required.' },
        body: { type: 'string' },
        head: { type: 'string', description: 'Source branch. Required.' },
        repo: { type: 'string', description: 'Default exafyltd/vitana-platform.' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid', 'title', 'head'],
    },
  },
  {
    name: 'dev_get_pr_status',
    description: 'DEVELOPER ONLY. PR state and mergeability.',
    parameters: {
      type: 'object',
      properties: { pr_number: { type: 'integer', description: 'Required.' }, repo: { type: 'string' } },
      required: ['pr_number'],
    },
  },
  {
    name: 'dev_get_pr_checks',
    description: 'DEVELOPER ONLY. CI check runs for a PR.',
    parameters: {
      type: 'object',
      properties: { pr_number: { type: 'integer', description: 'Required.' }, repo: { type: 'string' } },
      required: ['pr_number'],
    },
  },
  {
    name: 'dev_list_open_prs',
    description: 'DEVELOPER ONLY. List open PRs with CI/mergeable status.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' }, repo: { type: 'string' } } },
  },
  {
    name: 'dev_merge_pr',
    description: 'DEVELOPER ONLY. Merge a PR through the governed pipeline (checks + governance + validator gate). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'Required.' },
        pr_number: { type: 'integer', description: 'Required.' },
        repo: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid', 'pr_number'],
    },
  },
  {
    name: 'dev_safe_merge',
    description: 'DEVELOPER ONLY. Safe-merge a PR (checks + governance gate, no validator step). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'Required.' },
        pr_number: { type: 'integer', description: 'Required.' },
        repo: { type: 'string' },
        require_checks: { type: 'boolean' },
        merge_strategy: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid', 'pr_number'],
    },
  },
  {
    name: 'dev_revert_pr',
    description: 'DEVELOPER ONLY. Open a revert PR for a given merge commit. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        merge_sha: { type: 'string', description: 'Required.' },
        branch_name: { type: 'string', description: 'Required — new branch name for the revert.' },
        title: { type: 'string' },
        body: { type: 'string' },
        repo: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['merge_sha', 'branch_name'],
    },
  },
  {
    name: 'dev_trigger_workflow',
    description: 'DEVELOPER ONLY. Dispatch a GitHub Actions workflow file by name. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow filename, e.g. "STAGE-DEPLOY.yml". Required.' },
        ref: { type: 'string', description: 'Branch/ref. Default main.' },
        inputs: { type: 'object', description: 'Workflow inputs.' },
        repo: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'dev_list_workflow_runs',
    description: 'DEVELOPER ONLY. Recent runs for a GitHub Actions workflow.',
    parameters: {
      type: 'object',
      properties: { workflow_id: { type: 'string', description: 'Required.' }, repo: { type: 'string' } },
      required: ['workflow_id'],
    },
  },
  {
    name: 'dev_get_run_jobs',
    description: 'DEVELOPER ONLY. Jobs and failures for a specific workflow run.',
    parameters: {
      type: 'object',
      properties: { run_id: { type: 'integer', description: 'Required.' }, repo: { type: 'string' } },
      required: ['run_id'],
    },
  },
  {
    name: 'dev_get_merge_lock',
    description: 'DEVELOPER ONLY. Current CI/CD merge lock status.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_release_merge_lock',
    description: 'DEVELOPER ONLY. Force-release a stuck merge lock for a VTID. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'Required.' },
        reason: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid'],
    },
  },
  {
    name: 'dev_cicd_health',
    description: 'DEVELOPER ONLY. CI/CD pipeline health (env config, runtime deploy, governance, AI services).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_approvals_feed',
    description: 'DEVELOPER ONLY. GitHub-authoritative feed of open PRs and their approval-readiness.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' }, repo: { type: 'string' } } },
  },
];
