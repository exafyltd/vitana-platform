/**
 * VTID-04604 — a voice session writes to the member's calendar only when the
 * member asked for it and confirmed it.
 *
 * Live staging (VTID-04487, 2026-09-24): during the greeting, before the member
 * had said a word, the model called create_calendar_event and created
 * "Nutrition Improvement Plan" dated 2026-04-15 (in the past) on the member's
 * calendar. The tool description already said "confirm before calling"; the
 * model did not. These checks are code, not prompt, so they hold regardless.
 *
 * Returns null when the write may proceed, else the refusal to hand back to
 * the model (written as intent, never as a sentence to speak — NEVER rule 41).
 */

export interface CalendarWriteContext {
  /** The member has said something in this session (a stored user turn or live input). */
  memberHasSpoken: boolean;
  /** The model's `confirmed` argument. */
  confirmed: unknown;
  /** Requested start time (ISO 8601). */
  startTime: string;
  /** Clock, ms. */
  nowMs: number;
}

/** Tolerance for a "now"-ish start (clock skew, "in a minute"). */
export const PAST_START_TOLERANCE_MS = 10 * 60 * 1000;

export function checkVoiceCalendarWrite(ctx: CalendarWriteContext): string | null {
  if (!ctx.memberHasSpoken) {
    return 'STATUS: not_created. The member has not asked for anything yet in this session. Never create calendar events on your own initiative; only when the member asks, and only after they confirm the details.';
  }
  if (ctx.confirmed !== true) {
    return 'STATUS: needs_confirmation. Nothing was created. Read the title, date and time back to the member in your own words and ask them to confirm; call again with confirmed=true only after they say yes.';
  }
  const start = Date.parse(ctx.startTime);
  if (!Number.isFinite(start)) {
    return 'STATUS: not_created. The start time is not a valid date. Ask the member when the event should take place.';
  }
  if (start < ctx.nowMs - PAST_START_TOLERANCE_MS) {
    return 'STATUS: not_created. That start time is in the past. Check today\'s date and ask the member for the correct date and time.';
  }
  return null;
}

/** True when the session holds any user speech: a stored user turn or buffered live input. */
export function memberHasSpoken(session: {
  transcriptTurns?: Array<{ role: string; text?: string }> | null;
  inputTranscriptBuffer?: string | null;
}): boolean {
  if ((session.inputTranscriptBuffer || '').trim().length > 0) return true;
  return (session.transcriptTurns ?? []).some((t) => t.role === 'user' && (t.text || '').trim().length > 0);
}
