/**
 * User Context Profiler - BOOTSTRAP-HISTORY-AWARE-TIMELINE Phase 3
 *
 * Deterministic, rules-based summary of what a user has been doing,
 * what they seem to prefer, and what health/routine patterns they exhibit.
 * The ORB injects this summary into the Gemini Live system prompt so
 * voice-to-voice conversations are history-aware rather than amnesic.
 *
 * Inputs (read-only, service role):
 *   - user_activity_log           last 14 days
 *   - user_routines               VTID-01936 pattern-extracted rhythms
 *   - memory_facts                via existing getCurrentFacts service
 *   - user_preferences            explicit user preferences
 *   - user_inferred_preferences   system-inferred preferences
 *   - vitana_index_scores         latest health snapshot
 *
 * Output: a compact tagged prose block sized to a configurable char budget.
 *
 * No LLM calls — pattern counting is fast (<30ms warm) and debuggable.
 * Upgrade path: swap internals behind the same signature if narratives
 * prove insufficient.
 *
 * Cache: per-user in-proc Map with 10-min TTL, invalidated on profiler
 * version bump (written by timeline-projector on new activity insert).
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getCurrentFacts } from './memory-facts-service';

const TTL_MS = 10 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_MAX_CHARS = 2400;

interface CacheEntry {
  version: number;
  summary: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface GetProfileOptions {
  maxChars?: number;
  windowDays?: number;
  tenantId?: string;
}

export interface UserContextProfile {
  summary: string;
  version: number;
  cached: boolean;
  warnings: string[];
}

function serviceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function readProfilerVersion(client: SupabaseClient, userId: string): Promise<number> {
  const { data } = await client
    .from('user_profiler_version')
    .select('version')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.version ?? 0;
}

function hourBucket(iso: string): 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' {
  const h = new Date(iso).getHours();
  if (h >= 5 && h < 10) return 'morning';
  if (h >= 10 && h < 13) return 'midday';
  if (h >= 13 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(delta / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function summarizeActivity(type: string, data?: Record<string, unknown> | null): string {
  const [prefix, ...rest] = type.split('.');
  const suffix = rest.join('.');

  // BOOTSTRAP-HISTORY-AWARE-TIMELINE: media consumption gets rich labels
  // that include the actual title so the voice ORB can name-drop the song /
  // podcast the user played, instead of just saying "played media".
  if (type === 'media.music.play') {
    const title = data?.title || data?.query || 'music';
    const channel = data?.channel ? ` by ${data.channel}` : '';
    const src = data?.source ? ` on ${formatMediaSource(String(data.source))}` : '';
    return `played "${title}"${channel}${src}`;
  }
  if (type === 'media.podcast.play') {
    const title = data?.title || data?.query || 'a podcast';
    return `listened to "${title}"`;
  }
  if (type === 'media.shorts.play' || type === 'media.video.play') {
    const title = data?.title || 'a short';
    return `watched "${title}"`;
  }

  const map: Record<string, string> = {
    'orb.session.start': 'started voice session',
    'orb.session.stop': 'ended voice session',
    'diary.create': 'logged a diary entry',
    'diary.template.submitted': 'logged a diary entry',
    'autopilot.action.execute': 'activated an autopilot recommendation',
    'autopilot.action.dismiss': 'dismissed an autopilot recommendation',
    'autopilot.action.snooze': 'snoozed an autopilot recommendation',
    'task.complete': 'completed a task',
    'task.create': 'created a task',
    'memory.promote': 'promoted content to knowledge',
    'health.biomarker.upload_pdf': 'uploaded lab results',
    'health.biomarker.upload_manual': 'logged biomarker manually',
    'health.biomarker.connect_device': 'connected a health device',
    'health.supplement.add': 'added a supplement',
    'community.live.join': 'joined a live room',
    'community.event.join': 'joined a community event',
    'community.group.join': 'joined a community group',
    'community.follow': 'followed someone',
    'discover.service.view': 'viewed a service',
    'discover.service.bookmark': 'bookmarked a service',
    'calendar.create': 'added a calendar event',
    'wallet.transfer': 'made a wallet transfer',
  };
  if (map[type]) return map[type];
  return `${prefix || 'activity'} ${suffix || ''}`.trim();
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

interface ActivityRow {
  activity_type: string;
  activity_data: Record<string, unknown> | null;
  created_at: string;
}

interface RoutineRow {
  routine_kind: string;
  title: string;
  summary: string;
  confidence: number;
}

interface PreferenceRow {
  category: string;
  preference_key: string;
  preference_value: string | null;
  source?: string;
}

async function fetchActivityLog(client: SupabaseClient, userId: string, sinceIso: string): Promise<ActivityRow[]> {
  const { data, error } = await client
    .from('user_activity_log')
    .select('activity_type, activity_data, created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(400);
  if (error) return [];
  return (data || []) as ActivityRow[];
}

async function fetchRoutines(client: SupabaseClient, userId: string): Promise<RoutineRow[]> {
  const { data, error } = await client
    .from('user_routines')
    .select('routine_kind, title, summary, confidence')
    .eq('user_id', userId)
    .gte('confidence', 0.5)
    .order('confidence', { ascending: false })
    .limit(8);
  if (error) return [];
  return (data || []) as RoutineRow[];
}

async function fetchPreferences(client: SupabaseClient, userId: string): Promise<PreferenceRow[]> {
  const out: PreferenceRow[] = [];
  const explicit = await client
    .from('user_preferences')
    .select('category, preference_key, preference_value')
    .eq('user_id', userId)
    .limit(20);
  if (!explicit.error && explicit.data) {
    for (const row of explicit.data as any[]) {
      out.push({
        category: row.category ?? 'preference',
        preference_key: row.preference_key ?? row.key ?? '',
        preference_value: row.preference_value ?? row.value ?? null,
        source: 'explicit',
      });
    }
  }
  const inferred = await client
    .from('user_inferred_preferences')
    .select('category, preference_key, preference_value, confidence')
    .eq('user_id', userId)
    .order('confidence', { ascending: false })
    .limit(15);
  if (!inferred.error && inferred.data) {
    for (const row of inferred.data as any[]) {
      if ((row.confidence ?? 0) < 0.55) continue;
      out.push({
        category: row.category ?? 'preference',
        preference_key: row.preference_key ?? row.key ?? '',
        preference_value: row.preference_value ?? row.value ?? null,
        source: 'inferred',
      });
    }
  }
  return out;
}

async function fetchVitanaIndex(client: SupabaseClient, userId: string): Promise<{ score: number; deltas?: Record<string, number> } | null> {
  const { data, error } = await client
    .from('vitana_index_scores')
    .select('score, sub_scores, computed_at')
    .eq('user_id', userId)
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { score: Number(data.score) || 0, deltas: (data.sub_scores as Record<string, number>) || undefined };
}

/**
 * Collapse noisy nav events (page.view, auth.*) into a counted summary and
 * surface high-signal actions (diary, autopilot, recommendation, health,
 * community, wallet, memory, orb.session) verbatim. This is the difference
 * between the voice ORB saying "you viewed some pages" and "you logged a
 * diary entry this morning and accepted an autopilot recommendation."
 */
