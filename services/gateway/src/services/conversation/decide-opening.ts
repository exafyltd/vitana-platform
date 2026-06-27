/**
 * Conversation Flow — the ONE opening decision.
 *
 * Replaces the brittle ladder of independent greeting rungs (temporal bucket →
 * flag → first-time → proactive → bare-name, each fired/suppressed in isolation)
 * with a single decision computed from the FULL context bundle. Every register
 * draws from the same data and ALWAYS closes on a concrete guided next step
 * (the Next-Best-Action engine) — Vitana never just reports, it always advises.
 *
 * Recency decides the register FIRST, so a return after one minute is never
 * greeted with "good morning":
 *
 *   first_time     never onboarded                    → onboarding welcome
 *   daily_briefing first session of a new real day    → full rich briefing (once/day)
 *   continue       reconnect (<2 min)                 → no greeting, pick up the thread
 *   quick_resume   recent (<15 min)                   → micro-ack, NO time-of-day, + NBA
 *   same_day       hours later, same calendar day     → light re-entry + what's new + NBA
 *
 * Multi-day gaps (yesterday/week/long) always have a stale once-per-day flag, so
 * they resolve to `daily_briefing` — the briefing itself acknowledges the absence.
 *
 * This module is transport-agnostic and (apart from delegating the rich-briefing
 * render) pure: it returns the directive text to hand the LLM as the first-turn
 * compose instruction, plus telemetry describing WHY it chose. See
 * docs/CONVERSATION_FLOW_HANDOFF.md for the Command-Hub "Conversation" section
 * that will visualise/configure all of this.
 */

import { VERTEX_WAKE_BRIEF_OVERRIDE_MARKER } from '../../orb/live/instruction/wake-brief-marker';
import type { OverviewPayload } from '../assistant-continuation/providers/new-day-overview-payload';
import type { TemporalBucket } from '../guide/temporal-bucket';
import { selectNextBestAction, type NextBestAction, type NbaKey } from './next-best-action';

export type OpeningRegister =
  | 'first_time'
  | 'daily_briefing'
  | 'continue'
  | 'quick_resume'
  | 'same_day';

export interface DecideRegisterInput {
  bucket: TemporalBucket;
  isFirstTime: boolean;
  /** Durable once-per-real-day briefing flag is stale → the full briefing is due. */
  briefingDue: boolean;
}

/**
 * Pick the register. Recency-FIRST for same-day reopens; onboarding and the
 * once-per-day briefing flag take precedence over recency for the big moments.
 */
export function decideOpeningRegister(input: DecideRegisterInput): OpeningRegister {
  if (input.isFirstTime) return 'first_time';
  // The full briefing owns the first session of a real day (any gap length —
  // the flag is stale). Multi-day returns land here too.
  if (input.briefingDue) return 'daily_briefing';
  // Briefing already delivered today → this is a same-day reopen. Frame by recency.
  switch (input.bucket) {
    case 'reconnect':
      return 'continue';
    case 'recent':
      return 'quick_resume';
    case 'same_day':
    case 'today':
    default:
      return 'same_day';
  }
}

export interface ResumeDirectiveInput {
  register: Exclude<OpeningRegister, 'first_time' | 'daily_briefing'>;
  payload: OverviewPayload | null;
  firstName: string | null;
  lang: string;
  /** Human "time ago" phrase from describeTimeSince (e.g. "about 3 hours ago"). */
  timeAgo: string;
  /** Rotation seed (day-of-year) so the guided nudge varies. */
  rotationSeed?: number;
  /** Durable per-user history of recently-suggested next steps (most-recent
   *  last). The opener ADVANCES past these so it never repeats the same
   *  suggestion two opens in a row. */
  recentNbaKeys?: NbaKey[];
}

export interface ResumeDirective {
  text: string;
  nba: NextBestAction | null;
}

/**
 * Compose the first-turn directive for a same-day reopen (continue / quick_resume
 * / same_day). The model composes ONE short, natural line in the user's language
 * from the structured pieces — recency framing, the where-we-left-off thread,
 * what is genuinely new, and the guided next step. Nothing is hardcoded; every
 * field is gated on real data.
 */
