/**
 * DEV-COMHU-2025-0014: ORB Multimodal v1 - Live Voice Session
 * VTID-0135: ORB Voice Conversation Enablement (Phase A)
 * VTID-01106: ORB Memory Bridge (Dev Sandbox)
 * VTID-01107: ORB Memory Debug Endpoint (Dev Sandbox)
 * VTID-01113: Intent Detection & Classification Engine (D21)
 * VTID-01118: Cross-Turn State & Continuity Engine (D26)
 *
 * SSE endpoint for real-time voice interaction with Gemini API.
 *
 * Endpoints:
 * - GET  /api/v1/orb/live         - SSE stream for real-time responses
 * - POST /api/v1/orb/audio        - Audio chunk submission
 * - POST /api/v1/orb/start        - Start live session
 * - POST /api/v1/orb/stop         - Stop live session
 * - POST /api/v1/orb/mute         - Toggle mute state
 * - POST /api/v1/orb/chat         - VTID-0135: Voice conversation chat (Vertex routing)
 * - GET  /api/v1/orb/debug/memory - VTID-01107: Memory debug endpoint (dev-sandbox only)
 * - GET  /api/v1/orb/debug/intent - VTID-01113: Intent debug endpoint (dev-sandbox only)
 * - GET  /api/v1/orb/health       - Health check
 *
 * VTID-0135 Changes:
 * - Added POST /api/v1/orb/chat endpoint using Vertex routing (same as Operator Console)
 * - Added OASIS event emission for ORB sessions and turns
 * - Added conversation_id continuity support
 *
 * VTID-01106 Changes:
 * - ORB Memory Bridge integration for dev sandbox
 * - Memory context injection into system instructions
 * - User identity and conversation context persistence
 *
 * VTID-01107 Changes:
 * - Added GET /api/v1/orb/debug/memory endpoint for memory debugging
 * - Dev-sandbox only (returns 404 in other environments)
 * - Emits orb.memory.debug_requested and orb.memory.debug_snapshot events
 *
 * IMPORTANT:
 * - POST /orb/chat uses Vertex AI routing (same as Operator Console)
 * - Other endpoints still use direct Gemini API
 * - READ-ONLY: No state mutation, no tool execution
 * - CSP compliant: No inline scripts/styles
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { processWithGemini } from '../services/gemini-operator';
import { emitOasisEvent } from '../services/oasis-event-service';
// VTID-01149: Unified Task-Creation Intake
import {
  detectTaskCreationIntent,
  hasActiveIntake,
  getIntakeState,
  startIntake,
  processIntakeAnswer,
  getNextQuestion,
  completeIntakeAndSchedule,
  looksLikeAnswer,
  generateIntakeStartMessage,
  INTAKE_QUESTIONS
} from '../services/task-intake-service';
// VTID-01105: Memory auto-write for ORB conversations
import { writeMemoryItem, classifyCategory } from './memory';
// VTID-01106: ORB Memory Bridge (Dev Sandbox)
// VTID-01107: ORB Memory Debug Endpoint + Dev Memory Write
import {
  isMemoryBridgeEnabled,
  isDevSandbox,
  fetchDevMemoryContext,
  buildMemoryEnhancedInstruction,
  getDebugSnapshot,
  writeDevMemoryItem,
  DEV_IDENTITY,
  MEMORY_CONFIG,
  OrbMemoryContext
} from '../services/orb-memory-bridge';
// VTID-01112: Context Assembly Engine (D20 Core Intelligence)
import {
  getOrbContext,
  formatContextForPrompt,
  ContextBundle
} from '../services/context-assembly-engine';
// VTID-01113: Intent Detection & Classification Engine (D21)
import {
  detectIntent,
  logIntentToOasis,
  logAmbiguousIntentWarning,
  logSafetyFlaggedIntent,
  buildConversationSignal,
  buildContextSignalFromMemory,
  getIntentDebugInfo,
  IntentBundle,
  IntentDetectionInput,
  ActiveRole,
  InteractionMode
} from '../services/intent-detection-engine';
// VTID-01114: Domain & Topic Routing Engine (D22)
import {
  computeRoutingBundle,
  getRoutingSummary,
  emitRoutingEvent
} from '../services/domain-routing-service';
import { RoutingInput, RoutingBundle } from '../types/domain-routing';
// VTID-01118: Cross-Turn State & Continuity Engine
import {
  getStateEngine,
  removeStateEngine,
  detectIntentType,
  detectDomainType,
  extractVtidMentions,
  CrossTurnStateEngine,
  StateUpdateInput
} from '../services/cross-turn-state-engine';
// VTID-01153: Memory Indexer Client (Mem0 OSS)
import {
  isMemoryIndexerEnabled,
  writeToMemoryIndexer,
  searchMemoryIndexer,
  getMemoryContext,
  buildMemoryIndexerEnhancedInstruction
} from '../services/memory-indexer-client';

const router = Router();

// =============================================================================
// Types & Constants
// =============================================================================

interface OrbLiveSession {
  sessionId: string;
  tenant: string;
  role: string;
  route: string;
  selectedId: string;
  muted: boolean;
  active: boolean;
  createdAt: Date;
  lastActivity: Date;
  audioChunksReceived: number;
  sseResponse: Response | null;
}

interface StartMessage {
  type: 'start';
  sessionId?: string;
  tenant: string;
  role: string;
  route: string;
  selectedId?: string;
  response?: { modalities: string[] };
}

interface AudioChunkMessage {
  type: 'audio_chunk';
  sessionId: string;
  mime: string;
  data_b64: string;
}

interface MuteMessage {
  type: 'mute';
  sessionId: string;
  muted: boolean;
}

interface StopMessage {
  type: 'stop';
  sessionId: string;
}

// In-memory session store (dev sandbox only)
const sessions = new Map<string, OrbLiveSession>();

// Session timeout: 30 minutes
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Allowed origins (dev sandbox)
const ALLOWED_ORIGINS = [
  'https://gateway-536750820055.us-central1.run.app',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3000'
];

// Connection limit per IP (dev sandbox)
const MAX_CONNECTIONS_PER_IP = 5;
const connectionCountByIP = new Map<string, number>();

// Gemini API configuration
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.0-flash-exp';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// =============================================================================
// VTID-0135: Voice Conversation Types & Stores
// =============================================================================

/**
 * VTID-0135: ORB Chat Request (voice conversation)
 */
interface OrbChatRequest {
  orb_session_id: string;
  conversation_id: string | null;
  input_text: string;
  meta?: {
    mode?: string;
    source?: string;
    vtid?: string | null;
  };
}

/**
 * VTID-0135: ORB Chat Response
 * VTID-01106: Extended with memory debug info
 * VTID-01114: Extended with routing debug info
 */
interface OrbChatResponse {
  ok: boolean;
  conversation_id: string;
  reply_text: string;
  meta: {
    provider: string;
    model: string;
    mode: string;
    vtid?: string;
    // VTID-01106: Memory debug info
    memory_bridge_enabled?: boolean;
    memory_context_ok?: boolean;
    memory_items_count?: number;
    memory_injected?: boolean;
    // VTID-01114: Domain routing info
    routing?: {
      primary_domain: string;
      secondary_domains: string[];
      routing_confidence: number;
      active_topics: string[];
      safety_flags: string[];
      autonomy_level: number;
      allows_commerce: boolean;
      determinism_key: string;
    };
  };
  error?: string;
}

/**
 * VTID-0135: Conversation context for continuity
 * VTID-01118: Added turn_count for cross-turn state tracking
 */
interface OrbConversation {
  conversationId: string;
  orbSessionId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: Date;
  lastActivity: Date;
  turn_count: number;  // VTID-01118: Track turns for state engine
}

// VTID-0135: In-memory conversation store (session-scoped)
const orbConversations = new Map<string, OrbConversation>();

// VTID-0135: Conversation timeout
// VTID-01109: Extended from 30 minutes to 24 hours for better conversation continuity
const CONVERSATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

// =============================================================================
// VTID-01039: ORB Session Transcript Store
// =============================================================================

/**
 * VTID-01039: Transcript turn for persisted storage
 */
interface OrbTranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

/**
 * VTID-01039: Persisted transcript for ORB session
 */
interface OrbSessionTranscript {
  orb_session_id: string;
  conversation_id: string | null;
  turns: OrbTranscriptTurn[];
  started_at: string;
  finalized: boolean;
  summary?: {
    title: string;
    bullets: string[];
    actions: string[];
    turns_count: number;
    duration_sec: number;
  };
}

// VTID-01039: In-memory transcript store
const orbTranscripts = new Map<string, OrbSessionTranscript>();

/**
 * VTID-01039: Cleanup expired transcripts (retain for 1 hour after finalization)
 */
function cleanupExpiredTranscripts(): void {
  const now = Date.now();
  const TRANSCRIPT_RETENTION_MS = 60 * 60 * 1000; // 1 hour

  for (const [sessionId, transcript] of orbTranscripts.entries()) {
    if (transcript.finalized) {
      const startedAt = new Date(transcript.started_at).getTime();
      if (now - startedAt > TRANSCRIPT_RETENTION_MS) {
        console.log(`[VTID-01039] Transcript expired: ${sessionId}`);
        orbTranscripts.delete(sessionId);
      }
    }
  }
}

