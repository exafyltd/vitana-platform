/**
 * Autopilot Recommendations Routes - VTID-01180 + VTID-01185
 *
 * API endpoints for the Autopilot Recommendation popup in Command Hub.
 * Users can view AI-generated recommendations and activate them to create
 * VTID task cards with spec snapshots.
 *
 * VTID-01180 Endpoints:
 * - GET /recommendations - List recommendations (filtered by status)
 * - GET /recommendations/count - Get count for badge
 * - POST /recommendations/:id/activate - Activate recommendation (creates VTID)
 * - POST /recommendations/:id/reject - Reject/dismiss recommendation
 * - POST /recommendations/:id/snooze - Snooze for later
 *
 * VTID-01185 Endpoints (Recommendation Engine):
 * - POST /recommendations/generate - Trigger recommendation generation
 * - GET /recommendations/sources - Get analyzer source status
 * - GET /recommendations/history - Get generation run history
 *
 * Mounted at: /api/v1/autopilot/recommendations
 */

import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { emitOasisEvent } from '../services/oasis-event-service';
import { generateRecommendations, generatePersonalRecommendations, SourceType } from '../services/recommendation-engine';
import { notifyUserAsync } from '../services/notification-service';
import { DEFAULT_WAVE_CONFIG, buildTemplateToWaveMap } from '../services/wave-defaults';
import { derivePillarImpact } from '../services/recommendation-engine/pillar-impact';
import { evaluateRecAlignment } from '../services/recommendation-engine/alignment-evaluator';

/**
 * Phase 5 of the Ultimate Goal hardening (VTID-02935): when a recommendation
 * graduates to a VTID, emit an OASIS event reporting whether the rec advances
 * any mission dimension. The rec is "aligned" if it has a primary pillar OR a
 * non-'none' economic_axis. Pillar impact is derived from contribution_vector.
 *
 * NOT a hard block — visibility only. Future: graduation to a block once ≥80%
 * of activations in a 14-day window carry alignment fields. See
 * docs/GOVERNANCE/ULTIMATE-GOAL.md.
 */
async function emitAlignmentEventForActivation(params: {
  vtid: string;
  recId: string;
  recTitle: string;
  userId: string | null;
  supabaseUrl: string;
  svcKey: string;
}): Promise<void> {
  try {
    const recResp = await fetch(
      `${params.supabaseUrl}/rest/v1/autopilot_recommendations?id=eq.${params.recId}&select=economic_axis,autonomy_level,contribution_vector,source_type,source_ref,domain&limit=1`,
      { headers: { apikey: params.svcKey, Authorization: `Bearer ${params.svcKey}` } },
    );
    if (!recResp.ok) return;
    const rows = await recResp.json() as any[];
    const rec = rows[0];
    if (!rec) return;

    const evaluation = evaluateRecAlignment(rec);

    await emitOasisEvent({
      vtid: params.vtid,
      type: evaluation.topic,
      source: 'autopilot-recommendations',
      status: evaluation.status,
      message: evaluation.message,
      payload: {
        recommendation_id: params.recId,
        recommendation_title: params.recTitle,
        user_id: params.userId,
        pillar_impact: evaluation.pillar_impact,
        economic_axis: evaluation.economic_axis,
        autonomy_level: evaluation.autonomy_level,
        source_type: rec.source_type || null,
        source_ref: rec.source_ref || null,
        domain: rec.domain || null,
      },
    });
  } catch (err: any) {
    // Never let alignment telemetry break the activation path.
    console.warn(`[VTID-02935] emitAlignmentEventForActivation failed (non-fatal): ${err?.message || err}`);
  }
}

/**
 * Annotate an array of recommendation rows from get_autopilot_recommendations
 * with derived pillar_impact ({primary_pillar, magnitude}). Read-time derivation
 * from contribution_vector JSONB — see services/.../pillar-impact.ts.
 * Mutates each row in place (cheap and unambiguous for response payload use).
 */
function annotateWithPillarImpact<T extends { contribution_vector?: unknown }>(rows: T[]): Array<T & { pillar_impact: ReturnType<typeof derivePillarImpact> }> {
  return rows.map((row) => ({
    ...row,
    pillar_impact: derivePillarImpact(row.contribution_vector as Record<string, unknown> | null | undefined),
  }));
}

const router = Router();

const LOG_PREFIX = '[VTID-01180]';

// =============================================================================
// Community Action Map — signal_type → action for community user activation
// =============================================================================
interface CommunityAction {
  action_type: 'navigate' | 'notify';
  target?: string;
  completion_message: string;
  /** Intelligent Calendar: optional calendar event metadata for schedulable actions */
  calendar_event?: {
    title_template: string;
    duration_minutes: number;
    event_type: string;
    wellness_tags: string[];
  };
}

