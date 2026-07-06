/**
 * Awareness-signal voice tools (VTID-02778).
 *
 * Per-user awareness snapshots for the ORB assistant, one tool per Awareness
 * dimension: D28 emotional/cognitive signals, D32 situational awareness,
 * D33 availability/readiness, D34 environment/mobility and D40 life-stage
 * context. Each handler is backed by the REAL dimension engine or its
 * canonical tables — D28 reads `emotional_cognitive_signals` (falling back to
 * recent `memory_diary_entries` moods), D32/D33 call the deterministic
 * in-process engines enriched with live `calendar_events` + `reminders`
 * density, D34 calls the D34 engine seeded with the user's stored
 * `memory_facts.user_residence`, and D40 reads `life_stage_assessments` +
 * `life_stage_goals` + the active `life_compass` row + membership tenure.
 * Every spoken snapshot states what it is based on; nothing is invented.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import {
  computeSituationalAwareness,
  toOrbSituationContext,
} from '../d32-situational-awareness-engine';
import {
  computeAvailabilityReadiness,
  getCurrentAvailability,
} from '../d33-availability-readiness-engine';
import { computeContext } from '../d34-environmental-mobility-engine';
import type { TimeContextSignals, AvailabilityReadinessBundle } from '../../types/availability-readiness';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** ok:false when there is no authenticated user — all five tools read personal state. */
function authGate(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id || !id.tenant_id) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

/** "a few minutes ago" / "3 hours ago" / "2 days ago" from an ISO timestamp. */
function relativePastPhrase(iso: string | null | undefined): string {
  if (!iso) return 'recently';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'recently';
  const mins = (Date.now() - t) / 60000;
  if (mins < 10) return 'a few minutes ago';
  if (mins < 90) return `${Math.round(mins)} minutes ago`;
  if (mins < 36 * 60) return `${Math.round(mins / 60)} hours ago`;
  return `${Math.round(mins / (60 * 24))} days ago`;
}

/** "in 25 minutes" / "in about 3 hours" from a minutes-from-now count. */
function inMinutesPhrase(mins: number): string {
  if (mins <= 1) return 'right about now';
  if (mins < 90) return `in ${Math.round(mins)} minutes`;
  return `in about ${Math.round(mins / 60)} hours`;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the user's timezone: explicit tool arg first, then the timezone the
 * user last set a reminder in (`reminders.user_tz` — a real, user-provided
 * signal), else undefined (engines fall back to UTC).
 */
async function resolveUserTimezone(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<string | undefined> {
  const explicit = typeof args.timezone === 'string' ? args.timezone.trim() : '';
  if (explicit && isValidTimezone(explicit)) return explicit;
  try {
    const { data } = await sb
      .from('reminders')
      .select('user_tz')
      .eq('user_id', id.user_id)
      .eq('tenant_id', id.tenant_id)
      .order('created_at', { ascending: false })
      .limit(1);
    const tz = data?.[0]?.user_tz;
    if (typeof tz === 'string' && tz && tz !== 'UTC' && isValidTimezone(tz)) return tz;
  } catch {
    /* timezone is best-effort */
  }
  return undefined;
}

/** Hour/day-of-week signals in the user's local timezone (UTC when unknown). */
function timeContextFor(tz: string | undefined, now: Date = new Date()): TimeContextSignals {
  let hour = now.getUTCHours();
  let dow = now.getUTCDay();
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hourCycle: 'h23',
        weekday: 'short',
      }).formatToParts(now);
      const h = Number(parts.find((p) => p.type === 'hour')?.value);
      if (Number.isFinite(h)) hour = h;
      const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
      const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
      if (idx >= 0) dow = idx;
    } catch {
      /* keep UTC */
    }
  }
  return { current_hour: hour, day_of_week: dow, is_weekend: dow === 0 || dow === 6 };
}

interface CalendarEventLite {
  id: string;
  title: string | null;
  start_time: string;
  end_time: string | null;
  event_type: string | null;
}

