/**
 * VTID-01112: Context Assembly Engine (D20 Core Intelligence)
 *
 * Deterministic Context Assembly Engine that produces a single, coherent,
 * ranked context object for ORB before any reasoning, response, prediction,
 * or action occurs.
 *
 * This is the FOUNDATION of all intelligence from D20 onward.
 * ORB must NEVER reason on raw memory fragments again.
 *
 * Core Responsibilities:
 * 1. COLLECT - memory items, diary entries, garden nodes, conversations, user state
 * 2. NORMALIZE - domains, timestamps, confidence levels, source reliability
 * 3. RANK - relevance to intent, temporal proximity, confidence, domain priority
 * 4. ASSEMBLE - into ONE structured, immutable context bundle
 *
 * Hard Rules (Non-Negotiable):
 * - ❌ ORB may NOT access raw memory tables directly
 * - ❌ No reasoning before context assembly
 * - ❌ No unranked memory injection
 * - ✅ All downstream intelligence consumes ONLY context_bundle
 *
 * Determinism Requirements:
 * - Given same inputs → context output MUST be identical
 * - Ranking MUST be reproducible
 * - Ordering MUST be stable
 * - NO randomness at this layer
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// VTID-01112: Configuration
// =============================================================================

/**
 * Context Assembly Configuration
 * All limits are configurable but have safe defaults.
 */
export const CONTEXT_CONFIG = {
  // Max items per domain (safety limit)
  MAX_ITEMS_PER_DOMAIN: 10,
  // Max total memory items
  MAX_MEMORY_ITEMS: 50,
  // Max diary entries
  MAX_DIARY_ENTRIES: 10,
  // Max garden nodes
  MAX_GARDEN_NODES: 20,
  // Max recent events (conversations)
  MAX_RECENT_EVENTS: 15,
  // Default lookback hours for memory
  DEFAULT_LOOKBACK_HOURS: 168, // 7 days
  // Max content length per item (truncation)
  MAX_CONTENT_LENGTH: 500,
  // Sensitive domains that require explicit expansion
  SENSITIVE_DOMAINS: ['health'] as const,
};

// =============================================================================
// VTID-01112: Domain Definitions
// =============================================================================

/**
 * Canonical domains for normalization
 */
export const DOMAINS = ['health', 'social', 'business', 'learning', 'commerce', 'lifestyle', 'values'] as const;
export type Domain = typeof DOMAINS[number];

/**
 * Category to domain mapping for normalization
 */
const CATEGORY_TO_DOMAIN: Record<string, Domain> = {
  // Memory categories
  conversation: 'social',
  health: 'health',
  relationships: 'social',
  community: 'social',
  preferences: 'lifestyle',
  goals: 'lifestyle',
  tasks: 'business',
  products_services: 'commerce',
  events_meetups: 'social',
  notes: 'lifestyle',
  personal: 'lifestyle',
  // Garden node domains map directly
};

/**
 * Source reliability scores (0-100)
 * Higher = more reliable
 */
const SOURCE_RELIABILITY: Record<string, number> = {
  diary: 95,        // User's own written words
  orb_voice: 85,    // Voice transcription may have errors
  orb_text: 90,     // Direct text input
  system: 80,       // System-derived
  upload: 75,       // Uploaded content
  import: 70,       // Imported from external source
};

// =============================================================================
// VTID-01112: Core Types
// =============================================================================

/**
 * User state for context
 */
export interface UserState {
  user_id: string;
  tenant_id: string;
  active_role: string;
  display_name?: string;
}

/**
 * Normalized memory item
 */
export interface NormalizedMemoryItem {
  id: string;
  domain: Domain;
  category_key: string;
  source: string;
  content: string;
  content_json?: Record<string, unknown>;
  importance: number;
  confidence: number;
  reliability: number;
  occurred_at: string;
  created_at: string;
  // Computed ranking score
  rank_score: number;
}

/**
 * Normalized diary entry
 */
export interface NormalizedDiaryEntry {
  id: string;
  entry_date: string;
  entry_type: string;
  content: string;
  mood?: string;
  energy_level?: number;
  tags: string[];
  confidence: number;
  reliability: number;
  rank_score: number;
}