const COMMUNITY_ACTIONS: Record<string, CommunityAction> = {
  // Onboarding
  onboarding_profile:           { action_type: 'navigate', target: '/profile/edit', completion_message: 'Let\'s complete your profile!' },
  onboarding_avatar:            { action_type: 'navigate', target: '/profile/edit', completion_message: 'Add a photo so others can recognize you!' },
  onboarding_explore:           { action_type: 'navigate', target: '/community', completion_message: 'Discover your community!' },
  onboarding_interests:         { action_type: 'navigate', target: '/profile/edit', completion_message: 'Tell us what you\'re into!' },
  onboarding_maxina:            { action_type: 'navigate', target: '/chat', completion_message: 'Maxina is ready to chat!' },
  onboarding_diary:             { action_type: 'navigate', target: '/diary', completion_message: 'Time to write your first entry!' },
  onboarding_diary_day0:        { action_type: 'navigate', target: '/diary', completion_message: 'Start your well-being journal!' },
  onboarding_health:            { action_type: 'navigate', target: '/health', completion_message: 'See your health overview!' },
  onboarding_matches:           { action_type: 'navigate', target: '/matches', completion_message: 'Check out your matches!' },
  onboarding_discover_matches:  { action_type: 'navigate', target: '/matches', completion_message: 'See who you\'ve been matched with!' },
  onboarding_group:             { action_type: 'navigate', target: '/groups', completion_message: 'Find a group that fits you!' },
  // Engagement
  engage_matches:       { action_type: 'navigate', target: '/matches', completion_message: 'Your matches are waiting!' },
  engage_meetup:        { action_type: 'navigate', target: '/events', completion_message: 'Find a meetup near you!', calendar_event: { title_template: 'Attend a meetup', duration_minutes: 60, event_type: 'community', wellness_tags: ['social'] } },
  engage_health:        { action_type: 'navigate', target: '/health', completion_message: 'Check your health scores!', calendar_event: { title_template: 'Check health scores', duration_minutes: 15, event_type: 'health', wellness_tags: ['health-check'] } },
  deepen_connection:    { action_type: 'navigate', target: '/connections', completion_message: 'Reach out to a connection!', calendar_event: { title_template: 'Deepen a connection', duration_minutes: 30, event_type: 'personal', wellness_tags: ['social'] } },
  set_goal:             { action_type: 'navigate', target: '/?open=life_compass', completion_message: "Pick a direction — your goal will steer Vitana's recommendations.", calendar_event: { title_template: 'Open your Life Compass', duration_minutes: 10, event_type: 'personal', wellness_tags: ['mindfulness', 'mental'] } },
  invite_friend:        { action_type: 'navigate', target: '/invite', completion_message: 'Share Vitana with a friend!' },
  // Advanced
  share_expertise:      { action_type: 'navigate', target: '/groups', completion_message: 'Share your knowledge in a group!' },
  start_streak:         { action_type: 'navigate', target: '/diary', completion_message: 'Start your wellness streak!', calendar_event: { title_template: 'Start a wellness streak', duration_minutes: 15, event_type: 'health', wellness_tags: ['wellness'] } },
  // mentor_new and organize_meetup removed — not automatable by autopilot
  // Weakness-driven
  weakness_movement:    { action_type: 'navigate', target: '/health', completion_message: 'Let\'s get moving!', calendar_event: { title_template: 'Exercise session', duration_minutes: 30, event_type: 'workout', wellness_tags: ['movement'] } },
  weakness_stress:      { action_type: 'navigate', target: '/health', completion_message: 'Try a breathing exercise!', calendar_event: { title_template: 'Breathing exercise', duration_minutes: 15, event_type: 'health', wellness_tags: ['mindfulness', 'stress'] } },
  weakness_social:      { action_type: 'navigate', target: '/connections', completion_message: 'Say hello to someone!', calendar_event: { title_template: 'Social connection', duration_minutes: 15, event_type: 'personal', wellness_tags: ['social', 'community'] } },
  weakness_nutrition:   { action_type: 'navigate', target: '/health', completion_message: 'Track what you eat today!', calendar_event: { title_template: 'Track your meals', duration_minutes: 15, event_type: 'nutrition', wellness_tags: ['nutrition'] } },
  weakness_sleep:       { action_type: 'navigate', target: '/health', completion_message: 'Set up your evening routine!', calendar_event: { title_template: 'Evening routine', duration_minutes: 15, event_type: 'health', wellness_tags: ['sleep'] } },
  weakness_hydration:   { action_type: 'navigate', target: '/health', completion_message: 'Track your water intake today!', calendar_event: { title_template: 'Hydration check-in', duration_minutes: 10, event_type: 'health', wellness_tags: ['hydration'] } },
  weakness_mental:      { action_type: 'navigate', target: '/health', completion_message: 'A brief mindfulness moment.', calendar_event: { title_template: 'Mindfulness check-in', duration_minutes: 10, event_type: 'health', wellness_tags: ['mindfulness', 'mental'] } },
  // Mood-driven
  mood_support:         { action_type: 'navigate', target: '/chat', completion_message: 'Maxina is here to listen.' },
  mood_energy:          { action_type: 'navigate', target: '/events', completion_message: 'Use your energy on an activity!' },
  // Streak celebrations
  streak_celebration:   { action_type: 'notify', completion_message: 'Amazing streak! Keep it up!' },
  streak_continue:      { action_type: 'notify', completion_message: 'Great streak! Keep going!' },
};

// =============================================================================
// Helper: Supabase RPC call
// =============================================================================
async function callRpc<T>(
  functionName: string,
  params: Record<string, unknown>,
  authToken?: string
): Promise<{ ok: boolean; data?: T; error?: string; message?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': authToken ? `Bearer ${authToken}` : `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = await response.json() as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Helper: Extract user ID from request
// =============================================================================
function getUserId(req: Request): string | null {
  // @ts-ignore - user may be set by auth middleware
  if (req.user?.id) return req.user.id;
  // @ts-ignore - user may be set by auth middleware
  if (req.user?.sub) return req.user.sub;

  const headerUserId = req.get('X-User-ID') || req.get('X-Vitana-User');
  if (headerUserId) return headerUserId;

  const queryUserId = req.query.user_id as string;
  if (queryUserId) return queryUserId;

  return null;
}

// =============================================================================
// Helper: Extract active role from request
// =============================================================================
function getActiveRole(req: Request): string | null {
  return (req.query.role as string)
    || req.get('X-Vitana-Active-Role')
    || null;
}

// =============================================================================
// Helper: Direct PostgREST query for role-filtered recommendations
//
// VTID-02969: Exported so other voice / proactive surfaces (e.g.
// tool_send_chat_message → next_actions) can reuse the EXACT same query
// the Autopilot popup hits. There must be only one canonical "which
// recommendations does this user see" source.
// =============================================================================
export async function queryRecommendationsByRole(
  role: string,
  userId: string | null,
  statuses: string[],
  limit: number,
  offset: number,
): Promise<{ ok: boolean; data?: any[]; count?: number; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  const select = 'id,title,summary,domain,risk_level,impact_score,effort_score,status,activated_vtid,created_at,activated_at,time_estimate_seconds,source_ref,economic_axis,autonomy_level,contribution_vector';
  const params = new URLSearchParams();
  params.set('select', select);
  params.set('status', `in.(${statuses.join(',')})`);
  params.set('order', 'impact_score.desc,created_at.desc');
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  // Exclude snoozed recs
  params.append('or', '(snoozed_until.is.null,snoozed_until.lt.now())');

  if (role === 'community') {
    // Community role: only personal recs from community analyzer
    if (!userId) return { ok: true, data: [], count: 0 };
    params.set('user_id', `eq.${userId}`);
    params.set('source_type', 'eq.community');
  } else if (role === 'developer') {
    // Developer role: system-wide recs (user_id IS NULL), non-community source types
    params.set('user_id', 'is.null');
    params.set('source_type', 'neq.community');
  }
  // admin role or unknown: no extra filters (returns everything)

  try {
    const queryUrl = `${supabaseUrl}/rest/v1/autopilot_recommendations?${params.toString()}`;
    console.log(`${LOG_PREFIX} queryRecommendationsByRole PostgREST query:`, queryUrl.replace(supabaseKey!, '***'));
    const response = await fetch(
      queryUrl,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'count=exact',
        },
      },
    );
    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }
    const data = await response.json() as any[];
    const contentRange = response.headers.get('content-range');
    const totalCount = contentRange ? parseInt(contentRange.split('/')[1]) || data.length : data.length;
    return { ok: true, data, count: totalCount };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Helper: Fallback query — fetch by user_id only (no source_type filter)
