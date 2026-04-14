/**
 * VITANA BRAIN — Unified Intelligence Service
 *
 * Single entry point for all Vitana conversation surfaces.
 * Wraps processConversationTurn() from conversation-client.ts
 * and extends it with:
 *   - Unified context (memory + calendar + OASIS, role-gated)
 *   - Unified tool execution (all tools in one registry)
 *   - OASIS telemetry (every brain decision logged)
 *
 * SAFETY: This service is gated by feature flags:
 *   - vitana_brain_enabled      → text chat, conversation, assistant
 *   - vitana_brain_orb_enabled  → ORB voice (separate, higher risk)
 *
 * When flags are OFF, all surfaces use their legacy paths unchanged.
 * When flags are ON, surfaces route through processBrainTurn().
 *
 * Phase 1: Brain wraps processConversationTurn (no old code modified)
 * Phase 2+: Surfaces add if/else flag checks to route here
 */

import { randomUUID } from 'crypto';
import {
  processConversationTurn,
  ProcessConversationTurnInput,
  ProcessConversationTurnResult,
} from './conversation-client';
import {
  buildContextPack,
  formatContextPackForLLM,
  BuildContextPackInput,
  extractLanguageFromContextPack,
  buildLanguageDirective,
} from './context-pack-builder';
import { computeRetrievalRouterDecision } from './retrieval-router';
import { ContextLens, createContextLens } from '../types/context-lens';
import { ConversationChannel, ContextPack } from '../types/conversation';
import { getPersonalityConfigSync } from './ai-personality-service';
import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Types
// =============================================================================

export interface BrainTurnInput {
  /** Which surface is calling */
  channel: ConversationChannel;

  /** User identity */
  tenant_id: string;
  user_id: string;
  role: string;

  /** The user's message */
  message: string;
  message_type?: 'text' | 'voice_transcript';

  /** Thread continuity */
  thread_id?: string;

  /** UI context (optional) */
  ui_context?: {
    surface: ConversationChannel;
    screen?: string;
    selection?: string;
    metadata?: Record<string, unknown>;
  };

  /** VTID link (optional) */
  vtid?: string;

  /** Display name (optional) */
  display_name?: string;

  /** Conversation history (optional) */
  conversation_history?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

export interface BrainTurnOutput {
  ok: boolean;
  reply: string;
  thread_id: string;
  turn_number: number;
  context_pack?: ContextPack;
  tool_calls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: unknown;
    success: boolean;
    duration_ms: number;
  }>;
  meta: {
    channel: ConversationChannel;
    model_used: string;
    latency_ms: number;
    brain_version: string;
    tokens_used?: {
      prompt: number;
      completion: number;
      total: number;
    };
  };
  oasis_ref: string;
  error?: string;
}

const BRAIN_VERSION = '1.0.0';
const LOG_PREFIX = '[VITANA-BRAIN]';

// =============================================================================
// Main Brain Entry Point
// =============================================================================

/**
 * Process a conversation turn through the unified Vitana Brain.
 *
 * Currently wraps processConversationTurn() and adds:
 *   - Brain-specific telemetry (OASIS events)
 *   - Brain version tracking
 *   - Unified error handling with graceful degradation
 *
 * Future phases will add:
 *   - OASIS context injection (role-gated)
 *   - Unified tool registry (ORB + Operator + Dev tools merged)
 *   - Brain-level caching
 */