// Cleanup expired transcripts every 10 minutes
setInterval(cleanupExpiredTranscripts, 10 * 60 * 1000);

/**
 * VTID-0135: Cleanup expired conversations
 */
function cleanupExpiredConversations(): void {
  const now = Date.now();
  for (const [convId, conv] of orbConversations.entries()) {
    if (now - conv.lastActivity.getTime() > CONVERSATION_TIMEOUT_MS) {
      console.log(`[VTID-0135] Conversation expired: ${convId}`);
      orbConversations.delete(convId);
    }
  }
}

// Cleanup expired conversations every 5 minutes
setInterval(cleanupExpiredConversations, 5 * 60 * 1000);

// =============================================================================
// VTID-0135: OASIS Event Emission for ORB
// =============================================================================

/**
 * VTID-0135: Emit orb.session.started event
 */
async function emitOrbSessionStarted(orbSessionId: string, conversationId: string): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.session.started',
    source: 'command-hub',
    status: 'info',
    message: `ORB voice session started: ${orbSessionId}`,
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-0135] Failed to emit orb.session.started:', err.message));
}

/**
 * VTID-0135: Emit orb.turn.received event
 */
async function emitOrbTurnReceived(
  orbSessionId: string,
  conversationId: string,
  inputText: string
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.turn.received',
    source: 'command-hub',
    status: 'info',
    message: `ORB turn received: ${inputText.substring(0, 50)}...`,
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      input_length: inputText.length,
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-0135] Failed to emit orb.turn.received:', err.message));
}

/**
 * VTID-0135: Emit orb.turn.responded event
 */
async function emitOrbTurnResponded(
  orbSessionId: string,
  conversationId: string,
  replyText: string,
  provider: string
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.turn.responded',
    source: 'command-hub',
    status: 'success',
    message: `ORB turn responded via ${provider}`,
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      reply_length: replyText.length,
      provider,
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-0135] Failed to emit orb.turn.responded:', err.message));
}

/**
 * VTID-0135: Emit orb.session.ended event
 */
async function emitOrbSessionEnded(orbSessionId: string, conversationId: string): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.session.ended',
    source: 'command-hub',
    status: 'info',
    message: `ORB voice session ended: ${orbSessionId}`,
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-0135] Failed to emit orb.session.ended:', err.message));
}

// =============================================================================
// Helpers
// =============================================================================

function validateOrigin(req: Request): boolean {
  const origin = req.get('origin') || req.get('referer') || '';
  if (!origin) return true; // Allow requests without origin (e.g., curl)
  return ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed));
}

/**
 * VTID-01105: Extract Bearer token from Authorization header
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * VTID-01105: Emit memory write OASIS event
 */
async function emitMemoryWriteEvent(
  eventType: 'memory.write.user_message' | 'memory.write.assistant_message',
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01105',
    type: eventType as any,
    source: 'orb-memory-auto',
    status: 'success',
    message: `ORB ${eventType.includes('user') ? 'user' : 'assistant'} message written to memory`,
    payload
  }).catch(err => console.warn(`[VTID-01105] Failed to emit ${eventType}:`, err.message));
}

function getClientIP(req: Request): string {
  return (req.get('x-forwarded-for') || req.ip || 'unknown').split(',')[0].trim();
}

function checkConnectionLimit(ip: string): boolean {
  const count = connectionCountByIP.get(ip) || 0;
  return count < MAX_CONNECTIONS_PER_IP;
}

function incrementConnection(ip: string): void {
  const count = connectionCountByIP.get(ip) || 0;
  connectionCountByIP.set(ip, count + 1);
}

function decrementConnection(ip: string): void {
  const count = connectionCountByIP.get(ip) || 0;
  if (count > 0) {
    connectionCountByIP.set(ip, count - 1);
  }
}

function generateSystemInstruction(session: OrbLiveSession): string {
  return `You are VITANA ORB, a voice-first multimodal assistant.

Context:
- tenant: ${session.tenant}
- role: ${session.role}
- route: ${session.route}
- selectedId: ${session.selectedId || 'none'}

Operating mode:
- Voice conversation is primary.
- Always listening while ORB overlay is open.
- Read-only: do not mutate system state.
- Be concise, contextual, and helpful.`;
}

/**
 * VTID-01106: Generate memory-enhanced system instruction for ORB chat
 * Fetches user memory context and injects it into the system prompt
 *
 * BUG FIX: Now returns different base instructions depending on whether memory is available.
 * Previously claimed "persistent memory" even when none was available, confusing the LLM.
 *
 * VTID-01112: Now uses Context Assembly Engine for unified, ranked context.
 * ORB no longer accesses raw memory tables directly.
 */
async function generateMemoryEnhancedSystemInstruction(
  session: { tenant: string; role: string; route?: string; selectedId?: string }
): Promise<{ instruction: string; memoryContext: OrbMemoryContext | null; contextBundle?: ContextBundle }> {
  // Base instruction WITHOUT memory claims (used when memory is unavailable)
  const baseInstructionNoMemory = `You are VITANA ORB, a voice-first multimodal assistant.

Context:
- tenant: ${session.tenant}
- role: ${session.role}
- route: ${session.route || 'unknown'}
- selectedId: ${session.selectedId || 'none'}

Operating mode:
- Voice conversation is primary.
- Always listening while ORB overlay is open.
- Read-only: do not mutate system state.
- Be concise, contextual, and helpful.`;

  // Base instruction WITH memory claims (used when memory IS available)
  const baseInstructionWithMemory = `You are VITANA ORB, a voice-first multimodal assistant with persistent memory.

Context:
- tenant: ${session.tenant}
- role: ${session.role}
- route: ${session.route || 'unknown'}
- selectedId: ${session.selectedId || 'none'}

Operating mode:
- Voice conversation is primary.
- Always listening while ORB overlay is open.
- Read-only: do not mutate system state.
- Be concise, contextual, and helpful.
- You have PERSISTENT MEMORY - you remember users across sessions.
- NEVER claim you cannot remember or that your memory resets.`;

  // VTID-01153: Try memory-indexer first (Mem0 OSS)
  if (isMemoryIndexerEnabled()) {
    console.log('[VTID-01153] Memory indexer enabled, fetching context from Mem0');
    try {
      const mem0Result = await buildMemoryIndexerEnhancedInstruction(
        baseInstructionWithMemory,
        DEV_IDENTITY.USER_ID,
        'general conversation context' // Query for broad context
      );

      if (mem0Result.contextChars > 0) {
        console.log(`[VTID-01153] Memory indexer context injected: ${mem0Result.contextChars} chars`);
        return {
          instruction: mem0Result.instruction,
          memoryContext: null // Using Mem0 format instead of legacy
        };
      } else {
        console.log('[VTID-01153] Memory indexer returned empty context, falling back');
      }
    } catch (err: any) {
      console.warn('[VTID-01153] Memory indexer error, falling back:', err.message);
    }
  }

  // Check if memory bridge is enabled (legacy Supabase-based memory)
  if (!isMemoryBridgeEnabled()) {
    console.log('[VTID-01106] Memory bridge disabled, using base instruction (no memory claims)');
    return { instruction: baseInstructionNoMemory, memoryContext: null };
  }

  try {
    // VTID-01112: Use Context Assembly Engine instead of raw memory access
    // This ensures all downstream intelligence uses ranked, unified context
    const contextResult = await getOrbContext(
      DEV_IDENTITY.USER_ID,
      DEV_IDENTITY.TENANT_ID,
      DEV_IDENTITY.ACTIVE_ROLE,
      'conversation' // ORB default intent
    );

    if (!contextResult.ok || !contextResult.bundle) {
      console.log(`[VTID-01112] Context assembly failed: ${contextResult.error}`);
      // Fallback to legacy memory bridge
      const memoryContext = await fetchDevMemoryContext();
      if (!memoryContext.ok || memoryContext.items.length === 0) {
        return { instruction: baseInstructionNoMemory, memoryContext };
      }
      const enhancedInstruction = buildMemoryEnhancedInstruction(baseInstructionWithMemory, memoryContext);
      return { instruction: enhancedInstruction, memoryContext };
    }

    const bundle = contextResult.bundle;

    if (bundle.top_memories.length === 0 && bundle.long_term_patterns.length === 0) {
      console.log('[VTID-01112] No context items found for user');
      return { instruction: baseInstructionNoMemory, memoryContext: null, contextBundle: bundle };
    }

    // Format context bundle for prompt injection
    const contextForPrompt = formatContextForPrompt(bundle);

    // Build enhanced instruction with context bundle
    const enhancedInstruction = `${baseInstructionWithMemory}

## CRITICAL: You Have Persistent Memory About This User

You have access to PERSISTENT MEMORY that contains REAL information from previous conversations with THIS SPECIFIC USER. This is NOT hypothetical - this is ACTUAL stored data about them.

**MANDATORY RULES - FOLLOW THESE EXACTLY:**
1. NEVER say "I don't remember", "ich erinnere mich nicht", "I don't have information about your name/hometown/etc."
2. When the user asks about their name, hometown, or ANY personal detail - CHECK THE CONTEXT BELOW FIRST
3. If the information IS in your context, ANSWER WITH THAT INFORMATION
4. Only say "I don't have that information yet" if it's truly NOT in the context below

**STORING NEW INFORMATION - CRITICAL:**
5. When the user tells you NEW personal information (name, birthday, family member's birthday, preferences, etc.), the system AUTOMATICALLY STORES IT in persistent memory.
6. NEVER say "I cannot store this", "ich kann nicht speichern", or "I don't have the ability to save". The system DOES store it automatically.
7. When the user provides new info, ACKNOWLEDGE it positively: "Got it, I'll remember that" / "Notiert!" / "Ich merke mir das"
8. Treat every piece of personal information the user shares as something you WILL remember in future conversations.

---
${contextForPrompt}
---

You KNOW this user. You REMEMBER their name, their hometown, their family. Answer their questions using the context above.`;

    console.log(`[VTID-01112] Context-enhanced instruction generated with ${bundle.traceability.total_items_included} items (bundle=${bundle.bundle_id})`);

    // Return with context bundle for traceability
    return {
      instruction: enhancedInstruction,
      memoryContext: null, // No longer using legacy format
      contextBundle: bundle
    };
  } catch (err: any) {
    console.warn('[VTID-01112] Context assembly error:', err.message);
    // Fallback to legacy memory bridge
    try {
      const memoryContext = await fetchDevMemoryContext();
      if (!memoryContext.ok || memoryContext.items.length === 0) {
        return { instruction: baseInstructionNoMemory, memoryContext };
      }
      const enhancedInstruction = buildMemoryEnhancedInstruction(baseInstructionWithMemory, memoryContext);
      return { instruction: enhancedInstruction, memoryContext };
    } catch {
      return { instruction: baseInstructionNoMemory, memoryContext: null };
    }
  }
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
      console.log(`[ORB-LIVE] Session expired: ${sessionId}`);
      if (session.sseResponse) {
        try {
          session.sseResponse.end();
        } catch (e) {
          // Ignore
        }
      }
      sessions.delete(sessionId);
    }
  }
}