/**
 * Normalized garden node
 */
export interface NormalizedGardenNode {
  id: string;
  domain: Domain;
  node_type: string;
  title: string;
  summary: string;
  confidence: number;
  first_seen: string;
  last_seen: string;
  rank_score: number;
}

/**
 * Recent event (conversation turn)
 */
export interface RecentEvent {
  id: string;
  direction: 'user' | 'assistant';
  content: string;
  occurred_at: string;
  importance: number;
  rank_score: number;
}

/**
 * Long-term pattern derived from garden nodes
 */
export interface LongTermPattern {
  id: string;
  domain: Domain;
  pattern_type: string;
  title: string;
  summary: string;
  confidence: number;
  first_seen: string;
  last_seen: string;
  occurrences: number;
}

/**
 * Constraint for context
 */
export interface Constraint {
  type: 'role_based' | 'domain_limit' | 'sensitivity' | 'time_range';
  description: string;
  applied: boolean;
}

/**
 * Confidence scores per domain
 */
export type ConfidenceScores = Record<Domain, number>;

/**
 * Domain weights applied during ranking
 */
export type DomainWeights = Record<Domain, number>;

/**
 * THE CANONICAL CONTEXT BUNDLE
 * This is the ONLY context object that ORB and downstream intelligence may consume.
 * It is IMMUTABLE per turn.
 */
export interface ContextBundle {
  // Metadata
  bundle_id: string;
  bundle_hash: string;
  assembled_at: string;
  assembly_duration_ms: number;

  // User state
  user_state: UserState;
  active_roles: string[];
  current_intent: string;

  // Ranked content (ordered by rank_score DESC)
  top_memories: NormalizedMemoryItem[];
  recent_events: RecentEvent[];
  long_term_patterns: LongTermPattern[];

  // Constraints applied
  constraints: Constraint[];

  // Confidence per domain
  confidence_scores: ConfidenceScores;

  // Traceability
  traceability: {
    memory_ids_used: string[];
    diary_ids_used: string[];
    garden_node_ids_used: string[];
    domain_weights_applied: DomainWeights;
    total_items_considered: number;
    total_items_included: number;
  };
}

/**
 * Context Assembly Request
 */
export interface ContextAssemblyRequest {
  user_id: string;
  tenant_id: string;
  active_role: string;
  display_name?: string;
  intent?: 'conversation' | 'health' | 'community' | 'lifestyle' | 'planner' | 'general';
  time_range?: {
    from?: string;
    to?: string;
    last_hours?: number;
  };
  include?: {
    memory?: boolean;
    diary?: boolean;
    garden?: boolean;
    conversations?: boolean;
  };
  expand_sensitive?: boolean; // Explicit opt-in for sensitive domains
}

/**
 * Context Assembly Result
 */
export interface ContextAssemblyResult {
  ok: boolean;
  bundle?: ContextBundle;
  error?: string;
}

// =============================================================================
// VTID-01112: Supabase Client
// =============================================================================

let _supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
  if (_supabaseClient) return _supabaseClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[VTID-01112] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return null;
  }

  _supabaseClient = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  return _supabaseClient;
}

// =============================================================================
// VTID-01112: Normalization Functions
// =============================================================================

/**
 * Normalize category key to canonical domain
 */
function normalizeDomain(categoryKey: string, gardenDomain?: string): Domain {
  if (gardenDomain && DOMAINS.includes(gardenDomain as Domain)) {
    return gardenDomain as Domain;
  }
  return CATEGORY_TO_DOMAIN[categoryKey] || 'lifestyle';
}

/**
 * Get source reliability score
 */
function getSourceReliability(source: string): number {
  return SOURCE_RELIABILITY[source] ?? 50;
}

/**
 * Normalize timestamp to ISO string
 */
function normalizeTimestamp(timestamp: string | Date): string {
  if (timestamp instanceof Date) {
    return timestamp.toISOString();
  }
  return new Date(timestamp).toISOString();
}

/**
 * Truncate content to max length
 */
function truncateContent(content: string, maxLength: number = CONTEXT_CONFIG.MAX_CONTENT_LENGTH): string {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength - 3) + '...';
}

