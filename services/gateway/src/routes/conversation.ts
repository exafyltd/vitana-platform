/**
 * VTID-01216: Unified Conversation Intelligence Layer Routes (D1)
 *
 * Shared Conversation API endpoints used by both ORB and Operator Console.
 * Both surfaces MUST use this path - no separate Gemini/ORB paths allowed.
 *
 * Endpoints:
 * - POST /api/v1/conversation/turn       - Process a conversation turn
 * - POST /api/v1/conversation/stream     - Stream response (for ORB voice)
 * - GET  /api/v1/conversation/tool-health - Tool health status
 * - GET  /api/v1/conversation/tools      - Tool registry
 * - GET  /api/v1/conversation/health     - Health check
 *
 * Architecture:
 * ```
 * ORB UI ─┐
 *         ├─> /api/v1/conversation/turn
 * Operator┘
 *               ↓
 *       Retrieval Router (D2)
 *               ↓
 *     ┌────────────┬────────────┬────────────┐
 *     │MemoryGarden│KnowledgeHub│ Web Search │
 *     │  (D1-D63)  │ (existing) │ (existing) │
 *     └────────────┴────────────┴────────────┘
 *               ↓
 *       Context Pack Builder (D3)
 *               ↓
 *         LLM (shared routing)
 *               ↓
 *           Response
 * ```
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  ConversationTurnRequestSchema,
  ConversationTurnRequest,
  ConversationTurnResponse,
  ConversationChannel,
  ToolCall,
} from '../types/conversation';
import { ContextLens, createContextLens } from '../types/context-lens';
import { computeRetrievalRouterDecision, logRetrievalRouterDecision } from '../services/retrieval-router';
import { buildContextPack, formatContextPackForLLM, BuildContextPackInput } from '../services/context-pack-builder';
import {
  buildToolRegistryResponse,
  buildToolHealthResponse,
  runToolHealthChecks,
  getGeminiToolDefinitions,
  logToolExecution,
} from '../services/tool-registry';
import { processWithGemini } from '../services/gemini-operator';
// Memory auto-write for conversation turns
import { classifyCategory } from './memory';
import { writeMemoryItemWithIdentity } from '../services/orb-memory-bridge';

const router = Router();

// =============================================================================
// Conversation State (Thread Management)
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
// POST /turn - Process a conversation turn
// =============================================================================

router.post('/turn', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  const startTime = Date.now();

  console.log(`[VTID-01216] Conversation turn ${requestId} started`);

  try {
    // Validate request
    const validation = ConversationTurnRequestSchema.safeParse(req.body);
    if (!validation.success) {
      console.warn(`[VTID-01216] Validation failed:`, validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      });
    }

    const input = validation.data;
    const { channel, tenant_id, user_id, role, message, ui_context, vtid } = input;

    // Log turn received
    await emitOasisEvent({
      vtid: vtid || 'VTID-01216',
      type: 'conversation.turn.received',
      source: `conversation-${channel}`,
      status: 'info',
      message: `Turn received: ${message.text.substring(0, 50)}...`,
      payload: {
        request_id: requestId,
        tenant_id,
        user_id,
        channel,
        role,
        message_type: message.type,
        message_length: message.text.length,
      },
    }).catch(() => {});

    // Get or create conversation thread
    const thread = getOrCreateThread(input.thread_id, tenant_id, user_id, channel);
    thread.turn_count++;

    // Create context lens for memory access
    const lens: ContextLens = createContextLens(tenant_id, user_id, {
      workspace_scope: 'product',
      active_role: role,
    });

    // Step 1: Compute retrieval router decision
    const routerDecision = computeRetrievalRouterDecision(message.text, { channel });

    // Log router decision
    await logRetrievalRouterDecision(routerDecision, {
      tenant_id,
      user_id,
      thread_id: thread.thread_id,
      channel,
      query: message.text,
    });

    // Step 2: Build context pack
    const contextPackInput: BuildContextPackInput = {
      lens,
      query: message.text,
      channel,
      thread_id: thread.thread_id,
      turn_number: thread.turn_count,
      conversation_start: thread.started_at,
      role,
      ui_context: ui_context ? {
        surface: ui_context.surface,
        screen: ui_context.screen,
        selection: ui_context.selection,
        metadata: ui_context.metadata,
      } : undefined,
      router_decision: routerDecision,
      vtid,
    };

    const contextPack = await buildContextPack(contextPackInput);

    // Step 3: Format context for LLM
    const contextForLLM = formatContextPackForLLM(contextPack);

    // Step 4: Call LLM with context
    const llmStartTime = Date.now();
    let reply = '';
    let toolCalls: ToolCall[] = [];
    let tokensUsed = { prompt: 0, completion: 0, total: 0 };
    let modelUsed = 'unknown';

    try {
      // Build system instruction with context pack
      const systemInstruction = `You are Vitana, an intelligent assistant. Respond helpfully and accurately based on the context provided.

${contextForLLM}

Current conversation channel: ${channel}
User's role: ${role}

Instructions:
- Use the memory context to personalize responses
- Use knowledge context for Vitana-specific questions
- Be concise but helpful
- For ORB (voice), keep responses conversational
- For Operator, you can be more detailed`;

      // Get tool definitions for the user's role
      const toolDefs = getGeminiToolDefinitions(role);

      // Process with Gemini
      const geminiResult = await processWithGemini({
        text: message.text,
        systemInstruction,
        conversationHistory: [], // TODO: Add conversation history
        threadId: thread.thread_id,
      });

      reply = geminiResult.reply;
      modelUsed = 'gemini-2.5-pro'; // TODO: Get from routing policy

      // Process any tool calls
      if (geminiResult.toolResults && geminiResult.toolResults.length > 0) {
        for (const toolResult of geminiResult.toolResults) {
          const toolCall: ToolCall = {
            id: randomUUID(),
            name: toolResult.name,
            args: toolResult.response as Record<string, unknown>,
            duration_ms: 0, // Not tracked in current implementation
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
            { tenant_id, user_id, thread_id: thread.thread_id, channel }
          );
        }
      }

      // Log model called
      await emitOasisEvent({
        vtid: vtid || 'VTID-01216',
        type: 'conversation.model.called',
        source: `conversation-${channel}`,
        status: 'success',
        message: `LLM response generated`,
        payload: {
          tenant_id,
          user_id,
          thread_id: thread.thread_id,
          channel,
          model: modelUsed,
          latency_ms: Date.now() - llmStartTime,
          tool_calls_count: toolCalls.length,
        },
      }).catch(() => {});

    } catch (llmError: any) {
      console.error(`[VTID-01216] LLM error:`, llmError.message);

      await emitOasisEvent({
        vtid: vtid || 'VTID-01216',
        type: 'conversation.model.called',
        source: `conversation-${channel}`,
        status: 'error',
        message: `LLM call failed: ${llmError.message}`,
        payload: {
          tenant_id,
          user_id,
          thread_id: thread.thread_id,
          channel,
          error: llmError.message,
        },
      }).catch(() => {});

      reply = `I apologize, but I encountered an error processing your request. Please try again.`;
    }

    // Step 5: Auto-write conversation to memory
    try {
      const category = classifyCategory(message.text);
      await writeMemoryItemWithIdentity(
        { user_id, tenant_id },
        {
          content: `User (${channel}): ${message.text}\nAssistant: ${reply}`,
          source: channel === 'orb' ? 'orb_text' : 'orb_text',
          category_key: category || 'conversation',
          importance: 10,
        }
      );
    } catch (memoryError: any) {
      console.warn(`[VTID-01216] Memory write failed:`, memoryError.message);
    }

    // Build response
    const response: ConversationTurnResponse = {
      ok: true,
      reply,
      thread_id: thread.thread_id,
      meta: {
        channel,
        turn_number: thread.turn_count,
        model_used: modelUsed,
        latency_ms: Date.now() - startTime,
        tokens_used: tokensUsed.total > 0 ? tokensUsed : undefined,
      },
      // Only include context pack for Operator (not voice/ORB)
      context_pack: channel === 'operator' ? contextPack : undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      oasis_ref: `OASIS-CONV-${requestId.slice(0, 8).toUpperCase()}`,
    };

    // Log turn completed
    await emitOasisEvent({
      vtid: vtid || 'VTID-01216',
      type: 'conversation.turn.completed',
      source: `conversation-${channel}`,
      status: 'success',
      message: `Turn completed successfully`,
      payload: {
        request_id: requestId,
        tenant_id,
        user_id,
        thread_id: thread.thread_id,
        channel,
        turn_number: thread.turn_count,
        total_latency_ms: Date.now() - startTime,
        memory_hits: contextPack.memory_hits.length,
        knowledge_hits: contextPack.knowledge_hits.length,
        web_hits: contextPack.web_hits.length,
        tool_calls: toolCalls.length,
      },
    }).catch(() => {});

    console.log(`[VTID-01216] Turn ${requestId} completed in ${Date.now() - startTime}ms`);
    return res.status(200).json(response);

  } catch (error: any) {
    console.error(`[VTID-01216] Turn ${requestId} failed:`, error.message);

    await emitOasisEvent({
      vtid: 'VTID-01216',
      type: 'conversation.turn.completed',
      source: 'conversation-api',
      status: 'error',
      message: `Turn failed: ${error.message}`,
      payload: {
        request_id: requestId,
        error: error.message,
        latency_ms: Date.now() - startTime,
      },
    }).catch(() => {});

    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      oasis_ref: `OASIS-CONV-${requestId.slice(0, 8).toUpperCase()}`,
    });
  }
});

// =============================================================================
// POST /stream - Stream response (for ORB voice)
// =============================================================================

router.post('/stream', async (req: Request, res: Response) => {
  const requestId = randomUUID();

  try {
    // Validate request
    const validation = ConversationTurnRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      });
    }

    const input = validation.data;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Send stream start event
    res.write(`data: ${JSON.stringify({ type: 'stream_start', timestamp: new Date().toISOString(), sequence: 0 })}\n\n`);

    // Process the turn (reuse turn logic)
    const thread = getOrCreateThread(input.thread_id, input.tenant_id, input.user_id, input.channel);
    thread.turn_count++;

    // Create context lens
    const lens: ContextLens = createContextLens(input.tenant_id, input.user_id, {
      workspace_scope: 'product',
      active_role: input.role,
    });

    // Compute router decision
    const routerDecision = computeRetrievalRouterDecision(input.message.text, { channel: input.channel });

    // Send context pack ready event
    res.write(`data: ${JSON.stringify({ type: 'context_pack_ready', timestamp: new Date().toISOString(), sequence: 1 })}\n\n`);

    // Build context pack
    const contextPackInput: BuildContextPackInput = {
      lens,
      query: input.message.text,
      channel: input.channel,
      thread_id: thread.thread_id,
      turn_number: thread.turn_count,
      conversation_start: thread.started_at,
      role: input.role,
      router_decision: routerDecision,
    };

    const contextPack = await buildContextPack(contextPackInput);
    const contextForLLM = formatContextPackForLLM(contextPack);

    // Build system instruction
    const systemInstruction = `You are Vitana, an intelligent voice assistant. Keep responses concise and conversational.

${contextForLLM}

Instructions:
- Be brief and natural for voice interaction
- Avoid long lists or complex formatting
- Be warm and helpful`;

    // Process with Gemini
    try {
      const geminiResult = await processWithGemini({
        text: input.message.text,
        systemInstruction,
        conversationHistory: [],
        threadId: thread.thread_id,
      });

      // Send text chunks (simulate streaming)
      const words = geminiResult.reply.split(' ');
      let sequence = 2;
      for (let i = 0; i < words.length; i += 3) {
        const chunk = words.slice(i, i + 3).join(' ');
        res.write(`data: ${JSON.stringify({ type: 'text_chunk', data: chunk + ' ', timestamp: new Date().toISOString(), sequence: sequence++ })}\n\n`);
      }

      // Send stream end
      res.write(`data: ${JSON.stringify({
        type: 'stream_end',
        data: {
          thread_id: thread.thread_id,
          turn_number: thread.turn_count,
          full_text: geminiResult.reply,
        },
        timestamp: new Date().toISOString(),
        sequence: sequence
      })}\n\n`);

    } catch (llmError: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', data: llmError.message, timestamp: new Date().toISOString(), sequence: 999 })}\n\n`);
    }

    res.end();

  } catch (error: any) {
    console.error(`[VTID-01216] Stream ${requestId} failed:`, error.message);

    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        error: 'Internal server error',
      });
    }

    res.write(`data: ${JSON.stringify({ type: 'error', data: error.message, timestamp: new Date().toISOString(), sequence: 999 })}\n\n`);
    res.end();
  }
});

// =============================================================================
// GET /tool-health - Tool health status
// =============================================================================

router.get('/tool-health', async (_req: Request, res: Response) => {
  try {
    const response = await runToolHealthChecks();
    return res.status(200).json(response);
  } catch (error: any) {
    console.error(`[VTID-01216] Tool health check failed:`, error.message);
    return res.status(500).json({
      ok: false,
      error: 'Health check failed',
    });
  }
});

// =============================================================================
// GET /tools - Tool registry
// =============================================================================

router.get('/tools', (_req: Request, res: Response) => {
  try {
    const response = buildToolRegistryResponse();
    return res.status(200).json(response);
  } catch (error: any) {
    console.error(`[VTID-01216] Tool registry failed:`, error.message);
    return res.status(500).json({
      ok: false,
      error: 'Registry retrieval failed',
    });
  }
});

// =============================================================================
// GET /health - Health check
// =============================================================================

router.get('/health', (_req: Request, res: Response) => {
  const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

  res.status(200).json({
    ok: true,
    service: 'conversation-api',
    vtid: 'VTID-01216',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    features: {
      memory_garden: true,
      knowledge_hub: true,
      web_search: !!PERPLEXITY_API_KEY,
      streaming: true,
    },
  });
});

export default router;
