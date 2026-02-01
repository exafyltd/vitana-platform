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
import { TextToSpeechClient, protos } from '@google-cloud/text-to-speech';
import { processWithGemini } from '../services/gemini-operator';
import { emitOasisEvent } from '../services/oasis-event-service';
// VTID-01225: Cognee Entity Extraction Integration
import { cogneeExtractorClient, type CogneeExtractionRequest } from '../services/cognee-extractor-client';
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
// VTID-01186: Identity-aware memory functions
import {
  isMemoryBridgeEnabled,
  isDevSandbox,
  fetchDevMemoryContext,
  fetchMemoryContextWithIdentity,
  buildMemoryEnhancedInstruction,
  getDebugSnapshot,
  writeDevMemoryItem,
  writeMemoryItemWithIdentity,
  DEV_IDENTITY,
  MEMORY_CONFIG,
  OrbMemoryContext,
  MemoryIdentity
} from '../services/orb-memory-bridge';
// VTID-01186: Auth middleware for identity propagation
// VTID-01224: Added verifyAndExtractIdentity for WebSocket auth
import {
  optionalAuth,
  AuthenticatedRequest,
  verifyAndExtractIdentity,
  SupabaseIdentity
} from '../middleware/auth-supabase-jwt';
// VTID-01224: Context Pack Builder for Live API intelligence
import {
  buildContextPack,
  formatContextPackForLLM,
  BuildContextPackInput,
  CONTEXT_PACK_CONFIG
} from '../services/context-pack-builder';
// VTID-01224: Retrieval Router for context source decisions
import { computeRetrievalRouterDecision } from '../services/retrieval-router';
// VTID-01224: Context Lens for memory access control
import { ContextLens, createContextLens } from '../types/context-lens';
// VTID-01224: Conversation types for thread continuity
import { ContextPack } from '../types/conversation';
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
// VTID-01158: ORB Router Fix — Enforce OASIS-Only Task Discovery
import {
  isTaskStateQuery,
  executeTaskStateQuery,
  getTaskStateQueryDebugInfo
} from '../services/task-state-query-service';
// VTID-01153: Memory Indexer Client (Mem0 OSS)
import {
  isMemoryIndexerEnabled,
  writeToMemoryIndexer,
  searchMemoryIndexer,
  getMemoryContext,
  buildMemoryIndexerEnhancedInstruction
} from '../services/memory-indexer-client';
// VTID-01219: Gemini Live API WebSocket for real-time voice-to-voice
// VTID-01222: WebSocket server for client connections
import WebSocket, { WebSocketServer } from 'ws';
import { GoogleAuth } from 'google-auth-library';
import { Server as HttpServer, IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';

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
  'https://gateway-q74ibpv6ia-uc.a.run.app',
  'https://gateway-86804897789.us-central1.run.app',
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
// VTID-01186: Identity Helpers for Memory Operations
// =============================================================================

/**
 * VTID-01186: Extract memory identity from authenticated request.
 * If authenticated, uses req.identity. Otherwise, falls back to DEV_IDENTITY in dev-sandbox mode.
 *
 * @param req - Express request (may have identity attached by optionalAuth middleware)
 * @returns MemoryIdentity with user_id, tenant_id, and active_role
 */
function getMemoryIdentity(req: AuthenticatedRequest): MemoryIdentity {
  // If authenticated with tenant, use the real identity
  if (req.identity && req.identity.user_id && req.identity.tenant_id) {
    return {
      user_id: req.identity.user_id,
      tenant_id: req.identity.tenant_id,
      active_role: req.identity.role || null
    };
  }

  // Fallback to DEV_IDENTITY in dev-sandbox mode
  if (isDevSandbox()) {
    return {
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      active_role: DEV_IDENTITY.ACTIVE_ROLE
    };
  }

  // No identity available - this will cause memory operations to fail gracefully
  return {
    user_id: '',
    tenant_id: '',
    active_role: null
  };
}

/**
 * VTID-01186: Check if request has valid identity for memory operations.
 * @param req - Express request
 * @returns true if identity is valid (either authenticated or dev-sandbox fallback)
 */
function hasValidIdentity(req: AuthenticatedRequest): boolean {
  const identity = getMemoryIdentity(req);
  return !!identity.user_id && !!identity.tenant_id;
}

// =============================================================================
// VTID-0135: Voice Conversation Types & Stores
// =============================================================================

/**
 * VTID-0135: ORB Chat Request (voice conversation)
 * VTID-01155: Added images array for multimodal input
 */
interface OrbChatRequest {
  orb_session_id: string;
  conversation_id: string | null;
  input_text: string;
  // VTID-01155: Optional images for multimodal input (screen/camera frames)
  images?: Array<{
    data_b64: string;      // Base64 encoded image data
    mime: string;          // e.g., 'image/jpeg'
    source?: 'screen' | 'camera';
  }>;
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

// =============================================================================
// VTID-01155: Gemini Live Multimodal Session Types & Stores
// =============================================================================

/**
 * VTID-01155: Supported languages for Live sessions and TTS
 * Voice map uses female voices per spec
 */
const LIVE_LANGUAGE_VOICES: Record<string, string> = {
  'en': 'Callirrhoe',
  'de': 'Achernar',
  'fr': 'Leda',
  'es': 'Aoede',
  'ar': 'Sulafat',
  'zh': 'Laomedeia',
  'sr': 'Vindemiatrix',
  'ru': 'Gacrux'
};

const SUPPORTED_LIVE_LANGUAGES = ['en', 'de', 'fr', 'es', 'ar', 'zh', 'sr', 'ru'];

/**
 * VTID-01155: Gemini Live session state
 * VTID-01224: Extended with identity and context fields for intelligence stack
 */
interface GeminiLiveSession {
  sessionId: string;
  lang: string;
  voiceStyle?: string;
  responseModalities: string[];
  upstreamWs: any | null;  // WebSocket to Vertex Live API
  sseResponse: Response | null;
  active: boolean;
  createdAt: Date;
  lastActivity: Date;
  audioInChunks: number;
  videoInFrames: number;
  audioOutChunks: number;
  // VTID-01224: Identity for context retrieval (server-verified from JWT)
  identity?: SupabaseIdentity;
  // VTID-01224: Thread continuity
  thread_id?: string;
  conversation_id?: string;
  turn_count: number;
  // VTID-01224: Bootstrap context (injected into system instruction)
  contextInstruction?: string;
  contextPack?: ContextPack;
  contextBootstrapLatencyMs?: number;
  contextBootstrapSkippedReason?: string;
}

/**
 * VTID-01155: Live session start request
 */
interface LiveSessionStartRequest {
  lang: string;
  voice_style?: string;
  response_modalities?: string[];
}

/**
 * VTID-01155: TTS request body
 */
interface TtsRequest {
  text: string;
  lang?: string;
  voice_style?: string;
}

/**
 * VTID-01155: Stream message types from client
 */
interface LiveStreamAudioChunk {
  type: 'audio';
  data_b64: string;
  mime: string;  // audio/pcm;rate=16000
}

interface LiveStreamVideoFrame {
  type: 'video';
  source: 'screen' | 'camera';
  data_b64: string;  // JPEG base64
  width?: number;
  height?: number;
}

type LiveStreamMessage = LiveStreamAudioChunk | LiveStreamVideoFrame;

// VTID-01155: In-memory Live session store
const liveSessions = new Map<string, GeminiLiveSession>();

// VTID-01155: Vertex AI Live API configuration
const VERTEX_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || '';
const VERTEX_LOCATION = process.env.VERTEX_AI_LOCATION || 'us-central1';
const VERTEX_LIVE_MODEL = 'gemini-live-2.5-flash-native-audio';  // Live API model for BidiGenerateContent
const VERTEX_TTS_MODEL = 'gemini-2.5-flash-tts';  // Cloud TTS with Gemini voices

// VTID-01155: Google Cloud Text-to-Speech client with Gemini voices
// Uses ADC (Application Default Credentials) - automatic on Cloud Run
let ttsClient: TextToSpeechClient | null = null;
try {
  ttsClient = new TextToSpeechClient();
  console.log('[VTID-01155] Google Cloud TTS client initialized');
} catch (err: any) {
  console.warn('[VTID-01155] Failed to initialize TTS client:', err.message);
}

// VTID-01155: Gemini TTS voice mapping for each language
// Uses Google Cloud TTS with Gemini model
const GEMINI_TTS_VOICES: Record<string, { name: string; languageCode: string }> = {
  'en': { name: 'Kore', languageCode: 'en-US' },
  'de': { name: 'Kore', languageCode: 'de-DE' },
  'fr': { name: 'Kore', languageCode: 'fr-FR' },
  'es': { name: 'Kore', languageCode: 'es-ES' },
  'ar': { name: 'Kore', languageCode: 'ar-XA' },
  'zh': { name: 'Kore', languageCode: 'cmn-CN' },
  'sr': { name: 'Kore', languageCode: 'sr-RS' },
  'ru': { name: 'Kore', languageCode: 'ru-RU' }
};

// VTID-01219: TTS voices for ALL languages
// Neural2 voices provide lower latency and more natural speech synthesis
// Gemini TTS "Kore" voice DOES NOT WORK due to @google-cloud/text-to-speech
// library stripping modelName field during protobuf serialization.
// Female voices selected per specification
// Neural2 available: de, en, fr, es
// WaveNet fallback: ar, zh, ru (Neural2 not available)
// Standard fallback: sr (neither Neural2 nor WaveNet available)
const NEURAL2_TTS_VOICES: Record<string, { name: string; languageCode: string }> = {
  'de': { name: 'de-DE-Neural2-G', languageCode: 'de-DE' },  // Female German - Neural2
  'en': { name: 'en-US-Neural2-H', languageCode: 'en-US' },  // Female English - Neural2
  'fr': { name: 'fr-FR-Neural2-A', languageCode: 'fr-FR' },  // Female French - Neural2
  'es': { name: 'es-ES-Neural2-A', languageCode: 'es-ES' },  // Female Spanish - Neural2
  'ar': { name: 'ar-XA-Wavenet-D', languageCode: 'ar-XA' },  // Female Arabic - WaveNet (Neural2 N/A)
  'zh': { name: 'cmn-CN-Wavenet-A', languageCode: 'cmn-CN' }, // Female Chinese - WaveNet (Neural2 N/A)
  'ru': { name: 'ru-RU-Wavenet-A', languageCode: 'ru-RU' },  // Female Russian - WaveNet (Neural2 N/A)
  'sr': { name: 'sr-RS-Standard-A', languageCode: 'sr-RS' }, // Female Serbian - Standard (Neural2/WaveNet N/A)
};

// ALL languages use best available voice (Neural2 > WaveNet > Standard)
const NEURAL2_ENABLED_LANGUAGES = ['en', 'de', 'fr', 'es', 'ar', 'zh', 'ru', 'sr'];

// =============================================================================
// VTID-01219: Gemini Live API WebSocket Implementation
// Real-time bidirectional audio streaming for voice-to-voice
// =============================================================================

// Google Auth client for getting access tokens
let googleAuth: GoogleAuth | null = null;
try {
  googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  console.log('[VTID-01219] Google Auth client initialized for Live API');
} catch (err: any) {
  console.warn('[VTID-01219] Failed to initialize Google Auth:', err.message);
}

/**
 * VTID-01219: Get access token for Vertex AI Live API
 * Uses Application Default Credentials (ADC) - automatic on Cloud Run
 */
async function getAccessToken(): Promise<string> {
  if (!googleAuth) {
    throw new Error('Google Auth client not initialized');
  }
  const client = await googleAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error('Failed to get access token');
  }
  return tokenResponse.token;
}

/**
 * VTID-01219: Live API voice names (Vertex AI voices)
 * These are different from Cloud TTS voices
 */
const LIVE_API_VOICES: Record<string, string> = {
  'en': 'Aoede',    // English - warm, clear
  'de': 'Kore',     // German
  'fr': 'Charon',   // French
  'es': 'Fenrir',   // Spanish
  'ar': 'Aoede',    // Arabic - fallback to English voice
  'zh': 'Kore',     // Chinese - fallback
  'ru': 'Aoede',    // Russian - fallback
  'sr': 'Aoede'     // Serbian - fallback
};

// =============================================================================
// VTID-01224: Live API Context Bootstrap Configuration
// =============================================================================

/**
 * VTID-01224: Configuration for context bootstrap at session start
 */
const LIVE_CONTEXT_CONFIG = {
  /** Maximum time (ms) to wait for context bootstrap before connecting without it */
  BOOTSTRAP_TIMEOUT_MS: 500,
  /** Maximum memory items to include in bootstrap */
  MAX_MEMORY_ITEMS: 8,
  /** Maximum knowledge items to include in bootstrap */
  MAX_KNOWLEDGE_ITEMS: 4,
  /** Skip web search at bootstrap (no query yet) */
  SKIP_WEB_SEARCH: true,
  /** Maximum total context characters for system instruction */
  MAX_CONTEXT_CHARS: 4000,
};

/**
 * VTID-01224: Build bootstrap context pack for Live API session
 * Uses latency caps to avoid delaying voice connection
 *
 * @param identity - Server-verified user identity
 * @param sessionId - Session ID for thread tracking
 * @returns Context pack result with latency info
 */
async function buildBootstrapContextPack(
  identity: SupabaseIdentity,
  sessionId: string
): Promise<{
  contextPack?: ContextPack;
  contextInstruction?: string;
  latencyMs: number;
  skippedReason?: string;
}> {
  const startTime = Date.now();

  // Validate identity
  if (!identity.tenant_id || !identity.user_id) {
    return {
      latencyMs: Date.now() - startTime,
      skippedReason: 'missing_identity',
    };
  }

  try {
    // Create context lens for memory access
    const lens: ContextLens = createContextLens(identity.tenant_id, identity.user_id, {
      workspace_scope: 'product',
      active_role: identity.role || undefined,
    });

    // Bootstrap router decision: memory + knowledge, no web search
    const routerDecision = computeRetrievalRouterDecision('session bootstrap context', {
      channel: 'orb',
      force_sources: ['memory_garden', 'knowledge_hub'],
      limit_overrides: {
        memory_garden: LIVE_CONTEXT_CONFIG.MAX_MEMORY_ITEMS,
        knowledge_hub: LIVE_CONTEXT_CONFIG.MAX_KNOWLEDGE_ITEMS,
        web_search: 0,
      },
    });

    // Build context pack with timeout
    const contextPackPromise = buildContextPack({
      lens,
      query: 'session bootstrap - recent highlights and user context',
      channel: 'orb',
      thread_id: sessionId,
      turn_number: 0,
      conversation_start: new Date().toISOString(),
      role: identity.role || 'user',
      router_decision: routerDecision,
    });

    // Race against timeout
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), LIVE_CONTEXT_CONFIG.BOOTSTRAP_TIMEOUT_MS)
    );

    const contextPack = await Promise.race([contextPackPromise, timeoutPromise]);

    const latencyMs = Date.now() - startTime;

    if (!contextPack) {
      console.warn(`[VTID-01224] Context bootstrap timed out after ${latencyMs}ms for session ${sessionId}`);
      return {
        latencyMs,
        skippedReason: 'timeout',
      };
    }

    // Format context for system instruction
    let contextInstruction = formatContextPackForLLM(contextPack);

    // Truncate if too long
    if (contextInstruction.length > LIVE_CONTEXT_CONFIG.MAX_CONTEXT_CHARS) {
      contextInstruction = contextInstruction.substring(0, LIVE_CONTEXT_CONFIG.MAX_CONTEXT_CHARS) + '\n[...truncated]';
    }

    console.log(`[VTID-01224] Context bootstrap complete: ${latencyMs}ms, memory=${contextPack.memory_hits?.length || 0}, knowledge=${contextPack.knowledge_hits?.length || 0}`);

    return {
      contextPack,
      contextInstruction,
      latencyMs,
    };
  } catch (err: any) {
    console.error(`[VTID-01224] Context bootstrap error for session ${sessionId}:`, err.message);
    return {
      latencyMs: Date.now() - startTime,
      skippedReason: `error: ${err.message}`,
    };
  }
}