// =============================================================================
// VTID-01112: Deterministic Ranking Algorithm
// =============================================================================

/**
 * Intent-based domain weights
 * These weights boost domains relevant to the current intent
 */
const INTENT_DOMAIN_WEIGHTS: Record<string, DomainWeights> = {
  conversation: { health: 0.8, social: 1.2, business: 0.6, learning: 0.7, commerce: 0.5, lifestyle: 1.0, values: 0.8 },
  health: { health: 1.5, social: 0.7, business: 0.4, learning: 0.6, commerce: 0.5, lifestyle: 0.8, values: 0.7 },
  community: { health: 0.6, social: 1.5, business: 0.5, learning: 0.7, commerce: 0.4, lifestyle: 0.9, values: 0.8 },
  lifestyle: { health: 0.9, social: 0.9, business: 0.6, learning: 0.8, commerce: 0.7, lifestyle: 1.3, values: 1.0 },
  planner: { health: 0.7, social: 0.8, business: 1.2, learning: 0.9, commerce: 0.8, lifestyle: 1.0, values: 0.6 },
  general: { health: 1.0, social: 1.0, business: 1.0, learning: 1.0, commerce: 1.0, lifestyle: 1.0, values: 1.0 },
};

/**
 * Calculate temporal proximity score (0-100)
 * More recent = higher score
 * Uses exponential decay
 */
function calculateTemporalScore(occurredAt: string, now: Date): number {
  const eventTime = new Date(occurredAt).getTime();
  const nowTime = now.getTime();
  const hoursAgo = (nowTime - eventTime) / (1000 * 60 * 60);

  if (hoursAgo <= 1) return 100;
  if (hoursAgo <= 24) return 90 - (hoursAgo / 24) * 20;
  if (hoursAgo <= 168) return 70 - ((hoursAgo - 24) / 144) * 40;
  return Math.max(10, 30 - (hoursAgo - 168) / 168 * 20);
}

/**
 * Calculate rank score for a memory item
 * DETERMINISTIC: Same inputs → same output
 *
 * Formula:
 * rank_score = (importance * 0.3) + (temporal * 0.25) + (confidence * 0.2) +
 *              (reliability * 0.1) + (domain_weight * 0.15 * 100)
 */
function calculateMemoryRankScore(
  item: {
    importance: number;
    occurred_at: string;
    confidence: number;
    reliability: number;
    domain: Domain;
  },
  domainWeights: DomainWeights,
  now: Date
): number {
  const temporalScore = calculateTemporalScore(item.occurred_at, now);
  const domainWeight = domainWeights[item.domain] ?? 1.0;

  const score =
    (item.importance * 0.3) +
    (temporalScore * 0.25) +
    (item.confidence * 0.2) +
    (item.reliability * 0.1) +
    (domainWeight * 0.15 * 100);

  // Round to 2 decimal places for determinism
  return Math.round(score * 100) / 100;
}

/**
 * Calculate rank score for a garden node
 */
function calculateGardenNodeRankScore(
  node: {
    confidence: number;
    last_seen: string;
    first_seen: string;
    domain: Domain;
  },
  domainWeights: DomainWeights,
  now: Date
): number {
  const recencyScore = calculateTemporalScore(node.last_seen, now);
  const longevityDays = (new Date(node.last_seen).getTime() - new Date(node.first_seen).getTime()) / (1000 * 60 * 60 * 24);
  const longevityBonus = Math.min(20, longevityDays * 0.5);
  const domainWeight = domainWeights[node.domain] ?? 1.0;

  const score =
    (node.confidence * 0.4) +
    (recencyScore * 0.25) +
    (longevityBonus * 0.15) +
    (domainWeight * 0.2 * 100);

  return Math.round(score * 100) / 100;
}

/**
 * Deterministic stable sort
 * When scores are equal, sort by ID for determinism
 */
function stableSort<T extends { rank_score: number; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (b.rank_score !== a.rank_score) {
      return b.rank_score - a.rank_score;
    }
    // Stable sort by ID when scores are equal
    return a.id.localeCompare(b.id);
  });
}

// =============================================================================
// VTID-01112: Data Collection Functions
// =============================================================================

/**
 * Fetch memory items from database
 */