// Cleanup expired sessions every 5 minutes
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

/**
 * Call Gemini API with audio transcription request
 * Uses Gemini API directly (NOT Vertex)
 * VTID-01107: Now includes memory context injection for dev-sandbox
 */
async function callGeminiWithAudio(
  session: OrbLiveSession,
  audioBase64: string,
  mimeType: string
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!GEMINI_API_KEY) {
    return { ok: false, error: 'GOOGLE_GEMINI_API_KEY not configured' };
  }

  try {
    // VTID-01107: Use memory-enhanced system instruction in dev-sandbox
    let systemInstruction: string;
    if (isDevSandbox()) {
      const { instruction, memoryContext } = await generateMemoryEnhancedSystemInstruction({
        tenant: session.tenant,
        role: session.role,
        route: session.route,
        selectedId: session.selectedId
      });
      systemInstruction = instruction;
      if (memoryContext && memoryContext.ok && memoryContext.items.length > 0) {
        console.log(`[VTID-01107] Memory injected into /audio: ${memoryContext.items.length} items`);
      }
    } else {
      systemInstruction = generateSystemInstruction(session);
    }

    // Build request for Gemini API
    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inline_data: {
                mime_type: mimeType === 'audio/pcm;rate=16000' ? 'audio/wav' : mimeType,
                data: audioBase64
              }
            },
            {
              text: 'Please respond to this voice input. Be concise and helpful.'
            }
          ]
        }
      ],
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 256,
        topP: 0.9
      }
    };

    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ORB-LIVE] Gemini API error: ${response.status} - ${errorText}`);
      return { ok: false, error: `Gemini API error: ${response.status}` };
    }

    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

    // Extract text from response
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!text) {
      return { ok: false, error: 'No response from Gemini' };
    }

    return { ok: true, text };
  } catch (error: any) {
    console.error(`[ORB-LIVE] Gemini API call failed:`, error);
    return { ok: false, error: error.message || 'Failed to call Gemini API' };
  }
}

/**
 * Call Gemini API with text input (for testing/fallback)
 * VTID-01107: Now includes memory context injection for dev-sandbox
 */
async function callGeminiWithText(
  session: OrbLiveSession,
  userText: string
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!GEMINI_API_KEY) {
    return { ok: false, error: 'GOOGLE_GEMINI_API_KEY not configured' };
  }

  try {
    // VTID-01107: Use memory-enhanced system instruction in dev-sandbox
    let systemInstruction: string;
    if (isDevSandbox()) {
      const { instruction, memoryContext } = await generateMemoryEnhancedSystemInstruction({
        tenant: session.tenant,
        role: session.role,
        route: session.route,
        selectedId: session.selectedId
      });
      systemInstruction = instruction;
      if (memoryContext && memoryContext.ok && memoryContext.items.length > 0) {
        console.log(`[VTID-01107] Memory injected into /text: ${memoryContext.items.length} items`);
      }
    } else {
      systemInstruction = generateSystemInstruction(session);
    }

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [{ text: userText }]
        }
      ],
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 256,
        topP: 0.9
      }
    };

    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ORB-LIVE] Gemini API error: ${response.status} - ${errorText}`);
      return { ok: false, error: `Gemini API error: ${response.status}` };
    }

    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!text) {
      return { ok: false, error: 'No response from Gemini' };
    }

    return { ok: true, text };
  } catch (error: any) {
    console.error(`[ORB-LIVE] Gemini API call failed:`, error);
    return { ok: false, error: error.message || 'Failed to call Gemini API' };
  }
}

// =============================================================================
// Routes
// =============================================================================

/**
 * GET /live - SSE endpoint for real-time responses
 */
router.get('/live', (req: Request, res: Response) => {
  console.log('[ORB-LIVE] SSE connection request');

  // Validate origin
  if (!validateOrigin(req)) {
    console.warn('[ORB-LIVE] Origin not allowed:', req.get('origin'));
    return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }

  // Check connection limit
  const clientIP = getClientIP(req);
  if (!checkConnectionLimit(clientIP)) {
    console.warn('[ORB-LIVE] Connection limit exceeded for IP:', clientIP);
    return res.status(429).json({ ok: false, error: 'Too many connections' });
  }

  // Get session ID from query
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: 'sessionId required' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  // Setup SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Track connection
  incrementConnection(clientIP);
  session.sseResponse = res;
  session.lastActivity = new Date();

  // Send ready event
  res.write(`data: ${JSON.stringify({ type: 'ready', meta: { model: GEMINI_MODEL } })}\n\n`);

  // Heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch (e) {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[ORB-LIVE] SSE connection closed for session: ${sessionId}`);
    clearInterval(heartbeatInterval);
    decrementConnection(clientIP);
    if (session.sseResponse === res) {
      session.sseResponse = null;
    }
  });
});

/**
 * POST /start - Start a new live session
 */
router.post('/start', (req: Request, res: Response) => {
  console.log('[ORB-LIVE] POST /start');

  // Validate origin
  if (!validateOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }

  const body = req.body as StartMessage;

  if (!body.tenant || !body.role || !body.route) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: tenant, role, route'
    });
  }

  // Generate or use provided session ID
  const sessionId = body.sessionId || `orb-${randomUUID()}`;

  // Create session
  const session: OrbLiveSession = {
    sessionId,
    tenant: body.tenant,
    role: body.role,
    route: body.route,
    selectedId: body.selectedId || '',
    muted: false,
    active: true,
    createdAt: new Date(),
    lastActivity: new Date(),
    audioChunksReceived: 0,
    sseResponse: null
  };

  sessions.set(sessionId, session);

  console.log(`[ORB-LIVE] Session created: ${sessionId}`);

  return res.status(200).json({
    ok: true,
    sessionId,
    meta: { model: GEMINI_MODEL }
  });
});

/**
 * POST /audio - Submit audio chunk
 */
router.post('/audio', async (req: Request, res: Response) => {
  const body = req.body as AudioChunkMessage;

  if (!body.sessionId || !body.data_b64) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: sessionId, data_b64'
    });
  }

  const session = sessions.get(body.sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ ok: false, error: 'Session not active' });
  }

  if (session.muted) {
    return res.status(200).json({ ok: true, muted: true });
  }

  // Update activity
  session.lastActivity = new Date();
  session.audioChunksReceived++;

  const mime = body.mime || 'audio/pcm;rate=16000';

  // Process audio with Gemini
  console.log(`[ORB-LIVE] Processing audio chunk for session: ${body.sessionId}, chunk #${session.audioChunksReceived}`);

  const result = await callGeminiWithAudio(session, body.data_b64, mime);

  if (result.ok && result.text) {
    // Send response via SSE if connected
    if (session.sseResponse) {
      try {
        session.sseResponse.write(`data: ${JSON.stringify({ type: 'assistant_text', text: result.text })}\n\n`);
      } catch (e) {
        console.error('[ORB-LIVE] Failed to send SSE response:', e);
      }
    }

    return res.status(200).json({
      ok: true,
      text: result.text
    });
  } else {
    // Send error via SSE if connected
    if (session.sseResponse) {
      try {
        session.sseResponse.write(`data: ${JSON.stringify({ type: 'error', message: result.error })}\n\n`);
      } catch (e) {
        // Ignore
      }
    }

    return res.status(200).json({
      ok: false,
      error: result.error
    });
  }
});

