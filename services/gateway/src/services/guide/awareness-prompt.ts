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
import { formatLocalHHMM } from './user-timezone';

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

  // VTID-01990 — cross-surface conversation tracking. Surfaces "this is your
  // Nth session today, last at HH:MM" + a one-liner per prior session today
  // and yesterday's last session. Lets Vitana feel persistent across
  // sessions and lets users say "we talked yesterday morning about X" and
  // have it actually work (the recall_conversation_at_time tool resolves the
  // window; this block is what makes the assistant know it's possible).
  const sessionsBlock = renderSessionsTrackingBlock(awareness);
  if (sessionsBlock) lines.push(sessionsBlock);

  if (!compact) {
    lines.push(
      '',
      'Use this awareness naturally. Reference it when relevant — never recite.',
      'If the user mentions something (interest, concern, goal), acknowledge it.',
    );
  }

  return lines.join('\n');
}

function renderSessionsTrackingBlock(awareness: UserAwareness): string {
  const today = awareness.sessions_today;
  const yesterday = awareness.last_session_yesterday;
  if ((!today || today.count === 0) && !yesterday) return '';

  const tz = awareness.user_timezone;
  const out: string[] = [];

  if (today && today.count > 0) {
    out.push(`Sessions today: ${today.count} prior (this is the ${ordinal(today.count + 1)}).`);
    // Up to 4 most recent today entries, oldest first so the trail reads chronologically
    const entries = today.entries.slice(-4);
    for (const e of entries) {
      const hhmm = formatLocalHHMM(e.ended_at, tz);
      const themes = (e.themes || []).slice(0, 3).join(', ');
      const summary = truncateSummary(e.summary || '', 240);
      const channelTag = e.channel === 'voice' ? 'voice' : 'text';
      out.push(`  - ${hhmm} (${channelTag})${themes ? ` themes: ${themes}` : ''} — ${summary}`);
    }
  }

  if (yesterday) {
    const hhmm = formatLocalHHMM(yesterday.ended_at, tz);
    const themes = (yesterday.themes || []).slice(0, 3).join(', ');
    const summary = truncateSummary(yesterday.summary || '', 240);
    out.push(`Yesterday's last session ${hhmm}${themes ? ` themes: ${themes}` : ''} — ${summary}`);
  }

  if (out.length > 0) {
    out.push(
      `(All session times are local to the user — ${tz}. Always quote times in this timezone, never UTC.)`,
      'When the user references a past conversation by time ("we talked yesterday morning..."), call recall_conversation_at_time to fetch the actual turns. Do not invent details from these summaries alone.',
    );
  }

  return out.join('\n');
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function truncateSummary(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
