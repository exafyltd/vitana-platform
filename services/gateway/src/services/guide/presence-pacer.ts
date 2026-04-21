/**
 * Companion Phase H — Proactive Presence Pacer (VTID-01945)
 *
 * Single-source guardrail for every proactive surface (welcome banner,
 * priority card, autopilot badge pulse, morning brief push, text-chat
 * awareness, self-awareness preview).
 *
 * Rules enforced:
 *   - At most one unsolicited "touch" per surface per day (per user).
 *   - Cross-channel silence: active user_proactive_pause suppresses ALL surfaces.
 *   - Per-user frequency cap via proactive_presence_level (quiet/balanced/engaged)
 *     in user_preferences.metadata — default balanced (up to 2 touches per day
 *     across all surfaces combined).
 *   - Dismissal respect: a dismissed_at on a prior touch within 24h suppresses
 *     the SAME surface for 24h.
 *
 * Every surface MUST call canSurfaceProactively() BEFORE rendering/sending,
 * and recordTouch() AFTER the user sees it.
 */

import { getSupabase } from '../../lib/supabase';
import { isPaused } from './pause-check';
import { emitGuideTelemetry } from './guide-telemetry';

const LOG_PREFIX = '[Guide:presence-pacer]';

export type ProactiveSurface =
  | 'welcome_banner'
  | 'priority_card'
  | 'autopilot_badge'
  | 'morning_brief'
  | 'text_chat_awareness'
  | 'self_awareness_preview'
  | 'voice_opener';

export type PresenceLevel = 'quiet' | 'balanced' | 'engaged';

const LEVEL_DAILY_CAPS: Record<PresenceLevel, number> = {
  quiet: 1,
  balanced: 2,
  engaged: 3,
};

export interface PacerDecision {
  allow: boolean;
  reason?:
    | 'ok'
    | 'paused'
    | 'surface_already_touched_today'
    | 'daily_cap_reached'
    | 'recent_dismissal'
    | 'storage_unavailable';
  pause?: { scope: string; paused_until: string } | null;
  touches_today?: number;
  daily_cap?: number;
}

export interface RecordTouchInput {
  user_id: string;
  surface: ProactiveSurface;
  reason_tag?: string;
  metadata?: Record<string, unknown>;
}

export interface AcknowledgeTouchInput {
  user_id: string;
  surface: ProactiveSurface;
  action: 'acknowledged' | 'dismissed';
}

/**
 * The one function every proactive surface calls before showing/sending.
 * Returns allow=true only if all pacing rules pass.
 *
 * Short-circuits: storage unavailable → fail OPEN (allow) so a DB outage
 * doesn't silence the companion. Pause active → fail CLOSED (deny) because
 * user explicitly asked for quiet.
 */
export async function canSurfaceProactively(
  userId: string,
  surface: ProactiveSurface,
  opts?: { bypass_daily_cap?: boolean },
): Promise<PacerDecision> {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn(`${LOG_PREFIX} no supabase — failing OPEN`);
    return { allow: true, reason: 'storage_unavailable' };
  }

  // 1. Hard stop: active proactive pause
  const pauseResult = await isPaused({
    user_id: userId,
    channel: surfaceToChannel(surface),
  });
  if (pauseResult.paused && pauseResult.pause) {
    return {
      allow: false,
      reason: 'paused',
      pause: {
        scope: pauseResult.pause.scope,
        paused_until: pauseResult.pause.paused_until,
      },
    };
  }

  // 2. Fetch today's touches
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const startIso = startOfToday.toISOString();

  const { data: todaysTouches } = await supabase
    .from('user_proactive_touches')
    .select('surface, dismissed_at, sent_at')
    .eq('user_id', userId)
    .gte('sent_at', startIso);

  const touches = (todaysTouches || []) as Array<{
    surface: string;
    dismissed_at: string | null;
    sent_at: string;
  }>;

  // 3. Surface-level check — at most 1 per surface per day
  const thisSurfaceTodayCount = touches.filter((t) => t.surface === surface).length;
  if (thisSurfaceTodayCount >= 1) {
    return {
      allow: false,
      reason: 'surface_already_touched_today',
      touches_today: touches.length,
    };
  }

  // 4. Recent dismissal — if this surface was dismissed within 24h, honor it
  const recentDismiss = touches.find(
    (t) =>
      t.surface === surface &&
      t.dismissed_at &&
      Date.now() - new Date(t.dismissed_at).getTime() < 24 * 3600 * 1000,
  );
  if (recentDismiss) {
    return {
      allow: false,
      reason: 'recent_dismissal',
      touches_today: touches.length,
    };
  }

  // 5. Per-user frequency cap based on presence_level
  if (!opts?.bypass_daily_cap) {
    const level = await resolvePresenceLevel(userId);
    const cap = LEVEL_DAILY_CAPS[level];
    if (touches.length >= cap) {
      return {
        allow: false,
        reason: 'daily_cap_reached',
        touches_today: touches.length,
        daily_cap: cap,
      };
    }
    return {
      allow: true,
      reason: 'ok',
      touches_today: touches.length,
      daily_cap: cap,
    };
  }

  return { allow: true, reason: 'ok', touches_today: touches.length };
}

