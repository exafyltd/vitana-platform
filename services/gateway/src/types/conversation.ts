/**
 * VTID-01216: Unified Conversation Intelligence Layer Types
 *
 * Shared types for the unified conversation API that both ORB and Operator Console use.
 * This layer provides identical intelligence, memory usage, knowledge access, and tool behavior
 * across both surfaces.
 *
 * Surfaces:
 * - ORB: Voice-first interaction
 * - Operator: Text-first + professional decision screens
 */

import { z } from 'zod';
import { ContextLens } from './context-lens';

// =============================================================================
// Channel & Surface Types
// =============================================================================

/**
 * Conversation channels - where the message originates
 */
export const CONVERSATION_CHANNELS = ['orb', 'operator'] as const;
export type ConversationChannel = typeof CONVERSATION_CHANNELS[number];

/**
 * Message types
 */
export const MESSAGE_TYPES = ['text', 'voice_transcript'] as const;
export type MessageType = typeof MESSAGE_TYPES[number];

// =============================================================================
// Conversation Turn Request
// =============================================================================

/**
 * UI context for surface-specific behavior
 */
export interface UIContext {
  /** Which surface sent this message */
  surface: ConversationChannel;
  /** Current screen/view (optional) */
  screen?: string;
  /** Any selected item (optional) */
  selection?: string;
  /** Additional surface-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Conversation turn request schema
 */
export const ConversationTurnRequestSchema = z.object({
  /** Channel identifier */
  channel: z.enum(CONVERSATION_CHANNELS),

  /** Tenant ID for multi-tenancy isolation */
  tenant_id: z.string().uuid(),

  /** User ID for user-level access control */
  user_id: z.string().uuid(),

  /** User's active role */
  role: z.string().default('user'),

  /** Thread ID for conversation continuity */
  thread_id: z.string().uuid().optional(),

  /** The user's message */
  message: z.object({
    type: z.enum(MESSAGE_TYPES),
    text: z.string().min(1, 'Message text is required'),
  }),

  /** UI context for surface-specific behavior */
  ui_context: z.object({
    surface: z.enum(CONVERSATION_CHANNELS),
    screen: z.string().optional(),
    selection: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  }).optional(),

  /** Optional conversation ID for thread continuity */
  conversation_id: z.string().uuid().optional(),

  /** Optional VTID link */
  vtid: z.string().optional(),
});

export type ConversationTurnRequest = z.infer<typeof ConversationTurnRequestSchema>;

// =============================================================================
// Retrieval Router Types
// =============================================================================

/**
 * Retrieval sources available
 */
export const RETRIEVAL_SOURCES = ['memory_garden', 'knowledge_hub', 'web_search'] as const;
export type RetrievalSource = typeof RETRIEVAL_SOURCES[number];

/**
 * Routing rules for retrieval
 */
export interface RetrievalRoutingRule {
  /** Query patterns that trigger this rule */
  patterns: RegExp[];
  /** Primary source to query first */
  primary_source: RetrievalSource;
  /** Secondary sources to query if primary doesn't satisfy */
  secondary_sources: RetrievalSource[];
  /** Priority (higher = evaluated first) */
  priority: number;
}

/**
 * Retrieval router decision
 */
export interface RetrievalRouterDecision {
  /** Which sources to query */
  sources_to_query: RetrievalSource[];
  /** Order of querying */
  query_order: RetrievalSource[];
  /** Limits per source */
  limits: Record<RetrievalSource, number>;
  /** Rule that matched */
  matched_rule: string;
  /** Decision timestamp */
  decided_at: string;
  /** Decision rationale */
  rationale: string;
}

// =============================================================================
// Context Pack Types
// =============================================================================

/**
 * Memory hit from Memory Garden (D1-D63)
 */
export interface MemoryHit {
  id: string;
  category_key: string;
  content: string;
  importance: number;
  occurred_at: string;
  relevance_score: number;
  source: string;
}

/**
 * Knowledge hit from Vitana Knowledge Hub
 */
export interface KnowledgeHit {
  id: string;
  title: string;
  snippet: string;
  source_path: string;
  relevance_score: number;
}

/**
 * Web search hit with citation
 */
export interface WebHit {
  id: string;
  title: string;
  snippet: string;
  url: string;
  citation: string;
  relevance_score: number;
}

/**
 * Tool health status
 */
export interface ToolHealthStatus {
  name: string;
  available: boolean;
  latency_ms?: number;
  last_checked: string;
  error?: string;
}

/**
 * Active VTID context
 */
export interface ActiveVTID {
  vtid: string;
  title: string;
  status: string;
  priority?: string;
}

/**
 * Tenant policies affecting conversation
 */
export interface TenantPolicy {
  policy_id: string;
  type: string;
  value: unknown;
  enforced: boolean;
}

/**
 * The Context Pack - injected into LLM for every turn
 * Hard limit: ~15KB to prevent prompt bloat
 */
export interface ContextPack {
  /** Unique pack ID for traceability */
  pack_id: string;