interface CalendarWindow {
  in_progress: CalendarEventLite | null;
  next_event: CalendarEventLite | null;
  minutes_to_next: number | null;
  upcoming_count: number;
  horizon_hours: number;
  fetched: boolean;
}

const CALENDAR_HORIZON_HOURS = 12;
const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;

/**
 * One pass over the user's `calendar_events` (the canonical calendar table):
 * events from 2h back to +12h, classified into in-progress / next / density.
 */
async function fetchCalendarWindow(
  sb: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<CalendarWindow> {
  const empty: CalendarWindow = {
    in_progress: null,
    next_event: null,
    minutes_to_next: null,
    upcoming_count: 0,
    horizon_hours: CALENDAR_HORIZON_HOURS,
    fetched: false,
  };
  try {
    const fromIso = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const toIso = new Date(now.getTime() + CALENDAR_HORIZON_HOURS * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from('calendar_events')
      .select('id, title, start_time, end_time, event_type')
      .eq('user_id', userId)
      .eq('status', 'scheduled')
      .gte('start_time', fromIso)
      .lte('start_time', toIso)
      .order('start_time', { ascending: true })
      .limit(20);
    if (error || !Array.isArray(data)) return empty;

    const rows = data as CalendarEventLite[];
    const nowMs = now.getTime();
    let inProgress: CalendarEventLite | null = null;
    const upcoming: CalendarEventLite[] = [];
    for (const ev of rows) {
      const startMs = Date.parse(ev.start_time);
      if (!Number.isFinite(startMs)) continue;
      if (startMs > nowMs) {
        upcoming.push(ev);
        continue;
      }
      const endMs = ev.end_time ? Date.parse(ev.end_time) : startMs + DEFAULT_EVENT_DURATION_MS;
      if (Number.isFinite(endMs) && endMs >= nowMs && !inProgress) inProgress = ev;
    }
    const next = upcoming[0] ?? null;
    return {
      in_progress: inProgress,
      next_event: next,
      minutes_to_next: next ? Math.max(0, Math.round((Date.parse(next.start_time) - nowMs) / 60000)) : null,
      upcoming_count: upcoming.length,
      horizon_hours: CALENDAR_HORIZON_HOURS,
      fetched: true,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// get_emotional_state — D28 emotional/cognitive signals
// ---------------------------------------------------------------------------

interface D28StateEntry {
  state?: string;
  score?: number;
  confidence?: number;
}

interface D28SignalRow {
  emotional_states: unknown;
  cognitive_states: unknown;
  engagement_level: string | null;
  engagement_confidence: number | null;
  urgency_detected: boolean | null;
  hesitation_detected: boolean | null;
  created_at: string | null;
  decay_at: string | null;
}

/** Strongest non-neutral states first (score-sorted); neutral only when alone. */
function topStates(raw: unknown, max = 2): D28StateEntry[] {
  if (!Array.isArray(raw)) return [];
  const items = raw
    .filter((s): s is D28StateEntry => !!s && typeof s === 'object' && typeof (s as D28StateEntry).state === 'string')
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const meaningful = items.filter((s) => s.state !== 'neutral' && (Number(s.score) || 0) >= 30);
  return (meaningful.length > 0 ? meaningful : items).slice(0, max);
}

function speakStates(entries: D28StateEntry[]): string {
  return entries.map((s) => String(s.state).replace(/_/g, ' ')).join(' and ');
}

export async function tool_get_emotional_state(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_emotional_state', id);
  if (gate) return gate;
  try {
    const nowMs = Date.now();

    // 1) Real source: latest non-decayed D28 signal bundle for this user.
    const { data: signalRows, error: signalErr } = await sb
      .from('emotional_cognitive_signals')
      .select(
        'emotional_states, cognitive_states, engagement_level, engagement_confidence, ' +
          'urgency_detected, hesitation_detected, created_at, decay_at',
      )
      .eq('tenant_id', id.tenant_id)
      .eq('user_id', id.user_id)
      .eq('decayed', false)
      .order('created_at', { ascending: false })
      .limit(1);
    if (signalErr) {
      return { ok: false, error: `get_emotional_state failed: ${signalErr.message}` };
    }

    const row = (signalRows as unknown as D28SignalRow[] | null)?.[0];
    const createdMs = row ? Date.parse(String(row.created_at)) : NaN;
    const decayMs = row?.decay_at ? Date.parse(String(row.decay_at)) : NaN;
    const fresh =
      !!row &&
      Number.isFinite(createdMs) &&
      nowMs - createdMs <= 24 * 60 * 60 * 1000 &&
      (!row.decay_at || (Number.isFinite(decayMs) && decayMs > nowMs));

    if (fresh && row) {
      const emo = topStates(row.emotional_states);
      const cog = topStates(row.cognitive_states);
      const parts: string[] = [];
      parts.push(`Based on your conversation signals from ${relativePastPhrase(String(row.created_at))}:`);
      if (emo.length > 0) parts.push(`emotionally you come across as ${speakStates(emo)},`);
      if (cog.length > 0) parts.push(`cognitively ${speakStates(cog)},`);
      parts.push(`with ${String(row.engagement_level ?? 'medium')} engagement.`);
      if (row.urgency_detected) parts.push('Your recent messages carried some urgency.');
      if (row.hesitation_detected) parts.push('There was a bit of hesitation too.');
      parts.push('These are light behavioral observations, not a clinical assessment.');
      return {
        ok: true,
        result: {
          source: 'conversation_signals',
          emotional_states: emo.map((s) => ({ state: s.state, score: s.score ?? null })),
          cognitive_states: cog.map((s) => ({ state: s.state, score: s.score ?? null })),
          engagement_level: row.engagement_level ?? null,
          urgency_detected: !!row.urgency_detected,
          hesitation_detected: !!row.hesitation_detected,
          computed_at: row.created_at ?? null,
        },
        text: parts.join(' '),
      };
    }

    // 2) Best-effort fallback: recent diary moods/energy (real user data).
    const sinceDate = new Date(nowMs - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: diaryRows } = await sb
      .from('memory_diary_entries')
      .select('mood, energy_level, entry_date')
      .eq('tenant_id', id.tenant_id)
      .eq('user_id', id.user_id)
      .gte('entry_date', sinceDate)
      .order('entry_date', { ascending: false })
      .limit(5);
    const withMood = (diaryRows ?? []).filter(
      (d) => (typeof d.mood === 'string' && d.mood.trim() !== '') || typeof d.energy_level === 'number',
    );
    if (withMood.length > 0) {
      const latest = withMood[0];
      const energies = withMood
        .map((d) => Number(d.energy_level))
        .filter((n) => Number.isFinite(n));
      const avgEnergy = energies.length > 0 ? Math.round((energies.reduce((a, b) => a + b, 0) / energies.length) * 10) / 10 : null;
      const bits: string[] = ['I have no live conversation signals right now, so this comes from your recent diary:'];
      if (latest.mood) bits.push(`your last logged mood was "${latest.mood}" (${latest.entry_date}).`);
      if (avgEnergy !== null) {
        bits.push(`Average energy across your last ${energies.length} ${energies.length === 1 ? 'entry' : 'entries'}: ${avgEnergy} out of 10.`);
      }
      return {
        ok: true,
        result: {
          source: 'diary',
          latest_mood: latest.mood ?? null,
          latest_entry_date: latest.entry_date ?? null,
          average_energy: avgEnergy,
          entries_considered: withMood.length,
        },
        text: bits.join(' '),
      };
    }

    // 3) Honest empty state (ok:true — an empty state is not a failure).
    return {
      ok: true,
      result: { source: 'none', available: false },
      text:
        'I have no recent emotional or cognitive signals for you — no analyzed conversation turns and no recent diary moods or energy logs. Nothing is wrong; there is just no data yet.',
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_emotional_state failed' };
  }
}

// ---------------------------------------------------------------------------
// get_situational_awareness — D32 situational summary
// ---------------------------------------------------------------------------

export async function tool_get_situational_awareness(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_situational_awareness', id);
  if (gate) return gate;
  try {
    const timezone = await resolveUserTimezone(args, id, sb);
    const cal = await fetchCalendarWindow(sb, id.user_id);

    const computed = await computeSituationalAwareness({
      user_id: id.user_id,
      tenant_id: id.tenant_id as string,
      session_id: id.session_id ?? undefined,
      timezone,
      calendar_hints: cal.fetched
        ? {
            next_event_in_minutes: cal.minutes_to_next ?? undefined,
            is_free_now: !cal.in_progress,
          }
        : undefined,
    });
    if (!computed.ok || !computed.bundle) {
      return { ok: false, error: computed.error || 'get_situational_awareness failed' };
    }

    const ctx = toOrbSituationContext(computed.bundle);
    const parts: string[] = [];
    parts.push(
      `Right now it's ${String(ctx.time_window).replace(/_/g, ' ')} for you${ctx.is_late_night ? ' (late night)' : ''}.`,
    );
    parts.push(
      `Availability looks ${String(ctx.availability).replace(/_/g, ' ')}, energy ${String(ctx.energy).replace(/_/g, ' ')}, so a ${ctx.suggested_depth} interaction depth fits best.`,
    );
    if (cal.in_progress) {
      parts.push(`You appear to be in "${cal.in_progress.title ?? 'a calendar event'}" at the moment.`);
    } else if (cal.next_event && cal.minutes_to_next !== null) {
      parts.push(`Next on your calendar: "${cal.next_event.title ?? 'an event'}" ${inMinutesPhrase(cal.minutes_to_next)}.`);
    }
    if (ctx.active_constraints.length > 0) {
      parts.push(`Active constraints: ${ctx.active_constraints.map((c) => String(c).replace(/_/g, ' ')).join(', ')}.`);
    }
    parts.push(
      `This is inferred from the time of day${cal.fetched ? ' and your calendar' : ''}${timezone ? ` (timezone ${timezone})` : ''} — ${ctx.confidence}% confidence.`,
    );

    return {
      ok: true,
      result: {
        time_window: ctx.time_window,
        is_late_night: ctx.is_late_night,
        availability: ctx.availability,
        energy: ctx.energy,
        suggested_depth: ctx.suggested_depth,
        active_constraints: ctx.active_constraints,
        next_event_title: cal.next_event?.title ?? null,
        next_event_in_minutes: cal.minutes_to_next,
        in_event_now: !!cal.in_progress,
        confidence: ctx.confidence,
        timezone: timezone ?? null,
      },
      text: parts.join(' '),
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_situational_awareness failed' };
  }
}

// ---------------------------------------------------------------------------
// get_availability — D33 availability / readiness
// ---------------------------------------------------------------------------

const TIME_WINDOW_PHRASES: Record<string, string> = {
  immediate: 'only a couple of minutes',
  short: 'a short window of a few minutes',
  extended: 'a longer stretch of time',
  defer: 'a moment better saved for later',
};

export async function tool_get_availability(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_availability', id);
  if (gate) return gate;
  try {
    const now = new Date();
    const timezone = await resolveUserTimezone(args, id, sb);
    const cal = await fetchCalendarWindow(sb, id.user_id, now);

    // Reminders due soon (real "active timers"): pending, next 4 hours.
    let remindersDue: Array<{ action_text: string | null; next_fire_at: string }> = [];
    try {
      const { data } = await sb
        .from('reminders')
        .select('action_text, next_fire_at')
        .eq('user_id', id.user_id)
        .eq('tenant_id', id.tenant_id)
        .eq('status', 'pending')
        .lte('next_fire_at', new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString())
        .order('next_fire_at', { ascending: true })
        .limit(5);
      remindersDue = Array.isArray(data) ? data : [];
    } catch {
      /* reminders are additive context */
    }

    // Prefer the live in-session D33 bundle when one is cached for this session.
    let bundle: AvailabilityReadinessBundle | null = null;
    let basis = 'your calendar and the time of day';
    if (id.session_id) {
      const cached = await getCurrentAvailability(id.session_id);
      if (cached.ok && cached.bundle) {
        bundle = cached.bundle;
        basis = 'this session and your calendar';
      }
    }
    if (!bundle) {
      const computed = await computeAvailabilityReadiness({
        session_id: id.session_id ?? undefined,
        time_context: timeContextFor(timezone, now),
        calendar: cal.fetched
          ? {
              has_upcoming_event: !!cal.next_event,
              minutes_to_next_event: cal.minutes_to_next ?? undefined,
              is_in_meeting: !!cal.in_progress,
              calendar_availability: cal.in_progress ? 'busy' : 'free',
            }
          : undefined,
      });
      if (!computed.ok || !computed.bundle) {
        return { ok: false, error: computed.message || computed.error || 'get_availability failed' };
      }
      bundle = computed.bundle;
    }

    const parts: string[] = [];
    parts.push(
      `Your availability looks ${bundle.availability.level}, with ${TIME_WINDOW_PHRASES[bundle.time_window.window] ?? bundle.time_window.window} available` +
        `${typeof bundle.time_window.estimated_minutes === 'number' ? ` (about ${Math.round(bundle.time_window.estimated_minutes)} minutes)` : ''}.`,
    );
    parts.push(`Readiness for engagement is around ${Math.round(bundle.readiness.score * 100)}%.`);
    if (cal.in_progress) {
      parts.push(`You seem to be in "${cal.in_progress.title ?? 'a calendar event'}" right now.`);
    } else if (cal.next_event && cal.minutes_to_next !== null) {
      parts.push(`Next commitment: "${cal.next_event.title ?? 'an event'}" ${inMinutesPhrase(cal.minutes_to_next)}.`);
    }
    if (cal.fetched) {
      parts.push(
        cal.upcoming_count > 0
          ? `You have ${cal.upcoming_count} calendar ${cal.upcoming_count === 1 ? 'item' : 'items'} in the next ${cal.horizon_hours} hours.`
          : `Your calendar is clear for the next ${cal.horizon_hours} hours.`,
      );
    }
    if (remindersDue.length > 0) {
      const first = remindersDue[0];
      const mins = Math.max(0, Math.round((Date.parse(first.next_fire_at) - now.getTime()) / 60000));
      parts.push(
        `${remindersDue.length} reminder${remindersDue.length === 1 ? '' : 's'} due within 4 hours — the next one${first.action_text ? ` ("${first.action_text}")` : ''} ${inMinutesPhrase(mins)}.`,
      );
    }
    parts.push(`Based on ${basis}.`);

    return {
      ok: true,
      result: {
        availability_level: bundle.availability.level,
        time_window: bundle.time_window.window,
        estimated_minutes: bundle.time_window.estimated_minutes ?? null,
        readiness_score: bundle.readiness.score,
        availability_tag: bundle.availability_tag,
        in_event_now: !!cal.in_progress,
        next_event_title: cal.next_event?.title ?? null,
        next_event_in_minutes: cal.minutes_to_next,
        upcoming_events_count: cal.upcoming_count,
        reminders_due_count: remindersDue.length,
        was_user_override: bundle.was_user_override,
      },
      text: parts.join(' '),
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_availability failed' };
  }
}

// ---------------------------------------------------------------------------
// get_environmental_context — D34 environment / mobility
// ---------------------------------------------------------------------------

export async function tool_get_environmental_context(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_environmental_context', id);
  if (gate) return gate;
  try {
    // Real stored location: the user's residence fact from the Memory Garden
    // (memory_facts.user_residence, written by the Cognee extractor).
    let residence: string | null = null;
    try {
      const { data } = await sb
        .from('memory_facts')
        .select('fact_value')
        .eq('tenant_id', id.tenant_id)
        .eq('user_id', id.user_id)
        .eq('fact_key', 'user_residence')
        .eq('entity', 'self')
        .is('superseded_by', null)
        .order('extracted_at', { ascending: false })
        .limit(1);
      const v = data?.[0]?.fact_value;
      residence = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    } catch {
      /* residence fact is best-effort seed data */
    }

    const computed = await computeContext(
      {
        user_id: id.user_id,
        session_id: id.session_id ?? undefined,
        explicit_location: residence ? { city: residence } : undefined,
        force_refresh: false,
      },
      id.user_jwt ?? undefined,
    );
    if (!computed.ok || !computed.bundle) {
      return { ok: false, error: computed.message || computed.error || 'get_environmental_context failed' };
    }
    const b = computed.bundle;
    const loc = b.location_context;
    const mob = b.mobility_profile;
    const env = b.environmental_constraints;

    const parts: string[] = [];
    if (loc.city || loc.country) {
      const place = [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
      const sourceNote =
        loc.source === 'explicit'
          ? 'the location you shared with me'
          : loc.source === 'preferences'
            ? 'your saved location preferences'
            : loc.source === 'visit_history'
              ? 'your recent visit history'
              : 'an inferred hint';
      parts.push(
        `You're ${loc.travel_state === 'traveling' ? 'traveling — currently around' : 'based in'} ${place} (from ${sourceNote}).`,
      );
    } else {
      parts.push("I don't have a location for you — nothing stored or shared yet.");
    }
    if (mob.mode_preference && mob.mode_preference !== 'unknown') {
      parts.push(`You usually get around by ${String(mob.mode_preference).replace(/_/g, ' ')}.`);
    }
    if (env.is_late_night) parts.push("It's late night in your area.");
    else if (env.is_early_morning) parts.push("It's early morning in your area.");
    if (env.indoor_outdoor_preference !== 'either') {
      parts.push(`${env.indoor_outdoor_preference === 'indoor' ? 'Indoor' : 'Outdoor'} activities suit the current conditions best.`);
    }
    if (b.environment_tags.length > 0) {
      parts.push(`Environment notes: ${b.environment_tags.map((t) => String(t).replace(/_/g, ' ')).join(', ')}.`);
    }
    if (b.fallback_applied) {
      parts.push('Most of this is a neutral default — I have little real location or mobility data for you yet.');
    } else {
      parts.push(`Overall confidence: ${b.overall_confidence}%.`);
    }

    return {
      ok: true,
      result: {
        city: loc.city ?? null,
        region: loc.region ?? null,
        country: loc.country ?? null,
        location_source: loc.source,
        travel_state: loc.travel_state,
        urban_density: loc.urban_density,
        mode_preference: mob.mode_preference,
        environment_tags: b.environment_tags,
        is_late_night: env.is_late_night,
        is_early_morning: env.is_early_morning,
        overall_confidence: b.overall_confidence,
        fallback_applied: b.fallback_applied,
      },
      text: parts.join(' '),
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_environmental_context failed' };
  }
}

// ---------------------------------------------------------------------------
// get_life_stage_context — D40 life-stage context
// ---------------------------------------------------------------------------

const DECADE_WORDS: Record<number, string> = {
  10: 'teens',
  20: 'twenties',
  30: 'thirties',
  40: 'forties',
  50: 'fifties',
  60: 'sixties',
  70: 'seventies',
  80: 'eighties',
  90: 'nineties',
};

/** "in your fifties" from a birthday string; null when unparseable. */
function ageBandPhrase(birthdayRaw: string, now: Date = new Date()): string | null {
  const t = Date.parse(birthdayRaw);
  if (!Number.isFinite(t)) return null;
  const age = Math.floor((now.getTime() - t) / (365.25 * 24 * 60 * 60 * 1000));
  if (age < 10 || age > 110) return null;
  const decade = Math.floor(age / 10) * 10;
  const word = DECADE_WORDS[decade];
  return word ? `in your ${word}` : null;
}

/** "8 months" / "2 years" tenure phrase from a created_at ISO. */
function tenurePhrase(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = (Date.now() - t) / (24 * 60 * 60 * 1000);
  if (days < 0) return null;
  if (days < 14) return `${Math.max(1, Math.round(days))} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 700) return `${Math.round(days / 30)} months`;
  return `${Math.round(days / 365)} years`;
}

interface LifeStageAssessmentRow {
  phase: string;
  phase_confidence: number;
  stability_level: string;
  transition_flag: boolean;
  transition_type: string | null;
}

interface LifeCompassRow {
  primary_goal: string | null;
  category: string | null;
}

export async function tool_get_life_stage_context(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_life_stage_context', id);
  if (gate) return gate;
  try {
    // 1) Latest valid D40 assessment.
    let assessment: LifeStageAssessmentRow | null = null;
    try {
      const { data } = await sb
        .from('life_stage_assessments')
        .select('phase, phase_confidence, stability_level, transition_flag, transition_type')
        .eq('tenant_id', id.tenant_id)
        .eq('user_id', id.user_id)
        .eq('valid', true)
        .order('created_at', { ascending: false })
        .limit(1);
      assessment = (data as LifeStageAssessmentRow[] | null)?.[0] ?? null;
    } catch {
      /* assessment is one of several sources */
    }

    // 2) Active D40 goals (top priority first).
    let goals: Array<{ category: string; description: string }> = [];
    try {
      const { data } = await sb
        .from('life_stage_goals')
        .select('category, description, priority')
        .eq('tenant_id', id.tenant_id)
        .eq('user_id', id.user_id)
        .eq('status', 'active')
        .order('priority', { ascending: false })
        .limit(3);
      goals = Array.isArray(data) ? data : [];
    } catch {
      /* goals optional */
    }

    // 3) Active Life Compass (primary long-term goal + category).
    let compass: LifeCompassRow | null = null;
    try {
      const { data } = await sb
        .from('life_compass')
        .select('primary_goal, category')
        .eq('user_id', id.user_id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1);
      compass = (data as LifeCompassRow[] | null)?.[0] ?? null;
    } catch {
      /* compass optional */
    }

    // 4) Community tenure from app_users.created_at.
    let tenure: string | null = null;
    try {
      const { data } = await sb
        .from('app_users')
        .select('created_at')
        .eq('user_id', id.user_id)
        .limit(1);
      if (data?.[0]?.created_at) tenure = tenurePhrase(String(data[0].created_at));
    } catch {
      /* tenure optional */
    }

    // 5) Age band from the user's stated birthday (memory_facts.user_birthday).
    let ageBand: string | null = null;
    try {
      const { data } = await sb
        .from('memory_facts')
        .select('fact_value')
        .eq('tenant_id', id.tenant_id)
        .eq('user_id', id.user_id)
        .eq('fact_key', 'user_birthday')
        .eq('entity', 'self')
        .is('superseded_by', null)
        .order('extracted_at', { ascending: false })
        .limit(1);
      const v = data?.[0]?.fact_value;
      if (typeof v === 'string' && v.trim() !== '') ageBand = ageBandPhrase(v.trim());
    } catch {
      /* age band optional */
    }

    const parts: string[] = [];
    if (assessment) {
      parts.push(
        `You're in a${assessment.phase === 'exploratory' || assessment.phase === 'optimizing' ? 'n' : ''} ${assessment.phase} life phase (${assessment.phase_confidence}% confidence), with ${assessment.stability_level} stability.`,
      );
      if (assessment.transition_flag) {
        parts.push(`A life transition is in play${assessment.transition_type ? ` (${String(assessment.transition_type).replace(/_/g, ' ')})` : ''}.`);
      }
    }
    if (compass?.primary_goal) {
      parts.push(`Your Life Compass points at ${compass.category ? `${compass.category}: ` : ''}"${compass.primary_goal}".`);
    }
    if (goals.length > 0 && !compass?.primary_goal) {
      const g = goals[0];
      parts.push(`Your top active goal is ${String(g.category).replace(/_/g, ' ')}: "${g.description}".`);
    }
    if (ageBand) parts.push(`You're ${ageBand} (based on the birthday you shared).`);
    if (tenure) parts.push(`You've been part of the community for ${tenure}.`);

    if (parts.length === 0) {
      return {
        ok: true,
        result: { available: false },
        text:
          "I don't have life-stage context for you yet — no life-stage assessment, no Life Compass goal, and no birthday on record. We can set up your Life Compass whenever you like.",
      };
    }
    parts.push('This is based on what you\'ve shared and your activity — you know your life best.');

    return {
      ok: true,
      result: {
        phase: assessment?.phase ?? null,
        phase_confidence: assessment?.phase_confidence ?? null,
        stability_level: assessment?.stability_level ?? null,
        in_transition: assessment?.transition_flag ?? false,
        life_compass_category: compass?.category ?? null,
        life_compass_goal: compass?.primary_goal ?? null,
        top_goal_category: goals[0]?.category ?? null,
        age_band: ageBand,
        member_tenure: tenure,
      },
      text: parts.join(' '),
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_life_stage_context failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const AWARENESS_TOOL_HANDLERS: Record<string, Handler> = {
  get_emotional_state: tool_get_emotional_state,
  get_situational_awareness: tool_get_situational_awareness,
  get_availability: tool_get_availability,
  get_environmental_context: tool_get_environmental_context,
  get_life_stage_context: tool_get_life_stage_context,
};

export const AWARENESS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'get_emotional_state',
    description: [
      "Read the user's current emotional and cognitive signals (D28): mood,",
      'focus, engagement, urgency, hesitation — from analyzed conversation',
      'signals, or recent diary moods/energy when no live signals exist.',
      'CALL WHEN the user asks: "how am I doing?", "how do I seem to you?",',
      '"wie wirke ich gerade?", "wie geht es mir laut meinen Daten?".',
      'Speak the returned text as-is — it already names the data source.',
      'Never diagnose; these are light behavioral observations only.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_situational_awareness',
    description: [
      "Summarize the user's current situation (D32): time-of-day window,",
      'availability, energy, suggested conversation depth and any active',
      'constraints, enriched with their next calendar commitment.',
      'CALL WHEN the user asks: "what\'s my situation right now?", "is this',
      'a good moment?", "wie sieht meine Lage gerade aus?", "passt es gerade?".',
      'Optionally pass timezone (IANA name like Europe/Berlin) if known.',
      'Speak the returned text; it states what the summary is based on.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: "The user's IANA timezone (e.g. Europe/Berlin), only if known.",
        },
      },
      required: [],
    },
  },
  {
    name: 'get_availability',
    description: [
      'Check how available and ready the user is right now (D33): availability',
      'level, time window, readiness score, calendar density for the next',
      'hours, whether they are in an event, and reminders due soon.',
      'CALL WHEN the user asks: "do I have time right now?", "is now a good',
      'time?", "habe ich gerade Zeit?", "ist jetzt ein guter Zeitpunkt?",',
      'or BEFORE proposing a long activity or deep session.',
      'Optionally pass timezone (IANA name) if known. Speak the returned text.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: "The user's IANA timezone (e.g. Europe/Berlin), only if known.",
        },
      },
      required: [],
    },
  },
  {
    name: 'get_environmental_context',
    description: [
      "Read the user's environment and mobility context (D34): where they",
      'are based or traveling, how they get around, late-night/early-morning',
      'flags and indoor/outdoor suitability — from stored location facts,',
      'preferences and visit history. Never invents a location.',
      'CALL WHEN the user asks: "what do you know about where I am?",',
      '"was weißt du über meine Umgebung?", or before suggesting nearby or',
      'outdoor activities. Speak the returned text; it names its sources.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_life_stage_context',
    description: [
      "Read the user's life-stage context (D40): life phase and stability,",
      'any transition, Life Compass goal and category, age band (from their',
      'stated birthday) and community tenure.',
      'CALL WHEN the user asks: "where am I in life?", "what stage am I in?",',
      '"wo stehe ich gerade im Leben?", "in welcher Lebensphase bin ich?",',
      'or when tailoring long-term advice to their life situation.',
      'Speak the returned text; it is non-prescriptive — the user knows',
      'their life best. If nothing is on record, offer to set up Life Compass.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
];