/**
 * VTID-01224: Build Live API tool declarations for function calling
 * These tools enable dynamic context retrieval during the conversation
 */
function buildLiveApiTools(): object[] {
  return [
    {
      function_declarations: [
        {
          name: 'search_memory',
          description: 'Search the user\'s personal memory for information they have previously shared, including personal details, health data, preferences, goals, and past conversations.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query to find relevant memories',
              },
              categories: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional categories to filter: personal, health, preferences, goals, relationships, conversation',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'search_knowledge',
          description: 'Search the Vitana knowledge base for information about health topics, longevity research, and the Vitana platform.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query to find relevant knowledge',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'search_web',
          description: 'Search the web for current information about health topics, news, research, and general questions. Use this for time-sensitive or external information.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The web search query',
              },
            },
            required: ['query'],
          },
        },
      ],
    },
  ];
}

/**
 * VTID-01224: Execute a Live API tool call
 * Handles search_memory, search_knowledge, and search_web tools
 *
 * @param session - The Live session (for identity access)
 * @param toolName - Name of the tool to execute
 * @param args - Tool arguments
 * @returns Tool execution result
 */
async function executeLiveApiTool(
  session: GeminiLiveSession,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; result: string; error?: string }> {
  const startTime = Date.now();

  // Validate identity for tool execution
  if (!session.identity || !session.identity.tenant_id || !session.identity.user_id) {
    return {
      success: false,
      result: '',
      error: 'Authentication required for tool execution',
    };
  }

  const lens: ContextLens = createContextLens(
    session.identity.tenant_id,
    session.identity.user_id,
    {
      workspace_scope: 'product',
      active_role: session.identity.role || undefined,
    }
  );

  try {
    switch (toolName) {
      case 'search_memory': {
        const query = (args.query as string) || '';
        const categories = args.categories as string[] | undefined;

        // Build context pack with memory focus
        const routerDecision = computeRetrievalRouterDecision(query, {
          channel: 'orb',
          force_sources: ['memory_garden'],
          limit_overrides: {
            memory_garden: 10,
            knowledge_hub: 0,
            web_search: 0,
          },
        });

        const contextPack = await buildContextPack({
          lens,
          query,
          channel: 'orb',
          thread_id: session.thread_id || session.sessionId,
          turn_number: session.turn_count,
          conversation_start: session.createdAt.toISOString(),
          role: session.identity.role || 'user',
          router_decision: routerDecision,
        });

        // Format memory results
        const memoryHits = contextPack.memory_hits || [];
        if (memoryHits.length === 0) {
          return {
            success: true,
            result: 'No relevant memories found for this query.',
          };
        }

        const formatted = memoryHits
          .map((hit: any) => `[${hit.category_key || 'memory'}] ${hit.content}`)
          .join('\n');

        console.log(`[VTID-01224] search_memory executed: ${memoryHits.length} hits, ${Date.now() - startTime}ms`);
        return {
          success: true,
          result: `Found ${memoryHits.length} relevant memories:\n${formatted}`,
        };
      }

      case 'search_knowledge': {
        const query = (args.query as string) || '';

        // Build context pack with knowledge focus
        const routerDecision = computeRetrievalRouterDecision(query, {
          channel: 'orb',
          force_sources: ['knowledge_hub'],
          limit_overrides: {
            memory_garden: 0,
            knowledge_hub: 6,
            web_search: 0,
          },
        });

        const contextPack = await buildContextPack({
          lens,
          query,
          channel: 'orb',
          thread_id: session.thread_id || session.sessionId,
          turn_number: session.turn_count,
          conversation_start: session.createdAt.toISOString(),
          role: session.identity.role || 'user',
          router_decision: routerDecision,
        });

        // Format knowledge results
        const knowledgeHits = contextPack.knowledge_hits || [];
        if (knowledgeHits.length === 0) {
          return {
            success: true,
            result: 'No relevant knowledge found for this query.',
          };
        }

        const formatted = knowledgeHits
          .map((hit: any) => `**${hit.title || 'Knowledge'}**\n${hit.snippet || hit.content}`)
          .join('\n\n');

        console.log(`[VTID-01224] search_knowledge executed: ${knowledgeHits.length} hits, ${Date.now() - startTime}ms`);
        return {
          success: true,
          result: `Found ${knowledgeHits.length} relevant knowledge items:\n${formatted}`,
        };
      }

      case 'search_web': {
        const query = (args.query as string) || '';

        // Build context pack with web search focus
        const routerDecision = computeRetrievalRouterDecision(query, {
          channel: 'orb',
          force_sources: ['web_search'],
          limit_overrides: {
            memory_garden: 0,
            knowledge_hub: 0,
            web_search: 5,
          },
        });

        const contextPack = await buildContextPack({
          lens,
          query,
          channel: 'orb',
          thread_id: session.thread_id || session.sessionId,
          turn_number: session.turn_count,
          conversation_start: session.createdAt.toISOString(),
          role: session.identity.role || 'user',
          router_decision: routerDecision,
        });

        // Format web results
        const webHits = contextPack.web_hits || [];
        if (webHits.length === 0) {
          return {
            success: true,
            result: 'No relevant web results found for this query.',
          };
        }

        const formatted = webHits
          .map((hit: any) => `**${hit.title || 'Web Result'}**\n${hit.snippet || hit.content}\nSource: ${hit.url || hit.citation || 'web'}`)
          .join('\n\n');

        console.log(`[VTID-01224] search_web executed: ${webHits.length} hits, ${Date.now() - startTime}ms`);
        return {
          success: true,
          result: `Found ${webHits.length} relevant web results:\n${formatted}`,
        };
      }

      default:
        return {
          success: false,
          result: '',
          error: `Unknown tool: ${toolName}`,
        };
    }
  } catch (err: any) {
    console.error(`[VTID-01224] Tool execution error (${toolName}):`, err.message);
    return {
      success: false,
      result: '',
      error: `Tool execution failed: ${err.message}`,
    };
  }
}

/**
 * VTID-01224: Send function response back to Live API
 * After executing a tool, send the result back to Gemini
 */
function sendFunctionResponseToLiveAPI(
  ws: WebSocket,
  functionCallId: string,
  toolName: string,
  result: { success: boolean; result: string; error?: string }
): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn('[VTID-01224] Cannot send function response - WebSocket not open');
    return false;
  }

  // Build tool response message (Vertex AI format)
  const responseMessage = {
    tool_response: {
      function_responses: [
        {
          id: functionCallId,
          name: toolName,
          response: {
            output: result.success ? result.result : `Error: ${result.error}`,
          },
        },
      ],
    },
  };

  console.log(`[VTID-01224] Sending function response for ${toolName}: ${result.result.substring(0, 100)}...`);
  ws.send(JSON.stringify(responseMessage));
  return true;
}

/**
 * VTID-01219: Build system instruction for Live API
 * VTID-01224: Extended to accept bootstrap context
 */
function buildLiveSystemInstruction(
  lang: string,
  voiceStyle: string,
  bootstrapContext?: string
): string {
  const languageNames: Record<string, string> = {
    'en': 'English',
    'de': 'German',
    'fr': 'French',
    'es': 'Spanish',
    'ar': 'Arabic',
    'zh': 'Chinese',
    'ru': 'Russian',
    'sr': 'Serbian'
  };

  let instruction = `You are Vitana, an AI health companion assistant powered by Gemini Live.

LANGUAGE: Respond ONLY in ${languageNames[lang] || 'English'}.

VOICE STYLE: ${voiceStyle}

ROLE:
- You are a caring health companion for elderly users
- Focus on medication reminders, health tips, and wellness support
- Be warm, patient, and empathetic
- Keep responses concise for voice interaction (2-3 sentences max)
- Use natural conversational tone

TOOLS:
- Use search_memory to recall information the user has shared before
- Use search_knowledge for Vitana platform and health information
- Use search_web for current events, news, and external information

IMPORTANT:
- This is a real-time voice conversation
- Listen actively and respond naturally
- If interrupted, gracefully handle the interruption
- Confirm important information when needed
- Use tools to provide accurate, personalized responses`;

  // VTID-01224: Append bootstrap context if available
  if (bootstrapContext) {
    instruction += `\n\n${bootstrapContext}`;
  }

  return instruction;
}

/**
 * VTID-01219: Connect to Vertex AI Live API WebSocket
 * Establishes bidirectional audio streaming connection
 * Returns a Promise that resolves only after WebSocket is open and setup is complete
 */
