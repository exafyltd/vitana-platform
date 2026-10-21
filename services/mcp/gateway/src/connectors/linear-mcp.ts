interface LinearConfig {
  apiKey: string;
  baseUrl: string;
}

class LinearMcpConnector {
  private config: LinearConfig;

  constructor() {
    this.config = {
      apiKey: process.env.LINEAR_API_KEY || '',
      baseUrl: 'https://api.linear.app/graphql',
    };

    if (!this.config.apiKey) {
      console.warn('LINEAR_API_KEY not set - Linear connector will not work');
    }
  }

  async health() {
    return {
      status: this.config.apiKey ? 'ok' : 'misconfigured',
      message: this.config.apiKey ? 'Ready' : 'Missing API key',
    };
  }

  async call(method: string, params: any) {
    switch (method) {
      case 'issue.list':
        return this.listIssues(params);
      case 'issue.get':
        return this.getIssue(params);
      case 'issue.update_status':
        return this.updateIssueStatus(params);
      case 'issue.create':
        return this.createIssue(params);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private async query(graphqlQuery: string, variables: any = {}) {
    const response = await fetch(this.config.baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Linear API error: ${response.status} - ${error}`);
    }

    const data: any = await response.json();
    if (data.errors) {
      throw new Error(`Linear GraphQL error: ${JSON.stringify(data.errors)}`);
    }

    return data.data;
  }

  private async listIssues(params: { teamId?: string; state?: string; limit?: number }) {
    const query = `
      query($teamId: String, $first: Int) {
        issues(
          filter: { team: { id: { eq: $teamId } } }
          first: $first
        ) {
          nodes {
            id
            identifier
            title
            description
            state {
              name
              type
            }
            assignee {
              name
              email
            }
            createdAt
            updatedAt
            url
          }
        }
      }
    `;

    const variables = {
      teamId: params.teamId,
      first: params.limit || 50,
    };

    const data: any = await this.query(query, variables);
    return data.issues.nodes;
  }

  private async getIssue(params: { id?: string; identifier?: string }) {
    if (!params.id && !params.identifier) {
      throw new Error('Either id or identifier is required');
    }

    const query = `
      query($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          state {
            name
            type
          }
          assignee {
            name
            email
          }
          createdAt
          updatedAt
          url
        }
      }
    `;

    const data: any = await this.query(query, {
      id: params.id || params.identifier,
    });

    return data.issue;
  }

  private async updateIssueStatus(params: { issueId: string; stateId: string }) {
    if (!params.issueId || !params.stateId) {
      throw new Error('issueId and stateId are required');
    }

    const mutation = `
      mutation($issueId: String!, $stateId: String!) {
        issueUpdate(
          id: $issueId
          input: { stateId: $stateId }
        ) {
          success
          issue {
            id
            identifier
            title
            state {
              name
              type
            }
          }
        }
      }
    `;

    const data: any = await this.query(mutation, {
      issueId: params.issueId,
      stateId: params.stateId,
    });

    return data.issueUpdate;
  }

  private async createIssue(params: {
    teamId: string;
    title: string;
    description?: string;
    assigneeId?: string;
  }) {
    if (!params.teamId || !params.title) {
      throw new Error('teamId and title are required');
    }

    const mutation = `
      mutation($teamId: String!, $title: String!, $description: String, $assigneeId: String) {
        issueCreate(
          input: {
            teamId: $teamId
            title: $title
            description: $description
            assigneeId: $assigneeId
          }
        ) {
          success
          issue {
            id
            identifier
            title
            url
          }
        }
      }
    `;

    const data: any = await this.query(mutation, params);
    return data.issueCreate;
  }
}

export const linearMcpConnector = new LinearMcpConnector();
