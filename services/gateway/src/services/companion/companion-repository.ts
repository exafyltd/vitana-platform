/**
 * VTID-05099 — companion messages data access. Reads member signals
 * (memberships, profiles, preferences, the ledger, today's onboarding touch)
 * and writes the ledger ONLY through claim_companion_message /
 * finish_companion_message / mark_companion_replied.
 *
 * VTID-05100 adds: the member's own preferences row (read / upsert, keyed by
 * the verified user id), the staff audience lookup, and the Vitana DM insert
 * used by delivery.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const CHUNK = 200;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function inChunks<R>(
  ids: string[],
  run: (part: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<R[]> {
  const out: R[] = [];
  for (const part of chunks(ids)) {
    const { data, error } = await run(part);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...((data ?? []) as R[]));
  }
  return out;
}

export interface MemberRow { user_id: string; tenant_id: string }

/** Every primary membership, paged (REST caps a select at ~1000). */
export async function fetchMembers(sb: SupabaseClient): Promise<MemberRow[]> {
  const out: MemberRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('user_tenants')
      .select('user_id, tenant_id')
      .eq('is_primary', true)
      .order('user_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`user_tenants: ${error.message}`);
    out.push(...((data ?? []) as MemberRow[]));
    if (!data || data.length < 1000) return out;
  }
}

export interface ProfileRow { user_id: string; first_name: string | null; timezone: string | null }

export function fetchProfiles(sb: SupabaseClient, ids: string[]) {
  return inChunks<ProfileRow>(
    ids, (p) => sb.from('profiles').select('user_id, first_name, timezone').in('user_id', p), 'profiles');
}

export interface PreferenceRow {
  user_id: string;
  enabled: boolean;
  topic_health: boolean;
  topic_community: boolean;
  topic_business: boolean;
}

export function fetchPreferences(sb: SupabaseClient, ids: string[]) {
  return inChunks<PreferenceRow>(
    ids,
    (p) => sb.from('companion_preferences')
      .select('user_id, enabled, topic_health, topic_community, topic_business').in('user_id', p),
    'companion_preferences');
}

/**
 * VTID-05101: reads that return many rows per member (a row per day, an entry
 * per diary write) page through PostgREST's ~1000-row cap per id chunk, so a
 * busy page is never silently truncated. One query per page of 1000 rows —
 * never one per member.
 */
async function inChunksPaged<R>(
  ids: string[],
  run: (part: string[], from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
  chunk = 50,
): Promise<R[]> {
  const out: R[] = [];
  for (const part of chunks(ids, chunk)) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await run(part, from, from + 999);
      if (error) throw new Error(`${label}: ${error.message}`);
      const rows = (data ?? []) as R[];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
  }
  return out;
}

export interface LedgerRow {
  user_id: string;
  local_date: string;
  mode: string;
  moment_key: string;
  /** VTID-05101 back-off: only `sent` rows count; a reply resets. */
  status?: string | null;
  replied_at?: string | null;
  facts?: Record<string, unknown> | null;
}

export function fetchRecentLedger(sb: SupabaseClient, ids: string[], sinceDate: string) {
  return inChunksPaged<LedgerRow>(
    ids,
    (p, from, to) => sb.from('companion_messages_ledger')
      .select('user_id, local_date, mode, moment_key, status, replied_at, facts')
      .gte('local_date', sinceDate).in('user_id', p)
      .order('user_id', { ascending: true }).order('local_date', { ascending: false }).order('mode', { ascending: true })
      .range(from, to),
    'companion_ledger');
}

// ── VTID-05101: member signals for the Phase 3 moments ───────────────────────

export interface JourneyStateRow {
  user_id: string;
  mode: 'guided' | 'full';
  onboarding_status: string;
  current_session: number;
  completed_practice_count: number;
  qualification_threshold: number;
  last_opened_topic_id: string | null;
  metadata: Record<string, any> | null;
}

