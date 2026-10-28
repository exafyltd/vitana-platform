/**
 * VTID-05143 (builds VTID-05085 Phase 1) — Unified Card System completion
 * resolver. Completion is derived from the source tables only (plan F12: no
 * completed_at column, no POST /complete). All reads run in parallel
 * (Promise.all) through completion-resolver-repository.ts.
 *
 * | Card | Source                 | Done when                                             |
 * |------|------------------------|-------------------------------------------------------|
 * | E1   | profiles.avatar_url    | non-empty                                             |
 * | E2   | profiles.bio           | trimmed length > 50                                   |
 * | E3   | profile_posts          | any row                                               |
 * | E4   | profiles.interests     | non-empty array                                       |
 * | E5   | profiles.location      | non-empty                                             |
 * | E6   | social_connections     | instagram, is_active = true, disconnected_at IS NULL  |
 * | E7   | social_connections     | facebook, same                                        |
 * | E8   | connected_app_settings | google/outlook/apple-calendar enabled                 |
 * | E9   | contacts               | any row                                               |
 * | E10  | user_device_tokens     | revoked_at IS NULL AND fcm_token IS NOT NULL          |
 * | E11  | profiles.cover_url or universal_intent_cover_url | either non-empty (the cover library writes the latter) |
 *
 * Boost triggers (Phase 3, plan §2C / §6.5), resolved by `resolveBoostTriggers`
 * in the same parallel batch:
 *
 * | Card | Source                         | Fires when                                         |
 * |------|--------------------------------|----------------------------------------------------|
 * | G1   | profiles (useProfileProgress)  | weighted profile completion < 80 %                 |
 * | G2   | daily_matches                  | ≥ 1 live match the member has not seen yet         |
 * | G3   | diary_entries (UTC days)       | no entry yesterday or today AND the streak ending  |
 * |      |                                | the day before yesterday is > 3 days               |
 *
 * Any read error throws EnrichmentDataError — the route answers 500, never an
 * empty list.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import * as repo from './completion-resolver-repository';
import {
  ENRICHMENT_CARD_TYPES,
  PROFILE_COMPLETION_BOOST_THRESHOLD,
  STREAK_AT_RISK_MIN_EXCLUSIVE,
  type BoostCardType,
  type BoostTrigger,
  type EnrichmentCardType,
  type EnrichmentDismissRow,
} from './card-catalog';

export class EnrichmentDataError extends Error {
  constructor(public readonly source: string, message: string) {
    super(`[enrichment] ${source}: ${message}`);
    this.name = 'EnrichmentDataError';
  }
}

/** Raw facts the completion rules read — the repository's output, normalised. */
export interface EnrichmentFacts {
  profile: {
    avatar_url?: string | null;
    bio?: string | null;
    location?: string | null;
    cover_url?: string | null;
    universal_intent_cover_url?: string | null;
    interests?: string[] | null;
  } | null;
  hasPost: boolean;
  activeSocialProviders: string[];
  hasEnabledCalendar: boolean;
  hasContact: boolean;
  hasActiveDeviceToken: boolean;
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/** Pure: E1–E11 completion from the facts. */
export function computeCompletions(facts: EnrichmentFacts): Map<EnrichmentCardType, boolean> {
  const p = facts.profile ?? {};
  const bio = typeof p.bio === 'string' ? p.bio.trim() : '';
  const interests = Array.isArray(p.interests) ? p.interests.filter(nonEmpty) : [];
  const social = new Set(facts.activeSocialProviders);
  const done: Record<EnrichmentCardType, boolean> = {
    E1: nonEmpty(p.avatar_url),
    E2: bio.length > 50,
    E3: facts.hasPost,
    E4: interests.length > 0,
    E5: nonEmpty(p.location),
    E6: social.has('instagram'),
    E7: social.has('facebook'),
    E8: facts.hasEnabledCalendar,
    E9: facts.hasContact,
    E10: facts.hasActiveDeviceToken,
    E11: nonEmpty(p.cover_url) || nonEmpty(p.universal_intent_cover_url),
  };
  return new Map(ENRICHMENT_CARD_TYPES.map((t) => [t, done[t]]));
}

type RepoResult = { data: unknown; error: { message?: string } | null };

function unwrap<T>(source: string, result: RepoResult): T {
  if (result.error) throw new EnrichmentDataError(source, result.error.message || 'query failed');
  return result.data as T;
}

const hasRows = (data: unknown): boolean => Array.isArray(data) && data.length > 0;

export interface EnrichmentCardState {
  completions: Map<EnrichmentCardType, boolean>;
  /** G1–G3: whether each trigger fired, with the number the card shows. */
  boosts: Map<BoostCardType, BoostTrigger>;
  dismissals: EnrichmentDismissRow[];
}

// ==================== Boost triggers (pure) ====================

/** The `profiles` fields vitana-v1 `useProfileProgress.ts` weighs. */
export interface ProfileProgressFields {
  display_name?: string | null;
  handle?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  location?: string | null;
  links?: unknown;
  cover_url?: string | null;
  universal_intent_cover_url?: string | null;
  languages?: unknown;
  service_offerings?: unknown;
}

const nonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/**
 * Same sections and weights as vitana-v1 `src/hooks/useProfileProgress.ts`
 * (identity 20, avatar 15, about 20, location 10, links 10, cover 15,
 * languages 5, services 5 — sums to 100). Read from the stored row, so a
 * placeholder the UI shows for an empty field never counts.
 */
export const PROFILE_PROGRESS_SECTIONS: ReadonlyArray<{
  id: string;
  weight: number;
  done: (p: ProfileProgressFields) => boolean;
}> = [
  { id: 'identity', weight: 20, done: (p) => nonEmpty(p.display_name) && nonEmpty(p.handle) },
  { id: 'avatar', weight: 15, done: (p) => nonEmpty(p.avatar_url) },
  // Same rule as E2 (trimmed bio longer than 50 characters).
  { id: 'about', weight: 20, done: (p) => typeof p.bio === 'string' && p.bio.trim().length > 50 },
  { id: 'location', weight: 10, done: (p) => nonEmpty(p.location) },
  { id: 'links', weight: 10, done: (p) => nonEmptyArray(p.links) },
  // Same rule as E11: the cover library writes universal_intent_cover_url.
  { id: 'cover', weight: 15, done: (p) => nonEmpty(p.cover_url) || nonEmpty(p.universal_intent_cover_url) },
  { id: 'languages', weight: 5, done: (p) => Array.isArray(p.languages) && p.languages.some(nonEmpty) },
  {
    id: 'services',
    weight: 5,
    done: (p) => {
      const so = p.service_offerings as { offers?: unknown } | null | undefined;
      return !!so && typeof so === 'object' && nonEmptyArray(so.offers);
    },
  },
];

/** Weighted profile completion 0–100. A member with no profile row is at 0. */
export function computeProfileCompletionPct(profile: ProfileProgressFields | null): number {
  const p = profile ?? {};
  return Math.round(PROFILE_PROGRESS_SECTIONS.reduce((sum, s) => sum + (s.done(p) ? s.weight : 0), 0));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);

/**
 * G3 — UTC calendar days, the same day boundary as the `user_diary_streak`
 * view and diary-missing-relevant.ts. `streak_days` is the length of the run
 * of consecutive entry days ending the day before yesterday; the trigger fires
 * when there is no entry yesterday or today and that run is longer than 3.
 */
export function computeStreakAtRisk(entryTimes: readonly string[], now: Date): { fired: boolean; streak_days: number } {
  const days = new Set<number>();
  for (const t of entryTimes) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) days.add(utcDay(ms));
  }
  const today = utcDay(now.getTime());
  if (days.has(today) || days.has(today - 1)) return { fired: false, streak_days: 0 };
  let streak = 0;
  for (let d = today - 2; days.has(d); d--) streak++;
  return { fired: streak > STREAK_AT_RISK_MIN_EXCLUSIVE, streak_days: streak };
}