/**
 * Log that a proactive surface touched the user. Call AFTER the user sees
 * the surface (banner rendered, badge pulsed, push sent, etc).
 *
 * Fire-and-forget from the caller's perspective — pacer failures must never
 * block the user-visible UI.
 */
export async function recordTouch(input: RecordTouchInput): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabase();
  if (!supabase) return { success: false, error: 'storage_unavailable' };

  const { error } = await supabase.from('user_proactive_touches').insert({
    user_id: input.user_id,
    surface: input.surface,
    reason_tag: input.reason_tag ?? null,
    metadata: input.metadata ?? {},
  });

  if (error) {
    console.warn(`${LOG_PREFIX} recordTouch failed for ${input.surface}:`, error.message);
    return { success: false, error: error.message };
  }

  emitGuideTelemetry('guide.presence.touch_recorded', {
    user_id: input.user_id,
    surface: input.surface,
    reason_tag: input.reason_tag ?? null,
  }).catch(() => {});

  return { success: true };
}

/**
 * Mark a touch as acknowledged (user tapped CTA) or dismissed (user closed it).
 * Used by H.1 banner dismiss, H.4 autopilot badge view, etc.
 */
export async function acknowledgeTouch(input: AcknowledgeTouchInput): Promise<{ success: boolean }> {
  const supabase = getSupabase();
  if (!supabase) return { success: false };

  const col = input.action === 'acknowledged' ? 'acknowledged_at' : 'dismissed_at';
  const nowIso = new Date().toISOString();
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  // Find the most-recent unresolved touch for this user+surface today
  const { data } = await supabase
    .from('user_proactive_touches')
    .select('id')
    .eq('user_id', input.user_id)
    .eq('surface', input.surface)
    .gte('sent_at', startOfToday.toISOString())
    .is(col, null)
    .order('sent_at', { ascending: false })
    .limit(1);

  const row = (data || [])[0] as { id: string } | undefined;
  if (!row) return { success: true }; // nothing to update — idempotent

  await supabase
    .from('user_proactive_touches')
    .update({ [col]: nowIso })
    .eq('id', row.id);

  emitGuideTelemetry(
    input.action === 'acknowledged'
      ? 'guide.presence.touch_acknowledged'
      : 'guide.presence.touch_dismissed',
    { user_id: input.user_id, surface: input.surface },
  ).catch(() => {});

  return { success: true };
}

/**
 * Read the user's configured presence level. Defaults to 'balanced' when no
 * preference exists or when storage is unavailable.
 */
async function resolvePresenceLevel(userId: string): Promise<PresenceLevel> {
  const supabase = getSupabase();
  if (!supabase) return 'balanced';

  const { data } = await supabase
    .from('user_preferences')
    .select('metadata')
    .eq('user_id', userId)
    .eq('preference_type', 'proactive_presence_level')
    .limit(1);

  const row = (data || [])[0] as { metadata: { level?: PresenceLevel } } | undefined;
  const level = row?.metadata?.level;
  if (level === 'quiet' || level === 'balanced' || level === 'engaged') {
    return level;
  }
  return 'balanced';
}

/**
 * Map a surface to the dismissal-pause channel scope it cares about.
 * Voice channels honor voice pauses; push/in-app surfaces honor all/channel.
 */
function surfaceToChannel(surface: ProactiveSurface): 'voice' | 'text' {
  if (surface === 'voice_opener') return 'voice';
  return 'text';
}