async function connectToLiveAPI(
  session: GeminiLiveSession,
  onAudioResponse: (audioB64: string) => void,
  onTextResponse: (text: string) => void,
  onError: (error: Error) => void
): Promise<WebSocket> {
  console.log(`[VTID-01219] connectToLiveAPI called for session ${session.sessionId}`);

  // VTID-01222: Fail fast if project/location missing
  if (!VERTEX_PROJECT_ID || !VERTEX_LOCATION) {
    throw new Error('Missing VERTEX_PROJECT_ID or VERTEX_LOCATION');
  }

  // Get access token
  const accessToken = await getAccessToken();
  console.log(`[VTID-01219] Got access token (length: ${accessToken.length})`);

  // Build WebSocket URL for Vertex AI Live API
  // VTID-01222: Correct endpoint per Google documentation
  // https://github.com/GoogleCloudPlatform/generative-ai/blob/main/gemini/multimodal-live-api/intro_multimodal_live_api.ipynb
  const wsUrl = `wss://${VERTEX_LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;

  console.log(`[VTID-01219] Connecting to Live API: ${wsUrl}`);
  console.log(`[VTID-01219] Using model: ${VERTEX_LIVE_MODEL}`);
  console.log(`[VTID-01219] Project: ${VERTEX_PROJECT_ID}, Location: ${VERTEX_LOCATION}`);

  return new Promise((resolve, reject) => {
    // VTID-01222: Connect WITHOUT subprotocol - Google's official examples don't use one
    // Only Authorization header is required per documentation
    const ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    let setupComplete = false;
    const connectionTimeout = setTimeout(() => {
      if (!setupComplete) {
        console.error(`[VTID-01219] Live API connection timeout for session ${session.sessionId}`);
        ws.close();
        reject(new Error('Live API connection timeout'));
      }
    }, 15000); // 15 second timeout

    // Connection opened - send setup message
    ws.on('open', () => {
      console.log(`[VTID-01219] Live API WebSocket connected for session ${session.sessionId}`);

      // Send setup message with model and configuration
      // Vertex AI uses snake_case (unlike Google AI which uses camelCase)
      // VTID-01224: Include tools and bootstrap context
      const setupMessage = {
        setup: {
          model: `projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_LIVE_MODEL}`,
          generation_config: {
            response_modalities: session.responseModalities.includes('audio') ? ['AUDIO'] : ['TEXT'],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: {
                  voice_name: LIVE_API_VOICES[session.lang] || LIVE_API_VOICES['en']
                }
              }
            }
          },
          system_instruction: {
            parts: [{
              // VTID-01224: Pass bootstrap context to system instruction
              text: buildLiveSystemInstruction(
                session.lang,
                session.voiceStyle || 'friendly, calm, empathetic',
                session.contextInstruction
              )
            }]
          },
          // VTID-01224: Include tools for dynamic context retrieval during conversation
          tools: session.identity ? buildLiveApiTools() : []
        }
      };

      const setupPreview = JSON.stringify(setupMessage).substring(0, 800);
      console.log(`[VTID-01219] Sending setup message:`, setupPreview);
      console.log(`[VTID-01224] Setup includes: tools=${session.identity ? 3 : 0}, contextChars=${session.contextInstruction?.length || 0}`);
      ws.send(JSON.stringify(setupMessage));
      console.log(`[VTID-01219] Setup message sent for session ${session.sessionId}`);
    });

    // Handle incoming messages from Gemini
    ws.on('message', (data: WebSocket.Data) => {
      try {
        const rawData = data.toString();
        console.log(`[VTID-01219] Received message from Gemini (length: ${rawData.length}): ${rawData.substring(0, 300)}`);
        const message = JSON.parse(rawData);
        console.log(`[VTID-01219] Parsed message keys: ${Object.keys(message).join(', ')}`);

        // Check for setup completion (handle both snake_case and camelCase)
        if (message.setup_complete || message.setupComplete) {
          console.log(`[VTID-01219] Live API setup complete for session ${session.sessionId}`);
          setupComplete = true;
          clearTimeout(connectionTimeout);
          resolve(ws); // NOW we resolve the promise - connection is ready!
          return;
        }

        // Handle server content (audio/text responses) - handle both formats
        const serverContent = message.server_content || message.serverContent;
        if (serverContent) {
          const content = serverContent;

          // Check if turn is complete (handle both formats)
          const turnComplete = content.turn_complete || content.turnComplete;
          if (turnComplete) {
            console.log(`[VTID-01219] Turn complete for session ${session.sessionId}`);
            // Notify client that response is complete
            if (session.sseResponse) {
              session.sseResponse.write(`data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`);
            }
            return;
          }

          // Process model turn content (handle both formats)
          const modelTurn = content.model_turn || content.modelTurn;
          if (modelTurn && modelTurn.parts) {
            for (const part of modelTurn.parts) {
              // Handle audio response (handle both formats)
              const inlineData = part.inline_data || part.inlineData;
              const mimeType = inlineData?.mime_type || inlineData?.mimeType;
              if (inlineData && mimeType?.startsWith('audio/')) {
                session.audioOutChunks++;
                const audioB64 = inlineData.data;
                console.log(`[VTID-01219] Received audio chunk ${session.audioOutChunks}, size: ${audioB64.length}`);
                onAudioResponse(audioB64);

                // Emit OASIS event for audio output
                emitLiveSessionEvent('vtid.live.audio.out.chunk', {
                  session_id: session.sessionId,
                  chunk_number: session.audioOutChunks,
                  bytes: audioB64.length,
                  rate: 24000
                }).catch(() => {});
              }

              // Handle text response
              if (part.text) {
                console.log(`[VTID-01219] Received text: ${part.text.substring(0, 100)}`);
                onTextResponse(part.text);
              }
            }
          }

          // Handle input/output transcriptions if present (handle both formats)
          const inputTranscription = content.input_transcription || content.inputTranscription;
          const outputTranscription = content.output_transcription || content.outputTranscription;
          if (inputTranscription) {
            console.log(`[VTID-01219] Input transcription: ${inputTranscription}`);
            if (session.sseResponse) {
              session.sseResponse.write(`data: ${JSON.stringify({ type: 'input_transcript', text: inputTranscription })}\n\n`);
            }
          }
          if (outputTranscription) {
            console.log(`[VTID-01219] Output transcription: ${outputTranscription}`);
            if (session.sseResponse) {
              session.sseResponse.write(`data: ${JSON.stringify({ type: 'output_transcript', text: outputTranscription })}\n\n`);
            }
          }
        }

        // VTID-01224: Handle tool calls (function calling) - execute and respond
        const toolCall = message.tool_call || message.toolCall;
        if (toolCall) {
          console.log(`[VTID-01224] Tool call received for session ${session.sessionId}:`, JSON.stringify(toolCall).substring(0, 500));

          // Extract function calls (handle both formats)
          const functionCalls = toolCall.function_calls || toolCall.functionCalls || [];
          for (const fc of functionCalls) {
            const toolName = fc.name;
            const toolArgs = fc.args || {};
            const callId = fc.id || randomUUID();

            console.log(`[VTID-01224] Executing tool: ${toolName} with args: ${JSON.stringify(toolArgs)}`);

            // Execute the tool asynchronously
            executeLiveApiTool(session, toolName, toolArgs)
              .then((result) => {
                // Send response back to Live API
                sendFunctionResponseToLiveAPI(ws, callId, toolName, result);

                // Emit OASIS event for tool execution
                emitOasisEvent({
                  vtid: 'VTID-01224',
                  type: 'orb.live.tool.executed',
                  source: 'orb-live-ws',
                  status: result.success ? 'info' : 'warning',
                  message: `Tool ${toolName} executed: ${result.success ? 'success' : 'failed'}`,
                  payload: {
                    session_id: session.sessionId,
                    tool_name: toolName,
                    tool_args: toolArgs,
                    success: result.success,
                    result_preview: result.result.substring(0, 200),
                    error: result.error || null,
                  },
                }).catch(() => {});
              })
              .catch((err) => {
                console.error(`[VTID-01224] Tool execution error:`, err);
                sendFunctionResponseToLiveAPI(ws, callId, toolName, {
                  success: false,
                  result: '',
                  error: err.message,
                });
              });
          }
        }

      } catch (err) {
        console.error(`[VTID-01219] Error parsing Live API message:`, err);
      }
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
      console.error(`[VTID-01219] Live API WebSocket error for session ${session.sessionId}:`, error);
      clearTimeout(connectionTimeout);
      if (!setupComplete) {
        reject(error);
      }
      onError(error);
    });

    // Handle WebSocket close
    ws.on('close', (code, reason) => {
      console.log(`[VTID-01219] Live API WebSocket closed for session ${session.sessionId}: code=${code}, reason=${reason}`);
      clearTimeout(connectionTimeout);
      session.upstreamWs = null;
      if (!setupComplete) {
        reject(new Error(`WebSocket closed before setup: code=${code}, reason=${reason}`));
      }
    });
  });
}

/**
 * VTID-01219: Send audio chunk to Live API
 * Forwards audio from client to Gemini for real-time processing
 */
function sendAudioToLiveAPI(ws: WebSocket, audioB64: string, mimeType: string = 'audio/pcm;rate=16000'): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn('[VTID-01219] Cannot send audio - WebSocket not open, state:', ws.readyState);
    return false;
  }

  // Build realtime input message (Vertex AI uses snake_case)
  const message = {
    realtime_input: {
      media_chunks: [{
        mime_type: mimeType,
        data: audioB64
      }]
    }
  };

  ws.send(JSON.stringify(message));
  return true;
}

/**
 * VTID-01219: Send end of turn signal to Live API
 * Tells Gemini that user has finished speaking
 */
function sendEndOfTurn(ws: WebSocket): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  // Vertex AI uses snake_case
  const message = {
    client_content: {
      turn_complete: true
    }
  };

  ws.send(JSON.stringify(message));
  return true;
}

/**
 * VTID-01155: Convert raw PCM audio data to WAV format
 * Gemini TTS returns audio/L16;codec=pcm;rate=24000 (16-bit PCM at 24kHz mono)
 * Browser Audio element cannot play raw PCM, needs WAV headers
 */
function pcmToWav(pcmBase64: string, sampleRate = 24000, numChannels = 1, bitsPerSample = 16): string {
  // Decode base64 PCM data
  const pcmData = Buffer.from(pcmBase64, 'base64');
  const pcmLength = pcmData.length;

  // WAV header is 44 bytes
  const wavHeaderSize = 44;
  const wavBuffer = Buffer.alloc(wavHeaderSize + pcmLength);

  // RIFF header
  wavBuffer.write('RIFF', 0);
  wavBuffer.writeUInt32LE(wavHeaderSize + pcmLength - 8, 4); // File size - 8
  wavBuffer.write('WAVE', 8);

  // fmt subchunk
  wavBuffer.write('fmt ', 12);
  wavBuffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  wavBuffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  wavBuffer.writeUInt16LE(numChannels, 22); // NumChannels
  wavBuffer.writeUInt32LE(sampleRate, 24); // SampleRate
  wavBuffer.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28); // ByteRate
  wavBuffer.writeUInt16LE(numChannels * bitsPerSample / 8, 32); // BlockAlign
  wavBuffer.writeUInt16LE(bitsPerSample, 34); // BitsPerSample

  // data subchunk
  wavBuffer.write('data', 36);
  wavBuffer.writeUInt32LE(pcmLength, 40); // Subchunk2Size

  // Copy PCM data
  pcmData.copy(wavBuffer, wavHeaderSize);

  // Return as base64
  return wavBuffer.toString('base64');
}

/**
 * VTID-01155: Process multimodal chat with images
 * Uses Gemini API directly with image data for screen/camera sharing
 */
async function processMultimodalChat(
  inputText: string,
  images: Array<{ data_b64: string; mime: string; source?: string }>,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemInstruction?: string
): Promise<{ reply: string; provider: string; model: string }> {
  console.log(`[VTID-01155] Processing multimodal chat with ${images.length} image(s)`);

  // Build content parts with text and images
  const parts: any[] = [];

  // Add images first
  for (const img of images) {
    parts.push({
      inlineData: {
        mimeType: img.mime || 'image/jpeg',
        data: img.data_b64
      }
    });
    console.log(`[VTID-01155] Added ${img.source || 'unknown'} image (${img.mime})`);
  }

  // Add text prompt
  parts.push({ text: inputText });

  // Build contents array with conversation history
  const contents: any[] = [];

  // Add conversation history (text only)
  for (const msg of conversationHistory.slice(-10)) {  // Last 10 messages
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  }

  // Add current user message with images
  contents.push({
    role: 'user',
    parts
  });

  const requestBody: any = {
    contents,
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 2048
    }
  };

  // Add system instruction if provided
  if (systemInstruction) {
    requestBody.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  // Use the multimodal-capable model
  const multimodalModel = 'gemini-2.0-flash-exp';  // Supports vision
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${multimodalModel}:generateContent`;

  const response = await fetch(`${apiUrl}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[VTID-01155] Multimodal API error: ${response.status} - ${errorText}`);
    throw new Error(`Multimodal API error: ${response.status}`);
  }

  const data = await response.json() as any;
  const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  console.log(`[VTID-01155] Multimodal response received: ${replyText.substring(0, 50)}...`);

  return {
    reply: replyText,
    provider: 'gemini-multimodal',
    model: multimodalModel
  };
}

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
 *
 * VTID-01186: Now accepts optional identity parameter to use authenticated user's memory.
 */
