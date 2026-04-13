/**
 * Intelligent Calendar — Phase 6: Natural Language Calendar Parser
 *
 * Parses natural language calendar commands for the assistant.
 * Server-side equivalent of vitana-v1/src/lib/parseCalendarNL.ts.
 *
 * Examples:
 * - "Move my yoga to 3pm tomorrow" → reschedule_event
 * - "Cancel my meetup on Friday" → cancel_event
 * - "Schedule a 30-minute walk at 7am" → create_event
 * - "Mark my morning exercise as done" → complete_event
 */

export interface CalendarAction {
  type: 'create_event' | 'reschedule_event' | 'cancel_event' | 'complete_event';
  payload: Record<string, unknown>;
  requires_confirmation: boolean;
  natural_language_summary: string;
}

// =============================================================================
// Day name resolution
// =============================================================================

const DAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function resolveDay(dayStr: string): Date | null {
  const lower = dayStr.toLowerCase().trim();
  const now = new Date();

  if (lower === 'today') return now;
  if (lower === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const dayNum = DAY_NAMES[lower];
  if (dayNum !== undefined) {
    const d = new Date(now);
    const diff = (dayNum - d.getDay() + 7) % 7 || 7; // next occurrence
    d.setDate(d.getDate() + diff);
    return d;
  }

  // Try parsing as a date
  const parsed = new Date(dayStr);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

// =============================================================================
// Time parsing
// =============================================================================

function parseTime(timeStr: string): { hours: number; minutes: number } | null {
  const lower = timeStr.toLowerCase().trim();

  // "3pm", "3:30pm", "15:00"
  const match12 = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (match12) {
    let hours = parseInt(match12[1]);
    const minutes = parseInt(match12[2] || '0');
    if (match12[3] === 'pm' && hours < 12) hours += 12;
    if (match12[3] === 'am' && hours === 12) hours = 0;
    return { hours, minutes };
  }

  const match24 = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    return { hours: parseInt(match24[1]), minutes: parseInt(match24[2]) };
  }

  return null;
}

// =============================================================================
// Duration parsing
// =============================================================================

function parseDuration(text: string): number | null {
  const match = text.match(/(\d+)\s*(?:min(?:ute)?s?|m\b)/i);
  if (match) return parseInt(match[1]);

  const hourMatch = text.match(/(\d+)\s*(?:hour|hr|h)\b/i);
  if (hourMatch) return parseInt(hourMatch[1]) * 60;

  return null;
}

// =============================================================================
// Main parser
// =============================================================================

/**
 * Attempt to parse a natural language calendar command.
 * Returns null if the message doesn't look like a calendar command.
 */
export function parseCalendarCommand(message: string): CalendarAction | null {
  const lower = message.toLowerCase().trim();

  // ── Cancel patterns ──
  if (/\b(cancel|remove|delete)\b.*\b(event|meetup|appointment|session|task)\b/i.test(lower) ||
      /\b(event|meetup|appointment)\b.*\b(cancel|remove)\b/i.test(lower)) {
    const eventMatch = message.match(/(?:cancel|remove|delete)\s+(?:my\s+)?(.+?)(?:\s+on\s+(.+))?$/i);
    return {
      type: 'cancel_event',
      payload: {
        match_title: eventMatch?.[1]?.trim() || '',
        date: eventMatch?.[2] ? resolveDay(eventMatch[2])?.toISOString() : undefined,
      },
      requires_confirmation: true,
      natural_language_summary: `Cancel "${eventMatch?.[1]?.trim() || 'event'}"`,
    };
  }

  // ── Complete / mark done patterns ──
  if (/\b(mark|complete|done|finish|did)\b/i.test(lower) &&
      /\b(event|task|exercise|yoga|walk|workout|entry|diary)\b/i.test(lower)) {
    const eventMatch = message.match(/(?:mark|complete|finish)\s+(?:my\s+)?(.+?)(?:\s+as\s+done)?$/i);
    return {
      type: 'complete_event',
      payload: {
        match_title: eventMatch?.[1]?.trim() || '',
        completion_status: 'completed',
      },
      requires_confirmation: false,
      natural_language_summary: `Mark "${eventMatch?.[1]?.trim() || 'event'}" as completed`,
    };
  }

  // ── Reschedule / move patterns ──
  if (/\b(move|reschedule|change|shift|push)\b/i.test(lower)) {
    const moveMatch = message.match(/(?:move|reschedule|change|shift|push)\s+(?:my\s+)?(.+?)\s+to\s+(.+)/i);
    if (moveMatch) {
      const eventTitle = moveMatch[1].trim();
      const targetStr = moveMatch[2].trim();

      // Parse target: "3pm tomorrow", "Friday at 2pm", "3pm"
      let targetDate: Date | null = null;
      let targetTime: { hours: number; minutes: number } | null = null;

      const parts = targetStr.split(/\s+(?:at|on)\s+/i);
      for (const part of parts) {
        const d = resolveDay(part);
        if (d) targetDate = d;
        const t = parseTime(part);
        if (t) targetTime = t;
      }
      // Also try the whole string as time
      if (!targetTime) targetTime = parseTime(targetStr);

      return {
        type: 'reschedule_event',
        payload: {
          match_title: eventTitle,
          new_date: targetDate?.toISOString(),
          new_time: targetTime ? `${String(targetTime.hours).padStart(2, '0')}:${String(targetTime.minutes).padStart(2, '0')}` : undefined,
        },
        requires_confirmation: true,
        natural_language_summary: `Move "${eventTitle}" to ${targetStr}`,
      };
    }
  }

  // ── Create / schedule patterns ──
  if (/\b(schedule|add|create|book|plan|set up)\b/i.test(lower)) {
    const createMatch = message.match(/(?:schedule|add|create|book|plan|set up)\s+(?:a\s+)?(.+?)(?:\s+(?:at|for)\s+(.+))?$/i);
    if (createMatch) {
      const titleRaw = createMatch[1].trim();
      const whenStr = createMatch[2]?.trim();

      const duration = parseDuration(titleRaw) || parseDuration(message) || 30;
      const title = titleRaw.replace(/\d+\s*(?:min(?:ute)?s?|hour|hr|h)\s*/gi, '').trim();

      let time: { hours: number; minutes: number } | null = null;
      let date: Date | null = null;
      if (whenStr) {
        const parts = whenStr.split(/\s+(?:on|at)\s+/i);
        for (const part of parts) {
          const d = resolveDay(part);
          if (d) date = d;
          const t = parseTime(part);
          if (t) time = t;
        }
        if (!time) time = parseTime(whenStr);
        if (!date) date = resolveDay(whenStr);
      }

      return {
        type: 'create_event',
        payload: {
          title: title || titleRaw,
          duration_minutes: duration,
          date: date?.toISOString(),
          time: time ? `${String(time.hours).padStart(2, '0')}:${String(time.minutes).padStart(2, '0')}` : undefined,
        },
        requires_confirmation: true,
        natural_language_summary: `Schedule "${title || titleRaw}" (${duration} min)${whenStr ? ` at ${whenStr}` : ''}`,
      };
    }
  }

  return null;
}
