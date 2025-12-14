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
 */

import fetch from 'node-fetch';
import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { AssistantContext, AssistantChatResponse } from '../types/assistant';

// Environment config
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

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
 * VTID-0150-B: Call Gemini API for assistant response
 */
async function callGemini(
  message: string,
  context: AssistantContext
): Promise<{ reply: string; tokens_in: number; tokens_out: number }> {
  if (!GOOGLE_GEMINI_API_KEY) {
    // Fallback response when Gemini is not configured
    console.warn('[VTID-0150-B] GOOGLE_GEMINI_API_KEY not configured, using fallback');
    return {
      reply: `I'm the Vitana Assistant. I received your message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"

Currently, the Gemini API is not configured. Once configured, I'll be able to provide intelligent responses to help you understand the Vitana system.

**Context I have:**
- Your role: ${context.role}
- Current route: ${context.route || 'Not specified'}
- Selected entity: ${context.selectedId || 'None'}

Please configure GOOGLE_GEMINI_API_KEY to enable full assistant capabilities.`,
      tokens_in: 0,
      tokens_out: 0
    };
  }

  const systemPrompt = buildSystemPrompt(context);

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: message }]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
      topP: 0.95,
      topK: 40
    }
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[VTID-0150-B] Gemini API error: ${response.status} - ${errorText}`);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const result = await response.json() as any;
    const candidate = result.candidates?.[0];
    const content = candidate?.content;

    if (!content) {
      return {
        reply: 'I apologize, but I could not generate a response. Please try again.',
        tokens_in: 0,
        tokens_out: 0
      };
    }

    // Extract text response
    const textPart = content.parts?.find((part: any) => part.text);
    const reply = textPart?.text || 'I could not generate a response.';

    // Extract token usage if available
    const usageMetadata = result.usageMetadata || {};
    const tokens_in = usageMetadata.promptTokenCount || 0;
    const tokens_out = usageMetadata.candidatesTokenCount || 0;

    return { reply, tokens_in, tokens_out };
  } catch (error: any) {
    console.error(`[VTID-0150-B] Gemini call failed:`, error.message);
    return {
      reply: `I encountered an error while processing your request. Please try again.

Error: ${error.message}`,
      tokens_in: 0,
      tokens_out: 0
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

    // Call Gemini
    const geminiResult = await callGemini(message, context);

    const latency_ms = Date.now() - startTime;
    const model = GOOGLE_GEMINI_API_KEY ? 'gemini-pro' : 'fallback';

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
