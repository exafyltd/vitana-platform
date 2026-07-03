/**
 * Command Hub — "Conversation" section backend (roadmap Step 4, READ-ONLY).
 *
 * Admin-gated read models + a non-speaking Simulator for the conversation flow.
 * This is the operator cockpit for the failure class in
 * docs/CONVERSATION_FLOW_HANDOFF.md §1 — see the decisions the brain makes, the
 * registers/NBAs/screen map it draws from, and the tool-failure feed — WITHOUT
 * any editing controls (editing is Step 5; tenant overrides Step 6).
 *
 * Everything here is derived from the single brain
 * (services/conversation/*) + `oasis_events`; it NEVER speaks, writes, or mutates
 * conversation state. The Simulator dry-runs the exact pure decision functions.
 *
 * Endpoints (mounted at /api/v1, path-scoped admin auth):
 *   GET /admin/conversation/config            → code-derived defaults (registers, NBA bands, screen map)
 *   GET /admin/conversation/preview           → Simulator: dry-run the decision for a user (no speaking)
 *   GET /admin/conversation/decisions         → Monitor: recent greeting decisions (oasis_events)
 *   GET /admin/conversation/tool-failures     → Tool Health: recent tool failures (oasis_events)
 *
 * See docs/CONVERSATION_FLOW_HANDOFF.md §8–§9.
 */

import { Router, Response } from 'express';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import type { OverviewPayload } from '../services/assistant-continuation/providers/new-day-overview-payload';
import {
  rankNextBestActions,
  selectNextBestAction,
  CAPABILITY_BY_KEY,
} from '../services/conversation/next-best-action';
import {
  decideOpeningRegister,
  buildResumeDirective,
  type OpeningRegister,
} from '../services/conversation/decide-opening';
import {
  surfaceForRoute,
  screenCompletionFor,
  type ConversationSurface,
} from '../services/conversation/screen-surface';
import type { TemporalBucket } from '../services/guide/temporal-bucket';

const router = Router();
router.use('/admin/conversation', requireAuth);
router.use('/admin/conversation', requireExafyAdmin);

// The 5 opening registers + their triggers (mirrors decide-opening.ts). Static
// description of the recency-first ladder for the Registers tab.
const REGISTER_MODEL = [
  { register: 'first_time', trigger: 'never onboarded', greeting: 'welcome' },
  { register: 'daily_briefing', trigger: 'first session of a real day (durable last_full_briefing_date is stale)', greeting: 'time-of-day + rich briefing' },
  { register: 'continue', trigger: 'recency bucket = reconnect (<2 min)', greeting: 'none — pick the thread back up' },
  { register: 'quick_resume', trigger: 'recency bucket = recent (<15 min)', greeting: 'micro-ack, no time-of-day' },
  { register: 'same_day', trigger: 'recency bucket = same_day / today (hours later)', greeting: 'light re-entry + what is new' },
] as const;

const ALL_SURFACES: ConversationSurface[] = [
  'matches', 'community', 'chat', 'diary', 'index', 'profile', 'journey', 'news', 'home', 'other',
];

// A fully-populated payload so `rankNextBestActions` surfaces EVERY grounded
// action with its band + capability — the code-derived NBA table for the UI.
function fullPayloadForConfig(): OverviewPayload {
  return {
    journey: null,
    vitana_index: {
      state: 'ok', today: 180, tier: 'Early', tier_framing: null, trend_7d: 2,
      weakest_pillar: { name: 'sleep', score: 40 }, strongest_pillar: { name: 'movement', score: 80 },
      balance_label: 'balanced', pillars: null, projected_day_90: null, projected_day_90_tier: null,
    } as OverviewPayload['vitana_index'],
    life_compass: { state: 'not_set' } as OverviewPayload['life_compass'],
    calendar_today: { count: 0, next: null },
    calendar_passed: { count: 0, most_recent: null },
    autopilot: {
      state: 'has_actions',
      today_checkpoint: {
        recommendation_id: 'demo', title: 'a short breath sequence',
        summary: null, domain: null, impact_score: null,
      },
      this_week: [], pending_total: 1,
    } as OverviewPayload['autopilot'],
    matches_unread: 2,
    messages_unread: 1,
    reminders_today: { count: 1, next: { action_text: 'take your supplement' } } as OverviewPayload['reminders_today'],
    diary_last_7d: 0,
    guided_journey: {
      sessions_completed: 3, next_session_title: 'Session 4 — Sleep', last_session_recall: null,
      topics_learned: 3, topics_total: 12,
    } as OverviewPayload['guided_journey'],
    last_session_date_user_tz: null,
  } as OverviewPayload;
}

