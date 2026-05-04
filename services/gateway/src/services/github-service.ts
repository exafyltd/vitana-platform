/**
 * GitHub Service - VTID-0516 Autonomous Safe-Merge Layer
 * Handles all GitHub API interactions for PR creation, status checks, and merging
 */

import {
  GitHubPullRequest,
  GitHubCheckRun,
  GitHubCombinedStatus,
  CheckStatus,
  GovernanceEvaluation,
  BLOCKED_FILE_PATTERNS,
  SENSITIVE_PATHS,
} from '../types/cicd';

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_REPO = 'exafyltd/vitana-platform';

/**
 * Get the GitHub token from environment
 */
function getGitHubToken(): string {
  const token = process.env.GITHUB_SAFE_MERGE_TOKEN;
  if (!token) {
    throw new Error('GITHUB_SAFE_MERGE_TOKEN environment variable is not set');
  }
  return token;
}

/**
 * Make an authenticated request to GitHub API
 */
async function githubRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getGitHubToken();
  const url = endpoint.startsWith('https://') ? endpoint : `${GITHUB_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`GitHub API error: ${response.status} - ${errorBody}`);
    throw new Error(`GitHub API error: ${response.status} - ${response.statusText}`);
  }

  // Handle empty responses (like 204 No Content)
  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

/**
 * VTID-01031: Check if a branch exists on the remote repository
 */
export async function branchExists(
  repo: string,
  branch: string
): Promise<boolean> {
  try {
    await githubRequest<{ ref: string }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return true;
  } catch (error) {
    // 404 means branch doesn't exist
    if (error instanceof Error && error.message.includes('404')) {
      return false;
    }
    throw error;
  }
}

/**
 * VTID-01031: Find an existing open PR for a head branch targeting a base branch
 * Returns the PR if found, null otherwise
 */
export async function findPrForBranch(
  repo: string,
  headBranch: string,
  baseBranch: string = 'main'
): Promise<{ number: number; html_url: string; title: string; state: string } | null> {
  try {
    // GitHub API: list PRs filtered by head branch
    // head param format is "owner:branch" or just "branch" for same-repo PRs
    const [owner] = repo.split('/');
    const prs = await githubRequest<Array<{
      number: number;
      html_url: string;
      title: string;
      state: string;
      base: { ref: string };
      head: { ref: string };
    }>>(`/repos/${repo}/pulls?state=open&head=${owner}:${headBranch}&base=${baseBranch}`);

    if (prs.length > 0) {
      return {
        number: prs[0].number,
        html_url: prs[0].html_url,
        title: prs[0].title,
        state: prs[0].state,
      };
    }
    return null;
  } catch (error) {
    console.error(`[GitHub] Error finding PR for branch ${headBranch}:`, error);
    throw error;
  }
}

/**
 * Get PR details from GitHub
 */
export async function getPullRequest(
  repo: string,
  prNumber: number
): Promise<GitHubPullRequest> {
  return githubRequest<GitHubPullRequest>(`/repos/${repo}/pulls/${prNumber}`);
}

/**
 * Get files changed in a PR
 */
export async function getPrFiles(
  repo: string,
  prNumber: number
): Promise<Array<{ filename: string; status: string; additions: number; deletions: number }>> {
  return githubRequest<Array<{ filename: string; status: string; additions: number; deletions: number }>>(
    `/repos/${repo}/pulls/${prNumber}/files`
  );
}

/**
 * Get combined status for a commit (legacy status API)
 */
export async function getCombinedStatus(
  repo: string,
  ref: string
): Promise<GitHubCombinedStatus> {
  return githubRequest<GitHubCombinedStatus>(`/repos/${repo}/commits/${ref}/status`);
}

/**
 * Get check runs for a commit (newer Checks API)
 */
export async function getCheckRuns(
  repo: string,
  ref: string
): Promise<{ check_runs: GitHubCheckRun[] }> {
  return githubRequest<{ check_runs: GitHubCheckRun[] }>(
    `/repos/${repo}/commits/${ref}/check-runs`
  );
}

/**
 * Get PR status and checks combined
 */
export async function getPrStatus(
  repo: string,
  prNumber: number
): Promise<{
  pr: GitHubPullRequest;
  checks: CheckStatus[];
  allPassed: boolean;
}> {
  const pr = await getPullRequest(repo, prNumber);
  const headSha = pr.head.sha;

  // Get both legacy statuses and check runs
  const [combinedStatus, checkRunsResponse] = await Promise.all([
    getCombinedStatus(repo, headSha).catch(() => ({ state: 'pending' as const, statuses: [] })),
    getCheckRuns(repo, headSha).catch(() => ({ check_runs: [] })),
  ]);

  const checks: CheckStatus[] = [];

  // Add legacy statuses
  for (const status of combinedStatus.statuses) {
    checks.push({
      name: status.context,
      status: status.state === 'error' ? 'failure' : status.state,
      conclusion: status.state,
    });
  }

  // Add check runs
  for (const run of checkRunsResponse.check_runs) {
    checks.push({
      name: run.name,
      status: run.status === 'completed'
        ? (run.conclusion === 'success' ? 'success' : run.conclusion === 'neutral' || run.conclusion === 'skipped' ? 'neutral' : 'failure')
        : 'pending',
      conclusion: run.conclusion || undefined,
    });
  }

  // Check if all required checks passed (exclude neutral/skipped)
  const allPassed = checks.length === 0 || checks.every(
    (c) => c.status === 'success' || c.status === 'neutral' || c.status === 'skipped'
  );

  return { pr, checks, allPassed };
}

/**
 * Create a pull request
 */
export async function createPullRequest(
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string = 'main'
): Promise<{ number: number; html_url: string }> {
  // Validate head is not main
  if (head === 'main' || head === 'master') {
    throw new Error('Cannot create PR from main/master branch');
  }

  // Validate base is main
  if (base !== 'main') {
    throw new Error('PRs must target main branch');
  }

  return githubRequest<{ number: number; html_url: string }>(
    `/repos/${repo}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        title,
        body,
        head,
        base,
      }),
    }
  );
}

