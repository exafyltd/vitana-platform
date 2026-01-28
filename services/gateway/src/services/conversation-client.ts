/**
 * VTID-01216: Conversation API Client
 *
 * Internal client for ORB and Operator to use the unified conversation API.
 * This provides a consistent interface for both surfaces to access the
 * same conversation intelligence layer.
 *
 * Usage:
 * - Import processConversationTurn in ORB or Operator routes
 * - Pass the request parameters and get a unified response
 *
 * Both ORB and Operator should migrate to use this client
 * instead of directly calling Gemini or separate LLM paths.
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  ConversationTurnRequest,
  ConversationTurnResponse,
  ConversationChannel,
  ContextPack,
  ToolCall,
} from '../types/conversation';
import { ContextLens, createContextLens } from '../types/context-lens';
import { computeRetrievalRouterDecision, logRetrievalRouterDecision } from './retrieval-router';
import { buildContextPack, formatContextPackForLLM, BuildContextPackInput } from './context-pack-builder';
import { processWithGemini } from './gemini-operator';
import { getGeminiToolDefinitions, logToolExecution } from './tool-registry';
import { classifyCategory } from '../routes/memory';
import { writeMemoryItemWithIdentity } from './orb-memory-bridge';
import { isUnifiedConversationEnabled } from './system-controls-service';

// =============================================================================
// Thread Management
// =============================================================================

interface ConversationThread {
  thread_id: string;
  tenant_id: string;
  user_id: string;
  channel: ConversationChannel;
  turn_count: number;
  started_at: string;
  last_activity: string;
  conversation_id?: string;
}

// In-memory thread store (should be replaced with persistent storage in production)
const threads = new Map<string, ConversationThread>();

/**
 * Get or create a conversation thread
 */
function getOrCreateThread(
  thread_id: string | undefined,
  tenant_id: string,
  user_id: string,
  channel: ConversationChannel
): ConversationThread {
  const id = thread_id || randomUUID();

  if (threads.has(id)) {
    const thread = threads.get(id)!;
    thread.last_activity = new Date().toISOString();
    return thread;
  }

  const newThread: ConversationThread = {
    thread_id: id,
    tenant_id,
    user_id,
    channel,
    turn_count: 0,
    started_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
  };

  threads.set(id, newThread);
  return newThread;
}

// =============================================================================
// Main Conversation Processing Function
// =============================================================================

export interface ProcessConversationTurnInput {
  /** Channel (ORB or Operator) */
  channel: ConversationChannel;

  /** Tenant ID */
  tenant_id: string;

  /** User ID */
  user_id: string;

  /** User's role */
  role: string;

  /** Thread ID (optional - will create if not provided) */
  thread_id?: string;

  /** User's message text */
  message: string;

  /** Message type */
  message_type?: 'text' | 'voice_transcript';

  /** UI context (optional) */
  ui_context?: {
    surface: ConversationChannel;
    screen?: string;
    selection?: string;
    metadata?: Record<string, unknown>;
  };

  /** VTID link (optional) */
  vtid?: string;

  /** Display name for context (optional) */
  display_name?: string;

  /** Conversation history (optional - for context) */
  conversation_history?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

export interface ProcessConversationTurnResult {
  ok: boolean;

  /** The assistant's reply */
  reply: string;

  /** Thread ID for continuation */
  thread_id: string;

  /** Turn number */
  turn_number: number;

  /** Context pack (for Operator visibility) */
  context_pack?: ContextPack;

  /** Tool calls made */
  tool_calls: ToolCall[];

  /** Response metadata */
  meta: {
    channel: ConversationChannel;
    model_used: string;
    latency_ms: number;
    tokens_used?: {
      prompt: number;
      completion: number;
      total: number;
    };
  };

  /** OASIS reference */
  oasis_ref: string;

