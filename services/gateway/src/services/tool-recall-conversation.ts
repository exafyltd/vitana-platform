/**
 * VTID-01990: recall_conversation_at_time tool handler
 *
 * When the user says something like "we talked yesterday morning about my
 * company" or "earlier today we discussed sleep", Gemini emits a function
 * call to this tool. The handler:
 *
 *   1. Parses the time hint into a [since, until] window in the user's
 *      local timezone (DE + EN supported).
 *   2. Calls the recall_at_time_range RPC for matched session summaries +
 *      conversation_messages excerpts + memory_facts in that window.
 *   3. Shapes the result for the LLM tool reply.
 *
 * Read-only. Safe by construction — RPC scopes by user_id internally.
 */

import { resolveUserTimezone } from './guide/user-timezone';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

export interface RecallToolArgs {
  time_hint: string;
  topic_hint?: string;
}

export interface RecallToolResult {
  ok: boolean;
  error?: string;
  resolved_window?: { since: string; until: string; label: string };
  matched_session?: {
    session_id: string;
    channel: 'voice' | 'text';
    ended_at: string;
    summary: string;
    themes: string[];
  };
  excerpts?: Array<{
    role: 'user' | 'assistant';
    channel: string;
    content: string;
    created_at: string;
  }>;
  related_facts?: Array<{
    fact_key: string;
    fact_value: string;
    extracted_at: string;
  }>;
  neighbors?: Array<{ ended_at: string; summary: string; themes: string[] }>;
}

/**
 * Resolve a free-text time hint to a UTC [since, until) window in the user's
 * local timezone. Returns null when the hint can't be parsed.
 */
