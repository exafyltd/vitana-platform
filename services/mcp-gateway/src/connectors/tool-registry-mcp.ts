/**
 * Tool Registry MCP - Context Pollution Management
 * VTID-01177: Dynamic tool loading to reduce context usage at scale
 *
 * Skills:
 *   - tool.search      - Semantic search for relevant tools
 *   - tool.get_schema  - Get specific tool definition
 *   - tool.suggest     - AI-suggested tools based on task description
 *   - tool.list_tier   - List tools by tier (essential/domain/specialty)
 *   - tool.batch_load  - Load multiple tool schemas efficiently
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Tool tiers for hierarchical loading
export const TOOL_TIERS = {
  essential: [
    'worker.route_subagent',
    'oasis.emit_event',
    'vtid.validate_payload',
    'vtid.get_task',
    'vtid.get_spec',
  ],
  domain: {
    frontend: [
      'worker.frontend.apply_patch',
      'worker.frontend.validate_accessibility',
      'csp.validate',
      'file.read',
      'file.write',
      'file.edit',
    ],
    backend: [
      'worker.backend.apply_patch',
      'worker.backend.security_scan',
      'worker.backend.analyze_service',
      'route.validate_mount',
      'route.check_conflicts',
      'curl.test_endpoint',
    ],
    memory: [
      'worker.memory.apply_patch',
      'worker.memory.validate_rls_policy',
      'worker.memory.preview_migration',
      'supabase.validate_migration',
      'rpc.validate_signature',
    ],
  },
  specialty: {
    github: ['github.repo.get_file', 'github.repo.search_code', 'github.pr.list', 'github.pr.get'],
    supabase: ['supabase.schema.list_tables', 'supabase.schema.get_table', 'supabase.read_query'],
    perplexity: ['perplexity.ask', 'perplexity.research'],
    linear: ['linear.issue.list', 'linear.issue.get', 'linear.issue.update_status', 'linear.issue.create'],
    context7: ['context7.space.list', 'context7.search', 'context7.doc.get', 'context7.doc.search'],
    testsprite: ['testsprite.run_tests', 'testsprite.debug_code', 'testsprite.test.status', 'testsprite.test.results'],
  },
} as const;

// Domain keywords for routing
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  frontend: ['ui', 'css', 'component', 'layout', 'button', 'modal', 'form', 'tailwind', 'html', 'spa', 'csp', 'accessibility'],
  backend: ['api', 'endpoint', 'route', 'controller', 'middleware', 'service', 'rest', 'express', 'authentication', 'cicd'],
  memory: ['database', 'migration', 'supabase', 'rpc', 'query', 'schema', 'table', 'vector', 'embedding', 'rls', 'tenant'],
  github: ['pr', 'pull request', 'commit', 'repository', 'branch', 'merge', 'github'],
  linear: ['issue', 'ticket', 'task', 'linear', 'backlog', 'sprint'],
  testing: ['test', 'spec', 'coverage', 'assertion', 'mock', 'testsprite'],
  research: ['search', 'research', 'question', 'answer', 'perplexity', 'context7'],
};

interface ToolSchema {
  skill_id: string;
  server: string;
  description: string;
  params_schema: Record<string, any>;
  tier: 'essential' | 'domain' | 'specialty';
  domain?: string;
  enabled: boolean;
}

interface ToolMatch {
  skill_id: string;
  server: string;
  description: string;
  relevance_score: number;
  tier: string;
  domain?: string;
}

interface SearchParams {
  query: string;
  domain?: string;
  tier?: 'essential' | 'domain' | 'specialty';
  limit?: number;
}

interface SuggestParams {
  task_description: string;
  vtid?: string;
  include_essential?: boolean;
}

interface BatchLoadParams {
  tool_ids: string[];
}

interface ListTierParams {
  tier: 'essential' | 'domain' | 'specialty';
  domain?: string;
}

function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase credentials not configured');
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

/**
 * Compute simple relevance score based on keyword matching
 * In production, this would use embeddings and vector search
 */
function computeRelevanceScore(query: string, tool: ToolSchema): number {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  let score = 0;

  // Exact skill_id match
  if (tool.skill_id.toLowerCase().includes(queryLower)) {
    score += 0.8;
  }

  // Description match
  const descLower = tool.description.toLowerCase();
  for (const word of queryWords) {
    if (word.length > 2 && descLower.includes(word)) {
      score += 0.15;
    }
  }

  // Server/domain match
  if (tool.server.toLowerCase().includes(queryLower)) {
    score += 0.3;
  }

  // Domain keyword boost
  if (tool.domain) {
    const domainKeywords = DOMAIN_KEYWORDS[tool.domain] || [];
    for (const keyword of domainKeywords) {
      if (queryLower.includes(keyword)) {
        score += 0.2;
      }
    }
  }

  return Math.min(score, 1.0);
}