const HIGH_SIGNAL_PREFIXES = [
  'diary.',
  'autopilot.',
  'recommendation.',
  'health.',
  'community.',
  'wallet.',
  'memory.',
  'media.',              // songs, podcasts, shorts, videos
  'orb.session.',
  'task.',
  'calendar.',
  'discover.service.bookmark',
  'discover.offer.view',
  'profile.update',
];

function formatMediaSource(source: string): string {
  const map: Record<string, string> = {
    youtube_music: 'YouTube Music',
    spotify: 'Spotify',
    apple_music: 'Apple Music',
    vitana_hub: 'the Vitana Media Hub',
  };
  return map[source] || source;
}

function isHighSignal(type: string): boolean {
  return HIGH_SIGNAL_PREFIXES.some(p => type === p || type.startsWith(p));
}

/**
 * Dedicated content-consumption section. Makes songs / podcasts / shorts the
 * user played impossible for the voice ORB to miss — they get their own block,
 * separate from the generic [RECENT] list. Listed newest first with the title.
 */
function buildContentSection(activities: ActivityRow[]): string {
  const media = activities.filter(a => a.activity_type.startsWith('media.'));
  if (!media.length) return '';

  const seenTitles = new Set<string>();
  const lines: string[] = [];
  for (const a of media) {
    const title = (a.activity_data?.title || a.activity_data?.query || '').toString();
    const dedupeKey = `${a.activity_type}:${title}`;
    if (seenTitles.has(dedupeKey)) continue;
    seenTitles.add(dedupeKey);
    lines.push(`- ${summarizeActivity(a.activity_type, a.activity_data)} (${relativeTime(a.created_at)})`);
    if (lines.length >= 8) break;
  }

  if (!lines.length) return '';
  return `[CONTENT_PLAYED]\n${lines.join('\n')}`;
}

