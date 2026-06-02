/**
 * VTID-LIVEKIT-FOUNDATION: ORB LiveKit pipeline routes (real implementation).
 *
 * Replaces the 501/503 stubs from PR #1157 with working endpoints. The
 * pipeline is still mutually exclusive with Vertex — the active provider
 * flag in `system_config['voice.active_provider']` decides which one
 * serves real traffic, and the standby's session-mint endpoint refuses
 * with 503.
 *
 * Endpoints (now implemented):
 *
 *   GET  /api/v1/orb/active-provider           current flag + last flip metadata
 *   POST /api/v1/orb/active-provider           admin flip with 60-min cooldown + audit
 *   POST /api/v1/orb/livekit/token             mint LiveKit room JWT + embed metadata
 *   GET  /api/v1/orb/livekit/health            LiveKit-side health probe
 *   GET  /api/v1/orb/context-bootstrap         minimal-viable shared context fetcher
 *   GET  /api/v1/voice-providers               provider registry
 *   POST /api/v1/voice-providers/:id/test      per-provider reachability ping
 *   GET  /api/v1/agents/:id/voice-config       per-agent provider trio
 *   PUT  /api/v1/agents/:id/voice-config       update provider trio (validated + audited)
 *   POST /api/v1/agents/:id/voice-config/test-session
 *                                              ephemeral one-shot token bound to
 *                                              an UNSAVED proposed config
 *
 * Depends on PR #1156 (voice tables migration) being applied. Endpoints
 * that read voice_providers / agent_voice_configs degrade gracefully
 * when the migration hasn't landed (return empty result, not 500).
 *
 * Flag storage: `system_config[key='voice.active_provider'].value` is a
 * JSON string ("vertex" | "livekit"). Falls back to env var
 * VOICE_ACTIVE_PROVIDER when the row doesn't exist yet (so the dev
 * sandbox flows even before the operator writes the row).
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { AccessToken } from 'livekit-server-sdk';
import * as jose from 'jose';
import { emitOasisEvent } from '../services/oasis-event-service';
import { getSupabase } from '../lib/supabase';
// VTID-03210: single structured turn-1 wake-decision snapshot — emitted
// identically on Vertex (live-session-controller) and here on LiveKit so
// the turn-1 state machine is observable across both transports.
import { logWakeDecisionSnapshot } from '../orb/live/instruction/wake-decision-snapshot';
// VTID-03248 (R1 slice 1): single canonical spoken-first-name resolver.
import { resolveSpokenFirstName } from '../services/awareness-unified-context';
// VTID-02855: reuse Vertex's geo-IP + UA-parse + format helpers so the
// LiveKit bootstrap injects the same ENVIRONMENT CONTEXT block (city,
// country, timezone, localTime, UTC, device) that Vertex's authenticated
// system prompt has. Without this, LiveKit's LLM has no location/time
// awareness and answers "where am I?" / "what time is it?" with garbage.
// VTID-03036: reuse Vertex's buildBootstrapContextPack so the LiveKit
// prompt carries the SAME memoryContext.formatted_context + last-3 user
// turns + USER CONTEXT PROFILE (activity/routines/tenure) block Vertex
// injects via session.contextInstruction. Closes parity gaps like
// "how long have I been a member" + "what did I ask last?".
import {
  buildBootstrapContextPack,
  buildClientContext,
  formatClientContextForInstruction,
  buildPersonaBehavioralRule,
  buildSpecialistLanguageDirective,
  fetchSpecialistContextSection,
} from './orb-live';
// L2.2b.6 (VTID-03010): render the full Vertex system instruction for LiveKit.
// Until this slice, the LiveKit agent built its own ~7-section Python prompt
// while Vertex sent a ~17-section TypeScript prompt — the LLM had radically
// different rules depending on which pipeline served the session. Bootstrap
// now returns the rendered Vertex instruction verbatim under a new
// `system_instruction` field; the agent reads it directly.
import { buildLiveSystemInstruction } from '../orb/live/instruction/live-system-instruction';
// BOOTSTRAP-ORB-RCV-DOUBLEGREET: the wake-brief override sentinel. On LiveKit
// the marker is injected to STRIP the competing brain-opener sections, but —
// unlike Vertex — it is NOT paired with a "speak this verbatim" directive. The
// Python agent's session.say(user_facing_line) is the single source of truth
// for the LiveKit first turn; the LLM must stay silent until the user replies.
import { VERTEX_WAKE_BRIEF_OVERRIDE_MARKER } from '../orb/live/instruction/wake-brief-marker';
import {
  optionalAuth,
  requireAuthWithTenant,
  AuthenticatedRequest,
  SupabaseIdentity,
} from '../middleware/auth-supabase-jwt';
// L2.2a (VTID-02982): per-identity active-provider resolution + LiveKit
// Agent readiness flag. The resolver pins to Vertex unless the backend
// agent is enabled (the no-empty-room invariant).
import { resolveActiveProviderForCaller } from '../orb/live/upstream/active-provider-resolver';
import { getLiveKitCanaryConfig } from '../orb/live/upstream/livekit-canary-config';
import { getLiveKitAgentReadiness } from '../orb/live/upstream/livekit-agent-config';
// VTID-03052: wake-brief continuation wiring on the LiveKit path.
// `decideWakeBriefForSession` already runs from Vertex's session-start
// handler (live-session-controller.ts:730); this slice mirrors the call
// here so the LiveKit canary user produces the same continuation
// telemetry (wake_timeline + assistant.continuation.* OASIS events) and
// the response payload carries the structured decision for downstream
// observability. No prompt rewiring in this slice — per the B0d.4
// design rule, the spoken first words stay on their existing path until
// telemetry confirms the decision flow is healthy.
import { decideWakeBriefForSession } from '../services/wake-brief-wiring';
import { fetchLastSessionInfo, describeTimeSince } from '../services/guide/temporal-bucket';

const router = Router();

const VTID = 'VTID-LIVEKIT-FOUNDATION';

// ---------------------------------------------------------------------------
// VTID-03035: bootstrap response cache.
// ---------------------------------------------------------------------------
// The /orb/context-bootstrap handler costs 600-800ms per call (down from
// 1.3-2.0s after VTID-03030 parallelization). On a normal session that's
// 600-800ms of dead time between agent dispatch and audible greeting.
//
// In-memory LRU keyed by {user_id, agent_id, lang}, TTL 60s. The key
// design lets reconnects within the TTL hit the cache (~10ms response).
// The 60s window is short enough that stale identity_facts / memory_items
// risk is negligible — those tables change on order of minutes-to-hours.
//
// The bigger win comes from PRE-WARMING the cache: both token-mint
// endpoints (/orb/livekit/token and /agents/:id/voice-config/test-session)
// kick off a fire-and-forget cache-fill via `prewarmBootstrap()` so that
// by the time the agent's bootstrap.fetch() arrives (~1-2s later), the
// cache is populated and the response is essentially free.
//
// Cache size is bounded to 1000 entries — way more than any reasonable
// active-user count for a single Cloud Run instance.
// ---------------------------------------------------------------------------
const BOOTSTRAP_CACHE_TTL_MS = 60_000;
const BOOTSTRAP_CACHE_MAX_ENTRIES = 1000;
type BootstrapCacheEntry = { value: Record<string, unknown>; cachedAt: number };
const BOOTSTRAP_CACHE = new Map<string, BootstrapCacheEntry>();

function bootstrapCacheKey(userId: string | null, agentId: string, lang: string): string {
  return `${userId ?? 'anon'}|${agentId}|${lang}`;
}

function getCachedBootstrap(key: string): Record<string, unknown> | null {
  const entry = BOOTSTRAP_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > BOOTSTRAP_CACHE_TTL_MS) {
    BOOTSTRAP_CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedBootstrap(key: string, value: Record<string, unknown>): void {
  // Simple LRU-ish eviction: when full, drop the oldest entry by insertion order.
  if (BOOTSTRAP_CACHE.size >= BOOTSTRAP_CACHE_MAX_ENTRIES) {
    const firstKey = BOOTSTRAP_CACHE.keys().next().value;
    if (firstKey !== undefined) BOOTSTRAP_CACHE.delete(firstKey);
  }
  BOOTSTRAP_CACHE.set(key, { value, cachedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// VTID-03036: shared cross-instance cache via Supabase `bootstrap_cache` table.
// ---------------------------------------------------------------------------
// The VTID-03035 in-memory cache only hits when both the token-mint and the
// agent's bootstrap.fetch() land on the same Cloud Run gateway instance. In
// production the LB routes those requests across multiple instances, so
// real-session hit-rate stayed low and bootstrap_latency_ms stuck at ~700ms.
//
// This layer mirrors every write to a Supabase row keyed by the same string.
// On miss the handler checks Supabase before doing the full work; on hit it
// re-populates the in-memory cache so subsequent same-instance reads are
// instant.
//
// Defensive: ALL Supabase calls are wrapped in try/catch and return
// null/undefined on any error (table missing, network blip, etc.). The
// handler always falls back to the existing in-memory + full-work path —
// no behavior regression if the migration hasn't been applied yet.
// ---------------------------------------------------------------------------

async function getSharedCachedBootstrap(
  key: string,
): Promise<Record<string, unknown> | null> {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from('bootstrap_cache')
      .select('payload, expires_at')
      .eq('cache_key', key)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { payload: unknown; expires_at: string };
    return (row.payload as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

async function setSharedCachedBootstrap(
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const expiresAt = new Date(Date.now() + BOOTSTRAP_CACHE_TTL_MS).toISOString();
    await sb
      .from('bootstrap_cache')
      .upsert(
        { cache_key: key, payload: value, expires_at: expiresAt },
        { onConflict: 'cache_key' },
      );
  } catch {
    /* best-effort */
  }
}

/**
 * Fire-and-forget bootstrap pre-warm. Called from token-mint endpoints to
 * fill the cache while the LiveKit client + WebRTC handshake are still
 * in progress on the client side. By the time the agent actually requests
 * /orb/context-bootstrap, the cache hit makes it a ~10ms response.
 *
 * Self-calls the same /orb/context-bootstrap endpoint via an internal
 * fetch with a placeholder header so the handler sees a normal request.
 * If the call errors, we silently skip — the agent will then do the
 * normal uncached fetch (no behavior regression).
 */
function prewarmBootstrap(opts: {
  userJwt: string | null;
  agentId: string;
  lang: string;
  clientIp: string | null;
  baseUrl: string;
}): void {
  const headers: Record<string, string> = {
    'Accept-Language': opts.lang,
  };
  if (opts.userJwt) headers['Authorization'] = `Bearer ${opts.userJwt}`;
  if (opts.clientIp) headers['X-Real-IP'] = opts.clientIp;
  const url =
    opts.baseUrl.replace(/\/+$/, '') +
    `/api/v1/orb/context-bootstrap?agent_id=${encodeURIComponent(opts.agentId)}`;
  fetch(url, { method: 'GET', headers })
    .then(() => {
      /* fire-and-forget — cache populated by the handler */
    })
    .catch((exc: unknown) => {
      console.warn(
        `[${VTID}] prewarmBootstrap failed: ${(exc as Error).message ?? exc}`,
      );
    });
}