/**
 * VTID-02702: Create a revert PR that undoes a specific merge commit.
 *
 * Used by the feedback rollback flow. Strategy:
 *   1. Get the merge commit and identify its first parent (= main before merge).
 *   2. Diff merge_sha vs first parent → list of files added/modified/deleted.
 *   3. Build a new tree starting from current main HEAD, then for each
 *      changed file restore the parent's version (or delete if it was added
 *      by the merge).
 *   4. Create a commit pointing at that tree with current HEAD as the parent.
 *   5. Create a branch ref + open the PR.
 *
 * Caveats:
 *   - If main has subsequent commits that modified the same files, the
 *     revert may be technically correct but undo intervening work too.
 *     Caller should ensure the rollback is requested promptly (the 3-day
 *     window in the rollback endpoint enforces this).
 *   - Binary files larger than ~1MB will fail the contents API path; v1
 *     restricts rollback to text-only diffs (typical for autopilot PRs).
 */
export async function createRevertPullRequest(
  repo: string,
  mergeSha: string,
  branchName: string,
  prTitle: string,
  prBody: string,
): Promise<{ number: number; html_url: string }> {
  // 1. Get merge commit (need its first parent = pre-merge main).
  const mergeCommit = await githubRequest<{
    sha: string;
    parents: Array<{ sha: string }>;
    message: string;
  }>(`/repos/${repo}/git/commits/${mergeSha}`);
  if (!mergeCommit.parents || mergeCommit.parents.length === 0) {
    throw new Error(`merge commit ${mergeSha} has no parents — cannot revert`);
  }
  const parentSha = mergeCommit.parents[0].sha;

  // 2. Current main HEAD.
  const mainRef = await githubRequest<{ object: { sha: string } }>(
    `/repos/${repo}/git/refs/heads/main`,
  );
  const headSha = mainRef.object.sha;

  // 3. Diff to learn what the merge changed.
  const compare = await githubRequest<{
    files: Array<{ filename: string; status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'; previous_filename?: string }>;
  }>(`/repos/${repo}/compare/${parentSha}...${mergeSha}`);
  if (!compare.files || compare.files.length === 0) {
    throw new Error(`merge ${mergeSha} touches zero files — nothing to revert`);
  }

  // 4. Build tree items: restore each changed file from parentSha (or null = delete).
  const treeItems: Array<{
    path: string;
    mode: '100644' | '100755' | '040000' | '160000' | '120000';
    type: 'blob' | 'tree' | 'commit';
    sha: string | null;
  }> = [];

  for (const f of compare.files) {
    if (f.status === 'added') {
      // Added by the PR → remove in revert.
      treeItems.push({ path: f.filename, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    // For modified / removed / renamed / changed: restore parent's version.
    const lookupPath = f.status === 'renamed' && f.previous_filename
      ? f.previous_filename
      : f.filename;
    try {
      // Get file content at parentSha. The contents API returns base64-encoded.
      const parentContent = await githubRequest<{ content: string; encoding: string }>(
        `/repos/${repo}/contents/${encodeURIComponent(lookupPath)}?ref=${parentSha}`,
      );
      // Re-create as a blob in the repo.
      const blob = await githubRequest<{ sha: string }>(
        `/repos/${repo}/git/blobs`,
        {
          method: 'POST',
          body: JSON.stringify({
            content: parentContent.content,
            encoding: parentContent.encoding === 'base64' ? 'base64' : 'utf-8',
          }),
        },
      );
      treeItems.push({ path: f.filename, mode: '100644', type: 'blob', sha: blob.sha });
      // For renames: also delete the new path.
      if (f.status === 'renamed' && f.previous_filename && f.previous_filename !== f.filename) {
        treeItems.push({ path: f.filename, mode: '100644', type: 'blob', sha: null });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 on a removed-by-merge file probably means parent didn't have it
      // either (rename + removal), which is a no-op for us. Skip.
      if (msg.includes('404')) continue;
      throw err;
    }
  }

  // 5. Get current main's tree SHA to base our new tree on.
  const headCommit = await githubRequest<{ tree: { sha: string } }>(
    `/repos/${repo}/git/commits/${headSha}`,
  );

  const newTree = await githubRequest<{ sha: string }>(
    `/repos/${repo}/git/trees`,
    {
      method: 'POST',
      body: JSON.stringify({
        base_tree: headCommit.tree.sha,
        tree: treeItems,
      }),
    },
  );

  // 6. Create a commit on top of current HEAD with the revert tree.
  const revertCommit = await githubRequest<{ sha: string }>(
    `/repos/${repo}/git/commits`,
    {
      method: 'POST',
      body: JSON.stringify({
        message: prTitle,
        tree: newTree.sha,
        parents: [headSha],
      }),
    },
  );

  // 7. Branch ref.
  await githubRequest(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: revertCommit.sha,
    }),
  });

  // 8. Open the PR.
  return createPullRequest(repo, prTitle, prBody, branchName, 'main');
}

/**
 * Merge a pull request using squash merge
 */
export async function mergePullRequest(
  repo: string,
  prNumber: number,
  commitTitle: string,
  mergeStrategy: 'squash' | 'merge' | 'rebase' = 'squash'
): Promise<{ sha: string; merged: boolean; message: string }> {
  return githubRequest<{ sha: string; merged: boolean; message: string }>(
    `/repos/${repo}/pulls/${prNumber}/merge`,
    {
      method: 'PUT',
      body: JSON.stringify({
        commit_title: commitTitle,
        merge_method: mergeStrategy,
      }),
    }
  );
}

/**
 * Evaluate governance rules for a PR
 */
export async function evaluateGovernance(
  repo: string,
  prNumber: number,
  vtid: string
): Promise<GovernanceEvaluation> {
  const files = await getPrFiles(repo, prNumber);
  const filenames = files.map((f) => f.filename);

  const blockedReasons: string[] = [];
  const servicesImpacted = new Set<string>();

  for (const filename of filenames) {
    // Check blocked file patterns
    for (const pattern of BLOCKED_FILE_PATTERNS) {
      if (pattern.test(filename)) {
        blockedReasons.push(`Blocked file pattern: ${filename} matches ${pattern}`);
      }
    }

    // Check sensitive paths
    for (const path of SENSITIVE_PATHS) {
      if (filename.startsWith(path)) {
        blockedReasons.push(`Sensitive path: ${filename} in ${path}`);
      }
    }

    // Detect services impacted
    const serviceMatch = filename.match(/^services\/([^/]+)/);
    if (serviceMatch) {
      servicesImpacted.add(serviceMatch[1]);
    }
  }

  const decision = blockedReasons.length > 0 ? 'blocked' : 'approved';

  return {
    decision,
    vtid,
    files_touched: filenames,
    services_impacted: Array.from(servicesImpacted),
    blocked_reasons: blockedReasons,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Trigger a GitHub Actions workflow
 */
export async function triggerWorkflow(
  repo: string,
  workflowId: string,
  ref: string = 'main',
  inputs: Record<string, string> = {}
): Promise<void> {
  await githubRequest<void>(
    `/repos/${repo}/actions/workflows/${workflowId}/dispatches`,
    {
      method: 'POST',
      body: JSON.stringify({
        ref,
        inputs,
      }),
    }
  );
}

/**
 * Get recent workflow runs
 */
export async function getWorkflowRuns(
  repo: string,
  workflowId: string
): Promise<{
  workflow_runs: Array<{
    id: number;
    status: string;
    conclusion: string | null;
    html_url: string;
    created_at: string;
  }>;
}> {
  return githubRequest<{
    workflow_runs: Array<{
      id: number;
      status: string;
      conclusion: string | null;
      html_url: string;
      created_at: string;
    }>;
  }>(`/repos/${repo}/actions/workflows/${workflowId}/runs?per_page=5`);
}

/**
 * Get jobs for a specific workflow run (for matrix strategy per-screen status)
 */
export async function getWorkflowRunJobs(
  repo: string,
  runId: number
): Promise<{
  jobs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    started_at: string;
    completed_at: string | null;
  }>;
}> {
  return githubRequest<{
    jobs: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      started_at: string;
      completed_at: string | null;
    }>;
  }>(`/repos/${repo}/actions/runs/${runId}/jobs`);
}

/**
 * VTID-01154: GitHub-authoritative feed item for approvals
 */
export interface GitHubFeedItem {
  repo: string;
  pr_number: number;
  pr_url: string;
  branch: string;
  commit_sha: string;
  ci_state: 'pass' | 'fail' | 'running';
  mergeable: boolean;
  vtid: string | null;
  updated_at: string;
}

/**
 * VTID-01154: Parse VTID from branch name or PR title
 * Pattern: VTID-XXXXX where X is 4-5 digits
 */
function parseVtidFromText(text: string): string | null {
  if (!text) return null;
  const match = text.match(/VTID-\d{4,5}/i);
  return match ? match[0].toUpperCase() : null;
}

/**
 * VTID-01154: Get CI state from PR checks
 * Returns 'pass' | 'fail' | 'running' based on GitHub's actual CI status
 */
async function getCiState(
  repo: string,
  headSha: string
): Promise<'pass' | 'fail' | 'running'> {
  try {
    const [combinedStatus, checkRunsResponse] = await Promise.all([
      getCombinedStatus(repo, headSha).catch(() => ({ state: 'pending' as const, statuses: [] })),
      getCheckRuns(repo, headSha).catch(() => ({ check_runs: [] })),
    ]);

    // Gather all check states
    const states: string[] = [];

    // Legacy statuses
    for (const status of combinedStatus.statuses) {
      if (status.state === 'pending') {
        states.push('pending');
      } else if (status.state === 'success') {
        states.push('success');
      } else {
        states.push('failure');
      }
    }

    // Check runs (newer API)
    for (const run of checkRunsResponse.check_runs) {
      if (run.status !== 'completed') {
        states.push('pending');
      } else if (run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped') {
        states.push('success');
      } else {
        states.push('failure');
      }
    }

    // If no checks, consider as pass (no CI requirements)
    if (states.length === 0) {
      return 'pass';
    }

    // Any failure means fail
    if (states.some(s => s === 'failure')) {
      return 'fail';
    }

    // Any pending means running
    if (states.some(s => s === 'pending')) {
      return 'running';
    }

    // All success
    return 'pass';
  } catch (error) {
    console.error(`[VTID-01154] Error getting CI state for ${headSha}:`, error);
    return 'running'; // Conservative default
  }
}

/**
 * VTID-01154: List open PRs with CI and mergeability status from GitHub
 * This is the GitHub-authoritative source for the approvals feed
 */
export async function listOpenPrsWithStatus(
  repo: string = DEFAULT_REPO,
  limit: number = 50
): Promise<GitHubFeedItem[]> {
  try {
    // Fetch open PRs from GitHub
    const prs = await githubRequest<Array<{
      number: number;
      html_url: string;
      title: string;
      state: string;
      head: { ref: string; sha: string };
      base: { ref: string };
      mergeable: boolean | null;
      mergeable_state: string;
      updated_at: string;
    }>>(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${limit}`);

    const feedItems: GitHubFeedItem[] = [];

    // Process each PR to get CI status
    for (const pr of prs) {
      // Get CI state for this PR's head commit
      const ciState = await getCiState(repo, pr.head.sha);

      // Parse VTID from branch name first, then title
      const vtid = parseVtidFromText(pr.head.ref) || parseVtidFromText(pr.title);

      // Determine mergeability
      // GitHub's mergeable can be null while being computed, treat as false
      // mergeable_state: clean, dirty, unstable, blocked, unknown
      const mergeable = pr.mergeable === true &&
        (pr.mergeable_state === 'clean' || pr.mergeable_state === 'unstable');

      feedItems.push({
        repo,
        pr_number: pr.number,
        pr_url: pr.html_url,
        branch: pr.head.ref,
        commit_sha: pr.head.sha,
        ci_state: ciState,
        mergeable,
        vtid,
        updated_at: pr.updated_at,
      });
    }

    return feedItems;
  } catch (error) {
    console.error(`[VTID-01154] Error listing open PRs:`, error);
    throw error;
  }
}

/**
 * Detect which service is primarily affected by a PR
 */
export function detectServiceFromFiles(files: string[]): string | null {
  const serviceCounts: Record<string, number> = {};

  for (const file of files) {
    const match = file.match(/^services\/([^/]+)/);
    if (match) {
      const service = match[1];
      serviceCounts[service] = (serviceCounts[service] || 0) + 1;
    }
  }

  // Return the most frequently touched service
  let maxService: string | null = null;
  let maxCount = 0;
  for (const [service, count] of Object.entries(serviceCounts)) {
    if (count > maxCount) {
      maxService = service;
      maxCount = count;
    }
  }

  return maxService;
}

export const githubService = {
  branchExists,
  findPrForBranch,
  getPullRequest,
  getPrFiles,
  getCombinedStatus,
  getCheckRuns,
  getPrStatus,
  createPullRequest,
  createRevertPullRequest,
  mergePullRequest,
  evaluateGovernance,
  triggerWorkflow,
  getWorkflowRuns,
  getWorkflowRunJobs,
  detectServiceFromFiles,
  listOpenPrsWithStatus,
};

export default githubService;
