/**
 * Companion Phase H.2 — Priority of the Day rule engine (VTID-01947)
 *
 * Pure function: given awareness state, returns the most relevant priority
 * for today — the copy the Home banner shows. Rules are ordered; first
 * match wins. Falls back to a generic time-of-day message when no
 * awareness-driven rule matches.
 *
 * Consumed by /api/v1/presence/priority endpoint and (future) the
 * WelcomeBackBanner.
 */

import type { UserAwareness } from './types';

export interface PriorityMessage {
  message: string;
  cta_url: string | null;
  reason_tag: string;
  variant: 'urgent' | 'warm' | 'engage' | 'inform';
}

export interface PriorityRulesInput {
  awareness: UserAwareness;
  now?: Date;
  user_name?: string | null;
}

/**
 * Resolve the single most relevant priority for today. Rules ordered by
 * importance: cooling/absent re-engagement first, then weakness signals,
 * then journey nudges, then goal-aware prompts, then generic fallback.
 */
export function resolvePriorityMessage(input: PriorityRulesInput): PriorityMessage {
  const { awareness, user_name } = input;
  const firstName = (user_name || '').split(' ')[0] || '';

  // Rule 1 — absence re-engagement (highest priority)
  const motiv = awareness.last_interaction?.motivation_signal;
  if (motiv === 'absent' || motiv === 'cooling') {
    const days = awareness.last_interaction?.days_since_last ?? 0;
    const streak = awareness.community_signals?.diary_streak_days ?? 0;
    if (streak > 0) {
      return {
        message: `${firstName ? firstName + ', ' : ''}welcome back. Your diary streak paused at ${streak} days — want to pick it up?`,
        cta_url: '/memory?tab=diary',
        reason_tag: `absence:${days}d+streak`,
        variant: 'warm',
      };
    }
    return {
      message: `${firstName ? firstName + ', ' : ''}it's been ${days} day${days === 1 ? '' : 's'} — glad you're back.`,
      cta_url: null,
      reason_tag: `absence:${days}d`,
      variant: 'warm',
    };
  }

  // Rule 2 — overdue calendar items take precedence over weakness
  const overdue = awareness.recent_activity?.overdue_calendar_count ?? 0;
  if (overdue > 0) {
    return {
      message: `${overdue} journey activit${overdue === 1 ? 'y is' : 'ies are'} waiting from earlier. Want to tackle ${overdue === 1 ? 'it' : 'one'} now?`,
      cta_url: '/autopilot',
      reason_tag: `overdue:${overdue}`,
      variant: 'urgent',
    };
  }

  // Rule 3 — goal-aware prompts
  const goal = awareness.goal;
  if (goal?.category === 'prosperity' || /financial|business|income|freedom/i.test(goal?.primary_goal || '')) {
    const activated = awareness.recent_activity?.activated_recs_last_7d ?? 0;
    if (activated === 0) {
      return {
        message: 'Your goal points at building freedom. One Business Hub check-in could move it today.',
        cta_url: '/business',
        reason_tag: 'goal:prosperity:idle',
        variant: 'engage',
      };
    }
  }

  // Rule 4 — Day-0/Day-1 welcome — explain next step
  if (awareness.tenure?.stage === 'day0' || awareness.tenure?.stage === 'day1') {
    const wave = awareness.journey?.current_wave;
    if (wave) {
      return {
        message: `You're in "${wave.name}" — ${wave.description}. Want a 2-minute walkthrough?`,
        cta_url: '/autopilot',
        reason_tag: `tenure:${awareness.tenure.stage}:wave:${wave.id}`,
        variant: 'engage',
      };
    }
    return {
      message: 'Welcome to your longevity journey. Let me show you what we can do together.',
      cta_url: '/autopilot',
      reason_tag: `tenure:${awareness.tenure.stage}:no_wave`,
      variant: 'engage',
    };
  }

  // Rule 5 — pending autopilot recs
  const openRecs = awareness.recent_activity?.open_autopilot_recs ?? 0;
  if (openRecs > 0) {
    return {
      message: `${openRecs} Autopilot action${openRecs === 1 ? '' : 's'} ready for you. Worth a look?`,
      cta_url: '/autopilot',
      reason_tag: `open_recs:${openRecs}`,
      variant: 'inform',
    };
  }

  // Rule 6 — mid-journey engagement
  const wave = awareness.journey?.current_wave;
  if (wave && awareness.journey?.day_in_journey != null) {
    return {
      message: `Day ${awareness.journey.day_in_journey} of your journey, in ${wave.name}. Keep going.`,
      cta_url: '/autopilot',
      reason_tag: `journey:${wave.id}:day${awareness.journey.day_in_journey}`,
      variant: 'inform',
    };
  }

  // Rule 7 — generic fallback (time-of-day) — matches legacy banner behavior
  const hour = (input.now ?? new Date()).getHours();
  const tod = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return {
    message: `Good ${tod}${firstName ? ', ' + firstName : ''}. Ready when you are.`,
    cta_url: null,
    reason_tag: 'fallback:time_of_day',
    variant: 'inform',
  };
}