/**
 * POST /text - Submit text message (fallback/testing)
 * VTID-01125: Updated to use Vertex AI via processWithGemini (same as /chat)
 */
router.post('/text', async (req: Request, res: Response) => {
  const body = req.body as { sessionId: string; text: string };

  if (!body.sessionId || !body.text) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: sessionId, text'
    });
  }

  const session = sessions.get(body.sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ ok: false, error: 'Session not active' });
  }

  // Update activity
  session.lastActivity = new Date();

  console.log(`[ORB-LIVE] Processing text for session: ${body.sessionId}`);

  try {
    // VTID-01125: Use processWithGemini (Vertex AI) instead of direct Gemini API
    // This uses the same routing as /chat: Vertex AI (ADC) > Gemini API > Local
    const threadId = `orb-text-${body.sessionId}`;

    // VTID-01107: Use memory-enhanced system instruction in dev-sandbox
    let systemInstruction: string;
    if (isDevSandbox()) {
      const { instruction } = await generateMemoryEnhancedSystemInstruction({
        tenant: session.tenant,
        role: session.role,
        route: session.route,
        selectedId: session.selectedId
      });
      systemInstruction = instruction;
    } else {
      systemInstruction = generateSystemInstruction(session);
    }

    const geminiResponse = await processWithGemini({
      text: body.text,
      threadId,
      systemInstruction
    });

    const replyText = geminiResponse.reply || '';

    if (replyText) {
      // Send response via SSE if connected
      if (session.sseResponse) {
        try {
          session.sseResponse.write(`data: ${JSON.stringify({ type: 'assistant_text', text: replyText })}\n\n`);
        } catch (e) {
          console.error('[ORB-LIVE] Failed to send SSE response:', e);
        }
      }

      return res.status(200).json({
        ok: true,
        text: replyText,
        meta: geminiResponse.meta
      });
    } else {
      return res.status(200).json({
        ok: false,
        error: 'No response from AI'
      });
    }
  } catch (error: any) {
    console.error('[ORB-LIVE] /text processing error:', error);
    return res.status(200).json({
      ok: false,
      error: error.message || 'Failed to process text'
    });
  }
});

/**
 * POST /mute - Toggle mute state
 */
router.post('/mute', (req: Request, res: Response) => {
  const body = req.body as MuteMessage;

  if (!body.sessionId || typeof body.muted !== 'boolean') {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: sessionId, muted'
    });
  }

  const session = sessions.get(body.sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  session.muted = body.muted;
  session.lastActivity = new Date();

  console.log(`[ORB-LIVE] Session ${body.sessionId} muted: ${body.muted}`);

  return res.status(200).json({
    ok: true,
    muted: session.muted
  });
});

/**
 * POST /stop - Stop live session
 */
router.post('/stop', (req: Request, res: Response) => {
  const body = req.body as StopMessage;

  if (!body.sessionId) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required field: sessionId'
    });
  }

  const session = sessions.get(body.sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  // Close SSE connection
  if (session.sseResponse) {
    try {
      session.sseResponse.write(`data: ${JSON.stringify({ type: 'session_ended' })}\n\n`);
      session.sseResponse.end();
    } catch (e) {
      // Ignore
    }
    session.sseResponse = null;
  }

  session.active = false;
  sessions.delete(body.sessionId);

  console.log(`[ORB-LIVE] Session stopped: ${body.sessionId}`);

  return res.status(200).json({ ok: true });
});

/**
 * VTID-0135: POST /chat - Voice conversation chat (Vertex routing)
 *
 * Request JSON:
 * {
 *   "orb_session_id": "uuid",
 *   "conversation_id": "string|null",
 *   "input_text": "string",
 *   "meta": { "mode": "orb_voice", "source": "command-hub", "vtid": null }
 * }
 *
 * Response JSON:
 * {
 *   "ok": true,
 *   "conversation_id": "string",
 *   "reply_text": "string",
 *   "meta": { "provider": "vertex", "model": "gemini-*", "mode": "orb_voice" }
 * }
 */
