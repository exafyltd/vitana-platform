interface TestspriteConfig {
  apiKey: string;
  baseUrl: string;
}

class TestspriteMcpConnector {
  private config: TestspriteConfig;

  constructor() {
    this.config = {
      apiKey: process.env.TESTSPRITE_API_KEY || '',
      baseUrl: process.env.TESTSPRITE_BASE_URL || 'https://api.testsprite.ai',
    };

    if (!this.config.apiKey) {
      console.warn('TESTSPRITE_API_KEY not set - Testsprite connector will not work');
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
      case 'run_tests':
        return this.runTests(params);
      case 'debug_code':
        return this.debugCode(params);
      case 'test.status':
        return this.getTestStatus(params);
      case 'test.results':
        return this.getTestResults(params);
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
      throw new Error(`Testsprite API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async runTests(params: {
    vtid: string;
    testType?: string;
    branch?: string;
    files?: string[];
  }) {
    if (!params.vtid) {
      throw new Error('vtid is required');
    }

    const body: any = {
      vtid: params.vtid,
      testType: params.testType || 'unit',
      branch: params.branch || 'main',
    };

    if (params.files && params.files.length > 0) {
      body.files = params.files;
    }

    return this.request('/tests/run', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async debugCode(params: { code: string; error: string; context?: string }) {
    if (!params.code || !params.error) {
      throw new Error('code and error are required');
    }

    return this.request('/debug', {
      method: 'POST',
      body: JSON.stringify({
        code: params.code,
        error: params.error,
        context: params.context || '',
      }),
    });
  }

  private async getTestStatus(params: { testId: string }) {
    if (!params.testId) {
      throw new Error('testId is required');
    }

    return this.request(`/tests/${params.testId}/status`);
  }

  private async getTestResults(params: { testId: string }) {
    if (!params.testId) {
      throw new Error('testId is required');
    }

    return this.request(`/tests/${params.testId}/results`);
  }
}

export const testspriteMcpConnector = new TestspriteMcpConnector();