export function resolveTimeHint(
  hint: string,
  userTz?: string,
  now: Date = new Date(),
): { since: Date; until: Date; label: string } | null {
  const raw = hint.trim().toLowerCase();
  if (!raw) return null;

  // VTID-02019: 'UTC' or unspecified means "we don't know the user's tz" —
  // resolve to the system default (Europe/Berlin). 10k+ users are CET so
  // when they say "yesterday morning" they mean CET morning.
  const tz = resolveUserTimezone(userTz);

  // Buckets in the user's local day. Anchored to local midnight.
  // Computed in UTC against a virtual local-midnight.
  const tzNow = localDayParts(now, tz);

  const todayStartUTC = utcInstantOfLocalMidnight(tzNow.localYear, tzNow.localMonth, tzNow.localDay, tz);
  const oneDay = 24 * 3600 * 1000;

  type TimeBucket = { startHour: number; endHour: number; label: string };
  const buckets: Record<string, TimeBucket> = {
    morning: { startHour: 5, endHour: 12, label: 'morning' },
    noon: { startHour: 11, endHour: 14, label: 'noon' },
    midday: { startHour: 11, endHour: 14, label: 'midday' },
    afternoon: { startHour: 12, endHour: 18, label: 'afternoon' },
    evening: { startHour: 17, endHour: 22, label: 'evening' },
    tonight: { startHour: 17, endHour: 22, label: 'tonight' },
    night: { startHour: 21, endHour: 29, label: 'night' }, // wraps past midnight
    late: { startHour: 21, endHour: 29, label: 'late' },
  };

  // Locale dictionary — maps DE phrases into the same bucket keys
  const dayOffsets: Array<{ rx: RegExp; offset: number; label: string }> = [
    { rx: /\b(today|heute)\b/, offset: 0, label: 'today' },
    { rx: /\b(yesterday|gestern)\b/, offset: -1, label: 'yesterday' },
    { rx: /\b(day before yesterday|vorgestern)\b/, offset: -2, label: 'day-before-yesterday' },
  ];
  const bucketAliases: Array<{ rx: RegExp; key: keyof typeof buckets }> = [
    { rx: /\b(morning|morgens|in der frueh|am morgen|heute morgen)\b/, key: 'morning' },
    { rx: /\b(noon|mittag|mittags)\b/, key: 'noon' },
    { rx: /\b(afternoon|nachmittag|nachmittags)\b/, key: 'afternoon' },
    { rx: /\b(evening|abend|abends|tonight|heute abend)\b/, key: 'evening' },
    { rx: /\b(night|nacht|nachts|late|spaet|spät|letzte nacht|last night)\b/, key: 'night' },
  ];

  // "N days ago" / "vor N Tagen"
  const daysAgoMatch = raw.match(/\b(\d+)\s*(days?\s*ago|tagen?\s+her|tagen?)\b/);
  if (daysAgoMatch) {
    const n = parseInt(daysAgoMatch[1], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 30) {
      const start = new Date(todayStartUTC.getTime() - n * oneDay);
      const end = new Date(start.getTime() + oneDay);
      return { since: start, until: end, label: `${n} days ago` };
    }
  }

  // "last <weekday>" / "letzten <Wochentag>"
  const weekdays: Array<[RegExp, number]> = [
    [/\b(monday|montag)\b/, 1],
    [/\b(tuesday|dienstag)\b/, 2],
    [/\b(wednesday|mittwoch)\b/, 3],
    [/\b(thursday|donnerstag)\b/, 4],
    [/\b(friday|freitag)\b/, 5],
    [/\b(saturday|samstag|sonnabend)\b/, 6],
    [/\b(sunday|sonntag)\b/, 0],
  ];
  if (/\b(last|letzten?)\b/.test(raw) || /\bvergangenen\b/.test(raw)) {
    for (const [rx, dow] of weekdays) {
      if (rx.test(raw)) {
        // Most recent past <dow>
        const todayDow = new Date(todayStartUTC).getUTCDay();
        let delta = todayDow - dow;
        if (delta <= 0) delta += 7;
        const start = new Date(todayStartUTC.getTime() - delta * oneDay);
        const end = new Date(start.getTime() + oneDay);
        return { since: start, until: end, label: `last ${dow}` };
      }
    }
  }

  // Day-anchored buckets (today/yesterday/etc + optional bucket)
  let dayOffset: number | null = null;
  let dayLabel = 'today';
  for (const dy of dayOffsets) {
    if (dy.rx.test(raw)) {
      dayOffset = dy.offset;
      dayLabel = dy.label;
      break;
    }
  }
  // Bucket may appear standalone ("morning" => today's morning)
  let bucketKey: keyof typeof buckets | null = null;
  for (const ba of bucketAliases) {
    if (ba.rx.test(raw)) {
      bucketKey = ba.key;
      break;
    }
  }

  if (dayOffset === null && bucketKey === null) {
    return null; // Unparseable
  }

  const day = dayOffset ?? 0;
  const dayStartUtc = new Date(todayStartUTC.getTime() + day * oneDay);

  if (!bucketKey) {
    // Whole day
    return {
      since: dayStartUtc,
      until: new Date(dayStartUtc.getTime() + oneDay),
      label: dayLabel,
    };
  }

  const b = buckets[bucketKey];
  // Bucket bounds expressed as offsets-from-local-midnight, then converted to UTC
  const since = new Date(dayStartUtc.getTime() + b.startHour * 3600 * 1000);
  const until = new Date(dayStartUtc.getTime() + b.endHour * 3600 * 1000);
  return { since, until, label: `${dayLabel} ${b.label}` };
}

function localDayParts(now: Date, tz: string): { localYear: number; localMonth: number; localDay: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts(now).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    return {
      localYear: parseInt(parts.year || '1970', 10),
      localMonth: parseInt(parts.month || '1', 10),
      localDay: parseInt(parts.day || '1', 10),
    };
  } catch {
    return { localYear: now.getUTCFullYear(), localMonth: now.getUTCMonth() + 1, localDay: now.getUTCDate() };
  }
}

function utcInstantOfLocalMidnight(year: number, month: number, day: number, tz: string): Date {
  // Compute the UTC instant that is local-midnight in the given tz on the given date.
  // Approach: build a UTC date, then shift by the tz offset at that instant.
  const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  // Get the tz's offset at that approximate instant
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = fmt.formatToParts(new Date(utcMidnight)).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    const localAsUTC = Date.UTC(
      parseInt(parts.year, 10),
      parseInt(parts.month, 10) - 1,
      parseInt(parts.day, 10),
      parseInt(parts.hour, 10),
      parseInt(parts.minute, 10),
      parseInt(parts.second, 10),
    );
    const offset = localAsUTC - utcMidnight;
    return new Date(utcMidnight - offset);
  } catch {
    return new Date(utcMidnight);
  }
}

