interface PerplexityConfig {
  apiKey: string;
  baseUrl: string;
}

class PerplexityMcpConnector {
  private config: PerplexityConfig;

  constructor() {
    this.config = {
      apiKey: process.env.PERPLEXITY_API_KEY || '',
      baseUrl: 'https://api.perplexity.ai',
    };

    if (!this.config.apiKey) {
      console.warn('PERPLEXITY_API_KEY not set - Perplexity connector will not work');
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
      case 'ask':
        return this.ask(params);
      case 'research':
        return this.research(params);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private async ask(params: { question: string; model?: string }) {
    if (!params.question) {
      throw new Error('Question is required');
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: params.model || 'sonar-medium-online',
        messages: [
          {
            role: 'user',
            content: params.question,
          },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Perplexity API error: ${response.status} - ${error}`);
    }

    const data: any = await response.json();
    return {
      answer: data.choices[0]?.message?.content || '',
      citations: data.citations || [],
      model: data.model,
      usage: data.usage,
    };
  }

  private async research(params: { topic: string; depth?: string }) {
    if (!params.topic) {
      throw new Error('Topic is required');
    }

    const depth = params.depth || 'detailed';
    const prompts: Record<string, string> = {
      basic: `Provide a brief summary about: ${params.topic}`,
      detailed: `Provide a detailed analysis with key points about: ${params.topic}`,
      comprehensive: `Conduct comprehensive research covering all aspects, trends, and implications of: ${params.topic}`,
    };

    const question = prompts[depth] || prompts.detailed;

    return this.ask({ question, model: 'sonar-medium-online' });
  }
}

export const perplexityMcpConnector = new PerplexityMcpConnector();
