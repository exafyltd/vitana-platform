/**
 * Proactive Guide — Temporal Bucket (time-since-last-session)
 *
 * Extracted from orb-live.ts (VTID-NAV-TIMEJOURNEY) so the awareness module
 * and the ORB voice greeting policy share ONE source of truth for "how long
 * has it been since the user last talked to Vitana."
 *
 * Eight buckets:
 *   reconnect  (< 2 min — user literally just closed the widget)
 *   recent     (< 15 min — same micro-session)
 *   same_day   (< 8h)
 *   today      (< 24h)
 *   yesterday  (1 day ago)
 *   week       (2–7 days)
 *   long       (> 7 days)
 *   first      (no prior session)
 *
 * The motivation_signal layer (fresh / engaged / cooling / absent) is what the
 * companion uses to choose how warmly to acknowledge an absence.
 */

export type TemporalBucket =
  | 'reconnect'
  | 'recent'
  | 'same_day'
  | 'today'
  | 'yesterday'
  | 'week'
  | 'long'
  | 'first';

export type MotivationSignal = 'fresh' | 'engaged' | 'cooling' | 'absent';

export interface LastInteraction {
  bucket: TemporalBucket;
  time_ago: string;
  last_session_at: string | null;
  diff_ms: number;
  was_failure: boolean;
  motivation_signal: MotivationSignal;
  days_since_last: number; // floor(diffMs / 86400000); 0 for same-day; Infinity for 'first'
}

/**
 * Compute bucket + human "time ago" phrase from a last-session timestamp.
 * Mirrors the original describeTimeSince() in orb-live.ts so existing greeting
 * behavior stays consistent.
 */
export function describeTimeSince(
  lastSessionInfo: { time: string; wasFailure: boolean } | null | undefined,
): LastInteraction {
  if (!lastSessionInfo?.time) {
    return {
      bucket: 'first',
      time_ago: 'never before',
      last_session_at: null,
      diff_ms: Number.POSITIVE_INFINITY,
      was_failure: false,
      motivation_signal: 'fresh',
      days_since_last: Number.POSITIVE_INFINITY,
    };
  }

  const lastTs = new Date(lastSessionInfo.time).getTime();
  if (!Number.isFinite(lastTs)) {
    return {
      bucket: 'first',
      time_ago: 'never before',
      last_session_at: lastSessionInfo.time,
      diff_ms: Number.POSITIVE_INFINITY,
      was_failure: !!lastSessionInfo.wasFailure,
      motivation_signal: 'fresh',
      days_since_last: Number.POSITIVE_INFINITY,
    };
  }

  const diffMs = Date.now() - lastTs;
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  let bucket: TemporalBucket;
  let timeAgo: string;
  if (diffSec < 120) {
    bucket = 'reconnect';
    timeAgo = diffSec < 30 ? 'a few seconds ago' : `about ${diffSec} seconds ago`;
  } else if (diffMin < 15) {
    bucket = 'recent';
    timeAgo = `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  } else if (diffHour < 8) {
    bucket = 'same_day';
    if (diffMin < 60) {
      timeAgo = `${diffMin} minutes ago`;
    } else {
      timeAgo = `about ${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
    }
  } else if (diffHour < 24) {
    bucket = 'today';
    timeAgo = `earlier today (about ${diffHour} hours ago)`;
  } else if (diffDay === 1) {
    bucket = 'yesterday';
    timeAgo = 'yesterday';
  } else if (diffDay < 7) {
    bucket = 'week';
    timeAgo = `${diffDay} days ago`;
  } else {
    bucket = 'long';
    timeAgo = `${diffDay} days ago`;
  }

  return {
    bucket,
    time_ago: timeAgo,
    last_session_at: lastSessionInfo.time,
    diff_ms: diffMs,
    was_failure: !!lastSessionInfo.wasFailure,
    motivation_signal: deriveMotivationSignal(bucket, diffDay),
    days_since_last: diffDay,
  };
}

/**
 * Map a bucket + day count into the companion's motivation interpretation.
 *
 * fresh   — same-day return, no acknowledgement of absence needed
 * engaged — yesterday or this week, light warmth
 * cooling — 8 to 14 days, explicit warm "it's been a few days, welcome back"
 * absent  — >14 days, explicit absence acknowledgement, re-engagement before productivity
 */
export function deriveMotivationSignal(bucket: TemporalBucket, daysSinceLast: number): MotivationSignal {
  if (bucket === 'reconnect' || bucket === 'recent' || bucket === 'same_day' || bucket === 'today') {
    return 'fresh';
  }
  if (bucket === 'yesterday' || bucket === 'week') return 'engaged';
  if (bucket === 'long' && daysSinceLast <= 14) return 'cooling';
  if (bucket === 'long' && daysSinceLast > 14) return 'absent';
  // 'first' — defer to tenure stage; treat as fresh by default
  return 'fresh';
}

/**
 * Fetch the user's most recent ORB session start time from oasis_events.
 *
 * Mirrors the existing fetchLastSessionInfo() in orb-live.ts — primarily reads
 * vtid.live.session.start events (which carry user_id reliably), falls back
 * to vtid.live.session.stop for wasFailure detection.
 *
 * Returns null when no prior session is found (treated as 'first' bucket by
 * describeTimeSince).
 *
 * Best-effort with a short timeout — never blocks the brain turn.
 */
export async function fetchLastSessionInfo(
  userId: string,
): Promise<{ time: string; wasFailure: boolean } | null> {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return null;
    }

    const headers = {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);

    try {
      const userFilter = `or=(actor_id.eq.${userId},metadata->>user_id.eq.${userId})`;
      const startUrl = `${SUPABASE_URL}/rest/v1/oasis_events?select=created_at,metadata&topic=eq.vtid.live.session.start&${userFilter}&order=created_at.desc&limit=1`;
      const stopUrl = `${SUPABASE_URL}/rest/v1/oasis_events?select=created_at,metadata&topic=eq.vtid.live.session.stop&${userFilter}&order=created_at.desc&limit=1`;

      const [startResp, stopResp] = await Promise.all([
        fetch(startUrl, { method: 'GET', headers, signal: controller.signal }),
        fetch(stopUrl, { method: 'GET', headers, signal: controller.signal }).catch(() => null),
      ]);

      let time: string | null = null;
      if (startResp.ok) {
        const startData = (await startResp.json()) as Array<{ created_at: string; metadata: Record<string, unknown> }>;
        if (startData.length > 0) time = startData[0].created_at;
      }

      let wasFailure = false;
      if (stopResp && stopResp.ok) {
        const stopData = (await stopResp.json()) as Array<{ created_at: string; metadata: Record<string, unknown> }>;
        if (stopData.length > 0) {
          const meta = stopData[0].metadata || {};
          const turnCount = Number(meta.turn_count) || 0;
          const audioOut = Number(meta.audio_out_chunks) || 0;
          wasFailure = turnCount === 0 || audioOut === 0;
          if (!time) time = stopData[0].created_at;
        }
      }

      return time ? { time, wasFailure } : null;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    return null;
  }
}
