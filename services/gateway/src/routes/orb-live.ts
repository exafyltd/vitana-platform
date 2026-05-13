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
// VTID-02917 (B0d.3): wake reliability timeline — emit + record only,
// never block the wake path. The recorder is best-effort by design.
import { defaultWakeTimelineRecorder } from '../services/wake-timeline/wake-timeline-recorder';
// VTID-02918 (B0d.4): wake-brief decision wiring. Side-effect import
// registers the voice-wake-brief provider with the default registry;
// `decideWakeBriefForSession` runs the continuation decision and emits
// the 3 continuation_decision_* timeline events.
import { decideWakeBriefForSession } from '../services/wake-brief-wiring';
// VTID-02941 (B0b-min + B2 decision integration): minimal decision-contract
// spine. The instruction layer renders the typed contract; the compiler
// distills. NO raw rows cross this boundary.
import { compileAssistantDecisionContext } from '../orb/context/compile-assistant-decision-context';
import { renderDecisionContract } from '../orb/live/instruction/decision-contract-renderer';
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
// VTID-02857: read operator-tunable speakingRate from system_config (cached)
import { getVoiceConfig } from '../services/voice-config';
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

export interface OrbLiveSession {
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

// In-memory session store (dev sandbox only).
// A8.1: declaration moved to orb/live/session/live-session-registry.ts;
// the `sessions` symbol used below is imported at the top of this file.

// A2 (orb-live-refactor): SESSION_TIMEOUT_MS lifted to orb/live/config.ts.
import { SESSION_TIMEOUT_MS } from '../orb/live/config';

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

// A2 (orb-live-refactor): MAX_CONNECTIONS_PER_IP lifted to orb/live/config.ts.
import { MAX_CONNECTIONS_PER_IP } from '../orb/live/config';
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
// A2 (orb-live-refactor): CONVERSATION_TIMEOUT_MS lifted to orb/live/config.ts.
import { CONVERSATION_TIMEOUT_MS } from '../orb/live/config';

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

// A2 (orb-live-refactor): SUPPORTED_LIVE_LANGUAGES lifted to orb/live/config.ts.
import { SUPPORTED_LIVE_LANGUAGES } from '../orb/live/config';

/**
 * VTID-01155: Gemini Live session state
 * VTID-01224: Extended with identity and context fields for intelligence stack
 */
export interface GeminiLiveSession {
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

// A1 (orb-live-refactor): client/protocol types lifted to orb/live/types.ts.
// No behavior change — same declarations, imported from a shared module so
// A3/A8/A9 don't have to circle back here for the wire contract. We keep
// ClientContext as a public re-export because external modules already
// import it from this route file.
import type {
  ClientContext,
  LiveSessionStartRequest,
  TtsRequest,
  LiveStreamAudioChunk,
  LiveStreamVideoFrame,
  LiveStreamMessage,
} from '../orb/live/types';
export type { ClientContext } from '../orb/live/types';

// VTID-01155: In-memory Live session store.
// A8.1: declaration moved to orb/live/session/live-session-registry.ts;
// the `liveSessions` symbol used below is imported at the top of this file.

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
// A2 (orb-live-refactor): VERTEX_PROJECT_ID + VERTEX_LOCATION lifted to orb/live/config.ts.
import { VERTEX_PROJECT_ID, VERTEX_LOCATION } from '../orb/live/config';
// A1 (orb-live-refactor): VERTEX_LIVE_MODEL + VERTEX_TTS_MODEL lifted to
// orb/live/protocol.ts. Same values, same callers; the constants now live
// in a shared module so A3/A7/A9 don't have to re-declare them.
import { VERTEX_LIVE_MODEL, VERTEX_TTS_MODEL } from '../orb/live/protocol';
// A9.1 (orb-live-refactor / VTID-02957): WebSocket transport attach lifted
// to orb/live/transport/websocket-handler.ts. `initializeOrbWebSocket`
// below now delegates the WSS construction + connection dispatch to the
// new module. Wire protocol byte-for-byte identical; mount path unchanged.
import { mountOrbWebSocketTransport } from '../orb/live/transport/websocket-handler';
// A9.2 (orb-live-refactor / VTID-02958): SSE transport helpers lifted to
// orb/live/transport/sse-handler.ts. The two SSE upgrade points below
// (`GET /orb/live`, `GET /orb/live/stream`) call attachSseHeaders +
// writeSseEvent + startSseHeartbeat. Wire format byte-for-byte identical:
// 4 SSE headers + flushHeaders, `data: ${JSON}\n\n` events, 10 s data
// heartbeat (NOT an SSE comment — that's the legacy [VTID-HEARTBEAT-FIX]).
// Session-lifecycle (session.sseResponse = res, context-pack rebuild,
// upstream WS connect, transcript extract on disconnect) stays here and
// moves under A8.
import {
  attachSseHeaders,
  writeSseEvent,
  startSseHeartbeat,
} from '../orb/live/transport/sse-handler';
// A8.1 (orb-live-refactor / VTID-02959): session registries lifted to
// orb/live/session/live-session-registry.ts. Same Map instances, same
// identity — only the declaration location moves. orb-live.ts continues
// to mutate `sessions`, `liveSessions`, `wsClientSessions` in place;
// A8.2 + A8.3 lift the lifecycle methods that operate on these Maps.
import {
  sessions,
  liveSessions,
  wsClientSessions,
} from '../orb/live/session/live-session-registry';
// A8.2 (orb-live-refactor / VTID-02961): session lifecycle helpers +
// smallest session-action handler lifted into the controller module.
// A8.2.1 (VTID-02962): `/live/session/start` handler also lifted into the
// controller; orb-live.ts configures the deps bag with all locals the
// lifted handlers need at module-init below.
import {
  configureLiveSessionController,
  cleanupExpiredSessions,
  cleanupWsSession,
  handleLiveStreamEndTurn,
  handleLiveSessionStart,
  handleLiveSessionStop,
  handleLiveStreamSend,
} from '../orb/live/session/live-session-controller';
// A8.3a.2 (VTID-02968): upstream Live message-handler body lifted to
// orb/live/session/upstream-message-handler.ts. Factory binds the
// connectToLiveAPI Promise-closure state (setupComplete / connectionTimeout
// / resolve) via onSetupComplete + isSetupComplete callbacks, and forwards
// every orb-live.ts-local helper through the deps bag.
import { createUpstreamLiveMessageHandler } from '../orb/live/session/upstream-message-handler';
// A8.3b.1 (VTID-02971): connectToLiveAPI now uses the A7 UpstreamLiveClient
// boundary via VertexLiveClient. The orb-specific persona/tools/context
// envelope is supplied through the new `customSetupMessage` option so the
// payload remains byte-for-byte identical to the pre-A8.3b.1 path.
// A8.3b.2 will rename / remove this adapter; for now it remains the active
// call path so frontends + transparent reconnect see no behavior change.
import { VertexLiveClient } from '../orb/live/upstream/vertex-live-client';
// L1 (VTID-02976): provider-selection plumbing for the upstream live client.
// Pure selector — `connectToLiveAPI` reads env + voice.active_provider, then
// asks the selector which provider to use, then emits OASIS events for the
// decision. L1 always pins to Vertex; L2 (canary) will honor LiveKit.
import {
  selectUpstreamProvider,
  type UpstreamSelectionDecision,
} from '../orb/live/upstream/upstream-provider-selector';
// NOTE: `getVoiceConfig` is already imported above (line ~92).
// A3 (orb-live-refactor): system instruction builder + its private helpers
// (describeTimeSince, describeRoute, buildTemporalJourneyContextSection,
// TemporalBucket type) lifted to orb/live/instruction/live-system-instruction.ts.
// No behavior change. The characterization tests from A0.1 + A0.2 verify
// the rendered prompt + bucket logic match byte-for-byte.
//
// Re-exported here so external callers that import from this route file
// (including the A0.1 + A0.2 characterization test suites) continue to
// resolve the same symbols.
import {
  buildLiveSystemInstruction,
  describeTimeSince,
  describeRoute,
} from '../orb/live/instruction/live-system-instruction';
export {
  buildLiveSystemInstruction,
  describeTimeSince,
  describeRoute,
} from '../orb/live/instruction/live-system-instruction';
// A5 (orb-live-refactor): buildLiveApiTools lifted to orb/live/tools/live-tool-catalog.ts.
// Same function, same callers, same admin-tool injection. Zero behavior change.
// Re-exported here so external callers (including the A0.1 tool-catalog
// characterization test) continue to resolve from this route file.
import { buildLiveApiTools } from '../orb/live/tools/live-tool-catalog';
export { buildLiveApiTools } from '../orb/live/tools/live-tool-catalog';
// A6.2 (orb-live-refactor): SessionContext + SessionMutator + first
// lifted navigator handler. orb-live.ts keeps compat shims that build
// the typed views and forward to handlers under orb/live/tools/handlers/.
import { buildSessionContext } from '../orb/live/session/session-context';
import { makeSessionMutator } from '../orb/live/session/session-mutator';
import { getCurrentScreenHandler } from '../orb/live/tools/handlers/navigator';
console.log(`[VTID-ORBC] Vertex config at startup: PROJECT_ID=${VERTEX_PROJECT_ID || 'EMPTY'}, LOCATION=${VERTEX_LOCATION}`);

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
  // PR 1.B-4: lifted to services/orb-tools-shared.ts:tool_navigate. Both
  // pipelines now run the same consultNavigator + decision logic + directive
  // payload construction + OASIS emit chain. Vertex post-processes the
  // result to: emit the directive immediately on its SSE/WS transport,
  // mutate session.pendingNavigation + session.current_route +
  // session.recent_routes, and persist the navigator-action memory row.
  // LiveKit's wrapper publishes the same directive over the room data
  // channel via _dispatch_with_directive (PR 1.B-0).
  const question = String(args.question || '').trim();
  if (!question) {
    return { success: false, result: '', error: 'navigate requires a non-empty question.' };
  }
  const hasIdentity = !!(session.identity?.tenant_id && session.identity?.user_id);

