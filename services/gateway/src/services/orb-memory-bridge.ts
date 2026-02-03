/**
 * VTID-01106: ORB Memory Bridge (Dev Sandbox)
 * VTID-01115: Memory Relevance Scoring Engine Integration (D23)
 *
 * Bridges ORB live sessions to Memory Core for persistent user context.
 * Enables ORB to remember user identity and conversation history.
 *
 * Features:
 * - Fixed dev identity for sandbox mode (no JWT required)
 * - Memory context retrieval for system instruction injection
 * - Conversation context formatting for LLM prompts
 * - VTID-01115: Relevance scoring for all memory items before context assembly
 *
 * Integration with Intelligence Stack:
 * - Memory Scoring (D23) → Confidence (D24) → D25 Context Window Control → Context Assembly (D20)
 *
 * DEV SANDBOX ONLY - No production auth patterns.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  scoreAndRankMemories,
  emitScoringEvent,
  logScoringRun,
  type ScoringContext,
  type ScoredMemoryItem,
  type ScoringMetadata,
  type RetrieveIntent,
  type Domain,
  type UserRole
} from './memory-relevance-scoring';
import {
  processMessageForOrb,
  getOrbSignalContext,
  OrbSignalContext
} from './d28-emotional-cognitive-engine';
import {
  getOrbBoundaryContext,
  OrbBoundaryContext
} from './d41-boundary-consent-engine';
import {
  ContextWindowManager,
  selectContextWindow,
  ContextSelectionResult,
  ContextMetrics,
  formatSelectionDebug
} from './context-window-manager';

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
  // Max items to fetch for context
  // VTID-DEBUG-01: Increased from 30 to 100 to accommodate personal identity
  DEFAULT_CONTEXT_LIMIT: 100,
  // Per-category limit for formatting (applies to non-identity categories)
  // VTID-DEBUG-01: Personal/relationships have NO limit - see formatMemoryForPrompt
  ITEMS_PER_CATEGORY: 10,
  // Categories relevant for ORB context (added 'personal' and 'company' for identity info)
  // VTID-DEBUG-MEMORY-FIX: Added 'company' category for business identity
  CONTEXT_CATEGORIES: ['personal', 'company', 'conversation', 'preferences', 'goals', 'health', 'relationships'],
  // Max age of memory items to include (7 days instead of 24 hours)
  MAX_AGE_HOURS: 168,
  // Max characters for memory context in system prompt
  // VTID-DEBUG-01: Increased from 6000 to 10000 to hold all personal info
  MAX_CONTEXT_CHARS: 10000,
  // Max characters per individual item (increased from 150)
  MAX_ITEM_CHARS: 300,
  /**
   * VTID-DEBUG-01 + VTID-DEBUG-MEMORY-FIX: Categories that should NEVER be time-filtered.
   * Personal identity information (name, birthday, hometown, family members, company)
   * must be available regardless of when it was stored.
   * These are fundamental facts about the user that don't expire.
   */
  PERSISTENT_CATEGORIES: ['personal', 'relationships', 'company']
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
 * VTID-01117: Enhanced with context window metrics
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
  // VTID-01115: Scoring metadata
  scoring_metadata?: ScoringMetadata;
  /** VTID-01117: Context window selection metrics */
  contextMetrics?: ContextMetrics;
  /** VTID-01117: Number of items excluded by context window manager */
  excludedCount?: number;
  /** VTID-01117: Reasons for exclusions (summary) */
  exclusionSummary?: Record<string, number>;
}

/**
 * VTID-01115: Scored memory context with full relevance scoring
 */