async function generateMemoryEnhancedSystemInstruction(
  session: { tenant: string; role: string; route?: string; selectedId?: string },
  identity?: MemoryIdentity | null
): Promise<{ instruction: string; memoryContext: OrbMemoryContext | null; contextBundle?: ContextBundle }> {
  // VTID-01186: Determine effective identity (authenticated or DEV_IDENTITY fallback)
  const effectiveIdentity: MemoryIdentity = identity && identity.user_id && identity.tenant_id
    ? identity
    : { user_id: DEV_IDENTITY.USER_ID, tenant_id: DEV_IDENTITY.TENANT_ID, active_role: DEV_IDENTITY.ACTIVE_ROLE };
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
  // VTID-01186: Use effective identity for memory lookups
  if (isMemoryIndexerEnabled()) {
    console.log('[VTID-01153] Memory indexer enabled, fetching context from Mem0');
    try {
      const mem0Result = await buildMemoryIndexerEnhancedInstruction(
        baseInstructionWithMemory,
        effectiveIdentity.user_id,
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
    // VTID-01186: Use effective identity for context assembly
    // This ensures all downstream intelligence uses ranked, unified context
    const contextResult = await getOrbContext(
      effectiveIdentity.user_id,
      effectiveIdentity.tenant_id,
      effectiveIdentity.active_role || 'user',
      'conversation' // ORB default intent
    );

    if (!contextResult.ok || !contextResult.bundle) {
      console.log(`[VTID-01112] Context assembly failed: ${contextResult.error}`);
      // Fallback to legacy memory bridge with identity-aware function
      const memoryContext = await fetchMemoryContextWithIdentity(effectiveIdentity);
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

**CALCULATIONS WITH MEMORY DATA - USE run_code:**
5. When the user asks for calculations based on data in your memory (age difference, days between dates, how old someone is, etc.), YOU MUST:
   - First, extract the relevant data from your memory context below
   - Then, call the run_code tool with JavaScript code to calculate
   - NEVER say "I don't have access to your data" - you DO have it in the context below!
6. Example: If asked "age difference between me and my fiancée" and you have both birthdays in context:
   - Extract: user birthday = Sept 9, 1969, fiancée birthday = Nov 4, 1997
   - Call run_code with: const d1 = new Date('1969-09-09'); const d2 = new Date('1997-11-04'); return daysBetween(d1, d2);
7. ALWAYS use run_code for: age calculations, date differences, percentages, conversions, any math

**STORING NEW INFORMATION - CRITICAL:**
8. When the user tells you NEW personal information (name, birthday, family member's birthday, preferences, etc.), the system AUTOMATICALLY STORES IT in persistent memory.
9. NEVER say "I cannot store this", "ich kann nicht speichern", or "I don't have the ability to save". The system DOES store it automatically.
10. When the user provides new info, ACKNOWLEDGE it positively: "Got it, I'll remember that" / "Notiert!" / "Ich merke mir das"

---
${contextForPrompt}
---

You KNOW this user. You REMEMBER their name, their hometown, their family. USE the data above to answer questions. For any calculation, USE the run_code tool.`;

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
router.post('/chat', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body as OrbChatRequest;

  // VTID-01186: Extract identity from authenticated request or fallback to DEV_IDENTITY
  const identity = getMemoryIdentity(req);
  console.log(`[VTID-01186] POST /orb/chat received (user=${identity.user_id ? identity.user_id.substring(0,8) + '...' : 'none'})`);

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
  // VTID-01186: Use identity-aware memory write with req.identity or DEV_IDENTITY fallback
  const isVoice = body.meta?.mode === 'orb_voice';
  const memorySource = isVoice ? 'orb_voice' : 'orb_text';
  const requestId = randomUUID();

  // VTID-01186: Write memory with authenticated identity (fire-and-forget)
  if (hasValidIdentity(req)) {
    writeMemoryItemWithIdentity(identity, {
      source: memorySource,
      content: inputText,
      content_json: {
        direction: 'user',
        channel: 'orb',
        mode: isVoice ? 'voice' : 'text',
        request_id: requestId,
        orb_session_id: orbSessionId,
        conversation_id: conversationId
      },
      workspace_scope: 'dev'
    }).then(result => {
      if (result.ok && !result.skipped) {
        console.log(`[VTID-01186] User message written to memory: ${result.id} (user=${identity.user_id.substring(0,8)}...)`);
        emitMemoryWriteEvent('memory.write.user_message', {
          memory_id: result.id,
          category_key: result.category_key,
          orb_session_id: orbSessionId,
          conversation_id: conversationId,
          source: memorySource,
          user_id: identity.user_id,
          tenant_id: identity.tenant_id
        });
      } else if (result.skipped) {
        console.log(`[VTID-01186] User message skipped (trivial)`);
      } else {
        console.warn('[VTID-01186] User message memory write failed:', result.error);
      }
    }).catch(err => {
      console.warn('[VTID-01186] User message memory write error:', err.message);
    });
  }

  // VTID-01153: Write to memory-indexer (Mem0 OSS) - fire-and-forget
  // VTID-01186: Use identity from request
  if (isMemoryIndexerEnabled() && identity.user_id) {
    writeToMemoryIndexer({
      user_id: identity.user_id,
      content: inputText,
      role: 'user',
      metadata: {
        source: 'orb',
        orb_session_id: orbSessionId,
        conversation_id: conversationId,
        vtid: 'VTID-01153',
        tenant_id: identity.tenant_id
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
    // VTID-01186: Pass identity for authenticated memory access
    // Extract context from meta (cast to any for dev sandbox flexibility)
    const meta = body.meta as Record<string, unknown> | undefined;
    const { instruction: baseSystemInstruction, memoryContext } = await generateMemoryEnhancedSystemInstruction({
      tenant: (meta?.tenant as string) || 'vitana',
      role: (meta?.role as string) || 'developer',
      route: meta?.route as string | undefined,
      selectedId: meta?.selectedId as string | undefined
    }, identity);

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
    // VTID-01158: ORB Router Fix — Enforce OASIS-Only Task Discovery
    // HARD GOVERNANCE: For any query about tasks/VTIDs/scheduled/pending/in progress,
    // ORB MUST use OASIS discover_tasks. NO fallback to repo scans or memory.
    // =========================================================================

    if (detectedIntent === 'task_state_query' || isTaskStateQuery(inputText)) {
      console.log(`[VTID-01158] Task state query detected, routing to OASIS discover_tasks`);

      // Execute OASIS-only task discovery
      const taskQueryResult = await executeTaskStateQuery({
        tenant: (meta?.tenant as string) || 'vitana',
        environment: (meta?.environment as string) || 'dev_sandbox',
        statuses: ['scheduled', 'allocated', 'in_progress'],
        limit: 50
      });

      // Log OASIS event for traceability
      await emitOasisEvent({
        vtid: 'VTID-01158',
        type: 'orb.task_state_query.completed',
        source: 'orb-live',
        status: taskQueryResult.ok ? 'success' : 'error',
        message: taskQueryResult.ok
          ? `Task state query completed: ${taskQueryResult.counts.total_pending} pending tasks`
          : `Task state query failed: ${taskQueryResult.error}`,
        payload: {
          orb_session_id: orbSessionId,
          conversation_id: conversationId,
          user_id: DEV_IDENTITY.USER_ID,
          query_result: {
            ok: taskQueryResult.ok,
            pending_count: taskQueryResult.counts.total_pending,
            ignored_count: taskQueryResult.counts.ignored,
            status_breakdown: {
              scheduled: taskQueryResult.counts.scheduled,
              allocated: taskQueryResult.counts.allocated,
              in_progress: taskQueryResult.counts.in_progress
            }
          }
        }
      }).catch((err: Error) => console.warn('[VTID-01158] OASIS event failed:', err.message));

      // Update conversation history with response
      conversation.history.push({ role: 'user', content: inputText });
      conversation.history.push({ role: 'assistant', content: taskQueryResult.response_text });

      // Append to transcript
      if (transcript) {
        transcript.turns.push({
          role: 'user',
          text: inputText,
          ts: new Date().toISOString()
        });
        transcript.turns.push({
          role: 'assistant',
          text: taskQueryResult.response_text,
          ts: new Date().toISOString()
        });
      }

      console.log(`[VTID-01158] Task state query response: ${taskQueryResult.ok ? 'success' : 'failed'}, ${taskQueryResult.counts.total_pending} pending tasks`);

      // Return OASIS-sourced response (NO FALLBACK to Gemini/memory)
      return res.status(200).json({
        ok: true,
        conversation_id: conversationId,
        reply_text: taskQueryResult.response_text,
        meta: {
          provider: 'oasis-discover-tasks',
          model: 'vtid-01158',
          mode: 'orb_voice',
          vtid: 'VTID-01158',
          source_of_truth: 'OASIS',
          task_query_result: {
            ok: taskQueryResult.ok,
            pending_count: taskQueryResult.counts.total_pending,
            ignored_count: taskQueryResult.counts.ignored,
            status_breakdown: {
              scheduled: taskQueryResult.counts.scheduled,
              allocated: taskQueryResult.counts.allocated,
              in_progress: taskQueryResult.counts.in_progress
            }
          }
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

    // VTID-01155: Check if images are provided for multimodal processing
    let replyText: string;
    let provider: string;
    let model: string;
    let toolResults: Array<{ name: string; response: unknown }> = [];
    let latencyMs = 0;

    if (body.images && body.images.length > 0) {
      // VTID-01155: Use multimodal processing with images (screen/camera)
      console.log(`[VTID-01155] Processing with ${body.images.length} image(s)`);
      const multimodalResponse = await processMultimodalChat(
        inputText,
        body.images,
        conversation.history,
        systemInstruction
      );
      replyText = multimodalResponse.reply || 'I apologize, but I could not generate a response.';
      provider = multimodalResponse.provider;
      model = multimodalResponse.model;
      // Multimodal doesn't return tool results or latency
    } else {
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
      replyText = geminiResponse.reply || 'I apologize, but I could not generate a response.';
      provider = (geminiResponse.meta?.provider as string) || 'vertex';
      model = (geminiResponse.meta?.model as string) || 'gemini-2.5-pro';
      toolResults = (geminiResponse.toolResults as Array<{ name: string; response: unknown }>) || [];
      latencyMs = (geminiResponse.meta?.latency_ms as number) || 0;
    }

    // Update conversation history
    conversation.history.push({ role: 'user', content: inputText });
    conversation.history.push({ role: 'assistant', content: replyText });

    // Limit history to last 20 turns (10 pairs) to avoid context overflow
    if (conversation.history.length > 20) {
      conversation.history = conversation.history.slice(-20);
    }

    // VTID-01118: Update cross-turn state with turn results
    // Extract tool calls from response for state tracking
    const toolCalls = toolResults.map((tr: { name: string; response: unknown }) => ({
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
    // VTID-01186: Use identity-aware memory write with req.identity or DEV_IDENTITY fallback
    if (hasValidIdentity(req)) {
      writeMemoryItemWithIdentity(identity, {
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
        },
        workspace_scope: 'dev'
      }).then(result => {
        if (result.ok && !result.skipped) {
          console.log(`[VTID-01186] Assistant message written to memory: ${result.id} (user=${identity.user_id.substring(0,8)}...)`);
          emitMemoryWriteEvent('memory.write.assistant_message', {
            memory_id: result.id,
            category_key: result.category_key,
            orb_session_id: orbSessionId,
            conversation_id: conversationId,
            source: memorySource,
            model,
            latency_ms: latencyMs,
            user_id: identity.user_id,
            tenant_id: identity.tenant_id
          });
        } else if (result.skipped) {
          console.log(`[VTID-01186] Assistant message skipped (trivial)`);
        } else {
          console.warn('[VTID-01186] Assistant message memory write failed:', result.error);
        }
      }).catch(err => {
        console.warn('[VTID-01186] Assistant message memory write error:', err.message);
      });
    }

    // VTID-DEBUG-MEM: Write assistant response to memory-indexer (Mem0 OSS) - fire-and-forget
    // VTID-01186: Use identity from request
    // This ensures conversation continuity - the LLM needs to know what it said previously
    if (isMemoryIndexerEnabled() && identity.user_id) {
      writeToMemoryIndexer({
        user_id: identity.user_id,
        content: replyText,
        role: 'assistant',
        metadata: {
          source: 'orb',
          orb_session_id: orbSessionId,
          conversation_id: conversationId,
          model,
          provider,
          latency_ms: latencyMs,
          vtid: 'VTID-DEBUG-MEM',
          tenant_id: identity.tenant_id
        }
      }).then(result => {
        if (result.stored) {
          console.log(`[VTID-DEBUG-MEM] Assistant response written to Mem0: ${result.memory_ids.join(', ')}`);
        } else {
          console.log(`[VTID-DEBUG-MEM] Assistant response not stored in Mem0: ${result.decision}`);
        }
      }).catch(err => {
        console.warn('[VTID-DEBUG-MEM] Mem0 assistant write error:', err.message);
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

    // VTID-01225: Fire-and-forget Cognee entity extraction from transcript
    if (cogneeExtractorClient.isEnabled() && transcript.turns.length > 0) {
      const fullTranscript = transcript.turns
        .map(turn => `${turn.role}: ${turn.text}`)
        .join('\n');

      // Note: Using dev sandbox defaults since OrbSessionTranscript doesn't track user context
      const tenantId = process.env.DEV_SANDBOX_TENANT_ID || '00000000-0000-0000-0000-000000000001';
      const userId = process.env.DEV_SANDBOX_USER_ID || '00000000-0000-0000-0000-000000000099';

      cogneeExtractorClient.extractAsync({
        transcript: fullTranscript,
        tenant_id: tenantId,
        user_id: userId,
        session_id: orb_session_id,
        active_role: 'community'
      });
      console.log(`[VTID-01225] Cognee extraction queued for session: ${orb_session_id}`);
    }
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

  // VTID-01225: Fire-and-forget Cognee entity extraction from transcript
  // Only extract if there are turns and cognee is enabled
  if (cogneeExtractorClient.isEnabled() && transcript.turns.length > 0) {
    // Combine all turns into a single transcript text
    const fullTranscript = transcript.turns
      .map(turn => `${turn.role}: ${turn.text}`)
      .join('\n');

    // Note: Using dev sandbox defaults since OrbSessionTranscript doesn't track user context
    const tenantId = process.env.DEV_SANDBOX_TENANT_ID || '00000000-0000-0000-0000-000000000001';
    const userId = process.env.DEV_SANDBOX_USER_ID || '00000000-0000-0000-0000-000000000099';

    const extractionRequest: CogneeExtractionRequest = {
      transcript: fullTranscript,
      tenant_id: tenantId,
      user_id: userId,
      session_id: orb_session_id,
      active_role: 'community'  // Default role for voice sessions
    };

    // Fire-and-forget - don't await, don't block response
    cogneeExtractorClient.extractAsync(extractionRequest);
    console.log(`[VTID-01225] Cognee extraction queued for session: ${orb_session_id}`);
  }

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
 * VTID-01155: GET /debug/tts - TTS Debug Endpoint
 *
 * Tests Google Cloud TTS with Gemini model and returns detailed debug info.
 * Helps diagnose why TTS might be failing.
 *
 * Query params:
 * - text: Text to speak (optional, defaults to "Hello, this is a test")
 * - lang: Language code (optional, defaults to "en")
 *
 * Response:
 * {
 *   "ok": true/false,
 *   "tts_client_ready": true/false,
 *   "voice": "Kore",
 *   "audio_bytes": 12345,
 *   "error": "..." (if failed)
 * }
 */
router.get('/debug/tts', async (req: Request, res: Response) => {
  console.log('[VTID-01155] Debug TTS endpoint accessed');

  const testText = (req.query.text as string) || 'Hello, this is a TTS test.';
  const lang = normalizeLang((req.query.lang as string) || 'en');
  const voiceConfig = GEMINI_TTS_VOICES[lang] || GEMINI_TTS_VOICES['en'];

  const debugResult: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    tts_client_ready: !!ttsClient,
    model: 'gemini-2.5-flash-tts',
    voice: voiceConfig.name,
    language_code: voiceConfig.languageCode,
    lang: lang,
    test_text: testText,
    test_text_length: testText.length
  };

  if (!ttsClient) {
    return res.status(200).json({
      ok: false,
      ...debugResult,
      error: 'Google Cloud TTS client not initialized'
    });
  }

  try {
    console.log(`[VTID-01155] Debug TTS: testing Cloud TTS with voice=${voiceConfig.name}, lang=${voiceConfig.languageCode}`);

    const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
      input: { text: testText },
      voice: {
        languageCode: voiceConfig.languageCode,
        name: voiceConfig.name,
        // @ts-ignore - modelName is supported but types may be outdated
        modelName: 'gemini-2.5-flash-tts'
      },
      audioConfig: {
        audioEncoding: 'MP3' as any,
        speakingRate: 1.0,
        pitch: 0
      }
    };

    debugResult.request = request;

    const [response] = await ttsClient.synthesizeSpeech(request);

    debugResult.has_audio_content = !!response.audioContent;

    if (!response.audioContent) {
      return res.status(200).json({
        ok: false,
        ...debugResult,
        error: 'No audio content in response'
      });
    }

    const audioBytes = Buffer.isBuffer(response.audioContent)
      ? response.audioContent.length
      : (response.audioContent as Uint8Array).length;

    debugResult.audio_bytes = audioBytes;

    // Success!
    return res.status(200).json({
      ok: true,
      ...debugResult,
      message: 'Google Cloud TTS with Gemini model working correctly'
    });

  } catch (err: any) {
    console.error('[VTID-01155] Debug TTS error:', err.message);
    return res.status(200).json({
      ok: false,
      ...debugResult,
      error: err.message,
      error_code: err.code,
      error_details: err.details,
      stack: err.stack?.substring(0, 500)
    });
  }
});

// =============================================================================
// VTID-01155: Gemini Live Multimodal Session Endpoints
// =============================================================================

/**
 * VTID-01155: Helper to emit Live session events to OASIS
 */
async function emitLiveSessionEvent(
  eventType: 'vtid.live.session.start' | 'vtid.live.session.stop' | 'vtid.live.audio.in.chunk' | 'vtid.live.video.in.frame' | 'vtid.live.audio.out.chunk',
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: 'VTID-01155',
      type: eventType,
      source: 'gateway',
      status: 'info',
      message: `Live session event: ${eventType}`,
      payload: {
        ...payload,
        service: 'gateway',
        component: 'orb-live',
        env: isDevSandbox() ? 'dev-sandbox' : 'production'
      }
    });
  } catch (err: any) {
    console.warn(`[VTID-01155] Failed to emit ${eventType}:`, err.message);
  }
}

/**
 * VTID-01155: Helper to emit TTS events to OASIS
 */
async function emitTtsEvent(
  eventType: 'vtid.tts.request' | 'vtid.tts.success' | 'vtid.tts.failure',
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: 'VTID-01155',
      type: eventType,
      source: 'gateway',
      status: eventType === 'vtid.tts.failure' ? 'error' : 'info',
      message: `TTS event: ${eventType}`,
      payload: {
        ...payload,
        service: 'gateway',
        component: 'orb-live',
        env: isDevSandbox() ? 'dev-sandbox' : 'production'
      }
    });
  } catch (err: any) {
    console.warn(`[VTID-01155] Failed to emit ${eventType}:`, err.message);
  }
}

/**
 * VTID-01155: Normalize language code to 2-letter ISO
 */
function normalizeLang(lang: string): string {
  const lowerLang = lang.toLowerCase();
  // Handle full locale codes like 'en-US', 'de-DE', 'sr-RS', 'ru-RU'
  const langPart = lowerLang.split('-')[0];
  return SUPPORTED_LIVE_LANGUAGES.includes(langPart) ? langPart : 'en';
}

/**
 * VTID-01155: Get voice name for language
 */
function getVoiceForLang(lang: string): string {
  const normalized = normalizeLang(lang);
  return LIVE_LANGUAGE_VOICES[normalized] || LIVE_LANGUAGE_VOICES['en'];
}

/**
 * VTID-01155: POST /live/session/start - Start Gemini Live API session
 *
 * Creates a Live API session for real-time audio/video streaming.
 * Gateway maintains upstream WebSocket to Vertex Live API.
 *
 * Request:
 * {
 *   "lang": "en|de|fr|es|ar|zh|sr|ru",
 *   "voice_style": "friendly, calm, empathetic (optional)",
 *   "response_modalities": ["audio","text"]
 * }
 *
 * Response:
 * { "ok": true, "session_id": "live-xxx" }
 */
router.post('/live/session/start', async (req: Request, res: Response) => {
  console.log('[VTID-01155] POST /orb/live/session/start');

  // Validate origin
  if (!validateOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }

  const body = req.body as LiveSessionStartRequest;
  const lang = normalizeLang(body.lang || 'en');
  const voiceStyle = body.voice_style || 'friendly, calm, empathetic';
  const responseModalities = body.response_modalities || ['audio', 'text'];

  // Generate session ID
  const sessionId = `live-${randomUUID()}`;

  // Create session object
  const session: GeminiLiveSession = {
    sessionId,
    lang,
    voiceStyle,
    responseModalities,
    upstreamWs: null,
    sseResponse: null,
    active: true,
    createdAt: new Date(),
    lastActivity: new Date(),
    audioInChunks: 0,
    videoInFrames: 0,
    audioOutChunks: 0,
    // VTID-01224: Required fields for context
    turn_count: 0,
  };

  // Store session
  liveSessions.set(sessionId, session);

  // Emit OASIS event
  await emitLiveSessionEvent('vtid.live.session.start', {
    session_id: sessionId,
    lang,
    modalities: responseModalities,
    voice: getVoiceForLang(lang)
  });

  console.log(`[VTID-01155] Live session created: ${sessionId} (lang=${lang})`);

  return res.status(200).json({
    ok: true,
    session_id: sessionId,
    meta: {
      lang,
      voice: getVoiceForLang(lang),
      modalities: responseModalities,
      model: VERTEX_LIVE_MODEL
    }
  });
});

/**
 * VTID-01155: POST /live/session/stop - Stop Gemini Live session
 *
 * Stops upstream session and cleans resources.
 *
 * Request:
 * { "session_id": "live-xxx" }
 */
router.post('/live/session/stop', async (req: Request, res: Response) => {
  console.log('[VTID-01155] POST /orb/live/session/stop');

  const { session_id } = req.body;

  if (!session_id) {
    return res.status(400).json({ ok: false, error: 'session_id required' });
  }

  const session = liveSessions.get(session_id);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  // Close upstream WebSocket if exists
  if (session.upstreamWs) {
    try {
      session.upstreamWs.close();
    } catch (e) {
      // Ignore close errors
    }
    session.upstreamWs = null;
  }

  // Close SSE response if exists
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

  // Emit OASIS event
  await emitLiveSessionEvent('vtid.live.session.stop', {
    session_id,
    audio_in_chunks: session.audioInChunks,
    video_in_frames: session.videoInFrames,
    audio_out_chunks: session.audioOutChunks,
    duration_ms: Date.now() - session.createdAt.getTime()
  });

  // Remove from store
  liveSessions.delete(session_id);

  console.log(`[VTID-01155] Live session stopped: ${session_id}`);

  return res.status(200).json({ ok: true });
});

/**
 * VTID-01155: GET /live/stream - SSE endpoint for bidirectional streaming
 *
 * Client connects to this SSE endpoint to receive audio output from the model.
 * Client sends audio/video data via POST /live/stream/send
 *
 * Query params:
 * - session_id: The live session ID
 */
router.get('/live/stream', async (req: Request, res: Response) => {
  console.log('[VTID-01155] GET /orb/live/stream');

  const sessionId = req.query.session_id as string;
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: 'session_id required' });
  }

  const session = liveSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ ok: false, error: 'Session not active' });
  }

  // Check connection limit
  const clientIP = getClientIP(req);
  if (!checkConnectionLimit(clientIP)) {
    return res.status(429).json({ ok: false, error: 'Too many connections' });
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

  // VTID-01219: Connect to Vertex AI Live API WebSocket
  let liveApiConnected = false;
  if (googleAuth && VERTEX_PROJECT_ID) {
    try {
      console.log(`[VTID-01219] Connecting to Vertex AI Live API for session ${sessionId}...`);

      const ws = await connectToLiveAPI(
        session,
        // Audio response handler - forward to client via SSE
        (audioB64: string) => {
          if (session.sseResponse) {
            try {
              // Convert PCM to WAV for browser playback
              const wavB64 = pcmToWav(audioB64, 24000, 1, 16);
              session.sseResponse.write(`data: ${JSON.stringify({
                type: 'audio',
                data_b64: wavB64,
                mime: 'audio/wav',
                chunk_number: session.audioOutChunks
              })}\n\n`);
            } catch (err) {
              console.error('[VTID-01219] Error sending audio to client:', err);
            }
          }
        },
        // Text response handler - forward to client via SSE
        (text: string) => {
          if (session.sseResponse) {
            try {
              session.sseResponse.write(`data: ${JSON.stringify({
                type: 'transcript',
                text
              })}\n\n`);
            } catch (err) {
              console.error('[VTID-01219] Error sending transcript to client:', err);
            }
          }
        },
        // Error handler
        (error: Error) => {
          console.error(`[VTID-01219] Live API error for session ${sessionId}:`, error);
          if (session.sseResponse) {
            try {
              session.sseResponse.write(`data: ${JSON.stringify({
                type: 'error',
                message: 'Live API connection error'
              })}\n\n`);
            } catch (err) {
              // Ignore
            }
          }
        }
      );

      session.upstreamWs = ws;
      liveApiConnected = true;
      console.log(`[VTID-01219] Live API WebSocket connected for session ${sessionId}`);
    } catch (err: any) {
      console.error(`[VTID-01219] Failed to connect Live API for session ${sessionId}:`, err.message);
      // Continue without Live API - will fall back to simulated responses
    }
  } else {
    console.warn('[VTID-01219] Live API not available - missing auth or project ID');
  }

  // Send ready event with session config
  res.write(`data: ${JSON.stringify({
    type: 'ready',
    session_id: sessionId,
    live_api_connected: liveApiConnected,
    meta: {
      model: VERTEX_LIVE_MODEL,
      lang: session.lang,
      voice: liveApiConnected ? LIVE_API_VOICES[session.lang] || LIVE_API_VOICES['en'] : getVoiceForLang(session.lang),
      audio_out_rate: 24000,  // 24kHz output
      audio_in_rate: 16000    // 16kHz input
    }
  })}\n\n`);

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
    console.log(`[VTID-01155] Live stream disconnected: ${sessionId}`);
    clearInterval(heartbeatInterval);
    decrementConnection(clientIP);
    if (session.sseResponse === res) {
      session.sseResponse = null;
    }
    // VTID-01219: Close upstream WebSocket on client disconnect
    if (session.upstreamWs) {
      try {
        session.upstreamWs.close();
      } catch (e) {
        // Ignore
      }
      session.upstreamWs = null;
    }
  });
});

/**
 * VTID-01155: POST /live/stream/send - Send audio/video data to Live session
 *
 * Client sends audio chunks (PCM 16kHz) or video frames (JPEG) to this endpoint.
 * Gateway forwards to Vertex Live API and relays responses via SSE.
 *
 * Request:
 * For audio: { "type": "audio", "data_b64": "...", "mime": "audio/pcm;rate=16000" }
 * For video: { "type": "video", "source": "screen|camera", "data_b64": "...", "width": 768, "height": 768 }
 */
router.post('/live/stream/send', async (req: Request, res: Response) => {
  const { session_id } = req.query;
  const body = req.body as LiveStreamMessage & { session_id?: string };
  const effectiveSessionId = (session_id as string) || body.session_id;

  if (!effectiveSessionId) {
    return res.status(400).json({ ok: false, error: 'session_id required' });
  }

  const session = liveSessions.get(effectiveSessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ ok: false, error: 'Session not active' });
  }

  session.lastActivity = new Date();

  try {
    if (body.type === 'audio') {
      // Handle audio chunk
      session.audioInChunks++;

      // Emit OASIS event (sample every 10th chunk to avoid flooding)
      if (session.audioInChunks % 10 === 0) {
        emitLiveSessionEvent('vtid.live.audio.in.chunk', {
          session_id: effectiveSessionId,
          chunk_number: session.audioInChunks,
          bytes: body.data_b64.length,
          rate: 16000
        }).catch(() => {});
      }

      // VTID-01219: Forward audio to Vertex Live API WebSocket
      if (session.upstreamWs && session.upstreamWs.readyState === WebSocket.OPEN) {
        // Forward audio to Live API for real-time processing
        const sent = sendAudioToLiveAPI(session.upstreamWs, body.data_b64, body.mime || 'audio/pcm;rate=16000');
        if (sent) {
          console.log(`[VTID-01219] Audio chunk forwarded to Live API: session=${effectiveSessionId}, chunk=${session.audioInChunks}`);
        } else {
          console.warn(`[VTID-01219] Failed to forward audio chunk: session=${effectiveSessionId}`);
        }
      } else {
        // Fallback: Log when Live API not connected
        console.log(`[VTID-01155] Audio chunk received (no Live API): session=${effectiveSessionId}, chunk=${session.audioInChunks}`);

        // Send acknowledgment via SSE (fallback behavior)
        if (session.sseResponse && session.audioInChunks % 5 === 0) {
          session.sseResponse.write(`data: ${JSON.stringify({
            type: 'audio_ack',
            chunk_number: session.audioInChunks,
            live_api: false
          })}\n\n`);
        }
      }

    } else if (body.type === 'video') {
      // Handle video frame
      session.videoInFrames++;
      const videoBody = body as LiveStreamVideoFrame;

      // Emit OASIS event
      emitLiveSessionEvent('vtid.live.video.in.frame', {
        session_id: effectiveSessionId,
        source: videoBody.source,
        frame_number: session.videoInFrames,
        bytes: videoBody.data_b64.length,
        fps: 1
      }).catch(() => {});

      console.log(`[VTID-01155] Video frame received: session=${effectiveSessionId}, source=${videoBody.source}, frame=${session.videoInFrames}`);

      // Acknowledge frame receipt via SSE
      if (session.sseResponse) {
        session.sseResponse.write(`data: ${JSON.stringify({
          type: 'video_ack',
          source: videoBody.source,
          frame_number: session.videoInFrames
        })}\n\n`);
      }
    }

    return res.status(200).json({ ok: true });

  } catch (error: any) {
    console.error(`[VTID-01155] Stream send error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * VTID-01219: POST /live/stream/end-turn - Signal end of user turn
 *
 * Client calls this when user stops speaking (voice activity detection).
 * Tells Gemini Live API that the user has finished their input.
 *
 * Request:
 * { "session_id": "live-xxx" }
 *
 * Response:
 * { "ok": true }
 */
router.post('/live/stream/end-turn', async (req: Request, res: Response) => {
  const { session_id } = req.query;
  const body = req.body as { session_id?: string };
  const effectiveSessionId = (session_id as string) || body.session_id;

  if (!effectiveSessionId) {
    return res.status(400).json({ ok: false, error: 'session_id required' });
  }

  const session = liveSessions.get(effectiveSessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ ok: false, error: 'Session not active' });
  }

  // VTID-01219: Send end of turn to Live API
  if (session.upstreamWs && session.upstreamWs.readyState === WebSocket.OPEN) {
    const sent = sendEndOfTurn(session.upstreamWs);
    if (sent) {
      console.log(`[VTID-01219] End of turn sent to Live API: session=${effectiveSessionId}`);
      return res.status(200).json({ ok: true, message: 'End of turn signaled' });
    }
  }

  console.log(`[VTID-01219] End of turn (no Live API): session=${effectiveSessionId}`);
  return res.status(200).json({ ok: true, message: 'End of turn acknowledged (no Live API)' });
});

/**
 * VTID-01155: POST /tts - Google Cloud TTS
 * VTID-01219: Neural2 voices for German (de-DE-Neural2-G) and English (en-US-Neural2-H)
 *
 * Text-to-speech using Google Cloud Text-to-Speech API.
 * - German/English: Uses Neural2 voices for improved latency and natural speech
 * - Other languages: Uses Gemini TTS model
 * Uses ADC (Application Default Credentials) - automatic on Cloud Run.
 * Returns MP3 audio directly (no PCM conversion needed).
 *
 * Request:
 * {
 *   "text": "Text to speak",
 *   "lang": "en|de|fr|es|ar|zh|sr|ru",
 *   "voice_style": "friendly, calm (optional)"
 * }
 *
 * Response:
 * {
 *   "ok": true,
 *   "audio_b64": "...",
 *   "mime": "audio/mp3",
 *   "voice": "de-DE-Neural2-G",
 *   "voice_type": "Neural2"
 * }
 */
router.post('/tts', async (req: Request, res: Response) => {
  console.log('[VTID-01219] POST /orb/tts (Cloud TTS with Neural2/Gemini)');

  const body = req.body as TtsRequest;

  if (!body.text || typeof body.text !== 'string') {
    return res.status(400).json({ ok: false, error: 'text is required' });
  }

  const text = body.text.trim();
  if (!text) {
    return res.status(400).json({ ok: false, error: 'text cannot be empty' });
  }

  // Limit text length for TTS
  if (text.length > 5000) {
    return res.status(400).json({ ok: false, error: 'text exceeds 5000 character limit' });
  }

  const lang = normalizeLang(body.lang || 'en');

  // VTID-01219: Use Neural2 voices for German and English, Gemini for others
  const useNeural2 = NEURAL2_ENABLED_LANGUAGES.includes(lang);
  const voiceConfig = useNeural2
    ? (NEURAL2_TTS_VOICES[lang] || GEMINI_TTS_VOICES['en'])
    : (GEMINI_TTS_VOICES[lang] || GEMINI_TTS_VOICES['en']);
  const voiceType = useNeural2 ? 'Neural2' : 'Gemini';

  // Emit request event
  await emitTtsEvent('vtid.tts.request', {
    lang,
    voice: voiceConfig.name,
    voice_type: voiceType,
    text_length: text.length
  });

  // Check if TTS client is available
  if (!ttsClient) {
    console.warn('[VTID-01219] TTS: Google Cloud TTS client not initialized');
    await emitTtsEvent('vtid.tts.failure', {
      lang,
      voice: voiceConfig.name,
      voice_type: voiceType,
      error: 'TTS client not initialized'
    });
    return res.status(503).json({
      ok: false,
      error: 'TTS service not available'
    });
  }

  try {
    console.log(`[VTID-01219] TTS request: voice=${voiceConfig.name}, type=${voiceType}, lang=${voiceConfig.languageCode}, text_length=${text.length}`);

    // VTID-01219: Build request differently for Neural2 vs Gemini voices
    // Neural2 voices don't need modelName - voice name includes model type
    // Gemini voices require modelName parameter
    const voiceParams: any = {
      languageCode: voiceConfig.languageCode,
      name: voiceConfig.name,
    };

    // Only add modelName for Gemini voices (not Neural2)
    if (!useNeural2) {
      voiceParams.modelName = 'gemini-2.5-flash-tts';
    }

    const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
      input: { text: text },
      voice: voiceParams,
      audioConfig: {
        audioEncoding: 'MP3' as any,  // Returns MP3 directly
        speakingRate: 1.0,
        pitch: 0
      }
    };

    const [response] = await ttsClient.synthesizeSpeech(request);

    if (!response.audioContent) {
      console.error('[VTID-01219] No audio content in TTS response');
      await emitTtsEvent('vtid.tts.failure', {
        lang,
        voice: voiceConfig.name,
        voice_type: voiceType,
        error: 'No audio content in response'
      });
      return res.status(500).json({
        ok: false,
        error: 'No audio content in TTS response'
      });
    }

    // Convert audio content to base64
    const audioB64 = Buffer.isBuffer(response.audioContent)
      ? response.audioContent.toString('base64')
      : Buffer.from(response.audioContent as Uint8Array).toString('base64');

    // Emit success event
    await emitTtsEvent('vtid.tts.success', {
      lang,
      voice: voiceConfig.name,
      voice_type: voiceType,
      text_length: text.length,
      audio_bytes: audioB64.length,
      mime_type: 'audio/mp3'
    });

    console.log(`[VTID-01219] TTS success: lang=${lang}, voice=${voiceConfig.name}, type=${voiceType}, text_length=${text.length}, audio_bytes=${audioB64.length}`);

    return res.status(200).json({
      ok: true,
      audio_b64: audioB64,
      mime: 'audio/mp3',
      voice: voiceConfig.name,
      voice_type: voiceType,
      lang
    });

  } catch (error: any) {
    console.error('[VTID-01219] TTS error:', error);

    await emitTtsEvent('vtid.tts.failure', {
      lang,
      voice: voiceConfig.name,
      voice_type: voiceType,
      error: error.message
    });

    return res.status(500).json({
      ok: false,
      error: error.message || 'TTS processing failed'
    });
  }
});

/**
 * GET /health - Health check
 * VTID-01106: Added memory bridge status
 * VTID-01113: Added intent detection status
 * VTID-01118: Added cross-turn state engine status
 * VTID-01155: Added Live session and TTS status
 * VTID-01219: Added Neural2 voice configuration status
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasGeminiKey = !!GEMINI_API_KEY;
  const memoryBridgeEnabled = isMemoryBridgeEnabled();

  return res.status(200).json({
    ok: true,
    service: 'orb-live',
    vtid: ['DEV-COMHU-2025-0014', 'VTID-0135', 'VTID-01039', 'VTID-01106', 'VTID-01107', 'VTID-01113', 'VTID-01118', 'VTID-01155', 'VTID-01219'],
    model: GEMINI_MODEL,
    transport: 'SSE',
    gemini_configured: hasGeminiKey,
    tts_client_ready: !!ttsClient,
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
    // VTID-01155: Gemini Live Multimodal + TTS status
    gemini_live: {
      enabled: true,
      vtid: 'VTID-01155',
      active_live_sessions: liveSessions.size,
      live_model: VERTEX_LIVE_MODEL,
      tts_model: VERTEX_TTS_MODEL,
      supported_languages: SUPPORTED_LIVE_LANGUAGES,
      audio_in_rate: '16kHz PCM',
      audio_out_rate: '24kHz PCM',
      video_format: 'JPEG 768x768 @ 1 FPS'
    },
    // VTID-01219: Neural2 TTS voice configuration (ALL languages)
    neural2_tts: {
      enabled: true,
      vtid: 'VTID-01219',
      enabled_languages: NEURAL2_ENABLED_LANGUAGES,
      voices: {
        de: NEURAL2_TTS_VOICES['de']?.name,
        en: NEURAL2_TTS_VOICES['en']?.name,
        fr: NEURAL2_TTS_VOICES['fr']?.name,
        es: NEURAL2_TTS_VOICES['es']?.name,
        ar: NEURAL2_TTS_VOICES['ar']?.name,
        zh: NEURAL2_TTS_VOICES['zh']?.name,
        ru: NEURAL2_TTS_VOICES['ru']?.name,
        sr: NEURAL2_TTS_VOICES['sr']?.name
      },
      note: 'Gemini TTS disabled - modelName stripped by protobuf serialization'
    },
    timestamp: new Date().toISOString()
  });
});

// =============================================================================
// VTID-01222: WebSocket Server for Client-to-Gateway Communication
// =============================================================================

/**
 * VTID-01222: WebSocket message types from client
 * VTID-01224: Added auth_token for server-verified identity
 */
interface WsClientMessage {
  type: 'start' | 'audio' | 'video' | 'end_turn' | 'stop' | 'ping';
  // Start message fields
  lang?: string;
  voice_style?: string;
  response_modalities?: string[];
  // VTID-01224: Auth token for identity (client CAN send, server MUST verify)
  // Prefer passing token via query param (?token=) or Authorization header on WS upgrade
  auth_token?: string;
  // Audio message fields
  data_b64?: string;
  mime?: string;
  // Video message fields
  source?: 'screen' | 'camera';
  width?: number;
  height?: number;
}

/**
 * VTID-01222: WebSocket session state
 * VTID-01224: Added identity for context retrieval
 */
interface WsClientSession {
  sessionId: string;
  clientWs: WebSocket;
  liveSession: GeminiLiveSession | null;
  connected: boolean;
  lastActivity: Date;
  clientIP: string;
  // VTID-01224: Server-verified identity from JWT
  identity?: SupabaseIdentity;
}

// Track WebSocket client sessions
const wsClientSessions = new Map<string, WsClientSession>();

/**
 * VTID-01222: Initialize WebSocket server for ORB client connections
 * Attaches a WebSocketServer to the HTTP server for the /api/v1/orb/live/ws path
 *
 * @param server - The HTTP server instance from Express
 */
export function initializeOrbWebSocket(server: HttpServer): void {
  console.log('[VTID-01222] Initializing ORB WebSocket server...');

  // Create WebSocket server attached to HTTP server
  const wss = new WebSocketServer({
    server,
    path: '/api/v1/orb/live/ws'
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    handleWebSocketConnection(ws, req);
  });

  wss.on('error', (error) => {
    console.error('[VTID-01222] WebSocket server error:', error);
  });

  console.log('[VTID-01222] ORB WebSocket server initialized at /api/v1/orb/live/ws');

  // Cleanup expired WebSocket sessions every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of wsClientSessions.entries()) {
      if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
        console.log(`[VTID-01222] WebSocket session expired: ${sessionId}`);
        cleanupWsSession(sessionId);
      }
    }
  }, 5 * 60 * 1000);
}

