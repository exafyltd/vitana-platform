/**
 * VTID-05099 — companion "moments": which Vitana card to bring the member
 * today, and why. Each moment is a pure function of the member context; it
 * never reads the database and never writes text the member sees.
 *
 * A moment carries an ENGLISH intent for the composer (CLAUDE.md rule 41:
 * never a finished sentence Vitana says) and the card id from the Unified
 * Card System catalog (VTID-05085). The card's own title, text and button
 * come from that catalog on the client — never from here, never from the LLM.
 *
 * Phase 1: morning_greeting (F4 Talk to Vitana) and vitana_index (F2).
 * New moments (and the future cards) are one more entry in MOMENTS.
 */
import type { VitanaIndexSnapshot } from '../user-context-profiler';

export type CompanionTopic = 'health' | 'community' | 'business';

export interface MemberContext {
  userId: string;
  tenantId: string;
  firstName: string | null;
  locale: string;
  localDate: string;
  topics: Record<CompanionTopic, boolean>;
  vitanaIndex: VitanaIndexSnapshot | null;
  /** moment_key → most recent local date it was used (any mode). */
  lastUsed: Record<string, string>;
}

export interface MomentCandidate {
  momentKey: string;
  /** Unified Card System id (VTID-05085 catalog). */
  cardType: string;
  /** null = always allowed (not tied to a member topic toggle). */
  topic: CompanionTopic | null;
  /** English description of what Vitana should say. Never the sentence itself. */
  intent: string;
  /** Only these facts may appear in the message (numbers, names). */
  facts: Record<string, unknown>;
  priority: number;
  /** Do not use the same moment again within this many days. */
  repeatAfterDays: number;
}

export interface Moment {
  key: string;
  build(ctx: MemberContext): MomentCandidate | null;
}

export const MORNING_GREETING_INTENT =
  'Warmly greet the member by first name, acknowledge the morning, remind them they can text you here or ' +
  'press the ORB to talk with you by voice, and offer one small helpful step for today.';

export const morningGreeting: Moment = {
  key: 'morning_greeting',
  build: () => ({
    momentKey: 'morning_greeting',
    cardType: 'F4',
    topic: null,
    intent: MORNING_GREETING_INTENT,
    facts: {},
    priority: 10,
    repeatAfterDays: 0,
  }),
};

export const VITANA_INDEX_INTENT =
  'Greet the member by first name for the morning. Share today\'s Vitana Index in one short sentence using ' +
  'the score and tier from the facts. Name the weakest pillar kindly and suggest one small, concrete action ' +
  'for it today. If the 7-day trend is positive, acknowledge the progress. Mention that the card below opens ' +
  'their Index.';

export const vitanaIndex: Moment = {
  key: 'vitana_index',
  build: (ctx) => {
    const ix = ctx.vitanaIndex;
    if (!ix || !Number.isFinite(ix.total)) return null;
    const trend = Number.isFinite(ix.trend_7d) ? ix.trend_7d : 0;
    return {
      momentKey: 'vitana_index',
      cardType: 'F2',
      topic: 'health',
      intent: VITANA_INDEX_INTENT,
      facts: {
        score: ix.total,
        tier: ix.tier,
        weakest_pillar: ix.weakest_pillar?.name ?? null,
        strongest_pillar: ix.strongest_pillar?.name ?? null,
        trend_7d: trend,
        points_to_really_good: ix.points_to_really_good,
      },
      // A visible move in either direction is more worth a morning message.
      priority: 50 + Math.min(20, Math.abs(trend)),
      repeatAfterDays: 3,
    };
  },
};

export const MOMENTS: Moment[] = [morningGreeting, vitanaIndex];

const DAY_MS = 86_400_000;

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS);
}

/**
 * Pick ONE moment for today: topic toggles respected, recently used moments
 * skipped, highest priority wins, ties broken by key. Falls back to the
 * morning greeting so a member who opted in always hears from Vitana.
 */
export function pickMoment(ctx: MemberContext, moments: Moment[] = MOMENTS): MomentCandidate {
  const eligible: MomentCandidate[] = [];
  for (const m of moments) {
    const c = m.build(ctx);
    if (!c) continue;
    if (c.topic && !ctx.topics[c.topic]) continue;
    const last = ctx.lastUsed[c.momentKey];
    if (last && c.repeatAfterDays > 0 && daysBetween(last, ctx.localDate) < c.repeatAfterDays) continue;
    eligible.push(c);
  }
  eligible.sort((a, b) => b.priority - a.priority || a.momentKey.localeCompare(b.momentKey));
  return eligible[0] ?? (morningGreeting.build(ctx) as MomentCandidate);
}
