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
  getPullRequest,
  getPrFiles,
  getCombinedStatus,
  getCheckRuns,
  getPrStatus,
  createPullRequest,
  mergePullRequest,
  evaluateGovernance,
  triggerWorkflow,
  getWorkflowRuns,
  detectServiceFromFiles,
};

export default githubService;