  const sb = getSupabase();
  if (!sb) {
    return { success: false, result: '', error: 'supabase_not_configured' };
  }
  const { dispatchOrbTool } = await import('../services/orb-tools-shared');
  const r = await dispatchOrbTool(
    'navigate',
    {
      question,
      current_route: session.current_route ?? null,
      recent_routes: Array.isArray(session.recent_routes) ? session.recent_routes : [],
      transcript_excerpt: session.inputTranscriptBuffer || '',
    },
    {
      user_id: session.identity?.user_id ?? '',
      tenant_id: session.identity?.tenant_id ?? null,
      role: session.identity?.role ?? null,
      vitana_id: session.identity?.vitana_id ?? null,
      lang: session.lang ?? 'en',
      session_id: session.sessionId,
      session_started_iso: session.createdAt.toISOString(),
      turn_number: session.turn_count,
    },
    sb,
  );

  if (r.ok === false) {
    return { success: false, result: '', error: r.error };
  }

  const result = (r.result ?? {}) as {
    decision?: string;
    confidence?: string;
    screen_id?: string;
    route?: string;
    title?: string;
    reason?: string;
    directive?: { type: string; directive: string; screen_id: string; route: string; title: string; reason: string; vtid: string };
  };

  // Vertex-only: when the shared dispatcher returned a directive, emit it
  // immediately on the SSE/WS transport (VTID-NAV-FAST), set
  // session.pendingNavigation (cleared right away so turn_complete won't
  // double-dispatch), eagerly update session.current_route +
  // session.recent_routes, and persist the navigator-action memory row.
  if (result.directive && result.screen_id && result.route && result.title) {
    const directive = result.directive;
    const directiveJson = JSON.stringify(directive);
    if (session.sseResponse) {
      try { session.sseResponse.write(`data: ${directiveJson}\n\n`); } catch (_e) { /* SSE closed */ }
    }
    if ((session as any).clientWs && (session as any).clientWs.readyState === 1 /* WebSocket.OPEN */) {
      try { sendWsMessage((session as any).clientWs, directive); } catch (_e) { /* WS closed */ }
    }
    console.log(`[VTID-NAV-FAST] Immediate orb_directive dispatched: ${result.screen_id} (${result.route})`);

    session.pendingNavigation = {
      screen_id: result.screen_id,
      route: result.route,
      title: result.title,
      reason: question,
      decision_source: 'direct',
      requested_at: Date.now(),
    };
    session.navigationDispatched = true;
    session.pendingNavigation = undefined;

    const previousRoute = session.current_route;
    session.current_route = result.route;
    if (previousRoute && previousRoute !== result.route) {
      const trail = Array.isArray(session.recent_routes) ? [...session.recent_routes] : [];
      const deduped = trail.filter((rt) => rt !== previousRoute);
      session.recent_routes = [previousRoute, ...deduped].slice(0, 5);
    }

    if (hasIdentity) {
      const lang = session.lang || 'en';
      writeNavigatorActionMemory({
        identity: {
          user_id: session.identity!.user_id,
          tenant_id: session.identity!.tenant_id as string,
          role: session.active_role || session.identity!.role || undefined,
        },
        screen: {
          screen_id: result.screen_id,
          route: result.route,
          title: result.title,
        },
        reason: question,
        decision_source: 'direct',
        orb_session_id: session.sessionId,
        conversation_id: session.conversation_id,
        lang,
      }).catch(() => {});
    }
  }