router.post('/chat', async (req: Request, res: Response) => {
  const body = req.body as OrbChatRequest;

  console.log('[VTID-0135] POST /orb/chat received');

  // Validate required fields
  if (!body.orb_session_id || !body.input_text) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: orb_session_id, input_text'
    });
  }

  const orbSessionId = body.orb_session_id;
  const inputText = body.input_text.trim();

  if (!inputText) {
    return res.status(400).json({
      ok: false,
      error: 'input_text cannot be empty'
    });
  }

  // Get or create conversation
  let conversationId = body.conversation_id;
  let conversation: OrbConversation;
  let isNewSession = false;

  if (conversationId && orbConversations.has(conversationId)) {
    // Continue existing conversation
    conversation = orbConversations.get(conversationId)!;
    conversation.lastActivity = new Date();
    // VTID-01118: Ensure turn_count exists for older conversations
    if (conversation.turn_count === undefined) {
      conversation.turn_count = Math.floor(conversation.history.length / 2);
    }
    console.log(`[VTID-0135] Continuing conversation: ${conversationId}`);
  } else {
    // Create new conversation
    conversationId = `orb-conv-${randomUUID()}`;
    conversation = {
      conversationId,
      orbSessionId,
      history: [],
      createdAt: new Date(),
      lastActivity: new Date(),
      turn_count: 0  // VTID-01118: Initialize turn counter
    };
    orbConversations.set(conversationId, conversation);
    isNewSession = true;
    console.log(`[VTID-0135] Created new conversation: ${conversationId}`);

    // Emit session started event
    await emitOrbSessionStarted(orbSessionId, conversationId);
  }

  // VTID-01039: Append user turn to transcript (replaces per-turn OASIS event)
  // Get or create transcript for this session
  let transcript = orbTranscripts.get(orbSessionId);
  if (!transcript) {
    transcript = {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      turns: [],
      started_at: new Date().toISOString(),
      finalized: false
    };
    orbTranscripts.set(orbSessionId, transcript);
    console.log(`[VTID-01039] Transcript created via /chat: ${orbSessionId}`);
  }

  // Append user turn
  transcript.turns.push({
    role: 'user',
    text: inputText,
    ts: new Date().toISOString()
  });

  // VTID-01105: Auto-write user message to memory
  // VTID-01107: Support dev-sandbox mode without token
  const userToken = getBearerToken(req);
  const isVoice = body.meta?.mode === 'orb_voice';
  const memorySource = isVoice ? 'orb_voice' : 'orb_text';
  const requestId = randomUUID();

  if (userToken) {
    // Write user message to memory with JWT (fire-and-forget, don't block response)
    writeMemoryItem(userToken, {
      source: memorySource as 'orb_text' | 'orb_voice',
      content: inputText,
      content_json: {
        direction: 'user',
        channel: 'orb',
        mode: isVoice ? 'voice' : 'text',
        request_id: requestId,
        orb_session_id: orbSessionId,
        conversation_id: conversationId
      }
    }).then(result => {
      if (result.ok) {
        console.log(`[VTID-01105] User message written to memory: ${result.id} (${result.category_key})`);
        emitMemoryWriteEvent('memory.write.user_message', {
          memory_id: result.id,
          category_key: result.category_key,
          orb_session_id: orbSessionId,
          conversation_id: conversationId,
          source: memorySource
        });
      } else {
        console.warn('[VTID-01105] User message memory write failed:', result.error);
      }
    }).catch(err => {
      console.warn('[VTID-01105] User message memory write error:', err.message);
    });
  } else if (isDevSandbox()) {
    // VTID-01107: Dev-sandbox mode - write with dev identity (no token required)
    writeDevMemoryItem({
      source: memorySource,
      content: inputText,
      content_json: {
        direction: 'user',
        channel: 'orb',
        mode: isVoice ? 'voice' : 'text',
        request_id: requestId,
        orb_session_id: orbSessionId,
        conversation_id: conversationId
      }
    }).then(result => {
      if (result.ok) {
        console.log(`[VTID-01107] Dev user message written to memory: ${result.id} (${result.category_key})`);
        emitMemoryWriteEvent('memory.write.user_message', {
          memory_id: result.id,
          category_key: result.category_key,
          orb_session_id: orbSessionId,
          conversation_id: conversationId,
          source: memorySource,
          dev_sandbox: true
        });
      } else {
        console.warn('[VTID-01107] Dev user message memory write failed:', result.error);
      }
    }).catch(err => {
      console.warn('[VTID-01107] Dev user message memory write error:', err.message);
    });
  }

  // VTID-01153: Write to memory-indexer (Mem0 OSS) - fire-and-forget
  if (isMemoryIndexerEnabled()) {
    writeToMemoryIndexer({
      user_id: DEV_IDENTITY.USER_ID,
      content: inputText,
      role: 'user',
      metadata: {
        source: 'orb',
        orb_session_id: orbSessionId,
        conversation_id: conversationId,
        vtid: 'VTID-01153'
      }
    }).then(result => {
      if (result.stored) {
        console.log(`[VTID-01153] User message written to Mem0: ${result.memory_ids.join(', ')}`);
      } else {
        console.log(`[VTID-01153] User message not stored in Mem0: ${result.decision}`);
      }
    }).catch(err => {
      console.warn('[VTID-01153] Mem0 write error:', err.message);
    });
  }

  try {
    // Build thread ID for Gemini processing
    const threadId = `orb-${orbSessionId}`;

    // VTID-01118: Get state engine and increment turn count
    conversation.turn_count = (conversation.turn_count || 0) + 1;
    const stateEngine = getStateEngine(orbSessionId, conversationId);

    // VTID-01118: Pre-detect intent, domain, and VTIDs from user message
    const detectedIntent = detectIntentType(inputText);
    const detectedDomain = detectDomainType(inputText);
    const vtidMentions = extractVtidMentions(inputText);

    console.log(`[VTID-01118] Turn ${conversation.turn_count}: intent=${detectedIntent}, domain=${detectedDomain}, vtids=${vtidMentions.join(',') || 'none'}`);

    // VTID-01106: Fetch memory context and build enhanced system instruction
    // Extract context from meta (cast to any for dev sandbox flexibility)
    const meta = body.meta as Record<string, unknown> | undefined;
    const { instruction: baseSystemInstruction, memoryContext } = await generateMemoryEnhancedSystemInstruction({
      tenant: (meta?.tenant as string) || 'vitana',
      role: (meta?.role as string) || 'developer',
      route: meta?.route as string | undefined,
      selectedId: meta?.selectedId as string | undefined
    });

    // VTID-01118: Inject cross-turn state context into system instruction
    const stateContext = stateEngine.generateContextString();
    const systemInstruction = stateContext
      ? `${baseSystemInstruction}\n\n${stateContext}`
      : baseSystemInstruction;

    // VTID-01106: Emit memory context injection event
    if (memoryContext && memoryContext.ok && memoryContext.items.length > 0) {
      emitOasisEvent({
        vtid: 'VTID-01106',
        type: 'orb.memory.context_injected',
        source: 'orb-memory-bridge',
        status: 'success',
        message: `Memory context injected: ${memoryContext.items.length} items`,
        payload: {
          orb_session_id: orbSessionId,
          conversation_id: conversationId,
          user_id: DEV_IDENTITY.USER_ID,
          items_count: memoryContext.items.length,
          summary: memoryContext.summary
        }
      }).catch((err: Error) => console.warn('[VTID-01106] OASIS event failed:', err.message));
    }

    // =========================================================================
    // VTID-01113: Intent Detection & Classification (D21)
    // Detect intent BEFORE ORB responds - this informs downstream intelligence
    // Order: D20 Context → D21 Intent → D22 Routing → Intelligence (Gemini)
    // =========================================================================

    // Build multi-signal input for intent detection
    const activeRole: ActiveRole = (meta?.role as ActiveRole) || 'patient';
    const interactionMode: InteractionMode = body.meta?.mode === 'orb_voice' ? 'orb' : 'chat';

    const intentInput: IntentDetectionInput = {
      current_input: inputText,
      conversation: buildConversationSignal(conversation.history),
      context_bundle: memoryContext?.ok ? buildContextSignalFromMemory({
        ok: memoryContext.ok,
        user_id: memoryContext.user_id,
        items: memoryContext.items.map(item => ({
          category_key: item.category_key,
          content: item.content
        }))
      }) : undefined,
      active_role: activeRole,
      mode: interactionMode
    };

    // Detect intent (deterministic classification)
    const intentBundle = detectIntent(intentInput);

    console.log(`[VTID-01113] Intent detected: ${intentBundle.primary_intent} (confidence: ${intentBundle.confidence_score}, ambiguous: ${intentBundle.is_ambiguous})`);

    // Log intent to OASIS for traceability (fire-and-forget)
    logIntentToOasis(
      intentBundle,
      intentInput,
      isDevSandbox() ? DEV_IDENTITY.USER_ID : undefined,
      conversationId
    ).catch((err: Error) => console.warn('[VTID-01113] Intent log failed:', err.message));

    // Log ambiguous intent warning if applicable
    if (intentBundle.is_ambiguous) {
      logAmbiguousIntentWarning(
        intentBundle,
        isDevSandbox() ? DEV_IDENTITY.USER_ID : undefined,
        conversationId
      ).catch((err: Error) => console.warn('[VTID-01113] Ambiguous intent log failed:', err.message));
    }

    // Log safety-flagged intent if applicable
    if (intentBundle.requires_safety_review) {
      logSafetyFlaggedIntent(
        intentBundle,
        isDevSandbox() ? DEV_IDENTITY.USER_ID : undefined,
        conversationId
      ).catch((err: Error) => console.warn('[VTID-01113] Safety flag log failed:', err.message));
    }

    // =========================================================================
    // VTID-01149: Unified Task-Creation Intake Mode
    // Check for active intake session OR detect task creation intent
    // If in intake mode, handle Q1/Q2 flow before Gemini processing
    // =========================================================================

    // Check if there's an active intake session for this orb session
    if (hasActiveIntake(orbSessionId)) {
      const intakeState = getIntakeState(orbSessionId);

      if (intakeState && intakeState.intake_active) {
        const nextQ = getNextQuestion(intakeState);

        // Process the user's message as an answer if it looks like one
        if (nextQ.question && looksLikeAnswer(inputText)) {
          const answerResult = await processIntakeAnswer({
            sessionId: orbSessionId,
            question: nextQ.question,
            answer: inputText,
            surface: 'orb'
          });

          if (answerResult.ok) {
            // If ready to schedule, complete the intake and schedule the task
            if (answerResult.ready_to_schedule) {
              const scheduleResult = await completeIntakeAndSchedule(orbSessionId);

              // Append to transcript
              if (transcript) {
                transcript.turns.push({
                  role: 'assistant',
                  text: scheduleResult.ok
                    ? `Your task has been created and scheduled: ${scheduleResult.vtid}. You can track it on the Command Hub board.`
                    : `I couldn't schedule the task: ${scheduleResult.error}. Please try again.`,
                  ts: new Date().toISOString()
                });
              }

              // Update conversation history
              conversation.history.push({ role: 'user', content: inputText });
              conversation.history.push({
                role: 'assistant',
                content: scheduleResult.ok
                  ? `Your task has been created and scheduled: ${scheduleResult.vtid}. You can track it on the Command Hub board.`
                  : `I couldn't schedule the task: ${scheduleResult.error}. Please try again.`
              });

              console.log(`[VTID-01149] ORB intake complete, task ${scheduleResult.ok ? 'scheduled' : 'failed'}: ${scheduleResult.vtid}`);

              return res.status(200).json({
                ok: true,
                conversation_id: conversationId,
                reply_text: scheduleResult.ok
                  ? `Your task has been created and scheduled: ${scheduleResult.vtid}. You can track it on the Command Hub board.`
                  : `I couldn't schedule the task: ${scheduleResult.error}. Please try again.`,
                meta: {
                  provider: 'task-intake',
                  model: 'vtid-01149',
                  mode: 'orb_voice',
                  vtid: scheduleResult.vtid || 'VTID-01149',
                  intake_complete: true,
                  task_scheduled: scheduleResult.ok
                }
              });
            }

            // More questions to ask
            if (answerResult.next_question_prompt) {
              // Append to transcript
              if (transcript) {
                transcript.turns.push({
                  role: 'assistant',
                  text: answerResult.next_question_prompt,
                  ts: new Date().toISOString()
                });
              }

              // Update conversation history
              conversation.history.push({ role: 'user', content: inputText });
              conversation.history.push({ role: 'assistant', content: answerResult.next_question_prompt });

              console.log(`[VTID-01149] ORB intake asking next question: ${answerResult.next_question}`);

              return res.status(200).json({
                ok: true,
                conversation_id: conversationId,
                reply_text: answerResult.next_question_prompt,
                meta: {
                  provider: 'task-intake',
                  model: 'vtid-01149',
                  mode: 'orb_voice',
                  vtid: 'VTID-01149',
                  intake_active: true,
                  next_question: answerResult.next_question
                }
              });
            }
          }
        }
      }
    }

    // Check if this message indicates task creation intent and start intake
    // Only if not already in intake mode
    if (!hasActiveIntake(orbSessionId) && detectTaskCreationIntent(inputText)) {
      console.log(`[VTID-01149] Task creation intent detected in ORB, starting intake`);

      await startIntake({
        sessionId: orbSessionId,
        surface: 'orb',
        tenant: 'vitana'
      });

      const startMessage = generateIntakeStartMessage();

      // Append to transcript
      if (transcript) {
        transcript.turns.push({
          role: 'assistant',
          text: startMessage,
          ts: new Date().toISOString()
        });
      }

      // Update conversation history
      conversation.history.push({ role: 'user', content: inputText });
      conversation.history.push({ role: 'assistant', content: startMessage });

      return res.status(200).json({
        ok: true,
        conversation_id: conversationId,
        reply_text: startMessage,
        meta: {
          provider: 'task-intake',
          model: 'vtid-01149',
          mode: 'orb_voice',
          vtid: 'VTID-01149',
          intake_active: true,
          next_question: 'spec'
        }
      });
    }

    // =========================================================================
    // VTID-01114: Domain & Topic Routing (D22)
    // Uses D21 intent output to determine which intelligence domain handles turn
    // =========================================================================

    const routingInput: RoutingInput = {
      context: {
        user_id: memoryContext?.user_id || DEV_IDENTITY.USER_ID,
        tenant_id: memoryContext?.tenant_id || DEV_IDENTITY.TENANT_ID,
        memory_items: (memoryContext?.items || []).map(item => ({
          category_key: item.category_key,
          content: item.content,
          importance: item.importance
        })),
        formatted_context: memoryContext?.formatted_context || ''
      },
      intent: {
        // VTID-01113 → VTID-01114: Wire D21 intent into D22 routing
        top_topics: intentBundle.domain_tags.map((tag, idx) => ({
          topic_key: tag,
          score: 1.0 - (idx * 0.1) // Primary topic gets 1.0, secondary gets 0.9, etc.
        })),
        weaknesses: intentBundle.requires_safety_review ? [intentBundle.primary_intent] : [],
        recommended_actions: intentBundle.urgency_level === 'critical' ? [{
          type: 'escalate',
          id: `escalate-${intentBundle.bundle_id}`,
          why: [{ template: 'Critical urgency detected by D21 intent classification' }]
        }] : []
      },
      current_message: inputText,
      active_role: (meta?.role as 'patient' | 'professional' | 'admin' | 'developer') || 'patient',
      session: {
        session_id: orbSessionId,
        turn_number: transcript.turns.filter(t => t.role === 'user').length
      }
    };

    const routingBundle = computeRoutingBundle(routingInput);
    console.log(`[VTID-01114] ${getRoutingSummary(routingBundle)}`);

    // Emit routing event for audit (D59 compliance)
    await emitRoutingEvent(
      routingBundle,
      routingInput.context.user_id,
      routingInput.context.tenant_id,
      orbSessionId
    );

    // VTID-01114: Check for critical safety flags that require intervention
    const criticalFlags = routingBundle.safety_flags.filter(f => f.severity === 'critical');
    if (criticalFlags.length > 0) {
      console.warn(`[VTID-01114] CRITICAL safety flags detected: ${criticalFlags.map(f => f.type).join(', ')}`);
      // Note: In production, this might trigger human escalation or special handling
    }

    // Process with Gemini using Vertex routing (same as Operator Console)
    // VTID-0135: Uses processWithGemini which prioritizes Vertex AI > Gemini API > Local
    // VTID-01106: Pass memory-enhanced system instruction
    const geminiResponse = await processWithGemini({
      text: inputText,
      threadId,
      conversationHistory: conversation.history,
      conversationId,
      systemInstruction
    });

    const replyText = geminiResponse.reply || 'I apologize, but I could not generate a response.';
    const provider = (geminiResponse.meta?.provider as string) || 'vertex';
    const model = (geminiResponse.meta?.model as string) || 'gemini-2.5-pro';

    // Update conversation history
    conversation.history.push({ role: 'user', content: inputText });
    conversation.history.push({ role: 'assistant', content: replyText });

    // Limit history to last 20 turns (10 pairs) to avoid context overflow
    if (conversation.history.length > 20) {
      conversation.history = conversation.history.slice(-20);
    }

    // VTID-01118: Update cross-turn state with turn results
    // Extract tool calls from response for state tracking
    const toolCalls = (geminiResponse.toolResults || []).map(tr => ({
      name: tr.name,
      args: {},
      result: tr.response
    }));

    // Build state update input
    const stateUpdateInput: StateUpdateInput = {
      turn_number: conversation.turn_count,
      user_message: inputText,
      assistant_response: replyText,
      detected_intent: detectedIntent,
      detected_domain: detectedDomain,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      vtid_mentioned: vtidMentions.length > 0 ? vtidMentions : undefined,
      is_correction: detectedIntent === 'correction',
      is_clarification: detectedIntent === 'clarification',
    };

    // Update state (async, fire-and-forget for performance)
    stateEngine.updateState(stateUpdateInput)
      .then(snapshot => {
        console.log(`[VTID-01118] State updated: focus="${snapshot.focus_summary}", confidence=${snapshot.continuity_confidence.toFixed(2)}`);
      })
      .catch(err => {
        console.warn('[VTID-01118] State update error:', err.message);
      });

    // VTID-01039: Append assistant turn to transcript (replaces per-turn OASIS event)
    if (transcript) {
      transcript.turns.push({
        role: 'assistant',
        text: replyText,
        ts: new Date().toISOString()
      });
    }

    // VTID-01105: Auto-write assistant message to memory (fire-and-forget)
    // VTID-01107: Support dev-sandbox mode without token
    const latencyMs = geminiResponse.meta?.latency_ms as number || 0;
    if (userToken) {
      writeMemoryItem(userToken, {
        source: memorySource as 'orb_text' | 'orb_voice',
        content: replyText,
        content_json: {
          direction: 'assistant',
          channel: 'orb',
          model,
          provider,
          latency_ms: latencyMs,
          request_id: requestId,
          orb_session_id: orbSessionId,
          conversation_id: conversationId
        }
      }).then(result => {
        if (result.ok) {
          console.log(`[VTID-01105] Assistant message written to memory: ${result.id} (${result.category_key})`);
          emitMemoryWriteEvent('memory.write.assistant_message', {
            memory_id: result.id,
            category_key: result.category_key,
            orb_session_id: orbSessionId,
            conversation_id: conversationId,
            source: memorySource,
            model,
            latency_ms: latencyMs
          });
        } else {
          console.warn('[VTID-01105] Assistant message memory write failed:', result.error);
        }
      }).catch(err => {
        console.warn('[VTID-01105] Assistant message memory write error:', err.message);
      });
    } else if (isDevSandbox()) {
      // VTID-01107: Dev-sandbox mode - write with dev identity (no token required)
      writeDevMemoryItem({
        source: memorySource,
        content: replyText,
        content_json: {
          direction: 'assistant',
          channel: 'orb',
          model,
          provider,
          latency_ms: latencyMs,
          request_id: requestId,
          orb_session_id: orbSessionId,
          conversation_id: conversationId
        }
      }).then(result => {
        if (result.ok) {
          console.log(`[VTID-01107] Dev assistant message written to memory: ${result.id} (${result.category_key})`);
          emitMemoryWriteEvent('memory.write.assistant_message', {
            memory_id: result.id,
            category_key: result.category_key,
            orb_session_id: orbSessionId,
            conversation_id: conversationId,
            source: memorySource,
            model,
            latency_ms: latencyMs,
            dev_sandbox: true
          });
        } else {
          console.warn('[VTID-01107] Dev assistant message memory write failed:', result.error);
        }
      }).catch(err => {
        console.warn('[VTID-01107] Dev assistant message memory write error:', err.message);
      });
    }

    console.log(`[VTID-0135] Chat response generated via ${provider}`);

    // VTID-01106: Add memory debug info to response for debugging
    const memoryDebug = {
      memory_bridge_enabled: isMemoryBridgeEnabled(),
      memory_context_ok: memoryContext?.ok ?? false,
      memory_items_count: memoryContext?.items?.length ?? 0,
      memory_injected: Boolean(memoryContext?.ok && memoryContext?.items?.length > 0)
    };

// VTID-01113: Add intent bundle to response for visibility (spec section 5)
    const intentDebug = {
      intent_bundle_id: intentBundle.bundle_id,
      primary_intent: intentBundle.primary_intent,
      secondary_intents: intentBundle.secondary_intents,
      confidence_score: intentBundle.confidence_score,
      urgency_level: intentBundle.urgency_level,
      domain_tags: intentBundle.domain_tags,
      is_ambiguous: intentBundle.is_ambiguous,
      requires_safety_review: intentBundle.requires_safety_review
    };

    // VTID-01114: Add routing info to response for visibility
    const routingDebug = {
      primary_domain: routingBundle.primary_domain,
      secondary_domains: routingBundle.secondary_domains,
      routing_confidence: routingBundle.routing_confidence,
      active_topics: routingBundle.active_topics.map(t => t.topic_key),
      safety_flags: routingBundle.safety_flags.map(f => f.type),
      autonomy_level: routingBundle.autonomy_level,
      allows_commerce: routingBundle.allows_commerce,
      determinism_key: routingBundle.metadata.determinism_key
    };

    // VTID-01118: Add state debug info to response
    const currentState = stateEngine.getState();
    const stateDebug = {
      state_turn: conversation.turn_count,
      state_focus_vtid: currentState.focus_vtid,
      state_active_intents: currentState.active_intents.length,
      state_open_tasks: currentState.open_tasks.length,
      state_continuity_confidence: currentState.continuity_confidence
    };

    const response: OrbChatResponse = {
      ok: true,
      conversation_id: conversationId,
      reply_text: replyText,
      meta: {
        provider,
        model,
        mode: 'orb_voice',
        vtid: 'VTID-0135',
        ...memoryDebug, // Include memory debug info in response
        ...intentDebug, // VTID-01113: Include intent classification in response
        routing: routingDebug, // VTID-01114: Include routing info
        ...stateDebug   // VTID-01118: Include state debug info in response
      }
    };

    return res.status(200).json(response);

  } catch (error: any) {
    console.error('[VTID-0135] Chat processing error:', error);

    return res.status(500).json({
      ok: false,
      conversation_id: conversationId,
      reply_text: '',
      error: error.message || 'Failed to process chat request',
      meta: {
        provider: 'error',
        model: 'none',
        mode: 'orb_voice',
        vtid: 'VTID-0135'
      }
    });
  }
});