export async function executeRecallConversationAtTime(
  args: RecallToolArgs,
  context: { user_id: string; user_timezone?: string },
): Promise<RecallToolResult> {
  if (!args || typeof args.time_hint !== 'string' || args.time_hint.trim().length === 0) {
    return { ok: false, error: 'missing_time_hint' };
  }
  if (!context.user_id) {
    return { ok: false, error: 'missing_user_context' };
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'storage_unavailable' };
  }

  // VTID-02019: pass through whatever tz the executor placed on the thread
  // identity; resolveTimeHint() will substitute Europe/Berlin if it's UTC or
  // missing.
  const tz = context.user_timezone;
  const window = resolveTimeHint(args.time_hint, tz);
  if (!window) {
    return { ok: false, error: 'ambiguous_time' };
  }

  // Cap window to avoid runaway scans (max 7 days)
  const maxSpanMs = 7 * 24 * 3600 * 1000;
  if (window.until.getTime() - window.since.getTime() > maxSpanMs) {
    return { ok: false, error: 'window_too_wide' };
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/recall_at_time_range`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        p_user_id: context.user_id,
        p_since: window.since.toISOString(),
        p_until: window.until.toISOString(),
        p_topic_hint: args.topic_hint || null,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `rpc_${res.status}` };
    }
    const data = (await res.json()) as any;
    if (!data || !data.ok) {
      return { ok: false, error: data?.error || 'rpc_failed' };
    }
    const sessions = (data.sessions || []) as Array<any>;
    const excerpts = (data.excerpts || []) as Array<any>;
    const facts = (data.facts || []) as Array<any>;

    const result: RecallToolResult = {
      ok: true,
      resolved_window: {
        since: window.since.toISOString(),
        until: window.until.toISOString(),
        label: window.label,
      },
      excerpts: excerpts.map((e) => ({
        role: e.role,
        channel: e.channel,
        content: e.content,
        created_at: e.created_at,
      })),
      related_facts: facts.map((f) => ({
        fact_key: f.fact_key,
        fact_value: f.fact_value,
        extracted_at: f.extracted_at,
      })),
    };

    if (sessions.length > 0) {
      const top = sessions[0];
      result.matched_session = {
        session_id: top.session_id,
        channel: top.channel,
        ended_at: top.ended_at,
        summary: top.summary,
        themes: top.themes || [],
      };
    } else if (excerpts.length === 0) {
      // No session AND no turns in this window → tell the LLM there was no
      // conversation, and offer the nearest neighbors so it can clarify.
      const neighbors = await fetchNearestNeighbors(context.user_id, window.since);
      return {
        ok: false,
        error: 'no_session_in_window',
        resolved_window: {
          since: window.since.toISOString(),
          until: window.until.toISOString(),
          label: window.label,
        },
        neighbors,
      };
    }
    return result;
  } catch (err: any) {
    console.warn(`[VTID-01990:recall] RPC call failed: ${err.message}`);
    return { ok: false, error: 'rpc_exception' };
  }
}

async function fetchNearestNeighbors(
  userId: string,
  anchor: Date,
): Promise<Array<{ ended_at: string; summary: string; themes: string[] }>> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return [];
  // Find one before and one after the anchor
  try {
    const before = await fetch(
      `${SUPABASE_URL}/rest/v1/user_session_summaries?select=ended_at,summary,themes&user_id=eq.${userId}&ended_at=lt.${encodeURIComponent(anchor.toISOString())}&order=ended_at.desc&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      },
    );
    const after = await fetch(
      `${SUPABASE_URL}/rest/v1/user_session_summaries?select=ended_at,summary,themes&user_id=eq.${userId}&ended_at=gte.${encodeURIComponent(anchor.toISOString())}&order=ended_at.asc&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      },
    );
    const out: Array<{ ended_at: string; summary: string; themes: string[] }> = [];
    if (before.ok) {
      const arr = (await before.json()) as any[];
      if (arr && arr[0]) out.push({ ended_at: arr[0].ended_at, summary: arr[0].summary, themes: arr[0].themes || [] });
    }
    if (after.ok) {
      const arr = (await after.json()) as any[];
      if (arr && arr[0]) out.push({ ended_at: arr[0].ended_at, summary: arr[0].summary, themes: arr[0].themes || [] });
    }
    return out;
  } catch {
    return [];
  }
}