/** Guided Journey state (VTID-03276), one row per member. */
export function fetchJourneyStates(sb: SupabaseClient, ids: string[]) {
  return inChunks<JourneyStateRow>(
    ids,
    (p) => sb.from('user_guided_journey_state')
      .select('user_id, mode, onboarding_status, current_session, completed_practice_count, qualification_threshold, last_opened_topic_id, metadata')
      .in('user_id', p),
    'journey_state');
}

/** The app's Daily Diary (`diary_entries`: user_id, created_at, no tenant column) since a UTC instant. */
export function fetchDiaryEntriesSince(sb: SupabaseClient, ids: string[], sinceIso: string) {
  return inChunksPaged<{ user_id: string; created_at: string }>(
    ids,
    (p, from, to) => sb.from('diary_entries')
      .select('user_id, created_at').gte('created_at', sinceIso).in('user_id', p)
      .order('user_id', { ascending: true }).order('created_at', { ascending: false })
      .range(from, to),
    'diary_entries');
}

/** Distinct active usage days (`user_active_days`, one row per user per UTC date). */
export function fetchActiveDaysSince(sb: SupabaseClient, ids: string[], sinceDate: string) {
  return inChunksPaged<{ user_id: string; active_date: string }>(
    ids,
    (p, from, to) => sb.from('user_active_days')
      .select('user_id, active_date').gte('active_date', sinceDate).in('user_id', p)
      .order('user_id', { ascending: true }).order('active_date', { ascending: false })
      .range(from, to),
    'user_active_days',
    30);
}

// ── VTID-05367 (messenger-vitana-cards-v2): bulk enrichment completion + dismissal ──
// Per-member reads in enrichment/completion-resolver-repository.ts are one
// query per member; the companion tick needs them per PAGE of members, so these
// mirror fetchJourneyStates / fetchActiveDaysSince (one IN-clause per source
// table). The compute stays in enrichment/completion-resolver.ts
// (computeCompletions) and card-catalog.ts (eligibleEnrichmentCards) — these
// functions only read.

/** E1/E2/E4/E5/E11 — profile enrichment fields, one row per member (missing row = absent). */
export function fetchProfileEnrichmentFieldsBulk(sb: SupabaseClient, ids: string[]) {
  return inChunks<{
    user_id: string;
    avatar_url: string | null;
    bio: string | null;
    location: string | null;
    cover_url: string | null;
    universal_intent_cover_url: string | null;
    interests: string[] | null;
  }>(
    ids,
    (p) => sb.from('profiles')
      .select('user_id, avatar_url, bio, location, cover_url, universal_intent_cover_url, interests').in('user_id', p),
    'enrichment_profiles');
}

/** E3 — members with at least one post (distinct user_ids). */
export function fetchMembersWithAnyPost(sb: SupabaseClient, ids: string[]) {
  return inChunksPaged<{ user_id: string }>(
    ids,
    (p, from, to) => sb.from('profile_posts').select('user_id').in('user_id', p)
      .order('user_id', { ascending: true }).range(from, to),
    'enrichment_posts');
}

/** E6/E7 — active Instagram/Facebook connections (is_active, not disconnected). */
export function fetchActiveSocialConnectionsBulk(sb: SupabaseClient, ids: string[]) {
  return inChunks<{ user_id: string; provider: string }>(
    ids,
    (p) => sb.from('social_connections').select('user_id, provider')
      .in('user_id', p).in('provider', ['instagram', 'facebook']).eq('is_active', true).is('disconnected_at', null),
    'enrichment_social');
}

/** E8 — members with an enabled calendar app. */
export function fetchMembersWithEnabledCalendar(sb: SupabaseClient, ids: string[]) {
  return inChunks<{ user_id: string }>(
    ids,
    (p) => sb.from('connected_app_settings').select('user_id')
      .in('user_id', p).in('app_id', ['google-calendar', 'outlook-calendar', 'apple-calendar']).eq('enabled', true),
    'enrichment_calendar');
}