  return { success: true, result: typeof r.text === 'string' ? r.text : '' };
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
  // PR 1.B-5: lifted to services/orb-tools-shared.ts:tool_navigate_to_screen.
  // The shared module now enforces all 7 gates (anonymous, viewport,
  // mobile_route override, already-there dedup, OASIS error_kind events,
  // identity threading, fuzzy resolution). Vertex post-processes the
  // result here for session-state mutations: pendingNavigation +
  // navigationDispatched + eager current_route + writeNavigatorActionMemory.
  const screenId = String(args.screen_id || args.target || '').trim();
  if (!screenId) {
    return { success: false, result: '', error: 'navigate_to_screen requires screen_id (or legacy target).' };
  }
  const hasIdentity = !!(session.identity?.tenant_id && session.identity?.user_id);
  const sb = getSupabase();
  if (!sb) {
    return { success: false, result: '', error: 'supabase_not_configured' };
  }

  const { dispatchOrbTool } = await import('../services/orb-tools-shared');
  const r = await dispatchOrbTool(
    'navigate_to_screen',
    {
      ...args,
      current_route: session.current_route ?? null,
    },
    {
      user_id: session.identity?.user_id ?? '',
      tenant_id: session.identity?.tenant_id ?? null,
      role: session.identity?.role ?? null,
      vitana_id: session.identity?.vitana_id ?? null,
      lang: session.lang ?? 'en',
      session_id: session.sessionId,
      is_anonymous: !!session.isAnonymous || !hasIdentity,
      is_mobile: session.is_mobile === true,
    },
    sb,
  );

  if (r.ok === false) {
    return { success: false, result: '', error: r.error };
  }

  const result = (r.result ?? {}) as {
    screen_id?: string;
    route?: string;
    base_route?: string;
    title?: string;
    entry_kind?: string;
    already_there?: boolean;
    directive?: { type: string; directive: string; screen_id: string; route: string; title: string; reason: string; entry_kind: string; vtid: string };
  };

  // Already-there short-circuit — the shared dispatcher returns ok:true
  // with already_there:true (so LiveKit gets a friendly LLM-visible text).
  // Vertex's contract is success:false + error containing "already on…"
  // (preserved from handleNavigateToScreen pre-lift; the tool-loop logic
  // and the nav-redirect-flow tests both depend on that shape). Translate.
  if (result.already_there) {
    return {
      success: false,
      result: '',
      error: typeof r.text === 'string' && r.text.length > 0
        ? r.text
        : `The user is already on ${result.route || ''}. Suggest a related screen or just answer in voice instead.`,
    };
  }

  // Vertex-only: set pendingNavigation + eagerly update current_route so
  // turn_complete + get_current_screen see the fresh destination.
  if (result.directive && result.screen_id && result.route && result.title) {
    const reason = String(args.reason || 'navigate_to_screen tool call');
    session.pendingNavigation = {
      screen_id: result.screen_id,
      route: result.route,
      title: result.title,
      reason,
      decision_source: 'direct',
      requested_at: Date.now(),
    };
    session.navigationDispatched = true;

    const isOverlay = result.entry_kind === 'overlay';
    if (!isOverlay) {
      const baseRoutePath = result.base_route || result.route.split('?')[0];
      const previousRoute = session.current_route;
      session.current_route = baseRoutePath;
      if (previousRoute && previousRoute !== baseRoutePath) {
        const trail = Array.isArray(session.recent_routes) ? [...session.recent_routes] : [];
        const deduped = trail.filter((rt) => rt !== previousRoute);
        session.recent_routes = [previousRoute, ...deduped].slice(0, 5);
      }
    }

    if (hasIdentity) {
      const lang = session.lang || 'en';
      writeNavigatorActionMemory({
        identity: {
          user_id: session.identity!.user_id,
          tenant_id: session.identity!.tenant_id as string,
          role: session.identity!.role || session.active_role || undefined,
        },
        screen: {
          screen_id: result.screen_id,
          route: result.route,
          title: result.title,
        },
        reason,
        decision_source: 'direct',
        orb_session_id: session.sessionId,
        conversation_id: session.conversation_id,
        lang,
      }).catch(() => {});
    }
  }