// Internal port — when a request hits our own Cloud Run service, it
// reaches us via the LB at port 8080 on localhost.
const SELF_BASE_URL = process.env.SELF_BASE_URL || 'http://localhost:8080';

// VTID-03014: extract the user's real client IP from the request and embed
// it in LiveKit token metadata. Without this, the orb-agent (running in
// Cloud Run us-central1) calls /orb/context-bootstrap from its OWN egress
// IP, so buildClientContext()'s geo-IP lookup returns "United States" no
// matter where the user actually is. Mirrors the precedence used by
// orb-live.ts:getClientIP — x-forwarded-for first (Cloud Run sets this
// with the real client IP), then x-real-ip, then x-appengine-user-ip,
// then req.ip as a last resort.
function getRequestClientIP(req: Request): string | null {
  const xff = req.get('x-forwarded-for');
  const xri = req.get('x-real-ip');
  const xaui = req.get('x-appengine-user-ip');
  const ip = (xff?.split(',')[0]?.trim()) || xri || xaui || req.ip || '';
  // Skip obviously-local/private addresses so the agent doesn't try to
  // geo-resolve 127.0.0.1 (which the gateway's bootstrap already filters,
  // but trimming early keeps the metadata clean).
  if (!ip || ip === 'unknown' || ip === '::1' || ip.startsWith('127.')) {
    return null;
  }
  return ip;
}
const ACTIVE_PROVIDER_KEY = 'voice.active_provider';
const FLIP_COOLDOWN_SECONDS = 60 * 60; // 1 hour anti-flap
const TEST_SESSION_TOKEN_TTL_SECONDS = 5 * 60;
const AGENT_USER_JWT_TTL_SECONDS = 60 * 60; // 1 hour, matches LiveKit token TTL

// ---------------------------------------------------------------------------
// Per-session user JWT for the orb-agent (VTID-LIVEKIT-AGENT-JWT)
//
// The orb-agent calls gateway tool endpoints on behalf of the user, but it
// does not hold the user's original JWT (we don't pass user JWTs into
// LiveKit tokens — that would put long-lived auth into a third-party
// provider's signaling layer). Instead, when minting a LiveKit room token
// for an authenticated user, we also mint a short-lived Supabase JWT
// derived from the same identity and embed it in the room metadata. The
// agent reads `metadata.user_jwt` at session start and uses it as Bearer
// for every tool call. Same secret as the user's normal JWTs (HS256 against
// SUPABASE_JWT_SECRET) so existing optionalAuth/requireAuth middleware on
// every tool endpoint validates it transparently — no new auth pattern.
//
// Anonymous sessions get null; their tools effectively no-op since most
// gateway endpoints reject unauthenticated requests anyway.
// ---------------------------------------------------------------------------
async function mintAgentSessionJwt(identity: SupabaseIdentity): Promise<string | null> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.error('[orb-livekit] cannot mint agent JWT — SUPABASE_JWT_SECRET unset');
    return null;
  }
  if (!identity.user_id) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: identity.user_id,
    aud: identity.aud || 'authenticated',
    role: identity.role || 'authenticated',
    app_metadata: {
      active_tenant_id: identity.tenant_id,
      exafy_admin: identity.exafy_admin,
      // Marker so the audit trail can distinguish agent-issued tokens from
      // human sign-ins. Optional for downstream code but cheap to include.
      issued_for: 'orb_livekit_agent',
    },
  };
  if (identity.email) payload.email = identity.email;

  const key = new TextEncoder().encode(secret);
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + AGENT_USER_JWT_TTL_SECONDS)
    .sign(key);
}

type ProviderName = 'vertex' | 'livekit';

// ---------------------------------------------------------------------------
// Active-provider flag — read/write helpers
// ---------------------------------------------------------------------------

interface ActiveProviderState {
  active_provider: ProviderName;
  last_flipped_at: string | null;
  flipped_by: string | null;
  cooldown_remaining_s: number;
}

async function readActiveProvider(): Promise<ActiveProviderState> {
  const fallback: ProviderName =
    process.env.VOICE_ACTIVE_PROVIDER === 'livekit' ? 'livekit' : 'vertex';

  const sb = getSupabase();
  if (!sb) {
    return {
      active_provider: fallback,
      last_flipped_at: null,
      flipped_by: null,
      cooldown_remaining_s: 0,
    };
  }

  // system_config table shape: { key TEXT PK, value JSONB, updated_by TEXT, updated_at TIMESTAMPTZ }
  // (see supabase/migrations/20260402000000_self_healing_tables.sql)
  const { data: cfgRow } = await sb
    .from('system_config')
    .select('value, updated_by, updated_at')
    .eq('key', ACTIVE_PROVIDER_KEY)
    .maybeSingle();

  let provider: ProviderName = fallback;
  let lastFlippedAt: string | null = null;
  let flippedBy: string | null = null;

  if (cfgRow) {
    const raw = (cfgRow as { value: unknown }).value;
    if (typeof raw === 'string' && (raw === 'vertex' || raw === 'livekit')) {
      provider = raw;
    } else if (raw && typeof raw === 'object' && 'provider' in (raw as Record<string, unknown>)) {
      const p = (raw as Record<string, unknown>).provider;
      if (p === 'vertex' || p === 'livekit') provider = p;
    }
    lastFlippedAt = (cfgRow as { updated_at: string | null }).updated_at ?? null;
    flippedBy = (cfgRow as { updated_by: string | null }).updated_by ?? null;
  }

  let cooldownRemaining = 0;
  if (lastFlippedAt) {
    const lastMs = new Date(lastFlippedAt).getTime();
    const elapsedS = (Date.now() - lastMs) / 1000;
    cooldownRemaining = Math.max(0, Math.floor(FLIP_COOLDOWN_SECONDS - elapsedS));
  }

  return {
    active_provider: provider,
    last_flipped_at: lastFlippedAt,
    flipped_by: flippedBy,
    cooldown_remaining_s: cooldownRemaining,
  };
}

async function writeActiveProvider(
  next: ProviderName,
  reason: string | null,
  changedBy: string | null,
): Promise<{ ok: boolean; error?: string; previous?: ProviderName }> {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: 'supabase client unavailable' };

  const current = await readActiveProvider();
  if (current.active_provider === next) {
    return { ok: true, previous: current.active_provider };
  }
  if (current.cooldown_remaining_s > 0) {
    return {
      ok: false,
      error: `cooldown active: ${current.cooldown_remaining_s}s remaining`,
    };
  }

  const { error: upErr } = await sb.from('system_config').upsert(
    {
      key: ACTIVE_PROVIDER_KEY,
      value: next as unknown as object,
      updated_by: changedBy ?? 'system',
    },
    { onConflict: 'key' },
  );
  if (upErr) return { ok: false, error: upErr.message };

  // Audit (best-effort — table from PR #1156 may not exist yet).
  await sb
    .from('voice_active_provider_changes')
    .insert({
      from_provider: current.active_provider,
      to_provider: next,
      reason: reason ?? 'manual',
      changed_by: changedBy,
    })
    .then(
      () => undefined,
      () => undefined,
    );

  return { ok: true, previous: current.active_provider };
}

// L2.2a (VTID-02982): `/orb/active-provider` is now per-identity canary-aware.
//
// Legacy field `active_provider` carries the EFFECTIVE provider for the
// caller — the existing frontend `useActiveVoiceProvider()` hook reads only
// that field, so this change is back-compat without any frontend edit.
//
// Hard pin: until `voice.livekit_agent_enabled` is true (the L2.2b backend
// agent isn't built yet), the resolver returns `effectiveProvider=vertex`
// for EVERY caller regardless of allowlist. No empty LiveKit rooms.
router.get(
  '/orb/active-provider',
  optionalAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const state = await readActiveProvider();
      const canary = await getLiveKitCanaryConfig();
      const agent = await getLiveKitAgentReadiness();
      const livekitCredsValid = !!(
        process.env.LIVEKIT_URL &&
        process.env.LIVEKIT_API_KEY &&
        process.env.LIVEKIT_API_SECRET
      );

      const resolution = resolveActiveProviderForCaller({
        globalActiveProvider: state.active_provider,
        canary: {
          enabled: canary.enabled,
          allowedTenants: canary.allowedTenants,
          allowedUsers: canary.allowedUsers,
        },
        livekitCredsValid,
        agentReady: agent.enabled,
        identity: req.identity
          ? {
              tenantId: req.identity.tenant_id ?? null,
              userId: req.identity.user_id ?? null,
            }
          : null,
      });

      // Emit OASIS when a canary user reaches the agent-pinned state — this
      // is the signal "we have someone we'd flip if the agent were ready."
      if (resolution.reason === 'pinned_until_agent_ready') {
        void emitOasisEvent({
          type: 'orb.upstream.active_provider.pinned_until_agent_ready',
          vtid: 'VTID-02982',
          payload: {
            tenant_id: req.identity?.tenant_id ?? null,
            user_id: req.identity?.user_id ?? null,
            requested_provider: resolution.requestedProvider,
            livekit_ready: resolution.livekitReady,
            canary_eligible: resolution.canaryEligible,
            agent_ready: resolution.agentReady,
          },
        } as never).catch(() => { /* best-effort */ });
      }

      res.json({
        ok: true,
        // Legacy fields (backwards-compatible with useActiveVoiceProvider).
        // `active_provider` now carries the per-caller effective provider.
        active_provider: resolution.effectiveProvider,
        last_flipped_at: state.last_flipped_at,
        flipped_by: state.flipped_by,
        cooldown_remaining_s: state.cooldown_remaining_s,
        // L2.2a additions — diagnostic fields for ops + Improve cockpit.
        requestedProvider: resolution.requestedProvider,
        effectiveProvider: resolution.effectiveProvider,
        livekitReady: resolution.livekitReady,
        canaryEligible: resolution.canaryEligible,
        agentReady: resolution.agentReady,
        reason: resolution.reason,
        vtid: VTID,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message, vtid: VTID });
    }
  },
);

router.post(
  '/orb/active-provider',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    const { provider, reason } = (req.body ?? {}) as {
      provider?: string;
      reason?: string;
    };
    if (provider !== 'vertex' && provider !== 'livekit') {
      return res
        .status(400)
        .json({ ok: false, error: 'provider must be vertex or livekit', vtid: VTID });
    }
    if (!req.identity?.exafy_admin) {
      return res.status(403).json({
        ok: false,
        error: 'exafy_admin role required for active-provider flip',
        vtid: VTID,
      });
    }
    const result = await writeActiveProvider(
      provider,
      reason ?? null,
      req.identity?.user_id ?? null,
    );
    if (!result.ok) {
      const status = result.error?.startsWith('cooldown') ? 429 : 500;
      return res.status(status).json({ ok: false, error: result.error, vtid: VTID });
    }
    try {
      await emitOasisEvent({
        type: 'voice.active_provider.flipped' as never,
        actor: req.identity?.user_id ?? 'system',
        payload: {
          from: result.previous,
          to: provider,
          reason: reason ?? null,
          vtid: VTID,
        },
      } as never);
    } catch {
      // never block flip on telemetry
    }
    return res.json({
      ok: true,
      from: result.previous,
      to: provider,
      vtid: VTID,
    });
  },
);

