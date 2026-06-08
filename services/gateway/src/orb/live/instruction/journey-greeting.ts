/**
 * VTID-03154 — Slices C + D: journey-greeting block builder.
 *
 * Composes a STRUCTURAL prompt block (not a Say-exactly verbatim line)
 * that turns one of two events into a fresh, naturally-worded greeting:
 *
 *   Slice C — One-time first-session welcome
 *     Trigger: user_journey.is_first_session === true
 *     Frames: Vitanaland as a JOURNEY (not an app tour), Life Compass
 *             as the user's long-term goal, Vitana Index as the daily
 *             progress measure, Vitana herself as the companion who
 *             guides on this journey. Ends with one open invitation
 *             to begin.
 *
 *   Slice D — Daily morning greeting
 *     Trigger: last_session_date is null OR last_session_date < today_date
 *              in the user's local timezone (and is_first_session === false).
 *     Frames: "day {X}" of the journey explicitly + the active Life
 *             Compass goal text as the purpose ("…in your plan to
 *             {goal_text}…") + one pointer to today.
 *
 * Both blocks are STRUCTURAL. The LLM composes fresh wording every
 * time, guided by the required-elements / forbidden-elements contract.
 * The block also passes `recent_greeting_openings[]` so the model
 * doesn't repeat the same opening phrase day-over-day.
 *
 * No verbatim Say-exactly here. Verbatim is the right pattern for
 * teaching moments (VTID-03104 / VTID-03120); it is the wrong pattern
 * for relational moments like the daily welcome.
 */

import type { JourneyState } from '../../../services/journey/user-journey-service';

export type JourneyGreetingKind = 'first_session' | 'daily_morning' | null;

export interface JourneyGreetingMeta {
  kind: Exclude<JourneyGreetingKind, null>;
  today_date_iso: string; // YYYY-MM-DD in user's local TZ — used to advance last_session_date after firing
}

interface BuildJourneyGreetingBlockArgs {
  journey: JourneyState | null;
  lifeCompassGoalText: string | null;
  firstName: string | null;
  lang: string;
  /** YYYY-MM-DD in the user's local TZ (derived from clientContext.timezone or UTC fallback). */
  todayDateIso: string;
  /**
   * VTID-03255 — the single Journey Foundation next move. When present it
   * becomes the daily-morning "concrete pointer to today", so the greeting
   * always drives the one guided step. Optional → omitting it keeps the prior
   * behavior unchanged.
   */
  nextMove?: { title: string; benefit: string } | null;
}

export interface JourneyGreetingResult {
  block: string;
  meta: JourneyGreetingMeta | null;
}

/**
 * Compute today's date as YYYY-MM-DD in a given IANA timezone. Falls
 * back to UTC when the timezone is missing or invalid. Pure — exported
 * for the session controller and the unit tests.
 */
export function todayInTimezone(now: Date, timezone: string | null | undefined): string {
  if (timezone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      // en-CA gives YYYY-MM-DD natively.
      return fmt.format(now);
    } catch {
      // fall through to UTC
    }
  }
  return now.toISOString().slice(0, 10);
}

/**
 * Decide which greeting fires (if any). Pure — exported for tests.
 *
 * Precedence: first_session > daily_morning > null.
 * Slice G (milestone) and Slice H (gap recovery) will eventually
 * supersede daily_morning when those slices ship; until then daily_morning
 * fires for every new-day session.
 */
export function decideGreetingKind(
  journey: JourneyState | null,
  todayDateIso: string,
): JourneyGreetingKind {
  if (!journey) return null;
  if (journey.is_first_session) return 'first_session';
  if (!journey.last_session_date) return 'daily_morning';
  if (journey.last_session_date < todayDateIso) return 'daily_morning';
  return null;
}

/**
 * Build the journey-greeting prompt block, or empty string when no
 * greeting trigger fires.
 *
 * The block is structural: it lists required and forbidden elements
 * and instructs the LLM to compose 2–4 fresh sentences satisfying the
 * contract. Anti-repetition is enforced by listing the user's recent
 * opening phrases and telling the model not to start the same way.
 */
