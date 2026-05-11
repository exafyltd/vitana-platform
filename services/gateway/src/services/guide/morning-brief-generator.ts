/**
 * Companion Phase H.3 — Morning Brief generator (VTID-01949)
 *
 * Assembles a one-notification morning brief for a single user from:
 *   - UserAwareness (tenure + journey + last_interaction + recent_activity + community_signals)
 *   - Priority rule engine (re-uses priority-rules.ts for body copy)
 *
 * Returns { title, body, data } or null when the user should NOT receive
 * a brief today (paused, just spoke to ORB, nothing meaningful to say).
 */

import { getAwarenessContext } from './awareness-context';
import { resolvePriorityMessage } from './priority-rules';
import { canSurfaceProactively } from './presence-pacer';
import type { NotificationPayload } from '../notification-service';
import { getSupabase } from '../../lib/supabase';
import { fetchLifeCompass } from '../user-context-profiler';
import { tierForScore, projectDay90 } from '../../lib/vitana-pillars';
import { buildRankerContext, rankBatch } from '../recommendation-engine/ranking/index-pillar-weighter';

export interface MorningBriefInput {
  user_id: string;
  tenant_id: string;
  user_name?: string | null;
  now?: Date;
}

export interface MorningBriefOutput extends NotificationPayload {
  reason_tag: string;
  variant: string;
  bucket: string | null;
}

/**
 * Decides whether to send a brief and what to say.
 * Returns null when the brief should be skipped.
 */
export async function buildMorningBrief(
  input: MorningBriefInput
): Promise<MorningBriefOutput | null> {
  const now = input.now || new Date();

  // Pacer guard — respects pauses, daily caps, per-surface cooldowns
  const decision = await canSurfaceProactively(input.user_id, 'morning_brief');
  if (!decision.allow) return null;

  const awareness = await getAwarenessContext(input.user_id, input.tenant_id);

  // If the user opened ORB already today, skip the brief — the conversation
  // itself satisfies the "daily touch" purpose.
  const bucket = awareness.last_interaction?.bucket;
  if (bucket === 'reconnect' || bucket === 'recent' || bucket === 'same_day') {
    return null;
  }

  // Pull priority message for the body — same rules that power the Home card
  const priority = resolvePriorityMessage({
    awareness,
    now,
    user_name: input.user_name ?? null,
  });

  // Fabricate the title — short, warm, awareness-driven
  const firstName = (input.user_name || '').split(' ')[0] || '';
  const timeOfDay = pickGreeting(now);
  const title = firstName
    ? `${timeOfDay}, ${firstName}`
    : `${timeOfDay}`;

  // G9: fetch Index + Compass + top ranked rec in parallel. Best-effort —
  // any failure falls through to the legacy priority-message body so the
  // brief never depends on the Index layer being up.
  let indexSummary: { score: number; tier: string } | null = null;
  let compassGoal: { primary_goal: string; category: string } | null = null;
  let topAction: { title: string; source_ref: string | null } | null = null;
  let day90Projection: { score: number; tier: string } | null = null;

  try {
    const supabase = getSupabase();
    if (supabase) {
      const [indexRow, firstRow, compass, rankerCtx] = await Promise.all([
        supabase
          .from('vitana_index_scores')
          .select('score_total, date')
          .eq('user_id', input.user_id)
          .order('date', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('vitana_index_scores')
          .select('date')
          .eq('user_id', input.user_id)
          .order('date', { ascending: true })
          .limit(1)
          .maybeSingle(),
        fetchLifeCompass(supabase, input.user_id),
        buildRankerContext(supabase, input.user_id),
      ]);

      const row = indexRow.data as { score_total?: number; date?: string } | null;
      if (row && typeof row.score_total === 'number') {
        const t = tierForScore(row.score_total);
        indexSummary = { score: row.score_total, tier: t.name };

        // Day-90 projection uses the same lib helper as the profiler + trajectory card.
        const firstTs = firstRow.data?.date
          ? Date.parse(firstRow.data.date as string)
          : Date.now();
        const days = Math.max(0, Math.floor((Date.now() - firstTs) / 86400000));
        const proj = projectDay90(row.score_total, 0, days);
        if (proj !== null) {
          day90Projection = { score: proj, tier: tierForScore(proj).name };
        }
      }
      if (compass) compassGoal = { primary_goal: compass.primary_goal, category: compass.category };

      // Top ranked Autopilot rec using the shared ranker. This query runs
      // for up to 10 recent community recs; rankBatch re-orders and the
      // top is picked.
      const { data: recs } = await supabase
        .from('autopilot_recommendations')
        .select('id, title, source_ref, impact_score, economic_axis, contribution_vector, domain, status')
        .eq('user_id', input.user_id)
        .eq('source_type', 'community')
        .eq('status', 'new')
        .order('impact_score', { ascending: false })
        .limit(10);
      if (recs && recs.length > 0) {
        const ranked = rankBatch(recs as any, rankerCtx);
        if (ranked.length > 0) {
          const top = ranked[0].rec as { title?: string | null; source_ref?: string | null };
          if (top.title) topAction = { title: String(top.title), source_ref: top.source_ref ?? null };
        }
      }
    }
  } catch (err: any) {
    console.warn(`[MorningBrief] G9 enrichment failed (non-fatal): ${err?.message ?? err}`);
  }

  // Compose body. When the Index is set, lead with score + tier.
  // Then top action (if ranker picked one). Then compass alignment.
  // Fall back to priority message when we have nothing Index-y to say.
  const parts: string[] = [];
  if (indexSummary) parts.push(`Vitana ${indexSummary.score} (${indexSummary.tier})`);
  if (topAction) parts.push(`Today's move: ${topAction.title}`);
  if (compassGoal) parts.push(`Aligned with: ${compassGoal.primary_goal}`);

  let body: string;
  if (parts.length > 0) {
    body = parts.join(' · ');
  } else {
    body = priority.message;
  }
  if (body.length > 140) body = body.slice(0, 137) + '…';

  return {
    title,
    body,
    data: {
      kind: 'morning_brief',
      reason_tag: priority.reason_tag,
      variant: priority.variant,
      cta_url: priority.cta_url || '/',
      // G9: structured payload for the frontend brief card (separate from
      // the notification body). FCM data must be all strings; empty string
      // when not present so the payload stays flat.
      index_score_total: indexSummary ? String(indexSummary.score) : '',
      index_tier: indexSummary?.tier ?? '',
      projected_day_90: day90Projection ? String(day90Projection.score) : '',
      projected_day_90_tier: day90Projection?.tier ?? '',
      active_goal: compassGoal?.primary_goal ?? '',
      active_goal_category: compassGoal?.category ?? '',
      top_action_title: topAction?.title ?? '',
      top_action_source_ref: topAction?.source_ref ?? '',
    },
    reason_tag: priority.reason_tag,
    variant: priority.variant,
    bucket: bucket || null,
  };
}

function pickGreeting(now: Date): string {
  const hr = now.getUTCHours();
  if (hr < 12) return 'Good morning';
  if (hr < 18) return 'Good afternoon';
  return 'Good evening';
}