/** E9 — members with at least one imported contact. */
export function fetchMembersWithAnyContact(sb: SupabaseClient, ids: string[]) {
  return inChunksPaged<{ user_id: string }>(
    ids,
    (p, from, to) => sb.from('contacts').select('user_id').in('user_id', p)
      .order('user_id', { ascending: true }).range(from, to),
    'enrichment_contacts');
}

/** E10 — members with a live FCM token (not revoked). */
export function fetchMembersWithActiveDeviceToken(sb: SupabaseClient, ids: string[]) {
  return inChunks<{ user_id: string }>(
    ids,
    (p) => sb.from('user_device_tokens').select('user_id')
      .in('user_id', p).is('revoked_at', null).not('fcm_token', 'is', null),
    'enrichment_device_tokens');
}

/** `user_enrichment_cards` dismissal rows for the page (one query per chunk). */
export function fetchEnrichmentDismissalsBulk(sb: SupabaseClient, ids: string[]) {
  return inChunks<{ user_id: string; card_type: string; dismissed_at: string | null; cooldown_days: number | null }>(
    ids,
    (p) => sb.from('user_enrichment_cards').select('user_id, card_type, dismissed_at, cooldown_days').in('user_id', p),
    'enrichment_dismissals');
}

/** Onboarding coach touches already SENT (VTID-04892) — one Vitana touch a day, whoever sends it. */
export function fetchOnboardingTouches(sb: SupabaseClient, ids: string[], sinceDate: string) {
  return inChunks<{ user_id: string; local_day: string }>(
    ids,
    (p) => sb.from('onboarding_touch_ledger')
      .select('user_id, local_day').eq('status', 'sent').gte('local_day', sinceDate).in('user_id', p),
    'onboarding_touch_ledger');
}

/** Full compositions already spent today (UTC day) by shadow mode (sparring F5 cap). */
export async function countShadowComposedSince(sb: SupabaseClient, sinceIso: string): Promise<number> {
  const { count, error } = await sb
    .from('companion_messages_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('mode', 'shadow')
    .not('composed_text', 'is', null)
    .gte('created_at', sinceIso);
  if (error) throw new Error(`companion_ledger count: ${error.message}`);
  return count ?? 0;
}

export interface ClaimArgs {
  user_id: string;
  tenant_id: string;
  local_date: string;
  mode: 'shadow' | 'staff' | 'live';
  sender: 'companion' | 'proactive_match';
  moment_key: string;
  card_type: string | null;
  facts: Record<string, unknown>;
}

export type ClaimResult =
  | { ok: true; claimed: true; id: number }
  | { ok: true; claimed: false; reason: string }
  | { ok: false; error: string };

export async function claimMessage(sb: SupabaseClient, a: ClaimArgs): Promise<ClaimResult> {
  const { data, error } = await sb.rpc('claim_companion_message', {
    p_user_id: a.user_id,
    p_tenant_id: a.tenant_id,
    p_local_date: a.local_date,
    p_mode: a.mode,
    p_sender: a.sender,
    p_moment_key: a.moment_key,
    p_card_type: a.card_type,
    p_facts: a.facts,
  });
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: 'empty_rpc_result' }) as ClaimResult;
}

export async function finishMessage(
  sb: SupabaseClient,
  id: number,
  status: 'sent' | 'failed' | 'shadow',
  composedText: string | null,
  composedByModel: string | null,
  chatMessageId: string | null = null,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await sb.rpc('finish_companion_message', {
    p_id: id,
    p_status: status,
    p_composed_text: composedText,
    p_composed_by_model: composedByModel,
    p_chat_message_id: chatMessageId,
  });
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: 'empty_rpc_result' }) as { ok: boolean; error?: string };
}

// ── VTID-05100 ──────────────────────────────────────────────────────────────

/** Owner decision D2: no row = enabled, health + community on, business off. */
export const DEFAULT_PREFERENCES = Object.freeze({
  enabled: true,
  topic_health: true,
  topic_community: true,
  topic_business: false,
});

export type CompanionPreferences = { -readonly [K in keyof typeof DEFAULT_PREFERENCES]: boolean };
export type CompanionPreferencesPatch = Partial<CompanionPreferences>;