// ---------------------------------------------------------------------------
// LiveKit token mint
// ---------------------------------------------------------------------------

interface MintTokenBody {
  lang?: string;
  agent_id?: string;
  voice_style?: string;
  // PR-VTID-02853: per-session voice override from the LiveKit test page
  // dropdown. Embedded in the AccessToken metadata; the agent reads it and
  // hands to build_cascade(voice_override=…). Examples:
  //   "de-DE-Chirp3-HD-Leda"  (Chirp3-HD German persona)
  //   "Kore"                  (Gemini TTS multilingual voice)
  // Empty / absent → use language default from LANG_DEFAULTS.
  voice_override?: string;
}

router.post(
  '/orb/livekit/token',
  optionalAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const state = await readActiveProvider();
    if (state.active_provider !== 'livekit') {
      return res.status(503).json({
        ok: false,
        error: 'provider_standby',
        active_provider: state.active_provider,
        vtid: VTID,
      });
    }

    const livekitUrl = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!livekitUrl || !apiKey || !apiSecret) {
      return res.status(500).json({
        ok: false,
        error: 'livekit_misconfigured',
        detail: 'LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set',
        vtid: VTID,
      });
    }

    const body = (req.body ?? {}) as MintTokenBody;
    const lang = body.lang || 'en';
    const agentId = body.agent_id || 'vitana';
    const voiceOverride = typeof body.voice_override === 'string' && body.voice_override.trim().length > 0
      ? body.voice_override.trim()
      : null;
    const isAnonymous = !req.identity;
    const userId = req.identity?.user_id ?? `anon-${randomUUID()}`;
    const tenantId = req.identity?.tenant_id ?? '';

    // Mobile-community coercion (defense-in-depth, mirrors
    // memory/feedback_mobile_community_only.md).
    const ua = String(req.headers['user-agent'] || '').toLowerCase();
    const isMobile = /iphone|android|appilix|webview|mobile/.test(ua);
    const dbRole = req.identity?.role ?? 'community';
    const role = isMobile ? 'community' : dbRole;

    const orbSessionId = `orb-${randomUUID()}`;
    const roomName = `orb-${userId}-${Date.now()}`;

    // Mint a per-session user JWT for the orb-agent's tool calls. Anonymous
    // sessions get null (most gateway tools require auth and would reject
    // anonymous traffic anyway).
    const agentUserJwt = req.identity ? await mintAgentSessionJwt(req.identity) : null;

    // VTID-03014: capture user's real client IP at mint time so the agent
    // can forward it to /orb/context-bootstrap and geo-IP resolves the
    // actual user location, not the agent's us-central1 Cloud Run IP.
    const clientIp = getRequestClientIP(req);

    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      ttl: 60 * 60, // 1 hour session
      metadata: JSON.stringify({
        user_id: userId,
        tenant_id: tenantId,
        role,
        lang,
        is_mobile: isMobile,
        is_anonymous: isAnonymous,
        agent_id: agentId,
        orb_session_id: orbSessionId,
        vitana_id: req.identity?.vitana_id ?? null,
        voice_override: voiceOverride,
        // VTID-LIVEKIT-AGENT-JWT: the orb-agent extracts this and uses it as
        // Bearer for every gateway tool call. Same secret/shape as the
        // user's normal JWT — existing optionalAuth/requireAuth middleware
        // validates it transparently.
        user_jwt: agentUserJwt,
        // VTID-03014: forward the user's real IP through to the agent.
        client_ip: clientIp,
      }),
    });
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    // VTID-03035: pre-warm the bootstrap cache so the agent's
    // /orb/context-bootstrap call (which fires ~1-2s later, while
    // WebRTC handshake is still happening) hits the cache and returns
    // in ~10ms instead of ~600-800ms. Fire-and-forget.
    if (req.identity?.user_id && agentUserJwt) {
      prewarmBootstrap({
        userJwt: agentUserJwt,
        agentId,
        lang,
        clientIp,
        baseUrl: SELF_BASE_URL,
      });
    }

    return res.json({
      ok: true,
      url: livekitUrl,
      token,
      room: roomName,
      orb_session_id: orbSessionId,
      lang,
      vtid: VTID,
    });
  },
);

