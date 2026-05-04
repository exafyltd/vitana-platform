/**
 * VTID-02601 — Reminders service
 *
 * Shared logic for the REST routes (/api/v1/reminders) and the ORB voice
 * tools (set_reminder, find_reminders, delete_reminder). Keeping the create
 * + soft-delete + tts-prerender paths in one place means voice and UI emit
 * the same OASIS events and run the same validation.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';

const VTID = 'VTID-02601';
const REMINDER_VTID = 'VTID-REMINDER';

const MIN_LEAD_MS = 60_000;          // 60s — see Plan-agent: <60s falls through to push-only
const MAX_LEAD_MS = 90 * 86_400_000; // 90 days — sanity cap for hallucinated dates

export interface CreateReminderInput {
  user_id: string;
  tenant_id: string;
  action_text: string;
  spoken_message: string;
  scheduled_for_iso: string;
  user_tz: string;
  description?: string;
  created_via: 'voice' | 'ui' | 'system';
  calendar_event_id?: string | null;
  lang?: string;
}

export interface ReminderRow {
  id: string;
  user_id: string;
  tenant_id: string;
  action_text: string;
  spoken_message: string;
  description: string | null;
  next_fire_at: string;
  user_tz: string;
  status: string;
  delivery_via: string | null;
  fired_at: string | null;
  acked_at: string | null;
  snooze_count: number;
  tts_audio_b64: string | null;
  tts_voice: string | null;
  tts_lang: string | null;
  calendar_event_id: string | null;
  created_via: string;
  created_at: string;
  updated_at: string;
}

export class ReminderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderValidationError';
  }
}

/** Validates and normalizes the inputs. Throws ReminderValidationError on bad input. */
export function validateReminderInput(input: CreateReminderInput): {
  fireAt: Date;
  actionText: string;
  spokenMessage: string;
} {
  const actionText = (input.action_text || '').trim();
  const spokenMessage = (input.spoken_message || '').trim();
  if (!actionText) throw new ReminderValidationError('action_text is required');
  if (!spokenMessage) throw new ReminderValidationError('spoken_message is required');
  if (actionText.length > 200) throw new ReminderValidationError('action_text too long (max 200 chars)');
  if (spokenMessage.length > 1000) throw new ReminderValidationError('spoken_message too long (max 1000 chars)');

  const fireAt = new Date(input.scheduled_for_iso);
  if (isNaN(fireAt.getTime())) {
    throw new ReminderValidationError(`scheduled_for_iso is not a valid timestamp: ${input.scheduled_for_iso}`);
  }
  const now = Date.now();
  if (fireAt.getTime() < now + MIN_LEAD_MS) {
    throw new ReminderValidationError('Time must be at least 60 seconds in the future');
  }
  if (fireAt.getTime() > now + MAX_LEAD_MS) {
    throw new ReminderValidationError('Time must be within 90 days');
  }

  return { fireAt, actionText, spokenMessage };
}

/**
 * Pre-render the spoken message via the same Cloud TTS path the ORB uses,
 * returning base64-encoded MP3. Best-effort — if TTS fails we still create
 * the reminder but the tick endpoint will retry rendering at fire time.
 */
export async function preRenderReminderTts(
  spokenMessage: string,
  lang: string,
): Promise<{ audio_b64: string | null; voice: string | null; lang: string }> {
  try {
    const { synthesizeReminderTts } = await import('./reminder-tts');
    const result = await synthesizeReminderTts(spokenMessage, lang);
    return result;
  } catch (err: any) {
    console.warn(`[${VTID}] preRenderReminderTts failed (non-fatal): ${err?.message}`);
    return { audio_b64: null, voice: null, lang };
  }
}

/**
 * Insert a reminder row + emit OASIS event. Used by both REST and voice paths.
 * Caller is responsible for auth — `user_id` and `tenant_id` must be vetted.
 */
export async function createReminder(
  admin: SupabaseClient,
  input: CreateReminderInput,
): Promise<ReminderRow> {
  const { fireAt, actionText, spokenMessage } = validateReminderInput(input);
  const lang = (input.lang || 'en').toLowerCase().slice(0, 5);

  const tts = await preRenderReminderTts(spokenMessage, lang);

  const { data, error } = await admin
    .from('reminders')
    .insert({
      user_id: input.user_id,
      tenant_id: input.tenant_id,
      action_text: actionText,
      spoken_message: spokenMessage,
      description: input.description || null,
      next_fire_at: fireAt.toISOString(),
      user_tz: input.user_tz || 'UTC',
      tts_audio_b64: tts.audio_b64,
      tts_voice: tts.voice,
      tts_lang: tts.lang,
      calendar_event_id: input.calendar_event_id || null,
      created_via: input.created_via,
    })
    .select('*')
    .single();

  if (error) throw new Error(`reminders insert failed: ${error.message}`);

  emitOasisEvent({
    type: 'reminder.created' as any,
    source: 'gateway',
    vtid: REMINDER_VTID,
    status: 'info',
    message: `Reminder created via ${input.created_via}`,
    payload: {
      reminder_id: data.id,
      source: input.created_via,
      fire_at: data.next_fire_at,
      tts_prerendered: !!tts.audio_b64,
    },
  }).catch((e) => console.warn(`[${VTID}] OASIS emit failed: ${e?.message}`));

  return data as ReminderRow;
}