function jsonError(res: Response, code: number, error: string) {
  return res.status(code).json({ ok: false, error });
}

/**
 * GET /admin/conversation/config
 * Code-derived read model of the current (global) conversation-flow defaults:
 * the register ladder, the full NBA band table (with executing tool), and the
 * per-surface screen-completion map. No tenant overrides (Step 6).
 */
router.get('/admin/conversation/config', (_req: AuthenticatedRequest, res: Response) => {
  const ranked = rankNextBestActions(fullPayloadForConfig(), { rotationSeed: 0 }).map((a) => ({
    key: a.key,
    domain: a.domain,
    band: a.band,
    detail: a.detail,
    executes_with_tool: a.capability ?? null,
  }));
  const screen_completion = ALL_SURFACES.map((surface) => {
    const c = screenCompletionFor(surface);
    return {
      surface,
      completion_key: c?.action.key ?? null,
      band: c?.action.band ?? null,
      suppresses_redirect: c?.redirect_key ?? null,
      executes_with_tool: c?.action.capability ?? null,
    };
  });
  return res.json({
    ok: true,
    data: {
      source: 'global_defaults',
      registers: REGISTER_MODEL,
      next_best_actions: ranked,
      capability_by_key: CAPABILITY_BY_KEY,
      screen_completion,
    },
  });
});

/**
 * GET /admin/conversation/preview?user_id=&lang=&timezone=&bucket=&first_time=&briefing_due=&current_route=
 * The Simulator. Dry-runs the pure decision for a user: assembles the overview
 * bundle, then computes the register + ranked NBAs + the composed resume
 * directive — WITHOUT speaking or emitting. `bucket` / `first_time` /
 * `briefing_due` let the operator simulate any recency state.
 */
router.get('/admin/conversation/preview', async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.query.user_id || '').trim();
  if (!userId) return jsonError(res, 400, 'user_id is required');

  const lang = String(req.query.lang || 'de');
  const timezone = String(req.query.timezone || 'UTC');
  const bucket = (String(req.query.bucket || 'same_day') as TemporalBucket);
  const firstTime = req.query.first_time === 'true';
  const briefingDue = req.query.briefing_due === 'true';
  const currentRoute = req.query.current_route ? String(req.query.current_route) : null;

  const supabase = getSupabase();
  if (!supabase) return jsonError(res, 503, 'Database not configured');

  try {
    // Assemble the same bundle the live path reads — read-only.
    const { gatherOverviewPayload } = await import(
      '../services/assistant-continuation/providers/new-day-overview-payload'
    );
    const now = new Date();
    let payload: OverviewPayload | null = null;
    try {
      payload = await gatherOverviewPayload({
        supabase,
        userId,
        now,
        timezone,
        lang,
        lastSessionDateUserTz: null,
        lastSessionAtIso: null,
      });
    } catch {
      payload = null; // preview still returns the register/NBA reasoning
    }

    const register: OpeningRegister = decideOpeningRegister({ bucket, isFirstTime: firstTime, briefingDue });

    const ranked = payload
      ? rankNextBestActions(payload, { rotationSeed: 0 }).map((a) => ({
          key: a.key, domain: a.domain, band: a.band, detail: a.detail, executes_with_tool: a.capability ?? null,
        }))
      : [];
    const chosen = payload ? selectNextBestAction(payload, { rotationSeed: 0 }) : null;

    // Only the same-day resume registers compose a directive here (first_time /
    // daily_briefing are owned by other renderers). Mirrors the live guard.
    let directive: string | null = null;
    let directive_nba: string | null = null;
    if (register === 'continue' || register === 'quick_resume' || register === 'same_day') {
      const r = buildResumeDirective({
        register,
        payload,
        firstName: null,
        lang,
        timeAgo: 'earlier',
        rotationSeed: 0,
        recentNbaKeys: [],
        currentScreen: currentRoute,
      });
      directive = r.text;
      directive_nba = r.nba?.key ?? null;
    }

    return res.json({
      ok: true,
      data: {
        user_id: userId,
        simulated: { bucket, first_time: firstTime, briefing_due: briefingDue, lang, timezone, current_route: currentRoute },
        surface: surfaceForRoute(currentRoute),
        register,
        payload_available: !!payload,
        overview_payload: payload,
        ranked_nbas: ranked,
        chosen_nba: chosen ? { key: chosen.key, domain: chosen.domain, band: chosen.band, executes_with_tool: chosen.capability ?? null } : null,
        directive,
        directive_nba,
        note: 'read-only dry-run — the assistant did not speak or emit',
      },
    });
  } catch (e) {
    return jsonError(res, 500, e instanceof Error ? e.message : 'preview failed');
  }
});

