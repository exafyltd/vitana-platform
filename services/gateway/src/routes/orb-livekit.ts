/**
 * VTID-LIVEKIT-FOUNDATION: ORB LiveKit pipeline (parallel to Vertex orb-live.ts).
 *
 * Stub endpoints for the standby LiveKit voice pipeline. They live alongside
 * the existing /api/v1/orb/* routes (orb-live.ts) but are mutually exclusive
 * at runtime — a global flag (system_config.voice.active_provider) decides
 * which pipeline serves real traffic. The standby pipeline's session-mint
 * endpoints return 503 { error: 'provider_standby', active_provider: 'vertex' }.
 *
 * Endpoints (all stubs in this PR — return 501 Not Implemented or 503 Standby):
 *
 *   GET  /api/v1/orb/active-provider           current active provider + flip metadata
 *   POST /api/v1/orb/active-provider           admin-only flip (60-min anti-flap)
 *   POST /api/v1/orb/livekit/token             mint LiveKit room JWT (refuses when standby)
 *   GET  /api/v1/orb/livekit/health            health check (LiveKit-side providers)
 *   GET  /api/v1/orb/context-bootstrap         shared context fetcher (consumed by both
 *                                              pipelines once wired)
 *   GET  /api/v1/voice-providers               provider registry (drives Voice Lab dropdowns)
 *   POST /api/v1/voice-providers/:id/test      lightweight provider reachability probe
 *   GET  /api/v1/agents/:id/voice-config       per-agent provider trio
 *   PUT  /api/v1/agents/:id/voice-config       update per-agent provider trio
 *   POST /api/v1/agents/:id/voice-config/test-session
 *                                              ephemeral one-shot session token bound
 *                                              to a proposed (unsaved) config
 *
 * Implementation lands in follow-up PRs:
 *   - LiveKit JWT mint via livekit-server-sdk
 *   - Self-hosted LiveKit URL/key/secret resolution (env vars from secrets manager)
 *   - voice_providers / agent_voice_configs queries (migration in PR #1156)
 *   - active-provider read/write via system_config (flag) + voice_active_provider_changes (audit)
 *
 * See .claude/plans/here-is-what-our-valiant-stearns.md for the full design.
 */

import { Router, Request, Response } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
import { getSupabase } from '../lib/supabase';
import {
  optionalAuth,
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';

const router = Router();

const STUB_VTID = 'VTID-LIVEKIT-FOUNDATION';

// ---------------------------------------------------------------------------
// Active provider switch
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/orb/active-provider
 * Returns the current active provider. Read by the frontend at app boot and
 * on iOS visibility resume to know which pipeline to connect to.
 */
router.get('/orb/active-provider', async (_req: Request, res: Response) => {
  // Default: 'vertex' until the flag exists. Once system_config is wired in
  // a follow-up PR, this reads from there. ENV fallback in the meantime.
  const active = process.env.VOICE_ACTIVE_PROVIDER === 'livekit' ? 'livekit' : 'vertex';
  res.json({
    ok: true,
    active_provider: active,
    last_flipped_at: null,
    flipped_by: null,
    cooldown_remaining_s: 0,
    vtid: STUB_VTID,
    note: 'STUB — wire to system_config in follow-up PR.',
  });
});

/**
 * POST /api/v1/orb/active-provider
 * Admin-only flip. Body: { provider: 'vertex'|'livekit', reason: string }.
 * Enforces 60-minute anti-flap cooldown. Writes voice_active_provider_changes.
 */
router.post('/orb/active-provider', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  const { provider, reason } = req.body ?? {};
  if (provider !== 'vertex' && provider !== 'livekit') {
    return res.status(400).json({ ok: false, error: 'provider must be vertex or livekit' });
  }
  // TODO(VTID-LIVEKIT-FOUNDATION): enforce admin role, 60-min cooldown,
  // write system_config + voice_active_provider_changes, emit
  // voice.active_provider.flipped OASIS event.
  return res.status(501).json({
    ok: false,
    error: 'not_implemented',
    vtid: STUB_VTID,
    detail: 'Active-provider flip is stubbed pending the follow-up PR. Use VOICE_ACTIVE_PROVIDER env var meanwhile.',
    requested: { provider, reason: reason ?? null, requested_by: req.identity?.user_id ?? null },
  });
});

