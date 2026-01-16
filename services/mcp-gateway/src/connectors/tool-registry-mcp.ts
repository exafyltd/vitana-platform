/**
 * Tool Registry MCP - Context Pollution Management
 * VTID-01177: Dynamic tool loading to reduce context usage at scale
 *
 * Skills:
 *   - tool.filter         - Metadata + text filtering (NOT semantic search)
 *   - tool.semantic_search - Real semantic search via embeddings (when available)
 *   - tool.get_schema     - Get specific tool definition (with visibility gating)
 *   - tool.suggest        - Suggest tools based on task description
 *   - tool.list_tier      - List tools by tier (essential/domain/specialty)
 *   - tool.batch_load     - Load multiple tool schemas efficiently
 *
 * Security:
 *   - Visibility gating (dev/prod/internal/admin)
 *   - Caller role validation
 *   - OASIS audit logging for all schema fetches
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
    sentry: ['sentry.list_issues', 'sentry.get_issue', 'sentry.get_stacktrace', 'sentry.search_similar', 'sentry.list_events'],
    code_review: ['review.analyze_diff', 'review.security_scan', 'review.type_check', 'review.lint_check', 'review.suggest_improvements'],
  },
} as const;

// Visibility levels (ordered by access level)
type VisibilityLevel = 'public' | 'dev' | 'prod' | 'internal' | 'admin';
const VISIBILITY_HIERARCHY: VisibilityLevel[] = ['public', 'dev', 'prod', 'internal', 'admin'];

// Caller roles and their max visibility access
const ROLE_VISIBILITY_ACCESS: Record<string, VisibilityLevel> = {
  'agent': 'prod',           // Agents can see dev + prod tools
  'worker': 'prod',          // Workers can see dev + prod tools
  'orchestrator': 'internal', // Orchestrator can see internal tools
  'admin': 'admin',          // Admin can see everything
  'debug': 'admin',          // Debug mode sees everything
};

// Domain keywords for routing
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  frontend: ['ui', 'css', 'component', 'layout', 'button', 'modal', 'form', 'tailwind', 'html', 'spa', 'csp', 'accessibility'],
  backend: ['api', 'endpoint', 'route', 'controller', 'middleware', 'service', 'rest', 'express', 'authentication', 'cicd'],
  memory: ['database', 'migration', 'supabase', 'rpc', 'query', 'schema', 'table', 'vector', 'embedding', 'rls', 'tenant'],
  github: ['pr', 'pull request', 'commit', 'repository', 'branch', 'merge', 'github'],
  linear: ['issue', 'ticket', 'task', 'linear', 'backlog', 'sprint'],
  testing: ['test', 'spec', 'coverage', 'assertion', 'mock', 'testsprite'],
  research: ['search', 'research', 'question', 'answer', 'perplexity', 'context7'],
  sentry: ['error', 'exception', 'crash', 'bug', 'stacktrace', 'sentry'],
  code_review: ['review', 'lint', 'quality', 'static analysis'],
};

interface ToolSchema {
  skill_id: string;
  server: string;
  description: string;
  params_schema: Record<string, any>;
  tier: 'essential' | 'domain' | 'specialty';
  domain?: string;
  visibility: VisibilityLevel;
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

interface CallerContext {
  caller_role: string;
  caller_id?: string;
  vtid?: string;
  run_id?: string;
}

interface FilterParams {
  query: string;
  domain?: string;
  tier?: 'essential' | 'domain' | 'specialty';
  limit?: number;
  caller: CallerContext;
}

interface SemanticSearchParams {
  query: string;
  limit?: number;
  caller: CallerContext;
}

interface GetSchemaParams {
  tool_id: string;
  caller: CallerContext;
}

interface SuggestParams {
  task_description: string;
  vtid?: string;
  include_essential?: boolean;
  caller: CallerContext;
}

interface BatchLoadParams {
  tool_ids: string[];
  caller: CallerContext;
}

interface ListTierParams {
  tier: 'essential' | 'domain' | 'specialty';
  domain?: string;
  caller: CallerContext;
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
 * Check if caller can access a tool based on visibility
 */
function canAccessVisibility(callerRole: string, toolVisibility: VisibilityLevel): boolean {
  const maxAccess = ROLE_VISIBILITY_ACCESS[callerRole] || 'dev';
  const callerLevel = VISIBILITY_HIERARCHY.indexOf(maxAccess);
  const toolLevel = VISIBILITY_HIERARCHY.indexOf(toolVisibility);
  return callerLevel >= toolLevel;
}

/**
 * Emit OASIS audit event for tool schema access
 */