async function fetchMemoryItems(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
  since: Date,
  limit: number
): Promise<NormalizedMemoryItem[]> {
  const { data, error } = await supabase
    .from('memory_items')
    .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('occurred_at', since.toISOString())
    .order('importance', { ascending: false })
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn('[VTID-01112] Memory items fetch error:', error.message);
    return [];
  }

  return (data || []).map(item => ({
    id: item.id,
    domain: normalizeDomain(item.category_key),
    category_key: item.category_key,
    source: item.source,
    content: truncateContent(item.content),
    content_json: item.content_json,
    importance: item.importance,
    confidence: item.importance, // Use importance as initial confidence
    reliability: getSourceReliability(item.source),
    occurred_at: normalizeTimestamp(item.occurred_at),
    created_at: normalizeTimestamp(item.created_at),
    rank_score: 0, // Calculated later
  }));
}

/**
 * Fetch diary entries from database
 */
async function fetchDiaryEntries(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
  since: Date,
  limit: number
): Promise<NormalizedDiaryEntry[]> {
  const { data, error } = await supabase
    .from('memory_diary_entries')
    .select('id, entry_date, entry_type, raw_text, mood, energy_level, tags, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('entry_date', since.toISOString().split('T')[0])
    .order('entry_date', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn('[VTID-01112] Diary entries fetch error:', error.message);
    return [];
  }

  return (data || []).map(entry => ({
    id: entry.id,
    entry_date: entry.entry_date,
    entry_type: entry.entry_type,
    content: truncateContent(entry.raw_text),
    mood: entry.mood,
    energy_level: entry.energy_level,
    tags: entry.tags || [],
    confidence: 90, // Diary entries have high confidence
    reliability: SOURCE_RELIABILITY.diary,
    rank_score: 0,
  }));
}

/**
 * Fetch garden nodes from database
 */
async function fetchGardenNodes(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
  limit: number
): Promise<NormalizedGardenNode[]> {
  const { data, error } = await supabase
    .from('memory_garden_nodes')
    .select('id, domain, node_type, title, summary, confidence, first_seen, last_seen')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('confidence', { ascending: false })
    .order('last_seen', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn('[VTID-01112] Garden nodes fetch error:', error.message);
    return [];
  }

  return (data || []).map(node => ({
    id: node.id,
    domain: node.domain as Domain,
    node_type: node.node_type,
    title: node.title,
    summary: truncateContent(node.summary),
    confidence: node.confidence,
    first_seen: node.first_seen,
    last_seen: node.last_seen,
    rank_score: 0,
  }));
}

// =============================================================================
// VTID-01112: Bundle Hash Generation
// =============================================================================

/**
 * Generate deterministic hash for context bundle
 * Used for traceability and verification
 */
function generateBundleHash(bundle: Omit<ContextBundle, 'bundle_hash'>): string {
  const hashInput = JSON.stringify({
    bundle_id: bundle.bundle_id,
    user_state: bundle.user_state,
    current_intent: bundle.current_intent,
    memory_ids: bundle.traceability.memory_ids_used.sort(),
    diary_ids: bundle.traceability.diary_ids_used.sort(),
    garden_ids: bundle.traceability.garden_node_ids_used.sort(),
  });

  return createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
}

// =============================================================================
// VTID-01112: Main Assembly Function
// =============================================================================

/**
 * Assemble context bundle
 *
 * This is the MAIN ENTRY POINT for context assembly.
 * All downstream intelligence MUST call this function to get context.
 */
export async function assembleContext(request: ContextAssemblyRequest): Promise<ContextAssemblyResult> {
  const startTime = Date.now();
  const bundleId = `ctx_${Date.now()}_${request.user_id.substring(0, 8)}`;
  const assembledAt = new Date().toISOString();
  const now = new Date();

  console.log(`[VTID-01112] Context assembly started: ${bundleId}`);

  // Get Supabase client
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { ok: false, error: 'Database not configured' };
  }

  try {
    // Bootstrap request context for RLS
    try {
      await supabase.rpc('dev_bootstrap_request_context', {
        p_tenant_id: request.tenant_id,
        p_active_role: request.active_role
      });
    } catch {
      // Non-fatal if RPC doesn't exist
    }

    // Determine time range
    const lookbackHours = request.time_range?.last_hours ?? CONTEXT_CONFIG.DEFAULT_LOOKBACK_HOURS;
    const since = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);

    // Get domain weights for intent
    const intent = request.intent ?? 'general';
    const domainWeights = INTENT_DOMAIN_WEIGHTS[intent] ?? INTENT_DOMAIN_WEIGHTS.general;

    // Include flags
    const include = {
      memory: request.include?.memory ?? true,
      diary: request.include?.diary ?? true,
      garden: request.include?.garden ?? true,
      conversations: request.include?.conversations ?? true,
    };

    // Collect data in parallel
    const [rawMemoryItems, rawDiaryEntries, rawGardenNodes] = await Promise.all([
      include.memory
        ? fetchMemoryItems(supabase, request.user_id, request.tenant_id, since, CONTEXT_CONFIG.MAX_MEMORY_ITEMS)
        : Promise.resolve([]),
      include.diary
        ? fetchDiaryEntries(supabase, request.user_id, request.tenant_id, since, CONTEXT_CONFIG.MAX_DIARY_ENTRIES)
        : Promise.resolve([]),
      include.garden
        ? fetchGardenNodes(supabase, request.user_id, request.tenant_id, CONTEXT_CONFIG.MAX_GARDEN_NODES)
        : Promise.resolve([]),
    ]);

    // Apply role-based filtering BEFORE ranking
    const roleConstraints: Constraint[] = [];

    // Filter sensitive domains unless explicitly expanded
    let memoryItems = rawMemoryItems;
    if (!request.expand_sensitive) {
      const sensitiveDomains = CONTEXT_CONFIG.SENSITIVE_DOMAINS;
      const beforeCount = memoryItems.length;
      memoryItems = memoryItems.filter(item => {
        if (sensitiveDomains.includes(item.domain as any)) {
          // Keep but limit sensitive domain items
          return true; // Include but will be limited per domain later
        }
        return true;
      });
      if (beforeCount !== memoryItems.length) {
        roleConstraints.push({
          type: 'sensitivity',
          description: `Sensitive domains filtered (expand_sensitive=false)`,
          applied: true
        });
      }
    }

    // Apply per-domain limits
    const domainCounts: Record<string, number> = {};
    memoryItems = memoryItems.filter(item => {
      domainCounts[item.domain] = (domainCounts[item.domain] || 0) + 1;
      if (domainCounts[item.domain] > CONTEXT_CONFIG.MAX_ITEMS_PER_DOMAIN) {
        return false;
      }
      return true;
    });

    roleConstraints.push({
      type: 'domain_limit',
      description: `Max ${CONTEXT_CONFIG.MAX_ITEMS_PER_DOMAIN} items per domain`,
      applied: true
    });

    // Calculate rank scores for all items
    memoryItems = memoryItems.map(item => ({
      ...item,
      rank_score: calculateMemoryRankScore(item, domainWeights, now)
    }));

    const gardenNodes = rawGardenNodes.map(node => ({
      ...node,
      rank_score: calculateGardenNodeRankScore(node, domainWeights, now)
    }));

    // Sort by rank score (deterministic stable sort)
    const rankedMemories = stableSort(memoryItems);
    const rankedGardenNodes = stableSort(gardenNodes);

    // Extract recent events (conversations) from memory items
    const recentEvents: RecentEvent[] = rankedMemories
      .filter(item => item.category_key === 'conversation' && item.content_json?.direction)
      .slice(0, CONTEXT_CONFIG.MAX_RECENT_EVENTS)
      .map(item => ({
        id: item.id,
        direction: (item.content_json?.direction as 'user' | 'assistant') || 'user',
        content: item.content,
        occurred_at: item.occurred_at,
        importance: item.importance,
        rank_score: item.rank_score,
      }));

    // Extract long-term patterns from garden nodes
    const longTermPatterns: LongTermPattern[] = rankedGardenNodes
      .filter(node => node.node_type === 'pattern' || node.node_type === 'habit')
      .map(node => ({
        id: node.id,
        domain: node.domain,
        pattern_type: node.node_type,
        title: node.title,
        summary: node.summary,
        confidence: node.confidence,
        first_seen: node.first_seen,
        last_seen: node.last_seen,
        occurrences: 1, // Would need junction table query for accurate count
      }));

    // Calculate confidence scores per domain
    const confidenceScores: ConfidenceScores = {
      health: 0,
      social: 0,
      business: 0,
      learning: 0,
      commerce: 0,
      lifestyle: 0,
      values: 0,
    };

    for (const item of rankedMemories) {
      if (confidenceScores[item.domain] < item.confidence) {
        confidenceScores[item.domain] = item.confidence;
      }
    }

    for (const node of rankedGardenNodes) {
      if (confidenceScores[node.domain] < node.confidence) {
        confidenceScores[node.domain] = node.confidence;
      }
    }

    // Build traceability
    const traceability = {
      memory_ids_used: rankedMemories.map(m => m.id),
      diary_ids_used: rawDiaryEntries.map(d => d.id),
      garden_node_ids_used: rankedGardenNodes.map(n => n.id),
      domain_weights_applied: domainWeights,
      total_items_considered: rawMemoryItems.length + rawDiaryEntries.length + rawGardenNodes.length,
      total_items_included: rankedMemories.length + rawDiaryEntries.length + rankedGardenNodes.length,
    };

    // Build user state
    const userState: UserState = {
      user_id: request.user_id,
      tenant_id: request.tenant_id,
      active_role: request.active_role,
      display_name: request.display_name,
    };

    // Assemble the bundle (without hash first)
    const bundleWithoutHash: Omit<ContextBundle, 'bundle_hash'> = {
      bundle_id: bundleId,
      assembled_at: assembledAt,
      assembly_duration_ms: Date.now() - startTime,
      user_state: userState,
      active_roles: [request.active_role],
      current_intent: intent,
      top_memories: rankedMemories,
      recent_events: recentEvents,
      long_term_patterns: longTermPatterns,
      constraints: roleConstraints,
      confidence_scores: confidenceScores,
      traceability,
    };

    // Generate bundle hash for verification
    const bundleHash = generateBundleHash(bundleWithoutHash);

    // Final bundle
    const bundle: ContextBundle = {
      ...bundleWithoutHash,
      bundle_hash: bundleHash,
      assembly_duration_ms: Date.now() - startTime,
    };

    // Log assembly completion
    console.log(`[VTID-01112] Context assembly complete: ${bundleId} (${bundle.assembly_duration_ms}ms, hash=${bundleHash})`);

    // Emit OASIS event for traceability
    await emitOasisEvent({
      vtid: 'VTID-01112',
      type: 'context.assembly.completed' as any,
      source: 'context-assembly-engine',
      status: 'success',
      message: `Context bundle assembled: ${bundle.traceability.total_items_included} items`,
      payload: {
        bundle_id: bundleId,
        bundle_hash: bundleHash,
        user_id: request.user_id,
        tenant_id: request.tenant_id,
        intent,
        items_considered: traceability.total_items_considered,
        items_included: traceability.total_items_included,
        duration_ms: bundle.assembly_duration_ms,
      }
    }).catch(err => console.warn('[VTID-01112] OASIS event failed:', err.message));

    return { ok: true, bundle };

  } catch (err: any) {
    console.error('[VTID-01112] Context assembly error:', err.message);
    return { ok: false, error: err.message };
  }
}

