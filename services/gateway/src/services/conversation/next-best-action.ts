/**
 * Conversation Flow — Next-Best-Action (NBA) engine.
 *
 * Vitana ALWAYS guides: every conversation opening (and the standing behavior)
 * closes on a concrete, real next step — "here's where we left off, I suggest
 * we do X next." This module picks that X from the already-assembled rich
 * overview payload, ranked by value × timeliness, toward the two north stars:
 *
 *   • COMMUNITY engagement  — matches, messages, posts, activities, connections
 *   • HEALTH improvement    — diary→Index, weakest pillar, guided sessions
 *
 * It is a PURE function over OverviewPayload (no I/O): the bundle is gathered
 * once by gatherOverviewPayload, and the opener + the standing instruction both
 * read the chosen action from here, so voice never invents a suggestion and the
 * whole conversation pushes the same next step.
 *
 * Grounding rule: every candidate is gated on REAL data in the payload. If a
 * signal is absent, its action is not offered. We never bluff a next step.
 *
 * Rotation: when several actions tie, a caller-supplied seed (day-of-year)
 * varies the pick so Vitana does not nag the identical thing every open. Full
 * "don't repeat what we suggested last time" needs per-user state — tracked as
 * a follow-up (see CONVERSATION_FLOW_HANDOFF.md).
 */

import type { OverviewPayload } from '../assistant-continuation/providers/new-day-overview-payload';

export type NbaDomain = 'health' | 'community' | 'journey' | 'admin';

export type NbaKey =
  | 'reminder_due'
  | 'autopilot_step'
  | 'reply_messages'
  | 'review_matches'
  | 'next_session'
  | 'diary_entry'
  | 'focus_pillar'
  | 'make_post'
  | 'create_activity'
  | 'connect_community'
  | 'set_goal'
  // Screen-aware COMPLETION actions — chosen when the user is already on the
  // relevant screen, to deepen toward finishing the action instead of redirecting.
  | 'complete_matches'
  | 'complete_chat'
  | 'complete_post'
  | 'complete_diary'
  | 'complete_index'
  | 'complete_profile';

export interface NextBestAction {
  key: NbaKey;
  domain: NbaDomain;
  /** Priority band (higher = more urgent). For telemetry + tie-breaks. */
  band: number;
  /** The concrete thing, with real specifics (titles/counts) for the prompt to
   *  weave into a natural suggestion. NOT a finished user-facing sentence. */
  detail: string;
  /** Why-now, grounding the model so the suggestion reads as reasoned. */
  rationale: string;
}

export interface NbaContext {
  /** Day-of-year (user tz) — varies tie-broken picks so the nudge rotates. */
  rotationSeed?: number;
  /** Keys Vitana already suggested recently (most-recent last), from the
   *  durable per-user history. The selector skips these so each open ADVANCES
   *  to the next-best fresh action instead of repeating the same suggestion. */
  recentKeys?: NbaKey[];
  /** How many of the most-recent suggestions to treat as "on cooldown".
   *  Default 3 — cycles through the top handful before any can repeat. */
  cooldown?: number;
}

/**
 * Rank every grounded next-best-action for this user, most-valuable first.
 * Bands (value × timeliness):
 *   100 time-sensitive / waiting on the user (reminder due, prepared autopilot step, unread DMs)
 *    80 continuity (the next guided session — the journey thread)
 *    60 health momentum (diary gap → Index lift, weakest pillar)
 *    40 community growth (new matches, then post / activity / connect openings)
 */