export function buildResumeDirective(input: ResumeDirectiveInput): ResumeDirective {
  const { register, payload, lang } = input;
  const nba = payload
    ? selectNextBestAction(payload, {
        rotationSeed: input.rotationSeed,
        recentKeys: input.recentNbaKeys,
        cooldown: 3,
      })
    : null;

  // "Where we left off" is only REAL when it is an actual last-opened topic.
  // The payload falls back to the next-session title when the last-opened topic
  // is unknown — asserting that as "we were just on X" every open is the stale
  // copy-paste the user called out, so we suppress it and let the (rotating)
  // next step carry the re-entry instead.
  const rawRecall = payload?.guided_journey?.last_session_recall ?? null;
  const nextSessionTitle = payload?.guided_journey?.next_session_title ?? null;
  const recall = rawRecall && rawRecall !== nextSessionTitle ? rawRecall : null;
  const newBits: string[] = [];
  if (payload) {
    if (payload.matches_unread > 0) newBits.push(`${payload.matches_unread} new match(es)`);
    if (payload.messages_unread > 0) newBits.push(`${payload.messages_unread} unread message(s)`);
    if (payload.reminders_today && payload.reminders_today.count > 0) newBits.push(`${payload.reminders_today.count} reminder(s) due today`);
  }

  // Register-specific framing rules the model must obey.
  const framing =
    register === 'continue'
      ? `REGISTER: CONTINUE (the user reopened seconds ago — they never really left).\n` +
        `- Do NOT greet. No "hello", no time-of-day, no name salutation. Just pick the thread back up.\n` +
        `- One short sentence: carry on from where you were, then the suggested next step.`
      : register === 'quick_resume'
        ? `REGISTER: QUICK RESUME (the user reopened a few minutes ago).\n` +
          `- Do NOT use a time-of-day greeting ("good morning/afternoon"). A bare "${input.firstName ? input.firstName + ', ' : ''}" warm reconnect at most.\n` +
          `- Acknowledge anything genuinely NEW since they were just here, then the suggested next step.`
        : `REGISTER: SAME-DAY RETURN (the user is back later the same day, ${input.timeAgo}).\n` +
          `- A light, warm re-entry is fine, but NOT a second full morning briefing and NOT "good morning" if it is no longer morning-fresh.\n` +
          `- Mention what is new since earlier, reconnect to the thread, then the suggested next step.`;

  const compact: Record<string, unknown> = {};
  if (recall) compact.where_we_left_off = recall;
  if (newBits.length) compact.new_since_last = newBits;
  if (nba) compact.suggested_next_step = { kind: nba.key, what: nba.detail, why: nba.rationale };
  if (input.recentNbaKeys && input.recentNbaKeys.length) {
    compact.already_offered_recently = input.recentNbaKeys.slice(-4);
  }

  const nameLine = input.firstName
    ? `User first name: ${input.firstName}`
    : 'User first name: (unknown — address warmly without a name, never invent one)';

  const text = `\n\n${VERTEX_WAKE_BRIEF_OVERRIDE_MARKER}

## SPOKEN FIRST UTTERANCE — CONVERSATION RESUME (Conversation Flow)

The user just reopened Vitana. This is NOT the first session of the day — the
full morning briefing already happened. Compose a SHORT, natural first line in
the user's language that fits the register below. Vitana ALWAYS guides: the line
MUST end with the suggested next step as a concrete offer ("ich würde
vorschlagen, wir …" / "I'd suggest we …"), phrased as doing it WITH the user.

${framing}

## LANGUAGE
${(lang || 'en').toLowerCase()}. Speak only in the user's language.
${nameLine}

## RULES
- ONE to TWO short sentences. This is a re-entry, not a report.
- THIS IS A FRESH TURN — do NOT reuse the wording of a previous opener, and do
  NOT re-offer anything in ${'`already_offered_recently`'}. Move the conversation
  FORWARD to the new ${'`suggested_next_step`'}. Repeating the same suggestion is
  forbidden — the user has heard it.
- ${'`where_we_left_off`'}, when present, is a real thread to continue — reference
  it naturally, never as a database row. When it is ABSENT, do NOT invent a "we
  were just on X" line; lead with what's new and the next step instead.
- Only mention ${'`new_since_last`'} items that are present; if empty, skip — do not say "nothing new".
- ALWAYS finish with ${'`suggested_next_step`'} as a guided offer. Never end on a bare "How can I help?".
- Nothing here is hardcoded wording — compose it; but never invent data not in the payload.

## STRUCTURED PAYLOAD
\`\`\`json
${JSON.stringify(compact, null, 2)}
\`\`\`

This block OVERRIDES every other greeting rule for the first turn only.
Subsequent turns follow the normal conversation flow.`;

  return { text, nba };
}