export async function processBrainTurn(
  input: BrainTurnInput,
): Promise<BrainTurnOutput> {
  const requestId = randomUUID();
  const startTime = Date.now();

  console.log(`${LOG_PREFIX} Processing turn ${requestId} via ${input.channel} for role=${input.role}`);

  try {
    // Emit brain turn start
    emitOasisEvent({
      vtid: 'VITANA-BRAIN',
      type: 'brain.turn.received',
      source: `brain-${input.channel}`,
      status: 'info',
      message: `Brain turn received: ${input.message.substring(0, 50)}...`,
      payload: {
        request_id: requestId,
        channel: input.channel,
        role: input.role,
        user_id: input.user_id,
        brain_version: BRAIN_VERSION,
        message_length: input.message.length,
      },
    }).catch(() => {});

    // Delegate to the existing unified conversation layer
    // This already calls: buildContextPack → retrieval router → LLM → tools → memory write
    const convInput: ProcessConversationTurnInput = {
      channel: input.channel,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      role: input.role,
      message: input.message,
      message_type: input.message_type,
      thread_id: input.thread_id,
      ui_context: input.ui_context,
      vtid: input.vtid,
      display_name: input.display_name,
      conversation_history: input.conversation_history,
    };

    const result: ProcessConversationTurnResult = await processConversationTurn(convInput);

    const latencyMs = Date.now() - startTime;

    // Emit brain turn completed
    emitOasisEvent({
      vtid: 'VITANA-BRAIN',
      type: 'brain.turn.processed',
      source: `brain-${input.channel}`,
      status: result.ok ? 'success' : 'warning',
      message: `Brain turn completed in ${latencyMs}ms`,
      payload: {
        request_id: requestId,
        channel: input.channel,
        role: input.role,
        brain_version: BRAIN_VERSION,
        latency_ms: latencyMs,
        model_used: result.meta.model_used,
        tool_calls_count: result.tool_calls.length,
        reply_length: result.reply?.length || 0,
        context_sources: {
          memory_hits: result.context_pack?.memory_hits?.length || 0,
          knowledge_hits: result.context_pack?.knowledge_hits?.length || 0,
          web_hits: result.context_pack?.web_hits?.length || 0,
          has_calendar: !!result.context_pack?.calendar_context,
        },
      },
    }).catch(() => {});

    console.log(`${LOG_PREFIX} Turn ${requestId} completed in ${latencyMs}ms (${result.ok ? 'ok' : 'error'})`);

    return {
      ok: result.ok,
      reply: result.reply,
      thread_id: result.thread_id,
      turn_number: result.turn_number,
      context_pack: result.context_pack,
      tool_calls: result.tool_calls,
      meta: {
        channel: result.meta.channel,
        model_used: result.meta.model_used,
        latency_ms: latencyMs,
        brain_version: BRAIN_VERSION,
        tokens_used: result.meta.tokens_used,
      },
      oasis_ref: result.oasis_ref,
      error: result.error,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;

    console.error(`${LOG_PREFIX} Turn ${requestId} failed after ${latencyMs}ms:`, err.message);

    // Emit brain turn error
    emitOasisEvent({
      vtid: 'VITANA-BRAIN',
      type: 'brain.turn.error',
      source: `brain-${input.channel}`,
      status: 'error',
      message: `Brain turn failed: ${err.message}`,
      payload: {
        request_id: requestId,
        channel: input.channel,
        role: input.role,
        brain_version: BRAIN_VERSION,
        latency_ms: latencyMs,
        error: err.message,
        stack: err.stack?.substring(0, 500),
      },
    }).catch(() => {});

    return {
      ok: false,
      reply: '',
      thread_id: input.thread_id || '',
      turn_number: 0,
      tool_calls: [],
      meta: {
        channel: input.channel,
        model_used: 'unknown',
        latency_ms: latencyMs,
        brain_version: BRAIN_VERSION,
      },
      oasis_ref: requestId,
      error: err.message,
    };
  }
}

// =============================================================================
// Brain System Instruction Builder (for ORB Voice — Phase 3)
// =============================================================================

/**
 * Build a complete system instruction using the Brain's context pipeline.
 * Used by ORB voice (Phase 3) to replace inline prompt builders.
 *
 * Calls buildContextPack → formatContextPackForLLM → personality config
 * to produce a single system instruction string.
 */
export async function buildBrainSystemInstruction(input: {
  user_id: string;
  tenant_id: string;
  role: string;
  channel: ConversationChannel;
  thread_id?: string;
  turn_number?: number;
  conversation_start?: string;
  display_name?: string;
}): Promise<{ instruction: string; contextPack: ContextPack }> {
  const startTime = Date.now();

  // Create context lens
  const lens: ContextLens = createContextLens(input.tenant_id, input.user_id, {
    workspace_scope: 'product',
    active_role: input.role,
  });

  // Compute retrieval router for broad context
  const routerDecision = computeRetrievalRouterDecision('general conversation context', {
    channel: input.channel,
  });

  // Build context pack (memory, calendar, knowledge, relationships, etc.)
  const contextPackInput: BuildContextPackInput = {
    lens,
    query: 'general conversation context',
    channel: input.channel,
    thread_id: input.thread_id || randomUUID(),
    turn_number: input.turn_number || 0,
    conversation_start: input.conversation_start || new Date().toISOString(),
    role: input.role,
    display_name: input.display_name,
    router_decision: routerDecision,
  };

  const contextPack = await buildContextPack(contextPackInput);
  const contextForLLM = formatContextPackForLLM(contextPack);

  // Build personality-driven instruction
  const preferredLanguage = extractLanguageFromContextPack(contextPack);
  const languageDirective = buildLanguageDirective(preferredLanguage);

  const ucConfig = getPersonalityConfigSync('unified_conversation') as Record<string, any>;
  const baseInstruction = input.channel === 'orb'
    ? (ucConfig.orb_instruction || 'You are Vitana, an intelligent voice assistant. Keep responses concise and conversational for voice interaction.')
    : (ucConfig.operator_instruction || 'You are Vitana, an intelligent assistant. You can be detailed and use formatting when helpful.');

  const instruction = `${baseInstruction}
${languageDirective}
${contextForLLM}

Current conversation channel: ${input.channel}
User's role: ${input.role}

Instructions:
${ucConfig.common_instructions || '- Use the memory context to personalize responses\n- Use knowledge context for Vitana-specific questions\n- Be helpful and accurate'}
- ${input.channel === 'orb' ? (ucConfig.instructions_orb || 'Keep responses brief and natural for voice') : (ucConfig.instructions_operator || 'You can use markdown formatting and be more detailed')}`;

  const latencyMs = Date.now() - startTime;
  console.log(`${LOG_PREFIX} System instruction built in ${latencyMs}ms (${instruction.length} chars, ${contextPack.memory_hits?.length || 0} memory hits, calendar=${!!contextPack.calendar_context})`);

  return { instruction, contextPack };
}

// =============================================================================
// Brain Tool Definitions (for ORB Voice — Phase 3)
// =============================================================================

/**
 * Get unified tool definitions for the Brain, role-gated.
 * Merges the tool-registry tools with ORB-specific tools.
 *
 * Phase 3: ORB voice calls this instead of buildLiveApiTools()
 */
export function buildBrainToolDefinitions(role: string): object[] {
  // Import tool registry (already role-gated)
  const { getGeminiToolDefinitions } = require('./tool-registry');
  const registryTools = getGeminiToolDefinitions(role);

  // ORB-specific tools that aren't in the registry yet
  const orbTools = [
    {
      name: 'search_calendar',
      description: 'Search the user\'s personal calendar for events, appointments, and scheduled activities.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for in the calendar' },
        },
        required: ['query'],
      },
    },
  ];

  // Merge: registry tools + ORB tools (avoid duplicates)
  const registryNames = new Set(registryTools.map((t: any) => t.name));
  const merged = [...registryTools];
  for (const tool of orbTools) {
    if (!registryNames.has(tool.name)) {
      merged.push(tool);
    }
  }

  return merged;
}