export function rankNextBestActions(p: OverviewPayload, ctx: NbaContext = {}): NextBestAction[] {
  const out: NextBestAction[] = [];

  // ---- Band 100: time-sensitive / waiting on the user --------------------
  if (p.reminders_today && p.reminders_today.count > 0 && p.reminders_today.next) {
    out.push({
      key: 'reminder_due',
      domain: 'admin',
      band: 100,
      detail: p.reminders_today.next.action_text,
      rationale: `A reminder is due today (${p.reminders_today.count} total) — act on it before it slips.`,
    });
  }
  if (p.autopilot && p.autopilot.state === 'has_actions' && p.autopilot.today_checkpoint) {
    out.push({
      key: 'autopilot_step',
      domain: 'health',
      band: 98,
      detail: p.autopilot.today_checkpoint.title,
      rationale: 'Autopilot has already prepared the next step — offer to start it.',
    });
  }
  if (p.messages_unread > 0) {
    out.push({
      key: 'reply_messages',
      domain: 'community',
      band: 92,
      detail: `${p.messages_unread} unread message(s)`,
      rationale: 'People are waiting on a reply — responding keeps the community warm.',
    });
  }

  // ---- Band 80: continuity (the guided-journey thread) -------------------
  if (p.guided_journey && p.guided_journey.next_session_title) {
    out.push({
      key: 'next_session',
      domain: 'journey',
      band: 80,
      detail: p.guided_journey.next_session_title,
      rationale: `Continue the guided journey — ${p.guided_journey.sessions_completed} sessions done so far.`,
    });
  }

  // ---- Band 60: health momentum ------------------------------------------
  if (p.diary_last_7d === 0) {
    out.push({
      key: 'diary_entry',
      domain: 'health',
      band: 62,
      detail: 'a short diary entry',
      rationale: 'No diary entry in 7 days — a quick entry nudges the Vitana Index up.',
    });
  }
  if (p.vitana_index && p.vitana_index.state === 'ok' && p.vitana_index.weakest_pillar) {
    out.push({
      key: 'focus_pillar',
      domain: 'health',
      band: 58,
      detail: p.vitana_index.weakest_pillar.name,
      rationale: `Weakest Index pillar is ${p.vitana_index.weakest_pillar.name} (${p.vitana_index.weakest_pillar.score}) — one small move lifts it.`,
    });
  }

  // ---- Band 40: community growth -----------------------------------------
  if (p.matches_unread > 0) {
    out.push({
      key: 'review_matches',
      domain: 'community',
      band: 44,
      detail: `${p.matches_unread} new match(es)`,
      rationale: 'Fresh matches are waiting — looking at them grows real connections.',
    });
  }
  // Always-available community-growth openings (no precondition signal). These
  // are the lowest band so they only surface when nothing more specific exists,
  // and the rotation seed varies which one is offered.
  const growthPool: NextBestAction[] = [
    { key: 'make_post', domain: 'community', band: 30, detail: 'share a short update with the community', rationale: 'Posting keeps you visible and grows engagement.' },
    { key: 'create_activity', domain: 'community', band: 30, detail: 'create an activity others can join', rationale: 'Activities turn the community into real-world meetups.' },
    { key: 'connect_community', domain: 'community', band: 30, detail: 'like or comment on someone’s post', rationale: 'A small interaction strengthens the network.' },
  ];
  const seed = Number.isFinite(ctx.rotationSeed) ? (ctx.rotationSeed as number) : 0;
  out.push(growthPool[((seed % growthPool.length) + growthPool.length) % growthPool.length]);

  // Life Compass not set → a one-time set-goal nudge (low band; the briefing's
  // own setup-gap handling covers the rich case, this is the NBA fallback).
  if (p.life_compass && p.life_compass.state === 'not_set') {
    out.push({
      key: 'set_goal',
      domain: 'health',
      band: 26,
      detail: 'set your Life Compass goal',
      rationale: 'No goal set yet — naming one gives the whole journey direction.',
    });
  }

  // Stable sort by band desc; ties keep insertion order (already priority-ordered).
  return out.sort((a, b) => b.band - a.band);
}

/** The single next-best-action to lead the always-guiding close — ADVANCING,
 *  not repeating. Picks the highest-value action whose key was NOT among the
 *  last `cooldown` suggestions, so each open moves to a fresh next step and only
 *  revisits an action after cycling through the others. Falls back to the
 *  top-ranked action when everything is on cooldown (small action sets). Null
 *  only when there is literally nothing actionable (effectively never, thanks to
 *  the always-available community-growth pool). */
export function selectNextBestAction(p: OverviewPayload, ctx: NbaContext = {}): NextBestAction | null {
  const ranked = rankNextBestActions(p, ctx);
  if (ranked.length === 0) return null;
  const cooldown = Number.isFinite(ctx.cooldown) ? (ctx.cooldown as number) : 3;
  const recent = new Set((ctx.recentKeys ?? []).slice(-cooldown));
  const fresh = ranked.find((a) => !recent.has(a.key));
  return fresh ?? ranked[0];
}