/**
 * VTID-01222: Handle new WebSocket connection from client
 * VTID-01224: Extract and verify auth token from query params or headers
 */
async function handleWebSocketConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const clientIP = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const sessionId = `ws-${randomUUID()}`;

  console.log(`[VTID-01222] WebSocket connected: ${sessionId} from ${clientIP}`);

  // Check connection limit
  if (!checkConnectionLimit(clientIP)) {
    console.warn(`[VTID-01222] Connection limit exceeded for IP: ${clientIP}`);
    ws.close(4029, 'Too many connections');
    return;
  }

  incrementConnection(clientIP);

  // VTID-01224: Extract auth token from query params or Authorization header
  // Priority: 1. ?token= query param  2. Authorization: Bearer header  3. Sec-WebSocket-Protocol
  let identity: SupabaseIdentity | undefined;
  const url = parseUrl(req.url || '', true);
  const queryToken = url.query.token as string | undefined;
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const protocolToken = req.headers['sec-websocket-protocol'] as string | undefined;

  const token = queryToken || headerToken || protocolToken;

  if (token) {
    try {
      const result = await verifyAndExtractIdentity(token);
      if (result) {
        identity = result.identity;
        console.log(`[VTID-01224] WebSocket authenticated: user=${identity.user_id}, tenant=${identity.tenant_id}`);
      } else {
        console.warn(`[VTID-01224] WebSocket auth failed for ${sessionId}: invalid token`);
      }
    } catch (err: any) {
      console.warn(`[VTID-01224] WebSocket auth error for ${sessionId}: ${err.message}`);
    }
  } else {
    console.log(`[VTID-01224] WebSocket unauthenticated: ${sessionId} (no token provided)`);
  }

  // Create client session
  const clientSession: WsClientSession = {
    sessionId,
    clientWs: ws,
    liveSession: null,
    connected: true,
    lastActivity: new Date(),
    clientIP,
    identity  // VTID-01224: Server-verified identity
  };

  wsClientSessions.set(sessionId, clientSession);

  // Send connection acknowledgment
  sendWsMessage(ws, {
    type: 'connected',
    session_id: sessionId,
    authenticated: !!identity,
    tenant_id: identity?.tenant_id || null,
    message: identity
      ? 'WebSocket connected and authenticated. Send "start" message to begin Live API session.'
      : 'WebSocket connected (unauthenticated). Send "start" message to begin Live API session. Note: Context retrieval requires authentication.'
  });

  // Handle incoming messages
  ws.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString()) as WsClientMessage;
      clientSession.lastActivity = new Date();
      await handleWsClientMessage(clientSession, message);
    } catch (err: any) {
      console.error(`[VTID-01222] Error processing message for ${sessionId}:`, err.message);
      sendWsMessage(ws, {
        type: 'error',
        message: 'Invalid message format',
        details: err.message
      });
    }
  });

  // Handle client disconnect
  ws.on('close', (code, reason) => {
    console.log(`[VTID-01222] WebSocket disconnected: ${sessionId}, code=${code}, reason=${reason}`);
    cleanupWsSession(sessionId);
    decrementConnection(clientIP);
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error(`[VTID-01222] WebSocket error for ${sessionId}:`, error);
    cleanupWsSession(sessionId);
    decrementConnection(clientIP);
  });
}

