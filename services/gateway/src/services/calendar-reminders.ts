/**
 * VTID-04338 — every calendar entry reminds by default.
 *
 * A reconcile loop turns calendar entries into rows in `reminders` — the
 * table the existing pipeline already delivers (tick → full-screen SSE
 * overlay in the app + push to the phone). One row per (entry, occurrence,
 * offset); the row set is recomputed every minute, so a moved entry gets its
 * reminder moved, and a cancelled, completed or deleted entry loses its
 * pending reminders.
 *
 * Which reminders an entry gets (owner-approved 2026-09-23):
 *   entry.reminder_offsets set   exactly those minutes-before ('{}' = none)
 *   lab test                     the evening before (19:00 local) + 1 h before
 *   workout                      30 min before
 *   habit / nudge / Autopilot    at the time itself
 *   everything else (meetings,   10 min before
 *   events, health, work)
 *
 * Only reminders firing in the next MATERIALIZE_HORIZON are written, so the
 * table holds a small, fresh set instead of months of rows for a daily habit.
 *
 * VTID-04373:
 *   - Quiet hours. A default reminder that would fire inside the member's
 *     Do-Not-Disturb window (user_notification_preferences.dnd_*, local time)
 *     fires one minute before the window starts instead — never inside it,
 *     never after the entry. If another reminder for the same occurrence
 *     already fires in the QUIET_DEDUP_MS before that, the moved one is
 *     dropped (a lab gets the 19:00 heads-up, not a second one at 21:59).
 *     An entry's own reminder_offsets are a deliberate choice and are left
 *     where the member put them.
 *   - Text refresh. A pending reminder whose entry was renamed (or whose
 *     wording changed) gets its text rewritten on the next reconcile; before
 *     this the text was fixed at insert.
 */

import { CalendarEvent } from '../types/calendar';
import { expandOccurrences, localParts, zonedTimeToEpoch } from './calendar-recurrence';
import { formatLocalHHMM, resolveUserTimezone } from './guide/user-timezone';

const LOG_PREFIX = '[CalendarReminders]';
const MINUTE = 60_000;
export const MATERIALIZE_HORIZON_MS = 36 * 60 * MINUTE;
/** The longest lead allowed by valid_reminder_offsets (4 weeks). */
export const MAX_LEAD_MS = 40_320 * MINUTE;
/** A due reminder stays valid this long, so a reconcile never races the tick. */
const VALIDITY_LOOKBACK_MS = 24 * 60 * MINUTE;

export type ReminderRule = { kind: 'before'; minutes: number } | { kind: 'evening_before'; hour: number };

export type ReminderEntry = Pick<
  CalendarEvent,
  'id' | 'user_id' | 'title' | 'start_time' | 'end_time' | 'event_type' | 'source_type' | 'status' | 'completed_at'
> & {
  source_ref_type?: string | null;
  rrule?: string | null;
  timezone?: string | null;
  reminder_offsets?: number[] | null;
  emoji?: string | null;
  role_context?: string | null;
};

/** Default emoji per entry kind; the UI uses the same map. */
export const DEFAULT_EMOJI: Record<string, string> = {
  personal: '📌',
  community: '🎉',
  professional: '💼',
  health: '🩺',
  workout: '🏃',
  nutrition: '🥗',
  autopilot: '✨',
  journey_milestone: '🏁',
  dev_task: '🛠️',
  deployment: '🚀',
  sprint_milestone: '🎯',
  admin_task: '🗂️',
  wellness_nudge: '🌱',
  lab: '🧪',
};

function isLab(e: ReminderEntry): boolean {
  return e.source_type === 'lab_order' || (e.source_ref_type ?? '').startsWith('lab_');
}

export function entryEmoji(e: ReminderEntry): string {
  if (e.emoji) return e.emoji;
  if (isLab(e)) return DEFAULT_EMOJI.lab;
  return DEFAULT_EMOJI[e.event_type] ?? '📌';
}

export function reminderRules(e: ReminderEntry): ReminderRule[] {
  if (Array.isArray(e.reminder_offsets)) {
    return [...new Set(e.reminder_offsets)].map((minutes) => ({ kind: 'before' as const, minutes }));
  }
  if (isLab(e)) return [{ kind: 'evening_before', hour: 19 }, { kind: 'before', minutes: 60 }];
  switch (e.event_type) {
    case 'workout':
      return [{ kind: 'before', minutes: 30 }];
    case 'wellness_nudge':
    case 'nutrition':
    case 'autopilot':
    case 'journey_milestone':
      return [{ kind: 'before', minutes: 0 }];
    default:
      return [{ kind: 'before', minutes: 10 }];
  }
}