/**
 * VTID-0135: POST /end-session - End an ORB voice conversation session
 * VTID-01039: Now finalizes session and emits ONE orb.session.summary event
 * VTID-01109: Don't delete conversation - it should persist for memory continuity
 */
router.post('/end-session', async (req: Request, res: Response) => {
  const { orb_session_id, conversation_id } = req.body;

  if (!orb_session_id) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required field: orb_session_id'
    });
  }

  console.log(`[VTID-01039] Ending session: ${orb_session_id}`);

  // VTID-01118: Expire cross-turn state when session ends
  if (conversation_id) {
    removeStateEngine(orb_session_id, conversation_id)
      .then(() => console.log(`[VTID-01118] State engine removed for session: ${orb_session_id}`))
      .catch(err => console.warn('[VTID-01118] State engine removal error:', err.message));
  }

  // VTID-01109: Don't delete conversation - keep it for memory continuity
  // The conversation should persist until it expires naturally (30 min timeout)
  // or until the user explicitly logs out
  // REMOVED: orbConversations.delete(conversation_id);
  if (conversation_id && orbConversations.has(conversation_id)) {
    console.log(`[VTID-01109] Keeping conversation ${conversation_id} for memory continuity`);
  }

  // VTID-01039: Finalize transcript and emit summary instead of orb.session.ended
  const transcript = orbTranscripts.get(orb_session_id);
  if (transcript && !transcript.finalized) {
    // Generate summary
    const summaryContent = generateSessionSummary(transcript.turns);

    // Calculate duration
    const durationSec = Math.round(
      (Date.now() - new Date(transcript.started_at).getTime()) / 1000
    );

    // Store summary
    transcript.summary = {
      ...summaryContent,
      turns_count: transcript.turns.length,
      duration_sec: durationSec
    };
    transcript.finalized = true;

    // Emit ONE orb.session.summary event to OASIS
    await emitOasisEvent({
      vtid: 'VTID-01039',
      type: 'orb.session.summary',
      source: 'command-hub',
      status: 'success',
      message: summaryContent.title,
      payload: {
        orb_session_id,
        conversation_id: transcript.conversation_id || conversation_id || null,
        turns_count: transcript.summary.turns_count,
        duration_sec: transcript.summary.duration_sec,
        summary: {
          title: summaryContent.title,
          bullets: summaryContent.bullets,
          actions: summaryContent.actions
        },
        metadata: { mode: 'orb_voice' }
      }
    }).catch(err => console.warn('[VTID-01039] Failed to emit orb.session.summary:', err.message));

    console.log(`[VTID-01039] Session finalized: ${orb_session_id} (${transcript.summary.turns_count} turns, ${durationSec}s)`);
  }

  return res.status(200).json({ ok: true });
});