export interface ScoredOrbMemoryContext extends OrbMemoryContext {
  scored_items: ScoredMemoryItem[];
  excluded_items: ScoredMemoryItem[];
  scoring_metadata: ScoringMetadata;
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

/**
 * VTID-01109 rev2: Reset memory bridge cache
 * Call this if environment variables change or for testing
 */
export function resetMemoryBridgeCache(): void {
  _cachedMemoryBridgeEnabled = null;
  _memoryBridgeStatusLogged = false;
  console.log('[VTID-01109] Memory bridge cache reset');
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
// VTID-01225: Fetch Recent Conversation for Cognee Extraction
// =============================================================================

/**
 * VTID-01225: Fetch recent conversation turns from memory_items for Cognee extraction
 * Queries by user_id and time range to get conversation history
 */
export async function fetchRecentConversationForCognee(
  tenantId: string,
  userId: string,
  startTime: Date,
  endTime: Date = new Date()
): Promise<string | null> {
  const client = createMemoryClient();
  if (!client) {
    console.warn('[VTID-01225] No Supabase client for fetching conversation');
    return null;
  }

  try {
    const { data, error } = await client
      .from('memory_items')
      .select('content, content_json, occurred_at')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .in('source', ['orb_voice', 'orb_text'])
      .gte('occurred_at', startTime.toISOString())
      .lte('occurred_at', endTime.toISOString())
      .order('occurred_at', { ascending: true })
      .limit(100);

    if (error) {
      console.error('[VTID-01225] Error fetching conversation:', error.message);
      return null;
    }

    if (!data || data.length === 0) {
      console.log('[VTID-01225] No conversation items found for time range');
      return null;
    }

    // Build transcript from memory items
    const transcript = data
      .map(item => {
        const direction = (item.content_json as any)?.direction || 'unknown';
        const role = direction === 'user' ? 'User' : direction === 'assistant' ? 'Assistant' : 'Unknown';
        return `${role}: ${item.content}`;
      })
      .join('\n');

    console.log(`[VTID-01225] Built transcript from ${data.length} memory items`);
    return transcript;
  } catch (err: any) {
    console.error('[VTID-01225] Exception fetching conversation:', err.message);
    return null;
  }
}

// =============================================================================
// VTID-01106: Memory Context Fetching
// =============================================================================

/**
 * VTID-01109 rev2: Check if a message is worth storing in memory
 * Filters out trivial messages to prevent memory flooding
 *
 * Returns true if the message should be stored, false if it should be skipped.
 */
export function shouldStoreInMemory(content: string, direction: 'user' | 'assistant'): boolean {
  const lower = content.toLowerCase().trim();
  const wordCount = lower.split(/\s+/).filter(w => w.length > 0).length;

  // Skip very short messages (less than 3 words) unless they contain key info
  if (wordCount < 3) {
    // Check if it contains important keywords despite being short
    const hasImportantInfo = /\b(name|heiß|heiss|bin|from|aus|jahre|old|live|wohne|email|phone)\b/i.test(lower);
    if (!hasImportantInfo) {
      console.log(`[VTID-01109] Skipping trivial message (${wordCount} words): "${lower.substring(0, 30)}..."`);
      return false;
    }
  }

  // Skip common trivial responses
  const trivialPatterns = [
    /^(ok|okay|yes|no|ja|nein|gut|alles klar|danke|thanks|thank you|bitte|please|sure|klar|genau|aha|hmm|uh|oh|ah)\.?$/i,
    /^(hallo|hello|hi|hey|guten tag|guten morgen|guten abend)\.?$/i,
    /^(tschüss|tschüs|bye|goodbye|auf wiedersehen|bis dann|ciao)\.?$/i,
    /^(what|was|wie|warum|why|when|wann|where|wo)\?$/i,  // Single word questions
  ];

  for (const pattern of trivialPatterns) {
    if (pattern.test(lower)) {
      console.log(`[VTID-01109] Skipping trivial ${direction} message: "${lower}"`);
      return false;
    }
  }

  // For assistant messages, skip generic acknowledgments AND "I don't know" responses
  // VTID-DEBUG-04: Critical fix - "I don't know" responses were being stored as facts
  // and retrieved later, creating a self-poisoning loop where the LLM would repeat
  // "I don't know X" even when X was stored in earlier entries
  if (direction === 'assistant') {
    const assistantTrivial = [
      /^(verstanden|understood|got it|alright|i see|ich verstehe)/i,
      /^(wie kann ich.*helfen|how can i help)/i,
      /^(gerne|gern geschehen|you're welcome|no problem)/i,
    ];
    for (const pattern of assistantTrivial) {
      if (pattern.test(lower)) {
        console.log(`[VTID-01109] Skipping trivial assistant response: "${lower.substring(0, 50)}..."`);
        return false;
      }
    }

    // VTID-DEBUG-04: Skip "I don't know" / "I don't have" responses
    // These should NEVER be stored as they would override correct earlier information
    const dontKnowPatterns = [
      // German "I don't know/have" patterns - expanded to catch "gerade", "leider", etc.
      /habe ich (noch |gerade |leider )?(nicht|keine)/i,  // "habe ich gerade nicht parat"
      /weiß ich (noch |gerade |leider )?nicht/i,          // "weiß ich nicht"
      /weiss ich (noch |gerade |leider )?nicht/i,         // "weiss ich nicht" (ss variant)
      /kenne ich (noch |gerade |leider )?nicht/i,         // "kenne ich nicht"
      /ist mir (noch |gerade )?nicht bekannt/i,           // "ist mir nicht bekannt"
      /fehlt mir/i,                                        // "diese Information fehlt mir"
      /nicht (in meinem|in meiner) (gedächtnis|erinnerung)/i, // "nicht in meinem Gedächtnis"
      /nicht gespeichert/i,                               // "noch nicht gespeichert"
      /nicht parat/i,                                     // "habe ich nicht parat" - explicit catch
      // English "I don't know/have" patterns
      /i (do not|don't|dont) (know|have|remember)/i,
      /i haven't (got|stored|saved)/i,
      /i (do not|don't) have (this|that|your|the) (information|info|data)/i,
      /not (in my|stored in) memory/i,
      /i('m| am) (not sure|uncertain|unsure)/i,
      // Generic negation patterns for missing info
      /(noch |gerade )?nicht (parat|gespeichert|bekannt|vorhanden)/i,
      // "Can you tell me again" patterns (indicates LLM doesn't know)
      /kannst du .*(noch ?mal|noch ?einmal|erneut|wieder) sagen/i,
      /can you .*(again|once more)/i,
    ];
    for (const pattern of dontKnowPatterns) {
      if (pattern.test(lower)) {
        console.log(`[VTID-DEBUG-04] Skipping "I don't know" assistant response - prevents memory poisoning: "${lower.substring(0, 80)}..."`);
        return false;
      }
    }
  }

  // Check if message contains meaningful personal/contextual information
  const hasMeaningfulContent =
    // Personal info patterns
    /\b(name|heiß|heiss|ich bin|i am|from|aus|born|geboren|live|wohne|work|arbeit|email|phone|address|adresse)\b/i.test(lower) ||
    // Preference patterns
    /\b(like|mag|love|liebe|prefer|bevorzuge|favorite|liebling|hate|hasse|always|immer|never|nie)\b/i.test(lower) ||
    // Relationship patterns
    /\b(family|familie|friend|freund|partner|wife|frau|husband|mann|child|kind|mother|mutter|father|vater)\b/i.test(lower) ||
    // Goal patterns
    /\b(want|will|möchte|plane|goal|ziel|hope|hoffe|dream|traum)\b/i.test(lower) ||
    // Remember requests
    /\b(remember|merk|vergiss nicht|don't forget|wichtig|important)\b/i.test(lower) ||
    // Substantive content (longer messages are more likely meaningful)
    wordCount >= 8;

  if (!hasMeaningfulContent) {
    console.log(`[VTID-01109] Skipping low-value ${direction} message (no meaningful keywords)`);
    return false;
  }

  return true;
}

/**
 * VTID-01107: Write memory item for dev user (dev-sandbox only)
 * Uses service role to bypass RLS with fixed dev identity.
 * This is the write counterpart to fetchDevMemoryContext.
 *
 * VTID-01109 rev2: Added filtering to prevent memory flooding
 */
export async function writeDevMemoryItem(params: {
  source: 'orb_text' | 'orb_voice' | 'system';
  content: string;
  content_json?: Record<string, unknown>;
  importance?: number;
  category_key?: string;
  occurred_at?: string;
  skipFiltering?: boolean;  // Set to true to bypass shouldStoreInMemory check
}): Promise<{ ok: boolean; id?: string; category_key?: string; error?: string; skipped?: boolean }> {
  // Check if memory bridge is enabled
  if (!isMemoryBridgeEnabled()) {
    return { ok: false, error: 'Memory bridge not enabled (requires dev-sandbox)' };
  }

  // VTID-01109 rev2: Filter trivial messages to prevent memory flooding
  const direction = params.content_json?.direction as 'user' | 'assistant' | undefined;
  if (!params.skipFiltering && direction && !shouldStoreInMemory(params.content, direction)) {
    return { ok: true, skipped: true };  // Successfully skipped (not an error)
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

    // VTID-01109 rev2: Boost importance for personal/relationship categories
    let adjustedImportance = importance;
    if (categoryKey === 'personal') {
      adjustedImportance = Math.max(importance, 50);  // Personal info is high priority
    } else if (categoryKey === 'relationships') {
      adjustedImportance = Math.max(importance, 40);  // Relationships are important
    }

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
        importance: adjustedImportance,
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

    console.log(`[VTID-01107] Dev memory written: ${data?.id} (${categoryKey}, importance=${adjustedImportance})`);
    return { ok: true, id: data?.id, category_key: categoryKey };

  } catch (err: any) {
    console.error('[VTID-01107] Memory write exception:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * VTID-01186: Identity structure for authenticated memory operations
 */
export interface MemoryIdentity {
  user_id: string;
  tenant_id: string;
  active_role?: string | null;
}

/**
 * VTID-01186: Write memory item with authenticated identity
 * Uses the provided identity instead of DEV_IDENTITY.
 * This is the production-ready version that works with req.identity from JWT.
 *
 * @param identity - The authenticated user's identity (from req.identity)
 * @param params - Memory item parameters
 */
export async function writeMemoryItemWithIdentity(
  identity: MemoryIdentity,
  params: {
    source: 'orb_text' | 'orb_voice' | 'system';
    content: string;
    content_json?: Record<string, unknown>;
    importance?: number;
    category_key?: string;
    occurred_at?: string;
    workspace_scope?: string;
    skipFiltering?: boolean;
  }
): Promise<{ ok: boolean; id?: string; category_key?: string; error?: string; skipped?: boolean }> {
  // Validate identity
  if (!identity.user_id || !identity.tenant_id) {
    console.error('[VTID-01186] writeMemoryItemWithIdentity: Missing user_id or tenant_id');
    return { ok: false, error: 'Identity incomplete: user_id and tenant_id required' };
  }

  // Filter trivial messages to prevent memory flooding
  const direction = params.content_json?.direction as 'user' | 'assistant' | undefined;
  if (!params.skipFiltering && direction && !shouldStoreInMemory(params.content, direction)) {
    return { ok: true, skipped: true };
  }

  const supabase = createMemoryClient();
  if (!supabase) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const occurredAt = params.occurred_at || new Date().toISOString();
    const importance = params.importance || 10;
    const contentJson = {
      ...params.content_json,
      workspace_scope: params.workspace_scope || 'dev',
      active_role: identity.active_role || null,
    };

    // Auto-classify category if not provided
    const categoryKey = params.category_key || classifyDevCategory(params.content);

    // Boost importance for personal/relationship categories
    let adjustedImportance = importance;
    if (categoryKey === 'personal') {
      adjustedImportance = Math.max(importance, 50);
    } else if (categoryKey === 'relationships') {
      adjustedImportance = Math.max(importance, 40);
    }

    // Insert with authenticated identity
    const { data, error } = await supabase
      .from('memory_items')
      .insert({
        tenant_id: identity.tenant_id,
        user_id: identity.user_id,
        category_key: categoryKey,
        source: params.source,
        content: params.content,
        content_json: contentJson,
        importance: adjustedImportance,
        occurred_at: occurredAt
      })
      .select('id, category_key')
      .single();

    if (error) {
      if (error.message.includes('does not exist') || error.code === '42P01') {
        console.warn('[VTID-01186] memory_items table not found');
        return { ok: false, error: 'Memory Core not available' };
      }
      console.error('[VTID-01186] Memory write error:', error.message);
      return { ok: false, error: error.message };
    }

    console.log(`[VTID-01186] Memory written: ${data?.id} (user=${identity.user_id.substring(0,8)}..., tenant=${identity.tenant_id.substring(0,8)}...)`);
    return { ok: true, id: data?.id, category_key: categoryKey };

  } catch (err: any) {
    console.error('[VTID-01186] Memory write exception:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * VTID-01186: Fetch memory context with authenticated identity
 * Uses the provided identity instead of DEV_IDENTITY.
 * Falls back to DEV_IDENTITY if no identity provided (dev-sandbox only).
 *
 * @param identity - Optional authenticated identity. If not provided, uses DEV_IDENTITY in dev-sandbox mode.
 * @param limit - Maximum number of memory items to fetch
 * @param categories - Optional category filter
 */
export async function fetchMemoryContextWithIdentity(
  identity?: MemoryIdentity | null,
  limit: number = MEMORY_CONFIG.DEFAULT_CONTEXT_LIMIT,
  categories?: string[]
): Promise<OrbMemoryContext> {
  // If no identity provided, fall back to DEV_IDENTITY in dev-sandbox mode
  const effectiveIdentity: MemoryIdentity = identity && identity.user_id && identity.tenant_id
    ? identity
    : {
        user_id: DEV_IDENTITY.USER_ID,
        tenant_id: DEV_IDENTITY.TENANT_ID,
        active_role: DEV_IDENTITY.ACTIVE_ROLE
      };

  // If falling back to DEV_IDENTITY, check if dev-sandbox mode is enabled
  if (!identity && !isMemoryBridgeEnabled()) {
    const fetchedAt = new Date().toISOString();
    return {
      ok: false,
      user_id: effectiveIdentity.user_id,
      tenant_id: effectiveIdentity.tenant_id,
      items: [],
      summary: 'Memory bridge disabled',
      formatted_context: '',
      fetched_at: fetchedAt,
      error: 'Memory bridge not enabled (requires dev-sandbox mode or valid identity)'
    };
  }

  const fetchedAt = new Date().toISOString();
  const supabase = createMemoryClient();
  if (!supabase) {
    return {
      ok: false,
      user_id: effectiveIdentity.user_id,
      tenant_id: effectiveIdentity.tenant_id,
      items: [],
      summary: 'Database not configured',
      formatted_context: '',
      fetched_at: fetchedAt,
      error: 'Supabase not configured'
    };
  }

  try {
    const sinceDate = new Date();
    sinceDate.setHours(sinceDate.getHours() - MEMORY_CONFIG.MAX_AGE_HOURS);
    const sinceTimestamp = sinceDate.toISOString();
    const categoryFilter = categories || MEMORY_CONFIG.CONTEXT_CATEGORIES;

    // Split categories into persistent and time-sensitive
    const persistentCategories = categoryFilter.filter(
      (cat: string) => MEMORY_CONFIG.PERSISTENT_CATEGORIES.includes(cat)
    );
    const timeSensitiveCategories = categoryFilter.filter(
      (cat: string) => !MEMORY_CONFIG.PERSISTENT_CATEGORIES.includes(cat)
    );

    // Query persistent categories (no time filter)
    let persistentItems: MemoryItem[] = [];
    if (persistentCategories.length > 0) {
      const { data, error } = await supabase
        .from('memory_items')
        .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
        .eq('tenant_id', effectiveIdentity.tenant_id)
        .eq('user_id', effectiveIdentity.user_id)
        .in('category_key', persistentCategories)
        .order('importance', { ascending: false })
        .limit(limit);

      if (!error) {
        persistentItems = (data || []) as MemoryItem[];
      }
    }

    // Query time-sensitive categories
    let timeSensitiveItems: MemoryItem[] = [];
    if (timeSensitiveCategories.length > 0) {
      const { data, error } = await supabase
        .from('memory_items')
        .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
        .eq('tenant_id', effectiveIdentity.tenant_id)
        .eq('user_id', effectiveIdentity.user_id)
        .in('category_key', timeSensitiveCategories)
        .gte('occurred_at', sinceTimestamp)
        .order('importance', { ascending: false })
        .limit(limit);

      if (!error) {
        timeSensitiveItems = (data || []) as MemoryItem[];
      }
    }

    // Merge and deduplicate
    const allItems = [...persistentItems, ...timeSensitiveItems];
    const seenIds = new Set<string>();
    const memoryItems = allItems.filter(item => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    });

    // Use context window manager for selection
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const selectionResult = selectContextWindow(
      memoryItems,
      50,
      turnId,
      effectiveIdentity.user_id,
      effectiveIdentity.tenant_id
    );

    const items: MemoryItem[] = selectionResult.includedItems.map(item => ({
      id: item.id,
      category_key: item.category_key,
      source: item.source,
      content: item.content,
      content_json: item.content_json,
      importance: item.importance,
      occurred_at: item.occurred_at,
      created_at: item.created_at
    }));

    const summary = generateMemorySummary(items);
    const formattedContext = formatMemoryForPrompt(items);

    console.log(`[VTID-01186] Memory context fetched for user=${effectiveIdentity.user_id.substring(0,8)}...: ${items.length} items`);

    return {
      ok: true,
      user_id: effectiveIdentity.user_id,
      tenant_id: effectiveIdentity.tenant_id,
      items,
      summary,
      formatted_context: formattedContext,
      fetched_at: fetchedAt,
      contextMetrics: selectionResult.metrics,
      excludedCount: selectionResult.excludedItems.length
    };

  } catch (err: any) {
    console.error('[VTID-01186] Memory context fetch error:', err.message);
    return {
      ok: false,
      user_id: effectiveIdentity.user_id,
      tenant_id: effectiveIdentity.tenant_id,
      items: [],
      summary: 'Fetch error',
      formatted_context: '',
      fetched_at: fetchedAt,
      error: err.message
    };
  }
}

/**
 * Simple category classification for dev memory writes
 * VTID-01109: Enhanced to better classify personal identity and relationships
 *
 * BUG FIXES (VTID-01109 revision 2):
 * - Fixed regex patterns with trailing spaces that broke \b word boundary
 * - Added German ß/ss variants (speech-to-text may normalize ß to ss)
 * - Added more German name patterns (nenn mich, man nennt mich, etc.)
 * - Added English contractions properly (my name's, I'm)
 */
function classifyDevCategory(content: string): string {
  const lower = content.toLowerCase();

  // VTID-01109 rev2 + VTID-DEBUG-05: Personal identity keywords
  // VTID-DEBUG-05: Removed overly broad patterns that caused false positives:
  // - "/\bi am\b/" matched any "I am X" including "I am here"
  // - "/\bi'm\b/" matched any "I'm X"
  // - "/\bich bin\b/" matched "ich bin da" (I'm here)
  // Now uses more specific patterns for actual name introductions
  const personalPatterns = [
    // English name patterns - specific to name introductions
    /\bmy name\b/i,
    /\bmy name's\b/i,
    /\bmy name is\b/i,
    /\bi am called\b/i,
    /\bcall me\b/i,
    /\byou can call me\b/i,
    /\bpeople call me\b/i,
    /\beveryone calls me\b/i,
    /\bi go by\b/i,
    // German name patterns - specific to name introductions
    /\bich heiße\b/i,
    /\bich heisse\b/i,           // speech-to-text may convert ß to ss
    /\bich bin der\b/i,          // "ich bin der Marco"
    /\bich bin die\b/i,          // "ich bin die Maria"
    /\bmein name ist\b/i,
    /\bmein name lautet\b/i,
    /\bnenn mich\b/i,
    /\bnennen sie mich\b/i,
    /\bman nennt mich\b/i,
    /\bdu kannst mich.*nennen\b/i,
    /\bsie können mich.*nennen\b/i,
    // Location/origin patterns (fixed: removed trailing space from "from")
    /\bi'm from\b/i,
    /\bi am from\b/i,
    /\bi come from\b/i,
    /\bborn in\b/i,
    /\bhometown\b/i,
    /\bi live in\b/i,
    /\bich komme aus\b/i,
    /\bich wohne in\b/i,
    /\bgeboren in\b/i,
    // VTID-DEBUG-MEMORY-FIX: Added missing German location patterns
    /\bmein wohnort\b/i,         // "mein Wohnort ist..."
    /\bwohnort ist\b/i,          // "Wohnort ist Berlin"
    /\bmeine heimatstadt\b/i,    // "meine Heimatstadt ist..."
    /\bheimatstadt ist\b/i,      // "Heimatstadt ist München"
    /\bich lebe in\b/i,          // "ich lebe in Berlin"
    /\bwohne seit\b/i,           // "ich wohne seit 5 Jahren in..."
    /\bgebürtig aus\b/i,         // "gebürtig aus Hamburg"
    /\bgeburtig aus\b/i,         // speech-to-text variant
    /\baufgewachsen in\b/i,      // "aufgewachsen in München"
    // Age/birthday patterns
    /\bmy age\b/i,
    /\byears old\b/i,
    /\bmy birthday\b/i,
    /\bich bin \d+ jahre\b/i,
    /\bmein geburtstag\b/i,
    // VTID-DEBUG-MEMORY-FIX: Added missing German birthday patterns
    /\bmein geburtsdatum\b/i,    // "mein Geburtsdatum ist..."
    /\bgeburtsdatum ist\b/i,     // "Geburtsdatum ist 15.03.1985"
    /\bgeboren am\b/i,           // "geboren am 15. März"
    /\bam \d+\.\d+\.\d+ geboren\b/i,  // "am 15.03.1985 geboren"
    /\bbin am \d+\b/i,           // "ich bin am 15. März..."
    /\bgeburtstag ist am\b/i,    // "mein Geburtstag ist am..."
    /\bgeburtstag am\b/i,        // "Geburtstag am 15.03"
    // Occupation patterns
    /\bi work\b/i,
    /\bmy job\b/i,
    /\bmy occupation\b/i,
    /\bi'm a\b/i,
    /\bich arbeite\b/i,
    /\bmein beruf\b/i,
    /\bich bin.*von beruf\b/i,
    // VTID-DEBUG-MEMORY-FIX: Added company/business patterns
    /\bmy company\b/i,           // "my company is..."
    /\bmy business\b/i,          // "my business is..."
    /\bown a company\b/i,        // "I own a company"
    /\bmy firm\b/i,              // "my firm is..."
    /\bmeine firma\b/i,          // "meine Firma heißt..."
    /\bfirma heißt\b/i,          // "die Firma heißt..."
    /\bfirma heisst\b/i,         // speech-to-text variant
    /\bmein unternehmen\b/i,     // "mein Unternehmen ist..."
    /\bunternehmen heißt\b/i,    // "das Unternehmen heißt..."
    /\bunternehmen heisst\b/i,   // speech-to-text variant
    /\bich habe eine firma\b/i,  // "ich habe eine Firma"
    /\bselbstständig\b/i,        // "ich bin selbstständig"
    /\bselbststaendig\b/i,       // speech-to-text variant
    /\bfreiberufler\b/i,         // "ich bin Freiberufler"
    /\bgründer von\b/i,          // "ich bin Gründer von..."
    /\bgruender von\b/i,         // speech-to-text variant
    // Contact patterns
    /\bmy email\b/i,
    /\bmy phone\b/i,
    /\bmy address\b/i,
    /\bmeine email\b/i,
    /\bmeine telefon\b/i,
    /\bmeine adresse\b/i,
    // VTID-DEBUG-MEMORY-FIX: Explicit "remember this" patterns (German)
    /\bdas ist mein\b/i,         // "das ist mein Name/Geburtstag/etc."
    /\bdas ist meine\b/i,        // "das ist meine Firma/Adresse/etc."
    /\bich bin \w+ und\b/i       // "ich bin Dragan und..." (name introduction)
  ];

  for (const pattern of personalPatterns) {
    if (pattern.test(lower)) {
      return 'personal';
    }
  }

  // Health-related keywords
  if (/\b(health|fitness|exercise|sleep|diet|weight|medication|doctor|symptom|pain|illness|sick|medical|gesundheit|arzt|medizin|schmerz|krank)\b/i.test(lower)) {
    return 'health';
  }

  // VTID-01109: Relationship keywords - EXPANDED with German
  if (/\b(family|friend|partner|wife|husband|fiancée|fiancee|fiance|spouse|girlfriend|boyfriend|significant other|child|children|son|daughter|parent|mother|father|mom|dad|brother|sister|colleague|relationship|married|engaged|dating|verlobte|verlobter|frau|mann|freundin|freund|kind|kinder|mutter|vater|schwester|bruder|familie)\b/i.test(lower)) {
    return 'relationships';
  }

  // Preference keywords (likes, dislikes, favorites)
  if (/\b(prefer|like|love|hate|favorite|favourite|always|never|want|need|enjoy|dislike|mag|liebe|hasse|bevorzuge|liebling)\b/i.test(lower)) {
    return 'preferences';
  }

  // Goal keywords
  if (/\b(goal|plan|want to|going to|will|target|achieve|objective|aspire|dream|hope to|ziel|plane|vorhaben|erreichen|traum)\b/i.test(lower)) {
    return 'goals';
  }

  // Remember requests (user asking to remember something specific)
  if (/\b(remember|don't forget|keep in mind|note that|wichtig|merken|vergiss nicht|merk dir)\b/i.test(lower)) {
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

    // VTID-DEBUG-01: Split categories into persistent (no time filter) and time-sensitive
    // Personal identity info (name, birthday, family) must NEVER expire
    const persistentCategories = categoryFilter.filter(
      (cat: string) => MEMORY_CONFIG.PERSISTENT_CATEGORIES.includes(cat)
    );
    const timeSensitiveCategories = categoryFilter.filter(
      (cat: string) => !MEMORY_CONFIG.PERSISTENT_CATEGORIES.includes(cat)
    );

    console.log(`[VTID-DEBUG-01] Querying persistent categories (no time limit): ${persistentCategories.join(', ')}`);
    console.log(`[VTID-DEBUG-01] Querying time-sensitive categories (${MEMORY_CONFIG.MAX_AGE_HOURS}h): ${timeSensitiveCategories.join(', ')}`);

    // Query 1: Persistent categories WITHOUT time filter (personal identity never expires)
    let persistentItems: MemoryItem[] = [];
    if (persistentCategories.length > 0) {
      const { data: persistentData, error: persistentError } = await supabase
        .from('memory_items')
        .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
        .eq('tenant_id', DEV_IDENTITY.TENANT_ID)
        .eq('user_id', DEV_IDENTITY.USER_ID)
        .in('category_key', persistentCategories)
        // NO time filter - personal identity info should always be available
        .order('importance', { ascending: false })
        .limit(limit);  // Generous limit for identity info

      if (persistentError) {
        console.warn('[VTID-DEBUG-01] Persistent category query error:', persistentError.message);
      } else {
        persistentItems = (persistentData || []) as MemoryItem[];
        console.log(`[VTID-DEBUG-01] Found ${persistentItems.length} persistent memory items (no time filter)`);
      }
    }

    // Query 2: Time-sensitive categories WITH time filter
    let timeSensitiveItems: MemoryItem[] = [];
    if (timeSensitiveCategories.length > 0) {
      const { data: timeSensitiveData, error: timeSensitiveError } = await supabase
        .from('memory_items')
        .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
        .eq('tenant_id', DEV_IDENTITY.TENANT_ID)
        .eq('user_id', DEV_IDENTITY.USER_ID)
        .in('category_key', timeSensitiveCategories)
        .gte('occurred_at', sinceTimestamp)  // Time filter for non-identity categories
        .order('importance', { ascending: false })
        .limit(limit);

      if (timeSensitiveError) {
        // Check if table doesn't exist (VTID-01104 not deployed)
        if (timeSensitiveError.message.includes('does not exist') || timeSensitiveError.code === '42P01') {
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
        console.error('[VTID-DEBUG-01] Time-sensitive category query error:', timeSensitiveError.message);
      } else {
        timeSensitiveItems = (timeSensitiveData || []) as MemoryItem[];
      }
    }

    // Merge results: persistent items first (identity is most important), then time-sensitive
    const allItems = [...persistentItems, ...timeSensitiveItems];

    // Deduplicate by ID (in case of overlap)
    const seenIds = new Set<string>();
    const memoryItems = allItems.filter(item => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    });

    console.log(`[VTID-DEBUG-01] Total memory items: ${memoryItems.length} (${persistentItems.length} persistent + ${timeSensitiveItems.length} time-sensitive, ${allItems.length - memoryItems.length} duplicates removed)`);

    // Handle empty result (not an error, just no data yet)
    if (memoryItems.length === 0) {
      console.log('[VTID-01106] No memory items found for dev user');
    }

    // VTID-01117: Use Context Window Manager for deterministic selection
    // This replaces the old ad-hoc sorting and limiting logic
    const rawItems = (memoryItems || []) as MemoryItem[];

    // Generate a unique turn ID for traceability
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    // Apply context window selection with saturation control
    // Quality score defaults to 50 (medium confidence) - can be enhanced with D24 integration
    const selectionResult = selectContextWindow(
      rawItems,
      50, // Default quality score
      turnId,
      DEV_IDENTITY.USER_ID,
      DEV_IDENTITY.TENANT_ID
    );

    // Extract selected items (strip the enhanced fields to maintain interface compatibility)
    const items: MemoryItem[] = selectionResult.includedItems.map(item => ({
      id: item.id,
      category_key: item.category_key,
      source: item.source,
      content: item.content,
      content_json: item.content_json,
      importance: item.importance,
      occurred_at: item.occurred_at,
      created_at: item.created_at
    }));

    // Generate exclusion summary for debugging
    const exclusionSummary: Record<string, number> = {};
    for (const exclusion of selectionResult.excludedItems) {
      exclusionSummary[exclusion.reason] = (exclusionSummary[exclusion.reason] || 0) + 1;
    }

    console.log(
      `[VTID-01117] Context window selection: ${items.length} included, ` +
      `${selectionResult.excludedItems.length} excluded ` +
      `(personal: ${items.filter(i => i.category_key === 'personal').length}, ` +
      `relationships: ${items.filter(i => i.category_key === 'relationships').length})`
    );

    if (selectionResult.excludedItems.length > 0) {
      console.log(`[VTID-01117] Exclusion reasons: ${JSON.stringify(exclusionSummary)}`);
    }

    const summary = generateMemorySummary(items);
    const formattedContext = formatMemoryForPrompt(items);

    console.log(`[VTID-01106] Context assembled: ${items.length} items, ${selectionResult.metrics.totalChars} chars`);

    // Emit OASIS event for memory context fetch with enhanced metrics
    await emitOasisEvent({
      vtid: 'VTID-01117',
      type: 'orb.context.window_selected',
      source: 'orb-memory-bridge',
      status: 'success',
      message: `Context window selected: ${items.length} items, ${selectionResult.excludedItems.length} excluded`,
      payload: {
        user_id: DEV_IDENTITY.USER_ID,
        tenant_id: DEV_IDENTITY.TENANT_ID,
        turn_id: turnId,
        included_count: items.length,
        excluded_count: selectionResult.excludedItems.length,
        total_chars: selectionResult.metrics.totalChars,
        diversity_score: selectionResult.metrics.diversityScore,
        budget_utilization: selectionResult.metrics.budgetUtilization,
        processing_time_ms: selectionResult.metrics.processingTimeMs,
        exclusion_summary: exclusionSummary,
        categories: categoryFilter,
        since: sinceTimestamp
      }
    }).catch((err: Error) => console.warn('[VTID-01117] OASIS event failed:', err.message));

    return {
      ok: true,
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      items,
      summary,
      formatted_context: formattedContext,
      fetched_at: fetchedAt,
      // VTID-01117: Include context window metrics
      contextMetrics: selectionResult.metrics,
      excludedCount: selectionResult.excludedItems.length,
      exclusionSummary
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
// VTID-01115: Scored Memory Context Fetching
// =============================================================================

/**
 * VTID-01115: Fetch memory context with relevance scoring
 *
 * This is the D23 implementation of the Memory Relevance Scoring Engine.
 * Every memory item is scored before entering the context bundle.
 *
 * Hard Constraints:
 * - No memory enters context without a score
 * - All scoring logic is deterministic and inspectable
 * - Raw timestamps alone do not determine relevance
 *
 * @param intent - The current intent from D21 (health, longevity, community, lifestyle, planner, general)
 * @param domain - Optional domain from D22 (health, community, business, lifestyle)
 * @param role - User role for access control (patient, professional, staff, admin, developer)
 * @param limit - Maximum number of memory items to consider
 * @param categories - Optional category filter
 */
export async function fetchScoredMemoryContext(
  intent: RetrieveIntent = 'general',
  domain?: Domain,
  role: UserRole = 'patient',
  limit: number = MEMORY_CONFIG.DEFAULT_CONTEXT_LIMIT,
  categories?: string[]
): Promise<ScoredOrbMemoryContext> {
  const fetchedAt = new Date().toISOString();
  const currentTime = new Date();

  // Check if memory bridge is enabled
  if (!isMemoryBridgeEnabled()) {
    return {
      ok: false,
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      items: [],
      scored_items: [],
      excluded_items: [],
      summary: 'Memory bridge disabled',
      formatted_context: '',
      fetched_at: fetchedAt,
      error: 'Memory bridge not enabled (requires dev-sandbox mode)',
      scoring_metadata: {
        scoring_run_id: `score_${DEV_IDENTITY.TENANT_ID}_${Date.now()}`,
        scoring_timestamp: fetchedAt,
        context: { intent, domain, role },
        total_candidates: 0,
        included_count: 0,
        deprioritized_count: 0,
        excluded_count: 0,
        top_n_with_factors: [],
        exclusion_reasons: []
      }
    };
  }

  const supabase = createMemoryClient();
  if (!supabase) {
    return {
      ok: false,
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      items: [],
      scored_items: [],
      excluded_items: [],
      summary: 'Database not configured',
      formatted_context: '',
      fetched_at: fetchedAt,
      error: 'Supabase not configured',
      scoring_metadata: {
        scoring_run_id: `score_${DEV_IDENTITY.TENANT_ID}_${Date.now()}`,
        scoring_timestamp: fetchedAt,
        context: { intent, domain, role },
        total_candidates: 0,
        included_count: 0,
        deprioritized_count: 0,
        excluded_count: 0,
        top_n_with_factors: [],
        exclusion_reasons: []
      }
    };
  }

  try {
    // Calculate since timestamp (max age for memory items)
    const sinceDate = new Date();
    sinceDate.setHours(sinceDate.getHours() - MEMORY_CONFIG.MAX_AGE_HOURS);
    const sinceTimestamp = sinceDate.toISOString();

    // Filter categories
    const categoryFilter = categories || MEMORY_CONFIG.CONTEXT_CATEGORIES;

    // Set request context for dev user
    const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
      p_tenant_id: DEV_IDENTITY.TENANT_ID,
      p_active_role: DEV_IDENTITY.ACTIVE_ROLE
    });
    if (bootstrapError) {
      console.warn('[VTID-01115] Bootstrap context failed (non-fatal):', bootstrapError.message);
    }

    // VTID-DEBUG-01: Split categories into persistent (no time filter) and time-sensitive
    // Personal identity info (name, birthday, family) must NEVER expire
    const persistentCategories = categoryFilter.filter(
      (cat: string) => MEMORY_CONFIG.PERSISTENT_CATEGORIES.includes(cat)
    );
    const timeSensitiveCategories = categoryFilter.filter(
      (cat: string) => !MEMORY_CONFIG.PERSISTENT_CATEGORIES.includes(cat)
    );

    console.log(`[VTID-DEBUG-01] Scored query - persistent categories (no time limit): ${persistentCategories.join(', ')}`);
    console.log(`[VTID-DEBUG-01] Scored query - time-sensitive categories (${MEMORY_CONFIG.MAX_AGE_HOURS}h): ${timeSensitiveCategories.join(', ')}`);

    // Query 1: Persistent categories WITHOUT time filter (personal identity never expires)
    let persistentItems: MemoryItem[] = [];
    if (persistentCategories.length > 0) {
      const { data: persistentData, error: persistentError } = await supabase
        .from('memory_items')
        .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
        .eq('tenant_id', DEV_IDENTITY.TENANT_ID)
        .eq('user_id', DEV_IDENTITY.USER_ID)
        .in('category_key', persistentCategories)
        // NO time filter - personal identity info should always be available
        .order('importance', { ascending: false })
        .limit(limit * 2);

      if (persistentError) {
        console.warn('[VTID-DEBUG-01] Persistent category query error (scored):', persistentError.message);
      } else {
        persistentItems = (persistentData || []) as MemoryItem[];
        console.log(`[VTID-DEBUG-01] Scored: Found ${persistentItems.length} persistent memory items (no time filter)`);
      }
    }

    // Query 2: Time-sensitive categories WITH time filter
    let timeSensitiveItems: MemoryItem[] = [];
    if (timeSensitiveCategories.length > 0) {
      const { data: timeSensitiveData, error: timeSensitiveError } = await supabase
        .from('memory_items')
        .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
        .eq('tenant_id', DEV_IDENTITY.TENANT_ID)
        .eq('user_id', DEV_IDENTITY.USER_ID)
        .in('category_key', timeSensitiveCategories)
        .gte('occurred_at', sinceTimestamp)  // Time filter for non-identity categories
        .order('occurred_at', { ascending: false })
        .limit(limit * 2);

      if (timeSensitiveError) {
        if (timeSensitiveError.message.includes('does not exist') || timeSensitiveError.code === '42P01') {
          console.warn('[VTID-01115] memory_items table not found (VTID-01104 dependency)');
          return {
            ok: false,
            user_id: DEV_IDENTITY.USER_ID,
            tenant_id: DEV_IDENTITY.TENANT_ID,
            items: [],
            scored_items: [],
            excluded_items: [],
            summary: 'Memory Core not deployed',
            formatted_context: '',
            fetched_at: fetchedAt,
            error: 'Memory Core not available (VTID-01104 dependency)',
            scoring_metadata: {
              scoring_run_id: `score_${DEV_IDENTITY.TENANT_ID}_${Date.now()}`,
              scoring_timestamp: fetchedAt,
              context: { intent, domain, role },
              total_candidates: 0,
              included_count: 0,
              deprioritized_count: 0,
              excluded_count: 0,
              top_n_with_factors: [],
              exclusion_reasons: []
            }
          };
        }
        console.error('[VTID-DEBUG-01] Time-sensitive category query error (scored):', timeSensitiveError.message);
      } else {
        timeSensitiveItems = (timeSensitiveData || []) as MemoryItem[];
      }
    }

    // Merge results: persistent items first (identity is most important), then time-sensitive
    const allItems = [...persistentItems, ...timeSensitiveItems];

    // Deduplicate by ID (in case of overlap)
    const seenIds = new Set<string>();
    const memoryItems = allItems.filter(item => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    });

    console.log(`[VTID-DEBUG-01] Scored total: ${memoryItems.length} items (${persistentItems.length} persistent + ${timeSensitiveItems.length} time-sensitive)`);

    const rawItems = memoryItems as MemoryItem[];

    // =============================================================================
    // VTID-01115: Apply Relevance Scoring
    // This is the core D23 functionality - score all memories before context assembly
    // =============================================================================

    const scoringContext: ScoringContext = {
      intent,
      domain,
      role,
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      current_time: currentTime
      // TODO: Add user_reinforcement_signals when available from database
    };

    console.log(`[VTID-01115] Scoring ${rawItems.length} memory candidates (intent=${intent}, domain=${domain || 'none'}, role=${role})`);

    const scoringResult = scoreAndRankMemories(rawItems, scoringContext);

    // Log the scoring run for debugging
    logScoringRun(scoringResult.scoring_metadata, true);

    // Emit OASIS event for scoring
    await emitScoringEvent(
      'memory.scoring.completed',
      scoringResult.scoring_metadata,
      {
        intent,
        domain,
        role,
        categories: categoryFilter
      }
    ).catch((err: Error) => console.warn('[VTID-01115] Failed to emit scoring event:', err.message));

    // Get only included items (not excluded) up to limit
    const includedItems = scoringResult.scored_items
      .filter(item => !item.exclusion_reason)
      .slice(0, limit);

    // Convert ScoredMemoryItem back to MemoryItem for backward compatibility
    const items: MemoryItem[] = includedItems.map(scored => ({
      id: scored.id,
      category_key: scored.category_key,
      source: scored.source,
      content: scored.content,
      content_json: scored.content_json,
      importance: scored.importance,
      occurred_at: scored.occurred_at,
      created_at: scored.created_at
    }));

    const summary = generateMemorySummary(items);
    const formattedContext = formatScoredMemoryForPrompt(includedItems);

    console.log(`[VTID-01115] Scored context: ${includedItems.length} included, ${scoringResult.excluded_items.length} excluded (of ${rawItems.length} candidates)`);

    // Emit OASIS event for context fetch
    await emitOasisEvent({
      vtid: 'VTID-01115',
      type: 'orb.memory.scored_context_fetched',
      source: 'orb-memory-bridge',
      status: 'success',
      message: `Fetched ${includedItems.length} scored memory items for ORB context`,
      payload: {
        user_id: DEV_IDENTITY.USER_ID,
        tenant_id: DEV_IDENTITY.TENANT_ID,
        scoring_run_id: scoringResult.scoring_metadata.scoring_run_id,
        total_candidates: rawItems.length,
        included_count: includedItems.length,
        excluded_count: scoringResult.excluded_items.length,
        intent,
        domain,
        role
      }
    }).catch((err: Error) => console.warn('[VTID-01115] OASIS event failed:', err.message));

    return {
      ok: true,
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      items,
      scored_items: includedItems,
      excluded_items: scoringResult.excluded_items,
      summary,
      formatted_context: formattedContext,
      fetched_at: fetchedAt,
      scoring_metadata: scoringResult.scoring_metadata
    };

  } catch (err: any) {
    console.error('[VTID-01115] Scored memory context fetch error:', err.message);
    return {
      ok: false,
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      items: [],
      scored_items: [],
      excluded_items: [],
      summary: 'Fetch error',
      formatted_context: '',
      fetched_at: fetchedAt,
      error: err.message,
      scoring_metadata: {
        scoring_run_id: `score_${DEV_IDENTITY.TENANT_ID}_${Date.now()}`,
        scoring_timestamp: fetchedAt,
        context: { intent, domain, role },
        total_candidates: 0,
        included_count: 0,
        deprioritized_count: 0,
        excluded_count: 0,
        top_n_with_factors: [],
        exclusion_reasons: []
      }
    };
  }
}

/**
 * VTID-01115: Format scored memory items for prompt injection
 * Includes relevance scores for transparency
 */
function formatScoredMemoryForPrompt(items: ScoredMemoryItem[]): string {
  if (items.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## User Context (from Memory - Relevance Scored)');
  lines.push('');

  // Group by category
  const byCategory: Record<string, ScoredMemoryItem[]> = {};
  for (const item of items) {
    if (!byCategory[item.category_key]) {
      byCategory[item.category_key] = [];
    }
    byCategory[item.category_key].push(item);
  }

  // Sort categories by highest score in category
  const sortedCategories = Object.keys(byCategory).sort((a, b) => {
    const maxA = Math.max(...byCategory[a].map(i => i.relevance_score));
    const maxB = Math.max(...byCategory[b].map(i => i.relevance_score));
    return maxB - maxA;
  });

  // Format each category
  for (const category of sortedCategories) {
    const catItems = byCategory[category];
    lines.push(`### ${formatCategoryName(category)}`);

    // VTID-DEBUG-01: NO LIMIT for personal/relationships - include ALL items
    // Other categories use ITEMS_PER_CATEGORY to prevent flooding
    const isIdentityCategory = category === 'personal' || category === 'relationships';
    const itemLimit = isIdentityCategory ? catItems.length : (MEMORY_CONFIG.ITEMS_PER_CATEGORY || 10);

    for (const item of catItems.slice(0, itemLimit)) {
      const timestamp = formatRelativeTime(item.occurred_at);
      const content = truncateContent(item.content, MEMORY_CONFIG.MAX_ITEM_CHARS || 300);
      const direction = item.content_json?.direction as string | undefined;

      // Include relevance indicator for high-scoring items
      const relevanceMarker = item.relevance_score >= 70 ? '★' :
                              item.relevance_score >= 50 ? '●' : '○';

      if (direction === 'user') {
        lines.push(`- ${relevanceMarker} [${timestamp}] User: "${content}"`);
      } else if (direction === 'assistant') {
        lines.push(`- ${relevanceMarker} [${timestamp}] Assistant: "${content}"`);
      } else {
        lines.push(`- ${relevanceMarker} [${timestamp}] ${content}`);
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

    // VTID-DEBUG-01: NO LIMIT for personal/relationships - include ALL items
    // Other categories use ITEMS_PER_CATEGORY to prevent flooding
    const isIdentityCategory = category === 'personal' || category === 'relationships';
    const itemLimit = isIdentityCategory ? catItems.length : (MEMORY_CONFIG.ITEMS_PER_CATEGORY || 10);

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

**STORING NEW INFORMATION - CRITICAL:**
7. When the user tells you NEW personal information (name, birthday, family member's birthday, preferences, etc.), the system AUTOMATICALLY STORES IT in persistent memory.
8. NEVER say "I cannot store this", "ich kann nicht speichern", or "I don't have the ability to save". The system DOES store it automatically.
9. When the user provides new info, ACKNOWLEDGE it positively: "Got it, I'll remember that" / "Notiert!" / "Ich merke mir das"
10. Treat every piece of personal information the user shares as something you WILL remember in future conversations.

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
 * VTID-01117: Enhanced with context window metrics
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
  /** VTID-01117: Context window metrics */
  context_window?: {
    excluded_count: number;
    exclusion_summary: Record<string, number>;
    diversity_score: number;
    budget_utilization: number;
    processing_time_ms: number;
  };
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
    timestamp,
    // VTID-01117: Include context window metrics
    context_window: memoryContext.contextMetrics ? {
      excluded_count: memoryContext.excludedCount || 0,
      exclusion_summary: memoryContext.exclusionSummary || {},
      diversity_score: memoryContext.contextMetrics.diversityScore,
      budget_utilization: memoryContext.contextMetrics.budgetUtilization,
      processing_time_ms: memoryContext.contextMetrics.processingTimeMs
    } : undefined
  };
}

// =============================================================================
// VTID-01121: Trust Context Integration
// =============================================================================

import {
  TrustRepairService,
  quickDetectCorrection,
  getTrustBand,
} from './trust-repair-service';
import type { TrustScore, BehaviorConstraint } from '../types/feedback-correction';

/**
 * Trust context for ORB decision-making
 * Fetched alongside memory context for complete user state
 */
export interface OrbTrustContext {
  ok: boolean;
  overallTrust: number;
  trustBand: string;  // 'Critical' | 'Low' | 'Medium' | 'High' | 'Full'
  requiresRestriction: boolean;
  needsAttention: boolean;
  scores: TrustScore[];
  constraints: BehaviorConstraint[];
  recentCorrectionCount: number;
  timestamp: string;
  error?: string;
}

/**
 * VTID-01121: Fetch trust context for ORB session
 * Returns current trust scores and behavior constraints
 * Used to adjust ORB behavior based on user's correction history
 */
export async function fetchDevTrustContext(): Promise<OrbTrustContext> {
  const timestamp = new Date().toISOString();

  // Only active in dev sandbox
  if (!isMemoryBridgeEnabled()) {
    return {
      ok: false,
      overallTrust: 80,  // Default trust
      trustBand: 'High',
      requiresRestriction: false,
      needsAttention: false,
      scores: [],
      constraints: [],
      recentCorrectionCount: 0,
      timestamp,
      error: 'Trust context only available in dev-sandbox mode',
    };
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !supabaseKey) {
      return {
        ok: false,
        overallTrust: 80,
        trustBand: 'High',
        requiresRestriction: false,
        needsAttention: false,
        scores: [],
        constraints: [],
        recentCorrectionCount: 0,
        timestamp,
        error: 'Supabase credentials not configured',
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Bootstrap dev identity context
    await supabase.rpc('dev_bootstrap_request_context', {
      p_tenant_slug: DEV_IDENTITY.TENANT_SLUG,
      p_user_id: DEV_IDENTITY.USER_ID,
      p_active_role: DEV_IDENTITY.ACTIVE_ROLE,
    });

    // Fetch trust scores
    const { data: trustData, error: trustError } = await supabase.rpc('get_trust_scores');

    if (trustError) {
      // If RPC doesn't exist, return defaults (migration not applied)
      if (trustError.message.includes('does not exist')) {
        console.log('[VTID-01121] Trust scores RPC not available (migration pending)');
        return {
          ok: true,
          overallTrust: 80,
          trustBand: 'High',
          requiresRestriction: false,
          needsAttention: false,
          scores: [],
          constraints: [],
          recentCorrectionCount: 0,
          timestamp,
        };
      }
      throw new Error(trustError.message);
    }

    // Fetch behavior constraints
    const { data: constraintData, error: constraintError } = await supabase.rpc('get_behavior_constraints', {
      p_constraint_type: null,
    });

    if (constraintError && !constraintError.message.includes('does not exist')) {
      console.warn('[VTID-01121] Constraint fetch error:', constraintError.message);
    }

    // Fetch recent correction count
    const { data: historyData } = await supabase.rpc('get_correction_history', {
      p_limit: 10,
      p_offset: 0,
      p_feedback_type: null,
    });

    const scores: TrustScore[] = trustData?.scores || [];
    const constraints: BehaviorConstraint[] = constraintData?.constraints || [];
    const recentCorrectionCount = historyData?.total || 0;

    // Find overall trust score
    const overallScore = scores.find(s => s.component === 'overall');
    const overallTrust = overallScore?.score ?? 80;
    const trustBand = getTrustBand(overallTrust);

    // Determine if restriction is needed
    const requiresRestriction = overallTrust < 40 || scores.some(s => s.score < 40);
    const needsAttention = overallTrust < 20 || scores.some(s => s.consecutive_corrections >= 5);

    console.log(`[VTID-01121] Trust context fetched: overall=${overallTrust}, band=${trustBand}, constraints=${constraints.length}`);

    return {
      ok: true,
      overallTrust,
      trustBand,
      requiresRestriction,
      needsAttention,
      scores,
      constraints,
      recentCorrectionCount,
      timestamp,
    };

  } catch (err: any) {
    console.error('[VTID-01121] Failed to fetch trust context:', err.message);
    return {
      ok: false,
      overallTrust: 80,
      trustBand: 'High',
      requiresRestriction: false,
      needsAttention: false,
      scores: [],
      constraints: [],
      recentCorrectionCount: 0,
      timestamp,
      error: err.message,
    };
  }
}

/**
 * VTID-01121: Build trust-aware system instruction enhancement
 * Adds trust context and behavior constraints to ORB system prompt
 */
export function buildTrustAwareInstruction(
  baseInstruction: string,
  trustContext: OrbTrustContext
): string {
  // If trust is high and no constraints, no modification needed
  if (!trustContext.ok || (trustContext.overallTrust >= 70 && trustContext.constraints.length === 0)) {
    return baseInstruction;
  }

  let trustGuidance = '\n\n## TRUST & BEHAVIOR GUIDANCE (VTID-01121)\n';

  // Add trust level awareness
  trustGuidance += `\nCurrent trust level: ${trustContext.trustBand} (${trustContext.overallTrust}/100)\n`;

  // Add restriction guidance if needed
  if (trustContext.requiresRestriction) {
    trustGuidance += `
**IMPORTANT: The user has corrected you multiple times. Be extra careful:**
- Ask for confirmation before taking significant actions
- Be more conservative with suggestions
- Acknowledge when you're uncertain
- If the user seems frustrated, acknowledge it and adjust your approach
`;
  }

  if (trustContext.needsAttention) {
    trustGuidance += `
**CRITICAL: Trust is very low. The user is frustrated with past interactions:**
- Avoid proactive suggestions unless asked
- Keep responses shorter and more direct
- Ask before assuming anything about their preferences
- If you're about to repeat a past mistake, stop and ask instead
`;
  }

  // Add specific behavior constraints
  if (trustContext.constraints.length > 0) {
    trustGuidance += '\n**BLOCKED BEHAVIORS - DO NOT DO THESE:**\n';
    for (const constraint of trustContext.constraints.slice(0, 5)) {
      trustGuidance += `- ${constraint.description}\n`;
    }
    if (trustContext.constraints.length > 5) {
      trustGuidance += `- (and ${trustContext.constraints.length - 5} more constraints)\n`;
    }
  }

  return baseInstruction + trustGuidance;
}

/**
 * VTID-01121: Quick check if a user message appears to be a correction
 * Returns detection result for ORB to decide how to respond
 */
export function detectUserCorrection(userMessage: string): {
  isCorrection: boolean;
  type: string | null;
  shouldAcknowledge: boolean;
} {
  const result = quickDetectCorrection(userMessage);

  return {
    isCorrection: result.isCorrection,
    type: result.type,
    shouldAcknowledge: result.isCorrection && result.type !== null,
  };
}

/**
 * VTID-01121: Get combined memory and trust context for ORB
 * Convenience function that fetches both contexts in parallel
 */
export async function getFullOrbContext(): Promise<{
  memoryContext: OrbMemoryContext;
  trustContext: OrbTrustContext;
}> {
  const [memoryContext, trustContext] = await Promise.all([
    fetchDevMemoryContext(),
    fetchDevTrustContext(),
  ]);

  return { memoryContext, trustContext };
}

/**
 * VTID-01121: Build fully enhanced instruction with memory and trust
 * Combines memory context and trust awareness into system instruction
 */
export async function buildFullyEnhancedInstruction(
  baseInstruction: string
): Promise<{
  instruction: string;
  memoryContext: OrbMemoryContext;
  trustContext: OrbTrustContext;
}> {
  const { memoryContext, trustContext } = await getFullOrbContext();

  // First add memory context
  let instruction = buildMemoryEnhancedInstruction(baseInstruction, memoryContext);

  // Then add trust awareness
  instruction = buildTrustAwareInstruction(instruction, trustContext);

  return { instruction, memoryContext, trustContext };
}

// =============================================================================
// VTID-01120: D28 Emotional & Cognitive Signal Integration
// =============================================================================

/**
 * Enhanced instruction context including D28 emotional/cognitive signals
 * VTID-01135: Now includes D41 boundary/consent context
 */
export interface OrbEnhancedContext {
  instruction: string;
  memoryContext: OrbMemoryContext;
  signalContext?: {
    context: string;
    orbContext: OrbSignalContext;
  };
  /** VTID-01135: D41 boundary and consent context */
  boundaryContext?: {
    context: string;
    orbContext: OrbBoundaryContext;
  };
}

/**
 * VTID-01120 + VTID-01135: Build memory-enhanced instruction with D28 signal and D41 boundary context
 *
 * Combines:
 * - Base system instruction
 * - Memory context (personal, relationships, conversations)
 * - D28 emotional/cognitive signals (tone, pacing, depth hints)
 * - D41 boundary/consent context (privacy, emotional safety, suppressions)
 *
 * @param baseInstruction - The base system instruction
 * @param sessionId - Optional session ID for signal lookup
 * @returns Enhanced instruction with memory, signal, and boundary context
 */
export async function getFullyEnhancedInstruction(
  baseInstruction: string,
  sessionId?: string
): Promise<OrbEnhancedContext> {
  // Get memory context
  const memoryContext = await fetchDevMemoryContext();
  let instruction = buildMemoryEnhancedInstruction(baseInstruction, memoryContext);

  // Get D28 signal context
  let signalContext: { context: string; orbContext: OrbSignalContext } | undefined;
  try {
    const signalResult = await getOrbSignalContext(sessionId);
    if (signalResult) {
      signalContext = signalResult;

      // Inject signal context into instruction
      // Position after memory context but before closing
      instruction = `${instruction}

${signalResult.context}

Use these signals to adapt your response:
- If user appears stressed/overwhelmed: Use calming tone, simplify explanations
- If user appears frustrated: Be patient, acknowledge their concern, focus on solutions
- If user appears fatigued: Be concise, offer to continue later if needed
- If urgency is detected: Address the urgent need first
- If hesitation is detected: Ask clarifying questions, offer options
- IMPORTANT: Never mention these signals directly to the user`;
    }
  } catch (err) {
    console.warn('[VTID-01120] Signal context fetch failed (non-fatal):', err);
    // Continue without signal context - graceful degradation
  }

  // VTID-01135: Get D41 boundary/consent context
  let boundaryContext: { context: string; orbContext: OrbBoundaryContext } | undefined;
  try {
    // Convert OrbSignalContext to Record<string, unknown> for compatibility
    const emotionalSignals = signalContext?.orbContext
      ? { ...signalContext.orbContext } as Record<string, unknown>
      : undefined;
    const boundaryResult = await getOrbBoundaryContext(
      undefined, // authToken - uses dev identity in sandbox
      emotionalSignals // Pass emotional signals for vulnerability detection
    );
    if (boundaryResult) {
      boundaryContext = boundaryResult;

      // Inject boundary context into instruction
      instruction = `${instruction}

${boundaryResult.context}

BOUNDARY ENFORCEMENT RULES (Non-Negotiable):
- If monetization is suppressed: Do NOT suggest products, services, or paid recommendations
- If social introductions are suppressed: Do NOT suggest meeting new people or joining groups
- If proactive nudges are suppressed: Only respond to what the user explicitly asks
- Blocked topics listed above MUST NEVER be discussed, even if user asks
- For topics requiring consent: Ask permission before proceeding
- When in doubt, choose the more protective response
- NEVER argue with or question the user's boundaries`;

      console.log(`[VTID-01135] D41 boundary context injected: privacy=${boundaryResult.orbContext.privacy_level}, suppressions=${
        [boundaryResult.orbContext.suppress_monetization && 'monetization',
         boundaryResult.orbContext.suppress_social && 'social',
         boundaryResult.orbContext.suppress_proactive && 'proactive'].filter(Boolean).join(',') || 'none'
      }`);
    }
  } catch (err) {
    console.warn('[VTID-01135] Boundary context fetch failed (non-fatal):', err);
    // Continue without boundary context - graceful degradation
  }

  return { instruction, memoryContext, signalContext, boundaryContext };
}

/**
 * VTID-01120 + VTID-01135: Process user message and get enhanced instruction context
 *
 * Convenience function that:
 * 1. Computes D28 signals from the incoming message
 * 2. Fetches memory context
 * 3. Fetches D41 boundary/consent context
 * 4. Builds fully enhanced instruction
 *
 * @param baseInstruction - The base system instruction
 * @param userMessage - The user's incoming message
 * @param sessionId - Optional session ID
 * @param turnId - Optional turn ID
 * @param responseTimeSeconds - Optional time since last interaction
 * @returns Enhanced instruction with computed signals, memory, and boundaries
 */
export async function processAndEnhanceInstruction(
  baseInstruction: string,
  userMessage: string,
  sessionId?: string,
  turnId?: string,
  responseTimeSeconds?: number
): Promise<OrbEnhancedContext> {
  // Get memory context
  const memoryContext = await fetchDevMemoryContext();
  let instruction = buildMemoryEnhancedInstruction(baseInstruction, memoryContext);

  // Process message through D28 engine to compute signals
  let signalContext: { context: string; orbContext: OrbSignalContext } | undefined;
  try {
    const signalResult = await processMessageForOrb(
      userMessage,
      sessionId,
      turnId,
      responseTimeSeconds
    );

    if (signalResult) {
      signalContext = {
        context: signalResult.context,
        orbContext: signalResult.orbContext
      };

      // Inject signal context into instruction
      instruction = `${instruction}

${signalResult.context}

Use these signals to adapt your response:
- If user appears stressed/overwhelmed: Use calming tone, simplify explanations
- If user appears frustrated: Be patient, acknowledge their concern, focus on solutions
- If user appears fatigued: Be concise, offer to continue later if needed
- If urgency is detected: Address the urgent need first
- If hesitation is detected: Ask clarifying questions, offer options
- IMPORTANT: Never mention these signals directly to the user`;

      console.log(`[VTID-01120] D28 signals computed: engagement=${signalResult.orbContext.engagement_level}, urgent=${signalResult.orbContext.is_urgent}`);
    }
  } catch (err) {
    console.warn('[VTID-01120] Signal computation failed (non-fatal):', err);
    // Continue without signal context - graceful degradation
  }

  // VTID-01135: Get D41 boundary/consent context
  let boundaryContext: { context: string; orbContext: OrbBoundaryContext } | undefined;
  try {
    // Convert OrbSignalContext to Record<string, unknown> for compatibility
    const emotionalSignals = signalContext?.orbContext
      ? { ...signalContext.orbContext } as Record<string, unknown>
      : undefined;
    const boundaryResult = await getOrbBoundaryContext(
      undefined, // authToken - uses dev identity in sandbox
      emotionalSignals // Pass emotional signals for vulnerability detection
    );
    if (boundaryResult) {
      boundaryContext = boundaryResult;

      // Inject boundary context into instruction
      instruction = `${instruction}

${boundaryResult.context}

BOUNDARY ENFORCEMENT RULES (Non-Negotiable):
- If monetization is suppressed: Do NOT suggest products, services, or paid recommendations
- If social introductions are suppressed: Do NOT suggest meeting new people or joining groups
- If proactive nudges are suppressed: Only respond to what the user explicitly asks
- Blocked topics listed above MUST NEVER be discussed, even if user asks
- For topics requiring consent: Ask permission before proceeding
- When in doubt, choose the more protective response
- NEVER argue with or question the user's boundaries`;

      console.log(`[VTID-01135] D41 boundary context injected for message processing`);
    }
  } catch (err) {
    console.warn('[VTID-01135] Boundary context fetch failed (non-fatal):', err);
    // Continue without boundary context - graceful degradation
  }

  return { instruction, memoryContext, signalContext, boundaryContext };
}

// =============================================================================
// VTID-01106 + VTID-01115 + VTID-01117 + VTID-01120 + VTID-01121 + VTID-01135: Exports
// Note: shouldStoreInMemory, resetMemoryBridgeCache already exported inline
// Note: fetchScoredMemoryContext, ScoredOrbMemoryContext exported inline
// VTID-01117: Added context window manager exports
// VTID-01135: Added D41 boundary context exports
// =============================================================================

export {
  MEMORY_CONFIG,
  formatMemoryForPrompt,
  generateMemorySummary,
  getOrbSignalContext,
  processMessageForOrb,
  getOrbBoundaryContext
};

// Re-export scoring types for consumers (VTID-01115)
export type {
  ScoringContext,
  ScoredMemoryItem,
  ScoringMetadata,
  RetrieveIntent,
  Domain,
  UserRole
} from './memory-relevance-scoring';

export type { OrbSignalContext };
export type { OrbBoundaryContext };

// VTID-01117: Re-export context window manager for direct access
export {
  ContextWindowManager,
  selectContextWindow,
  formatSelectionDebug
} from './context-window-manager';
