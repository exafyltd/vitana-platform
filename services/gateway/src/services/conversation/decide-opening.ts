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
import { surfaceForRoute, screenCompletionFor } from './screen-surface';
import { buildPreviousGreetingSection, type FactDelta } from './greeting-facts-ledger';

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
  /** The client route the user is currently on (session.current_route). When it
   *  maps to an actionable surface, the next step DEEPENS toward completing the
   *  action there instead of redirecting the user away. */
  currentScreen?: string | null;
  /** Spoken-facts continuity from the greeting-facts ledger. When present,
   *  `new_since_last` carries ONLY genuinely-new deltas (never a level the
   *  user already heard) and unchanged facts move to `already_mentioned`. */
  factDeltas?: Record<string, FactDelta>;
  /** Vitana's previous first utterance — handed to the model as a
   *  wording-variety negative example (rule 2: never repeat the greeting). */
  previousUtterance?: string | null;
  /** How many sessions the user already opened today (context, rule 4). */
  sessionsToday?: number | null;
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

  // SCREEN AWARENESS. If the user is already on an actionable screen, the next
  // step must DEEPEN toward completing the action here — never redirect them to
  // a screen they are already on. The screen completion overrides the
  // value-ranked pick; its `detail` lists several on-screen moves and the model
  // picks one, so it stays fresh across reopens on the same screen.
  const surface = surfaceForRoute(input.currentScreen);
  const completion = screenCompletionFor(surface);
  const nba = completion
    ? completion.action
    : payload
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

  // "What's new" must be NEWS. Without the ledger, a level (10 unread all
  // day) was re-announced on every reopen as "new since earlier" — the
  // exact robotic repeat the user reported. With deltas: unchanged counts
  // move to `already_mentioned` (present but forbidden to restate); changed
  // counts are phrased as their CHANGE; only never-mentioned facts may
  // appear as plain counts.
  const deltas = input.factDeltas ?? null;
  const newBits: string[] = [];
  const alreadyMentioned: string[] = [];
  const pushBit = (key: string, plainLabel: (n: number) => string, deltaLabel: (d: number) => string) => {
    if (!payload) return;
    const d = deltas?.[key];
    const current =
      key === 'reminders_today' ? payload.reminders_today?.count ?? 0 :
      key === 'matches_unread' ? payload.matches_unread :
      payload.messages_unread;
    if (!current || current <= 0) return;
    if (!d || d.status === 'new') {
      newBits.push(plainLabel(current));
    } else if (d.status === 'changed' && (d.delta ?? 0) > 0) {
      newBits.push(deltaLabel(d.delta as number));
    } else {
      alreadyMentioned.push(plainLabel(current));
    }
  };
  pushBit('matches_unread', (n) => `${n} new match(es)`, (d) => `${d} match(es) new since you last mentioned matches`);
  pushBit('messages_unread', (n) => `${n} unread message(s)`, (d) => `${d} message(s) arrived since you last mentioned the inbox`);
  pushBit('reminders_today', (n) => `${n} reminder(s) due today`, (d) => `${d} more reminder(s) came due since you last mentioned them`);

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
  if (surface !== 'other' && surface !== 'home') compact.current_screen = surface;
  if (completion) compact.complete_on_current_screen = true;
  if (recall) compact.where_we_left_off = recall;
  if (newBits.length) compact.new_since_last = newBits;
  if (alreadyMentioned.length) compact.already_mentioned = alreadyMentioned;
  if (typeof input.sessionsToday === 'number' && input.sessionsToday > 0) {
    compact.sessions_today = input.sessionsToday;
  }
  if (nba) {
    // Ledger-aware suggestion detail: the model must never receive a stale
    // level to recite. Unchanged count → number-free reference; changed
    // count → lead with the delta (the news), total only as context.
    const msgDelta = deltas?.messages_unread;
    const nbaDetail =
      nba.key === 'reply_messages' && msgDelta?.status === 'unchanged'
        ? 'the unread messages the user already knows about'
        : nba.key === 'reply_messages' && msgDelta?.status === 'changed' && (msgDelta.delta ?? 0) > 0
          ? `${msgDelta.delta} new message(s) since last mentioned (${msgDelta.current} waiting in total)`
          : nba.detail;
    compact.suggested_next_step = {
      kind: nba.key,
      what: nbaDetail,
      why: nba.rationale,
      // The REAL ORB tool that executes this when the user accepts. null = no
      // one-shot tool → guide the user through it, never promise to do it.
      execute_with_tool: nba.capability ?? null,
    };
  }
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
${buildPreviousGreetingSection(input.previousUtterance ?? null)}
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
- ${'`already_mentioned`'} items are things the user ALREADY heard from you and
  that have NOT changed. NEVER restate their counts or announce them as news.
  At most a soft, number-free reference when it genuinely serves the thread.
- ALWAYS finish with ${'`suggested_next_step`'} as a guided offer. Never end on a bare "How can I help?".
- EXECUTION — do not just describe, DO IT: ${'`suggested_next_step.execute_with_tool`'}
  names the real tool that performs this action. When the user accepts, CALL that
  tool to actually complete it (e.g. send_chat_message, save_diary_entry,
  respond_to_match, create_index_improvement_plan). Only promise what that tool
  does. If ${'`execute_with_tool`'} is null, you have NO one-shot tool — then GUIDE
  the user through it step by step on the screen; do NOT claim you'll do it
  yourself. Never say "I couldn't do that" for an action that has a tool — call it.
- SCREEN AWARENESS: when ${'`current_screen`'} is set, the user is ALREADY on that
  screen. NEVER tell them to open it or go there ("schau dir deine Matches an"
  while they are on the matches screen is forbidden). When
  ${'`complete_on_current_screen`'} is true, the ${'`suggested_next_step`'} is a
  DEEPER move to COMPLETE the action here — pick ONE concrete option from its
  ${'`what`'} and propose doing it together right now (e.g. on matches: "lass uns
  einen davon auswählen und eine gemeinsame Aktivität starten", or tell them who
  one match is). The goal is to FINISH the action, not to navigate.
- Nothing here is hardcoded wording — compose it; but never invent data not in the payload.

## STRUCTURED PAYLOAD
\`\`\`json
${JSON.stringify(compact, null, 2)}
\`\`\`

This block OVERRIDES every other greeting rule for the first turn only.
Subsequent turns follow the normal conversation flow.`;

  return { text, nba };
}