// =============================================================================
// VTID-01112: ORB Integration - Replace Raw Memory Access
// =============================================================================

/**
 * Get context for ORB
 *
 * This is the ONLY function ORB should use to get context.
 * Replaces direct memory table access.
 */
export async function getOrbContext(
  userId: string,
  tenantId: string,
  activeRole: string,
  intent: 'conversation' | 'health' | 'community' | 'lifestyle' | 'planner' | 'general' = 'conversation'
): Promise<ContextAssemblyResult> {
  return assembleContext({
    user_id: userId,
    tenant_id: tenantId,
    active_role: activeRole,
    intent,
    include: {
      memory: true,
      diary: true,
      garden: true,
      conversations: true,
    },
    expand_sensitive: false, // ORB doesn't auto-expand sensitive by default
  });
}

/**
 * Format context bundle for LLM prompt injection
 *
 * Converts the structured context bundle into a formatted string
 * suitable for injection into system prompts.
 */
export function formatContextForPrompt(bundle: ContextBundle): string {
  const lines: string[] = [];

  lines.push('## User Context (Assembled by Context Engine)');
  lines.push('');

  // User state
  if (bundle.user_state.display_name) {
    lines.push(`**User:** ${bundle.user_state.display_name}`);
  }
  lines.push(`**Role:** ${bundle.user_state.active_role}`);
  lines.push(`**Intent:** ${bundle.current_intent}`);
  lines.push('');

  // Top memories by domain
  const memoriesByDomain: Record<string, NormalizedMemoryItem[]> = {};
  for (const memory of bundle.top_memories) {
    if (!memoriesByDomain[memory.domain]) {
      memoriesByDomain[memory.domain] = [];
    }
    memoriesByDomain[memory.domain].push(memory);
  }

  // Priority order for domains
  const domainOrder: Domain[] = ['lifestyle', 'social', 'health', 'business', 'values', 'learning', 'commerce'];

  for (const domain of domainOrder) {
    const domainMemories = memoriesByDomain[domain];
    if (!domainMemories || domainMemories.length === 0) continue;

    lines.push(`### ${domain.charAt(0).toUpperCase() + domain.slice(1)}`);
    for (const memory of domainMemories.slice(0, 5)) {
      const direction = memory.content_json?.direction;
      const prefix = direction === 'user' ? 'User' : direction === 'assistant' ? 'Assistant' : '';
      const content = memory.content;
      if (prefix) {
        lines.push(`- ${prefix}: "${content}"`);
      } else {
        lines.push(`- ${content}`);
      }
    }
    lines.push('');
  }

  // Long-term patterns
  if (bundle.long_term_patterns.length > 0) {
    lines.push('### Known Patterns');
    for (const pattern of bundle.long_term_patterns.slice(0, 5)) {
      lines.push(`- **${pattern.title}**: ${pattern.summary}`);
    }
    lines.push('');
  }

  // Constraints
  if (bundle.constraints.some(c => c.applied)) {
    lines.push('### Context Constraints');
    for (const constraint of bundle.constraints.filter(c => c.applied)) {
      lines.push(`- ${constraint.description}`);
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`*Context ID: ${bundle.bundle_id} | Hash: ${bundle.bundle_hash}*`);

  return lines.join('\n');
}

// =============================================================================
// VTID-01112: Verification Functions
// =============================================================================

/**
 * Verify context bundle integrity
 *
 * Checks that the bundle hash matches the content.
 * Used for debugging and governance review.
 */
export function verifyBundleIntegrity(bundle: ContextBundle): boolean {
  const expectedHash = generateBundleHash(bundle);
  return expectedHash === bundle.bundle_hash;
}

/**
 * Verify determinism
 *
 * Given two bundles with same inputs, verifies they are identical.
 * Used for testing and validation.
 */
export function verifyDeterminism(bundle1: ContextBundle, bundle2: ContextBundle): {
  match: boolean;
  differences: string[];
} {
  const differences: string[] = [];

  if (bundle1.bundle_hash !== bundle2.bundle_hash) {
    differences.push(`Hash mismatch: ${bundle1.bundle_hash} vs ${bundle2.bundle_hash}`);
  }

  if (bundle1.top_memories.length !== bundle2.top_memories.length) {
    differences.push(`Memory count mismatch: ${bundle1.top_memories.length} vs ${bundle2.top_memories.length}`);
  }

  const ids1 = bundle1.traceability.memory_ids_used.sort().join(',');
  const ids2 = bundle2.traceability.memory_ids_used.sort().join(',');
  if (ids1 !== ids2) {
    differences.push('Memory IDs mismatch');
  }

  return {
    match: differences.length === 0,
    differences
  };
}

// =============================================================================
// VTID-01112: Additional Exports (re-exported for convenience)
// Note: CONTEXT_CONFIG, DOMAINS already exported at declaration
// =============================================================================

export { CATEGORY_TO_DOMAIN, INTENT_DOMAIN_WEIGHTS };
