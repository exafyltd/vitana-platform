interface LinearConfig {
  apiKey: string;
}

interface LinearResponse {
  data?: any;
  errors?: any[];
}

export class LinearMCP {
  private apiKey: string;
  private baseUrl = 'https://api.linear.app/graphql';

  constructor(config: LinearConfig) {
    this.apiKey = config.apiKey;
  }

  async query(graphqlQuery: string, variables?: Record<string, any>): Promise<any> {
    const fetch = (await import('node-fetch')).default;
    
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.apiKey,
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables,
      }),
    });

    const data = await response.json() as LinearResponse;

    if (data.errors) {
      throw new Error(`Linear GraphQL error: ${JSON.stringify(data.errors)}`);
    }

    return data.data;
  }

  async listIssues(filter?: { teamId?: string; state?: string }): Promise<any> {
    const query = `
      query Issues($filter: IssueFilter) {
        issues(filter: $filter) {
          nodes {
            id
            title
            description
            state { name }
            assignee { name }
            createdAt
            updatedAt
          }
        }
      }
    `;
    return this.query(query, { filter });
  }

  async getIssue(issueId: string): Promise<any> {
    const query = `
      query Issue($id: String!) {
        issue(id: $id) {
          id
          title
          description
          state { name }
          assignee { name }
          comments { nodes { body } }
          createdAt
          updatedAt
        }
      }
    `;
    return this.query(query, { id: issueId });
  }

  async updateIssueStatus(issueId: string, stateId: string): Promise<any> {
    const mutation = `
      mutation UpdateIssue($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
          issue { id title state { name } }
        }
      }
    `;
    return this.query(mutation, { id: issueId, stateId });
  }

  async createIssue(input: { title: string; description?: string; teamId: string }): Promise<any> {
    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id title }
        }
      }
    `;
    return this.query(mutation, { input });
  }
}

// Connector factory function
export const linearMcpConnector = {
  name: 'linear-mcp',
  create: (config: LinearConfig) => new LinearMCP(config),
  skills: [
    {
      id: 'linear.issue.list',
      name: 'List Issues',
      description: 'List Linear issues with optional filters',
      parameters: {
        teamId: { type: 'string', required: false },
        state: { type: 'string', required: false }
      }
    },
    {
      id: 'linear.issue.get',
      name: 'Get Issue',
      description: 'Get details of a specific Linear issue',
      parameters: {
        issueId: { type: 'string', required: true }
      }
    },
    {
      id: 'linear.issue.update_status',
      name: 'Update Issue Status',
      description: 'Update the status of a Linear issue',
      parameters: {
        issueId: { type: 'string', required: true },
        stateId: { type: 'string', required: true }
      }
    },
    {
      id: 'linear.issue.create',
      name: 'Create Issue',
      description: 'Create a new Linear issue',
      parameters: {
        title: { type: 'string', required: true },
        description: { type: 'string', required: false },
        teamId: { type: 'string', required: true }
      }
    }
  ]
};
