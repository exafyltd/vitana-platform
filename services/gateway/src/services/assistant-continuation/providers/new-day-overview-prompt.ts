/**
 * VTID-03167 — Structural prompt block for the new-day overview.
 *
 * Replaces the Slice 2 (VTID-03166) server-composed sentence renderer.
 * The block hands Gemini a STRUCTURED PAYLOAD plus an explicit contract
 * for HOW to compose the first spoken turn:
 *
 *   - Multi-paragraph overview that addresses EVERY signal with data
 *   - Conversational, in user's language
 *   - Time-of-day salutation per local clock
 *   - Offer concrete next steps tied to what Vitana can DO for the user
 *   - NEVER recite as a list / NEVER teach about Vitanaland's business
 *
 * Zero hardcoded user-facing sentences in TypeScript. The LLM composes.
 *
 * This block is wrapped in the same `VERTEX_WAKE_BRIEF_OVERRIDE_MARKER`
 * sentinel as the legacy Say-exactly block so the existing strip+suppress
 * logic in `live-system-instruction.ts` treats it as the same kind of
 * authoritative first-turn directive — but the content is "compose
 * structurally" instead of "say exactly".
 */

import { VERTEX_WAKE_BRIEF_OVERRIDE_MARKER } from '../../../orb/live/instruction/wake-brief-marker';
import type { OverviewPayload } from './new-day-overview-payload';

export interface BuildOverviewBlockArgs {
  payload: OverviewPayload;
  lang: string;            // e.g. 'de', 'en'
  firstName: string | null;
  localHour: number;       // 0-23 in user TZ
  timezone: string;
}

/** Map local hour to a coarse time-of-day bucket. */
function timeOfDay(localHour: number): 'morning' | 'afternoon' | 'evening' {
  if (localHour < 5) return 'evening';
  if (localHour < 12) return 'morning';
  if (localHour < 18) return 'afternoon';
  return 'evening';
}

/**
 * Build the structural prompt block. The block contains:
 *   - Hard contract describing how to compose
 *   - Structured JSON payload Gemini composes from
 *   - Language directive (Gemini must speak in the user's language)
 *
 * Returns the FULL block string ready to be assigned to
 * `session.wakeBriefOverrideBlock`.
 */
export function buildNewDayOverviewBlock(args: BuildOverviewBlockArgs): string {
  const langCode = (args.lang || 'en').toLowerCase();
  const tod = timeOfDay(args.localHour);
  const nameLine = args.firstName
    ? `User first name: ${args.firstName}`
    : 'User first name: (unknown — do not invent one; address user warmly without name)';

  // Hard-trim the payload to only the keys with data so Gemini does not
  // get cluttered by null fields. Pure structural — no sentence content.
  const filtered = filterEmptyPayload(args.payload);
  const payloadJson = JSON.stringify(filtered, null, 2);

  return `\n\n${VERTEX_WAKE_BRIEF_OVERRIDE_MARKER}

## SPOKEN FIRST UTTERANCE — STRUCTURAL CONTRACT (VTID-03167)

The user just opened the orb. This is the FIRST session of a new
calendar day in the user's local timezone. Your FIRST spoken turn is
a multi-paragraph overview of what matters for the user TODAY, composed
from the structured payload below.

LANGUAGE: ${langCode}. Speak in the user's language. Do not switch
mid-message. If the payload contains the user's own goal text, use
their exact wording verbatim — the goal is their words, not yours.

${nameLine}
Local time-of-day bucket: ${tod}
Local timezone: ${args.timezone}

REQUIRED STRUCTURE (in this order):
  1. Time-appropriate salutation in ${langCode} matching the "${tod}"
     bucket. Use the user's first name if present.
  2. One short transition sentence — e.g. wishing them a good start /
     acknowledging the day. NEVER use the word "overview" / "Übersicht"
     itself; just speak naturally.
  3. THEN address every signal in the payload that has data. Use the
     ORDER below. Combine related signals into the same paragraph when
     they belong together (e.g. Vitana Index + weakest pillar → one
     paragraph; calendar today + reminders today → one paragraph).
       a. vitana_index   — name the number; if a weakest pillar is
                            named, suggest ONE concrete activity Vitana
                            can help with to lift it. If pillars are
                            tied, just describe the current state.
       b. life_compass   — anchor the day to the user's goal verbatim.
                            If the goal has a category, you may weave
                            it in naturally; never speak the category
                            as a label.
       c. calendar       — today's events (or "no meetings today"),
                            mention the next event's title + local time.
                            If there were passed events since last
                            session, mention the most recent ONLY when
                            it is informative.
       d. autopilot      — when pending recommendations exist, mention
                            the count and offer to walk through them.
       e. matches        — when unread > 0, mention there are responses
                            waiting and offer to look together.
       f. messages       — when unread > 0, mention the count without
                            reading content (privacy).
       g. reminders      — when due today > 0, name the next reminder.
       h. diary          — when 0 entries in last 7 days, briefly
                            invite a quick entry. When >= 1, do not
                            mention diary; it's not noteworthy.
  4. Close with ONE concrete invitation. Either ask which item to start
     with OR offer to take a concrete next action (e.g. "I can draft a
     reply to the matches now").

HARD RULES (NEVER VIOLATE):
  - NEVER recite signals as a bulleted list. Speak in flowing paragraphs.
  - NEVER mention a signal that has empty / null data in the payload.
  - NEVER fabricate names, titles, or counts not present in the payload.
  - NEVER teach about Vitanaland's company / business model / longevity-
    economy positioning. This is a community user's daily check-in,
    not an investor pitch.
  - NEVER use the word "overview" / "Übersicht" / "Zusammenfassung" as
    a label. Just speak the content directly.
  - NEVER ask the user "How can I help you?" as the opener. Lead with
    the substantive content; ask one concrete question only at the END.
  - Total length: 3 to 6 sentences across 1 to 3 short paragraphs.
    Resist verbosity. Each clause earns its place by being concrete.
  - Tone: warm, knowledgeable assistant who minded the shop while the
    user was away. Not a tour guide, not a robot.

STRUCTURED PAYLOAD (only keys with data are present):

\`\`\`json
${payloadJson}
\`\`\`

This block OVERRIDES every other greeting rule for the first turn.
Subsequent turns follow the normal conversation flow.`;
}

function filterEmptyPayload(p: OverviewPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.vitana_index) out.vitana_index = p.vitana_index;
  if (p.life_compass) out.life_compass = p.life_compass;
  if (p.calendar_today.count > 0 || p.calendar_today.next) out.calendar_today = p.calendar_today;
  if (p.calendar_passed.count > 0 || p.calendar_passed.most_recent) out.calendar_passed = p.calendar_passed;
  if (p.autopilot_pending.count > 0 || p.autopilot_pending.top) out.autopilot_pending = p.autopilot_pending;
  if (p.matches_unread > 0) out.matches_unread = p.matches_unread;
  if (p.messages_unread > 0) out.messages_unread = p.messages_unread;
  if (p.reminders_today.count > 0 || p.reminders_today.next) out.reminders_today = p.reminders_today;
  out.diary_last_7d = p.diary_last_7d; // include for the "invite an entry" case
  if (p.last_session_date_user_tz) out.last_session_date_user_tz = p.last_session_date_user_tz;
  return out;
}