// ---------------------------------------------------------------------------
// LiveKit token mint + health
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/orb/livekit/token
 * Mints a LiveKit room JWT bound to one user. Embeds resolved identity
 * (vitana_id, tenant_id, role with mobile-community coercion, lang) into
 * the room metadata so the agent worker reads it without a round-trip.
 *
 * Refuses with 503 when LiveKit is the standby provider.
 */
router.post('/orb/livekit/token', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  const active = process.env.VOICE_ACTIVE_PROVIDER === 'livekit' ? 'livekit' : 'vertex';
  if (active !== 'livekit') {
    return res.status(503).json({
      ok: false,
      error: 'provider_standby',
      active_provider: active,
      vtid: STUB_VTID,
      detail: 'LiveKit is currently the standby provider. Connect to the Vertex pipeline instead.',
    });
  }

  // TODO(VTID-LIVEKIT-FOUNDATION): mint LiveKit JWT via livekit-server-sdk,
  // embed room metadata { user_id, tenant_id, role, lang, vitana_id,
  // is_mobile, is_anonymous, agent_id }, allocate orb_session_id.
  return res.status(501).json({
    ok: false,
    error: 'not_implemented',
    vtid: STUB_VTID,
    detail: 'LiveKit token mint stubbed pending self-hosted infra (PR #7) + livekit-server-sdk wiring.',
  });
});

/**
 * GET /api/v1/orb/livekit/health
 * Sibling of /orb/health. Reports LiveKit-side reachability.
 */
router.get('/orb/livekit/health', async (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'orb-livekit-routes',
    vtid: STUB_VTID,
    livekit: {
      url_configured: !!process.env.LIVEKIT_URL,
      api_key_configured: !!process.env.LIVEKIT_API_KEY,
    },
    agent_worker_reachable: false, // TODO: actual probe via agent worker /health
    providers: {
      anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
      openai_configured: !!process.env.OPENAI_API_KEY,
      deepgram_configured: !!process.env.DEEPGRAM_API_KEY,
      cartesia_configured: !!process.env.CARTESIA_API_KEY,
      elevenlabs_configured: !!process.env.ELEVENLABS_API_KEY,
      assemblyai_configured: !!process.env.ASSEMBLYAI_API_KEY,
    },
    active_provider: process.env.VOICE_ACTIVE_PROVIDER === 'livekit' ? 'livekit' : 'vertex',
    note: 'STUB — wire real reachability checks in follow-up PR.',
  });
});

// ---------------------------------------------------------------------------
// Shared context bootstrap (consumed by BOTH pipelines once orb-live ports to it)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/orb/context-bootstrap
 * Returns the same payload structure that orb-live.ts currently builds inline.
 * Used by the LiveKit agent worker (services/agents/orb-agent/) and eventually
 * by orb-live.ts itself (refactor target so both pipelines share one builder).
 *
 * Query params: agent_id, is_reconnect, last_n_turns
 */
router.get('/orb/context-bootstrap', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  const agentId = String(req.query.agent_id ?? 'vitana');
  const isReconnect = String(req.query.is_reconnect ?? 'false') === 'true';
  const lastN = Math.min(50, Math.max(0, Number(req.query.last_n_turns ?? 0) || 0));

  // TODO(VTID-LIVEKIT-FOUNDATION): port the inline builder from orb-live.ts.
  // For now return an empty-but-shaped payload so the agent's BootstrapResult
  // dataclass doesn't crash on .get() calls.
  res.json({
    ok: true,
    vtid: STUB_VTID,
    agent_id: agentId,
    is_reconnect: isReconnect,
    bootstrap_context: '',
    active_role: req.identity?.role ?? null,
    conversation_summary: null,
    last_turns: null,
    last_session_info: null,
    current_route: null,
    recent_routes: [],
    client_context: {},
    vitana_id: null,
    voice_config: null,
    last_n_requested: lastN,
    note: 'STUB — full context-bootstrap port lands in follow-up PR.',
  });
});

// ---------------------------------------------------------------------------
// voice_providers registry
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/voice-providers
 * Full registry — drives Command Hub Voice Lab dropdowns.
 */