/**
 * VTID-01222: Handle messages from WebSocket client
 */
async function handleWsClientMessage(clientSession: WsClientSession, message: WsClientMessage): Promise<void> {
  const { sessionId, clientWs, liveSession } = clientSession;

  switch (message.type) {
    case 'ping':
      sendWsMessage(clientWs, { type: 'pong', timestamp: Date.now() });
      break;

    case 'start':
      await handleWsStartMessage(clientSession, message);
      break;

    case 'audio':
      if (!liveSession || !liveSession.active) {
        sendWsMessage(clientWs, { type: 'error', message: 'No active session. Send "start" first.' });
        return;
      }
      await handleWsAudioMessage(clientSession, message);
      break;

    case 'video':
      if (!liveSession || !liveSession.active) {
        sendWsMessage(clientWs, { type: 'error', message: 'No active session. Send "start" first.' });
        return;
      }
      handleWsVideoMessage(clientSession, message);
      break;

    case 'end_turn':
      if (!liveSession || !liveSession.active) {
        sendWsMessage(clientWs, { type: 'error', message: 'No active session.' });
        return;
      }
      handleWsEndTurn(clientSession);
      break;

    case 'stop':
      handleWsStopSession(clientSession);
      break;

    default:
      sendWsMessage(clientWs, { type: 'error', message: `Unknown message type: ${message.type}` });
  }
}

