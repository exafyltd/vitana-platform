/**
 * VTID-04917 — the audiobook daily reminder in the member's calendar.
 *
 * One recurring entry per member, kept in step with the reminder setting:
 *   set / change → upsert (FREQ=DAILY at the chosen local time, in the
 *                  member's time zone, 20 minutes long);
 *   switch off   → cancel.
 * reminder_offsets = [] so the calendar reminder loop never pushes for it;
 * the audiobook dispatcher (audiobook-reminder-dispatch.ts) stays the only
 * sender. The app opens the player from it ("Listen now"); listening is
 * tracked by the player, never by marking the entry done.
 *
 * A calendar failure never fails the reminder itself: it is logged and the
 * member's setting is saved either way.
 */
import { upsertCalendarEntryFromSource, cancelCalendarEntriesForSource } from '../calendar-producers';
import type { AudiobookReminderPref } from '../../types/guided-journey';

const LOG_PREFIX = '[AudiobookCalendar]';
export const AUDIOBOOK_SOURCE_REF_TYPE = 'audiobook_reminder';
export const AUDIOBOOK_ENTRY_MINUTES = 20;

/** Offset of `timeZone` from UTC at `instant`, in minutes (Berlin summer → 120). */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The first occurrence: today (in the member's zone) at the chosen local
 * time, as a UTC instant. DST-safe: the offset is taken at the target time.
 */
export function audiobookEntryStart(pref: AudiobookReminderPref, now: Date = new Date()): Date {
  const [hh, mm] = pref.time.split(':').map(Number);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: pref.tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now)
    .split('-')
    .map(Number);
  const naive = Date.UTC(day[0], day[1] - 1, day[2], hh, mm);
  const firstGuess = naive - zoneOffsetMinutes(new Date(naive), pref.tz) * 60_000;
  return new Date(naive - zoneOffsetMinutes(new Date(firstGuess), pref.tz) * 60_000);
}

export type AudiobookCalendarSync = 'upserted' | 'cancelled' | 'failed';

/** Keeps the member's audiobook calendar entry in step with their reminder. */
export async function syncAudiobookCalendarEntry(
  userId: string,
  pref: AudiobookReminderPref | null,
  now: Date = new Date(),
): Promise<AudiobookCalendarSync> {
  try {
    if (!pref) {
      await cancelCalendarEntriesForSource(userId, AUDIOBOOK_SOURCE_REF_TYPE, userId);
      return 'cancelled';
    }
    const start = audiobookEntryStart(pref, now);
    const result = await upsertCalendarEntryFromSource(
      userId,
      { source_type: 'audiobook', source_ref_type: AUDIOBOOK_SOURCE_REF_TYPE, source_ref_id: userId },
      {
        // English fallback; the app shows a localised title for source_type 'audiobook'.
        title: 'Audiobook',
        start_time: start.toISOString(),
        end_time: new Date(start.getTime() + AUDIOBOOK_ENTRY_MINUTES * 60_000).toISOString(),
        event_type: 'wellness_nudge',
        role_context: 'community',
        rrule: 'FREQ=DAILY',
        timezone: pref.tz,
        reminder_offsets: [],
        emoji: '🎧',
        metadata: { kind: 'audiobook', time: pref.time },
      } as any,
    );
    if (result.action === 'failed') {
      console.error(`${LOG_PREFIX} upsert failed for ${userId}: ${result.error ?? 'unknown'}`);
      return 'failed';
    }
    return 'upserted';
  } catch (err: any) {
    console.error(`${LOG_PREFIX} sync failed for ${userId}: ${err?.message}`);
    return 'failed';
  }
}