  /** Pack hash for deduplication */
  pack_hash: string;

  /** When the pack was assembled */
  assembled_at: string;

  /** Assembly duration for telemetry */
  assembly_duration_ms: number;

  /** User identity context */
  identity: {
    tenant_id: string;
    user_id: string;
    role: string;
    display_name?: string;
  };

  /** Session state */
  session_state: {
    thread_id: string;
    channel: ConversationChannel;
    turn_number: number;
    conversation_start: string;
  };

  /** Memory hits from Memory Garden (5-12 max) */
  memory_hits: MemoryHit[];

  /** Knowledge hits from Vitana Knowledge Hub (0-8) */
  knowledge_hits: KnowledgeHit[];

  /** Web search hits with citations (0-6) */
  web_hits: WebHit[];

  /** Active VTIDs in context */
  active_vtids: ActiveVTID[];

  /** Tenant policies affecting this conversation */
  tenant_policies: TenantPolicy[];

  /** Tool health status */
  tool_health: ToolHealthStatus[];

  /** UI context from request */
  ui_context?: UIContext;

  /** Retrieval trace for debugging */
  retrieval_trace: {
    router_decision: RetrievalRouterDecision;
    sources_queried: RetrievalSource[];
    latencies: Record<RetrievalSource, number>;
    hit_counts: Record<RetrievalSource, number>;
  };

  /** Token budget tracking */
  token_budget: {
    total_budget: number;
    used: number;
    remaining: number;
  };
}

// =============================================================================
// Conversation Turn Response
// =============================================================================

/**
 * Tool call made during response generation
 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  duration_ms: number;
  result: unknown;
  success: boolean;
  error?: string;
}

/**
 * Conversation turn response
 */
export interface ConversationTurnResponse {
  ok: boolean;

  /** The assistant's reply */
  reply: string;

  /** Thread ID for conversation continuity */
  thread_id: string;

  /** Turn metadata */
  meta: {
    channel: ConversationChannel;
    turn_number: number;
    model_used: string;
    latency_ms: number;
    tokens_used?: {
      prompt: number;
      completion: number;
      total: number;
    };
  };

  /** Context Pack used (for Operator visibility) */
  context_pack?: ContextPack;

  /** Tool calls made (for Operator visibility) */
  tool_calls?: ToolCall[];

  /** OASIS reference for audit trail */
  oasis_ref: string;

  /** Error details if ok=false */
  error?: string;
}

// =============================================================================
// Tool Registry Types
// =============================================================================

/**
 * Tool definition for registry
 */
export interface ToolDefinition {
  /** Unique tool name */
  name: string;

  /** Human-readable description */
  description: string;

  /** JSON Schema for parameters */
  parameters_schema: Record<string, unknown>;

  /** Roles allowed to use this tool */
  allowed_roles: string[];

  /** Whether the tool is currently enabled */
  enabled: boolean;

  /** Tool category */
  category: 'autopilot' | 'knowledge' | 'memory' | 'system' | 'custom';

  /** Average latency in ms */
  avg_latency_ms?: number;

  /** VTID that defines this tool */
  vtid?: string;
}

/**
 * Tool registry response
 */
export interface ToolRegistryResponse {
  ok: boolean;
  tools: ToolDefinition[];
  total_count: number;
  enabled_count: number;
  timestamp: string;
}

/**
 * Tool health response
 */
export interface ToolHealthResponse {
  ok: boolean;
  tools: ToolHealthStatus[];
  healthy_count: number;
  unhealthy_count: number;
  last_check: string;
}

// =============================================================================
// Stream Response Types (for ORB voice)
// =============================================================================

/**
 * Stream event types
 */
export const STREAM_EVENT_TYPES = [
  'stream_start',
  'text_chunk',
  'tool_call_start',
  'tool_call_result',
  'context_pack_ready',
  'stream_end',
  'error'
] as const;
export type StreamEventType = typeof STREAM_EVENT_TYPES[number];

/**
 * Stream event
 */
export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
  timestamp: string;
  sequence: number;
}

// =============================================================================
// OASIS Telemetry Event Types
// =============================================================================

/**
 * Conversation telemetry event types (as per spec)
 */
export const CONVERSATION_TELEMETRY_EVENTS = [
  'conversation.turn.received',
  'conversation.retrieval.router_decision',
  'conversation.retrieval.memory.completed',
  'conversation.retrieval.knowledge.completed',
  'conversation.retrieval.web.completed',
  'conversation.context_pack.built',
  'conversation.model.called',
  'conversation.tool.called',
  'conversation.turn.completed',
] as const;
export type ConversationTelemetryEvent = typeof CONVERSATION_TELEMETRY_EVENTS[number];

/**
 * Telemetry payload base
 */
export interface ConversationTelemetryPayload {
  vtid: string;
  tenant_id: string;
  user_id: string;
  role: string;
  thread_id: string;
  channel: ConversationChannel;
  [key: string]: unknown;
}
