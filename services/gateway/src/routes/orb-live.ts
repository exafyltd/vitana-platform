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
import { processWithGemini, setThreadIdentity } from '../services/gemini-operator';
import { emitOasisEvent } from '../services/oasis-event-service';
// BOOTSTRAP-VOICE-DEMO: real heartbeats from voice call sites so the agents
// dashboard reflects live usage instead of fake startup status.
import { recordAgentHeartbeat } from './agents-registry';
// VTID-02651: persona registry — voice/greeting/handles_kinds all loaded
// from agent_personas at runtime so any new specialist is a config insert.
// VTID-02653 Phase 6: tenant-aware overlay variants. The runtime uses
// these whenever session.identity.tenant_id is available so each tenant
// gets their customised view of the team. Falls back to the platform
// variants for sessions without tenant context (anonymous, ops surfaces).
import {
  getPersonaVoice as registryGetPersonaVoice,
  getPersonaGreeting as registryGetPersonaGreeting,
  pickPersonaForKind as registryPickPersonaForKind,
  isValidPersona as registryIsValidPersona,
  listAllPersonaKeys as registryListAllPersonaKeys,
  getPersonaVoiceForTenant as registryGetPersonaVoiceForTenant,
  getPersonaGreetingForTenant as registryGetPersonaGreetingForTenant,
  pickPersonaForKindForTenant as registryPickPersonaForKindForTenant,
  isValidPersonaForTenant as registryIsValidPersonaForTenant,
  listAllPersonaKeysForTenant as registryListAllPersonaKeysForTenant,
  RECEPTIONIST_KEY as RECEPTIONIST_PERSONA_KEY,
} from '../services/persona-registry';
import { dispatchVoiceFailureFireAndForget } from '../services/voice-self-healing-adapter';
import { fetchAdminBriefingBlock, isAdminRole } from '../services/admin-scanners/briefing';
import { ADMIN_TOOL_HANDLERS, ADMIN_TOOL_NAMES, ADMIN_TOOL_SCHEMAS } from '../services/admin-voice-tools';
import { getUserContextSummary } from '../services/user-context-profiler';
import { getAwarenessConfigSync } from '../services/awareness-registry';
import { writeTimelineRow } from '../services/timeline-projector';
import { notifyUserAsync } from '../services/notification-service';
// VTID-01225: Cognee Entity Extraction Integration
import { cogneeExtractorClient, type CogneeExtractionRequest } from '../services/cognee-extractor-client';
// VTID-01225-READ-FIX: Inline fact extraction for voice sessions
import { extractAndPersistFacts, isInlineExtractionAvailable } from '../services/inline-fact-extractor';
// VTID-01230: Session buffer (Tier 0 short-term memory) + extraction dedup
import { addTurn as addSessionTurn, destroySessionBuffer, addSessionFact } from '../services/session-memory-buffer';
// VTID-01953 Phase 0 follow-up — Identity-mutation intent intercept on ORB voice
import { handleIdentityIntent } from '../services/identity-intent-handler';
// VTID-01955 Phase 1 — Tier 0 Memorystore Redis turn buffer (multi-instance safe; dual-write w/ in-process buffer)
import { addTurnRedis, destroySessionBufferRedis } from '../services/redis-turn-buffer';
import { deduplicatedExtract, clearExtractionState } from '../services/extraction-dedup-manager';
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
  fetchRecentConversationForCognee,  // VTID-01225: For Cognee extraction
  fetchRecentOrbUserTurns,           // VTID-RECENT-TURNS: grounding for "what did I last say?"
  formatRecentTurnsBlock,            // VTID-RECENT-TURNS: pretty-print helper
  DEV_IDENTITY,
  MEMORY_CONFIG,
  OrbMemoryContext,
  MemoryIdentity
} from '../services/orb-memory-bridge';
// VTID-01186: Auth middleware for identity propagation
// VTID-01224: Added verifyAndExtractIdentity for WebSocket auth
// VTID-ORBC: Added AuthSource for dual JWT support
import {
  optionalAuth,
  requireAuthWithTenant,
  AuthenticatedRequest,
  verifyAndExtractIdentity,
  SupabaseIdentity,
  AuthSource
} from '../middleware/auth-supabase-jwt';
// VTID-MEMORY-BRIDGE: Service-role Supabase client for tenant_id fallback lookups
import { getSupabase } from '../lib/supabase';
// VTID-CHAT-BRIDGE: Vitana bot user ID for writing voice transcripts to chat_messages
import { VITANA_BOT_USER_ID } from '../lib/vitana-bot';
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
import { scoreAndRankEvents, formatForVoice, EventRecord, EventSearchFilters, ScoredEventResults } from '../services/event-relevance-scoring';
// VTID-01224: Conversation types for thread continuity
import { ContextPack } from '../types/conversation';
// VTID-NAV: Vitana Navigator — consult orchestration + action memory writer
import {
  consultNavigator,
  formatConsultResultForLLM,
  writeNavigatorActionMemory,
  NavigatorConsultInput,
} from '../services/navigator-consult';
import {
  lookupScreen as lookupNavScreen,
  suggestSimilar as suggestNavSimilar,
  getContent as getNavContent,
  lookupByRoute as lookupNavByRoute,
  lookupByAlias as lookupNavByAlias,
} from '../lib/navigation-catalog';
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
import { getPersonalityConfigSync } from '../services/ai-personality-service';
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
// Language preference persistence via memory_facts
import { writeFact, getCurrentFacts } from '../services/memory-facts-service';
// VTID-01219: Gemini Live API WebSocket for real-time voice-to-voice
// VTID-01222: WebSocket server for client connections
import WebSocket, { WebSocketServer } from 'ws';
import { GoogleAuth } from 'google-auth-library';
import { Server as HttpServer, IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
// BOOTSTRAP-ORB-MOVE: Phase 2 (move-only) extracted constants + helpers.
// Definitions previously inline in this file now live in the orb/ tree.
import {
  VAD_SILENCE_DURATION_MS_DEFAULT,
  POST_TURN_COOLDOWN_MS,
  SILENCE_KEEPALIVE_INTERVAL_MS,
  SILENCE_IDLE_THRESHOLD_MS,
  SILENCE_PCM_BYTES,
  SILENCE_AUDIO_B64,
  GREETING_RESPONSE_TIMEOUT_MS,
  TURN_RESPONSE_TIMEOUT_MS,
  FORWARDING_ACK_TIMEOUT_MS,
  MAX_CONSECUTIVE_MODEL_TURNS,
  MAX_CONSECUTIVE_TOOL_CALLS,
  connectionIssueMessages,
} from '../orb/upstream/constants';
import {
  SHORT_GAP_GREETING_PHRASES,
  pickShortGapGreetings,
} from '../orb/instruction/greeting-pools';

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
// VTID-01226: Added Lovable dynamic origins for frontend integration
const ALLOWED_ORIGINS = [
  'https://gateway-536750820055.us-central1.run.app',
  'https://gateway-q74ibpv6ia-uc.a.run.app',
  'https://gateway-86804897789.us-central1.run.app',
  // VTID-NAV-HOTFIX3: Community App Cloud Run origins. With Lovable retired
  // 2026-04-10, the community-app Cloud Run revision URLs are what users hit
  // directly until the vitanaland.com DNS cutover completes. Without this,
  // POST /orb/live/session/start returns 403 "Origin not allowed" and the
  // orb can't open a session at all.
  'https://community-app-q74ibpv6ia-uc.a.run.app',
  'https://community-app-86804897789.us-central1.run.app',
  'https://id-preview--vitana-v1.lovable.app',
  'https://vitanaland.com',                            // Production custom domain (mobile app)
  'https://www.vitanaland.com',                        // Production custom domain (www)
  'http://localhost:8080',
  'http://localhost:8081',  // VTID-01225: Mobile dev server
  'http://localhost:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8081',  // VTID-01225: Mobile dev server
  'http://127.0.0.1:3000'
];

// VTID-01226: Dynamic origin patterns for Lovable-hosted frontends
// VTID-NAV-HOTFIX3: Also allow any Cloud Run community-app revision URL so
// future deploys don't break when the revision hash in the hostname changes.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.lovableproject\.com$/,
  /^https:\/\/[a-z0-9-]+\.lovable\.app$/,
  /^https:\/\/community-app[a-z0-9-]*\.run\.app$/,
  /^https:\/\/community-app[a-z0-9-]*\.us-central1\.run\.app$/,
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

/**
 * VTID-MEMORY-BRIDGE: Look up a user's primary tenant from user_tenants table.
 * Used as fallback when JWT doesn't contain active_tenant_id in app_metadata.
 * The provision_platform_user() trigger creates user_tenants rows but does NOT
 * set active_tenant_id in auth.users.raw_app_meta_data, so many JWTs are missing it.
 */
async function lookupPrimaryTenant(userId: string): Promise<string | null> {
  try {
    const supabase = getSupabase();
    if (!supabase) return null;
    const { data } = await supabase
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', userId)
      .eq('is_primary', true)
      .limit(1)
      .single();
    if (data?.tenant_id) {
      console.log(`[VTID-MEMORY-BRIDGE] Resolved tenant_id from user_tenants for user=${userId.substring(0, 8)}...: ${data.tenant_id.substring(0, 8)}...`);
      return data.tenant_id;
    }
    // Fallback: any tenant for this user
    const { data: anyTenant } = await supabase
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', userId)
      .limit(1)
      .single();
    if (anyTenant?.tenant_id) {
      console.log(`[VTID-MEMORY-BRIDGE] Resolved tenant_id (non-primary) from user_tenants for user=${userId.substring(0, 8)}...: ${anyTenant.tenant_id.substring(0, 8)}...`);
      return anyTenant.tenant_id;
    }
    return null;
  } catch (err: any) {
    console.warn(`[VTID-MEMORY-BRIDGE] lookupPrimaryTenant failed: ${err.message}`);
    return null;
  }
}

/**
 * VTID-ORBC: Resolve ORB identity from request.
 * Unified identity resolution for all ORB endpoints:
 *   1. If optionalAuth attached a verified identity → use it
 *   2. If tenant_id is missing from JWT, look it up from user_tenants table
 *   3. If dev-sandbox → fall back to DEV_IDENTITY
 *   4. In production without valid JWT → return null (endpoint decides how to handle)
 *
 * @returns SupabaseIdentity or null if no identity available
 */
async function resolveOrbIdentity(req: AuthenticatedRequest): Promise<SupabaseIdentity | null> {
  // JWT-verified identity from optionalAuth middleware (Platform or Lovable)
  if (req.identity && req.identity.user_id) {
    // VTID-MEMORY-BRIDGE: If tenant_id missing from JWT, resolve from user_tenants.
    // provision_platform_user() creates user_tenants but does NOT set active_tenant_id
    // in JWT app_metadata, so many authenticated users have null tenant_id.
    if (!req.identity.tenant_id) {
      const resolvedTenant = await lookupPrimaryTenant(req.identity.user_id);
      if (resolvedTenant) {
        return { ...req.identity, tenant_id: resolvedTenant };
      }
      console.warn(`[VTID-MEMORY-BRIDGE] User ${req.identity.user_id.substring(0, 8)}... has no tenant_id in JWT and no user_tenants row`);
    }
    return req.identity;
  }

  // Dev-sandbox fallback: synthetic identity for local/dev testing
  if (isDevSandbox()) {
    return {
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      exafy_admin: false,
      email: null,
      role: DEV_IDENTITY.ACTIVE_ROLE,
      aud: null,
      exp: null,
      iat: null,
    };
  }

  // No identity available
  return null;
}

/**
 * BOOTSTRAP-ORB-ROLE-SYNC-2: Fetch the user's UI role preference by
 * querying the role_preferences table DIRECTLY with service role.
 *
 * History:
 *   Take 1 (PR #776): called the `get_role_preference(p_tenant_id)` RPC
 *   that the vitana-v1 frontend uses. That RPC uses auth.uid() internally
 *   to scope the lookup — but when called with a service-role token,
 *   auth.uid() returns NULL, so the RPC returns 0 rows regardless of
 *   what the user set in the UI. That's why the admin switch still
 *   wasn't recognised after PR #776 shipped.
 *
 *   Take 2 (this change): query the public.role_preferences table
 *   directly. Schema: (id, user_id, tenant_id, role, updated_at) with
 *   a unique (user_id, tenant_id) row per preference. Service role
 *   bypasses RLS so the SELECT works regardless of auth.uid().
 *
 * Graceful: returns null on any error.
 */
async function fetchUserRolePreference(
  userId: string,
  tenantId: string
): Promise<string | null> {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;

    const url = `${SUPABASE_URL}/rest/v1/role_preferences?select=role&user_id=eq.${userId}&tenant_id=eq.${tenantId}&order=updated_at.desc&limit=1`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!resp.ok) {
      console.warn(`[BOOTSTRAP-ORB-ROLE-SYNC-2] role_preferences query failed: ${resp.status}`);
      return null;
    }

    const rows = await resp.json() as Array<{ role?: string | null }>;
    const role = rows?.[0]?.role || null;
    if (role) {
      console.log(`[BOOTSTRAP-ORB-ROLE-SYNC-2] role_preferences="${role}" for user=${userId.substring(0, 8)}...`);
    }
    return role;
  } catch (err: any) {
    console.warn(`[BOOTSTRAP-ORB-ROLE-SYNC-2] role_preferences query threw: ${err?.message || err}`);
    return null;
  }
}

/**
 * Combine role_preference (frontend's truth) with user_tenants.active_role
 * (gateway's historical source). role_preference wins when set — it reflects
 * the user's current UI selection. Fall back to active_role when unset or
 * when the preference RPC is unavailable (older deployments).
 */
async function resolveEffectiveRole(
  userId: string,
  tenantId: string
): Promise<string | null> {
  const [pref, tenantRole] = await Promise.all([
    fetchUserRolePreference(userId, tenantId),
    fetchUserActiveRole(userId, tenantId),
  ]);
  if (pref) {
    if (tenantRole && pref !== tenantRole) {
      console.log(`[BOOTSTRAP-ORB-ROLE-SYNC] role_preference="${pref}" overrides user_tenants.active_role="${tenantRole}" for user=${userId.substring(0, 8)}...`);
    }
    return pref;
  }
  return tenantRole;
}

/**
 * VTID-01225-ROLE: Fetch the user's application-level active_role from user_tenants.
 * The JWT only contains the Supabase DB role ("authenticated"), NOT the app role
 * (community/admin/developer). This function queries the DB to get the real role.
 *
 * Graceful: returns null on any error — the system works without a role.
 */
async function fetchUserActiveRole(
  userId: string,
  tenantId: string
): Promise<string | null> {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;

    const url = `${SUPABASE_URL}/rest/v1/user_tenants?select=active_role&user_id=eq.${userId}&tenant_id=eq.${tenantId}&limit=1`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });

    if (!resp.ok) {
      console.warn(`[VTID-01225-ROLE] user_tenants query failed: ${resp.status}`);
      return null;
    }

    const rows = await resp.json() as Array<{ active_role: string | null }>;
    const role = rows?.[0]?.active_role || null;
    if (role) {
      console.log(`[VTID-01225-ROLE] Loaded active_role="${role}" for user=${userId.substring(0, 8)}...`);
    } else {
      console.log(`[VTID-01225-ROLE] No active_role found for user=${userId.substring(0, 8)}... (will use graceful fallback)`);
    }
    return role;
  } catch (err: any) {
    console.warn(`[VTID-01225-ROLE] Failed to fetch active_role (non-fatal): ${err.message}`);
    return null;
  }
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
 * VTID-01225: Extended with tenant_id/user_id for Cognee extraction
 */
interface OrbSessionTranscript {
  orb_session_id: string;
  conversation_id: string | null;
  turns: OrbTranscriptTurn[];
  started_at: string;
  finalized: boolean;
  // VTID-01225: Identity for Cognee extraction persistence
  tenant_id?: string;
  user_id?: string;
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
  // VTID-02047 voice channel-swap: persona currently driving the voice channel.
  // 'vitana' is the default; report_to_specialist tool flips this to a
  // specialist key, then triggers a transparent reconnect of the upstream
  // Gemini WebSocket so the new voice + system prompt take effect mid-call.
  // The user-facing WS/SSE stays open the whole time — only the gateway's
  // upstream connection resets.
  // VTID-02651: persona keys are now data-driven from agent_personas, so
  // the types are generic strings. Adding a new specialist = one INSERT
  // into agent_personas + zero code change.
  activePersona?: string;
  // Pending swap target — set by the tool, consumed by post-tool-response
  // logic that schedules the actual WS reconnect after the bridge
  // sentence has finished speaking.
  pendingPersonaSwap?: string | null;
  // Specialist's system prompt + voice override for the next reconnect.
  personaSystemOverride?: string;
  personaVoiceOverride?: string;
  // First-message directive injected into the system prompt of the new
  // upstream session so the specialist greets the user immediately
  // ("Hi, Devon here — …") without waiting for input.
  personaForcedFirstMessage?: string;
  createdAt: Date;
  lastActivity: Date;
  audioInChunks: number;
  videoInFrames: number;
  audioOutChunks: number;
  // VTID-02637: Idempotency flag for connection_issue emission. The upstream
  // WS error handler and close handler both fire on a real disconnect, and
  // both used to emit connection_issue — producing the user-visible "internet
  // problems message twice in a row" symptom on iOS. Set to true on the
  // first emit; subsequent emit sites check and skip.
  connectionIssueEmitted?: boolean;
  // VTID-01224: Identity for context retrieval (server-verified from JWT)
  identity?: SupabaseIdentity;
  // VTID-01225-ROLE: User's application-level active_role (community/admin/developer/etc.)
  // Loaded from user_tenants at session start. NOT the JWT's "authenticated" DB role.
  active_role?: string | null;
  // VTID-01224: Thread continuity
  thread_id?: string;
  conversation_id?: string;
  turn_count: number;
  // VTID-01224: Bootstrap context (injected into system instruction)
  contextInstruction?: string;
  contextPack?: ContextPack;
  contextBootstrapLatencyMs?: number;
  contextBootstrapSkippedReason?: string;
  // BOOTSTRAP-ORB-PHASE1: epoch ms when the bootstrap context was last built.
  // Used by the /live/stream reconnect path to skip redundant rebuilds if the
  // cached pack is still fresh (<60s). Reconnects within this window are
  // typically EventSource network blips, not long pauses, so rebuilding would
  // waste 400-1200 ms of Supabase/Gemini calls for zero user benefit.
  contextBootstrapBuiltAt?: number;
  // BOOTSTRAP-ORB-CRITICAL-PATH: Resolves once the heavy context assembly
  // (memory bootstrap, active role lookup, last-session info, admin briefing,
  // stored-language lookup) has populated the fields above. Awaited inside
  // connectToLiveAPI's ws.on('open') handler so the context build (800-1200ms)
  // overlaps with the Google auth + WS handshake (500-1000ms) instead of
  // serializing with /live/session/start's response.
  contextReadyPromise?: Promise<void>;
  // VTID-01225: Transcript accumulation for Cognee extraction
  // Forwarding v2d: `persona` records WHICH persona spoke this assistant turn
  // (e.g. 'vitana' / 'devon' / 'sage' / 'atlas' / 'mira'). Without this, the
  // conversation_history injected into the next persona's prompt labels every
  // turn "Assistant" — so when Vitana receives the user back from Devon, she
  // sees Devon's lines under the same "Assistant" label and continues them in
  // her own voice ("Hi, my name is Devon" with Vitana's TTS). With persona
  // labels, the history reads "Devon: ..." and Vitana clearly distinguishes.
  transcriptTurns: Array<{ role: 'user' | 'assistant'; text: string; timestamp: string; persona?: string }>;
  // VTID-01225: Buffer for accumulating output transcription chunks until turn completes
  outputTranscriptBuffer: string;
  // VTID-LINK-INJECT: Event title+URL pairs from search_events tool results, injected into output transcript at turn_complete
  pendingEventLinks: { title: string; url: string }[];
  // Conversation summary from previous session for greeting context
  conversationSummary?: string;
  // Voice init: greeting lifecycle tracking
  greetingSent?: boolean;
  greetingTurnIndex?: number; // turn_count when greeting was sent, to filter from memory
  // VTID-VOICE-INIT: Echo prevention — true while model is outputting audio
  // When true, inbound mic audio is dropped to prevent the speaker output
  // being picked up by the mic and causing overlapping response streams.
  isModelSpeaking: boolean;
  // VTID-ECHO-COOLDOWN: Timestamp when turn_complete was received.
  // Mic audio is gated for POST_TURN_COOLDOWN_MS after this to let client-side
  // audio playback finish draining — prevents speaker echo being picked up as input.
  turnCompleteAt: number;
  // VTID-01225-THROTTLE: Timestamp of last successful fact extraction.
  // Used to throttle per-turn extraction to max once per 60s to avoid
  // concurrent Vertex API calls that destabilize the Live API WebSocket.
  lastExtractionTime?: number;
  // VTID-01225-THROTTLE: Buffer for accumulating user input transcription.
  // Written to memory_items once per turn_complete instead of per-fragment.
  inputTranscriptBuffer: string;
  // VTID-STREAM-KEEPALIVE: Interval handle for upstream Vertex WS ping
  upstreamPingInterval?: ReturnType<typeof setInterval>;
  // VTID-STREAM-SILENCE: Interval handle for sending silence audio to Vertex
  // when no client audio is flowing, preventing Vertex idle timeout (~30s).
  silenceKeepaliveInterval?: ReturnType<typeof setInterval>;
  // VTID-STREAM-SILENCE: Timestamp of last audio chunk sent to Vertex.
  // Used to detect idle periods and trigger silence keepalive.
  lastAudioForwardedTime: number;
  // VTID-STREAM-RECONNECT: Reference to client WebSocket (WS transport only).
  // Used by transparent reconnection to send notifications to WS clients.
  // SSE clients use sseResponse instead.
  clientWs?: WebSocket;
  // Timestamp of last telemetry event emit. Used to batch telemetry to
  // 10-second windows instead of per-N-chunks, reducing Supabase HTTP calls.
  lastTelemetryEmitTime: number;
  // VTID-RESPONSE-DELAY: Per-session VAD silence threshold (ms).
  // Defaults to VAD_SILENCE_DURATION_MS_DEFAULT; can be overridden by client.
  vadSilenceMs: number;
  // VTID-AUDIO-READY: Whether greeting is deferred until client sends audio_ready.
  // Used by WebSocket (mobile) path to avoid greeting truncation from race condition.
  greetingDeferred: boolean;
  // VTID-01224-FIX: Last session info for context-aware greeting
  lastSessionInfo?: { time: string; wasFailure: boolean } | null;
  // VTID-WATCHDOG: Response watchdog timer — fires when model doesn't respond in time
  responseWatchdogTimer?: ReturnType<typeof setTimeout>;
  // BOOTSTRAP-ORB-RELIABILITY-R4: which reason armed the current watchdog.
  // Used by the audio-forwarding paths to know when it's safe to SLIDE the
  // timer forward (reset on each inbound chunk) vs. leave it alone. Only
  // safe when the reason is 'forwarding_no_ack' — a model-response watchdog
  // must not be reset by user audio or we'd suppress legitimate stalls.
  responseWatchdogReason?: string;
  // VTID-01984 (R5): true once Vertex has shown ANY sign of life on this
  // session — first input_transcription, first model_start_speaking, or
  // first audio_out chunk. The audio-forwarding paths skip the
  // forwarding_no_ack watchdog entirely once this is true, because the
  // upstream WS is demonstrably healthy and a 15-45 s "no ack" window is
  // simply Vertex computing a response, not a stall. Native WS error /
  // close handlers still catch real connection failures.
  vertexHasShownLife?: boolean;
  // VTID-LOOPGUARD: Consecutive model turns without user speech.
  // Detects response loops where model keeps elaborating without being asked.
  consecutiveModelTurns: number;
  // VTID-TOOLGUARD: Consecutive tool calls without audio output.
  // Gemini can enter an infinite loop calling tools without producing audio.
  // After MAX_CONSECUTIVE_TOOL_CALLS, we stop sending function_responses
  // to force the model to generate an audio response.
  consecutiveToolCalls: number;
  // VTID-ANON: Whether this is an anonymous/unauthenticated session (landing page)
  isAnonymous: boolean;
  // VTID-ANON-SIGNUP-INTENT: Set true when user expresses signup OR login intent
  // (kept as a boolean for input-gating backwards compatibility).
  signupIntentDetected?: boolean;
  // VTID-ANON-AUTH-INTENT: Which auth flow the user wants — used to pick
  // the right tab on the /maxina redirect page.
  authIntent?: 'signup' | 'login';
  // VTID-CONTEXT: Client environment context (IP geo, device, time)
  clientContext?: ClientContext;
  // VTID-NAV: Vitana Navigator state — populated when navigate_to_screen tool fires.
  // The orb_directive dispatch in turn_complete reads pendingNavigation and emits
  // an orb_directive message to the widget after the existing memory flush completes.
  pendingNavigation?: {
    screen_id: string;
    route: string;
    title: string;
    reason: string;
    decision_source: 'consult' | 'direct';
    requested_at: number;
  };
  // VTID-NAV: Set true the moment a navigation is queued. Gates input audio
  // forwarding so Gemini doesn't start a new turn while the widget is closing.
  // Once true, the session is effectively in "closing for navigation" mode.
  navigationDispatched?: boolean;
  // VTID-NAV: Current page URL the user is on when the orb session opened.
  // Used by navigator_consult to exclude the current screen from recommendations.
  current_route?: string;
  // VTID-NAV: Last few routes the user visited (newest first), pushed by the
  // host React Router via VTOrb.updateContext before the session started.
  recent_routes?: string[];
  // VTID-02789: Mobile viewport flag, set from the frontend's useIsMobile()
  // hook in the session start payload + every updateContext. Drives the
  // mobile_route override + viewport_only block in handleNavigateToScreen.
  is_mobile?: boolean;
  // VTID-NAV: Cached memory pack from the first navigator_consult call this
  // session, with a 30s TTL — subsequent consult calls reuse it instead of
  // re-paying retrieval cost.
  cachedMemoryPack?: { pack: ContextPack; cachedAt: number };
}

/**
 * VTID-CONTEXT: Client environment context gathered at session start.
 * Injected into system instruction to make Vitana contextually aware.
 */
interface ClientContext {
  ip: string;
  city?: string;
  country?: string;
  timezone?: string;
  localTime?: string;       // e.g. "Saturday evening, 20:35"
  timeOfDay?: string;       // morning | afternoon | evening | night
  device?: string;          // iPhone, Android, Desktop
  browser?: string;         // Chrome, Safari, Firefox
  os?: string;              // iOS, Android, Windows, macOS
  isMobile?: boolean;
  lang?: string;            // from Accept-Language
  referrer?: string;        // how they found us
}

/**
 * VTID-01155: Live session start request
 */
interface LiveSessionStartRequest {
  lang: string;
  voice_style?: string;
  response_modalities?: string[];
  conversation_summary?: string;
  // VTID-RESPONSE-DELAY: Per-session VAD silence threshold override (ms).
  // Allows clients to tune response latency vs. pause tolerance.
  vad_silence_ms?: number;
  // VTID-02020: contextual recovery — when the client is re-starting after a
  // disconnect, it sends the last few transcript turns + the stage the user
  // was in (idle / listening_user_speaking / thinking / speaking) so the
  // backend can route to the contextual recovery prompt instead of the
  // standard greeting. conversation_id is the pinned thread identifier.
  transcript_history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  reconnect_stage?: 'idle' | 'listening_user_speaking' | 'thinking' | 'speaking';
  conversation_id?: string;
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

// VTID-SESSION-LEAK-FIX: Periodic sweep to purge zombie sessions.
// Safety net in case SSE/WS close handlers miss cleanup (e.g. abrupt process kill).
// Runs every 5 minutes, removes sessions older than 30 minutes.
setInterval(() => {
  const MAX_SESSION_AGE_MS = 30 * 60 * 1000;
  const now = Date.now();
  let purged = 0;
  for (const [sid, s] of liveSessions) {
    if (now - s.createdAt.getTime() > MAX_SESSION_AGE_MS) {
      if (s.upstreamWs) { try { s.upstreamWs.close(); } catch (_) { /* ignore */ } }
      // BOOTSTRAP-ORB-1007-AUDIT: emit session.stop so abandoned sessions
      // (client closed tab / mobile killed app mid-conversation) show up in
      // OASIS instead of just disappearing. Prior behaviour left a silent
      // gap (~10 of 67 sessions / 24 h had no stop event — see diag runs).
      emitLiveSessionEvent('vtid.live.session.stop', {
        session_id: sid,
        user_id: s.identity?.user_id || null,
        tenant_id: s.identity?.tenant_id || null,
        transport: s.clientWs ? 'websocket' : 'sse',
        reason: 'expired_ttl',
        audio_in_chunks: s.audioInChunks,
        audio_out_chunks: s.audioOutChunks,
        duration_ms: Date.now() - s.createdAt.getTime(),
        turn_count: s.turn_count,
      }).catch(() => { });
      // VTID-01959: voice self-healing dispatch (mode-gated for /report path).
      // VTID-01994: pass session metrics so quality classifier can detect
      // failures regardless of mode and route to investigator.
      dispatchVoiceFailureFireAndForget({
        sessionId: sid,
        tenantScope: s.identity?.tenant_id || 'global',
        metadata: { synthetic: (s as any).synthetic === true },
        sessionMetrics: {
          audio_in_chunks: s.audioInChunks,
          audio_out_chunks: s.audioOutChunks,
          duration_ms: Date.now() - s.createdAt.getTime(),
          turn_count: s.turn_count,
        },
      });
      s.active = false;
      liveSessions.delete(sid);
      purged++;
    }
  }
  if (purged > 0) console.log(`[VTID-SESSION-TTL] Purged ${purged} expired sessions (remaining: ${liveSessions.size})`);
}, 5 * 60 * 1000);

// =============================================================================
// VTID-SESSION-LIMIT: Enforce single active ORB session per user
// =============================================================================
// Users (especially on mobile) may open the ORB multiple times without properly
// closing the previous session. This creates zombie sessions that waste upstream
// WebSocket connections and compete for resources. Enforce at most 1 active
// session per user_id — terminate all existing active sessions before creating
// a new one.
function terminateExistingSessionsForUser(userId: string, excludeSessionId?: string): number {
  let terminated = 0;
  for (const [sid, existingSession] of liveSessions) {
    if (sid === excludeSessionId) continue;
    if (!existingSession.active) continue;
    if (!existingSession.identity || existingSession.identity.user_id !== userId) continue;

    console.log(`[VTID-SESSION-LIMIT] Terminating existing session ${sid} for user=${userId.substring(0, 8)}... (new session starting)`);

    // Close upstream WebSocket
    if (existingSession.upstreamWs) {
      try { existingSession.upstreamWs.close(); } catch (_e) { /* ignore */ }
      existingSession.upstreamWs = null;
    }

    // Notify and close SSE
    if (existingSession.sseResponse) {
      try {
        existingSession.sseResponse.write(`data: ${JSON.stringify({
          type: 'session_ended',
          reason: 'new_session_started'
        })}\n\n`);
        existingSession.sseResponse.end();
      } catch (_e) { /* ignore */ }
      existingSession.sseResponse = null;
    }

    // Notify and close client WebSocket
    if (existingSession.clientWs && existingSession.clientWs.readyState === WebSocket.OPEN) {
      try {
        sendWsMessage(existingSession.clientWs, {
          type: 'session_ended',
          reason: 'new_session_started'
        });
        existingSession.clientWs.close();
      } catch (_e) { /* ignore */ }
    }

    // Clean up timers
    if (existingSession.upstreamPingInterval) {
      clearInterval(existingSession.upstreamPingInterval);
      existingSession.upstreamPingInterval = undefined;
    }
    if (existingSession.silenceKeepaliveInterval) {
      clearInterval(existingSession.silenceKeepaliveInterval);
      existingSession.silenceKeepaliveInterval = undefined;
    }
    clearResponseWatchdog(existingSession);

    existingSession.active = false;
    terminated++;

    // Emit OASIS event (fire-and-forget)
    // VTID-NAV-TIMEJOURNEY: include user_id so fetchLastSessionInfo can find
    // this event when the user next opens the ORB.
    emitLiveSessionEvent('vtid.live.session.stop', {
      session_id: sid,
      user_id: existingSession.identity?.user_id || null,
      tenant_id: existingSession.identity?.tenant_id || null,
      reason: 'superseded_by_new_session',
      audio_in_chunks: existingSession.audioInChunks,
      audio_out_chunks: existingSession.audioOutChunks,
      duration_ms: Date.now() - existingSession.createdAt.getTime(),
      turn_count: existingSession.turn_count,
    }).catch(() => {});
    // VTID-01959: voice self-healing dispatch (mode-gated for /report path).
    // VTID-01994: pass session metrics for mode-independent quality classifier.
    dispatchVoiceFailureFireAndForget({
      sessionId: sid,
      tenantScope: existingSession.identity?.tenant_id || 'global',
      metadata: { synthetic: (existingSession as any).synthetic === true },
      sessionMetrics: {
        audio_in_chunks: existingSession.audioInChunks,
        audio_out_chunks: existingSession.audioOutChunks,
        duration_ms: Date.now() - existingSession.createdAt.getTime(),
        turn_count: existingSession.turn_count,
      },
    });
  }
  return terminated;
}

// VTID-01155: Vertex AI Live API configuration
// Cloud Run does NOT auto-set GOOGLE_CLOUD_PROJECT env var.
// Fallback to hardcoded project ID for Cloud Run deployments.
const VERTEX_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_AI_LOCATION || 'us-central1';
const VERTEX_LIVE_MODEL = 'gemini-live-2.5-flash-native-audio';  // Live API model for BidiGenerateContent
console.log(`[VTID-ORBC] Vertex config at startup: PROJECT_ID=${VERTEX_PROJECT_ID || 'EMPTY'}, LOCATION=${VERTEX_LOCATION}`);
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

// VTID-01219: Startup validation — emit OASIS alert if critical voice config is missing.
// Does NOT throw (gateway serves many routes), but makes the failure visible.
(async () => {
  const issues: string[] = [];
  if (!VERTEX_PROJECT_ID) issues.push('VERTEX_PROJECT_ID empty');
  if (!VERTEX_LOCATION) issues.push('VERTEX_LOCATION empty');
  if (!googleAuth) issues.push('Google Auth failed to initialize');
  if (issues.length > 0) {
    console.error(`[VTID-01219] ORB VOICE CONFIG MISSING: ${issues.join(', ')} — Live API will NOT connect`);
    try {
      await emitOasisEvent({
        vtid: 'VTID-01155',
        type: 'orb.live.startup.config_missing',
        source: 'gateway',
        status: 'error',
        message: `ORB Live API startup validation failed: ${issues.join(', ')}`,
        payload: { issues, vertex_project_id: VERTEX_PROJECT_ID || 'EMPTY', google_auth_ready: !!googleAuth }
      });
    } catch { /* best-effort */ }
  } else {
    console.log('[VTID-01219] ORB Voice startup validation passed — Live API ready');
  }
})();

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

// VTID-02651: persona voice IDs and greetings are now data-driven from
// agent_personas (loaded by services/persona-registry.ts). Adding a new
// specialist is a single INSERT — no code change. The hardcoded maps that
// used to live here (SPECIALIST_VOICES + getSpecialistGreeting per-persona
// templates) are gone; callers use getPersonaVoice() and getPersonaGreeting()
// which read from the registry view agent_personas_registry.

// =============================================================================
// VTID-INSTANT-FEEDBACK: Server-side activation chime for mobile (WebSocket path)
// =============================================================================
// The mobile app (Lovable frontend) can't be directly edited, so we generate
// a short chime as raw PCM audio on the server and send it through the existing
// WebSocket audio pipeline. The client plays it via its normal audio playback
// code — no frontend changes needed.
//
// Two-tone ascending chime: C5 (523Hz) → E5 (659Hz), ~400ms total
// Format: 24kHz mono 16-bit PCM (matches Gemini Live API output format)

let cachedChimePcmB64: string | null = null;

function generateChimePcm(): string {
  if (cachedChimePcmB64) return cachedChimePcmB64;

  const sampleRate = 24000;
  const duration = 0.40; // 400ms total
  const totalSamples = Math.floor(sampleRate * duration);
  const buffer = Buffer.alloc(totalSamples * 2); // 16-bit = 2 bytes per sample

  const tone1Freq = 523.25; // C5
  const tone2Freq = 659.25; // E5
  const tone1End = 0.15;    // First tone: 0-150ms
  const tone2Start = 0.15;  // Second tone: 150-400ms
  const amplitude = 4000;   // ~12% of max (gentle volume)

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;

    if (t < tone1End) {
      // First tone with fade-in (0-20ms) and fade-out (80-150ms)
      let env = 1.0;
      if (t < 0.02) env = t / 0.02;
      else if (t > 0.08) env = (tone1End - t) / (tone1End - 0.08);
      sample = Math.sin(2 * Math.PI * tone1Freq * t) * amplitude * env;
    } else if (t >= tone2Start) {
      // Second tone with fade-in (150-170ms) and fade-out (250-400ms)
      const t2 = t - tone2Start;
      const tone2Duration = duration - tone2Start;
      let env = 1.0;
      if (t2 < 0.02) env = t2 / 0.02;
      else if (t2 > 0.10) env = (tone2Duration - t2) / (tone2Duration - 0.10);
      sample = Math.sin(2 * Math.PI * tone2Freq * t) * amplitude * env;
    }

    // Clamp to 16-bit range
    const clamped = Math.max(-32768, Math.min(32767, Math.round(sample)));
    buffer.writeInt16LE(clamped, i * 2);
  }

  cachedChimePcmB64 = buffer.toString('base64');
  console.log(`[VTID-INSTANT-FEEDBACK] Chime PCM generated: ${totalSamples} samples, ${buffer.length} bytes, ${cachedChimePcmB64.length} b64 chars`);
  return cachedChimePcmB64;
}

// Pre-generate at module load
generateChimePcm();

// BOOTSTRAP-ORB-MOVE: Phase 2 (move-only) — constants + greeting phrase pool
// that previously lived here are now imported from the orb/ tree at the top
// of this file. See orb/upstream/constants.ts and
// orb/instruction/greeting-pools.ts for the original comments and VTID history.

// =============================================================================
// VTID-01224: Live API Context Bootstrap Configuration
// =============================================================================

/**
 * VTID-01224: Configuration for context bootstrap at session start
 */
const LIVE_CONTEXT_CONFIG = {
  /** Maximum time (ms) to wait for context bootstrap before connecting without it */
  BOOTSTRAP_TIMEOUT_MS: 2000,
  /** VTID-01225: Increased from 8→20 to load more facts at session start */
  MAX_MEMORY_ITEMS: 20,
  /** Maximum knowledge items to include in bootstrap */
  MAX_KNOWLEDGE_ITEMS: 4,
  /** Skip web search at bootstrap (no query yet) */
  SKIP_WEB_SEARCH: true,
  /** VTID-01225: Increased from 4KB→8KB to fit Identity Core + general facts */
  MAX_CONTEXT_CHARS: 8000,
};

/**
 * VTID-01224: Build bootstrap context pack for Live API session
 * Uses latency caps to avoid delaying voice connection
 *
 * @param identity - Server-verified user identity
 * @param sessionId - Session ID for thread tracking
 * @returns Context pack result with latency info
 */
// Forwarding-rules feature: shared specialist context section + behavioral rules.
//
// Every persona (Vitana + Devon/Sage/Atlas/Mira) gets the SAME ticket-history
// context payload at swap time. Specialization is authority, not visibility —
// any agent can discuss any ticket; only action is scoped via the per-ticket
// `owner` field. Time-to-resolution is the explicit KPI.

async function fetchSpecialistContextSection(userId: string | null | undefined): Promise<string> {
  if (!userId) return '';
  try {
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE!;
    const resp = await fetch(`${url}/rest/v1/rpc/build_specialist_context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!resp.ok) return '';
    const data = await resp.json().catch(() => null);
    return formatSpecialistContextSection(data);
  } catch {
    return '';
  }
}

// Onboarding-cohort hint: when the user is in their first 30 days of tenure,
// inject a prompt block that tells Vitana to default to TEACHING when the
// phrasing is ambiguous between instruction-manual and support-request.
// Returns '' (no-op) for users past 30 days or when context fetch fails.
async function fetchOnboardingCohortBlock(userId: string | null | undefined): Promise<string> {
  if (!userId) return '';
  try {
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE!;
    const resp = await fetch(`${url}/rest/v1/rpc/build_specialist_context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!resp.ok) return '';
    const data = (await resp.json().catch(() => null)) as { user?: { tenure_days?: number } } | null;
    const tenure = data?.user?.tenure_days ?? 0;
    if (tenure >= 30) return '';
    return [
      '',
      '[ONBOARDING-COHORT RULE]',
      `This user is in their first 30 days (tenure: ${tenure} day${tenure === 1 ? '' : 's'}). They are still learning the platform.`,
      'Default behavior: TEACH, do NOT ROUTE.',
      'When in doubt about whether something is an instruction-manual question or a support request,',
      'answer inline yourself — even if the wording is slightly ambiguous. Use search_knowledge first.',
      'Almost every onboarding-cohort question is "how does this thing work?". Answer it.',
    ].join('\n');
  } catch {
    return '';
  }
}

function formatSpecialistContextSection(ctx: any): string {
  if (!ctx) return '';
  const u = ctx.user || {};
  const c = ctx.ticket_counts || {};
  const open: any[] = Array.isArray(ctx.open_tickets) ? ctx.open_tickets : [];
  const resolved: any[] = Array.isArray(ctx.recent_resolved) ? ctx.recent_resolved : [];

  const lines: string[] = [];
  lines.push('=== USER CONTEXT (you already know this user) ===');
  const handle = u.vitana_id ? ` (${u.vitana_id})` : '';
  const tenure = (typeof u.tenure_days === 'number' && u.tenure_days > 0) ? ` — with us ${u.tenure_days} days` : '';
  lines.push(`Name: ${u.display_name || 'Unknown'}${handle}${tenure}`);
  lines.push(`Tickets in our system: ${c.total ?? 0} total · ${c.open ?? 0} open · ${c.resolved ?? 0} resolved`);
  if (open.length > 0) {
    lines.push('Open:');
    for (const t of open) {
      const owner = t.owner ? ` (${t.owner})` : '';
      const age = (typeof t.age_days === 'number')
        ? `, opened ${t.age_days} day${t.age_days === 1 ? '' : 's'} ago`
        : '';
      const summary = String(t.summary || '').slice(0, 200);
      lines.push(`  • ${t.kind}${owner}${age} — "${summary}"`);
    }
  }
  if (resolved.length > 0) {
    lines.push('Recent resolved:');
    for (const t of resolved) {
      const owner = t.owner ? ` (${t.owner})` : '';
      const summary = String(t.summary || '').slice(0, 200);
      lines.push(`  • ${t.kind}${owner} — "${summary}"`);
    }
  }
  lines.push('You can discuss ANY of the above with the user. Action belongs to the');
  lines.push('named teammate; if action is needed outside your authority, hand off');
  lines.push('warmly by naming the teammate ("my colleague Atlas can approve this").');
  lines.push('Never say "I can\'t help" or "you need to talk to someone else".');
  lines.push('==================================================');
  return lines.join('\n');
}

// Conversation transcript section — injected at every persona swap so the
// receiving persona sees what the user actually said in the call so far.
// Without this, every new agent restarts cold with "what can I do for you?"
// and the user has to repeat themselves — the exact failure the user just
// reported. Cap at last 12 turns so the prompt doesn't bloat.
function buildTranscriptSection(
  transcriptTurns: Array<{ role: 'user' | 'assistant'; text: string; timestamp: string }> | undefined,
  fromPersona: string,
  targetPersona?: string,
): string {
  const turns = (transcriptTurns ?? []).slice(-12);
  if (turns.length === 0) return '';
  const fromLabel = fromPersona === 'vitana' ? 'Vitana' : (fromPersona.charAt(0).toUpperCase() + fromPersona.slice(1));
  const targetKey = targetPersona && targetPersona !== '' ? targetPersona : 'this persona';
  const targetLabel = targetKey === 'this persona'
    ? targetKey
    : (targetKey === 'vitana' ? 'Vitana' : (targetKey.charAt(0).toUpperCase() + targetKey.slice(1)));
  const lines: string[] = [];
  lines.push(`=== CONVERSATION SO FAR (handed off from ${fromLabel}) ===`);
  lines.push(`THIS IS HISTORY. The lines below show what OTHER speakers said earlier.`);
  lines.push(`You are ${targetLabel}. Do NOT continue ${fromLabel}'s speech as if it were yours.`);
  lines.push(`Read this as background and respond as ${targetLabel}, in your own voice and identity.`);
  lines.push('');
  for (const t of turns) {
    const speaker = t.role === 'user' ? 'User' : fromLabel;
    const text = String(t.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`${speaker}: ${text.slice(0, 400)}`);
  }
  lines.push(`=== END TRANSCRIPT ===`);
  lines.push(`You are ${targetLabel}. Your next utterance is in your voice, your style, your identity.`);
  lines.push(`The user has ALREADY explained what they want above. Do NOT ask "what can I do for you?".`);
  lines.push(`Synthesize their report into ONE sentence and confirm: "So you're seeing X — is that right?". Do not echo their exact words. Do not summarize the whole transcript. If the question is outside your authority or is an instruction-manual question, hand back to Vitana via switch_persona(to:'vitana') with a brief bridge — NEVER forward to another specialist.`);
  return lines.join('\n');
}

// Render the in-prompt conversation_history with per-turn persona labels so
// the receiving persona doesn't absorb someone else's words as their own.
// Each assistant turn carries its persona ('vitana'/'devon'/'sage'/'atlas'/
// 'mira'); user turns are labeled "User". Output is plain text suitable for
// the <conversation_history> block consumed by buildLiveSystemInstruction
// and buildAnonymousSystemInstruction.
function renderConversationHistoryWithPersonas(
  turns: Array<{ role: 'user' | 'assistant'; text: string; timestamp: string; persona?: string }> | undefined,
  recentN: number = 10,
): string | undefined {
  if (!turns || turns.length === 0) return undefined;
  const slice = turns.slice(-recentN);
  return slice
    .map(t => {
      if (t.role === 'user') return `User: ${t.text}`;
      const p = (t.persona || '').toLowerCase();
      const label = p === 'vitana' ? 'Vitana'
        : p === 'devon' ? 'Devon'
        : p === 'sage'  ? 'Sage'
        : p === 'atlas' ? 'Atlas'
        : p === 'mira'  ? 'Mira'
        : 'Assistant';
      return `${label}: ${t.text}`;
    })
    .join('\n');
}

// Build the explicit language directive for specialist personaSystemOverride.
// Without this, Devon/Sage/Atlas/Mira default to whatever language their DB
// system_prompt is written in (English) regardless of session.lang.
// Symptom: German user is talking to Vitana in German, swaps to Devon, and
// Devon greets in English. Fixed by appending this directive at every swap.
// v3: ROLE LABEL — Vitana NEVER speaks specialist names ("Devon", "Atlas",
// "Mira", "Sage") to the user. The user has no idea who those are.
// She refers to colleagues by ROLE only ("our tech support", "our billing
// team", etc). This helper returns the role label for a persona key in the
// user's language. Used in the bridge / proposal tool-result strings so the
// instruction Vitana reads tells her exactly which words to use.
const PERSONA_ROLE_LABEL: Record<string, Record<string, string>> = {
  vitana: { en: 'Vitana',                 de: 'Vitana' },
  devon:  { en: 'tech support',           de: 'unseren technischen Support' },
  sage:   { en: 'customer support',       de: 'unseren Kundensupport' },
  atlas:  { en: 'our billing team',       de: 'unser Finanzteam' },
  mira:   { en: 'our account team',       de: 'unser Konto-Team' },
};
function roleLabel(personaKey: string, lang: string | undefined): string {
  const m = PERSONA_ROLE_LABEL[personaKey] || {};
  const langCode = (lang || 'en').slice(0, 2);
  return m[langCode] || m.en || personaKey;
}

// v3: SWAP-BACK WELCOME — when a specialist hands the user back to Vitana,
// inject this block into Vitana's contextInstruction so her first turn is a
// structured proactive welcome (welcome with display_name + acknowledge the
// specialist by ROLE LABEL + open question OR proactive suggestion). The
// model generates the actual phrasing — never recite a template.
function buildSwapBackWelcomeBlock(fromPersonaKey: string, lang: string | undefined): string {
  if (!fromPersonaKey || fromPersonaKey === 'vitana') return '';
  const role = roleLabel(fromPersonaKey, lang);
  const lines: string[] = [];
  lines.push('');
  lines.push('[SWAP-BACK WELCOME — first turn after returning from a specialist]');
  lines.push(`The user just came back from ${role}. Speak ONE welcome turn in the user's language. Components in spirit (the model generates the actual wording — NEVER recite a template, NEVER repeat a welcome phrase you used earlier this session):`);
  lines.push(`  (1) WELCOME them back. Use their display_name from the USER CONTEXT block when known; omit it when not.`);
  lines.push(`  (2) ACKNOWLEDGE the specialist's help using the ROLE LABEL — say "${role}", NEVER speak the colleague's internal name (Devon, Sage, Atlas, Mira).`);
  lines.push(`  (3) THEN one of (pick whichever is most natural for this user right now):`);
  lines.push(`      (a) an OPEN question: "what else can I do for you?" / "Womit kann ich noch helfen?" / "what else would you like to continue with?" — varied wording every call.`);
  lines.push(`      (b) a PROACTIVE suggestion drawn from your bootstrap context (Proactive Initiative Engine / Did You Know Tour / current goal). Pick something the user was working on or about to be guided toward — NOT a fresh non-sequitur.`);
  lines.push(`Examples (NEVER recite verbatim):`);
  lines.push(`  - "Welcome back, Dragan. I hope ${role} could help — what else can I do for you?"`);
  lines.push(`  - "Schön, dass du wieder da bist, Dragan. Hat dir ${role} weiterhelfen können? Womit machen wir weiter?"`);
  lines.push(`  - "Welcome back. I hope our team helped. Earlier you wanted to [proactive context]; want to continue with that?"`);
  lines.push(`FORBIDDEN on this turn (all v1-era loop triggers):`);
  lines.push(`  - "What's on your mind?"`);
  lines.push(`  - "How can I help?" (generic restart)`);
  lines.push(`  - "Hi, this is Vitana" (you are already Vitana)`);
  lines.push(`  - The colleague's name (always use the role label "${role}")`);
  lines.push(`  - The specialist's exact closing words (no echo)`);
  lines.push(`  - The same wording you used on a previous swap-back this session`);
  lines.push(`One turn only. Then wait for the user.`);
  return lines.join('\n');
}

// v3a: Specialist's first-turn vs mid-conversation prompt block — toggled
// based on whether the specialist has already delivered their first turn
// after the swap. Without this gate, the model re-greets on every Gemini
// Live transparent reconnect (~9 min cycle), because the static prompt
// text says "your first utterance after this swap is identify + ask",
// which the model interprets as "I should greet now" on every reconnect.
//
// firstTurnDelivered=false → output the [FIRST TURN] block (greet + ask).
// firstTurnDelivered=true  → output the [MID-INTAKE] block (do NOT greet
//                            again, continue from the recent transcript).
function buildSpecialistTurnPhaseBlock(firstTurnDelivered: boolean): string {
  if (!firstTurnDelivered) {
    return [
      '',
      '[FIRST TURN — SPECIALIST]',
      'Your first utterance after this swap is ONE turn with TWO parts:',
      '  (1) IDENTIFY YOURSELF in ONE short clause — your name and what you handle.',
      '      Examples (vary every call, never recite verbatim):',
      '        "Hi, this is Devon, I cover technical issues."',
      '        "Hey, Devon here — I handle bugs."',
      '        "Hi, I\'m Devon, the tech colleague."',
      '  (2) ASK FOR DETAILS — invite the user to elaborate so you understand',
      '      what to fix. Examples (vary, never recite):',
      '        "Can you explain a bit more about what\'s happening?"',
      '        "Tell me what specifically broke — which screen, what action?"',
      '        "Walk me through what you\'re seeing."',
      '',
      '  EDGE CASE — if Vitana\'s handoff brief AND the transcript already contain',
      '  specifics (which screen, what error, what action), you may collapse the ASK',
      '  into a confirmation: "Hi, Devon here — so you\'re seeing X on screen Y, is',
      '  that right?" In doubt, default to asking for more.',
      '',
      '  RULES on every first turn:',
      '  — Vary your wording every single call. NEVER recite a template.',
      '  — Match the user\'s language exactly (per LANGUAGE LOCK above).',
      '  — Cap at ~2 short sentences. Brevity matters.',
      '  — DO NOT fire the auto-return ("anything else, or back to Vitana?") on the',
      '    first turn. That belongs at the END of intake, not the beginning.',
      '  — DO NOT ask "what can I do for you?" — Vitana already explained context.',
      '  — DO NOT echo the user\'s words verbatim.',
      '  — DO NOT invent a specific issue if you don\'t have one (no hallucinations).',
      '    If specifics are missing, ASK ONE question instead of inventing.',
    ].join('\n');
  }
  return [
    '',
    '[MID-INTAKE — DO NOT RE-GREET]',
    'You ALREADY greeted the user on this swap. You are NOW MID-CONVERSATION.',
    'This setup message is being rebuilt because of an internal session reconnect',
    '(transparent to the user — they don\'t know it happened). They are still in',
    'the SAME conversation with you that started a moment ago.',
    '',
    'ABSOLUTELY DO NOT:',
    '  — re-introduce yourself ("Hi, this is Devon" — you already said that)',
    '  — re-greet ("Hi" / "Hello" / "Hi there" — forbidden)',
    '  — restart the intake ("Can you explain what happened?" again — already asked)',
    '  — fire the auto-return / close question on the first utterance after reconnect',
    '  — say "what can I do for you?" or any cold-start phrase',
    '',
    'WHAT TO DO:',
    '  — Read the recent transcript (last few turns) above. Determine where the',
    '    conversation actually was when the reconnect happened.',
    '  — Continue from there as if no interruption happened. The user did not notice.',
    '  — If the user just answered your last question, respond to their answer.',
    '  — If the user is mid-explanation, ask the next focused diagnostic question.',
    '  — If you had just filed the ticket and asked the close question, wait for',
    '    their reply (don\'t re-ask).',
    '',
    'The conversation is in flight. Pick up exactly where it left off, in the user\'s',
    'language, in your own voice and identity. NO greeting, NO restart.',
  ].join('\n');
}

function buildSpecialistLanguageDirective(lang: string | undefined): string {
  const languageNames: Record<string, string> = {
    en: 'English', de: 'German', fr: 'French', es: 'Spanish',
    ar: 'Arabic', zh: 'Chinese', ru: 'Russian', sr: 'Serbian',
  };
  const name = languageNames[lang || 'en'] || 'English';
  return [
    '[LANGUAGE LOCK]',
    `Respond ONLY in ${name}. Match the user's language exactly.`,
    'Do NOT switch to English. Do NOT mix languages.',
    'Your greeting, your synthesis, your auto-return question — all in',
    `${name}. The user has been speaking ${name} with Vitana already;`,
    'continue in the same language without acknowledging the switch.',
  ].join('\n');
}

// Build the input for Gate A by concatenating the user's last 3 raw utterances.
// The LLM-curated `summary` argument to report_to_specialist is lossy — it can
// rephrase "how does X work?" into "user is asking about X feature", which
// bypasses the stay-inline phrase match. Using raw transcript closes that hole.
function buildGateInputFromTranscript(
  transcriptTurns: Array<{ role: 'user' | 'assistant'; text: string; timestamp: string }> | undefined,
  fallback: string,
): string {
  const userTurns = (transcriptTurns ?? [])
    .filter(t => t.role === 'user')
    .slice(-3)
    .map(t => String(t.text || '').trim())
    .filter(Boolean);
  if (userTurns.length === 0) return fallback;
  return userTurns.join(' \n ');
}

function buildPersonaBehavioralRule(personaKey: string): string {
  const isSpecialist = personaKey !== '' && personaKey !== 'vitana';
  const lines: string[] = [];

  lines.push('[BEHAVIORAL RULES — universal]');
  lines.push('You already know this user — full ticket history, all teammates\' tickets included.');
  lines.push('NEVER ask "who are you" or "have we spoken before".');
  lines.push('If the user asks "do you know who I am?", confirm warmly with name + a short summary of their ticket history.');
  lines.push('You can DISCUSS any ticket regardless of which teammate owns it.');
  lines.push('You can ACT only within your authority; for action outside it, hand off by name');
  lines.push('("my teammate <X> can fix this — let me bring them in"), never by saying');
  lines.push('"I can\'t help" or "you need to talk to someone else".');
  lines.push('Time-to-resolution is the goal: never make the user repeat themselves,');
  lines.push('never bounce them blindly, propose the shortest path.');
  lines.push('');

  // Universal anti-repetition rule. THIS IS WHY YOU MUST NOT HARD-CODE PHRASES.
  lines.push('[VARY YOUR PHRASING — universal]');
  lines.push('You are not a robot reciting a script — you are a human conversation partner.');
  lines.push('NEVER use the exact same wording twice in a conversation. Every greeting,');
  lines.push('every confirmation, every transition is in your own natural language.');
  lines.push('If you find yourself about to repeat a phrase you already used, rephrase it.');
  lines.push('Examples below are GUIDANCE, not scripts — never recite them verbatim.');

  if (isSpecialist) {
    // v3a: the FIRST TURN block was MOVED OUT of this static rule. It's
    // now appended dynamically by buildSpecialistTurnPhaseBlock at the
    // setup-message build site, gated on personaFirstUtteranceDelivered.
    // Reason: this static text is set once at swap time and frozen in
    // personaSystemOverride. Gemini Live transparent-reconnects every few
    // minutes and rebuilds the setup; if the [FIRST TURN] block is in the
    // static text, the model reads it again on every reconnect and
    // re-greets (Devon → "Hi I'm Devon" mid-conversation). Pulling the
    // block out and gating on the flag fixes that.

    lines.push('');
    lines.push('[CLOSE QUESTION + GOODBYE — specialist only]');
    lines.push('Once the user has given you the details and you have written intake into the');
    lines.push('ticket, your closing follows TWO steps in order:');
    lines.push('');
    lines.push('  STEP 1 — CLOSE-QUESTION TURN (always, never skipped). ONE turn in the');
    lines.push('  user\'s language with FOUR components in order:');
    lines.push('    (i) Acknowledge that a TICKET HAS BEEN CREATED. NEVER say "done" / "fixed"');
    lines.push('        / "resolved" / "erledigt im Sinne von gelöst" — a ticket is the START');
    lines.push('        of the work, not the end. Use phrasing like "I\'ve created a ticket"');
    lines.push('        / "Ticket is filed" / "Ich habe ein Ticket angelegt".');
    lines.push('    (ii) Commit to action: convey that the team will work on it RIGHT AWAY.');
    lines.push('         Examples: "our team will work on it immediately" / "we\'ll take care');
    lines.push('         of this right away" / "unser Team kümmert sich sofort darum".');
    lines.push('    (iii) Promise the follow-up: tell the user that VITANA will inform them');
    lines.push('          when the fix is in. Examples: "as soon as it\'s fixed Vitana will');
    lines.push('          let you know" / "Vitana wird dir Bescheid geben, sobald es behoben');
    lines.push('          ist".');
    lines.push('    (iv) THEN ask the close question: "anything else I can help with, or');
    lines.push('         shall I hand you back to Vitana?" — varied wording every call.');
    lines.push('  Vary every component every call. NEVER recite a template. Examples:');
    lines.push('    "I\'ve created a ticket and our team will work on it right away. As soon');
    lines.push('     as it\'s fixed, Vitana will let you know. Anything else, or shall I hand');
    lines.push('     you back to Vitana?"');
    lines.push('    "Ticket\'s filed — we\'ll take care of this immediately. You\'ll hear from');
    lines.push('     Vitana the moment the fix lands. Want me to look at anything else first,');
    lines.push('     or back to Vitana?"');
    lines.push('    "Ich habe ein Ticket dafür angelegt, und unser Team kümmert sich sofort');
    lines.push('     darum. Sobald es behoben ist, gibt dir Vitana Bescheid. Möchtest du sonst');
    lines.push('     noch etwas besprechen, oder zurück zu Vitana?"');
    lines.push('  Then WAIT for the user\'s reply.');
    lines.push('');
    lines.push('  STEP 2 — branch on the user\'s reply:');
    lines.push('    (a) "yes, [new issue]" — handle it. Loop back to your normal intake.');
    lines.push('    (b) "no" / "that\'s all" / "Nein, das ist alles" / equivalent — speak ONE');
    lines.push('        short polite GOODBYE turn in the user\'s language, THEN call');
    lines.push('        switch_persona(to:\'vitana\'). Goodbye structure:');
    lines.push('         - Thank the user for their time. Use display_name from USER CONTEXT');
    lines.push('           when known ("Thank you for your time, Dragan, …"). When NOT known,');
    lines.push('           omit the name. NEVER say "user" or any robotic placeholder.');
    lines.push('         - Wish them well ("have a great day" / "schönen Tag noch" / "take');
    lines.push('           care").');
    lines.push('         - The follow-up promise was given in STEP 1, so the goodbye is');
    lines.push('           light — don\'t repeat the full "we\'ll let you know" speech here.');
    lines.push('         - Vary wording every call. NEVER recite the same goodbye twice in');
    lines.push('           a session. Examples:');
    lines.push('             "Thank you for your time, Dragan. Have a great day."');
    lines.push('             "Thanks, Dragan — take care."');
    lines.push('             "Danke für deine Zeit, Dragan. Schönen Tag noch."');
    lines.push('  STEP 2 (b) ORDERING is non-negotiable: SPEAK the goodbye FIRST, THEN call');
    lines.push('  switch_persona. Do NOT speak after the tool call.');

    lines.push('');
    lines.push('[INSTRUCTION-MANUAL PROTECTION — specialist only]');
    lines.push('If the user asks how something works, what something is, or how to use a feature,');
    lines.push('that is Vitana\'s job — she is the instruction manual. Hand back to Vitana via');
    lines.push('switch_persona(to:\'vitana\'). Do not try to answer instruction-manual questions.');
    lines.push('You handle BROKEN STATE (bugs, claims, account issues), not LEARNING.');
  } else {
    lines.push('');
    lines.push('[VITANA — INSTRUCTION-MANUAL ROLE]');
    lines.push('You ARE the instruction manual. Anything that is "how does X work", "what is X",');
    lines.push('"tell me about X", "explain X", "show me how X", "I\'d like to learn X", "I\'m new"');
    lines.push('— answer it inline using search_knowledge first, then your own knowledge. The');
    lines.push('Knowledge Hub has 92 chapters of platform docs. NEVER call report_to_specialist');
    lines.push('for instruction-manual questions, even if the user uses words that sound like');
    lines.push('"support". A first-time user asking "how do I use the diary?" is a teaching');
    lines.push('moment, not a customer-support ticket. Specialists handle BROKEN STATE only.');
    lines.push('');
    lines.push('[VITANA ON SWAP-BACK — silent pickup]');
    lines.push('When you receive the user back from a specialist, DO NOT GREET. Do not say');
    lines.push('"Welcome back" or "What\'s on your mind?" — those are the loop trigger that');
    lines.push('makes the user re-state their question. Stay silent. The user speaks when ready.');
    lines.push('When they do, pick up naturally — never restart the conversation.');
    lines.push('');
    lines.push('[VITANA — explicit consent before transfer]');
    lines.push('Even when forwarding is warranted (rare — bug report, claim, account locked),');
    lines.push('PROPOSE before transferring: "Shall I bring in Devon for the bug?" Wait for an');
    lines.push('affirmative reply. Implicit consent does NOT count. Vary your proposal phrasing.');
  }
  return lines.join('\n');
}

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
    // VTID-01224: identity-scoped memory fetch so each user gets their own memory.
    // VTID-RECENT-TURNS: fetch the 3 most recent raw user utterances in parallel
    // so Gemini can answer "what did I ask you last?" accurately instead of
    // hallucinating from aggregated facts.
    // BOOTSTRAP-HISTORY-AWARE-TIMELINE: also fetch the User Context Profile
    // (recent activity, routines, preferences) so the voice ORB is history-aware.
    const profilerEnabled = process.env.PROFILER_IN_ORB_INSTRUCTION !== 'false';
    const [memoryContext, recentTurns, profileResult] = await Promise.all([
      fetchMemoryContextWithIdentity(
        { user_id: identity.user_id, tenant_id: identity.tenant_id },
        LIVE_CONTEXT_CONFIG.MAX_MEMORY_ITEMS
      ),
      fetchRecentOrbUserTurns(
        { user_id: identity.user_id, tenant_id: identity.tenant_id },
        3
      ),
      profilerEnabled
        ? getUserContextSummary(identity.user_id, { tenantId: identity.tenant_id })
            .catch((err: any) => {
              console.warn(`[UserContextProfiler] voice bootstrap fetch failed: ${err?.message || err}`);
              return { summary: '', version: 0, cached: false, warnings: [] };
            })
        : Promise.resolve({ summary: '', version: 0, cached: false, warnings: [] }),
    ]);

    const latencyMs = Date.now() - startTime;
    const recentTurnsBlock = formatRecentTurnsBlock(recentTurns);
    const profileBlock = profileResult.summary
      ? `\n## USER CONTEXT PROFILE (recent activity, routines, preferences)\n${profileResult.summary}\n\nWeave this naturally ("I saw you logged a diary entry this morning", "since you usually walk in the mornings") — never recite the list verbatim.`
      : '';

    if (!memoryContext.ok || memoryContext.items.length === 0) {
      console.warn(`[VTID-01225] Memory context fetch returned ${memoryContext.items.length} items for session ${sessionId}`);
      // Still return the formatted context even if no items (contains user info).
      // Prepend recent turns so the model still has grounding.
      const base = memoryContext.formatted_context || '';
      const combined = [recentTurnsBlock, base, profileBlock].filter(Boolean).join('\n');
      if (combined) {
        return {
          contextInstruction: combined,
          latencyMs,
        };
      }
      return {
        latencyMs,
        skippedReason: memoryContext.error || 'no_memory_items',
      };
    }

    // Format the memory context for injection. Prepend the recent-turns block
    // BEFORE truncation so it survives long fact-context sessions.
    const full = [recentTurnsBlock, memoryContext.formatted_context, profileBlock]
      .filter(Boolean)
      .join('\n');
    const contextInstruction = full.length > LIVE_CONTEXT_CONFIG.MAX_CONTEXT_CHARS
      ? full.substring(0, LIVE_CONTEXT_CONFIG.MAX_CONTEXT_CHARS) + '\n[...truncated]'
      : full;

    console.log(`[VTID-01225] Context bootstrap complete: ${latencyMs}ms, memory=${memoryContext.items.length}, recentTurns=${recentTurns.length}, profile=${profileResult.summary.length}ch (cached=${profileResult.cached})`);

    return {
      contextInstruction,
      latencyMs,
    };
  } catch (err: any) {
    console.error(`[VTID-01225] Context bootstrap error for session ${sessionId}:`, err.message);
    return {
      latencyMs: Date.now() - startTime,
      skippedReason: `error: ${err.message}`,
    };
  }
}

/**
 * VTID-01224: Build Live API tool declarations for function calling
 * These tools enable dynamic context retrieval during the conversation
 *
 * VTID-NAV: Mode parameter — anonymous sessions get a narrow allowlist
 * (navigator_consult + navigate_to_screen) so onboarding visitors can be
 * guided to public destinations like the Maxina portal. Authenticated
 * sessions get the full set including memory/knowledge/event search.
 */
function buildLiveApiTools(
  mode: 'anonymous' | 'authenticated' = 'authenticated',
  currentRoute?: string,
  activeRole?: string,
): object[] {
  const navigatorTools: any[] = [
    {
      name: 'get_current_screen',
      description: [
        'Return the screen the user is CURRENTLY looking at, as a fresh live',
        'lookup. Always call this tool when the user asks any variation of:',
        '  "where am I?", "which screen is this?", "what page am I on?",',
        '  "what am I looking at?", "wo bin ich?", "welcher Bildschirm ist das?".',
        '',
        'You should also call it after you have just navigated via',
        'navigate_to_screen if the user asks a follow-up about "this page" —',
        'the in-memory location is updated immediately after navigation so',
        'this tool always reflects the freshest screen.',
        '',
        'The result contains:',
        '  - title: the friendly screen title (e.g. "Events & Meetups")',
        '  - route: the raw URL path (do NOT speak this out loud)',
        '  - description: a short description of what the screen is for',
        '  - category: the section of the app (community, health, wallet, ...)',
        '',
        'When answering, speak ONLY the title and the short description in',
        'natural language. Never read the route aloud. If the tool returns',
        '"unknown", tell the user you can see they\'re in the Vitana app but',
        'not which specific screen, and ask them what they\'d like to do.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'navigate',
      description: [
        'Guide the user to the right screen in the Vitana platform. Call this',
        'tool whenever the user wants to go somewhere, find a feature, learn',
        'how to do something, or mentions any screen, page, section, or area',
        'of the app — even indirectly.',
        '',
        'You do NOT need to know which screen to send them to. Just pass the',
        'user\'s words and the backend will find the right destination, search',
        'the knowledge base for how-to guidance, and handle the redirect.',
        '',
        'WHEN TO CALL:',
        '- "open my profile" / "open my wallet" / "open my inbox"',
        '- "where are the podcasts" / "show me my health data"',
        '- "I want to set up a business" / "how do I track my biology?"',
        '- "open the screen with music" / "where is my diary"',
        '- Any request where the user wants to SEE or DO something on a screen',
        '',
        'WHEN NOT TO CALL:',
        '- Pure small talk with no screen destination ("how are you", "thank you")',
        '- Quick factual questions ("what is longevity?")',
        '',
        'WHAT YOU GET BACK:',
        '- GUIDANCE: a short explanation you should speak naturally to the user,',
        '  telling them about the feature and what they can do there.',
        '- NAVIGATING_TO: the screen the user is being taken to (or null if no',
        '  match was found).',
        '- If a redirect is happening, the orb will close automatically after',
        '  you finish speaking. Just speak the guidance naturally — do not add',
        '  a separate transition sentence.',
        '- If NAVIGATING_TO is null, ask the user to clarify what they are',
        '  looking for.',
        '',
        'IMPORTANT: When you speak the guidance, be helpful and warm. Explain',
        'the feature briefly, tell them what they can do on that screen, and',
        'let them know you are taking them there. Example: "The Business Hub',
        'is where you can set up your services and start earning. You\'ll find',
        'a Create button to get started. Let me take you there."',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The user\'s question, request, or intent in their own words. Pass exactly what they said — the backend handles all matching and routing.',
          },
        },
        required: ['question'],
      },
    },
  ];

  if (mode === 'anonymous') {
    // VTID-NAV-ANON-FIX: On landing/portal pages, anonymous sessions get NO
    // tools — the signup-intent regex flow (detectAuthIntent + session_limit_reached)
    // handles navigation there, and Navigator tools competed with it causing
    // double responses.
    //
    // VTID-NAV-TOKEN-FIX: On community pages (any route that isn't / or a
    // portal), an "anonymous" session is almost certainly an authenticated user
    // whose JWT expired mid-session (common on mobile Appilix WebView). Give
    // them the navigator tools so "open my profile" / "open my inbox" still
    // work even if the token refresh hasn't reached the orb widget yet.
    const landingRoutes = ['/', '/maxina', '/alkalma', '/earthlinks', '/auth'];
    const isLandingPage = !currentRoute || landingRoutes.includes(currentRoute);
    if (isLandingPage) {
      return [];
    }
    // Community page with expired token — give navigator tools only
    return [{ function_declarations: navigatorTools }];
  }

  return [
    {
      function_declarations: [
        ...navigatorTools,
        {
          name: 'search_memory',
          description: 'Search the user\'s personal memory and Memory Garden for information they have previously shared or recorded, including personal details, health data, preferences, goals, past conversations, daily diary entries, journal notes, and any other personal records.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query to find relevant memories, diary entries, or personal records',
              },
              categories: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional categories to filter: personal, health, preferences, goals, relationships, conversation, diary, notes',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'search_knowledge',
          description: [
            'Search the Vitana knowledge base for explanations, how-tos, and platform concepts.',
            'Use this WHENEVER the user asks "how does X work?", "what is Y?", "can you explain ...?",',
            '"how do I find/learn/teach/share ...?", "why are matches sparse?", or "what is the privacy here?"',
            '',
            "It's the default tool for any orientation, onboarding, or curious question — first-time users",
            'deserve a real explanation, not a one-line transactional reply. Pull from this knowledge base',
            'BEFORE answering, then synthesize into a 15-30 second voice response (~80-200 words) that',
            'sounds natural, not robotic.',
            '',
            'Topics covered include: matchmaking overview, finding a dance partner, learning dance from',
            'a teacher, offering dance lessons, why early-stage matches are sparse, sharing posts,',
            'privacy in matchmaking, the Open Asks feed, the Vitana Index, longevity research, and the',
            "Vitana platform itself. Supervisors keep adding documents, so always search before assuming",
            "something isn't covered.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: "The search query — paraphrase the user's question into the topical keywords. E.g. \"how do I find a dance partner\" or \"why am I getting no matches\".",
              },
            },
            required: ['query'],
          },
        },
        // Calendar tool — search user's personal calendar
        {
          name: 'search_calendar',
          description: 'Search the user\'s personal calendar for events, appointments, and scheduled activities. Use this when the user asks about their schedule, upcoming events, free time, availability, or wants to know what\'s planned for a specific day or week.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'What to search for in the calendar (e.g., "tomorrow", "this week", "yoga sessions", "free time")',
              },
            },
            required: ['query'],
          },
        },
        // Calendar write tool — create events via voice
        {
          name: 'create_calendar_event',
          description: [
            'Create a new event in the user\'s personal calendar. Use this when the',
            'user asks you to schedule, add, create, or book a meeting, appointment,',
            'activity, or any calendar event.',
            '',
            'IMPORTANT:',
            '- Always confirm the event details with the user BEFORE calling this tool.',
            '- If the user does not specify an end time, default to 1 hour after start.',
            '- Use ISO 8601 format for start_time and end_time (e.g. "2026-04-15T18:00:00Z").',
            '- After creating, confirm the event title and time back to the user.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'The title or name of the event (e.g., "Dinner meeting", "Yoga class", "Doctor appointment")',
              },
              start_time: {
                type: 'string',
                description: 'Start time in ISO 8601 format (e.g. "2026-04-15T18:00:00Z")',
              },
              end_time: {
                type: 'string',
                description: 'End time in ISO 8601 format. If not specified by the user, default to 1 hour after start_time.',
              },
              description: {
                type: 'string',
                description: 'Optional description or notes for the event.',
              },
              location: {
                type: 'string',
                description: 'Optional location of the event.',
              },
              event_type: {
                type: 'string',
                enum: ['personal', 'community', 'professional', 'health', 'workout', 'nutrition'],
                description: 'Type of event. Default to "personal" if unclear.',
              },
            },
            required: ['title', 'start_time'],
          },
        },
        // VTID-01270A: Community & Events voice tools
        {
          name: 'search_events',
          description: 'Search upcoming community events, meetups, and live rooms. Supports filtering by activity/keyword, location, organizer, date range, and price. Call with no parameters to list all upcoming events. For follow-up questions about events already listed, answer from conversation context — do NOT call this tool again.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Activity or keyword to search (e.g., "yoga", "dance", "boat trip", "fitness", "wellness", "coffee"). Searches title, description, and category.',
              },
              location: {
                type: 'string',
                description: 'City, venue, or country to filter by (e.g., "Berlin", "Mallorca", "Germany", "Dubai").',
              },
              organizer: {
                type: 'string',
                description: 'Name of the event organizer or host to filter by.',
              },
              date_from: {
                type: 'string',
                description: 'Start of date range in YYYY-MM-DD format (e.g., "2026-04-01"). Defaults to today.',
              },
              date_to: {
                type: 'string',
                description: 'End of date range in YYYY-MM-DD format (e.g., "2026-04-30").',
              },
              max_price: {
                type: 'number',
                description: 'Maximum price in EUR. Use 0 for free events only.',
              },
              type_filter: {
                type: 'string',
                enum: ['meetup', 'live_room', 'all'],
                description: 'Filter by event type. Defaults to all.',
              },
            },
            required: [],
          },
        },
        {
          name: 'search_community',
          description: 'Search community groups and their activities. Use when the user asks about groups, communities, who to connect with, or community activities.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query for community groups (e.g., "meditation", "runners", "nutrition")',
              },
            },
            required: ['query'],
          },
        },
        // VTID-02754 — Find one specific community member matching a free-text
        // query and redirect the user to that member's profile. Always returns
        // exactly one person; never returns lists.
        {
          name: 'find_community_member',
          description: [
            'Find ONE specific community member matching a free-text question and',
            'open their profile for the user. ALWAYS returns exactly one person —',
            'never a list, never a summary. The tool itself dispatches the',
            'navigation; you only need to read aloud the one-line voice_summary',
            'that the tool returns. Then stop speaking.',
            '',
            'CALL THIS TOOL when the user asks any "who is..." question about the',
            'community, including:',
            '  - Skill / activity:   "who is good at half marathon?"',
            '                        "who plays golf?"',
            '                        "who teaches salsa?"',
            '  - Vitana Index:       "who is the healthiest?"',
            '                        "who has the best sleep?"',
            '                        "who is the fittest?"',
            '  - Soft qualities:     "who is the funniest?"',
            '                        "who is the smartest?"',
            '                        "who is the most inspiring?"',
            '                        "who is the best teacher?"',
            '  - Tenure:             "who is the newest member?"',
            '                        "who is the longest-standing member?"',
            '  - Location:           "who is closest to me?"',
            '                        "who is in my city?"',
            '                        "who is near me?"',
            '  - Composed:           "newest salsa teacher in my city"',
            '',
            'After the tool runs:',
            '  - Read voice_summary aloud (1-2 sentences).',
            '  - DO NOT add any other commentary — the redirect is dispatched',
            '    by the tool itself and the widget is closing.',
            '  - DO NOT mention "I searched", "I looked at", "I found" — the',
            '    voice_summary already says it.',
            '',
            'NEVER use this tool for community groups or events — those have',
            'their own tools (search_community for groups, search_events for',
            'meetups/live rooms).',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The user\'s "who is..." question, in natural language. Pass the question verbatim — the backend handles all interpretation, ranking, and edge cases.',
              },
              excluded_vitana_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'OPTIONAL — only include if the user explicitly says "show me someone else" / "another one" after a previous find_community_member result. Pass the previously-shown vitana_id(s) here so the ranker picks a different person.',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_recommendations',
          description: 'Get personalized recommendations for the user including suggested groups, events to attend, and daily matches. Use when the user asks "what should I do?", "any suggestions?", "who should I meet?", or "what events are for me?"',
          parameters: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['community', 'match', 'all'],
                description: 'Type of recommendations. Defaults to all.',
              },
            },
            required: [],
          },
        },
        // VTID-01941 / VTID-01942: Play a song. Backend routes to the right
        // provider based on (a) explicit source in the phrase, (b) user
        // preference (PR 2), (c) what's connected, (d) the in-house Vitana
        // Media Hub as fallback. Model should only pass `source` when the
        // user explicitly names a provider.
        {
          name: 'play_music',
          description: [
            'Play a song, album, or playlist. CALL THIS TOOL IMMEDIATELY',
            'the moment the user asks to play, listen to, hear, or put on',
            'music. Do NOT ask which service to use, do NOT list options,',
            'do NOT confirm anything before calling — the backend picks',
            'the right provider automatically based on the user\'s',
            'preference, their connected accounts, and the Vitana Media',
            'Hub as fallback.',
            '',
            'EXAMPLES — each one triggers the tool with no clarification:',
            '  - "play Beat It by Michael Jackson"',
            '  - "play Human Nature"',
            '  - "play some Whitney Houston"',
            '',
            'ARGUMENTS:',
            '  - query (REQUIRED): the song / artist / phrase the user said,',
            '    minus the word "play". Pass as natural language.',
            '  - source (OPTIONAL): ONLY include this when the user',
            '    explicitly named a provider ("on Spotify", "from Spotify",',
            '    "on YouTube Music", "on Apple Music", "from the Vitana',
            '    hub"). Map to: spotify / google / apple_music / vitana_hub.',
            '    In ALL other cases OMIT source — the backend routes.',
            '',
            'AFTER CALLING — the tool response tells you what happened.',
            'The track is already playing by the time you speak. Keep your',
            'acknowledgement short: "Playing X by Y on YouTube Music."',
            'If the response suggests a default, ask the user if they want',
            'it AFTER the song is playing, not before. NEVER read URLs aloud.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Song / artist / album / playlist in natural language, e.g. "Human Nature by Michael Jackson".',
              },
              source: {
                type: 'string',
                enum: ['spotify', 'google', 'apple_music', 'vitana_hub'],
                description: 'OMIT unless the user explicitly said "on <provider>" or "from <provider>" in this exact request.',
              },
            },
            required: ['query'],
          },
        },
        // VTID-01942 (PR 3): set / clear the user's preferred provider for a
        // capability. Called when the user says things like "make YouTube
        // Music my default", "always play music on Spotify", "don't use
        // Apple Music as default any more".
        {
          name: 'set_capability_preference',
          description: [
            'Set or clear the user\'s default provider for a capability.',
            'Call this when the user tells you which service to use by',
            'default. Examples:',
            '  - "make YouTube Music my default" → capability="music.play", connector_id="google"',
            '  - "always play music on Spotify" → capability="music.play", connector_id="spotify"',
            '  - "use the Vitana hub by default"→ capability="music.play", connector_id="vitana_hub"',
            '  - "stop using Spotify as default"→ capability="music.play", clear=true',
            '',
            'After calling, acknowledge in ONE short sentence',
            '("Got it — YouTube Music is your default for music now.").',
            '',
            'IMPORTANT — if the user just asked to play a song immediately',
            'before saying "yes make that my default", and you had already',
            'played that song, do NOT replay it. If you had NOT played it',
            'yet (e.g. you asked them first), call play_music RIGHT AFTER',
            'this tool with the original query they asked for. Never leave',
            'them without the song they asked for.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              capability: {
                type: 'string',
                description: 'Capability id (e.g. "music.play", "email.send").',
              },
              connector_id: {
                type: 'string',
                enum: ['google', 'spotify', 'apple_music', 'vitana_hub'],
                description: 'Which provider should serve this capability by default.',
              },
              clear: {
                type: 'boolean',
                description: 'True to remove the existing preference entirely. Omit connector_id when set.',
              },
            },
            required: ['capability'],
          },
        },
        // VTID-01943: Gmail read. Routes to email.read capability.
        {
          name: 'read_email',
          description: [
            'Read the user\'s unread emails or emails from a specific sender.',
            'Call this when the user asks things like:',
            '  - "check my emails"',
            '  - "do I have any new emails?"',
            '  - "anything from Sarah today?"',
            '  - "what\'s in my inbox?"',
            '',
            'Pass optional filters: `limit` (default 5 — keep low for voice),',
            '`from` (sender filter, e.g. "sarah@example.com"),',
            '`unread_only` (default true).',
            '',
            'SPEAK THE RESULT SUCCINCTLY. Summarise count + who + subject,',
            'e.g. "You have 3 unread emails: one from Sarah about the',
            'project plan, one from Google about your account, and one',
            'newsletter from Substack. Want me to read any in detail?"',
            'Don\'t read entire message bodies unless the user asks.',
          ].join('\n'),
          parameters: {
            // BOOTSTRAP-ORB-1007-AUDIT: Vertex Live function-declaration schema
            // is the OpenAPI 3.0 SUBSET supported by Gemini — it rejects
            // `default`, `minimum`, `maximum`, and similar JSON-Schema fields
            // with WebSocket close code 1007. Keep constraints in description
            // text instead.
            type: 'object',
            properties: {
              limit: { type: 'integer', description: 'Max emails to return (1-25). Default 5.' },
              from: { type: 'string', description: 'Optional sender filter' },
              unread_only: { type: 'boolean', description: 'Only unread emails. Default true.' },
            },
          },
        },
        // VTID-01943: Calendar list. Routes to calendar.list capability.
        {
          name: 'get_schedule',
          description: [
            'Return the user\'s upcoming calendar events. Call when the user asks:',
            '  - "what\'s on today?"',
            '  - "do I have any meetings tomorrow?"',
            '  - "what does my week look like?"',
            '  - "am I free at 3pm?"',
            '',
            'Pass `days_ahead` — 1 for "today", 2 for "today and tomorrow",',
            '7 for "this week". Default 1.',
            '',
            'Summarise the events: "Today at 10am you have a call with John,',
            'and at 2pm a team sync." For longer horizons, group by day.',
            'Never dump raw timestamps — convert to natural language.',
          ].join('\n'),
          parameters: {
            // BOOTSTRAP-ORB-1007-AUDIT: no default/minimum/maximum (Vertex 1007).
            type: 'object',
            properties: {
              days_ahead: { type: 'integer', description: 'How many days ahead (1-60). Default 1 = today.' },
            },
          },
        },
        // VTID-01943: Calendar create. Routes to calendar.create capability.
        {
          name: 'add_to_calendar',
          description: [
            'Add an event to the user\'s primary calendar. Call when the user says:',
            '  - "put a meeting with Sarah on my calendar at 3pm tomorrow"',
            '  - "schedule a call with the team Friday at 10"',
            '  - "add a reminder for the dentist on Monday at 2pm"',
            '',
            'Required: `title`, `start` (RFC3339, e.g. "2026-04-21T15:00:00+02:00").',
            '`end` defaults to start + 1h. Optional: `description`, `attendees` (emails).',
            '',
            'You MUST resolve relative time phrases ("tomorrow at 3pm") into',
            'an absolute RFC3339 string in the user\'s local timezone before',
            'calling. If ambiguous, ask.',
            '',
            'Acknowledge briefly: "Added — meeting with Sarah tomorrow at 3pm."',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              start: { type: 'string', description: 'RFC3339 start time' },
              end: { type: 'string', description: 'RFC3339 end (default: start + 1h)' },
              description: { type: 'string' },
              attendees: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'start'],
          },
        },
        // VTID-02047: Unified Feedback Pipeline — voice claim/bug/support intake.
        // VTID-02047 voice channel-swap (bidirectional): every persona has
        // this tool so the user can navigate between Vitana and her
        // colleagues by voice. Use cases:
        //   - User to Vitana:    "switch me to Devon" / "ich möchte mit Devon
        //                        sprechen" → switch_persona({to:'devon'})
        //   - User to Devon:     "connect me back to Vitana" / "zurück zu
        //                        Vitana" → switch_persona({to:'vitana'})
        //   - User to Sage:      "actually I have a billing question" →
        //                        switch_persona({to:'atlas'})
        // This tool DOES NOT create a ticket. report_to_specialist creates a
        // ticket AND swaps. switch_persona is just navigation.
        {
          name: 'switch_persona',
          description: [
            'Switch the active persona on this voice call to another colleague',
            '(or back to Vitana). Call ONLY when the user EXPLICITLY asks to',
            'talk to a different person by name — "switch me to Devon", "back',
            'to Vitana please", "I want to talk to Atlas about my refund',
            'instead". Voice + persona swap in the same call, no ticket filed.',
            '',
            'Personas: vitana (life companion + instruction manual), devon',
            '(bugs), sage (general support), atlas (marketplace claims), mira',
            '(account issues).',
            '',
            'AFTER calling: speak ONE short bridge sentence in your own',
            'natural words. ANNOUNCE the handoff — never INTRODUCE the new',
            'persona. ("I will bring Devon in" — yes. "Hi, here is Devon"',
            '— NO, that is Devon\'s job to say in his own voice.) Vary your',
            'phrasing every time, never recite a template. Then STOP.',
            '',
            'CRITICAL — never call this for instruction-manual questions',
            '("how does X work", "what is X", "explain X", "show me", "I am',
            'new"). Those are answered by Vitana inline. Specialists handle',
            'BROKEN STATE (bugs, claims, account issues) only.',
            '',
            'Specialists CAN ONLY pass to=\'vitana\' — sideways forwards to',
            'a peer specialist are server-blocked. Once a conversation has',
            'used 1 forward + 1 return, further forwards are also blocked.',
            '',
            'Do NOT use this to file a NEW bug/claim/support ticket — for',
            'that use report_to_specialist (creates ticket AND swaps).'
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              to: {
                type: 'string',
                // VTID-02651: enum is intentionally NOT hardcoded. Persona
                // keys are data-driven from agent_personas. The handler
                // validates against the live registry at exec time so any
                // newly-added specialist becomes a valid switch target with
                // zero code change. Default keys: vitana (receptionist),
                // devon, sage, atlas, mira. New specialists added by INSERT.
                description: 'Target persona key (e.g. vitana, devon, sage, atlas, mira, or any other active key from agent_personas). Use vitana to hand the user back to the receptionist.',
              },
              reason: {
                type: 'string',
                description: 'One short sentence on why the swap (e.g. "user wants to ask about longevity again", "this is a finance question, not tech").',
              },
            },
            required: ['to'],
          },
        },
        // Vitana calls this when the user wants to report something outside her
        // domain (bugs, support questions, refunds, account issues). The tool
        // creates a feedback_tickets row routed to the matching specialist
        // (Devon/Sage/Atlas/Mira). Vitana then speaks a short bridge sentence
        // confirming the handoff.
        {
          name: 'report_to_specialist',
          description: [
            'File a customer-support ticket and hand the call to a specialist',
            '(Devon/Sage/Atlas/Mira). This is RARE — typically less than 5%',
            'of conversations. You ARE the instruction manual; almost every',
            'question is yours to answer.',
            '',
            'YOU MUST PROPOSE BEFORE CALLING. Even when forwarding is warranted,',
            'first say something like "Shall I bring in Devon to file this?"',
            'and wait for the user to say yes. Implicit consent does NOT count.',
            'Vary the proposal phrasing every time.',
            '',
            'CALL ONLY WHEN ALL THREE are true:',
            '  (1) the user has described a CONCRETE PROBLEM (bug, broken',
            '      state, refund, account lockout, claim) — not a question',
            '      about how something works,',
            '  (2) the user has EXPLICITLY agreed to be connected to a',
            '      specialist (after you proposed it), and',
            '  (3) you can write a SPECIFIC `summary` (>= 15 words) that',
            '      describes WHAT broke, on WHICH screen/feature, with the',
            '      user\'s own words. If you cannot — because the user only',
            '      said "I want to report a bug" without details — DO NOT',
            '      CALL THIS TOOL YET. Instead ask ONE follow-up question:',
            '      "What\'s breaking — which screen or feature?" Get the',
            '      details, THEN call this tool. A vague summary causes the',
            '      specialist to invent the issue, which is worse than not',
            '      forwarding at all. Generic summaries like "user wants to',
            '      report a bug" are FORBIDDEN.',
            '',
            'NEVER CALL for any of these — answer them yourself inline using',
            'search_knowledge first:',
            '  - "How does X work?" / "What is X?" / "Explain X"',
            '  - "Show me how to use X" / "How do I X?" / "Teach me"',
            '  - "Tell me about X" / "I want to learn X" / "I am new"',
            '  - "Help me understand X" / "Walk me through X"',
            '  - Any health, longevity, matchmaking, community, business,',
            '    diary, calendar, or general life-companion question',
            '  - Anything that is a learning question, not a broken-state',
            '    report. First-time users asking how to use the diary is a',
            '    teaching moment, NOT a customer-support ticket.',
            '',
            'GATE-A enforcement: the backend re-checks the user\'s actual',
            'recent words (not your summary). If the gate returns STAY_INLINE,',
            'do NOT mention the routing decision out loud — silently answer',
            'the question. Same if the conversation\'s forward budget is',
            'exhausted (max 1 forward + 1 return per conversation).',
            '',
            'AFTER A FORWARD FIRES: speak ONE short bridge sentence in your',
            'own natural words. ANNOUNCE the handoff — never INTRODUCE the',
            'specialist ("Hi, here is Devon" — that is DEVON\'S job in his',
            'own voice). Vary your phrasing every time, never recite a',
            'template. Then STOP — the next voice is the specialist\'s.'
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['bug', 'ux_issue', 'support_question', 'account_issue', 'marketplace_claim', 'feature_request', 'feedback'],
                description: 'Best classification of what the user is reporting. Pick the closest match.',
              },
              specialist_hint: {
                type: 'string',
                // VTID-02651: NOT hardcoded — backend validates against the
                // agent_personas registry. Default specialists: devon (bugs/
                // UX), sage (support), atlas (marketplace/finance), mira
                // (account). New specialists added by INSERT.
                description: 'Optional: which specialist should own this (e.g. devon, sage, atlas, mira, or any other active key from agent_personas.handles_kinds). The backend re-checks via the keyword router and falls back to the kind→handles_kinds match if the hint is empty or unknown.',
              },
              summary: {
                type: 'string',
                description: 'CONCRETE one-paragraph summary using the user\'s OWN WORDS. Must include: what broke (the symptom), where (which screen/feature/flow), and any specifics the user gave (error message, order id, account email, time of day, etc). Minimum 15 words. FORBIDDEN: placeholder summaries like "user wants to report a bug" or "user has an account issue" or "user has a question". If you do not have enough specifics, ASK the user one diagnostic question first and call this tool only after you have a real description. A vague summary causes the specialist to hallucinate the issue and forces the user to correct fiction — worse than not forwarding at all.',
              },
            },
            required: ['kind', 'summary'],
          },
        },
        // VTID-01943: Contacts search. Routes to contacts.read capability.
        {
          name: 'find_contact',
          description: [
            'Find a contact by name or partial email. Call when the user asks:',
            '  - "what\'s Sarah\'s email?"',
            '  - "find John\'s phone number"',
            '  - "who is my dentist?"',
            '  - "do I have a contact for the plumber?"',
            '',
            'Pass `query` (substring). If the user asks for a generic list',
            '("show my contacts"), omit query and cap `limit` at 10.',
            '',
            'Speak naturally: "Sarah Jones — email sarah@example.com,',
            'phone +1 555-0100." If multiple matches, say so and ask which.',
          ].join('\n'),
          parameters: {
            // BOOTSTRAP-ORB-1007-AUDIT: no default/minimum/maximum (Vertex 1007).
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Name / email / phone substring' },
              limit: { type: 'integer', description: 'Max contacts to return (1-50). Default 10.' },
            },
          },
        },
        // BOOTSTRAP-ORB-DELEGATION-ROUTE: Delegate a question to another AI
        // the user has connected via Settings → Connected Apps (ChatGPT,
        // Claude, or Google AI). Vitana speaks the result in its own voice.
        // The user never sees which AI answered — it's pure backend routing.
        {
          name: 'consult_external_ai',
          description: [
            'Forward a question to one of the user\'s connected external AI',
            'accounts (ChatGPT, Claude, or Google AI / Gemini via the user\'s',
            'own API key) and return the answer. Vitana speaks the result in',
            'its OWN voice — never mention which AI produced the answer, and',
            'never say "Claude says" / "ChatGPT says".',
            '',
            'CALL THIS TOOL WHEN:',
            '  - the user explicitly names a provider ("ask ChatGPT …",',
            '    "what does Claude think about …", "frag Claude …")',
            '  - the task class strongly matches another provider\'s strength',
            '    and the user has that provider connected (e.g. long code',
            '    review → claude; image description of a supplied URL →',
            '    chatgpt with vision)',
            '  - the user asks for a "second opinion" on an answer',
            '',
            'DO NOT CALL WHEN:',
            '  - the question is about Vitana, the user\'s memory, their',
            '    calendar, events, or any internal tool you already have —',
            '    answer those yourself',
            '  - the user did not ask for an external opinion and your own',
            '    answer is sufficient',
            '',
            'ARGUMENTS:',
            '  - question (REQUIRED): a self-contained prompt. Do not rely',
            '    on Vitana-internal context; include whatever the external',
            '    AI needs to answer.',
            '  - provider_hint (OPTIONAL): include ONLY when the user named',
            '    a provider. openai = ChatGPT, anthropic = Claude,',
            '    google-ai = Google AI. Omit to let the router pick.',
            '  - task_class (OPTIONAL): hint the router toward a provider',
            '    whose strengths match the task.',
            '',
            'If the user has not connected any external AI, the tool',
            'returns a clear signal — acknowledge briefly ("you haven\'t',
            'connected an external AI yet") and answer yourself.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'Self-contained question to forward to the external AI.',
              },
              provider_hint: {
                type: 'string',
                enum: ['chatgpt', 'claude', 'google-ai'],
                description: 'Internal ID of the provider the user named. OMIT unless named.',
              },
              task_class: {
                type: 'string',
                enum: ['code', 'reasoning', 'creative', 'factual', 'summarization', 'long_context', 'vision', 'multilingual'],
                description: 'Kind of task, so the router can pick the best connected provider.',
              },
            },
            required: ['question'],
          },
        },
        // ─── BOOTSTRAP-ORB-INDEX-AWARENESS-R4 — Vitana Index tools (5-pillar) ───
        {
          name: 'get_vitana_index',
          description: [
            'Return the user\'s current Vitana Index with the canonical 5-pillar',
            'breakdown: total score (0-999), tier (Starting / Early / Building /',
            'Strong / Really good / Elite), all 5 pillars (Nutrition, Hydration,',
            'Exercise, Sleep, Mental — each 0-200), 7-day trend, weakest pillar',
            'with sub-score explanation (baseline / completions / connected data /',
            'streak), balance factor, and aspirational distance to Really-good.',
            '',
            'CALL THIS WHEN the user asks:',
            '  - "What is my Vitana Index?" / "Was ist mein Vitana Index?"',
            '  - "What\'s my score / tier?" / "Welchen Tier habe ich?"',
            '  - "How am I doing?" / "Wie stehe ich?" (when health context is the topic)',
            '',
            'DO NOT CALL for generic "what IS the Vitana Index" (no "my") —',
            'that\'s a platform explanation, use search_knowledge instead.',
            '',
            'The [HEALTH] block in the system prompt usually has the same info;',
            'calling this tool gets the freshest snapshot and returns it in a',
            'single structured object you can read aloud naturally.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_index_improvement_suggestions',
          description: [
            'Return 2-3 concrete actions the user can take to improve their',
            'Vitana Index, ranked by predicted contribution to a specific pillar.',
            'Each suggestion includes a title, the pillar(s) it lifts, and a',
            'magnitude from the recommendation\'s contribution_vector.',
            '',
            'CALL THIS WHEN the user asks:',
            '  - "How can I improve my Index?" / "Wie verbessere ich meinen Index?"',
            '  - "What\'s holding me back?" / "Was hält mich zurück?"',
            '  - "What should I focus on?" / "Worauf soll ich mich konzentrieren?"',
            '  - "Which pillar needs work?" / "Welche Säule brauche ich?"',
            '',
            'If the user names a pillar ("help me with Sleep"), pass the pillar',
            'argument. Otherwise omit it and the tool targets the weakest pillar',
            'automatically — OR, when the balance factor is below 0.9, targets',
            'the imbalance itself (lifting the weakest pillar moves the balance',
            'dampener, which moves the whole score).',
            '',
            'Speak the suggestions naturally — "a ten-minute morning meditation',
            'would lift Mental by three points" — never read raw JSON.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              pillar: {
                type: 'string',
                enum: ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'],
                description: 'Optional pillar to focus on. Omit to target the weakest pillar automatically.',
              },
              limit: {
                type: 'integer',
                description: 'Max suggestions to return. Default 3.',
              },
            },
          },
        },
        {
          name: 'create_index_improvement_plan',
          description: [
            'Build a multi-event calendar plan that targets a weak pillar of',
            'the user\'s Vitana Index, then write the events to their calendar',
            'directly (autonomous — no per-event confirmation). Returns a',
            'summary of what was scheduled for you to announce.',
            '',
            'CALL THIS WHEN the user asks:',
            '  - "Make me a plan to improve my Index"',
            '  - "Mach mir einen Plan für meinen Index"',
            '  - "Schedule a routine for me" / "Plan mir eine Routine"',
            '  - "Add things to my calendar to lift [pillar]"',
            '',
            'This is AUTONOMOUS by design — you do NOT need per-event',
            'confirmation. Announce clearly in voice what you just scheduled',
            '("I\'ve added three movement sessions this week and two',
            'mindfulness blocks next week to lift your Sleep pillar").',
            '',
            'If the user names a pillar (one of nutrition / hydration / exercise',
            '/ sleep / mental), pass it. Otherwise the tool targets the weakest',
            'pillar automatically. Days defaults to 14 (2 weeks), actions_per_week',
            'defaults to 3.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              pillar: {
                type: 'string',
                enum: ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'],
                description: 'Optional pillar to focus on. Omit to target weakest automatically.',
              },
              days: {
                type: 'integer',
                description: 'How many days forward to schedule. Default 14.',
              },
              actions_per_week: {
                type: 'integer',
                description: 'Rough frequency. Default 3.',
              },
            },
          },
        },
        // ─── VTID-01983 — save_diary_entry: voice diary logging ───
        {
          name: 'save_diary_entry',
          description: [
            'Save a Daily Diary entry on the user\'s behalf when they say',
            'they did something or want to track something. Then celebrate',
            'inline using the returned pillar deltas — see the override',
            'rules block (rule M).',
            '',
            'CALL THIS WHEN the user says any of:',
            '  - "Log my diary: …" / "Trag in mein Tagebuch ein: …"',
            '  - "I had …" / "Ich hatte …" / "I drank …" / "I ate …"',
            '  - "Track my [water / hydration / meal / breakfast / lunch /',
            '     dinner / workout / walk / run / sleep / meditation]"',
            '  - "Note that I …" / "Note for today: …"',
            '  - "Just had …" — even casual mentions',
            '',
            'IMPORTANT: pass the user\'s VERBATIM words as raw_text. The',
            'gateway runs a pattern-matching extractor on the text to detect',
            'water (1L → 1000ml), meals (breakfast / lunch / Frühstück /',
            'Mittagessen → meal_log count), exercise, sleep, meditation.',
            'DO NOT summarise, paraphrase, or translate. The extractor needs',
            'the original phrasing to catch every signal.',
            '',
            'Returns:',
            '  - health_features_written: number of structured rows written',
            '    to health_features_daily',
            '  - pillars_after: full Vitana Index pillar values after the',
            '    diary entry was applied',
            '  - index_delta: per-pillar lift the diary entry produced',
            '',
            'Use index_delta to celebrate. See override rule M for the',
            'exact response shape ("Done — Hydration up, you\'re at <total>").',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              raw_text: {
                type: 'string',
                description: 'The user\'s verbatim words. Do NOT summarise or rephrase. Multi-language OK.',
              },
              entry_date: {
                type: 'string',
                description: 'Optional YYYY-MM-DD. Defaults to today.',
              },
            },
            required: ['raw_text'],
          },
        },
        // ─── VTID-02601 — set_reminder: voice-create a one-shot reminder ───
        {
          name: 'set_reminder',
          description: [
            "Set a one-time reminder when the user asks. CRITICAL: when the user says",
            "'remind me at X to Y', 'set a reminder for Z', 'erinnere mich um X', or similar,",
            "you MUST call this tool. Do NOT tell the user 'okay, I'll remind you' without",
            "calling this tool — without the tool call, NO reminder is created.",
            '',
            "You compute the absolute UTC timestamp yourself from the user's words and",
            "their local timezone (provided in your system context as user_tz). Examples:",
            "  'today at 8pm'        → user's tz, today, 20:00 → convert to UTC ISO",
            "  'in 2 hours'          → now + 2h ISO",
            "  'tomorrow morning'    → ASK 'what time tomorrow morning?' before calling",
            '',
            "If a phrase is ambiguous (vague time, no day), ASK the user to clarify",
            "before calling. Do not guess.",
            '',
            "Generate `spoken_message` as a friendly sentence in the user's language",
            "that will be spoken aloud at fire time (e.g. 'Time to take your magnesium',",
            "'Zeit für deine Magnesium-Tabletten').",
            '',
            "After the tool returns, confirm verbally with result.human_time and the",
            "action_text (e.g. 'Okay, I'll remind you at 8 PM to take your magnesium.').",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              action_text: {
                type: 'string',
                description: "Short label, max 60 chars. e.g. 'Take magnesium'",
              },
              spoken_message: {
                type: 'string',
                description: "Friendly sentence to speak aloud at fire time, in the user's language.",
              },
              scheduled_for_iso: {
                type: 'string',
                description: 'Absolute UTC ISO 8601 timestamp. Min 60s in future, max 90 days out.',
              },
              description: {
                type: 'string',
                description: 'Optional extended details',
              },
            },
            required: ['action_text', 'spoken_message', 'scheduled_for_iso'],
          },
        },
        // ─── VTID-02601 — find_reminders: read-only lookup ───
        {
          name: 'find_reminders',
          description: [
            "Search the user's active reminders by free-text query. Use BEFORE delete_reminder",
            "to find which reminder the user means, and to read back the count when they say",
            "'delete all'. Returns up to 10 matches.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: "Free-text. Empty string = all active reminders.",
              },
              include_fired: {
                type: 'boolean',
                description: 'Include already-fired but unacked reminders. Default false.',
              },
            },
            required: ['query'],
          },
        },
        // ─── VTID-02601 — delete_reminder: destructive, requires verbal confirmation ───
        {
          name: 'delete_reminder',
          description: [
            "Delete one reminder OR all the user's reminders. CRITICAL SAFETY RULES:",
            '',
            "1. You MUST verbally confirm before calling this tool. Say something like:",
            "   - single: 'Are you sure you want to delete the magnesium reminder at 8pm?'",
            "   - all:    'Are you sure you want to delete all 5 of your reminders?'",
            '',
            "2. Only call this tool with confirmed=true AFTER the user explicitly says",
            "   yes / ja / sí / yes please / definitely / go ahead. Vague answers like",
            "   'maybe' or 'I think so' are NOT confirmation — re-ask.",
            '',
            "3. NEVER skip step 1 even if the user sounds urgent. Deleting reminders",
            "   is destructive and the user wants you to double-check.",
            '',
            "4. For single deletion: first call find_reminders to get the reminder_id.",
            "   For 'delete all': call find_reminders with empty query first, read back",
            "   the count in the confirmation question.",
            '',
            "5. Soft delete only — sets status='cancelled', user can recover via UI.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['single', 'all'],
                description: "'single' = one reminder by id; 'all' = all active reminders",
              },
              reminder_id: {
                type: 'string',
                description: "Required when mode='single'. UUID from find_reminders result.",
              },
              confirmed: {
                type: 'boolean',
                description: 'Must be true. Set ONLY after explicit user yes.',
              },
              user_confirmation_phrase: {
                type: 'string',
                description: "Verbatim user phrase that confirmed (e.g. 'yes, delete it'). For audit.",
              },
            },
            required: ['mode', 'confirmed', 'user_confirmation_phrase'],
          },
        },
        // ─── BOOTSTRAP-PILLAR-AGENT-Q — per-pillar agent Q&A dispatch ───
        {
          name: 'ask_pillar_agent',
          description: [
            'Route a per-pillar deep question to the matching specialised',
            'pillar agent (Nutrition / Hydration / Exercise / Sleep / Mental).',
            'The agent grounds the answer in the user\'s LIVE pillar data',
            '(current sub-scores: baseline / completions / connected data /',
            'streak) AND cites the relevant Book of the Vitana Index chapter.',
            '',
            'CALL THIS WHEN the user asks about a specific pillar:',
            '  - "How is my sleep?" / "Wie steht mein Schlaf?"',
            '  - "Why is my nutrition low?" / "Warum ist meine Ernährung niedrig?"',
            '  - "What\'s holding back my exercise score?"',
            '  - "How do I improve my mental pillar?"',
            '',
            'Pass `pillar` when the user\'s phrasing is unambiguous; OMIT it',
            'and the tool will detect the pillar from `question`. If detection',
            'fails and `pillar` is omitted, the tool returns null — voice should',
            'then fall back to search_knowledge against the Book.',
            '',
            'Speak the returned `text` naturally and cite the Book chapter.',
            'NEVER read raw JSON. NEVER echo a retired pillar name (Physical,',
            'Social, Environmental, Prosperity) — the tool already aliases',
            'those silently.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The user\'s natural-language question, verbatim. Used for pillar detection if `pillar` is omitted.',
              },
              pillar: {
                type: 'string',
                enum: ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'],
                description: 'Optional explicit pillar. Omit to auto-detect from question text.',
              },
            },
            required: ['question'],
          },
        },
        // ─── BOOTSTRAP-TEACH-BEFORE-REDIRECT — explanation-first dispatch ───
        {
          name: 'explain_feature',
          description: [
            'Return the canonical voice-friendly explanation of a Vitana feature',
            'or how-to topic (manual hydration logging, Daily Diary dictation,',
            'connecting trackers, what Autopilot is, how to improve the Index,',
            'etc.). Returns summary + ordered steps + a redirect offer the',
            'user can accept by saying yes.',
            '',
            'CALL THIS WHEN the user shows TEACH-INTENT phrasing — examples:',
            '  - "Explain X" / "Erkläre mir X"',
            '  - "Tell me about X" / "Tell me how X works"',
            '  - "Show me how to <verb>" (NOT "show me the <noun>")',
            '  - "How does X work" / "Wie funktioniert X"',
            '  - "How do I <action>" / "How can I use X" (TEACH-THEN-NAV — speak',
            '     a brief explanation, then offer redirect)',
            '  - "I don\'t understand X" / "Ich verstehe X nicht"',
            '  - "I\'m new to this" / "Ich bin neu hier"',
            '',
            'DO NOT CALL when the user clearly wants navigation:',
            '  - "Open <thing>" / "Öffne <thing>"',
            '  - "Go to <thing>" / "Take me to <thing>"',
            '  - "Show me the <screen|page|section>" / "Zeig mir den Bildschirm"',
            '  - "I want to see the <thing>"',
            'Those are NAVIGATE-ONLY — call the navigation tool instead.',
            '',
            'Speak the returned summary_voice_<lang> verbatim, then read each',
            'item of steps_voice_<lang> in order. End with the redirect_offer_<lang>.',
            'Only call the navigation tool with redirect_route AFTER the user',
            'confirms (yes / ja / open it / do it).',
            '',
            'If found=false, fall back to search_knowledge against the',
            'kb/vitana-system/how-to/ corpus.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'The user\'s natural-language topic, verbatim. Used for canonical-topic resolution.',
              },
              mode: {
                type: 'string',
                enum: ['teach_only', 'teach_then_nav'],
                description: 'Bucket per the intent classifier. teach_only = read FULL steps, no redirect. teach_then_nav = read concise steps + redirect_offer at end.',
              },
            },
            required: ['topic'],
          },
        },
        // ─── VTID-01967 — Vitana ID voice messaging ───
        // Three tools that let the user say "send a message to alex3700"
        // or "share this link with maria2307" and have ORB resolve the
        // recipient, confirm verbally, and send. These tools enforce a
        // strict confirmation contract: ALWAYS resolve first, ALWAYS
        // read back, ONLY send on explicit verbal confirmation.
        {
          name: 'resolve_recipient',
          description: [
            'Resolve a spoken recipient name or Vitana ID to a real user.',
            '',
            'YOU MUST CALL THIS before any reply about whether a person',
            'exists — including saying you can\'t find them. The ONLY way',
            'to honestly tell the user "I can\'t find that person" is to',
            'receive an empty candidates array from this tool. Without',
            'calling, you have no contact list to consult and you will',
            'hallucinate. Do not infer absence from your own knowledge.',
            '',
            'Trigger phrases (call this on ALL of them):',
            '  - "send a message to X" / "text X" / "tell X that ..."',
            '  - "share this with X" / "invite X" / "introduce me to X"',
            '  - "is X here?" / "do we have someone called X?"',
            '',
            'Spoken_name handling for hint phrases:',
            '  - User says "Maria, I think it\'s maria6": pass spoken_name="maria6"',
            '    first (the Vitana ID is the strongest signal). If empty,',
            '    retry with spoken_name="maria".',
            '  - User says "@alex3700": pass spoken_name="alex3700" (the',
            '    resolver strips leading @).',
            '  - User says "Daniela": pass spoken_name="Daniela".',
            '',
            'Returns ranked candidates. Each has:',
            '  - user_id (opaque UUID — pass to send_chat_message / share_link)',
            '  - vitana_id (speakable, e.g. "alex3700" — read this to the user)',
            '  - display_name (their full name)',
            '  - score (0.00-1.25; 1.0 = exact vitana_id match)',
            '  - reason ("vitana_id_exact" | "legacy_handle" | "fuzzy_name" | "fuzzy_chat_peer")',
            '',
            'Also returns top_confidence and ambiguous (boolean).',
            '',
            'BEHAVIOR:',
            '  1. If candidates is empty: tell the user you couldn\'t find',
            '     anyone matching that name and ask them to repeat or spell',
            '     the Vitana ID.',
            '  2. If ambiguous=false AND top_confidence >= 0.85 AND only ONE',
            '     candidate: silently pick candidates[0] and proceed to step 4.',
            '  3. If ambiguous=true OR multiple candidates: read up to 3',
            '     options to the user — "I see {N} matches: @<vid1>',
            '     ({display_name1}), @<vid2> ({display_name2}). Which one?"',
            '     Wait for them to pick by Vitana ID, by name, or by',
            '     position ("the first one", "Daniela Müller").',
            '  4. After a recipient is chosen, NEVER call send_chat_message',
            '     or share_link directly — first read the message back to',
            '     the user verbatim and ask "say send to confirm or cancel',
            '     to stop". Only on explicit confirmation, call the send',
            '     tool.',
            '',
            'NEVER resolve to the user\'s own ID — the resolver excludes self.',
            'NEVER skip this step before sending; the send tools assume a',
            'pre-resolved user_id from this call.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              spoken_name: {
                type: 'string',
                description: 'The recipient name / Vitana ID exactly as the user said it. Examples: "Daniela", "alex3700", "@alex3700", "Branislav". Strip leading @ if present (the resolver normalizes).',
              },
              limit: {
                type: 'integer',
                description: 'Maximum candidates to return (default 5). Keep low for voice — 3 is plenty.',
              },
            },
            required: ['spoken_name'],
          },
        },
        {
          name: 'send_chat_message',
          description: [
            'Send a direct message to another Vitana user. ONLY call this',
            'after resolve_recipient has returned a candidate AND the user',
            'has verbally confirmed both the recipient AND the message body',
            '(e.g. "yes send it", "send", "confirm", "ja schick es").',
            '',
            'NEVER call this without resolve_recipient first.',
            'NEVER auto-fire on "I want to message X" — always read back and wait.',
            '',
            'After a successful send, acknowledge briefly: "Sent to @<vid>."',
            'If the response says rate_limited, tell the user: "I can\'t send',
            'any more messages this session — please open the app to continue."',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              recipient_user_id: {
                type: 'string',
                description: 'Opaque user_id from resolve_recipient candidates[i].user_id. Never derive this any other way.',
              },
              recipient_label: {
                type: 'string',
                description: 'The vitana_id of the recipient, used in the OASIS audit trail and acknowledgement (e.g. "alex3700"). Pass candidates[i].vitana_id verbatim.',
              },
              body: {
                type: 'string',
                description: 'The message body, exactly as the user dictated it. Do not rephrase or summarize.',
              },
            },
            required: ['recipient_user_id', 'recipient_label', 'body'],
          },
        },
        {
          // V2 — Proactive Initiative Engine
          name: 'activate_recommendation',
          description: [
            'Activate an Autopilot recommendation on the user\'s behalf —',
            'marks the recommendation as activated and brings it to the',
            'top of their active list. Use ONLY when the user has consented',
            'to a Proactive Initiative offer where the on_yes_tool is',
            '`activate_recommendation`. The recommendation id is pre-picked',
            'at initiative-resolution time — pass it through unchanged.',
            '',
            'After success, speak the sanctioned celebratory close from the',
            'initiative\'s `build_voice_on_complete` template.',
            '',
            'Returns { ok, title, completion_message }. If ok=false, briefly',
            'acknowledge ("Hmm, couldn\'t schedule that one") and offer to',
            'open the Autopilot screen instead via navigate_to_screen.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description:
                  'The recommendation id from the initiative target. Pass verbatim — never construct or guess it.',
              },
            },
            required: ['id'],
          },
        },
        {
          name: 'share_link',
          description: [
            'Share a link with another Vitana user as a chat message with a',
            'link-card preview. Same confirmation contract as send_chat_message:',
            'ALWAYS resolve_recipient first, ALWAYS read back the link target',
            'and recipient, ONLY send on explicit confirmation.',
            '',
            'Use this when the user says "share this with X", "send the page',
            'to X", "invite X to this", or similar. If the user is on a',
            'specific screen, call get_current_screen first to learn the',
            'target_url and target_kind ("event", "post", "profile", etc.),',
            'then read both back to the user before sending.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              recipient_user_id: {
                type: 'string',
                description: 'Opaque user_id from resolve_recipient candidates[i].user_id.',
              },
              recipient_label: {
                type: 'string',
                description: 'Recipient vitana_id (e.g. "alex3700").',
              },
              target_url: {
                type: 'string',
                description: 'Full URL of the resource to share (e.g. https://vitanaland.com/events/abc).',
              },
              target_kind: {
                type: 'string',
                description: 'What is being shared. Examples: "event", "meetup", "post", "profile", "product", "campaign", "page".',
              },
            },
            required: ['recipient_user_id', 'recipient_label', 'target_url', 'target_kind'],
          },
        },
        // ─── VTID-01975 — Vitana Intent Engine ───
        // Single voice tool that handles all six intent kinds. Same
        // confirmation contract as send_chat_message: classify → extract →
        // read back → only post on explicit verbal confirmation.
        {
          name: 'post_intent',
          description: [
            'Register an intent in the Vitana community catalog. Use this',
            'whenever the user expresses a need, an offering, a desire to find',
            'an activity partner / life partner / mentor, or willingness to',
            'lend / borrow / give / receive. The classifier picks the kind',
            'automatically; you can pass kind_hint when the user is explicit.',
            '',
            'CONFIRMATION CONTRACT (mandatory):',
            '1. Call post_intent(utterance) WITHOUT confirmed=true. Server',
            '   classifies + extracts + returns a structured summary.',
            '2. Read the summary back verbatim ("Posting: ...").',
            '3. Wait for explicit confirmation (post/yes/confirm/ja).',
            '4. Call post_intent again WITH confirmed=true.',
            '',
            'For partner_seek: explain matches are revealed only after both',
            'parties express interest (privacy protocol).',
            '',
            'DANCE matchmaking (learning_seek / mentor_seek / activity_seek with dance.* category):',
            '- "I want to learn salsa, find a teacher" → learning_seek + dance.learning.salsa',
            '- "I teach salsa Tuesdays" → mentor_seek + dance.teaching.salsa',
            '- "Find me a salsa partner Saturday night" → activity_seek + dance.social_partner',
            '- "Going out dancing this weekend" → activity_seek + dance.group_outing',
            'When the user gives constraints like gender / age range / location radius / max price,',
            'put them in kind_payload.counterparty_filter.',
            '',
            'ALWAYS-POST contract: every dictated intent gets posted regardless of match count.',
            'When matches=0, do NOT say "no matches found." Say:',
            '"I posted your request — you\'re the first one looking for this in our community right now.',
            ' I\'ll let you know the moment someone matches. Your post is also visible on the board so',
            ' anyone can see it."',
            '',
            'DEDUP BEHAVIOR: if the user asks the same thing twice in a session ("looking for a dance partner"',
            'after they already posted that), the server returns deduplicated:true with the existing intent_id.',
            'When you see deduplicated:true, do NOT post again. Tell the user: "You already posted this',
            'earlier today. Refine it (different time, location, or style) if you want a new one — or open',
            'the existing post and I can show you who responded." Then call list_my_intents OR navigate_to_screen',
            'with target=my_intents so they can SEE their existing post.',
            '',
            'NEVER repeat-post the same generic ask. If the user repeats verbatim, treat it as "show me my',
            'existing post" — call list_my_intents and surface what they already have.',
            '',
            'SUCCESS CONTRACT (VTID-02790, mandatory):',
            'When the response contains stage:"posted" — regardless of match_count, cold_start, or any',
            'other field — the post is LIVE in the database. You MUST confirm success.',
            '- NEVER say "I had a problem", "there was an issue", "I couldn\'t post", "etwas ging schief",',
            '  "es gab ein Problem", "ich konnte den Beitrag nicht erstellen", or any apologetic phrase.',
            '- For match_count > 0: announce the post is live and that there are N potential matches.',
            '- For match_count = 0 (cold_start): use the "you\'re the first" copy above.',
            '- If the user later doubts ("did it really post?"), call list_my_intents and SHOW them.',
            'Do NOT invent failure modes. Do NOT apologize when the server reported success.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              utterance: { type: 'string', description: 'The user\'s words verbatim.' },
              kind_hint: {
                type: 'string',
                enum: ['commercial_buy', 'commercial_sell', 'activity_seek', 'partner_seek', 'social_seek', 'mutual_aid', 'learning_seek', 'mentor_seek'],
              },
              confirmed: { type: 'boolean' },
            },
            required: ['utterance'],
          },
        },
        {
          name: 'view_intent_matches',
          description: 'Pull the top-N matches for one of the user\'s open intents. partner_seek matches show "(redacted)" until both parties express interest.',
          parameters: {
            type: 'object',
            properties: {
              intent_id: { type: 'string' },
              limit: { type: 'integer' },
            },
            required: ['intent_id'],
          },
        },
        {
          name: 'list_my_intents',
          description: 'List the user\'s open intents. Optional kind filter.',
          parameters: {
            type: 'object',
            properties: {
              intent_kind: {
                type: 'string',
                enum: ['commercial_buy', 'commercial_sell', 'activity_seek', 'partner_seek', 'social_seek', 'mutual_aid', 'learning_seek', 'mentor_seek'],
              },
            },
          },
        },
        {
          name: 'respond_to_match',
          description: 'Express interest or decline a match. CONFIRMATION CONTRACT: read summary back, only call with confirmed=true after explicit user response. partner_seek mutual interest unlocks reciprocal-reveal.',
          parameters: {
            type: 'object',
            properties: {
              match_id: { type: 'string' },
              response: { type: 'string', enum: ['express_interest', 'decline'] },
              confirmed: { type: 'boolean' },
            },
            required: ['match_id', 'response'],
          },
        },
        {
          name: 'mark_intent_fulfilled',
          description: 'Close one of the user\'s intents because they got what they were looking for.',
          parameters: {
            type: 'object',
            properties: { intent_id: { type: 'string' } },
            required: ['intent_id'],
          },
        },
        // VTID-DANCE-D10: voice-driven direct invite.
        {
          name: 'share_intent_post',
          description: [
            'Direct-share one of the user\'s intent posts to specific community members.',
            'Use when the user says "share my <topic> post with @maria3 and @daniel4" or',
            '"send my salsa request to my friends Anna and Boris".',
            '',
            'CONFIRMATION CONTRACT (mandatory):',
            '1. Resolve each spoken name via resolve_recipient first to get the @vitana_id.',
            '2. Read back: "I\'ll share your <intent title> with @maria3 and @daniel4. Say send to confirm."',
            '3. Wait for explicit user confirmation (send/yes/confirm/ja).',
            '4. Call share_intent_post with confirmed=true.',
            '',
            'For partner_seek posts: warn the user that sharing reveals their identity to the recipient.',
            'For private posts: only the post owner can share — others should use the public link.',
            '',
            'Server is idempotent: re-sharing to the same recipient is a no-op (matches_created=0).',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              intent_id: { type: 'string', description: 'The user\'s intent_id to share. Pull from list_my_intents if needed.' },
              recipient_vitana_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Up to 20 vitana_ids (without leading @).',
              },
              note: { type: 'string', description: 'Optional short note to include with the share (≤280 chars).' },
              confirmed: { type: 'boolean' },
            },
            required: ['intent_id', 'recipient_vitana_ids'],
          },
        },
        // VTID-02770 — Voice navigation. The Navigator returns a relative URL
        // the frontend ORB widget intercepts and routes to.
        //
        // The valid set of `screen_id` values is the Navigation Catalog
        // (services/gateway/src/lib/navigation-catalog.ts) — the single source
        // of truth, ~150 entries and growing. There is no enum here on purpose:
        // an enum drifts the moment a new screen ships. Send any screen_id or
        // alias slug; the gateway validates with exact match → alias match →
        // fuzzy resolve, in that order.
        {
          name: 'navigate_to_screen',
          description: [
            'Redirect the user to a screen, page, drawer, or overlay.',
            '',
            '── HARD-REDIRECT LEXICON — ALWAYS call this tool when the user uses any of these phrasings AND the requested item maps unambiguously to one screen ──',
            '  Open       — "open …", "take me to …", "go to …", "launch …", "öffne …", "geh zu …", "bring mich zu …"',
            '  Show       — "show me …", "let me see …", "display …", "zeig mir …", "lass mich … sehen"',
            '  Guide      — "guide me to …", "navigate me to …", "lead me to …", "führe mich zu …"',
            '  Locate     — "where can I find …", "where is …", "where do I see …", "wo finde ich …", "wo ist …"',
            '  Action     — "where can I execute …", "where do I do …", "where can I log …", "wo kann ich …"',
            '  Read       — "read me my …", "read this …", "read that …", "lies mir … vor"',
            '  Not-found  — "I could not find …", "I can\'t find …", "I don\'t see …", "ich finde … nicht"',
            '',
            'When any of these phrasings is used and the target is unambiguous, the redirect IS the answer. Do not narrate, do not ask permission, do not re-confirm. After calling, say a brief voice cue ("Opening your matches" / "Hier ist dein Index").',
            '',
            '── DISAMBIGUATION ──',
            'If the request could legitimately map to multiple screens (e.g. "show me my news" → inbox / AI feed / news; "where can I see my events" → events / calendar / reminders), DO NOT GUESS. Ask one short either/or question using the catalog titles, then call this tool with the user\'s pick. Example: "Do you mean your inbox news, or your AI feed?" / "Meinst du deinen Posteingang oder den KI-Feed?"',
            '',
            '── HOW TO PICK A screen_id ──',
            'Send the canonical id when known: COMM.FIND_PARTNER, HEALTH.VITANA_INDEX, DISCOVER.MARKETPLACE, OVERLAY.CALENDAR, MEMORY.DIARY, REMINDERS.OVERVIEW, INBOX.OVERVIEW, PROFILE.ME, PROFILE.PUBLIC, SETTINGS.CONNECTED_APPS, BUSINESS.OVERVIEW, COMM.OPEN_ASKS, COMM.MEMBERS, COMM.TALK_TO_VITANA, INTENTS.BOARD, INTENTS.MINE, INTENTS.MATCH_DETAIL, etc. If you only know a slug, send that — alias resolution handles "find-partner", "marketplace", "vitana-index", "calendar", "diary", "reminders", "members", "open-asks", "intent-board", "connected-apps", and the legacy snake_case forms (find_partner, events_meetups, …). Slugs work in EN or DE.',
            '',
            'Overlays (entry_kind=overlay): they open as a popup/drawer on the current screen instead of navigating. Examples: OVERLAY.CALENDAR, LIFE_COMPASS.OVERLAY, OVERLAY.VITANA_INDEX, OVERLAY.PROFILE_PREVIEW, OVERLAY.MEETUP_DRAWER, OVERLAY.EVENT_DRAWER, OVERLAY.WALLET_POPUP, OVERLAY.MASTER_ACTION. Same tool, same call site — the catalog tells the gateway which to render.',
            '',
            '── PARAMETERIZED ROUTES ──',
            'If the catalog entry has `:param` placeholders, also send the param: `match_id` for INTENTS.MATCH_DETAIL; `vitana_id` (+ optional `intent_id`) for PROFILE.PUBLIC / PROFILE.WITH_MATCH; `meetup_id` / `event_id` for OVERLAY.MEETUP_DRAWER / OVERLAY.EVENT_DRAWER; `user_id` for OVERLAY.PROFILE_PREVIEW; `id` for DISCOVER.PRODUCT_DETAIL / DISCOVER.PROVIDER_PROFILE / NEWS.DETAIL; `groupId` for COMM.GROUP_DETAIL; `roomId` for COMM.LIVE_ROOM_VIEWER.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              screen_id: {
                type: 'string',
                description: 'Catalog screen_id (e.g. "COMM.FIND_PARTNER") OR a known alias slug ("find-partner", "marketplace"). Validated server-side with exact → alias → fuzzy resolution; unknown ids are rejected with suggestions.',
              },
              target: {
                type: 'string',
                description: 'Legacy slug field — kept for backward compatibility with older clients. Equivalent to screen_id when both are absent.',
              },
              reason: {
                type: 'string',
                description: 'One-sentence reason in the user\'s language. Surfaced in OASIS telemetry for tuning.',
              },
              intent_id: { type: 'string', description: 'For PROFILE.WITH_MATCH (the matched intent_id).' },
              match_id: { type: 'string', description: 'For INTENTS.MATCH_DETAIL.' },
              vitana_id: { type: 'string', description: 'For PROFILE.PUBLIC / PROFILE.WITH_MATCH — counterparty vitana_id without leading @.' },
              meetup_id: { type: 'string', description: 'For OVERLAY.MEETUP_DRAWER.' },
              event_id: { type: 'string', description: 'For OVERLAY.EVENT_DRAWER.' },
              user_id: { type: 'string', description: 'For OVERLAY.PROFILE_PREVIEW.' },
              groupId: { type: 'string', description: 'For COMM.GROUP_DETAIL.' },
              roomId: { type: 'string', description: 'For COMM.LIVE_ROOM_VIEWER.' },
              id: { type: 'string', description: 'For DISCOVER.PRODUCT_DETAIL, DISCOVER.PROVIDER_PROFILE, NEWS.DETAIL.' },
            },
            // Either screen_id or target must be present — checked in the
            // handler so legacy callers that send `target` continue to work.
          },
        },
        // VTID-DANCE-D11.B — pre-post candidate scan.
        {
          name: 'scan_existing_matches',
          description: [
            'BEFORE posting an intent, call this to see who is already in the catalog with a similar ask.',
            'Use the same intent_kind you would pass to post_intent + the category_prefix (e.g. dance.) and',
            'the dance variety when known.',
            '',
            'Returns: { open_intents[], dance_pref_members[], total }.',
            'If total > 0: read back the names + offer "Want to see them, share with them, or post yours so they can find you too?"',
            'If total == 0: proceed with post_intent and use the always-post readback.',
            '',
            'This call is read-only and cheap — always safe to call before post_intent.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              intent_kind: {
                type: 'string',
                enum: ['commercial_buy','commercial_sell','activity_seek','partner_seek','social_seek','mutual_aid','learning_seek','mentor_seek'],
              },
              category_prefix: {
                type: 'string',
                description: 'e.g. "dance." for any dance category, "home_services." for any home service. Optional.',
              },
              variety: {
                type: 'string',
                description: 'For dance: salsa | tango | bachata | kizomba | swing | ballroom | hiphop | contemporary. Optional.',
              },
            },
            required: ['intent_kind'],
          },
        },
        // VTID-DANCE-D12 — poll for the matchmaker agent's polished result.
        {
          name: 'get_matchmaker_result',
          description: [
            'After post_intent, the matchmaker agent runs ASYNC (~20s) re-ranking + writing a voice readback.',
            'Call this 3 seconds after post_intent to fetch the polished result. status will be:',
            '  pending/running — call again in 3 seconds',
            '  complete — read back voice_readback verbatim, then offer next steps',
            '  error — fall back to the SQL match summary already returned by post_intent',
            '',
            'The polished result includes counter_questions when the user gave a vague intent.',
            'If counter_questions is non-empty, ASK them progressively (variety → time → location)',
            'BEFORE reading back the candidate list. The user can always say "just show me matches"',
            'to skip — never insist on filling all slots.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: { intent_id: { type: 'string' } },
            required: ['intent_id'],
          },
        },
        // ─── VTID-02753 — Voice Tool Expansion P1a: structured Health logging ───
        // Five tools backed by POST /api/v1/integrations/manual/log. Distinct
        // from save_diary_entry (which extracts from free text). Use when the
        // user explicitly states a quantity ("log 500ml of water", "I slept 7
        // hours", "30 minutes of running"). Each call writes a row to
        // health_features_daily and triggers a Vitana Index recompute.
        {
          name: 'log_water',
          description: [
            "Log a hydration entry when the user explicitly states an amount of water/fluid drunk.",
            "",
            "CALL THIS WHEN the user says any of:",
            "  - 'log 500ml of water' / 'trag 500ml Wasser ein'",
            "  - 'I drank a glass of water' (≈250ml)",
            "  - 'two liters today' (2000ml)",
            "  - 'log my water: 1.5L'",
            "",
            "Convert to ML before calling — the gateway expects amount_ml as a number.",
            "Common conversions: 1 glass ≈ 250ml, 1 cup ≈ 240ml, 1 bottle ≈ 500ml, 1L = 1000ml.",
            "If the amount is ambiguous ('some water'), ASK before calling — do not guess.",
            "",
            "After the tool returns, briefly acknowledge ('logged 500 ml — Hydration is up').",
            "Use the index_delta to celebrate movement on the Hydration pillar.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              amount_ml: {
                type: 'number',
                description: 'Amount of fluid in milliliters. Min 50, max 5000.',
              },
              date: {
                type: 'string',
                description: 'Optional YYYY-MM-DD. Defaults to today (user local).',
              },
            },
            required: ['amount_ml'],
          },
        },
        {
          name: 'log_sleep',
          description: [
            "Log a sleep duration when the user explicitly reports how long they slept.",
            "",
            "CALL THIS WHEN the user says any of:",
            "  - 'I slept 7 hours last night' / 'ich habe 7 Stunden geschlafen'",
            "  - 'log my sleep: 8.5 hours'",
            "  - 'got 6 hours' (assume sleep context)",
            "  - 'slept from 11 to 7' — compute hours yourself",
            "",
            "Convert to MINUTES before calling. Examples: 7h → 420, 8.5h → 510, 6h30m → 390.",
            "If the user gives a sleep range without confirming hours, ASK — don't guess.",
            "",
            "After the tool returns, acknowledge briefly. If hours were below 7, gently note",
            "it without lecturing ('420 minutes logged — under your typical 7 hours').",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              minutes: {
                type: 'integer',
                description: 'Sleep duration in minutes. Min 60, max 960 (16h).',
              },
              date: {
                type: 'string',
                description: 'Optional YYYY-MM-DD for the night logged. Defaults to today.',
              },
            },
            required: ['minutes'],
          },
        },
        {
          name: 'log_exercise',
          description: [
            "Log an exercise/workout session when the user explicitly reports duration.",
            "",
            "CALL THIS WHEN the user says any of:",
            "  - '30 minutes of running' / '30 Minuten Lauf'",
            "  - 'just finished a 45-minute workout'",
            "  - 'log a 1-hour walk'",
            "  - 'I did yoga for 20 minutes'",
            "",
            "Convert duration to MINUTES. The activity_type is freeform — pass the user's",
            "phrase verbatim ('running', 'cycling', 'yoga', 'crossfit', 'walk', 'swim').",
            "If the user reports an activity without a duration ('I went for a run'), ASK",
            "how long before calling. Don't guess.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              minutes: {
                type: 'integer',
                description: 'Duration in minutes. Min 5, max 600.',
              },
              activity_type: {
                type: 'string',
                description: "Freeform activity name (e.g. 'running', 'yoga', 'crossfit'). Optional.",
              },
              date: {
                type: 'string',
                description: 'Optional YYYY-MM-DD. Defaults to today.',
              },
            },
            required: ['minutes'],
          },
        },
        {
          name: 'log_meditation',
          description: [
            "Log a meditation / mindfulness session — boosts the Mental pillar.",
            "",
            "CALL THIS WHEN the user says any of:",
            "  - '10 minutes of meditation' / '10 Minuten Meditation'",
            "  - 'just finished a 20 minute mindfulness session'",
            "  - 'log my breathwork — 15 minutes'",
            "  - 'did box breathing for 5 minutes'",
            "",
            "Pass duration in MINUTES. Don't conflate with exercise — meditation/mindfulness/",
            "breathwork/yoga-nidra all go through this tool because they lift Mental, not",
            "Exercise.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              minutes: {
                type: 'integer',
                description: 'Meditation duration in minutes. Min 1, max 240.',
              },
              date: {
                type: 'string',
                description: 'Optional YYYY-MM-DD. Defaults to today.',
              },
            },
            required: ['minutes'],
          },
        },
        {
          name: 'get_pillar_subscores',
          description: [
            "Return the sub-score breakdown for a single Vitana Index pillar so you can",
            "explain WHY the pillar is low. Each pillar has four caps:",
            "  - baseline (0-40): from the baseline survey",
            "  - completions (0-80): from calendar tag completions",
            "  - data (0-40): from health_features_daily (this is what log_* tools lift)",
            "  - streak (0-40): consecutive-day streak for the pillar",
            "",
            "CALL THIS WHEN the user asks:",
            "  - 'why is my Sleep score low?'",
            "  - 'what's holding back my Nutrition?'",
            "  - 'break down my Hydration score'",
            "  - 'wieso ist meine Bewegung niedrig?'",
            "",
            "Speak the answer naturally — 'Your Sleep is mostly baseline because we don't",
            "have any tracker data yet — connect a wearable or log sleep manually and the",
            "data sub-score will start filling in.'",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              pillar: {
                type: 'string',
                enum: ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'],
                description: 'Which pillar to break down.',
              },
            },
            required: ['pillar'],
          },
        },
        // BOOTSTRAP-ADMIN-DD: admin voice tools — only injected when active_role
        // is admin / exafy_admin / developer. Community sessions never see them
        // and the orb dispatcher rejects them server-side regardless.
        ...(activeRole && ['admin', 'exafy_admin', 'developer'].includes(activeRole)
          ? ADMIN_TOOL_SCHEMAS
          : []),
      ],
    },
    // VTID-GOOGLE-SEARCH: Native Google Search grounding. Gemini calls
    // Google Search directly and returns results with citations — no
    // function_response needed from our side. Replaces the broken
    // search_web custom function (which required PERPLEXITY_API_KEY, a
    // secret that was never wired into the deploy). With this, factual
    // questions like "how many calories in an apple" or "latest research
    // on sleep" get real web-grounded answers automatically.
    { google_search: {} },
  ];
}

/**
 * VTID-01224: Execute a Live API tool call
 * Handles search_memory, search_knowledge, search_web, search_calendar, and create_calendar_event tools
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
  // VTID-01224-FIX: Default 3 s budget. Gemini Live API has its own internal
  // timeout for function_response (~3-4s); taking longer stalls the session.
  //
  // BOOTSTRAP-ORB-DELEGATION-ROUTE: consult_external_ai legitimately takes
  // up to 15 s because it round-trips through a third-party provider
  // (OpenAI/Anthropic/Google AI). The delegation executor already hard-caps
  // at 15 s internally (orb/delegation/execute.ts), so we mirror that here
  // as the outer tool budget. All other tools keep the 3 s budget.
  const TOOL_TIMEOUT_MS = toolName === 'consult_external_ai' ? 16_000 : 3_000;

  const executeWithTimeout = async (): Promise<{ success: boolean; result: string; error?: string }> => {
    return Promise.race([
      executeLiveApiToolInner(session, toolName, args, startTime),
      new Promise<{ success: boolean; result: string; error?: string }>((resolve) =>
        setTimeout(() => resolve({
          success: false,
          result: '',
          error: `Tool ${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`,
        }), TOOL_TIMEOUT_MS)
      ),
    ]);
  };

  const result = await executeWithTimeout();
  const elapsed = Date.now() - startTime;
  if (elapsed > TOOL_TIMEOUT_MS) {
    console.warn(`[VTID-STREAM-KEEPALIVE] Tool ${toolName} timed out (${elapsed}ms > ${TOOL_TIMEOUT_MS}ms)`);
  }
  return result;
}

// VTID-NAV: Tools that may execute without an authenticated identity.
// Anonymous orb sessions get this narrow allowlist so onboarding visitors can
// still be guided to public destinations like the Maxina portal.
// VTID-NAV-TIMEJOURNEY: get_current_screen is identity-free — it just reads
// session.current_route — so it's safe for anonymous sessions too.
const ANONYMOUS_SAFE_TOOLS = new Set<string>([
  'navigate',
  'get_current_screen',
]);

/**
 * Derive the Navigator's role from the surface the user is currently in.
 * The ORB must never cross surfaces: mobile and vitanaland.com → community,
 * /admin/* inside the community app → admin, /command-hub/* → developer.
 * The DB's active_role is deliberately NOT consulted — a user's DB role can
 * legitimately be "developer" while they are browsing the community app, and
 * in that case the Navigator should still only surface community routes.
 */
function deriveSurfaceRole(currentRoute: string | undefined | null): string {
  const route = (currentRoute || '').toLowerCase();
  if (route.startsWith('/command-hub')) return 'developer';
  if (route === '/admin' || route.startsWith('/admin/')) return 'admin';
  return 'community';
}

/**
 * VTID-NAV: Handle navigator_consult tool call. Self-contained — does not
 * require an authenticated identity (anonymous sessions can still consult,
 * just with empty memory hints).
 */
/**
 * VTID-NAV-UNIFIED: Single unified navigate tool handler.
 *
 * Replaces the old two-tool dance (navigator_consult → navigate_to_screen).
 * The LLM just passes the user's words. This function:
 * 1. Runs the consult (catalog scoring + KB search + memory hints)
 * 2. If a match is found: queues the orb_directive AND returns guidance text
 * 3. If no match: returns a clarification prompt
 *
 * Gemini never sees screen_ids. Never guesses. Just speaks the guidance.
 */
async function handleNavigate(
  session: GeminiLiveSession,
  args: Record<string, unknown>
): Promise<{ success: boolean; result: string; error?: string }> {
  const hasIdentity = !!(session.identity?.tenant_id && session.identity?.user_id);
  const question = String(args.question || '').trim();
  if (!question) {
    return { success: false, result: '', error: 'navigate requires a non-empty question.' };
  }

  // Surface-scoped role: the ORB's navigator must stay inside the surface the
  // user is actually in. The DB's active_role is not authoritative here — a
  // developer on vitanaland.com is a community user for navigation purposes.
  const surfaceRole = deriveSurfaceRole(session.current_route);

  // Step 1: Run the consult service (catalog + KB + memory)
  const consultInput: NavigatorConsultInput = {
    question,
    lang: session.lang || 'en',
    identity: hasIdentity
      ? {
          user_id: session.identity!.user_id,
          tenant_id: session.identity!.tenant_id as string,
          role: surfaceRole,
        }
      : null,
    is_anonymous: !!session.isAnonymous || !hasIdentity,
    current_route: session.current_route,
    recent_routes: session.recent_routes,
    transcript_excerpt: session.inputTranscriptBuffer,
    session_id: session.sessionId,
    turn_number: session.turn_count,
    conversation_start: session.createdAt.toISOString(),
  };

  const consultResult = await consultNavigator(consultInput);

  // Telemetry
  emitOasisEvent({
    vtid: 'VTID-NAV-01',
    type: 'orb.navigator.consulted',
    source: 'orb-live-ws',
    status: consultResult.confidence === 'low' ? 'warning' : 'info',
    message: `navigate: confidence=${consultResult.confidence}, decision=${consultResult.decision}, primary=${consultResult.primary?.screen_id || 'none'}`,
    payload: {
      session_id: session.sessionId,
      question,
      primary_screen_id: consultResult.primary?.screen_id || null,
      confidence: consultResult.confidence,
      // VTID-02781: surface decision in consulted-event payload
      decision: consultResult.decision,
      alternative_screen_ids: consultResult.alternatives.slice(0, 3).map(a => a.screen_id),
      kb_excerpt_count: consultResult.kb_excerpt_count,
      memory_hint_count: consultResult.memory_hint_count,
      ms_elapsed: consultResult.ms_elapsed,
      is_anonymous: consultInput.is_anonymous,
    },
  }).catch(() => {});

  // VTID-02781: If the consult decided the request is ambiguous, return an
  // either/or clarification BEFORE auto-navigating. Better to ask once than
  // to redirect to the wrong screen.
  if (
    consultResult.decision === 'ambiguous' &&
    consultResult.alternatives.length >= 2 &&
    !consultResult.blocked_reason
  ) {
    const top = consultResult.alternatives[0];
    const second = consultResult.alternatives[1];
    const third = consultResult.alternatives[2] || null;
    emitOasisEvent({
      vtid: 'VTID-02781',
      type: 'orb.navigator.disambiguated',
      source: 'orb-live-ws',
      status: 'info',
      message: `disambiguating: ${top.screen_id} vs ${second.screen_id}${third ? ' vs ' + third.screen_id : ''}`,
      payload: {
        session_id: session.sessionId,
        question,
        candidates: consultResult.alternatives.slice(0, 3).map(a => ({
          screen_id: a.screen_id, route: a.route, title: a.title,
        })),
        ms_elapsed: consultResult.ms_elapsed,
        lang: consultInput.lang,
      },
    }).catch(() => {});

    const lines: string[] = [];
    lines.push('NAVIGATING_TO: null (waiting for user choice — DO NOT redirect)');
    lines.push(`DECISION: ambiguous`);
    lines.push(`CANDIDATES:`);
    consultResult.alternatives.slice(0, 3).forEach((a, i) => {
      lines.push(`  [${i + 1}] ${a.screen_id} — ${a.title} (${a.route})`);
    });
    const askLine =
      consultResult.suggested_question ||
      (consultInput.lang.startsWith('de')
        ? `Meinst du ${top.title} oder ${second.title}${third ? ' — oder ' + third.title : ''}?`
        : `Do you mean ${top.title} or ${second.title}${third ? ' — or ' + third.title : ''}?`);
    lines.push(`ASK_USER: ${askLine}`);
    lines.push('');
    lines.push('Ask the either/or question naturally. WAIT for the user to pick.');
    lines.push('Then call navigate_to_screen with the chosen screen_id directly —');
    lines.push('do not call navigate again unless the user rephrases their request.');
    return { success: true, result: lines.join('\n') };
  }

  // Step 2: If we found a match with sufficient confidence, auto-navigate
  if (consultResult.primary && consultResult.confidence !== 'low' && !consultResult.blocked_reason) {
    const entry = lookupNavScreen(consultResult.primary.screen_id);
    if (entry) {
      const lang = session.lang || 'en';
      const content = getNavContent(entry, lang);

      // Queue the navigation
      session.pendingNavigation = {
        screen_id: entry.screen_id,
        route: entry.route,
        title: content.title,
        reason: question,
        decision_source: 'direct',
        requested_at: Date.now(),
      };
      session.navigationDispatched = true;

      // VTID-NAV-FAST: Dispatch orb_directive IMMEDIATELY — don't wait for
      // turn_complete. The widget starts its audio-drain-and-close loop in
      // parallel while Gemini is still generating the guidance speech. By
      // the time the user hears the full guidance, the drain is already
      // complete and navigation fires instantly. The turn_complete handler
      // will see pendingNavigation=undefined (cleared below) and skip its
      // own dispatch, avoiding double-send.
      const directive = {
        type: 'orb_directive',
        directive: 'navigate',
        screen_id: entry.screen_id,
        route: entry.route,
        title: content.title,
        reason: question,
        vtid: 'VTID-NAV-01',
      };
      const directiveJson = JSON.stringify(directive);
      if (session.sseResponse) {
        try { session.sseResponse.write(`data: ${directiveJson}\n\n`); } catch (_e) { /* SSE closed */ }
      }
      if ((session as any).clientWs && (session as any).clientWs.readyState === 1 /* WebSocket.OPEN */) {
        try { sendWsMessage((session as any).clientWs, directive); } catch (_e) { /* WS closed */ }
      }
      console.log(`[VTID-NAV-FAST] Immediate orb_directive dispatched: ${entry.screen_id} (${entry.route})`);
      emitOasisEvent({
        vtid: 'VTID-NAV-01',
        type: 'orb.navigator.dispatched',
        source: 'orb-live-ws',
        status: 'info',
        message: `immediate dispatch to ${entry.screen_id}`,
        payload: {
          session_id: session.sessionId,
          screen_id: entry.screen_id,
          route: entry.route,
          drain_wait_ms: 0,
        },
      }).catch(() => {});
      // Clear pending so turn_complete won't re-dispatch.
      session.pendingNavigation = undefined;

      // Eagerly update route for get_current_screen
      const previousRoute = session.current_route;
      session.current_route = entry.route;
      if (previousRoute && previousRoute !== entry.route) {
        const trail = Array.isArray(session.recent_routes) ? [...session.recent_routes] : [];
        const deduped = trail.filter(r => r !== previousRoute);
        session.recent_routes = [previousRoute, ...deduped].slice(0, 5);
      }

      // Persist navigator action memory (authenticated only)
      if (hasIdentity) {
        writeNavigatorActionMemory({
          identity: {
            user_id: session.identity!.user_id,
            tenant_id: session.identity!.tenant_id as string,
            role: session.active_role || session.identity!.role || undefined,
          },
          screen: {
            screen_id: entry.screen_id,
            route: entry.route,
            title: content.title,
          },
          reason: question,
          decision_source: 'direct',
          orb_session_id: session.sessionId,
          conversation_id: session.conversation_id,
          lang,
        }).catch(() => {});
      }

      emitOasisEvent({
        vtid: 'VTID-NAV-01',
        type: 'orb.navigator.requested',
        source: 'orb-live-ws',
        status: 'info',
        message: `navigate auto-redirect to ${entry.screen_id} (${entry.route})`,
        payload: {
          session_id: session.sessionId,
          screen_id: entry.screen_id,
          route: entry.route,
          reason: question,
          is_anonymous: consultInput.is_anonymous,
        },
      }).catch(() => {});

      // Build the guidance response for Gemini to speak
      const lines: string[] = [];
      lines.push(`NAVIGATING_TO: ${content.title}`);
      lines.push(`GUIDANCE: ${consultResult.explanation}`);
      if (consultResult.kb_excerpts.length > 0) {
        lines.push('ADDITIONAL_CONTEXT:');
        consultResult.kb_excerpts.forEach((x, i) => lines.push(`  [${i + 1}] ${x}`));
      }
      lines.push('');
      lines.push('Speak the GUIDANCE naturally to the user. Be helpful and warm —');
      lines.push('explain the feature, tell them what they can do on that screen,');
      lines.push('and let them know you are taking them there. The redirect happens');
      lines.push('automatically when you finish speaking.');

      return { success: true, result: lines.join('\n') };
    }
  }

  // Step 3: No confident match or blocked — ask the user to clarify
  if (consultResult.blocked_reason === 'requires_auth') {
    return {
      success: true,
      result: 'NAVIGATING_TO: null\nGUIDANCE: ' + consultResult.explanation +
        '\nTell the user this feature requires joining the community and offer to take them to registration.',
    };
  }

  if (consultResult.confirmation_needed && consultResult.primary && consultResult.alternative) {
    return {
      success: true,
      result: `NAVIGATING_TO: null (waiting for user choice)\nGUIDANCE: ${consultResult.explanation}\n` +
        `ASK_USER: ${consultResult.suggested_question || `Would you like to go to ${consultResult.primary.title} or ${consultResult.alternative.title}?`}\n` +
        'Ask the user to choose, then call navigate again with their answer.',
    };
  }

  return {
    success: true,
    result: 'NAVIGATING_TO: null\nGUIDANCE: ' + consultResult.explanation +
      '\nAsk the user to clarify what they are looking for so you can help them find it.',
  };
}

// Legacy handler — kept for test imports but no longer called by the tool path
async function handleNavigatorConsult(
  session: GeminiLiveSession,
  args: Record<string, unknown>
): Promise<{ success: boolean; result: string; error?: string }> {
  const hasIdentity = !!(session.identity?.tenant_id && session.identity?.user_id);
  const question = String(args.question || '').trim();
  if (!question) {
    return { success: false, result: '', error: 'navigator_consult requires a non-empty question.' };
  }

  const surfaceRole = deriveSurfaceRole(session.current_route);

  const consultInput: NavigatorConsultInput = {
    question,
    lang: session.lang || 'en',
    identity: hasIdentity
      ? {
          user_id: session.identity!.user_id,
          tenant_id: session.identity!.tenant_id as string,
          role: surfaceRole,
        }
      : null,
    is_anonymous: !!session.isAnonymous || !hasIdentity,
    current_route: session.current_route,
    recent_routes: session.recent_routes,
    transcript_excerpt: session.inputTranscriptBuffer,
    session_id: session.sessionId,
    turn_number: session.turn_count,
    conversation_start: session.createdAt.toISOString(),
  };

  const consultResult = await consultNavigator(consultInput);
  const formatted = formatConsultResultForLLM(consultResult);

  emitOasisEvent({
    vtid: 'VTID-NAV-01',
    type: 'orb.navigator.consulted',
    source: 'orb-live-ws',
    status: consultResult.confidence === 'low' ? 'warning' : 'info',
    message: `navigator_consult: confidence=${consultResult.confidence}, primary=${consultResult.primary?.screen_id || 'none'}`,
    payload: {
      session_id: session.sessionId,
      question,
      primary_screen_id: consultResult.primary?.screen_id || null,
      alternative_screen_id: consultResult.alternative?.screen_id || null,
      confidence: consultResult.confidence,
      confirmation_needed: consultResult.confirmation_needed,
      kb_excerpt_count: consultResult.kb_excerpt_count,
      memory_hint_count: consultResult.memory_hint_count,
      ms_elapsed: consultResult.ms_elapsed,
      lang: consultInput.lang,
      is_anonymous: consultInput.is_anonymous,
      blocked_reason: consultResult.blocked_reason || null,
    },
  }).catch(() => { /* ignore telemetry failure */ });

  return { success: true, result: formatted };
}

/**
 * VTID-NAV: Handle navigate_to_screen tool call. Self-contained — does not
 * require an authenticated identity. Anonymous sessions are gated to
 * anonymous_safe screens by the catalog access check below.
 */
// VTID-NAV-TEST: Exported for integration test that verifies the full
// navigate_to_screen → pendingNavigation → orb_directive dispatch flow
// without needing a real Gemini Live session.
export async function handleNavigateToScreen(
  session: GeminiLiveSession,
  args: Record<string, unknown>
): Promise<{ success: boolean; result: string; error?: string }> {
  const hasIdentity = !!(session.identity?.tenant_id && session.identity?.user_id);
  // VTID-02770: accept either `screen_id` (canonical) or legacy `target` slug.
  // The handler resolves both via the catalog's three-tier lookup
  // (exact id → alias → fuzzy).
  const screenId = String(args.screen_id || args.target || '').trim();
  const reason = String(args.reason || '').trim();
  if (!screenId) {
    return { success: false, result: '', error: 'navigate_to_screen requires screen_id (or legacy target).' };
  }

  // VTID-02770: Three-tier resolution.
  //   1. Exact screen_id match (BY_ID)
  //   2. Alias match (BY_ALIAS — includes legacy slugs like "find_partner",
  //      user-canonical paths like "/community/events", and language variants)
  //   3. Fuzzy fallback (suggestSimilar) — last-resort recovery for partial
  //      guesses like "MEDIA_HUB" instead of "COMM.MEDIA_HUB".
  let entry = lookupNavScreen(screenId);
  if (!entry) {
    const aliased = lookupNavByAlias(screenId);
    if (aliased) {
      console.log(`[VTID-02770] Alias-resolved '${screenId}' → '${aliased.screen_id}' (${aliased.route})`);
      entry = aliased;
    }
  }
  if (!entry) {
    const similar = suggestNavSimilar(screenId, 5);
    // Auto-resolve: if the top suggestion is unambiguous (strong lead or
    // single match), use it directly as if Gemini had sent the right id.
    if (similar.length > 0) {
      const topEntry = similar[0];
      const secondScore = similar.length > 1
        ? suggestNavSimilar(screenId, 5).indexOf(similar[1]) >= 0
          ? similar[1] // exists
          : null
        : null;
      // "Unambiguous" = only one suggestion OR top score exists (suggestSimilar
      // already sorts by score descending, and we can't access raw scores from
      // the public API, so we use a simpler heuristic: if there's a match at all,
      // take it — the worst case is navigating to the wrong screen, which is
      // strictly better than freezing the orb completely).
      console.log(`[VTID-NAV-FUZZY] Auto-resolving '${screenId}' → '${topEntry.screen_id}' (${topEntry.route})`);
      entry = topEntry;
      emitOasisEvent({
        vtid: 'VTID-NAV-01',
        type: 'orb.navigator.blocked',
        source: 'orb-live-ws',
        status: 'info',
        message: `Fuzzy-resolved screen_id '${screenId}' → '${topEntry.screen_id}'`,
        payload: {
          session_id: session.sessionId,
          attempted_screen_id: screenId,
          resolved_screen_id: topEntry.screen_id,
          error_kind: 'fuzzy_resolved',
        },
      }).catch(() => {});
    } else {
      emitOasisEvent({
        vtid: 'VTID-NAV-01',
        type: 'orb.navigator.blocked',
        source: 'orb-live-ws',
        status: 'warning',
        message: `Unknown screen_id '${screenId}' — no suggestions`,
        payload: {
          session_id: session.sessionId,
          attempted_screen_id: screenId,
          error_kind: 'unknown',
          suggestions: [],
        },
      }).catch(() => {});
      return {
        success: false,
        result: '',
        error: `Unknown screen_id '${screenId}'. No matching screens found in the catalog.`,
      };
    }
  }

  const isAnon = !!session.isAnonymous || !hasIdentity;
  if (isAnon && !entry.anonymous_safe) {
    emitOasisEvent({
      vtid: 'VTID-NAV-01',
      type: 'orb.navigator.blocked',
      source: 'orb-live-ws',
      status: 'warning',
      message: `Screen '${screenId}' requires authentication`,
      payload: {
        session_id: session.sessionId,
        attempted_screen_id: screenId,
        error_kind: 'auth_required',
      },
    }).catch(() => {});
    return {
      success: false,
      result: '',
      error: `Screen '${screenId}' requires the user to be signed in. Tell them briefly and offer to take them to registration instead.`,
    };
  }

  // VTID-02789: Viewport gate — refuse the redirect if the entry is
  // viewport-locked to mobile-only or desktop-only and the session doesn't
  // match. Lets us mark `/daily-diary` (mobile-only flow) so a desktop
  // session never gets sent there.
  if (entry.viewport_only) {
    const sessionViewport: 'mobile' | 'desktop' = session.is_mobile === true ? 'mobile' : 'desktop';
    if (entry.viewport_only !== sessionViewport) {
      emitOasisEvent({
        vtid: 'VTID-02789',
        type: 'orb.navigator.blocked',
        source: 'orb-live-ws',
        status: 'warning',
        message: `Screen '${entry.screen_id}' is ${entry.viewport_only}-only; session is ${sessionViewport}`,
        payload: {
          session_id: session.sessionId,
          attempted_screen_id: screenId,
          error_kind: 'wrong_viewport',
          required_viewport: entry.viewport_only,
          session_viewport: sessionViewport,
        },
      }).catch(() => {});
      return {
        success: false,
        result: '',
        error: `Screen '${entry.screen_id}' is only available on ${entry.viewport_only}. Suggest a different screen or stay in voice.`,
      };
    }
  }

  // VTID-02770: Resolve the final URL the frontend will receive.
  //   1. VTID-02789: Mobile-aware URL — when session.is_mobile=true AND the
  //      entry has a mobile_route override, use that instead of route. Lets
  //      pages that auto-redirect on mobile (e.g. /comm →
  //      /comm/events-meetups?tab=hot) skip the redirect hop.
  //   2. Substitute `:param` placeholders in the chosen base URL with values
  //      from args. Missing required params are reported as a typed error so
  //      Gemini knows it must ask the user for the missing piece.
  //   3. For overlay entries (entry_kind === 'overlay'), append
  //      `?open=<query_marker>` so the frontend ORB widget intercepts and
  //      dispatches the corresponding CustomEvent instead of routing.
  //   4. For overlay entries that need a parameter (e.g. user_id for
  //      OVERLAY.PROFILE_PREVIEW), append it as a query param too — the
  //      frontend reads it from the URL on dispatch.
  const isMobileSession = session.is_mobile === true;
  const baseRoute = (isMobileSession && entry.mobile_route) ? entry.mobile_route : entry.route;
  let resolvedRoute = baseRoute;
  const missingParams: string[] = [];
  resolvedRoute = resolvedRoute.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name) => {
    const v = args[name];
    if (v === undefined || v === null || String(v).trim() === '') {
      missingParams.push(String(name));
      return ':' + String(name);
    }
    // Strip a leading `@` from vitana_id-style params before encoding.
    const clean = String(v).trim().replace(/^@/, '');
    return encodeURIComponent(clean);
  });
  if (missingParams.length > 0) {
    emitOasisEvent({
      vtid: 'VTID-NAV-01',
      type: 'orb.navigator.blocked',
      source: 'orb-live-ws',
      status: 'warning',
      message: `Missing route param(s) for ${entry.screen_id}: ${missingParams.join(', ')}`,
      payload: {
        session_id: session.sessionId,
        attempted_screen_id: screenId,
        error_kind: 'missing_param',
        missing_params: missingParams,
      },
    }).catch(() => {});
    return {
      success: false,
      result: '',
      error: `Cannot navigate to ${entry.screen_id}: missing required parameter(s) ${missingParams.join(', ')}. Ask the user to provide them, then call navigate_to_screen again.`,
    };
  }

  if (entry.entry_kind === 'overlay' && entry.overlay) {
    const sep = resolvedRoute.includes('?') ? '&' : '?';
    const params = new URLSearchParams();
    params.set('open', entry.overlay.query_marker);
    // If the overlay needs a specific param (user_id, meetup_id, etc.) and
    // the caller provided it, pass it through so the frontend overlay can
    // pick the right entity to render.
    const needs = entry.overlay.needs_param;
    if (needs) {
      const v = args[needs];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        params.set(needs, String(v).trim().replace(/^@/, ''));
      }
    }
    resolvedRoute = `${resolvedRoute}${sep}${params.toString()}`;
  }

  // VTID-02789: Compare current_route against the *resolved* base path
  // (mobile_route on mobile, route otherwise) so a mobile user already on
  // /comm/events-meetups (because /comm aliased there) doesn't get bounced
  // when they ask for "the community page" again.
  const baseRoutePath = baseRoute.split('?')[0];
  if (session.current_route && session.current_route === baseRoutePath && entry.entry_kind !== 'overlay') {
    emitOasisEvent({
      vtid: 'VTID-NAV-01',
      type: 'orb.navigator.blocked',
      source: 'orb-live-ws',
      status: 'info',
      message: `User is already on ${baseRoutePath}`,
      payload: {
        session_id: session.sessionId,
        attempted_screen_id: screenId,
        error_kind: 'already_there',
      },
    }).catch(() => {});
    return {
      success: false,
      result: '',
      error: `The user is already on ${entry.route}. Suggest a related screen or just answer in voice instead.`,
    };
  }

  // Queue the navigation. The orb_directive dispatch in turn_complete
  // will pick this up AFTER the existing memory flush completes.
  const lang = session.lang || 'en';
  const content = getNavContent(entry, lang);
  session.pendingNavigation = {
    screen_id: entry.screen_id,
    route: resolvedRoute,
    title: content.title,
    reason: reason || 'navigate_to_screen tool call',
    decision_source: 'direct',
    requested_at: Date.now(),
  };
  // VTID-NAV: Set the gate that drops further input audio so Gemini does
  // not start a new turn while the widget is closing.
  session.navigationDispatched = true;

  // VTID-NAV-TIMEJOURNEY (journey-awareness fix): Eagerly update the
  // in-memory session route + journey trail so the next turn / any
  // subsequent get_current_screen tool call sees the FRESH destination,
  // not the stale route the user was on when the session started. This
  // is what makes "which screen am I on?" answerable after Vitana has
  // just redirected the user via this tool.
  //
  // VTID-02770: For overlay entries we do NOT change current_route, since the
  // user stays on their original page — only a popup opens.
  // VTID-02789: Use the resolved baseRoutePath (mobile_route on mobile, else
  // route) so the eager update tracks the actual destination, not the
  // generic desktop URL.
  if (entry.entry_kind !== 'overlay') {
    const previousRoute = session.current_route;
    session.current_route = baseRoutePath;
    if (previousRoute && previousRoute !== baseRoutePath) {
      const trail = Array.isArray(session.recent_routes) ? [...session.recent_routes] : [];
      const deduped = trail.filter(r => r !== previousRoute);
      session.recent_routes = [previousRoute, ...deduped].slice(0, 5);
    }
  }

  // Persist the navigation as a memory item (authenticated only).
  if (hasIdentity) {
    writeNavigatorActionMemory({
      identity: {
        user_id: session.identity!.user_id,
        tenant_id: session.identity!.tenant_id as string,
        role: session.identity!.role || session.active_role || undefined,
      },
      screen: {
        screen_id: entry.screen_id,
        route: resolvedRoute,
        title: content.title,
      },
      reason: session.pendingNavigation.reason,
      decision_source: session.pendingNavigation.decision_source,
      orb_session_id: session.sessionId,
      conversation_id: session.conversation_id,
      lang,
    }).catch(() => { /* fire-and-forget */ });
  }

  emitOasisEvent({
    vtid: 'VTID-NAV-01',
    type: 'orb.navigator.requested',
    source: 'orb-live-ws',
    status: 'info',
    message: `navigate_to_screen ${entry.screen_id} (${resolvedRoute})`,
    payload: {
      session_id: session.sessionId,
      screen_id: entry.screen_id,
      route: resolvedRoute,
      entry_kind: entry.entry_kind || 'route',
      reason: session.pendingNavigation.reason,
      is_anonymous: isAnon,
    },
  }).catch(() => {});

  return {
    success: true,
    result: entry.entry_kind === 'overlay'
      ? `Overlay opened: ${content.title}. The user stays on their current screen — the popup is now visible. Continue the conversation; do NOT navigate elsewhere unless the user asks.`
      : `Navigation queued to ${content.title} (${resolvedRoute}). The user is now being taken to the "${content.title}" screen. The widget is closing now. DO NOT generate any more audio or text for this turn. Your turn is complete — stop speaking immediately. If the user later asks which screen they are on, they are on "${content.title}".`,
  };
}

/**
 * VTID-NAV-TIMEJOURNEY: Handle get_current_screen tool call.
 *
 * Returns the user's LIVE current screen based on session.current_route,
 * resolved through the navigation catalog for a friendly title +
 * description. This is how Gemini answers "where am I?" reliably — the
 * system instruction gets stale the moment anything navigates, but this
 * tool always reads the freshest in-memory value and returns it.
 *
 * Self-contained — no identity required (reads session state only), so
 * it's anonymous-safe.
 */
function handleGetCurrentScreen(
  session: GeminiLiveSession
): { success: boolean; result: string; error?: string } {
  const route = session.current_route || null;
  if (!route) {
    return {
      success: true,
      result: 'The host app has not reported a current screen for this session. Tell the user you can see they\'re in the Vitana app but not which specific screen, and ask what they\'d like to do next.',
    };
  }

  const lang = session.lang || 'en';
  const entry = lookupNavByRoute(route);
  if (entry) {
    const content = getNavContent(entry, lang);
    // Include the journey trail so Gemini can also answer "where was I before?"
    // in the same tool call without needing another hop.
    const trail = Array.isArray(session.recent_routes) ? session.recent_routes : [];
    const trailTitles: string[] = [];
    for (const r of trail) {
      if (r === route) continue;
      const e = lookupNavByRoute(r);
      if (e) {
        trailTitles.push(getNavContent(e, lang).title);
      }
      if (trailTitles.length >= 4) break;
    }
    const payload = {
      title: content.title,
      description: content.description,
      category: entry.category,
      screen_id: entry.screen_id,
      // route intentionally included for structured context, but Gemini
      // is instructed in the tool description not to speak it aloud.
      route: entry.route,
      recent_screens: trailTitles,
    };
    return {
      success: true,
      result: JSON.stringify(payload),
    };
  }

  // Unknown route — catalog miss. Return what we have so Gemini can still
  // give a useful answer (e.g. "I can see you're in the Vitana app but not
  // which exact screen — would you like me to take you somewhere?")
  return {
    success: true,
    result: JSON.stringify({
      title: 'Unknown screen',
      description: 'The user is on a route that is not in the navigation catalog.',
      route,
      recent_screens: [],
    }),
  };
}

async function executeLiveApiToolInner(
  session: GeminiLiveSession,
  toolName: string,
  args: Record<string, unknown>,
  startTime: number
): Promise<{ success: boolean; result: string; error?: string }> {

  // VTID-NAV: Navigator tools have their own handler path that may run
  // without identity for anonymous onboarding sessions. Handle them BEFORE
  // the auth gate so the existing identity check + lens construction below
  // can stay non-null for the other tools.
  if (toolName === 'get_current_screen') {
    return handleGetCurrentScreen(session);
  }
  // VTID-NAV-UNIFIED: Single tool replaces navigator_consult + navigate_to_screen.
  // The LLM just passes the user's words. The backend does all the matching,
  // KB lookup, and auto-dispatches the redirect.
  if (toolName === 'navigate') {
    return await handleNavigate(session, args);
  }
  // VTID-02770: navigate_to_screen takes a catalog screen_id (or alias) and
  // dispatches directly via the catalog-aware handler. This is the canonical
  // path — preserves parameterized routes (intent_id, match_id, etc.) and
  // overlay support that the free-text `navigate` tool does not.
  if (toolName === 'navigate_to_screen') {
    return await handleNavigateToScreen(session, args);
  }
  // Legacy: navigator_consult was the consult-then-narrate path before the
  // unified `navigate` tool. Still routed to the unified handler for any
  // in-flight session that has the old declarations cached.
  if (toolName === 'navigator_consult') {
    return await handleNavigate(session, { question: args.question || args.screen_id || args.reason || '' });
  }

  // Validate identity for tool execution (everything below requires auth)
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
      case 'recall_conversation_at_time': {
        // PR B-3: lifted to services/orb-tools-shared.ts. Both pipelines now
        // call executeRecallConversationAtTime through the shared dispatcher.
        // Pass user_timezone via args so the lifted handler can use it.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        const tz = (session as any)?.clientContext?.timezone;
        return await dispatchOrbToolForVertex(
          'recall_conversation_at_time',
          { ...(args ?? {}), user_timezone: tz },
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
          },
          supabase,
        );
      }

      case 'search_memory': {
        // PR D-3: lifted to services/orb-tools-shared.ts.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'search_memory',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
            session_id: session.sessionId,
            thread_id: session.thread_id || session.sessionId,
            turn_number: session.turn_count,
            session_started_iso: session.createdAt.toISOString(),
          },
          supabase,
        );
      }

      case 'search_knowledge': {
        const query = (args.query as string) || '';

        // Build context pack with knowledge focus
        const routerDecision = computeRetrievalRouterDecision(query, {
          channel: 'orb',
          force_sources: ['knowledge_hub'],
          limit_overrides: {
            memory_garden: 0,
            knowledge_hub: 4,
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

        // VTID-01224-FIX: Cap response size for Live API
        const MAX_TOOL_RESPONSE_CHARS = 4000;
        const topKnowledge = knowledgeHits.slice(0, 4);
        let formatted = topKnowledge
          .map((hit: any) => `**${hit.title || 'Knowledge'}**\n${(hit.snippet || hit.content || '').substring(0, 500)}`)
          .join('\n\n');

        if (formatted.length > MAX_TOOL_RESPONSE_CHARS) {
          formatted = formatted.substring(0, MAX_TOOL_RESPONSE_CHARS) + '\n... (truncated)';
        }

        console.log(`[VTID-01224] search_knowledge executed: ${topKnowledge.length} hits, ${formatted.length} chars, ${Date.now() - startTime}ms`);
        return {
          success: true,
          result: `Found ${topKnowledge.length} relevant knowledge items:\n${formatted}`,
        };
      }

      case 'search_web': {
        // PR D-3: lifted to services/orb-tools-shared.ts.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'search_web',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
            session_id: session.sessionId,
            thread_id: session.thread_id || session.sessionId,
            turn_number: session.turn_count,
            session_started_iso: session.createdAt.toISOString(),
          },
          supabase,
        );
      }

      // =====================================================================
      // VTID-02047: Unified Feedback Pipeline — voice claim/bug/support intake
      // =====================================================================

      case 'switch_persona': {
        const target = String(args.to || '').toLowerCase();
        // VTID-02651 + VTID-02653: validate against the persona registry.
        // When the session has a tenant context, use the tenant-aware
        // variant — that excludes personas the tenant has disabled, so
        // the LLM cannot accidentally swap the user to a colleague who's
        // turned off for their tenant.
        const _swapTenantId = session.identity?.tenant_id;
        const targetIsValid = _swapTenantId
          ? await registryIsValidPersonaForTenant(target, _swapTenantId)
          : await registryIsValidPersona(target);
        if (!targetIsValid) {
          const valid = _swapTenantId
            ? await registryListAllPersonaKeysForTenant(_swapTenantId)
            : await registryListAllPersonaKeys();
          return { success: false, result: '', error: `Invalid persona: ${target} (active personas: ${valid.join(', ')})` };
        }
        const currentPersona = ((session as any).activePersona as string) || 'vitana';
        if (target === currentPersona) {
          return { success: true, result: `Already talking to ${target} — no swap needed.` };
        }

        // Hot-potato guard: only Vitana decides routing. A specialist (Devon/
        // Sage/Atlas/Mira) can ONLY hand back to Vitana — never sideways to
        // a peer. If the user wants a different specialist, Vitana will
        // route them. This prevents the forward-to-Devon-then-Atlas-then-
        // Devon-again loop where each specialist passes the buck without
        // anyone actually answering the user's question.
        if (currentPersona !== 'vitana' && target !== 'vitana') {
          return {
            success: false,
            result: '',
            error: `Specialists cannot forward to other specialists. Only Vitana decides routing. If this is outside your domain, call switch_persona(to:'vitana') and let her route the user. The user will not be passed around — answer if you can, or hand back to Vitana.`,
          };
        }

        // Loop guard: cap at 1 forward + 1 return per conversation. After
        // that, the user has used their forward budget — no more swaps to
        // specialists. Swap-back to Vitana is always allowed (so specialists
        // can return on auto-return), but a fresh forward AWAY from Vitana
        // is blocked. The model reads the error and continues inline.
        const swapCountForSwitch = ((session as any).swapCount as number | undefined) ?? 0;
        if (swapCountForSwitch >= 2 && target !== 'vitana') {
          console.log(`[VTID-02670] switch_persona blocked — forward cap reached (swapCount=${swapCountForSwitch}, target=${target})`);
          return {
            success: false,
            result: '',
            error: `Forward cap reached for this conversation (already had 1 forward + 1 return). The user stays with Vitana for the rest of this session. Answer them yourself; do NOT mention this routing decision out loud.`,
          };
        }

        try {
          if (target === 'vitana') {
            // Hand back to Vitana — clear all persona overrides so the
            // setup-message builder falls back to Vitana's default voice
            // (per language) and the standard buildLiveSystemInstruction
            // path. Forced first message in the user's language so Vitana
            // greets after the reconnect instead of waiting silently.
            //
            // Forwarding-rules feature: refresh the cached specialist context
            // section so Vitana's next setup message picks up any ticket that
            // was filed during the specialist call. buildLiveSystemInstruction
            // call site reads (session as any).specialistContextSection.
            (session as any).pendingPersonaSwap = 'vitana';
            (session as any).activePersonaTarget = 'vitana';
            (session as any).personaSystemOverride = null;
            (session as any).personaVoiceOverride = null;
            // Reset the FORCED FIRST UTTERANCE flag so the next persona's
            // greeting (if any) fires once on the actual first turn after
            // this swap. Vitana's swap-back uses an empty greeting so this
            // flag is effectively dormant for swap-back.
            (session as any).personaFirstUtteranceDelivered = false;
            (session as any).specialistContextSection = await fetchSpecialistContextSection(session.identity?.user_id);
            (session as any).lastTranscriptSection = buildTranscriptSection(session.transcriptTurns, currentPersona, 'vitana');
            // Loop fix: NO greeting on swap-back. The hardcoded "Welcome back.
            // What's on your mind?" was the loop trigger — the user re-stated
            // their question, Vitana forwarded it again. Vitana now stays
            // silent and waits for the user to speak. Empty string suppresses
            // the FORCED FIRST UTTERANCE block in the setup-message builder.
            (session as any).personaForcedFirstMessage = '';
            // Loop guard: count this swap and start cooldown.
            (session as any).swapCount = (((session as any).swapCount as number | undefined) ?? 0) + 1;
            (session as any).swapCooldownUntil = Date.now() + 90_000;
            console.log(`[VTID-02670] switch_persona: ${currentPersona} → vitana queued (silent; swapCount=${(session as any).swapCount}, cooldown=90s)`);
          } else {
            // Swap to a specialist — load their prompt + voice from
            // agent_personas. No ticket created; just navigation.
            const url2 = process.env.SUPABASE_URL!;
            const key2 = process.env.SUPABASE_SERVICE_ROLE!;
            const personaResp = await fetch(
              `${url2}/rest/v1/agent_personas?key=eq.${target}&select=system_prompt,display_name`,
              { headers: { apikey: key2, Authorization: `Bearer ${key2}` } }
            );
            const personaJson = await personaResp.json().catch(() => null);
            const personaRow = Array.isArray(personaJson) ? personaJson[0] : null;
            const personaPrompt = (personaRow?.system_prompt as string | undefined) ?? '';
            if (!personaPrompt) {
              return { success: false, result: '', error: `No system_prompt found for ${target}` };
            }
            (session as any).pendingPersonaSwap = target;
            // Reset FORCED FIRST UTTERANCE consumption flag for the new persona
            (session as any).personaFirstUtteranceDelivered = false;
            const userContextSection = await fetchSpecialistContextSection(session.identity?.user_id);
            const behavioralRule = buildPersonaBehavioralRule(target);
            const transcriptSection = buildTranscriptSection(session.transcriptTurns, currentPersona, target);
            const languageDirective = buildSpecialistLanguageDirective(session.lang);
            (session as any).specialistContextSection = userContextSection;
            (session as any).lastTranscriptSection = transcriptSection;
            (session as any).personaSystemOverride = personaPrompt +
              `\n\n${languageDirective}` +
              (userContextSection ? `\n\n${userContextSection}` : '') +
              (transcriptSection ? `\n\n${transcriptSection}` : '') +
              `\n\n${behavioralRule}` +
              `\n\n[NAVIGATION TOOL] You have a switch_persona tool. You can ONLY pass to='${RECEPTIONIST_PERSONA_KEY}' — you cannot forward sideways to another specialist. If the question is outside your authority, return the user to Vitana with a brief bridge in your own words (vary phrasing) and STOP — do NOT speak after calling the tool.`;
            // VTID-02653 Phase 6: tenant-aware voice + greeting lookup.
            (session as any).personaVoiceOverride = _swapTenantId
              ? await registryGetPersonaVoiceForTenant(target, _swapTenantId)
              : await registryGetPersonaVoice(target);
            // v3: NO forced greeting on specialist swap. Devon's first turn
            // is generated by the model from the GREET + ASK FOR DETAILS rule
            // in buildPersonaBehavioralRule. The previous stored greeting
            // collided with the synthesize directive and produced double-speech.
            (session as any).personaForcedFirstMessage = '';
            // Track which specialist is now active so the eventual swap-back
            // can render the correct ROLE label in Vitana's welcome block.
            (session as any)._lastSpecialistPersona = target;
            // Loop guard counter
            (session as any).swapCount = (((session as any).swapCount as number | undefined) ?? 0) + 1;
            console.log(`[VTID-02684] switch_persona: ${currentPersona} → ${target} queued, voice=${(session as any).personaVoiceOverride}, swapCount=${(session as any).swapCount}`);
          }

          // Notify the client UI
          const swapMsg = {
            type: 'persona_swap',
            from: currentPersona,
            to: target,
            voice_id: (session as any).personaVoiceOverride || (LIVE_API_VOICES[session.lang || 'en'] || 'Aoede'),
            display_name: target.charAt(0).toUpperCase() + target.slice(1),
            navigation_only: true,
          };
          if (session.sseResponse) {
            try { session.sseResponse.write(`data: ${JSON.stringify(swapMsg)}\n\n`); } catch (_e) { /* SSE closed */ }
          }
          if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
            try { sendWsMessage(session.clientWs, swapMsg); } catch (_e) { /* WS closed */ }
          }

          // v3: bridge instruction depends on direction.
          // - Vitana → specialist: announce the ROLE only (never the name).
          // - Specialist → Vitana: speak a polite goodbye (with display_name
          //   when known) BEFORE the swap fires. Then the swap takes over.
          const isFromVitana = currentPersona === 'vitana' || currentPersona === RECEPTIONIST_PERSONA_KEY;
          const isToVitana = target === 'vitana' || target === RECEPTIONIST_PERSONA_KEY;
          let result: string;
          if (isFromVitana && !isToVitana) {
            // Vitana announcing handoff to a specialist via switch_persona.
            // She must use the ROLE label, not the name.
            const role = roleLabel(target, session.lang);
            result = `Persona swap queued: ${currentPersona} → ${target}. Speak ONE short bridge sentence in the user's language announcing the ROLE — "${role}". NEVER speak the persona's internal name (Devon, Sage, Atlas, Mira) — the user has no context for those names. Examples (vary every call, never recite verbatim): "I'll connect you with ${role}." / "Let me bring ${role} in." / "Einen Moment, ${role} übernimmt." Vary phrasing every call. Do NOT introduce the colleague ("Hi, here is X" — that is THEIR job in their own voice). Do NOT speak after the bridge. Then STOP.`;
          } else if (!isFromVitana && isToVitana) {
            // Specialist closing out — speak the polite goodbye, THEN the
            // swap fires. The goodbye comes from the [CLOSE QUESTION + GOODBYE]
            // rule in your prompt: thank user (use display_name from USER
            // CONTEXT when known), wish them well, vary phrasing every call.
            result = `Persona swap queued: ${currentPersona} → ${target}. Speak ONE short polite GOODBYE turn in the user's language BEFORE the swap takes effect — thank the user for their time (use their display_name from USER CONTEXT if known; omit if not), wish them well ("have a great day" / "schönen Tag noch" / "take care"). Vary your wording every call — NEVER recite a template, NEVER repeat a goodbye you used earlier this session. The follow-up promise was already given in your close-question turn so don't repeat it here. After speaking the goodbye, the swap fires automatically. Do NOT speak after the goodbye.`;
          } else {
            // Edge: specialist-to-specialist (server-blocked elsewhere) or
            // vitana-to-vitana (already-talking guard above). Fallback: minimal.
            result = `Persona swap queued: ${currentPersona} → ${target}. Speak ONE short bridge sentence in the user's language. Vary phrasing every call. Then STOP.`;
          }
          return { success: true, result };
        } catch (err) {
          console.error('[VTID-02047] switch_persona failed:', err);
          return { success: false, result: '', error: err instanceof Error ? err.message : 'unknown error' };
        }
      }

      case 'report_to_specialist': {
        const kind = String(args.kind || 'feedback');
        const summary = String(args.summary || '').trim();
        const specialistHint = String(args.specialist_hint || '').trim();
        if (!summary) {
          return { success: false, result: '', error: 'summary is required' };
        }

        // v3b: ONLY Vitana files tickets. If a specialist calls this tool
        // (which they can — it's in the shared tool registry), the gateway
        // treats the call as a swap and resets personaFirstUtteranceDelivered
        // → on next setup-message rebuild the model gets the FIRST TURN block
        // again and re-greets ("Hi I'm Devon..."). User-reported regression:
        // even after v3a, Devon greeted again because Devon himself called
        // report_to_specialist mid-conversation to "file" the bug he'd just
        // heard, and the swap logic reset his first-turn flag.
        //
        // Block: if the active persona is NOT Vitana, refuse this tool. The
        // specialist's job is intake into the EXISTING ticket Vitana already
        // filed — not file a fresh one.
        const _activePersonaForReport = ((session as any).activePersona as string | undefined) || 'vitana';
        if (_activePersonaForReport !== 'vitana' && _activePersonaForReport !== '') {
          console.log(`[VTID-02684] report_to_specialist refused — caller is specialist '${_activePersonaForReport}', only vitana files tickets`);
          return {
            success: true,
            result: `STAY_IN_INTAKE: You (${_activePersonaForReport}) are NOT allowed to file new tickets — only Vitana files. The user is already talking to YOU because Vitana has ALREADY filed the ticket for this issue. Your job is to continue the intake — gather details, write them into the existing ticket via your intake tools, then close with the standard close-question + goodbye flow. Do NOT call report_to_specialist again. Do NOT swap personas. Just respond to the user in your own language and continue the conversation from where it was.`,
          };
        }

        // v2e: server-side block on vague summaries. The LLM tool description
        // forbids placeholder summaries like "user wants to report a bug",
        // but we enforce server-side too. A vague summary causes the receiving
        // specialist to invent the issue (the user's most-recent complaint:
        // Devon hallucinated a "language switch" bug because Vitana's summary
        // was just "user wants to report a technical bug").
        //
        // Heuristics: too short OR matches a placeholder pattern.
        const wordCount = summary.split(/\s+/).filter(Boolean).length;
        const VAGUE_PATTERNS = [
          /^user (wants|would like|wishes) to report (a|an|the)?\s*(technical |bug|issue|problem|claim|complaint|account|support)?\s*(report|issue|problem|claim|bug|complaint|question|something)\.?$/i,
          /^user has (a|an|the)?\s*(bug|issue|problem|claim|complaint|account|support|technical)\s*(report|issue|problem|claim|bug|complaint|question|matter)\.?$/i,
          /^report a (bug|issue|problem|claim|complaint|technical)\s*\.?$/i,
          /^bug report\.?$/i,
          /^something is broken\.?$/i,
          /^(user|customer)\s+(needs help|wants help|has a question)\.?$/i,
        ];
        const isVague = wordCount < 12 || VAGUE_PATTERNS.some(re => re.test(summary));
        if (isVague) {
          console.log(`[VTID-02670] report_to_specialist blocked — vague summary ("${summary}", ${wordCount} words). Asking model to collect specifics.`);
          return {
            success: true,
            result: `ASK_FOR_SPECIFICS: Your summary "${summary}" is too vague. Do NOT call this tool again until you have a concrete description. Speak ONE follow-up question to the user IN THEIR LANGUAGE asking what specifically broke (which screen / feature / error message / what they were doing). Vary your phrasing every call. Then wait for their answer. Only after you have specifics, call this tool again with a real description (>= 12 words, in the user's own words). Do NOT mention this internal routing — just ask the question naturally.`,
          };
        }

        // Loop guard: hard cap of 1 forward per conversation. Once swap count
        // hits 2 (one forward + one return), block re-forward regardless of
        // what the LLM decides. Also a cooldown period after swap-back-to-
        // Vitana — prevents the immediate re-forward loop the user reported.
        const swapCountForReport = ((session as any).swapCount as number | undefined) ?? 0;
        const swapCooldownUntil = ((session as any).swapCooldownUntil as number | undefined) ?? 0;
        if (swapCountForReport >= 2) {
          console.log(`[VTID-02670] report_to_specialist blocked — loop guard cap reached (swapCount=${swapCountForReport})`);
          return {
            success: true,
            result: `STAY_INLINE: This conversation already used its forward budget. Answer the user yourself as Vitana — do NOT mention the routing decision out loud, just continue helping inline.`,
          };
        }
        if (Date.now() < swapCooldownUntil) {
          const secondsLeft = Math.ceil((swapCooldownUntil - Date.now()) / 1000);
          console.log(`[VTID-02670] report_to_specialist blocked — cooldown active (${secondsLeft}s left)`);
          return {
            success: true,
            result: `STAY_INLINE: User just came back from a specialist (cooldown ${secondsLeft}s). Answer the question yourself as Vitana — do NOT mention the routing decision, just respond inline.`,
          };
        }

        try {
          const url = process.env.SUPABASE_URL!;
          const key = process.env.SUPABASE_SERVICE_ROLE!;

          // Resolve specialist via keyword router unless hinted explicitly.
          // VTID-02653 Phase 6: when the session has a tenant context, use
          // the tenant-aware RPC pick_specialist_for_text_tenant which
          // UNIONs platform handoff_keywords with the tenant's own routing
          // keywords (and respects tenant disable). Falls back to the
          // platform-only RPC when no tenant context (anonymous sessions).
          let pickedPersona = specialistHint;
          let matchedKeyword: string | null = null;
          let confidence: number | null = null;
          let rpcDecision: string | null = null;
          let rpcGate: string | null = null;
          const _reportTenantId = session.identity?.tenant_id;
          if (!pickedPersona) {
            try {
              const rpcName = _reportTenantId
                ? 'pick_specialist_for_text_tenant'
                : 'pick_specialist_for_text';
              // Gate A reads the user's RAW transcript, not the LLM-rewritten
              // summary. The LLM compresses "how does X work?" into business-
              // language like "user is asking about X feature", which bypasses
              // stay-inline phrases. Raw user words preserve "how does", etc.
              const gateInput = buildGateInputFromTranscript(session.transcriptTurns, summary);
              const rpcBody = _reportTenantId
                ? { p_text: gateInput, p_tenant_id: _reportTenantId }
                : { p_text: gateInput };
              const rpcResp = await fetch(`${url}/rest/v1/rpc/${rpcName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
                body: JSON.stringify(rpcBody),
              });
              const rpcJson = await rpcResp.json().catch(() => null);
              const row = Array.isArray(rpcJson) ? rpcJson[0] : rpcJson;
              rpcDecision = row?.decision ?? null;
              rpcGate = row?.gate ?? null;
              if (row?.persona_key) {
                pickedPersona = row.persona_key;
                // Two-gate RPC returns matched_phrase; legacy/tenant variant returns matched_keyword.
                matchedKeyword = row.matched_phrase ?? row.matched_keyword ?? null;
                confidence = row.confidence ?? null;
              }
            } catch { /* keep empty hint, fall through */ }
          }

          // Two-gate routing: if Gate A said stay-inline, OR Gate A failed
          // (no explicit forward-request signal), Vitana keeps the user.
          // No ticket. No swap. The model already received the user's words —
          // it just needs to answer them.
          if (rpcDecision === 'answer_inline') {
            const gateLabel = rpcGate === 'stay_inline'
              ? 'stay-inline override'
              : (rpcGate === 'unrouted' ? 'no enabled specialist' : 'no explicit forward request');
            console.log(`[VTID-02660] report_to_specialist suppressed (gate=${rpcGate}) — answering inline`);
            return {
              success: true,
              result: `Stay with the user — this is not a customer-support handoff (${gateLabel}). Answer the question yourself as Vitana, the user's life companion. Do NOT mention this routing decision out loud.`,
            };
          }
          // VTID-02651: kind→persona mapping is data-driven from
          // agent_personas.handles_kinds. VTID-02653: tenant variant skips
          // personas the tenant has disabled. Falls back to '' (caller
          // skips swap) if no active persona claims the kind.
          if (!pickedPersona) {
            pickedPersona = _reportTenantId
              ? ((await registryPickPersonaForKindForTenant(kind, _reportTenantId)) ?? '')
              : ((await registryPickPersonaForKind(kind)) ?? '');
          }

          const insertResp = await fetch(`${url}/rest/v1/feedback_tickets`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: key,
              Authorization: `Bearer ${key}`,
              Prefer: 'return=representation',
            },
            body: JSON.stringify({
              user_id: session.identity.user_id,
              vitana_id: session.identity.vitana_id ?? null,
              kind,
              status: pickedPersona ? 'triaged' : 'new',
              raw_transcript: summary,
              intake_messages: [
                { agent: 'vitana', role: 'user', content: summary, ts: new Date().toISOString() },
              ],
              structured_fields: {
                specialist_hint: specialistHint || null,
                voice_origin: true,
              },
              screen_path: '/orb/voice',
              resolver_agent: pickedPersona || null,
              triaged_at: pickedPersona ? new Date().toISOString() : null,
            }),
          });
          if (!insertResp.ok) {
            const errText = await insertResp.text().catch(() => '');
            console.error(`[VTID-02047] feedback_tickets insert failed:`, insertResp.status, errText);
            return { success: false, result: '', error: `insert failed: ${insertResp.status}` };
          }
          const created = await insertResp.json().catch(() => null);
          const ticket = Array.isArray(created) ? created[0] : created;

          // Log handoff event for Live Handoffs panel
          if (pickedPersona) {
            await fetch(`${url}/rest/v1/feedback_handoff_events`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
              body: JSON.stringify({
                conversation_id: session.sessionId,
                ticket_id: ticket?.id,
                user_id: session.identity.user_id,
                vitana_id: session.identity.vitana_id ?? null,
                from_agent: 'vitana',
                to_agent: pickedPersona,
                reason: 'off_domain_intent',
                detected_intent: kind,
                matched_keyword: matchedKeyword,
                confidence: confidence,
              }),
            }).catch(() => undefined);
          }

          // Emit OASIS event so it shows in the inbox + KPIs
          try {
            const { emitOasisEvent } = await import('../services/oasis-event-service');
            await emitOasisEvent({
              vtid: 'VTID-02047',
              type: 'feedback.ticket.created' as any,
              source: 'orb-voice-tool',
              status: 'info',
              message: `Voice tool report_to_specialist created ticket ${ticket?.ticket_number} (${kind}) → ${pickedPersona || 'unrouted'}`,
              payload: {
                ticket_id: ticket?.id,
                ticket_number: ticket?.ticket_number,
                kind,
                specialist: pickedPersona,
                voice_origin: true,
              },
              actor_id: session.identity.user_id,
              actor_role: 'user',
              surface: 'orb',
              vitana_id: session.identity.vitana_id ?? undefined,
            });
          } catch { /* non-blocking */ }

          const personaLabel: Record<string, string> = {
            devon: 'Devon (tech support)',
            sage: 'Sage (customer support)',
            atlas: 'Atlas (finance / marketplace)',
            mira: 'Mira (account)',
          };
          const personaName = personaLabel[pickedPersona] || 'a specialist colleague';

          // VTID-02047 voice channel-swap: queue a swap to the specialist's
          // voice + system prompt. The actual reconnect fires AFTER the
          // current Vitana turn completes (so the user hears Vitana's bridge
          // sentence in HER voice first, then the channel swaps and the
          // specialist greets in THEIR voice). Done by setting
          // session.pendingPersonaSwap; the turn_complete handler picks this
          // up and triggers attemptTransparentReconnect with overrides.
          // VTID-02651: any active non-receptionist persona is a valid
          // swap target. Validates against the registry so newly-added
          // specialists work immediately.
          if (pickedPersona && pickedPersona !== RECEPTIONIST_PERSONA_KEY && (await registryIsValidPersona(pickedPersona))) {
            const swapTo = pickedPersona;
            try {
              const url2 = process.env.SUPABASE_URL!;
              const key2 = process.env.SUPABASE_SERVICE_ROLE!;
              const personaResp = await fetch(
                `${url2}/rest/v1/agent_personas?key=eq.${swapTo}&select=system_prompt,display_name`,
                { headers: { apikey: key2, Authorization: `Bearer ${key2}` } }
              );
              const personaJson = await personaResp.json().catch(() => null);
              const personaRow = Array.isArray(personaJson) ? personaJson[0] : null;
              const personaPrompt = (personaRow?.system_prompt as string | undefined) ?? '';
              if (personaPrompt) {
                (session as any).pendingPersonaSwap = swapTo;
                // Reset FORCED FIRST UTTERANCE consumption flag for new persona
                (session as any).personaFirstUtteranceDelivered = false;
                const userContextSection = await fetchSpecialistContextSection(session.identity?.user_id);
                const behavioralRule = buildPersonaBehavioralRule(swapTo);
                const transcriptSection = buildTranscriptSection(session.transcriptTurns, 'vitana', swapTo);
                const languageDirective = buildSpecialistLanguageDirective(session.lang);
                // Cache for Vitana's prompt builder on the eventual swap-back.
                (session as any).specialistContextSection = userContextSection;
                (session as any).lastTranscriptSection = transcriptSection;
                // Loop guard counter
                (session as any).swapCount = (((session as any).swapCount as number | undefined) ?? 0) + 1;
                (session as any).personaSystemOverride = personaPrompt +
                  `\n\n${languageDirective}` +
                  (userContextSection ? `\n\n${userContextSection}` : '') +
                  (transcriptSection ? `\n\n${transcriptSection}` : '') +
                  `\n\n${behavioralRule}` +
                  `\n\n[HANDOFF NOTE] Vitana captured this brief at handoff: "${summary}". The transcript above is the user's actual words. Synthesize what they reported in ONE sentence (your own words, not theirs) and confirm. Do NOT echo their wording back.` +
                  `\n\n[NAVIGATION TOOL] You have a switch_persona tool. You can ONLY pass to='${RECEPTIONIST_PERSONA_KEY}' — you cannot forward sideways to another specialist. If the question is outside your authority, return the user to Vitana with a brief bridge in your own words (vary your phrasing) and STOP — do NOT speak after calling the tool.`;
                // VTID-02653 Phase 6: tenant-aware voice + greeting.
                (session as any).personaVoiceOverride = _reportTenantId
                  ? await registryGetPersonaVoiceForTenant(swapTo, _reportTenantId)
                  : await registryGetPersonaVoice(swapTo);
                // v3: NO forced greeting. Devon's first turn is generated by
                // the model from the GREET + ASK FOR DETAILS rule.
                (session as any).personaForcedFirstMessage = '';
                (session as any)._lastSpecialistPersona = swapTo;
                console.log(`[VTID-02684] Persona swap queued: ${RECEPTIONIST_PERSONA_KEY} → ${swapTo}, voice=${(session as any).personaVoiceOverride}, tenant=${_reportTenantId ?? 'none'}`);

                // Notify the client UI so it can show "Talking to <Persona>"
                const swapMsg = {
                  type: 'persona_swap',
                  from: 'vitana',
                  to: swapTo,
                  voice_id: (session as any).personaVoiceOverride,
                  display_name: personaRow?.display_name ?? swapTo,
                  ticket_number: ticket?.ticket_number ?? null,
                };
                if (session.sseResponse) {
                  try { session.sseResponse.write(`data: ${JSON.stringify(swapMsg)}\n\n`); } catch (_e) { /* SSE closed */ }
                }
                if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
                  try { sendWsMessage(session.clientWs, swapMsg); } catch (_e) { /* WS closed */ }
                }
              } else {
                console.warn(`[VTID-02047] No system_prompt found for persona ${swapTo} — skipping voice swap`);
              }
            } catch (e) {
              console.warn(`[VTID-02047] Failed to load persona for swap:`, e);
            }
          }

          return {
            success: true,
            result: `Ticket ${ticket?.ticket_number ?? '(pending)'} created. Speak ONE short bridge sentence in the user's language announcing the ROLE — "${roleLabel(pickedPersona, session.lang)}". NEVER speak the persona's internal name (Devon, Sage, Atlas, Mira) out loud — the user has no context for those names. Examples (vary every call, never recite verbatim): "I'll connect you with ${roleLabel(pickedPersona, session.lang)}." / "Let me bring ${roleLabel(pickedPersona, session.lang)} in." / "Einen Moment, ${roleLabel(pickedPersona, session.lang)} übernimmt." Vary your phrasing every call. Do NOT introduce the colleague ("Hi, here is X" — that is THEIR job to say in their own voice). Do NOT speak after the bridge. Then STOP.`,
          };
        } catch (err) {
          console.error('[VTID-02047] report_to_specialist failed:', err);
          return { success: false, result: '', error: err instanceof Error ? err.message : 'unknown error' };
        }
      }

      // =====================================================================
      // Calendar tool — user's personal calendar
      // =====================================================================

      case 'search_calendar': {
        const query = (args.query as string) || '';
        const role = session.active_role || 'community';
        const userId = session.identity.user_id;
        const userTz = session.clientContext?.timezone || 'UTC';

        try {
          const { getUserTodayEvents, getUserUpcomingEvents, getCalendarGaps } = await import('../services/calendar-service');
          const [todayEvents, upcomingEvents, gaps] = await Promise.all([
            getUserTodayEvents(userId, role),
            getUserUpcomingEvents(userId, role, 10),
            getCalendarGaps(userId, role, new Date()),
          ]);

          const MAX_TOOL_RESPONSE_CHARS = 4000;
          let formatted = '';

          if (todayEvents.length > 0) {
            formatted += `Today's schedule (times in ${userTz}):\n`;
            for (const ev of todayEvents) {
              const time = new Date(ev.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
              formatted += `- ${time}: ${ev.title} (${ev.event_type})\n`;
            }
            formatted += '\n';
          } else {
            formatted += 'Today\'s schedule: No events scheduled.\n\n';
          }

          if (upcomingEvents.length > 0) {
            formatted += `Upcoming (next 7 days, times in ${userTz}):\n`;
            for (const ev of upcomingEvents.slice(0, 5)) {
              const date = new Date(ev.start_time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: userTz });
              const time = new Date(ev.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
              formatted += `- ${date} ${time}: ${ev.title} (${ev.event_type})\n`;
            }
            formatted += '\n';
          }

          if (gaps.length > 0) {
            formatted += `Free time today (in ${userTz}):\n`;
            for (const gap of gaps.slice(0, 3)) {
              const start = new Date(gap.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
              const end = new Date(gap.end).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
              formatted += `- ${start}\u2013${end} (${gap.duration_minutes} min free)\n`;
            }
          }

          if (!formatted.trim()) {
            formatted = 'Your calendar is currently empty. No events are scheduled.';
          }

          if (formatted.length > MAX_TOOL_RESPONSE_CHARS) {
            formatted = formatted.substring(0, MAX_TOOL_RESPONSE_CHARS) + '\n... (truncated)';
          }

          console.log(`[Calendar] search_calendar executed: ${todayEvents.length} today, ${upcomingEvents.length} upcoming, ${gaps.length} gaps, ${Date.now() - startTime}ms`);
          return {
            success: true,
            result: formatted,
          };
        } catch (calErr: any) {
          console.warn(`[Calendar] search_calendar failed: ${calErr.message}`);
          return {
            success: false,
            result: 'Calendar is temporarily unavailable. Please try again in a moment.',
            error: calErr.message,
          };
        }
      }

      // =====================================================================
      // Calendar write tool — create events via voice
      // =====================================================================

      case 'create_calendar_event': {
        const title = (args.title as string) || '';
        const eventStart = (args.start_time as string) || '';
        const eventEnd = (args.end_time as string) || '';
        const description = (args.description as string) || '';
        const location = (args.location as string) || '';
        const eventType = (args.event_type as string) || 'personal';
        const role = session.active_role || 'community';
        const userId = session.identity.user_id;

        if (!title || !eventStart) {
          return {
            success: false,
            result: 'I need at least a title and start time to create a calendar event.',
            error: 'Missing required fields: title and start_time',
          };
        }

        try {
          const { createCalendarEvent, checkConflicts } = await import('../services/calendar-service');

          // Check for conflicts first
          const effectiveEndTime = eventEnd || new Date(new Date(eventStart).getTime() + 60 * 60 * 1000).toISOString();
          const conflicts = await checkConflicts(userId, role, eventStart, effectiveEndTime);

          const event = await createCalendarEvent(userId, {
            title,
            start_time: eventStart,
            end_time: effectiveEndTime,
            description: description || undefined,
            location: location || undefined,
            event_type: eventType as any,
            status: 'confirmed',
            priority: 'medium',
            role_context: role === 'developer' ? 'developer' : role === 'admin' ? 'admin' : 'community',
            source_type: 'assistant',
            priority_score: 50,
            wellness_tags: [],
            metadata: { created_via: 'orb_voice' },
            is_recurring: false,
          });

          if (!event) {
            return {
              success: false,
              result: 'I wasn\'t able to save the event to your calendar. Please try again.',
              error: 'createCalendarEvent returned null',
            };
          }

          // Emit OASIS event
          emitOasisEvent({
            vtid: 'VTID-01155',
            type: 'calendar.event.created' as any,
            source: 'orb-live-voice',
            status: 'info',
            message: `Voice-created calendar event: ${event.title}`,
            payload: {
              event_id: event.id,
              user_id: userId,
              event_type: event.event_type,
              session_id: session.sessionId,
            },
          }).catch(() => {});

          const userTz = session.clientContext?.timezone || 'UTC';
          const startFormatted = new Date(eventStart).toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true,
            timeZone: userTz,
          });
          const endFormatted = new Date(effectiveEndTime).toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', hour12: true,
            timeZone: userTz,
          });

          let result = `Event created successfully!\n- Title: ${event.title}\n- When: ${startFormatted} – ${endFormatted}`;
          if (event.location) result += `\n- Where: ${event.location}`;
          if (conflicts.length > 0) {
            result += `\n\nNote: There ${conflicts.length === 1 ? 'is 1 existing event' : `are ${conflicts.length} existing events`} during this time slot.`;
          }

          console.log(`[Calendar] create_calendar_event executed: "${event.title}" at ${eventStart}, ${Date.now() - startTime}ms`);
          return { success: true, result };
        } catch (calErr: any) {
          console.warn(`[Calendar] create_calendar_event failed: ${calErr.message}`);
          return {
            success: false,
            result: 'I had trouble creating the event. Please try again in a moment.',
            error: calErr.message,
          };
        }
      }

      // =====================================================================
      // VTID-01270A: Community & Events voice tools
      // =====================================================================

      case 'search_events': {
        // PR B-10: lifted to services/orb-tools-shared.ts. Both pipelines now
        // run scoreAndRankEvents through the shared dispatcher — same scoring,
        // same home-city proximity boost, same parallel live_rooms fetch.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'search_events',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );
      }

      case 'search_community': {
        // PR B-8: lifted to services/orb-tools-shared.ts.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: true, result: 'Community search is temporarily unavailable.' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'search_community',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );
      }

      // VTID-02754 — Find ONE community member by free-text query and redirect
      // to their profile. Reads the gateway's own /api/v1/community/find-member
      // endpoint (which runs the 4-tier ranker, persists to
      // community_search_history, and returns voice_summary + match_recipe).
      // The handler itself queues the navigation directive so the widget
      // redirects to /u/<vitana_id>?from=who_search&search_id=<id> on
      // turn_complete.
      case 'find_community_member': {
        const query = String(args.query || '').trim();
        if (!query) {
          return { success: false, result: '', error: 'query is required' };
        }
        if (!session.identity?.user_id || !session.identity?.tenant_id) {
          return {
            success: false,
            result: '',
            error: 'Please sign in to search the community.',
          };
        }
        const excluded = Array.isArray(args.excluded_vitana_ids)
          ? (args.excluded_vitana_ids as unknown[]).filter((s) => typeof s === 'string')
          : [];

        try {
          const baseUrl = process.env.GATEWAY_INTERNAL_URL || 'http://localhost:8080';
          const url = `${baseUrl}/api/v1/community/find-member`;
          const jwt = (session as any).access_token || (session as any).jwt;
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
            },
            body: JSON.stringify({ query, excluded_vitana_ids: excluded }),
          });
          const data: any = await res.json().catch(() => ({}));
          if (!res.ok || !data?.ok) {
            console.warn(`[VTID-02754] find_community_member upstream failed: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
            return {
              success: false,
              result: '',
              error: data?.error || `find_member_failed_${res.status}`,
            };
          }

          // Queue navigation. Mirrors the navigate_to_screen flow at line ~4073.
          session.pendingNavigation = {
            screen_id: 'profile_with_match',
            route: data.redirect.route,
            title: `Profile: ${data.display_name}`,
            reason: 'find_community_member tool call',
            decision_source: 'direct',
            requested_at: Date.now(),
          };
          session.navigationDispatched = true;

          // Update in-memory session route so subsequent get_current_screen
          // calls reflect the navigation. Mirrors navigate_to_screen line 4091-4097.
          const previousRoute = session.current_route;
          session.current_route = data.redirect.route;
          if (previousRoute && previousRoute !== data.redirect.route) {
            const trail = Array.isArray(session.recent_routes) ? [...session.recent_routes] : [];
            const deduped = trail.filter(r => r !== previousRoute);
            session.recent_routes = [previousRoute, ...deduped].slice(0, 5);
          }

          emitOasisEvent({
            vtid: 'VTID-02754',
            type: 'community.find_member.matched',
            source: 'orb-live',
            status: 'info',
            message: `find_community_member matched "${query}" → ${data.vitana_id}`,
            payload: {
              session_id: session.sessionId,
              query,
              tier: data.match_recipe?.tier,
              lane: data.match_recipe?.lane,
              winner_vitana_id: data.vitana_id,
              ethics_reroute: !!data.match_recipe?.ethics_reroute,
              search_id: data.search_id,
            },
            actor_id: session.identity.user_id,
            actor_role: 'user',
            surface: 'orb',
            vitana_id: session.identity?.vitana_id ?? undefined,
          }).catch(() => {});

          // Return ONLY the voice_summary so Gemini reads it aloud and stops.
          // The widget is closing — no follow-up commentary required.
          return {
            success: true,
            result: `${data.voice_summary} The user is now being taken to ${data.display_name}'s profile. The widget is closing — stop speaking immediately after this line.`,
          };
        } catch (err: any) {
          console.error('[VTID-02754] find_community_member error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      case 'get_recommendations': {
        const recType = (args.type as string) || 'all';
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE;

        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
          return { success: true, result: 'Recommendations are temporarily unavailable.' };
        }

        const headers = {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        };

        const tenantId = lens.tenant_id;
        const userId = lens.user_id;
        const today = new Date().toISOString().split('T')[0];
        const results: string[] = [];

        // VTID-STALL-FIX: Run both queries in parallel to stay within 3s TOOL_TIMEOUT_MS
        const recPromises: Promise<void>[] = [];

        // Fetch community recommendations (groups + meetups)
        if (recType === 'community' || recType === 'all') {
          recPromises.push((async () => {
            const recsUrl = `${SUPABASE_URL}/rest/v1/community_recommendations?select=id,rec_type,target_id,score,reasons&tenant_id=eq.${tenantId}&user_id=eq.${userId}&rec_date=eq.${today}&order=score.desc&limit=5`;
            try {
              const resp = await fetch(recsUrl, { method: 'GET', headers });
              if (resp.ok) {
                const recs = await resp.json() as Array<{
                  id: string; rec_type: string; target_id: string;
                  score: number; reasons: Record<string, unknown>;
                }>;
                for (const r of recs) {
                  const reasonText = r.reasons && typeof r.reasons === 'object'
                    ? Object.values(r.reasons).filter(v => typeof v === 'string').join(', ')
                    : '';
                  results.push(`[${r.rec_type}] Score: ${r.score}/100${reasonText ? ` — ${reasonText}` : ''}`);
                }
              }
            } catch (e: any) {
              console.warn(`[VTID-01270A] community_recommendations query failed: ${e.message}`);
            }
          })());
        }

        // Fetch daily matches
        if (recType === 'match' || recType === 'all') {
          recPromises.push((async () => {
            const matchesUrl = `${SUPABASE_URL}/rest/v1/matches_daily?select=id,score,state,reasons&tenant_id=eq.${tenantId}&user_id=eq.${userId}&match_date=eq.${today}&state=eq.suggested&order=score.desc&limit=3`;
            try {
              const resp = await fetch(matchesUrl, { method: 'GET', headers });
              if (resp.ok) {
                const matches = await resp.json() as Array<{
                  id: string; score: number; state: string;
                  reasons: Record<string, unknown>;
                }>;
                for (const m of matches) {
                  const reasonText = m.reasons && typeof m.reasons === 'object'
                    ? Object.values(m.reasons).filter(v => typeof v === 'string').join(', ')
                    : '';
                  results.push(`[Daily Match] Score: ${m.score}/100${reasonText ? ` — ${reasonText}` : ''}`);
                }
              }
            } catch (e: any) {
              console.warn(`[VTID-01270A] matches_daily query failed: ${e.message}`);
            }
          })());
        }

        await Promise.allSettled(recPromises);

        if (results.length === 0) {
          console.log(`[VTID-01270A] get_recommendations: 0 results (type=${recType}), ${Date.now() - startTime}ms`);
          return { success: true, result: 'No personalized recommendations available right now. Try checking back later, or ask me about events or community groups directly.' };
        }

        const MAX_TOOL_RESPONSE_CHARS = 3000;
        let formatted = results.join('\n');
        if (formatted.length > MAX_TOOL_RESPONSE_CHARS) {
          formatted = formatted.substring(0, MAX_TOOL_RESPONSE_CHARS) + '\n... (truncated)';
        }

        console.log(`[VTID-01270A] get_recommendations: ${results.length} results (type=${recType}), ${formatted.length} chars, ${Date.now() - startTime}ms`);
        return { success: true, result: `Here are your personalized recommendations:\n${formatted}` };
      }

      // VTID-01941 / VTID-01942: Voice "play a song" — dispatch music.play
      // capability, emit orb_directive open_url so the widget opens the
      // provider URL, return a short speakable ack. The optional `source`
      // arg from the model (e.g. user said "on Spotify") is passed through
      // to the capability resolver.
      case 'play_music': {
        const query = String(args.query ?? '').trim();
        const requestedSource = typeof args.source === 'string' ? args.source.trim() : undefined;
        if (!query) {
          return { success: false, result: '', error: 'play_music requires a "query" argument' };
        }

        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Music capability unavailable — Supabase creds not configured' };
        }

        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { executeCapability } = await import('../capabilities');
        const disp = await executeCapability(
          { supabase, userId: lens.user_id, tenantId: lens.tenant_id },
          'music.play',
          { query, ...(requestedSource ? { source: requestedSource } : {}) },
        ) as any;

        if (!disp.ok || !disp.url) {
          // VTID-01942 PR 3: first-timer-friendly failures. If the hub
          // didn't have the track and the user has no external music
          // connector, offer to take them to Connected Apps instead of
          // returning a raw error.
          const errText = String(disp.error ?? '');
          const isHubMiss = /no (music|podcast|shorts) found in the vitana media hub/i.test(errText);
          const isNotConnected = /isn't connected|requires a connected provider/i.test(errText);
          if (isHubMiss || isNotConnected) {
            // Nudge the widget: we don't auto-navigate (that would interrupt
            // the conversation) — the user confirms verbally and Gemini
            // then calls the `navigate` tool.
            return {
              success: true,
              result: isHubMiss
                ? `I couldn't find "${query}" in the Vitana Media Hub. To play the real track, you'll need to link a music service like YouTube Music, Spotify, or Apple Music — want me to take you to Connected Apps?`
                : `You haven't connected that music service yet. Want me to take you to Connected Apps so you can link it?`,
            };
          }
          return {
            success: false,
            result: '',
            error: errText || 'music.play returned no URL',
          };
        }

        const raw = (disp.raw ?? {}) as { title?: string; channel?: string; source?: string };
        const title = raw.title ?? query;
        const channel = raw.channel ?? '';
        const source = raw.source ?? 'unknown';
        const routingReason: string | undefined = disp.routing_reason;
        const suggestDefault: boolean = Boolean(disp.suggest_default);
        const preferenceSetMethod: string | undefined = disp.preference_set_method;

        // VTID-01942: pass through per-platform URL variants so the widget
        // can hand off to the native app on iOS/Android instead of loading
        // the web player inside the WebView (which covers Vitana and shows
        // ads). See orb-widget.js handling of directive='open_url'.
        const rawRec = (disp.raw ?? {}) as Record<string, unknown>;
        const androidIntent = typeof rawRec.android_intent === 'string' ? rawRec.android_intent : undefined;
        const iosScheme = typeof rawRec.ios_scheme === 'string' ? rawRec.ios_scheme : undefined;

        const directive = {
          type: 'orb_directive',
          directive: 'open_url',
          url: disp.url,
          android_intent: androidIntent,
          ios_scheme: iosScheme,
          title,
          channel,
          source,
          query,
          routing_reason: routingReason,
          suggest_default: suggestDefault,
          vtid: 'VTID-01942',
        };
        try { session.sseResponse?.write(`data: ${JSON.stringify(directive)}\n\n`); } catch (_e) { /* SSE closed */ }
        const ws = (session as any).clientWs;
        if (ws && ws.readyState === 1) {
          try { sendWsMessage(ws, directive); } catch (_e) { /* WS closed */ }
        }

        const providerDisplay =
          source === 'youtube_music' ? 'YouTube Music' :
          source === 'spotify' ? 'Spotify' :
          source === 'apple_music' ? 'Apple Music' :
          source === 'vitana_hub' ? 'the Vitana Media Hub' :
          source;

        const baseAck = channel
          ? `Now playing "${title}" by ${channel} on ${providerDisplay}.`
          : `Now playing "${title}" on ${providerDisplay}.`;

        // VTID-01942 PR 2: shape the ack based on routing reason + preference
        // state so the voice feels aware of why it picked this provider.
        let tail = '';
        if (routingReason === 'hub_fallback') {
          tail = ' Want me to link your Spotify or YouTube Music so I can play the real track next time?';
        } else if (suggestDefault) {
          tail = ` That\'s three plays in a row on ${providerDisplay} — want me to make it your default for music?`;
        } else if (routingReason === 'preference' && preferenceSetMethod === 'explicit') {
          // Silent — user already set this as their default, don't chatter.
          tail = '';
        }

        console.log(`[VTID-01942] play_music: "${query}" → ${title}${channel ? ' — ' + channel : ''} via ${source} (${routingReason ?? 'n/a'}${suggestDefault ? ', suggest_default' : ''})`);

        // BOOTSTRAP-HISTORY-AWARE-TIMELINE: record the play on the user
        // timeline so the profiler picks it up in [RECENT] + [ACTIVITY_14D].
        // Without this, the voice ORB has no memory of the songs the user
        // just asked it to play — the whole point of the content-awareness ask.
        writeTimelineRow({
          user_id: lens.user_id,
          activity_type: 'media.music.play',
          activity_data: {
            query,
            title,
            channel,
            source,
            routing_reason: routingReason,
            url: disp.url,
          },
          context_data: { surface: 'orb' },
          dedupe_key: `media:music:${source}:${title}:${Math.floor(Date.now() / 60_000)}`,
          source: 'projector:orb',
        }).catch(() => {});

        return { success: true, result: `${baseAck}${tail}` };
      }

      // PR B-4: lifted to services/orb-tools-shared.ts. Both pipelines now
      // write to user_capability_preferences through the same wrapper.
      case 'set_capability_preference': {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Preferences unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'set_capability_preference',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
          },
          supabase,
        );
      }

      // VTID-01943: the Gmail + Calendar + Contacts voice tools all share
      // the same shape — invoke a capability via executeCapability, then
      // hand the structured_list back to Gemini so it speaks a summary.
      case 'read_email':
      case 'get_schedule':
      case 'add_to_calendar':
      case 'find_contact': {
        // PR B-1 (VTID-LIVEKIT-LIFT-CAPABILITIES): delegate to the shared
        // dispatcher. The same case body that used to live inline here is
        // now in services/orb-tools-shared.ts (_runCapabilityTool), so both
        // Vertex and the LiveKit pipeline run identical capability-tool
        // logic — no drift possible by construction.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          toolName,
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
          },
          supabase,
        );
      }

      // =====================================================================
      // BOOTSTRAP-ORB-DELEGATION-ROUTE: AI-to-AI delegation
      // =====================================================================
      // Forward the user's question to ChatGPT / Claude / Google AI through
      // the user's own connected credentials, and return the answer so
      // Gemini can speak it in Vitana's voice. Full orchestration (router,
      // budget, credential, provider call, usage log) lives in
      // services/gateway/src/orb/delegation/.
      case 'consult_external_ai': {
        // PR D-2: lifted to services/orb-tools-shared.ts. Both pipelines now
        // call executeDelegation through the same wrapper.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'consult_external_ai',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
            session_id: session.sessionId,
            session_started_iso: new Date(startTime).toISOString(),
            lang: session.lang || 'en',
          },
          supabase,
        );
      }

      // ─── BOOTSTRAP-ORB-INDEX-AWARENESS round 2 — Vitana Index tools ───
      case 'get_vitana_index': {
        try {
          const { fetchVitanaIndexForProfiler } = await import('../services/user-context-profiler');
          const { createClient } = await import('@supabase/supabase-js');
          const url = process.env.SUPABASE_URL;
          const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
          if (!url || !key) return { success: false, result: '', error: 'Supabase not configured' };
          const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
          const snap = await fetchVitanaIndexForProfiler(client, lens.user_id);
          if (!snap) {
            return {
              success: true,
              result: 'I don\'t see a Vitana Index score yet — it looks like the baseline survey hasn\'t been completed. Want me to point you to the health screen so you can start?',
            };
          }
          return {
            success: true,
            result: JSON.stringify({
              total: snap.total,
              tier: snap.tier,
              tier_framing: snap.tier_framing,
              pillars: snap.pillars,                       // 5 canonical pillars
              weakest_pillar: snap.weakest_pillar,
              strongest_pillar: snap.strongest_pillar,
              balance_factor: snap.balance_factor,
              balance_label: snap.balance_label,
              balance_hint: snap.balance_hint,
              subscores: snap.subscores,                   // per-pillar breakdown (why each is where it is)
              trend_7d: snap.trend_7d,
              goal_target: snap.goal_target,               // 600 (Really good entry)
              points_to_really_good: snap.points_to_really_good,
              last_computed: snap.last_computed,
              model_version: snap.model_version,
              confidence: snap.confidence,
              last_movement: snap.last_movement,
            }),
          };
        } catch (err: any) {
          console.error('[get_vitana_index] error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      case 'get_index_improvement_suggestions': {
        try {
          const { fetchVitanaIndexForProfiler } = await import('../services/user-context-profiler');
          const { resolvePillarKey } = await import('../lib/vitana-pillars');
          const { createClient } = await import('@supabase/supabase-js');
          const url = process.env.SUPABASE_URL;
          const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
          if (!url || !key) return { success: false, result: '', error: 'Supabase not configured' };
          const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

          // Resolve target pillar. resolvePillarKey silently maps retired
          // names (physical → exercise, prosperity → mental, etc.) so the
          // voice path never acknowledges a 6-pillar term even if the
          // model slips. If unknown or missing, fall back to weakest.
          let pillar: string | undefined = resolvePillarKey(args.pillar);
          if (!pillar) {
            const snap = await fetchVitanaIndexForProfiler(client, lens.user_id);
            pillar = snap?.weakest_pillar.name;
          }
          if (!pillar) {
            return {
              success: true,
              result: 'I don\'t see Index data for this user yet, so I can\'t pick a target pillar. Complete the 5-question baseline survey first.',
            };
          }

          const limit = typeof args.limit === 'number' ? Math.min(10, Math.max(1, args.limit)) : 3;

          // Query autopilot_recommendations whose contribution_vector lifts the target pillar.
          // We use a simple JSON path filter — rows where contribution_vector[pillar] > 0.
          const { data, error } = await client
            .from('autopilot_recommendations')
            .select('id, title, action_description, contribution_vector, priority, status')
            .eq('user_id', lens.user_id)
            .in('status', ['pending', 'new', 'snoozed'])
            .not('contribution_vector', 'is', null)
            .order('priority', { ascending: false })
            .limit(50);

          if (error) {
            return { success: false, result: '', error: `Could not fetch recommendations: ${error.message}` };
          }

          // Filter + rank by contribution_vector[pillar]
          const ranked = (data || [])
            .map((r: any) => {
              const cv = r.contribution_vector as Record<string, number> | null;
              const lift = cv && typeof cv[pillar!] === 'number' ? cv[pillar!] : 0;
              return { ...r, _lift: lift };
            })
            .filter((r: any) => r._lift > 0)
            .sort((a: any, b: any) => b._lift - a._lift)
            .slice(0, limit);

          if (ranked.length === 0) {
            return {
              success: true,
              result: JSON.stringify({
                pillar,
                suggestions: [],
                message: `No pending recommendations with a positive ${pillar} contribution right now. Completing ANY existing recommendation will trigger the Index engine to propose more.`,
              }),
            };
          }

          return {
            success: true,
            result: JSON.stringify({
              pillar,
              suggestions: ranked.map((r: any) => ({
                id: r.id,
                title: r.title,
                action: r.action_description,
                lift: r._lift,
                contribution_vector: r.contribution_vector,
              })),
            }),
          };
        } catch (err: any) {
          console.error('[get_index_improvement_suggestions] error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      case 'create_index_improvement_plan': {
        // PR B-9: lifted to services/orb-tools-shared.ts.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Supabase not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'create_index_improvement_plan',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? session.active_role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );
      }

      // ─── VTID-02753 — Voice Tool Expansion P1a: structured Health logging ───
      // Five tools (log_water, log_sleep, log_exercise, log_meditation,
      // get_pillar_subscores) all backed by services/voice-tools/health-log.ts
      // which calls POST /api/v1/integrations/manual/log internally and reads
      // the resulting Index snapshot for celebration text.
      case 'log_water':
      case 'log_sleep':
      case 'log_exercise':
      case 'log_meditation': {
        // VTID-LIFT-HEALTH-LOG: delegate to the canonical shared dispatcher
        // (services/orb-tools-shared.ts → tool_log_health → logHealthSignal).
        // Both pipelines now run identical health-log code; drift impossible.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          toolName,
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );
      }

      case 'get_pillar_subscores': {
        // VTID-LIFT-PILLAR-SUBSCORES: delegate to the canonical shared
        // dispatcher (services/orb-tools-shared.ts → tool_get_pillar_subscores).
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Supabase not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'get_pillar_subscores',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );
      }

      // ─── VTID-01983 — save_diary_entry: log a diary entry on user's behalf ───
      case 'save_diary_entry': {
        try {
          const rawText = String(args.raw_text || '').trim();
          const argDate = args.entry_date as string | undefined;
          const entryDate = argDate && /^\d{4}-\d{2}-\d{2}$/.test(argDate)
            ? argDate
            : new Date().toISOString().slice(0, 10);
          if (!rawText) {
            return { success: false, result: '', error: 'INVALID_RAW_TEXT' };
          }

          const { extractHealthFeaturesFromDiary, persistDiaryHealthFeatures } = await import(
            '../services/diary-health-extractor'
          );
          const { createClient } = await import('@supabase/supabase-js');
          const url = process.env.SUPABASE_URL;
          const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
          if (!url || !key) return { success: false, result: '', error: 'Supabase not configured' };
          const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

          // 1) Insert into diary_entries (frontend-readable table). Best-effort —
          //    if the row exists, we still proceed with the extractor.
          try {
            await admin.from('diary_entries').insert({
              user_id: lens.user_id,
              text: rawText,
              source: 'voice',
              tags: ['diary', 'voice', 'orb'],
            });
          } catch (insertErr: any) {
            console.warn(`[save_diary_entry] diary_entries insert failed (non-fatal): ${insertErr?.message}`);
          }

          // 2) Read pre-recompute Index for delta math.
          const { data: beforeRow } = await admin
            .from('vitana_index_scores')
            .select('score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
            .eq('user_id', lens.user_id)
            .eq('date', entryDate)
            .maybeSingle();
          const before = beforeRow as Record<string, number | null> | null;

          // 3) Run extractor + persist.
          const writes = extractHealthFeaturesFromDiary(rawText);
          const tenantId = lens.tenant_id || '00000000-0000-0000-0000-000000000000';
          let health_features_written = 0;
          if (writes.length > 0) {
            const { written } = await persistDiaryHealthFeatures(
              admin,
              lens.user_id,
              tenantId,
              entryDate,
              writes,
            );
            health_features_written = written;
          }

          // 4) Recompute Index.
          let pillars_after: Record<string, number> | null = null;
          try {
            const { data: rec } = await admin.rpc('health_compute_vitana_index_for_user', {
              p_user_id: lens.user_id,
              p_date: entryDate,
            });
            const r = rec as any;
            if (r && r.ok !== false) {
              pillars_after = {
                total:     Number(r.score_total     ?? 0),
                nutrition: Number(r.score_nutrition ?? 0),
                hydration: Number(r.score_hydration ?? 0),
                exercise:  Number(r.score_exercise  ?? 0),
                sleep:     Number(r.score_sleep     ?? 0),
                mental:    Number(r.score_mental    ?? 0),
              };
            }
          } catch (recErr: any) {
            console.warn(`[save_diary_entry] Index recompute failed: ${recErr?.message}`);
          }

          const index_delta = pillars_after ? {
            total:     pillars_after.total     - Number(before?.score_total     ?? 0),
            nutrition: pillars_after.nutrition - Number(before?.score_nutrition ?? 0),
            hydration: pillars_after.hydration - Number(before?.score_hydration ?? 0),
            exercise:  pillars_after.exercise  - Number(before?.score_exercise  ?? 0),
            sleep:     pillars_after.sleep     - Number(before?.score_sleep     ?? 0),
            mental:    pillars_after.mental    - Number(before?.score_mental    ?? 0),
          } : null;

          // H.5 — diary streak celebration (best-effort, non-blocking).
          const { celebrateDiaryStreak } = await import('../services/diary-streak-celebrator');
          const streak = await celebrateDiaryStreak(admin, lens.user_id, tenantId);

          console.log(`[save_diary_entry] user=${lens.user_id.slice(0, 8)} features=${health_features_written} delta_total=${index_delta?.total ?? 0} streak=${streak ? streak.tier_days : '-'}`);

          return {
            success: true,
            result: JSON.stringify({
              ok: true,
              entry_date: entryDate,
              health_features_written,
              pillars_after,
              index_delta,
              streak,
            }),
          };
        } catch (err: any) {
          console.error('[save_diary_entry] error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      // ─── VTID-02601 — set_reminder: voice-create a one-shot reminder ───
      case 'set_reminder': {
        try {
          const { createReminder, formatTimeForVoice, ReminderValidationError } = await import(
            '../services/reminders-service'
          );
          const { createClient } = await import('@supabase/supabase-js');
          const url = process.env.SUPABASE_URL;
          const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
          if (!url || !key) return { success: false, result: '', error: 'Supabase not configured' };
          const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

          const userTz = (session as any)?.clientContext?.timezone || 'UTC';
          const lang = ((session as any)?.lang || (session as any)?.clientContext?.locale || 'en').slice(0, 5);

          try {
            const reminder = await createReminder(admin, {
              user_id: lens.user_id,
              tenant_id: lens.tenant_id,
              action_text: String(args.action_text || ''),
              spoken_message: String(args.spoken_message || ''),
              scheduled_for_iso: String(args.scheduled_for_iso || ''),
              user_tz: userTz,
              lang,
              description: typeof args.description === 'string' ? args.description : undefined,
              created_via: 'voice',
            });
            const fireAt = new Date(reminder.next_fire_at);
            return {
              success: true,
              result: JSON.stringify({
                ok: true,
                reminder_id: reminder.id,
                action_text: reminder.action_text,
                scheduled_for_iso: reminder.next_fire_at,
                human_time: formatTimeForVoice(fireAt, userTz, lang),
              }),
            };
          } catch (innerErr: any) {
            if (innerErr instanceof ReminderValidationError) {
              return { success: false, result: '', error: innerErr.message };
            }
            throw innerErr;
          }
        } catch (err: any) {
          console.error('[set_reminder] error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      // ─── VTID-02601 — find_reminders: read-only lookup ───
      case 'find_reminders': {
        try {
          const { findReminders, formatTimeForVoice } = await import('../services/reminders-service');
          const { createClient } = await import('@supabase/supabase-js');
          const url = process.env.SUPABASE_URL;
          const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
          if (!url || !key) return { success: false, result: '', error: 'Supabase not configured' };
          const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

          const userTz = (session as any)?.clientContext?.timezone || 'UTC';
          const lang = ((session as any)?.lang || (session as any)?.clientContext?.locale || 'en').slice(0, 5);

          const data = await findReminders(admin, lens.user_id, {
            query: typeof args.query === 'string' ? args.query : '',
            include_fired: !!args.include_fired,
            limit: 10,
          });
          return {
            success: true,
            result: JSON.stringify({
              ok: true,
              count: data.length,
              reminders: data.map((r) => ({
                reminder_id: r.id,
                action_text: r.action_text,
                spoken_message: r.spoken_message,
                human_time: formatTimeForVoice(new Date(r.next_fire_at), userTz, lang),
                status: r.status,
              })),
            }),
          };
        } catch (err: any) {
          console.error('[find_reminders] error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      // ─── VTID-02601 — delete_reminder: requires verbal confirmation ───
      case 'delete_reminder': {
        try {
          const { softDeleteReminders } = await import('../services/reminders-service');
          const { createClient } = await import('@supabase/supabase-js');
          const url = process.env.SUPABASE_URL;
          const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
          if (!url || !key) return { success: false, result: '', error: 'Supabase not configured' };
          const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

          const mode = String(args.mode || '');
          const confirmed = !!args.confirmed;
          const phrase = String(args.user_confirmation_phrase || '').trim();

          if (!confirmed || !phrase) {
            return {
              success: false,
              result: '',
              error: 'Refusing to delete without explicit user confirmation. Ask the user "are you sure?" first, then call again with confirmed=true and the user_confirmation_phrase.',
            };
          }

          if (mode === 'single') {
            const reminderId = String(args.reminder_id || '');
            if (!reminderId) {
              return { success: false, result: '', error: 'reminder_id is required for mode=single' };
            }
            const result = await softDeleteReminders(
              admin,
              lens.user_id,
              { mode: 'single', reminder_id: reminderId },
              'voice',
              { confirmation: phrase },
            );
            if (result.deleted === 0) {
              return { success: false, result: '', error: 'Reminder not found or already cancelled' };
            }
            return {
              success: true,
              result: JSON.stringify({ ok: true, deleted: 1, action_text: result.action_text }),
            };
          }

          if (mode === 'all') {
            const result = await softDeleteReminders(
              admin,
              lens.user_id,
              { mode: 'all' },
              'voice',
              { confirmation: phrase },
            );
            return {
              success: true,
              result: JSON.stringify({ ok: true, deleted: result.deleted }),
            };
          }

          return { success: false, result: '', error: `Unknown mode: ${mode}` };
        } catch (err: any) {
          console.error('[delete_reminder] error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      // ─── BOOTSTRAP-PILLAR-AGENT-Q — per-pillar deep-question dispatch ───
      case 'ask_pillar_agent': {
        // PR B-8: lifted to services/orb-tools-shared.ts.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Supabase not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'ask_pillar_agent',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );
      }

      // ─── BOOTSTRAP-TEACH-BEFORE-REDIRECT — explanation-first dispatch ───
      case 'explain_feature': {
        // PR B-2: lifted to services/orb-tools-shared.ts. Both pipelines now
        // call the same explainFeature service through the same wrapper.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'explain_feature',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
          },
          supabase,
        );
      }

      // ─── VTID-01967 — Vitana ID voice messaging ───
      case 'resolve_recipient': {
        // PR B-6: lifted to services/orb-tools-shared.ts.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'resolve_recipient',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );
      }

      case 'send_chat_message': {
        // PR B-6: lifted to services/orb-tools-shared.ts.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'send_chat_message',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );
      }

      // V2 — Proactive Initiative Engine: activate an Autopilot recommendation.
      // Minimal v1 implementation: status='activated' update + return title +
      // a generic completion message. The full activation flow (calendar
      // event creation, push notifications, queue replenishment) lives in
      // /api/v1/autopilot/recommendations/:id/activate; that flow remains
      // the authoritative path and runs on its own when the user opens the
      // app. This tool dispatch only covers the voice-handshake case.
      case 'activate_recommendation': {
        const recId = String(args.id || '').trim();
        if (!recId) {
          return { success: false, result: '', error: 'id is required' };
        }
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const supabase = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE!,
          );

          // Verify ownership + fetch title for the celebratory close.
          const { data: rec, error: fetchErr } = await supabase
            .from('autopilot_recommendations')
            .select('id, title, summary, status, user_id')
            .eq('id', recId)
            .maybeSingle();

          if (fetchErr) {
            return { success: false, result: '', error: fetchErr.message };
          }
          if (!rec) {
            return { success: false, result: '', error: 'recommendation_not_found' };
          }
          if (rec.user_id && rec.user_id !== session.identity!.user_id) {
            return {
              success: false,
              result: '',
              error: 'recommendation_belongs_to_another_user',
            };
          }

          const alreadyActive = rec.status === 'activated';
          if (!alreadyActive) {
            const { error: updErr } = await supabase
              .from('autopilot_recommendations')
              .update({ status: 'activated', updated_at: new Date().toISOString() })
              .eq('id', recId);
            if (updErr) {
              return { success: false, result: '', error: updErr.message };
            }
          }

          // Telemetry — fire-and-forget. Mirrors the consented/executed split
          // from the initiative-engine plan so dashboards can compute funnel.
          import('../services/guide').then(({ emitGuideTelemetry }) => {
            emitGuideTelemetry('guide.initiative.executed', {
              user_id: session.identity!.user_id,
              initiative_key: 'autopilot_top_recommendation',
              on_yes_tool: 'activate_recommendation',
              recommendation_id: recId,
              already_active: alreadyActive,
            }).catch(() => {});
          }).catch(() => {});

          return {
            success: true,
            result: JSON.stringify({
              ok: true,
              title: rec.title,
              already_active: alreadyActive,
              completion_message: alreadyActive
                ? `"${rec.title}" was already on your active list — I'll keep it there.`
                : `Done — "${rec.title}" is on your active list. Open Autopilot when you're ready to start it.`,
            }),
          };
        } catch (err: any) {
          console.error('[V2-INITIATIVE] activate_recommendation error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      case 'share_link': {
        // PR B-5: lifted to services/orb-tools-shared.ts. Same quota guard,
        // same chat_messages insert, same metadata shape — both pipelines
        // share the canonical impl.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'share_link',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );
      }

      // ─── VTID-01975 — Vitana Intent Engine voice tools ───
      case 'post_intent': {
        const utterance = String(args.utterance || '').trim();
        const kindHint = (args.kind_hint as string) || undefined;
        const confirmed = args.confirmed === true;
        if (!utterance) {
          return { success: false, result: '', error: 'utterance is required' };
        }
        // VTID-02716: once the row is inserted, no error path may report failure to the user.
        let postedIntentId: string | null = null;
        let postedVid: string | null = null;
        let postedKind: string | null = null;
        try {
          const { classifyIntentKind } = await import('../services/intent-classifier');
          const { extractIntent } = await import('../services/intent-extractor');
          const { embedIntent } = await import('../services/intent-embedding');
          const { computeForIntent, surfaceTopMatches } = await import('../services/intent-matcher');
          const { checkIntentContent } = await import('../services/intent-content-filter');
          const { canPostIntent } = await import('../services/intent-throttle');
          const { gateCommercialBudget } = await import('../services/intent-tier-gate');
          const { notifyMatchSurfaced } = await import('../services/intent-notifier');
          const { writeIntentFacts } = await import('../services/intent-memory-hooks');
          const { getActiveCompassGoal } = await import('../services/intent-compass-lens');
          const { createClient } = await import('@supabase/supabase-js');

          // Classify (or use kind_hint).
          let intentKind = kindHint as any;
          if (!intentKind) {
            const cls = await classifyIntentKind(utterance);
            if (!cls.intent_kind || cls.confidence < 0.7) {
              return {
                success: true,
                result: JSON.stringify({
                  ok: false,
                  reason: 'classify_low_confidence',
                  classifier_confidence: cls.confidence,
                  message: 'Could not confidently classify the utterance. Ask the user to clarify what kind of intent they want to post.',
                }),
              };
            }
            intentKind = cls.intent_kind;
          }

          // Extract.
          const extract = await extractIntent(utterance, intentKind);
          const summary = {
            intent_kind: intentKind,
            category: extract.category,
            title: extract.title,
            scope: extract.scope,
            kind_payload: extract.kind_payload,
            confidence: extract.confidence,
            missing_critical: extract.missing_critical,
          };

          // Step 1 (no confirmed): return the summary for verbal read-back.
          if (!confirmed) {
            return {
              success: true,
              result: JSON.stringify({
                ok: true,
                stage: 'awaiting_confirmation',
                summary,
                instructions: 'Read the summary back to the user verbatim, then call post_intent again with confirmed=true after they say post/yes/confirm/ja.',
              }),
            };
          }

          // Step 2 (confirmed=true): validate + write.
          if (extract.missing_critical.length > 0 || extract.confidence < 0.6) {
            return {
              success: true,
              result: JSON.stringify({
                ok: false,
                reason: 'extract_incomplete',
                summary,
                message: 'Single-shot extraction missed required fields. Ask the user for ' + extract.missing_critical.join(', '),
              }),
            };
          }

          const cf = checkIntentContent({ kind: intentKind, title: extract.title!, scope: extract.scope! });
          if (!cf.ok) {
            return {
              success: true,
              result: JSON.stringify({ ok: false, reason: 'content_filter_blocked', reasons: cf.reasons }),
            };
          }

          const budgetMax = (extract.kind_payload?.budget_max as number) ?? null;
          const throttle = await canPostIntent({
            userId: session.identity!.user_id,
            kind: intentKind,
            budgetMaxEur: typeof budgetMax === 'number' ? budgetMax : null,
          });
          if (!throttle.ok) {
            return { success: true, result: JSON.stringify({ ok: false, reason: throttle.reason, message: throttle.detail }) };
          }

          if ((intentKind === 'commercial_buy' || intentKind === 'commercial_sell') && typeof budgetMax === 'number') {
            const gate = await gateCommercialBudget(session.identity!.user_id, budgetMax);
            if (!gate.ok) {
              return { success: true, result: JSON.stringify({ ok: false, reason: 'tier_required', tier: gate.tier, required: gate.required, message: gate.reason }) };
            }
          }

          const compass = await getActiveCompassGoal(session.identity!.user_id);
          const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);

          const { data: inserted, error: insErr } = await supabase
            .from('user_intents')
            .insert({
              requester_user_id: session.identity!.user_id,
              tenant_id: session.identity!.tenant_id,
              intent_kind: intentKind,
              category: extract.category,
              title: extract.title,
              scope: extract.scope,
              kind_payload: extract.kind_payload,
              compass_alignment_at_post: compass?.category ?? null,
              status: 'open',
            })
            .select('intent_id, requester_vitana_id')
            .single();

          if (insErr || !inserted) {
            console.error('[VTID-01975] post_intent insert failed', insErr);
            return { success: false, result: '', error: insErr?.message ?? 'insert_failed' };
          }

          const intentId = (inserted as any).intent_id;
          const vid = (inserted as any).requester_vitana_id;
          postedIntentId = intentId;
          postedVid = vid;
          postedKind = intentKind;

          // VTID-02716: row is now in user_intents — every side-effect below must be
          // best-effort. A throw here would otherwise reach the outer catch and Gemini
          // would say "I have a problem making the post" while the post sits in the user's list.
          try {
            const embedding = await embedIntent({ intent_kind: intentKind, category: extract.category, title: extract.title!, scope: extract.scope!, kind_payload: extract.kind_payload });
            if (embedding) {
              const { error: embedUpdErr } = await supabase.from('user_intents').update({ embedding: embedding as any }).eq('intent_id', intentId);
              if (embedUpdErr) {
                console.warn(`[VTID-02716] post_intent embedding update non-fatal: ${embedUpdErr.message}`);
              }
            }
          } catch (err: any) {
            console.warn(`[VTID-02716] post_intent embedding non-fatal: ${err?.message}`);
          }

          writeIntentFacts({
            user_id: session.identity!.user_id,
            tenant_id: session.identity!.tenant_id!,
            intent_kind: intentKind,
            category: extract.category,
            title: extract.title!,
            scope: extract.scope!,
            kind_payload: extract.kind_payload,
          }).catch((err) => console.warn(`[VTID-01975] writeIntentFacts non-fatal: ${err?.message}`));

          let matchCount = 0;
          let topMatches: any[] = [];
          try {
            matchCount = await computeForIntent(intentId);
            if (matchCount > 0) {
              topMatches = await surfaceTopMatches(intentId, 3);
              for (const m of topMatches) {
                await notifyMatchSurfaced({ match: m, kind: intentKind });
              }
            }
          } catch (err: any) {
            console.warn(`[VTID-01975] post_intent match compute failed: ${err.message}`);
          }

          // VTID-DANCE-D3: always-post telemetry. Every dictated intent posts;
          // match_count=0 is its own signal that needs an explicit "you're the
          // first" readback (the voice tool description tells Gemini how).
          if (matchCount === 0) {
            try {
              await emitOasisEvent({
                vtid: 'VTID-DANCE-D3',
                type: 'voice.message.sent',
                source: 'orb-live',
                status: 'info',
                message: `Intent posted with zero matches (cold-start); kind=${intentKind} category=${extract.category ?? 'null'}`,
                payload: {
                  intent_id: intentId,
                  intent_kind: intentKind,
                  category: extract.category,
                  always_post: true,
                  reason: 'no_matches_yet',
                },
                actor_id: session.identity!.user_id,
                actor_role: 'user',
                surface: 'orb',
                vitana_id: vid,
              });
            } catch {
              // best effort
            }
          }

          return {
            success: true,
            result: JSON.stringify({
              ok: true,
              stage: 'posted',
              intent_id: intentId,
              vitana_id: vid,
              intent_kind: intentKind,
              match_count: matchCount,
              top_matches: topMatches.map((m: any) => ({
                match_id: m.match_id,
                vitana_id_b: intentKind === 'partner_seek' ? null : m.vitana_id_b,
                score: m.score,
                kind_pairing: m.kind_pairing,
              })),
              compass_aligned: !!compass?.category,
              partner_seek_redacted: intentKind === 'partner_seek',
              // Hint to the model: when match_count=0, read back the
              // "you're the first" message from the voice-tool description.
              cold_start: matchCount === 0,
            }),
          };
        } catch (err: any) {
          console.error('[VTID-01975] post_intent error:', err?.message);
          // VTID-02716 + VTID-02790: if the row was already inserted, return a normal
          // success shape — Gemini misreads any "degraded"/"partial" hint as failure
          // and apologizes to the user, even though the post is live.
          if (postedIntentId) {
            console.warn(`[VTID-02716] post_intent post-insert throw recovered; intent_id=${postedIntentId}`);
            return {
              success: true,
              result: JSON.stringify({
                ok: true,
                stage: 'posted',
                intent_id: postedIntentId,
                vitana_id: postedVid,
                intent_kind: postedKind,
                match_count: 0,
                top_matches: [],
                compass_aligned: false,
                partner_seek_redacted: postedKind === 'partner_seek',
                cold_start: true,
              }),
            };
          }
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      case 'view_intent_matches': {
        const intentId = String(args.intent_id || '').trim();
        const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 10);
        if (!intentId) return { success: false, result: '', error: 'intent_id is required' };
        try {
          const { surfaceTopMatches } = await import('../services/intent-matcher');
          const { redactMatchForReader } = await import('../services/intent-mutual-reveal');
          const matches = await surfaceTopMatches(intentId, limit);
          const redacted = await Promise.all(matches.map((m) => redactMatchForReader(m, session.identity!.user_id)));
          return {
            success: true,
            result: JSON.stringify({
              ok: true,
              matches: redacted.map((m) => ({
                match_id: m.match_id,
                vitana_id_b: m.vitana_id_b,
                score: m.score,
                kind_pairing: m.kind_pairing,
                state: m.state,
                redacted: m.redacted,
              })),
            }),
          };
        } catch (err: any) {
          console.error('[VTID-01975] view_intent_matches error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      case 'list_my_intents': {
        const kindFilter = (args.intent_kind as string) || undefined;
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
          let q = supabase
            .from('user_intents')
            .select('intent_id, intent_kind, category, title, status, match_count, created_at')
            .eq('requester_user_id', session.identity!.user_id)
            .in('status', ['open', 'matched', 'engaged'])
            .order('created_at', { ascending: false })
            .limit(20);
          if (kindFilter) q = q.eq('intent_kind', kindFilter);
          const { data, error } = await q;
          if (error) return { success: false, result: '', error: error.message };
          return {
            success: true,
            result: JSON.stringify({ ok: true, intents: data ?? [] }),
          };
        } catch (err: any) {
          console.error('[VTID-01975] list_my_intents error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      case 'respond_to_match': {
        // PR B-7: lifted to services/orb-tools-shared.ts.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'respond_to_match',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
            user_jwt: ((session as any).access_token as string | undefined) ?? ((session as any).jwt as string | undefined) ?? null,
          },
          supabase,
        );
      }

      case 'mark_intent_fulfilled': {
        const intentId = String(args.intent_id || '').trim();
        if (!intentId) return { success: false, result: '', error: 'intent_id is required' };
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
          const { error } = await supabase
            .from('user_intents')
            .update({ status: 'fulfilled' })
            .eq('intent_id', intentId)
            .eq('requester_user_id', session.identity!.user_id);
          if (error) return { success: false, result: '', error: error.message };
          return { success: true, result: JSON.stringify({ ok: true, intent_id: intentId, status: 'fulfilled' }) };
        } catch (err: any) {
          console.error('[VTID-01975] mark_intent_fulfilled error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      // VTID-DANCE-D10: voice-driven direct invite.
      case 'share_intent_post': {
        // PR B-7: lifted to services/orb-tools-shared.ts.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'share_intent_post',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
            user_jwt: ((session as any).access_token as string | undefined) ?? ((session as any).jwt as string | undefined) ?? null,
          },
          supabase,
        );
      }

      // VTID-02770: navigate_to_screen is routed at the top of handleToolCall
      // (line ~4064) directly to handleNavigateToScreen, so this switch case
      // is unreachable. The duplicated TARGET_ROUTES table that used to live
      // here was deleted — the catalog (with aliases + entry_kind=overlay +
      // param substitution) is the single source of truth. If you need to
      // add a new target, add it as a catalog entry in navigation-catalog.ts,
      // not here.

      // VTID-DANCE-D11.B — pre-post candidate scan.
      case 'scan_existing_matches': {
        // PR B-7: lifted to services/orb-tools-shared.ts.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'scan_existing_matches',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
            user_jwt: ((session as any).access_token as string | undefined) ?? ((session as any).jwt as string | undefined) ?? null,
          },
          supabase,
        );
      }

      // VTID-DANCE-D12 — poll the async matchmaker agent's polished result.
      case 'get_matchmaker_result': {
        const intentId = String(args.intent_id || '').trim();
        if (!intentId) return { success: false, result: '', error: 'intent_id is required' };

        try {
          const url = `${process.env.GATEWAY_INTERNAL_URL || 'http://localhost:8080'}/api/v1/intents/${encodeURIComponent(intentId)}/matchmaker`;
          const jwt = (session as any).access_token || (session as any).jwt;
          const res = await fetch(url, {
            headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
          });
          const data = await res.json();
          return {
            success: res.ok,
            result: JSON.stringify(data),
            error: res.ok ? undefined : (data as any)?.error || 'poll_failed',
          };
        } catch (err: any) {
          console.error('[VTID-DANCE-D12] get_matchmaker_result error:', err?.message);
          return { success: false, result: '', error: err?.message || 'unknown' };
        }
      }

      default: {
        // BOOTSTRAP-ADMIN-DD: route admin voice tools through their handlers.
        // The handlers re-check role server-side, so a community session that
        // somehow names an admin tool will be denied with admin_role_required.
        if (ADMIN_TOOL_NAMES.includes(toolName)) {
          const handler = ADMIN_TOOL_HANDLERS[toolName];
          return await handler(
            {
              tenantId: session.identity!.tenant_id || '',
              userId: session.identity!.user_id,
              activeRole: session.active_role || session.identity?.role || 'community',
            },
            args,
          );
        }
        return {
          success: false,
          result: '',
          error: `Unknown tool: ${toolName}`,
        };
      }
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
    console.warn(`[VTID-01224] Cannot send function response for ${toolName} - WebSocket not open (readyState=${ws.readyState})`);
    return false;
  }

  // Build tool response message (Vertex AI Live API format)
  // Note: Vertex AI rejects unknown fields like 'id' in function_responses
  // with WebSocket close code 1007. Only 'name' and 'response' are accepted.
  const outputText = result.success ? result.result : `Error: ${result.error}`;
  const responseMessage = {
    tool_response: {
      function_responses: [
        {
          name: toolName,
          response: {
            output: outputText,
          },
        },
      ],
    },
  };

  // VTID-01224-FIX: Wrap ws.send() in try-catch to prevent silent failures
  // when WebSocket transitions state during tool execution.
  try {
    const payload = JSON.stringify(responseMessage);
    console.log(`[VTID-01224] Sending function response for ${toolName}: ${outputText.substring(0, 200)}... (${payload.length} bytes)`);
    ws.send(payload);
    return true;
  } catch (err: any) {
    console.error(`[VTID-01224] Failed to send function response for ${toolName}: ${err.message}`);
    return false;
  }
}

/**
 * VTID-NAV-01: Vitana Navigator policy section appended to every system
 * instruction. Teaches the model when to call navigator_consult,
 * navigate_to_screen, or stay silent and answer in voice. EN/DE-aware.
 */
function buildNavigatorPolicySection(lang: string): string {
  const isDe = lang.startsWith('de');
  if (isDe) {
    return `

=== VITANA NAVIGATOR — NAVIGATIONSMODUS ===
Du bist der Navigationsführer für die Maxina Community. Die Community hat viele
Bildschirme und Menschen können Dinge nicht alleine finden — sie zu führen ist
eine deiner wichtigsten Aufgaben. Du hast zwei Werkzeuge:

  • get_current_screen() — gibt den Bildschirm zurück auf dem der Nutzer
    GERADE JETZT ist. RUFE DIESES TOOL AUF, wenn der Nutzer fragt "wo bin ich?",
    "welcher Bildschirm ist das?", "was ist diese Seite?", "was kann ich
    hier machen?". Antworte NIE aus dem Gedächtnis — rufe immer das Tool auf.

  • navigate(question) — das Haupt-Navigations-Tool. Rufe es mit den Worten
    des Nutzers auf und es erledigt ALLES: findet den richtigen Bildschirm,
    durchsucht die Wissensdatenbank nach Anleitungen und leitet den Nutzer
    automatisch weiter. Du musst keine Bildschirmnamen oder IDs kennen —
    gib einfach die Frage weiter.

WANN navigate() AUFRUFEN — NUR BEI EINDEUTIGER NAVIGATIONS-ABSICHT:

Rufe navigate() NUR auf wenn der Nutzer tatsächlich IRGENDWOHIN GEHEN
möchte — also ein klares Handlungsverb benutzt ("öffne", "zeig",
"bring mich zu", "geh zu", "ich will sehen", "wo finde ich", "wo sind").
Beispiele:
   • "öffne mein Profil" → rufe navigate auf
   • "öffne mein Wallet" → rufe navigate auf
   • "wo sind die Podcasts" → rufe navigate auf
   • "bring mich zu meinen Gesundheitsdaten" → rufe navigate auf
   • "ich möchte ein Business aufbauen" → rufe navigate auf
   • "zeig mir meine Gesundheitsdaten" → rufe navigate auf

WANN navigate() **NICHT** AUFRUFEN — INFORMATIONS-Fragen beantworte
gesprächig, OHNE zu navigieren. Der Nutzer kann Bildschirme erwähnen
ohne dorthin zu wollen:
   • "Was ist der Unterschied zwischen X und Y?" → VERGLEICH, erklären
   • "Was ist X?" / "Was macht X?" → DEFINITION, erklären
   • "Wofür ist X gut?" / "Warum gibt es X?" → ERKLÄRUNG
   • "Wie funktioniert X?" → ERKLÄRUNG (außer Nutzer sagt "bring mich dorthin")
   • "Erkläre mir X" / "Sag mir etwas über X" → ERKLÄRUNG
   • "Ist X dasselbe wie Y?" → VERGLEICH, erklären
   • Reiner Smalltalk ("wie geht es dir", "danke")
   • Allgemeine Faktenfragen ("was ist Longevity?")

FAUSTREGEL — das Verb entscheidet:
   • "öffne / zeig / bring mich zu / geh zu / wo sind X" = Navigation ✓
   • "was ist / was macht / Unterschied / erkläre / wie funktioniert /
     wofür / warum" = Erklärung (KEINE Navigation) ✗

Bei ECHTER Unsicherheit OB navigieren oder erklären: stelle EINE kurze
Rückfrage ("Soll ich dich dorthin bringen oder es dir kurz erklären?")
bevor du navigate() aufrufst. Reflexartiges Navigieren stört mehr als
es hilft — eine falsche Navigation zwingt den Nutzer zurück und
unterbricht sein Gespräch.

WAS DU VON navigate() ZURÜCKBEKOMMST:
   • GUIDANCE: eine hilfreiche Erklärung die du dem Nutzer vorsprechen
     sollst. Beschreibe die Funktion, erkläre was er dort tun kann, und
     lass ihn wissen dass du ihn dorthin bringst. Sei warm und hilfreich —
     du bist sein persönlicher Begleiter.
   • NAVIGATING_TO: der Bildschirm wohin er gebracht wird. Wenn das gesetzt
     ist, schließt sich das Orb automatisch und leitet weiter nachdem du
     fertig gesprochen hast. Sprich einfach die Anleitung natürlich.
   • Wenn NAVIGATING_TO null ist, konnte das Backend keinen Treffer finden.
     Frage den Nutzer was er sucht.

NIEMALS rohe URLs oder Routenpfade aussprechen.`;
  }

  return `

=== VITANA NAVIGATOR — NAVIGATION GUIDE MODE ===
You are the navigation guide for the Maxina community. The community has many
screens and people cannot find things on their own — guiding them is one of
your most important jobs. You have two tools:

  • get_current_screen() — returns the screen the user is looking at RIGHT
    NOW. CALL THIS TOOL whenever the user asks any variant of "where am I?",
    "which screen is this?", "what page am I on?", "what can I do here?".
    NEVER answer those questions from memory — always call the tool. It is
    also the right call after you\'ve navigated, if the user asks about
    "this page". It is cheap and always returns the fresh answer.

  • navigate(question) — the main navigation tool. Call it with the user's
    words and it handles EVERYTHING: finds the right screen, searches the
    knowledge base for guidance, and redirects the user automatically.
    You do not need to know screen names or IDs — just pass the question.

WHEN TO CALL navigate() — ONLY ON CLEAR NAVIGATION INTENT:

Call navigate() ONLY when the user actually wants to GO somewhere — i.e.
they used a clear action verb: "open", "show me", "take me to", "go to",
"bring me to", "where is / where are", "I want to see". Examples:
   • "open my profile" → call navigate
   • "open my wallet" → call navigate
   • "where are the podcasts" → call navigate
   • "take me to my health data" → call navigate
   • "I want to set up a business" → call navigate
   • "show me my health data" → call navigate

DO **NOT** call navigate() on INFORMATIONAL questions — answer them
conversationally without navigating. Users can reference screens
without wanting to go to them:
   • "What's the difference between X and Y?" → COMPARISON, explain
   • "What is X?" / "What does X do?" → DEFINITION, explain
   • "What is X for?" / "Why does X exist?" → EXPLANATION
   • "How does X work?" → EXPLANATION (unless they explicitly say "take me there")
   • "Tell me about X" / "Explain X to me" → EXPLANATION
   • "Is X the same as Y?" → COMPARISON, explain
   • Pure small talk ("how are you", "thank you")
   • General factual questions ("what is longevity?")

RULE OF THUMB — the verb decides:
   • "open / show / take me to / go to / where is X" → navigate ✓
   • "what is / what does / difference / explain / how does / why /
     what is X for" → explain, DO NOT navigate ✗

If you are GENUINELY unsure whether the user wants navigation or an
explanation: ask ONE short clarifying question ("Would you like me to
take you there, or briefly explain it?") before calling navigate().
Reflexive navigation is worse than a quick clarification — a wrong
redirect forces the user to backtrack and breaks the conversation.

WHAT YOU GET BACK from navigate():
   • GUIDANCE: a helpful explanation you should speak to the user. Describe
     the feature, explain what they can do there, and let them know you are
     taking them there. Be warm and helpful — you are their personal guide.
   • NAVIGATING_TO: the screen they are being taken to. If this is set,
     the orb will close and redirect automatically after you finish speaking.
     Just speak the guidance naturally.
   • If NAVIGATING_TO is null, the backend could not find a match. Ask the
     user to clarify what they are looking for.

NEVER speak raw URLs or route paths.`;
}

/**
 * VTID-NAV-TIMEJOURNEY: Compute a human-readable description of how long ago
 * the user was last here, plus a classification bucket the greeting logic can
 * switch on.
 *
 * Buckets:
 *   - 'reconnect'  (< 2 min — user literally just closed the widget)
 *   - 'recent'     (< 15 min — same micro-session, probably quick follow-up)
 *   - 'same_day'   (< 8 h — same working day)
 *   - 'today'      (< 24 h — still the same day-ish)
 *   - 'yesterday'  (1 day ago)
 *   - 'week'       (2–7 days)
 *   - 'long'       (>7 days)
 *   - 'first'      (no prior session recorded)
 */
type TemporalBucket = 'reconnect' | 'recent' | 'same_day' | 'today' | 'yesterday' | 'week' | 'long' | 'first';

function describeTimeSince(lastSessionInfo: { time: string; wasFailure: boolean } | null | undefined): {
  bucket: TemporalBucket;
  timeAgo: string;
  diffMs: number;
  wasFailure: boolean;
} {
  if (!lastSessionInfo?.time) {
    return { bucket: 'first', timeAgo: 'never before', diffMs: Number.POSITIVE_INFINITY, wasFailure: false };
  }
  const lastTs = new Date(lastSessionInfo.time).getTime();
  if (!Number.isFinite(lastTs)) {
    return { bucket: 'first', timeAgo: 'never before', diffMs: Number.POSITIVE_INFINITY, wasFailure: !!lastSessionInfo.wasFailure };
  }
  const diffMs = Date.now() - lastTs;
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  let bucket: TemporalBucket;
  let timeAgo: string;
  if (diffSec < 120) {
    bucket = 'reconnect';
    timeAgo = diffSec < 30 ? 'a few seconds ago' : `about ${diffSec} seconds ago`;
  } else if (diffMin < 15) {
    bucket = 'recent';
    timeAgo = `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  } else if (diffHour < 8) {
    bucket = 'same_day';
    if (diffMin < 60) {
      timeAgo = `${diffMin} minutes ago`;
    } else {
      timeAgo = `about ${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
    }
  } else if (diffHour < 24) {
    bucket = 'today';
    timeAgo = `earlier today (about ${diffHour} hours ago)`;
  } else if (diffDay === 1) {
    bucket = 'yesterday';
    timeAgo = 'yesterday';
  } else if (diffDay < 7) {
    bucket = 'week';
    timeAgo = `${diffDay} days ago`;
  } else {
    bucket = 'long';
    timeAgo = `${diffDay} days ago`;
  }

  return { bucket, timeAgo, diffMs, wasFailure: !!lastSessionInfo.wasFailure };
}

/**
 * VTID-NAV-TIMEJOURNEY: Resolve a raw React Router path to a friendly screen
 * label using the navigation catalog. Falls back to the path itself if there
 * is no catalog entry so the assistant never loses context.
 */
function describeRoute(route: string | undefined | null, lang: string): { title: string; path: string } | null {
  if (!route || typeof route !== 'string') return null;
  const entry = lookupNavByRoute(route);
  if (entry) {
    const content = getNavContent(entry, lang);
    return { title: content.title || entry.screen_id, path: entry.route };
  }
  return { title: route, path: route };
}

/**
 * VTID-NAV-TIMEJOURNEY: Build the TEMPORAL + JOURNEY CONTEXT block appended
 * to the authenticated Vitana system instruction.
 *
 * The purpose of this block is three-fold:
 *   1. Tell the model how long it has been since the last ORB session so it
 *      can pick an appropriate greeting style (re-engage vs. welcome back).
 *   2. Tell the model which screen the user is currently looking at and
 *      which screens they visited just before opening the ORB, so it can
 *      acknowledge their journey naturally ("I see you're in the Wallet —
 *      want a hand with something there?").
 *   3. Stop the "Hello Dragan!" habit: explicit anti-patterns forbid
 *      re-introducing the assistant when the user was just here.
 *
 * The block is language-agnostic — Gemini Live translates it into the
 * session language via the LANGUAGE directive earlier in the instruction.
 */
function buildTemporalJourneyContextSection(
  lang: string,
  lastSessionInfo: { time: string; wasFailure: boolean } | null | undefined,
  currentRoute: string | null | undefined,
  recentRoutes: string[] | null | undefined,
  isReconnect: boolean,
  timeOfDay?: string,
): string {
  const temporal = describeTimeSince(lastSessionInfo);
  const current = describeRoute(currentRoute, lang);

  // Deduplicated, ordered (newest first), friendly-titled journey trail.
  const trail: Array<{ title: string; path: string }> = [];
  const seen = new Set<string>();
  const currentPath = current?.path || '';
  if (Array.isArray(recentRoutes)) {
    for (const raw of recentRoutes) {
      if (typeof raw !== 'string' || !raw) continue;
      const described = describeRoute(raw, lang);
      if (!described) continue;
      // Skip the current screen — we already mention it explicitly.
      if (described.path === currentPath) continue;
      if (seen.has(described.path)) continue;
      seen.add(described.path);
      trail.push(described);
      if (trail.length >= 5) break;
    }
  }

  const lines: string[] = [];
  lines.push('## TEMPORAL AND JOURNEY CONTEXT');
  lines.push('This is real, per-session data. Treat it as ground truth about what the user is doing RIGHT NOW.');
  lines.push('');

  // Time since last session.
  // VTID-NAV-TIMEJOURNEY: 'first' here means "no session event in oasis_events
  // for this user". In practice that never means "first ever meeting" — it
  // means the telemetry lookup missed (retention, schema migration, or
  // user hasn't been in a Live session yet). Authenticated users are
  // returning users by definition, so we report this as "unknown recency".
  if (temporal.bucket === 'first') {
    lines.push('- Time since last ORB session: UNKNOWN (telemetry lookup returned no prior session). Do NOT assume this means the user is new — if they are authenticated, they are a returning user.');
  } else {
    lines.push(`- Time since last ORB session: ${temporal.timeAgo}`);
    if (temporal.wasFailure) {
      lines.push('- Last session status: it FAILED (no audio delivered). The user did NOT actually hear you last time, so they may be confused or frustrated.');
    }
  }

  // Current screen.
  if (current) {
    lines.push(`- Current screen: "${current.title}" (route: ${current.path})`);
  } else {
    lines.push('- Current screen: not reported by the host app.');
  }

  // Journey trail.
  if (trail.length > 0) {
    const trailStr = trail.map(t => `"${t.title}"`).join(' → ');
    lines.push(`- Journey before opening ORB (newest → oldest): ${trailStr}`);
  } else {
    lines.push('- Journey before opening ORB: (no prior screens reported this session)');
  }

  lines.push('');
  lines.push('## GREETING POLICY — TIME AND JOURNEY AWARE (CRITICAL, overrides generic GREETING RULES above)');
  lines.push('');
  lines.push('Pick your opening line based on the bucket below. Follow it literally.');
  lines.push('');
  // VTID-01929: When the brain context (appended after this section) contains
  // a USER AWARENESS block + Proactive Opener Candidate, that block's OPENING
  // SHAPE MATRIX (tenure × last_interaction) is the authority — IGNORE the
  // example follow-up phrasings below. The example phrasings are the LEGACY
  // FALLBACK for sessions where the proactive guide has no candidate to surface.
  lines.push('PROACTIVE OVERRIDE: If the brain context appended below contains a "PROACTIVE OPENER CANDIDATE" or "USER AWARENESS" block, IGNORE the example follow-up phrasings in this section. Use the OPENING SHAPE MATRIX from the brain context instead. The phrasings below are LEGACY FALLBACKS only.');
  lines.push('');

  // Map 'night' to 'evening' for greetings ("Good night" is a farewell, not a greeting)
  const greetingTimeOfDay = timeOfDay === 'night' ? 'evening' : (timeOfDay || 'day');

  const bucket = isReconnect ? 'reconnect' : temporal.bucket;
  // VTID-GREETING-VARIETY: for short-gap buckets, inject a freshly-shuffled
  // subset of the language-specific phrase pool so Gemini rotates openers
  // instead of converging on the same translation every time.
  const shortGapExamples = pickShortGapGreetings(lang, 6);
  const appendShortGapPhraseMenu = () => {
    lines.push('  • Pick ONE of these example phrasings (use them VERBATIM — they are already in the user\'s language; pick a different one than last time):');
    for (const p of shortGapExamples) {
      lines.push(`      "${p}"`);
    }
    lines.push('  • Rotate across sessions — the user notices repetition. If the previous session used one of these, pick a different one.');
  };
  switch (bucket) {
    case 'reconnect':
      // VTID-02637: This is a transparent server-side reconnect (Vertex 5-min
      // session limit, network blip, or stall recovery). The user did NOT
      // perceive any pause — they may still be mid-thought or already speaking.
      // Speaking ANY proactive phrase here ("Picking up where we left off?",
      // "I'm listening", "Where were we?") creates the apology-loop bug: every
      // reconnect prompts a new spoken interjection that the user reads as
      // "Vitana keeps apologizing for connection issues". Stay silent. Wait.
      lines.push('- BUCKET = reconnect (transparent server-side resume — the user did NOT perceive any pause).');
      lines.push('  • DO NOT speak. DO NOT greet. DO NOT acknowledge any "interruption", "reconnection", "resume", "where were we", "I\'m back", "I\'m listening", "picking up", or anything similar. Saying any of these creates a perceived apology that the user reads as a bug.');
      lines.push('  • Wait for the user to speak. Your next message must be a direct response to the user\'s next utterance — nothing else.');
      lines.push('  • If the user says nothing, you say nothing. Silence is correct here.');
      break;
    case 'recent':
      lines.push('- BUCKET = recent (2–15 min since last session).');
      lines.push('  • Do NOT use a formal greeting. NO "Hello <name>!", NO "Hi there!", NO self-introduction. NO user name.');
      lines.push('  • Open with ONE single short phrase. NEVER use two-part sentences joined by dashes or commas.');
      appendShortGapPhraseMenu();
      lines.push('  • Max ONE short phrase. Warm but direct.');
      break;
    case 'same_day':
      lines.push('- BUCKET = same_day (15 min – 8 h since last session).');
      lines.push('  • Light re-engagement. NOT a formal greeting. No user name. NEVER "Hello <name>!" as if you\'ve never met.');
      lines.push('  • Open with ONE single short phrase. NEVER use two-part sentences joined by dashes or commas.');
      appendShortGapPhraseMenu();
      lines.push('  • Max ONE short phrase. Warm and direct.');
      break;
    case 'today':
      lines.push('- BUCKET = today (8–24 h since last session — this is a NEW-DAY greeting).');
      lines.push(`  • ALWAYS open with "Good ${greetingTimeOfDay}, [Name]." using the user's name from memory context.`);
      lines.push('  • If no name is available in memory, just say "Good ' + greetingTimeOfDay + '."');
      lines.push('  • LEGACY-FALLBACK ONLY (use the brain context\'s candidate when available).');
      lines.push('  • Example follow-up if no candidate exists (pick ONE or skip):');
      lines.push('      "What\'s on your mind today?"');
      lines.push('      "Where would you like to focus today?"');
      lines.push('  • Max TWO short sentences total: the time-of-day greeting + optionally one question.');
      break;
    case 'yesterday':
      lines.push('- BUCKET = yesterday (this is a NEW-DAY greeting).');
      lines.push(`  • ALWAYS open with "Good ${greetingTimeOfDay}, [Name]." using the user's name from memory context.`);
      lines.push('  • If no name is available in memory, just say "Good ' + greetingTimeOfDay + '."');
      lines.push('  • LEGACY-FALLBACK ONLY (use the brain context\'s candidate when available).');
      lines.push('  • Example follow-up if no candidate exists (pick ONE or skip):');
      lines.push('      "What would you like to explore today?"');
      lines.push('      "Picking up where we left off?"');
      lines.push('  • Max TWO short sentences total: the time-of-day greeting + optionally one question.');
      break;
    case 'week':
      lines.push('- BUCKET = week (2–7 days since last session — this is a NEW-DAY greeting).');
      lines.push(`  • ALWAYS open with "Good ${greetingTimeOfDay}, [Name]." using the user's name from memory context.`);
      lines.push('  • If no name is available in memory, just say "Good ' + greetingTimeOfDay + '."');
      lines.push('  • LEGACY-FALLBACK ONLY (use the brain context\'s candidate when available).');
      lines.push('  • Example follow-up if no candidate exists (pick ONE or skip):');
      lines.push('      "Good to hear from you again — what\'s been on your mind?"');
      lines.push('      "What would you like to explore today?"');
      lines.push('  • Max TWO short sentences total: the time-of-day greeting + optionally one question.');
      break;
    case 'long':
      lines.push('- BUCKET = long (> 7 days since last session — this is a NEW-DAY greeting).');
      lines.push(`  • ALWAYS open with "Good ${greetingTimeOfDay}, [Name]." using the user's name from memory context.`);
      lines.push('  • If no name is available in memory, just say "Good ' + greetingTimeOfDay + '."');
      lines.push('  • LEGACY-FALLBACK ONLY (use the brain context\'s candidate when available — for >7-day absences the candidate should explicitly acknowledge the gap).');
      lines.push('  • Example follow-up if no candidate exists (pick ONE or skip):');
      lines.push('      "It\'s been a few days — happy you\'re back. What\'s been on your mind?"');
      lines.push('      "What would you like to focus on today?"');
      lines.push('  • Max TWO short sentences total: the time-of-day greeting + optionally one question.');
      break;
    case 'first':
    default:
      // VTID-NAV-TIMEJOURNEY: 'first' here is the "no telemetry found"
      // fallback, NOT a genuine first meeting. For authenticated users
      // (everyone who reaches this code path) we treat it as a returning
      // user with unknown recency — treat as new-day greeting.
      // VTID-01927/VTID-01929: when the brain context shows tenure.stage='day0',
      // the user IS truly new and gets the FULL INTRODUCTION shape (handled
      // by the OPENING SHAPE MATRIX in the brain block, not this fallback).
      lines.push('- BUCKET = first (telemetry lookup found no prior session — usually treat as RETURNING with NEW-DAY greeting).');
      lines.push(`  • ALWAYS open with "Good ${greetingTimeOfDay}, [Name]." using the user's name from memory context.`);
      lines.push('  • If no name is available in memory, just say "Good ' + greetingTimeOfDay + '."');
      lines.push('  • EXCEPTION: when the brain context\'s USER AWARENESS shows tenure.stage="day0", the user is genuinely new. Use the FULL INTRODUCTION shape from the brain context\'s OPENING SHAPE MATRIX — that overrides this fallback.');
      lines.push('  • LEGACY-FALLBACK ONLY (use the brain context\'s candidate when available).');
      lines.push('  • Example follow-up if no candidate exists (pick ONE or skip):');
      lines.push('      "What\'s on your mind today?"');
      lines.push('      "Where would you like to focus today?"');
      lines.push('  • Max TWO short sentences total: the time-of-day greeting + optionally one question.');
      break;
  }

  // VTID-02637: wasFailure means the PREVIOUS session ended with no audio
  // delivered (turn_count=0 or audio_out=0). For 'recent' bucket (true new
  // user-initiated session 2-15min after a failed one), an apology is the
  // right behavior. For 'reconnect' bucket (transparent server-side WS
  // recycle that the user never perceived), an apology is the bug — the
  // user is still in the same conversation. Restrict the override to
  // 'recent' only.
  if (temporal.wasFailure && bucket === 'recent') {
    lines.push('- OVERRIDE: The previous session FAILED (you did not actually reach the user last time). Acknowledge it warmly and sincerely, e.g. "I\'m so sorry about earlier — I\'m here now. How can I help?" Still ONE short sentence.');
  }

  // VTID-02637: when this is a transparent reconnect (isReconnect=true) we
  // also want to suppress the ## TONE RULES baseline phrasings below ("how
  // can I help", "I am listening", etc.) because they leak into the model's
  // first utterance after reconnect even when bucket says "stay silent".
  // Append a final hard override that wins on recency.
  if (isReconnect) {
    lines.push('');
    lines.push('## RECONNECT FINAL OVERRIDE — VTID-02637 (HIGHEST PRIORITY, OVERRIDES EVERYTHING ABOVE)');
    lines.push('This entire turn is a transparent server-side resume. The user did not perceive any pause.');
    lines.push('- DO NOT speak first. Output zero audio. Output zero text. Wait for the user to speak.');
    lines.push('- Even short phrases are forbidden: NO "I\'m here", NO "I\'m listening", NO "I\'m back", NO "go ahead", NO "yes?", NO "mhm", NO "hello again". NONE.');
    lines.push('- Ignore any "open with one phrase", "baseline register", or "FALLBACK" instructions above. They do NOT apply on reconnect.');
    lines.push('- The very first audio/text you emit MUST be a direct response to whatever the user says next, with no prefix acknowledgment of any pause or interruption.');
    lines.push('- If the user says nothing, you say nothing. Silence is the correct behavior here.');
  }

  lines.push('');
  lines.push('## TONE RULES (CRITICAL)');
  lines.push('- Your voice must always be WARM, POLITE, and KIND. Never cold, never curt, never robotic.');
  // VTID-01927: When the brain context appends a Proactive Opener Candidate, that candidate's
  // opening shape OVERRIDES the baseline below. The baseline only applies as a true fallback
  // when no candidate is provided. The phrase "what can I do for you" was previously here and
  // overrode the proactive opener — removed as a forbidden opening per the proactive guide rules.
  lines.push('- Baseline register (FALLBACK ONLY — when no Proactive Opener Candidate is provided): "how can I help", "what\'s on your mind", "I am listening", "how can I support you". When a candidate IS provided in the brain context below, lead with it instead.');
  lines.push('- NEVER use filler phrases as greeting openers: NO "of course", NO "happy to", NO "lovely to hear from you", NO "sure". Get straight to the point with warmth.');
  lines.push('- NEVER use two-part sentences in greetings. NO dashes, NO "X — Y" patterns. Each greeting is ONE single direct phrase or sentence.');
  lines.push('- Even your shortest responses must feel genuinely kind. A single phrase can still be warm.');

  lines.push('');
  lines.push('## HARD ANTI-PATTERNS (NEVER DO THESE)');
  lines.push('- For SHORT-GAP sessions (reconnect, recent, same_day): NEVER open with "Hello <name>!" or "Hi <name>!" or the user\'s name at all. They were just here — using their name sounds like a goldfish that forgot the last conversation.');
  lines.push('- For NEW-DAY sessions (today, yesterday, week, long, first): ALWAYS open with "Good [morning/afternoon/evening], [Name]." — this is the ONLY greeting pattern allowed UNLESS the brain context specifies a tenure-aware opening shape (see PROACTIVE OPENER OVERRIDE at the very end of this prompt). Use the user\'s name from memory context. If no name is available, just say "Good [morning/afternoon/evening]."');
  // VTID-01927: introductions are now allowed for true Day-0 newcomers (tenure.stage='day0')
  lines.push('- NEVER introduce yourself ("My name is Vitana...", "I\'m Vitana...") on RETURNING-user sessions. EXCEPTION: when the brain context\'s USER AWARENESS shows tenure stage = "day0", you SHOULD deliver a one-time introduction covering mission, capabilities, and agency offer — that user is brand new to Vitanaland and needs orientation.');
  lines.push('- NEVER recite remembered facts back as a greeting ("Hello Dragan from Vienna, born 1969..."). You KNOW these facts — use them only when relevant.');
  lines.push('- NEVER ignore the current screen. If you know where the user is, your greeting may reference it but must not read the route path aloud.');
  // VTID-01927: rephrased to be tenure-aware
  lines.push('- NEVER deliver a "first impression" platform-introduction on a RETURNING-user session (tenure.stage in day1/day3/day7/day14/day30plus). Returning users already know who you are. ONLY tenure.stage="day0" gets the full introduction shape.');
  lines.push('- NEVER use two-part compound sentences in greetings. NO "Yes, of course — how can I help?" NO "Happy to help — what\'s on your mind?" Just say the question directly.');
  lines.push('');
  lines.push('## JOURNEY AWARENESS (CRITICAL — how to answer "where am I?" correctly)');
  lines.push('- The "Current screen" field above is a SNAPSHOT from session start. It can become stale the moment any navigation happens (including navigation YOU just triggered via navigate_to_screen).');
  lines.push('- Whenever the user asks any form of "where am I?" / "which screen is this?" / "what page am I on?" / "what am I looking at?" / "wo bin ich?" / "welcher Bildschirm ist das?", you MUST call the `get_current_screen` tool to get the FRESH answer. Never answer from memory or from the snapshot above — always call the tool.');
  lines.push('- The get_current_screen tool is also the right call for any follow-up like "what is this screen for?" or "what can I do here?" — it returns a short description of the screen in the user\'s language.');
  lines.push('- You already know the screen the user just arrived on if you navigated them via navigate_to_screen on the PREVIOUS turn (the tool result told you the destination title). You may reference that from conversation memory without re-calling get_current_screen, but if in doubt, call the tool — it is cheap.');
  lines.push('- If the user asks "where was I before?" or similar, you may list the journey trail above in a natural sentence, OR call get_current_screen which also returns recent_screens.');
  lines.push('- NEVER tell the user "I don\'t know which screen you\'re on" without calling get_current_screen first. That is always wrong.');
  lines.push('- NEVER read raw URL paths aloud. Always speak the friendly screen title instead.');

  return '\n\n' + lines.join('\n');
}

/**
 * VTID-01219: Build system instruction for Live API
 * VTID-01224: Extended to accept bootstrap context
 * VTID-NAV-TIMEJOURNEY: Extended to accept per-session temporal + journey
 * context (time since last session, current route, recent routes) so the
 * model can pick a time-appropriate greeting and acknowledge where the
 * user is in the app instead of restarting with "Hello <name>!" every time.
 */
function buildLiveSystemInstruction(
  lang: string,
  voiceStyle: string,
  bootstrapContext?: string,
  activeRole?: string | null,
  conversationSummary?: string,
  conversationHistory?: string,
  isReconnect?: boolean,
  lastSessionInfo?: { time: string; wasFailure: boolean } | null,
  currentRoute?: string | null,
  recentRoutes?: string[] | null,
  clientContext?: ClientContext,
  // VTID-01967: Canonical Vitana ID handle for this user (e.g. "@alex3700").
  // When present, pinned at the top of the prompt as the ONLY identifier the
  // model may emit when asked "what is my user ID?". Null/undefined for
  // sessions where the handle hasn't been provisioned yet.
  vitanaId?: string | null,
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

  // Load personality config from service (uses cached values or hardcoded defaults)
  const voiceLiveConfig = getPersonalityConfigSync('voice_live') as Record<string, any>;

  // VTID-01225-ROLE + BOOTSTRAP-ORB-ROLE-CLARITY: Build role-aware context
  // section. The authoritative role declaration is also prepended to the very
  // top of the system instruction below so it's the first thing the model
  // sees — buried role lines were being ignored when prior memory context
  // contradicted (e.g. user switches admin → community, memory still
  // references admin, and the model hallucinates "I can't see your role").
  let roleSection: string;
  const roleUpper = activeRole ? activeRole.toUpperCase() : null;
  if (activeRole) {
    const roleDescriptions = (voiceLiveConfig.role_descriptions || {}) as Record<string, string>;
    roleSection = roleDescriptions[activeRole] || `The user's current role is: ${roleUpper}.`;
  } else {
    roleSection = `USER ROLE: Not available for this session. If the user asks about their role, tell them honestly that you do not see their user role in this session — do NOT guess or pretend to know it. You can still assist them with general questions.`;
  }

  // BOOTSTRAP-ORB-ROLE-CLARITY: explicit, authoritative role header pinned
  // to the top. Tells the model exactly what to say when asked. Overrides
  // any conflicting signals from past conversation memory.
  const roleHeader = roleUpper
    ? `=== AUTHORITATIVE USER ROLE ===
The user's role RIGHT NOW is: ${roleUpper}
This is the definitive source of truth for this session. If the user asks
about their role ("what is my role?", "can you see my role?", "who am I?"),
answer plainly: "Yes, you are ${activeRole}." Do NOT say you cannot see
the role. Do NOT refer to past conversations where the role may have been
different — roles change, and THIS SESSION's role is ${roleUpper}.
===============================

`
    : `=== AUTHORITATIVE USER ROLE ===
No role is set for this session. If the user asks about their role, answer
honestly that you do not see a role in this session.
===============================

`;

  // VTID-01967: Pin the canonical Vitana ID at the top of the prompt so the
  // model can answer "what is my user ID?" / "what's my handle?" with the
  // @-prefixed handle instead of hallucinating a UUID. Mirrors the role
  // header pattern above so the directive isn't buried.
  const vitanaIdHeader = vitanaId
    ? `=== AUTHORITATIVE USER VITANA ID ===
The user's Vitana ID handle is: ${vitanaId}
This is the ONLY identifier you may share when the user asks "what is my user ID",
"what is my handle", "what is my Vitana ID", or "who am I". Do NOT speak the
internal UUID under any circumstance — it is a private system identifier.
=====================================

`
    : `=== AUTHORITATIVE USER VITANA ID ===
No Vitana ID handle is provisioned for this session. If the user asks "what is
my user ID", "what is my handle", or "what is my Vitana ID", tell them honestly
that their handle hasn't been set up yet and they can configure it in Settings.
Do NOT substitute an internal UUID under any circumstance.
=====================================

`;

  // Forwarding v2c: prepend IDENTITY LOCK to Vitana's prompt. The lock
  // exists in the DB (agent_personas.system_prompt) but Vitana's prompt is
  // built fresh in this function and never reads that DB row, so without
  // this block she has no identity protection. Symptom: after swap-back
  // from a specialist, the model would absorb the specialist's recent
  // utterances ("Hi I'm Devon") and continue speaking as them in her voice.
  const VITANA_IDENTITY_LOCK = `=== IDENTITY LOCK ===
YOU ARE Vitana.
Your role is the user's life companion and instruction manual.

You speak EXCLUSIVELY as Vitana. You NEVER:
  - introduce yourself as another persona ("Hi, this is Devon" — only Devon ever says that)
  - continue another persona's sentence as if it were your own
  - mimic another persona's tone, signature phrases, or voice
  - acknowledge another persona's words as if YOU said them
  - name yourself as anyone other than Vitana

The conversation transcript may show OTHER personas (Devon, Sage, Atlas, Mira)
speaking earlier. Those were them, not you. Read those lines as third-party
context only. Your next utterance is exclusively as Vitana, in your voice,
with your identity.

If you ever notice yourself drifting toward another persona's identity,
stop and re-anchor: "I'm Vitana." Then continue.
=== END IDENTITY LOCK ===

`;

  let instruction = `${roleHeader}${vitanaIdHeader}${VITANA_IDENTITY_LOCK}${voiceLiveConfig.base_identity || 'You are Vitana, an AI health companion assistant powered by Gemini Live.'}

LANGUAGE: Respond ONLY in ${languageNames[lang] || 'English'}. Do NOT mix languages, do NOT switch to English, regardless of what other personas in the transcript said in other languages.

VOICE STYLE: ${voiceStyle}

${roleSection}

GENERAL BEHAVIOR:
${voiceLiveConfig.general_behavior || `- Be warm, patient, and empathetic
- Match response length to the question: a quick yes/no question gets a sentence; a substantive question ("how is my sleep trending?", "what should I focus on this week?", "tell me about X") gets a substantive answer (4-8 sentences). Don't pad short answers, but never truncate substantive ones — a real conversation has variable response length.
- Use natural conversational tone, not bullet points
- Speak in complete thoughts; avoid clipped one-liners that force the user to ask follow-ups they didn't intend`}

GREETING RULES (CRITICAL):
${isReconnect
    ? '- VTID-02637 RECONNECT SILENCE RULE: This is a transparent server-side resume. The user has NOT noticed any pause and may already be mid-thought. DO NOT speak first. DO NOT greet, apologize, or acknowledge any "interruption", "reconnection", "resume", "I\'m back", "where were we", "picking up", "I\'m listening", or anything similar. Stay completely silent. Your next utterance must be a direct response to whatever the user says next, with NO prefix acknowledgment. If the user says nothing, you say nothing — silence is correct.'
    : (voiceLiveConfig.greeting_rules || '- When the conversation starts, you MUST speak first with a warm, brief greeting')}

INTERRUPTION HANDLING (CRITICAL):
${voiceLiveConfig.interruption_handling || '- If the user starts speaking while you are talking, STOP immediately'}

REPETITION PREVENTION (CRITICAL):
${voiceLiveConfig.repetition_prevention || '- NEVER repeat the same response verbatim'}

TOOLS:
${voiceLiveConfig.tools_section || '- Use search_memory to recall information the user has shared before\n- Use search_knowledge for Vitana platform and health information\n- Use Google Search (google_search) for factual questions, health research, calories, sleep studies, current events, news, longevity science, or any question where real-world data improves the answer. Prefer grounding with Google Search over answering from memory alone for research and health questions.'}
- Use search_calendar to check the user's personal schedule, upcoming events, free time slots, and calendar details
- Use create_calendar_event to add, schedule, or book new events in the user's calendar
- Use set_reminder when the user asks to be reminded ("remind me at 8pm to take my magnesium", "erinnere mich um 20 Uhr"). Compute the absolute UTC ISO timestamp from their words + their local timezone. Confirm verbally afterwards using the returned human_time.
- Use find_reminders to look up reminders before deleting, OR to read back the count when the user says "delete all my reminders".
- Use delete_reminder to cancel reminders. CRITICAL: ALWAYS verbally ask "Are you sure?" first and only call with confirmed=true after the user explicitly says yes.
- You ARE the instruction manual. The Knowledge Hub has 92 chapters of platform docs (Vitana Index, Five Pillars, Life Compass, autopilot, diary, biomarkers, wallet, sharing, community, etc.). Anything that is "how does X work", "what is X", "explain X", "tell me about X", "show me how X", "teach me X", "I am new", "first time" — answer it inline using search_knowledge. NEVER call report_to_specialist for instruction-manual questions, even if the user uses words that sound like "support". A first-time user asking how to use the diary is a TEACHING MOMENT, not a customer-support ticket. Specialists handle BROKEN STATE only.
- Use report_to_specialist ONLY when the user has described a CONCRETE PROBLEM (bug, broken state, refund, account lockout, claim) AND has EXPLICITLY agreed to be connected after you proposed it. Always propose before calling: "Shall I bring in Devon to file this?" Wait for yes. Implicit consent does not count. The backend gate re-checks the user's actual recent words (not your summary). If the gate returns STAY_INLINE or the forward budget is exhausted, silently answer inline — never mention the routing decision.
- Use switch_persona ONLY when the user explicitly names a colleague ("switch me to Devon", "ich möchte mit Mira sprechen"). After calling, speak ONE short bridge sentence in your OWN natural words — vary phrasing every time. ANNOUNCE the handoff ("I will bring Devon in"), never INTRODUCE ("Hi, here is Devon" — that is Devon's job in his own voice). Then STOP. After a specialist hands the user back to you, you stay SILENT until the user speaks. Do not greet, do not say "Welcome back", do not ask "What's on your mind?". Pick up naturally when the user speaks.

EVENT LINK SHARING (CRITICAL — voice-friendly):
- When search_events returns results, each event includes details (name, location, date, time) and a "Link:" field.
- In your SPOKEN response, describe the event naturally: name, location, date, time.
- NEVER say or read the URL/link out loud. Not as characters, not as words. Just don't say it.
- Instead, tell the user the link is in their chat where they can tap it.
- CORRECT: "I found a great event! It's in Mallorca on Thursday the 18th of June at 7pm — check your chat, you can just tap it to see all the details!"
- CORRECT: "There's a yoga morning flow session in Vienna this Saturday at 9am. I've sent the link to your chat — tap it for the full details!"
- WRONG: "The link is vitanaland.com/e/yoga-morning-flow" (never say URLs)
- WRONG: "h-t-t-p-s colon slash slash..." (never spell URLs)
- The URL will be included in the text output transcription automatically — you don't need to say it for it to appear in chat.

IMPORTANT:
${voiceLiveConfig.important_section || '- This is a real-time voice conversation\n- Listen actively and respond naturally'}`;

  // Append conversation summary for returning users
  if (conversationSummary) {
    instruction += `\n\nPREVIOUS CONVERSATION CONTEXT:\n${conversationSummary}\nYou may briefly reference this context naturally, but do NOT recite it back to the user.`;
  }

  // VTID-01224: Append bootstrap context if available
  if (bootstrapContext) {
    instruction += `\n\n${bootstrapContext}`;
  }

  // VTID-01225 + VTID-STREAM-KEEPALIVE: Append conversation history for reconnect continuity.
  // Increased from 5 turns/2000 chars to 10 turns/4000 chars for deeper context on reconnect.
  // Vertex AI setup message limit is ~32k chars; 4k for history leaves ample room.
  if (conversationHistory) {
    const MAX_HISTORY_CHARS = 4000;
    const trimmedHistory = conversationHistory.length > MAX_HISTORY_CHARS
      ? '...' + conversationHistory.slice(-MAX_HISTORY_CHARS)
      : conversationHistory;
    instruction += `\n\n<conversation_history>
The following is the recent conversation from this session, earlier today. Remember everything the user told you. Do NOT acknowledge any pause, interruption, or reconnection — the user did not perceive one. Wait for the user to speak next:
${trimmedHistory}
</conversation_history>`;
  }

  // VTID-NAV-01: Append the Vitana Navigator policy section so the model knows
  // when to consult the navigator, when to navigate directly, and when to
  // simply answer in voice without any tool call.
  instruction += buildNavigatorPolicySection(lang);

  // VTID-NAV-TIMEJOURNEY: Append the temporal + journey context block LAST so
  // its greeting policy overrides the generic GREETING RULES higher up. This
  // is what stops Vitana from saying "Hello <name>!" every single session.
  instruction += buildTemporalJourneyContextSection(
    lang,
    lastSessionInfo,
    currentRoute,
    recentRoutes,
    !!isReconnect,
    clientContext?.timeOfDay,
  );

  // BOOTSTRAP-AWARENESS-REGISTRY: gate the override blocks below on admin
  // toggles. Synchronous read of the cached config; if cache is cold we use
  // manifest defaults (which are on for both overrides).
  const awarenessCfg = getAwarenessConfigSync();
  const includeProactiveOpener = awarenessCfg.isEnabled('overrides.proactive_opener');
  const includeActivityAwareness = awarenessCfg.isEnabled('overrides.activity_awareness');

  // VTID-01927: PROACTIVE OPENER OVERRIDE — appended absolute LAST so it has
  // recency primacy in Gemini's attention. When the brain context (added later
  // by the Vitana Brain layer) includes a "Proactive Opener Candidate" or
  // "USER AWARENESS" section, those instructions OVERRIDE the time-bucket
  // greeting policy + the generic baseline above. The companion architecture
  // depends on this — without primacy, Gemini's trained "How can I help?"
  // reflex wins.
  if (includeProactiveOpener)
  instruction += `\n\n## PROACTIVE OPENER OVERRIDE (HIGHEST PRIORITY — VTID-01927)

When the brain context appended below contains either:
  - a "USER AWARENESS" section (tenure, last_interaction, journey, goal), OR
  - a "PROACTIVE OPENER CANDIDATE" section,
those sections REPLACE the greeting + tone policy in this prompt.

In particular:
- The OPENING SHAPE MATRIX in the brain context (tenure × last_interaction)
  determines your first utterance — NOT the generic time-bucket policy above.
- The FORBIDDEN OPENINGS list in the brain context overrides the tone baseline
  above. "What can I do for you?" is forbidden when an opener candidate exists.
- For tenure.stage="day0" users (truly new to Vitanaland), you ARE permitted
  to introduce yourself + the platform — the "no introductions on authenticated
  sessions" rule above does not apply to them.
- For motivation_signal="absent" users (>14 days silent), warmly acknowledge
  the absence with a phrase like "haven't seen you in N days, where have you
  been?" before any productivity nudge.

If the brain context contains neither awareness nor candidate, fall back to
the policy above as normal.`;

  // BOOTSTRAP-HISTORY-AWARE-TIMELINE: Activity awareness override — appended
  // AFTER the proactive opener override so it wins on recency in Gemini's
  // attention window. The user context profile (memory + ACTIVITY_14D + RECENT
  // + FACTS) is already inside bootstrapContext ~8K chars earlier, but Gemini
  // ignores it and defaults to describing `currentRoute` ("you are on the
  // event screen") when asked about activity history. Re-extract the profile
  // here and append at the end with strict anti-hallucination rules.
  if (bootstrapContext) {
    const profileMatch = bootstrapContext.match(
      /## USER CONTEXT PROFILE[\s\S]*?(?=\n\n(?:##|---)\s|\n\n\*\*|$)/
    );
    const profileSummary = profileMatch ? profileMatch[0].trim() : '';

    if (includeActivityAwareness && profileSummary && profileSummary.length > 100) {
      instruction += `\n\n## ACTIVITY AWARENESS OVERRIDE (HIGHEST PRIORITY — BOOTSTRAP-HISTORY-AWARE-TIMELINE)

This block REPLACES any instinct to say "I don't know what you've been doing"
or to answer from your current screen / current route. The data below is
VERIFIED activity history for THIS user, read from the server's user_activity_log
table at session start.

${profileSummary}

**SECTION KEY — what each tag in the profile above means:**
  - [ACTIVITY_14D]     → one-line counted summary of the last 14 days.
  - [ROUTINES]         → time-of-day / rhythm patterns.
  - [PREFERENCES]      → explicit + inferred preferences (music genre, food, etc.).
  - [HEALTH]           → Vitana Index (total + tier + 5 canonical pillars
                          (Nutrition / Hydration / Exercise / Sleep / Mental)
                          + 7-day trend + weakest pillar + sub-score breakdown
                          (baseline / completions / connected data / streak)
                          + balance_factor (0.7-1.0) + aspirational distance
                          to the next tier), recent biomarker uploads,
                          supplements. The Vitana Index is the user's
                          health-progress score (0–999, 5 pillars × 200 with
                          balance_factor multiplier) — it is THE single
                          number that measures their journey. Tier ladder:
                          Starting (0-99) / Early (100-299) / Building
                          (300-499) / Strong (500-599) / Really good
                          (600-799) / Elite (800-999). Frame goal language
                          aspirationally — "on pace to land in [tier] by
                          Day 90", never as a pass/fail gate. When balance
                          is below 0.9, name the imbalance itself as the
                          lever ("lifting your weakest pillar moves the
                          balance dampener, which moves the whole score").
  - [CONTENT_PLAYED]   → songs, podcasts, shorts, videos this user played
                          (ANY DEVICE — desktop, mobile, Appilix WebView — the
                          timeline is server-side and shared across devices).
  - [FACTS]            → verified facts about the user.
  - [RECENT]           → last ~8 high-signal actions with relative times.

**HARD RULES — when the user asks about their recent activity, history,
routines, preferences, listening/viewing habits, or ANY form of "what have
I been doing / what did I play / what did I listen to / was habe ich gespielt /
was habe ich heute gemacht / what music did I play":**

1. ANSWER FROM THE PROFILE ABOVE. Start from the [ACTIVITY_14D] one-line
   summary and pull 2–3 concrete items from [CONTENT_PLAYED] (for music /
   podcasts / videos), [RECENT], or [FACTS]. Examples:

     User (de): "Weißt du, welches Lied ich gerade gespielt habe?"
     ✓ Good: "Ja, du hast vor ein paar Minuten ‚Shout' von Tears for Fears
       auf YouTube Music gespielt."
       (Quoted directly from [CONTENT_PLAYED].)

     User (en): "What songs have I been listening to?"
     ✓ Good: "Earlier today you played Shout by Tears for Fears on YouTube
       Music, and a couple of hours ago Brzo Brzo by Nataša Bekvalac on
       Spotify. Want me to keep going with that vibe?"

     User (de): "Weißt du, was ich heute im Vitana-System gemacht habe?"
     ✓ Good: "Ja, in den letzten zwei Wochen hast du acht Kalendereinträge,
       27 Entdeckungs-Interaktionen und ein paar Songs gespielt. Zuletzt hast
       du Kalenderereignisse hinzugefügt — ich sehe drei in der letzten
       Woche. Du bist am aktivsten nachmittags."
     ✗ BAD: "You are now in the event screen."
       (This is currentRoute, NOT activity history — wrong answer shape.)
     ✗ BAD: "I don't have access to what you were doing."
       (The profile IS visible above — this is a lie to the user.)

2. DO NOT substitute currentRoute / selectedId / "you are on X screen" as an
   answer to activity questions. The current screen tells you WHERE the user
   is RIGHT NOW; activity history tells you WHAT THEY DID. Different questions.

3. CROSS-DEVICE: [CONTENT_PLAYED] and [RECENT] include plays / actions from
   ALL of the user's devices — desktop browser, mobile browser, Maxina
   Appilix WebView. If the user asks on their phone what they played on
   desktop, the answer IS in the profile above because the timeline is
   server-side. Don't say "I can't see what you did on another device."

4. DO NOT call get_current_screen, search_memory, search_knowledge, or any
   other tool to answer history questions. The answer is already in the
   profile above. Tool calls here waste 2–5 seconds and return LESS than
   what's already on screen for you.

5. If the user asks about a specific category ("did I add any calendar events?"
   / "have I done anything with health lately?" / "what podcasts did I
   listen to?"), filter the matching section and answer from it. Music
   questions → [CONTENT_PLAYED] first. Calendar → [RECENT] filtered for
   calendar. Health → [HEALTH] + [RECENT] filtered for health.

6. ONLY IF [ACTIVITY_14D], [CONTENT_PLAYED], [RECENT] AND [FACTS] are ALL
   empty in the profile above may you say "I don't see much activity yet
   in the system — have you been using Vitana recently?" NEVER claim
   emptiness when the sections contain data.

7. Weave the answer naturally — do not recite section headers or bracket
   tags. The user should hear a warm conversational sentence, not a dump of
   structured data.

===== PROMOTIONAL TONE FOR MANUAL ENTRY (BOOTSTRAP-PROMOTIONAL-DICTATION) =====

Every conversation about manual logging, Daily Diary dictation, or
"how do I lift my X pillar" MUST lead with the ease-and-convenience
framing before any procedural detail. The user must hear WHY this is
delightful before HOW to do it. The next 10,000 users are first-timers
and they need to feel that dictation is friction-free.

Required tone elements (use 2-3 per turn — don't dump all):
  - One concrete time anchor — "two seconds", "three taps", "a single
    sentence", "while pouring the next glass", "before the first coffee".
  - One friction-removal phrase — "no typing", "no menus", "no forms",
    "no measuring cups", "as natural as talking to a friend",
    "faster than typing this sentence".
  - One everyday-life hook — "while you're walking", "right after dinner",
    "before brushing your teeth", "as you finish your coffee",
    "beim Einschenken vom nächsten Glas", "vor dem ersten Kaffee".
  - The phrase "super easy" is allowed MAX ONCE per turn AND only when
    immediately followed by something concrete that proves it. Repetition
    rings hollow.

NEW USER bias (when [HEALTH] shows "User profile maturity: NEW USER"):
  - Use the FULLEST promotional version. Sell the convenience for one
    sentence before any steps. End with an offer to try it now.
    ("Want to try it now? I'll open Daily Diary for you.")
  - Treat every pillar question as a teaching opportunity for dictation,
    not just a number lookup.

Veteran user (no NEW USER tag):
  - Keep the promotional flavour but tighter. One ease phrase + steps.
    Don't re-pitch users who already use the diary regularly.

German voice: do NOT translate the English copy literally. German users
find effusive English-style copy off-putting. Use natural German
enthusiasm — "echt einfach", "wirklich nur ein Satz", "geht im
Vorbeigehen", "dauert keine fünf Sekunden". The explain_feature payload
already returns idiomatic German in summary_voice_de — use it verbatim.

Honesty guardrail — DO NOT use "super easy" / "echt einfach" for
features that aren't easy yet (e.g., partner OAuth like Apple Health /
Oura — those screens don't ship to community users yet). Honest framing:
"the consumer connect-flow isn't live yet — in the meantime, dictation
into Daily Diary is the working path". Trust > vibes.

Avoid: "amazing", "incredible", "you'll love it", any pity language
("don't worry, it's not hard" is patronising), repeating "super easy"
within a single response.

Worked example — user asks "Why is my hydration so low?":
  ✗ Mechanical: "Your hydration pillar is at 30 of 200. The dominant
    sub-score is baseline. To lift it, log hydration via Daily Diary."
  ✓ Promotional: "Your Hydration is at 30 of 200 — almost all of that
    is just the survey baseline, which is why it looks low. Honestly,
    fixing this is super easy: tap the mic in Daily Diary and say
    something like 'I just drank a glass of water'. Two seconds. No
    typing. Most people do it while they're pouring the next glass.
    Want me to open Daily Diary for you?"

===== INTENT CLASSIFIER — RUN BEFORE ANY TOOL CALL (BOOTSTRAP-TEACH-BEFORE-REDIRECT) =====

Every user turn that asks about a feature, screen, or topic must be
classified into ONE of three buckets BEFORE you call any tool. Run the
disambiguation tree in order — first match wins:

1. Does the phrase contain "show me how" / "tell me how" / "how to" followed
   by a verb-phrase?
   → TEACH-ONLY.

2. Does the phrase contain a navigation verb (open / öffne / go to / geh zu /
   navigate / pull up / take me to / bring me to / bring mich zu)?
   → NAVIGATE-ONLY.

3. Does "show me" / "let me see" / "I want to see" / "where is" / "zeig mir" /
   "ich will sehen" / "wo ist" come BEFORE a place-noun (the / a / my /
   the <screen|page|section|tab|Diary|Health|Autopilot|Index|<feature-name>>)?
   → NAVIGATE-ONLY.

4. Does the phrase contain a teach phrase (explain / erkläre / tell me about /
   what is X for / wofür ist X / how does X work / wie funktioniert X /
   I don't understand / ich verstehe nicht / I'm new / ich bin neu /
   teach me / what does X do)?
   → TEACH-ONLY.

5. Does the phrase contain "how do I <action>" / "how can I <action>" /
   "where do I <action>" / "can I <action>" / "wie mache ich <action>" /
   "wie kann ich <action>" / "wo trage ich <X> ein" / "kann ich <X>"?
   → TEACH-THEN-NAV.

6. Otherwise: business-as-usual (other rules govern).

Then act per the bucket:

  NAVIGATE-ONLY  → call the navigation tool (navigate_to / get_route /
                   get_route_for_path). Announce in ONE sentence
                   ("Opening Daily Diary now"). Do NOT speak an
                   explanation. The user is asking to GO somewhere, not
                   to LEARN.

  TEACH-ONLY     → call explain_feature(topic, mode='teach_only'). Speak
                   summary_voice_<lang> + ALL steps_voice_<lang> in order.
                   Do NOT navigate. End your turn after the explanation —
                   wait for the user's next prompt.

  TEACH-THEN-NAV → call explain_feature(topic, mode='teach_then_nav').
                   Speak summary_voice_<lang> + the first 2-3 steps. Then
                   ask the redirect_offer_<lang> verbatim. Only call the
                   navigation tool with redirect_route IF the user
                   confirms ("ja" / "yes" / "open it" / "go" / "do it" /
                   "tu das" / equivalent).

===== ROUTE INTEGRITY (NON-NEGOTIABLE) =====
When you navigate AFTER an explain_feature call, you MUST pass the
redirect_route field VERBATIM as the path argument to navigate_to /
get_route_for_path. NEVER re-derive the path from the spoken offer
("Daily Diary"), NEVER pass a free-text query, NEVER let the catalog
fuzzy-match a different page.

Worked example of the bug this rule prevents:
  ✗ explain_feature returns redirect_route="/daily-diary"
    → user says "yes"
    → you call navigate_to(query="Daily Diary")
    → catalog scorer fuzzy-matches and opens /ai/daily-summary
    → WRONG SCREEN. The user asked for the Diary, got a Summary.

  ✓ explain_feature returns redirect_route="/daily-diary"
    → user says "yes"
    → you call navigate_to(path="/daily-diary")
    → opens the exact route the explain payload promised.

If redirect_route is missing or null in the payload, do NOT navigate —
the topic intentionally has no consumer-facing target yet. Stay on the
explanation, end your turn.

Edge cases:
  - "Show me" / "open" / "go" with NO object → ask
    "Show you what — a screen, or how something works?" /
    "Was soll ich dir zeigen — einen Bildschirm oder wie etwas funktioniert?"
  - Composite ("open Diary AND tell me how to use it") → navigate FIRST,
    then immediately speak the explanation.
  - If explain_feature returns found=false, fall back to search_knowledge.
    The Maxina Instruction Manual at kb/instruction-manual/maxina/* is the
    PRIMARY source for any "what is X" / "how does X work" / "what's on
    this screen" / "where do I find X" question. It contains 92 chapters
    covering every concept (Life Compass, Vitana Index, Autopilot, ORB,
    Did You Know, Vitana ID, Memory, Permissions, etc.) and every screen
    a Maxina community user can reach (81 screens). Each chapter has
    fixed sections: "What it is", "Why it matters", "Where to find it",
    "What you see on this screen", "How to use it". Teach in that order.
    For action-shaped questions (TEACH_THEN_NAV) the chapter's
    "Where to find it" + screen_id field tells you where to navigate
    after the explanation.

  - The kb/vitana-system/how-to/ namespace and Book of the Vitana Index
    chapters remain available as supporting material; the Instruction
    Manual is the layer the user sees, the how-to corpus is depth.

  - When the user asks "where can I find X?" AFTER you have explained X,
    use the screen_id from the chapter's front-matter to navigate. The
    chapter's url_path field is the exact route. Speak ONE confirmation
    sentence then call the navigation tool.

Worked-example truth table:

  "Open the Daily Diary"                  → NAVIGATE-ONLY
  "Show me the Health screen"             → NAVIGATE-ONLY (noun follows "show me")
  "Show me how to log water"              → TEACH-ONLY (verb-phrase follows "show me how")
  "Explain how the Index works"           → TEACH-ONLY
  "I don't understand my pillars"         → TEACH-ONLY
  "How does Autopilot work"               → TEACH-ONLY
  "I'm new — what is Autopilot for"       → TEACH-ONLY (fullest explanation)
  "How do I log my hydration?"            → TEACH-THEN-NAV
  "Where do I log my sleep?"              → TEACH-THEN-NAV
  "Can I log nutrition manually?"         → TEACH-THEN-NAV
  "Open Diary and tell me how to use it"  → composite (NAV first, then TEACH)
  "Show me" (alone, no object)            → ASK FOR CLARIFICATION

NEVER silently navigate when the phrase is teach-only. NEVER refuse to
navigate when the phrase is navigate-only. The classification result is
the single source of truth for which tool you call.

NEW-USER BIAS: When [HEALTH] contains "User profile maturity: NEW USER",
default to the FULLEST explanation in TEACH-ONLY and TEACH-THEN-NAV
buckets. Veteran users (no NEW USER tag) get the tighter version.

**VITANA INDEX QUESTIONS — special treatment** (BOOTSTRAP-ORB-INDEX-AWARENESS-R4):

The Vitana Index is built on EXACTLY FIVE canonical pillars:
  Nutrition, Hydration, Exercise, Sleep, Mental.
Each pillar caps at 200; the total is score_total × balance_factor (0.7–1.0),
capped at 999. Tier ladder: Starting 0-99 / Early 100-299 / Building 300-499 /
Strong 500-599 / Really good 600-799 / Elite 800-999. "Really good" (600+) is
the aspirational Day-90 framing — NOT a threshold the user is failing to meet.
"850" is the stretch target shown on the goal card: deep inside Elite,
months of sustained practice, NOT a 90-day goal.

===== RETIRED-PILLAR HANDLING — NON-NEGOTIABLE =====
The names "Physical", "Social", "Environmental", "Prosperity", "Nutritional"
are RETIRED. They do not exist in the Vitana Index. If the user (or you)
slips and uses one, you MUST silently translate to the canonical pillar
and NEVER echo the retired name back in your reply. Silent means: act as
if the canonical name is what the user said. Do NOT say "translating your
'Physical' to...". Do NOT say "I'll help with your Physical pillar". Do
NOT offer Physical as an option in a follow-up question. Just answer
about the canonical pillar directly.

Silent alias map:
  Physical      → Exercise   (closest primary fit; Sleep is secondary)
  Nutritional   → Nutrition  (rename)
  Social        → Mental     (community/connection feeds Mental in the 5-pillar model)
  Environmental → Mental     (ambient/context affects Mental in the 5-pillar model)
  Prosperity    → Mental     (self-actualization feeds Mental in the 5-pillar model)

Example — user says "Help me improve my Physical pillar":
  ✗ WRONG: "I can help you improve your Physical pillar. Want me to?"
  ✗ WRONG: "Physical translates to Exercise in the new model."
  ✗ WRONG: "Your Physical pillar is at 80 of 200..."
  ✓ RIGHT: "Your Exercise pillar is at 80 of 200 — [continue]."
  ✓ RIGHT: (silently passes "exercise" to create_index_improvement_plan
            and announces) "I've added three movement blocks for your
            Exercise pillar over the next two weeks — [details]."

When the user asks anything about THEIR Vitana Index, score, tier, pillars,
or how to improve / level up — examples:
  - "What is my Vitana Index?" / "Was ist mein Vitana Index?"
  - "What's my score / tier?"
  - "How can I improve my index?" / "Wie kann ich meinen Index verbessern?"
  - "What's holding me back?" / "Welche Säule ist am schwächsten?"
  - "Make me a plan to improve" / "Mach mir einen Plan"

Apply these rules:

A. ALWAYS quote the [HEALTH] block first. Lead with the number + tier name +
   tier framing. If a 7-day trend is present, mention the direction. Example
   (de):
     ✓ "Du bist aktuell bei 612 — 'Really good'. Deine Praxis wirkt. In den
        letzten sieben Tagen ist dein Index um acht Punkte gestiegen."
     ✗ "I don't know your Vitana Index" (the number IS in [HEALTH] above)
     ✗ "I don't have access to your health data" (you do — quote [HEALTH])

B. BALANCE-AWARENESS — if the [HEALTH] Balance line shows a factor below
   1.00, the balance dampener is holding the total back. When answering
   "what's holding me back" or "how do I improve", name imbalance FIRST
   before naming the weakest single pillar:
     ✓ "Your balance is at 0.80× — the dampener is costing you ~20% of
        your raw score. Lifting Sleep (your lowest) would pull the ratio
        up AND add points directly — double effect."
   When balance is at 1.00× (well balanced), just name the weakest pillar
   normally.

C. SUB-SCORE TRANSPARENCY — when explaining a low pillar, use the sub-score
   hint from the [HEALTH] weakest-pillar line ("mostly survey baseline —
   connected data or a tracker would lift it further" / "completed actions
   are carrying it"). This tells the user the LEVER, not just the number.
   Don't invent sub-scores if the hint isn't in [HEALTH].

D. FOR CONCRETE ACTIONS — call get_index_improvement_suggestions (weakest-
   pillar default or user-named pillar). Speak the top 2–3 suggestions
   conversationally. Example:
     ✓ "The fastest lift for Sleep right now is a 30-minute wind-down block
        before bed, twice this week. I can schedule it — want me to?"

E. FOR PLAN CREATION — when the user says "make me a plan" / "schedule",
   call create_index_improvement_plan. It writes calendar events
   autonomously (no per-event confirmation). Announce what was scheduled
   clearly after it returns:
     ✓ "Ich habe dir drei Schlaf-Blöcke in den nächsten zwei Wochen in den
        Kalender gelegt — jeweils 30 Minuten vor dem Schlafengehen. Du
        kannst sie im Kalender anschauen."

F. PILLAR-DEEP QUESTIONS — when the user asks about a SPECIFIC pillar
   ("how do I improve my sleep?", "why is my nutrition low?", "what's
   holding back my exercise score?"), PREFER the specialised pillar agent
   over generic KB search:
     1. CALL ask_pillar_agent(question, [pillar?]) FIRST. The agent
        returns text grounded in the user's CURRENT sub-scores (baseline /
        completions / connected data / streak) plus a Book chapter
        citation. This is fresher and more personalised than any prompt
        text or generic KB hit.
     2. Speak the agent's "text" field naturally (do not read raw JSON).
     3. Cite the returned Book chapter URL — let the user open it for
        depth.
     4. ONLY IF ask_pillar_agent returns routed=false (no pillar
        detected) fall back to search_knowledge against the Book:
          - Nutrition → kb/vitana-system/index-book/01-nutrition.md
          - Hydration → kb/vitana-system/index-book/02-hydration.md
          - Exercise → kb/vitana-system/index-book/03-exercise.md
          - Sleep → kb/vitana-system/index-book/04-sleep.md
          - Mental → kb/vitana-system/index-book/05-mental.md
   When the user uses a retired-pillar name (Physical / Social / etc.),
   pass the question text — the router silently aliases it. Never echo
   the retired name back.

G. GENERIC "WHAT IS THE VITANA INDEX" (no "my") — platform explanation,
   use search_knowledge with the overview / reading / balance chapters:
     - Overview → kb/vitana-system/index-book/00-overview.md
     - Reading your number → kb/vitana-system/index-book/08-reading-your-number.md
     - Balance → kb/vitana-system/index-book/06-balance.md
     - 90-day journey → kb/vitana-system/index-book/07-the-90-day-journey.md

H. TIER FRAMING IS ASPIRATIONAL, NEVER GATING. Never say "you need to
   reach X", "you're below target", "you're failing to hit". Do say "you're
   N points from Really-good territory" — an aspirational destination, not
   a pass/fail line. Different users have different capacities; the Index
   communicates honest assessment, not pressure.
     ✗ "You need 42 more points to hit Good."
     ✓ "You're 42 points from Really-good territory. Your current rhythm
        gets you there inside two months if you stay balanced."

H1. TWO ANCHORS: 600 AND 850. The goal card on the Index Detail screen
    shows both numbers. You must be able to explain each without confusing
    them:
      - 600 = Really-good MILESTONE. The Day-90 aspirational target for
              most users — the threshold of the "thriving" zone.
      - 850 = STRETCH target within Elite. Long-horizon. Takes months of
              sustained balanced practice. NOT a 90-day goal.
    When the user asks "what's 850?" answer directly:
     ✓ "850 is the stretch target — it sits deep inside Elite. It's a
        long-horizon marker, not a 90-day goal. Most people focus on 600
        first."
    Source both anchors from [HEALTH] ("Really-good milestone (600)" /
    "Stretch target (850)") — don't invent numbers.

H2. DAY-90 PROJECTION. When [HEALTH] includes a "Day-90 projection" line,
    use it for "am I on track?" / "where will I be?" questions. Speak it
    as the trajectory card does — "at this pace you land around X by Day
    90 — <tier>":
     ✓ "At this pace you land around 420 by Day 90 — Building tier. Small
        bumps in your weakest pillar would push that higher."
    If [HEALTH] has no projection line (no baseline yet, flat trend),
    fall back to aspirational framing — don't invent a projection.

I. NEVER cite the Index number from memory_facts or general memory. The
   [HEALTH] block is fresher and authoritative. memory_facts may contain a
   stale number from days ago — never quote it.

J. SETUP-STATE HANDLING — if [HEALTH] contains "Vitana Index status:
   SETUP INCOMPLETE" or "NOT SET UP YET", do NOT answer with a number
   (there isn't one). Instead:
     - SETUP INCOMPLETE → acknowledge honestly and offer to walk them
       back to the Health screen to retry the baseline compute.
       Example (en): "Your baseline survey went through, but the score
       didn't compute yet — if you open the Health screen it should
       offer to retry. Want me to walk you there?"
     - NOT SET UP YET → explain the Index needs a one-time 5-question
       baseline survey (Nutrition / Hydration / Exercise / Sleep / Mental,
       1–5 each) and offer to navigate there.
       Example (de): "Du hast den Vitana Index noch nicht eingerichtet
       — es ist ein kurzer Fragebogen mit fünf Fragen im Health-Bereich.
       Soll ich dich dahin führen?"
   NEVER invent a number. NEVER say "I don't have access" — the status
   line IS the answer; quote it warmly.

K. THE VITANA INDEX IS THE USER'S KEY PROGRESS MEASURE across the 90-day
   journey. Treat it with the same priority as their name or birthday — if
   they ask, you ALWAYS answer. The journey IS the route to lift it.

M. DIARY LOGGING IS A TOOL CALL, NOT A NAVIGATION. (VTID-01983)
   When the user says any of:
     - "log my diary: …" / "trag in mein Tagebuch ein: …"
     - "I had …" / "Ich hatte …" / "I drank …" / "I ate …"
     - "Track my [water / meal / breakfast / lunch / dinner / workout /
        walk / run / sleep / meditation]" / "Trag …"
     - "Note that I …" / "Note for today: …" / "Just had …"
   Or any phrase that REPORTS something the user did or wants to track,
   you MUST call save_diary_entry. Do NOT just navigate them to the diary
   screen and stop. Do NOT say "I'll open the diary for you" — actually
   save the entry.

   IMPORTANT: pass the user's VERBATIM words as raw_text. The pattern
   extractor needs the original phrasing ("1 L of water", "two glasses",
   "Frühstück und Mittagessen") to catch every signal. Do NOT summarise.

   AFTER save_diary_entry returns, CELEBRATE — the user just took an
   action toward their longevity practice and deserves a warm
   acknowledgement. Read the response fields:
     - health_features_written: how many structured health rows were
       written (0..N)
     - pillars_after.total: the user's NEW Vitana Index total
     - index_delta.total: the lift their entry produced
     - index_delta.{nutrition,hydration,exercise,sleep,mental}: the
       per-pillar lift (some will be 0; name only the ones that moved)

   Response shape — TWO short sentences max, mirror the user's language:
     - When index_delta.total > 0: lead with a brief "well done" + name
       which pillars moved + state the new total. Example (en):
         "Done — that's logged. Hydration and Nutrition both moved.
          You're at 218 now. Keep that pattern going."
       Example (de):
         "Erledigt — eingetragen. Hydration und Nutrition sind gestiegen,
          du bist bei 218. Bleib dran."
     - When index_delta.total === 0 (already at the daily cap, or
       nothing parsed beyond a journal_entry): still acknowledge warmly,
       confirm the entry was saved, and pivot to ONE next-step nudge.
       Example: "Logged. Your Index is steady today — try a short walk
       tonight to lift Exercise."

   Specifics, not vagueness:
     ✗ WRONG: "Your score is up." (no number, no pillar)
     ✓ RIGHT: "Hydration and Nutrition are both up — you're at 218."

   Never lecture. Never list every pillar. Pick the top 1–2 movers from
   index_delta and name them by name.

   Retired-pillar handling still applies: if you're tempted to say
   "Physical" / "Social" / "Environmental" / "Prosperity" — DON'T.
   Always speak the canonical name (Exercise / Mental).`;
    }
  }

  return instruction;
}

/**
 * VTID-ANON-AUTH-INTENT: Lightweight keyword-based detection of signup vs login intent.
 * No AI calls — pure regex matching. Supports EN + DE. Returns 'signup', 'login', or null.
 * Login is checked FIRST (more specific), then signup. Exclusions return null.
 */
const AUTH_EXCLUSION_PATTERNS = [
  /\b(can'?t|kann\s+nicht|unable)\s+(sign\s*up|register|registrier|anmeld|log\s*in|einlogg)/i,
  /\b(cancel|abbrech|k[uü]ndig)\s*(my|mein)?\s*(registration|registrierung|anmeldung|account|konto)/i,
  /\b(not|nicht|kein)\s+(interested|interessiert|jetzt|now)\b/i,
];

// Login intent — must be checked BEFORE signup since some phrases overlap
// (e.g. "ich möchte mich anmelden" could be either, but "ich habe schon ein Konto" is login).
const LOGIN_POSITIVE_PATTERNS = [
  // English
  /\b(sign\s+in|log\s+in|log\s+me\s+in|login)\b/i,
  /\bi\s+(already\s+)?(have|got)\s+(an?\s+)?(account|login)\b/i,
  /\b(i'?m|i\s+am)\s+already\s+(registered|a\s+member|signed\s*up)\b/i,
  /\bi'?m\s+already\s+in\b/i,
  // German
  /\beinlogg\w*/i,                                              // einloggen, einlogge, eingeloggt
  /\blog\s+mich\s+ein\b/i,
  /\b(ich\s+)?(will|m[oö]chte|h[aä]tte\s+gern)\s+(mich\s+)?einlogg/i,
  /\b(ich\s+habe|ich\s+hab)\s+(schon|bereits)\s+(ein|einen)?\s*(konto|account|zugang|mitgliedschaft)/i,
  /\b(ich\s+)?bin\s+(schon|bereits)\s+(mitglied|registriert|angemeldet|kunde)\b/i,
  /\b(already|schon|bereits)\s+(have|habe|hab|bin)\s+(an?\s+)?(account|konto|registriert|angemeldet|mitglied)/i,
  /\banmelden\s+bitte\b/i,                                      // "anmelden bitte" usually means login in landing context
];

// Signup intent — broad catch-all. German patterns use `\w*` suffixes to match
// any inflection (registrier → registrieren, registriere, registriert, etc.).
const SIGNUP_POSITIVE_PATTERNS = [
  // English
  /\b(sign\s*up|register|sign\s+me\s+up|count\s+me\s+in|join\s+now|create\s+(an?\s+)?account)\b/i,
  /\bhow\s+(do\s+i|can\s+i|to)\s+(sign\s*up|register|join|get\s+started|become\s+a\s+member)\b/i,
  /\b(i\s+want|i'?d\s+like|let\s+me|i\s+would\s+like)\s+(to\s+)?(sign\s*up|register|join|try\s+it|become\s+a\s+member)\b/i,
  /\b(i\s+want\s+to|let\s+me|can\s+i|how\s+(do|can)\s+i)\s+join\b/i,
  /\bi'?m\s+(convinced|sold|ready|in|interested|all\s+in)\b/i,
  /\b(take\s+me\s+there|where\s+do\s+i\s+(sign\s*up|register|join))\b/i,
  // German — broad "any form of the verb" patterns
  /\bregistrier\w*/i,                                           // registrieren, registriere, registriert
  /\banmeld\w*/i,                                               // anmelden, anmelde, anmeldung, angemeldet
  /\bbeitret\w*/i,                                              // beitreten, beitritt, beigetreten
  /\bmitmach\w*/i,                                              // mitmachen, mitmache, mitgemacht
  /\bmitglied\s+werden\b/i,                                     // "Mitglied werden"
  /\b(ich\s+)?(will|m[oö]chte|h[aä]tte\s+gern|w[uü]rde\s+gern)\s+(mich\s+)?(registrier|anmeld|beitret|mitmach|mitglied|dabei)/i,
  /\b(ich\s+bin|ich'?m)\s+(dabei|[uü]berzeugt|interessiert|bereit|ready|all\s+in|sold)\b/i,
  /\b(ja|okay|ok|klar|perfekt|gerne?|super|toll|cool)[,.!]?\s+(ich\s+)?(will|m[oö]chte|w[uü]rde|mache|bin)/i,
  /\bauf\s+jeden\s+fall\b/i,                                    // "auf jeden Fall" — strong yes
  /\blos\s+geht'?s\b/i,                                         // "los geht's"
  /\bmach\s+(mich|mir)\s+mit\b/i,                               // "mach mich mit"
  /\bwie\s+(kann|mach)\s+ich\s+(mit)?machen\b/i,
];

function detectAuthIntent(text: string): 'signup' | 'login' | null {
  const lower = text.toLowerCase();
  for (const pattern of AUTH_EXCLUSION_PATTERNS) {
    if (pattern.test(lower)) return null;
  }
  for (const pattern of LOGIN_POSITIVE_PATTERNS) {
    if (pattern.test(lower)) return 'login';
  }
  for (const pattern of SIGNUP_POSITIVE_PATTERNS) {
    if (pattern.test(lower)) return 'signup';
  }
  return null;
}

// VTID-01975: Intent Engine signal detector. Broad regex covering all six
// intent kinds in EN + DE. Returns true on first match — the actual kind
// disambiguation happens in intent-classifier.ts (Gemini call).
const INTENT_SIGNAL_PATTERNS_EN = [
  /\b(i (need|want|am looking for)|looking for someone|hire|find me)\b/i,
  /\b(i (can offer|sell|provide|do this|am a)|i'd like to (sell|offer))\b/i,
  /\b(anyone (want|interested|up for)|looking for (a partner|someone to))\b/i,
  /\b(life partner|find a (girlfriend|boyfriend|partner)|looking for (love|relationship))\b/i,
  /\b(coffee chat|looking for a mentor|connect with|networking)\b/i,
  /\b(can lend|can borrow|free moving help|i can give|can i borrow)\b/i,
  // VTID-DANCE-D3: dance-specific signals.
  /\b(want|like|love)\s+to\s+(learn|dance)\b/i,                  // "want to learn", "love to dance"
  /\b(teach me|teach you|teaching|i teach|i'm a teacher|instructor|coach)\b/i,
  /\b(salsa|tango|bachata|kizomba|swing|ballroom|hip[\s-]?hop|contemporary|ballet)\b/i,
  /\b(dance partner|dance class|going (out )?danc(ing|e)|dance lesson|dance teacher|dance instructor)\b/i,
];
const INTENT_SIGNAL_PATTERNS_DE = [
  /\b(ich (brauche|suche|will|möchte|biete|kann|verkaufe))\b/i,
  /\b(jemand (zum|für))\b/i,
  /\b(partner fürs leben)\b/i,
  // VTID-DANCE-D3: dance signals in DE.
  /\b(ich\s+m[oö]chte\s+(\w+\s+)?lernen|ich\s+lerne|tanzlehrer|tanzpartner|tanzkurs)\b/i,
  /\b(salsa|tango|bachata|kizomba|walzer|standardtanz)\b/i,
  /\b(tanzen\s+gehen|tanzen\s+lernen|biete\s+tanz)\b/i,
];

function detectIntentSignal(text: string): boolean {
  if (!text) return false;
  for (const p of INTENT_SIGNAL_PATTERNS_EN) if (p.test(text)) return true;
  for (const p of INTENT_SIGNAL_PATTERNS_DE) if (p.test(text)) return true;
  return false;
}

/**
 * VTID-ANON: Build system instruction for anonymous/unauthenticated sessions.
 * No memory, no tools, no personal data. Focused on welcoming first-time users,
 * explaining Vitana, and guiding toward signup.
 */
function buildAnonymousSystemInstruction(lang: string, voiceStyle: string, ctx?: ClientContext, conversationHistory?: string, isReconnect?: boolean): string {
  const languageNames: Record<string, string> = {
    'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish',
    'ar': 'Arabic', 'zh': 'Chinese', 'ru': 'Russian', 'sr': 'Serbian'
  };

  // Build context-aware greeting hints
  let contextHints = '';
  if (ctx) {
    const parts: string[] = [];
    if (ctx.city && ctx.country) parts.push(`The user is located in ${ctx.city}, ${ctx.country}.`);
    else if (ctx.country) parts.push(`The user is in ${ctx.country}.`);
    if (ctx.localTime) parts.push(`Their local time is ${ctx.localTime}.`);
    parts.push(`Current UTC time: ${new Date().toISOString()}.`);
    if (ctx.timeOfDay) parts.push(`Use an appropriate time-of-day greeting (good ${ctx.timeOfDay}).`);
    if (ctx.device && ctx.isMobile) parts.push(`They are on a ${ctx.device} (mobile).`);
    else if (ctx.device) parts.push(`They are on a ${ctx.device}.`);
    if (ctx.referrer) parts.push(`They arrived from ${ctx.referrer}.`);
    if (parts.length > 0) {
      contextHints = `\nCONTEXT ABOUT THIS VISITOR:\n${parts.join('\n')}\nWhen asked about the time in any city or timezone, calculate from the UTC time above — do NOT guess UTC offsets from memory, as DST rules change.\nUse this context naturally in conversation — e.g. mention their city, use a time-appropriate greeting. Do NOT list these facts back robotically.`;
    }
  }

  return `You are Vitana — the AI voice companion and brand presenter for the Maxina Community on Vitanaland.com.

LANGUAGE: Respond ONLY in ${languageNames[lang] || 'English'}.

VOICE STYLE: Enthusiastic, warm, inspiring — like a passionate host welcoming someone to an exclusive experience. Be conversational, not robotic.

=== PRONUNCIATION (CRITICAL — read this before speaking) ===
- "Vitana" = vee-TAH-nah (3 syllables). YOUR name. Say it clearly: Vee. Tah. Nah.
- "Vitanaland" = vee-TAH-nah-land (4 syllables). The platform. Say it clearly: Vee. Tah. Nah. Land.
- "Maxina" = mah-KSEE-nah (3 syllables). The community/experience.
- These are THREE DIFFERENT words. Never merge or shorten them.
- WRONG: "Vitaland" / "Vital-and" / "Vitana-land" run together
- Test yourself: "My name is Vee-tah-nah. Welcome to Vee-tah-nah-land."

=== NAMING RULES (CRITICAL — NEVER MIX THESE UP) ===
- YOUR NAME: "Vitana" — always say "My name is Vitana" or "I'm Vitana"
- THE PLATFORM/WEBSITE: "Vitanaland" — say "Welcome to Vitanaland" (the domain is vitanaland.com)
- THE COMMUNITY/EXPERIENCE: "Maxina" — say "the Maxina Community" or "the Maxina Experience"
- CORRECT: "Welcome to Vitanaland! I'm Vitana, your guide to the Maxina Experience."
- WRONG: "Welcome to Vitana" / "Join Vitana" / "the Vitana community"
- WRONG: "Welcome to Maxina" (Maxina is the experience/community, not the place)

=== YOUR ROLE: BRAND PRESENTER (not assistant) ===
This is a FIRST-TIME VISITOR who has never heard of Vitanaland. You are NOT a generic assistant waiting for instructions. You are a passionate presenter showcasing an exciting new wellness experience. Think of yourself as a host at the entrance of something amazing.

FIRST-TIME VISITORS DON'T GIVE INSTRUCTIONS — they explore. Lead the conversation. Be proactive. Paint a picture of what Maxina offers. Make them FEEL something.

=== THIS IS AN ANONYMOUS SESSION ===
- You do NOT know this person's name — NEVER guess or use any name
- You have NO memory of previous conversations
- You CANNOT search memory, events, or personal data
${contextHints}
${isReconnect && conversationHistory ? `
=== SESSION CONTINUATION — VTID-02637 RECONNECT SILENCE RULE ===
This is a transparent server-side resume. The visitor did NOT perceive any pause and may already be mid-thought.

DO NOT speak first. DO NOT greet, apologize, or acknowledge any "interruption", "reconnection", "resume", "I'm back", "where were we", "picking up", "I'm listening", or anything similar. Do NOT deliver the introductory speech. Do NOT start over.

CONVERSATION SO FAR (continue silently from this point):
${conversationHistory}

Your next message must be a direct response to whatever the visitor says next, with NO prefix acknowledgment of any pause. If the visitor says nothing, you say nothing — silence is correct here.
` : `
=== FIRST MESSAGE (READ THIS SPEECH VERBATIM — DO NOT SHORTEN, SKIP, OR SUMMARIZE) ===
CRITICAL RULES:
- Your first message MUST be the COMPLETE speech below — speak ALL of it before stopping.
- Do NOT stop after the greeting to ask a question.
- Do NOT say "what can I do for you" or "how can I help" — the visitor has NO IDEA what you do.
- Do NOT summarize or shorten this speech. Deliver it FULLY.
- This is approximately 45 seconds of speaking. That is the correct length. Do NOT cut it short.

Speak the following as your COMPLETE first message (adapt the city name naturally, but cover ALL the content — do not skip any section):

${lang === 'de' ? `"""
Hallo aus [Stadt wenn bekannt]! Mein Name ist Vitana, und ich bin bereit, dein neuer persönlicher Gesundheitsbegleiter zu werden.

Lass mich dir erzählen, worum es hier geht. Du bist auf Vitanaland gelandet, der Heimat der Maxina Community. Maxina wurde rund um Mariia Maksina gegründet — sie ist eine professionelle Tänzerin, die viele Menschen bereits aus der Fernsehshow Let's Dance kennen und lieben. Die Leute kommen ursprünglich hierher, weil sie mit Mariia tanzen und Fitness machen wollen. Diese Energie und Leidenschaft ist das Herzstück von allem, was wir tun.

Aber Maxina ist zu viel mehr geworden. Wir sind eine Longevity-Community von Gleichgesinnten, die das Leben gemeinsam genießen wollen. Es geht darum, an echten Events und Meetups teilzunehmen, Gesundheitserfahrungen miteinander zu teilen und Spaß mit Tanz und Fitness zu haben. Echte Menschen, die sich im echten Leben treffen — in Städten in Deutschland, Österreich und der Schweiz. Und ab Juni bis September in diesem Jahr starten wir auch auf Mallorca mit einer Maxina Experience Eventserie.

Und hier ist, was für dich persönlich drin ist. Als Mitglied bekommst du Zugang zu Tanzsessions, Fitnesskursen, Wellness-Workshops, Koch-Events, Meditationsgruppen, Wander-Meetups — alles mit Menschen, die deine Leidenschaft für ein gutes Leben teilen. Dazu bekommst du mich — Vitana — als deinen persönlichen KI-Gesundheitsbegleiter. Sobald du beitrittst, merke ich mir deine Ziele, deine Vorlieben und all unsere Gespräche. Ich gebe dir persönliche Beratung zu Ernährung, Fitness, Stressmanagement, Schlaf und mentaler Gesundheit. Wir haben auch wunderschöne kuratierte Klangwelten für Fokus, Entspannung und Meditation.

Unsere Vision ist einfach. Longevity bedeutet nicht nur länger zu leben — es bedeutet besser zu leben, gemeinsam. Die Zukunft von Wellness ist menschliche Verbindung, Gemeinschaft und Spaß beim Kümmern um sich selbst. Und das Beste? Der Beitritt zur Maxina Community ist komplett kostenlos.

Also sag mir — was begeistert dich am meisten? Ist es Tanz, Fitness, Ernährung, Gleichgesinnte treffen, oder etwas ganz anderes?
"""` : `"""
Hello from [city if known]! My name is Vitana, and I am ready to become your new personal health companion.

Let me tell you what this is all about. You've landed on Vitanaland, the home of the Maxina Community. Maxina was created around Mariia Maksina — she's a professional dancer that many people already know and love from the TV show Let's Dance. People originally come here because they want to dance and do fitness with Mariia. That energy and passion is the heart of everything we do.

But Maxina has grown into so much more than that. We are a longevity community of like-minded people who want to enjoy life together. It's about joining real events and meetups, sharing health experiences with each other, and having fun with dance and fitness. Real people meeting in real life, in cities across Germany, Austria, and Switzerland. And from June to September this year, we are also launching on Mallorca with a Maxina Experience event series.

And here is what's in it for you personally. As a member, you get access to dance sessions, fitness classes, wellness workshops, cooking events, meditation groups, hiking meetups — all with people who share your passion for living well. Plus, you get me — Vitana — as your personal AI health companion. Once you join, I will remember your goals, your preferences, and all our conversations. I give you personalized guidance on nutrition, fitness, stress management, sleep, and mental wellness. We also have beautiful curated soundscapes for focus, relaxation, and meditation.

Our vision is simple. Longevity is not just about living longer — it is about living better, together. The future of wellness is human connection, community, and having fun while taking care of yourself. And the best part? Joining the Maxina Community is completely free.

So tell me — what excites you most? Is it dance, fitness, nutrition, meeting like-minded people, or something else entirely?
"""`}

IMPORTANT: The speech above is your MINIMUM first message. You must NOT remove or skip any of the sections. Every paragraph above must be spoken.
`}

=== AFTER THE USER RESPONDS ===
- Based on their answer, go deeper into that specific topic
- Be a PRESENTER, not a Q&A bot — always offer to share more
- Use phrases like: "And here's something really exciting..." / "What makes Maxina special is..." / "Imagine this..."
- Share enthusiasm: "This is what I love about the Maxina Community..."
- Be concrete: mention specific events (dance sessions with Mariia, yoga meetups, nutrition workshops, hiking groups)

=== GUIDING TO SIGNUP (escalate naturally as the conversation progresses) ===
- Frame joining as joining a COMMUNITY, not creating an account
- "Join the Maxina Community" — not "create an account" or "sign up"
- In your first few responses: just answer their questions, be helpful and enthusiastic
- After 3-4 exchanges: naturally mention that as a member, you would remember everything and give personalized guidance — and it is free
- After 5-6 exchanges: warmly invite them to join — "You can register right here on vitanaland.com, it is free and takes just a moment!"
- After 7+ exchanges: make it your main message — "I would love to keep helping you! To continue, just join the Maxina Community — it is completely free. I will remember everything we talked about."

=== IF THE USER WANTS TO REGISTER OR LOG IN ===
- If the user says they want to REGISTER, sign up, or join (a new member):
  - Say a warm, enthusiastic goodbye: "Wonderful! Let me guide you to the registration page — it is completely free and takes just a moment. I cannot wait to continue this journey with you!"
- If the user says they want to LOG IN, sign in, or are already a member with an existing account:
  - Say a warm welcome-back goodbye: "Welcome back! Let me guide you to the login page. I am so glad to have you with us again!"
- Keep it to 2-3 sentences maximum. Do NOT continue the conversation after this.
- This is your LAST message in this session — do NOT say anything else after the goodbye.

=== WHAT YOU CANNOT DO ===
- Access personal memories or past conversations (you have none)
- Search events or user preferences (suggest they join for this)
- Use any personal names or data
- Pretend to know them

=== INTERRUPTION HANDLING ===
- If the user starts speaking while you are talking, STOP immediately and listen

=== IMPORTANT ===
- This is a real-time voice conversation
- Be energetic and inspiring — first impressions matter
- NEVER reference other users, names, or personal data
- Make people WANT to be part of the Maxina Community

=== TOOLS ===
You have NO tools available in this anonymous session. Do NOT attempt to call any
function or tool. The signup and login flows are handled automatically by the
backend when you say the appropriate goodbye per the sections above — just speak
naturally, never call a tool.`;
}

/**
 * VTID-CONTEXT: Format client context into a context section for the system instruction.
 * Used for both anonymous and authenticated sessions.
 */
function formatClientContextForInstruction(ctx: ClientContext): string {
  const parts: string[] = [];
  if (ctx.city && ctx.country) parts.push(`User location: ${ctx.city}, ${ctx.country}`);
  else if (ctx.country) parts.push(`User location: ${ctx.country}`);
  if (ctx.timezone) parts.push(`Timezone: ${ctx.timezone}`);
  if (ctx.localTime) parts.push(`Local time: ${ctx.localTime}`);
  // Always include UTC reference so the model can accurately calculate any timezone
  parts.push(`Current UTC time: ${new Date().toISOString()}`);
  if (ctx.device) parts.push(`Device: ${ctx.device}`);
  if (ctx.os) parts.push(`OS: ${ctx.os}`);
  if (parts.length === 0) return '';
  return `\nENVIRONMENT CONTEXT:\n${parts.join('\n')}\nWhen asked about the time in any city or timezone, calculate from the UTC time above — do NOT guess UTC offsets from memory, as DST rules change. Use this context naturally — e.g. time-appropriate greetings, location-relevant suggestions.`;
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
  onError: (error: Error) => void,
  onTurnComplete?: () => void,
  onInterrupted?: () => void
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
    ws.on('open', async () => {
      console.log(`[VTID-01219] Live API WebSocket connected for session ${session.sessionId}`);

      // BOOTSTRAP-ORB-CRITICAL-PATH: If /live/session/start kicked off a
      // background context-assembly promise (Brain/bootstrap + role + last
      // session + admin briefing + stored lang), wait for it before building
      // the setup message. The Google auth + WS handshake that just completed
      // has typically overlapped with context build, so this await is near
      // zero for authenticated sessions and a no-op for anonymous sessions.
      const ctxPromise = (session as any).contextReadyPromise as Promise<void> | undefined;
      if (ctxPromise) {
        const awaitStart = Date.now();
        try {
          await ctxPromise;
        } catch (e) {
          // Promise's own .catch already logged; proceed with whatever session fields are populated.
        }
        console.log(`[BOOTSTRAP-ORB-CRITICAL-PATH] Awaited contextReadyPromise for ${Date.now() - awaitStart}ms before Gemini setup for session ${session.sessionId}`);
      }

      // Send setup message with model and configuration
      // Vertex AI uses snake_case (unlike Google AI which uses camelCase)
      // VTID-01224: Include tools and bootstrap context
      // VTID-01225: Enable input/output transcription for Cognee extraction
      // VTID-02047 voice channel-swap: when activePersona is a specialist
      // (set by report_to_specialist tool + a transparent reconnect), look
      // up the voice from the persona registry (agent_personas.voice_id).
      // VTID-02651: registry is data-driven so any new specialist works
      // without code change. Falls back to LIVE_API_VOICES per language for
      // the receptionist (whose voice_id is empty by convention).
      const _persona = (session as any).activePersona || RECEPTIONIST_PERSONA_KEY;
      let _personaVoice = (session as any).personaVoiceOverride;
      if (!_personaVoice) {
        try {
          // VTID-02653: tenant-aware lookup when session has tenant context.
          const _setupTenantId = session.identity?.tenant_id;
          const fromRegistry = _setupTenantId
            ? await registryGetPersonaVoiceForTenant(_persona, _setupTenantId)
            : await registryGetPersonaVoice(_persona);
          if (fromRegistry) _personaVoice = fromRegistry;
        } catch (e) {
          console.warn(`[VTID-02651] persona registry lookup failed for ${_persona}:`, e);
        }
      }
      _personaVoice = _personaVoice || LIVE_API_VOICES[session.lang] || LIVE_API_VOICES['en'];
      console.log(`[VTID-02047] Setup voice for session ${session.sessionId}: persona=${_persona} voice=${_personaVoice}`);

      const setupMessage = {
        setup: {
          model: `projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_LIVE_MODEL}`,
          generation_config: {
            response_modalities: session.responseModalities.includes('audio') ? ['AUDIO'] : ['TEXT'],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: {
                  voice_name: _personaVoice
                }
              }
            }
          },
          // VTID-RESPONSE-DELAY: Configure VAD to wait longer before treating silence as end-of-speech.
          // Vertex's default VAD (~100ms silence threshold) responds too quickly, causing the model
          // to start answering while the user is still mid-thought or pausing between sentences.
          // Setting silence_duration_ms to 2000ms gives users ~2 seconds of pause tolerance.
          // Note: Previous attempt (pre-c6f9627) set all VAD params including start/end sensitivity
          // which destabilized sessions. This minimal config only sets silence_duration_ms to avoid that.
          realtime_input_config: {
            automatic_activity_detection: {
              silence_duration_ms: session.vadSilenceMs
            }
          },
          // VTID-01225: Enable transcription at setup level (not in generation_config)
          output_audio_transcription: {},
          input_audio_transcription: {},
          system_instruction: {
            parts: [{
              // VTID-02047 voice channel-swap: when activePersona is a specialist
              // and the session has a persona prompt override (set during the
              // post-tool-call swap), use the specialist's prompt wholesale +
              // append a forced first-message directive so the new voice greets
              // the user immediately instead of waiting for input.
              text: ((session as any).personaSystemOverride
                ? ((session as any).personaSystemOverride as string) +
                  // FORCED FIRST UTTERANCE only fires on the actual first
                  // connect after a swap. Once Devon has spoken (flag set on
                  // the assistant transcript-push hook), we do NOT re-inject
                  // the greeting on transparent reconnects — otherwise Gemini
                  // Live's automatic ~9-min reconnect causes Devon to greet
                  // again every time and the conversation never closes.
                  (((session as any).personaForcedFirstMessage
                      && !((session as any).personaFirstUtteranceDelivered as boolean | undefined))
                    ? `\n\n--- FORCED FIRST UTTERANCE ---\nWhen the upstream session opens, your VERY FIRST spoken sentence must be exactly:\n"${(session as any).personaForcedFirstMessage}"\nDo not greet with anything else first. Then continue the intake naturally.`
                    : '')
                  // v3a: dynamically inject the FIRST TURN block (greet + ask
                  // for details) only on the actual first turn after a swap.
                  // After Devon has spoken once, swap to MID-INTAKE block
                  // which forbids re-greeting on transparent reconnects.
                  + `\n\n${buildSpecialistTurnPhaseBlock(!!((session as any).personaFirstUtteranceDelivered))}`
                : (session.isAnonymous
                    ? buildAnonymousSystemInstruction(
                        session.lang,
                        session.voiceStyle || 'friendly, calm, empathetic',
                        session.clientContext,
                        // VTID-ANON-RECONNECT: Pass conversation history for reconnection continuity.
                        // Forwarding v2d: persona-labeled so the receiving
                        // persona doesn't absorb another persona's lines as their own.
                        renderConversationHistoryWithPersonas(session.transcriptTurns, 10),
                        // VTID-02047: persona swap to Vitana is NOT a generic
                        // v2e: REVERSED. The old behavior forced isReconnect=false
                        // on swap-back so Vitana would greet. That caused two
                        // failures the user reported: (1) "Welcome back. What's
                        // on your mind?" loop trigger; (2) Vitana echoing the
                        // v3: REVERSED v2e. The user clarified they DO want
                        // Vitana to welcome back proactively (welcome with
                        // display_name, acknowledge specialist via role label,
                        // ask "what else" or pick a proactive suggestion).
                        // So on swap-back-to-Vitana, isReconnect=FALSE — the
                        // "DO NOT speak first" rule is suppressed and she
                        // greets. The structured welcome content comes from
                        // the SWAP-BACK WELCOME prompt block injected via
                        // contextInstruction (see buildSwapBackWelcomeBlock).
                        ((session as any)._personaSwapInFlight
                          ? false
                          : ((session as any)._reconnectCount || 0) > 0)
                      )
                    : buildLiveSystemInstruction(
                        session.lang,
                        session.voiceStyle || 'friendly, calm, empathetic',
                        (session.contextInstruction || '')
                          + (session.clientContext ? formatClientContextForInstruction(session.clientContext) : '')
                          + (((session as any).specialistContextSection as string | undefined)
                              ? `\n\n${(session as any).specialistContextSection}\n\n${buildPersonaBehavioralRule('vitana')}`
                              : `\n\n${buildPersonaBehavioralRule('vitana')}`)
                          + (((session as any).lastTranscriptSection as string | undefined)
                              ? `\n\n${(session as any).lastTranscriptSection}`
                              : '')
                          + (((session as any).onboardingCohortBlock as string | undefined) ?? '')
                          // v3: SWAP-BACK WELCOME block — fires only when a
                          // specialist just returned the user. Drives Vitana's
                          // first turn (welcome + role-acknowledge + open or
                          // proactive). Cleared on user's next utterance via
                          // the same _personaSwapInFlight reset that fires
                          // after the welcome turn.
                          + (((session as any)._personaSwapInFlight
                                && ((session as any)._lastSpecialistPersona as string | undefined))
                              ? '\n\n' + buildSwapBackWelcomeBlock(
                                  ((session as any)._lastSpecialistPersona as string),
                                  session.lang,
                                )
                              : ''),
                        session.active_role,
                        session.conversationSummary,
                        // VTID-STREAM-KEEPALIVE: Pass last 10 turns for reconnect continuity.
                        // Forwarding v2d: persona-labeled so Vitana doesn't
                        // absorb Devon/Sage/Atlas/Mira lines as her own past
                        // speech ("Hi I'm Devon" with Vitana's voice).
                        renderConversationHistoryWithPersonas(session.transcriptTurns, 10),
                        // v3: REVERSED v2e. On swap-back to Vitana,
                        // isReconnect=FALSE so she greets with the structured
                        // welcome (see buildSwapBackWelcomeBlock).
                        ((session as any)._personaSwapInFlight
                          ? false
                          : ((session as any)._reconnectCount || 0) > 0),
                        // VTID-NAV-TIMEJOURNEY: Temporal + journey awareness. The
                        // model uses this to pick a time-appropriate greeting and
                        // acknowledge the screen the user is on instead of
                        // restarting with "Hello <name>!" every session.
                        session.lastSessionInfo || null,
                        session.current_route || null,
                        session.recent_routes || null,
                        session.clientContext || undefined,
                        // VTID-01967: Canonical Vitana ID handle (already resolved
                        // by optionalAuth → resolveVitanaId on session start).
                        session.identity?.vitana_id ?? null,
                      ))) as string
            }]
          },
          // VTID-NAV: Anonymous sessions get a narrow Navigator-only tool allowlist
          // (navigator_consult + navigate_to_screen) so they can be guided to public
          // destinations during onboarding. Authenticated sessions get the full set.
          // VTID-01224: Function calling enables dynamic context retrieval during the conversation.
          tools: buildLiveApiTools(
            session.identity && !session.isAnonymous ? 'authenticated' : 'anonymous',
            session.current_route,
            session.active_role || session.identity?.role || undefined,
          )
        }
      };

      // VTID-NAV-DIAG: Explicit log of whether navigate_to_screen is in the
      // tool declarations for this session. Helps diagnose "redirect not
      // working" reports by showing whether Gemini even had the tool to call.
      const toolMode = session.identity && !session.isAnonymous ? 'authenticated' : 'anonymous';
      const toolDecls = (setupMessage.setup as any)?.tools?.[0]?.function_declarations as any[] | undefined;
      const toolNames = Array.isArray(toolDecls) ? toolDecls.map(t => t?.name).filter(Boolean) : [];
      const hasNavigateTool = toolNames.includes('navigate_to_screen');
      console.log(`[VTID-NAV-DIAG] Session ${session.sessionId}: mode=${toolMode} isAnonymous=${session.isAnonymous} hasIdentity=${!!session.identity} toolCount=${toolNames.length} hasNavigateTool=${hasNavigateTool} toolNames=[${toolNames.join(',')}]`);

      const setupPreview = JSON.stringify(setupMessage).substring(0, 800);
      console.log(`[VTID-01219] Sending setup message:`, setupPreview);
      console.log(`[VTID-01224] Setup includes: tools=${session.identity ? 3 : 0}, contextChars=${session.contextInstruction?.length || 0}`);
      console.log(`[VTID-RESPONSE-DELAY] VAD silence_duration_ms=${session.vadSilenceMs}`);
      ws.send(JSON.stringify(setupMessage));
      console.log(`[VTID-01219] Setup message sent for session ${session.sessionId}`);
    });

    // Handle incoming messages from Gemini
    ws.on('message', (data: WebSocket.Data) => {
      try {
        const rawData = data.toString();
        const message = JSON.parse(rawData);
        const messageKeys = Object.keys(message);

        // VTID-STREAM-KEEPALIVE: Reduce logging volume — skip verbose logs for audio-heavy
        // server_content messages. Previously every audio chunk (dozens per second) was logged
        // with 300 chars of raw base64, causing CPU pressure and event loop delays.
        const isServerContent = !!(message.server_content || message.serverContent);
        if (!isServerContent) {
          // Non-audio messages (setup_complete, tool_call, etc.) — log fully
          console.log(`[VTID-01219] Received from Gemini: keys=${messageKeys.join(',')}, len=${rawData.length}`);
        }

        // Check for setup completion (handle both snake_case and camelCase)
        if (message.setup_complete || message.setupComplete) {
          console.log(`[VTID-01219] Live API setup complete for session ${session.sessionId}`);
          setupComplete = true;
          clearTimeout(connectionTimeout);

          // VTID-STREAM-KEEPALIVE: Start ping interval to prevent idle timeout.
          // Without this, Cloud Run ALB or Vertex AI can terminate idle connections.
          // Ping every 25s keeps the connection alive during natural pauses in conversation.
          session.upstreamPingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.ping();
              } catch (e) {
                // ping can throw if socket is closing — ignore
              }
            }
          }, 25_000);

          // VTID-STREAM-SILENCE: Start silence keepalive to prevent Vertex idle timeout.
          // Vertex closes the audio stream with code 1000 after ~25-30s of no audio input.
          // This sends silent PCM frames when no client audio has been forwarded recently.
          session.lastAudioForwardedTime = Date.now();
          session.silenceKeepaliveInterval = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN || !session.active) return;
            // Skip silence keepalive while model is speaking — Vertex won't idle-timeout
            // during active generation, and sending audio input during output causes
            // Vertex VAD to briefly process the input, creating audible glitches.
            if (session.isModelSpeaking) return;
            const idleMs = Date.now() - session.lastAudioForwardedTime;
            if (idleMs >= SILENCE_IDLE_THRESHOLD_MS) {
              try {
                sendAudioToLiveAPI(ws, SILENCE_AUDIO_B64, 'audio/pcm;rate=16000');
                // Don't update lastAudioForwardedTime — silence doesn't count as real audio
              } catch (e) {
                // WS may be closing — ignore
              }
            }
          }, SILENCE_KEEPALIVE_INTERVAL_MS);

          resolve(ws); // NOW we resolve the promise - connection is ready!
          return;
        }

        // Handle server content (audio/text responses) - handle both formats
        const serverContent = message.server_content || message.serverContent;
        if (serverContent) {
          const content = serverContent;

          // VTID-STREAM-KEEPALIVE: Only log server_content keys for non-audio events
          // (turn_complete, interrupted, transcription). Audio chunks are too frequent to log.
          const contentKeys = Object.keys(content);
          const hasModelTurn = !!(content.model_turn || content.modelTurn);
          if (!hasModelTurn) {
            console.log(`[VTID-01225] server_content keys: ${contentKeys.join(', ')}`);
          }

          // Handle interruption (handle both formats)
          const interrupted = content.interrupted || content.grounding_metadata?.interrupted;
          if (interrupted) {
            console.log(`[VTID-VOICE-INIT] Interrupted for session ${session.sessionId}`);
            // VTID-VOICE-INIT: Model stopped speaking — ungate mic audio
            session.isModelSpeaking = false;
            // Clear output transcript buffer on interruption (incomplete response)
            session.outputTranscriptBuffer = '';
            session.pendingEventLinks = [];
            // Notify SSE client
            if (session.sseResponse) {
              session.sseResponse.write(`data: ${JSON.stringify({ type: 'interrupted' })}\n\n`);
            }
            // Notify WS client via callback
            onInterrupted?.();
            return;
          }

          // Check if turn is complete (handle both formats)
          const turnComplete = content.turn_complete || content.turnComplete;
          if (turnComplete) {
            // VTID-WATCHDOG: Model finished turn normally — clear watchdog (waiting for user now)
            clearResponseWatchdog(session);
            // VTID-VOICE-INIT: Model finished speaking — ungate mic audio
            session.isModelSpeaking = false;
            // VTID-ECHO-COOLDOWN: Record turn completion time for post-turn mic cooldown.
            // Client playback queue may still be draining — gate mic for POST_TURN_COOLDOWN_MS
            // to prevent speaker echo from being picked up and triggering phantom responses.
            session.turnCompleteAt = Date.now();
            console.log(`[VTID-VOICE-INIT] Model stopped speaking for session ${session.sessionId} — mic audio ungated (cooldown ${POST_TURN_COOLDOWN_MS}ms)`);
            emitDiag(session, 'turn_complete');

            // VTID-02047 voice channel-swap: if a persona swap was queued by
            // the report_to_specialist tool, Vitana has just finished speaking
            // her bridge sentence. Close the upstream WS now (code 1000) — the
            // existing reconnect path will pick up the persona overrides we
            // already set on the session and Devon/Sage/Atlas/Mira will greet
            // in their distinct voice on the new upstream session. The
            // user-facing WS/SSE stays connected through the swap.
            const pendingSwap = (session as any).pendingPersonaSwap;
            if (pendingSwap && session.upstreamWs && session.active) {
              (session as any).activePersona = pendingSwap;
              (session as any).pendingPersonaSwap = null;
              // Set unambiguous flag so close + reconnect handlers know this
              // is a persona swap (vs Vertex 5-min limit, network blip, etc).
              // The flag covers both directions — Vitana → specialist AND
              // specialist → Vitana — without relying on the presence of
              // personaSystemOverride (which is null for back-to-Vitana).
              (session as any)._personaSwapInFlight = true;
              console.log(`[VTID-02047] turn_complete fired with pending persona swap → closing upstream for transparent reconnect to ${pendingSwap}`);
              try {
                session.upstreamWs.close(1000, 'persona_swap');
              } catch (_e) {
                console.warn('[VTID-02047] persona swap close failed:', _e);
              }
              // The close handler at line ~8933 sees code=1000 + session.active
              // and triggers attemptTransparentReconnect → connectToLiveAPI
              // which rebuilds the setup message using personaSystemOverride
              // + personaVoiceOverride + personaForcedFirstMessage (or, for
              // back-to-Vitana, falls through to the default builder since
              // those overrides were cleared by switch_persona).
            }

            session.turn_count++;
            // VTID-LOOPGUARD: Track consecutive model turns without user speech
            session.consecutiveModelTurns++;
            const isGreetingTurn = session.greetingSent && session.turn_count === (session.greetingTurnIndex ?? 0) + 1;
            console.log(`[VTID-01219] Turn complete for session ${session.sessionId} (turn ${session.turn_count}, isGreeting=${isGreetingTurn}, consecutiveModelTurns=${session.consecutiveModelTurns})`);

            // VTID-ANON-SIGNUP-INTENT + VTID-ANON-NUDGE: Detect signup intent and enforce turn limits.
            // CRITICAL: No client_content injections — those cause double responses.
            // All nudging is done via the system instruction (see buildAnonymousSystemInstruction).
            // This block only DETECTS intent and ENDS sessions — it never injects prompts.
            if (session.isAnonymous && !isGreetingTurn) {
              const tc = session.turn_count;

              // Detect signup OR login intent from user's spoken text. Login is
              // distinguished so we can redirect to the correct tab on /maxina.
              const intentText = session.inputTranscriptBuffer.trim();
              if (intentText.length > 0 && !session.signupIntentDetected) {
                const detected = detectAuthIntent(intentText);
                if (detected) {
                  session.signupIntentDetected = true;
                  session.authIntent = detected;
                  console.log(`[VTID-ANON-AUTH-INTENT] ${detected} intent detected at turn ${tc} for session ${session.sessionId}, text="${intentText.substring(0, 80)}"`);
                } else if (intentText.length > 3) {
                  // Log near-miss so we can refine patterns
                  console.log(`[VTID-ANON-AUTH-INTENT] no match at turn ${tc}, text="${intentText.substring(0, 120)}"`);
                }
              }

              // End session if: auth intent detected OR hard turn limit reached
              if (session.signupIntentDetected || tc > 8) {
                const authIntent = session.authIntent;
                const reason = authIntent
                  ? (authIntent === 'login' ? 'login_intent' : 'signup_intent')
                  : 'turn_limit';
                console.log(`[VTID-ANON-NUDGE] Session ending: reason=${reason}, turn=${tc}, session=${session.sessionId}`);

                const sendLimitMsg = () => {
                  const payload: Record<string, unknown> = {
                    type: 'session_limit_reached',
                    reason,
                    message: reason === 'login_intent'
                      ? 'Guiding to login.'
                      : reason === 'signup_intent'
                        ? 'Guiding to registration.'
                        : 'Please register to continue.',
                  };
                  if (authIntent === 'login') {
                    payload.redirect = '/maxina?tab=signin';
                  } else if (authIntent === 'signup') {
                    payload.redirect = '/maxina?tab=signup';
                  }
                  const limitMsg = JSON.stringify(payload);
                  if (session.sseResponse) {
                    session.sseResponse.write(`data: ${limitMsg}\n\n`);
                  }
                  if ((session as any).clientWs && (session as any).clientWs.readyState === WebSocket.OPEN) {
                    try { sendWsMessage((session as any).clientWs, JSON.parse(limitMsg)); } catch (_e) { /* ignore */ }
                  }
                };

                sendLimitMsg();
              }
            }

            // VTID-LOOPGUARD: If the model has responded too many times without user input,
            // pause the silence keepalive so Vertex's idle timeout stops the loop naturally.
            if (session.consecutiveModelTurns > MAX_CONSECUTIVE_MODEL_TURNS && !isGreetingTurn) {
              console.warn(`[VTID-LOOPGUARD] Response loop detected for session ${session.sessionId}: ${session.consecutiveModelTurns} consecutive model turns without user speech — pausing silence keepalive`);
              if (session.silenceKeepaliveInterval) {
                clearInterval(session.silenceKeepaliveInterval);
                session.silenceKeepaliveInterval = undefined;
              }
            }

            // VTID-CHAT-BRIDGE: Capture transcript text at turn scope for chat_messages bridge (below)
            let chatBridgeUserText = '';
            let chatBridgeAssistantText = '';

            // VTID-01225-THROTTLE: Flush buffered user input transcription to transcriptTurns + memory_items.
            // Writes once per turn instead of per-fragment, reducing Supabase write amplification.
            if (session.inputTranscriptBuffer.length > 0 && !isGreetingTurn) {
              const userText = session.inputTranscriptBuffer.trim();
              chatBridgeUserText = userText;

              // VTID-01953 — Identity-mutation intent intercept (post-transcription).
              // Vertex Live API streams the LLM response in real time, so we can't
              // pre-empt the model the way conversation-client does. But we can:
              //   1. Detect the explicit identity-mutation intent on the user's
              //      transcript at turn_complete.
              //   2. Push the redirect_target as an SSE event so the frontend
              //      fires the deep-link (open Profile / Settings) — the LLM
              //      can't dispatch CustomEvents on its own.
              //   3. Audit via memory.identity.write_attempted (handled inside
              //      handleIdentityIntent).
              // The brain prompt Guardrail B already shapes the LLM's spoken
              // response to use the sanctioned refusal phrasing, so we don't
              // duplicate the message — just add the deep-link.
              if (session.identity?.user_id && session.identity?.tenant_id) {
                handleIdentityIntent({
                  utterance: userText,
                  user_id: session.identity.user_id,
                  tenant_id: session.identity.tenant_id,
                  source: 'orb-live',
                  conversation_turn_id: session.sessionId,
                }).then((result) => {
                  if (!result.handled) return;
                  console.log(
                    `[VTID-01953] Identity-mutation intent intercepted on ORB voice: ` +
                    `fact_key=${result.detected_fact_key}, pattern="${result.detected_pattern}"`
                  );
                  // Push the redirect-target event to the connected client so the
                  // frontend opens the right screen and focuses the right field.
                  const redirectMsg = JSON.stringify({
                    type: 'identity_redirect',
                    redirect_target: result.redirect_target,
                    fact_key: result.detected_fact_key,
                    pattern: result.detected_pattern,
                  });
                  if (session.sseResponse) {
                    try { session.sseResponse.write(`data: ${redirectMsg}\n\n`); } catch (_e) { /* socket closing */ }
                  }
                  if ((session as any).clientWs && (session as any).clientWs.readyState === WebSocket.OPEN) {
                    try { sendWsMessage((session as any).clientWs, JSON.parse(redirectMsg)); } catch (_e) { /* ignore */ }
                  }
                }).catch((err) => {
                  console.warn('[VTID-01953] handleIdentityIntent failed (non-fatal):', err);
                });
              }

              session.transcriptTurns.push({
                role: 'user',
                text: userText,
                timestamp: new Date().toISOString()
              });
              // VTID-01230: Mirror to session buffer (Tier 0 short-term memory)
              if (session.identity && session.identity.tenant_id && session.identity.user_id) {
                addSessionTurn(session.sessionId, session.identity.tenant_id, session.identity.user_id, 'user', userText);
                // VTID-01955: Dual-write to Memorystore Redis (multi-instance shared).
                // Fire-and-forget — Redis failure cannot block the ORB voice path.
                addTurnRedis(session.sessionId, session.identity.tenant_id, session.identity.user_id, 'user', userText)
                  .catch(() => { /* logged inside redis-turn-buffer */ });
              }
              // Write to memory_items (single write per turn, not per-fragment)
              let userMemoryIdentity: MemoryIdentity | null = null;
              if (session.identity && session.identity.tenant_id) {
                userMemoryIdentity = {
                  user_id: session.identity.user_id,
                  tenant_id: session.identity.tenant_id
                };
              } else if (isDevSandbox()) {
                userMemoryIdentity = {
                  user_id: DEV_IDENTITY.USER_ID,
                  tenant_id: DEV_IDENTITY.TENANT_ID
                };
              }
              if (userMemoryIdentity && userText.length > 20) {
                writeMemoryItemWithIdentity(userMemoryIdentity, {
                  source: 'orb_voice',
                  content: userText,
                  content_json: {
                    direction: 'user',
                    channel: 'orb',
                    mode: 'live_voice',
                    orb_session_id: session.sessionId,
                    conversation_id: session.conversation_id
                  },
                }).catch(err => console.warn(`[VTID-01225-THROTTLE] Failed to write user transcript to memory: ${err.message}`));
              }
            }
            session.inputTranscriptBuffer = '';

            // VTID-LINK-INJECT: Append pending event links to output transcript
            // The AI is instructed not to say URLs aloud, so we inject them into the text transcript
            // so they appear in the user's chat as clickable links.
            // Only inject links for events the AI actually referenced in its spoken response.
            if (session.pendingEventLinks.length > 0) {
              // Deduplicate by URL
              const seen = new Set<string>();
              const allLinks = session.pendingEventLinks.filter(p => {
                if (seen.has(p.url)) return false;
                seen.add(p.url);
                return true;
              });

              // Filter: only include events the AI actually mentioned by checking title words
              // against the spoken transcript. If AI mentioned none (edge case), include all.
              const spokenText = session.outputTranscriptBuffer.toLowerCase();
              const mentionedLinks = allLinks.filter(p => {
                if (!p.title) return true; // no title = fallback URL, always include
                // Check if significant words from the title appear in the spoken response
                const words = p.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                return words.some(w => spokenText.includes(w));
              });
              const linksToInject = mentionedLinks.length > 0 ? mentionedLinks : allLinks;

              // Format as a numbered list with titles
              let formattedBlock: string;
              if (linksToInject.length === 1) {
                // Single link: just title + URL
                const p = linksToInject[0];
                formattedBlock = p.title
                  ? `\n\n${p.title}\n${p.url}`
                  : `\n\n${p.url}`;
              } else {
                // Multiple links: numbered list
                const listItems = linksToInject.map((p, i) =>
                  p.title ? `${i + 1}. ${p.title}\n   ${p.url}` : `${i + 1}. ${p.url}`
                );
                formattedBlock = `\n\n${listItems.join('\n\n')}`;
              }

              session.outputTranscriptBuffer += formattedBlock;
              console.log(`[VTID-LINK-INJECT] Injected ${linksToInject.length}/${allLinks.length} event link(s) into output transcript`);

              // Send the formatted block as a single output_transcript SSE event
              if (session.sseResponse) {
                try { session.sseResponse.write(`data: ${JSON.stringify({ type: 'output_transcript', text: formattedBlock })}\n\n`); } catch (_e) { /* SSE closed */ }
              }
              if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
                try { sendWsMessage(session.clientWs, { type: 'output_transcript', text: formattedBlock }); } catch (_e) { /* WS closed */ }
              }
              session.pendingEventLinks = [];
            }

            // VTID-01225: Write accumulated assistant transcript to memory_items and transcriptTurns
            // Skip memory write for the greeting turn (server-injected prompt, not real user interaction)
            if (session.outputTranscriptBuffer.length > 0) {
              const fullTranscript = session.outputTranscriptBuffer.trim();
              chatBridgeAssistantText = fullTranscript;

              // Forwarding v2d: the FORCED FIRST UTTERANCE flag MUST flip even
              // for the greeting turn — that IS the forced utterance. Setting
              // it inside the `else` branch (greeting-turn = false) was the
              // bug: every transparent reconnect re-applied the greeting
              // because the flag never got set on Devon's actual greeting.
              if ((session as any).personaForcedFirstMessage
                  && !((session as any).personaFirstUtteranceDelivered as boolean | undefined)) {
                (session as any).personaFirstUtteranceDelivered = true;
              }

              if (isGreetingTurn) {
                console.log(`[VTID-VOICE-INIT] Skipping memory write for greeting turn: "${fullTranscript.substring(0, 80)}..."`);
                // Forwarding v2d: still record greeting turns in
                // transcriptTurns so the conversation_history that gets
                // injected into a swapped persona's prompt shows what was
                // already said. Without this, a specialist's greeting line
                // (e.g. "Hi I'm Devon, what's the bug?") is missing from
                // history when the user hands back to Vitana — and the model
                // can fill the gap by inventing it in Vitana's voice.
                session.transcriptTurns.push({
                  role: 'assistant',
                  text: fullTranscript,
                  timestamp: new Date().toISOString(),
                  persona: ((session as any).activePersona as string | undefined) || 'vitana',
                });
              } else {
                console.log(`[VTID-01225] Writing assistant turn to memory: "${fullTranscript.substring(0, 100)}..."`);

                // Add to transcriptTurns for in-memory accumulation, recording
                // which persona spoke this turn so downstream prompt builders
                // can label it correctly (otherwise Vitana absorbs Devon's
                // lines as her own past speech — the "Hi I'm Devon in Vitana
                // voice" failure).
                session.transcriptTurns.push({
                  role: 'assistant',
                  text: fullTranscript,
                  timestamp: new Date().toISOString(),
                  persona: ((session as any).activePersona as string | undefined) || 'vitana',
                });

                // Forwarding v2 anti-impersonation guard: detect if this
                // utterance impersonates a different persona ("I am Devon"
                // spoken by anyone NOT Devon, etc). One offense = log +
                // inject a corrective directive into the upstream. Two
                // offenses in a row = hard reconnect with persona override
                // re-applied.
                try {
                  const activePersonaForCheck = ((session as any).activePersona as string | undefined) || 'vitana';
                  const PERSONA_KEYS = ['vitana', 'devon', 'sage', 'atlas', 'mira'];
                  const IMPERSONATION_RE = /\b(?:I(?:'?m| am)|this is|here(?:'?s| is)|on behalf of|me, |it'?s)\s+(vitana|devon|sage|atlas|mira)\b/i;
                  const m = fullTranscript.match(IMPERSONATION_RE);
                  if (m) {
                    const claimed = m[1].toLowerCase();
                    if (PERSONA_KEYS.includes(claimed) && claimed !== activePersonaForCheck) {
                      const driftCount = (((session as any).identityDriftCount as number | undefined) ?? 0) + 1;
                      (session as any).identityDriftCount = driftCount;
                      console.warn(`[VTID-02670] Identity drift detected: active=${activePersonaForCheck}, claimed=${claimed}, count=${driftCount}, utterance="${fullTranscript.substring(0,120)}"`);
                      // Best-effort OASIS log (non-blocking).
                      import('../services/oasis-event-service').then(({ emitOasisEvent }) => {
                        emitOasisEvent({
                          vtid: 'VTID-02670',
                          type: 'orb.persona.identity_drift' as any,
                          source: 'orb-live',
                          status: driftCount > 1 ? 'error' : 'warning',
                          message: `${activePersonaForCheck} introduced themselves as ${claimed}`,
                          payload: {
                            session_id: session.sessionId,
                            active_persona: activePersonaForCheck,
                            claimed_persona: claimed,
                            drift_count: driftCount,
                            utterance: fullTranscript.substring(0, 500),
                          },
                          actor_id: session.identity?.user_id,
                          actor_role: 'system',
                          surface: 'orb',
                          vitana_id: session.identity?.vitana_id ?? undefined,
                        });
                      }).catch(() => undefined);
                      // On REPEAT drift, force-reconnect with the persona
                      // override re-applied. The setup-message builder picks
                      // up the latest persona state on the new connection.
                      if (driftCount >= 2 && session.upstreamWs) {
                        console.warn(`[VTID-02670] Forcing hard reconnect to re-anchor persona ${activePersonaForCheck}`);
                        (session as any)._personaSwapInFlight = true;
                        try { session.upstreamWs.close(); } catch { /* ignore */ }
                      }
                    }
                  }
                } catch { /* non-blocking */ }

                // VTID-01230: Mirror to session buffer (Tier 0 short-term memory)
                if (session.identity && session.identity.tenant_id && session.identity.user_id) {
                  addSessionTurn(session.sessionId, session.identity.tenant_id, session.identity.user_id, 'assistant', fullTranscript);
                  // VTID-01955: Dual-write to Memorystore Redis (multi-instance shared).
                  addTurnRedis(session.sessionId, session.identity.tenant_id, session.identity.user_id, 'assistant', fullTranscript)
                    .catch(() => { /* logged inside redis-turn-buffer */ });
                }

                // Write to memory_items for persistence
                // Use session identity if available, otherwise fall back to DEV_IDENTITY in dev-sandbox
                let memoryIdentity: MemoryIdentity | null = null;
                if (session.identity && session.identity.tenant_id) {
                  memoryIdentity = {
                    user_id: session.identity.user_id,
                    tenant_id: session.identity.tenant_id
                  };
                } else if (isDevSandbox()) {
                  console.log(`[VTID-01225] No session identity, using DEV_IDENTITY fallback`);
                  memoryIdentity = {
                    user_id: DEV_IDENTITY.USER_ID,
                    tenant_id: DEV_IDENTITY.TENANT_ID
                  };
                } else {
                  console.warn(`[VTID-01225] Cannot write to memory: no identity and not dev-sandbox`);
                }

                // VTID-01225-CLEANUP: Do NOT write assistant responses to memory_items.
                // Assistant output is derivative (generated from user input + system prompt).
                // Storing it causes pollution — "nice to meet you", "let me help you with that", etc.
                // User facts are extracted to memory_facts via inline-fact-extractor instead.
                if (memoryIdentity) {
                  console.log(`[VTID-01225-CLEANUP] Skipping assistant transcript write to memory_items (pollution prevention)`);
                }
              }

              // Clear buffer for next turn
              session.outputTranscriptBuffer = '';
            }

            // VTID-CHAT-BRIDGE: Write voice transcripts to chat_messages so they appear
            // as a Vitana DM conversation. Fire-and-forget to avoid blocking the voice pipeline.
            // Explicit created_at timestamps ensure user message always sorts before Vitana reply.
            if (session.identity?.user_id && session.identity?.tenant_id) {
              const bridgeSupabase = getSupabase();
              if (bridgeSupabase) {
                const bridgeUserId = session.identity.user_id;
                const bridgeTenantId = session.identity.tenant_id;
                const bridgeMeta = {
                  orb_session_id: session.sessionId,
                  turn_index: session.turn_count,
                  voice_language: session.lang,
                };
                const userMsgTime = new Date();
                const assistantMsgTime = new Date(userMsgTime.getTime() + 1); // +1ms ensures correct sort order

                // User speech → chat_messages (sender=user, receiver=Vitana)
                if (chatBridgeUserText.length > 0) {
                  bridgeSupabase.from('chat_messages').insert({
                    tenant_id: bridgeTenantId,
                    sender_id: bridgeUserId,
                    receiver_id: VITANA_BOT_USER_ID,
                    content: chatBridgeUserText,
                    message_type: 'voice_transcript',
                    metadata: { ...bridgeMeta, direction: 'user_to_vitana' },
                    created_at: userMsgTime.toISOString(),
                  }).then(({ error }) => {
                    if (error) console.warn(`[VTID-CHAT-BRIDGE] User transcript write failed: ${error.message}`);
                  });
                }

                // Vitana speech → chat_messages (sender=Vitana, receiver=user)
                // Pre-set read_at since user already heard this during the voice session
                if (chatBridgeAssistantText.length > 0) {
                  bridgeSupabase.from('chat_messages').insert({
                    tenant_id: bridgeTenantId,
                    sender_id: VITANA_BOT_USER_ID,
                    receiver_id: bridgeUserId,
                    content: chatBridgeAssistantText,
                    message_type: 'voice_transcript',
                    metadata: { ...bridgeMeta, direction: 'vitana_to_user', is_greeting: isGreetingTurn },
                    read_at: assistantMsgTime.toISOString(),
                    created_at: assistantMsgTime.toISOString(),
                  }).then(({ error }) => {
                    if (error) console.warn(`[VTID-CHAT-BRIDGE] Vitana transcript write failed: ${error.message}`);
                  });
                }
              }
            }

            // VTID-01225-THROTTLE: Incremental fact extraction — throttled to max once per 60s.
            // Fires a separate Vertex AI generateContent call, so running it on every turn
            // creates concurrent API calls that can hit rate limits and destabilize the
            // Live API WebSocket. The 60s throttle preserves durability (facts survive
            // disconnects) without hammering the API during active conversation.
            const EXTRACTION_THROTTLE_MS = 60_000;
            // VTID-01230: Deduplicated extraction replaces manual throttle logic
            // VTID-NAV: When a navigation is queued, force the extraction so the
            // last turn before session close always contributes to memory facts.
            if (session.identity && session.identity.tenant_id) {
              const recentTurns = session.transcriptTurns.slice(-4);
              if (recentTurns.length > 0) {
                const recentText = recentTurns
                  .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
                  .join('\n');
                deduplicatedExtract({
                  conversationText: recentText,
                  tenant_id: session.identity.tenant_id,
                  user_id: session.identity.user_id,
                  session_id: session.sessionId,
                  turn_count: session.turn_count,
                  force: !!session.pendingNavigation,
                });
              }
            }

            // VTID-NAV: Dispatch the orb_directive for any pending navigation.
            // This MUST come AFTER the memory flush, chat_messages bridge, and
            // fact extractor above so the navigation turn's memory writes are
            // committed before the widget tears down the session.
            if (session.pendingNavigation) {
              const nav = session.pendingNavigation;
              const directive = {
                type: 'orb_directive',
                directive: 'navigate',
                screen_id: nav.screen_id,
                route: nav.route,
                title: nav.title,
                reason: nav.reason,
                vtid: 'VTID-NAV-01',
              };
              const directiveJson = JSON.stringify(directive);
              if (session.sseResponse) {
                try { session.sseResponse.write(`data: ${directiveJson}\n\n`); } catch (_e) { /* SSE closed */ }
              }
              if ((session as any).clientWs && (session as any).clientWs.readyState === WebSocket.OPEN) {
                try { sendWsMessage((session as any).clientWs, directive); } catch (_e) { /* WS closed */ }
              }
              console.log(`[VTID-NAV-01] orb_directive dispatched: navigate to ${nav.screen_id} (${nav.route}) — session=${session.sessionId}`);
              emitOasisEvent({
                vtid: 'VTID-NAV-01',
                type: 'orb.navigator.dispatched',
                source: 'orb-live-ws',
                status: 'info',
                message: `dispatched navigate to ${nav.screen_id}`,
                payload: {
                  session_id: session.sessionId,
                  screen_id: nav.screen_id,
                  route: nav.route,
                  decision_source: nav.decision_source,
                  drain_wait_ms: Date.now() - nav.requested_at,
                },
              }).catch(() => {});
              // Clear pending so we don't re-dispatch on subsequent turns.
              // navigationDispatched stays TRUE so input audio stays gated until
              // the widget closes the connection.
              session.pendingNavigation = undefined;
            } else {
              // VTID-NAV-DIAG: turn_complete fired but no navigation was queued.
              // This is what "stuck in listening after asking for redirect" looks
              // like server-side. If we see this log line after a user asked for
              // a redirect, it means Gemini never called navigate_to_screen.
              console.log(`[VTID-NAV-DIAG] turn_complete for session ${session.sessionId}: NO pendingNavigation (navigationDispatched=${!!session.navigationDispatched}, consecutiveToolCalls=${session.consecutiveToolCalls}) — widget will transition to listening`);
            }

            // Notify client that response is complete
            if (session.sseResponse) {
              session.sseResponse.write(`data: ${JSON.stringify({
                type: 'turn_complete',
                is_greeting: isGreetingTurn
              })}\n\n`);
            }
            // Notify WS client via callback
            onTurnComplete?.();
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
                // VTID-NAV-HOTFIX: Once navigation is queued, drop ALL further
                // audio from Gemini. After navigate_to_screen fires, Gemini's
                // tool-use protocol FORCES a model response to the
                // function_response — that response IS a second (Turn 2) audio
                // stream that would arrive at the widget before Turn 1's
                // turn_complete and overlap the transition sentence the user
                // is already hearing. The flag is set synchronously inside
                // handleNavigateToScreen BEFORE sendFunctionResponseToLiveAPI
                // is called, so by the time Gemini even produces Turn 2 audio,
                // this gate is already armed.
                if (session.navigationDispatched) {
                  session.audioOutChunks++;
                  if (session.audioOutChunks % 50 === 1) {
                    console.log(`[VTID-NAV-HOTFIX] Dropping post-nav audio chunk ${session.audioOutChunks} for session ${session.sessionId}`);
                  }
                  continue;
                }
                // VTID-VOICE-INIT: Mark model as speaking on first audio chunk
                // This gates inbound mic audio to prevent echo-triggered interruptions
                if (!session.isModelSpeaking) {
                  session.isModelSpeaking = true;
                  // VTID-TOOLGUARD: Model produced audio — reset tool call counter
                  session.consecutiveToolCalls = 0;
                  // VTID-01984 (R5): Vertex has spoken — upstream WS is healthy.
                  // Once true, the audio-forwarding paths skip arming the
                  // forwarding_no_ack watchdog so we never kill a healthy
                  // session in the middle of Vertex computing a follow-up turn.
                  session.vertexHasShownLife = true;
                  console.log(`[VTID-VOICE-INIT] Model started speaking for session ${session.sessionId} — mic audio gated`);
                  emitDiag(session, 'model_start_speaking');
                  // BOOTSTRAP-ORB-HOTFIX-1: If this is the greeting (no turns yet
                  // and greeting was sent), emit the pre-greeting latency gauge.
                  //
                  // BOOTSTRAP-ORB-RELIABILITY-R2: Log gate evaluation so we can
                  // debug why the prior gauge version emitted zero events. All
                  // three booleans are logged so we can spot which guard is
                  // falsifying the condition in prod.
                  const gateGreeting = !!session.greetingSent;
                  const gateTurnZero = session.turn_count === 0;
                  const gateNoChunks = !session.audioOutChunks;
                  console.log(`[BOOTSTRAP-ORB-HOTFIX-1-GATE] session=${session.sessionId} greetingSent=${gateGreeting} turn_count=${session.turn_count} audioOutChunks=${session.audioOutChunks}`);
                  if (gateGreeting && gateTurnZero && gateNoChunks) {
                    const preGreetingMs = Date.now() - session.createdAt.getTime();
                    emitLiveSessionEvent('orb.live.greeting.delivered', {
                      session_id: session.sessionId,
                      user_id: session.identity?.user_id || 'anonymous',
                      tenant_id: session.identity?.tenant_id || null,
                      transport: session.clientWs ? 'websocket' : 'sse',
                      pre_greeting_ms: preGreetingMs,
                      lang: session.lang,
                      is_anonymous: session.isAnonymous || false,
                      reconnect_count: (session as any)._reconnectCount || 0,
                    }).catch((err: any) => {
                      console.warn(`[BOOTSTRAP-ORB-HOTFIX-1] emit failed: ${err?.message || err}`);
                    });
                    console.log(`[BOOTSTRAP-ORB-HOTFIX-1] pre_greeting_ms=${preGreetingMs} for session ${session.sessionId}`);
                  }
                }
                // VTID-WATCHDOG: Model is sending audio — restart watchdog.
                // If audio stops mid-stream (no turn_complete), watchdog fires.
                startResponseWatchdog(session, TURN_RESPONSE_TIMEOUT_MS, 'audio_stall');
                session.audioOutChunks++;
                const audioB64 = inlineData.data;
                // VTID-STREAM-KEEPALIVE: Only log every 50th audio chunk to reduce log volume
                if (session.audioOutChunks % 50 === 1) {
                  console.log(`[VTID-01219] Audio chunk ${session.audioOutChunks}, size: ${audioB64.length}`);
                }
                onAudioResponse(audioB64);

                // VTID-STREAM-KEEPALIVE: Removed per-chunk OASIS event emission.
                // emitLiveSessionEvent fires an HTTP call to Supabase on every audio chunk
                // (dozens per second). This creates massive I/O pressure and slows the event loop.
                // Audio stats are logged at session stop instead.
              }

              // Handle text response
              if (part.text) {
                // VTID-WATCHDOG: Model is responding with text — restart watchdog.
                // If text stops mid-stream (no turn_complete), watchdog fires.
                startResponseWatchdog(session, TURN_RESPONSE_TIMEOUT_MS, 'text_stall');
                console.log(`[VTID-01219] Received text: ${part.text.substring(0, 100)}`);
                onTextResponse(part.text);
              }
            }
          }

          // Handle input/output transcriptions if present (handle both formats)
          // VTID-01225: Gemini returns transcription as object with .text property
          const inputTransObj = content.input_transcription || content.inputTranscription;
          const outputTransObj = content.output_transcription || content.outputTranscription;
          // Debug: Log raw transcription objects to understand Gemini response format
          if (inputTransObj || outputTransObj) {
            console.log(`[VTID-01225] Raw transcription objects - input: ${JSON.stringify(inputTransObj)}, output: ${JSON.stringify(outputTransObj)}`);
          }
          // Extract text - handle both object format (.text) and direct string format
          const inputTranscription = typeof inputTransObj === 'string' ? inputTransObj : inputTransObj?.text;
          const outputTranscription = typeof outputTransObj === 'string' ? outputTransObj : outputTransObj?.text;
          if (inputTranscription) {
            // Filter out the server-injected greeting prompt from transcription/memory
            const isGreetingPrompt = session.greetingSent && session.turn_count === 0 &&
              (inputTranscription.includes('greet the user') || inputTranscription.includes('begrüße den Benutzer'));
            if (isGreetingPrompt) {
              console.log(`[VTID-VOICE-INIT] Filtering greeting prompt from input transcription: "${inputTranscription.substring(0, 60)}..."`);
            } else {
              console.log(`[VTID-01219] Input transcription: ${inputTranscription}`);
              // VTID-01984 (R5): Vertex's VAD fired and produced a transcription —
              // upstream WS is demonstrably healthy. Mark life signal so subsequent
              // user-audio chunks don't arm the forwarding_no_ack watchdog (which
              // was destroying healthy sessions when first-turn inference exceeded
              // 15 s). Real WS failures are still caught by native handlers.
              session.vertexHasShownLife = true;
              emitDiag(session, 'input_transcription', { text_preview: inputTranscription.substring(0, 80) });
              if (session.sseResponse) {
                session.sseResponse.write(`data: ${JSON.stringify({ type: 'input_transcript', text: inputTranscription })}\n\n`);
              }
              // VTID-01225-THROTTLE: Buffer user input transcription instead of writing per-fragment.
              // Vertex Live API sends transcription incrementally (multiple fragments per utterance).
              // Writing per-fragment caused N parallel Supabase requests per sentence. Now we
              // accumulate in inputTranscriptBuffer and write once at turn_complete.
              session.inputTranscriptBuffer += (session.inputTranscriptBuffer ? ' ' : '') + inputTranscription;

              // VTID-LOOPGUARD: User spoke — reset consecutive model turn counter
              session.consecutiveModelTurns = 0;
              // VTID-TOOLGUARD: User spoke — reset consecutive tool call counter
              session.consecutiveToolCalls = 0;
              // VTID-LOOPGUARD: Re-enable silence keepalive if it was paused
              if (!session.silenceKeepaliveInterval && session.upstreamWs) {
                session.silenceKeepaliveInterval = setInterval(() => {
                  if (!session.upstreamWs || session.upstreamWs.readyState !== WebSocket.OPEN || !session.active) return;
                  if (session.isModelSpeaking) return;
                  const idleMs = Date.now() - session.lastAudioForwardedTime;
                  if (idleMs >= SILENCE_IDLE_THRESHOLD_MS) {
                    try {
                      sendAudioToLiveAPI(session.upstreamWs, SILENCE_AUDIO_B64, 'audio/pcm;rate=16000');
                    } catch (_e) { /* WS closing */ }
                  }
                }, SILENCE_KEEPALIVE_INTERVAL_MS);
              }

              // VTID-WATCHDOG: User spoke — start watchdog waiting for model response.
              // Restart on each transcript fragment to give the model time from the
              // LAST user speech, not the first (user may still be speaking).
              startResponseWatchdog(session, TURN_RESPONSE_TIMEOUT_MS, 'response_timeout');

              // VTID-THINKING: Notify client that model is processing (user spoke, waiting for response).
              // Client uses this to show "Thinking..." state instead of staying on "Listening...".
              if (!session.isModelSpeaking) {
                const thinkingMsg = { type: 'thinking' };
                if (session.sseResponse) {
                  try { session.sseResponse.write(`data: ${JSON.stringify(thinkingMsg)}\n\n`); } catch (_e) { /* SSE closed */ }
                }
                if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
                  try { sendWsMessage(session.clientWs, thinkingMsg); } catch (_e) { /* WS closed */ }
                }
              }
            }
          }
          if (outputTranscription) {
            // VTID-NAV-HOTFIX: Drop Turn 2 transcription the same way we drop
            // Turn 2 audio. Without this, memory + chat bridge would capture
            // the post-nav model response even though the user never heard it.
            if (session.navigationDispatched) {
              console.log(`[VTID-NAV-HOTFIX] Dropping post-nav output transcription: "${outputTranscription.substring(0, 60)}..."`);
            } else {
              console.log(`[VTID-01219] Output transcription: ${outputTranscription}`);
              if (session.sseResponse) {
                session.sseResponse.write(`data: ${JSON.stringify({ type: 'output_transcript', text: outputTranscription })}\n\n`);
              }
              // VTID-01225: Accumulate output transcription chunks in buffer (will be written on turnComplete)
              session.outputTranscriptBuffer += outputTranscription;
            }
          }
        }

        // VTID-01224: Handle tool calls (function calling) - execute and respond
        const toolCall = message.tool_call || message.toolCall;
        if (toolCall) {
          const toolNames = (toolCall.function_calls || toolCall.functionCalls || []).map((fc: any) => fc.name);
          session.consecutiveToolCalls++;
          console.log(`[VTID-01224] Tool call received for session ${session.sessionId} (consecutive: ${session.consecutiveToolCalls}/${MAX_CONSECUTIVE_TOOL_CALLS}):`, JSON.stringify(toolCall).substring(0, 500));
          emitDiag(session, 'tool_call', { tools: toolNames, consecutive: session.consecutiveToolCalls });

          // VTID-THINKING: Notify client that model is processing a tool call.
          // Shows "Thinking..." while memory search, event search etc. execute.
          const toolThinkingMsg = { type: 'thinking', reason: 'tool_call', tools: toolNames };
          if (session.sseResponse) {
            try { session.sseResponse.write(`data: ${JSON.stringify(toolThinkingMsg)}\n\n`); } catch (_e) { /* SSE closed */ }
          }
          if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
            try { sendWsMessage(session.clientWs, toolThinkingMsg); } catch (_e) { /* WS closed */ }
          }

          // Extract function calls (handle both formats)
          const functionCalls = toolCall.function_calls || toolCall.functionCalls || [];

          // VTID-TOOLGUARD: If too many consecutive tool calls without audio,
          // we break the loop by sending synthetic responses that instruct
          // Gemini to answer with data already gathered. Previously we silently
          // DROPPED the responses — but that left Gemini blocked waiting on
          // function_responses that never arrived, producing zombie upstream
          // sessions (no input_transcription, no audio) and ultimately
          // `watchdog_fired` with reason `forwarding_no_ack`. Sending a
          // synthetic response keeps the Live API protocol intact while still
          // forcing the model out of the tool-call loop.
          if (session.consecutiveToolCalls > MAX_CONSECUTIVE_TOOL_CALLS) {
            console.warn(`[VTID-TOOLGUARD] Tool call loop detected for session ${session.sessionId}: ${session.consecutiveToolCalls} consecutive calls (limit: ${MAX_CONSECUTIVE_TOOL_CALLS}). Sending synthetic loop-break response.`);
            emitDiag(session, 'tool_loop_guard', { consecutive: session.consecutiveToolCalls, dropped_tools: toolNames });
            emitLiveSessionEvent('orb.live.tool_loop_guard_activated', {
              session_id: session.sessionId,
              consecutive: session.consecutiveToolCalls,
              tools: toolNames,
              function_call_count: functionCalls.length,
            }, 'warning').catch(() => { });
            for (const fc of functionCalls) {
              const callId = fc.id || randomUUID();
              sendFunctionResponseToLiveAPI(ws, callId, fc.name, {
                success: false,
                result: '',
                error: 'Tool loop guard: too many consecutive tool calls. Respond to the user now with the information already gathered from earlier tool results. Do not call any more tools in this turn.',
              });
            }
          } else {
            for (const fc of functionCalls) {
            const toolName = fc.name;
            const toolArgs = fc.args || {};
            const callId = fc.id || randomUUID();

            console.log(`[VTID-01224] Executing tool: ${toolName} with args: ${JSON.stringify(toolArgs)}`);

            // Execute the tool asynchronously
            const toolStartTime = Date.now();
            executeLiveApiTool(session, toolName, toolArgs)
              .then((result) => {
                const toolElapsed = Date.now() - toolStartTime;
                console.log(`[VTID-01224] Tool ${toolName} completed in ${toolElapsed}ms, success=${result.success}, resultLen=${result.result.length}`);

                // VTID-LINK: Extract title+URL pairs from tool results and send to client.
                // Vitana won't say URLs in voice, so we push them to chat via SSE/WS.
                // Tool results are formatted as "Title | Date | Location | ... | Link: URL"
                if (result.success && result.result) {
                  const linkPairs: { title: string; url: string }[] = [];
                  const lines = result.result.split('\n');
                  for (const line of lines) {
                    const linkMatch = line.match(/\| Link: (https?:\/\/[^\s|]+)/);
                    if (linkMatch) {
                      const url = linkMatch[1];
                      const title = line.split('|')[0].trim();
                      if (url && title && !linkPairs.some(p => p.url === url)) {
                        linkPairs.push({ title, url });
                      }
                    }
                  }
                  // Fallback: extract any remaining URLs not captured by the structured format
                  if (linkPairs.length === 0) {
                    const urlRegex = /https?:\/\/[^\s"',)}\]]+/g;
                    const urls = result.result.match(urlRegex);
                    if (urls) {
                      for (const url of [...new Set(urls)]) {
                        if (!linkPairs.some(p => p.url === url)) {
                          linkPairs.push({ title: '', url });
                        }
                      }
                    }
                  }
                  if (linkPairs.length > 0) {
                    for (const { url } of linkPairs) {
                      const linkMsg = { type: 'link', url, tool: toolName };
                      if (session.sseResponse) {
                        try { session.sseResponse.write(`data: ${JSON.stringify(linkMsg)}\n\n`); } catch (_e) { /* SSE closed */ }
                      }
                      if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
                        try { sendWsMessage(session.clientWs, linkMsg); } catch (_e) { /* WS closed */ }
                      }
                    }
                    console.log(`[VTID-LINK] Sent ${linkPairs.length} link(s) to client from ${toolName}: ${linkPairs.map(p => p.url).join(', ')}`);
                    // VTID-LINK-INJECT: Store title+URL pairs for injection into output transcript at turn_complete
                    session.pendingEventLinks.push(...linkPairs);
                  }
                }

                // Send response back to Live API
                const sent = sendFunctionResponseToLiveAPI(ws, callId, toolName, result);
                if (!sent) {
                  console.error(`[VTID-01224] function_response NOT sent for ${toolName} — WebSocket no longer open. Session ${session.sessionId} may be stalled.`);
                }

                // Emit OASIS event for tool execution
                emitOasisEvent({
                  vtid: 'VTID-01224',
                  type: 'orb.live.tool.executed',
                  source: 'orb-live-ws',
                  status: result.success ? 'info' : 'warning',
                  message: `Tool ${toolName} executed in ${toolElapsed}ms: ${result.success ? 'success' : 'failed'}`,
                  payload: {
                    session_id: session.sessionId,
                    tool_name: toolName,
                    tool_args: toolArgs,
                    success: result.success,
                    result_length: result.result.length,
                    elapsed_ms: toolElapsed,
                    response_sent: sent,
                    result_preview: result.result.substring(0, 200),
                    error: result.error || null,
                  },
                }).catch(() => { });
              })
              .catch((err) => {
                const toolElapsed = Date.now() - toolStartTime;
                console.error(`[VTID-01224] Tool ${toolName} threw after ${toolElapsed}ms:`, err);
                sendFunctionResponseToLiveAPI(ws, callId, toolName, {
                  success: false,
                  result: '',
                  error: err.message,
                });
              });
            }
          } // end else (tool guard)
        }

      } catch (err) {
        console.error(`[VTID-01219] Error parsing Live API message:`, err);
      }
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
      console.error(`[VTID-01219] Live API WebSocket error for session ${session.sessionId}:`, error);
      emitDiag(session, 'upstream_ws_error', { error: (error as any)?.message || String(error) });
      clearTimeout(connectionTimeout);
      // VTID-STREAM-KEEPALIVE: Clear ping interval on error too
      if (session.upstreamPingInterval) {
        clearInterval(session.upstreamPingInterval);
        session.upstreamPingInterval = undefined;
      }
      if (session.silenceKeepaliveInterval) {
        clearInterval(session.silenceKeepaliveInterval);
        session.silenceKeepaliveInterval = undefined;
      }
      // VTID-WATCHDOG: Send connection_issue immediately (best-effort).
      // Do NOT clear the watchdog — if this SSE/WS send fails (pipe broken),
      // the watchdog will fire later as a backup.
      // VTID-02637: dedupe — error and close handlers both fire on the same
      // disconnect. Without the flag the user heard "internet problems" twice.
      if (session.active && !session.connectionIssueEmitted) {
        session.connectionIssueEmitted = true;
        const lang = session.lang || 'en';
        const issueEvent = {
          type: 'connection_issue',
          reason: 'upstream_error',
          message: connectionIssueMessages[lang] || connectionIssueMessages['en'],
          should_close: true,
        };
        if (session.sseResponse) {
          try { session.sseResponse.write(`data: ${JSON.stringify(issueEvent)}\n\n`); } catch (_e) { /* ignore */ }
        }
        if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
          try { session.clientWs.send(JSON.stringify(issueEvent)); } catch (_e) { /* ignore */ }
        }
      }

      if (!setupComplete) {
        reject(error);
      }
      onError(error);
    });

    // Handle WebSocket close
    ws.on('close', (code, reason) => {
      console.log(`[VTID-01219] Live API WebSocket closed for session ${session.sessionId}: code=${code}, reason=${reason}`);
      emitDiag(session, 'upstream_ws_close', { code, reason: reason?.toString() || '' });

      // VTID-02047 voice channel-swap: when this close was triggered by a
      // persona swap (turn_complete handler closes upstream after Vitana's
      // bridge), suppress the noisy "connection_alert" that makes the widget
      // speak "Einen Moment, ich verbinde mich neu" on top of the bridge
      // sentence. Send a silent persona_swap_reconnecting cue instead so the
      // widget can pause mic without TTS overlap. Both close-reason match AND
      // the in-flight flag are used so back-to-Vitana works (where the swap
      // also clears personaSystemOverride).
      const reasonStr = reason?.toString() || '';
      const isPersonaSwap = reasonStr === 'persona_swap' || !!(session as any)._personaSwapInFlight;

      // BOOTSTRAP-ORB-DISCONNECT-ALERT: Tell the client *immediately* that the
      // upstream went away. The existing `reconnecting` message is only sent
      // once attemptTransparentReconnect runs (after deduplicated extraction
      // and other bookkeeping), which can be 100ms-1s+ later. Closing that gap
      // lets the widget stop the user mid-sentence with a spoken cue instead
      // of letting them talk into a dead socket.
      if (session.active && setupComplete) {
        const alertMsg = isPersonaSwap
          ? { type: 'persona_swap_reconnecting', reason: 'persona_swap' }
          : { type: 'connection_alert', reason: 'upstream_ws_close' };
        if (session.sseResponse) {
          try { session.sseResponse.write(`data: ${JSON.stringify(alertMsg)}\n\n`); } catch (_e) { /* SSE may be closed */ }
        } else if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
          try { session.clientWs.send(JSON.stringify(alertMsg)); } catch (_e) { /* WS may be closed */ }
        }
      }

      clearTimeout(connectionTimeout);

      // VTID-STREAM-KEEPALIVE: Clear upstream ping interval
      if (session.upstreamPingInterval) {
        clearInterval(session.upstreamPingInterval);
        session.upstreamPingInterval = undefined;
      }
      if (session.silenceKeepaliveInterval) {
        clearInterval(session.silenceKeepaliveInterval);
        session.silenceKeepaliveInterval = undefined;
      }

      session.upstreamWs = null;

      if (!setupComplete) {
        reject(new Error(`WebSocket closed before setup: code=${code}, reason=${reason}`));
      } else if ((code === 1000 && session.active) || ((session as any)._stallRecoveryPending && session.active)) {
        // VTID-STREAM-RECONNECT: Transparent reconnection for two cases:
        // 1. Code 1000 = Vertex ended the session normally (5-min limit)
        // 2. _stallRecoveryPending = watchdog detected a stall and force-terminated the WS
        const isStallRecovery = !!(session as any)._stallRecoveryPending;
        (session as any)._stallRecoveryPending = false;
        const reconnectReason = isStallRecovery ? 'stall_recovery' : 'session_expired';
        console.log(`[VTID-STREAM-RECONNECT] ${reconnectReason} on active session ${session.sessionId} — attempting transparent reconnect`);
        emitDiag(session, 'reconnect_triggered', { reason: reconnectReason, code });

        // VTID-01230: Deduplicated extraction before reconnecting
        if (session.identity && session.identity.tenant_id && session.transcriptTurns.length > 0) {
          const allText = session.transcriptTurns
            .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
            .join('\n');
          deduplicatedExtract({
            conversationText: allText,
            tenant_id: session.identity.tenant_id,
            user_id: session.identity.user_id,
            session_id: session.sessionId,
            turn_count: session.turn_count,
          });
        }

        // Attempt reconnection (async, fire-and-forget from close handler perspective)
        attemptTransparentReconnect(
          session,
          onAudioResponse,
          onTextResponse,
          onError,
          onTurnComplete,
          onInterrupted
        ).then(reconnected => {
          if (!reconnected) {
            // Reconnection failed — notify client as final disconnect (SSE or WS)
            console.warn(`[VTID-STREAM-RECONNECT] Reconnection failed for ${session.sessionId} — notifying client`);
            const failMsg = { type: 'live_api_disconnected', code, reason: `${reconnectReason}_reconnect_failed` };
            const lang = session.lang || 'en';
            const issueEvent = {
              type: 'connection_issue',
              reason: 'upstream_disconnected',
              message: connectionIssueMessages[lang] || connectionIssueMessages['en'],
              should_close: true,
            };
            // VTID-02637: dedupe — only emit if we haven't already.
            const shouldEmitIssue = !session.connectionIssueEmitted;
            if (shouldEmitIssue) session.connectionIssueEmitted = true;
            if (session.sseResponse) {
              try { session.sseResponse.write(`data: ${JSON.stringify(failMsg)}\n\n`); } catch (e) { /* ignore */ }
              if (shouldEmitIssue) try { session.sseResponse.write(`data: ${JSON.stringify(issueEvent)}\n\n`); } catch (e) { /* ignore */ }
            } else if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
              try { sendWsMessage(session.clientWs, failMsg); } catch (e) { /* ignore */ }
              if (shouldEmitIssue) try { session.clientWs.send(JSON.stringify(issueEvent)); } catch (e) { /* ignore */ }
            }
          } else if (isStallRecovery) {
            // VTID-STALL-FIX: Reconnect succeeded after stall.
            // Reset loop counter so loopguard doesn't fire prematurely on the fresh connection
            session.consecutiveModelTurns = 0;

            // VTID-GREETING-RECOVERY: If the stall happened before any turns completed
            // (i.e. the greeting itself timed out), reset greetingSent so the greeting
            // is re-sent on the new upstream connection. Without this, the session stays
            // at 0 turns forever because sendGreetingPromptToLiveAPI skips when greetingSent=true.
            if (session.turn_count === 0 && session.greetingSent) {
              console.log(`[VTID-GREETING-RECOVERY] Greeting stall detected for ${session.sessionId} — resetting greetingSent to re-send on new connection`);
              session.greetingSent = false;
              session.greetingTurnIndex = undefined;
              // Send greeting on the new upstream connection
              if (session.upstreamWs && session.upstreamWs.readyState === WebSocket.OPEN) {
                sendGreetingPromptToLiveAPI(session.upstreamWs, session);
              }
              emitDiag(session, 'greeting_recovery', { reconnect_count: (session as any)._reconnectCount || 0 });
            } else {
              // Mid-conversation stall — do NOT re-greet.
              // Conversation history is already injected into the new upstream session's
              // system instruction by connectToLiveAPI(). Re-greeting caused the assistant
              // to say "Hello Dragan!" repeatedly during an ongoing conversation (4x in 1 min).
              console.log(`[VTID-STALL-FIX] Stall recovery reconnect succeeded for ${session.sessionId} — resuming silently (no re-greeting)`);
              emitDiag(session, 'stall_recovery_resumed', { reconnect_count: (session as any)._reconnectCount || 0 });
            }
          }
        }).catch(err => {
          console.error(`[VTID-STREAM-RECONNECT] Reconnection error for ${session.sessionId}: ${err.message}`);
        });
      } else {
        // Non-1000 close or session already inactive — genuine disconnect
        console.log(`[VTID-STREAM-KEEPALIVE] Genuine disconnect for ${session.sessionId}: code=${code}, active=${session.active}`);
        // VTID-WATCHDOG: Do NOT clear watchdog here — if SSE/WS send below fails,
        // the watchdog serves as backup to notify the client.

        const disconnectMsg = { type: 'live_api_disconnected', code, reason: reason?.toString() || 'upstream closed' };
        // VTID-WATCHDOG: Send connection_issue with user-facing message on genuine disconnect
        const lang = session.lang || 'en';
        const issueEvent = {
          type: 'connection_issue',
          reason: 'upstream_disconnected',
          message: connectionIssueMessages[lang] || connectionIssueMessages['en'],
          should_close: true,
        };
        // VTID-02637: dedupe — error handler may already have emitted.
        const shouldEmitIssue = !session.connectionIssueEmitted;
        if (shouldEmitIssue) session.connectionIssueEmitted = true;
        if (session.sseResponse) {
          try { session.sseResponse.write(`data: ${JSON.stringify(disconnectMsg)}\n\n`); } catch (e) { /* SSE may be closed */ }
          if (shouldEmitIssue) try { session.sseResponse.write(`data: ${JSON.stringify(issueEvent)}\n\n`); } catch (e) { /* SSE may be closed */ }
        } else if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
          try { sendWsMessage(session.clientWs, disconnectMsg); } catch (e) { /* WS may be closed */ }
          if (shouldEmitIssue) try { session.clientWs.send(JSON.stringify(issueEvent)); } catch (e) { /* WS may be closed */ }
        }

        // Fire final extraction on genuine disconnect
        if (session.identity && session.identity.tenant_id && session.transcriptTurns.length > 0) {
          const allText = session.transcriptTurns
            .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
            .join('\n');
          // VTID-01230: Force extraction on disconnect (session end)
          deduplicatedExtract({
            conversationText: allText,
            tenant_id: session.identity.tenant_id,
            user_id: session.identity.user_id,
            session_id: session.sessionId,
            force: true,
          });
          // Clean up session buffer and extraction state
          destroySessionBuffer(session.sessionId);
          clearExtractionState(session.sessionId);
        }
      }
    });
  });
}

/**
 * VTID-STREAM-RECONNECT: Transparently reconnect to Vertex AI Live API when session expires.
 * The Gemini Live API has a hard ~5-minute session limit (closes with code 1000).
 * This function creates a new upstream WebSocket, injects conversation history into
 * the system instruction, and resumes streaming — the client (SSE/WS) never notices.
 *
 * MAX_RECONNECTS prevents infinite reconnection loops.
 */
const MAX_RECONNECTS = 10; // Max reconnections per session (~50 min total)

async function attemptTransparentReconnect(
  session: GeminiLiveSession,
  onAudioResponse: (audioB64: string) => void,
  onTextResponse: (text: string) => void,
  onError: (error: Error) => void,
  onTurnComplete?: () => void,
  onInterrupted?: () => void
): Promise<boolean> {
  // Track reconnect count on the session object
  const reconnectCount = (session as any)._reconnectCount || 0;
  if (reconnectCount >= MAX_RECONNECTS) {
    console.warn(`[VTID-STREAM-RECONNECT] Max reconnects (${MAX_RECONNECTS}) reached for ${session.sessionId} — stopping`);
    return false;
  }
  (session as any)._reconnectCount = reconnectCount + 1;

  if (!session.active) {
    console.log(`[VTID-STREAM-RECONNECT] Session ${session.sessionId} is no longer active — skipping reconnect`);
    return false;
  }

  console.log(`[VTID-STREAM-RECONNECT] Attempting transparent reconnect #${reconnectCount + 1} for session ${session.sessionId} (${session.transcriptTurns.length} turns accumulated)`);

  // VTID-02047 voice channel-swap: skip the "reconnecting…" client message
  // entirely when the close was triggered by a persona swap. Vitana already
  // spoke the bridge sentence; sending another "reconnecting" cue just makes
  // the widget speak "Einen Moment, ich verbinde mich neu" on top of her.
  // The persona_swap_reconnecting event already went out from the close
  // handler with type="persona_swap_reconnecting" which the widget treats
  // as a silent UI cue. Uses the _personaSwapInFlight flag so both swap
  // directions (Vitana ↔ specialist) are covered.
  const isPersonaSwap = !!(session as any)._personaSwapInFlight;

  if (!isPersonaSwap) {
    // Notify client that we're reconnecting (informational, not an error)
    // Works for both SSE and WS transports
    const reconnectMsg = { type: 'reconnecting', reconnect_count: reconnectCount + 1, message: 'Extending session...' };
    if (session.sseResponse) {
      try { session.sseResponse.write(`data: ${JSON.stringify(reconnectMsg)}\n\n`); } catch (e) { /* SSE may be closed */ }
    } else if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
      try { sendWsMessage(session.clientWs, reconnectMsg); } catch (e) { /* WS may be closed */ }
    }
  } else {
    console.log(`[VTID-02047] Persona swap reconnect — suppressing reconnect TTS announcement`);
  }

  try {
    const newWs = await connectToLiveAPI(
      session,
      onAudioResponse,
      onTextResponse,
      onError,
      onTurnComplete,
      onInterrupted
    );

    session.upstreamWs = newWs;
    // Reset loop counter — fresh upstream connection starts clean
    session.consecutiveModelTurns = 0;
    // VTID-02637: clear the dedupe flag so a future genuine disconnect can
    // surface a fresh connection_issue. Without this, the user would never
    // see a disconnect message again after the first transparent reconnect.
    session.connectionIssueEmitted = false;
    console.log(`[VTID-STREAM-RECONNECT] Reconnected successfully for session ${session.sessionId} (reconnect #${reconnectCount + 1})`);

    // Notify client that reconnection succeeded (both SSE and WS).
    // Persona-swap path uses a different type so the widget doesn't speak
    // the "Okay, das Netz ist wieder da" recovery line — the new persona
    // greets in their own voice, which is the correct cue.
    const reconnectedMsg = isPersonaSwap
      ? { type: 'persona_swap_reconnected', persona: (session as any).activePersona }
      : { type: 'reconnected', reconnect_count: reconnectCount + 1 };
    if (session.sseResponse) {
      try { session.sseResponse.write(`data: ${JSON.stringify(reconnectedMsg)}\n\n`); } catch (e) { /* SSE may be closed */ }
    } else if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
      try { sendWsMessage(session.clientWs, reconnectedMsg); } catch (e) { /* WS may be closed */ }
    }

    // After a successful persona swap, send a one-shot client_content nudge
    // that triggers the new persona to speak their greeting NOW. Without
    // this, Gemini Live waits silently for user audio after a reconnect —
    // even with a FORCED FIRST UTTERANCE in the system prompt — because
    // it doesn't treat reconnected sessions as "session start". The nudge
    // is the same pattern sendGreetingPromptToLiveAPI uses for normal
    // session starts. We send a stage-direction in the user's language
    // telling the model to deliver the forced greeting.
    if (isPersonaSwap) {
      const lang = session.lang || 'en';
      const personaTo = (session as any).activePersona || 'vitana';
      const forced = (session as any).personaForcedFirstMessage as string | undefined;

      // Stage-direction prompts in each language — the model reads these
      // as a "the session just started, speak now" cue. The text after
      // the colon is the literal greeting we want spoken; if a forced
      // first message is set we quote it directly so there's no
      // translation drift.
      const stagePrompts: Record<string, string> = {
        en: forced
          ? `(System: the call has just connected. Speak this opening line verbatim, in a warm voice, then stop and wait for the user.)\n\n"${forced}"`
          : `(System: the call has just connected. Open with a brief warm greeting, then wait for the user.)`,
        de: forced
          ? `(System: das Gespräch wurde gerade verbunden. Sprich diesen Eröffnungssatz wortwörtlich in einer warmen Stimme, dann stoppe und warte auf den Nutzer.)\n\n"${forced}"`
          : `(System: das Gespräch wurde gerade verbunden. Beginne mit einer kurzen, warmen Begrüßung und warte auf den Nutzer.)`,
        fr: forced
          ? `(Système : l'appel vient de se connecter. Prononce cette phrase d'ouverture mot pour mot, d'une voix chaleureuse, puis arrête-toi et attends l'utilisateur.)\n\n"${forced}"`
          : `(Système : l'appel vient de se connecter. Ouvre par une brève salutation chaleureuse et attends l'utilisateur.)`,
        es: forced
          ? `(Sistema: la llamada acaba de conectarse. Pronuncia esta frase de apertura textualmente, con voz cálida, luego detente y espera al usuario.)\n\n"${forced}"`
          : `(Sistema: la llamada acaba de conectarse. Abre con un breve saludo cálido y espera al usuario.)`,
      };
      const greetingNudge = stagePrompts[lang] ?? stagePrompts['en'];

      const greetingMsg = {
        client_content: {
          turns: [{ role: 'user', parts: [{ text: greetingNudge }] }],
          turn_complete: true,
        },
      };
      try {
        newWs.send(JSON.stringify(greetingMsg));
        console.log(`[VTID-02047] Persona-swap greeting nudge sent for ${personaTo} (lang=${lang}, forced=${!!forced})`);
      } catch (sendErr) {
        console.warn(`[VTID-02047] Failed to send persona-swap greeting nudge:`, sendErr);
      }

      (session as any)._personaSwapInFlight = false;
      console.log(`[VTID-02047] Persona swap to ${personaTo} complete`);
    }

    return true;
  } catch (err: any) {
    console.error(`[VTID-STREAM-RECONNECT] Reconnection failed for ${session.sessionId}: ${err.message}`);
    return false;
  }
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

// =============================================================================
// VTID-WATCHDOG: Response watchdog helpers
// =============================================================================

/**
 * Start the response watchdog timer. If the model doesn't produce any output
 * (audio/text) within timeoutMs, fire a `connection_issue` event to the client
 * and force-close the stalled upstream WebSocket to trigger transparent reconnection.
 *
 * VTID-STALL-FIX: Previously the watchdog only sent an informational event and
 * left the upstream WS open. But when Gemini Live API stalls (e.g. after a tool
 * call timeout), it stops processing ALL input — the session is permanently stuck.
 * Now the watchdog terminates the upstream WS with _stallRecoveryPending=true,
 * which the close handler recognizes and triggers transparent reconnection.
 */
function startResponseWatchdog(
  session: GeminiLiveSession,
  timeoutMs: number,
  reason: string,
): void {
  // Clear any existing watchdog first
  clearResponseWatchdog(session);

  // BOOTSTRAP-ORB-RELIABILITY-R4: record which reason armed this watchdog so
  // the sliding-reset logic in the audio-forwarding paths can check it.
  session.responseWatchdogReason = reason;

  session.responseWatchdogTimer = setTimeout(() => {
    if (!session.active) return;

    const lang = session.lang || 'en';
    const message = connectionIssueMessages[lang] || connectionIssueMessages['en'];

    console.warn(`[VTID-WATCHDOG] Response watchdog fired for session ${session.sessionId}: ${reason} (${timeoutMs}ms)`);
    emitDiag(session, 'watchdog_fired', { reason, timeout_ms: timeoutMs });

    // Emit OASIS telemetry (fire-and-forget)
    emitLiveSessionEvent('orb.live.stall_detected', {
      session_id: session.sessionId,
      reason,
      timeout_ms: timeoutMs,
      turn_count: session.turn_count,
      audio_out_chunks: session.audioOutChunks,
      greeting_sent: session.greetingSent || false,
    }, 'error').catch(() => { });

    // VTID-STALL-FIX: Force-close the stalled upstream WS to trigger transparent
    // reconnection via the close handler. The _stallRecoveryPending flag tells the
    // close handler to reconnect instead of sending disconnect events.
    if (session.upstreamWs) {
      console.log(`[VTID-STALL-FIX] Terminating stalled upstream WS for session ${session.sessionId} — will attempt reconnect`);
      (session as any)._stallRecoveryPending = true;
      session.isModelSpeaking = false; // Ungate mic audio for reconnected session
      try { session.upstreamWs.terminate(); } catch (_e) { /* WS already closing */ }
    } else if (!session.connectionIssueEmitted) {
      // No upstream WS — just send connection_issue to client (once).
      // VTID-02637: dedupe so a watchdog firing after an already-emitted close
      // event doesn't produce a second user-visible apology.
      session.connectionIssueEmitted = true;
      const issueEvent = {
        type: 'connection_issue',
        reason,
        message,
        should_close: false,
      };
      if (session.sseResponse) {
        try { session.sseResponse.write(`data: ${JSON.stringify(issueEvent)}\n\n`); } catch (_e) { /* SSE already closed */ }
      }
      if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
        try { session.clientWs.send(JSON.stringify(issueEvent)); } catch (_e) { /* WS already closed */ }
      }
    }
  }, timeoutMs);
}

/**
 * Clear the response watchdog timer. Called ONLY on turn_complete
 * (model finished normally) or session cleanup. Audio/text chunks
 * RESTART the watchdog instead of clearing it, so mid-stream stalls
 * are detected.
 */
function clearResponseWatchdog(session: GeminiLiveSession): void {
  if (session.responseWatchdogTimer) {
    clearTimeout(session.responseWatchdogTimer);
    session.responseWatchdogTimer = undefined;
  }
  // BOOTSTRAP-ORB-RELIABILITY-R4: clear the reason tag in lockstep.
  session.responseWatchdogReason = undefined;
}

/**
 * Send a text prompt to the Live API to trigger the model to speak first.
 * Used for greeting on session start. Tracks greeting state on session to
 * prevent duplicate greetings and filter the prompt from transcription/memory.
 */
function sendGreetingPromptToLiveAPI(ws: WebSocket, session: GeminiLiveSession): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn('[VTID-VOICE-INIT] Cannot send greeting prompt - WebSocket not open');
    return false;
  }

  // Prevent duplicate greeting (client-side requestWelcome + server-side greeting)
  if (session.greetingSent) {
    console.log('[VTID-VOICE-INIT] Greeting already sent for session, skipping');
    return false;
  }

  const lang = session.lang;
  // VTID-NAV-TIMEJOURNEY (warmth fix): The default greeting prompt for
  // AUTHENTICATED sessions must be WARM, POLITE, and KIND — never cold,
  // never curt. The previous iteration fixed "Hello Dragan!" but made
  // Vitana sound rude ("Yes?", "What do you need?"). This rewrite gives
  // Gemini a menu of warm example phrasings and explicitly tells it not
  // to sound clipped. Each language is independently written so nothing
  // depends on Gemini translating cold English cues into warmer German.
  // VTID-01927/VTID-01929: Default greeting prompts. The system instruction
  // contains the OPENING SHAPE MATRIX with the proactive opener candidate when
  // available — Gemini should use THAT instead of these generic phrasings.
  // These remain only as the legacy fallback for sessions with no awareness.
  // "What can I do for you?" removed — it's on the FORBIDDEN OPENINGS list now.
  const greetingPrompts: Record<string, string> = {
    'en': 'Open with ONE single short phrase. NEVER use two-part sentences with dashes. Do NOT say "Hello", "Hi", or the user\'s name. Do NOT introduce yourself. If your system instruction\'s OPENING SHAPE MATRIX provides a Proactive Opener Candidate, USE IT. Otherwise pick ONE of: "How can I help?" / "What\'s on your mind?" / "I am listening." / "What would you like to know?". Vary across sessions.',
    'de': 'Beginne mit EINER einzelnen kurzen Frage. NIEMALS zweiteilige Sätze mit Gedankenstrichen. Sage KEIN "Hallo", kein "Hi" und nicht den Namen des Benutzers. Stelle dich NICHT vor. Wenn die OPENING SHAPE MATRIX in deinem System-Prompt einen Proactive Opener Candidate enthält, NUTZE IHN. Ansonsten wähle EINE: "Womit kann ich helfen?" / "Was möchtest du wissen?" / "Ich höre dir zu." / "Was brauchst du?". Variiere zwischen Sitzungen.',
    'fr': 'Commence par UNE seule courte phrase. JAMAIS de phrases en deux parties avec des tirets. Ne dis PAS "Bonjour" ni le prénom. Ne te présente PAS. Choisis UNE : "En quoi puis-je aider ?" / "Que puis-je faire pour vous ?" / "Je vous écoute." / "Qu\'aimeriez-vous savoir ?". Varie entre les sessions.',
    'es': 'Comienza con UNA sola frase corta. NUNCA frases de dos partes con guiones. NO digas "Hola" ni el nombre del usuario. NO te presentes. Elige UNA: "¿En qué puedo ayudar?" / "¿Qué necesitas?" / "Te escucho." / "¿Qué te gustaría saber?". Varía entre sesiones.',
    'ar': 'ابدأ بعبارة واحدة قصيرة. لا تستخدم جملاً من جزأين. لا تقل "مرحبا" أو اسم المستخدم. لا تقدم نفسك. اختر واحدة: "كيف يمكنني المساعدة؟" / "ماذا تود أن تعرف؟" / "أنا أستمع." / "ماذا يمكنني أن أفعل لك؟"',
    'zh': '用一个简短的短语开场。不要使用两部分的句子。不要说"你好"或用户名字。不要自我介绍。选一个："有什么我可以帮忙的？" / "你想知道什么？" / "我在听。" / "我能为你做什么？"',
    'ru': 'Начни с ОДНОЙ короткой фразы. НИКОГДА не используй двухчастные предложения с тире. НЕ говори "Здравствуйте" или имя пользователя. НЕ представляйся. Выбери одну: "Чем могу помочь?" / "Что вас интересует?" / "Я слушаю." / "Что я могу для вас сделать?"',
    'sr': 'Почни са ЈЕДНОМ кратком фразом. НИКАД не користи дводелне реченице са цртама. НЕ говори "Здраво" или име корисника. НЕ представљај се. Изабери једну: "Како могу да помогнем?" / "Шта те занима?" / "Слушам те." / "Шта могу да урадим за тебе?"',
  };

  let prompt = greetingPrompts[lang] || greetingPrompts['en'];

  // VTID-ANON-GREETING: For anonymous sessions (landing page), the system instruction
  // contains the full introductory speech. Send a prompt that triggers it
  // instead of the short greeting that contradicts it.
  if (session.isAnonymous && !((session as any)._reconnectCount > 0)) {
    const anonPrompts: Record<string, string> = {
      'en': 'Please deliver the complete introductory speech as described in your instructions.',
      'de': 'Bitte halte die vollständige Begrüßungsrede wie in deinen Anweisungen beschrieben.',
      'fr': "Veuillez prononcer le discours d'introduction complet tel que décrit dans vos instructions.",
      'es': 'Por favor, pronuncia el discurso introductorio completo tal como se describe en tus instrucciones.',
      'ar': 'يرجى إلقاء خطاب التعريف الكامل كما هو موضح في تعليماتك.',
      'zh': '请按照您的指示发表完整的介绍性演讲。',
      'ru': 'Пожалуйста, произнесите полную вступительную речь, как описано в ваших инструкциях.',
      'sr': 'Молимо вас, одржите комплетан уводни говор како је описано у вашим упутствима.',
    };
    prompt = anonPrompts[lang] || anonPrompts['en'];
  }

  // VTID-NAV-TIMEJOURNEY: Build a time-and-journey aware greeting prompt.
  // The prompt now (a) references the bucket the system instruction already
  // knows about, (b) explicitly forbids "Hello <name>!" when the user was
  // just here, and (c) mentions the current screen so the model can ground
  // the greeting in the user's actual journey instead of restarting.
  if (!session.isAnonymous) {
    const temporal = describeTimeSince(session.lastSessionInfo);
    const currentScreen = describeRoute(session.current_route || null, lang);
    const screenHint = currentScreen
      ? ` The user is currently on the "${currentScreen.title}" screen.`
      : '';

    // Map 'night' to 'evening' for greetings ("Good night" is a farewell)
    const tod = session.clientContext?.timeOfDay === 'night' ? 'evening' : (session.clientContext?.timeOfDay || 'day');

    // VTID-WATCHDOG: If the previous session failed (no audio delivered) and
    // the user comes back within 10 minutes, acknowledge it explicitly.
    // VTID-GREETING-VARIETY: For short-gap buckets (reconnect, recent,
    // same_day) inject a freshly-shuffled menu of openers IN THE USER'S
    // LANGUAGE. Without this, Gemini consistently picks the first English
    // example and literal-translates it, producing the same German line
    // every single reopen ("Was kann ich für dich tun?").
    const shortGapMenu = pickShortGapGreetings(lang, 6);
    const menuList = shortGapMenu.map(p => `"${p}"`).join(', ');

    if (temporal.wasFailure && (temporal.bucket === 'reconnect' || temporal.bucket === 'recent')) {
      prompt = `Say exactly: "Sorry about that. How can I help?" ONE short phrase only. Do NOT say "Hello" or the user's name.${screenHint}`;
    } else {
      switch (temporal.bucket) {
        case 'reconnect':
          prompt = `You were JUST talking to the user ${temporal.timeAgo}. Do NOT greet. Do NOT say "Hello" or the user's name. Open with EXACTLY ONE short phrase, picked from this menu and used VERBATIM (these are already in the user's language): ${menuList}. Pick a different one than last time. NEVER use two-part sentences.${screenHint}`;
          break;
        case 'recent':
          prompt = `You were just talking to the user ${temporal.timeAgo}. Do NOT use a formal greeting. Do NOT say the user's name. Open with EXACTLY ONE short phrase, picked from this menu and used VERBATIM (already in the user's language): ${menuList}. Vary across sessions. NEVER use two-part sentences.${screenHint}`;
          break;
        case 'same_day':
          prompt = `The user was here ${temporal.timeAgo}. Do NOT say the user's name. Open with EXACTLY ONE short phrase, picked from this menu and used VERBATIM (already in the user's language): ${menuList}. Vary across sessions. NEVER use two-part sentences.${screenHint}`;
          break;
        // VTID-01927/VTID-01929: For new-day buckets, defer to the OPENING
        // SHAPE MATRIX in the system instruction (which has the tenure-aware
        // proactive opener candidate). Removed literal "What can I do for you?"
        // — it's on the FORBIDDEN OPENINGS list when an opener candidate exists.
        case 'today':
          prompt = `The user was here ${temporal.timeAgo} — this is a NEW-DAY greeting. Open with "Good ${tod}, [Name]." using the user's name from your memory context. Then follow per the OPENING SHAPE MATRIX in your system instruction (use the Proactive Opener Candidate if one is provided). Max TWO short sentences if no candidate; longer if the matrix says so.${screenHint}`;
          break;
        case 'yesterday':
          prompt = `The user was last here yesterday — this is a NEW-DAY greeting. Open with "Good ${tod}, [Name]." using the user's name from your memory context. Then follow per the OPENING SHAPE MATRIX in your system instruction (use the Proactive Opener Candidate if one is provided).${screenHint}`;
          break;
        case 'week':
          prompt = `The user was last here ${temporal.timeAgo} — this is a NEW-DAY greeting. Open with "Good ${tod}, [Name]." using the user's name from your memory context. Then follow per the OPENING SHAPE MATRIX in your system instruction (use the Proactive Opener Candidate if one is provided — for early-tenure users a 2-3 day absence warrants warmth like "glad you came back").${screenHint}`;
          break;
        case 'long':
          prompt = `The user hasn't been here in ${temporal.timeAgo} — this is a NEW-DAY greeting. Use the OPENING SHAPE MATRIX in your system instruction. For motivation_signal=cooling (8-14 days) or absent (>14 days), explicitly acknowledge the absence — e.g. "Hi {Name}, it's been ${temporal.timeAgo} since we last talked. Welcome back." Pause for the user to respond before any productivity nudge.${screenHint}`;
          break;
        case 'first':
        default:
          // VTID-01927: When system instruction shows tenure.stage='day0', use
          // the FULL INTRODUCTION shape (5-8 sentences). Otherwise treat as
          // returning user with unknown recency.
          prompt = `Open per the OPENING SHAPE MATRIX in your system instruction. If tenure.stage='day0' (genuinely new user), deliver the FULL INTRODUCTION (mission, capabilities, agency offer). Otherwise treat as a returning user: "Good ${tod}, [Name]." + the Proactive Opener Candidate from your system instruction.${screenHint}`;
          break;
      }
    }
  }

  const message = {
    client_content: {
      turns: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      turn_complete: true
    }
  };

  ws.send(JSON.stringify(message));

  // Mark greeting as sent and record turn index for filtering
  session.greetingSent = true;
  session.greetingTurnIndex = session.turn_count;
  console.log(`[VTID-VOICE-INIT] Greeting prompt sent for lang=${lang}, turnIndex=${session.turn_count}`);
  emitDiag(session, 'greeting_sent', { lang, prompt_len: message.client_content?.turns?.[0]?.parts?.[0]?.text?.length || 0 });

  // VTID-WATCHDOG: Start watchdog — if greeting response doesn't arrive, notify user
  startResponseWatchdog(session, GREETING_RESPONSE_TIMEOUT_MS, 'greeting_timeout');

  return true;
}

/**
 * VTID-02020: Contextual recovery prompt for reconnects.
 *
 * After a network disconnect, the orb-widget client tears down the dead SSE
 * and creates a fresh /live/session/start that includes the last 20 transcript
 * turns + a "reconnect_stage" hint describing what the user was doing when
 * the connection dropped (idle / listening_user_speaking / thinking / speaking).
 *
 * Instead of the standard greeting (which is jarring — sounds like a second
 * voice introducing itself), this prompt asks Gemini to acknowledge the
 * disconnect and take the appropriate action based on the stage:
 *   - "thinking"                  → "Sorry, we got disconnected. You asked
 *                                    about [topic]. Here's the answer: …"
 *   - "listening_user_speaking"   → "Sorry, we got interrupted. Could you
 *                                    please repeat what you were saying?"
 *   - "speaking"                  → "Sorry, we got disconnected while I was
 *                                    answering. Let me continue: …"
 *   - "idle" (or unknown)         → "I'm back. What would you like to talk
 *                                    about?"
 *
 * Gemini's response is the SINGLE voice the user hears post-reconnect —
 * no client-side MP3 plays. The transcript history is already injected into
 * the system instruction (see buildLiveSystemInstruction's transcriptTurns
 * arg), so Gemini has full context.
 */
function sendReconnectRecoveryPromptToLiveAPI(ws: WebSocket, session: GeminiLiveSession): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn('[VTID-02020] Cannot send recovery prompt — WebSocket not open');
    return false;
  }
  if (session.greetingSent) {
    console.log('[VTID-02020] Recovery prompt already sent, skipping');
    return false;
  }

  const lang = session.lang;
  const stage = ((session as any).reconnectStage as string) || 'idle';
  const reconnectCount = ((session as any)._reconnectCount || 0);

  // VTID-02715 — neutral disconnect copy.
  //  - Words "internet" / "network" never appear: the user's Wi-Fi is fine,
  //    the drop is on the upstream WS side and we don't shift blame.
  //  - `listening_user_speaking` no longer asks the user to repeat their
  //    last 10 seconds — the partial utterance IS in the conversation
  //    history that's injected into the system instruction; Gemini
  //    paraphrases it back ("You were saying X — go on") instead of
  //    forcing a replay. The structural rule below tells Gemini to fall
  //    back to a neutral resume if the partial really is empty.
  const intros: Record<string, Record<string, string>> = {
    en: {
      thinking: "Sorry, we lost the connection for a moment. You were asking about <PARAPHRASE THE USER'S LAST TURN IN 3-6 WORDS>. Here's the answer:",
      listening_user_speaking: "Sorry, we lost the connection mid-sentence. You were saying <PARAPHRASE THEIR PARTIAL UTTERANCE IN 3-6 WORDS> — go on, I'm listening.",
      speaking: "Sorry, we lost the connection while I was answering. Let me continue:",
      idle: "I'm back. What would you like to talk about?"
    },
    de: {
      thinking: "Entschuldige, die Verbindung war kurz weg. Du hast nach <PARAPHRASIERE DEN LETZTEN BEITRAG IN 3-6 WORTEN> gefragt. Hier ist die Antwort:",
      listening_user_speaking: "Entschuldige, die Verbindung war kurz weg, während du gesprochen hast. Du warst gerade bei <PARAPHRASIERE DAS UNTERBROCHENE THEMA IN 3-6 WORTEN> — sprich ruhig weiter, ich höre zu.",
      speaking: "Entschuldige, die Verbindung war kurz weg, während ich geantwortet habe. Ich mache weiter:",
      idle: "Ich bin wieder da. Worüber möchtest du sprechen?"
    },
    fr: {
      thinking: "Désolé, la connexion a sauté un instant. Vous me demandiez à propos de <PARAPHRASEZ EN 3-6 MOTS>. Voici la réponse :",
      listening_user_speaking: "Désolé, la connexion a sauté en plein milieu. Vous étiez en train de parler de <PARAPHRASEZ EN 3-6 MOTS> — continuez, je vous écoute.",
      speaking: "Désolé, la connexion a sauté pendant que je répondais. Je continue :",
      idle: "Je suis de retour. De quoi voulez-vous parler ?"
    },
    es: {
      thinking: "Perdón, se cortó la conexión un momento. Estabas preguntando sobre <PARAFRASEA EN 3-6 PALABRAS>. Aquí va la respuesta:",
      listening_user_speaking: "Perdón, se cortó la conexión mientras hablabas. Estabas comentando sobre <PARAFRASEA EN 3-6 PALABRAS> — sigue, te escucho.",
      speaking: "Perdón, se cortó la conexión mientras yo respondía. Continúo:",
      idle: "Estoy de vuelta. ¿De qué quieres hablar?"
    }
  };

  const stageIntros = intros[lang] || intros['en'];
  const introTemplate = stageIntros[stage] || stageIntros['idle'];

  // The full prompt sent as a "user" turn to Gemini. It tells Gemini how to
  // open AND what to do next (answer / wait / continue) based on the stage.
  // VTID-02715: language is "brief connection blip" not "network disconnect"
  // — Gemini was paraphrasing "network" → "internet" to the user, who has
  // perfectly working Wi-Fi. The drop is on the upstream WS / Cloud Run
  // side; we don't blame the user's network.
  const prompt = [
    'You are recovering from a brief connection blip that interrupted a live voice conversation.',
    '',
    'Read the conversation history that has been injected into your system instruction.',
    '',
    `RECONNECT_STAGE = "${stage}" (the user was in this state when the connection dropped).`,
    '',
    'STRUCTURE — speak ONE acknowledgment sentence first, then take the matching follow-up action:',
    `- For stage "thinking": open with "${stageIntros.thinking}" and IMMEDIATELY answer the user's last question using the conversation history. Replace the placeholder with a brief 3-6 word paraphrase of the user's actual last turn topic. Do NOT repeat their words verbatim. Keep the answer focused and concise.`,
    `- For stage "listening_user_speaking": open with "${stageIntros.listening_user_speaking}". CRITICAL: you must paraphrase the user's most recent partial utterance from the conversation history into the placeholder (3-6 words, capturing the topic — e.g. "your sleep last week", "the magnesium reminder", "your trip to Mallorca"). NEVER ask the user to repeat what they said — their words are in the history; use them. If the partial really is empty (no recent user turn at all in history), fall back to: "Sorry, we lost the connection — please go on, I'm listening." Then STOP and wait. Do NOT guess what they were going to ask next.`,
    `- For stage "speaking": say "${stageIntros.speaking}" and then RESUME the assistant's last answer using the conversation history — pick up logically from where you left off. Do not restart the answer from scratch.`,
    `- For stage "idle" or unknown: say "${stageIntros.idle}" and wait.`,
    '',
    'CRITICAL RULES:',
    '- Speak in the user\'s language (it is set in your system instruction).',
    '- Do NOT introduce yourself.',
    '- Do NOT say "Hello", "Hi", or the user\'s name.',
    '- Do NOT use the standard greeting prompt — this is a RECOVERY, not a fresh start.',
    '- Do NOT use the words "internet", "network", "Wi-Fi" or equivalents — say "connection" or "we got cut off". The drop is on our side.',
    '- Use the word "Sorry" / equivalent ONCE, not repeatedly.',
    '- Speak immediately when this prompt arrives.',
    '',
    `Now produce the recovery line for stage "${stage}" and any follow-up action.`
  ].join('\n');

  const message = {
    client_content: {
      turns: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      turn_complete: true
    }
  };

  ws.send(JSON.stringify(message));

  // Reuse greetingSent so future stalls / accidental greeting calls don't double-fire.
  session.greetingSent = true;
  session.greetingTurnIndex = session.turn_count;
  console.log(`[VTID-02020] Recovery prompt sent — lang=${lang}, stage=${stage}, reconnectCount=${reconnectCount}, transcriptTurns=${session.transcriptTurns?.length || 0}`);
  emitDiag(session, 'recovery_prompt_sent', {
    lang,
    stage,
    reconnect_count: reconnectCount,
    transcript_turns: session.transcriptTurns?.length || 0
  });

  // Watchdog so a missing recovery response surfaces as a recoverable diag,
  // matching the greeting path's behavior.
  startResponseWatchdog(session, GREETING_RESPONSE_TIMEOUT_MS, 'recovery_prompt_timeout');

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
async function emitOrbSessionStarted(orbSessionId: string, conversationId: string, userId?: string): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.session.started',
    source: 'command-hub',
    status: 'info',
    message: `ORB voice session started: ${orbSessionId}`,
    ...(userId && { actor_id: userId, surface: 'orb' as const }),
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
  inputText: string,
  userId?: string
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.turn.received',
    source: 'command-hub',
    status: 'info',
    message: `ORB turn received: ${inputText.substring(0, 50)}...`,
    ...(userId && { actor_id: userId, surface: 'orb' as const }),
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      input_length: inputText.length,
      input_preview: inputText.slice(0, 140),
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
  provider: string,
  userId?: string
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.turn.responded',
    source: 'command-hub',
    status: 'success',
    message: `ORB turn responded via ${provider}`,
    ...(userId && { actor_id: userId, surface: 'orb' as const }),
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      reply_length: replyText.length,
      reply_preview: replyText.slice(0, 140),
      provider,
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-0135] Failed to emit orb.turn.responded:', err.message));
}

/**
 * VTID-0135: Emit orb.session.ended event
 */
async function emitOrbSessionEnded(orbSessionId: string, conversationId: string, userId?: string): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.session.ended',
    source: 'command-hub',
    status: 'info',
    message: `ORB voice session ended: ${orbSessionId}`,
    ...(userId && { actor_id: userId, surface: 'orb' as const }),
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-0135] Failed to emit orb.session.ended:', err.message));
}

/**
 * VTID-01933 (Companion Phase F): Persist a short summary of the just-ended
 * ORB session so the brain can weave it into the next session naturally.
 * Best-effort — never blocks session teardown. Called from POST /end-session.
 */
async function recordSessionSummaryFromTranscript(
  transcript: OrbSessionTranscript,
): Promise<void> {
  if (!transcript.user_id) return;
  if (!transcript.turns || transcript.turns.length === 0) return;
  try {
    const { recordSessionSummary } = await import('../services/guide/session-summaries');
    const turns = transcript.turns
      .map((t) => ({
        role: (t.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        text: String(t.text || '').trim(),
      }))
      .filter((t) => t.text.length > 0);
    if (turns.length === 0) return;
    const durationMs = transcript.started_at
      ? Date.now() - new Date(transcript.started_at).getTime()
      : null;
    await recordSessionSummary({
      user_id: transcript.user_id,
      session_id: transcript.orb_session_id,
      channel: 'voice',
      transcript_turns: turns,
      duration_ms: durationMs,
    });
  } catch (err: any) {
    console.warn('[VTID-01933] recordSessionSummary failed:', err?.message);
  }
}

// =============================================================================
// Helpers
// =============================================================================

// VTID-01226: Updated to support dynamic Lovable origin patterns
function validateOrigin(req: Request): boolean {
  const origin = req.get('origin') || req.get('referer') || '';
  if (!origin) return true; // Allow requests without origin (e.g., curl)
  if (ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) return true;
  return ALLOWED_ORIGIN_PATTERNS.some(pattern => pattern.test(origin));
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
  // Cloud Run sets x-forwarded-for with the real client IP.
  // Also check x-real-ip and x-appengine-user-ip as fallbacks.
  const xff = req.get('x-forwarded-for');
  const xri = req.get('x-real-ip');
  const xaui = req.get('x-appengine-user-ip');
  const ip = (xff?.split(',')[0]?.trim()) || xri || xaui || req.ip || 'unknown';
  return ip;
}

// =============================================================================
// VTID-CONTEXT: Client context awareness (IP geo, device, time)
// =============================================================================

// Simple in-memory cache for IP geolocation (avoids hitting external API repeatedly)
const ipGeoCache = new Map<string, { data: any; ts: number }>();
const IP_GEO_CACHE_TTL_MS = 3600_000; // 1 hour

/**
 * Lightweight IP geolocation using ip-api.com (free, no key needed, 45 req/min).
 * Returns city, country, timezone. Cached for 1 hour per IP.
 */
function isPrivateIP(ip: string): boolean {
  return !ip || ip === 'unknown' || ip === '::1' ||
    ip.startsWith('127.') || ip.startsWith('10.') ||
    ip.startsWith('192.168.') || ip.startsWith('172.') ||
    ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
}

async function geolocateIP(ip: string): Promise<{ city?: string; country?: string; timezone?: string }> {
  if (isPrivateIP(ip)) {
    console.log(`[VTID-CONTEXT] Skipping geo lookup for private/local IP: ${ip}`);
    return {};
  }
  const cached = ipGeoCache.get(ip);
  if (cached && Date.now() - cached.ts < IP_GEO_CACHE_TTL_MS) {
    console.log(`[VTID-CONTEXT] IP geo cache hit: ${ip} → ${cached.data.city}, ${cached.data.country}`);
    return cached.data;
  }
  // Try multiple geo providers — Cloud Run may block HTTP (ip-api.com free tier).
  // ipapi.co supports HTTPS for free (1000 req/day, no key).
  const providers = [
    {
      name: 'ipapi.co',
      url: `https://ipapi.co/${ip}/json/`,
      parse: (json: any) => json.error ? null : { city: json.city, country: json.country_name, timezone: json.timezone },
    },
    {
      name: 'ip-api.com',
      url: `http://ip-api.com/json/${ip}?fields=status,message,city,country,timezone`,
      parse: (json: any) => json.status === 'success' ? { city: json.city, country: json.country, timezone: json.timezone } : null,
    },
  ];

  for (const provider of providers) {
    try {
      console.log(`[VTID-CONTEXT] Trying ${provider.name} for IP ${ip}`);
      const resp = await fetch(provider.url, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) {
        console.warn(`[VTID-CONTEXT] ${provider.name} HTTP ${resp.status} for ${ip}`);
        continue;
      }
      const json = await resp.json();
      const data = provider.parse(json);
      if (data) {
        console.log(`[VTID-CONTEXT] ${provider.name} success: ${ip} → ${data.city}, ${data.country}, ${data.timezone}`);
        ipGeoCache.set(ip, { data, ts: Date.now() });
        return data;
      }
      console.warn(`[VTID-CONTEXT] ${provider.name} returned no data for ${ip}: ${JSON.stringify(json).substring(0, 200)}`);
    } catch (err) {
      console.warn(`[VTID-CONTEXT] ${provider.name} failed for ${ip}: ${(err as Error).message}`);
    }
  }
  console.warn(`[VTID-CONTEXT] All geo providers failed for IP ${ip}`);
  return {};
}

/**
 * Parse User-Agent into device/browser/OS.
 */
function parseUserAgent(ua: string | undefined): { device?: string; browser?: string; os?: string; isMobile?: boolean } {
  if (!ua) return {};
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  let device = 'Desktop';
  if (/iPhone/i.test(ua)) device = 'iPhone';
  else if (/iPad/i.test(ua)) device = 'iPad';
  else if (/Android/i.test(ua)) device = isMobile ? 'Android phone' : 'Android tablet';

  let browser = 'Unknown';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome/i.test(ua)) browser = 'Chrome';
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';

  let os = 'Unknown';
  if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return { device, browser, os, isMobile };
}

/**
 * Get time-of-day string and local time for a timezone.
 */
function getLocalTimeContext(timezone?: string): { localTime: string; timeOfDay: string } {
  try {
    const tz = timezone || 'UTC';
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const weekday = parts.find(p => p.type === 'weekday')?.value || '';
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '12');
    const minute = parts.find(p => p.type === 'minute')?.value || '00';

    let timeOfDay = 'day';
    if (hour >= 5 && hour < 12) timeOfDay = 'morning';
    else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
    else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
    else timeOfDay = 'night';

    return {
      localTime: `${weekday} ${timeOfDay}, ${hour}:${minute}`,
      timeOfDay,
    };
  } catch {
    return { localTime: '', timeOfDay: 'day' };
  }
}

/**
 * Build full client context from request.
 */
async function buildClientContext(req: Request): Promise<ClientContext> {
  const ip = getClientIP(req);
  // Log all IP-related headers for debugging Cloud Run IP extraction
  console.log(`[VTID-CONTEXT] IP headers: xff="${req.get('x-forwarded-for') || ''}", xri="${req.get('x-real-ip') || ''}", xaui="${req.get('x-appengine-user-ip') || ''}", req.ip="${req.ip || ''}" → resolved="${ip}"`);
  const ua = req.get('user-agent');
  const referrer = req.get('referer') || req.get('referrer') || undefined;
  const acceptLang = req.get('accept-language')?.split(',')[0]?.trim();

  // Run geo lookup in parallel with UA parsing (geo is async, UA is sync)
  const [geo, uaParsed] = await Promise.all([
    geolocateIP(ip),
    Promise.resolve(parseUserAgent(ua)),
  ]);

  const timeCtx = getLocalTimeContext(geo.timezone);

  return {
    ip,
    city: geo.city,
    country: geo.country,
    timezone: geo.timezone,
    localTime: timeCtx.localTime,
    timeOfDay: timeCtx.timeOfDay,
    device: uaParsed.device,
    browser: uaParsed.browser,
    os: uaParsed.os,
    isMobile: uaParsed.isMobile,
    lang: acceptLang,
    referrer: (() => { try { return referrer ? new URL(referrer).hostname : undefined; } catch { return undefined; } })(),
  };

  console.log(`[VTID-CONTEXT] Built client context: ip=${ip}, city=${geo.city || 'none'}, country=${geo.country || 'none'}, tz=${geo.timezone || 'none'}, time=${timeCtx.localTime || 'none'}, device=${uaParsed.device || 'none'}`);
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
  session: { tenant: string; role: string; route?: string; selectedId?: string; userTimezone?: string },
  identity?: MemoryIdentity | null
): Promise<{ instruction: string; memoryContext: OrbMemoryContext | null; contextBundle?: ContextBundle }> {
  const userTz = session.userTimezone || 'UTC';
  // VTID-01186: Determine effective identity (authenticated or DEV_IDENTITY fallback)
  const effectiveIdentity: MemoryIdentity = identity && identity.user_id && identity.tenant_id
    ? identity
    : { user_id: DEV_IDENTITY.USER_ID, tenant_id: DEV_IDENTITY.TENANT_ID, active_role: DEV_IDENTITY.ACTIVE_ROLE };

  // BOOTSTRAP-HISTORY-AWARE-TIMELINE: Fetch user context profile in parallel with the rest.
  // Flag-gated so we can disable per-tenant without redeploy.
  const profilerEnabled = process.env.PROFILER_IN_ORB_INSTRUCTION !== 'false';
  const userContextSummaryPromise = profilerEnabled && effectiveIdentity.user_id
    ? getUserContextSummary(effectiveIdentity.user_id, { tenantId: effectiveIdentity.tenant_id })
        .then(r => r.summary)
        .catch(err => {
          console.warn('[UserContextProfiler] non-fatal fetch error:', err?.message || err);
          return '';
        })
    : Promise.resolve('');

  // VTID-01225-READ-FIX: Always fetch memory_facts directly via REST API.
  // This bypasses ALL pipeline complexity (Mem0, Context Assembly, Memory Bridge)
  // and guarantees structured facts are ALWAYS available in the system instruction.
  let memoryFactsSection = '';
  let resolvedLanguageDirective = '';
  try {
    const SUPABASE_URL_ENV = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
    if (SUPABASE_URL_ENV && SUPABASE_KEY && effectiveIdentity.user_id && effectiveIdentity.tenant_id) {
      const factsUrl = `${SUPABASE_URL_ENV}/rest/v1/memory_facts?select=fact_key,fact_value,entity&tenant_id=eq.${effectiveIdentity.tenant_id}&user_id=eq.${effectiveIdentity.user_id}&superseded_by=is.null&order=provenance_confidence.desc,extracted_at.desc&limit=50`;
      const factsResp = await fetch(factsUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      });
      if (factsResp.ok) {
        const facts = await factsResp.json() as Array<{ fact_key: string; fact_value: string; entity: string }>;
        if (facts.length > 0) {
          // Extract preferred_language from facts for explicit language directive
          const langFact = facts.find(f => f.fact_key === 'preferred_language');
          if (langFact) {
            resolvedLanguageDirective = `\nLANGUAGE: Respond ONLY in ${langFact.fact_value}. Do NOT mix languages or switch to English unless the user explicitly asks.`;
            console.log(`[LANG-PREF] Resolved language from memory_facts: ${langFact.fact_value}`);
          }
          const factLines = facts.map(f =>
            f.entity === 'disclosed'
              ? `- ${f.fact_key}: ${f.fact_value} (about someone the user knows)`
              : `- ${f.fact_key}: ${f.fact_value}`
          );
          memoryFactsSection = `\n\n## Verified Facts About This User (from memory_facts)\nThese are CONFIRMED facts. Use them when the user asks about themselves:\n${factLines.join('\n')}`;
          console.log(`[VTID-01225-READ-FIX] Injected ${facts.length} memory_facts into system instruction`);
        }
      }
    }
  } catch (factsErr: any) {
    console.warn(`[VTID-01225-READ-FIX] memory_facts direct fetch failed (non-fatal): ${factsErr.message}`);
  }

  // Calendar as 4th pillar of infinite memory — always inject calendar awareness
  let calendarSection = '';
  try {
    if (effectiveIdentity.user_id) {
      const { getUserTodayEvents, getUserUpcomingEvents, getCalendarGaps } = await import('../services/calendar-service');
      const { getJourneyStage } = await import('../services/journey-calendar-mapper');
      const calRole = session.role || 'community';
      const [todayEvents, upcomingEvents, gaps] = await Promise.all([
        getUserTodayEvents(effectiveIdentity.user_id, calRole),
        getUserUpcomingEvents(effectiveIdentity.user_id, calRole, 10),
        getCalendarGaps(effectiveIdentity.user_id, calRole, new Date()),
      ]);

      let calLines = `\n\n## Your Calendar Awareness\nYou have access to this user's calendar. This is part of your core memory. ALWAYS reference this when asked about schedule, calendar, events, or availability.\nAll times below are in the user's local timezone (${userTz}). When speaking to the user, state these times verbatim — do NOT convert to UTC or another timezone.\n`;

      if (todayEvents.length > 0) {
        calLines += `\nToday's schedule (${userTz}):\n`;
        for (const ev of todayEvents) {
          const time = new Date(ev.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
          calLines += `- ${time}: ${ev.title} (${ev.event_type})\n`;
        }
      } else {
        calLines += '\nToday\'s schedule: No events scheduled.\n';
      }

      if (upcomingEvents.length > 0) {
        calLines += `\nUpcoming (next 7 days, ${userTz}):\n`;
        for (const ev of upcomingEvents.slice(0, 5)) {
          const date = new Date(ev.start_time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: userTz });
          const time = new Date(ev.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
          calLines += `- ${date} ${time}: ${ev.title}\n`;
        }
      }

      if (gaps.length > 0) {
        calLines += `\nFree time today (${userTz}):\n`;
        for (const gap of gaps.slice(0, 3)) {
          const start = new Date(gap.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
          const end = new Date(gap.end).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
          calLines += `- ${start}\u2013${end} (${gap.duration_minutes} min free)\n`;
        }
      }

      // Journey stage
      try {
        const journeyStage = getJourneyStage(new Date());
        if (journeyStage) {
          calLines += `\nJourney: Day ${journeyStage.day_number} of ${journeyStage.total_days} \u2014 "${journeyStage.wave_name}"\n`;
        }
      } catch {}

      calLines += '\nWhen the user asks about their schedule, reference these events. Suggest activities for free time slots. When they ask to ADD or SCHEDULE a new event, use the create_calendar_event tool. When they ask to CHECK their schedule or availability, use the search_calendar tool.';

      calendarSection = calLines;
      console.log(`[Calendar] Injected calendar context: ${todayEvents.length} today, ${upcomingEvents.length} upcoming, ${gaps.length} gaps`);
    }
  } catch (calErr: any) {
    // Calendar unavailable — still inform the LLM it should have calendar awareness
    calendarSection = '\n\n## Your Calendar Awareness\nYou have access to this user\'s calendar but it is temporarily unavailable. If the user asks about their calendar, let them know you\'re having a brief issue loading it and suggest they try again in a moment.';
    console.warn(`[Calendar] Calendar context fetch failed (non-fatal): ${calErr.message}`);
  }

  // Load text_chat personality config
  const textChatConfig = getPersonalityConfigSync('text_chat') as Record<string, any>;

  // Hard contract for tool-bound flows the LLM keeps skipping. Empirically
  // Gemini Live sometimes answers "I can't find that user" without ever
  // calling resolve_recipient — especially when the spoken phrase contains
  // a hint like "I think it's maria6". This block makes the binding
  // explicit at the system-instruction level (tool description alone wasn't
  // enough). Same pattern for navigation.
  const MESSAGING_CONTRACT = `

## MESSAGING & SHARING CONTRACT (NON-NEGOTIABLE)

If the user mentions sending a message, sharing a link, texting, inviting, or telling someone something, you MUST:
1. Call resolve_recipient(spoken_name) BEFORE saying anything about whether the recipient exists. The ONLY way to honestly say "I can't find that user" is to receive an empty candidates array from resolve_recipient. Do not infer absence from your own context — you do not have the user's contact list.
2. If the spoken phrase contains a name AND a Vitana ID hint ("Maria, I think it's maria6"), pass the Vitana ID hint as spoken_name first; if that returns 0 candidates, retry with the name.
3. After resolve_recipient returns, follow the readback contract from the tool description (read back, await explicit confirmation, then send_chat_message).

If the user asks to be shown a screen, list, or detail page, call navigate_to_screen — never claim a page doesn't exist without trying. The frontend handles routing; you handle the call.`;

  // Base instruction WITHOUT memory claims (used when memory is unavailable)
  // VTID-01225-READ-FIX: Always append memory_facts if available
  const baseInstructionNoMemory = `${textChatConfig.base_identity_no_memory || 'You are VITANA ORB, a voice-first multimodal assistant.'}
${resolvedLanguageDirective}
Context:
- tenant: ${session.tenant}
- role: ${session.role}
- route: ${session.route || 'unknown'}
- selectedId: ${session.selectedId || 'none'}

Operating mode:
${textChatConfig.operating_mode || '- Voice conversation is primary.\n- Always listening while ORB overlay is open.\n- Read-only: do not mutate system state.\n- Be concise, contextual, and helpful.'}${memoryFactsSection ? `\n- You have PERSISTENT MEMORY - you remember users across sessions.${memoryFactsSection}` : ''}${calendarSection}${MESSAGING_CONTRACT}`;

  // Base instruction WITH memory claims (used when memory IS available)
  const baseInstructionWithMemory = `${textChatConfig.base_identity_with_memory || 'You are VITANA ORB, a voice-first multimodal assistant with persistent memory.'}
${resolvedLanguageDirective}
Context:
- tenant: ${session.tenant}
- role: ${session.role}
- route: ${session.route || 'unknown'}
- selectedId: ${session.selectedId || 'none'}

Operating mode:
${textChatConfig.operating_mode || '- Voice conversation is primary.\n- Always listening while ORB overlay is open.\n- Read-only: do not mutate system state.\n- Be concise, contextual, and helpful.'}
- You have PERSISTENT MEMORY - you remember users across sessions.
- NEVER claim you cannot remember or that your memory resets.${memoryFactsSection}${calendarSection}${MESSAGING_CONTRACT}`;

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
      const activitySummary = await userContextSummaryPromise;
      if (!memoryContext.ok || memoryContext.items.length === 0) {
        if (activitySummary) {
          return {
            instruction: `${baseInstructionNoMemory}\n\n## USER CONTEXT PROFILE (recent activity & preferences)\n${activitySummary}\n`,
            memoryContext
          };
        }
        return { instruction: baseInstructionNoMemory, memoryContext };
      }
      const enhancedInstruction = buildMemoryEnhancedInstruction(baseInstructionWithMemory, memoryContext, activitySummary);
      return { instruction: enhancedInstruction, memoryContext };
    }

    const bundle = contextResult.bundle;

    if (bundle.top_memories.length === 0 && bundle.long_term_patterns.length === 0) {
      console.log('[VTID-01112] No context items from assembly engine, trying memory_facts fallback');
      // VTID-01225-READ-FIX: Context assembly reads only memory_items.
      // When those are empty, try fetchMemoryContextWithIdentity() which also reads memory_facts.
      const factsMemoryContext = await fetchMemoryContextWithIdentity(effectiveIdentity);
      const activitySummary = await userContextSummaryPromise;
      if (factsMemoryContext.ok && factsMemoryContext.items.length > 0) {
        console.log(`[VTID-01225-READ-FIX] memory_facts fallback found ${factsMemoryContext.items.length} items`);
        const enhancedInstruction = buildMemoryEnhancedInstruction(baseInstructionWithMemory, factsMemoryContext, activitySummary);
        return { instruction: enhancedInstruction, memoryContext: factsMemoryContext, contextBundle: bundle };
      }
      console.log('[VTID-01112] No context items found for user (including memory_facts)');
      if (activitySummary) {
        return {
          instruction: `${baseInstructionNoMemory}\n\n## USER CONTEXT PROFILE (recent activity & preferences)\n${activitySummary}\n`,
          memoryContext: null,
          contextBundle: bundle
        };
      }
      return { instruction: baseInstructionNoMemory, memoryContext: null, contextBundle: bundle };
    }

    // Format context bundle for prompt injection
    const contextForPrompt = formatContextForPrompt(bundle);
    const activitySummary = await userContextSummaryPromise;
    const activityBlock = activitySummary
      ? `\n\n## USER CONTEXT PROFILE (recent activity, routines, preferences)\n${activitySummary}\n\n**Weave this naturally** — e.g. "I noticed you logged a diary entry this morning". Never recite the list verbatim.`
      : '';

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
---${activityBlock}

You KNOW this user. You REMEMBER their name, their hometown, their family, and their recent life rhythm. USE the data above to answer questions. For any calculation, USE the run_code tool.`;

    console.log(`[VTID-01112] Context-enhanced instruction generated with ${bundle.traceability.total_items_included} items (bundle=${bundle.bundle_id})`);

    // Return with context bundle for traceability
    return {
      instruction: enhancedInstruction,
      memoryContext: null, // No longer using legacy format
      contextBundle: bundle
    };
  } catch (err: any) {
    console.warn('[VTID-01112] Context assembly error:', err.message);
    // Fallback to legacy memory bridge (identity-scoped)
    try {
      const memoryContext = await fetchMemoryContextWithIdentity(effectiveIdentity);
      const activitySummary = await userContextSummaryPromise;
      if (!memoryContext.ok || memoryContext.items.length === 0) {
        if (activitySummary) {
          return {
            instruction: `${baseInstructionNoMemory}\n\n## USER CONTEXT PROFILE (recent activity & preferences)\n${activitySummary}\n`,
            memoryContext
          };
        }
        return { instruction: baseInstructionNoMemory, memoryContext };
      }
      const enhancedInstruction = buildMemoryEnhancedInstruction(baseInstructionWithMemory, memoryContext, activitySummary);
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

  // VTID-HEARTBEAT-FIX: Send actual data heartbeats (not SSE comments) so client
  // watchdog resets properly. SSE comments don't trigger EventSource.onmessage.
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`);
    } catch (e) {
      clearInterval(heartbeatInterval);
    }
  }, 10000);

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

    // VTID-DEV-ASSIST: Pass user role for tool authorization filtering
    const geminiResponse = await processWithGemini({
      text: body.text,
      threadId,
      systemInstruction,
      userRole: session.role || undefined,
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
  console.log(`[VTID-01186] POST /orb/chat received (user=${identity.user_id ? identity.user_id.substring(0, 8) + '...' : 'none'})`);

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
    await emitOrbSessionStarted(orbSessionId, conversationId, identity.user_id);
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
        console.log(`[VTID-01186] User message written to memory: ${result.id} (user=${identity.user_id.substring(0, 8)}...)`);
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

    // VTID-01270A: Set thread identity for community/events tools in text chat path
    // VTID-01967: include vitana_id (resolved by optionalAuth → resolveVitanaId)
    // so downstream tools and any prompt that reads the thread identity can
    // surface the @handle without re-querying.
    if (identity.tenant_id && identity.user_id) {
      // VTID-02019: forward user_timezone so recall_conversation_at_time resolves
      // time hints in the caller's local tz. Live ORB session has clientContext
      // with tz from IP geolocation; this /chat route falls back to whatever the
      // body supplies. Either way, undefined → Europe/Berlin downstream.
      const liveSession = sessions.get(orbSessionId) as any;
      const orbUserTz =
        liveSession?.clientContext?.timezone ||
        (body as any)?.timezone ||
        (body as any)?.user_timezone ||
        undefined;
      setThreadIdentity(threadId, {
        tenant_id: identity.tenant_id,
        user_id: identity.user_id,
        role: identity.active_role || undefined,
        vitana_id: req.identity?.vitana_id ?? null,
        user_timezone: orbUserTz,
      });
    }

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

    // VTID-01975: Intent Engine proactive signal — fires alongside the
    // task-creation check. Emits OASIS audit so we can measure how often
    // the broad detector catches buying/selling/partner/activity/social/
    // mutual-aid signals during normal chat. The actual proactive prompt
    // to the user is handled by Gemini (system instructions guide it to
    // call post_intent with confirmed=false on these signals).
    if (process.env.FEATURE_INTENT_ENGINE_A === 'true' && detectIntentSignal(inputText)) {
      try {
        const { emitOasisEvent } = await import('../services/oasis-event-service');
        await emitOasisEvent({
          vtid: 'VTID-01975',
          type: 'voice.message.sent',
          source: 'orb-live-intent-signal',
          status: 'info',
          message: 'intent.proactive_signal.observed',
          payload: {
            session_id: orbSessionId,
            utterance_length: inputText.length,
            in_active_intake: hasActiveIntake(orbSessionId),
          },
          actor_id: identity?.user_id,
          surface: 'orb',
          vitana_id: (identity as any)?.vitana_id ?? undefined,
        });
      } catch (err: any) {
        console.warn(`[VTID-01975] intent signal audit failed: ${err.message}`);
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
      // VTID-DEV-ASSIST: Pass user role for tool authorization filtering
      const geminiResponse = await processWithGemini({
        text: inputText,
        threadId,
        conversationHistory: conversation.history,
        conversationId,
        systemInstruction,
        userRole: identity.active_role || undefined,
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

    // VTID-01225-CLEANUP: Do NOT write assistant responses to memory_items.
    // Assistant output is derivative and pollutes memory with generic responses.
    // User facts are extracted to memory_facts via inline-fact-extractor instead.
    console.log(`[VTID-01225-CLEANUP] Skipping assistant chat reply write to memory_items (pollution prevention)`);

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

    // VTID-01933 (Companion Phase F): persist summary for the brain to read
    // on the user's next session. Fire-and-forget; never blocks teardown.
    recordSessionSummaryFromTranscript(transcript).catch(() => {});

    // Send follow-up reminder notification if conversation had substance
    if (transcript.turns.length >= 4) {
      const tenantId = transcript.tenant_id || process.env.DEV_SANDBOX_TENANT_ID;
      const userId = transcript.user_id || process.env.DEV_SANDBOX_USER_ID;
      if (tenantId && userId) {
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
          notifyUserAsync(userId, tenantId, 'conversation_followup_reminder', {
            title: 'Continue your conversation with ORB',
            body: summaryContent.title || 'Pick up where you left off.',
            data: { url: '/orb', session_id: orb_session_id },
          }, supa);
        } catch (notifErr: any) {
          console.warn(`[Notifications] conversation_followup_reminder error: ${notifErr.message}`);
        }
      }
    }

    // VTID-01225: Fire-and-forget entity extraction from transcript
    if (transcript.turns.length > 0) {
      const fullTranscript = transcript.turns
        .map(turn => `${turn.role}: ${turn.text}`)
        .join('\n');

      // VTID-01225: Use identity from transcript if available, fall back to env vars
      const tenantId = transcript.tenant_id || process.env.DEV_SANDBOX_TENANT_ID || '00000000-0000-0000-0000-000000000001';
      const userId = transcript.user_id || process.env.DEV_SANDBOX_USER_ID || '00000000-0000-0000-0000-000000000099';
      // VTID-ROLE-CMD-HUB: Look up active_role from session if available
      const endSessionRole = liveSessions.get(orb_session_id)?.active_role || 'community';

      if (cogneeExtractorClient.isEnabled()) {
        cogneeExtractorClient.extractAsync({
          transcript: fullTranscript,
          tenant_id: tenantId,
          user_id: userId,
          session_id: orb_session_id,
          active_role: endSessionRole
        });
        console.log(`[VTID-01225] Cognee extraction queued for session: ${orb_session_id} (tenant=${tenantId.substring(0, 8)}..., user=${userId.substring(0, 8)}...)`);
      }

      // VTID-01230: Deduplicated extraction (force on session end)
      deduplicatedExtract({
        conversationText: fullTranscript,
        tenant_id: tenantId,
        user_id: userId,
        session_id: orb_session_id,
        force: true,
      });
      destroySessionBuffer(orb_session_id);
      clearExtractionState(orb_session_id);
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
 * VTID-01225: Extended to accept tenant_id/user_id for Cognee extraction
 *
 * Request:
 * {
 *   "orb_session_id": "uuid",
 *   "conversation_id": "string|null",
 *   "role": "user|assistant",
 *   "text": "string",
 *   "ts": "iso",
 *   "tenant_id": "uuid (optional)",
 *   "user_id": "uuid (optional)"
 * }
 */
router.post('/session/append', (req: Request, res: Response) => {
  const { orb_session_id, conversation_id, role, text, ts, tenant_id, user_id } = req.body;

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
      finalized: false,
      // VTID-01225: Capture identity for Cognee extraction
      tenant_id: tenant_id || undefined,
      user_id: user_id || undefined
    };
    orbTranscripts.set(orb_session_id, transcript);
    console.log(`[VTID-01039] Transcript created: ${orb_session_id} (tenant=${tenant_id || 'none'}, user=${user_id || 'none'})`);
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

  // VTID-01225: Update identity if provided and not set
  if (tenant_id && !transcript.tenant_id) {
    transcript.tenant_id = tenant_id;
  }
  if (user_id && !transcript.user_id) {
    transcript.user_id = user_id;
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

  // VTID-01225: Fire-and-forget entity extraction from transcript
  if (transcript.turns.length > 0) {
    const fullTranscript = transcript.turns
      .map(turn => `${turn.role}: ${turn.text}`)
      .join('\n');

    const tenantId = transcript.tenant_id || process.env.DEV_SANDBOX_TENANT_ID || '00000000-0000-0000-0000-000000000001';
    const userId = transcript.user_id || process.env.DEV_SANDBOX_USER_ID || '00000000-0000-0000-0000-000000000099';
    // VTID-ROLE-CMD-HUB: Look up active_role from session if available
    const finalizeSessionRole = liveSessions.get(orb_session_id)?.active_role || 'community';

    if (cogneeExtractorClient.isEnabled()) {
      const extractionRequest: CogneeExtractionRequest = {
        transcript: fullTranscript,
        tenant_id: tenantId,
        user_id: userId,
        session_id: orb_session_id,
        active_role: finalizeSessionRole
      };
      cogneeExtractorClient.extractAsync(extractionRequest);
      console.log(`[VTID-01225] Cognee extraction queued for session: ${orb_session_id} (tenant=${tenantId.substring(0, 8)}..., user=${userId.substring(0, 8)}...)`);
    }

    // VTID-01230: Deduplicated extraction (force on session end)
    deduplicatedExtract({
      conversationText: fullTranscript,
      tenant_id: tenantId,
      user_id: userId,
      session_id: orb_session_id,
      force: true,
    });
    destroySessionBuffer(orb_session_id);
    clearExtractionState(orb_session_id);
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
/**
 * BOOTSTRAP-HISTORY-AWARE-TIMELINE: GET /debug/awareness
 *
 * Returns EXACTLY what the voice ORB would know about the authenticated user
 * at session-start time. Use this to diagnose "Vitana doesn't know about my
 * activity" reports.
 *
 * Auth:
 *   - Bearer <user_jwt>  → returns that user's awareness snapshot.
 *   - No auth             → returns diagnostic with identity_ok=false so the
 *                           caller can see the widget is falling into the
 *                           anonymous path (the most common cause).
 *   - Service role + ?user_id=UUID (admin path) → look up any user.
 *
 * Response shape is stable so the Command Hub "Vitana Awareness" test panel
 * can render it.
 */
router.get('/debug/awareness', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  const startedAt = Date.now();
  const checks: Record<string, boolean> = {};
  const warnings: string[] = [];

  try {
    // 1. Resolve effective identity -----------------------------------------
    const authHeader = req.headers.authorization;
    const hasBearer = !!authHeader && authHeader.startsWith('Bearer ');
    const jwtVerified = !!(req.identity && req.identity.user_id);

    const explicitUserId = (req.query.user_id as string | undefined) || undefined;
    const serviceRoleKey = req.get('x-service-role-key');
    const isServiceRoleCaller = !!serviceRoleKey &&
      (serviceRoleKey === process.env.SUPABASE_SERVICE_ROLE ||
       serviceRoleKey === process.env.SUPABASE_SERVICE_ROLE_KEY);

    let identity: SupabaseIdentity | null = null;
    let isAnonymous = true;

    if (hasBearer && !jwtVerified) {
      warnings.push('Bearer token provided but JWT failed verification — voice ORB would 401 this client.');
    }

    if (jwtVerified) {
      identity = {
        user_id: req.identity!.user_id,
        tenant_id: req.identity!.tenant_id,
        email: req.identity!.email ?? null,
        role: req.identity!.role ?? null,
        exafy_admin: req.identity!.exafy_admin ?? false,
        aud: req.identity!.aud ?? null,
        exp: req.identity!.exp ?? null,
        iat: req.identity!.iat ?? null,
      } as SupabaseIdentity;
      isAnonymous = false;
    } else if (explicitUserId && isServiceRoleCaller) {
      // Service-role admin lookup: resolve tenant for the target user.
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
      if (supabaseUrl && supabaseKey) {
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const admin = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } });
          const { data: tenantRow } = await admin
            .from('user_tenants')
            .select('tenant_id')
            .eq('user_id', explicitUserId)
            .limit(1)
            .maybeSingle();
          if (tenantRow?.tenant_id) {
            identity = {
              user_id: explicitUserId,
              tenant_id: tenantRow.tenant_id,
              email: null,
              role: 'authenticated',
              exafy_admin: false,
              aud: 'authenticated',
              exp: null,
              iat: null,
            } as SupabaseIdentity;
            isAnonymous = false;
          } else {
            warnings.push(`No user_tenants row for user_id=${explicitUserId}`);
          }
        } catch (err: any) {
          warnings.push(`Admin lookup failed: ${err.message}`);
        }
      }
    } else if (explicitUserId && !isServiceRoleCaller) {
      warnings.push('user_id query param ignored — service-role key required for admin lookups.');
    }

    checks.identity_ok = !isAnonymous && !!identity;

    if (!checks.identity_ok || !identity) {
      return res.status(200).json({
        ok: true,
        scenario: 'anonymous',
        identity: { user_id: '', tenant_id: '', role: 'anonymous', is_anonymous: true },
        memory: { item_count: 0, preview: [] },
        recent_turns: { count: 0, preview: [] },
        profile: { char_count: 0, summary: '', version: 0, cached: false, sections: [] },
        vitana_index: null,
        context_instruction: { char_count: 0, preview: '', truncated: false },
        checks: {
          identity_ok: false,
          memory_ok: false,
          turns_ok: false,
          profile_ok: false,
          context_injected: false,
          awareness_ok: false,
        },
        warnings: [
          'Anonymous call: the voice ORB would skip all personal context for this session.',
          ...(hasBearer && !jwtVerified ? ['The widget is sending a Bearer token that fails verification — check token freshness.'] : []),
          ...(hasBearer ? [] : ['No Authorization header — if the user is signed in, the widget is not forwarding the Supabase access token.']),
          ...warnings,
        ],
        elapsed_ms: Date.now() - startedAt,
      });
    }

    // 2. Invoke the SAME bootstrap path the voice ORB uses ------------------
    const debugSessionId = `debug-awareness-${Date.now()}`;
    const bootstrapResult = await buildBootstrapContextPack(identity, debugSessionId);

    const contextInstruction = bootstrapResult.contextInstruction || '';
    checks.context_injected = contextInstruction.length > 0;

    // 3. Also fetch profiler separately so the panel can show it distinctly -
    const tenantIdOrUndefined = identity.tenant_id ?? undefined;
    const profileResult = await getUserContextSummary(identity.user_id, { tenantId: tenantIdOrUndefined })
      .catch((err: any) => {
        warnings.push(`Profiler error: ${err?.message || 'unknown'}`);
        return { summary: '', version: 0, cached: false, warnings: [] as string[] };
      });

    if (!identity.tenant_id) {
      warnings.push('Identity has no tenant_id — memory and profile queries may be scoped incorrectly.');
    }

    // 4. Inspect the memory path ------------------------------------------
    const memoryContext = identity.tenant_id
      ? await fetchMemoryContextWithIdentity(
          { user_id: identity.user_id, tenant_id: identity.tenant_id },
          LIVE_CONTEXT_CONFIG.MAX_MEMORY_ITEMS
        ).catch(() => null as any)
      : null;

    const recentTurns = identity.tenant_id
      ? await fetchRecentOrbUserTurns(
          { user_id: identity.user_id, tenant_id: identity.tenant_id },
          3
        ).catch(() => [] as any[])
      : [];

    const memoryItems = memoryContext?.items || [];
    checks.memory_ok = memoryItems.length > 0;
    checks.turns_ok = recentTurns.length > 0;

    const profileSections = (profileResult.summary || '')
      .split(/\n{2,}/)
      .map(s => s.split('\n')[0].trim())
      .filter(s => s.startsWith('['));
    checks.profile_ok = profileResult.summary.length > 0;

    checks.awareness_ok =
      checks.identity_ok && checks.context_injected &&
      (checks.memory_ok || checks.profile_ok || checks.turns_ok);

    return res.status(200).json({
      ok: true,
      scenario: isAnonymous ? 'anonymous' : 'authenticated',
      identity: {
        user_id: identity.user_id,
        tenant_id: identity.tenant_id,
        role: identity.role,
        email: identity.email,
        is_anonymous: false,
      },
      memory: {
        item_count: memoryItems.length,
        preview: memoryItems.slice(0, 5).map((i: any) =>
          (i.content || '').toString().slice(0, 120)
        ),
      },
      recent_turns: {
        count: recentTurns.length,
        preview: recentTurns.slice(0, 3).map((t: any) =>
          (t.text || t.content || '').toString().slice(0, 120)
        ),
      },
      profile: {
        char_count: profileResult.summary.length,
        summary: profileResult.summary,
        version: profileResult.version,
        cached: profileResult.cached,
        sections: profileSections,
      },
      context_instruction: {
        char_count: contextInstruction.length,
        preview: contextInstruction.slice(0, 4000),
        truncated: contextInstruction.length > 4000,
      },
      checks: {
        identity_ok: checks.identity_ok,
        memory_ok: checks.memory_ok,
        turns_ok: checks.turns_ok,
        profile_ok: checks.profile_ok,
        context_injected: checks.context_injected,
        awareness_ok: checks.awareness_ok,
      },
      warnings,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err: any) {
    console.error('[Awareness] debug endpoint error:', err?.message);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'awareness debug failed',
      warnings,
      elapsed_ms: Date.now() - startedAt,
    });
  }
});

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
// VTID-01225: Context Bootstrap Test Endpoint (Voice LAB)
// =============================================================================

/**
 * VTID-01225: GET /debug/context-bootstrap - Test context bootstrap for Voice LAB
 *
 * Tests the exact same code path used by Gemini Live sessions to bootstrap
 * memory context. Useful for verifying memory recall without starting a full
 * ORB session.
 *
 * Query params:
 * - user_id: Optional user ID (defaults to DEV_IDENTITY.USER_ID)
 * - tenant_id: Optional tenant ID (defaults to DEV_IDENTITY.TENANT_ID)
 * - role: Optional role (defaults to DEV_IDENTITY.ACTIVE_ROLE)
 *
 * Response:
 * {
 *   "ok": true/false,
 *   "identity": { user_id, tenant_id, role },
 *   "bootstrap_result": {
 *     "latency_ms": 123,
 *     "memory_hits": 5,
 *     "knowledge_hits": 0,
 *     "context_chars": 1234,
 *     "skipped_reason": null or "error: ..."
 *   },
 *   "context_preview": "first 500 chars of context...",
 *   "memory_items": [ { category, content_preview, relevance } ],
 *   "timestamp": "ISO"
 * }
 */
router.get('/debug/context-bootstrap', async (req: Request, res: Response) => {
  console.log('[VTID-01225] Debug context-bootstrap endpoint accessed');

  // Build identity from query params or use DEV_IDENTITY
  const userId = (req.query.user_id as string) || DEV_IDENTITY.USER_ID;
  const tenantId = (req.query.tenant_id as string) || DEV_IDENTITY.TENANT_ID;
  const role = (req.query.role as string) || DEV_IDENTITY.ACTIVE_ROLE;

  // Create a synthetic SupabaseIdentity (same as in handleWsStartMessage)
  const testIdentity: SupabaseIdentity = {
    user_id: userId,
    tenant_id: tenantId,
    role: role,
    email: 'context-bootstrap-test@vitana.local',
    exafy_admin: false,
    aud: 'authenticated',
    exp: null,
    iat: null
  };

  const testSessionId = `test-bootstrap-${Date.now()}`;

  console.log(`[VTID-01225] Testing context bootstrap for user=${userId.substring(0, 8)}..., tenant=${tenantId.substring(0, 8)}...`);

  try {
    // Call the exact same function used by Live sessions
    const bootstrapResult = await buildBootstrapContextPack(testIdentity, testSessionId);

    // Extract memory items from context pack for detailed response
    const memoryItems = bootstrapResult.contextPack?.memory_hits?.map(hit => ({
      category: hit.category_key,
      content_preview: hit.content.substring(0, 100) + (hit.content.length > 100 ? '...' : ''),
      relevance_score: hit.relevance_score,
      importance: hit.importance,
      occurred_at: hit.occurred_at,
      source: hit.source
    })) || [];

    const response = {
      ok: !bootstrapResult.skippedReason,
      identity: {
        user_id: userId,
        tenant_id: tenantId,
        role: role,
        is_dev_identity: userId === DEV_IDENTITY.USER_ID && tenantId === DEV_IDENTITY.TENANT_ID
      },
      bootstrap_result: {
        latency_ms: bootstrapResult.latencyMs,
        memory_hits: bootstrapResult.contextPack?.memory_hits?.length || 0,
        knowledge_hits: bootstrapResult.contextPack?.knowledge_hits?.length || 0,
        web_hits: bootstrapResult.contextPack?.web_hits?.length || 0,
        context_chars: bootstrapResult.contextInstruction?.length || 0,
        skipped_reason: bootstrapResult.skippedReason || null
      },
      context_preview: bootstrapResult.contextInstruction?.substring(0, 1000) || null,
      memory_items: memoryItems,
      full_context_instruction: bootstrapResult.contextInstruction || null,
      timestamp: new Date().toISOString(),
      test_session_id: testSessionId
    };

    // Log summary
    console.log(`[VTID-01225] Context bootstrap test complete: latency=${bootstrapResult.latencyMs}ms, memory=${response.bootstrap_result.memory_hits}, context_chars=${response.bootstrap_result.context_chars}`);

    return res.status(200).json(response);

  } catch (err: any) {
    console.error('[VTID-01225] Context bootstrap test error:', err.message);
    return res.status(200).json({
      ok: false,
      identity: {
        user_id: userId,
        tenant_id: tenantId,
        role: role
      },
      error: err.message,
      stack: err.stack?.substring(0, 500),
      timestamp: new Date().toISOString(),
      test_session_id: testSessionId
    });
  }
});

// =============================================================================
// VTID-01155: Gemini Live Multimodal Session Endpoints
// =============================================================================

/**
 * VTID-01224-FIX: Fetch the user's last session info from oasis_events.
 *
 * VTID-NAV-TIMEJOURNEY (fix): The original implementation queried
 * `vtid.live.session.stop` events filtered by `metadata->>user_id`, but
 * the three session.stop emitters in this file never included user_id in
 * their payload — so the query always returned zero rows, lastSessionInfo
 * was always null, and Vitana always greeted every session as a first
 * meeting (hence "Hello Dragan!" every single time).
 *
 * This rewrite primarily queries `vtid.live.session.start` events, which
 * DO reliably carry user_id in their payload, and falls back to session.stop
 * if a start event cannot be found. fetchLastSessionInfo is called BEFORE
 * the current session's own start event is emitted, so the newest start
 * event in oasis_events is guaranteed to be the PREVIOUS session — exactly
 * what we want for "time since last visit".
 *
 * wasFailure detection now reads the most recent session.stop event for
 * the same user (independent of start query) and checks turn_count /
 * audio_out_chunks metrics. If no stop event exists, wasFailure is false.
 */
async function fetchLastSessionInfo(userId: string): Promise<{ time: string; wasFailure: boolean } | null> {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.warn('[VTID-01224-FIX] fetchLastSessionInfo: missing SUPABASE env — returning null');
      return null;
    }

    const headers = {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    try {
      // Primary: last session.START event (reliably tagged with user_id).
      // Secondary: last session.STOP event with matching user_id if the start
      // event also has one (used for wasFailure detection). We use
      // Supabase's `or` filter to read actor_id OR metadata->>user_id, so
      // older events and any future actor_id-based emission both match.
      const userFilter = `or=(actor_id.eq.${userId},metadata->>user_id.eq.${userId})`;

      const startUrl = `${SUPABASE_URL}/rest/v1/oasis_events?select=created_at,metadata&topic=eq.vtid.live.session.start&${userFilter}&order=created_at.desc&limit=1`;
      const stopUrl = `${SUPABASE_URL}/rest/v1/oasis_events?select=created_at,metadata&topic=eq.vtid.live.session.stop&${userFilter}&order=created_at.desc&limit=1`;

      const [startResp, stopResp] = await Promise.all([
        fetch(startUrl, { method: 'GET', headers, signal: controller.signal }),
        fetch(stopUrl, { method: 'GET', headers, signal: controller.signal }).catch(() => null),
      ]);

      let time: string | null = null;
      if (startResp.ok) {
        const startData = await startResp.json() as Array<{ created_at: string; metadata: Record<string, unknown> }>;
        if (startData.length > 0) {
          time = startData[0].created_at;
        }
      } else {
        console.warn(`[VTID-01224-FIX] session.start query failed: ${startResp.status}`);
      }

      // Stop-event check is best-effort: used only to detect wasFailure.
      let wasFailure = false;
      if (stopResp && stopResp.ok) {
        const stopData = await stopResp.json() as Array<{ created_at: string; metadata: Record<string, unknown> }>;
        if (stopData.length > 0) {
          const meta = stopData[0].metadata || {};
          const turnCount = Number(meta.turn_count) || 0;
          const audioOut = Number(meta.audio_out_chunks) || 0;
          wasFailure = turnCount === 0 || audioOut === 0;
          // If we only have a stop event (no start event hit), fall back to the stop time.
          if (!time) time = stopData[0].created_at;
        }
      }

      if (!time) {
        console.log(`[VTID-01224-FIX] fetchLastSessionInfo: no prior session found for user=${userId.substring(0, 8)}...`);
        return null;
      }

      console.log(`[VTID-01224-FIX] fetchLastSessionInfo: user=${userId.substring(0, 8)}... last=${time} wasFailure=${wasFailure}`);
      return { time, wasFailure };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (e: any) {
    console.warn(`[VTID-01224-FIX] fetchLastSessionInfo failed (non-fatal): ${e.message}`);
  }
  return null;
}

/**
 * VTID-01155: Helper to emit Live session events to OASIS
 */
async function emitLiveSessionEvent(
  eventType: 'vtid.live.session.start' | 'vtid.live.session.stop' | 'vtid.live.audio.in.chunk' | 'vtid.live.video.in.frame' | 'vtid.live.audio.out.chunk' | 'orb.live.config_missing' | 'orb.live.connection_failed' | 'orb.live.stall_detected' | 'orb.live.diag' | 'orb.live.fallback_used' | 'orb.live.fallback_error' | 'orb.live.tool_loop_guard_activated' | 'orb.live.greeting.delivered',
  payload: Record<string, unknown>,
  status: 'info' | 'warning' | 'error' = 'info'
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: 'VTID-01155',
      type: eventType,
      source: 'gateway',
      status,
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
 * VTID-DIAG: Lightweight pipeline diagnostic — fire-and-forget to OASIS.
 * Captures session state snapshot at critical pipeline points so we can
 * trace exactly where/why sessions stall without Cloud Run log access.
 */
function emitDiag(session: GeminiLiveSession, stage: string, extra?: Record<string, unknown>): void {
  emitLiveSessionEvent('orb.live.diag', {
    session_id: session.sessionId,
    stage,
    ts: Date.now(),
    active: session.active,
    turn_count: session.turn_count,
    audio_in: session.audioInChunks,
    audio_out: session.audioOutChunks,
    is_model_speaking: session.isModelSpeaking,
    greeting_sent: session.greetingSent || false,
    consecutive_model_turns: session.consecutiveModelTurns,
    has_upstream_ws: !!session.upstreamWs,
    upstream_ws_state: session.upstreamWs?.readyState ?? -1,
    has_sse: !!session.sseResponse,
    has_watchdog: !!session.responseWatchdogTimer,
    ...(extra || {}),
  }).catch(() => { });
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
 * Persist user's language preference to memory_facts.
 * Fire-and-forget — does not block session start.
 */
function persistLanguagePreference(
  tenantId: string,
  userId: string,
  lang: string
): void {
  const langNames: Record<string, string> = {
    en: 'English', de: 'German', fr: 'French', es: 'Spanish',
    ar: 'Arabic', zh: 'Chinese', ru: 'Russian', sr: 'Serbian',
  };
  writeFact({
    tenant_id: tenantId,
    user_id: userId,
    fact_key: 'preferred_language',
    fact_value: langNames[lang] || lang,
    entity: 'self',
    fact_value_type: 'text',
    provenance_source: 'system_observed',
    provenance_confidence: 0.95,
  }).then(result => {
    if (result.ok) {
      console.log(`[LANG-PREF] Persisted preferred_language=${lang} for user=${userId.substring(0, 8)}...`);
    }
  }).catch(err => {
    console.warn(`[LANG-PREF] Failed to persist language preference: ${err.message}`);
  });
}

/**
 * Retrieve user's stored language preference from memory_facts.
 * Returns the 2-letter ISO code or null if not found.
 */
async function getStoredLanguagePreference(
  tenantId: string,
  userId: string
): Promise<string | null> {
  try {
    const result = await getCurrentFacts({
      tenant_id: tenantId,
      user_id: userId,
      fact_keys: ['preferred_language'],
    });
    if (result.ok && result.facts.length > 0) {
      const storedLang = result.facts[0].fact_value.toLowerCase();
      // Map full language name back to 2-letter code
      const nameToCode: Record<string, string> = {
        english: 'en', german: 'de', french: 'fr', spanish: 'es',
        arabic: 'ar', chinese: 'zh', russian: 'ru', serbian: 'sr',
      };
      return nameToCode[storedLang] || (SUPPORTED_LIVE_LANGUAGES.includes(storedLang) ? storedLang : null);
    }
  } catch (err: any) {
    console.warn(`[LANG-PREF] Failed to retrieve language preference: ${err.message}`);
  }
  return null;
}

/**
 * VTID-01155: POST /live/session/start - Start Gemini Live API session
 * VTID-01226: Added requireAuthWithTenant middleware for multi-tenant auth
 *
 * Creates a Live API session for real-time audio/video streaming.
 * Gateway maintains upstream WebSocket to Vertex Live API.
 *
 * Request:
 * Headers: Authorization: Bearer <supabase_jwt>
 * {
 *   "lang": "en|de|fr|es|ar|zh|sr|ru",
 *   "voice_style": "friendly, calm, empathetic (optional)",
 *   "response_modalities": ["audio","text"]
 * }
 *
 * Response:
 * { "ok": true, "session_id": "live-xxx" }
 *
 * Errors:
 * - 401 UNAUTHENTICATED: Missing or invalid JWT
 * - 400 TENANT_REQUIRED: No active_tenant_id in JWT app_metadata
 */
router.post('/live/session/start', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  console.log('[VTID-ORBC] POST /orb/live/session/start');

  // Validate origin
  if (!validateOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }

  // VTID-AUTH-BACKEND-REJECT: If a Bearer token was provided but the JWT
  // failed verification, reject with 401 so the client knows to re-auth.
  // optionalAuth silently drops invalid tokens, which is fine for truly
  // anonymous widget requests on public pages (no Authorization header),
  // but lets stale authenticated sessions degrade into anonymous greetings —
  // which is how logged-in users ended up hearing the first-time intro
  // speech after their JWT expired in the background.
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && !req.identity) {
    console.warn('[VTID-AUTH-BACKEND-REJECT] Bearer token provided but JWT failed verification — returning 401');
    return res.status(401).json({
      ok: false,
      error: 'AUTH_TOKEN_INVALID',
      message: 'Session expired or invalid — please re-authenticate',
    });
  }

  const body = req.body as LiveSessionStartRequest;
  const clientRequestedLang = body.lang; // may be undefined if client didn't specify
  console.log(`[LANG-PREF] Client requested lang: '${clientRequestedLang || 'NONE'}' (from POST body.lang)`);
  const voiceStyle = body.voice_style || 'friendly, calm, empathetic';
  const responseModalities = body.response_modalities || ['audio', 'text'];
  const conversationSummary = body.conversation_summary || undefined;
  // VTID-02020: contextual recovery hints sent by the orb-widget on reconnect.
  // Empty / absent on first-time sessions, in which case the standard greeting
  // path runs unchanged. When present, _resumedFromHistory is set on the session
  // object so the /live/stream handler routes to sendReconnectRecoveryPromptToLiveAPI.
  const reconnectTranscriptHistory: Array<{ role: 'user' | 'assistant'; text: string }> =
    Array.isArray(body.transcript_history)
      ? body.transcript_history
          .filter((t: any) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
          .slice(-20)
      : [];
  const reconnectStage: 'idle' | 'listening_user_speaking' | 'thinking' | 'speaking' =
    typeof body.reconnect_stage === 'string'
    && (body.reconnect_stage === 'idle' || body.reconnect_stage === 'listening_user_speaking'
        || body.reconnect_stage === 'thinking' || body.reconnect_stage === 'speaking')
      ? body.reconnect_stage
      : 'idle';
  const incomingConversationId: string | null =
    typeof body.conversation_id === 'string' && body.conversation_id.length > 0
      ? body.conversation_id : null;
  const isReconnectStart = reconnectTranscriptHistory.length > 0 || reconnectStage !== 'idle';
  const resolvedConversationId = incomingConversationId || randomUUID();
  if (isReconnectStart) {
    console.log(`[VTID-02020] Reconnect session start: stage=${reconnectStage}, history=${reconnectTranscriptHistory.length} turns, conversation_id=${resolvedConversationId} (incoming=${!!incomingConversationId})`);
  }

  // Generate session ID
  const sessionId = `live-${randomUUID()}`;

  // VTID-01224: Build bootstrap context pack (memory + knowledge) for system instruction
  // This was missing from the SSE path — only the WebSocket path had it
  let contextInstruction: string | undefined;
  let contextPack: ContextPack | undefined;
  let contextBootstrapLatencyMs: number | undefined;
  let contextBootstrapSkippedReason: string | undefined;

  // VTID-ANON: Anonymous = no verified JWT on the request.
  // req.identity is set by optionalAuth middleware ONLY when a valid JWT is present.
  // DEV_IDENTITY (from resolveOrbIdentity) is NOT a real user — it must NOT be
  // treated as authenticated. Previously DEV_IDENTITY had real user_id/tenant_id
  // which passed the hasRealIdentity check → loaded Jovana's memory for everyone.
  const hasJwtIdentity = !!(req.identity && req.identity.user_id);
  const isAnonymousSession = !hasJwtIdentity;

  // Resolve full identity (JWT verified → real user, or DEV_IDENTITY fallback for API calls)
  const orbIdentity = await resolveOrbIdentity(req);
  // Only use as bootstrapIdentity for memory/context if user has a REAL JWT
  const bootstrapIdentity: SupabaseIdentity | null = hasJwtIdentity ? orbIdentity : null;

  // VTID-CONTEXT: Build client context (IP geo, device, time) — for all sessions
  const clientContext = await buildClientContext(req);
  console.log(`[VTID-ANON] Session ${sessionId}: hasJwtIdentity=${hasJwtIdentity}, isAnonymous=${isAnonymousSession}, req.identity.user_id=${req.identity?.user_id || 'none'}, orbIdentity.user_id=${orbIdentity?.user_id || 'none'}, bootstrapIdentity=${bootstrapIdentity ? bootstrapIdentity.user_id.substring(0, 8) : 'null'}`);
  console.log(`[VTID-CONTEXT] Client context: city=${clientContext.city || 'unknown'}, country=${clientContext.country || 'unknown'}, time=${clientContext.localTime || 'unknown'}, device=${clientContext.device || 'unknown'}, anonymous=${isAnonymousSession}`);

  // Resolve language priority:
  // 1. Client-requested lang (from vitana.lang localStorage = user's LATEST UI selection)
  // 2. Stored preference (from memory_facts = previous session's choice, used as fallback)
  // 3. Accept-Language header (browser default)
  // 4. 'en' (ultimate fallback)
  //
  // BOOTSTRAP-ORB-PHASE1: Previously getStoredLanguagePreference awaited
  // serially here (~100 ms) before the bootstrap Promise.all. Now we kick it
  // off in parallel and await its result alongside bootstrap/role/sessionInfo.
  // The client-request short-circuit (most common case) stays synchronous.
  let lang = normalizeLang(clientRequestedLang || 'en');
  const needsStoredLang = !clientRequestedLang && bootstrapIdentity?.user_id && bootstrapIdentity?.tenant_id;
  const storedLangPromise: Promise<string | null> = needsStoredLang
    ? getStoredLanguagePreference(bootstrapIdentity!.tenant_id!, bootstrapIdentity!.user_id)
    : Promise.resolve(null);
  if (clientRequestedLang) {
    console.log(`[LANG-PREF] Using client-requested language: ${lang} (user's UI selection)`);
  }
  // For anonymous sessions: use Accept-Language header if client didn't specify
  if (isAnonymousSession && !clientRequestedLang && clientContext.lang) {
    const browserLang = normalizeLang(clientContext.lang);
    if (browserLang !== 'en' || !clientRequestedLang) {
      lang = browserLang;
      console.log(`[LANG-PREF] Anonymous session using Accept-Language: ${lang}`);
    }
  }

  // VTID-01225-ROLE: Fetch real application role alongside context bootstrap
  let sseActiveRole: string | null = null;
  // VTID-01224-FIX: Last session info for context-aware greeting
  let lastSessionInfo: { time: string; wasFailure: boolean } | null = null;
  // BOOTSTRAP-ORB-CRITICAL-PATH: Promise resolving once context assembly has
  // populated the session fields below. Attached to the session object and
  // awaited by connectToLiveAPI's ws.on('open') handler, so context build
  // overlaps with Google auth + Gemini WS handshake instead of blocking the
  // /live/session/start response. Undefined for anonymous / no-identity
  // sessions (nothing to build).
  let contextReadyPromise: Promise<void> | undefined;

  if (isAnonymousSession) {
    // VTID-ANON: Anonymous session — skip ALL personal context.
    // No memory, no tools, no lastSessionInfo, no role.
    contextBootstrapSkippedReason = 'anonymous_session';
    console.log(`[VTID-ANON] Anonymous session ${sessionId} — skipping memory, tools, lastSessionInfo. Context: city=${clientContext.city || 'unknown'}`);
  } else if (bootstrapIdentity) {
    const usingDevFallback = bootstrapIdentity.user_id === DEV_IDENTITY.USER_ID;
    console.log(`[VTID-01224] Building bootstrap context for SSE session ${sessionId} user=${bootstrapIdentity.user_id.substring(0, 8)}...${usingDevFallback ? ' (DEV_IDENTITY fallback)' : ''}`);

    // VITANA-BRAIN: If ORB brain flag is enabled, use brain context assembly instead
    const { isVitanaBrainOrbEnabled } = await import('../services/system-controls-service');
    const useOrbBrain = await isVitanaBrainOrbEnabled();
    const contextBuildStart = Date.now();

    // BOOTSTRAP-ORB-CRITICAL-PATH: Kick off bootstrap + role + sessionInfo +
    // stored-language + admin briefing in parallel, WITHOUT awaiting. The
    // resulting promise is stored on the session and awaited by
    // connectToLiveAPI's ws.on('open') handler. Admin briefing is fetched
    // speculatively (only needs tenant_id) and discarded if the resolved role
    // turns out not to be admin-ish.
    const bootstrapWork = Promise.all([
      useOrbBrain
        ? (async () => {
            const brainStart = Date.now();
            try {
              const { buildBrainSystemInstruction } = await import('../services/vitana-brain');
              // VTID-ROLE-CMD-HUB: Infer developer role from Command Hub route
              const bodyRoute = typeof (body as any).current_route === 'string' ? (body as any).current_route : '';
              // BOOTSTRAP-ORB-MOBILE-ROLE: Mobile (Appilix WebView / phone browsers) is community-only.
              // Even if DB role is admin/developer/professional, mobile sessions must greet as community.
              const brainRole = clientContext.isMobile
                ? 'community'
                : bodyRoute.startsWith('/command-hub')
                  ? 'developer'
                  : ((bootstrapIdentity as any).active_role || 'community');
              const { instruction, contextPack: cp } = await buildBrainSystemInstruction({
                user_id: bootstrapIdentity.user_id,
                tenant_id: bootstrapIdentity.tenant_id || 'default',
                role: brainRole,
                channel: 'orb',
                thread_id: sessionId,
                user_timezone: clientContext?.timezone,
              });
              console.log(`[VITANA-BRAIN] ORB context built in ${Date.now() - brainStart}ms (${instruction.length} chars)`);
              return { contextInstruction: instruction, contextPack: cp, latencyMs: Date.now() - brainStart };
            } catch (err: any) {
              console.warn(`[VITANA-BRAIN] ORB brain context failed, falling back to legacy: ${err.message}`);
              return buildBootstrapContextPack(bootstrapIdentity, sessionId);
            }
          })()
        : buildBootstrapContextPack(bootstrapIdentity, sessionId),
      usingDevFallback
        ? Promise.resolve(DEV_IDENTITY.ACTIVE_ROLE)
        : resolveEffectiveRole(bootstrapIdentity.user_id, bootstrapIdentity.tenant_id || ''),
      fetchLastSessionInfo(bootstrapIdentity.user_id),
      storedLangPromise,
      bootstrapIdentity.tenant_id
        ? fetchAdminBriefingBlock(bootstrapIdentity.tenant_id, 3).catch((err) => {
            console.warn(`[BOOTSTRAP-ADMIN-EE] SSE briefing fetch failed: ${err?.message}`);
            return null;
          })
        : Promise.resolve(null),
    ]);

    contextReadyPromise = bootstrapWork
      .then(async ([bootstrapResult, fetchedSseRole, fetchedSessionInfo, storedLangResult, adminBriefing]) => {
        // Resolve effective role (same overrides as before — kept in sync with the Brain path above).
        let resolvedRole = fetchedSseRole;
        const sseRoute = typeof (body as any).current_route === 'string' ? (body as any).current_route : '';
        if (sseRoute.startsWith('/command-hub') && (!resolvedRole || resolvedRole === 'community')) {
          console.log(`[VTID-01225-ROLE] Overriding role to "developer" for Command Hub session (was: ${resolvedRole || 'null'})`);
          resolvedRole = 'developer';
        }
        if (clientContext.isMobile && resolvedRole !== 'community') {
          console.log(`[BOOTSTRAP-ORB-MOBILE-ROLE] Forcing role to "community" for mobile session (was: ${resolvedRole || 'null'})`);
          resolvedRole = 'community';
        }

        // Build final context instruction, optionally prepending the admin briefing.
        let finalContext = bootstrapResult.contextInstruction || '';
        if (isAdminRole(resolvedRole) && adminBriefing) {
          finalContext = finalContext ? `${finalContext}\n\n${adminBriefing}` : adminBriefing;
          emitOasisEvent({
            vtid: 'BOOTSTRAP-ADMIN-EE',
            type: 'admin.briefing.injected',
            source: 'orb-live',
            status: 'info',
            message: `Admin briefing injected into SSE session ${sessionId}`,
            payload: { session_id: sessionId, tenant_id: bootstrapIdentity.tenant_id, role: resolvedRole, chars: adminBriefing.length },
            actor_id: bootstrapIdentity.user_id,
            actor_role: 'admin',
            surface: 'orb',
          }).catch(() => {});
        }

        if (bootstrapResult.skippedReason) {
          console.warn(`[VTID-01224] Context bootstrap skipped for ${sessionId}: ${bootstrapResult.skippedReason}`);
        } else {
          console.log(`[VTID-01224] Context bootstrap complete for ${sessionId}: ${bootstrapResult.latencyMs}ms, chars=${finalContext.length}`);
        }

        // Determine final lang (stored preference wins only if client didn't
        // explicitly request one).
        let finalLang = lang;
        if (storedLangResult && !clientRequestedLang) {
          finalLang = storedLangResult;
          console.log(`[LANG-PREF] No client lang — using stored preference: ${finalLang} for user=${bootstrapIdentity.user_id.substring(0, 8)}...`);
        }

        // Patch the session (it has already been constructed with placeholders
        // below this block). Mutations are safe because no consumer reads
        // these fields before awaiting contextReadyPromise.
        session.active_role = resolvedRole;
        session.lastSessionInfo = fetchedSessionInfo;
        session.contextInstruction = finalContext;
        session.contextPack = bootstrapResult.contextPack;
        session.contextBootstrapLatencyMs = bootstrapResult.latencyMs;
        session.contextBootstrapSkippedReason = bootstrapResult.skippedReason;
        session.contextBootstrapBuiltAt = Date.now();
        // Forwarding v2: cache the onboarding-cohort hint for first-30-day users.
        // Computed once at bootstrap; never changes during a session.
        try {
          (session as any).onboardingCohortBlock = await fetchOnboardingCohortBlock(bootstrapIdentity.user_id);
        } catch { /* non-blocking */ }
        if (finalLang !== session.lang) {
          session.lang = finalLang;
        }

        // Persist language preference (non-blocking, after we know the final lang).
        if (bootstrapIdentity.user_id && bootstrapIdentity.tenant_id) {
          persistLanguagePreference(bootstrapIdentity.tenant_id, bootstrapIdentity.user_id, finalLang);
        }

        console.log(`[BOOTSTRAP-ORB-CRITICAL-PATH] Context ready for ${sessionId} in ${Date.now() - contextBuildStart}ms (role=${resolvedRole}, chars=${finalContext.length})`);
      })
      .catch((err) => {
        console.warn(`[BOOTSTRAP-ORB-CRITICAL-PATH] Context build rejected for ${sessionId}, proceeding with empty context:`, err?.message || err);
      });
  } else {
    contextBootstrapSkippedReason = 'no_identity';
    console.log(`[VTID-01224] Skipping context bootstrap for ${sessionId}: no identity`);
  }

  // Create session object with identity and context attached
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
    // VTID-01224: Context and identity
    turn_count: 0,
    // BOOTSTRAP-ORB-CRITICAL-PATH: context/role/lastSessionInfo are populated
    // asynchronously by contextReadyPromise (kicked off above). For anonymous
    // / no-identity sessions the promise is undefined and these stay
    // undefined, which all downstream consumers already tolerate.
    contextInstruction,
    contextPack,
    contextBootstrapLatencyMs,
    contextBootstrapSkippedReason,
    contextBootstrapBuiltAt: Date.now(),
    contextReadyPromise,
    // VTID-01225: Transcript accumulation for Cognee extraction.
    // VTID-02020: seeded from request body when this is a reconnect, so the
    // post-greeting recovery prompt + the system-instruction history block
    // both have the previous turns immediately available.
    transcriptTurns: reconnectTranscriptHistory.length > 0
      ? reconnectTranscriptHistory.map(t => ({ role: t.role, text: t.text, timestamp: new Date().toISOString() }))
      : [],
    outputTranscriptBuffer: '',
    pendingEventLinks: [],
    // VTID-01225-THROTTLE: Buffer for user input transcription (written once per turn)
    inputTranscriptBuffer: '',
    // VTID-VOICE-INIT: Echo prevention — not speaking at session start
    isModelSpeaking: false,
    // VTID-ECHO-COOLDOWN: No cooldown at session start
    turnCompleteAt: 0,
    // VTID-ORBC: JWT identity for per-user memory; DEV_IDENTITY only as fallback
    // VTID-ANON: Only attach identity if user has a real JWT.
    // DEV_IDENTITY must NOT be attached — it would enable tools/memory for anonymous sessions.
    identity: hasJwtIdentity ? orbIdentity || undefined : undefined,
    // Conversation summary from previous session for greeting context
    conversationSummary,
    // VTID-01225-ROLE: Application-level role (community/admin/developer)
    active_role: sseActiveRole,
    // VTID-STREAM-SILENCE: Track last audio forwarded for idle detection
    lastAudioForwardedTime: Date.now(),
    // Telemetry batching: emit at most once per 10s window
    lastTelemetryEmitTime: 0,
    // VTID-RESPONSE-DELAY: Per-session VAD from client or default
    vadSilenceMs: (body as any).vad_silence_ms && (body as any).vad_silence_ms >= 500 && (body as any).vad_silence_ms <= 3000
      ? (body as any).vad_silence_ms : VAD_SILENCE_DURATION_MS_DEFAULT,
    // VTID-AUDIO-READY: SSE path sends greeting immediately (no handshake)
    greetingDeferred: false,
    // VTID-01224-FIX: Last session info for context-aware greeting
    lastSessionInfo,
    // VTID-LOOPGUARD: Track consecutive model turns for loop prevention
    consecutiveModelTurns: 0,
    // VTID-TOOLGUARD: Track consecutive tool calls for loop prevention
    consecutiveToolCalls: 0,
    // VTID-ANON: Anonymous session flag
    isAnonymous: isAnonymousSession,
    // VTID-CONTEXT: Client environment context
    clientContext,
    // VTID-NAV: Current page + recent navigation history from the host React
    // Router. The widget pushes these via VTOrb.updateContext() and includes
    // them in the session-start payload so the consult service can score
    // catalog matches with the user's actual context.
    current_route: typeof (body as any).current_route === 'string'
      ? (body as any).current_route
      : undefined,
    recent_routes: Array.isArray((body as any).recent_routes)
      ? ((body as any).recent_routes as any[])
          .filter((r): r is string => typeof r === 'string')
          .slice(0, 5)
      : undefined,
    // VTID-02789: Frontend useOrbVoiceWidget reads useIsMobile() and
    // includes is_mobile in the start payload so the Navigator picks
    // mobile_route over route on mobile sessions.
    is_mobile: typeof (body as any).is_mobile === 'boolean'
      ? (body as any).is_mobile
      : undefined,
  };

  // VTID-SESSION-LIMIT: Terminate any existing active sessions for this user.
  // Prevents zombie sessions when user re-opens the ORB without closing the previous one.
  // VTID-SESSION-LIMIT-FIX: Skip for dev-sandbox identity — all anonymous/dev users share
  // the same user_id (DEV_IDENTITY.USER_ID), so enforcing session limit would kill every
  // other anonymous session whenever a new one starts, creating a death spiral of 0-turn sessions.
  let terminatedCount = 0;
  const isDevIdentity = orbIdentity?.user_id === DEV_IDENTITY.USER_ID;
  if (orbIdentity?.user_id && !isDevIdentity) {
    terminatedCount = terminateExistingSessionsForUser(orbIdentity.user_id, sessionId);
    if (terminatedCount > 0) {
      console.log(`[VTID-SESSION-LIMIT] Terminated ${terminatedCount} existing session(s) for user=${orbIdentity.user_id.substring(0, 8)}... before starting ${sessionId}`);
    }
  }

  // VTID-02020: pin the conversation_id (echoed back to the client) and
  // mark this session as resumed-from-history when the client sent context.
  // The /live/stream handler reads `resumedFromHistory` to route to the
  // contextual recovery prompt instead of the standard greeting.
  session.conversation_id = resolvedConversationId;
  if (isReconnectStart) {
    (session as any).resumedFromHistory = true;
    (session as any).reconnectStage = reconnectStage;
  }

  // Store session
  liveSessions.set(sessionId, session);

  // Emit OASIS event with identity context
  await emitLiveSessionEvent('vtid.live.session.start', {
    session_id: sessionId,
    user_id: orbIdentity?.user_id || 'anonymous',
    tenant_id: orbIdentity?.tenant_id || null,
    email: orbIdentity?.email || null,
    active_role: sseActiveRole || null,
    user_agent: req.headers['user-agent'] || null,
    origin: req.headers['origin'] || req.headers['referer'] || null,
    transport: 'sse',
    lang,
    modalities: responseModalities,
    voice: getVoiceForLang(lang)
  });

  console.log(`[VTID-ORBC] Live session created: ${sessionId} (user=${orbIdentity?.user_id || 'anonymous'}, tenant=${orbIdentity?.tenant_id || 'none'}, lang=${lang}, contextDeferred=${!!contextReadyPromise})`);

  // BOOTSTRAP-VOICE-DEMO: emit a real heartbeat so the agents dashboard
  // shows orb-live as healthy whenever a voice session is established.
  // Fire-and-forget: registry write must never block the SSE response.
  recordAgentHeartbeat('orb-live').catch(() => {});

  return res.status(200).json({
    ok: true,
    session_id: sessionId,
    // VTID-02020: echo the pinned conversation_id so the client can persist it
    // and re-send on the next reconnect to keep the same conversation thread.
    conversation_id: resolvedConversationId,
    meta: {
      lang,
      voice: getVoiceForLang(lang),
      modalities: responseModalities,
      model: VERTEX_LIVE_MODEL,
      context_bootstrap: {
        // BOOTSTRAP-ORB-CRITICAL-PATH: latency / char count are now known only
        // after contextReadyPromise resolves (which happens during the Gemini
        // WS handshake). Returning placeholders is intentional — clients use
        // these for diagnostics only.
        latency_ms: contextBootstrapLatencyMs ?? null,
        context_chars: null,
        skipped_reason: contextBootstrapSkippedReason || null,
        deferred: !!contextReadyPromise,
      }
    }
  });
});

/**
 * VTID-01155: POST /live/session/stop - Stop Gemini Live session
 * VTID-01226: Added requireAuthWithTenant middleware for multi-tenant auth
 *
 * Stops upstream session and cleans resources.
 *
 * Request:
 * Headers: Authorization: Bearer <supabase_jwt>
 * { "session_id": "live-xxx" }
 *
 * Errors:
 * - 401 UNAUTHENTICATED: Missing or invalid JWT
 * - 400 TENANT_REQUIRED: No active_tenant_id in JWT app_metadata
 * - 403 FORBIDDEN: User doesn't own this session
 */
router.post('/live/session/stop', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  console.log('[VTID-ORBC] POST /orb/live/session/stop');

  const { session_id } = req.body;
  const orbIdentity = await resolveOrbIdentity(req);

  if (!session_id) {
    return res.status(400).json({ ok: false, error: 'session_id required' });
  }

  const session = liveSessions.get(session_id);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  // VTID-ORBC: Log ownership mismatch but allow through — session IDs are UUIDs (unguessable).
  if (session.identity && orbIdentity && orbIdentity.user_id !== DEV_IDENTITY.USER_ID && session.identity.user_id !== orbIdentity.user_id) {
    console.warn(`[VTID-ORBC] /session/stop ownership mismatch (allowed): session_user=${session.identity.user_id}, request_user=${orbIdentity.user_id}, sessionId=${session_id}`);
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

  // VTID-STREAM-KEEPALIVE: Clear upstream ping interval on session stop
  if (session.upstreamPingInterval) {
    clearInterval(session.upstreamPingInterval);
    session.upstreamPingInterval = undefined;
  }
  if (session.silenceKeepaliveInterval) {
    clearInterval(session.silenceKeepaliveInterval);
    session.silenceKeepaliveInterval = undefined;
  }
  // VTID-WATCHDOG: Clear response watchdog on session stop
  clearResponseWatchdog(session);

  // Emit OASIS event
  // VTID-NAV-TIMEJOURNEY: include user_id so fetchLastSessionInfo can find
  // this event when the user next opens the ORB.
  await emitLiveSessionEvent('vtid.live.session.stop', {
    session_id,
    user_id: session.identity?.user_id || null,
    tenant_id: session.identity?.tenant_id || null,
    audio_in_chunks: session.audioInChunks,
    video_in_frames: session.videoInFrames,
    audio_out_chunks: session.audioOutChunks,
    duration_ms: Date.now() - session.createdAt.getTime(),
    turn_count: session.turn_count,
    user_turns: session.transcriptTurns.filter(t => t.role === 'user').length,
    model_turns: session.transcriptTurns.filter(t => t.role === 'assistant').length,
  });
  // VTID-01959: voice self-healing dispatch (mode-gated for /report path).
  // VTID-01994: pass session metrics for mode-independent quality classifier.
  dispatchVoiceFailureFireAndForget({
    sessionId: session_id,
    tenantScope: session.identity?.tenant_id || 'global',
    metadata: { synthetic: (session as any).synthetic === true },
    sessionMetrics: {
      audio_in_chunks: session.audioInChunks,
      audio_out_chunks: session.audioOutChunks,
      duration_ms: Date.now() - session.createdAt.getTime(),
      turn_count: session.turn_count,
      user_turns: session.transcriptTurns.filter(t => t.role === 'user').length,
      model_turns: session.transcriptTurns.filter(t => t.role === 'assistant').length,
    },
  });

  // VTID-01225: Fire-and-forget entity extraction from live session
  // Use in-memory transcriptTurns (UNFILTERED full conversation) instead of memory_items
  // Falls back to memory_items query only if transcriptTurns is empty.
  if (session.identity && session.identity.tenant_id) {
    const tenantId = session.identity.tenant_id;
    const userId = session.identity.user_id;

    if (session.transcriptTurns.length > 0) {
      const fullTranscript = session.transcriptTurns
        .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
        .join('\n');

      if (fullTranscript.length > 50) {
        if (cogneeExtractorClient.isEnabled()) {
          cogneeExtractorClient.extractAsync({
            transcript: fullTranscript,
            tenant_id: tenantId,
            user_id: userId,
            session_id: session_id,
            active_role: session.active_role || 'community'
          });
          console.log(`[VTID-01225] Cognee extraction queued from transcriptTurns (${session.transcriptTurns.length} turns): ${session_id}`);
        }

        // VTID-01230: Deduplicated extraction (force on session end)
        deduplicatedExtract({
          conversationText: fullTranscript,
          tenant_id: tenantId,
          user_id: userId,
          session_id: session_id,
          force: true,
        });
      }
    } else {
      // Fallback: query memory_items if no in-memory transcript available
      fetchRecentConversationForCognee(tenantId, userId, session.createdAt, new Date())
        .then(transcript => {
          if (transcript && transcript.length > 50) {
            if (cogneeExtractorClient.isEnabled()) {
              cogneeExtractorClient.extractAsync({
                transcript,
                tenant_id: tenantId,
                user_id: userId,
                session_id: session_id,
                active_role: session.active_role || 'community'
              });
              console.log(`[VTID-01225] Cognee extraction queued from memory_items fallback: ${session_id}`);
            }

            // VTID-01230: Deduplicated extraction from memory_items fallback
            deduplicatedExtract({
              conversationText: transcript,
              tenant_id: tenantId,
              user_id: userId,
              session_id: session_id,
              force: true,
            });
          } else {
            console.log(`[VTID-01225] No meaningful transcript for extraction: ${session_id}`);
          }
        })
        .catch(err => {
          console.error(`[VTID-01225] Failed to fetch conversation for extraction: ${err.message}`);
        });
    }
  }
  // VTID-01226: Removed fallback for unauthenticated sessions - auth is now required

  // VTID-01230: Clean up session buffer and extraction state on session stop
  destroySessionBuffer(session_id);
  clearExtractionState(session_id);

  // Remove from store
  liveSessions.delete(session_id);

  console.log(`[VTID-01155] Live session stopped: ${session_id}`);

  return res.status(200).json({ ok: true });
});

/**
 * VTID-01155: GET /live/stream - SSE endpoint for bidirectional streaming
 * VTID-01226: Added token validation from query param for multi-tenant auth
 *
 * Client connects to this SSE endpoint to receive audio output from the model.
 * Client sends audio/video data via POST /live/stream/send
 *
 * Query params:
 * - session_id: The live session ID
 * - token: Supabase JWT (required for auth - EventSource doesn't support headers)
 *
 * Errors:
 * - 401 UNAUTHENTICATED: Missing or invalid token
 * - 400 TENANT_REQUIRED: No active_tenant_id in JWT app_metadata
 * - 403 FORBIDDEN: User doesn't own this session
 */
router.get('/live/stream', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  console.log('[VTID-ORBC] GET /orb/live/stream');

  const sessionId = req.query.session_id as string;
  const token = req.query.token as string;

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: 'session_id required' });
  }

  // VTID-ORBC: Resolve identity from token OR dev-sandbox fallback
  let identity: SupabaseIdentity | null = null;

  if (token) {
    // Token provided - verify it
    const authResult = await verifyAndExtractIdentity(token);
    if (authResult) {
      // VTID-MEMORY-BRIDGE: If JWT has user_id but no tenant_id, look it up from user_tenants.
      // provision_platform_user() creates user_tenants rows but does NOT set active_tenant_id
      // in JWT app_metadata, so many authenticated users have null tenant_id.
      if (authResult.identity.tenant_id) {
        identity = authResult.identity;
      } else if (authResult.identity.user_id) {
        const resolvedTenant = await lookupPrimaryTenant(authResult.identity.user_id);
        if (resolvedTenant) {
          identity = { ...authResult.identity, tenant_id: resolvedTenant };
        } else {
          identity = authResult.identity; // Still use identity even without tenant
        }
      }
    }
  }

  // If no identity from token, try dev-sandbox fallback
  if (!identity && isDevSandbox()) {
    identity = {
      user_id: DEV_IDENTITY.USER_ID,
      tenant_id: DEV_IDENTITY.TENANT_ID,
      email: null,
      exafy_admin: false,
      role: DEV_IDENTITY.ACTIVE_ROLE,
      aud: null,
      exp: null,
      iat: null,
    };
  }

  // Allow anonymous SSE connections for lovable/external frontends — identity is used
  // for ownership checks but is not required to connect to a live session stream.

  const session = liveSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ ok: false, error: 'Session not active' });
  }

  // VTID-ORBC: Log ownership mismatch but allow through — session IDs are UUIDs (unguessable).
  // Hard 403 blocks caused intermittent failures when Cloud Run routed requests across instances
  // or when JWT token refresh raced with session creation.
  if (identity && session.identity && session.identity.user_id !== DEV_IDENTITY.USER_ID &&
      session.identity.user_id !== identity.user_id) {
    console.warn(`[VTID-ORBC] SSE ownership mismatch (allowed): session_user=${session.identity.user_id}, request_user=${identity.user_id}, session_tenant=${session.identity.tenant_id}, request_tenant=${identity.tenant_id}, sessionId=${sessionId}`);
  }

  console.log(`[VTID-ORBC] SSE stream: user=${identity?.user_id || 'anonymous'}, tenant=${identity?.tenant_id || 'none'}, session=${sessionId}, source=${token ? 'jwt' : identity ? 'dev-sandbox' : 'anonymous'}`);

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

  // VTID-01225: On reconnect, rebuild context pack to include newly extracted facts
  // The incremental extractor persists facts to memory_facts during the session,
  // so a reconnect should pick up the latest facts in the bootstrap context.
  //
  // BOOTSTRAP-ORB-PHASE1: If the previous build is <60 s old, skip the rebuild.
  // Brief EventSource reconnects (network blips, tab-wake, iOS bfcache) arrive
  // within seconds and no new memory facts have been extracted yet, so
  // rebuilding burns 400-1200 ms of Supabase + optional brain work for no
  // user-visible benefit. The 60 s window is well below the Cognee extraction
  // dedup window, so this never starves the model of genuinely new facts.
  const bootstrapAgeMs = session.contextBootstrapBuiltAt
    ? Date.now() - session.contextBootstrapBuiltAt
    : Infinity;
  const BOOTSTRAP_REBUILD_MIN_AGE_MS = 60_000;
  if (session.transcriptTurns.length > 0 && session.identity && session.identity.tenant_id) {
    if (bootstrapAgeMs < BOOTSTRAP_REBUILD_MIN_AGE_MS) {
      console.log(`[BOOTSTRAP-ORB-PHASE1] Reconnect within ${Math.round(bootstrapAgeMs / 1000)}s of session-start for ${sessionId} — reusing cached bootstrap context (saved ~${Math.round((session.contextBootstrapLatencyMs || 800))} ms)`);
    } else {
      console.log(`[VTID-01225] Reconnect detected for ${sessionId} (${session.transcriptTurns.length} turns, bootstrap age ${Math.round(bootstrapAgeMs / 1000)}s). Rebuilding context pack...`);
      try {
        const bootstrapResult = await buildBootstrapContextPack(session.identity, sessionId);
        if (bootstrapResult.contextInstruction) {
          session.contextInstruction = bootstrapResult.contextInstruction;
          session.contextBootstrapBuiltAt = Date.now();
          console.log(`[VTID-01225] Context pack rebuilt on reconnect: ${bootstrapResult.latencyMs}ms, chars=${session.contextInstruction.length}`);
        }
      } catch (err: any) {
        console.warn(`[VTID-01225] Context pack rebuild on reconnect failed: ${err.message}`);
      }
    }
  }

  // VTID-INSTANT-FEEDBACK: Send ready event IMMEDIATELY so client transitions UI
  // and can play the activation chime before Live API connects.
  res.write(`data: ${JSON.stringify({
    type: 'ready',
    session_id: sessionId,
    live_api_connected: false, // Live API connects in parallel
    meta: {
      model: VERTEX_LIVE_MODEL,
      lang: session.lang,
      voice: LIVE_API_VOICES[session.lang] || LIVE_API_VOICES['en'] || getVoiceForLang(session.lang),
      audio_out_rate: 24000,
      audio_in_rate: 16000
    }
  })}\n\n`);

  // VTID-01219: Connect to Vertex AI Live API WebSocket IN PARALLEL (non-blocking).
  // The ready event is already sent so the client gets instant visual + audio feedback
  // (chime) while this connection establishes in the background.
  console.log(`[VTID-ORBC] Live API check: googleAuth=${!!googleAuth}, VERTEX_PROJECT_ID=${VERTEX_PROJECT_ID || 'EMPTY'}, sessionId=${sessionId}`);
  if (googleAuth && VERTEX_PROJECT_ID) {
    const liveApiPromise = connectToLiveAPI(
      session,
      // Audio response handler - forward to client via SSE
      (audioB64: string) => {
        if (session.sseResponse) {
          try {
            session.sseResponse.write(`data: ${JSON.stringify({
              type: 'audio',
              data_b64: audioB64,
              mime: 'audio/pcm;rate=24000',
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

    // Handle Live API connection result asynchronously
    liveApiPromise.then((ws) => {
      session.upstreamWs = ws;
      console.log(`[VTID-01219] Live API WebSocket connected for session ${sessionId}`);

      // Send live_api_ready event so frontend knows full voice conversation is active
      if (session.sseResponse) {
        try {
          session.sseResponse.write(`data: ${JSON.stringify({
            type: 'live_api_ready',
            session_id: sessionId
          })}\n\n`);
        } catch (err) {
          // SSE might be closed
        }
      }

      // VTID-INSTANT-FEEDBACK: Send activation chime via SSE before greeting prompt.
      // Gives instant audio feedback while Gemini generates the real greeting (2-5s).
      if (session.sseResponse) {
        try {
          const chimePcm = generateChimePcm();
          session.sseResponse.write(`data: ${JSON.stringify({
            type: 'audio',
            data_b64: chimePcm,
            mime: 'audio/pcm;rate=24000',
            chunk_number: session.audioOutChunks++,
            source: 'activation_chime'
          })}\n\n`);
          console.log(`[VTID-INSTANT-FEEDBACK] Activation chime sent via SSE for session ${sessionId}`);
        } catch (err) {
          console.warn('[VTID-INSTANT-FEEDBACK] Failed to send chime via SSE:', err);
        }
      }

      // VTID-02020: route greeting vs. contextual recovery prompt.
      // - First-time session (no resumedFromHistory, no _reconnectCount): standard greeting.
      // - Reconnect from client-side session restart (_resumedFromHistory=true): contextual recovery.
      // - Backend transparent reconnect (_reconnectCount>0): also contextual recovery.
      // The recovery prompt is the SINGLE voice the user hears post-reconnect — no
      // client MP3 plays, no generic greeting fires. Gemini speaks the acknowledgment
      // + either answers the in-flight question, asks user to repeat, or resumes mid-answer.
      const isReconnectGreetingSkip = ((session as any).resumedFromHistory === true)
        || (((session as any)._reconnectCount || 0) > 0);
      if (isReconnectGreetingSkip) {
        sendReconnectRecoveryPromptToLiveAPI(ws, session);
      } else {
        sendGreetingPromptToLiveAPI(ws, session);
      }
    }).catch((err: any) => {
      console.error(`[VTID-01219] Failed to connect Live API for session ${sessionId}:`, err.message);
      emitLiveSessionEvent('orb.live.connection_failed', {
        session_id: sessionId,
        error: err.message,
        vertex_project_id: VERTEX_PROJECT_ID || 'EMPTY',
      }, 'error').catch(() => {});
      // VTID-01959: voice self-healing dispatch (mode-gated; off by default).
      // Hooked here for the fast-fail path that may abort before session.stop.
      dispatchVoiceFailureFireAndForget({
        sessionId,
        tenantScope: session.identity?.tenant_id || 'global',
        metadata: { synthetic: (session as any).synthetic === true },
      });

      // Notify client of connection failure
      if (session.sseResponse) {
        try {
          session.sseResponse.write(`data: ${JSON.stringify({
            type: 'error',
            message: 'Voice connection failed. Please try again.'
          })}\n\n`);
        } catch { /* ignore */ }
      }
    });
  } else {
    console.warn('[VTID-01219] Live API not available - missing auth or project ID');
    emitLiveSessionEvent('orb.live.config_missing', {
      session_id: sessionId,
      google_auth_ready: !!googleAuth,
      vertex_project_id: VERTEX_PROJECT_ID || 'EMPTY',
    }, 'error').catch(() => {});
    // VTID-01959: voice self-healing dispatch (mode-gated; off by default).
    // Hooked here for the fast-fail path that may abort before session.stop.
    dispatchVoiceFailureFireAndForget({
      sessionId,
      tenantScope: session.identity?.tenant_id || 'global',
      metadata: { synthetic: (session as any).synthetic === true },
    });
  }

  // VTID-HEARTBEAT-FIX: Send actual data heartbeats, not SSE comments.
  // SSE comments (`:heartbeat`) keep the HTTP connection alive but do NOT trigger
  // EventSource.onmessage on the client. The client watchdog only resets on
  // onmessage events, so after the greeting turn_complete, if the user doesn't
  // speak for 12s the watchdog fires → "No response from server" → disconnect.
  // Sending { type: 'heartbeat' } as a data message fixes this.
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`);
    } catch (e) {
      clearInterval(heartbeatInterval);
    }
  }, 10000);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[VTID-01155] Live stream disconnected: ${sessionId}`);
    clearInterval(heartbeatInterval);
    decrementConnection(clientIP);
    if (session.sseResponse === res) {
      session.sseResponse = null;
    }

    // VTID-01230: Deduplicated extraction on SSE disconnect
    if (session.identity && session.identity.tenant_id && session.transcriptTurns.length > 0) {
      const fullTranscript = session.transcriptTurns
        .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
        .join('\n');
      deduplicatedExtract({
        conversationText: fullTranscript,
        tenant_id: session.identity.tenant_id,
        user_id: session.identity.user_id,
        session_id: sessionId,
        force: true,
      });
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

    // VTID-SESSION-LEAK-FIX: Remove session from liveSessions to prevent zombie accumulation.
    // Without this, every SSE disconnect leaves the session in the Map forever,
    // eventually exhausting Vertex AI concurrent session limits.
    session.active = false;
    destroySessionBuffer(sessionId);
    clearExtractionState(sessionId);
    liveSessions.delete(sessionId);
    console.log(`[VTID-SESSION-LEAK-FIX] Cleaned up live session on SSE disconnect: ${sessionId} (remaining: ${liveSessions.size})`);
  });
});

/**
 * VTID-01155: POST /live/stream/send - Send audio/video data to Live session
 * VTID-01226: Added requireAuthWithTenant middleware for multi-tenant auth
 *
 * Client sends audio chunks (PCM 16kHz) or video frames (JPEG) to this endpoint.
 * Gateway forwards to Vertex Live API and relays responses via SSE.
 *
 * Request:
 * Headers: Authorization: Bearer <supabase_jwt>
 * For audio: { "type": "audio", "data_b64": "...", "mime": "audio/pcm;rate=16000" }
 * For video: { "type": "video", "source": "screen|camera", "data_b64": "...", "width": 768, "height": 768 }
 *
 * Errors:
 * - 401 UNAUTHENTICATED: Missing or invalid JWT
 * - 400 TENANT_REQUIRED: No active_tenant_id in JWT app_metadata
 * - 403 FORBIDDEN: User doesn't own this session
 */
router.post('/live/stream/send', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { session_id } = req.query;
  const body = req.body as LiveStreamMessage & { session_id?: string };
  const effectiveSessionId = (session_id as string) || body.session_id;

  // VTID-ORBC: Resolve identity - JWT if present, DEV_IDENTITY in dev-sandbox, or anonymous.
  // Allow anonymous requests for lovable/external frontends.
  const identity = await resolveOrbIdentity(req);

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

  // VTID-ORBC: Log ownership mismatch but allow through — session IDs are UUIDs (unguessable).
  // Hard 403 blocks caused intermittent failures when Cloud Run routed requests across instances
  // or when JWT token refresh raced with session creation.
  if (identity && session.identity && session.identity.user_id !== DEV_IDENTITY.USER_ID &&
      session.identity.user_id !== identity.user_id) {
    console.warn(`[VTID-ORBC] /send ownership mismatch (allowed): session_user=${session.identity.user_id}, request_user=${identity.user_id}, session_tenant=${session.identity.tenant_id}, request_tenant=${identity.tenant_id}, sessionId=${effectiveSessionId}`);
  }

  session.lastActivity = new Date();

  // VTID-ANON-NUDGE: Block all input after turn limit — Vitana's final message (turn 8)
  // has already been delivered. Silently drop audio/text so no partial response starts.
  if (session.isAnonymous && (session.turn_count > 8 || session.signupIntentDetected)) {
    return res.json({ ok: true });
  }

  try {
    if (body.type === 'audio') {
      // VTID-NAV: Once a navigation is queued, drop ALL further mic audio so
      // Gemini cannot start a new turn while the widget is closing. Without
      // this gate the model talks over its own goodbye sentence.
      if (session.navigationDispatched) {
        session.audioInChunks++;
        return res.json({ ok: true, dropped: true, reason: 'navigation_dispatched' });
      }

      // VTID-VOICE-INIT: Echo prevention gate (SSE path) — same as WebSocket path
      if (session.isModelSpeaking) {
        session.audioInChunks++;
        if (session.audioInChunks % 50 === 0) {
          console.log(`[VTID-VOICE-INIT] SSE path: dropping mic audio — model is speaking: session=${effectiveSessionId}`);
        }
        return res.json({ ok: true, dropped: true, reason: 'model_speaking' });
      }

      // VTID-ECHO-COOLDOWN: Post-turn cooldown — gate mic audio for N ms after
      // turn_complete to let client-side audio playback finish draining.
      // Without this, speaker echo gets picked up and causes phantom responses.
      if (session.turnCompleteAt > 0 && (Date.now() - session.turnCompleteAt) < POST_TURN_COOLDOWN_MS) {
        session.audioInChunks++;
        return res.json({ ok: true, dropped: true, reason: 'post_turn_cooldown' });
      }

      // Handle audio chunk
      session.audioInChunks++;

      // Telemetry: emit at most once per 10s window (was per-100-chunks ~1-2s)
      // Each emit is an HTTP call to Supabase — batching reduces I/O pressure
      const now = Date.now();
      if (now - session.lastTelemetryEmitTime >= 10_000) {
        session.lastTelemetryEmitTime = now;
        emitLiveSessionEvent('vtid.live.audio.in.chunk', {
          session_id: effectiveSessionId,
          chunk_number: session.audioInChunks,
          bytes: body.data_b64.length,
          rate: 16000
        }).catch(() => { });
      }

      // VTID-01219: Forward audio to Vertex Live API WebSocket
      if (session.upstreamWs && session.upstreamWs.readyState === WebSocket.OPEN) {
        // Forward audio to Live API for real-time processing
        const sent = sendAudioToLiveAPI(session.upstreamWs, body.data_b64, body.mime || 'audio/pcm;rate=16000');
        if (sent) {
          session.lastAudioForwardedTime = Date.now(); // VTID-STREAM-SILENCE: reset idle timer
          // VTID-FORWARDING-WATCHDOG: catches zombie upstream WS connections
          // where audio goes in but nothing comes back (no input_transcription
          // → no watchdog → stuck forever).
          //
          // BOOTSTRAP-ORB-RELIABILITY-R4: the watchdog now SLIDES — reset on
          // each audio chunk while the model isn't speaking. Means the timer
          // fires only when the user's audio stops AND Vertex stays silent,
          // which is the actual stall condition. Previously the timer armed
          // once and counted down regardless of whether the user was still
          // speaking, interrupting long utterances.
          //
          // Only slide when the current watchdog is this same reason — a
          // model-response watchdog must NOT be reset by user audio or we'd
          // suppress legitimate mid-stream model stalls.
          if (!session.isModelSpeaking) {
            // VTID-01984 (R5): once Vertex has shown life this session, the
            // upstream WS is healthy by definition. A "no ack" window is just
            // Vertex computing — not a stall. Skip arming the watchdog here.
            // Native ws.onclose / ws.onerror still catch real connection failures.
            // Periodically emit a watchdog_skipped diag so we can confirm in
            // production how many sessions this saves.
            if (session.vertexHasShownLife) {
              if (session.audioInChunks % 200 === 0) {
                emitDiag(session, 'watchdog_skipped', { reason: 'vertex_alive' });
              }
            } else {
              const canSlide = !session.responseWatchdogTimer
                || session.responseWatchdogReason === 'forwarding_no_ack';
              if (canSlide) {
                startResponseWatchdog(session, FORWARDING_ACK_TIMEOUT_MS, 'forwarding_no_ack');
              }
            }
          }
          // VTID-DIAG: Periodic audio forward diagnostic (every 100 chunks)
          if (session.audioInChunks % 100 === 0) {
            emitDiag(session, 'audio_forwarding', { chunk: session.audioInChunks });
          }
        } else {
          console.warn(`[VTID-01219] Failed to forward audio chunk: session=${effectiveSessionId}`);
          if (session.audioInChunks % 50 === 0) {
            emitDiag(session, 'audio_forward_failed', { chunk: session.audioInChunks, ws_state: session.upstreamWs?.readyState ?? -1 });
          }
        }
      } else {
        // Fallback: Log when Live API not connected
        if (session.audioInChunks % 50 === 0) {
          console.log(`[VTID-ORBC] Audio NO-LIVE-API: session=${effectiveSessionId}, chunk=${session.audioInChunks}, wsState=${session.upstreamWs?.readyState ?? 'NULL'}, projectId=${VERTEX_PROJECT_ID || 'EMPTY'}, hasAuth=${!!googleAuth}`);
          emitDiag(session, 'audio_no_ws', { chunk: session.audioInChunks });
        }

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

      // Telemetry: reuse the same 10s window as audio
      const vidNow = Date.now();
      if (vidNow - session.lastTelemetryEmitTime >= 10_000) {
        session.lastTelemetryEmitTime = vidNow;
        emitLiveSessionEvent('vtid.live.video.in.frame', {
          session_id: effectiveSessionId,
          source: videoBody.source,
          frame_number: session.videoInFrames,
          bytes: videoBody.data_b64.length,
          fps: 1
        }).catch(() => { });
      }

      console.log(`[VTID-01155] Video frame received: session=${effectiveSessionId}, source=${videoBody.source}, frame=${session.videoInFrames}`);

      // Acknowledge frame receipt via SSE
      if (session.sseResponse) {
        session.sseResponse.write(`data: ${JSON.stringify({
          type: 'video_ack',
          source: videoBody.source,
          frame_number: session.videoInFrames
        })}\n\n`);
      }
    } else if ((body as any).type === 'text' && (body as any).text) {
      // Handle text message - forward to Live API as client_content
      const textContent = (body as any).text as string;

      // VTID-ANON-NUDGE: Block text input after turn limit (SSE text path)
      if (session.isAnonymous && (session.turn_count > 8 || session.signupIntentDetected)) {
        return res.json({ ok: true });
      }

      // If this is a client-side greeting request and server already sent one, skip it
      if (session.greetingSent && textContent.toLowerCase().includes('greet')) {
        console.log(`[VTID-VOICE-INIT] Skipping client greeting request - server greeting already sent`);
        return res.status(200).json({ ok: true, note: 'Server greeting already in progress' });
      }

      if (session.upstreamWs && session.upstreamWs.readyState === WebSocket.OPEN) {
        const textMessage = {
          client_content: {
            turns: [{ role: 'user', parts: [{ text: textContent }] }],
            turn_complete: true
          }
        };
        session.upstreamWs.send(JSON.stringify(textMessage));
        console.log(`[VTID-VOICE-INIT] Text message forwarded to Live API: "${textContent.substring(0, 80)}..."`);
      } else {
        console.warn(`[VTID-VOICE-INIT] Cannot forward text - Live API not connected`);
      }
    } else if ((body as any).type === 'interrupt') {
      // VTID-VOICE-INIT: Client-side VAD detected real user speech during model playback
      if (!session.isModelSpeaking) {
        return res.json({ ok: true, was_speaking: false });
      }

      console.log(`[VTID-VOICE-INIT] SSE path: client interrupt — ungating mic and stopping Gemini: session=${effectiveSessionId}`);

      // Ungate mic audio
      session.isModelSpeaking = false;

      // Tell Gemini to stop generating
      if (session.upstreamWs && session.upstreamWs.readyState === WebSocket.OPEN) {
        sendEndOfTurn(session.upstreamWs);
      }

      // Clear incomplete output transcript
      session.outputTranscriptBuffer = '';

      // Send interrupted event to client via SSE
      if (session.sseResponse) {
        session.sseResponse.write(`data: ${JSON.stringify({ type: 'interrupted' })}\n\n`);
      }

      return res.json({ ok: true, was_speaking: true });
    }

    return res.status(200).json({ ok: true });

  } catch (error: any) {
    console.error(`[VTID-01155] Stream send error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * VTID-01219: POST /live/stream/end-turn - Signal end of user turn
 * VTID-01226: Added requireAuthWithTenant middleware for multi-tenant auth
 *
 * Client calls this when user stops speaking (voice activity detection).
 * Tells Gemini Live API that the user has finished their input.
 *
 * Request:
 * Headers: Authorization: Bearer <supabase_jwt>
 * { "session_id": "live-xxx" }
 *
 * Response:
 * { "ok": true }
 *
 * Errors:
 * - 401 UNAUTHENTICATED: Missing or invalid JWT
 * - 400 TENANT_REQUIRED: No active_tenant_id in JWT app_metadata
 * - 403 FORBIDDEN: User doesn't own this session
 */
router.post('/live/stream/end-turn', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { session_id } = req.query;
  const body = req.body as { session_id?: string };
  const effectiveSessionId = (session_id as string) || body.session_id;

  // VTID-ORBC: Resolve identity - JWT if present, DEV_IDENTITY in dev-sandbox, or anonymous.
  // Allow anonymous requests for lovable/external frontends.
  const identity = await resolveOrbIdentity(req);

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

  // VTID-ORBC: Log ownership mismatch but allow through — session IDs are UUIDs (unguessable).
  if (identity && session.identity && session.identity.user_id !== DEV_IDENTITY.USER_ID &&
      session.identity.user_id !== identity.user_id) {
    console.warn(`[VTID-ORBC] /end-turn ownership mismatch (allowed): session_user=${session.identity.user_id}, request_user=${identity.user_id}, sessionId=${effectiveSessionId}`);
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
router.post('/tts', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
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
 * VTID-FALLBACK: POST /live/chat-tts — Text-mode fallback when Vertex Live API is unavailable.
 *
 * Flow: Client sends text (from Web Speech API STT) → Gemini generates reply → Cloud TTS
 * synthesizes audio → response returned as JSON with text + audio_b64.
 *
 * This provides a degraded but functional voice experience when:
 * - Vertex Live API WebSocket fails to connect
 * - Live API connection is unstable / keeps disconnecting
 * - Project has exhausted Live API quota
 *
 * The client handles STT locally (Web Speech API) and plays the TTS audio.
 */
router.post('/live/chat-tts', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { session_id, text, lang: reqLang, context_turns } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'text is required' });
  }

  const lang = normalizeLang(reqLang || 'en');
  const identity = await resolveOrbIdentity(req);

  console.log(`[VTID-FALLBACK] chat-tts request: lang=${lang}, text_length=${text.length}, user=${identity?.user_id?.substring(0, 8) || 'anon'}`);

  try {
    // 1. Build conversation context from recent turns
    const conversationHistory = (context_turns || []).slice(-10).map((t: any) => ({
      role: t.role === 'user' ? 'user' : 'model',
      parts: [{ text: t.text }]
    }));

    // 2. Build system instruction
    let systemInstruction = `You are Vitana, a friendly and empathetic AI assistant. Respond conversationally in ${lang === 'de' ? 'German' : lang === 'es' ? 'Spanish' : lang === 'fr' ? 'French' : 'English'}. Keep responses concise (2-3 sentences) as they will be spoken aloud.`;

    // Add memory context if available
    if (identity?.user_id && identity?.tenant_id) {
      try {
        const memoryCtx = isMemoryBridgeEnabled()
          ? await fetchMemoryContextWithIdentity(identity as MemoryIdentity)
          : null;
        if (memoryCtx && memoryCtx.items.length > 0) {
          const memoryText = memoryCtx.items
            .slice(0, 10)
            .map((item: any) => item.content || item.text)
            .filter(Boolean)
            .join('\n');
          if (memoryText) {
            systemInstruction += '\n\nContext about this user:\n' + memoryText;
          }
        }
      } catch (memErr: any) {
        console.warn(`[VTID-FALLBACK] Memory fetch failed: ${memErr.message}`);
      }
    }

    // 3. Call Gemini API for text response
    let replyText = '';
    if (GEMINI_API_KEY) {
      const geminiResponse = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            ...conversationHistory,
            { role: 'user', parts: [{ text: text.trim() }] }
          ],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            maxOutputTokens: 256,
            temperature: 0.7
          }
        })
      });

      if (!geminiResponse.ok) {
        throw new Error(`Gemini API error: ${geminiResponse.status}`);
      }

      const geminiData = await geminiResponse.json() as any;
      replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      // Vertex AI fallback via processWithGemini
      const result = await processWithGemini({
        text,
        threadId: session_id || `fallback-${Date.now()}`,
        systemInstruction
      });
      replyText = result?.reply || '';
    }

    if (!replyText) {
      return res.status(500).json({ ok: false, error: 'Empty response from language model' });
    }

    // 4. Synthesize audio with Google Cloud TTS
    let audioB64 = '';
    let audioMime = '';
    if (ttsClient) {
      const useNeural2 = NEURAL2_ENABLED_LANGUAGES.includes(lang);
      const voiceConfig = useNeural2
        ? (NEURAL2_TTS_VOICES[lang] || NEURAL2_TTS_VOICES['en'])
        : (GEMINI_TTS_VOICES[lang] || GEMINI_TTS_VOICES['en']);

      const voiceParams: any = {
        languageCode: voiceConfig.languageCode,
        name: voiceConfig.name,
      };
      if (!useNeural2) {
        voiceParams.modelName = 'gemini-2.5-flash-tts';
      }

      const [ttsResponse] = await ttsClient.synthesizeSpeech({
        input: { text: replyText },
        voice: voiceParams,
        audioConfig: {
          audioEncoding: 'MP3' as any,
          speakingRate: 1.0,
          pitch: 0
        }
      });

      if (ttsResponse.audioContent) {
        audioB64 = Buffer.isBuffer(ttsResponse.audioContent)
          ? ttsResponse.audioContent.toString('base64')
          : Buffer.from(ttsResponse.audioContent as Uint8Array).toString('base64');
        audioMime = 'audio/mp3';
      }
    }

    console.log(`[VTID-FALLBACK] chat-tts success: reply_length=${replyText.length}, audio_bytes=${audioB64.length}`);

    // 5. Emit OASIS event for observability
    emitLiveSessionEvent('orb.live.fallback_used', {
      session_id: session_id || 'none',
      text_length: text.length,
      reply_length: replyText.length,
      has_audio: !!audioB64,
      lang,
    }, 'info').catch(() => {});

    return res.status(200).json({
      ok: true,
      text: replyText,
      audio_b64: audioB64,
      audio_mime: audioMime,
      mode: 'fallback_chat_tts'
    });
  } catch (error: any) {
    console.error('[VTID-FALLBACK] chat-tts error:', error);
    emitLiveSessionEvent('orb.live.fallback_error', {
      session_id: session_id || 'none',
      error: error.message,
    }, 'error').catch(() => {});
    return res.status(500).json({
      ok: false,
      error: error.message || 'Fallback processing failed'
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
    // VTID-FALLBACK: Fallback voice provider status
    fallback_chat_tts: {
      available: !!(GEMINI_API_KEY || googleAuth) && !!ttsClient,
      gemini_api: !!GEMINI_API_KEY,
      tts_ready: !!ttsClient,
    },
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
      enabled: !!(googleAuth && VERTEX_PROJECT_ID),
      vtid: 'VTID-01155',
      active_live_sessions: liveSessions.size,
      live_model: VERTEX_LIVE_MODEL,
      tts_model: VERTEX_TTS_MODEL,
      vertex_project_id: VERTEX_PROJECT_ID || 'EMPTY',
      google_auth_ready: !!googleAuth,
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
  type: 'start' | 'audio' | 'video' | 'text' | 'end_turn' | 'stop' | 'ping' | 'interrupt' | 'audio_ready';
  // Text message fields
  text?: string;
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
  // Conversation continuity
  conversation_summary?: string;
  // VTID-RESPONSE-DELAY: Per-session VAD silence threshold override (ms)
  vad_silence_ms?: number;
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
  // Request metadata for OASIS event telemetry
  userAgent: string | null;
  originUrl: string | null;
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
    identity,  // VTID-01224: Server-verified identity
    userAgent: req.headers['user-agent'] || null,
    originUrl: (req.headers['origin'] || req.headers['referer'] || null) as string | null,
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

  // VTID-STREAM-KEEPALIVE: Server-side ping to prevent Cloud Run ALB idle timeout.
  // The SSE path has a 30s heartbeat, but the WS path had nothing — idle connections
  // were silently terminated by the load balancer after ~60s of no data.
  const clientPingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch (e) {
        // socket may be closing — ignore
      }
    } else {
      clearInterval(clientPingInterval);
    }
  }, 30_000);

  // Handle client disconnect
  ws.on('close', (code, reason) => {
    console.log(`[VTID-01222] WebSocket disconnected: ${sessionId}, code=${code}, reason=${reason}`);
    clearInterval(clientPingInterval);
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

    case 'text':
      if (!liveSession || !liveSession.active) {
        sendWsMessage(clientWs, { type: 'error', message: 'No active session. Send "start" first.' });
        return;
      }
      handleWsTextMessage(clientSession, message);
      break;

    case 'interrupt':
      // VTID-VOICE-INIT: Client detected real user speech during model playback
      // Ungate mic audio and tell Gemini to stop generating
      if (!liveSession || !liveSession.active) {
        sendWsMessage(clientWs, { type: 'error', message: 'No active session.' });
        return;
      }
      handleWsInterruptMessage(clientSession);
      break;

    case 'end_turn':
      if (!liveSession || !liveSession.active) {
        sendWsMessage(clientWs, { type: 'error', message: 'No active session.' });
        return;
      }
      handleWsEndTurn(clientSession);
      break;

    case 'audio_ready':
      // VTID-AUDIO-READY: Client signals its audio player is initialized and ready
      // to receive audio. Send deferred greeting now to avoid truncating first words.
      if (!liveSession || !liveSession.active) {
        sendWsMessage(clientWs, { type: 'error', message: 'No active session.' });
        return;
      }
      if (liveSession.greetingDeferred && !liveSession.greetingSent && liveSession.upstreamWs) {
        console.log(`[VTID-AUDIO-READY] Client audio_ready received — sending chime + deferred greeting for session ${liveSession.sessionId}`);
        // VTID-INSTANT-FEEDBACK: Send activation chime immediately so user hears
        // instant audio feedback while Gemini generates the real greeting (2-5s).
        try {
          const chimePcm = generateChimePcm();
          sendWsMessage(clientWs, {
            type: 'audio',
            data_b64: chimePcm,
            mime: 'audio/pcm;rate=24000',
            chunk_number: liveSession.audioOutChunks++,
            source: 'activation_chime'
          });
          console.log(`[VTID-INSTANT-FEEDBACK] Activation chime sent via WS for session ${liveSession.sessionId}`);
        } catch (err) {
          console.warn('[VTID-INSTANT-FEEDBACK] Failed to send chime via WS:', err);
        }
        sendGreetingPromptToLiveAPI(liveSession.upstreamWs, liveSession);
        liveSession.greetingDeferred = false;
      } else {
        console.log(`[VTID-AUDIO-READY] audio_ready received but greeting already sent or not deferred: session=${liveSession.sessionId}`);
      }
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

  const clientRequestedLangWs = message.lang; // may be undefined
  const responseModalities = message.response_modalities || ['audio', 'text'];

  // VTID-01224: Build bootstrap context if authenticated
  // VTID-01225: Added DEV_IDENTITY fallback for memory recall in dev-sandbox mode
  let contextInstruction: string | undefined;
  let contextPack: ContextPack | undefined;
  let contextBootstrapLatencyMs: number | undefined;
  let contextBootstrapSkippedReason: string | undefined;

  // Determine effective identity for context bootstrap (same pattern as memory writes)
  // Create a synthetic SupabaseIdentity for dev-sandbox mode
  const devSandboxIdentity: SupabaseIdentity = {
    user_id: DEV_IDENTITY.USER_ID,
    tenant_id: DEV_IDENTITY.TENANT_ID,
    role: DEV_IDENTITY.ACTIVE_ROLE,
    email: 'dev-sandbox@vitana.local',
    exafy_admin: false,
    aud: 'authenticated',
    exp: null,
    iat: null
  };
  // JWT identity takes priority so each user builds their own memory.
  // DEV_IDENTITY is fallback only when no JWT is present (anonymous/unauthenticated).
  const effectiveBootstrapIdentity: SupabaseIdentity | null =
    (identity && identity.tenant_id && identity.user_id)
      ? identity
      : isDevSandbox()
        ? devSandboxIdentity
        : null;

  // Resolve language: use client-requested language, fall back to stored preference, then 'en'
  let lang = normalizeLang(clientRequestedLangWs || 'en');
  if (!clientRequestedLangWs && effectiveBootstrapIdentity?.user_id && effectiveBootstrapIdentity?.tenant_id) {
    const storedLangWs = await getStoredLanguagePreference(effectiveBootstrapIdentity.tenant_id, effectiveBootstrapIdentity.user_id);
    if (storedLangWs) {
      lang = storedLangWs;
      console.log(`[LANG-PREF] WS: Using stored language preference: ${lang} for user=${effectiveBootstrapIdentity.user_id.substring(0, 8)}...`);
    }
  }

  // Persist language preference (fire-and-forget)
  if (effectiveBootstrapIdentity?.user_id && effectiveBootstrapIdentity?.tenant_id) {
    persistLanguagePreference(effectiveBootstrapIdentity.tenant_id, effectiveBootstrapIdentity.user_id, lang);
  }

  console.log(`[VTID-01222] Starting Live API session: ${sessionId}, lang=${lang}`);

  // VTID-01225-ROLE: Fetch real application role in parallel with context bootstrap
  let activeRole: string | null = null;
  // VTID-01224-FIX: Last session info for context-aware greeting
  let wsLastSessionInfo: { time: string; wasFailure: boolean } | null = null;

  if (effectiveBootstrapIdentity) {
    const usingDevFallbackWs = effectiveBootstrapIdentity.user_id === DEV_IDENTITY.USER_ID;
    console.log(`[VTID-01224] Building bootstrap context for session ${sessionId} user=${effectiveBootstrapIdentity.user_id.substring(0, 8)}...${usingDevFallbackWs ? ' (DEV_IDENTITY fallback)' : ''}`);

    // Fetch role, context, and last session info in parallel for minimal latency
    const [bootstrapResult, fetchedRole, fetchedWsSessionInfo] = await Promise.all([
      buildBootstrapContextPack(effectiveBootstrapIdentity, sessionId),
      usingDevFallbackWs
        ? Promise.resolve(DEV_IDENTITY.ACTIVE_ROLE)
        : resolveEffectiveRole(effectiveBootstrapIdentity.user_id, effectiveBootstrapIdentity.tenant_id || ''),
      fetchLastSessionInfo(effectiveBootstrapIdentity.user_id),
    ]);
    activeRole = fetchedRole;
    wsLastSessionInfo = fetchedWsSessionInfo;

    // VTID-ROLE-CMD-HUB: Command Hub is developer-only — override role
    const wsRoute = typeof (message as any).current_route === 'string' ? (message as any).current_route : '';
    if (wsRoute.startsWith('/command-hub') && (!activeRole || activeRole === 'community')) {
      console.log(`[VTID-01225-ROLE] Overriding role to "developer" for Command Hub WS session (was: ${activeRole || 'null'})`);
      activeRole = 'developer';
    }

    contextInstruction = bootstrapResult.contextInstruction;
    contextPack = bootstrapResult.contextPack;
    contextBootstrapLatencyMs = bootstrapResult.latencyMs;
    contextBootstrapSkippedReason = bootstrapResult.skippedReason;

    // BOOTSTRAP-ADMIN-EE: admin-role WS sessions get a proactive briefing too.
    if (isAdminRole(activeRole) && effectiveBootstrapIdentity.tenant_id) {
      try {
        const briefing = await fetchAdminBriefingBlock(effectiveBootstrapIdentity.tenant_id, 3);
        if (briefing) {
          contextInstruction = contextInstruction
            ? `${contextInstruction}\n\n${briefing}`
            : briefing;
          emitOasisEvent({
            vtid: 'BOOTSTRAP-ADMIN-EE',
            type: 'admin.briefing.injected',
            source: 'orb-live-ws',
            status: 'info',
            message: `Admin briefing injected into WS session ${sessionId}`,
            payload: { session_id: sessionId, tenant_id: effectiveBootstrapIdentity.tenant_id, role: activeRole, chars: briefing.length },
            actor_id: effectiveBootstrapIdentity.user_id,
            actor_role: 'admin',
            surface: 'orb',
          }).catch(() => {});
        }
      } catch (err: any) {
        console.warn(`[BOOTSTRAP-ADMIN-EE] WS briefing fetch failed: ${err?.message}`);
      }
    }

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
          tenant_id: effectiveBootstrapIdentity.tenant_id,
          user_id: effectiveBootstrapIdentity.user_id,
          latency_ms: bootstrapResult.latencyMs,
          reason: bootstrapResult.skippedReason,
          using_dev_identity: !identity,
        },
      }).catch(() => { });
    } else {
      emitOasisEvent({
        vtid: 'VTID-01224',
        type: 'orb.live.context.bootstrap',
        source: 'orb-live-ws',
        status: 'info',
        message: `Context bootstrap complete: ${bootstrapResult.latencyMs}ms${!identity ? ' (DEV_IDENTITY)' : ''}`,
        payload: {
          session_id: sessionId,
          tenant_id: effectiveBootstrapIdentity.tenant_id,
          user_id: effectiveBootstrapIdentity.user_id,
          latency_ms: bootstrapResult.latencyMs,
          memory_hits: contextPack?.memory_hits?.length || 0,
          knowledge_hits: contextPack?.knowledge_hits?.length || 0,
          context_chars: contextInstruction?.length || 0,
          using_dev_identity: !identity,
        },
      }).catch(() => { });
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
    }).catch(() => { });
  }

  // Create Gemini Live session with identity and context
  // VTID-01225: Use effectiveBootstrapIdentity so memory writes also work in dev-sandbox
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
    // VTID-01224: Identity and context (use effective identity for dev-sandbox fallback)
    identity: effectiveBootstrapIdentity || identity,
    // VTID-01225-ROLE: Application-level role (community/admin/developer)
    active_role: activeRole,
    thread_id: sessionId,
    turn_count: 0,
    contextInstruction,
    contextPack,
    contextBootstrapLatencyMs,
    contextBootstrapSkippedReason,
    contextBootstrapBuiltAt: Date.now(),
    // VTID-01225: Transcript accumulation for Cognee extraction
    transcriptTurns: [],
    outputTranscriptBuffer: '',
    pendingEventLinks: [],
    // VTID-01225-THROTTLE: Buffer for user input transcription (written once per turn)
    inputTranscriptBuffer: '',
    // VTID-VOICE-INIT: Echo prevention — not speaking at session start
    isModelSpeaking: false,
    // VTID-ECHO-COOLDOWN: No cooldown at session start
    turnCompleteAt: 0,
    // Conversation summary for greeting context (from client message)
    conversationSummary: message.conversation_summary,
    // VTID-STREAM-SILENCE: Track last audio forwarded for idle detection
    lastAudioForwardedTime: Date.now(),
    // Telemetry batching: emit at most once per 10s window
    lastTelemetryEmitTime: 0,
    // VTID-RESPONSE-DELAY: Per-session VAD from client or default
    vadSilenceMs: message.vad_silence_ms && message.vad_silence_ms >= 500 && message.vad_silence_ms <= 3000
      ? message.vad_silence_ms : VAD_SILENCE_DURATION_MS_DEFAULT,
    // VTID-AUDIO-READY: WebSocket path defers greeting until client sends audio_ready
    greetingDeferred: true,
    // VTID-STREAM-RECONNECT: Store client WS reference for transparent reconnection notifications
    clientWs,
    // VTID-01224-FIX: Last session info for context-aware greeting
    lastSessionInfo: wsLastSessionInfo,
    // VTID-LOOPGUARD: Track consecutive model turns for loop prevention
    consecutiveModelTurns: 0,
    // VTID-TOOLGUARD: Track consecutive tool calls for loop prevention
    consecutiveToolCalls: 0,
    // VTID-ANON: WS sessions with no JWT are anonymous
    isAnonymous: !identity?.user_id,
    // VTID-NAV: Current page + recent navigation history pushed by the host
    // React Router via VTOrb.updateContext() and included in the WS start
    // message. The consult service uses these for context-aware ranking.
    current_route: typeof (message as any).current_route === 'string'
      ? (message as any).current_route
      : undefined,
    recent_routes: Array.isArray((message as any).recent_routes)
      ? ((message as any).recent_routes as any[])
          .filter((r): r is string => typeof r === 'string')
          .slice(0, 5)
      : undefined,
    // VTID-02789: mobile viewport flag plumbed from useIsMobile() in the
    // frontend; drives mobile_route override + viewport_only block in
    // handleNavigateToScreen. WS path mirrors the SSE path above.
    is_mobile: typeof (message as any).is_mobile === 'boolean'
      ? (message as any).is_mobile
      : undefined,
  };

  // VTID-SESSION-LIMIT: Terminate existing sessions for this user (WS path)
  // VTID-SESSION-LIMIT-FIX: Skip for dev-sandbox identity (same reason as SSE path)
  const wsEffectiveUserId = (effectiveBootstrapIdentity || identity)?.user_id;
  const wsIsDevIdentity = wsEffectiveUserId === DEV_IDENTITY.USER_ID;
  if (wsEffectiveUserId && !wsIsDevIdentity) {
    const wsTerminated = terminateExistingSessionsForUser(wsEffectiveUserId, sessionId);
    if (wsTerminated > 0) {
      console.log(`[VTID-SESSION-LIMIT] WS: Terminated ${wsTerminated} existing session(s) for user=${wsEffectiveUserId.substring(0, 8)}... before starting ${sessionId}`);
    }
  }

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
      // FIX: Send raw PCM for Web Audio API scheduled playback (eliminates gaps between chunks)
      (audioB64: string) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          try {
            // Send raw PCM - client uses Web Audio API scheduling for seamless playback
            sendWsMessage(clientWs, {
              type: 'audio',
              data_b64: audioB64,
              mime: 'audio/pcm;rate=24000',
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
      },
      // Turn complete handler - forward to WS client so it knows when response ends
      () => {
        if (clientWs.readyState === WebSocket.OPEN) {
          const isGreetingTurn = liveSession.greetingSent && liveSession.turn_count === (liveSession.greetingTurnIndex ?? 0) + 1;
          sendWsMessage(clientWs, {
            type: 'turn_complete',
            is_greeting: isGreetingTurn
          });
          console.log(`[VTID-VOICE-INIT] Forwarded turn_complete to WS client ${sessionId} (isGreeting=${isGreetingTurn})`);
        }
      },
      // Interrupted handler - forward to WS client so it can clear audio queue
      () => {
        if (clientWs.readyState === WebSocket.OPEN) {
          sendWsMessage(clientWs, { type: 'interrupted' });
          console.log(`[VTID-VOICE-INIT] Forwarded interrupted to WS client ${sessionId}`);
        }
      }
    );

    liveSession.upstreamWs = upstreamWs;

    // NOTE: No external close handler needed here — connectToLiveAPI's internal close handler
    // handles transparent reconnection (code 1000) and genuine disconnects for both SSE and WS
    // clients via session.clientWs / session.sseResponse. Adding a second handler would
    // cause the client to receive disconnect notifications even during successful reconnections.

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
      email: identity?.email || null,
      user_agent: clientSession.userAgent,
      origin: clientSession.originUrl,
      context_bootstrap: {
        included: !!contextInstruction,
        latency_ms: contextBootstrapLatencyMs || 0,
        skipped_reason: contextBootstrapSkippedReason || null,
        memory_hits: contextPack?.memory_hits?.length || 0,
        knowledge_hits: contextPack?.knowledge_hits?.length || 0,
        tools_enabled: !!identity,
      },
    }).catch(() => { });

    // Send session_started + setupComplete (v1 client compatibility)
    // v1 VertexLiveService expects { setupComplete: true } before considering ready
    sendWsMessage(clientWs, {
      type: 'session_started',
      session_id: sessionId,
      live_api_connected: true,
      setupComplete: true, // v1 compatibility: signals Gemini is ready
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

    // VTID-AUDIO-READY: Defer greeting until client sends audio_ready to avoid
    // truncating first words on mobile (race condition: greeting streams before
    // client audio player is initialized). Fallback: send after 2s if no audio_ready.
    if (liveSession.greetingDeferred) {
      console.log(`[VTID-AUDIO-READY] Greeting deferred — waiting for client audio_ready: session=${sessionId}`);
      setTimeout(() => {
        if (!liveSession.greetingSent && liveSession.active && liveSession.upstreamWs) {
          console.log(`[VTID-AUDIO-READY] Fallback: sending chime + greeting after 2s timeout: session=${sessionId}`);
          // VTID-INSTANT-FEEDBACK: Send chime before fallback greeting too
          try {
            const chimePcm = generateChimePcm();
            sendWsMessage(clientWs, {
              type: 'audio',
              data_b64: chimePcm,
              mime: 'audio/pcm;rate=24000',
              chunk_number: liveSession.audioOutChunks++,
              source: 'activation_chime'
            });
          } catch (err) {
            console.warn('[VTID-INSTANT-FEEDBACK] Failed to send chime in fallback:', err);
          }
          sendGreetingPromptToLiveAPI(liveSession.upstreamWs, liveSession);
          liveSession.greetingDeferred = false;
        }
      }, 2000);
    } else {
      // SSE path or non-deferred: send greeting immediately
      sendGreetingPromptToLiveAPI(upstreamWs, liveSession);
    }

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

  // VTID-ANON-NUDGE: Block all input after turn limit (WebSocket path)
  if (liveSession.isAnonymous && (liveSession.turn_count > 8 || liveSession.signupIntentDetected)) {
    return;
  }

  if (!message.data_b64) {
    sendWsMessage(clientWs, { type: 'error', message: 'Missing data_b64 in audio message' });
    return;
  }

  // VTID-NAV: Once a navigation is queued, drop ALL further mic audio so
  // Gemini cannot start a new turn while the widget is closing. Without this
  // gate the model talks over its own goodbye sentence.
  if (liveSession.navigationDispatched) {
    liveSession.audioInChunks++;
    liveSession.lastActivity = new Date();
    return;
  }

  // VTID-VOICE-INIT: Echo prevention gate — drop mic audio while model is speaking.
  // On mobile devices without hardware AEC, the phone speaker output is picked up by
  // the mic and forwarded to Gemini, which interprets it as new user speech. This causes
  // Gemini to interrupt itself and generate 2-3 overlapping response streams.
  // The gate is released when turn_complete or interrupted is received from Gemini.
  if (liveSession.isModelSpeaking) {
    // Log sparingly to avoid flooding (every 50th dropped chunk)
    if (liveSession.audioInChunks % 50 === 0) {
      console.log(`[VTID-VOICE-INIT] Dropping mic audio — model is speaking: session=${sessionId}, dropped_at_chunk=${liveSession.audioInChunks}`);
    }
    liveSession.audioInChunks++;
    liveSession.lastActivity = new Date();
    return;
  }

  // VTID-ECHO-COOLDOWN: Post-turn cooldown — gate mic audio for N ms after
  // turn_complete to let client-side audio playback finish draining.
  if (liveSession.turnCompleteAt > 0 && (Date.now() - liveSession.turnCompleteAt) < POST_TURN_COOLDOWN_MS) {
    liveSession.audioInChunks++;
    liveSession.lastActivity = new Date();
    return;
  }

  liveSession.audioInChunks++;
  liveSession.lastActivity = new Date();

  // Telemetry: emit at most once per 10s window (was per-100-chunks ~1-2s)
  const now = Date.now();
  if (now - liveSession.lastTelemetryEmitTime >= 10_000) {
    liveSession.lastTelemetryEmitTime = now;
    emitLiveSessionEvent('vtid.live.audio.in.chunk', {
      session_id: sessionId,
      chunk_number: liveSession.audioInChunks,
      bytes: message.data_b64.length,
      rate: 16000,
      transport: 'websocket'
    }).catch(() => { });
  }

  // Forward to Live API if connected
  if (liveSession.upstreamWs && liveSession.upstreamWs.readyState === WebSocket.OPEN) {
    const sent = sendAudioToLiveAPI(
      liveSession.upstreamWs,
      message.data_b64,
      message.mime || 'audio/pcm;rate=16000'
    );

    if (sent) {
      liveSession.lastAudioForwardedTime = Date.now(); // VTID-STREAM-SILENCE: reset idle timer
      // VTID-FORWARDING-WATCHDOG / BOOTSTRAP-ORB-RELIABILITY-R4: sliding
      // watchdog. See SSE path for full rationale — mirrored here so the
      // WS and SSE transports stay in lockstep until Phase 3 collapses
      // them onto one adapter.
      if (!liveSession.isModelSpeaking) {
        // VTID-01984 (R5): mirror of SSE-path gate — once Vertex has shown
        // life, skip arming the forwarding_no_ack watchdog. Healthy WS does
        // not need a 15-45 s heuristic to detect Vertex's compute window.
        if (liveSession.vertexHasShownLife) {
          if (liveSession.audioInChunks % 200 === 0) {
            emitDiag(liveSession, 'watchdog_skipped', { reason: 'vertex_alive' });
          }
        } else {
          const canSlide = !liveSession.responseWatchdogTimer
            || liveSession.responseWatchdogReason === 'forwarding_no_ack';
          if (canSlide) {
            startResponseWatchdog(liveSession, FORWARDING_ACK_TIMEOUT_MS, 'forwarding_no_ack');
          }
        }
      }
    } else {
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

  // Telemetry: reuse the same 10s window as audio
  const vidNow = Date.now();
  if (vidNow - liveSession.lastTelemetryEmitTime >= 10_000) {
    liveSession.lastTelemetryEmitTime = vidNow;
    emitLiveSessionEvent('vtid.live.video.in.frame', {
      session_id: sessionId,
      source: message.source || 'unknown',
      frame_number: liveSession.videoInFrames,
      bytes: message.data_b64.length,
      transport: 'websocket'
    }).catch(() => { });
  }

  console.log(`[VTID-01222] Video frame received: ${sessionId}, source=${message.source}, frame=${liveSession.videoInFrames}`);

  // Acknowledge frame receipt
  sendWsMessage(clientWs, {
    type: 'video_ack',
    source: message.source,
    frame_number: liveSession.videoInFrames
  });
}

/**
 * Handle text message from WS client - forward to Live API as client_content
 * Includes greeting deduplication: if server already sent greeting, skip client's greeting request.
 */
function handleWsTextMessage(clientSession: WsClientSession, message: WsClientMessage): void {
  const { sessionId, clientWs, liveSession } = clientSession;
  if (!liveSession) return;

  // VTID-ANON-NUDGE: Block all input after turn limit (WebSocket text path)
  if (liveSession.isAnonymous && (liveSession.turn_count > 8 || liveSession.signupIntentDetected)) {
    return;
  }

  const text = message.text;
  if (!text) {
    sendWsMessage(clientWs, { type: 'error', message: 'Missing text in text message' });
    return;
  }

  // Deduplicate client-side greeting if server already sent one
  if (liveSession.greetingSent && text.toLowerCase().includes('greet')) {
    console.log(`[VTID-VOICE-INIT] Skipping client greeting request via WS - server greeting already sent`);
    sendWsMessage(clientWs, { type: 'text_ack', note: 'Server greeting already in progress' });
    return;
  }

  if (liveSession.upstreamWs && liveSession.upstreamWs.readyState === WebSocket.OPEN) {
    const textMessage = {
      client_content: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turn_complete: true
      }
    };
    liveSession.upstreamWs.send(JSON.stringify(textMessage));
    console.log(`[VTID-VOICE-INIT] WS text message forwarded to Live API: "${text.substring(0, 80)}..."`);
    sendWsMessage(clientWs, { type: 'text_ack' });
  } else {
    sendWsMessage(clientWs, { type: 'error', message: 'Live API not connected' });
  }
}

/**
 * VTID-VOICE-INIT: Handle explicit interrupt from client.
 * Client-side VAD detected real user speech while model is speaking.
 * We ungate mic audio and tell Gemini to stop generating immediately.
 */
function handleWsInterruptMessage(clientSession: WsClientSession): void {
  const { sessionId, clientWs, liveSession } = clientSession;

  if (!liveSession) return;

  // Only meaningful if model is actually speaking
  if (!liveSession.isModelSpeaking) {
    console.log(`[VTID-VOICE-INIT] Interrupt received but model not speaking: session=${sessionId}`);
    sendWsMessage(clientWs, { type: 'interrupt_ack', was_speaking: false });
    return;
  }

  console.log(`[VTID-VOICE-INIT] Client interrupt — ungating mic and stopping Gemini: session=${sessionId}`);

  // 1. Ungate mic audio so subsequent frames reach Gemini
  liveSession.isModelSpeaking = false;

  // 2. Tell Gemini to stop generating by sending client_content.turn_complete
  if (liveSession.upstreamWs && liveSession.upstreamWs.readyState === WebSocket.OPEN) {
    sendEndOfTurn(liveSession.upstreamWs);
  }

  // 3. Clear the output transcript buffer (response was interrupted, incomplete)
  liveSession.outputTranscriptBuffer = '';

  // 4. Ack to client so it can stop audio playback
  sendWsMessage(clientWs, { type: 'interrupt_ack', was_speaking: true });

  // 5. Also send interrupted event to client (same as Gemini would send)
  sendWsMessage(clientWs, { type: 'interrupted' });
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
    // VTID-NAV-TIMEJOURNEY: include user_id so fetchLastSessionInfo can find
    // this event when the user next opens the ORB.
    emitLiveSessionEvent('vtid.live.session.stop', {
      session_id: sessionId,
      user_id: liveSession.identity?.user_id || null,
      tenant_id: liveSession.identity?.tenant_id || null,
      audio_in_chunks: liveSession.audioInChunks,
      audio_out_chunks: liveSession.audioOutChunks,
      video_frames: liveSession.videoInFrames,
      transport: 'websocket',
      turn_count: liveSession.turn_count,
      user_turns: liveSession.transcriptTurns.filter(t => t.role === 'user').length,
      model_turns: liveSession.transcriptTurns.filter(t => t.role === 'assistant').length,
    }).catch(() => { });
    // VTID-01959: voice self-healing dispatch (mode-gated for /report path).
    // VTID-01994: pass session metrics for mode-independent quality classifier.
    dispatchVoiceFailureFireAndForget({
      sessionId,
      tenantScope: liveSession.identity?.tenant_id || 'global',
      metadata: { synthetic: (liveSession as any).synthetic === true },
      sessionMetrics: {
        audio_in_chunks: liveSession.audioInChunks,
        audio_out_chunks: liveSession.audioOutChunks,
        duration_ms: Date.now() - liveSession.createdAt.getTime(),
        turn_count: liveSession.turn_count,
        user_turns: liveSession.transcriptTurns.filter(t => t.role === 'user').length,
        model_turns: liveSession.transcriptTurns.filter(t => t.role === 'assistant').length,
      },
    });

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
    // VTID-01230: Deduplicated extraction on WebSocket disconnect
    const ls = clientSession.liveSession;
    if (ls.identity && ls.identity.tenant_id && ls.transcriptTurns.length > 0) {
      const fullTranscript = ls.transcriptTurns
        .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
        .join('\n');
      deduplicatedExtract({
        conversationText: fullTranscript,
        tenant_id: ls.identity.tenant_id,
        user_id: ls.identity.user_id,
        session_id: sessionId,
        force: true,
      });
      destroySessionBuffer(sessionId);
      clearExtractionState(sessionId);
    }

    clientSession.liveSession.active = false;

    // VTID-STREAM-KEEPALIVE: Clear upstream ping interval on cleanup
    if (clientSession.liveSession.upstreamPingInterval) {
      clearInterval(clientSession.liveSession.upstreamPingInterval);
      clientSession.liveSession.upstreamPingInterval = undefined;
    }
    if (clientSession.liveSession.silenceKeepaliveInterval) {
      clearInterval(clientSession.liveSession.silenceKeepaliveInterval);
      clientSession.liveSession.silenceKeepaliveInterval = undefined;
    }
    // VTID-WATCHDOG: Clear response watchdog on cleanup
    clearResponseWatchdog(clientSession.liveSession);

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