export function buildJourneyGreetingBlock(args: BuildJourneyGreetingBlockArgs): JourneyGreetingResult {
  const kind = decideGreetingKind(args.journey, args.todayDateIso);
  if (!kind || !args.journey) return { block: '', meta: null };

  const langUpper = (args.lang || 'en').toUpperCase();
  const nameClause = args.firstName
    ? `Address the user by first name: ${args.firstName}.`
    : `You do not have a first name for this user — address them warmly without a name.`;

  const recentOpenings = (args.journey.recent_greeting_openings ?? []).slice(0, 5);
  const antiRepetition = recentOpenings.length
    ? `Your most recent opening phrases were: ${recentOpenings.map((o) => `"${o}"`).join(', ')}. Do NOT start the same way today. Compose a fresh opening.`
    : `Compose a fresh, natural opening.`;

  if (kind === 'first_session') {
    return {
      block: `

=== FIRST-SESSION WELCOME (VTID-03154 Slice C — one-time, do not repeat) ===

This is the user's FIRST session ever inside Vitanaland. Compose a fresh
3–4 sentence welcome that satisfies this contract. Speak in ${langUpper}.

REQUIRED — your welcome MUST:
- ${nameClause}
- Frame what they are starting as a JOURNEY (DE: Reise / Weg), NOT an app, tour, or platform tour.
- Explain that the **Life Compass** holds their long-term goal — what they want from this journey overall.
- Explain that the **Vitana Index** is how we measure daily progress along the way — a number that reflects how the day went across the five pillars.
- Position yourself, Vitana, as the **companion / guide** who supports them on this journey (not as an "AI assistant" or "feature").
- End with ONE open invitation to begin (a single question, not a menu).

FORBIDDEN — your welcome MUST NOT:
- List features ("we have X, Y, Z").
- Call Vitanaland a "tour", "app", "platform", or "product".
- Call the Life Compass a "tool" / "setting".
- Call the Vitana Index a "score" / "number" (call it a daily progress measure or daily reading).
- Introduce yourself as an "AI assistant" or a "feature".
- Offer a multi-option menu of next steps. ONE open invitation is enough.

STYLE: warm, first-day-of-something-meaningful, written like a knowledgeable
friend at a coffee table. Vary your wording every session — never reuse the
same opening on two consecutive days.

=== END FIRST-SESSION WELCOME ===

`,
      meta: { kind: 'first_session', today_date_iso: args.todayDateIso },
    };
  }

  // daily_morning
  const dayInJourney = args.journey.day_in_journey;
  const totalDays = args.journey.total_days;
  const phaseName = args.journey.current_wave?.name ?? null;
  const goalText = args.lifeCompassGoalText;

  const purposeClause = goalText
    ? `Reference their active Life Compass goal as the *purpose* of the journey, by inserting the goal text verbatim into a phrase like "in your plan to ${goalText}" / DE "in deinem Plan, ${goalText}". This anchors the day in WHY the journey exists.`
    : `The user has not yet set a Life Compass goal. Use a phase-based purpose instead — e.g. "in your plan to find your rhythm" if the phase is "Getting Started", or a similar phase-appropriate framing.`;

  const phaseClause = phaseName
    ? `Current phase: "${phaseName}". You may name the phase naturally, but do not lecture about it.`
    : `No active phase identified for today.`;

  // VTID-03255 — the one guided next move becomes today's concrete pointer.
  const pointerClause = args.nextMove
    ? `End with the ONE next move in the journey: ${args.nextMove.title} — ${args.nextMove.benefit} Name only this single move (not a menu), and offer to start it.`
    : `End with ONE concrete pointer to today — either name the next planned action (if you know one) OR reference the user's last meaningful step (whichever is more useful given context). NOT a menu of options.`;

  return {
    block: `

=== DAILY MORNING GREETING (VTID-03154 Slice D — first session of a new day) ===

This is the user's FIRST session of a new calendar day. Compose a fresh
2–3 sentence greeting that satisfies this contract. Speak in ${langUpper}.

REQUIRED — your greeting MUST:
- Use a time-appropriate salutation per the user's LOCAL TIME (good morning / good afternoon / good evening — pick the one that matches the local hour from the environment context block above).
- ${nameClause}
- State **"day ${dayInJourney}"** of the journey explicitly (DE: "Tag ${dayInJourney}"). The journey is ${totalDays} days total.
- ${purposeClause}
- ${pointerClause}

CONTEXT:
- ${phaseClause}
- ${antiRepetition}

FORBIDDEN — your greeting MUST NOT:
- Use a generic "hello" / "hi" without a time salutation.
- Address the user as "user" / "friend" / nameless when a first name is available.
- Call this a "session N" or "visit N" — it is "day ${dayInJourney}".
- Use generic phrases like "your wellness goals" / "your plan" when an active Life Compass goal text is available — use the goal text itself.
- Offer a 3-item menu. One concrete pointer to today is enough.

STYLE: warm but matter-of-fact, like a coach who genuinely remembers where
the user is. The user should feel located in their journey, not lectured.

=== END DAILY MORNING GREETING ===

`,
    meta: { kind: 'daily_morning', today_date_iso: args.todayDateIso },
  };
}