router.get('/orb/livekit/health', async (_req: Request, res: Response) => {
  const state = await readActiveProvider();
  // Probe the orb-agent /health endpoint (configured via ORB_AGENT_URL secret).
  let agentReachable = false;
  let agentBody: unknown = null;
  const agentUrl = process.env.ORB_AGENT_URL;
  if (agentUrl) {
    try {
      const r = await fetch(agentUrl.replace(/\/+$/, '') + '/health', {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        agentReachable = true;
        agentBody = await r.json();
      }
    } catch {
      agentReachable = false;
    }
  }

  res.json({
    ok: true,
    service: 'orb-livekit-routes',
    vtid: VTID,
    active_provider: state.active_provider,
    livekit: {
      url_configured: !!process.env.LIVEKIT_URL,
      api_key_configured: !!process.env.LIVEKIT_API_KEY,
    },
    agent_worker_reachable: agentReachable,
    agent_health: agentBody,
    providers: {
      anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
      openai_configured: !!process.env.OPENAI_API_KEY,
      deepgram_configured: !!process.env.DEEPGRAM_API_KEY,
      cartesia_configured: !!process.env.CARTESIA_API_KEY,
      elevenlabs_configured: !!process.env.ELEVENLABS_API_KEY,
      assemblyai_configured: !!process.env.ASSEMBLYAI_API_KEY,
    },
  });
});

// ---------------------------------------------------------------------------
// Shared context bootstrap
// ---------------------------------------------------------------------------

router.get(
  '/orb/context-bootstrap',
  optionalAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const agentId = String(req.query.agent_id ?? 'vitana');
    const isReconnect = String(req.query.is_reconnect ?? 'false') === 'true';
    const lastN = Math.min(50, Math.max(0, Number(req.query.last_n_turns ?? 0) || 0));

    const sb = getSupabase();
    const userId = req.identity?.user_id ?? null;
    const tenantId = req.identity?.tenant_id ?? null;
    const role = req.identity?.role ?? 'community';
    // VTID-03084 (Lane 2): LiveKit lang resolution priority MUST match Vertex.
    //   1. Client-supplied `?lang=...` query param (UI dropdown — most explicit).
    //   2. Stored preference in `memory_facts` (fact_key=preferred_language).
    //   3. Accept-Language header (browser default).
    //   4. 'en' fallback.
    //
    // Before this fix the route ONLY read Accept-Language, so a German user
    // who picked DE in the Test Bench dropdown would still get English
    // wake-brief lines + English system_instruction whenever the browser
    // sent en-US in the header. That's how the user got
    // "Welcome back. What would you like to pick up on?" on a ?lang=de
    // request.
    const queryLang = typeof req.query.lang === 'string' && req.query.lang
      ? String(req.query.lang).split(',')[0].split('-')[0].toLowerCase()
      : null;
    const headerLang = String(req.headers['accept-language'] || 'en')
      .split(',')[0]
      .split('-')[0]
      .toLowerCase();
    let lang = queryLang || headerLang || 'en';
    // Stored preference only fills the gap when no explicit query param.
    // (We don't override an explicit ?lang=en with a stored DE preference —
    // the user just told us what they want for this session.)
    if (!queryLang && userId && tenantId) {
      try {
        const { getCurrentFacts } = await import('../services/memory-facts-service');
        const result = await getCurrentFacts({
          tenant_id: tenantId,
          user_id: userId,
          fact_keys: ['preferred_language'],
        });
        if (result.ok && result.facts.length > 0) {
          const stored = result.facts[0].fact_value.toLowerCase();
          const nameToCode: Record<string, string> = {
            english: 'en', german: 'de', french: 'fr', spanish: 'es',
            arabic: 'ar', chinese: 'zh', russian: 'ru', serbian: 'sr',
          };
          const resolved = nameToCode[stored] || stored;
          if (['en','de','fr','es','ar','zh','ru','sr'].includes(resolved)) {
            lang = resolved;
          }
        }
      } catch {
        // Fail-open: keep header-derived lang.
      }
    }

    // VTID-03122 (Phase E): accept optional journey-trail hints from the
    // client so the LiveKit-rendered system instruction can populate the
    // current-screen + journey trail in the TEMPORAL+JOURNEY block. Older
    // callers (Test Bench) don't send these; new callers can supply them
    // to close the parity gap with Vertex without forcing any frontend
    // change today. Always optional, null-safe, capped at 10 entries.
    const currentRoute =
      typeof req.query.current_route === 'string' && req.query.current_route
        ? String(req.query.current_route)
        : null;
    const recentRoutes: string[] | null = (() => {
      const raw = req.query.recent_routes;
      if (Array.isArray(raw)) {
        return raw
          .filter((r): r is string => typeof r === 'string' && r.length > 0)
          .slice(0, 10);
      }
      if (typeof raw === 'string' && raw) {
        return raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, 10);
      }
      return null;
    })();

    // VTID-03035 + VTID-03036: two-layer cache hit short-circuit.
    //  - L1 in-memory (per Cloud Run instance) — ~0ms when hit
    //  - L2 Supabase `bootstrap_cache` (shared across instances) — ~30-80ms
    // Only the full (non-greeting-only) path is cached — greeting_only is
    // already fast (~150-300ms) and its freshness matters less. Anonymous
    // sessions skip the cache (key would collide across visitors).
    const greetingOnly = String(req.query.greeting_only ?? 'false') === 'true';
    const cacheKey = userId ? bootstrapCacheKey(userId, agentId, lang) : null;
    if (cacheKey && !greetingOnly) {
      // L1: in-memory
      const l1Cached = getCachedBootstrap(cacheKey);
      if (l1Cached) {
        return res.json({
          ...l1Cached,
          cached: true,
          cache_layer: 'l1_memory',
          cache_age_ms: Date.now() - (BOOTSTRAP_CACHE.get(cacheKey)?.cachedAt ?? Date.now()),
        });
      }
      // L2: shared Supabase (VTID-03036). Best-effort; on any error this
      // returns null and we fall through to the normal handler work.
      const l2Cached = await getSharedCachedBootstrap(cacheKey);
      if (l2Cached) {
        // Re-populate L1 so the same instance hits in-memory next time.
        setCachedBootstrap(cacheKey, l2Cached);
        return res.json({
          ...l2Cached,
          cached: true,
          cache_layer: 'l2_supabase',
        });
      }
    }

    let voiceConfig: Record<string, unknown> | null = null;
    if (sb) {
      const { data } = await sb
        .from('agent_voice_configs')
        .select('*')
        .eq('agent_id', agentId)
        .maybeSingle();
      voiceConfig = (data as Record<string, unknown> | null) ?? null;
    }
    // VTID-03127 (Phase D.4.a): fall back to the seeded
    // `voice.cascade.default` policy row when no agent-specific
    // `agent_voice_configs` row exists. Before this, the gateway
    // returned `voice_config: null` and the Python orb-agent at
    // `providers.py:54-64` silently used a literal all-Google cascade —
    // hiding any service-token / DB failure under what looked like a
    // working voice path. Now the gateway always returns a non-null
    // voice_config (DB-seeded defaults or per-agent override); the
    // Python fallback becomes unreachable and D.4.b removes the dead
    // code.
    if (!voiceConfig) {
      try {
        const { getPolicyResolver } = await import(
          '../services/decision-contract/policy-resolver'
        );
        const { POLICY_KEYS } = await import(
          '../services/decision-contract/policy-keys'
        );
        const fallback = getPolicyResolver().getValue<Record<string, unknown> | null>(
          POLICY_KEYS.VOICE_CASCADE_DEFAULT,
          { defaultValue: null },
        );
        if (fallback && typeof fallback === 'object') {
          voiceConfig = { ...fallback, _source: 'voice.cascade.default' };
        }
      } catch (exc) {
        console.warn(
          `[VTID-03127] voice.cascade.default resolver fetch failed (non-fatal — agent will still fall back to its own literal): ${(exc as Error).message}`,
        );
      }
    }

    // VTID-03017: greeting-critical fast path. When the agent calls with
    // ?greeting_only=true, return ONLY the fields needed to build the cascade
    // and emit a deterministic templated greeting:
    //   - voice_config        (per-agent STT/LLM/TTS row)
    //   - first_name          (preferred address — from app_users.display_name,
    //                          falling back to memory_facts.user_name)
    //   - display_name        (full name for fallback)
    //   - vitana_id           (handle, as a fallback greeting form)
    //   - active_role         (so the placeholder prompt knows the role)
    //   - lang                (echo back for the agent)
    // Skips the slow work: memory_items, identity_facts compile, life_compass,
    // bootstrap_context render, decision_context compile, system_instruction
    // render. The agent runs this in the click→greeting path and runs the full
    // /orb/context-bootstrap (without the flag) as a background task to
    // hydrate the system instruction for subsequent turns.
    if (greetingOnly) {
      let goDisplayName: string | null = null;
      if (sb && userId) {
        // VTID-03030: run both lookups concurrently. Total cost drops from
        // ~100-200ms (sequential) to ~50-100ms (parallel) since neither
        // depends on the other and we only use the user_name fallback
        // when display_name is null.
        const [appData, factData] = await Promise.all([
          (async () => {
            try {
              const r = await sb
                .from('app_users')
                .select('display_name')
                .eq('user_id', userId)
                .maybeSingle();
              return r.data as Record<string, unknown> | null;
            } catch {
              return null;
            }
          })(),
          (async () => {
            try {
              const r = await sb
                .from('memory_facts')
                .select('fact_value')
                .eq('user_id', userId)
                .eq('fact_key', 'user_name')
                .order('updated_at', { ascending: false })
                .limit(1)
                .maybeSingle();
              return r.data as Record<string, unknown> | null;
            } catch {
              return null;
            }
          })(),
        ]);
        goDisplayName = (appData?.display_name as string | null) ?? null;
        if (!goDisplayName) {
          const userName = factData?.fact_value as string | undefined;
          if (userName) goDisplayName = userName;
        }
      }
      const goFirstName = goDisplayName ? goDisplayName.split(/\s+/)[0] : null;
      return res.json({
        // Greeting-critical fields (populated)
        voice_config: voiceConfig,
        active_role: role,
        vitana_id: req.identity?.vitana_id ?? null,
        display_name: goDisplayName,
        first_name: goFirstName,
        // Echoed back so the agent has lang in one place
        lang,
        greeting_only: true,
        // Slow-context fields (left empty — agent will get them from a
        // second non-greeting-only call)
        bootstrap_context: '',
        system_instruction: null,
        identity_facts: [],
        identity_facts_count: 0,
        memory_items: [],
        life_compass: null,
        decision_context: null,
        conversation_summary: null,
        last_turns: null,
        last_session_info: null,
        current_route: null,
        recent_routes: [],
        client_context: { user_agent: req.headers['user-agent'] ?? null },
      });
    }

    // VTID-LIVEKIT-BOOTSTRAP-IDENTITY: enrich the bootstrap context with the
    // user's identity facts so the agent's system prompt can answer "do you
    // know who I am?" correctly. Vertex's full system instruction builder
    // (orb-live.ts:7653) wires 23 awareness signals; until that builder is
    // hoisted into a shared module (planned PR 2b), inject the highest-
    // impact identity-core facts here.
    const memoryItems: Array<{ id: string; text: string }> = [];
    let displayName: string | null = null;
    let registrationSeq: number | null = null;
    let identityFacts: Array<{ fact_key: string; fact_value: string; entity: string }> = [];
    let indexSnapshot: {
      total: number;
      tier: string;
      pillars: Record<string, number>;
      weakest: string | null;
    } | null = null;
    // L2.2b.6 (VTID-03010): fetch the user's Life Compass row (goal + why +
    // target_date) and inline it into bootstrap_context so the Vertex prompt
    // renderer's [HEALTH] / activity-awareness blocks have ground truth for
    // "what am I working toward?" questions without requiring a tool call.
    // VTID-03022: corrected shape — life_compass actually has primary_goal +
    // category + is_active + created_at, not goal/why/target_date.
    let lifeCompass: {
      goal: string | null;
      category: string | null;
    } | null = null;

    // VTID-03030: parallel batch. The 5 user-scoped row lookups +
    // buildClientContext (geo-IP) are all independent and were previously
    // serialized at ~600-1000ms total. Running them concurrently brings
    // total cost down to the slowest single round-trip (~150-300ms).
    //
    // buildClientContext is moved INTO this batch from below so its
    // geo-IP lookup overlaps with the DB queries instead of running after.
    //
    // Each promise has its own .catch fallback so a single failure doesn't
    // reject the batch (matches the prior best-effort try/catch behavior).
    const IDENTITY_CORE_KEYS = [
      'user_name', 'user_birthday', 'user_residence', 'user_hometown',
      'user_company', 'user_occupation', 'user_email',
      'spouse_name', 'fiancee_name', 'mother_name', 'father_name',
      'fiancee_birthday',
      'user_health_condition', 'user_medication', 'user_allergy',
      'preferred_language',
    ];

    let envContext: import('./orb-live').ClientContext | null = null;
    // VTID-03036: result of buildBootstrapContextPack (memory preamble +
    // last-3 user turns + USER CONTEXT PROFILE). Held outside the batch
    // closure so the post-batch ctxParts push can read it.
    let historyContextPack: Awaited<ReturnType<typeof buildBootstrapContextPack>> | null = null;

    if (sb && userId) {
      const [
        memoryItemsData,
        appUsersData,
        memoryFactsData,
        indexData,
        lifeCompassData,
        envContextResolved,
        historyContextPackResolved,
      ] = await Promise.all([
        // memory_items top-5
        (async () => {
          try {
            const r = await sb
              .from('memory_items')
              .select('id, content')
              .eq('user_id', userId)
              .order('created_at', { ascending: false })
              .limit(5);
            return (r.data as Array<Record<string, unknown>> | null) ?? [];
          } catch {
            return [] as Array<Record<string, unknown>>;
          }
        })(),
        // app_users — display_name + registration_seq
        (async () => {
          try {
            const r = await sb
              .from('app_users')
              .select('display_name, registration_seq')
              .eq('user_id', userId)
              .maybeSingle();
            return r.data as Record<string, unknown> | null;
          } catch {
            return null;
          }
        })(),
        // memory_facts — identity-core keys
        (async () => {
          try {
            const r = await sb
              .from('memory_facts')
              .select('fact_key, fact_value, entity')
              .eq('user_id', userId)
              .in('fact_key', IDENTITY_CORE_KEYS)
              .is('superseded_by', null)
              .order('provenance_confidence', { ascending: false })
              .limit(40);
            return (
              (r.data as Array<{ fact_key: string; fact_value: string; entity: string }> | null) ??
              []
            );
          } catch {
            return [] as Array<{ fact_key: string; fact_value: string; entity: string }>;
          }
        })(),
        // Latest Vitana Index snapshot
        (async () => {
          try {
            const r = await sb
              .from('vitana_index_scores')
              .select(
                'date, score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental',
              )
              .eq('user_id', userId)
              .order('date', { ascending: false })
              .limit(1)
              .maybeSingle();
            return r.data as Record<string, number | string | null> | null;
          } catch {
            return null;
          }
        })(),
        // Life Compass row
        (async () => {
          try {
            const r = await sb
              .from('life_compass')
              .select('id, primary_goal, category, is_active, created_at')
              .eq('user_id', userId)
              .eq('is_active', true)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            return r.data as { primary_goal: string | null; category: string | null } | null;
          } catch {
            return null;
          }
        })(),
        // VTID-02855: ENVIRONMENT CONTEXT — geo-IP/UA/local time. Moved
        // into the parallel batch so its lookup overlaps with DB queries
        // instead of running after, saving another ~100-300ms.
        (async () => {
          try {
            return await buildClientContext(req);
          } catch (exc) {
            console.warn(
              `[${VTID}] buildClientContext failed: ${(exc as Error).message}`,
            );
            return null as import('./orb-live').ClientContext | null;
          }
        })(),
        // VTID-03036: history-aware context pack (memory preamble + last-3
        // user turns + USER CONTEXT PROFILE). Reuses Vertex's exported
        // buildBootstrapContextPack so both pipelines compose the same
        // contextInstruction layer. Best-effort; any throw is swallowed
        // and the LiveKit bootstrap falls back to the prior (thinner)
        // identity-only context.
        (async () => {
          try {
            if (!req.identity) return null;
            const sessionId = `livekit-bootstrap-${agentId}-${userId.slice(0, 8)}`;
            return await buildBootstrapContextPack(req.identity, sessionId);
          } catch (exc) {
            console.warn(
              `[${VTID}] buildBootstrapContextPack failed: ${(exc as Error).message}`,
            );
            return null;
          }
        })(),
      ]);

      // Memory items → flat objects (filter empty content).
      for (const it of memoryItemsData) {
        const text = String(it.content ?? '').trim();
        if (text) {
          memoryItems.push({ id: String(it.id ?? ''), text });
        }
      }

      // app_users
      if (appUsersData) {
        displayName = (appUsersData as { display_name?: string | null }).display_name ?? null;
        registrationSeq =
          (appUsersData as { registration_seq?: number | null }).registration_seq ?? null;
      }

      // memory_facts
      identityFacts = memoryFactsData;

      // Vitana Index — derive tier + weakest pillar from the row.
      if (indexData) {
        const row = indexData;
        const pillars: Record<string, number> = {
          nutrition: Number(row.score_nutrition ?? 0),
          hydration: Number(row.score_hydration ?? 0),
          exercise: Number(row.score_exercise ?? 0),
          sleep: Number(row.score_sleep ?? 0),
          mental: Number(row.score_mental ?? 0),
        };
        let weakestKey: string | null = null;
        let weakestVal = Number.POSITIVE_INFINITY;
        for (const [k, v] of Object.entries(pillars)) {
          if (v < weakestVal) {
            weakestVal = v;
            weakestKey = k;
          }
        }
        const total = Number(row.score_total ?? 0);
        const tier =
          total >= 800 ? 'Elite' :
          total >= 700 ? 'Really good' :
          total >= 500 ? 'Strong' :
          total >= 350 ? 'Building' :
          total >= 150 ? 'Early' : 'Starting';
        indexSnapshot = { total, tier, pillars, weakest: weakestKey };
      }

      // Life Compass
      if (lifeCompassData) {
        lifeCompass = {
          goal: (lifeCompassData.primary_goal || '').trim() || null,
          category: (lifeCompassData.category || '').trim() || null,
        };
      }

      // envContext — already resolved above, just save into closure scope
      envContext = envContextResolved;
      // VTID-03036: history-aware context pack — saved for the post-
      // batch ctxParts push below.
      historyContextPack = historyContextPackResolved;
    } else {
      // Anonymous/no-userId path: still run buildClientContext (no DB queries
      // needed since they're all user-scoped).
      try {
        envContext = await buildClientContext(req);
      } catch (exc) {
        console.warn(
          `[${VTID}] buildClientContext failed: ${(exc as Error).message}`,
        );
      }
    }

    const vitanaId = req.identity?.vitana_id ?? null;

    // VTID-03014: extract first_name preferring app_users.display_name, then
    // memory_facts.user_name (the canonical Cognee-extracted name). Without
    // this, users whose display_name is null but whose user_name fact IS
    // populated got greeted by @handle instead of their actual name —
    // exactly the failure mode the L2.2b.6 smoke surfaced.
    const userNameFactForPrompt = identityFacts.find((f) => f.fact_key === 'user_name');
    const promptFullName = (
      (displayName || '').trim() ||
      (userNameFactForPrompt?.fact_value || '').trim()
    );
    const promptFirstName = promptFullName ? promptFullName.split(/\s+/)[0] : '';

    const ctxParts: string[] = [];
    // Authoritative identity header — pinned at top so the LLM treats it
    // as ground truth, mirrors the role/vitana-id headers Vertex pins.
    //
    // VTID-03014: when a first_name exists, ONLY emit the first-name line.
    // The previous "Address them as @handle" line ran alongside it and
    // gave Gemini two competing addressing signals — sometimes it picked
    // the handle ("Hi @e2etest33!") instead of the name ("Hi Dragan!").
    // The handle stays in the AUTHORITATIVE USER VITANA ID block (rendered
    // by buildLiveSystemInstruction) for when the user explicitly asks
    // "what's my handle?", but it MUST NOT be promoted as preferred address.
    if (promptFirstName) {
      ctxParts.push(
        `The user's first name is ${promptFirstName}. ` +
        `Greet them by this name. Use the first name in conversation, ` +
        `not their Vitana handle.`,
      );
    } else if (vitanaId) {
      // Fallback: no first_name on file. Handle becomes the preferred
      // address since there's nothing better.
      ctxParts.push(
        `The user has no first name on file. Their Vitana handle is ` +
        `@${vitanaId} — use it for greetings until they tell you their name.`,
      );
    }
    // Note: deliberately do NOT include the raw UUID — small models read
    // "Internal user UUID" as off-limits debug info and refuse to use the
    // identity. The handle (@${vitanaId}) and name above are the model-
    // facing identifiers; the UUID stays in metadata for tool calls only.
    ctxParts.push(`Role: ${role}.`);
    ctxParts.push(`Language: ${lang}.`);
    if (registrationSeq !== null) {
      ctxParts.push(`Registration sequence: ${registrationSeq}.`);
    }

    // Verified facts — same shape Vertex injects via memory_facts.
    if (identityFacts.length > 0) {
      const factLines = identityFacts.map((f) => {
        const scope = f.entity === 'self' ? '' : ` (${f.entity})`;
        return `- ${f.fact_key}${scope}: ${f.fact_value}`;
      });
      ctxParts.push(
        `## Verified facts about this user (do NOT invent, do NOT contradict):\n${factLines.join('\n')}`,
      );
    }

    // Vitana Index snapshot — mirrors the [HEALTH] block Vertex injects.
    if (indexSnapshot) {
      const pillarLines = Object.entries(indexSnapshot.pillars)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n');
      ctxParts.push(
        `## Vitana Index\nTotal: ${indexSnapshot.total} (Tier: ${indexSnapshot.tier}).${
          indexSnapshot.weakest ? ` Weakest pillar: ${indexSnapshot.weakest}.` : ''
        }\nPillars:\n${pillarLines}`,
      );
    }

    // L2.2b.6 (VTID-03010): Life Compass block. Goes ABOVE memory items so the
    // long-term direction is visible to the model before transient recent
    // turns. The `goal` line is the high-signal one — the model uses it for
    // "what am I working toward?" answers and as a frame for activity nudges.
    if (lifeCompass && (lifeCompass.goal || lifeCompass.category)) {
      const lcLines: string[] = [];
      if (lifeCompass.goal) lcLines.push(`Goal: ${lifeCompass.goal}`);
      if (lifeCompass.category) lcLines.push(`Category: ${lifeCompass.category}`);
      ctxParts.push(`## Life Compass\n${lcLines.join('\n')}`);
    }

    if (memoryItems.length) {
      ctxParts.push(
        `## Recent memory items\n${memoryItems
          .map((m) => `- ${m.text.slice(0, 300)}`)
          .join('\n')}`,
      );
    }

    // VTID-03036: history-aware context block — the same contextInstruction
    // Vertex builds via session.contextInstruction (memoryContext.formatted_context
    // + last-3 user turns + USER CONTEXT PROFILE). Closes parity gaps that the
    // identity-only bootstrap left open:
    //   - "how long am I a member of Maxina?" / tenure questions
    //     → USER CONTEXT PROFILE block carries onboarding/activity-tenure data
    //   - "what did I ask you last?" / "what were we talking about?"
    //     → recent-turns block carries the last 3 raw user utterances
    //   - implicit fact recall ("you said I do walks in the mornings")
    //     → memoryContext.formatted_context fact preamble
    // Best-effort: when historyContextPack is null (anonymous, fetch failed)
    // or its contextInstruction is empty/missing, push nothing — never block
    // the bootstrap response.
    if (
      historyContextPack &&
      typeof historyContextPack.contextInstruction === 'string' &&
      historyContextPack.contextInstruction.trim().length > 0
    ) {
      ctxParts.push(historyContextPack.contextInstruction);
    }

    // VTID-03248 (R1 slice 1): resolve the spoken first name through the SAME
    // canonical resolver as the Vertex path so both transports use identical
    // precedence (memory_facts → app_users → email). Gains the email
    // last-resort the inline logic lacked. first_name_source stays comparable
    // across transports for the wake-decision snapshot (VTID-03210).
    const userNameFact = identityFacts.find((f) => f.fact_key === 'user_name');
    const { firstName, source: firstNameSource } = resolveSpokenFirstName({
      memoryFactUserName: userNameFact?.fact_value ?? null,
      displayName,
      email: (req.identity as { email?: string | null } | undefined)?.email ?? null,
    });

    // VTID-02855: ENVIRONMENT CONTEXT — geo-IP + UA + local time, mirrors
    // Vertex's orb-live.ts:14026 path. The fetch itself was moved INTO
    // the parallel batch above (VTID-03030); this block just appends
    // the formatted result to bootstrap_context. Order matters — runs
    // AFTER identity facts so the env block lands at the end.
    if (envContext) {
      try {
        const envBlock = formatClientContextForInstruction(envContext);
        if (envBlock) ctxParts.push(envBlock);
      } catch (exc) {
        console.warn(`[${VTID}] formatClientContextForInstruction failed: ${(exc as Error).message}`);
      }
    }

    // L2.2b.4 (VTID-03008): context-parity LITE. Compile the same
    // `AssistantDecisionContext` the Vertex path renders into its
    // system instruction (continuity / concept_mastery / journey_stage /
    // pillar_momentum / interaction_style) and append the rendered
    // section to bootstrap_context so the LiveKit agent's prompt
    // inherits identical decision-contract intelligence. Anonymous
    // sessions (userId/tenantId null) skip the compile entirely.
    //
    // Architectural rule (matches the L2.2b master design Section 2.5):
    //   - Compile happens in the gateway, NOT in the agent.
    //   - The renderer is a pure function — no provider/DB calls here.
    //   - Agent reads `bootstrap_context` unchanged; no agent code
    //     change is needed for this slice.
    //
    // Best-effort: any compile failure degrades to the pre-L2.2b.4
    // bootstrap (identity + facts + index + memory + env) without
    // blocking the session start.
    let decisionContext: import('../orb/context/types').AssistantDecisionContext | null = null;
    if (userId && tenantId) {
      try {
        const { compileAssistantDecisionContext } = await import(
          '../orb/context/compile-assistant-decision-context'
        );
        decisionContext = await compileAssistantDecisionContext({
          userId,
          tenantId,
        });
        const { renderDecisionContract } = await import(
          '../orb/live/instruction/decision-contract-renderer'
        );
        const decisionBlock = renderDecisionContract(decisionContext);
        if (decisionBlock) {
          ctxParts.push(decisionBlock);
        }
      } catch (exc) {
        // Compile/render failure must NEVER block the bootstrap.
        // Vertex production users are unaffected by anything here.
        console.warn(
          `[${VTID}] decision-context compile failed (LiveKit path falls back to identity-only bootstrap): ${(exc as Error).message}`,
        );
      }
    }

    const bootstrapContext = ctxParts.join('\n');

    // L2.2b.6 (VTID-03010): render the SAME system instruction Vertex
    // renders, so the LiveKit agent uses byte-identical prompt rules.
    // Until this slice, the LiveKit agent had its own ~7-section Python
    // builder while Vertex carried ~17 sections (greeting policy,
    // identity lock, activity awareness, intent classifier, route
    // integrity, retired-pillar handling, diary-logging tool rules,
    // etc.). The model behaved radically differently per pipeline.
    //
    // Best-effort: if rendering throws, the agent still gets the structured
    // bootstrap_context + identity fields and can fall back to its
    // pre-L2.2b.6 builder. Never block the bootstrap on a render error.
    // VTID-03027: when agent_id is a SPECIALIST persona (devon/sage/atlas/
    // mira), the agent is asking for the persona-specific system
    // instruction — not Vitana's. Mirror Vertex's persona-swap path which
    // loads `agent_personas.system_prompt` for the target persona and
    // composes the persona's full prompt with language directive +
    // optional handoff brief. Without this, LiveKit handoff returns
    // Vitana's 65KB IDENTITY-LOCK'd prompt for Devon — costume Devon.
    const SPECIALIST_PERSONAS = new Set(['devon', 'sage', 'atlas', 'mira']);
    const handoffSummary = typeof req.query.handoff_summary === 'string'
      ? (req.query.handoff_summary as string).trim()
      : '';
    let systemInstruction: string | null = null;
    if (SPECIALIST_PERSONAS.has(agentId.toLowerCase())) {
      try {
        const { data: personaRow } = await sb!
          .from('agent_personas')
          .select('system_prompt, display_name')
          .eq('key', agentId.toLowerCase())
          .maybeSingle();
        const personaPrompt = (personaRow as { system_prompt?: string } | null)?.system_prompt?.trim() || '';
        if (personaPrompt) {
          // VTID-03047: assemble the specialist's system instruction by
          // mirroring Vertex's report_to_specialist handler (orb-live.ts
          // ~lines 2922-2937). Same helpers, same order, same wording —
          // so LiveKit Devon's prompt is byte-similar to Vertex Devon's
          // and the model behaves the same. Previous LiveKit-only
          // hand-rolled BEHAVIORAL RULE blocks were drifting from Vertex
          // and bypassing rules that the user already validated for
          // Vertex (close-question flow, goodbye structure, instruction-
          // manual protection, swap-back ordering).
          const userContextSection = await fetchSpecialistContextSection(userId);
          const behavioralRule = buildPersonaBehavioralRule(agentId.toLowerCase());
          const languageDirective = buildSpecialistLanguageDirective(lang);
          const RECEPTIONIST_KEY = 'vitana';
          const handoffNote = handoffSummary
            ? `\n\n[HANDOFF NOTE] Vitana captured this brief at handoff: "${handoffSummary}". Synthesize what they reported in ONE sentence (your own words, not theirs) and confirm. Do NOT echo their wording back.`
            : '';
          systemInstruction =
            personaPrompt +
            `\n\n${languageDirective}` +
            (userContextSection ? `\n\n${userContextSection}` : '') +
            (bootstrapContext ? `\n\n## USER CONTEXT (carried over from Vitana)\n\n${bootstrapContext}` : '') +
            `\n\n${behavioralRule}` +
            handoffNote +
            `\n\n[NAVIGATION TOOL] You have a switch_persona tool. You can ONLY pass to='${RECEPTIONIST_KEY}' — you cannot forward sideways to another specialist. If the question is outside your authority, return the user to Vitana with a brief bridge in your own words (vary your phrasing) and STOP — do NOT speak after calling the tool.`;
          console.log(`[VTID-03047] persona system_instruction rendered for ${agentId} (${systemInstruction.length} chars, handoff_summary=${handoffSummary ? `${handoffSummary.length} chars` : 'none'}, user_context=${userContextSection ? 'yes' : 'no'})`);
        }
      } catch (exc) {
        console.warn(`[VTID-03047] persona prompt fetch failed for ${agentId}: ${(exc as Error).message}`);
      }
    }
    // VTID-03122 (Phase E): hoist fetchLastSessionInfo so the TEMPORAL+JOURNEY
    // block in buildLiveSystemInstruction has real "Time since last ORB session"
    // data instead of "UNKNOWN recency". The same call already runs inside the
    // wake-brief block below — hoisting here lets both code paths share a
    // single fetch. Best-effort: any error returns null and the temporal block
    // degrades to UNKNOWN, never blocks the bootstrap.
    let lastSessionInfo: { time: string; wasFailure: boolean } | null = null;
    if (userId) {
      try {
        lastSessionInfo = await fetchLastSessionInfo(userId);
      } catch (exc) {
        console.warn(
          `[${VTID}/VTID-03122] fetchLastSessionInfo failed (non-fatal, temporal block falls back to UNKNOWN): ${(exc as Error).message}`,
        );
      }
    }

    // Vitana path: full 65KB system instruction with IDENTITY LOCK etc.
    try {
      if (systemInstruction === null) {
      const voiceStyle =
        (voiceConfig as { voice_style?: string } | null)?.voice_style?.trim() ||
        'friendly, calm, empathetic';
      // VTID-03047: mirror Vertex's swap-back-to-Vitana assembly
      // (orb-live.ts:5641-5648). Vertex appends
      // `buildPersonaBehavioralRule('vitana')` to Vitana's contextInstruction
      // so she carries the universal behavioral rules — including the
      // [VITANA — explicit consent before transfer] block that drives
      // "PROPOSE before transferring, wait for affirmative reply" routing.
      // Without this LiveKit Vitana lacked the rules and the model fell
      // back to a "I'll note it for the team" no-op when faced with a
      // bug-report flow (2026-05-17 user-reported regression).
      const vitanaBehavioralRule = buildPersonaBehavioralRule('vitana');
      const vitanaContextInstruction = bootstrapContext
        ? `${bootstrapContext}\n\n${vitanaBehavioralRule}`
        : vitanaBehavioralRule;
      systemInstruction = buildLiveSystemInstruction(
        lang,
        voiceStyle,
        vitanaContextInstruction,
        role,
        undefined,           // conversationSummary — not surfaced through bootstrap yet
        undefined,           // conversationHistory — agent reconnect path will populate later
        isReconnect,
        lastSessionInfo,     // VTID-03122 (Phase E) — drives "Time since last ORB session" + wasFailure marker in the TEMPORAL+JOURNEY block
        currentRoute,        // VTID-03122 (Phase E) — drives "Current screen" line when client supplies ?current_route=…
        recentRoutes,        // VTID-03122 (Phase E) — drives journey trail when client supplies ?recent_routes=…
        envContext ?? undefined,
        req.identity?.vitana_id ?? null,
        true,                // VTID-03046 step 2 — LiveKit's session.say()
                             // plays a pre-rendered localized greeting at
                             // room-join; the LLM never generates the first
                             // utterance, so the ~37 KB GREETING POLICY +
                             // RECONNECT FINAL OVERRIDE + HARD ANTI-PATTERNS
                             // blocks are dead text on every per-turn LLM
                             // call. omitGreetingPolicy=true drops them
                             // (~107 KB → ~70 KB system_instruction).
      );
      }
    } catch (exc) {
      console.warn(
        `[${VTID}] system_instruction render failed (agent falls back to its own builder): ${(exc as Error).message}`,
      );
    }

    // VTID-03052: wake-brief continuation decision.
    // Mirrors live-session-controller.ts:727-745 (Vertex path). Best-effort:
    // any failure here MUST NOT block the bootstrap response. Decision is
    // attached to the payload so the agent + cockpit can observe it, but
    // is not yet routed into the spoken first words (deferred per the
    // B0d.4 design rule until timeline data confirms the path is healthy).
    let wakeBriefDecision: Awaited<ReturnType<typeof decideWakeBriefForSession>> | null = null;
    // VTID-03210: hoisted to handler scope so the wake-decision snapshot
    // (emitted below, after the override re-render) can read the bucket.
    let wakeBucketForSnapshot: string | null = null;
    if (userId && tenantId) {
      try {
        // LiveKit bootstrap has no long-lived session_id at this point —
        // each /orb/context-bootstrap call is one HTTP request. We synthesize
        // a per-bootstrap id so the wake-timeline can group the 3
        // continuation_decision_* events that fire from
        // decideWakeBriefForSession for THIS call.
        const wakeBriefSessionId = `livekit-bootstrap-${randomUUID()}`;
        // VTID-03122 (Phase E): reuse the lastSessionInfo hoisted at the top
        // of the handler instead of re-fetching here. Single fetch per
        // bootstrap, same value reaches both buildLiveSystemInstruction call
        // sites and the wake-brief decision.
        const temporal = describeTimeSince(lastSessionInfo);
        wakeBucketForSnapshot = temporal.bucket;
        // VTID-03081 (B1 wiring): read cadence signals from
        // user_assistant_state so decideGreetingPolicy() can apply the
        // 15-min greet-once cap, same-style downgrade, and heavy-day
        // dampening that have lived (unused) in greeting-policy.ts.
        const { fetchWakeCadenceSignals, recordWakeSessionStart } =
          await import('../services/wake-cadence-signals');
        type LkCadence = Awaited<ReturnType<typeof fetchWakeCadenceSignals>>;
        let cadenceSignals: LkCadence = {};
        if (sb) {
          try {
            cadenceSignals = await fetchWakeCadenceSignals({
              supabase: sb,
              tenantId,
              userId,
            });
          } catch {
            // Fail-open — empty signals degrade to bucket-only policy.
          }
        }
        wakeBriefDecision = await decideWakeBriefForSession({
          sessionId: wakeBriefSessionId,
          tenantId,
          userId,
          bucket: temporal.bucket,
          // `temporal.was_failure` is snake_case in temporal-bucket.ts's
          // canonical `LastInteraction` view; `decideWakeBriefForSession`'s
          // arg is `wasFailure` (camelCase) — bridge here.
          wasFailure: temporal.was_failure,
          isReconnect,
          lang,
          envelopeJourneySurface:
            (envContext as { journeySurface?: string } | undefined)?.journeySurface,
          // VTID-03053: forward distilled pillar-momentum so the renderer
          // can emit a proactive opener for slipping pillars instead of
          // the generic "Hello! How can I help today?" line. Already
          // compiled earlier in this handler at the spine step.
          pillarMomentum: decisionContext?.pillar_momentum ?? null,
          // VTID-03057 (B0d-real Xb): forward supabase client +
          // decisionContext so the Contextual Next Action provider can
          // query its sources (reminders, autopilot_recommendations).
          // Best-effort: when supabase is null (rare), the next-action
          // provider skips and voice-wake-brief still fires its
          // hardcoded fallback line.
          supabase: sb ?? undefined,
          decisionContext: decisionContext ?? null,
          // VTID-03081: pass cadence + wake_origin so the B1 policy runs
          // the full layered decision. Recording happens automatically
          // inside decideWakeBriefForSession on non-skip emissions.
          cadenceSignals,
          wakeOrigin:
            (envContext as { wakeOrigin?: 'orb_tap' | 'wake_word' | 'push_tap' | 'proactive_opener' | 'deep_link' | 'unknown' } | undefined)
              ?.wakeOrigin ?? 'unknown',
          // VTID-03164: forward timezone for the new-day-return provider.
          // LiveKit envelope carries it under clientContext.timezone OR
          // (legacy) envelope.timezone — try both.
          timezone:
            (envContext as { timezone?: string } | undefined)?.timezone
              ?? (envContext as { clientContext?: { timezone?: string } } | undefined)?.clientContext?.timezone
              ?? null,
          recordEmission: true,
        });
        // VTID-03081: bump sessions_today_count. Fire-and-forget; never
        // blocks the bootstrap response.
        if (sb) {
          void recordWakeSessionStart({
            supabase: sb,
            tenantId,
            userId,
            style: 'fresh_intro', // ignored by recordWakeSessionStart
          }).catch(() => {});
        }
      } catch (exc) {
        console.warn(
          `[${VTID}] wake-brief decision failed (non-fatal): ${(exc as Error).message}`,
        );
      }
    }

    // VTID-03100 / BOOTSTRAP-ORB-RCV-DOUBLEGREET: re-render systemInstruction
    // with the wake-brief SUPPRESSION block when a candidate has a non-empty
    // userFacingLine. The earlier buildLiveSystemInstruction call (line ~1517)
    // ran BEFORE wakeBriefDecision was computed, so the sentinel marker had
    // nowhere to go.
    //
    // *** LiveKit first-turn single-source-of-truth (double-greeting fix) ***
    // On Vertex the LLM speaks the first turn from the system instruction, so
    // the Vertex path injects a "## SPOKEN FIRST UTTERANCE — REQUIRED VERBATIM"
    // block (buildVertexWakeBriefBlock) telling the model to speak the line.
    //
    // On LiveKit the model does NOT own the first turn: the Python agent plays
    // the line deterministically via session.say(user_facing_line) at
    // room-join (see services/agents/orb-agent/src/orb_agent/session.py — the
    // greeting block that reads bootstrap.wake_brief_decision). If we ALSO
    // injected the "speak this verbatim" directive here, the model would speak
    // the same line a second time → the dragan3 double greeting.
    //
    // Fix: on LiveKit we inject ONLY the sentinel marker + a hard "do NOT
    // open / stay silent until the user speaks" directive. The marker still
    // triggers stripBrainOpenerSections() in live-system-instruction.ts (so
    // the competing OPENING SHAPE MATRIX / PROACTIVE OPENER CANDIDATE brain
    // sections + the SHORT-GAP pool are suppressed and can't produce a rival
    // opener), but there is no verbatim-speak instruction — session.say() is
    // the single source of truth for the LiveKit first turn.
    //
    // The proactive-offer path is unaffected: the agent still receives the
    // wake_brief_decision (user_facing_line + decision_id + dedupe_key) in the
    // response payload below and decides add_to_chat_ctx based on
    // is_proactive_offer — gateway behavior here does not touch that.
    let wakeOverrideApplied = false;
    try {
      const picked = wakeBriefDecision?.selectedContinuation ?? null;
      const line = picked?.userFacingLine?.trim();
      if (picked && line && line.length > 0 && !isReconnect) {
        wakeOverrideApplied = true;
        // LiveKit first-turn suppression — split into TWO parts so the bootstrap
        // cap (capBootstrapContext, 12 KB, trims the BOTTOM of the bootstrap)
        // can never strip the load-bearing directive:
        //
        //   1. SENTINEL MARKER — placed at the HEAD of the augmented bootstrap.
        //      buildLiveSystemInstruction passes the bootstrap through
        //      capBootstrapContext, which PRESERVES the head and trims the
        //      tail. Keeping the marker at the head guarantees it survives, so
        //      stripBrainOpenerSections() + the wakeBriefOverrideActive
        //      detection (both read the marker out of bootstrapContext) keep
        //      firing for heavy-context users. The marker alone produces NO
        //      greeting (it's a sentinel), so it cannot create a rival opener.
        //
        //   2. "DO NOT SPEAK FIRST" DIRECTIVE — appended to the RETURNED
        //      system_instruction, AFTER buildLiveSystemInstruction (i.e.
        //      OUTSIDE the bootstrap region that the cap can trim). This is the
        //      directive that actually silences the model's first turn. Placing
        //      it last also gives it recency primacy over the generic
        //      "you MUST speak first" GREETING RULES higher in the prompt.
        //
        // BOOTSTRAP-ORB-RCV-DOUBLEGREET (P2 fix): previously this whole block
        // was appended to the END of the bootstrap, so when an authenticated
        // user's bootstrapContext + behavioral rule exceeded 12 KB the
        // directive was trimmed off the final system_instruction while the
        // generic "speak first" rule survived → the double-greeting returned
        // for heavy-context users.
        const firstTurnSuppressionDirective = `

## FIRST TURN — DO NOT SPEAK FIRST (LiveKit transport — BOOTSTRAP-ORB-RCV-DOUBLEGREET)

The client app plays the opening line for this session before you receive
control. You MUST NOT produce an opening utterance, greeting, or
proactive offer on your first turn — the user has already heard it.
Do NOT introduce yourself, do NOT list features, do NOT ask "How can I
help?", and do NOT repeat or paraphrase any greeting. Remain silent and
WAIT for the user to speak. Only then respond normally.

This block OVERRIDES every other greeting rule in this prompt for the
first turn only. Subsequent turns follow the normal conversation flow.`;
        const vitanaBehavioralRule = buildPersonaBehavioralRule('vitana');
        // Marker at the HEAD so capBootstrapContext (head-preserving) can never
        // trim it away, regardless of bootstrap size.
        const augmentedContext =
          `${VERTEX_WAKE_BRIEF_OVERRIDE_MARKER}\n\n` +
          (bootstrapContext ? `${bootstrapContext}\n\n` : '') +
          `${vitanaBehavioralRule}`;
        const voiceStyle =
          (voiceConfig as { voice_style?: string } | null)?.voice_style?.trim() ||
          'friendly, calm, empathetic';
        systemInstruction = buildLiveSystemInstruction(
          lang,
          voiceStyle,
          augmentedContext,
          role,
          undefined,
          undefined,
          isReconnect,
          lastSessionInfo,     // VTID-03122 (Phase E)
          currentRoute,        // VTID-03122 (Phase E)
          recentRoutes,        // VTID-03122 (Phase E)
          envContext ?? undefined,
          req.identity?.vitana_id ?? null,
          true,
        );
        // Append the directive OUTSIDE the bootstrap-cap region — this is what
        // keeps it from ever being trimmed for heavy-context users.
        systemInstruction += firstTurnSuppressionDirective;
        console.log(
          `[${VTID}/BOOTSTRAP-ORB-RCV-DOUBLEGREET] systemInstruction re-rendered with LiveKit first-turn SUPPRESSION (kind=${picked.kind}, decision_id=${wakeBriefDecision?.decisionId}, lang=${lang}) — session.say() owns the first turn, model stays silent; directive appended post-cap so it survives heavy bootstrap`,
        );
      }
    } catch (exc) {
      console.warn(
        `[${VTID}/BOOTSTRAP-ORB-RCV-DOUBLEGREET] suppression re-render failed (non-fatal — falls back to pre-override system_instruction): ${(exc as Error).message}`,
      );
    }

    // VTID-03210: emit the SAME structured turn-1 wake-decision snapshot as
    // the Vertex path (live-session-controller). LiveKit composes the first
    // turn differently — the wake-brief override is the only turn-1 block in
    // this handler (teacher-mode / journey-greeting blocks are Vertex-session
    // constructs), so those flags are false here. The shared shape makes the
    // Vertex/LiveKit asymmetry directly comparable in logs.
    logWakeDecisionSnapshot({
      transport: 'livekit',
      sessionId: `livekit-bootstrap-${agentId}`,
      decision: wakeBriefDecision,
      blocks: {
        wakeBriefOverride: wakeOverrideApplied,
        teacherModeContent: false,
        journeyGreeting: false,
      },
      firstName: { value: firstName, source: firstNameSource },
      lang,
      bucket: wakeBucketForSnapshot,
      isReconnect,
      timezonePresent: !!(
        (envContext as { timezone?: string } | undefined)?.timezone ??
        (envContext as { clientContext?: { timezone?: string } } | undefined)?.clientContext?.timezone
      ),
    });

    const responsePayload: Record<string, unknown> = {
      ok: true,
      vtid: VTID,
      agent_id: agentId,
      is_reconnect: isReconnect,
      last_n_requested: lastN,
      bootstrap_context: bootstrapContext,
      // L2.2b.6 (VTID-03010): rendered full Vertex system instruction.
      // The agent's session.py uses this verbatim — no parallel Python
      // builder, no template drift. When null (rare: render exception),
      // the agent's instructions.py passthrough falls back to a minimal
      // bootstrap_context-based prompt.
      system_instruction: systemInstruction,
      active_role: role,
      conversation_summary: null,
      last_turns: null,
      // VTID-03122 (Phase E): echo the populated fields back so the client
      // can verify what was applied. lastSessionInfo flows in from the
      // hoisted fetch; currentRoute / recentRoutes echo the query-param
      // input (null/[] when unset).
      last_session_info: lastSessionInfo,
      current_route: currentRoute,
      recent_routes: recentRoutes ?? [],
      client_context: envContext ?? { user_agent: req.headers['user-agent'] ?? null },
      vitana_id: req.identity?.vitana_id ?? null,
      // VTID-LIVEKIT-IDENTITY-NAME: surface the user's name + verified facts as
      // structured fields so the agent's instructions.py can address them by
      // first name rather than only by @handle.
      display_name: displayName,
      first_name: firstName,
      identity_facts: identityFacts,
      identity_facts_count: identityFacts.length,
      voice_config: voiceConfig,
      memory_items: memoryItems,
      // L2.2b.6 (VTID-03010): Life Compass row surfaced for tooling / cockpit
      // inspection. The rendered value is already inside bootstrap_context.
      life_compass: lifeCompass,
      // L2.2b.4 (VTID-03008): structured decision-contract output for
      // cockpit/operator inspection. The rendered version is already
      // inlined into `bootstrap_context`; this field is for tooling.
      // null on anonymous sessions or when compile failed.
      decision_context: decisionContext,
      // VTID-03036: structured meta on the history-aware context pack.
      // The rendered contextInstruction is already inlined into
      // `bootstrap_context`; this object is for cockpit/operator
      // inspection (latency timing + skipped-reason for degraded
      // sources). null on anonymous sessions or when the call failed.
      context_pack: historyContextPack
        ? {
            ok: typeof historyContextPack.contextInstruction === 'string'
              && historyContextPack.contextInstruction.trim().length > 0,
            latency_ms: historyContextPack.latencyMs,
            skipped_reason: historyContextPack.skippedReason ?? null,
            chars: typeof historyContextPack.contextInstruction === 'string'
              ? historyContextPack.contextInstruction.length
              : 0,
          }
        : null,
      // VTID-03052: continuation decision for the orb_wake surface. The
      // agent + cockpit can read selected_continuation / suppression_reason
      // here; the full provider-results carrier is on
      // decisionContext-side observability. Null when the call was
      // skipped (anonymous / missing tenant) or failed.
      wake_brief_decision: wakeBriefDecision
        ? {
            decision_id: wakeBriefDecision.decisionId,
            selected_kind: wakeBriefDecision.selectedContinuation?.kind ?? 'none_with_reason',
            suppression_reason: wakeBriefDecision.suppressionReason ?? null,
            user_facing_line: wakeBriefDecision.selectedContinuation?.userFacingLine ?? null,
            // VTID-03076 (P0-C): expose dedupe_key + source_key on the
            // bootstrap response so the LiveKit agent can POST
            // accepted/dismissed events to /voice/next-action/event
            // when the user replies "ja"/"yes"/"nein"/"no" to a spoken
            // wake-brief. Without these two fields the agent has no way
            // to close the suggested → accepted lifecycle (event
            // endpoint validates dedupeKey as required).
            dedupe_key: wakeBriefDecision.selectedContinuation?.dedupeKey ?? null,
            source_key:
              wakeBriefDecision.selectedContinuation?.evidence
                .map((e) => e.kind)
                .find((k) => k.startsWith('source:'))
                ?.replace('source:', '') ?? null,
            decision_started_at: wakeBriefDecision.decisionStartedAt,
            decision_finished_at: wakeBriefDecision.decisionFinishedAt,
            provider_results: wakeBriefDecision.sourceProviderResults.map((r) => ({
              key: r.providerKey,
              status: r.status,
              latency_ms: r.latencyMs,
              reason: r.reason,
            })),
          }
        : null,
    };

    // VTID-03035 + VTID-03036: populate both cache layers for the next 60s.
    //  - L1 in-memory: instant hit on same Cloud Run instance.
    //  - L2 Supabase (fire-and-forget upsert): hit on any instance via the
    //    `bootstrap_cache` table — required for prewarm→agent to land
    //    cross-instance under load.
    if (cacheKey) {
      setCachedBootstrap(cacheKey, responsePayload);
      // Fire-and-forget — don't block the response on the Supabase write.
      void setSharedCachedBootstrap(cacheKey, responsePayload);
    }

    res.json(responsePayload);
  },
);