router.get('/voice-providers', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      res.json({ ok: true, providers: [], vtid: STUB_VTID, note: 'supabase client unavailable' });
      return;
    }
    const { data, error } = await supabase
      .from('voice_providers')
      .select('id, kind, display_name, models, options_schema, plugin_module, fallback_chain, enabled, notes')
      .eq('enabled', true)
      .order('kind', { ascending: true })
      .order('id', { ascending: true });

    if (error) {
      // Migration not applied yet → graceful empty response.
      res.json({ ok: true, providers: [], vtid: STUB_VTID, note: `Migration not applied: ${error.message}` });
      return;
    }
    res.json({ ok: true, providers: data ?? [], vtid: STUB_VTID });
  } catch (e) {
    res.json({ ok: true, providers: [], vtid: STUB_VTID, note: 'getSupabase unavailable in this env' });
  }
});

/**
 * POST /api/v1/voice-providers/:id/test
 * Lightweight reachability probe — STT/TTS round-trip or LLM ping. Powers
 * the green/red dot per dropdown option in the Voice Lab UI.
 */
router.post('/voice-providers/:id/test', async (req: Request, res: Response) => {
  const { id } = req.params;
  return res.status(501).json({
    ok: false,
    error: 'not_implemented',
    vtid: STUB_VTID,
    detail: `Provider reachability test stubbed for '${id}'. Real implementation lands in PR that adds the per-provider probe library.`,
  });
});

// ---------------------------------------------------------------------------
// Per-agent voice config (Voice Lab Agent Configuration sub-tab)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/agents/:id/voice-config
 * Read the per-agent provider trio + matching providers list for dropdowns.
 */
router.get('/agents/:id/voice-config', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabase();
    if (!supabase) {
      res.json({ ok: true, agent_id: id, config: null, vtid: STUB_VTID, note: 'supabase client unavailable' });
      return;
    }
    const { data, error } = await supabase
      .from('agent_voice_configs')
      .select('*')
      .eq('agent_id', id)
      .single();
    if (error) {
      res.json({ ok: true, agent_id: id, config: null, vtid: STUB_VTID, note: error.message });
      return;
    }
    res.json({ ok: true, agent_id: id, config: data, vtid: STUB_VTID });
  } catch {
    res.json({ ok: true, agent_id: id, config: null, vtid: STUB_VTID });
  }
});

/**
 * PUT /api/v1/agents/:id/voice-config
 * Update the per-agent provider trio. Validates the chosen models exist in
 * voice_providers and that mandatory options are present (e.g. ElevenLabs
 * voice_id). Audit row is auto-written by the migration's UPDATE trigger.
 */
router.put('/agents/:id/voice-config', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  return res.status(501).json({
    ok: false,
    error: 'not_implemented',
    vtid: STUB_VTID,
    detail: 'Per-agent voice config write is stubbed pending Voice Lab UI (PR #6).',
    requested: { agent_id: req.params.id, body: req.body, by: req.identity?.user_id ?? null },
  });
});

/**
 * POST /api/v1/agents/:id/voice-config/test-session
 * Mints a one-shot ephemeral session token bound to a *proposed* (unsaved)
 * provider trio. Used by the Voice Lab "Test conversation" button to
 * audition a configuration before saving it.
 */
router.post(
  '/agents/:id/voice-config/test-session',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    return res.status(501).json({
      ok: false,
      error: 'not_implemented',
      vtid: STUB_VTID,
      detail: 'Test-session token mint stubbed; lands with the Voice Lab UI (PR #6).',
      requested: { agent_id: req.params.id, proposed_config: req.body },
    });
  },
);

// ---------------------------------------------------------------------------
// Self-test on first request (one-shot OASIS event so we can confirm the
// router is mounted in production)
// ---------------------------------------------------------------------------

let _bootEmitted = false;
router.use(async (_req, _res, next) => {
  if (!_bootEmitted) {
    _bootEmitted = true;
    try {
      await emitOasisEvent({
        type: 'orb.livekit.routes_mounted' as any,
        actor: 'system',
        payload: { vtid: STUB_VTID, version: '0.1.0' },
      } as any);
    } catch {
      // never block requests on telemetry
    }
  }
  next();
});

export default router;