// =============================================================================
async function queryRecommendationsFallback(
  userId: string,
  statuses: string[],
  limit: number,
  offset: number,
): Promise<{ ok: boolean; data?: any[]; count?: number; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  const select = 'id,title,summary,domain,risk_level,impact_score,effort_score,status,activated_vtid,created_at,activated_at,time_estimate_seconds,source_ref,source_type,user_id,economic_axis,autonomy_level,contribution_vector';
  const params = new URLSearchParams();
  params.set('select', select);
  params.set('status', `in.(${statuses.join(',')})`);
  params.set('order', 'impact_score.desc,created_at.desc');
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.append('or', '(snoozed_until.is.null,snoozed_until.lt.now())');
  params.set('user_id', `eq.${userId}`);

  try {
    const url = `${supabaseUrl}/rest/v1/autopilot_recommendations?${params.toString()}`;
    console.log(`${LOG_PREFIX} Fallback query URL: ${url.replace(supabaseKey, '***')}`);
    const response = await fetch(url, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'count=exact',
      },
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }
    const data = await response.json() as any[];
    const contentRange = response.headers.get('content-range');
    const totalCount = contentRange ? parseInt(contentRange.split('/')[1]) || data.length : data.length;
    return { ok: true, data, count: totalCount };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// GET /recommendations - List recommendations
// =============================================================================
/**
 * GET /recommendations
 *
 * Query params:
 * - status: comma-separated status filter (default: 'new')
 * - limit: max items (default: 20, max: 100)
 * - offset: pagination offset (default: 0)
 *
 * Response:
 * {
 *   ok: true,
 *   recommendations: [...],
 *   count: number,
 *   has_more: boolean
 * }
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const role = getActiveRole(req);

    // Parse query params
    const statusParam = req.query.status as string || 'new';
    const statuses = statusParam.split(',').map(s => s.trim());
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    console.log(`${LOG_PREFIX} Recommendations requested`, {
      status: statuses.join(','),
      limit,
      role: role || 'none',
      userId: userId || 'null',
      headers: {
        'X-Vitana-Active-Role': req.get('X-Vitana-Active-Role') || 'missing',
        'X-Vitana-User': req.get('X-Vitana-User') || 'missing',
        'X-User-ID': req.get('X-User-ID') || 'missing',
        'Authorization': req.get('Authorization') ? 'present' : 'missing',
      },
      reqUser: (req as any).user ? { id: (req as any).user?.id, sub: (req as any).user?.sub } : 'no req.user',
    });

    // Role-based filtering: query table directly (RPC lacks source_type/user_id columns)
    if (role) {
      // Fetch extra rows to account for duplicates that will be collapsed by dedup
      const fetchLimit = role === 'community' ? Math.max((limit + 1) * 4, 80) : limit + 1;
      const result = await queryRecommendationsByRole(role, userId, statuses, fetchLimit, offset);
      console.log(`${LOG_PREFIX} queryRecommendationsByRole result`, {
        ok: result.ok,
        count: result.data?.length ?? 0,
        totalCount: result.count ?? 0,
        error: result.error || 'none',
        role,
        userId: userId || 'null',
        statuses,
      });

      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
      }

      let recommendations = result.data || [];

      // Fallback: if community role returns empty but userId exists, try without source_type filter
      if (recommendations.length === 0 && role === 'community' && userId) {
        console.log(`${LOG_PREFIX} Community query returned 0 results, trying fallback without source_type filter`);
        const fallbackResult = await queryRecommendationsFallback(userId, statuses, limit + 1, offset);
        console.log(`${LOG_PREFIX} Fallback result`, {
          ok: fallbackResult.ok,
          count: fallbackResult.data?.length ?? 0,
          error: fallbackResult.error || 'none',
        });
        if (fallbackResult.ok && (fallbackResult.data?.length ?? 0) > 0) {
          recommendations = fallbackResult.data!;
        }
      }

      // Auto-generate: if community user still has 0 recommendations, generate them inline.
      // This handles first-time users (race condition with fire-and-forget in auth.ts),
      // existing users who never had recs generated, and day30+ users after old recs expired.
      // Also triggers when ALL returned recs are activated/completed (none are 'new') —
      // this is the case for the Lovable app which fetches status=new,activated.
      const hasNewRecs = recommendations.some((r: any) => r.status === 'new');
      if (!hasNewRecs && role === 'community' && userId) {
        console.log(`${LOG_PREFIX} No NEW recommendations for community user ${userId.slice(0, 8)} (total=${recommendations.length}, all activated/completed), auto-generating...`);
        try {
          const supabaseUrl = process.env.SUPABASE_URL;
          const svcKey = process.env.SUPABASE_SERVICE_ROLE;
          if (supabaseUrl && svcKey) {
            const { createClient } = await import('@supabase/supabase-js');
            const supa = createClient(supabaseUrl, svcKey);
            const { data: tenantRow } = await supa
              .from('user_tenants')
              .select('tenant_id')
              .eq('user_id', userId)
              .eq('is_primary', true)
              .maybeSingle();
            const tenantId = tenantRow?.tenant_id || process.env.DEFAULT_TENANT_ID;
            if (tenantId) {
              const genResult = await generatePersonalRecommendations(userId, tenantId, { trigger_type: 'auto_replenish' });
              console.log(`${LOG_PREFIX} Auto-replenishment result: generated=${genResult.generated}, dupes=${genResult.duplicates_skipped}`);
              // Re-fetch after generation
              if (genResult.generated > 0) {
                const freshResult = await queryRecommendationsByRole(role, userId, statuses, fetchLimit, offset);
                if (freshResult.ok && (freshResult.data?.length ?? 0) > 0) {
                  recommendations = freshResult.data!;
                }
              }
            }
          }
        } catch (genErr: any) {
          console.warn(`${LOG_PREFIX} Auto-generation failed (non-fatal): ${genErr.message}`);
        }
      }

      // Deduplicate by source_ref (signal_type) first, then by title as fallback.
      // Keep only one per key, preferring 'new' status over others.
      const beforeDedup = recommendations.length;
      const seen = new Map<string, any>();
      for (const rec of recommendations) {
        const key = rec.source_ref || rec.title;
        const existing = seen.get(key);
        if (!existing) {
          seen.set(key, rec);
        } else if (rec.status === 'new' && existing.status !== 'new') {
          seen.set(key, rec);
        }
      }
      // Also deduplicate by title (different source_ref but same display title)
      const seenTitles = new Set<string>();
      const deduped: any[] = [];
      for (const rec of seen.values()) {
        if (seenTitles.has(rec.title)) continue;
        seenTitles.add(rec.title);
        deduped.push(rec);
      }
      recommendations = deduped;
      if (recommendations.length < beforeDedup) {
        console.log(`${LOG_PREFIX} Deduplication: ${beforeDedup} → ${recommendations.length} (${beforeDedup - recommendations.length} duplicates removed)`);
      }

      // Filter out retired action types: only keep recs whose source_ref maps to
      // a valid COMMUNITY_ACTIONS entry (or has no source_ref at all).
      // This hides old DB rows like organize_meetup / mentor_new without needing a DB migration.
      if (role === 'community') {
        const beforeFilter = recommendations.length;
        recommendations = recommendations.filter(rec => !rec.source_ref || COMMUNITY_ACTIONS[rec.source_ref]);
        if (recommendations.length < beforeFilter) {
          console.log(`${LOG_PREFIX} Retired-action filter: ${beforeFilter} → ${recommendations.length} (${beforeFilter - recommendations.length} retired recs hidden)`);
        }
      }

      const hasMore = recommendations.length > limit;
      if (hasMore) recommendations.pop();

      // G4: Index-weighted re-rank for community surfaces. Applies pillar
      // gap + compass boost + journey-mode decay + G6 per-pillar quota.
      // Read path mirrors the /generate pipeline so the AutopilotPopup and
      // the voice ORB tool always see the same top pick.
      if (role === 'community' && userId && recommendations.length > 0) {
        try {
          const { buildRankerContext, rankBatch } = await import('../services/recommendation-engine/ranking/index-pillar-weighter');
          const { createClient } = await import('@supabase/supabase-js');
          const svc = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE
            ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE)
            : null;
          if (svc) {
            const ctx = await buildRankerContext(svc, userId);
            const ranked = rankBatch(recommendations as any, ctx);
            recommendations = ranked.map(r => r.rec as any);
            // Attach rank metadata for the UI ("why this now" tooltip).
            for (const r of ranked) {
              const target = (r.rec as any);
              if (target) {
                target.rank_score = r.rank_score;
                target.pillar_boost = r.pillar_boost;
                target.compass_boost = r.compass_boost;
                target.economic_boost = r.economic_boost;
                target.journey_mode = r.journey_mode;
              }
            }
          }
        } catch (rankErr: any) {
          console.warn(`${LOG_PREFIX} community re-rank failed (non-fatal):`, rankErr?.message);
        }
      }

      // Enrich community recommendations with wave metadata
      let waves: any[] | undefined;
      if (role === 'community') {
        const templateToWave = buildTemplateToWaveMap();
        for (const rec of recommendations) {
          if (rec.source_ref) {
            const waveId = templateToWave.get(rec.source_ref);
            if (waveId) {
              rec.wave_id = waveId;
              const waveDef = DEFAULT_WAVE_CONFIG.find(w => w.id === waveId);
              rec.wave_order = waveDef?.order ?? 99;
            }
          }
          if (!rec.wave_id) {
            rec.wave_id = 'wave-1';
            rec.wave_order = 1;
          }
          // Derive a stable `horizon` field for frontend bucketing on the My
          // Journey path. Source: wave timeline.start_day. Buckets the
          // frontend renders are: today / next3 / thisWeek / month / future.
          const waveDef = DEFAULT_WAVE_CONFIG.find(w => w.id === rec.wave_id);
          const startDay = waveDef?.timeline.start_day ?? 0;
          rec.horizon =
            startDay <= 0  ? 'today'    :
            startDay <= 3  ? 'next3'    :
            startDay <= 7  ? 'thisWeek' :
            startDay <= 30 ? 'month'    : 'future';
        }
        // Include enabled waves in response
        waves = DEFAULT_WAVE_CONFIG
          .filter(w => w.enabled)
          .map(w => ({
            id: w.id,
            name: w.name,
            description: w.description,
            icon: w.icon,
            order: w.order,
            is_initiative: w.is_initiative,
            timeline: w.timeline,
          }));
      }

      return res.status(200).json({
        ok: true,
        recommendations: annotateWithPillarImpact(recommendations),
        count: recommendations.length,
        has_more: hasMore,
        ...(waves ? { waves } : {}),
        vtid: 'VTID-01180',
        timestamp: new Date().toISOString(),
        _debug: {
          role,
          userId: userId || null,
          queryPath: 'role-based',
          fallbackUsed: result.data?.length === 0 && recommendations.length > 0,
        },
      });
    }

    // No role specified: backward-compatible RPC path (Command Hub default)
    console.log(`${LOG_PREFIX} Using RPC fallback path (no role)`, { userId: userId || 'null', statuses });
    const result = await callRpc<any[]>('get_autopilot_recommendations', {
      p_status: statuses,
      p_limit: limit + 1,
      p_offset: offset,
      p_user_id: userId,
    });
    console.log(`${LOG_PREFIX} RPC result`, { ok: result.ok, count: (result.data as any[])?.length ?? 0, error: result.error || 'none' });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const recommendations = result.data || [];
    const hasMore = recommendations.length > limit;
    if (hasMore) {
      recommendations.pop();
    }

    return res.status(200).json({
      ok: true,
      recommendations: annotateWithPillarImpact(recommendations),
      count: recommendations.length,
      has_more: hasMore,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
      _debug: {
        role: null,
        userId: userId || null,
        queryPath: 'rpc',
      },
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} List recommendations error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// GET /recommendations/count - Get count for badge
// =============================================================================
/**
 * GET /recommendations/count
 *
 * Response:
 * {
 *   ok: true,
 *   count: number
 * }
 */
router.get('/count', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const role = getActiveRole(req);

    console.log(`${LOG_PREFIX} Recommendations count requested`, { role: role || 'none', userId: userId || 'null' });

    // Role-based count: query table directly with same filters
    if (role) {
      const result = await queryRecommendationsByRole(role, userId, ['new'], 0, 0);
      const count = result.ok ? (result.count || 0) : 0;
      console.log(`${LOG_PREFIX} Count result (role-based)`, { role, userId: userId || 'null', count, ok: result.ok, error: result.error || 'none' });
      return res.status(200).json({
        ok: true,
        count,
        vtid: 'VTID-01180',
        timestamp: new Date().toISOString(),
        _debug: { role, userId: userId || null, queryPath: 'role-based' },
      });
    }

    // No role: backward-compatible RPC path
    const result = await callRpc<number>('get_autopilot_recommendations_count', {
      p_user_id: userId,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.status(200).json({
      ok: true,
      count: result.data || 0,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Count error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /recommendations/generate-personal - Generate per-user personalized recs
// =============================================================================
/**
 * POST /recommendations/generate-personal
 *
 * Generates personalized community recommendations for the authenticated user.
 * Uses the Community User Analyzer to assess onboarding stage, health scores,
 * diary mood, connections, and more.
 *
 * Body:
 * {
 *   force?: boolean // Force regeneration even if recently run
 * }
 *
 * Response:
 * {
 *   ok: true,
 *   generated: 5,
 *   duplicates_skipped: 2,
 *   run_id: "rec-gen-...",
 *   duration_ms: 1200
 * }
 */
router.post('/generate-personal', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'User ID required' });
    }

    console.log(`${LOG_PREFIX} Personal generation requested for ${userId.slice(0, 8)}`);

    // Get tenant ID for the user
    const supabaseUrl = process.env.SUPABASE_URL;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    if (!supabaseUrl || !svcKey) {
      return res.status(503).json({ ok: false, error: 'Supabase not configured' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supa = createClient(supabaseUrl, svcKey);
    const { data: tenantRow } = await supa
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', userId)
      .eq('is_primary', true)
      .maybeSingle();

    const tenantId = tenantRow?.tenant_id || process.env.DEFAULT_TENANT_ID;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'No tenant found for user' });
    }

    const result = await generatePersonalRecommendations(userId, tenantId, {
      trigger_type: 'manual',
    });

    return res.status(result.ok ? 200 : 500).json({
      ...result,
      vtid: 'VTID-01185',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Personal generation error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /recommendations/:id/activate - Activate recommendation (creates VTID)
// =============================================================================
/**
 * POST /recommendations/:id/activate
 *
 * Creates a VTID task card with spec snapshot from the recommendation.
 * Idempotent: If already activated, returns existing VTID.
 *
 * Response:
 * {
 *   ok: true,
 *   vtid: "VTID-XXXXX",
 *   recommendation_id: "...",
 *   title: "...",
 *   status: "activated",
 *   activated_at: "...",
 *   spec_checksum: "...",
 *   already_activated?: boolean
 * }
 */
router.post('/:id/activate', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const role = getActiveRole(req);
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    console.log(`${LOG_PREFIX} Activating recommendation ${id.slice(0, 8)}... (role: ${role || 'none'})`);

    // =========================================================================
    // Community activation path — NO VTIDs, returns action for frontend
    // =========================================================================
    if (role === 'community') {
      const supabaseUrl = process.env.SUPABASE_URL;
      const svcKey = process.env.SUPABASE_SERVICE_ROLE;
      if (!supabaseUrl || !svcKey) {
        return res.status(503).json({ ok: false, error: 'Supabase not configured' });
      }

      // Fetch the recommendation to get source_type, source_ref, user_id, status
      const recResp = await fetch(
        `${supabaseUrl}/rest/v1/autopilot_recommendations?id=eq.${id}&select=id,title,summary,source_type,source_ref,user_id,status,domain&limit=1`,
        { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
      );
      if (!recResp.ok) {
        return res.status(400).json({ ok: false, error: 'Failed to fetch recommendation' });
      }
      const recRows = await recResp.json() as any[];
      const rec = recRows[0];
      if (!rec) {
        return res.status(404).json({ ok: false, error: 'Recommendation not found' });
      }

      // Verify this is a community recommendation belonging to this user
      if (rec.source_type !== 'community') {
        return res.status(403).json({ ok: false, error: 'Not a community recommendation' });
      }
      if (rec.user_id && userId && rec.user_id !== userId) {
        return res.status(403).json({ ok: false, error: 'Recommendation belongs to another user' });
      }

      // Already activated? Return idempotent response
      if (rec.status === 'activated') {
        const action = COMMUNITY_ACTIONS[rec.source_ref] || null;
        return res.status(200).json({
          ok: true,
          already_activated: true,
          recommendation_id: id,
          title: rec.title,
          action_type: action?.action_type || 'notify',
          target: action?.target || null,
          completion_message: action?.completion_message || 'Already done!',
          vtid: 'VTID-01180',
          timestamp: new Date().toISOString(),
        });
      }

      // Must be in activatable state
      if (rec.status !== 'new' && rec.status !== 'snoozed') {
        return res.status(400).json({ ok: false, error: `Cannot activate recommendation in status: ${rec.status}` });
      }

      // Look up the community action
      const action = COMMUNITY_ACTIONS[rec.source_ref] || {
        action_type: 'notify' as const,
        completion_message: 'Done!',
      };

      // Update recommendation status to 'activated' via PostgREST — NO VTID
      const patchResp = await fetch(
        `${supabaseUrl}/rest/v1/autopilot_recommendations?id=eq.${id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: svcKey,
            Authorization: `Bearer ${svcKey}`,
          },
          body: JSON.stringify({
            status: 'activated',
            activated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        }
      );
      if (!patchResp.ok) {
        console.error(`${LOG_PREFIX} Community activate PATCH failed:`, await patchResp.text());
        return res.status(500).json({ ok: false, error: 'Failed to update recommendation status' });
      }

      // Intelligent Calendar: create calendar event for schedulable actions
      let calendarEvent = null;
      if (action.calendar_event && userId) {
        try {
          const { computeNextAvailableSlot, createCalendarEvent } = await import('../services/calendar-service');
          const slot = await computeNextAvailableSlot(userId, 'community', action.calendar_event.duration_minutes);
          const endSlot = new Date(slot.getTime() + action.calendar_event.duration_minutes * 60 * 1000);
          calendarEvent = await createCalendarEvent(userId, {
            title: action.calendar_event.title_template || rec.title,
            description: rec.summary || action.completion_message,
            start_time: slot.toISOString(),
            end_time: endSlot.toISOString(),
            event_type: action.calendar_event.event_type,
            status: 'confirmed',
            priority: 'medium',
            role_context: 'community',
            source_type: 'autopilot',
            source_ref_id: id,
            source_ref_type: 'autopilot_recommendation',
            priority_score: 60,
            wellness_tags: action.calendar_event.wellness_tags,
            metadata: { recommendation_title: rec.title, source_ref: rec.source_ref },
          } as any);
          if (calendarEvent) {
            console.log(`${LOG_PREFIX} Calendar event created for recommendation ${id.slice(0, 8)}... → ${calendarEvent.id.slice(0, 8)}...`);
          }
        } catch (calErr: any) {
          console.warn(`${LOG_PREFIX} Calendar event creation failed (non-fatal): ${calErr.message}`);
        }
      }

      // Emit OASIS event
      await emitOasisEvent({
        vtid: 'SYSTEM',
        type: 'autopilot.recommendation.activated' as any,
        source: 'autopilot-recommendations',
        status: 'info',
        message: `Community recommendation activated: ${rec.title}`,
        payload: {
          recommendation_id: id,
          user_id: userId,
          role: 'community',
          action_type: action.action_type,
          target: action.target || null,
          source_ref: rec.source_ref,
          calendar_event_id: calendarEvent?.id || null,
        },
      });

      // Send push notification
      if (userId) {
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const supa = createClient(supabaseUrl, svcKey);
          const { data: tenantRow } = await supa
            .from('user_tenants')
            .select('tenant_id')
            .eq('user_id', userId)
            .eq('is_primary', true)
            .maybeSingle();
          if (tenantRow?.tenant_id) {
            notifyUserAsync(userId, tenantRow.tenant_id, 'recommendation_activated', {
              title: rec.title,
              body: action.completion_message,
              data: { url: action.target || '/', recommendation_id: id },
            }, supa);
          }
        } catch (notifErr: any) {
          console.warn(`${LOG_PREFIX} Notification error (non-fatal): ${notifErr.message}`);
        }
      }

      console.log(`${LOG_PREFIX} Community activation: ${rec.source_ref} → ${action.action_type}:${action.target || 'none'}`);

      // Auto-replenishment: check if user has any remaining 'new' recs.
      // If this was the last one, trigger generation of fresh recommendations.
      let replenished = 0;
      if (userId) {
        try {
          const remainingResp = await fetch(
            `${supabaseUrl}/rest/v1/autopilot_recommendations?user_id=eq.${userId}&status=eq.new&select=id&limit=1`,
            { headers: { apikey: svcKey!, Authorization: `Bearer ${svcKey}` } }
          );
          const remainingRows = remainingResp.ok ? await remainingResp.json() as any[] : [];
          if (remainingRows.length === 0) {
            console.log(`${LOG_PREFIX} Last community rec activated for user ${userId.slice(0, 8)} — triggering auto-replenishment`);
            const tenantId = req.get('X-Vitana-Tenant') || '';
            const authToken = req.get('Authorization')?.replace('Bearer ', '') || '';
            const { generatePersonalRecommendations: genPersonal } = await import('../services/recommendation-engine');
            const genResult = await genPersonal(userId, tenantId, { trigger_type: 'auto_replenish' });
            replenished = genResult?.generated || 0;
            console.log(`${LOG_PREFIX} Auto-replenishment generated ${replenished} new recommendations`);
          }
        } catch (replenishErr: any) {
          console.warn(`${LOG_PREFIX} Auto-replenishment failed (non-fatal): ${replenishErr.message}`);
        }
      }

      return res.status(200).json({
        ok: true,
        recommendation_id: id,
        title: rec.title,
        status: 'activated',
        activated_at: new Date().toISOString(),
        action_type: action.action_type,
        target: action.target || null,
        completion_message: action.completion_message,
        replenished,
        vtid: 'VTID-01180',
        timestamp: new Date().toISOString(),
      });
    }

    // =========================================================================
    // Developer/Admin activation path — creates VTID (existing behavior)
    // =========================================================================
    const result = await callRpc<any>('activate_autopilot_recommendation', {
      p_recommendation_id: id,
      p_user_id: userId,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const response = result.data;
    if (!response?.ok) {
      return res.status(400).json({ ok: false, error: response?.error || 'Failed to activate' });
    }

    // Emit OASIS event for tracking
    await emitOasisEvent({
      vtid: response.vtid || 'SYSTEM',
      type: 'autopilot.recommendation.activated',
      source: 'autopilot-recommendations',
      status: 'info',
      message: `Recommendation activated: ${response.title}`,
      payload: {
        recommendation_id: id,
        vtid: response.vtid,
        user_id: userId,
        already_activated: response.already_activated,
      },
    });

    // VTID-02935 Phase 5: emit alignment telemetry for fresh activations only.
    // Skip already-activated calls (idempotent re-tries don't change alignment
    // state). Pillar impact is derived from contribution_vector at read time.
    if (!response.already_activated && response.vtid) {
      const supabaseUrlForAlign = process.env.SUPABASE_URL;
      const svcKeyForAlign = process.env.SUPABASE_SERVICE_ROLE;
      if (supabaseUrlForAlign && svcKeyForAlign) {
        await emitAlignmentEventForActivation({
          vtid: response.vtid,
          recId: id,
          recTitle: response.title || '',
          userId: userId || null,
          supabaseUrl: supabaseUrlForAlign,
          svcKey: svcKeyForAlign,
        });
      }
    }

    // Create draft spec in oasis_specs from recommendation data so the task
    // enters the spec pipeline with content ready for validate → approve flow
    if (!response.already_activated && response.vtid) {
      try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const svcKey = process.env.SUPABASE_SERVICE_ROLE;
        if (supabaseUrl && svcKey) {
          // Fetch recommendation to get full data (summary, domain, risk_level)
          const recResp = await fetch(
            `${supabaseUrl}/rest/v1/autopilot_recommendations?id=eq.${id}&select=title,summary,domain,risk_level,impact_score,effort_score,spec_snapshot&limit=1`,
            { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
          );
          const recRows = recResp.ok ? await recResp.json() as any[] : [];
          const rec = recRows[0];

          if (rec) {
            const vtid = response.vtid;
            const snapshot = rec.spec_snapshot || {};

            // Build markdown spec from recommendation data
            const specMarkdown = [
              `# ${rec.title}`,
              '',
              `**VTID:** ${vtid}`,
              '',
              '---',
              '',
              '## 1. Goal',
              '',
              rec.summary || 'TBD',
              '',
              '---',
              '',
              '## 2. Non-negotiable Governance Rules Touched',
              '',
              (snapshot.non_negotiables || ['Safety check required', 'User consent required'])
                .map((r: string) => `- ${r}`).join('\n'),
              '',
              '---',
              '',
              '## 3. Scope',
              '',
              '### IN SCOPE',
              (snapshot.scope_in || [rec.domain]).map((s: string) => `- ${s}`).join('\n'),
              '',
              '### OUT OF SCOPE',
              (snapshot.scope_out || []).length > 0
                ? snapshot.scope_out.map((s: string) => `- ${s}`).join('\n')
                : '- TBD',
              '',
              '---',
              '',
              '## 4. Changes',
              '',
              '### 4.1 Database Migrations (SQL)',
              'TBD — to be detailed during implementation',
              '',
              '### 4.2 APIs (Routes, Request/Response)',
              'TBD — to be detailed during implementation',
              '',
              '### 4.3 UI Changes (Screens, States)',
              'TBD — to be detailed during implementation',
              '',
              '---',
              '',
              '## 5. Files to Modify',
              '',
              (snapshot.files_expected || []).length > 0
                ? snapshot.files_expected.map((f: string) => `- \`${f}\``).join('\n')
                : 'TBD — to be identified during implementation',
              '',
              '---',
              '',
              '## 6. Acceptance Criteria',
              '',
              (snapshot.definition_of_done || ['Implementation complete', 'Tests passing'])
                .map((c: string, i: number) => `${i + 1}. ${c}`).join('\n'),
              '',
              '---',
              '',
              '## 7. Verification Steps',
              '',
              '### 7.1 curl Calls',
              'TBD — to be defined during implementation',
              '',
              '### 7.2 UI Checks',
              'TBD — to be defined during implementation',
              '',
              '---',
              '',
              '## 8. Rollback Plan',
              '',
              'Revert the commit and redeploy. No data migration required.',
              '',
              '---',
              '',
              '## 9. Risk Level',
              '',
              `**${(rec.risk_level || 'low').toUpperCase()}** (Impact: ${rec.impact_score || '?'}/10, Effort: ${rec.effort_score || '?'}/10)`,
              '',
              `> Source: Autopilot recommendation (domain: ${rec.domain || 'general'})`,
            ].join('\n');

            const specHash = createHash('sha256').update(specMarkdown).digest('hex');

            // Insert into oasis_specs
            const insertResp = await fetch(`${supabaseUrl}/rest/v1/oasis_specs`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: svcKey,
                Authorization: `Bearer ${svcKey}`,
                Prefer: 'return=representation',
              },
              body: JSON.stringify({
                vtid,
                version: 1,
                title: rec.title,
                spec_markdown: specMarkdown,
                spec_hash: specHash,
                status: 'draft',
                created_by: 'autopilot',
              }),
            });

            if (insertResp.ok) {
              const specData = await insertResp.json() as any[];
              const newSpec = specData[0];

              // Update vtid_ledger with spec reference
              await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  apikey: svcKey,
                  Authorization: `Bearer ${svcKey}`,
                },
                body: JSON.stringify({
                  spec_status: 'draft',
                  spec_current_id: newSpec.id,
                  spec_current_hash: specHash,
                  spec_last_error: null,
                  updated_at: new Date().toISOString(),
                }),
              });

              console.log(`${LOG_PREFIX} Spec created for ${vtid}: hash=${specHash.substring(0, 8)}...`);
            } else {
              console.error(`${LOG_PREFIX} Failed to create spec for ${vtid}:`, await insertResp.text());
            }
          }
        }
      } catch (specErr: any) {
        // Non-fatal: VTID was created, spec can be generated manually
        console.error(`${LOG_PREFIX} Spec creation failed (non-fatal):`, specErr.message);
      }
    }

    // Bridge dev_autopilot* activations into the executor (cooldown skipped).
    // Without this, "Activate" only writes the vtid_ledger row and the card
    // sits in IN PROGRESS forever — there is no other code path that picks
    // up vtid_ledger rows for these findings. The reaper tick in
    // dev-autopilot-execute.ts catches any failures from this fire-and-forget
    // call. Fire-and-forget on purpose so a slow LLM plan generation doesn't
    // block the activate response.
    if (!response.already_activated && response.vtid) {
      try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const svcKey = process.env.SUPABASE_SERVICE_ROLE;
        if (supabaseUrl && svcKey) {
          const srcResp = await fetch(
            `${supabaseUrl}/rest/v1/autopilot_recommendations?id=eq.${id}&select=source_type&limit=1`,
            { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
          );
          const srcRows = srcResp.ok ? await srcResp.json() as Array<{ source_type: string }> : [];
          const srcType = srcRows[0]?.source_type;
          if (srcType === 'dev_autopilot' || srcType === 'dev_autopilot_impact') {
            const { bridgeActivationToExecution } = await import('../services/dev-autopilot-execute');
            bridgeActivationToExecution(id, userId || null)
              .then((br) => {
                if (br.ok) {
                  console.log(`${LOG_PREFIX} Bridged ${id.slice(0, 8)} → execution ${br.execution_id?.slice(0, 8) || '?'} (${br.skipped || 'enqueued'})`);
                } else {
                  console.warn(`${LOG_PREFIX} Bridge failed for ${id.slice(0, 8)}: ${br.error}`);
                }
              })
              .catch((bridgeErr: any) => {
                console.error(`${LOG_PREFIX} Bridge error for ${id.slice(0, 8)}: ${bridgeErr.message}`);
              });
          }
        }
      } catch (bridgeErr: any) {
        console.error(`${LOG_PREFIX} Bridge dispatch error (non-fatal):`, bridgeErr.message);
      }
    }

    return res.status(200).json({
      ...response,
      vtid_ref: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Activate error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /recommendations/:id/reject - Reject/dismiss recommendation
// =============================================================================
/**
 * POST /recommendations/:id/reject
 *
 * Body:
 * {
 *   reason?: string // Optional reason for rejection
 * }
 */
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    console.log(`${LOG_PREFIX} Rejecting recommendation ${id.slice(0, 8)}...`);

    const result = await callRpc<any>('reject_autopilot_recommendation', {
      p_recommendation_id: id,
      p_reason: reason || null,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const response = result.data;
    if (!response?.ok) {
      return res.status(400).json({ ok: false, error: response?.error || 'Failed to reject' });
    }

    return res.status(200).json({
      ...response,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Reject error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /recommendations/:id/snooze - Snooze for later
// =============================================================================
/**
 * POST /recommendations/:id/snooze
 *
 * Body:
 * {
 *   hours?: number // Hours to snooze (default: 24)
 * }
 */
router.post('/:id/snooze', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const hours = Math.min(Math.max(parseInt(req.body.hours) || 24, 1), 168); // 1-168 hours (1 week max)

    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    console.log(`${LOG_PREFIX} Snoozing recommendation ${id.slice(0, 8)}... for ${hours} hours`);

    const result = await callRpc<any>('snooze_autopilot_recommendation', {
      p_recommendation_id: id,
      p_hours: hours,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const response = result.data;
    if (!response?.ok) {
      return res.status(400).json({ ok: false, error: response?.error || 'Failed to snooze' });
    }

    return res.status(200).json({
      ...response,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Snooze error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// VTID-01185: POST /recommendations/generate - Trigger recommendation generation
// =============================================================================
/**
 * POST /recommendations/generate
 *
 * Triggers recommendation generation from analyzers.
 * Admin-only endpoint.
 *
 * Body:
 * {
 *   sources?: string[] // ['codebase', 'oasis', 'health', 'roadmap'] - default all
 *   limit?: number     // Max recommendations to generate (default 20)
 *   force?: boolean    // Regenerate even if recently run
 * }
 *
 * Response:
 * {
 *   ok: true,
 *   generated: 15,
 *   duplicates_skipped: 3,
 *   run_id: "rec-gen-2026-01-17-001",
 *   duration_ms: 45000
 * }
 */
router.post('/generate', async (req: Request, res: Response) => {
  const LOG = '[VTID-01185]';

  try {
    const userId = getUserId(req);
    const {
      sources = ['codebase', 'oasis', 'health', 'roadmap'],
      limit = 20,
      force = false,
    } = req.body;

    // Validate sources
    const validSources: SourceType[] = ['codebase', 'oasis', 'health', 'roadmap', 'llm', 'behavior'];
    const requestedSources = (Array.isArray(sources) ? sources : [sources]).filter(
      (s: string) => validSources.includes(s as SourceType)
    ) as SourceType[];

    if (requestedSources.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No valid sources specified',
        valid_sources: validSources,
      });
    }

    console.log(`${LOG} Generation requested by ${userId || 'anonymous'} - sources: ${requestedSources.join(', ')}`);

    // Emit start event
    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: 'autopilot.recommendation.generation.started' as any,
      source: 'recommendation-engine',
      status: 'info',
      message: `Recommendation generation started (sources: ${requestedSources.join(', ')})`,
      payload: {
        sources: requestedSources,
        limit,
        force,
        triggered_by: userId,
      },
    });

    // Get base path from environment or use default
    const basePath = process.env.VITANA_BASE_PATH || '/home/user/vitana-platform';

    // Run generation
    const result = await generateRecommendations(basePath, {
      sources: requestedSources,
      limit: Math.min(Math.max(limit, 1), 50),
      force,
      triggered_by: userId || 'api',
      trigger_type: 'manual',
    });

    // Emit completion event
    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: result.ok
        ? ('autopilot.recommendation.generation.completed' as any)
        : ('autopilot.recommendation.generation.failed' as any),
      source: 'recommendation-engine',
      status: result.ok ? 'success' : 'error',
      message: result.ok
        ? `Generated ${result.generated} recommendations (${result.duplicates_skipped} duplicates skipped)`
        : `Generation failed: ${result.errors[0]?.error || 'Unknown error'}`,
      payload: {
        run_id: result.run_id,
        generated: result.generated,
        duplicates_skipped: result.duplicates_skipped,
        duration_ms: result.duration_ms,
        errors: result.errors,
      },
    });

    // Notify user about new recommendations
    if (result.ok && result.generated > 0 && userId) {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
        const { data: tenantRow } = await supa
          .from('user_tenants')
          .select('tenant_id')
          .eq('user_id', userId)
          .eq('is_primary', true)
          .single();
        if (tenantRow?.tenant_id) {
          notifyUserAsync(userId, tenantRow.tenant_id, 'new_recommendation', {
            title: `${result.generated} new recommendation${result.generated > 1 ? 's' : ''}`,
            body: 'Autopilot found new actions to improve your wellbeing.',
            data: { url: '/autopilot', count: String(result.generated) },
          }, supa);

          // BOOTSTRAP-NOTIF-SYSTEM-EVENTS: surface the highest-impact rec
          // from this run as a P0 push so users see critical
          // recommendations even outside the in-app inbox. Threshold of 8+
          // matches the engine's reserved tier (see recommendation-
          // generator impact_score mapping where 8 is "strong signal").
          const { data: highImpact } = await supa
            .from('autopilot_recommendations')
            .select('id, title, summary, impact_score')
            .eq('user_id', userId)
            .eq('tenant_id', tenantRow.tenant_id)
            .gte('impact_score', 8)
            .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
            .order('impact_score', { ascending: false })
            .limit(1);
          const topRec = highImpact?.[0];
          if (topRec) {
            notifyUserAsync(userId, tenantRow.tenant_id, 'high_impact_recommendation', {
              title: topRec.title || 'High-impact recommendation',
              body: topRec.summary || 'Autopilot flagged a high-impact action for you.',
              data: {
                url: `/autopilot?rec=${topRec.id}`,
                entity_id: topRec.id,
                recommendation_id: topRec.id,
                impact_score: String(topRec.impact_score ?? ''),
              },
            }, supa);
          }
        }
      } catch (notifErr: any) {
        console.warn(`[Notifications] new_recommendation dispatch error: ${notifErr.message}`);
      }
    }

    return res.status(result.ok ? 200 : 500).json({
      ...result,
      vtid: 'VTID-01185',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG} Generation error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// VTID-01185: GET /recommendations/sources - Get analyzer source status
// =============================================================================
/**
 * GET /recommendations/sources
 *
 * Returns available analysis sources and their status.
 *
 * Response:
 * {
 *   ok: true,
 *   sources: [
 *     { type: 'codebase', status: 'ready', last_scan: '2026-01-17T10:00:00Z', files_scanned: 1523 },
 *     { type: 'oasis', status: 'ready', last_scan: '2026-01-17T12:00:00Z', events_analyzed: 50000 },
 *     { type: 'health', status: 'ready', last_scan: '2026-01-17T11:00:00Z', checks_run: 45 },
 *     { type: 'roadmap', status: 'ready', last_scan: '2026-01-17T09:00:00Z', specs_found: 23 }
 *   ]
 * }
 */
router.get('/sources', async (_req: Request, res: Response) => {
  const LOG = '[VTID-01185]';

  try {
    console.log(`${LOG} Sources status requested`);

    const result = await callRpc<any[]>('get_autopilot_analyzer_sources', {});

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const sources = (result.data || []).map((s: any) => ({
      type: s.source_type,
      status: s.status,
      enabled: s.enabled,
      last_scan: s.last_scan_at,
      last_scan_duration_ms: s.last_scan_duration_ms,
      items_scanned: s.items_scanned,
      items_found: s.items_found,
      recommendations_generated: s.recommendations_generated,
      last_error: s.last_error,
      config: s.config,
    }));

    return res.status(200).json({
      ok: true,
      sources,
      vtid: 'VTID-01185',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG} Sources error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// VTID-01185: GET /recommendations/history - Get generation run history
// =============================================================================
/**
 * GET /recommendations/history
 *
 * Returns generation history.
 *
 * Query params:
 * - limit: max items (default: 20, max: 100)
 * - offset: pagination offset (default: 0)
 * - trigger_type: filter by trigger type (manual, scheduled, pr_merge, webhook)
 *
 * Response:
 * {
 *   ok: true,
 *   runs: [
 *     { run_id: "rec-gen-2026-01-17-001", timestamp: "...", generated: 15, duration_ms: 45000 },
 *     { run_id: "rec-gen-2026-01-16-001", timestamp: "...", generated: 8, duration_ms: 32000 }
 *   ]
 * }
 */
router.get('/history', async (req: Request, res: Response) => {
  const LOG = '[VTID-01185]';

  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const triggerType = req.query.trigger_type as string || null;

    console.log(`${LOG} History requested (limit: ${limit}, offset: ${offset})`);

    const result = await callRpc<any[]>('get_autopilot_recommendation_history', {
      p_limit: limit + 1,
      p_offset: offset,
      p_trigger_type: triggerType,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const runs = result.data || [];
    const hasMore = runs.length > limit;
    if (hasMore) {
      runs.pop();
    }

    return res.status(200).json({
      ok: true,
      runs: runs.map((r: any) => ({
        run_id: r.run_id,
        status: r.status,
        trigger_type: r.trigger_type,
        triggered_by: r.triggered_by,
        sources: r.sources,
        recommendations_generated: r.recommendations_generated,
        duplicates_skipped: r.duplicates_skipped,
        errors_count: r.errors_count,
        duration_ms: r.duration_ms,
        started_at: r.started_at,
        completed_at: r.completed_at,
        analysis_summary: r.analysis_summary,
      })),
      count: runs.length,
      has_more: hasMore,
      vtid: 'VTID-01185',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG} History error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// GET /recommendations/health - Health check
// =============================================================================
// =============================================================================
// POST /recommendations/:id/complete - Mark recommendation as fully completed
// =============================================================================
/**
 * POST /recommendations/:id/complete
 *
 * Called by the frontend when a user has actually completed the recommended action
 * (e.g., finished editing profile, wrote first diary entry, joined a group).
 * This differs from "activate" which just means the user clicked to start the action.
 *
 * Community users only. Updates status from 'activated' to a completed marker,
 * emits an OASIS event for tracking, and optionally rewards the user.
 */
router.post('/:id/complete', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'User ID required' });
    }

    const recId = req.params.id;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ ok: false, error: 'Missing Supabase credentials' });
    }

    // Fetch the recommendation
    const fetchResp = await fetch(
      `${supabaseUrl}/rest/v1/autopilot_recommendations?id=eq.${recId}&user_id=eq.${userId}&select=id,status,source_ref,title`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      },
    );
    const recs = await fetchResp.json() as any[];
    const rec = recs?.[0];
    if (!rec) {
      return res.status(404).json({ ok: false, error: 'Recommendation not found' });
    }

    if (rec.status !== 'activated') {
      return res.status(400).json({ ok: false, error: `Cannot complete recommendation in status: ${rec.status}` });
    }

    // Update status to 'completed' with completion timestamp in metadata
    const patchResp = await fetch(
      `${supabaseUrl}/rest/v1/autopilot_recommendations?id=eq.${recId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          status: 'completed',
          metadata: {
            completed_at: new Date().toISOString(),
            completed_by: userId,
          },
        }),
      },
    );

    if (!patchResp.ok) {
      console.error(`${LOG_PREFIX} Community complete PATCH failed:`, await patchResp.text());
      return res.status(500).json({ ok: false, error: 'Failed to mark as completed' });
    }

    // Emit OASIS event
    try {
      await emitOasisEvent({
        vtid: 'VTID-01180',
        type: 'autopilot.recommendation.completed' as any,
        source: 'autopilot-recommendations',
        status: 'info',
        message: `Community recommendation completed: ${rec.title}`,
        payload: {
          recommendation_id: recId,
          user_id: userId,
          source_ref: rec.source_ref,
          title: rec.title,
        },
      });
    } catch (e) {
      console.warn(`${LOG_PREFIX} Failed to emit completion event:`, e);
    }

    // Look up tenant for notification
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: tenantRow } = await supabase
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', userId)
      .eq('is_primary', true)
      .maybeSingle();

    // Check if user earned a reward for this action
    const signalType = rec.source_ref;
    const isOnboardingAction = signalType?.startsWith('onboarding_');
    if (isOnboardingAction && tenantRow?.tenant_id) {
      // Credit small reward for completing onboarding tasks
      try {
        await supabase.rpc('credit_wallet', {
          p_tenant_id: tenantRow.tenant_id,
          p_user_id: userId,
          p_amount: 10,
          p_type: 'reward',
          p_source: 'recommendation_complete',
          p_source_event_id: `rec_complete_${recId}`,
          p_description: `Completed: ${rec.title}`,
        });
      } catch {
        // Best-effort; may fail if duplicate
      }
    }

    // Emit milestone event if all day-0 onboarding tasks are completed
    if (isOnboardingAction && tenantRow?.tenant_id) {
      const { data: remaining } = await supabase
        .from('autopilot_recommendations')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'activated')
        .like('source_ref', 'onboarding_%');

      if (!remaining || remaining.length === 0) {
        try {
          await emitOasisEvent({
            vtid: 'VTID-01180',
            type: 'user.milestone.reached' as any,
            source: 'autopilot-recommendations',
            status: 'info',
            message: 'User completed all onboarding recommendations',
            payload: {
              user_id: userId,
              milestone: 'onboarding_complete',
              tenant_id: tenantRow.tenant_id,
            },
          });
        } catch {
          // Best-effort
        }
      }
    }

    return res.status(200).json({
      ok: true,
      status: 'completed',
      completed_at: new Date().toISOString(),
      reward: isOnboardingAction ? 10 : 0,
    });

  } catch (err: any) {
    console.error(`${LOG_PREFIX} Error completing recommendation:`, err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'autopilot-recommendations',
    vtid: 'VTID-01180',
    version: '2.1.0',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /recommendations',
      'GET /recommendations/count',
      'POST /recommendations/:id/activate',
      'POST /recommendations/:id/complete',
      'POST /recommendations/:id/reject',
      'POST /recommendations/:id/snooze',
      'POST /recommendations/generate',
      'GET /recommendations/sources',
      'GET /recommendations/history',
    ],
  });
});

export default router;
