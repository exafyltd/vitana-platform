/**
 * Companion Phase H.2 — Priority of the Day rule engine (VTID-01947)
 *
 * Pure function: given awareness state, returns the most relevant priority
 * for today — the copy the Home banner shows. Rules are ordered; first
 * match wins. Falls back to a generic time-of-day message when no
 * awareness-driven rule matches.
 *
 * The rule engine is locale-agnostic: it returns a catalog key + params
 * (never a baked English sentence) so the gateway can localize the copy to
 * each user's language via `tt()`. The frontend renders the resolved
 * `message` verbatim. See services/gateway/src/i18n/catalog.ts.
 *
 * Consumed by /api/v1/presence/priority endpoint and the morning brief
 * generator.
 */

import type { UserAwareness } from './types';
import type { GatewayI18nKey } from '../../i18n/catalog';

export interface PriorityMessage {
  /** Catalog key resolved against the user's locale by the caller via `tt()`. */
  message_key: GatewayI18nKey;
  /** Interpolation params for the catalog string (e.g. {name}, {count}). */
  message_params?: Record<string, string | number>;
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
  const named = firstName.length > 0;

  // Rule 1 — absence re-engagement (highest priority)
  const motiv = awareness.last_interaction?.motivation_signal;
  if (motiv === 'absent' || motiv === 'cooling') {
    const days = awareness.last_interaction?.days_since_last ?? 0;
    const streak = awareness.community_signals?.diary_streak_days ?? 0;
    if (streak > 0) {
      return {
        message_key: named ? 'priority.absence_streak.named' : 'priority.absence_streak',
        message_params: named ? { name: firstName, streak } : { streak },
        cta_url: '/memory?tab=diary',
        reason_tag: `absence:${days}d+streak`,
        variant: 'warm',
      };
    }
    const oneDay = days === 1;
    return {
      message_key: named
        ? (oneDay ? 'priority.absence.named.day' : 'priority.absence.named.days')
        : (oneDay ? 'priority.absence.day' : 'priority.absence.days'),
      message_params: named ? { name: firstName, days } : { days },
      cta_url: null,
      reason_tag: `absence:${days}d`,
      variant: 'warm',
    };
  }

  // Rule 2 — overdue calendar items take precedence over weakness
  const overdue = awareness.recent_activity?.overdue_calendar_count ?? 0;
  if (overdue > 0) {
    return {
      message_key: overdue === 1 ? 'priority.overdue.one' : 'priority.overdue.many',
      message_params: { count: overdue },
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
        message_key: 'priority.goal_prosperity_idle',
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
        message_key: 'priority.welcome_wave',
        message_params: { wave: wave.name, description: wave.description },
        cta_url: '/autopilot',
        reason_tag: `tenure:${awareness.tenure.stage}:wave:${wave.id}`,
        variant: 'engage',
      };
    }
    return {
      message_key: 'priority.welcome_generic',
      cta_url: '/autopilot',
      reason_tag: `tenure:${awareness.tenure.stage}:no_wave`,
      variant: 'engage',
    };
  }

  // Rule 5 — pending autopilot recs
  const openRecs = awareness.recent_activity?.open_autopilot_recs ?? 0;
  if (openRecs > 0) {
    return {
      message_key: openRecs === 1 ? 'priority.open_recs.one' : 'priority.open_recs.many',
      message_params: { count: openRecs },
      cta_url: '/autopilot',
      reason_tag: `open_recs:${openRecs}`,
      variant: 'inform',
    };
  }

  // Rule 6 — mid-journey engagement
  const wave = awareness.journey?.current_wave;
  if (wave && awareness.journey?.day_in_journey != null) {
    return {
      message_key: 'priority.journey_day',
      message_params: { day: awareness.journey.day_in_journey, wave: wave.name },
      cta_url: '/autopilot',
      reason_tag: `journey:${wave.id}:day${awareness.journey.day_in_journey}`,
      variant: 'inform',
    };
  }

  // Rule 7 — generic fallback (time-of-day) — matches legacy banner behavior
  const hour = (input.now ?? new Date()).getHours();
  const tod = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const greetingKey = (
    named ? `priority.greeting.${tod}.named` : `priority.greeting.${tod}`
  ) as GatewayI18nKey;
  return {
    message_key: greetingKey,
    message_params: named ? { name: firstName } : undefined,
    cta_url: null,
    reason_tag: 'fallback:time_of_day',
    variant: 'inform',
  };
}
