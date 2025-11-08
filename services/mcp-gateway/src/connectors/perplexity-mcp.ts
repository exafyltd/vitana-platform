interface PerplexityConfig {
  apiKey: string;
}

interface PerplexityResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  citations?: string[];
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class PerplexityMCP {
  private apiKey: string;
  private baseUrl = 'https://api.perplexity.ai';

  constructor(config: PerplexityConfig) {
    this.apiKey = config.apiKey;
  }

  async ask(question: string, options?: { model?: string; searchDomainFilter?: string[] }): Promise<any> {
    const fetch = (await import('node-fetch')).default;
    
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || 'llama-3.1-sonar-small-128k-online',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that provides accurate information with citations.',
          },
          {
            role: 'user',
            content: question,
          },
        ],
        search_domain_filter: options?.searchDomainFilter,
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.statusText}`);
    }

    const data = await response.json() as PerplexityResponse;

    return {
      answer: data.choices[0]?.message?.content || '',
      citations: data.citations || [],
      model: data.model,
      usage: data.usage,
    };
  }

  async research(topic: string, options?: { depth?: 'basic' | 'detailed' }): Promise<any> {
    const prompt = options?.depth === 'detailed'
      ? `Provide a comprehensive research summary on: ${topic}. Include multiple perspectives, recent developments, and relevant citations.`
      : `Provide a concise overview of: ${topic}`;
    return this.ask(prompt);
  }
}

// Connector factory function
export const perplexityMcpConnector = {
  name: 'perplexity-mcp',
  create: (config: PerplexityConfig) => new PerplexityMCP(config),
  skills: [
    {
      id: 'perplexity.ask',
      name: 'Ask Perplexity',
      description: 'Ask a question and get an AI-powered answer with citations',
      parameters: {
        question: { type: 'string', required: true },
        model: { type: 'string', required: false }
      }
    },
    {
      id: 'perplexity.research',
      name: 'Research Topic',
      description: 'Conduct research on a topic with comprehensive analysis',
      parameters: {
        topic: { type: 'string', required: true },
        depth: { type: 'string', enum: ['basic', 'detailed'], required: false }
      }
    }
  ]
};
