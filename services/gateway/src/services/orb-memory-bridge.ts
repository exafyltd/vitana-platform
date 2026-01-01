/**
 * VTID-01106: ORB Memory Bridge (Dev Sandbox)
 *
 * Bridges ORB live sessions to Memory Core for persistent user context.
 * Enables ORB to remember user identity and conversation history.
 *
 * Features:
 * - Fixed dev identity for sandbox mode (no JWT required)
 * - Memory context retrieval for system instruction injection
 * - Conversation context formatting for LLM prompts
 *
 * DEV SANDBOX ONLY - No production auth patterns.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// VTID-01106: Constants & Configuration
// =============================================================================

/**
 * Fixed dev identity for sandbox testing (no JWT required)
 * These values match the dev_bootstrap_request_context expectations
 */
export const DEV_IDENTITY = {
  // Fixed dev user UUID (consistent across sessions)
  USER_ID: '00000000-0000-0000-0000-000000000099',
  // Vitana tenant (primary dev tenant)
  TENANT_ID: '00000000-0000-0000-0000-000000000001',
  TENANT_SLUG: 'vitana',
  // Default dev role
  ACTIVE_ROLE: 'developer',
  // Display name for memory items
  DISPLAY_NAME: 'Dev User (ORB Sandbox)'
};

/**
 * Memory context configuration
 * VTID-01109: Increased limits to prevent losing personal details
 */
const MEMORY_CONFIG = {
  // Max items to fetch for context (increased from 10 to allow per-category limits)
  DEFAULT_CONTEXT_LIMIT: 30,
  // Per-category limit for formatting (new)
  ITEMS_PER_CATEGORY: 5,
  // Categories relevant for ORB context (added 'personal' for identity info)
  CONTEXT_CATEGORIES: ['personal', 'conversation', 'preferences', 'goals', 'health', 'relationships'],
  // Max age of memory items to include (7 days instead of 24 hours)
  MAX_AGE_HOURS: 168,
  // Max characters for memory context in system prompt (increased from 2000)
  MAX_CONTEXT_CHARS: 6000,
  // Max characters per individual item (increased from 150)
  MAX_ITEM_CHARS: 300
};

// =============================================================================
// VTID-01106: Types
// =============================================================================

/**
 * Memory item from the memory_get_context RPC
 */
export interface MemoryItem {
  id: string;
  category_key: string;
  source: string;
  content: string;
  content_json: Record<string, unknown>;
  importance: number;
  occurred_at: string;
  created_at: string;
}

/**
 * Memory context for ORB system instruction
 */
export interface OrbMemoryContext {
  ok: boolean;
  user_id: string;
  tenant_id: string;
  items: MemoryItem[];
  summary: string;
  formatted_context: string;
  fetched_at: string;
  error?: string;
}

// =============================================================================
// VTID-01106: Environment Detection
// =============================================================================

/**
 * Check if running in dev-sandbox environment
 * VTID-01106: Now accepts flexible dev environment naming
 */
export function isDevSandbox(): boolean {
  const env = (process.env.ENVIRONMENT || process.env.VITANA_ENV || '').toLowerCase();
  // Accept: dev-sandbox, dev, development, sandbox, or any env containing 'dev' or 'sandbox'
  const isDevEnv = env === 'dev-sandbox' ||
                   env === 'dev' ||
                   env === 'development' ||
                   env === 'sandbox' ||
                   env.includes('dev') ||
                   env.includes('sandbox');
  return isDevEnv;
}

// Cache for memory bridge status (to avoid repeated logging)
let _memoryBridgeStatusLogged = false;
let _cachedMemoryBridgeEnabled: boolean | null = null;

/**
 * Check if Memory Bridge is enabled
 * Only active in dev-sandbox mode
 */
