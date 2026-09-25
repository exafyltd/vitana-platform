/**
 * VTID-04505 (Community Autopilot CA-5): the twice-daily member scan.
 *
 * An hourly tick (EventBridge → POST /api/v1/autopilot/recommendations/community-scan)
 * processes the members whose local hour is 07 or 17. For each: read a
 * snapshot, run the scanners, rank, insert the picks as `autopilot_recommendations`
 * rows (source_type community, a typed action, a 14 h expiry).
 *
 * Guarantees:
 *   - Test/service accounts are never scanned and never a target (rules 43-45).
 *   - Nothing is sent to a member: rows only appear in their own Autopilot.
 *     No push, no notification (owner decision 2: shadow mode first; the one
 *     daily digest push is a separate, later switch).
 *   - Off unless COMMUNITY_AUTOPILOT_SCAN_ENABLED is exactly 'true'; a dry run
 *     computes everything and writes nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { runScanners, type MemberSnapshot, type PillarKey, type ScanCandidate, type ScanCategory } from './scanners';
import { rankCandidates, SCAN_ROW_TTL_HOURS, type HistoryRow, type RankResult } from './ranker';
import { selectExcessOpenRows, type OpenRow } from './lineup-cap';

export const SCAN_LOCAL_HOURS = new Set([7, 17]);
export const SCAN_SOURCE_PREFIX = 'scan_';

const TEMPLATE_CATEGORY: Record<string, ScanCategory> = {
  index_pillar: 'health', health_inbox: 'health', diary_gap: 'reflect', reply_message: 'connect',
  match_intro: 'connect', event_rsvp: 'community', share_progress: 'create', media_first: 'create',
  discover_explore: 'explore', invite_friend: 'grow',
};

export function isScanEnabled(): boolean {
  return process.env.COMMUNITY_AUTOPILOT_SCAN_ENABLED === 'true';
}

/** Pure: is this member due at `now` in their timezone? */
export function isDue(now: Date, tz: string, hours: Set<number> = SCAN_LOCAL_HOURS): boolean {
  try {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now)) % 24;
    return hours.has(h);
  } catch {
    return false;
  }
}

export interface ScanMemberResult {
  userId: string;
  inserted: number;
  /** Open rows beyond the cap retired (auto_archived) before ranking. VTID-04523. */
  retired: number;
  rank: RankResult;
}

/**
 * VTID-04523: retire open community rows beyond MAX_OPEN_PER_ROLE (rows
 * written before the cap existed). Runs before the member is ranked, so the
 * freed slots are visible to the ranker. A dry run computes and writes nothing.
 * The update is scoped to status 'new', so a row the member acted on in the
 * meantime is never touched.
 */
export async function retireExcessOpenRows(
  sb: SupabaseClient,
  userId: string,
  now: Date,
  dryRun: boolean,
): Promise<string[]> {
  const open = await rows<OpenRow>(
    sb.from('autopilot_recommendations')
      .select('id,action,impact_score,created_at,expires_at')
      .eq('user_id', userId).eq('status', 'new').eq('role_scope', 'community').limit(200),
  );
  const ids = selectExcessOpenRows(open, now);
  if (dryRun || ids.length === 0) return ids;
  try {
    const { error } = await sb.from('autopilot_recommendations')
      .update({ status: 'auto_archived', updated_at: now.toISOString() })
      .in('id', ids).eq('status', 'new');
    if (error) {
      console.warn(`[community-scan] retire failed for ${userId.slice(0, 8)}: ${(error as any).message}`);
      return [];
    }
  } catch (err) {
    console.warn(`[community-scan] retire failed for ${userId.slice(0, 8)}: ${(err as Error).message}`);
    return [];
  }
  return ids;
}

async function rows<T>(p: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await p;
    return error ? [] : data ?? [];
  } catch {
    return [];
  }
}

