/**
 * VTID-0150-B: Assistant Core Service
 *
 * Provides Gemini-powered assistant capabilities for the Dev ORB.
 * This is the global assistant brain - read-only Q&A for VTID-0150-B.
 *
 * Key behaviors:
 * - No tools (pure Q&A / explanation)
 * - Safe, concise answers oriented to help developers understand the system
 * - OASIS event logging for assistant.session.started and assistant.turn
 *
 * VTID-0151-C: Updated to use Gemini API (AI Studio) with API key.
 * Uses gemini-3-pro-preview with fallback to gemini-2.5-pro.
 */

import { GoogleGenerativeAI, GenerateContentResult } from '@google/generative-ai';
import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { AssistantContext, AssistantChatResponse } from '../types/assistant';

// Gemini API configuration (AI Studio API key)
// NOTE: Lazy initialization - do NOT throw at import time!
// This allows the gateway to start even if Gemini is not configured.
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

// Model configuration with fallback
const PRIMARY_MODEL = 'gemini-3-pro-preview';
const FALLBACK_MODEL = 'gemini-2.5-pro';

// Lazy-initialized Gemini API client (created on first use)
let genAI: GoogleGenerativeAI | null = null;

/**
 * Get or create the Gemini API client (lazy initialization)
 * Throws only when Gemini is actually needed, not at startup
 */
function getGeminiClient(): GoogleGenerativeAI {
  if (!GEMINI_API_KEY) {
    throw new Error('GOOGLE_GEMINI_API_KEY not configured - Gemini API unavailable');
  }
  if (!genAI) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    console.log('[VTID-0150-B] Gemini API client initialized (lazy)');
  }
  return genAI;
}

// Track which model was used in the last request (for metadata)
let lastUsedModel = PRIMARY_MODEL;

// Track sessions to detect first turn
const activeSessions = new Set<string>();

/**
 * VTID-0150-B: System prompt for the global Vitana Assistant (Dev context)
 */
function buildSystemPrompt(context: AssistantContext): string {
  return `You are the Vitana Global Assistant, a helpful AI assistant for the Vitana development platform.

## Context
- **Role**: ${context.role} (Developer context)
- **Tenant**: ${context.tenant}
- **Current Route/Module**: ${context.route || 'Not specified'}
- **Selected Entity ID**: ${context.selectedId || 'None'}
- **Session ID**: ${context.sessionId}

## Your Purpose
You help developers understand and navigate the Vitana system. This includes:
- Explaining system architecture and components
- Answering questions about the codebase, features, and workflows
- Providing guidance on how to use the platform
- Clarifying concepts related to VTIDs, tasks, governance, and deployments

## Guidelines
1. Be concise and helpful - developers appreciate direct answers
2. Focus on explanations and guidance - do NOT execute actions or create tasks
3. You are read-only in this context - no side effects
4. When discussing code or technical concepts, be precise
5. If you don't know something, say so honestly
6. Reference specific VTIDs, modules, or features when relevant

## Important
- This is the Dev ORB assistant, NOT the Operator Chat
- You cannot create tasks, trigger deployments, or modify system state
- Your role is purely informational and educational

Answer the developer's question with clarity and precision.`;
}

/**
 * VTID-0151-C: Generate content with model fallback
 * Tries PRIMARY_MODEL first, falls back to FALLBACK_MODEL on error.
 */
async function generateWithFallback(
  prompt: string,
  systemPrompt: string
): Promise<GenerateContentResult> {
  // Get Gemini client (lazy init - throws if not configured)
  const client = getGeminiClient();

  try {
    console.log(`[VTID-0151-C] Trying primary model: ${PRIMARY_MODEL}`);
    const model = client.getGenerativeModel({
      model: PRIMARY_MODEL,
      systemInstruction: systemPrompt,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
        topP: 0.95,
        topK: 40
      }
    });
    lastUsedModel = PRIMARY_MODEL;
    return await model.generateContent(prompt);
  } catch (err: any) {
    console.warn(`[VTID-0151-C] Primary model (${PRIMARY_MODEL}) failed, falling back to ${FALLBACK_MODEL}:`, err.message);
    const fallback = client.getGenerativeModel({
      model: FALLBACK_MODEL,
      systemInstruction: systemPrompt,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
        topP: 0.95,
        topK: 40
      }
    });
    lastUsedModel = FALLBACK_MODEL;
    return await fallback.generateContent(prompt);
  }
}

/**
 * VTID-0150-B/VTID-0151-C: Call Gemini API for assistant response
 * Uses API key authentication with model fallback.
 */