  /** Error message if ok=false */
  error?: string;
}

/**
 * Process a conversation turn using the unified intelligence layer.
 *
 * This is the main entry point for ORB and Operator to use the shared
 * conversation brain. Both surfaces should call this function instead
 * of directly calling Gemini or other LLM providers.
 */
export async function processConversationTurn(
  input: ProcessConversationTurnInput
): Promise<ProcessConversationTurnResult> {
  const requestId = randomUUID();
  const startTime = Date.now();

  console.log(`[VTID-01216] Processing turn ${requestId} via ${input.channel}`);

  try {
    // Log turn received
    await emitOasisEvent({
      vtid: input.vtid || 'VTID-01216',
      type: 'conversation.turn.received',
      source: `conversation-${input.channel}`,
      status: 'info',
      message: `Turn received: ${input.message.substring(0, 50)}...`,
      payload: {
        request_id: requestId,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        channel: input.channel,
        role: input.role,
        message_length: input.message.length,
      },
    }).catch(() => {});

    // Get or create thread
    const thread = getOrCreateThread(input.thread_id, input.tenant_id, input.user_id, input.channel);
    thread.turn_count++;

    // Create context lens
    const lens: ContextLens = createContextLens(input.tenant_id, input.user_id, {
      workspace_scope: 'product',
      active_role: input.role,
    });

    // Step 1: Compute retrieval router decision
    const routerDecision = computeRetrievalRouterDecision(input.message, { channel: input.channel });

    // Log router decision
    await logRetrievalRouterDecision(routerDecision, {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      thread_id: thread.thread_id,
      channel: input.channel,
      query: input.message,
    });

    // Step 2: Build context pack
    const contextPackInput: BuildContextPackInput = {
      lens,
      query: input.message,
      channel: input.channel,
      thread_id: thread.thread_id,
      turn_number: thread.turn_count,
      conversation_start: thread.started_at,
      role: input.role,
      display_name: input.display_name,
      ui_context: input.ui_context,
      router_decision: routerDecision,
      vtid: input.vtid,
    };

    const contextPack = await buildContextPack(contextPackInput);

    // Step 3: Format context for LLM
    const contextForLLM = formatContextPackForLLM(contextPack);

    // Step 4: Build system instruction
    const systemInstruction = buildSystemInstruction(input.channel, input.role, contextForLLM);

    // Step 5: Get tool definitions
    const toolDefs = getGeminiToolDefinitions(input.role);

    // Step 6: Call LLM
    const llmStartTime = Date.now();
    let reply = '';
    let toolCalls: ToolCall[] = [];
    let modelUsed = 'gemini-2.5-pro';

    try {
      const geminiResult = await processWithGemini({
        text: input.message,
        systemInstruction,
        conversationHistory: input.conversation_history?.map(h => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
        })) || [],
        threadId: thread.thread_id,
      });

      reply = geminiResult.reply;

      // Process tool calls
      if (geminiResult.toolResults && geminiResult.toolResults.length > 0) {
        for (const toolResult of geminiResult.toolResults) {
          const toolCall: ToolCall = {
            id: randomUUID(),
            name: toolResult.name,
            args: toolResult.response as Record<string, unknown>,
            duration_ms: 0,
            result: toolResult.response,
            success: true,
          };
          toolCalls.push(toolCall);

          // Log tool execution
          await logToolExecution(
            toolCall.name,
            toolCall.args,
            toolCall.result,
            toolCall.success,
            toolCall.duration_ms,
            { tenant_id: input.tenant_id, user_id: input.user_id, thread_id: thread.thread_id, channel: input.channel }
          );
        }
      }

      // Log model called
      await emitOasisEvent({
        vtid: input.vtid || 'VTID-01216',
        type: 'conversation.model.called',
        source: `conversation-${input.channel}`,
        status: 'success',
        message: 'LLM response generated',
        payload: {
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          thread_id: thread.thread_id,
          channel: input.channel,
          model: modelUsed,
          latency_ms: Date.now() - llmStartTime,
          tool_calls_count: toolCalls.length,
        },
      }).catch(() => {});

    } catch (llmError: any) {
      console.error(`[VTID-01216] LLM error:`, llmError.message);

      await emitOasisEvent({
        vtid: input.vtid || 'VTID-01216',
        type: 'conversation.model.called',
        source: `conversation-${input.channel}`,
        status: 'error',
        message: `LLM call failed: ${llmError.message}`,
        payload: {
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          thread_id: thread.thread_id,
          channel: input.channel,
          error: llmError.message,
        },
      }).catch(() => {});

      reply = 'I apologize, but I encountered an error processing your request. Please try again.';
    }

