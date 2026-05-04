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
import { buildContextPack, formatContextPackForLLM, BuildContextPackInput, extractLanguageFromContextPack, buildLanguageDirective } from '../services/context-pack-builder';
import {
  buildToolRegistryResponse,
  buildToolHealthResponse,
  runToolHealthChecks,
  getGeminiToolDefinitions,
  logToolExecution,
} from '../services/tool-registry';
import { processWithGemini, setThreadIdentity } from '../services/gemini-operator';
// VTID-01967: Resolve canonical Vitana ID handle for the prompt + tool-thread identity
import { resolveVitanaId } from '../middleware/auth-supabase-jwt';
// VTID-DEV-ASSIST: Developer assistant personality
import { getPersonalityConfigSync } from '../services/ai-personality-service';
// Memory auto-write for conversation turns
import { classifyCategory } from './memory';
import { writeMemoryItemWithIdentity } from '../services/orb-memory-bridge';
// VTID-01225: Cognee entity extraction from conversation turns
import { cogneeExtractorClient } from '../services/cognee-extractor-client';
// VTID-01225: Inline fact extraction fallback when Cognee is unavailable
import { extractAndPersistFacts, isInlineExtractionAvailable } from '../services/inline-fact-extractor';
// VTID-01230: Session buffer for short-term memory + extraction dedup
import { addTurn as addSessionTurn } from '../services/session-memory-buffer';
// VTID-01955 Phase 1 — Tier 0 Memorystore Redis turn buffer (dual-write w/ in-process buffer)
import { addTurnRedis } from '../services/redis-turn-buffer';
import { deduplicatedExtract } from '../services/extraction-dedup-manager';
// Supabase client for persistent message storage
import { getSupabase } from '../lib/supabase';

const router = Router();

// =============================================================================
// Persistent Message Storage (conversation_messages table)
// =============================================================================

/**
 * Persist a message to the conversation_messages table in Supabase.
 * Fire-and-forget by default — callers should .catch() errors.
 */