function buildRecentSection(activities: ActivityRow[]): string {
  const meaningful = activities.filter(a => !a.activity_type.startsWith('chat.'));
  if (!meaningful.length) return '';

  const lines: string[] = [];
  const highSignal = meaningful.filter(a => isHighSignal(a.activity_type));
  const seen = new Set<string>();

  // Up to 8 high-signal items, de-duplicated by (type, activity_data.path or id)
  for (const a of highSignal.slice(0, 20)) {
    const dataKey = (a.activity_data && (a.activity_data.path || a.activity_data.entry_id || a.activity_data.recommendation_id || a.activity_data.orb_session_id)) as string | undefined;
    const key = `${a.activity_type}:${dataKey || relativeTime(a.created_at)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${summarizeActivity(a.activity_type, a.activity_data)} (${relativeTime(a.created_at)})`);
    if (lines.length >= 8) break;
  }

  // Nav summary: collapse consecutive page.view + auth into one counted line.
  const navCount = meaningful.filter(a => a.activity_type === 'page.view' || a.activity_type.startsWith('auth.')).length;
  if (navCount) {
    const navPaths = meaningful
      .filter(a => a.activity_type === 'page.view')
      .map(a => (a.activity_data?.path as string) || '')
      .filter(Boolean);
    const uniquePaths = Array.from(new Set(navPaths)).slice(0, 3);
    const pathsHint = uniquePaths.length ? ` — areas: ${uniquePaths.join(', ')}` : '';
    lines.push(`- ${navCount} navigation event${navCount === 1 ? '' : 's'} in this session${pathsHint}`);
  }

  if (!lines.length) return '';
  return `[RECENT]\n${lines.join('\n')}`;
}

/**
 * Counted summary across the 14-day window. Gives the voice ORB a sentence
 * it can quote when asked "what have I been doing lately?" even when no
 * single event is dramatic.
 */
function buildActivitySummarySection(activities: ActivityRow[]): string {
  if (!activities.length) return '';

  const counts: Record<string, number> = {};
  for (const a of activities) {
    const prefix = a.activity_type.split('.')[0];
    counts[prefix] = (counts[prefix] || 0) + 1;
  }

  const labelMap: Record<string, string> = {
    page: 'page views',
    auth: 'sign-ins',
    diary: 'diary entries',
    autopilot: 'autopilot actions',
    recommendation: 'recommendation interactions',
    health: 'health updates',
    community: 'community interactions',
    wallet: 'wallet actions',
    memory: 'memory updates',
    media: 'content plays',
    orb: 'voice sessions',
    task: 'task actions',
    calendar: 'calendar changes',
    discover: 'discover interactions',
    profile: 'profile edits',
  };

  // Show categories with count ≥ 1, ordered by count desc. Page views last
  // (they always dominate and shouldn't lead the sentence).
  const entries = Object.entries(counts)
    .map(([prefix, count]) => ({ prefix, count, label: labelMap[prefix] || prefix }))
    .sort((a, b) => {
      if (a.prefix === 'page' && b.prefix !== 'page') return 1;
      if (b.prefix === 'page' && a.prefix !== 'page') return -1;
      return b.count - a.count;
    })
    .slice(0, 6);

  if (!entries.length) return '';
  const parts = entries.map(e => `${e.count} ${e.label}`);
  return `[ACTIVITY_14D]\n- ${parts.join(', ')}.`;
}

function buildRoutinesSection(routines: RoutineRow[], activities: ActivityRow[]): string {
  const lines: string[] = [];

  // Prefer pre-extracted routines from VTID-01936 pattern extractor.
  for (const r of routines.slice(0, 5)) {
    lines.push(`- ${r.title}: ${r.summary}`);
  }

  // Fallback: derive a crude time-of-day preference from recent activity.
  if (lines.length === 0 && activities.length >= 10) {
    const buckets: Record<string, number> = {};
    for (const a of activities) {
      const b = hourBucket(a.created_at);
      buckets[b] = (buckets[b] || 0) + 1;
    }
    const total = activities.length;
    const [topBucket, topCount] = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0] || [];
    if (topBucket && topCount && topCount / total >= 0.4) {
      lines.push(`- Most active in the ${topBucket} (${Math.round((topCount / total) * 100)}% of recent activity).`);
    }
  }

  if (!lines.length) return '';
  return `[ROUTINES]\n${lines.join('\n')}`;
}