// ---------------------------------------------------------------------------
// voice_providers registry + per-provider /test
// ---------------------------------------------------------------------------

router.get('/voice-providers', async (_req: Request, res: Response) => {
  const sb = getSupabase();
  if (!sb) return res.json({ ok: true, providers: [], vtid: VTID });
  const { data, error } = await sb
    .from('voice_providers')
    .select(
      'id, kind, display_name, models, options_schema, plugin_module, fallback_chain, enabled, notes',
    )
    .eq('enabled', true)
    .order('kind', { ascending: true })
    .order('id', { ascending: true });
  if (error) {
    return res.json({
      ok: true,
      providers: [],
      vtid: VTID,
      note: `Migration not applied: ${error.message}`,
    });
  }
  res.json({ ok: true, providers: data ?? [], vtid: VTID });
});

async function probeUrl(
  url: string,
  envKey: string | null,
): Promise<{ ok: boolean; detail?: string }> {
  if (envKey && !process.env[envKey]) {
    return { ok: false, detail: `${envKey} not configured` };
  }
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return { ok: true, detail: `HEAD ${r.status}` };
  } catch (e) {
    return { ok: false, detail: `network: ${(e as Error).message}` };
  }
}

router.post('/voice-providers/:id/test', async (req: Request, res: Response) => {
  const { id } = req.params;
  const probes: Record<string, () => Promise<{ ok: boolean; detail?: string }>> = {
    deepgram: () => probeUrl('https://api.deepgram.com', 'DEEPGRAM_API_KEY'),
    assemblyai: () => probeUrl('https://api.assemblyai.com', 'ASSEMBLYAI_API_KEY'),
    cartesia: () => probeUrl('https://api.cartesia.ai', 'CARTESIA_API_KEY'),
    elevenlabs: () => probeUrl('https://api.elevenlabs.io', 'ELEVENLABS_API_KEY'),
    rime: () => probeUrl('https://users.rime.ai', 'RIME_API_KEY'),
    inworld: () => probeUrl('https://api.inworld.ai', 'INWORLD_API_KEY'),
    deepgram_tts: () => probeUrl('https://api.deepgram.com', 'DEEPGRAM_API_KEY'),
    google_stt: () => probeUrl('https://speech.googleapis.com', null),
    google_tts: () => probeUrl('https://texttospeech.googleapis.com', null),
    openai_stt: () => probeUrl('https://api.openai.com', 'OPENAI_API_KEY'),
    openai_tts: () => probeUrl('https://api.openai.com', 'OPENAI_API_KEY'),
    openai: () => probeUrl('https://api.openai.com', 'OPENAI_API_KEY'),
    anthropic: () => probeUrl('https://api.anthropic.com', 'ANTHROPIC_API_KEY'),
    google_llm: () =>
      probeUrl('https://generativelanguage.googleapis.com', 'GOOGLE_GEMINI_API_KEY'),
    xai: () => probeUrl('https://api.x.ai', 'XAI_API_KEY'),
    mistral: () => probeUrl('https://api.mistral.ai', 'MISTRAL_API_KEY'),
    groq: () => probeUrl('https://api.groq.com', 'GROQ_API_KEY'),
    cerebras: () => probeUrl('https://api.cerebras.ai', 'CEREBRAS_API_KEY'),
    soniox: () => probeUrl('https://api.soniox.com', 'SONIOX_API_KEY'),
    speechmatics: () => probeUrl('https://asr.api.speechmatics.com', 'SPEECHMATICS_API_KEY'),
    azure_stt: async () => ({
      ok: !!process.env.AZURE_SPEECH_KEY,
      detail: 'env-only check',
    }),
    azure_tts: async () => ({
      ok: !!process.env.AZURE_SPEECH_KEY,
      detail: 'env-only check',
    }),
    groq_stt: () => probeUrl('https://api.groq.com', 'GROQ_API_KEY'),
    cartesia_stt: () => probeUrl('https://api.cartesia.ai', 'CARTESIA_API_KEY'),
  };

  const probe = probes[id];
  if (!probe) {
    return res.status(404).json({ ok: false, error: 'unknown_provider', id, vtid: VTID });
  }
  const result = await probe();
  res.json({ ok: result.ok, provider_id: id, detail: result.detail ?? null, vtid: VTID });
});