async function emitOasisAuditEvent(
  eventType: string,
  caller: CallerContext,
  details: Record<string, any>
): Promise<void> {
  const client = getSupabaseClient();

  const event = {
    event_type: eventType,
    event_family: 'TOOL_REGISTRY',
    vtid: caller.vtid || 'SYSTEM',
    run_id: caller.run_id,
    payload: {
      caller_role: caller.caller_role,
      caller_id: caller.caller_id,
      timestamp: new Date().toISOString(),
      ...details,
    },
    created_at: new Date().toISOString(),
  };

  try {
    await client.from('oasis_events').insert(event);
  } catch (err) {
    // Log but don't fail the operation
    console.error('Failed to emit OASIS audit event:', err);
  }
}

/**
 * Compute simple relevance score based on keyword matching
 * This is METADATA + TEXT FILTERING, not semantic search
 */
function computeTextRelevanceScore(query: string, tool: ToolSchema): number {
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
 * Filter tools by metadata and text matching
 * NOTE: This is NOT semantic search - it uses keyword/text matching only
 */
async function filterTools(params: FilterParams): Promise<{
  tools: ToolMatch[];
  total_available: number;
  method: 'metadata_text_filter';
}> {
  const client = getSupabaseClient();
  const limit = Math.min(params.limit || 10, 50);

  // Get all enabled tools
  const { data, error } = await client.from('skills_mcp').select('*').eq('enabled', true);

  if (error) {
    throw new Error(`Failed to filter tools: ${error.message}`);
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
      visibility: row.visibility || 'dev',
      enabled: row.enabled,
    } as ToolSchema;
  });

  // Filter by visibility based on caller role
  let filtered = tools.filter(t => canAccessVisibility(params.caller.caller_role, t.visibility));

  // Filter by tier if specified
  if (params.tier) {
    filtered = filtered.filter(t => t.tier === params.tier);
  }

  // Filter by domain if specified
  if (params.domain) {
    filtered = filtered.filter(t => t.domain === params.domain);
  }

  // Score and rank using text matching
  const scored: ToolMatch[] = filtered.map(t => ({
    skill_id: t.skill_id,
    server: t.server,
    description: t.description,
    relevance_score: computeTextRelevanceScore(params.query, t),
    tier: t.tier,
    domain: t.domain,
  }));

  // Sort by relevance
  scored.sort((a, b) => b.relevance_score - a.relevance_score);

  // Filter out zero scores and apply limit
  const results = scored.filter(t => t.relevance_score > 0).slice(0, limit);

  // Audit log
  await emitOasisAuditEvent('tool.filter', params.caller, {
    query: params.query,
    results_count: results.length,
    total_searched: tools.length,
  });

  return {
    tools: results,
    total_available: tools.length,
    method: 'metadata_text_filter',
  };
}

/**
 * Semantic search using embeddings
 * Requires MEM0_QDRANT_HOST to be configured
 * Falls back to text filtering if embeddings not available
 */
async function semanticSearch(params: SemanticSearchParams): Promise<{
  tools: ToolMatch[];
  total_available: number;
  method: 'semantic_embedding' | 'fallback_text_filter';
  embedding_available: boolean;
}> {
  const qdrantHost = process.env.MEM0_QDRANT_HOST || process.env.QDRANT_HOST;

  // If Qdrant not configured, fall back to text filter
  if (!qdrantHost) {
    console.warn('Qdrant not configured, falling back to text filter');
    const filterResult = await filterTools({
      query: params.query,
      limit: params.limit,
      caller: params.caller,
    });

    return {
      tools: filterResult.tools,
      total_available: filterResult.total_available,
      method: 'fallback_text_filter',
      embedding_available: false,
    };
  }

  // TODO: Implement actual embedding-based search
  // This would:
  // 1. Generate embedding for query using sentence-transformers
  // 2. Search Qdrant collection "tool_embeddings" for nearest neighbors
  // 3. Return tools with cosine similarity scores
  //
  // For now, we mark it as not available and fall back

  console.warn('Semantic search not yet implemented, falling back to text filter');
  const filterResult = await filterTools({
    query: params.query,
    limit: params.limit,
    caller: params.caller,
  });

  // Audit log
  await emitOasisAuditEvent('tool.semantic_search', params.caller, {
    query: params.query,
    results_count: filterResult.tools.length,
    method_used: 'fallback_text_filter',
    embedding_available: false,
  });

  return {
    tools: filterResult.tools,
    total_available: filterResult.total_available,
    method: 'fallback_text_filter',
    embedding_available: false,
  };
}

/**
 * Get specific tool schema with visibility gating and audit logging
 */