function buildPreferencesSection(prefs: PreferenceRow[]): string {
  if (!prefs.length) return '';
  const deduped = new Map<string, PreferenceRow>();
  for (const p of prefs) {
    const key = `${p.category}:${p.preference_key}`;
    if (!deduped.has(key)) deduped.set(key, p);
  }
  const lines = [...deduped.values()].slice(0, 8).map(p => {
    const label = p.preference_key || p.category;
    const value = p.preference_value ? `: ${p.preference_value}` : '';
    const tag = p.source === 'inferred' ? ' (inferred)' : '';
    return `- ${label}${value}${tag}`;
  });
  return `[PREFERENCES]\n${lines.join('\n')}`;
}

function buildHealthSection(activities: ActivityRow[], vitana: { score: number; deltas?: Record<string, number> } | null): string {
  const lines: string[] = [];
  const healthActivities = activities.filter(a => a.activity_type.startsWith('health.'));
  if (healthActivities.length) {
    const uploads = healthActivities.filter(a => a.activity_type.includes('upload') || a.activity_type.includes('connect')).length;
    const supplements = healthActivities.filter(a => a.activity_type.startsWith('health.supplement.add')).length;
    if (uploads) lines.push(`- ${uploads} health data upload${uploads === 1 ? '' : 's'} in the last 14 days.`);
    if (supplements) lines.push(`- Added ${supplements} supplement${supplements === 1 ? '' : 's'} recently.`);
  }
  if (vitana && vitana.score > 0) {
    lines.push(`- Latest Vitana Index: ${vitana.score.toFixed(1)}.`);
  }
  if (!lines.length) return '';
  return `[HEALTH]\n${lines.join('\n')}`;
}

function buildFactsSection(facts: { fact_key: string; fact_value: string; provenance_confidence: number }[]): string {
  if (!facts.length) return '';
  const top = facts
    .filter(f => f.provenance_confidence >= 0.7)
    .slice(0, 6)
    .map(f => `- ${f.fact_key.replace(/_/g, ' ')}: ${f.fact_value}`);
  if (!top.length) return '';
  return `[FACTS]\n${top.join('\n')}`;
}

export async function getUserContextSummary(
  userId: string,
  opts: GetProfileOptions = {}
): Promise<UserContextProfile> {
  const warnings: string[] = [];
  if (!userId) {
    return { summary: '', version: 0, cached: false, warnings: ['missing userId'] };
  }

  const client = serviceClient();
  if (!client) {
    return { summary: '', version: 0, cached: false, warnings: ['supabase not configured'] };
  }

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = Date.now();

  const version = await readProfilerVersion(client, userId);

  // Cache hit?
  const hit = cache.get(userId);
  if (hit && hit.version === version && hit.expiresAt > now) {
    return { summary: hit.summary, version, cached: true, warnings };
  }

  const sinceIso = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const [activities, routines, prefs, vitana, factsResult] = await Promise.all([
    fetchActivityLog(client, userId, sinceIso),
    fetchRoutines(client, userId),
    fetchPreferences(client, userId),
    fetchVitanaIndex(client, userId),
    opts.tenantId
      ? getCurrentFacts({ tenant_id: opts.tenantId, user_id: userId })
      : Promise.resolve({ ok: true, facts: [] as any[] }),
  ]);

  const sections = [
    buildActivitySummarySection(activities),
    buildRoutinesSection(routines, activities),
    buildPreferencesSection(prefs),
    buildHealthSection(activities, vitana),
    buildContentSection(activities),
    buildFactsSection(factsResult.ok ? factsResult.facts : []),
    buildRecentSection(activities),
  ].filter(Boolean);

  const summary = truncate(sections.join('\n\n'), maxChars);

  cache.set(userId, { version, summary, expiresAt: now + TTL_MS });

  return { summary, version, cached: false, warnings };
}

/**
 * Drop the profiler cache for a user. Exposed for tests and admin endpoints.
 */
export function invalidateUserContextCache(userId: string): void {
  cache.delete(userId);
}

/**
 * Clear the entire cache — useful on gateway restart hooks if needed.
 */
export function clearUserContextCache(): void {
  cache.clear();
}
