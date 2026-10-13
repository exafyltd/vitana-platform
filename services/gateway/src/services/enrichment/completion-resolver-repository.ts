/**
 * VTID-05143 (builds VTID-05085 Phase 1) — data-access seam for the Unified
 * Card System completion resolver. One function per source table, every read
 * scoped to the caller's own user_id. Client-agnostic (takes `supabase` as a
 * param), same convention as guide/dismissal-tool-repository.ts.
 *
 * Sections:
 *   - Enrichment completion sources (E1–E11), Phase 1.
 *   - Dismissal state (`user_enrichment_cards`), Phase 1.
 *   - Boost trigger sources (G1–G3), Phase 3: the profile-progress fields,
 *     unseen live `daily_matches`, recent `diary_entries` days. Read-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const CALENDAR_APP_IDS = ['google-calendar', 'outlook-calendar', 'apple-calendar'] as const;
export const SOCIAL_PROVIDERS = ['instagram', 'facebook'] as const;

// ==================== Enrichment completion sources ====================

/** E1 avatar_url, E2 bio, E4 interests, E5 location, E11 cover_url or universal_intent_cover_url. */
export async function fetchProfileEnrichmentFields(sb: SupabaseClient, userId: string) {
  return sb
    .from('profiles')
    .select('avatar_url, bio, location, cover_url, universal_intent_cover_url, interests')
    .eq('user_id', userId)
    .maybeSingle();
}

/** E3 — any post by the member. */
export async function fetchAnyProfilePost(sb: SupabaseClient, userId: string) {
  return sb.from('profile_posts').select('id').eq('user_id', userId).limit(1);
}

/** E6/E7 — active Instagram/Facebook connections (no `status` column exists). */
export async function fetchActiveSocialConnections(sb: SupabaseClient, userId: string) {
  return sb
    .from('social_connections')
    .select('provider')
    .eq('user_id', userId)
    .in('provider', [...SOCIAL_PROVIDERS])
    .eq('is_active', true)
    .is('disconnected_at', null);
}

/** E8 — any enabled calendar app. */
export async function fetchEnabledCalendarApp(sb: SupabaseClient, userId: string) {
  return sb
    .from('connected_app_settings')
    .select('app_id')
    .eq('user_id', userId)
    .in('app_id', [...CALENDAR_APP_IDS])
    .eq('enabled', true)
    .limit(1);
}

/** E9 — any imported contact. */
export async function fetchAnyContact(sb: SupabaseClient, userId: string) {
  return sb.from('contacts').select('id').eq('user_id', userId).limit(1);
}

/** E10 — an FCM token that is not revoked. */
export async function fetchActiveDeviceToken(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_device_tokens')
    .select('id')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .not('fcm_token', 'is', null)
    .limit(1);
}

// ==================== Dismissal state ====================

export async function fetchEnrichmentCardStates(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_enrichment_cards')
    .select('card_type, dismissed_at, cooldown_days')
    .eq('user_id', userId);
}

/** Upsert the caller's own dismissal; cooldown_days keeps its stored/default value. */
export async function upsertEnrichmentCardDismissal(
  sb: SupabaseClient,
  userId: string,
  cardType: string,
  nowIso: string,
) {
  return sb
    .from('user_enrichment_cards')
    .upsert(
      { user_id: userId, card_type: cardType, dismissed_at: nowIso, updated_at: nowIso },
      { onConflict: 'user_id,card_type' },
    )
    .select('card_type, dismissed_at, cooldown_days')
    .single();
}

// ==================== Boost trigger sources (Phase 3) ====================

/**
 * G1 — every field vitana-v1 `useProfileProgress.ts` weighs: identity
 * (display_name + handle), avatar, bio, location, links, cover (cover_url or
 * the cover library's universal_intent_cover_url, as E11), languages, service
 * offerings (`profiles.service_offerings.offers`).
 */
export async function fetchProfileProgressFields(sb: SupabaseClient, userId: string) {
  return sb
    .from('profiles')
    .select('display_name, handle, avatar_url, bio, location, links, cover_url, universal_intent_cover_url, languages, service_offerings')
    .eq('user_id', userId)
    .maybeSingle();
}

/**
 * G2 — the caller's unseen live matches: the same rows the Matches page
 * (`/me/matches`, vitana-v1 useRealMatches) lists — not expired, no action
 * taken — that the member has not seen yet (`viewed_at` is set by
 * useMarkMatchesViewed when the cards are on screen). Count only.
 * (The plan named `match_notifications`; that table does not exist.)
 */
export async function countUnseenLiveMatches(sb: SupabaseClient, userId: string, nowIso: string) {
  return sb
    .from('daily_matches')
    .select('matched_user_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gt('expires_at', nowIso)
    .is('action', null)
    .is('viewed_at', null);
}

/** G3 — look-back for the diary streak (UTC days, same as the user_diary_streak view). */
export const DIARY_STREAK_LOOKBACK_DAYS = 120;
export const DIARY_STREAK_ROW_LIMIT = 2000;

/** G3 — the caller's diary entry timestamps since `sinceIso`, newest first. */
export async function fetchRecentDiaryEntryTimes(sb: SupabaseClient, userId: string, sinceIso: string) {
  return sb
    .from('diary_entries')
    .select('created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(DIARY_STREAK_ROW_LIMIT);
}
