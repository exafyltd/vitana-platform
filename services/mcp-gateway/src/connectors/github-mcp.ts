import { Octokit } from '@octokit/rest';

class GitHubMcpConnector {
  private octokit: Octokit;

  constructor() {
    const token = process.env.GITHUB_MCP_TOKEN || '';
    this.octokit = new Octokit({ auth: token });
  }

  async health() {
    try {
      await this.octokit.users.getAuthenticated();
      return { status: 'ok', message: 'Connected to GitHub' };
    } catch (error: any) {
      return { status: 'error', message: error.message };
    }
  }

  async call(method: string, params: any) {
    switch (method) {
      case 'repo.get_file':
        return this.getFile(params);
      case 'repo.search_code':
        return this.searchCode(params);
      case 'pr.list':
        return this.listPRs(params);
      case 'pr.get':
        return this.getPR(params);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private async getFile(params: { repo: string; path: string; ref?: string }) {
    const [owner, repoName] = params.repo.split('/');
    const { data } = await this.octokit.repos.getContent({
      owner,
      repo: repoName,
      path: params.path,
      ref: params.ref,
    });
    return data;
  }

  private async searchCode(params: { query: string; repo?: string }) {
    const q = params.repo ? `${params.query} repo:${params.repo}` : params.query;
    const { data } = await this.octokit.search.code({ q });
    return data.items;
  }

  private async listPRs(params: { repo: string; state?: string }) {
    const [owner, repoName] = params.repo.split('/');
    const { data } = await this.octokit.pulls.list({
      owner,
      repo: repoName,
      state: params.state as any,
    });
    return data;
  }

  private async getPR(params: { repo: string; pr_number: number }) {
    const [owner, repoName] = params.repo.split('/');
    const { data } = await this.octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: params.pr_number,
    });
    return data;
  }
}

export const githubMcpConnector = new GitHubMcpConnector();