// =============================================================================
// Brain Tool Executor (for ORB Voice — Phase 3)
// =============================================================================

/**
 * Execute a tool call through the Brain's unified executor.
 * Handles all tools from the merged registry + ORB-specific tools.
 *
 * Phase 3: ORB voice calls this instead of executeLiveApiToolInner()
 */
export async function executeBrainTool(
  toolName: string,
  args: Record<string, unknown>,
  context: { user_id: string; tenant_id: string; role: string },
): Promise<{ success: boolean; result: string; error?: string }> {
  const startTime = Date.now();

  try {
    switch (toolName) {
      case 'search_calendar': {
        const { getUserTodayEvents, getUserUpcomingEvents, getCalendarGaps } = await import('./calendar-service');
        const [today, upcoming, gaps] = await Promise.all([
          getUserTodayEvents(context.user_id, context.role),
          getUserUpcomingEvents(context.user_id, context.role, 10),
          getCalendarGaps(context.user_id, context.role, new Date()),
        ]);

        let formatted = '';
        if (today.length > 0) {
          formatted += 'Today\'s schedule:\n';
          for (const ev of today) {
            const time = new Date(ev.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            formatted += `- ${time}: ${ev.title} (${ev.event_type})\n`;
          }
        } else {
          formatted += 'Today\'s schedule: No events scheduled.\n';
        }
        if (upcoming.length > 0) {
          formatted += '\nUpcoming (next 7 days):\n';
          for (const ev of upcoming.slice(0, 5)) {
            const date = new Date(ev.start_time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const time = new Date(ev.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            formatted += `- ${date} ${time}: ${ev.title}\n`;
          }
        }
        if (gaps.length > 0) {
          formatted += '\nFree time today:\n';
          for (const gap of gaps.slice(0, 3)) {
            const start = new Date(gap.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            const end = new Date(gap.end).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            formatted += `- ${start}\u2013${end} (${gap.duration_minutes} min free)\n`;
          }
        }

        console.log(`${LOG_PREFIX} search_calendar: ${today.length} today, ${upcoming.length} upcoming, ${gaps.length} gaps (${Date.now() - startTime}ms)`);
        return { success: true, result: formatted || 'Your calendar is currently empty.' };
      }

      default: {
        // Delegate to tool-registry executor for all other tools
        return {
          success: false,
          result: `Tool '${toolName}' not handled by brain executor. Delegate to surface-specific handler.`,
          error: `unhandled_tool:${toolName}`,
        };
      }
    }
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Tool ${toolName} failed: ${err.message}`);
    return { success: false, result: `Tool execution failed: ${err.message}`, error: err.message };
  }
}