/** One member's preferences (defaults when they never saved any). */
export async function getMemberPreferences(sb: SupabaseClient, userId: string): Promise<CompanionPreferences> {
  const { data, error } = await sb
    .from('companion_preferences')
    .select('enabled, topic_health, topic_community, topic_business')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`companion_preferences: ${error.message}`);
  const row = (data ?? {}) as Partial<CompanionPreferences>;
  return {
    enabled: row.enabled ?? DEFAULT_PREFERENCES.enabled,
    topic_health: row.topic_health ?? DEFAULT_PREFERENCES.topic_health,
    topic_community: row.topic_community ?? DEFAULT_PREFERENCES.topic_community,
    topic_business: row.topic_business ?? DEFAULT_PREFERENCES.topic_business,
  };
}

/** Merge a patch onto the member's current preferences and save the full row. */
export async function saveMemberPreferences(
  sb: SupabaseClient,
  userId: string,
  tenantId: string | null,
  patch: CompanionPreferencesPatch,
): Promise<CompanionPreferences> {
  const current = await getMemberPreferences(sb, userId);
  const next: CompanionPreferences = { ...current, ...patch };
  const { error } = await sb.from('companion_preferences').upsert(
    { user_id: userId, ...(tenantId ? { tenant_id: tenantId } : {}), ...next, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(`companion_preferences upsert: ${error.message}`);
  return next;
}

/** Roles that make a member part of the staff audience (COMPANION_MODE=staff). */
export const STAFF_ROLES = ['staff', 'admin'] as const;

/**
 * Members (of the given ids) holding a staff/admin role in their own tenant
 * (user_permitted_roles — the table check_role_permitted() reads).
 */
export async function fetchStaffMemberIds(
  sb: SupabaseClient,
  members: Array<{ user_id: string; tenant_id: string }>,
): Promise<Set<string>> {
  const tenantBy = new Map(members.map((m) => [m.user_id, m.tenant_id]));
  const rows = await inChunks<{ user_id: string; tenant_id: string; role: string }>(
    members.map((m) => m.user_id),
    (p) => sb.from('user_permitted_roles').select('user_id, tenant_id, role').in('role', [...STAFF_ROLES]).in('user_id', p),
    'user_permitted_roles',
  );
  return new Set(rows.filter((r) => tenantBy.get(r.user_id) === r.tenant_id).map((r) => r.user_id));
}

export interface CompanionChatMessageRow {
  tenant_id: string;
  sender_id: string;
  receiver_id: string;
  content: string;
  message_type: 'text';
  /** Persisted as chat_messages.metadata; the client reads it as content_data. */
  metadata: Record<string, unknown>;
}

/** Insert Vitana's DM; returns the new chat_messages id. */
export async function insertCompanionChatMessage(
  sb: SupabaseClient,
  row: CompanionChatMessageRow,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await sb.from('chat_messages').insert(row).select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: ((data as { id?: string } | null)?.id) ?? null, error: null };
}

/** The member replied to Vitana: mark their latest unreplied real send (sparring F3). */
export async function markCompanionReplied(sb: SupabaseClient, userId: string): Promise<{ ok: boolean; marked?: boolean; error?: string }> {
  const { data, error } = await sb.rpc('mark_companion_replied', { p_user_id: userId });
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: 'empty_rpc_result' }) as { ok: boolean; marked?: boolean; error?: string };
}

/**
 * Fire-and-forget form for the reply path: never throws, never rejects,
 * never delays the caller (the Vitana reply must not depend on the ledger).
 */
export function markCompanionRepliedInBackground(sb: SupabaseClient, userId: string): void {
  try {
    Promise.resolve(markCompanionReplied(sb, userId))
      .then((r) => { if (!r.ok) console.warn(`[companion] mark_companion_replied failed: ${r.error}`); })
      .catch((err: any) => console.warn(`[companion] mark_companion_replied failed: ${err?.message ?? err}`));
  } catch (err: any) {
    console.warn(`[companion] mark_companion_replied failed: ${err?.message ?? err}`);
  }
}