// ---------------------------------------------------------------------------
// Per-agent voice config CRUD
// ---------------------------------------------------------------------------

interface VoiceConfigBody {
  transport?: string;
  stt_provider?: string;
  stt_model?: string;
  stt_options?: Record<string, unknown>;
  llm_provider?: string;
  llm_model?: string;
  llm_options?: Record<string, unknown>;
  tts_provider?: string;
  tts_model?: string;
  tts_options?: Record<string, unknown>;
}

const VALID_TRANSPORTS = new Set([
  'vertex',
  'livekit_cascade',
  'livekit_half_cascade',
  'livekit_realtime',
]);

router.get(
  '/agents/:id/voice-config',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const sb = getSupabase();
    if (!sb) return res.json({ ok: true, agent_id: id, config: null, vtid: VTID });
    const { data, error } = await sb
      .from('agent_voice_configs')
      .select('*')
      .eq('agent_id', id)
      .maybeSingle();
    if (error) {
      return res.json({
        ok: true,
        agent_id: id,
        config: null,
        vtid: VTID,
        note: error.message,
      });
    }
    res.json({ ok: true, agent_id: id, config: data ?? null, vtid: VTID });
  },
);

router.put(
  '/agents/:id/voice-config',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const body = (req.body ?? {}) as VoiceConfigBody;
    if (body.transport && !VALID_TRANSPORTS.has(body.transport)) {
      return res.status(400).json({ ok: false, error: 'invalid transport', vtid: VTID });
    }
    const sb = getSupabase();
    if (!sb)
      return res.status(500).json({ ok: false, error: 'supabase unavailable', vtid: VTID });

    const referenced = [body.stt_provider, body.llm_provider, body.tts_provider].filter(
      (x): x is string => Boolean(x),
    );
    if (referenced.length) {
      const { data: providers } = await sb
        .from('voice_providers')
        .select('id, enabled')
        .in('id', referenced);
      const known = new Map(
        (providers ?? []).map((p: Record<string, unknown>) => [
          String(p.id),
          Boolean(p.enabled),
        ]),
      );
      for (const p of referenced) {
        if (!known.has(p) || !known.get(p)) {
          return res.status(400).json({
            ok: false,
            error: `unknown or disabled provider: ${p}`,
            vtid: VTID,
          });
        }
      }
    }

    const update: Record<string, unknown> = {
      agent_id: id,
      updated_by: req.identity?.user_id ?? null,
    };
    for (const key of [
      'transport',
      'stt_provider',
      'stt_model',
      'stt_options',
      'llm_provider',
      'llm_model',
      'llm_options',
      'tts_provider',
      'tts_model',
      'tts_options',
    ] as const) {
      if (body[key] !== undefined) update[key] = body[key] as unknown;
    }

    const { data, error } = await sb
      .from('agent_voice_configs')
      .upsert(update, { onConflict: 'agent_id' })
      .select('*')
      .single();
    if (error) {
      return res.status(500).json({ ok: false, error: error.message, vtid: VTID });
    }
    try {
      await emitOasisEvent({
        type: 'agent.voice_config.changed' as never,
        actor: req.identity?.user_id ?? 'system',
        payload: { agent_id: id, config: data, vtid: VTID },
      } as never);
    } catch {}
    res.json({ ok: true, agent_id: id, config: data, vtid: VTID });
  },
);