  return { success: true, result: typeof r.text === 'string' ? r.text : '' };
}

/**
 * VTID-NAV-TIMEJOURNEY: Handle get_current_screen tool call.
 *
 * PR 1.B-3 lifted the body into services/orb-tools-shared.ts so the LiveKit
 * pipeline runs the same lookup. Vertex still resolves session-state from
 * its WebSocket session (current_route + recent_routes are mutated inline
 * by handleNavigateToScreen + handleNavigate as the user moves around) and
 * passes them via args to the shared dispatcher. Anonymous-safe — no
 * identity required.
 */
// A6.2 (orb-live-refactor): handleGetCurrentScreen is now a compat shim.
// The handler body lives in orb/live/tools/handlers/navigator.ts and
// receives the typed SessionContext + SessionMutator. The shim here
// builds the typed views from the live session and forwards.
//
// This is the template every subsequent A6.x handler extraction will
// follow: route file keeps a thin (session) → handler(args, ctx, mutator)
// wrapper for compatibility with the dispatcher; the real logic lives
// under orb/live/tools/handlers/.
async function handleGetCurrentScreen(
  session: GeminiLiveSession,
): Promise<{ success: boolean; result: string; error?: string }> {
  const ctx = buildSessionContext(session as any);
  const mutator = makeSessionMutator(session as any);
  return getCurrentScreenHandler({}, ctx, mutator);
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
    return await handleGetCurrentScreen(session);
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
        // PR B-10 lifted the scoring engine; PR 1.B-8 added auto-nav to
        // OVERLAY.EVENT_DRAWER when the top event dominates the runner-up
        // and there are no live-rooms competing. Switch from
        // dispatchOrbToolForVertex to dispatchOrbTool so we can read the
        // structured directive and emit it via SSE/WS just like
        // search_community + view_intent_matches do.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbTool } = await import('../services/orb-tools-shared');
        const r = await dispatchOrbTool(
          'search_events',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
            session_id: session.sessionId,
          },
          supabase,
        );
        if (r.ok === false) {
          return { success: false, result: '', error: r.error };
        }
        const result = (r.result ?? {}) as {
          decision?: string;
          directive?: {
            type: string;
            directive: string;
            screen_id: string;
            route: string;
            title: string;
            reason: string;
            vtid: string;
          };
        };
        if (result.decision === 'auto_nav' && result.directive) {
          const directive = result.directive;
          const directiveJson = JSON.stringify(directive);
          if (session.sseResponse) {
            try { session.sseResponse.write(`data: ${directiveJson}\n\n`); } catch (_e) { /* SSE closed */ }
          }
          if ((session as unknown as { clientWs?: { readyState: number } }).clientWs &&
              (session as unknown as { clientWs?: { readyState: number } }).clientWs!.readyState === 1) {
            try { sendWsMessage((session as unknown as { clientWs: unknown }).clientWs as Parameters<typeof sendWsMessage>[0], directive); } catch (_e) { /* WS closed */ }
          }
          // Event drawer is overlay-kind — DO NOT mutate session.current_route
          // (the user stays on the underlying page; only a drawer opens).
          // Set pendingNavigation so the turn_complete handler is informed.
          session.pendingNavigation = {
            screen_id: directive.screen_id,
            route: directive.route,
            title: directive.title,
            reason: directive.reason,
            decision_source: 'direct',
            requested_at: Date.now(),
          };
          session.navigationDispatched = true;
          session.pendingNavigation = undefined;
        }
        return {
          success: true,
          result: typeof r.text === 'string' ? r.text : '',
        };
      }

      case 'search_community': {
        // PR B-8 lifted the search; PR 1.B-7 added auto-nav to COMM.GROUP_DETAIL
        // when the result is unambiguous. Switch from dispatchOrbToolForVertex
        // to dispatchOrbTool so the structured `result.directive` is readable
        // and Vertex can emit it via SSE/WS + set session.pendingNavigation
        // + eagerly update session.current_route.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: true, result: 'Community search is temporarily unavailable.' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbTool } = await import('../services/orb-tools-shared');
        const r = await dispatchOrbTool(
          'search_community',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
            session_id: session.sessionId,
          },
          supabase,
        );
        if (r.ok === false) {
          return { success: false, result: '', error: r.error };
        }
        const result = (r.result ?? {}) as {
          groups?: unknown[];
          decision?: string;
          directive?: {
            type: string;
            directive: string;
            screen_id: string;
            route: string;
            title: string;
            reason: string;
            vtid: string;
          };
        };
        if (result.decision === 'auto_nav' && result.directive) {
          const directive = result.directive;
          const directiveJson = JSON.stringify(directive);
          if (session.sseResponse) {
            try { session.sseResponse.write(`data: ${directiveJson}\n\n`); } catch (_e) { /* SSE closed */ }
          }
          if ((session as unknown as { clientWs?: { readyState: number } }).clientWs &&
              (session as unknown as { clientWs?: { readyState: number } }).clientWs!.readyState === 1) {
            try { sendWsMessage((session as unknown as { clientWs: unknown }).clientWs as Parameters<typeof sendWsMessage>[0], directive); } catch (_e) { /* WS closed */ }
          }
          session.pendingNavigation = {
            screen_id: directive.screen_id,
            route: directive.route,
            title: directive.title,
            reason: directive.reason,
            decision_source: 'direct',
            requested_at: Date.now(),
          };
          session.navigationDispatched = true;
          session.pendingNavigation = undefined;
          const previousRoute = session.current_route;
          session.current_route = directive.route;
          if (previousRoute && previousRoute !== directive.route) {
            const trail = Array.isArray(session.recent_routes) ? [...session.recent_routes] : [];
            const deduped = trail.filter((rt) => rt !== previousRoute);
            session.recent_routes = [previousRoute, ...deduped].slice(0, 5);
          }
        }
        return {
          success: true,
          result: typeof r.text === 'string' ? r.text : '',
        };
      }

      // VTID-02754 — Find ONE community member by free-text query and redirect
      // to their profile. Calls findCommunityMember() directly via dynamic
      // import (rather than an internal HTTP roundtrip) because session.access_token
      // is never populated on the WebSocket session, so a self-call would 401.
      // Persists to community_search_history with the admin client and queues
      // the navigation directive so the widget redirects on turn_complete.
      case 'find_community_member': {
        // PR 1.B-1: lifted to services/orb-tools-shared.ts. Both pipelines
        // run identical ranker + history persistence + redirect-route
        // construction. Vertex still emits the redirect via
        // session.pendingNavigation + updates session.current_route +
        // session.recent_routes (transport-specific session-state mutation
        // that doesn't generalise to LiveKit). LiveKit's tool wrapper picks
        // up the same `directive` payload from result.directive and
        // publishes it on the room data channel via _dispatch_with_directive.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'supabase_not_configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { dispatchOrbTool } = await import('../services/orb-tools-shared');

        const r = await dispatchOrbTool(
          'find_community_member',
          args ?? {},
          {
            user_id: session.identity?.user_id ?? '',
            tenant_id: session.identity?.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );

        if (r.ok === false) {
          if (r.error === 'auth_required') {
            return { success: false, result: '', error: 'Please sign in to search the community.' };
          }
          if (r.error === 'query_too_short') {
            return { success: false, result: '', error: 'query is required' };
          }
          return { success: false, result: '', error: r.error };
        }

        const result = (r.result ?? {}) as {
          vitana_id?: string;
          display_name?: string;
          search_id?: string;
          directive?: { route?: string; title?: string };
        };
        const directive = result.directive;
        const route = directive?.route || '';
        const displayName = result.display_name || 'their profile';

        // Vertex-side WebSocket session-state mutation (Vertex-specific). This
        // is what pendingNavigation hands to the SSE/WS dispatcher and what
        // future get_current_screen calls read from.
        if (route) {
          session.pendingNavigation = {
            screen_id: 'profile_with_match',
            route,
            title: directive?.title || `Profile: ${displayName}`,
            reason: 'find_community_member tool call',
            decision_source: 'direct',
            requested_at: Date.now(),
          };
          session.navigationDispatched = true;

          const previousRoute = session.current_route;
          session.current_route = route;
          if (previousRoute && previousRoute !== route) {
            const trail = Array.isArray(session.recent_routes) ? [...session.recent_routes] : [];
            const deduped = trail.filter((rt) => rt !== previousRoute);
            session.recent_routes = [previousRoute, ...deduped].slice(0, 5);
          }
        }

        // Voice cue. The "stop speaking" tail is Vertex-specific (the
        // WebSocket widget is about to close); the underlying voice_summary
        // lives in r.text and is what LiveKit speaks.
        const voiceSummary = typeof r.text === 'string' && r.text.length > 0 ? r.text : `Bringing up ${displayName}'s profile.`;
        return {
          success: true,
          result: `${voiceSummary} The user is now being taken to ${displayName}'s profile. The widget is closing — stop speaking immediately after this line.`,
        };
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
        // PR D-4: lifted to services/orb-tools-shared.ts. The shared module
        // does executeCapability + voice-text + timeline writeback. Vertex
        // also emits the SSE/WS directive (the orb widget uses it to open
        // the URL in the native music app on iOS/Android). LiveKit doesn't
        // have SSE/WS so it just gets the URL in result.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Music capability unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbTool } = await import('../services/orb-tools-shared');

        const r = await dispatchOrbTool(
          'play_music',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
          },
          supabase,
        );

        if (r.ok === false) {
          return { success: false, result: '', error: r.error };
        }

        // Pick the directive out of the structured result and emit via
        // SSE/WS so the orb widget can open the URL natively.
        const result = (r.result ?? {}) as { directive?: Record<string, unknown> };
        const directive = result.directive;
        if (directive) {
          try { session.sseResponse?.write(`data: ${JSON.stringify(directive)}\n\n`); } catch (_e) { /* SSE closed */ }
          const ws = (session as unknown as { clientWs?: { readyState: number } }).clientWs;
          if (ws && ws.readyState === 1) {
            try {
              sendWsMessage(ws as unknown as Parameters<typeof sendWsMessage>[0], directive);
            } catch (_e) { /* WS closed */ }
          }
        }

        const text = typeof r.text === 'string' && r.text.length > 0 ? r.text : JSON.stringify(r.result ?? {});
        return { success: true, result: text };
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
        // VTID-02963: thread session.sessionId through identity so the
        // shared tool can scope its rate-limit key per real voice session
        // (the lift originally dropped it and used a synthetic per-user
        // key, breaking per-conversation isolation).
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
            session_id: session.sessionId ?? null,
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
        // VTID-02975: lifted to services/orb-tools-shared.ts. The shared
        // handler verifies ownership, flips new→activated only if needed,
        // emits guide.initiative.executed telemetry, and returns a result
        // with title + already_active for the celebratory close. Reachable
        // identically via /api/v1/orb/tool now that it's in ORB_TOOL_REGISTRY.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'Service unavailable — Supabase creds not configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
        const { dispatchOrbToolForVertex } = await import('../services/orb-tools-shared');
        return await dispatchOrbToolForVertex(
          'activate_recommendation',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
            session_id: session.sessionId ?? null,
          },
          supabase,
        );
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
          const { runMatchmakerAsync } = await import('../services/matchmaker-agent');
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

          // VTID-02806g — Fire-and-forget cover-photo resolution. The form
          // composer (POST /api/v1/intents) does this on every insert;
          // the voice path was missing it, so every dictated intent ended
          // up with cover_url=NULL and the frontend fell back to a static
          // themed JPG that looked AI-generated. Now the resolution chain
          // runs (library exact-category → universal → gender-aware AI →
          // curated) so a user with a universal photo or a category-tagged
          // library entry sees their own photo on dictated posts.
          import('../services/intent-cover-service')
            .then(({ generateCoverForIntent, themeFromCategory }) =>
              generateCoverForIntent({
                intentId,
                userId: session.identity!.user_id,
                theme: themeFromCategory(extract.category),
              }),
            )
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : 'unknown';
              console.warn(
                `[cover] voice-post auto-gen failed for ${intentId}: ${msg}`,
              );
            });

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

          // VTID-02832: kick the async matchmaker agent so the row exists in
          // intent_match_recommendations by the time Gemini polls
          // get_matchmaker_result (~3s later). Without this kick the poll
          // returns status='not_started' — a status the tool description
          // doesn't enumerate, so Gemini freelances and apologizes ("I had a
          // problem making the post") even though the post is live. Mirrors
          // intents.ts:370 (REST POST path).
          try {
            runMatchmakerAsync(intentId);
          } catch (err: any) {
            console.warn(`[VTID-02832] matchmaker async kick failed (non-fatal): ${err?.message}`);
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
        // PR 1.B-6: lifted to services/orb-tools-shared.ts. Both pipelines run
        // the same surfaceTopMatches + redactMatchForReader path. Auto-nav
        // to INTENTS.MATCH_DETAIL when the top score dominates the runner-up
        // (gap >= 0.15); otherwise list-only and let the LLM disambiguate.
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
          return { success: false, result: '', error: 'supabase_not_configured' };
        }
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { dispatchOrbTool } = await import('../services/orb-tools-shared');
        const r = await dispatchOrbTool(
          'view_intent_matches',
          args ?? {},
          {
            user_id: lens.user_id,
            tenant_id: lens.tenant_id ?? null,
            role: session.identity?.role ?? null,
            vitana_id: session.identity?.vitana_id ?? null,
            session_id: session.sessionId,
          },
          supabase,
        );
        if (r.ok === false) {
          return { success: false, result: '', error: r.error };
        }
        const result = (r.result ?? {}) as {
          matches?: unknown[];
          decision?: string;
          directive?: {
            type: string;
            directive: string;
            screen_id: string;
            route: string;
            title: string;
            reason: string;
            vtid: string;
          };
        };
        // Auto-nav: emit directive via SSE/WS + set session.pendingNavigation
        // + eagerly update current_route so the next get_current_screen sees
        // the fresh route.
        if (result.decision === 'auto_nav' && result.directive) {
          const directive = result.directive;
          const directiveJson = JSON.stringify(directive);
          if (session.sseResponse) {
            try { session.sseResponse.write(`data: ${directiveJson}\n\n`); } catch (_e) { /* SSE closed */ }
          }
          if ((session as unknown as { clientWs?: { readyState: number } }).clientWs &&
              (session as unknown as { clientWs?: { readyState: number } }).clientWs!.readyState === 1) {
            try { sendWsMessage((session as unknown as { clientWs: unknown }).clientWs as Parameters<typeof sendWsMessage>[0], directive); } catch (_e) { /* WS closed */ }
          }
          session.pendingNavigation = {
            screen_id: directive.screen_id,
            route: directive.route,
            title: directive.title,
            reason: directive.reason,
            decision_source: 'direct',
            requested_at: Date.now(),
          };
          session.navigationDispatched = true;
          session.pendingNavigation = undefined;
          const previousRoute = session.current_route;
          session.current_route = directive.route;
          if (previousRoute && previousRoute !== directive.route) {
            const trail = Array.isArray(session.recent_routes) ? [...session.recent_routes] : [];
            const deduped = trail.filter((rt) => rt !== previousRoute);
            session.recent_routes = [previousRoute, ...deduped].slice(0, 5);
          }
        }
        // Vertex's prior contract: result is JSON-stringified body. Preserve.
        const responseBody = { ok: true, matches: result.matches ?? [] };
        return {
          success: true,
          result: typeof r.text === 'string' && r.text.length > 0 && result.decision === 'auto_nav'
            ? r.text
            : JSON.stringify(responseBody),
        };
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
      // VTID-02861 (2026-05-07): query intent_match_recommendations directly via
      // service-role Supabase. The previous self-HTTP call to /api/v1/intents/:id/matchmaker
      // always 401'd because session.access_token is never populated on the WebSocket
      // session (same root cause as VTID-02754 for find_community_member). The 401 made
      // this tool return success:false right after a successful post_intent, and Gemini
      // misattributed that to the post itself — apologizing "I had a problem making the
      // post" while the row was already in user_intents. Now we always return success:true
      // with the polished status inside the result; the voice tool description already
      // tells the model how to react to status:'error' / status:'not_started'.
      case 'get_matchmaker_result': {
        const intentId = String(args.intent_id || '').trim();
        if (!intentId) {
          return {
            success: true,
            result: JSON.stringify({ ok: false, status: 'error', error: 'intent_id is required' }),
          };
        }

        try {
          const SUPABASE_URL = process.env.SUPABASE_URL;
          const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
          if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
            return {
              success: true,
              result: JSON.stringify({ ok: false, status: 'error', error: 'supabase_unavailable' }),
            };
          }
          const { createClient } = await import('@supabase/supabase-js');
          const adminSb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
            auth: { autoRefreshToken: false, persistSession: false },
          });

          // Visibility gate: requester owns the intent OR intent is public.
          const { data: src } = await adminSb
            .from('user_intents')
            .select('intent_id, requester_user_id, visibility')
            .eq('intent_id', intentId)
            .maybeSingle();
          if (!src) {
            return {
              success: true,
              result: JSON.stringify({ ok: false, status: 'error', error: 'intent_not_found' }),
            };
          }
          const isOwner = (src as any).requester_user_id === session.identity?.user_id;
          const visibility = String((src as any).visibility || 'public');
          if (!isOwner && visibility !== 'public') {
            return {
              success: true,
              result: JSON.stringify({ ok: false, status: 'error', error: 'forbidden' }),
            };
          }

          const { data: rec } = await adminSb
            .from('intent_match_recommendations')
            .select('intent_id, status, mode, pool_size, candidates, counter_questions, voice_readback, reasoning_summary, used_fallback, model, latency_ms, error, computed_at, updated_at')
            .eq('intent_id', intentId)
            .maybeSingle();

          if (!rec) {
            return {
              success: true,
              result: JSON.stringify({ ok: true, status: 'not_started', poll_again_ms: 2000 }),
            };
          }

          const status = String((rec as any).status);
          return {
            success: true,
            result: JSON.stringify({
              ok: true,
              status,
              mode: (rec as any).mode,
              pool_size: (rec as any).pool_size,
              candidates: (rec as any).candidates ?? [],
              counter_questions: (rec as any).counter_questions ?? [],
              voice_readback: (rec as any).voice_readback,
              reasoning_summary: (rec as any).reasoning_summary,
              used_fallback: (rec as any).used_fallback,
              model: (rec as any).model,
              latency_ms: (rec as any).latency_ms,
              error: (rec as any).error,
              computed_at: (rec as any).computed_at,
              poll_again_ms: status === 'pending' || status === 'running' ? 3000 : null,
            }),
          };
        } catch (err: any) {
          console.error('[VTID-DANCE-D12] get_matchmaker_result error:', err?.message);
          return {
            success: true,
            result: JSON.stringify({ ok: false, status: 'error', error: err?.message || 'unknown' }),
          };
        }
      }

      // VTID-02830 — Find Perfect flagships (lifted to shared dispatcher)
      case 'find_perfect_product':
      case 'find_perfect_practitioner': {
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
// A3 (orb-live-refactor): exported so the lifted buildLiveSystemInstruction
// in orb/live/instruction/live-system-instruction.ts can call it. Same
// behavior; only module-level visibility changes.
export function buildNavigatorPolicySection(lang: string): string {
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
export function formatClientContextForInstruction(ctx: ClientContext): string {
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

  // L1 (VTID-02976): consult the upstream provider selector. The selector
  // is a pure function — it never reads env / DB / OASIS. We gather inputs
  // here, hand them in, and emit OASIS based on the returned decision.
  // L1 always pins to Vertex; the decision tells operators what *would*
  // happen once L2 lifts the pin.
  let __upstreamDecision: UpstreamSelectionDecision;
  try {
    const __voiceCfg = await getVoiceConfig();
    __upstreamDecision = selectUpstreamProvider({
      envProviderOverride: process.env.ORB_LIVE_PROVIDER,
      systemConfigActiveProvider: __voiceCfg.active_provider,
      livekitCredentials: {
        url: process.env.LIVEKIT_URL,
        apiKey: process.env.LIVEKIT_API_KEY,
        apiSecret: process.env.LIVEKIT_API_SECRET,
      },
    });
  } catch (e) {
    // Voice config read failure must NOT block the session start; default
    // to Vertex so production behavior matches today.
    console.warn(`[VTID-02976] voice-config read failed; falling back to vertex defaults: ${(e as Error).message}`);
    __upstreamDecision = {
      provider: 'vertex',
      requested: null,
      reason: 'default',
      livekitReady: false,
    };
  }
  console.log(
    `[VTID-02976] upstream provider selected: provider=${__upstreamDecision.provider}` +
      ` requested=${__upstreamDecision.requested ?? 'none'}` +
      ` reason=${__upstreamDecision.reason}` +
      ` livekit_ready=${__upstreamDecision.livekitReady}`,
  );
  // OASIS emission — every connect call emits a single `selected` event.
  // When the request was LiveKit but the path degraded (config invalid or
  // pinned_to_vertex_l1), also emit a `selection_error` event with the
  // typed error string so the Improve cockpit can surface it.
  void emitOasisEvent({
    type: 'orb.upstream.provider.selected',
    vtid: 'VTID-02976',
    payload: {
      session_id: session.sessionId,
      provider: __upstreamDecision.provider,
      requested: __upstreamDecision.requested,
      reason: __upstreamDecision.reason,
      livekit_ready: __upstreamDecision.livekitReady,
    } as any,
  } as any).catch(() => { /* best-effort */ });
  if (__upstreamDecision.error) {
    void emitOasisEvent({
      type: 'orb.upstream.provider.selection_error',
      vtid: 'VTID-02976',
      payload: {
        session_id: session.sessionId,
        provider: __upstreamDecision.provider,
        requested: __upstreamDecision.requested,
        reason: __upstreamDecision.reason,
        livekit_ready: __upstreamDecision.livekitReady,
        error: __upstreamDecision.error,
      } as any,
    } as any).catch(() => { /* best-effort */ });
  }

  // A8.3b.2 (VTID-02972): the legacy raw-WebSocket scaffolding is gone.
  // `VertexLiveClient.connect()` owns the access-token fetch, the WSS URL
  // construction, the headers attach, and the open-handshake. We only need
  // to log what we're about to ask it to do.
  console.log(`[VTID-01219] Using model: ${VERTEX_LIVE_MODEL}`);
  console.log(`[VTID-01219] Project: ${VERTEX_PROJECT_ID}, Location: ${VERTEX_LOCATION}`);

  // A8.3b.1 (VTID-02971): the WS lifecycle now flows through the A7
  // UpstreamLiveClient boundary via VertexLiveClient. The orb-specific
  // persona/tools/context envelope is supplied via `customSetupMessage`
  // so the wire payload remains byte-for-byte identical to the pre-A8.3b.1
  // path. Error/close handlers continue to register on the raw socket
  // returned by `vertex.getSocket()`, preserving the transparent-reconnect
  // path and all VTID-02637 connection-issue dedupe behavior.
  return new Promise<WebSocket>(async (resolve, reject) => {
    const vertex = new VertexLiveClient();

    let setupComplete = false;
    const connectionTimeout = setTimeout(() => {
      if (!setupComplete) {
        console.error(`[VTID-01219] Live API connection timeout for session ${session.sessionId}`);
        vertex.close().catch(() => { /* swallow */ });
        reject(new Error('Live API connection timeout'));
      }
    }, 15000); // 15 second timeout

    // Build the orb-specific Vertex setup envelope. Identical body to the
    // pre-A8.3b.1 ws.on('open') handler — returns the {setup: {...}}
    // envelope object instead of calling ws.send() directly.
    // VertexLiveClient awaits this builder and sends the envelope inside
    // its own ws.on('open'), then resolves connect() when setup_complete
    // arrives.
    const buildOrbVertexSetupEnvelope = async (): Promise<Record<string, unknown>> => {
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
      console.log(`[VTID-01219] Setup envelope built for session ${session.sessionId} — VertexLiveClient will send`);
      return setupMessage as unknown as Record<string, unknown>;
    };

    // A8.3b.1 (VTID-02971): open the upstream connection through the A7
    // UpstreamLiveClient boundary. `vertex.connect()` performs the auth
    // header attach, the ws.on('open') handshake, awaits our custom
    // envelope builder, sends the envelope, and resolves on setup_complete.
    // After it resolves, the raw ws is available via `vertex.getSocket()`
    // so the legacy message + error + close handlers attach as before.
    let ws: WebSocket;
    try {
      await vertex.connect({
        model: VERTEX_LIVE_MODEL,
        projectId: VERTEX_PROJECT_ID,
        location: VERTEX_LOCATION,
        // The next four fields are overridden by `customSetupMessage`.
        // VertexLiveClient's default `buildSetupMessage` is not used.
        voiceName: 'overridden',
        responseModalities: session.responseModalities.includes('audio') ? ['audio'] : ['text'],
        vadSilenceMs: session.vadSilenceMs,
        systemInstruction: 'overridden',
        // A8.3b.2: VertexLiveClient.connect() invokes this directly.
        getAccessToken,
        connectTimeoutMs: 15000,
        customSetupMessage: buildOrbVertexSetupEnvelope,
      });
    } catch (err) {
      clearTimeout(connectionTimeout);
      reject(err as Error);
      return;
    }

    // setup_complete arrived → connect() resolved. Mark the legacy flag
    // (preserves any code-path that reads `setupComplete`) and clear the
    // outer connection timeout. The connect Promise is the source of
    // truth from here on.
    setupComplete = true;
    clearTimeout(connectionTimeout);

    const socket = vertex.getSocket();
    if (!socket) {
      reject(new Error('VertexLiveClient.getSocket() returned null after connect()'));
      return;
    }
    ws = socket;

    // A8.3a.2 (VTID-02968): the upstream message handler lives in
    // orb/live/session/upstream-message-handler.ts. After A8.3b.1 the
    // setup_complete branch inside it is unreachable (VertexLiveClient
    // consumed that frame), but the handler still owns every
    // post-setup dispatch (audio, transcripts, tool calls, turn-complete,
    // interrupted, ANON-NUDGE, identity intercept, NAV directive, chat
    // bridge — see the handler file for the full list).
    const handleUpstreamLiveMessage = createUpstreamLiveMessageHandler({
      session,
      ws,
      callbacks: { onAudioResponse, onTextResponse, onError, onTurnComplete, onInterrupted },
      // setup_complete is consumed by VertexLiveClient now; this hook is a
      // no-op for the Vertex path but stays wired so the handler keeps
      // working unchanged if a future provider needs caller-side
      // handshake plumbing.
      onSetupComplete: () => {
        /* no-op: VertexLiveClient already resolved connect() */
      },
      isSetupComplete: () => setupComplete,
      deps: {
        clearResponseWatchdog,
        detectAuthIntent,
        emitDiag,
        emitLiveSessionEvent,
        executeLiveApiTool,
        isDevSandbox,
        sendAudioToLiveAPI,
        sendFunctionResponseToLiveAPI,
        sendWsMessage,
        startResponseWatchdog,
      },
    });

    // A8.3a.1: register the named handler.
    ws.on('message', handleUpstreamLiveMessage);

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

    // A8.3b.1: resolve the outer Promise — connect() already settled when
    // setup_complete arrived, and the message/error/close handlers are
    // wired up. Legacy consumers expect Promise<WebSocket>.
    resolve(ws);
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
// A2 (orb-live-refactor): MAX_RECONNECTS lifted to orb/live/config.ts.
import { MAX_RECONNECTS } from '../orb/live/config';

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
export async function buildClientContext(req: Request): Promise<ClientContext> {
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
4. AFTER send_chat_message returns ok:true (VTID-02969): briefly acknowledge ("Sent to @<vid>.") AND in the SAME turn offer the next action — but ONLY from the tool result's next_actions array. Read next_actions[0].label verbatim as the suggestion. If the array is empty, briefly acknowledge and let the user lead — do NOT invent a next action from your own knowledge. Example with next_actions: "Sent to @dragan_red. Next: <next_actions[0].label>. Want me to do that?" Example with empty array: "Sent to @dragan_red." When the user accepts, call activate_recommendation with next_actions[0].id.

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

// A8.2 (VTID-02961) + A8.2.1 (VTID-02962): wire orb-live.ts locals into
// the session controller. MUST happen before any session-action handler
// fires. Function declarations are hoisted, so the references resolve at
// this module-load point even though some bodies appear later.
configureLiveSessionController({
  // A8.2
  resolveOrbIdentity,
  clearResponseWatchdog,
  sendEndOfTurn,
  // A8.2.1 (/live/session/start)
  validateOrigin,
  buildClientContext,
  normalizeLang,
  getVoiceForLang,
  getStoredLanguagePreference,
  persistLanguagePreference,
  fetchLastSessionInfo,
  fetchOnboardingCohortBlock,
  buildBootstrapContextPack,
  resolveEffectiveRole,
  terminateExistingSessionsForUser,
  emitLiveSessionEvent,
  describeTimeSince,
  // A8.2-complete (VTID-02964) — used by handleLiveStreamSend.
  sendAudioToLiveAPI,
  startResponseWatchdog,
  emitDiag,
  getGoogleAuthReady: () => !!googleAuth,
});

// A8.2: cleanupExpiredSessions body lifted to
// orb/live/session/live-session-controller.ts. The setInterval schedule
// stays here — orb-live.ts owns the cleanup timer lifecycle.
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

  // A9.2 (VTID-02958): SSE upgrade lifted to orb/live/transport/sse-handler.ts.
  // Same 4 headers + flushHeaders + ready event + 10 s data heartbeat.
  attachSseHeaders(res);

  // Track connection
  incrementConnection(clientIP);
  session.sseResponse = res;
  session.lastActivity = new Date();

  // Send ready event
  writeSseEvent(res, { type: 'ready', meta: { model: GEMINI_MODEL } });

  // VTID-HEARTBEAT-FIX: data-message heartbeat (NOT an SSE comment) so
  // client EventSource.onmessage fires and resets its watchdog.
  const heartbeat = startSseHeartbeat(res);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[ORB-LIVE] SSE connection closed for session: ${sessionId}`);
    heartbeat.clear();
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
    let systemInstruction = stateContext
      ? `${baseSystemInstruction}\n\n${stateContext}`
      : baseSystemInstruction;

    // VTID-02941 (B0b-min + B2 decision integration): append the decision-
    // contract section. Continuity is the only signal flowing through the
    // spine in this slice; future slices add more fields to
    // AssistantDecisionContext via the same renderer.
    //
    // Wall: a thrown error here MUST NOT break the prompt — the contract
    // is an enrichment layer, never required. We log and continue with the
    // unaugmented instruction (acceptance #6).
    if (identity?.tenant_id && identity?.user_id) {
      try {
        const decision = await compileAssistantDecisionContext({
          tenantId: identity.tenant_id,
          userId: identity.user_id,
        });
        const contractSection = renderDecisionContract(decision);
        if (contractSection) {
          systemInstruction = `${systemInstruction}\n\n${contractSection}`;
        }
      } catch (e) {
        console.warn(
          `[VTID-02941] decision contract render failed: ${(e as Error).message}`,
        );
      }
    }

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

    // VTID-02857: speakingRate read from system_config['tts.speaking_rate']
    const __vc = await getVoiceConfig();
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
        speakingRate: __vc.tts.speaking_rate,
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
// A8.2.1: handler body lifted to orb/live/session/live-session-controller.ts.
router.post('/live/session/start', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  await handleLiveSessionStart(req, res);
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
// A8.2-complete: handler body lifted to orb/live/session/live-session-controller.ts.
router.post('/live/session/stop', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  await handleLiveSessionStop(req, res);
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

  // A9.2 (VTID-02958): SSE upgrade lifted to orb/live/transport/sse-handler.ts.
  // Same 4 SSE headers + flushHeaders. Session-lifecycle assignment of
  // session.sseResponse stays here (A8 territory).
  attachSseHeaders(res);

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
  writeSseEvent(res, {
    type: 'ready',
    session_id: sessionId,
    live_api_connected: false, // Live API connects in parallel
    meta: {
      model: VERTEX_LIVE_MODEL,
      lang: session.lang,
      voice: LIVE_API_VOICES[session.lang] || LIVE_API_VOICES['en'] || getVoiceForLang(session.lang),
      audio_out_rate: 24000,
      audio_in_rate: 16000,
    },
  });

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

  // VTID-HEARTBEAT-FIX: 10 s data-message heartbeat (NOT an SSE comment) so
  // client EventSource.onmessage fires and resets its watchdog. A9.2 lifted
  // the implementation into orb/live/transport/sse-handler.ts; same cadence,
  // same payload shape, same auto-clear-on-write-failure behavior.
  const heartbeat = startSseHeartbeat(res);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[VTID-01155] Live stream disconnected: ${sessionId}`);
    heartbeat.clear();
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
// A8.2-complete: handler body lifted to orb/live/session/live-session-controller.ts.
router.post('/live/stream/send', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  await handleLiveStreamSend(req, res);
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
// A8.2: handler body lifted to orb/live/session/live-session-controller.ts.
router.post('/live/stream/end-turn', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  await handleLiveStreamEndTurn(req, res);
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

    // VTID-02857: speakingRate read from system_config['tts.speaking_rate']
    const __vc15315 = await getVoiceConfig();
    const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
      input: { text: text },
      voice: voiceParams,
      audioConfig: {
        audioEncoding: 'MP3' as any,  // Returns MP3 directly
        speakingRate: __vc15315.tts.speaking_rate,
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

      // VTID-02857: speakingRate read from system_config['tts.speaking_rate']
      const __vc15498 = await getVoiceConfig();
      const [ttsResponse] = await ttsClient.synthesizeSpeech({
        input: { text: replyText },
        voice: voiceParams,
        audioConfig: {
          audioEncoding: 'MP3' as any,
          speakingRate: __vc15498.tts.speaking_rate,
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
export interface WsClientSession {
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

// Track WebSocket client sessions.
// A8.1: declaration moved to orb/live/session/live-session-registry.ts;
// the `wsClientSessions` symbol used below is imported at the top of this file.

/**
 * VTID-01222: Initialize WebSocket server for ORB client connections
 * Attaches a WebSocketServer to the HTTP server for the /api/v1/orb/live/ws path
 *
 * @param server - The HTTP server instance from Express
 */
export function initializeOrbWebSocket(server: HttpServer): void {
  console.log('[VTID-01222] Initializing ORB WebSocket server...');

  // A9.1 (VTID-02957): WSS attach + connection/error dispatch lifted to
  // orb/live/transport/websocket-handler.ts. Wire protocol unchanged —
  // same mount path, same single-port attachment, same handler signature.
  mountOrbWebSocketTransport(server, {
    handleConnection: (ws, req) => handleWebSocketConnection(ws, req),
    onServerError: (err) => console.error('[VTID-01222] WebSocket server error:', err),
  });

  console.log('[VTID-01222] ORB WebSocket server initialized at /api/v1/orb/live/ws');

  // Cleanup expired WebSocket sessions every 5 minutes.
  // (Stays here for A9.1 — iterates over session-level state that
  // moves into orb/live/session/* under A8.)
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

// VTID-01222: Cleanup WebSocket session
// A8.2: body lifted to orb/live/session/live-session-controller.ts.
// cleanupWsSession is imported above and called from the same sites.

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