/** A member's quiet hours, as local minutes of the day. start === end means off. */
export interface QuietWindow {
  startMin: number;
  endMin: number;
}

/** Another reminder this close before a moved one makes the moved one redundant. */
export const QUIET_DEDUP_MS = 6 * 60 * MINUTE;

/** "22:00" / "22:00:00" → minutes of the day; null for anything else. */
function hhmmToMinutes(v: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/** The member's quiet window from their notification preferences row, or null. Pure. */
export function quietWindowFromPrefs(
  prefs: { dnd_enabled?: boolean | null; dnd_start_time?: string | null; dnd_end_time?: string | null } | null | undefined,
): QuietWindow | null {
  if (!prefs?.dnd_enabled) return null;
  const startMin = hhmmToMinutes(prefs.dnd_start_time);
  const endMin = hhmmToMinutes(prefs.dnd_end_time);
  if (startMin === null || endMin === null || startMin === endMin) return null;
  return { startMin, endMin };
}

/** True when `epochMs` falls inside the window in `tz` (the window may wrap midnight). Pure. */
export function inQuietWindow(epochMs: number, w: QuietWindow, tz: string): boolean {
  const p = localParts(epochMs, tz);
  const m = p.h * 60 + p.mi;
  return w.startMin < w.endMin ? m >= w.startMin && m < w.endMin : m >= w.startMin || m < w.endMin;
}

/**
 * One minute before the quiet window that contains `fireMs` began. Only
 * meaningful when inQuietWindow(fireMs) is true. Pure, DST-aware.
 */
export function beforeQuietWindow(fireMs: number, w: QuietWindow, tz: string): number {
  const p = localParts(fireMs, tz);
  const m = p.h * 60 + p.mi;
  // A wrapping window entered yesterday evening when we are in its morning half.
  const daysBack = w.startMin > w.endMin && m < w.endMin ? 1 : 0;
  const day = new Date(Date.UTC(p.y, p.mo - 1, p.d) - daysBack * 86_400_000);
  const start = zonedTimeToEpoch(
    day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(w.startMin / 60), w.startMin % 60, 0, tz,
  );
  return start - MINUTE;
}

export interface DesiredReminder {
  key: string;
  user_id: string;
  calendar_event_id: string;
  occurrence_start: string; // ISO
  offset_minutes: number;
  fire_at: string; // ISO
  rule: ReminderRule['kind'];
  timezone: string;
  /** True when quiet hours moved this reminder earlier (VTID-04373). */
  quiet_shifted?: boolean;
}

export function reminderKey(eventId: string, occurrenceStart: string, offsetMinutes: number): string {
  return `${eventId}|${new Date(occurrenceStart).toISOString()}|${offsetMinutes}`;
}

/** Epoch ms of `hour`:00 local on the day before the local date of `startMs`. */
function eveningBefore(startMs: number, hour: number, tz: string): number {
  // Local date of the start, then step back one calendar day.
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(startMs));
  const [y, m, d] = localDate.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  // Local hour:00 on that day → epoch (two-pass offset fix, DST-safe).
  const asUtc = Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate(), hour, 0, 0);
  const offsetAt = (t: number) => {
    const p: Record<string, number> = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = Number(part.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  let t = asUtc - offsetAt(asUtc);
  t = asUtc - offsetAt(t);
  return t;
}

/**
 * Every reminder the given entries should have whose fire time lies in
 * [now - lookback, now + horizon]. Pure.
 */
export function computeDesiredReminders(
  entries: ReminderEntry[],
  opts: {
    now: number;
    horizonMs?: number;
    lookbackMs?: number;
    tzOf: (userId: string) => string;
    /** The member's quiet hours; default reminders never fire inside them. */
    quietOf?: (userId: string) => QuietWindow | null;
  },
): DesiredReminder[] {
  const horizon = opts.horizonMs ?? MATERIALIZE_HORIZON_MS;
  const lookback = opts.lookbackMs ?? VALIDITY_LOOKBACK_MS;
  const minFire = opts.now - lookback;
  const maxFire = opts.now + horizon;
  const out = new Map<string, DesiredReminder>();

  for (const e of entries) {
    if (e.status === 'cancelled' || e.completed_at) continue;
    const rules = reminderRules(e);
    if (rules.length === 0) continue;
    const tz = e.timezone || opts.tzOf(e.user_id);

    const occurrences: string[] = e.rrule
      ? expandOccurrences(
          { start_time: e.start_time, end_time: e.end_time, rrule: e.rrule, timezone: e.timezone },
          { from: new Date(minFire).toISOString(), to: new Date(maxFire + MAX_LEAD_MS).toISOString() },
          tz,
        ).map((o) => o.start)
      : [e.start_time];

    // Quiet hours apply to default reminders only; explicit offsets stay put.
    const quiet = Array.isArray(e.reminder_offsets) ? null : opts.quietOf?.(e.user_id) ?? null;

    for (const occ of occurrences) {
      const startMs = Date.parse(occ);
      if (Number.isNaN(startMs)) continue;
      const fires: Array<{ fireMs: number; rule: ReminderRule['kind']; shifted: boolean }> = [];
      for (const rule of rules) {
        let fireMs = rule.kind === 'before' ? startMs - rule.minutes * MINUTE : eveningBefore(startMs, rule.hour, tz);
        let shifted = false;
        if (quiet && inQuietWindow(fireMs, quiet, tz)) {
          fireMs = beforeQuietWindow(fireMs, quiet, tz);
          shifted = true;
        }
        fires.push({ fireMs, rule: rule.kind, shifted });
      }
      for (const f of fires) {
        if (f.shifted && fires.some((o) => !o.shifted && o.fireMs <= f.fireMs && f.fireMs - o.fireMs <= QUIET_DEDUP_MS)) continue;
        const { fireMs } = f;
        if (fireMs > startMs || fireMs < minFire || fireMs > maxFire) continue;
        const offset = Math.round((startMs - fireMs) / MINUTE);
        const key = reminderKey(e.id, occ, offset);
        if (!out.has(key)) {
          out.set(key, {
            key,
            user_id: e.user_id,
            calendar_event_id: e.id,
            occurrence_start: new Date(startMs).toISOString(),
            offset_minutes: offset,
            fire_at: new Date(fireMs).toISOString(),
            rule: f.rule,
            timezone: tz,
            ...(f.shifted ? { quiet_shifted: true } : {}),
          });
        }
      }
    }
  }
  return [...out.values()];
}

/** The localized reminder text for one desired reminder. */
export function reminderText(
  entry: ReminderEntry,
  r: DesiredReminder,
  tr: (key: string, params: Record<string, string | number>) => string,
): string {
  const title = `${entryEmoji(entry)} ${entry.title}`.trim();
  // A reminder on the day before the entry reads "tomorrow at …" — the lab
  // heads-up, a reminder moved out of quiet hours, a one-day offset.
  const fireMs = Date.parse(r.fire_at);
  const startMs = Date.parse(r.occurrence_start);
  const dayBefore =
    !Number.isNaN(fireMs) &&
    !Number.isNaN(startMs) &&
    (() => {
      const f = localParts(fireMs, r.timezone);
      const s = localParts(startMs, r.timezone);
      return Date.UTC(s.y, s.mo - 1, s.d) - Date.UTC(f.y, f.mo - 1, f.d) === 86_400_000;
    })();
  if (r.rule === 'evening_before' || (dayBefore && r.offset_minutes >= 60)) {
    return tr('notif.calendar_reminder.tomorrow', { title, time: formatLocalHHMM(r.occurrence_start, r.timezone) });
  }
  if (r.offset_minutes === 0) return tr('notif.calendar_reminder.now', { title });
  if (r.offset_minutes < 120) return tr('notif.calendar_reminder.in_minutes', { title, minutes: r.offset_minutes });
  return tr('notif.calendar_reminder.in_hours', { title, hours: Math.round(r.offset_minutes / 60) });
}

// ---------------------------------------------------------------------------
// Reconcile (I/O)
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  ok: boolean;
  entries: number;
  desired: number;
  created: number;
  cancelled: number;
  refreshed: number;
  skipped_no_tenant: number;
  error?: string;
}

