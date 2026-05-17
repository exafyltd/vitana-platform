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
import { getAwarenessConfig } from './awareness-registry';

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

// VTID-03037: surface community-membership tenure into the profile block so
// the LiveKit / brain-OFF Vertex paths can answer "how long have I been a
// member?" without a tool call. Sourced from app_users.created_at which is
// the canonical registration timestamp (mirrored from profiles by Release A
// trigger). Returns null on miss so buildAccountSection can skip cleanly.
export interface AccountRow {
  createdAt: Date | null;
}

async function fetchAppUsersAccount(
  client: SupabaseClient,
  userId: string,
): Promise<AccountRow> {
  try {
    const { data, error } = await client
      .from('app_users')
      .select('created_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return { createdAt: null };
    const raw = (data as { created_at?: string | null }).created_at;
    if (!raw) return { createdAt: null };
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return { createdAt: null };
    return { createdAt: parsed };
  } catch {
    return { createdAt: null };
  }
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

// =============================================================================
// Vitana Index — canonical 5-pillar model (BOOTSTRAP-ORB-INDEX-AWARENESS-R4)
// =============================================================================
// Pillars: nutrition, hydration, exercise, sleep, mental  (each 0-200)
// Schema (post 5pillar-cleanup migration 20260423110000):
//   vitana_index_scores: tenant_id, user_id, date, score_total,
//     score_nutrition, score_hydration, score_exercise, score_sleep, score_mental,
//     model_version, feature_inputs JSONB (balance_factor, ratio, raw_sum, subscores),
//     confidence, updated_at
// Tier ladder + balance state: see services/gateway/src/lib/vitana-pillars.ts.
// Default 90-day framing: aspirational, not a gate — "Really good" at 600+.
// =============================================================================

import {
  PILLAR_KEYS,
  type PillarKey,
  tierForScore,
  describeBalance,
  REALLY_GOOD_THRESHOLD,
  STRETCH_TARGET,
  projectDay90,
} from '../lib/vitana-pillars';

/**
 * Sub-score breakdown per pillar. Matches the v3 compute RPC output shape
 * in feature_inputs.subscores. All four components are caps, not live
 * values — the RPC clamps each. We expose them so voice can explain WHY
 * a pillar is low ("mostly baseline — connect a tracker to climb").
 */
export interface PillarSubscores {
  baseline: number;     // 0-40, from vitana_index_baseline_survey
  completions: number;  // 0-80, from calendar_events completions × tag map
  data: number;         // 0-40, from health_features_daily
  streak: number;       // 0-40, consecutive-day streak for the pillar
}

export interface VitanaIndexSnapshot {
  total: number;                                     // 0-999
  tier: string;                                      // Starting / Early / ... / Elite
  tier_framing: string;                              // one-line voice-friendly description
  pillars: Record<PillarKey, number>;                // each 0-200
  weakest_pillar: { name: PillarKey; score: number };
  strongest_pillar: { name: PillarKey; score: number };
  balance_factor: number;                            // 0.7-1.0, from feature_inputs
  balance_label: string;                             // 'well balanced' / 'off-balance' / ...
  balance_hint: string;                              // assistant-facing guidance
  subscores: Partial<Record<PillarKey, PillarSubscores>>;  // per-pillar if available
  trend_7d: number;                                  // delta vs 7 days ago
  history_7d: number[];                              // [oldest...latest], up to 7 entries
  goal_target: number;                               // 600 (Really good entry)
  points_to_really_good: number;                     // max(0, 600 - total); aspirational only
  stretch_target: number;                            // 850 — aspirational stretch anchor (UI-aligned)
  points_to_stretch: number;                         // max(0, 850 - total)
  projected_day_90: number | null;                   // linear extrapolation of trend_7d onto Day 90; null if no baseline
  projected_day_90_tier: string | null;              // forecast tier name for the projection
  last_computed: string;                             // ISO date
  model_version?: string;                            // e.g. 'v3-5pillar'
  confidence?: number;                               // 0-1, from the RPC
  last_movement?: { pillar: string; delta: number; reason?: string };
  // G3: Life Compass active goal attached to the health snapshot so the
  // ORB [HEALTH] block can emit an `Active goal:` line. Null when the user
  // has not set a goal yet.
  life_compass: LifeCompassSnapshot | null;
}

/** Live Life Compass goal attached to the user's health snapshot. */
export interface LifeCompassSnapshot {
  primary_goal: string;
  category: string;
  confidence_score?: number | null;
}

/**
 * State of the user's Vitana Index setup. Used by buildHealthSection to
 * render an explicit, actionable line when the score isn't available —
 * instead of silently omitting the Index entirely, which is how the voice
 * model ended up with nothing to say ("I don't know your Index").
 *
 * BOOTSTRAP-ORB-INDEX-AWARENESS-R3: ensure the Assistant always has
 * SOMETHING to quote about the Index, even if that something is
 * "setup is incomplete — here's how to fix it."
 */
export type VitanaIndexFetchResult =
  | { state: 'ok'; snapshot: VitanaIndexSnapshot }
  | { state: 'no_score_baseline_exists' }     // survey done, compute failed (#839 state)
  | { state: 'not_set_up' };                   // neither row exists

const INDEX_SELECT_COLUMNS =
  'date, score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental, model_version, feature_inputs, confidence';

function parseSubscoresFromFeatureInputs(featureInputs: any): Partial<Record<PillarKey, PillarSubscores>> {
  const out: Partial<Record<PillarKey, PillarSubscores>> = {};
  if (!featureInputs || typeof featureInputs !== 'object') return out;
  const s = featureInputs.subscores;
  if (!s || typeof s !== 'object') return out;
  for (const pillar of PILLAR_KEYS) {
    const raw = s[pillar];
    if (raw && typeof raw === 'object') {
      out[pillar] = {
        baseline: Number(raw.baseline) || 0,
        completions: Number(raw.completions) || 0,
        data: Number(raw.data) || 0,
        streak: Number(raw.streak) || 0,
      };
    }
  }
  return out;
}

/**
 * G3: fetch the user's active Life Compass goal so it can ride along on the
 * VitanaIndexSnapshot and the ORB [HEALTH] block. Null when no goal set.
 * Best-effort: a table-missing or RLS error returns null so the profiler
 * stays up if the compass surface is temporarily unavailable.
 */
export async function fetchLifeCompass(
  client: SupabaseClient,
  userId: string,
): Promise<LifeCompassSnapshot | null> {
  try {
    const { data, error } = await client
      .from('life_compass')
      .select('primary_goal, category, confidence_score')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    const row = data[0] as { primary_goal: string; category: string; confidence_score?: number | null };
    return {
      primary_goal: row.primary_goal,
      category: row.category,
      confidence_score: row.confidence_score ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchVitanaIndex(client: SupabaseClient, userId: string): Promise<VitanaIndexFetchResult> {
  // 1) Try last 7 days first (for trend math).
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: recentData, error: recentErr } = await client
    .from('vitana_index_scores')
    .select(INDEX_SELECT_COLUMNS)
    .eq('user_id', userId)
    .gte('date', sinceIso)
    .order('date', { ascending: true })
    .limit(14);

  let rows: any[] | null = null;
  if (!recentErr && recentData && recentData.length > 0) {
    rows = recentData as any[];
  } else {
    // 2) Fallback: latest-ever score. User may have paused or not computed in a week;
    //    we still want to report what they have instead of saying nothing.
    const { data: latestData } = await client
      .from('vitana_index_scores')
      .select(INDEX_SELECT_COLUMNS)
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(1);
    if (latestData && latestData.length > 0) rows = latestData as any[];
  }

  if (!rows || rows.length === 0) {
    // 3) No score row at all. Distinguish "compute failed after baseline" from
    //    "never set up" so voice can redirect honestly (BOOTSTRAP-VITANA-INDEX-STATUS #839).
    const { data: surveyData } = await client
      .from('vitana_index_baseline_survey')
      .select('user_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (surveyData) return { state: 'no_score_baseline_exists' };
    return { state: 'not_set_up' };
  }

  const latest = rows[rows.length - 1];
  const earliest = rows[0];
  const history_7d = rows.map(r => Number(r.score_total) || 0);
  const total = Number(latest.score_total) || 0;
  const pillars: Record<PillarKey, number> = {
    nutrition: Number(latest.score_nutrition) || 0,
    hydration: Number(latest.score_hydration) || 0,
    exercise:  Number(latest.score_exercise)  || 0,
    sleep:     Number(latest.score_sleep)     || 0,
    mental:    Number(latest.score_mental)    || 0,
  };
  const pillarEntries = PILLAR_KEYS.map(k => [k, pillars[k]] as [PillarKey, number]);
  pillarEntries.sort((a, b) => a[1] - b[1]);
  const weakest_pillar = { name: pillarEntries[0][0], score: pillarEntries[0][1] };
  const strongest_pillar = { name: pillarEntries[pillarEntries.length - 1][0], score: pillarEntries[pillarEntries.length - 1][1] };
  const trend_7d = rows.length >= 2 ? total - (Number(earliest.score_total) || 0) : 0;

  const featureInputs = (latest.feature_inputs as any) || {};
  const balanceFactor = typeof featureInputs.balance_factor === 'number' ? featureInputs.balance_factor : 1.0;
  const balance = describeBalance(balanceFactor);
  const subscores = parseSubscoresFromFeatureInputs(featureInputs);
  const tier = tierForScore(total);

  let last_movement: VitanaIndexSnapshot['last_movement'] | undefined;
  try {
    const { data: evt } = await client
      .from('oasis_events')
      .select('topic, payload, created_at')
      .eq('actor_id', userId)
      .eq('topic', 'index.recomputed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (evt) {
      const p = (evt.payload as any) || {};
      const delta = Number(p.total_delta ?? p.delta ?? 0);
      const reason = p.reason ?? p.source ?? p.action_title;
      if (delta !== 0) last_movement = { pillar: p.pillar ?? 'unknown', delta, reason };
    }
  } catch { /* best-effort */ }

  // Day-90 projection — mirrors the frontend trajectory card (linear from
  // 7-day trend). Anchored at the user's first-ever Index row rather than
  // today so "days remaining" is meaningful. If we can't compute a
  // baseline day count (oldest row missing), fall back to using today as
  // the reference — projection stays accurate when trend is flat.
  let projected_day_90: number | null = null;
  let projected_day_90_tier: string | null = null;
  try {
    const { data: firstRow } = await client
      .from('vitana_index_scores')
      .select('date')
      .eq('user_id', userId)
      .order('date', { ascending: true })
      .limit(1)
      .maybeSingle();
    const firstDate = firstRow?.date as string | undefined;
    const today = new Date();
    const firstTs = firstDate ? Date.parse(firstDate) : today.getTime();
    const daysSinceStart = Math.max(0, Math.floor((today.getTime() - firstTs) / (24 * 60 * 60 * 1000)));
    const proj = projectDay90(total, trend_7d, daysSinceStart);
    if (proj !== null) {
      projected_day_90 = proj;
      projected_day_90_tier = tierForScore(proj).name;
    }
  } catch { /* best-effort */ }

  return {
    state: 'ok',
    snapshot: {
      total,
      tier: tier.name,
      tier_framing: tier.framing,
      pillars,
      weakest_pillar,
      strongest_pillar,
      balance_factor: balanceFactor,
      balance_label: balance.label,
      balance_hint: balance.assistantHint,
      subscores,
      trend_7d,
      history_7d,
      goal_target: REALLY_GOOD_THRESHOLD,
      points_to_really_good: Math.max(0, REALLY_GOOD_THRESHOLD - total),
      stretch_target: STRETCH_TARGET,
      points_to_stretch: Math.max(0, STRETCH_TARGET - total),
      projected_day_90,
      projected_day_90_tier,
      last_computed: latest.date,
      model_version: latest.model_version ?? undefined,
      confidence: typeof latest.confidence === 'number' ? latest.confidence : undefined,
      last_movement,
      // G3: attach Life Compass goal to the snapshot. Best-effort — null when
      // not set. Fetched after the Index read so the profiler doesn't fan out
      // an extra call for users whose Index isn't computed yet.
      life_compass: await fetchLifeCompass(client, userId),
    },
  };
}

/**
 * Thin wrapper exposed for ORB tools that want the raw snapshot (not the
 * state envelope). Returns null when there's no score — callers that need
 * the richer state machine should call fetchVitanaIndex directly.
 */
async function fetchVitanaIndexSnapshot(client: SupabaseClient, userId: string): Promise<VitanaIndexSnapshot | null> {
  const r = await fetchVitanaIndex(client, userId);
  return r.state === 'ok' ? r.snapshot : null;
}

export { fetchVitanaIndexSnapshot as fetchVitanaIndexForProfiler };

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

function formatPillarName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Pick the dominant sub-score category for a pillar so voice can explain
 * WHY the pillar sits where it does ("mostly baseline — connect a tracker
 * to climb", "strong streak — keep going").
 */
function dominantSubscoreHint(sub: PillarSubscores | undefined): string | null {
  if (!sub) return null;
  const parts: Array<[string, number]> = [
    ['baseline', sub.baseline],
    ['completions', sub.completions],
    ['data', sub.data],
    ['streak', sub.streak],
  ];
  const total = parts.reduce((a, [, n]) => a + n, 0);
  if (total <= 0) return 'no signal yet';
  parts.sort((a, b) => b[1] - a[1]);
  const [top, topVal] = parts[0];
  const share = topVal / total;
  if (top === 'baseline' && share >= 0.6) {
    return 'mostly survey baseline — connected data or a tracker would lift it further';
  }
  if (top === 'completions' && share >= 0.4) {
    return 'completed actions are carrying it — keep the rhythm';
  }
  if (top === 'data' && share >= 0.4) {
    return 'connected data is feeding it — real signal';
  }
  if (top === 'streak' && share >= 0.3) {
    return 'streak is doing the work — the day-over-day consistency compounds';
  }
  return null;
}

function buildHealthSection(activities: ActivityRow[], vitanaResult: VitanaIndexFetchResult | null): string {
  const lines: string[] = [];

  // Vitana Index — ALWAYS emit something so the voice model has a quotable
  // line. Three states: `ok`, `no_score_baseline_exists`, `not_set_up`.
  // R3 established the never-silent property; R4 carries it over to the
  // 5-pillar model with balance + sub-score transparency.
  if (vitanaResult) {
    if (vitanaResult.state === 'ok') {
      const vitana = vitanaResult.snapshot;
      const trendStr = vitana.trend_7d > 0
        ? `trending up +${vitana.trend_7d} over 7 days`
        : vitana.trend_7d < 0
          ? `trending down ${vitana.trend_7d} over 7 days`
          : 'stable over 7 days';
      lines.push(`- Vitana Index: ${vitana.total} / 999 (${vitana.tier} tier — ${vitana.tier_framing}); ${trendStr}.`);

      const p = vitana.pillars;
      const pillarLines = PILLAR_KEYS.map(k => `${formatPillarName(k)} ${p[k]}/200`);
      lines.push(`- Pillars (5 canonical, max 200 each): ${pillarLines.join(', ')}.`);

      // Weakest/strongest with sub-score explanation so voice can name the lever.
      const weakestSub = dominantSubscoreHint(vitana.subscores[vitana.weakest_pillar.name]);
      const weakestSuffix = weakestSub ? ` — ${weakestSub}` : '';
      lines.push(`- Weakest pillar: ${formatPillarName(vitana.weakest_pillar.name)} (${vitana.weakest_pillar.score}/200)${weakestSuffix}.`);
      lines.push(`- Strongest pillar: ${formatPillarName(vitana.strongest_pillar.name)} (${vitana.strongest_pillar.score}/200).`);

      // Balance factor — a first-class signal. The RPC applies it as a
      // multiplicative dampener, so when the factor is < 1.0 the dampener
      // is suppressing the total more than the weakest single pillar does.
      lines.push(`- Balance: ${vitana.balance_factor.toFixed(2)}× (${vitana.balance_label}) — ${vitana.balance_hint}`);

      // Aspirational framing, NOT a gate. "Really good" starts at 600; we
      // surface the gap as progress signal, not as pass/fail.
      // Aspirational anchors — match the Index Detail goal card (600
      // milestone / 850 stretch). Two lines because users reference both
      // numbers on screen and voice must be able to answer "what's 850?".
      if (vitana.points_to_really_good > 0) {
        lines.push(`- Really-good milestone (600): ${vitana.points_to_really_good} points away. 90-day aspirational target for most users — do not frame as pass/fail.`);
      } else if (vitana.total >= 800) {
        lines.push(`- Really-good milestone (600): already inside, ${vitana.total - 600} points clear.`);
      } else {
        lines.push(`- Really-good milestone (600): already inside. The climb from here is slow and earned.`);
      }
      if (vitana.points_to_stretch > 0) {
        lines.push(`- Stretch target (850): ${vitana.points_to_stretch} points away. Deep in the Elite band — months of sustained balanced practice, NOT a 90-day target. When asked "what is 850", explain it as a long-horizon anchor, not a near-term goal.`);
      } else {
        lines.push(`- Stretch target (850): already reached. Sustained excellence territory.`);
      }

      // Day-90 linear projection — matches the frontend trajectory card.
      // Null when no baseline exists yet (first-day users); otherwise voice
      // can say "at this pace you land around X by Day 90 — <tier>".
      if (typeof vitana.projected_day_90 === 'number' && vitana.projected_day_90_tier) {
        lines.push(`- Day-90 projection (linear from 7-day trend): ~${vitana.projected_day_90} (${vitana.projected_day_90_tier} tier). Mirror the trajectory card on /autopilot — use phrase "at this pace you land around X by Day 90".`);
      }

      if (vitana.last_movement) {
        const m = vitana.last_movement;
        const sign = m.delta > 0 ? '+' : '';
        const reason = m.reason ? ` from "${m.reason}"` : '';
        lines.push(`- Last movement: ${sign}${m.delta} ${formatPillarName(m.pillar)}${reason}.`);
      }

      if (vitana.model_version) {
        lines.push(`- Model: ${vitana.model_version}${typeof vitana.confidence === 'number' ? `, confidence ${vitana.confidence.toFixed(2)}` : ''}.`);
      }

      // BOOTSTRAP-TEACH-BEFORE-REDIRECT: NEW USER detection. A user whose
      // Index is mostly baseline-only (no completion sub-scores yet, low
      // confidence, baseline-survey-v2 model) is a first-timer who needs
      // fuller explanations. Voice's intent classifier reads this hint
      // and biases TEACH-ONLY / TEACH-THEN-NAV toward the longest steps.
      const isBaselineOnlyModel = typeof vitana.model_version === 'string'
        && vitana.model_version.includes('baseline-survey');
      const lowConfidence = typeof vitana.confidence === 'number' && vitana.confidence < 0.5;
      const noCompletionsYet = Object.values(vitana.subscores).every(s => !s || s.completions === 0);
      if (isBaselineOnlyModel || (lowConfidence && noCompletionsYet)) {
        lines.push('- User profile maturity: NEW USER (no completions yet, baseline-only score). When the user asks teach-intent questions, default to the FULLEST explanation + step list. Offer onboarding pointers warmly.');
      }

      // G3: Life Compass — when set, surface the goal so voice can align
      // suggestions toward it. When missing, invite the user to set one.
      if (vitana.life_compass) {
        lines.push(`- Active goal: "${vitana.life_compass.primary_goal}" (category: ${vitana.life_compass.category}). Frame every suggestion through this goal. If user wants to change direction: say "open my goals" → Life Compass overlay opens.`);
      } else {
        lines.push('- Active goal: NOT SET. Gently suggest the user open their Life Compass and pick a direction so Vitana can bias recommendations.');
      }
    } else if (vitanaResult.state === 'no_score_baseline_exists') {
      lines.push('- Vitana Index status: SETUP INCOMPLETE. The 5-pillar baseline survey was submitted, but the score did not compute (earlier compute RPC error). The user needs to retry — the Health screen should re-prompt the baseline modal. Do NOT fabricate an Index number.');
    } else if (vitanaResult.state === 'not_set_up') {
      lines.push('- Vitana Index status: NOT SET UP YET. The user has not completed the 5-question baseline survey (Nutrition / Hydration / Exercise / Sleep / Mental). Direct them to the Health screen — that survey is the only way the Index gets its first value. Do NOT fabricate an Index number.');
    }
  }

  const healthActivities = activities.filter(a => a.activity_type.startsWith('health.'));
  if (healthActivities.length) {
    const uploads = healthActivities.filter(a => a.activity_type.includes('upload') || a.activity_type.includes('connect')).length;
    const supplements = healthActivities.filter(a => a.activity_type.startsWith('health.supplement.add')).length;
    if (uploads) lines.push(`- ${uploads} health data upload${uploads === 1 ? '' : 's'} in the last 14 days.`);
    if (supplements) lines.push(`- Added ${supplements} supplement${supplements === 1 ? '' : 's'} recently.`);
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

// VTID-03037: account/tenure section. Rendered at the TOP of the profile so
// the LLM reads it before activity data. Emits "" when createdAt is missing
// (anonymous, fetch failed, or a row without created_at) so the rest of the
// summary degrades gracefully.
//
// Phrasing rationale:
//   - "Joined the Vitana community on ${YYYY-MM-DD}" is the canonical
//     anchor — date is unambiguous regardless of timezone.
//   - "Tenure: ${N} days" is the literal answer to "how long have I been a
//     member?". Phrasing chosen to align with Vertex's brain-path
//     `Tenure: ${stage} (registered ${N} days ago …)` so the LLM treats
//     them as the same fact when both blocks are present.
//   - Tenure cap at 0 handles the rare clock-drift case where created_at
//     parses to a future timestamp.
//
// Exported for unit testing — pure function, no side effects.
export function buildAccountSection(account: AccountRow, nowMs: number): string {
  if (!account.createdAt) return '';
  const ts = account.createdAt.getTime();
  if (!Number.isFinite(ts)) return '';
  const days = Math.max(0, Math.floor((nowMs - ts) / 86_400_000));
  const dateIso = account.createdAt.toISOString().slice(0, 10);
  return [
    '[ACCOUNT]',
    `- Joined the Vitana community on ${dateIso}.`,
    `- Tenure: ${days} day${days === 1 ? '' : 's'} as a community member.`,
  ].join('\n');
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

  // BOOTSTRAP-AWARENESS-REGISTRY: load admin config (60s cache) so each
  // section can be turned off / tuned globally without a redeploy.
  const cfg = await getAwarenessConfig().catch(() => null);

  // Effective window: registry param overrides opts.windowDays.
  const effectiveWindowDays = cfg
    ? Number(cfg.getParam('activity.recent.enabled', 'window_days', windowDays)) || windowDays
    : windowDays;
  const sinceIso = new Date(now - effectiveWindowDays * 24 * 60 * 60 * 1000).toISOString();

  const fetchActivitiesIfWanted = (cfg && (
    !cfg.isEnabled('activity.summary.enabled') &&
    !cfg.isEnabled('activity.recent.enabled') &&
    !cfg.isEnabled('content.music.enabled') &&
    !cfg.isEnabled('health.enabled')))
    ? Promise.resolve([] as ActivityRow[])
    : fetchActivityLog(client, userId, sinceIso);

  const fetchRoutinesIfWanted = (cfg && !cfg.isEnabled('routines.enabled'))
    ? Promise.resolve([] as RoutineRow[])
    : fetchRoutines(client, userId);

  const fetchPrefsIfWanted = (cfg && !cfg.isEnabled('preferences.explicit.enabled') && !cfg.isEnabled('preferences.inferred.enabled'))
    ? Promise.resolve([] as PreferenceRow[])
    : fetchPreferences(client, userId);

  const fetchVitanaIfWanted = (cfg && !cfg.isEnabled('health.enabled'))
    ? Promise.resolve(null)
    : fetchVitanaIndex(client, userId);

  const fetchFactsIfWanted = (cfg && !cfg.isEnabled('memory.facts.enabled')) || !opts.tenantId
    ? Promise.resolve({ ok: true, facts: [] as any[] })
    : getCurrentFacts({ tenant_id: opts.tenantId, user_id: userId });

  // VTID-03037: account/tenure fetch. Always in the batch — no awareness-
  // registry gate yet; the section itself self-skips when created_at is
  // missing. The query is cheap (single-row lookup on a PK) and adds no
  // measurable latency because it parallelizes with the existing five.
  const fetchAccountPromise = fetchAppUsersAccount(client, userId);

  const [activities, routines, prefs, vitana, factsResult, account] = await Promise.all([
    fetchActivitiesIfWanted,
    fetchRoutinesIfWanted,
    fetchPrefsIfWanted,
    fetchVitanaIfWanted,
    fetchFactsIfWanted,
    fetchAccountPromise,
  ]);

  const sections = [
    // VTID-03037: account/tenure goes FIRST so the LLM reads "joined on
    // YYYY-MM-DD, tenure N days" before activity data. Mirrors the brain
    // path's USER AWARENESS positioning (tenure line at top of awareness
    // block) so both pipelines agree on the high-signal placement.
    buildAccountSection(account, now),
    (!cfg || cfg.isEnabled('activity.summary.enabled')) ? buildActivitySummarySection(activities) : '',
    (!cfg || cfg.isEnabled('routines.enabled'))         ? buildRoutinesSection(routines, activities) : '',
    (!cfg || cfg.isEnabled('preferences.explicit.enabled') || cfg.isEnabled('preferences.inferred.enabled'))
      ? buildPreferencesSection(prefs) : '',
    (!cfg || cfg.isEnabled('health.enabled'))           ? buildHealthSection(activities, vitana) : '',
    (!cfg || cfg.isEnabled('content.music.enabled'))    ? buildContentSection(activities) : '',
    (!cfg || cfg.isEnabled('memory.facts.enabled'))     ? buildFactsSection(factsResult.ok ? factsResult.facts : []) : '',
    (!cfg || cfg.isEnabled('activity.recent.enabled'))  ? buildRecentSection(activities) : '',
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
