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
 * VTID-0151-C: Updated to use Vertex AI with ADC (Application Default Credentials)
 * via Cloud Run service account instead of API key.
 */

import { VertexAI } from '@google-cloud/vertexai';
import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { AssistantContext, AssistantChatResponse } from '../types/assistant';

// Vertex AI configuration (ADC via Cloud Run SA)
const VERTEX_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.PROJECT_ID ||
  'lovable-vitana-vers1';

const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

// Model to use - gemini-1.5-flash for fast, cost-effective responses
const VERTEX_MODEL = process.env.VERTEX_MODEL || 'gemini-1.5-flash';

// Singleton Vertex AI client (uses ADC automatically on Cloud Run)
const vertex = new VertexAI({ project: VERTEX_PROJECT, location: VERTEX_LOCATION });

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
 * VTID-0150-B/VTID-0151-C: Call Vertex AI Gemini for assistant response
 * Uses ADC (Application Default Credentials) via Cloud Run service account.
 */
async function callGemini(
  message: string,
  context: AssistantContext
): Promise<{ reply: string; tokens_in: number; tokens_out: number }> {
  const systemPrompt = buildSystemPrompt(context);

  try {
    console.log(`[VTID-0151-C] Calling Vertex AI model=${VERTEX_MODEL}, project=${VERTEX_PROJECT}, location=${VERTEX_LOCATION}`);

    // Get the generative model from Vertex AI
    const model = vertex.getGenerativeModel({
      model: VERTEX_MODEL,
      systemInstruction: systemPrompt,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
        topP: 0.95,
        topK: 40
      }
    });

    // Generate content
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: message }] }]
    });

    const response = result.response;
    const candidate = response?.candidates?.[0];
    const content = candidate?.content;

    if (!content) {
      return {
        reply: 'I apologize, but I could not generate a response. Please try again.',
        tokens_in: 0,
        tokens_out: 0
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

    console.log(`[VTID-0151-C] Vertex AI response received, tokens_in=${tokens_in}, tokens_out=${tokens_out}`);

    return { reply, tokens_in, tokens_out };
  } catch (error: any) {
    console.error(`[VTID-0151-C] Vertex AI call failed:`, error.message);
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
    const model = VERTEX_MODEL; // VTID-0151-C: Now using Vertex AI

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