/**
 * GET /admin/conversation/decisions?limit=&window_hours=
 * Monitor feed: recent greeting decisions from oasis_events
 * (topic='orb.live.diag', metadata.stage='greeting_sent').
 */
router.get('/admin/conversation/decisions', async (req: AuthenticatedRequest, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const windowHours = Math.min(Math.max(Number(req.query.window_hours) || 24, 1), 720);
  const supabase = getSupabase();
  if (!supabase) return jsonError(res, 503, 'Database not configured');
  try {
    const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('oasis_events')
      .select('created_at, metadata')
      .eq('topic', 'orb.live.diag')
      .eq('metadata->>stage', 'greeting_sent')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return jsonError(res, 500, error.message);
    const rows = (data || []).map((r: { created_at: string; metadata: Record<string, unknown> }) => {
      const m = r.metadata || {};
      return {
        created_at: r.created_at,
        wake_opener: m.wake_opener ?? '(legacy_default)',
        register: m.register ?? null,
        bucket: m.bucket ?? null,
        nba: m.nba ?? null,
        nba_domain: m.nba_domain ?? null,
        current_route: m.current_route ?? null,
        lang: m.lang ?? null,
      };
    });
    return res.json({ ok: true, data: { window_hours: windowHours, count: rows.length, decisions: rows } });
  } catch (e) {
    return jsonError(res, 500, e instanceof Error ? e.message : 'decisions read failed');
  }
});

/**
 * GET /admin/conversation/tool-failures?limit=&window_hours=
 * Tool Health feed: recent tool failures from oasis_events
 * (topic='orb.live.diag', metadata.stage='tool_failed').
 */
router.get('/admin/conversation/tool-failures', async (req: AuthenticatedRequest, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const windowHours = Math.min(Math.max(Number(req.query.window_hours) || 24, 1), 720);
  const supabase = getSupabase();
  if (!supabase) return jsonError(res, 503, 'Database not configured');
  try {
    const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('oasis_events')
      .select('created_at, metadata')
      .eq('topic', 'orb.live.diag')
      .eq('metadata->>stage', 'tool_failed')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return jsonError(res, 500, error.message);
    const rows = (data || []).map((r: { created_at: string; metadata: Record<string, unknown> }) => {
      const m = r.metadata || {};
      return {
        created_at: r.created_at,
        tool: m.tool ?? null,
        soft: m.soft ?? null,
        ms: m.ms ?? null,
        detail: m.detail ?? null,
      };
    });
    return res.json({ ok: true, data: { window_hours: windowHours, count: rows.length, failures: rows } });
  } catch (e) {
    return jsonError(res, 500, e instanceof Error ? e.message : 'tool-failures read failed');
  }
});

export default router;
