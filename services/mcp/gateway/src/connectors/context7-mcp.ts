interface Context7Config {
  apiKey: string;
  baseUrl: string;
}

class Context7McpConnector {
  private config: Context7Config;

  constructor() {
    this.config = {
      apiKey: process.env.CONTEXT7_API_KEY || '',
      baseUrl: process.env.CONTEXT7_BASE_URL || 'https://api.context7.ai',
    };

    if (!this.config.apiKey) {
      console.warn('CONTEXT7_API_KEY not set - Context7 connector will not work');
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
      case 'space.list':
        return this.listSpaces(params);
      case 'search':
        return this.search(params);
      case 'doc.get':
        return this.getDocument(params);
      case 'doc.search':
        return this.searchDocuments(params);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private async request(endpoint: string, options: RequestInit = {}) {
    const response = await fetch(`${this.config.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Context7 API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  private async listSpaces(params: { includeArchived?: boolean } = {}) {
    const queryParams = new URLSearchParams();
    if (params.includeArchived) {
      queryParams.set('includeArchived', 'true');
    }

    return this.request(`/spaces?${queryParams}`);
  }

  private async search(params: { query: string; spaceId?: string; limit?: number }) {
    if (!params.query) {
      throw new Error('Query is required');
    }

    const body: any = {
      query: params.query,
      limit: params.limit || 10,
    };

    if (params.spaceId) {
      body.spaceId = params.spaceId;
    }

    return this.request('/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  private async getDocument(params: { docId: string; includeContent?: boolean }) {
    if (!params.docId) {
      throw new Error('docId is required');
    }

    const queryParams = new URLSearchParams();
    if (params.includeContent !== false) {
      queryParams.set('includeContent', 'true');
    }

    return this.request(`/documents/${params.docId}?${queryParams}`);
  }

  private async searchDocuments(params: {
    spaceId: string;
    query: string;
    filters?: Record<string, any>;
  }) {
    if (!params.spaceId || !params.query) {
      throw new Error('spaceId and query are required');
    }

    return this.request('/documents/search', {
      method: 'POST',
      body: JSON.stringify({
        spaceId: params.spaceId,
        query: params.query,
        filters: params.filters || {},
      }),
    });
  }
}

export const context7McpConnector = new Context7McpConnector();