/**
 * Detect domains from task description
 */
function detectDomains(taskDescription: string): string[] {
  const descLower = taskDescription.toLowerCase();
  const detected: string[] = [];

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    for (const keyword of keywords) {
      if (descLower.includes(keyword)) {
        if (!detected.includes(domain)) {
          detected.push(domain);
        }
        break;
      }
    }
  }

  return detected;
}

/**
 * Get tier and domain for a tool
 */
function getToolTierInfo(skillId: string): { tier: 'essential' | 'domain' | 'specialty'; domain?: string } {
  if (TOOL_TIERS.essential.includes(skillId as any)) {
    return { tier: 'essential' };
  }

  for (const [domain, tools] of Object.entries(TOOL_TIERS.domain)) {
    if ((tools as readonly string[]).includes(skillId)) {
      return { tier: 'domain', domain };
    }
  }

  for (const [domain, tools] of Object.entries(TOOL_TIERS.specialty)) {
    if ((tools as readonly string[]).includes(skillId)) {
      return { tier: 'specialty', domain };
    }
  }

  return { tier: 'specialty' };
}

/**
 * Search for relevant tools
 */
async function searchTools(params: SearchParams): Promise<{ tools: ToolMatch[]; total_available: number }> {
  const client = getSupabaseClient();
  const limit = Math.min(params.limit || 10, 50);

  // Get all enabled tools
  let query = client.from('skills_mcp').select('*').eq('enabled', true);

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to search tools: ${error.message}`);
  }

  const tools = (data || []).map((row: any) => {
    const tierInfo = getToolTierInfo(row.skill_id);
    return {
      skill_id: row.skill_id,
      server: row.server,
      description: row.description,
      params_schema: typeof row.params_schema === 'string'
        ? JSON.parse(row.params_schema)
        : row.params_schema,
      tier: tierInfo.tier,
      domain: tierInfo.domain,
      enabled: row.enabled,
    } as ToolSchema;
  });

  // Filter by tier if specified
  let filtered = tools;
  if (params.tier) {
    filtered = filtered.filter(t => t.tier === params.tier);
  }

  // Filter by domain if specified
  if (params.domain) {
    filtered = filtered.filter(t => t.domain === params.domain);
  }

  // Score and rank
  const scored: ToolMatch[] = filtered.map(t => ({
    skill_id: t.skill_id,
    server: t.server,
    description: t.description,
    relevance_score: computeRelevanceScore(params.query, t),
    tier: t.tier,
    domain: t.domain,
  }));

  // Sort by relevance
  scored.sort((a, b) => b.relevance_score - a.relevance_score);

  // Filter out zero scores and apply limit
  const results = scored.filter(t => t.relevance_score > 0).slice(0, limit);

  return {
    tools: results,
    total_available: tools.length,
  };
}

/**
 * Get specific tool schema
 */
async function getToolSchema(params: { tool_id: string }): Promise<ToolSchema | null> {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from('skills_mcp')
    .select('*')
    .eq('skill_id', params.tool_id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to get tool: ${error.message}`);
  }

  const tierInfo = getToolTierInfo(data.skill_id);

  return {
    skill_id: data.skill_id,
    server: data.server,
    description: data.description,
    params_schema: typeof data.params_schema === 'string'
      ? JSON.parse(data.params_schema)
      : data.params_schema,
    tier: tierInfo.tier,
    domain: tierInfo.domain,
    enabled: data.enabled,
  };
}

/**
 * Suggest tools based on task description
 */
