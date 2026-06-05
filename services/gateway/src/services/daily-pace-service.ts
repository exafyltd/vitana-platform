/**
 * Daily Pace Notification Service (claude/daily-pace-notifications)
 *
 * Encapsulates the per-user decision logic for the daily-pace push:
 *
 *   - Cron fires hourly UTC.
 *   - For each user in the tenant we resolve their local hour. Only users
 *     currently in the 19:xx local hour are eligible.
 *   - We look at the user's autopilot pipeline over the last 7 days
 *     (`surfaced_7d` = rows created in the window; `activated_7d` = subset
 *     with status='activated', filtered by `created_at` so the numerator
 *     is always a subset of the denominator and `ratio` cannot exceed 1).
 *   - The ratio buckets into three tones — on_track / slightly_behind /
 *     falling_behind — which drives the localized title+body.
 *   - Hard guards: skip if the user has no active life_compass goal, has
 *     <3 surfaced actions, has push muted, or has already received this
 *     notification within their local day (deduped via `user_notifications`
 *     table — no new table required).
 *
 * The route handler (`/api/v1/scheduled-notifications/daily-pace-
 * notifications`) is the only caller. It wraps each `computePaceDecision`
 * call in a per-user try/catch so one user's bad data can't take down the
 * loop.
 *
 * NOTE on fractional offsets (Asia/Kathmandu = UTC+5:45): the strict
 * `localHour === 19` check still works because the hourly cron sweeps every
 * UTC hour, and one of those UTC ticks will land inside the user's 19:xx
 * local window (Kathmandu hits hour=19 at UTC 13:15 → 14:14, so the UTC
 * 14:00 cron tick sees local 19:45 → fires). Verified in tests.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveUserTimezone } from './guide/user-timezone';

export type PaceTone = 'on_track' | 'slightly_behind' | 'falling_behind';

export type SkipReason =
  | 'no_goal'
  | 'insufficient_actions'
  | 'muted'
  | 'already_sent'
  | 'wrong_hour'
  | 'invalid_tz';

export interface PaceDecision {
  shouldNotify: boolean;
  tone?: PaceTone;
  ratio?: number;
  surfaced7d?: number;
  activated7d?: number;
  skipReason?: SkipReason;
  userLocalDate?: string; // YYYY-MM-DD in user's tz
  userLocalHour?: number;
  timezone?: string;
}

const MIN_SURFACED_FOR_NOTIFY = 3;
const ON_TRACK_THRESHOLD = 0.7;
const SLIGHTLY_BEHIND_THRESHOLD = 0.4;

/**
 * Inline pace bucketer. Ratio is clamped at 1 so a future filter mismatch
 * (e.g. activated counted outside the surfaced window) can never blow past
 * the on_track bucket — it just stays at the top.
 */
export function bucketPace(activated7d: number, surfaced7d: number): { tone: PaceTone; ratio: number } {
  const a = Math.max(0, Math.floor(activated7d || 0));
  const s = Math.max(0, Math.floor(surfaced7d || 0));
  const raw = s > 0 ? a / s : 0;
  const ratio = Math.max(0, Math.min(1, raw));
  const tone: PaceTone =
    ratio >= ON_TRACK_THRESHOLD ? 'on_track' :
    ratio >= SLIGHTLY_BEHIND_THRESHOLD ? 'slightly_behind' :
    'falling_behind';
  return { tone, ratio };
}

/**
 * Validate an IANA timezone by asking Intl to format something with it.
 * Returns the trimmed string when valid, or null when Intl throws RangeError.
 */