async function callGemini(
  message: string,
  context: AssistantContext
): Promise<{ reply: string; tokens_in: number; tokens_out: number; model: string }> {
  const systemPrompt = buildSystemPrompt(context);

  try {
    console.log(`[VTID-0151-C] Calling Gemini API (primary=${PRIMARY_MODEL}, fallback=${FALLBACK_MODEL})`);

    // Generate content with fallback
    const result = await generateWithFallback(message, systemPrompt);

    const response = result.response;
    const candidate = response?.candidates?.[0];
    const content = candidate?.content;

    if (!content) {
      return {
        reply: 'I apologize, but I could not generate a response. Please try again.',
        tokens_in: 0,
        tokens_out: 0,
        model: lastUsedModel
      };
    }

    // Extract text response
    const reply =
      content.parts?.map((p: { text?: string }) => p.text).filter(Boolean).join('') ||
      'I could not generate a response.';

    // Extract token usage if available
    const usageMetadata = response?.usageMetadata;
    const tokens_in = usageMetadata?.promptTokenCount || 0;
    const tokens_out = usageMetadata?.candidatesTokenCount || 0;

    console.log(`[VTID-0151-C] Gemini API response received (model=${lastUsedModel}), tokens_in=${tokens_in}, tokens_out=${tokens_out}`);

    return { reply, tokens_in, tokens_out, model: lastUsedModel };
  } catch (error: any) {
    console.error(`[VTID-0151-C] Gemini API call failed:`, error.message);
    return {
      reply: `I encountered an error while processing your request. Please try again.

Error: ${error.message}`,
      tokens_in: 0,
      tokens_out: 0,
      model: 'error'
    };
  }
}

/**
 * VTID-0150-B: Log assistant session started event to OASIS
 */
async function logSessionStarted(context: AssistantContext): Promise<string | undefined> {
  const result = await emitOasisEvent({
    vtid: `VTID-0150-B`,
    type: 'assistant.session.started',
    source: 'assistant-core',
    status: 'info',
    message: `Assistant session started for ${context.role} on ${context.tenant}`,
    payload: {
      sessionId: context.sessionId,
      role: context.role,
      tenant: context.tenant,
      route: context.route,
      selectedId: context.selectedId
    }
  });

  return result.event_id;
}

/**
 * VTID-0150-B: Log assistant turn event to OASIS
 */
async function logAssistantTurn(
  context: AssistantContext,
  message: string,
  reply: string,
  model: string,
  tokens_in: number,
  tokens_out: number,
  latency_ms: number
): Promise<string | undefined> {
  const result = await emitOasisEvent({
    vtid: `VTID-0150-B`,
    type: 'assistant.turn',
    source: 'assistant-core',
    status: 'success',
    message: `Assistant turn completed (${latency_ms}ms, ${tokens_in + tokens_out} tokens)`,
    payload: {
      sessionId: context.sessionId,
      role: context.role,
      tenant: context.tenant,
      route: context.route,
      selectedId: context.selectedId,
      model,
      tokens_in,
      tokens_out,
      latency_ms,
      message_preview: message.substring(0, 100),
      reply_preview: reply.substring(0, 100)
    }
  });

  return result.event_id;
}

/**
 * VTID-0150-B: Process an assistant chat message
 *
 * Main entry point for the Assistant Core.
 * Handles session tracking, Gemini calls, and OASIS logging.
 */
export async function processAssistantMessage(
  message: string,
  sessionId: string | null | undefined,
  role: string,
  tenant: string,
  route: string,
  selectedId: string
): Promise<AssistantChatResponse> {
  const startTime = Date.now();

  // Generate or use provided sessionId
  const finalSessionId = sessionId || randomUUID();
  const isNewSession = !activeSessions.has(finalSessionId);

  const context: AssistantContext = {
    sessionId: finalSessionId,
    role,
    tenant,
    route,
    selectedId
  };

  console.log(`[VTID-0150-B] Processing assistant message, session=${finalSessionId}, new=${isNewSession}`);

  try {
    // Log session started if this is a new session
    if (isNewSession) {
      activeSessions.add(finalSessionId);
      await logSessionStarted(context);
      console.log(`[VTID-0150-B] New session started: ${finalSessionId}`);
    }

    // Call Gemini API with fallback
    const geminiResult = await callGemini(message, context);

    const latency_ms = Date.now() - startTime;
    const model = geminiResult.model; // VTID-0151-C: Now using Gemini API with fallback

    // Log the turn
    const turnEventId = await logAssistantTurn(
      context,
      message,
      geminiResult.reply,
      model,
      geminiResult.tokens_in,
      geminiResult.tokens_out,
      latency_ms
    );

    console.log(`[VTID-0150-B] Turn completed in ${latency_ms}ms, oasis_ref=${turnEventId}`);

    return {
      ok: true,
      reply: geminiResult.reply,
      sessionId: finalSessionId,
      oasis_ref: turnEventId || randomUUID(),
      meta: {
        model,
        tokens_in: geminiResult.tokens_in,
        tokens_out: geminiResult.tokens_out,
        latency_ms
      }
    };
  } catch (error: any) {
    console.error(`[VTID-0150-B] Assistant processing error:`, error);

    const latency_ms = Date.now() - startTime;

    return {
      ok: false,
      reply: 'I encountered an error while processing your request. Please try again.',
      sessionId: finalSessionId,
      oasis_ref: randomUUID(),
      meta: {
        model: 'error',
        tokens_in: 0,
        tokens_out: 0,
        latency_ms
      },
      error: error.message
    };
  }
}