export function isMemoryBridgeEnabled(): boolean {
  // Return cached result if available
  if (_cachedMemoryBridgeEnabled !== null) {
    return _cachedMemoryBridgeEnabled;
  }

  const env = process.env.ENVIRONMENT || process.env.VITANA_ENV || '(not set)';

  // Only enable in dev-sandbox
  if (!isDevSandbox()) {
    if (!_memoryBridgeStatusLogged) {
      console.log(`[VTID-01106] Memory bridge DISABLED: ENVIRONMENT='${env}' is not a dev environment`);
      _memoryBridgeStatusLogged = true;
    }
    _cachedMemoryBridgeEnabled = false;
    return false;
  }
  // Check if explicitly disabled
  if (process.env.ORB_MEMORY_BRIDGE_DISABLED === 'true') {
    if (!_memoryBridgeStatusLogged) {
      console.log(`[VTID-01106] Memory bridge DISABLED: ORB_MEMORY_BRIDGE_DISABLED=true`);
      _memoryBridgeStatusLogged = true;
    }
    _cachedMemoryBridgeEnabled = false;
    return false;
  }
  if (!_memoryBridgeStatusLogged) {
    console.log(`[VTID-01106] Memory bridge ENABLED for env='${env}'`);
    _memoryBridgeStatusLogged = true;
  }
  _cachedMemoryBridgeEnabled = true;
  return true;
}

// =============================================================================
// VTID-01106: Supabase Client for Memory Access
// =============================================================================

/**
 * Create a service-role Supabase client for memory access
 * In dev sandbox, we use service role to bypass RLS with fixed dev identity
 */
function createMemoryClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('[VTID-01106] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// =============================================================================
// VTID-01106: Memory Context Fetching
// =============================================================================

/**
 * VTID-01107: Write memory item for dev user (dev-sandbox only)
 * Uses service role to bypass RLS with fixed dev identity.
 * This is the write counterpart to fetchDevMemoryContext.
 */
export async function writeDevMemoryItem(params: {
  source: 'orb_text' | 'orb_voice' | 'system';
  content: string;
  content_json?: Record<string, unknown>;
  importance?: number;
  category_key?: string;
  occurred_at?: string;
}): Promise<{ ok: boolean; id?: string; category_key?: string; error?: string }> {
  // Check if memory bridge is enabled
  if (!isMemoryBridgeEnabled()) {
    return { ok: false, error: 'Memory bridge not enabled (requires dev-sandbox)' };
  }

  const supabase = createMemoryClient();
  if (!supabase) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const occurredAt = params.occurred_at || new Date().toISOString();
    const importance = params.importance || 10;
    const contentJson = params.content_json || {};

    // Auto-classify category if not provided
    const categoryKey = params.category_key || classifyDevCategory(params.content);

    // Insert directly into memory_items table using service role
    const { data, error } = await supabase
      .from('memory_items')
      .insert({
        tenant_id: DEV_IDENTITY.TENANT_ID,
        user_id: DEV_IDENTITY.USER_ID,
        category_key: categoryKey,
        source: params.source,
        content: params.content,
        content_json: contentJson,
        importance,
        occurred_at: occurredAt
      })
      .select('id, category_key')
      .single();

    if (error) {
      // Check if table doesn't exist
      if (error.message.includes('does not exist') || error.code === '42P01') {
        console.warn('[VTID-01107] memory_items table not found (VTID-01104 dependency)');
        return { ok: false, error: 'Memory Core not available' };
      }
      console.error('[VTID-01107] Memory write error:', error.message);
      return { ok: false, error: error.message };
    }

    console.log(`[VTID-01107] Dev memory written: ${data?.id} (${categoryKey})`);
    return { ok: true, id: data?.id, category_key: categoryKey };

  } catch (err: any) {
    console.error('[VTID-01107] Memory write exception:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Simple category classification for dev memory writes
 * VTID-01109: Enhanced to better classify personal identity and relationships
 */
function classifyDevCategory(content: string): string {
  const lower = content.toLowerCase();

  // VTID-01109: Personal identity keywords - NEW CATEGORY (highest priority)
  // Captures: name, hometown, birthday, age, location, occupation, etc.
  if (/\b(my name|i am|call me|i'm called|i'm |ich bin|ich heiße|mein name|born in|from |hometown|my age|years old|my birthday|i live|i work|my job|my occupation|my email|my phone|my address)\b/i.test(lower)) {
    return 'personal';
  }

  // Health-related keywords
  if (/\b(health|fitness|exercise|sleep|diet|weight|medication|doctor|symptom|pain|illness|sick|medical)\b/.test(lower)) {
    return 'health';
  }

  // VTID-01109: Relationship keywords - EXPANDED to include fiancée, girlfriend, etc.
  if (/\b(family|friend|partner|wife|husband|fiancée|fiancee|fiance|spouse|girlfriend|boyfriend|significant other|child|children|son|daughter|parent|mother|father|mom|dad|brother|sister|colleague|relationship|married|engaged|dating|verlobte|verlobter)\b/i.test(lower)) {
    return 'relationships';
  }

  // Preference keywords (likes, dislikes, favorites)
  if (/\b(prefer|like|love|hate|favorite|favourite|always|never|want|need|enjoy|dislike)\b/.test(lower)) {
    return 'preferences';
  }

  // Goal keywords
  if (/\b(goal|plan|want to|going to|will|target|achieve|objective|aspire|dream|hope to)\b/.test(lower)) {
    return 'goals';
  }

  // Remember requests (user asking to remember something specific)
  if (/\b(remember|don't forget|keep in mind|note that|wichtig|merken)\b/.test(lower)) {
    return 'personal';  // Store as personal since user explicitly wants it remembered
  }

  // Default to conversation
  return 'conversation';
}

/**
 * Fetch memory context for the dev user
 * Uses fixed dev identity and service role access
 *
 * @param limit - Maximum number of memory items to fetch
 * @param categories - Optional category filter
 * @returns Memory context with formatted prompt injection
 */
export async function fetchDevMemoryContext(
  limit: number = MEMORY_CONFIG.DEFAULT_CONTEXT_LIMIT,
  categories?: string[]
): Promise<OrbMemoryContext> {
  const fetchedAt = new Date().toISOString();

  // Check if memory bridge is enabled
  if (!isMemoryBridgeEnabled()) {
    return {
      ok: false,
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      items: [],
      summary: 'Memory bridge disabled',
      formatted_context: '',
      fetched_at: fetchedAt,
      error: 'Memory bridge not enabled (requires dev-sandbox mode)'
    };
  }

  const supabase = createMemoryClient();
  if (!supabase) {
    return {
      ok: false,
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      items: [],
      summary: 'Database not configured',
      formatted_context: '',
      fetched_at: fetchedAt,
      error: 'Supabase not configured'
    };
  }

  try {
    // Calculate since timestamp (last 24 hours)
    const sinceDate = new Date();
    sinceDate.setHours(sinceDate.getHours() - MEMORY_CONFIG.MAX_AGE_HOURS);
    const sinceTimestamp = sinceDate.toISOString();

    // Filter categories
    const categoryFilter = categories || MEMORY_CONFIG.CONTEXT_CATEGORIES;

    // Call memory_get_context RPC with dev identity context
    // First, set the request context for the dev user
    const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
      p_tenant_id: DEV_IDENTITY.TENANT_ID,
      p_active_role: DEV_IDENTITY.ACTIVE_ROLE
    });
    if (bootstrapError) {
      console.warn('[VTID-01106] Bootstrap context failed (non-fatal):', bootstrapError.message);
    }

    // Query memory items directly with service role (bypasses RLS)
    const { data: memoryItems, error } = await supabase
      .from('memory_items')
      .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
      .eq('tenant_id', DEV_IDENTITY.TENANT_ID)
      .eq('user_id', DEV_IDENTITY.USER_ID)
      .in('category_key', categoryFilter)
      .gte('occurred_at', sinceTimestamp)
      .order('occurred_at', { ascending: false })
      .limit(limit);

    if (error) {
      // Check if table doesn't exist (VTID-01104 not deployed)
      if (error.message.includes('does not exist') || error.code === '42P01') {
        console.warn('[VTID-01106] memory_items table not found (VTID-01104 dependency)');
        return {
          ok: false,
          user_id: DEV_IDENTITY.USER_ID,
          tenant_id: DEV_IDENTITY.TENANT_ID,
          items: [],
          summary: 'Memory Core not deployed',
          formatted_context: '',
          fetched_at: fetchedAt,
          error: 'Memory Core not available (VTID-01104 dependency)'
        };
      }
      console.error('[VTID-01106] Memory query error:', error.message);
      return {
        ok: false,
        user_id: DEV_IDENTITY.USER_ID,
        tenant_id: DEV_IDENTITY.TENANT_ID,
        items: [],
        summary: 'Query failed',
        formatted_context: '',
        fetched_at: fetchedAt,
        error: error.message
      };
    }

    const items = (memoryItems || []) as MemoryItem[];
    const summary = generateMemorySummary(items);
    const formattedContext = formatMemoryForPrompt(items);

    console.log(`[VTID-01106] Fetched ${items.length} memory items for dev user`);

    // Emit OASIS event for memory context fetch
    await emitOasisEvent({
      vtid: 'VTID-01106',
      type: 'orb.memory.context_fetched',
      source: 'orb-memory-bridge',
      status: 'success',
      message: `Fetched ${items.length} memory items for ORB context`,
      payload: {
        user_id: DEV_IDENTITY.USER_ID,
        tenant_id: DEV_IDENTITY.TENANT_ID,
        items_count: items.length,
        categories: categoryFilter,
        since: sinceTimestamp
      }
    }).catch((err: Error) => console.warn('[VTID-01106] OASIS event failed:', err.message));

    return {
      ok: true,
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      items,
      summary,
      formatted_context: formattedContext,
      fetched_at: fetchedAt
    };

  } catch (err: any) {
    console.error('[VTID-01106] Memory context fetch error:', err.message);
    return {
      ok: false,
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      items: [],
      summary: 'Fetch error',
      formatted_context: '',
      fetched_at: fetchedAt,
      error: err.message
    };
  }
}

// =============================================================================
// VTID-01106: Memory Formatting for Prompts
// =============================================================================

/**
 * Generate a brief summary of memory items
 */
function generateMemorySummary(items: MemoryItem[]): string {
  if (items.length === 0) {
    return 'No recent memory items';
  }

  // Count items by category
  const categoryCounts: Record<string, number> = {};
  for (const item of items) {
    categoryCounts[item.category_key] = (categoryCounts[item.category_key] || 0) + 1;
  }

  const categoryList = Object.entries(categoryCounts)
    .map(([cat, count]) => `${cat}: ${count}`)
    .join(', ');

  return `${items.length} recent items (${categoryList})`;
}

/**
 * Format memory items for injection into system prompt
 * Creates a structured, concise representation for LLM context
 * VTID-01109: Uses config values, prioritizes personal category
 */
function formatMemoryForPrompt(items: MemoryItem[]): string {
  if (items.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## User Context (from Memory)');
  lines.push('');

  // Group by category for better organization
  const byCategory: Record<string, MemoryItem[]> = {};
  for (const item of items) {
    if (!byCategory[item.category_key]) {
      byCategory[item.category_key] = [];
    }
    byCategory[item.category_key].push(item);
  }

  // VTID-01109: Process categories in priority order (personal first!)
  const categoryOrder = ['personal', 'relationships', 'preferences', 'health', 'goals', 'conversation'];
  const sortedCategories = Object.keys(byCategory).sort((a, b) => {
    const aIdx = categoryOrder.indexOf(a);
    const bIdx = categoryOrder.indexOf(b);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  // Format each category
  for (const category of sortedCategories) {
    const catItems = byCategory[category];
    lines.push(`### ${formatCategoryName(category)}`);

    // VTID-01109: Use config for items per category limit
    const itemLimit = MEMORY_CONFIG.ITEMS_PER_CATEGORY || 5;
    for (const item of catItems.slice(0, itemLimit)) {
      const timestamp = formatRelativeTime(item.occurred_at);
      // VTID-01109: Use config for content truncation limit
      const content = truncateContent(item.content, MEMORY_CONFIG.MAX_ITEM_CHARS || 300);
      const direction = item.content_json?.direction as string | undefined;

      if (direction === 'user') {
        lines.push(`- [${timestamp}] User: "${content}"`);
      } else if (direction === 'assistant') {
        lines.push(`- [${timestamp}] Assistant: "${content}"`);
      } else {
        lines.push(`- [${timestamp}] ${content}`);
      }
    }

    if (catItems.length > itemLimit) {
      lines.push(`  (+ ${catItems.length - itemLimit} more ${category} items)`);
    }
    lines.push('');
  }

  // Truncate if too long
  let result = lines.join('\n');
  if (result.length > MEMORY_CONFIG.MAX_CONTEXT_CHARS) {
    result = result.substring(0, MEMORY_CONFIG.MAX_CONTEXT_CHARS - 50) + '\n\n(context truncated for brevity)';
  }

  return result;
}

/**
 * Format category key as readable name
 * VTID-01109: Added 'personal' category
 */
function formatCategoryName(category: string): string {
  const names: Record<string, string> = {
    personal: 'Personal Identity (IMPORTANT - User\'s Name, Location, etc.)',
    conversation: 'Recent Conversations',
    preferences: 'User Preferences',
    goals: 'Goals & Plans',
    health: 'Health & Wellness',
    relationships: 'Relationships & Family',
    tasks: 'Tasks & Work',
    community: 'Community',
    products_services: 'Products & Services',
    events_meetups: 'Events',
    notes: 'Notes'
  };
  return names[category] || category;
}

/**
 * Format timestamp as relative time (e.g., "2h ago", "yesterday")
 */
function formatRelativeTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 5) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Truncate content to max length
 */
function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength - 3) + '...';
}

// =============================================================================
// VTID-01106: System Instruction Enhancement
// =============================================================================

/**
 * Build enhanced system instruction with memory context
 * Injects user memory/history into the ORB system prompt
 * VTID-01109: Enhanced with stronger directives to use personal information
 *
 * @param baseInstruction - The base system instruction
 * @param memoryContext - Memory context to inject
 * @returns Enhanced system instruction with memory
 */
export function buildMemoryEnhancedInstruction(
  baseInstruction: string,
  memoryContext: OrbMemoryContext
): string {
  // If no memory or error, return base instruction
  if (!memoryContext.ok || memoryContext.items.length === 0) {
    return baseInstruction;
  }

  // Extract key personal details for explicit mention
  const personalItems = memoryContext.items.filter(i => i.category_key === 'personal');
  const relationshipItems = memoryContext.items.filter(i => i.category_key === 'relationships');

  // VTID-01109: Create a quick-reference section for personal details
  let quickReference = '';
  if (personalItems.length > 0 || relationshipItems.length > 0) {
    quickReference = '\n### QUICK REFERENCE - KEY FACTS ABOUT THIS USER:\n';
    for (const item of personalItems.slice(0, 5)) {
      quickReference += `• ${item.content}\n`;
    }
    for (const item of relationshipItems.slice(0, 3)) {
      quickReference += `• ${item.content}\n`;
    }
  }

  // Inject memory context after the base instruction
  // VTID-01107 + VTID-01109: Strong instruction to USE memory and NEVER claim inability to remember
  const enhancedInstruction = `${baseInstruction}

## CRITICAL: You Have Persistent Memory About This User

You have access to PERSISTENT MEMORY that contains REAL information from previous conversations with THIS SPECIFIC USER. This is NOT hypothetical - this is ACTUAL stored data about them.
${quickReference}
**MANDATORY RULES - FOLLOW THESE EXACTLY:**
1. NEVER say "I don't remember", "ich erinnere mich nicht", "I don't have information about your name/hometown/etc."
2. When the user asks about their name, hometown, fiancée, or ANY personal detail - CHECK THE MEMORY BELOW FIRST
3. If the information IS in your memory context, ANSWER WITH THAT INFORMATION
4. The "Personal Identity" section below contains their name, location, and key facts - USE IT
5. The "Relationships & Family" section contains info about family/partners - USE IT
6. Only say "I don't have that information yet" if it's truly NOT in the memory context below

---
MEMORY CONTEXT (This is REAL data - USE IT when answering):
${memoryContext.formatted_context}
---

You KNOW this user. You REMEMBER their name, their hometown, their family. Answer their questions using the memory above.`;

  return enhancedInstruction;
}

/**
 * Get memory context and build enhanced instruction in one call
 * Convenience function for ORB integration
 */
export async function getMemoryEnhancedInstruction(
  baseInstruction: string
): Promise<{ instruction: string; memoryContext: OrbMemoryContext }> {
  const memoryContext = await fetchDevMemoryContext();
  const instruction = buildMemoryEnhancedInstruction(baseInstruction, memoryContext);

  return { instruction, memoryContext };
}

// =============================================================================
// VTID-01107: Debug Snapshot for Memory Endpoint
// =============================================================================

/**
 * Debug snapshot response for /api/v1/orb/debug/memory endpoint
 */
export interface OrbMemoryDebugSnapshot {
  ok: boolean;
  enabled: boolean;
  dev_user_id: string;
  dev_tenant_id: string;
  lookback_hours: number;
  items_count: number;
  items_preview: string[];
  injected_chars: number;
  injected_preview: string;
  timestamp: string;
  error?: string;
}

/**
 * VTID-01107: Get debug snapshot of current ORB memory state
 * Returns the exact data being injected into ORB system instructions
 *
 * This function is designed for the /api/v1/orb/debug/memory endpoint
 * to prove what memory context ORB is using.
 */
export async function getDebugSnapshot(): Promise<OrbMemoryDebugSnapshot> {
  const timestamp = new Date().toISOString();
  const enabled = isMemoryBridgeEnabled();

  // If not enabled, return minimal snapshot
  if (!enabled) {
    return {
      ok: false,
      enabled: false,
      dev_user_id: DEV_IDENTITY.USER_ID,
      dev_tenant_id: DEV_IDENTITY.TENANT_ID,
      lookback_hours: MEMORY_CONFIG.MAX_AGE_HOURS,
      items_count: 0,
      items_preview: [],
      injected_chars: 0,
      injected_preview: '',
      timestamp,
      error: 'Memory bridge not enabled (requires dev-sandbox environment)'
    };
  }

  // Fetch memory context
  const memoryContext = await fetchDevMemoryContext();

  if (!memoryContext.ok) {
    return {
      ok: false,
      enabled: true,
      dev_user_id: DEV_IDENTITY.USER_ID,
      dev_tenant_id: DEV_IDENTITY.TENANT_ID,
      lookback_hours: MEMORY_CONFIG.MAX_AGE_HOURS,
      items_count: 0,
      items_preview: [],
      injected_chars: 0,
      injected_preview: '',
      timestamp,
      error: memoryContext.error || 'Failed to fetch memory context'
    };
  }

  // Build items preview (truncate each to ~200 chars)
  const itemsPreview = memoryContext.items.map(item => {
    const content = item.content;
    return content.length > 200 ? content.substring(0, 197) + '...' : content;
  });

  // Build injected preview (the actual memory context block)
  // Use the VITANA_MEMORY_CONTEXT format that would be injected
  const fullInjectedBlock = `VITANA_MEMORY_CONTEXT\n---\n${memoryContext.formatted_context}\n---`;
  const injectedPreview = fullInjectedBlock.length > 800
    ? fullInjectedBlock.substring(0, 797) + '...'
    : fullInjectedBlock;

  return {
    ok: true,
    enabled: true,
    dev_user_id: DEV_IDENTITY.USER_ID,
    dev_tenant_id: DEV_IDENTITY.TENANT_ID,
    lookback_hours: MEMORY_CONFIG.MAX_AGE_HOURS,
    items_count: memoryContext.items.length,
    items_preview: itemsPreview,
    injected_chars: memoryContext.formatted_context.length,
    injected_preview: injectedPreview,
    timestamp
  };
}

// =============================================================================
// VTID-01106: Exports
// =============================================================================

export {
  MEMORY_CONFIG,
  formatMemoryForPrompt,
  generateMemorySummary
};