async function persistMessage(params: {
  thread_id: string;
  tenant_id: string;
  user_id: string;
  role: 'user' | 'assistant';
  channel: ConversationChannel;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string } | null> {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn('[conversation] Supabase not configured — message not persisted');
    return null;
  }

  const { data, error } = await supabase
    .from('conversation_messages')
    .insert({
      thread_id: params.thread_id,
      tenant_id: params.tenant_id,
      user_id: params.user_id,
      role: params.role,
      channel: params.channel,
      content: params.content,
      metadata: params.metadata || {},
    })
    .select('id')
    .single();

  if (error) {
    console.warn('[conversation] Failed to persist message:', error.message);
    return null;
  }

  return data;
}

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
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
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
    history: [],
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
    const { channel, tenant_id, user_id, role, message, ui_context, vtid, options } = input;

    // =========================================================================
    // VTID-DEV-ASSIST: STRICT ROLE ENFORCEMENT for developer_assistant channel
    // The developer_assistant channel grants access to task management, specs,
    // CI/CD, deployments, and approvals. Only verified developer/admin users
    // may access it. The role is verified server-side from user_tenants table,
    // NOT from the client-supplied role parameter.
    // =========================================================================
    if (channel === 'developer_assistant') {
      let verifiedRole: string | null = null;

      // Server-side role verification: query user_tenants for the actual active_role
      const supabase = getSupabase();
      if (supabase && user_id && tenant_id) {
        try {
          const { data: membership } = await supabase
            .from('user_tenants')
            .select('active_role')
            .eq('user_id', user_id)
            .eq('tenant_id', tenant_id)
            .limit(1)
            .single();

          verifiedRole = membership?.active_role || null;
        } catch (err: any) {
          console.warn(`[VTID-DEV-ASSIST] Role verification failed for user ${user_id}: ${err.message}`);
        }
      }

      // HARD BLOCK: Only developer and admin roles may use the developer_assistant channel
      const allowedDevRoles = ['developer', 'admin'];
      if (!verifiedRole || !allowedDevRoles.includes(verifiedRole)) {
        console.warn(
          `[VTID-DEV-ASSIST] ACCESS DENIED: user=${user_id} claimed_role=${role} verified_role=${verifiedRole} channel=developer_assistant`
        );

        await emitOasisEvent({
          vtid: 'VTID-DEV-ASSIST',
          type: 'conversation.turn.received',
          source: 'conversation-developer_assistant',
          status: 'error',
          message: `ACCESS DENIED: Non-developer user attempted developer_assistant channel`,
          payload: {
            request_id: requestId,
            user_id,
            tenant_id,
            claimed_role: role,
            verified_role: verifiedRole,
          },
        }).catch(() => {});

        return res.status(403).json({
          ok: false,
          error: 'FORBIDDEN',
          message: 'Access denied. The developer assistant is restricted to authorized developer accounts.',
        });
      }

      console.log(`[VTID-DEV-ASSIST] Access granted: user=${user_id} verified_role=${verifiedRole}`);
    }

    // VITANA-BRAIN: If brain flag is enabled, delegate entirely to brain and return early
    const { isVitanaBrainEnabled } = await import('../services/system-controls-service');
    const useBrain = await isVitanaBrainEnabled();
    if (useBrain) {
      console.log(`[VITANA-BRAIN] Routing conversation turn ${requestId} through brain`);
      const { processBrainTurn } = await import('../services/vitana-brain');
      const brainResult = await processBrainTurn({
        channel,
        tenant_id,
        user_id,
        role,
        message: message.text,
        message_type: message.type === 'voice_transcript' ? 'voice_transcript' : 'text',
        thread_id: input.thread_id,
        ui_context: ui_context ? { surface: ui_context.surface as any, screen: ui_context.screen, selection: ui_context.selection, metadata: ui_context.metadata } : undefined,
        vtid,
        display_name: (input as any).display_name,
      });
      return res.status(brainResult.ok ? 200 : 500).json({
        ok: brainResult.ok,
        response: brainResult.reply,
        thread_id: brainResult.thread_id,
        turn_number: brainResult.turn_number,
        context_pack: channel === 'operator' ? brainResult.context_pack : undefined,
        tool_calls: brainResult.tool_calls,
        meta: brainResult.meta,
        oasis_ref: brainResult.oasis_ref,
        error: brainResult.error,
      });
    }

    // VTID-01260: Generate conversation turn ID for event grouping
    const conversationTurnId = `turn-${requestId}`;

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
      // VTID-01260: Actor identification and surface tracking
      actor_id: user_id,
      actor_email: user_id, // user_id is typically the email
      actor_role: role === 'operator' ? 'operator' : 'user',
      surface: channel as 'orb' | 'operator',
      conversation_turn_id: conversationTurnId,
    }).catch(() => {});

    // Get or create conversation thread
    const thread = getOrCreateThread(input.thread_id, tenant_id, user_id, channel);
    thread.turn_count++;

    // VTID-01967: Resolve canonical Vitana ID handle (cached, ~free on hit).
    // Used both for tool-thread identity and for the system prompt below so
    // the assistant can answer "what is my user ID?" with the @handle.
    const vitanaId = await resolveVitanaId(user_id);

    // VTID-DEV-ASSIST: Set thread identity with role for tool-level role enforcement
    // VTID-01967: include vitana_id so downstream tools see the canonical handle.
    // VTID-02019: include user_timezone so recall_conversation_at_time resolves
    // free-text time hints in the user's local time (falls back to Europe/Berlin
    // when undefined).
    const reqUserTz =
      (req.body?.ui_context?.metadata?.timezone as string | undefined) || undefined;
    setThreadIdentity(thread.thread_id, {
      tenant_id,
      user_id,
      role,
      vitana_id: vitanaId,
      user_timezone: reqUserTz,
    });

    // Create context lens for memory access
    const lens: ContextLens = createContextLens(tenant_id, user_id, {
      workspace_scope: 'product',
      active_role: role,
    });

    // Step 1: Compute retrieval router decision
    const routerDecision = computeRetrievalRouterDecision(message.text, {
      channel,
      force_sources: options?.force_sources,
      limit_overrides: options?.limit_overrides as Record<'memory_garden' | 'knowledge_hub' | 'web_search', number> | undefined,
    });

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
      // VTID-01230: Session buffer lookup key
      session_id: thread.thread_id,
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
      // Extract user's preferred language from context pack facts
      const preferredLanguage = extractLanguageFromContextPack(contextPack);
      const languageDirective = buildLanguageDirective(preferredLanguage);

      // Build system instruction with context pack
      // VTID-DEV-ASSIST: Use developer_assistant personality for developer channel
      let channelInstructions = '';
      if (channel === 'developer_assistant') {
        const devConfig = getPersonalityConfigSync('developer_assistant');
        channelInstructions = `${devConfig.base_identity || ''}

${devConfig.purpose || ''}

${devConfig.guidelines || ''}

${devConfig.tools_section || ''}

${devConfig.important_section || ''}`;
      } else {
        channelInstructions = `Instructions:
- Use the memory context to personalize responses
- Use knowledge context for Vitana-specific questions
- Be concise but helpful
- For ORB (voice), keep responses conversational
- For Operator, you can be more detailed`;
      }

      // VTID-01967: Authoritative Vitana ID block — pinned to the system
      // prompt so the model answers identity questions with the @handle and
      // never the internal UUID. Mirrors the orb-live header pattern.
      const vitanaIdBlock = vitanaId
        ? `\n=== AUTHORITATIVE USER VITANA ID ===
The user's Vitana ID handle is: ${vitanaId}
This is the ONLY identifier you may share when the user asks "what is my user ID",
"what is my handle", "what is my Vitana ID", or "who am I". Do NOT speak the
internal UUID under any circumstance — it is a private system identifier.
=====================================\n`
        : `\n=== AUTHORITATIVE USER VITANA ID ===
No Vitana ID handle is provisioned for this session. If the user asks for their
user ID, handle, or Vitana ID, tell them honestly that their handle hasn't been
set up yet. Do NOT substitute an internal UUID.
=====================================\n`;

      const systemInstruction = `${channel === 'developer_assistant' ? '' : 'You are Vitana, an intelligent assistant. Respond helpfully and accurately based on the context provided.\n'}${languageDirective}
${vitanaIdBlock}
${contextForLLM}

Current conversation channel: ${channel}
User's role: ${role}

${channelInstructions}`;

      // Get tool definitions for the user's role
      const toolDefs = getGeminiToolDefinitions(role);

      // Process with Gemini
      // VTID-DEV-ASSIST: Pass role so tool definitions are filtered by authorization
      const geminiResult = await processWithGemini({
        text: message.text,
        systemInstruction,
        conversationHistory: thread.history.slice(-10), // Last 10 turns
        threadId: thread.thread_id,
        userRole: role,
      });

      reply = geminiResult.reply;
      modelUsed = 'gemini-2.5-pro'; // tracked: VTID-01216 Get from routing policy

      // Track conversation history for context continuity
      thread.history.push({ role: 'user', content: message.text });
      thread.history.push({ role: 'assistant', content: reply });

      // VTID-01230: Add turns to session buffer (Tier 0 short-term memory)
      addSessionTurn(thread.thread_id, tenant_id, user_id, 'user', message.text);
      addSessionTurn(thread.thread_id, tenant_id, user_id, 'assistant', reply);
      // VTID-01955: Dual-write to Memorystore Redis (multi-instance shared).
      addTurnRedis(thread.thread_id, tenant_id, user_id, 'user', message.text)
        .catch(() => { /* logged inside redis-turn-buffer */ });
      addTurnRedis(thread.thread_id, tenant_id, user_id, 'assistant', reply)
        .catch(() => { /* logged inside redis-turn-buffer */ });

      // Persist both messages to Supabase (fire-and-forget, non-blocking)
      persistMessage({
        thread_id: thread.thread_id,
        tenant_id,
        user_id,
        role: 'user',
        channel,
        content: message.text,
      }).catch(err => console.warn('[conversation] User message persist failed:', err.message));

      persistMessage({
        thread_id: thread.thread_id,
        tenant_id,
        user_id,
        role: 'assistant',
        channel,
        content: reply,
        metadata: {
          model: modelUsed,
          latency_ms: Date.now() - llmStartTime,
          tool_calls: toolCalls.length > 0 ? toolCalls.map(t => t.name) : undefined,
          turn_number: thread.turn_count,
        },
      }).catch(err => console.warn('[conversation] Assistant message persist failed:', err.message));

      // Prevent memory bloat by trimming to last 20 entries
      if (thread.history.length > 20) {
        thread.history = thread.history.slice(-20);
      }

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
        // VTID-01260: Actor identification and surface tracking
        actor_id: user_id,
        actor_email: user_id,
        surface: channel as 'orb' | 'operator',
        conversation_turn_id: conversationTurnId,
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
        // VTID-01260: Actor identification and surface tracking
        actor_id: user_id,
        actor_email: user_id,
        surface: channel as 'orb' | 'operator',
        conversation_turn_id: conversationTurnId,
      }).catch(() => {});

      reply = `I apologize, but I encountered an error processing your request. Please try again.`;
    }

    // Step 5: Auto-write USER message only to memory (not assistant reply)
    // VTID-01225-CLEANUP: Previously stored "User: X\nAssistant: Y" combined — this caused
    // massive pollution with assistant responses stored as user memory.
    // Now only stores the user's message with proper direction for shouldStoreInMemory filtering.
    try {
      const category = classifyCategory(message.text);
      await writeMemoryItemWithIdentity(
        { user_id, tenant_id },
        {
          content: message.text,
          source: channel === 'orb' ? 'orb_text' : 'orb_text',
          category_key: category || 'conversation',
          importance: 10,
          content_json: {
            direction: 'user',
            channel,
          },
        }
      );
    } catch (memoryError: any) {
      console.warn(`[VTID-01216] Memory write failed:`, memoryError.message);
    }

    // Step 6: VTID-01225 - Fire-and-forget fact extraction from conversation
    // Primary: Cognee extractor service (full entity/relationship/signal extraction)
    // Fallback: Inline Gemini extraction (structured facts only, no graph)
    const conversationText = `User: ${message.text}\nAssistant: ${reply}`;
    if (conversationText.length > 50) {
      if (cogneeExtractorClient.isEnabled()) {
        try {
          cogneeExtractorClient.extractAsync({
            transcript: conversationText,
            tenant_id,
            user_id,
            session_id: thread.thread_id,
            active_role: role,
          });
          console.log(`[VTID-01225] Cognee extraction queued for conversation turn: ${thread.thread_id}`);
        } catch (cogneeError: any) {
          console.warn(`[VTID-01225] Cognee extraction trigger failed:`, cogneeError.message);
        }
      }

      // VTID-01230: Deduplicated inline fact extraction (replaces raw extractAndPersistFacts)
      // Prevents redundant Gemini API calls when the same text is processed multiple times
      const extractResult = deduplicatedExtract({
        conversationText,
        tenant_id,
        user_id,
        session_id: thread.thread_id,
        turn_count: thread.turn_count,
      });
      if (extractResult.extracted) {
        console.log(`[VTID-01230] Fact extraction triggered for: ${thread.thread_id}`);
      } else {
        console.debug(`[VTID-01230] Extraction skipped: ${extractResult.skip_reason}`);
      }
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
      // VTID-01260: Actor identification and surface tracking
      actor_id: user_id,
      actor_email: user_id,
      actor_role: role === 'operator' ? 'operator' : 'user',
      surface: channel as 'orb' | 'operator',
      conversation_turn_id: conversationTurnId,
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
      // VTID-01260: Conversation turn ID for grouping
      conversation_turn_id: `turn-${requestId}`,
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

    // VTID-DEV-ASSIST: Block developer_assistant channel on stream endpoint too
    if (input.channel === 'developer_assistant') {
      const supabase = getSupabase();
      let verifiedRole: string | null = null;
      if (supabase && input.user_id && input.tenant_id) {
        try {
          const { data: membership } = await supabase
            .from('user_tenants')
            .select('active_role')
            .eq('user_id', input.user_id)
            .eq('tenant_id', input.tenant_id)
            .limit(1)
            .single();
          verifiedRole = membership?.active_role || null;
        } catch {}
      }
      if (!verifiedRole || !['developer', 'admin'].includes(verifiedRole)) {
        return res.status(403).json({
          ok: false,
          error: 'FORBIDDEN',
          message: 'Access denied. The developer assistant is restricted to authorized developer accounts.',
        });
      }
    }

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
      // VTID-01230: Session buffer lookup key
      session_id: thread.thread_id,
    };

    const contextPack = await buildContextPack(contextPackInput);
    const contextForLLM = formatContextPackForLLM(contextPack);

    // Extract user's preferred language from context pack facts
    const streamPreferredLanguage = extractLanguageFromContextPack(contextPack);
    const streamLanguageDirective = buildLanguageDirective(streamPreferredLanguage);

    // Build system instruction
    const systemInstruction = `You are Vitana, an intelligent voice assistant. Keep responses concise and conversational.
${streamLanguageDirective}
${contextForLLM}

Instructions:
- Be brief and natural for voice interaction
- Avoid long lists or complex formatting
- Be warm and helpful`;

    // Process with Gemini
    try {
      // VTID-DEV-ASSIST: Pass role for tool authorization filtering
      const geminiResult = await processWithGemini({
        text: input.message.text,
        systemInstruction,
        conversationHistory: [],
        threadId: thread.thread_id,
        userRole: input.role,
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

      // Persist both messages to Supabase (fire-and-forget, non-blocking)
      persistMessage({
        thread_id: thread.thread_id,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        role: 'user',
        channel: input.channel,
        content: input.message.text,
      }).catch(err => console.warn('[conversation] Stream user message persist failed:', err.message));

      persistMessage({
        thread_id: thread.thread_id,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        role: 'assistant',
        channel: input.channel,
        content: geminiResult.reply,
        metadata: { model: 'gemini-2.5-pro', turn_number: thread.turn_count },
      }).catch(err => console.warn('[conversation] Stream assistant message persist failed:', err.message));

      // VTID-01230: Session buffer + deduplicated extraction for streamed conversation
      addSessionTurn(thread.thread_id, input.tenant_id, input.user_id, 'user', input.message.text);
      addSessionTurn(thread.thread_id, input.tenant_id, input.user_id, 'assistant', geminiResult.reply);
      // VTID-01955: Dual-write to Memorystore Redis (multi-instance shared).
      addTurnRedis(thread.thread_id, input.tenant_id, input.user_id, 'user', input.message.text)
        .catch(() => { /* logged inside redis-turn-buffer */ });
      addTurnRedis(thread.thread_id, input.tenant_id, input.user_id, 'assistant', geminiResult.reply)
        .catch(() => { /* logged inside redis-turn-buffer */ });

      const streamedText = `User: ${input.message.text}\nAssistant: ${geminiResult.reply}`;
      if (streamedText.length > 50) {
        if (cogneeExtractorClient.isEnabled()) {
          cogneeExtractorClient.extractAsync({
            transcript: streamedText,
            tenant_id: input.tenant_id,
            user_id: input.user_id,
            session_id: thread.thread_id,
            active_role: input.role,
          });
        }
        deduplicatedExtract({
          conversationText: streamedText,
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          session_id: thread.thread_id,
          turn_count: thread.turn_count,
        });
      }

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
// GET /history/:threadId - Fetch persisted message history for a thread
// =============================================================================

router.get('/history/:threadId', async (req: Request, res: Response) => {
  const { threadId } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const before = req.query.before as string | undefined; // cursor-based pagination

  if (!threadId) {
    return res.status(400).json({ ok: false, error: 'threadId is required' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'Database not configured' });
  }

  try {
    let query = supabase
      .from('conversation_messages')
      .select('id, thread_id, role, channel, content, metadata, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[conversation] History fetch failed:', error.message);
      return res.status(500).json({ ok: false, error: 'Failed to fetch history' });
    }

    return res.status(200).json({
      ok: true,
      thread_id: threadId,
      messages: data || [],
      count: (data || []).length,
      has_more: (data || []).length === limit,
    });
  } catch (err: any) {
    console.error('[conversation] History fetch error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// =============================================================================
// GET /threads/active - Get user's most recent active thread
// =============================================================================

router.get('/threads/active', async (req: Request, res: Response) => {
  const tenant_id = req.query.tenant_id as string;
  const user_id = req.query.user_id as string;

  if (!tenant_id || !user_id) {
    return res.status(400).json({ ok: false, error: 'tenant_id and user_id are required' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'Database not configured' });
  }

  try {
    // Find the most recent thread by looking at the latest message per thread
    const { data, error } = await supabase
      .from('conversation_messages')
      .select('thread_id, created_at')
      .eq('tenant_id', tenant_id)
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('[conversation] Active thread fetch failed:', error.message);
      return res.status(500).json({ ok: false, error: 'Failed to fetch active thread' });
    }

    if (!data || data.length === 0) {
      return res.status(200).json({ ok: true, thread_id: null });
    }

    return res.status(200).json({
      ok: true,
      thread_id: data[0].thread_id,
      last_activity: data[0].created_at,
    });
  } catch (err: any) {
    console.error('[conversation] Active thread error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
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