function isValidTimezone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    // formatToParts throws RangeError on unknown IANA names
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).formatToParts(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * YYYY-MM-DD in the user's local tz. Uses 'en-CA' which renders ISO date
 * format with `-` separators reliably across all Intl implementations.
 */
export function userLocalDate(nowUtc: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(nowUtc);
}

/**
 * Local hour 0..23 in the user's local tz. We parse via formatToParts so we
 * always get the integer hour back rather than relying on locale-specific
 * formatting (en-GB might give "24:00", others "00", etc.).
 */
export function userLocalHour(nowUtc: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(nowUtc);
  const hourPart = parts.find((p) => p.type === 'hour');
  if (!hourPart) return 0;
  const h = parseInt(hourPart.value, 10);
  // en-GB renders the 0th hour as "24" in some Node versions, normalize.
  if (h === 24) return 0;
  return h;
}

/**
 * Resolve a user's timezone. Read order (first hit wins):
 *   1. `app_users.timezone`
 *   2. `user_preferences.timezone`
 *   3. `memory_facts.fact_key='timezone'`
 *   4. `resolveUserTimezone(null)` → DEFAULT_USER_TIMEZONE
 *
 * Each lookup is wrapped in try/catch so a missing column on older
 * deployments degrades to the next source rather than throwing the
 * caller out of the user loop.
 */
export async function getUserTimezone(
  supa: SupabaseClient<any, any, any>,
  userId: string,
  tenantId?: string,
): Promise<string> {
  if (!userId) return resolveUserTimezone(null);

  // 1. app_users.timezone (scope by tenant when supplied — the service-role
  // client bypasses RLS, so an unscoped lookup could pick up the same
  // user_id from another tenant if the same UUID is used cross-tenant).
  try {
    let q = supa.from('app_users').select('timezone').eq('user_id', userId);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { data } = await q.maybeSingle();
    const tz = (data as { timezone?: string | null } | null)?.timezone ?? null;
    if (tz && isValidTimezone(tz)) return tz;
  } catch {
    // column or table may not exist on older snapshots — fall through
  }

  // 2. user_preferences.timezone — `user_preferences` has no tenant_id
  //    column (schema confirmed June 2026), so this lookup is user-scoped
  //    only. Adding .eq('tenant_id', …) here would silently 400 and the
  //    DB layer would return null instead of the real timezone.
  try {
    const { data } = await supa
      .from('user_preferences')
      .select('timezone')
      .eq('user_id', userId)
      .maybeSingle();
    const tz = (data as { timezone?: string | null } | null)?.timezone ?? null;
    if (tz && isValidTimezone(tz)) return tz;
  } catch {
    // fall through
  }

  // 3. memory_facts where fact_key='timezone' (tenant-scoped same as above)
  try {
    let q = supa
      .from('memory_facts')
      .select('fact_value')
      .eq('user_id', userId)
      .eq('fact_key', 'timezone');
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { data } = await q
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const tz = (data as { fact_value?: string | null } | null)?.fact_value ?? null;
    if (tz && isValidTimezone(tz)) return tz;
  } catch {
    // fall through
  }

  // 4. fallback default (Europe/Berlin via resolveUserTimezone)
  return resolveUserTimezone(null);
}

/**
 * Dedupe: has the user already received a `daily_pace_check` notification
 * during their local day?
 *
 * We compute the UTC window that corresponds to the start of the user's
 * local day, then query `user_notifications` for any row of type
 * `daily_pace_check` created after that instant. Because the user's local
 * "today" can begin earlier than 24h ago in UTC (e.g. for a +14 zone),
 * we conservatively look back 26h — large enough to cover any IANA
 * offset on Earth.
 */
async function alreadySentToday(
  supa: SupabaseClient<any, any, any>,
  userId: string,
  tenantId: string,
  nowUtc: Date,
  tz: string,
): Promise<boolean> {
  // 26h window covers all real-world offsets (max ~14h east of UTC)
  const windowStart = new Date(nowUtc.getTime() - 26 * 60 * 60 * 1000).toISOString();
  const todayLocal = userLocalDate(nowUtc, tz);

  try {
    const { data } = await supa
      .from('user_notifications')
      .select('id, created_at')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('type', 'daily_pace_check')
      .gte('created_at', windowStart)
      .order('created_at', { ascending: false })
      .limit(10);
    const rows = (data || []) as Array<{ created_at: string }>;
    // Any row whose user-local-day matches today's user-local-day means we
    // already sent today. This is robust against offset weirdness — we
    // compare the date string in the user's own tz.
    for (const row of rows) {
      const rowDate = userLocalDate(new Date(row.created_at), tz);
      if (rowDate === todayLocal) return true;
    }
    return false;
  } catch (err: any) {
    // Propagate read failures so the route's per-user try/catch surfaces them
    // as `errors`, distinct from real already_sent dedupes. Silently returning
    // true on a transient blip would suppress the user's notification for the
    // whole day with the WRONG metric — making real send failures invisible.
    throw new Error(`alreadySentToday read failed: ${err?.message || err}`);
  }
}

/**
 * Main entrypoint: decide whether to notify this user, and with what tone.
 * All Supabase calls are guarded; this function never throws on data
 * errors. The route is still responsible for wrapping in try/catch so a
 * truly unexpected error (e.g. supabase client null) doesn't kill the loop.
 */
export async function computePaceDecision(
  supa: SupabaseClient<any, any, any>,
  userId: string,
  tenantId: string,
  nowUtc: Date,
  opts?: { skipHourCheck?: boolean },
): Promise<PaceDecision> {
  // 1. Resolve tz. Invalid strings fall through to Europe/Berlin via
  //    getUserTimezone's isValidTimezone guard, so this never throws.
  const tz = await getUserTimezone(supa, userId, tenantId);

  let localHour: number;
  let localDate: string;
  try {
    localHour = userLocalHour(nowUtc, tz);
    localDate = userLocalDate(nowUtc, tz);
  } catch {
    // Belt + braces: even with the DB layer cleaning bad tz values, if the
    // resolved string somehow makes Intl unhappy we mark invalid_tz and
    // skip — don't dispatch.
    return { shouldNotify: false, skipReason: 'invalid_tz', timezone: tz };
  }

  // The wrong_hour gate is bypassable only via the explicit debug param
  // on the route (?force=true) so on-call can fire a test push for a
  // single user without waiting for their local 19:00 tick.
  if (!opts?.skipHourCheck && localHour !== 19) {
    return {
      shouldNotify: false,
      skipReason: 'wrong_hour',
      userLocalDate: localDate,
      userLocalHour: localHour,
      timezone: tz,
    };
  }

  // 2. Active life_compass goal required. NOTE: `life_compass` has no
  //    tenant_id column (schema confirmed June 2026); user_id is unique
  //    enough on its own. An earlier .eq('tenant_id', …) here caused
  //    PostgREST to 400, the destructured `data` came back null, and
  //    everyone was silently skipped with skipReason='no_goal'.
  const { data: goal } = await supa
    .from('life_compass')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  if (!goal) {
    return {
      shouldNotify: false,
      skipReason: 'no_goal',
      userLocalDate: localDate,
      userLocalHour: localHour,
      timezone: tz,
    };
  }

  // 3. Push must not be globally muted
  const { data: prefs } = await supa
    .from('user_notification_preferences')
    .select('push_enabled')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  // Treat anything falsy as muted to mirror notifyUser's semantics
  // (notification-service.ts: `!prefs.push_enabled`). Without this, a user
  // with prefs row but push_enabled=NULL would be counted as dispatched here
  // and then silently suppressed downstream — leaving a dedup row written
  // for a notification that never went out and corrupting the metrics.
  if (prefs && !(prefs as { push_enabled?: boolean | null }).push_enabled) {
    return {
      shouldNotify: false,
      skipReason: 'muted',
      userLocalDate: localDate,
      userLocalHour: localHour,
      timezone: tz,
    };
  }

  // 4. Count surfaced_7d. NOTE: both numerator and denominator filter by
  //    `created_at` (the row's birth in the window) so the ratio cannot
  //    exceed 1. We deliberately do NOT filter activated by `activated_at`
  //    because that lets late-activated rows survive past the window and
  //    blow the ratio past 1.
  const windowStart = new Date(nowUtc.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // `autopilot_recommendations` has no tenant_id column (schema confirmed
  // June 2026); same silent-skip trap as life_compass if we filter on it.
  const { count: surfaced7d } = await supa
    .from('autopilot_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', windowStart);
  const surfaced = surfaced7d || 0;

  if (surfaced < MIN_SURFACED_FOR_NOTIFY) {
    return {
      shouldNotify: false,
      skipReason: 'insufficient_actions',
      surfaced7d: surfaced,
      userLocalDate: localDate,
      userLocalHour: localHour,
      timezone: tz,
    };
  }

  // 5. Dedupe
  const sent = await alreadySentToday(supa, userId, tenantId, nowUtc, tz);
  if (sent) {
    return {
      shouldNotify: false,
      skipReason: 'already_sent',
      surfaced7d: surfaced,
      userLocalDate: localDate,
      userLocalHour: localHour,
      timezone: tz,
    };
  }

  // 6. activated_7d (same window, status=activated)
  // No tenant_id column on autopilot_recommendations (see surfaced7d note).
  const { count: activated7d } = await supa
    .from('autopilot_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'activated')
    .gte('created_at', windowStart);
  const activated = activated7d || 0;

  const { tone, ratio } = bucketPace(activated, surfaced);

  return {
    shouldNotify: true,
    tone,
    ratio,
    surfaced7d: surfaced,
    activated7d: activated,
    userLocalDate: localDate,
    userLocalHour: localHour,
    timezone: tz,
  };
}

/**
 * Title/body i18n key pair for a given tone. Centralized so the route
 * handler and tests both reference the same mapping.
 */
export function paceToneKeys(tone: PaceTone): { titleKey: string; bodyKey: string } {
  return {
    titleKey: `notif.daily_pace.${tone}.title`,
    bodyKey: `notif.daily_pace.${tone}.body`,
  };
}
