/**
 * Conversation router — Phase 1 W1 scaffold (VTID-03181 VOICE-LAT).
 *
 * UNIFIED entry point for the three surfaces that today have their own
 * brain wiring:
 *   - assistant-service.ts (no tools, text only)
 *   - conversation-client.ts (tools, batch + sync)
 *   - orb-live.ts (voice + streaming + tools)
 *
 * W1 ships ONLY the entry shape + parity-test scaffold. NO call site is
 * migrated yet. W4 migrates assistant-service (lowest blast radius — no
 * tools). W5 migrates conversation-client. orb-live is explicitly DEFERRED
 * past the 40-day window per the plan.
 *
 * The router's job: take a typed `ConversationRequest`, choose a provider
 * (Vertex / Anthropic / Bedrock once W3 AWS lands), run with shadow if
 * the feature flag is on, and return a typed `ConversationResponse`. No
 * surface-specific shape logic — that stays at the call site.
 */

export type ConversationSurface = 'assistant' | 'conversation-client' | 'orb-live';

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

export interface ConversationTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ConversationRequest {
  surface: ConversationSurface;
  session_id: string;
  actor_id?: string;
  messages: ConversationMessage[];
  tools?: ConversationTool[];
  /** Caller hint; the router may override via shadow harness. */
  preferred_provider?: 'vertex' | 'anthropic' | 'bedrock';
  /** Caller hint; the router may downsize for cost. */
  preferred_model?: string;
  /** Hard deadline in ms; router aborts if exceeded. */
  timeout_ms?: number;
}

export interface ConversationToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ConversationResponse {
  text: string;
  tool_calls?: ConversationToolCall[];
  /** Provider that actually served the response. */
  provider: 'vertex' | 'anthropic' | 'bedrock';
  /** Model that actually served the response. */
  model: string;
  /** Wall-clock for the upstream call. */
  upstream_ms: number;
  /** Token usage if the upstream reported it. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * W1: throws "not implemented" until W4 migration begins. Lives as the
 * single canonical type contract so PR #5 lands the shape and downstream
 * migrations can wire to it without changing the import.
 */
export async function route(_req: ConversationRequest): Promise<ConversationResponse> {
  throw new Error(
    'conversation-router.route is W1 scaffold; migration starts W4 with assistant-service. ' +
      'See .claude/plans/yes-make-a-week-by-week-wild-shore.md',
  );
}