/** G1/G2/G3 from their raw facts. Pure. */
export function computeBoostTriggers(facts: {
  profile: ProfileProgressFields | null;
  unseenMatchCount: number;
  diaryEntryTimes: readonly string[];
  now: Date;
}): Map<BoostCardType, BoostTrigger> {
  const pct = computeProfileCompletionPct(facts.profile);
  const count = Math.max(0, Math.trunc(facts.unseenMatchCount || 0));
  const streak = computeStreakAtRisk(facts.diaryEntryTimes, facts.now);
  return new Map<BoostCardType, BoostTrigger>([
    ['G1', { card_type: 'G1', fired: pct < PROFILE_COMPLETION_BOOST_THRESHOLD, data: { completion_pct: pct } }],
    ['G2', { card_type: 'G2', fired: count > 0, data: { unread_match_count: count } }],
    ['G3', { card_type: 'G3', fired: streak.fired, data: { streak_days: streak.streak_days } }],
  ]);
}

/**
 * G1 profile progress, G2 unseen matches, G3 streak at risk — three
 * caller-scoped reads in parallel. Throws EnrichmentDataError on any read error.
 */
export async function resolveBoostTriggers(
  sb: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<Map<BoostCardType, BoostTrigger>> {
  const sinceIso = new Date((utcDay(now.getTime()) - repo.DIARY_STREAK_LOOKBACK_DAYS) * DAY_MS).toISOString();
  const [profile, matches, diary] = await Promise.all([
    repo.fetchProfileProgressFields(sb, userId),
    repo.countUnseenLiveMatches(sb, userId, now.toISOString()),
    repo.fetchRecentDiaryEntryTimes(sb, userId, sinceIso),
  ]);
  const profileRow = unwrap<ProfileProgressFields | null>('profiles.profile_progress', profile as RepoResult);
  const matchResult = matches as RepoResult & { count?: number | null };
  unwrap('daily_matches', matchResult);
  const diaryRows = unwrap<Array<{ created_at: string }> | null>('diary_entries', diary as RepoResult) ?? [];
  return computeBoostTriggers({
    profile: profileRow ?? null,
    unseenMatchCount: Number(matchResult.count ?? 0),
    diaryEntryTimes: diaryRows.map((r) => r.created_at),
    now,
  });
}

/** Every read for one member, in parallel. Throws EnrichmentDataError on any read error. */
export async function loadEnrichmentCardState(
  sb: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<EnrichmentCardState> {
  const [profile, posts, social, calendar, contacts, tokens, states, boosts] = await Promise.all([
    repo.fetchProfileEnrichmentFields(sb, userId),
    repo.fetchAnyProfilePost(sb, userId),
    repo.fetchActiveSocialConnections(sb, userId),
    repo.fetchEnabledCalendarApp(sb, userId),
    repo.fetchAnyContact(sb, userId),
    repo.fetchActiveDeviceToken(sb, userId),
    repo.fetchEnrichmentCardStates(sb, userId),
    resolveBoostTriggers(sb, userId, now),
  ]);

  const facts: EnrichmentFacts = {
    profile: unwrap<EnrichmentFacts['profile']>('profiles', profile as RepoResult),
    hasPost: hasRows(unwrap('profile_posts', posts as RepoResult)),
    activeSocialProviders: (unwrap<Array<{ provider: string }> | null>('social_connections', social as RepoResult) ?? [])
      .map((r) => r.provider),
    hasEnabledCalendar: hasRows(unwrap('connected_app_settings', calendar as RepoResult)),
    hasContact: hasRows(unwrap('contacts', contacts as RepoResult)),
    hasActiveDeviceToken: hasRows(unwrap('user_device_tokens', tokens as RepoResult)),
  };
  const dismissals = unwrap<EnrichmentDismissRow[] | null>('user_enrichment_cards', states as RepoResult) ?? [];

  return { completions: computeCompletions(facts), boosts, dismissals };
}

/** Map<CardType, boolean> for E1–E11 (true = done). */
export async function resolveCompletions(sb: SupabaseClient, userId: string): Promise<Map<EnrichmentCardType, boolean>> {
  return (await loadEnrichmentCardState(sb, userId)).completions;
}
