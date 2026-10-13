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
 * Any read error throws EnrichmentDataError — the route answers 500, never an
 * empty list. Boost triggers (G1–G3) slot into `resolveBoostTriggers` in
 * Phase 3 (VTID-05087); in Phase 1 it resolves none.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import * as repo from './completion-resolver-repository';
import {
  ENRICHMENT_CARD_TYPES,
  type BoostCardType,
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
  /** Boost triggers that fired (Phase 3). Always empty in Phase 1. */
  boosts: Map<BoostCardType, boolean>;
  dismissals: EnrichmentDismissRow[];
}

/** Phase 3 (VTID-05087) fills this: G1 profile progress, G2 unread matches, G3 streak at risk. */
export async function resolveBoostTriggers(
  _sb: SupabaseClient,
  _userId: string,
): Promise<Map<BoostCardType, boolean>> {
  return new Map();
}

/** Every read for one member, in parallel. Throws EnrichmentDataError on any read error. */
export async function loadEnrichmentCardState(sb: SupabaseClient, userId: string): Promise<EnrichmentCardState> {
  const [profile, posts, social, calendar, contacts, tokens, states, boosts] = await Promise.all([
    repo.fetchProfileEnrichmentFields(sb, userId),
    repo.fetchAnyProfilePost(sb, userId),
    repo.fetchActiveSocialConnections(sb, userId),
    repo.fetchEnabledCalendarApp(sb, userId),
    repo.fetchAnyContact(sb, userId),
    repo.fetchActiveDeviceToken(sb, userId),
    repo.fetchEnrichmentCardStates(sb, userId),
    resolveBoostTriggers(sb, userId),
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