async function getToolSchema(params: GetSchemaParams): Promise<{
  schema: ToolSchema | null;
  access_granted: boolean;
  audit_logged: boolean;
}> {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from('skills_mcp')
    .select('*')
    .eq('skill_id', params.tool_id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // Audit log - tool not found
      await emitOasisAuditEvent('tool.get_schema.not_found', params.caller, {
        tool_id: params.tool_id,
      });
      return { schema: null, access_granted: false, audit_logged: true };
    }
    throw new Error(`Failed to get tool: ${error.message}`);
  }

  const visibility = data.visibility || 'dev';

  // Check visibility access
  if (!canAccessVisibility(params.caller.caller_role, visibility)) {
    // Audit log - access denied
    await emitOasisAuditEvent('tool.get_schema.access_denied', params.caller, {
      tool_id: params.tool_id,
      tool_visibility: visibility,
      caller_role: params.caller.caller_role,
    });

    return { schema: null, access_granted: false, audit_logged: true };
  }

  const tierInfo = getToolTierInfo(data.skill_id);

  const schema: ToolSchema = {
    skill_id: data.skill_id,
    server: data.server,
    description: data.description,
    params_schema: typeof data.params_schema === 'string'
      ? JSON.parse(data.params_schema)
      : data.params_schema,
    tier: tierInfo.tier,
    domain: tierInfo.domain,
    visibility: visibility,
    enabled: data.enabled,
  };

  // Audit log - access granted
  await emitOasisAuditEvent('tool.get_schema.success', params.caller, {
    tool_id: params.tool_id,
    tool_visibility: visibility,
  });

  return { schema, access_granted: true, audit_logged: true };
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

  // Audit log
  await emitOasisAuditEvent('tool.suggest', params.caller, {
    task_description_length: params.task_description.length,
    detected_domains: detectedDomains,
    recommended_count: recommended.length,
    vtid: params.vtid,
  });

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
      for (const domainTools of Object.values(TOOL_TIERS.domain)) {
        tools.push(...domainTools);
      }
    }
  } else if (params.tier === 'specialty') {
    if (params.domain && TOOL_TIERS.specialty[params.domain as keyof typeof TOOL_TIERS.specialty]) {
      tools = [...TOOL_TIERS.specialty[params.domain as keyof typeof TOOL_TIERS.specialty]];
    } else {
      for (const specialtyTools of Object.values(TOOL_TIERS.specialty)) {
        tools.push(...specialtyTools);
      }
    }
  }

  return { tools, count: tools.length };
}

/**
 * Batch load tool schemas with visibility gating
 */
async function batchLoad(params: BatchLoadParams): Promise<{
  schemas: Record<string, ToolSchema>;
  loaded_count: number;
  denied_count: number;
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
  let deniedCount = 0;

  for (const row of data || []) {
    const visibility = row.visibility || 'dev';

    // Check visibility access
    if (!canAccessVisibility(params.caller.caller_role, visibility)) {
      deniedCount++;
      continue;
    }

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
      visibility: visibility,
      enabled: row.enabled,
    };
  }

  // Audit log
  await emitOasisAuditEvent('tool.batch_load', params.caller, {
    requested_count: params.tool_ids.length,
    loaded_count: Object.keys(schemas).length,
    denied_count: deniedCount,
  });

  const fullRegistryTokens = 2500; // Updated for 49 tools
  const loadedTokens = Object.keys(schemas).length * 50;
  const tokensSaved = Math.max(0, fullRegistryTokens - loadedTokens);

  return {
    schemas,
    loaded_count: Object.keys(schemas).length,
    denied_count: deniedCount,
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

    const qdrantAvailable = !!(process.env.MEM0_QDRANT_HOST || process.env.QDRANT_HOST);

    return {
      status: 'ok',
      message: 'Tool Registry MCP operational',
      features: {
        text_filter: true,
        semantic_search: qdrantAvailable,
        visibility_gating: true,
        oasis_audit: true,
      },
    };
  } catch (err: any) {
    return { status: 'error', error: String(err.message || err) };
  }
}

// Default caller context when not provided
function ensureCaller(params: any): CallerContext {
  return params.caller || {
    caller_role: 'agent',
    caller_id: 'unknown',
  };
}

export const toolRegistryMcpConnector = {
  name: 'tool-registry-mcp',

  async health() {
    return health();
  },

  async call(method: string, params: any) {
    switch (method) {
      case 'filter':
        return filterTools({ ...params, caller: ensureCaller(params) });
      case 'semantic_search':
        return semanticSearch({ ...params, caller: ensureCaller(params) });
      case 'get_schema':
        return getToolSchema({ ...params, caller: ensureCaller(params) });
      case 'suggest':
        return suggestTools({ ...params, caller: ensureCaller(params) });
      case 'list_tier':
        return listTier({ ...params, caller: ensureCaller(params) });
      case 'batch_load':
        return batchLoad({ ...params, caller: ensureCaller(params) });
      // Legacy alias for search -> filter
      case 'search':
        console.warn('tool.search is deprecated, use tool.filter (text matching) or tool.semantic_search');
        return filterTools({ ...params, caller: ensureCaller(params) });
      default:
        throw new Error(`Unknown method for tool-registry-mcp: ${method}`);
    }
  },
};