/**
 * VTID-01222: Handle "start" message - Create Live API session
 */
async function handleWsStartMessage(clientSession: WsClientSession, message: WsClientMessage): Promise<void> {
  const { sessionId, clientWs, identity } = clientSession;

  // Check if session already exists
  if (clientSession.liveSession && clientSession.liveSession.active) {
    sendWsMessage(clientWs, { type: 'error', message: 'Session already active' });
    return;
  }

  const lang = normalizeLang(message.lang || 'en');
  const responseModalities = message.response_modalities || ['audio', 'text'];

  console.log(`[VTID-01222] Starting Live API session: ${sessionId}, lang=${lang}`);

  // VTID-01224: Build bootstrap context if authenticated
  let contextInstruction: string | undefined;
  let contextPack: ContextPack | undefined;
  let contextBootstrapLatencyMs: number | undefined;
  let contextBootstrapSkippedReason: string | undefined;

  if (identity && identity.tenant_id && identity.user_id) {
    console.log(`[VTID-01224] Building bootstrap context for session ${sessionId}...`);
    const bootstrapResult = await buildBootstrapContextPack(identity, sessionId);

    contextInstruction = bootstrapResult.contextInstruction;
    contextPack = bootstrapResult.contextPack;
    contextBootstrapLatencyMs = bootstrapResult.latencyMs;
    contextBootstrapSkippedReason = bootstrapResult.skippedReason;

    // VTID-01224: Emit OASIS telemetry for context bootstrap
    if (bootstrapResult.skippedReason) {
      emitOasisEvent({
        vtid: 'VTID-01224',
        type: 'orb.live.context.bootstrap.skipped',
        source: 'orb-live-ws',
        status: 'warning',
        message: `Context bootstrap skipped: ${bootstrapResult.skippedReason}`,
        payload: {
          session_id: sessionId,
          tenant_id: identity.tenant_id,
          user_id: identity.user_id,
          latency_ms: bootstrapResult.latencyMs,
          reason: bootstrapResult.skippedReason,
        },
      }).catch(() => {});
    } else {
      emitOasisEvent({
        vtid: 'VTID-01224',
        type: 'orb.live.context.bootstrap',
        source: 'orb-live-ws',
        status: 'info',
        message: `Context bootstrap complete: ${bootstrapResult.latencyMs}ms`,
        payload: {
          session_id: sessionId,
          tenant_id: identity.tenant_id,
          user_id: identity.user_id,
          latency_ms: bootstrapResult.latencyMs,
          memory_hits: contextPack?.memory_hits?.length || 0,
          knowledge_hits: contextPack?.knowledge_hits?.length || 0,
          context_chars: contextInstruction?.length || 0,
        },
      }).catch(() => {});
    }
  } else {
    contextBootstrapSkippedReason = 'unauthenticated';
    console.log(`[VTID-01224] Skipping context bootstrap for ${sessionId}: unauthenticated`);

    // Emit skip event
    emitOasisEvent({
      vtid: 'VTID-01224',
      type: 'orb.live.context.bootstrap.skipped',
      source: 'orb-live-ws',
      status: 'info',
      message: 'Context bootstrap skipped: unauthenticated',
      payload: {
        session_id: sessionId,
        reason: 'unauthenticated',
      },
    }).catch(() => {});
  }

  // Create Gemini Live session with identity and context
  const liveSession: GeminiLiveSession = {
    sessionId,
    lang,
    voiceStyle: message.voice_style,
    responseModalities,
    upstreamWs: null,
    sseResponse: null,  // Not used for WebSocket clients
    active: true,
    createdAt: new Date(),
    lastActivity: new Date(),
    audioInChunks: 0,
    videoInFrames: 0,
    audioOutChunks: 0,
    // VTID-01224: Identity and context
    identity,
    thread_id: sessionId,
    turn_count: 0,
    contextInstruction,
    contextPack,
    contextBootstrapLatencyMs,
    contextBootstrapSkippedReason,
  };

  clientSession.liveSession = liveSession;
  liveSessions.set(sessionId, liveSession);

  // Connect to Vertex AI Live API
  if (!googleAuth || !VERTEX_PROJECT_ID) {
    console.warn(`[VTID-01222] Live API not available for ${sessionId} - missing auth or project ID`);
    sendWsMessage(clientWs, {
      type: 'session_started',
      session_id: sessionId,
      live_api_connected: false,
      message: 'Session created but Live API not available (missing credentials)',
      meta: {
        lang,
        voice: LIVE_API_VOICES[lang] || LIVE_API_VOICES['en'],
        model: VERTEX_LIVE_MODEL
      }
    });
    return;
  }

  try {
    console.log(`[VTID-01222] Connecting to Vertex AI Live API for session ${sessionId}...`);

    const upstreamWs = await connectToLiveAPI(
      liveSession,
      // Audio response handler - forward to client via WebSocket
      (audioB64: string) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          try {
            // Convert PCM to WAV for browser playback
            const wavB64 = pcmToWav(audioB64, 24000, 1, 16);
            sendWsMessage(clientWs, {
              type: 'audio',
              data_b64: wavB64,
              mime: 'audio/wav',
              chunk_number: liveSession.audioOutChunks
            });
          } catch (err) {
            console.error(`[VTID-01222] Error sending audio to client ${sessionId}:`, err);
          }
        }
      },
      // Text response handler - forward to client via WebSocket
      (text: string) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          sendWsMessage(clientWs, {
            type: 'transcript',
            text
          });
        }
      },
      // Error handler
      (error: Error) => {
        console.error(`[VTID-01222] Live API error for ${sessionId}:`, error);
        if (clientWs.readyState === WebSocket.OPEN) {
          sendWsMessage(clientWs, {
            type: 'error',
            message: 'Live API connection error',
            details: error.message
          });
        }
      }
    );

    liveSession.upstreamWs = upstreamWs;

    // Listen for upstream WebSocket close
    upstreamWs.on('close', (code, reason) => {
      console.log(`[VTID-01222] Upstream WebSocket closed for ${sessionId}: code=${code}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        sendWsMessage(clientWs, {
          type: 'live_api_disconnected',
          code,
          reason: reason?.toString()
        });
      }
    });

    console.log(`[VTID-01222] Live API connected for session ${sessionId}`);

    // Emit OASIS event with context info
    emitLiveSessionEvent('vtid.live.session.start', {
      session_id: sessionId,
      lang,
      voice: LIVE_API_VOICES[lang] || LIVE_API_VOICES['en'],
      response_modalities: responseModalities,
      transport: 'websocket',
      // VTID-01224: Include context bootstrap info
      authenticated: !!identity,
      tenant_id: identity?.tenant_id || null,
      user_id: identity?.user_id || null,
      context_bootstrap: {
        included: !!contextInstruction,
        latency_ms: contextBootstrapLatencyMs || 0,
        skipped_reason: contextBootstrapSkippedReason || null,
        memory_hits: contextPack?.memory_hits?.length || 0,
        knowledge_hits: contextPack?.knowledge_hits?.length || 0,
        tools_enabled: !!identity,
      },
    }).catch(() => {});

    sendWsMessage(clientWs, {
      type: 'session_started',
      session_id: sessionId,
      live_api_connected: true,
      // VTID-01224: Include context bootstrap status
      context_bootstrap: {
        included: !!contextInstruction,
        latency_ms: contextBootstrapLatencyMs || 0,
        skipped_reason: contextBootstrapSkippedReason || null,
        memory_hits: contextPack?.memory_hits?.length || 0,
        knowledge_hits: contextPack?.knowledge_hits?.length || 0,
        tools_enabled: !!identity,
      },
      meta: {
        lang,
        voice: LIVE_API_VOICES[lang] || LIVE_API_VOICES['en'],
        model: VERTEX_LIVE_MODEL,
        audio_in_rate: 16000,
        audio_out_rate: 24000,
        authenticated: !!identity,
      }
    });

  } catch (err: any) {
    console.error(`[VTID-01222] Failed to connect Live API for ${sessionId}:`, err.message);

    sendWsMessage(clientWs, {
      type: 'session_started',
      session_id: sessionId,
      live_api_connected: false,
      error: err.message,
      meta: {
        lang,
        voice: LIVE_API_VOICES[lang] || LIVE_API_VOICES['en'],
        model: VERTEX_LIVE_MODEL
      }
    });
  }
}

/**
 * VTID-01222: Handle audio message from client
 */
async function handleWsAudioMessage(clientSession: WsClientSession, message: WsClientMessage): Promise<void> {
  const { sessionId, clientWs, liveSession } = clientSession;

  if (!liveSession) return;

  if (!message.data_b64) {
    sendWsMessage(clientWs, { type: 'error', message: 'Missing data_b64 in audio message' });
    return;
  }

  liveSession.audioInChunks++;
  liveSession.lastActivity = new Date();

  // Emit OASIS event (sample every 10th chunk)
  if (liveSession.audioInChunks % 10 === 0) {
    emitLiveSessionEvent('vtid.live.audio.in.chunk', {
      session_id: sessionId,
      chunk_number: liveSession.audioInChunks,
      bytes: message.data_b64.length,
      rate: 16000,
      transport: 'websocket'
    }).catch(() => {});
  }

  // Forward to Live API if connected
  if (liveSession.upstreamWs && liveSession.upstreamWs.readyState === WebSocket.OPEN) {
    const sent = sendAudioToLiveAPI(
      liveSession.upstreamWs,
      message.data_b64,
      message.mime || 'audio/pcm;rate=16000'
    );

    if (!sent) {
      console.warn(`[VTID-01222] Failed to forward audio chunk for ${sessionId}`);
    }
  } else {
    // No Live API connection - send acknowledgment
    if (liveSession.audioInChunks % 5 === 0) {
      sendWsMessage(clientWs, {
        type: 'audio_ack',
        chunk_number: liveSession.audioInChunks,
        live_api: false
      });
    }
  }
}

/**
 * VTID-01222: Handle video frame from client
 */
function handleWsVideoMessage(clientSession: WsClientSession, message: WsClientMessage): void {
  const { sessionId, clientWs, liveSession } = clientSession;

  if (!liveSession) return;

  if (!message.data_b64) {
    sendWsMessage(clientWs, { type: 'error', message: 'Missing data_b64 in video message' });
    return;
  }

  liveSession.videoInFrames++;
  liveSession.lastActivity = new Date();

  // Emit OASIS event
  emitLiveSessionEvent('vtid.live.video.in.frame', {
    session_id: sessionId,
    source: message.source || 'unknown',
    frame_number: liveSession.videoInFrames,
    bytes: message.data_b64.length,
    transport: 'websocket'
  }).catch(() => {});

  console.log(`[VTID-01222] Video frame received: ${sessionId}, source=${message.source}, frame=${liveSession.videoInFrames}`);

  // Acknowledge frame receipt
  sendWsMessage(clientWs, {
    type: 'video_ack',
    source: message.source,
    frame_number: liveSession.videoInFrames
  });
}

/**
 * VTID-01222: Handle end of turn signal
 */
function handleWsEndTurn(clientSession: WsClientSession): void {
  const { sessionId, clientWs, liveSession } = clientSession;

  if (!liveSession) return;

  if (liveSession.upstreamWs && liveSession.upstreamWs.readyState === WebSocket.OPEN) {
    const sent = sendEndOfTurn(liveSession.upstreamWs);
    if (sent) {
      console.log(`[VTID-01222] End of turn sent to Live API: ${sessionId}`);
      sendWsMessage(clientWs, { type: 'end_turn_ack', live_api: true });
    } else {
      sendWsMessage(clientWs, { type: 'end_turn_ack', live_api: false, message: 'Failed to send' });
    }
  } else {
    sendWsMessage(clientWs, { type: 'end_turn_ack', live_api: false, message: 'No Live API connection' });
  }
}

/**
 * VTID-01222: Handle stop session message
 */
function handleWsStopSession(clientSession: WsClientSession): void {
  const { sessionId, clientWs, liveSession } = clientSession;

  console.log(`[VTID-01222] Stopping session: ${sessionId}`);

  if (liveSession) {
    liveSession.active = false;

    // Close upstream WebSocket
    if (liveSession.upstreamWs) {
      try {
        liveSession.upstreamWs.close();
      } catch (e) {
        // Ignore
      }
      liveSession.upstreamWs = null;
    }

    // Emit OASIS event
    emitLiveSessionEvent('vtid.live.session.stop', {
      session_id: sessionId,
      audio_in_chunks: liveSession.audioInChunks,
      audio_out_chunks: liveSession.audioOutChunks,
      video_frames: liveSession.videoInFrames,
      transport: 'websocket'
    }).catch(() => {});

    liveSessions.delete(sessionId);
  }

  clientSession.liveSession = null;

  sendWsMessage(clientWs, {
    type: 'session_stopped',
    session_id: sessionId
  });
}

/**
 * VTID-01222: Cleanup WebSocket session
 */
function cleanupWsSession(sessionId: string): void {
  const clientSession = wsClientSessions.get(sessionId);
  if (!clientSession) return;

  // Close Live API session if active
  if (clientSession.liveSession) {
    clientSession.liveSession.active = false;

    if (clientSession.liveSession.upstreamWs) {
      try {
        clientSession.liveSession.upstreamWs.close();
      } catch (e) {
        // Ignore
      }
    }

    liveSessions.delete(sessionId);
  }

  // Close client WebSocket if open
  if (clientSession.clientWs.readyState === WebSocket.OPEN) {
    try {
      clientSession.clientWs.close(1000, 'Session cleanup');
    } catch (e) {
      // Ignore
    }
  }

  wsClientSessions.delete(sessionId);
  console.log(`[VTID-01222] WebSocket session cleaned up: ${sessionId}`);
}

/**
 * VTID-01222: Send message to WebSocket client
 */
function sendWsMessage(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      console.error('[VTID-01222] Error sending WebSocket message:', err);
    }
  }
}

export default router;