/**
 * Spawn a system-origin reminder on behalf of an autopilot recommendation
 * and link the rows together. Used by server-side callers (recommendation
 * engine, automation handlers, future autopilot-worker integrations) to
 * populate the "Suggested by Vitana" surface on the frontend.
 *
 * The created reminder always has `created_via='system'`, so callers should
 * NOT use this path for user-initiated scheduling — that still goes through
 * `createReminder({...created_via:'ui'|'voice'})`.
 *
 * Sets `autopilot_recommendations.linked_reminder_id` to the new reminder's
 * id. Best-effort: if the link update fails, the reminder still exists and
 * the failure is logged (the back-link is a navigability nicety, not a
 * correctness invariant).
 */
export async function createReminderForRecommendation(
  admin: SupabaseClient,
  recommendationId: string,
  input: Omit<CreateReminderInput, 'created_via'>,
): Promise<ReminderRow> {
  const reminder = await createReminder(admin, { ...input, created_via: 'system' });

  const { error: linkErr } = await admin
    .from('autopilot_recommendations')
    .update({ linked_reminder_id: reminder.id, updated_at: new Date().toISOString() })
    .eq('id', recommendationId);
  if (linkErr) {
    console.warn(
      `[${VTID}] linked_reminder_id update failed for recommendation ${recommendationId}: ${linkErr.message}`,
    );
  }

  return reminder;
}

/**
 * Soft-delete a reminder (single) or all active reminders for a user.
 * Returns the number of rows cancelled. Emits a single OASIS event.
 */
export async function softDeleteReminders(
  admin: SupabaseClient,
  userId: string,
  scope: { mode: 'single'; reminder_id: string } | { mode: 'all' },
  source: 'voice' | 'ui',
  context?: { confirmation?: string },
): Promise<{ deleted: number; action_text?: string }> {
  if (scope.mode === 'single') {
    const { data, error } = await admin
      .from('reminders')
      .update({ status: 'cancelled' })
      .eq('id', scope.reminder_id)
      .eq('user_id', userId)
      .in('status', ['pending', 'dispatching', 'fired'])
      .select('id, action_text')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { deleted: 0 };

    emitOasisEvent({
      type: 'reminder.deleted' as any,
      source: 'gateway',
      vtid: REMINDER_VTID,
      status: 'info',
      message: `Reminder cancelled via ${source}`,
      payload: {
        reminder_id: data.id,
        source,
        mode: 'single',
        confirmation: context?.confirmation,
      },
    }).catch(() => {});
    return { deleted: 1, action_text: (data as any).action_text };
  }

  // mode === 'all'
  const { data, error } = await admin
    .from('reminders')
    .update({ status: 'cancelled' })
    .eq('user_id', userId)
    .in('status', ['pending', 'dispatching', 'fired'])
    .select('id');
  if (error) throw new Error(error.message);
  const count = data?.length || 0;

  emitOasisEvent({
    type: 'reminder.deleted' as any,
    source: 'gateway',
    vtid: REMINDER_VTID,
    status: 'info',
    message: `${count} reminder(s) cancelled via ${source}`,
    payload: {
      source,
      mode: 'all',
      count,
      confirmation: context?.confirmation,
    },
  }).catch(() => {});

  return { deleted: count };
}

/**
 * Find a user's reminders by free-text query. Used by the find_reminders voice
 * tool and by the REST GET /reminders endpoint when ?q= is supplied.
 */
export async function findReminders(
  admin: SupabaseClient,
  userId: string,
  opts: { query?: string; include_fired?: boolean; limit?: number },
): Promise<ReminderRow[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const statuses = opts.include_fired
    ? ['pending', 'dispatching', 'fired']
    : ['pending', 'dispatching'];

  let qb = admin
    .from('reminders')
    .select('*')
    .eq('user_id', userId)
    .in('status', statuses)
    .order('next_fire_at', { ascending: true })
    .limit(limit);

  const q = (opts.query || '').trim();
  if (q) {
    // ilike against both fields. Supabase JS .or() takes a comma-separated PostgREST filter string.
    const escaped = q.replace(/[,)]/g, ' ');
    qb = qb.or(`action_text.ilike.%${escaped}%,spoken_message.ilike.%${escaped}%`);
  }

  const { data, error } = await qb;
  if (error) throw new Error(error.message);
  return (data || []) as ReminderRow[];
}

/**
 * Format an absolute timestamp for spoken voice in the user's locale.
 * Used by voice tool confirmations ("Okay, I'll remind you at 8 PM today").
 */
export function formatTimeForVoice(date: Date, userTz: string, locale: string): string {
  try {
    const opts: Intl.DateTimeFormatOptions = {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: userTz || 'UTC',
    };
    const today = new Date();
    const sameDay =
      date.toLocaleDateString('en-CA', { timeZone: userTz || 'UTC' }) ===
      today.toLocaleDateString('en-CA', { timeZone: userTz || 'UTC' });
    const time = new Intl.DateTimeFormat(locale || 'en', opts).format(date);
    if (sameDay) return time;
    const dateStr = new Intl.DateTimeFormat(locale || 'en', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: userTz || 'UTC',
    }).format(date);
    return `${dateStr} at ${time}`;
  } catch {
    return date.toISOString();
  }
}