async function suggestTools(params: SuggestParams): Promise<{
  recommended: ToolMatch[];
  detected_domains: string[];
  essential_count: number;
  context_tokens_estimate: number;
}> {
  const detectedDomains = detectDomains(params.task_description);
  const recommended: ToolMatch[] = [];

  // Always include essential tools if requested
  if (params.include_essential !== false) {
    for (const toolId of TOOL_TIERS.essential) {
      recommended.push({
        skill_id: toolId,
        server: 'worker-orchestrator',
        description: `Essential tool: ${toolId}`,
        relevance_score: 1.0,
        tier: 'essential',
      });
    }
  }

  // Add domain-specific tools
  for (const domain of detectedDomains) {
    // Domain tier
    const domainTools = TOOL_TIERS.domain[domain as keyof typeof TOOL_TIERS.domain];
    if (domainTools) {
      for (const toolId of domainTools) {
        if (!recommended.find(t => t.skill_id === toolId)) {
          recommended.push({
            skill_id: toolId,
            server: `worker-${domain}`,
            description: `Domain tool for ${domain}`,
            relevance_score: 0.8,
            tier: 'domain',
            domain,
          });
        }
      }
    }

    // Specialty tier
    const specialtyTools = TOOL_TIERS.specialty[domain as keyof typeof TOOL_TIERS.specialty];
    if (specialtyTools) {
      for (const toolId of specialtyTools) {
        if (!recommended.find(t => t.skill_id === toolId)) {
          recommended.push({
            skill_id: toolId,
            server: `${domain}-mcp`,
            description: `Specialty tool: ${toolId}`,
            relevance_score: 0.6,
            tier: 'specialty',
            domain,
          });
        }
      }
    }
  }

  // Estimate context tokens (rough: ~50 tokens per tool definition)
  const tokensPerTool = 50;
  const contextTokensEstimate = recommended.length * tokensPerTool;

  return {
    recommended,
    detected_domains: detectedDomains,
    essential_count: TOOL_TIERS.essential.length,
    context_tokens_estimate: contextTokensEstimate,
  };
}

/**
 * List tools by tier
 */
async function listTier(params: ListTierParams): Promise<{ tools: string[]; count: number }> {
  let tools: string[] = [];

  if (params.tier === 'essential') {
    tools = [...TOOL_TIERS.essential];
  } else if (params.tier === 'domain') {
    if (params.domain && TOOL_TIERS.domain[params.domain as keyof typeof TOOL_TIERS.domain]) {
      tools = [...TOOL_TIERS.domain[params.domain as keyof typeof TOOL_TIERS.domain]];
    } else {
      // All domain tools
      for (const domainTools of Object.values(TOOL_TIERS.domain)) {
        tools.push(...domainTools);
      }
    }
  } else if (params.tier === 'specialty') {
    if (params.domain && TOOL_TIERS.specialty[params.domain as keyof typeof TOOL_TIERS.specialty]) {
      tools = [...TOOL_TIERS.specialty[params.domain as keyof typeof TOOL_TIERS.specialty]];
    } else {
      // All specialty tools
      for (const specialtyTools of Object.values(TOOL_TIERS.specialty)) {
        tools.push(...specialtyTools);
      }
    }
  }

  return { tools, count: tools.length };
}

/**
 * Batch load tool schemas
 */
async function batchLoad(params: BatchLoadParams): Promise<{
  schemas: Record<string, ToolSchema>;
  loaded_count: number;
  tokens_saved_estimate: number;
}> {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from('skills_mcp')
    .select('*')
    .in('skill_id', params.tool_ids);

  if (error) {
    throw new Error(`Failed to batch load tools: ${error.message}`);
  }

  const schemas: Record<string, ToolSchema> = {};

  for (const row of data || []) {
    const tierInfo = getToolTierInfo(row.skill_id);
    schemas[row.skill_id] = {
      skill_id: row.skill_id,
      server: row.server,
      description: row.description,
      params_schema: typeof row.params_schema === 'string'
        ? JSON.parse(row.params_schema)
        : row.params_schema,
      tier: tierInfo.tier,
      domain: tierInfo.domain,
      enabled: row.enabled,
    };
  }

  // Estimate tokens saved (assuming full registry would be ~34 tools * 50 tokens = 1700)
  const fullRegistryTokens = 1700;
  const loadedTokens = Object.keys(schemas).length * 50;
  const tokensSaved = Math.max(0, fullRegistryTokens - loadedTokens);

  return {
    schemas,
    loaded_count: Object.keys(schemas).length,
    tokens_saved_estimate: tokensSaved,
  };
}

async function health() {
  try {
    const client = getSupabaseClient();
    const { error } = await client.from('skills_mcp').select('skill_id').limit(1);
    if (error) {
      return { status: 'error', error: error.message };
    }
    return { status: 'ok', message: 'Tool Registry MCP operational' };
  } catch (err: any) {
    return { status: 'error', error: String(err.message || err) };
  }
}

export const toolRegistryMcpConnector = {
  name: 'tool-registry-mcp',

  async health() {
    return health();
  },

  async call(method: string, params: any) {
    switch (method) {
      case 'search':
        return searchTools(params || {});
      case 'get_schema':
        return getToolSchema(params || {});
      case 'suggest':
        return suggestTools(params || {});
      case 'list_tier':
        return listTier(params || {});
      case 'batch_load':
        return batchLoad(params || {});
      default:
        throw new Error(`Unknown method for tool-registry-mcp: ${method}`);
    }
  },
};