// =============================================================================
// VTID-01039: ORB Session Aggregation Endpoints
// =============================================================================

/**
 * VTID-01039: Generate summary from transcript turns
 * Creates title (max 80 chars), bullets (max 3), actions (max 3)
 */
function generateSessionSummary(turns: OrbTranscriptTurn[]): {
  title: string;
  bullets: string[];
  actions: string[];
} {
  if (turns.length === 0) {
    return {
      title: 'Empty ORB session',
      bullets: [],
      actions: []
    };
  }

  // Extract key topics from user turns
  const userTurns = turns.filter(t => t.role === 'user').map(t => t.text);
  const assistantTurns = turns.filter(t => t.role === 'assistant').map(t => t.text);

  // Generate title from first user message (truncated to 80 chars)
  let title = 'ORB voice conversation';
  if (userTurns.length > 0) {
    const firstQuery = userTurns[0].substring(0, 70);
    title = userTurns.length > 1
      ? `${firstQuery}... (+${userTurns.length - 1} more)`
      : firstQuery;
    if (title.length > 80) {
      title = title.substring(0, 77) + '...';
    }
  }

  // Generate bullets from assistant responses (max 3)
  const bullets: string[] = [];
  for (let i = 0; i < Math.min(3, assistantTurns.length); i++) {
    const response = assistantTurns[i];
    // Extract first sentence or first 100 chars
    const firstSentence = response.split(/[.!?]/)[0];
    const bullet = firstSentence.length > 100
      ? firstSentence.substring(0, 97) + '...'
      : firstSentence;
    if (bullet.trim()) {
      bullets.push(bullet.trim());
    }
  }

  // Generate actions from assistant responses (look for action keywords)
  const actions: string[] = [];
  const actionKeywords = ['you can', 'you should', 'try', 'consider', 'recommend', 'suggest'];
  for (const response of assistantTurns) {
    if (actions.length >= 3) break;
    const lowerResponse = response.toLowerCase();
    for (const keyword of actionKeywords) {
      if (lowerResponse.includes(keyword) && actions.length < 3) {
        // Extract the sentence containing the action keyword
        const sentences = response.split(/[.!?]/);
        for (const sentence of sentences) {
          if (sentence.toLowerCase().includes(keyword) && actions.length < 3) {
            const action = sentence.trim().substring(0, 100);
            if (action && !actions.includes(action)) {
              actions.push(action);
              break;
            }
          }
        }
        break;
      }
    }
  }

  return { title, bullets, actions };
}

/**
 * VTID-01039: POST /session/append - Append a turn to transcript
 *
 * Request:
 * {
 *   "orb_session_id": "uuid",
 *   "conversation_id": "string|null",
 *   "role": "user|assistant",
 *   "text": "string",
 *   "ts": "iso"
 * }
 */
router.post('/session/append', (req: Request, res: Response) => {
  const { orb_session_id, conversation_id, role, text, ts } = req.body;

  if (!orb_session_id || !role || !text) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: orb_session_id, role, text'
    });
  }

  if (role !== 'user' && role !== 'assistant') {
    return res.status(400).json({
      ok: false,
      error: 'role must be "user" or "assistant"'
    });
  }

  // Get or create transcript
  let transcript = orbTranscripts.get(orb_session_id);
  if (!transcript) {
    transcript = {
      orb_session_id,
      conversation_id: conversation_id || null,
      turns: [],
      started_at: new Date().toISOString(),
      finalized: false
    };
    orbTranscripts.set(orb_session_id, transcript);
    console.log(`[VTID-01039] Transcript created: ${orb_session_id}`);
  }

  if (transcript.finalized) {
    return res.status(400).json({
      ok: false,
      error: 'Session already finalized'
    });
  }

  // Update conversation_id if provided and not set
  if (conversation_id && !transcript.conversation_id) {
    transcript.conversation_id = conversation_id;
  }

  // Append turn
  transcript.turns.push({
    role,
    text,
    ts: ts || new Date().toISOString()
  });

  console.log(`[VTID-01039] Turn appended to ${orb_session_id}: ${role} (${text.length} chars)`);

  return res.status(200).json({
    ok: true,
    orb_session_id,
    turns_count: transcript.turns.length
  });
});

/**
 * VTID-01039: POST /session/finalize - Finalize session and emit summary event
 *
 * Request:
 * {
 *   "orb_session_id": "uuid",
 *   "conversation_id": "string|null",
 *   "turns_count": 12,
 *   "duration_sec": 180
 * }
 */
router.post('/session/finalize', async (req: Request, res: Response) => {
  const { orb_session_id, conversation_id, turns_count, duration_sec } = req.body;

  if (!orb_session_id) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required field: orb_session_id'
    });
  }

  // Get transcript
  const transcript = orbTranscripts.get(orb_session_id);
  if (!transcript) {
    return res.status(404).json({
      ok: false,
      error: 'Session transcript not found'
    });
  }

  if (transcript.finalized) {
    return res.status(400).json({
      ok: false,
      error: 'Session already finalized'
    });
  }

  // Generate summary
  const summaryContent = generateSessionSummary(transcript.turns);

  // Calculate duration if not provided
  const actualDuration = duration_sec || (
    transcript.turns.length > 0
      ? Math.round((Date.now() - new Date(transcript.started_at).getTime()) / 1000)
      : 0
  );

  // Store summary
  transcript.summary = {
    ...summaryContent,
    turns_count: turns_count || transcript.turns.length,
    duration_sec: actualDuration
  };
  transcript.finalized = true;

  // Emit ONE orb.session.summary event to OASIS
  await emitOasisEvent({
    vtid: 'VTID-01039',
    type: 'orb.session.summary',
    source: 'command-hub',
    status: 'success',
    message: summaryContent.title,
    payload: {
      orb_session_id,
      conversation_id: transcript.conversation_id || conversation_id || null,
      turns_count: transcript.summary.turns_count,
      duration_sec: transcript.summary.duration_sec,
      summary: {
        title: summaryContent.title,
        bullets: summaryContent.bullets,
        actions: summaryContent.actions
      },
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-01039] Failed to emit orb.session.summary:', err.message));

  console.log(`[VTID-01039] Session finalized: ${orb_session_id} (${transcript.summary.turns_count} turns, ${transcript.summary.duration_sec}s)`);

  return res.status(200).json({
    ok: true,
    orb_session_id,
    summary: transcript.summary
  });
});