async function displayNames(sb: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const ps = await rows<{ user_id: string; first_name: string | null; display_name: string | null; full_name: string | null }>(
    sb.from('profiles').select('user_id,first_name,display_name,full_name').in('user_id', ids),
  );
  for (const p of ps) out.set(p.user_id, (p.first_name || p.display_name || p.full_name || '').trim());
  return out;
}

/** Read everything the scanners need for one member. Every read fails soft. */
export async function loadSnapshot(sb: SupabaseClient, userId: string, excluded: Set<string>, now: Date): Promise<MemberSnapshot> {
  const since14 = new Date(now.getTime() - 14 * 86400_000).toISOString();
  const in7 = new Date(now.getTime() + 7 * 86400_000).toISOString();
  const [idx, diary, unread, matches, events, posts, videos, sent, inbox] = await Promise.all([
    rows<any>(sb.from('vitana_index_scores').select('score_total,score_sleep,score_nutrition,score_exercise,score_hydration,score_mental').eq('user_id', userId).order('date', { ascending: false }).limit(1)),
    rows<any>(sb.from('diary_entries').select('created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1)),
    rows<any>(sb.from('chat_messages').select('sender_id,created_at').eq('receiver_id', userId).is('read_at', null).is('group_id', null).order('created_at', { ascending: true }).limit(10)),
    rows<any>(sb.from('daily_matches').select('matched_user_id,viewed_at,created_at').eq('user_id', userId).gte('created_at', new Date(now.getTime() - 86400_000).toISOString()).order('match_score', { ascending: false }).limit(5)),
    rows<any>(sb.from('global_community_events').select('id,title,start_time,max_participants,participant_count').gte('start_time', now.toISOString()).lte('start_time', in7).order('start_time', { ascending: true }).limit(10)),
    rows<any>(sb.from('profile_posts').select('id').eq('user_id', userId).gte('created_at', since14).limit(1)),
    rows<any>(sb.from('media_videos').select('id').eq('user_id', userId).limit(1)),
    rows<any>(sb.from('chat_messages').select('id').eq('sender_id', userId).limit(1)),
    rows<any>(sb.from('recommendations').select('id,title,body,status').eq('user_id', userId).in('status', ['new', 'pending', 'unread']).order('created_at', { ascending: false }).limit(1)),
  ]);

  const unreadReal = unread.filter((m) => m.sender_id && m.sender_id !== userId && !excluded.has(m.sender_id));
  const freshMatches = matches.filter((m) => !m.viewed_at && m.matched_user_id && !excluded.has(m.matched_user_id));
  const names = await displayNames(sb, [...new Set([...unreadReal.map((m) => m.sender_id), ...freshMatches.map((m) => m.matched_user_id)])]);

  const firstUnread = unreadReal.find((m) => names.get(m.sender_id));
  const firstMatch = freshMatches.find((m) => names.get(m.matched_user_id));
  const openEvent = events.find((e) => e.title && (!e.max_participants || (e.participant_count ?? 0) < e.max_participants));
  const i = idx[0];

  const usedFeatures = new Set<string>();
  if (diary.length) usedFeatures.add('diary');
  if (posts.length) usedFeatures.add('news_feed');
  if (videos.length) usedFeatures.add('media_hub');
  if (sent.length) usedFeatures.add('messenger');
  if (matches.some((m) => m.viewed_at)) usedFeatures.add('matches');
  if (i) usedFeatures.add('vitana_index');

  return {
    userId,
    now,
    index: i
      ? {
          total: i.score_total ?? null,
          pillars: {
            sleep: i.score_sleep, nutrition: i.score_nutrition, exercise: i.score_exercise,
            hydration: i.score_hydration, mental: i.score_mental,
          } as Partial<Record<PillarKey, number | null>>,
        }
      : null,
    lastDiaryAt: diary[0]?.created_at ?? null,
    unreadFrom: firstUnread ? { userId: firstUnread.sender_id, name: names.get(firstUnread.sender_id)!, sentAt: firstUnread.created_at } : null,
    freshMatch: firstMatch ? { userId: firstMatch.matched_user_id, name: names.get(firstMatch.matched_user_id)! } : null,
    upcomingEvent: openEvent ? { id: openEvent.id, title: openEvent.title, startsAt: openEvent.start_time } : null,
    postsLast14d: posts.length,
    videosEver: videos.length,
    usedFeatures,
    inboxItem: inbox[0] ? { id: inbox[0].id, title: inbox[0].title, body: inbox[0].body ?? null } : null,
  };
}

export async function loadHistory(sb: SupabaseClient, userId: string, now: Date): Promise<HistoryRow[]> {
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const hist = await rows<any>(
    sb.from('autopilot_recommendations')
      .select('fingerprint,source_ref,status,domain,updated_at,expires_at')
      .eq('user_id', userId).eq('source_type', 'community').gte('updated_at', since).limit(200),
  );
  return hist
    // An expired open row no longer occupies a slot.
    .filter((h) => !(['new', 'snoozed'].includes(h.status) && h.expires_at && Date.parse(h.expires_at) < now.getTime()))
    .map((h) => {
      const template = typeof h.source_ref === 'string' && h.source_ref.startsWith(SCAN_SOURCE_PREFIX)
        ? h.source_ref.slice(SCAN_SOURCE_PREFIX.length) : h.source_ref ?? null;
      return {
        fingerprint: h.fingerprint ?? null,
        template,
        status: h.status,
        domain: h.domain ?? null,
        category: (template && TEMPLATE_CATEGORY[template]) || null,
        updated_at: h.updated_at,
      };
    });
}

/** The DB row for one pick, with title/summary in the member's language. */
export function buildRow(userId: string, c: ScanCandidate & { score: number; novelty: boolean }, locale: string, now: Date,
  tt: (k: any, l: string, p?: Record<string, string | number>) => string) {
  const params: Record<string, string> = { ...c.params };
  if (params.pillar) params.pillar = tt(`autopilot.pillar.${params.pillar}`, locale);
  const title = c.literal?.title ?? tt(`autopilot.scan.${c.template}.title`, locale, params);
  const summary = c.literal ? c.literal.summary : tt(`autopilot.scan.${c.template}.summary`, locale, params);
  return {
    user_id: userId,
    title,
    summary,
    domain: c.domain,
    risk_level: 'low',
    impact_score: Math.max(1, Math.min(10, Math.round(c.score / 10))),
    effort_score: 2,
    status: 'new',
    source_type: 'community',
    source_ref: `${SCAN_SOURCE_PREFIX}${c.template}`,
    fingerprint: c.fingerprint,
    expires_at: new Date(now.getTime() + SCAN_ROW_TTL_HOURS * 3600_000).toISOString(),
    time_estimate_seconds: 120,
    action: c.action,
    provenance: { source: 'community_autopilot_scan', template: c.template, category: c.category, score: c.score, novelty: c.novelty },
  };
}

export async function scanMember(
  sb: SupabaseClient,
  userId: string,
  opts: { excluded: Set<string>; locale: string; now: Date; dryRun: boolean },
): Promise<ScanMemberResult> {
  const retiredIds = await retireExcessOpenRows(sb, userId, opts.now, opts.dryRun);
  // In a dry run this is what WOULD be retired (the summary carries dry_run).
  const retired = retiredIds.length;
  const [snapshot, history] = await Promise.all([
    loadSnapshot(sb, userId, opts.excluded, opts.now),
    loadHistory(sb, userId, opts.now),
  ]);
  const rank = rankCandidates({ candidates: runScanners(snapshot), history, usedFeatures: snapshot.usedFeatures, now: opts.now });
  if (opts.dryRun || rank.picks.length === 0) return { userId, inserted: 0, retired, rank };
  const { tt } = await import('../../i18n/catalog');
  const payload = rank.picks.map((p) => buildRow(userId, p, opts.locale, opts.now, tt as any));
  const { error } = await sb.from('autopilot_recommendations').insert(payload);
  if (error) {
    console.warn(`[community-scan] insert failed for ${userId.slice(0, 8)}: ${(error as any).message}`);
    return { userId, inserted: 0, retired, rank };
  }
  return { userId, inserted: payload.length, retired, rank };
}

export interface ScanRunSummary {
  enabled: boolean;
  dry_run: boolean;
  members_considered: number;
  members_due: number;
  members_scanned: number;
  rows_inserted: number;
  rows_retired: number;
  results: Array<{ user_id: string; inserted: number; retired: number; picks: string[]; dropped: number }>;
}

/**
 * One tick. `onlyUserId` scans a single member regardless of the hour (for
 * an operator check); `dryRun` writes nothing.
 */
export async function runCommunityScan(
  sb: SupabaseClient,
  opts: { now?: Date; dryRun?: boolean; onlyUserId?: string; maxMembers?: number } = {},
): Promise<ScanRunSummary> {
  const now = opts.now ?? new Date();
  const enabled = isScanEnabled();
  const dryRun = opts.dryRun === true || !enabled;
  const { fetchExcludedTestServiceAccountIds } = await import('../../lib/excluded-test-service-accounts');
  const excluded = await fetchExcludedTestServiceAccountIds(sb);

  let memberIds: string[];
  if (opts.onlyUserId) {
    memberIds = [opts.onlyUserId];
  } else {
    const members = await rows<{ user_id: string }>(sb.from('user_tenants').select('user_id').eq('is_primary', true).limit(5000));
    memberIds = [...new Set(members.map((m) => m.user_id))];
  }
  memberIds = memberIds.filter((id) => id && !excluded.has(id));

  // Timezone: the member's latest reminder tz, else a remembered timezone
  // fact, else the platform default (Europe/Berlin for this community).
  const ids = memberIds.slice(0, 5000);
  const [reminderTz, factTz] = await Promise.all([
    rows<{ user_id: string; user_tz: string | null }>(
      sb.from('reminders').select('user_id,user_tz').in('user_id', ids).not('user_tz', 'is', null).order('created_at', { ascending: false }).limit(5000),
    ),
    rows<{ user_id: string; fact_value: string | null }>(
      sb.from('memory_facts').select('user_id,fact_value').in('user_id', ids).eq('fact_key', 'timezone').limit(5000),
    ),
  ]);
  const tzOf = new Map<string, string | null>();
  for (const f of factTz) if (f.fact_value && !tzOf.has(f.user_id)) tzOf.set(f.user_id, f.fact_value);
  for (const r of reminderTz) if (r.user_tz && !tzOf.has(r.user_id)) tzOf.set(r.user_id, r.user_tz);
  const { resolveUserTimezone } = await import('../guide/user-timezone');
  const due = opts.onlyUserId ? memberIds : memberIds.filter((id) => isDue(now, resolveUserTimezone(tzOf.get(id) ?? null)));
  const batch = due.slice(0, opts.maxMembers ?? 500);

  const { bulkGetUserLocales } = await import('../../i18n/server-locale');
  const locales = await bulkGetUserLocales(sb, batch).catch(() => new Map<string, string>());

  const results: ScanRunSummary['results'] = [];
  let inserted = 0;
  let retired = 0;
  for (const userId of batch) {
    try {
      const r = await scanMember(sb, userId, { excluded, locale: String(locales.get(userId) ?? 'de'), now, dryRun });
      inserted += r.inserted;
      retired += r.retired;
      results.push({ user_id: userId, inserted: r.inserted, retired: r.retired, picks: r.rank.picks.map((p) => p.fingerprint), dropped: r.rank.dropped.length });
    } catch (err) {
      console.warn(`[community-scan] member ${userId.slice(0, 8)} failed: ${(err as Error).message}`);
    }
  }
  return {
    enabled,
    dry_run: dryRun,
    members_considered: memberIds.length,
    members_due: due.length,
    members_scanned: results.length,
    rows_inserted: inserted,
    rows_retired: retired,
    results,
  };
}
