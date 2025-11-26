/**
 * GitHub Service
 * VTID: VTID-0512 (Safe Merge + Auto-Deploy Bridge)
 *
 * Handles GitHub API operations for safe merge and workflow dispatch.
 * Uses GITHUB_SAFE_MERGE_TOKEN from environment/Secret Manager.
 */

export interface PullRequestInfo {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  base: {
    ref: string;
    sha: string;
  };
  head: {
    ref: string;
    sha: string;
  };
  html_url: string;
  user: {
    login: string;
  };
}

export interface CheckRunStatus {
  conclusion: string | null;
  status: string;
  name: string;
}

export interface MergeResult {
  merged: boolean;
  sha?: string;
  message: string;
}

export interface WorkflowDispatchResult {
  ok: boolean;
  message: string;
}

const ALLOWED_REPO = 'exafyltd/vitana-platform';
const GITHUB_API_BASE = 'https://api.github.com';

export class GitHubService {
  private token: string | undefined;

  constructor() {
    // Use dedicated safe merge token, fallback to general GitHub token
    this.token = process.env.GITHUB_SAFE_MERGE_TOKEN || process.env.GITHUB_TOKEN;
  }

  private getHeaders(): Record<string, string> {
    if (!this.token) {
      throw new Error('GITHUB_SAFE_MERGE_TOKEN not configured');
    }
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vitana-safe-merge-bot',
    };
  }

  /**
   * Validate that the repo is allowed for safe merge operations
   */
  validateRepo(repo: string): { valid: boolean; error?: string } {
    if (repo !== ALLOWED_REPO) {
      return {
        valid: false,
        error: `Repository not allowed. Only '${ALLOWED_REPO}' is permitted for safe merge.`,
      };
    }
    return { valid: true };
  }

  /**
   * Fetch PR information from GitHub
   */
  async getPullRequest(repo: string, prNumber: number): Promise<PullRequestInfo> {
    const resp = await fetch(`${GITHUB_API_BASE}/repos/${repo}/pulls/${prNumber}`, {
      headers: this.getHeaders(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to fetch PR #${prNumber}: ${resp.status} - ${text}`);
    }

    return (await resp.json()) as PullRequestInfo;
  }

  /**
   * Get the status of CI checks for a PR's head commit
   */
  async getCheckRuns(repo: string, ref: string): Promise<CheckRunStatus[]> {
    const resp = await fetch(`${GITHUB_API_BASE}/repos/${repo}/commits/${ref}/check-runs`, {
      headers: this.getHeaders(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to fetch check runs: ${resp.status} - ${text}`);
    }

    const data = (await resp.json()) as { check_runs: any[] };
    return data.check_runs.map((run: any) => ({
      conclusion: run.conclusion,
      status: run.status,
      name: run.name,
    }));
  }

  /**
   * Get combined status for a ref
   */
  async getCombinedStatus(repo: string, ref: string): Promise<{ state: string; statuses: any[] }> {
    const resp = await fetch(`${GITHUB_API_BASE}/repos/${repo}/commits/${ref}/status`, {
      headers: this.getHeaders(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to fetch status: ${resp.status} - ${text}`);
    }

    return (await resp.json()) as { state: string; statuses: any[] };
  }

  /**
   * Verify that all required checks have passed
   */
  async verifyChecks(repo: string, ref: string): Promise<{ passed: boolean; details: string }> {
    try {
      // Check both check runs and commit statuses
      const [checkRuns, combinedStatus] = await Promise.all([
        this.getCheckRuns(repo, ref),
        this.getCombinedStatus(repo, ref),
      ]);

      // Verify check runs
      const failedChecks = checkRuns.filter(
        (run) =>
          run.status === 'completed' &&
          run.conclusion !== 'success' &&
          run.conclusion !== 'skipped' &&
          run.conclusion !== 'neutral'
      );

      const pendingChecks = checkRuns.filter((run) => run.status !== 'completed');

      if (pendingChecks.length > 0) {
        return {
          passed: false,
          details: `Pending checks: ${pendingChecks.map((c) => c.name).join(', ')}`,
        };
      }

      if (failedChecks.length > 0) {
        return {
          passed: false,
          details: `Failed checks: ${failedChecks.map((c) => `${c.name} (${c.conclusion})`).join(', ')}`,
        };
      }

      // Verify combined status
      if (combinedStatus.state === 'failure') {
        const failedStatuses = combinedStatus.statuses
          .filter((s: any) => s.state === 'failure')
          .map((s: any) => s.context);
        return {
          passed: false,
          details: `Failed statuses: ${failedStatuses.join(', ')}`,
        };
      }

      if (combinedStatus.state === 'pending') {
        const pendingStatuses = combinedStatus.statuses
          .filter((s: any) => s.state === 'pending')
          .map((s: any) => s.context);
        return {
          passed: false,
          details: `Pending statuses: ${pendingStatuses.join(', ')}`,
        };
      }

      return { passed: true, details: 'All checks passed' };
    } catch (error: any) {
      // If no checks are configured, consider it as passed (allows repos without CI)
      if (error.message.includes('404')) {
        return { passed: true, details: 'No checks configured' };
      }
      throw error;
    }
  }

  /**
   * Merge a pull request
   */
  async mergePullRequest(
    repo: string,
    prNumber: number,
    mergeMethod: 'squash' | 'merge' | 'rebase' = 'squash'
  ): Promise<MergeResult> {
    const resp = await fetch(`${GITHUB_API_BASE}/repos/${repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({
        merge_method: mergeMethod,
        commit_title: `Merge PR #${prNumber} via safe-merge-bot`,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      let errorMessage = `Merge failed: ${resp.status}`;
      try {
        const errorData = JSON.parse(text);
        errorMessage = errorData.message || errorMessage;
      } catch {}
      return { merged: false, message: errorMessage };
    }

    const data = (await resp.json()) as { merged: boolean; sha: string; message?: string };
    return {
      merged: data.merged,
      sha: data.sha,
      message: data.message || 'Pull request merged successfully',
    };
  }

  /**
   * Trigger a workflow dispatch event
   */
  async triggerWorkflowDispatch(
    repo: string,
    workflowId: string,
    ref: string,
    inputs: Record<string, string>
  ): Promise<WorkflowDispatchResult> {
    const resp = await fetch(
      `${GITHUB_API_BASE}/repos/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          ref,
          inputs,
        }),
      }
    );

    // workflow_dispatch returns 204 No Content on success
    if (resp.status === 204) {
      return { ok: true, message: 'Workflow dispatch triggered successfully' };
    }

    const text = await resp.text();
    let errorMessage = `Workflow dispatch failed: ${resp.status}`;
    try {
      const errorData = JSON.parse(text);
      errorMessage = errorData.message || errorMessage;
    } catch {}

    return { ok: false, message: errorMessage };
  }
}

// Singleton instance
export const githubService = new GitHubService();