    // Step 7: Auto-write conversation to memory
    try {
      const category = classifyCategory(input.message);
      await writeMemoryItemWithIdentity(
        { user_id: input.user_id, tenant_id: input.tenant_id },
        {
          content: `User (${input.channel}): ${input.message}\nAssistant: ${reply}`,
          source: input.channel === 'orb' ? 'orb_text' : 'orb_text',
          category_key: category || 'conversation',
          importance: 10,
        }
      );
    } catch (memoryError: any) {
      console.warn(`[VTID-01216] Memory write failed:`, memoryError.message);
    }

    // Log turn completed
    await emitOasisEvent({
      vtid: input.vtid || 'VTID-01216',
      type: 'conversation.turn.completed',
      source: `conversation-${input.channel}`,
      status: 'success',
      message: 'Turn completed successfully',
      payload: {
        request_id: requestId,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        thread_id: thread.thread_id,
        channel: input.channel,
        turn_number: thread.turn_count,
        total_latency_ms: Date.now() - startTime,
        memory_hits: contextPack.memory_hits.length,
        knowledge_hits: contextPack.knowledge_hits.length,
        web_hits: contextPack.web_hits.length,
        tool_calls: toolCalls.length,
      },
    }).catch(() => {});

    console.log(`[VTID-01216] Turn ${requestId} completed in ${Date.now() - startTime}ms`);

    return {
      ok: true,
      reply,
      thread_id: thread.thread_id,
      turn_number: thread.turn_count,
      context_pack: input.channel === 'operator' ? contextPack : undefined,
      tool_calls: toolCalls,
      meta: {
        channel: input.channel,
        model_used: modelUsed,
        latency_ms: Date.now() - startTime,
      },
      oasis_ref: `OASIS-CONV-${requestId.slice(0, 8).toUpperCase()}`,
    };

  } catch (error: any) {
    console.error(`[VTID-01216] Turn ${requestId} failed:`, error.message);

    await emitOasisEvent({
      vtid: input.vtid || 'VTID-01216',
      type: 'conversation.turn.completed',
      source: `conversation-${input.channel}`,
      status: 'error',
      message: `Turn failed: ${error.message}`,
      payload: {
        request_id: requestId,
        error: error.message,
        latency_ms: Date.now() - startTime,
      },
    }).catch(() => {});

    return {
      ok: false,
      reply: 'An error occurred while processing your request.',
      thread_id: input.thread_id || randomUUID(),
      turn_number: 0,
      tool_calls: [],
      meta: {
        channel: input.channel,
        model_used: 'unknown',
        latency_ms: Date.now() - startTime,
      },
      oasis_ref: `OASIS-CONV-${requestId.slice(0, 8).toUpperCase()}`,
      error: error.message,
    };
  }
}

/**
 * Build the system instruction for the LLM
 */
function buildSystemInstruction(
  channel: ConversationChannel,
  role: string,
  contextForLLM: string
): string {
  const baseInstruction = channel === 'orb'
    ? `You are Vitana, an intelligent voice assistant. Keep responses concise and conversational for voice interaction.`
    : `You are Vitana, an intelligent assistant for the Operator Console. You can be more detailed and use formatting when helpful.`;

  return `${baseInstruction}

${contextForLLM}

Current conversation channel: ${channel}
User's role: ${role}

Instructions:
- Use the memory context to personalize responses
- Use knowledge context for Vitana-specific questions
- Be helpful and accurate
- ${channel === 'orb' ? 'Keep responses brief and natural for voice' : 'You can use markdown formatting and be more detailed'}`;
}

// Re-export isUnifiedConversationEnabled from system-controls-service
// This uses DB-backed governance controls instead of env vars (VTID-01216)
export { isUnifiedConversationEnabled } from './system-controls-service';
