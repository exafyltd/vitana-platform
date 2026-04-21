/**
 * Companion Phase H.5 — Awareness prompt formatter (VTID-01950)
 *
 * Shared between voice (orb-live.ts) and text (conversation-client.ts).
 * Produces a compact USER AWARENESS block suitable for system instructions.
 *
 * The voice prompt uses the richer shape-matrix formatter in vitana-brain.ts.
 * Text chat uses this leaner version — same signals, no opener-shape rules.
 */

import type { UserAwareness } from './types';

export interface AwarenessPromptOpts {
  compact?: boolean; // omit section headers, one-line dense form
}

export function formatAwarenessForPrompt(
  awareness: UserAwareness | null,
  opts: AwarenessPromptOpts = {},
): string {
  if (!awareness) return '';
  const compact = !!opts.compact;
  const lines: string[] = compact ? [] : ['=== USER AWARENESS (right now) ==='];

  lines.push(
    `Tenure: ${awareness.tenure.stage} (day ${awareness.tenure.days_since_signup})`,
  );

  if (awareness.last_interaction) {
    const li = awareness.last_interaction;
    if (li.bucket === 'first') {
      lines.push('Last interaction: NEVER spoken before.');
    } else {
      lines.push(
        `Last interaction: ${li.time_ago} (${li.bucket}, ${li.days_since_last}d, motivation=${li.motivation_signal})`,
      );
    }
  }

  if (awareness.journey.is_past_90_day) {
    lines.push(`Journey: past 90-day plan (day ${awareness.journey.day_in_journey}).`);
  } else if (awareness.journey.current_wave) {
    lines.push(
      `Journey: day ${awareness.journey.day_in_journey}/90, wave "${awareness.journey.current_wave.name}"`,
    );
  }

  if (awareness.goal) {
    lines.push(
      `Life Compass goal: "${awareness.goal.primary_goal}" (${awareness.goal.category}${awareness.goal.is_system_seeded ? ', system-seeded' : ''})`,
    );
  }

  const cs = awareness.community_signals;
  const csParts: string[] = [];
  if (cs.diary_streak_days > 0) csParts.push(`diary streak ${cs.diary_streak_days}d`);
  if (cs.connection_count > 0) csParts.push(`${cs.connection_count} connections`);
  if (cs.group_count > 0) csParts.push(`${cs.group_count} groups`);
  if (cs.memory_goals.length > 0) csParts.push(`goals: ${cs.memory_goals.slice(0, 3).join(', ')}`);
  if (cs.memory_interests.length > 0) csParts.push(`interests: ${cs.memory_interests.slice(0, 3).join(', ')}`);
  if (csParts.length) lines.push(`Community: ${csParts.join('; ')}`);

  const ra = awareness.recent_activity;
  const raParts: string[] = [];
  if (ra.open_autopilot_recs > 0) raParts.push(`${ra.open_autopilot_recs} open recs`);
  if (ra.overdue_calendar_count > 0) raParts.push(`${ra.overdue_calendar_count} overdue events`);
  if (ra.upcoming_calendar_24h_count > 0) raParts.push(`${ra.upcoming_calendar_24h_count} upcoming 24h`);
  if (raParts.length) lines.push(`Recent activity: ${raParts.join('; ')}`);

  if (awareness.prior_session_themes && awareness.prior_session_themes.length > 0) {
    const t = awareness.prior_session_themes[0];
    const themes = (t.themes || []).slice(0, 3).join(', ');
    if (themes) {
      lines.push(`Last conversation (${t.ended_at.slice(0, 10)}): ${themes}`);
    }
  }

  if (!compact) {
    lines.push(
      '',
      'Use this awareness naturally. Reference it when relevant — never recite.',
      'If the user mentions something (interest, concern, goal), acknowledge it.',
    );
  }

  return lines.join('\n');
}