router.post(
  '/agents/:id/voice-config/test-session',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const livekitUrl = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!livekitUrl || !apiKey || !apiSecret) {
      return res.status(500).json({
        ok: false,
        error: 'livekit_misconfigured',
        vtid: VTID,
      });
    }
    const userId = req.identity?.user_id ?? `tester-${randomUUID()}`;
    const proposed = req.body ?? {};
    // PR 1.B-Lang: thread `lang` from the body into the token metadata so
    // the agent's build_cascade picks the right STT language + per-language
    // TTS voice. Without this, every test-session falls back to en-US even
    // when the user picked German in the LiveKit test page dropdown.
    const lang = typeof proposed.lang === 'string' && proposed.lang ? proposed.lang : 'en';
    const voiceOverride = typeof proposed.voice_override === 'string' && proposed.voice_override.trim().length > 0
      ? proposed.voice_override.trim()
      : null;
    const roomName = `orb-test-${id}-${Date.now()}`;

    const agentUserJwt = req.identity ? await mintAgentSessionJwt(req.identity) : null;

    // VTID-03014: capture user's real client IP at mint time so the agent
    // can forward it to /orb/context-bootstrap on the test path too. The
    // Test Bench is precisely the surface the user has been hitting, so
    // missing this here would leave the US-location bug intact even
    // after the production-token fix.
    const clientIp = getRequestClientIP(req);

    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      ttl: TEST_SESSION_TOKEN_TTL_SECONDS,
      metadata: JSON.stringify({
        user_id: userId,
        tenant_id: req.identity?.tenant_id ?? '',
        role: req.identity?.role ?? 'developer',
        lang,
        agent_id: id,
        is_test_session: true,
        proposed_voice_config: proposed,
        vitana_id: req.identity?.vitana_id ?? null,
        voice_override: voiceOverride,
        user_jwt: agentUserJwt,
        // VTID-03014: same shape as /orb/livekit/token — the agent reads
        // metadata.client_ip and forwards it as X-Real-IP to bootstrap.
        client_ip: clientIp,
      }),
    });
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();

    // VTID-03035: pre-warm bootstrap cache (see same block in /orb/livekit/token).
    if (req.identity?.user_id && agentUserJwt) {
      prewarmBootstrap({
        userJwt: agentUserJwt,
        agentId: id,
        lang,
        clientIp,
        baseUrl: SELF_BASE_URL,
      });
    }

    res.json({
      ok: true,
      url: livekitUrl,
      token,
      room: roomName,
      ttl_s: TEST_SESSION_TOKEN_TTL_SECONDS,
      vtid: VTID,
    });
  },
);

export default router;