/**
 * VTID-01039: GET /session/:orb_session_id - Get full transcript + summary
 */
router.get('/session/:orb_session_id', (req: Request, res: Response) => {
  const { orb_session_id } = req.params;

  if (!orb_session_id) {
    return res.status(400).json({
      ok: false,
      error: 'Missing orb_session_id parameter'
    });
  }

  const transcript = orbTranscripts.get(orb_session_id);
  if (!transcript) {
    return res.status(404).json({
      ok: false,
      error: 'Session transcript not found'
    });
  }

  return res.status(200).json({
    ok: true,
    orb_session_id: transcript.orb_session_id,
    conversation_id: transcript.conversation_id,
    started_at: transcript.started_at,
    finalized: transcript.finalized,
    turns: transcript.turns,
    summary: transcript.summary || null
  });
});

/**
 * VTID-01107: GET /debug/memory - ORB Memory Debug Endpoint (Dev Sandbox Only)
 *
 * Returns detailed debug information about what memory context ORB is using.
 * Only available in dev-sandbox environment - returns 404 in other environments.
 *
 * Response:
 * {
 *   "ok": true,
 *   "enabled": true,
 *   "dev_user_id": "000...099",
 *   "dev_tenant_id": "000...001",
 *   "lookback_hours": 24,
 *   "items_count": 7,
 *   "items_preview": ["Remember: my name is...", "Preference: German..."],
 *   "injected_chars": 1834,
 *   "injected_preview": "VITANA_MEMORY_CONTEXT...",
 *   "timestamp": "ISO"
 * }
 */
router.get('/debug/memory', async (_req: Request, res: Response) => {
  // Dev-sandbox gate: return 404 in non-dev environments
  if (!isDevSandbox()) {
    console.log('[VTID-01107] Debug endpoint accessed in non-dev environment, returning 404');
    return res.status(404).json({
      ok: false,
      error: 'Not found'
    });
  }

  console.log('[VTID-01107] Debug memory endpoint accessed');

  // Emit orb.memory.debug_requested event
  await emitOasisEvent({
    vtid: 'VTID-01107',
    type: 'orb.memory.debug_requested',
    source: 'orb-memory-debug',
    status: 'info',
    message: 'ORB memory debug endpoint accessed',
    payload: {
      dev_user_id: DEV_IDENTITY.USER_ID,
      dev_tenant_id: DEV_IDENTITY.TENANT_ID,
      lookback_hours: MEMORY_CONFIG.MAX_AGE_HOURS
    }
  }).catch((err: Error) => console.warn('[VTID-01107] Failed to emit debug_requested event:', err.message));

  try {
    // Get debug snapshot from orb-memory-bridge
    const snapshot = await getDebugSnapshot();

    // Emit orb.memory.debug_snapshot event with results
    await emitOasisEvent({
      vtid: 'VTID-01107',
      type: 'orb.memory.debug_snapshot',
      source: 'orb-memory-debug',
      status: snapshot.ok ? 'success' : 'warning',
      message: snapshot.ok
        ? `Debug snapshot: ${snapshot.items_count} items, ${snapshot.injected_chars} chars`
        : `Debug snapshot failed: ${snapshot.error}`,
      payload: {
        items_count: snapshot.items_count,
        injected_chars: snapshot.injected_chars,
        lookback_hours: snapshot.lookback_hours,
        enabled: snapshot.enabled,
        ok: snapshot.ok
      }
    }).catch((err: Error) => console.warn('[VTID-01107] Failed to emit debug_snapshot event:', err.message));

    console.log(`[VTID-01107] Debug snapshot: items=${snapshot.items_count}, chars=${snapshot.injected_chars}`);

    return res.status(200).json(snapshot);

  } catch (err: any) {
    console.error('[VTID-01107] Debug endpoint error:', err.message);
    return res.status(500).json({
      ok: false,
      enabled: isMemoryBridgeEnabled(),
      dev_user_id: DEV_IDENTITY.USER_ID,
      dev_tenant_id: DEV_IDENTITY.TENANT_ID,
      lookback_hours: MEMORY_CONFIG.MAX_AGE_HOURS,
      items_count: 0,
      items_preview: [],
      injected_chars: 0,
      injected_preview: '',
      timestamp: new Date().toISOString(),
      error: err.message
    });
  }
});

/**
 * VTID-01113: GET /debug/intent - Intent Detection Debug Endpoint
 *
 * Tests the intent detection engine with a sample input text.
 * Dev-sandbox only (returns 404 in other environments).
 *
 * Query params:
 * - text: Input text to classify (required)
 * - role: Active role (optional, defaults to 'patient')
 * - mode: Interaction mode (optional, defaults to 'orb')
 *
 * Response:
 * {
 *   "ok": true,
 *   "intent_bundle": { ... },
 *   "debug": { ... },
 *   "timestamp": "ISO"
 * }
 */
router.get('/debug/intent', async (req: Request, res: Response) => {
  // Dev-sandbox gate: return 404 in non-dev environments
  if (!isDevSandbox()) {
    console.log('[VTID-01113] Debug intent endpoint accessed in non-dev environment, returning 404');
    return res.status(404).json({
      ok: false,
      error: 'Not found'
    });
  }

  const inputText = (req.query.text as string) || '';
  const role = (req.query.role as ActiveRole) || 'patient';
  const mode = (req.query.mode as InteractionMode) || 'orb';

  if (!inputText.trim()) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required query param: text'
    });
  }

  console.log(`[VTID-01113] Debug intent endpoint accessed: "${inputText.substring(0, 50)}..."`);

  // Emit debug request event
  await emitOasisEvent({
    vtid: 'VTID-01113',
    type: 'orb.intent.debug_requested' as any, // VTID-01113: Custom event type
    source: 'intent-debug',
    status: 'info',
    message: 'ORB intent debug endpoint accessed',
    payload: {
      input_preview: inputText.substring(0, 100),
      role,
      mode
    }
  }).catch((err: Error) => console.warn('[VTID-01113] Failed to emit debug_requested event:', err.message));

  try {
    // Build input and get debug info
    const intentInput: IntentDetectionInput = {
      current_input: inputText,
      conversation: { recent_turns: [], turn_count: 0 },
      active_role: role,
      mode: mode
    };

    const debugInfo = getIntentDebugInfo(intentInput);

    // Emit debug result event
    await emitOasisEvent({
      vtid: 'VTID-01113',
      type: 'orb.intent.debug_result' as any, // VTID-01113: Custom event type
      source: 'intent-debug',
      status: 'success',
      message: `Debug result: ${debugInfo.bundle.primary_intent} (confidence: ${debugInfo.bundle.confidence_score})`,
      payload: {
        primary_intent: debugInfo.bundle.primary_intent,
        confidence_score: debugInfo.bundle.confidence_score,
        is_ambiguous: debugInfo.bundle.is_ambiguous,
        requires_safety_review: debugInfo.bundle.requires_safety_review
      }
    }).catch((err: Error) => console.warn('[VTID-01113] Failed to emit debug_result event:', err.message));

    console.log(`[VTID-01113] Debug result: ${debugInfo.bundle.primary_intent} (confidence: ${debugInfo.bundle.confidence_score})`);

    return res.status(200).json({
      ok: true,
      intent_bundle: debugInfo.bundle,
      debug: debugInfo.debug,
      config: {
        confidence_threshold: 0.6,
        max_secondary_intents: 3,
        safety_domains: ['health', 'commerce']
      },
      timestamp: new Date().toISOString()
    });

  } catch (err: any) {
    console.error('[VTID-01113] Debug intent endpoint error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /health - Health check
 * VTID-01106: Added memory bridge status
 * VTID-01113: Added intent detection status
 * VTID-01118: Added cross-turn state engine status
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasGeminiKey = !!GEMINI_API_KEY;
  const memoryBridgeEnabled = isMemoryBridgeEnabled();

  return res.status(200).json({
    ok: true,
    service: 'orb-live',
    vtid: ['DEV-COMHU-2025-0014', 'VTID-0135', 'VTID-01039', 'VTID-01106', 'VTID-01107', 'VTID-01113', 'VTID-01118'],
    model: GEMINI_MODEL,
    transport: 'SSE',
    gemini_configured: hasGeminiKey,
    active_sessions: sessions.size,
    active_conversations: orbConversations.size,
    active_transcripts: orbTranscripts.size,
    voice_conversation_enabled: true,
    // VTID-01106: Memory bridge status
    memory_bridge: {
      enabled: memoryBridgeEnabled,
      dev_user_id: memoryBridgeEnabled ? DEV_IDENTITY.USER_ID : null,
      dev_tenant_id: memoryBridgeEnabled ? DEV_IDENTITY.TENANT_ID : null
    },
    // VTID-01113: Intent detection status
    intent_detection: {
      enabled: true,
      vtid: 'VTID-01113',
      intent_classes: ['information', 'action', 'reflection', 'decision', 'connection', 'health', 'commerce', 'system'],
      confidence_threshold: 0.6
    },
    // VTID-01118: Cross-turn state engine status
    cross_turn_state_engine: {
      enabled: true,
      version: 'D26-v1'
    },
    timestamp: new Date().toISOString()
  });
});

export default router;