function cfg(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  return url && key ? { url, key } : null;
}

function h(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

const ENTRY_COLUMNS =
  'id,user_id,title,start_time,end_time,event_type,source_type,source_ref_type,status,completed_at,rrule,timezone,reminder_offsets,emoji,role_context';

export async function reconcileCalendarReminders(now: number = Date.now()): Promise<ReconcileResult> {
  const c = cfg();
  const result: ReconcileResult = { ok: false, entries: 0, desired: 0, created: 0, cancelled: 0, refreshed: 0, skipped_no_tenant: 0 };
  if (!c) return { ...result, error: 'supabase_config_missing' };

  try {
    const scanTo = new Date(now + MATERIALIZE_HORIZON_MS + MAX_LEAD_MS).toISOString();
    const scanFrom = new Date(now - VALIDITY_LOOKBACK_MS).toISOString();
    const base = `${c.url}/rest/v1/calendar_events?select=${ENTRY_COLUMNS}&status=neq.cancelled&completed_at=is.null`;
    const [oneOffResp, recurringResp, existingResp] = await Promise.all([
      fetch(`${base}&rrule=is.null&start_time=gte.${encodeURIComponent(scanFrom)}&start_time=lt.${encodeURIComponent(scanTo)}&limit=5000`, { headers: h(c.key) }),
      fetch(`${base}&rrule=not.is.null&start_time=lt.${encodeURIComponent(scanTo)}&limit=2000`, { headers: h(c.key) }),
      fetch(
        `${c.url}/rest/v1/reminders?select=id,calendar_event_id,calendar_occurrence_start,reminder_offset_minutes,next_fire_at,action_text` +
          `&calendar_event_id=not.is.null&status=eq.pending&created_via=eq.system&limit=10000`,
        { headers: h(c.key) },
      ),
    ]);
    for (const r of [oneOffResp, recurringResp, existingResp]) {
      if (!r.ok) throw new Error(`read failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const entries = [...((await oneOffResp.json()) as ReminderEntry[]), ...((await recurringResp.json()) as ReminderEntry[])];
    const existing = (await existingResp.json()) as Array<{
      id: string; calendar_event_id: string; calendar_occurrence_start: string; reminder_offset_minutes: number; next_fire_at: string;
      action_text?: string | null;
    }>;
    result.entries = entries.length;

    // Per-user timezone, locale and tenant — resolved once per tick.
    const userIds = [...new Set(entries.map((e) => e.user_id))];
    const { createClient } = await import('@supabase/supabase-js');
    const supa = createClient(c.url, c.key);
    const { getUserTimezone } = await import('./daily-pace-service');
    const { bulkGetUserLocales } = await import('../i18n/server-locale');
    const { tt } = await import('../i18n/catalog');
    const tzByUser = new Map<string, string>();
    for (const uid of userIds) tzByUser.set(uid, resolveUserTimezone(await getUserTimezone(supa as any, uid)));
    const locales = userIds.length ? await bulkGetUserLocales(supa as any, userIds) : new Map();
    const tenantByUser = new Map<string, string>();
    if (userIds.length) {
      const list = userIds.map((u) => `"${u}"`).join(',');
      const tr = await fetch(`${c.url}/rest/v1/user_tenants?select=user_id,tenant_id,is_primary&user_id=in.(${encodeURIComponent(list)})`, { headers: h(c.key) });
      if (tr.ok) {
        for (const row of (await tr.json()) as Array<{ user_id: string; tenant_id: string; is_primary: boolean }>) {
          if (!tenantByUser.has(row.user_id) || row.is_primary) tenantByUser.set(row.user_id, row.tenant_id);
        }
      }
    }
    // Quiet hours (VTID-04373). A failed read means no quiet hours this tick —
    // reminders still arrive, at their usual time — and is logged, not thrown.
    const quietByUser = new Map<string, QuietWindow>();
    if (userIds.length) {
      const list = userIds.map((u) => `"${u}"`).join(',');
      const qr = await fetch(
        `${c.url}/rest/v1/user_notification_preferences?select=user_id,dnd_enabled,dnd_start_time,dnd_end_time` +
          `&dnd_enabled=is.true&user_id=in.(${encodeURIComponent(list)})`,
        { headers: h(c.key) },
      );
      if (qr.ok) {
        for (const row of (await qr.json()) as Array<{ user_id: string; dnd_enabled: boolean; dnd_start_time: string | null; dnd_end_time: string | null }>) {
          const w = quietWindowFromPrefs(row);
          if (w) quietByUser.set(row.user_id, w);
        }
      } else {
        console.warn(`${LOG_PREFIX} quiet-hours read failed ${qr.status}; reminders keep their usual times this tick`);
      }
    }

    const valid = computeDesiredReminders(entries, {
      now,
      tzOf: (u) => tzByUser.get(u) ?? resolveUserTimezone(null),
      quietOf: (u) => quietByUser.get(u) ?? null,
    });
    const validKeys = new Set(valid.map((d) => d.key));
    const toWrite = valid.filter((d) => Date.parse(d.fire_at) >= now - MINUTE);
    result.desired = toWrite.length;

    const existingKeys = new Set(
      existing.map((r) => reminderKey(r.calendar_event_id, r.calendar_occurrence_start, r.reminder_offset_minutes)),
    );
    const entryById = new Map(entries.map((e) => [e.id, e]));

    const rows: Record<string, unknown>[] = [];
    for (const d of toWrite) {
      if (existingKeys.has(d.key)) continue;
      const tenant = tenantByUser.get(d.user_id);
      if (!tenant) {
        result.skipped_no_tenant++;
        continue;
      }
      const entry = entryById.get(d.calendar_event_id)!;
      const lc = locales.get(d.user_id);
      const text = reminderText(entry, d, (k, p) => tt(k as any, lc, p as any));
      rows.push({
        user_id: d.user_id,
        tenant_id: tenant,
        action_text: text,
        spoken_message: text,
        next_fire_at: d.fire_at,
        user_tz: d.timezone,
        status: 'pending',
        created_via: 'system',
        calendar_event_id: d.calendar_event_id,
        calendar_occurrence_start: d.occurrence_start,
        reminder_offset_minutes: d.offset_minutes,
      });
    }
    if (rows.length) {
      const ins = await fetch(
        `${c.url}/rest/v1/reminders?on_conflict=calendar_event_id,calendar_occurrence_start,reminder_offset_minutes`,
        {
          method: 'POST',
          headers: h(c.key, { Prefer: 'resolution=ignore-duplicates,return=representation' }),
          body: JSON.stringify(rows),
        },
      );
      if (!ins.ok) throw new Error(`insert failed ${ins.status}: ${(await ins.text()).slice(0, 200)}`);
      result.created = ((await ins.json()) as unknown[]).length;
    }

    // Pending reminders still wanted, whose text no longer matches the entry
    // (renamed, emoji changed, wording changed). Rows read without text are
    // left alone — nothing to compare against.
    const desiredByKey = new Map(valid.map((d) => [d.key, d]));
    for (const r of existing) {
      if (typeof r.action_text !== 'string') continue;
      const d = desiredByKey.get(reminderKey(r.calendar_event_id, r.calendar_occurrence_start, r.reminder_offset_minutes));
      const entry = d && entryById.get(d.calendar_event_id);
      if (!d || !entry) continue;
      const text = reminderText(entry, d, (k, p) => tt(k as any, locales.get(d.user_id), p as any));
      if (text === r.action_text) continue;
      const up = await fetch(`${c.url}/rest/v1/reminders?id=eq.${encodeURIComponent(r.id)}&status=eq.pending`, {
        method: 'PATCH',
        headers: h(c.key, { Prefer: 'return=representation' }),
        body: JSON.stringify({ action_text: text, spoken_message: text, updated_at: new Date(now).toISOString() }),
      });
      if (!up.ok) throw new Error(`refresh failed ${up.status}: ${(await up.text()).slice(0, 200)}`);
      result.refreshed += ((await up.json()) as unknown[]).length;
    }

    // Pending system reminders whose entry moved, was cancelled, completed or
    // deleted, or whose offsets changed.
    const stale = existing
      .filter((r) => !validKeys.has(reminderKey(r.calendar_event_id, r.calendar_occurrence_start, r.reminder_offset_minutes)))
      .map((r) => r.id);
    for (let i = 0; i < stale.length; i += 200) {
      const ids = stale.slice(i, i + 200).map((id) => `"${id}"`).join(',');
      const up = await fetch(`${c.url}/rest/v1/reminders?id=in.(${encodeURIComponent(ids)})&status=eq.pending`, {
        method: 'PATCH',
        headers: h(c.key, { Prefer: 'return=representation' }),
        body: JSON.stringify({ status: 'cancelled', updated_at: new Date(now).toISOString() }),
      });
      if (!up.ok) throw new Error(`cancel failed ${up.status}: ${(await up.text()).slice(0, 200)}`);
      result.cancelled += ((await up.json()) as unknown[]).length;
    }

    if (result.created || result.cancelled || result.refreshed) {
      console.log(`${LOG_PREFIX} created=${result.created} cancelled=${result.cancelled} refreshed=${result.refreshed} entries=${result.entries} skipped_no_tenant=${result.skipped_no_tenant}`);
    }
    return { ...result, ok: true };
  } catch (err: any) {
    console.error(`${LOG_PREFIX} reconcile failed:`, err?.message);
    return { ...result, error: err?.message ?? 'unknown' };
  }
}

export function isCalendarRemindersEnabled(raw: string | undefined = process.env.CALENDAR_DEFAULT_REMINDERS_ENABLED): boolean {
  return raw === 'true';
}

let loopStarted = false;

/** Reconcile every 60 s, gated on CALENDAR_DEFAULT_REMINDERS_ENABLED exactly 'true'. */
export function startCalendarRemindersLoop(): boolean {
  if (loopStarted || !isCalendarRemindersEnabled()) return false;
  loopStarted = true;
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await reconcileCalendarReminders();
    } finally {
      running = false;
    }
  }, 60_000);
  t.unref?.();
  return true;
}

