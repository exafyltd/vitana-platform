/**
 * VTID-05101 — member signals for the Phase 3 moments, read once per page of
 * members (never one query per member):
 *
 *   user_guided_journey_state  → guided_journey_step (F1)
 *   diary_entries              → diary_nudge (F3), feature_tip coverage
 *   user_active_days           → feature_tip (F8), invite_friend (F7)
 *   companion_messages_ledger  → feature tips already used (anti-repeat)
 *
 * A signal source that fails is reported in `unavailable` and simply leaves
 * that signal absent: the moment that needs it does not fire, the member
 * still gets the rest (worst case the morning greeting). Reads only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import * as repo from './companion-repository';
import { FEATURE_TIP_ANTI_REPEAT, SIGNAL_LOOKBACK_DAYS, type JourneySignal, type MemberContext } from './moments';
import { computeCompletions, type EnrichmentFacts } from '../enrichment/completion-resolver';
import { ENRICHMENT_CARD_TYPES, type EnrichmentCardType, type EnrichmentDismissRow } from '../enrichment/card-catalog';

const DAY_MS = 86_400_000;

export interface RawMemberSignals {
  journey?: repo.JourneyStateRow | null;
  lastDiaryDate?: string | null;
  activeDays?: number | null;
}

export interface SignalsResult {
  by: Map<string, RawMemberSignals>;
  unavailable: string[];
}

export type FetchSignals = (sb: SupabaseClient, ids: string[], now: Date) => Promise<SignalsResult>;

export const fetchMemberSignals: FetchSignals = async (sb, ids, now) => {
  const by = new Map<string, RawMemberSignals>(ids.map((id) => [id, {}]));
  const unavailable: string[] = [];
  const since = new Date(now.getTime() - SIGNAL_LOOKBACK_DAYS * DAY_MS);
  const sinceIso = since.toISOString();
  const sinceDate = sinceIso.slice(0, 10);

  const [journeys, diary, active] = await Promise.allSettled([
    repo.fetchJourneyStates(sb, ids),
    repo.fetchDiaryEntriesSince(sb, ids, sinceIso),
    repo.fetchActiveDaysSince(sb, ids, sinceDate),
  ]);

  if (journeys.status === 'fulfilled') {
    for (const id of ids) by.get(id)!.journey = null;
    for (const j of journeys.value) { const s = by.get(j.user_id); if (s) s.journey = j; }
  } else unavailable.push('journey');

  if (diary.status === 'fulfilled') {
    for (const id of ids) by.get(id)!.lastDiaryDate = null;
    for (const d of diary.value) {
      const s = by.get(d.user_id);
      const day = String(d.created_at ?? '').slice(0, 10);
      if (s && day && (!s.lastDiaryDate || s.lastDiaryDate < day)) s.lastDiaryDate = day;
    }
  } else unavailable.push('diary');

  if (active.status === 'fulfilled') {
    const days = new Map<string, Set<string>>();
    for (const a of active.value) {
      if (!days.has(a.user_id)) days.set(a.user_id, new Set());
      days.get(a.user_id)!.add(String(a.active_date));
    }
    for (const id of ids) by.get(id)!.activeDays = days.get(id)?.size ?? 0;
  } else unavailable.push('active_days');

  return { by, unavailable };
};

// ── VTID-05367 (messenger-vitana-cards-v2): bulk enrichment completion + dismissal ──

export interface EnrichmentCompletions {
  /** Per member: E1–E11 completion. ALWAYS all 11 keys (false-initialized) so
   *  eligibleEnrichmentCards' `=== false` test treats a member with no source
   *  row as incomplete/eligible, never as unknown/absent. */
  completions: Map<string, Map<EnrichmentCardType, boolean>>;
  /** Per member: `user_enrichment_cards` dismissal rows (for the 7-day cooldown). */
  dismissals: Map<string, EnrichmentDismissRow[]>;
  unavailable: string[];
}

export type FetchEnrichmentCompletions =
  (sb: SupabaseClient, ids: string[]) => Promise<EnrichmentCompletions>;

/** All E1–E11 false — the base every member starts from (R1-F3: never absent). */
function allIncomplete(): Map<EnrichmentCardType, boolean> {
  return new Map(ENRICHMENT_CARD_TYPES.map((t) => [t, false]));
}

/**
 * Bulk completion + dismissal for a page of members. Mirrors
 * `fetchMemberSignals`: every source read is in `Promise.allSettled`, a failed
 * source is named in `unavailable` and leaves its facts at the default — it
 * NEVER throws, so one bad query cannot abort the tick's `Promise.all`.
 * Reuses the pure `computeCompletions` so the rules match the HTTP route.
 */
export const fetchEnrichmentCompletions: FetchEnrichmentCompletions = async (sb, ids) => {
  const unavailable: string[] = [];
  // Per-member raw facts, seeded so a member with no rows is fully incomplete.
  const facts = new Map<string, EnrichmentFacts>(
    ids.map((id) => [id, {
      profile: null,
      hasPost: false,
      activeSocialProviders: [],
      hasEnabledCalendar: false,
      hasContact: false,
      hasActiveDeviceToken: false,
    }]),
  );
  const dismissals = new Map<string, EnrichmentDismissRow[]>(ids.map((id) => [id, []]));

  const [profiles, posts, social, calendar, contacts, tokens, dismissRows] = await Promise.allSettled([
    repo.fetchProfileEnrichmentFieldsBulk(sb, ids),
    repo.fetchMembersWithAnyPost(sb, ids),
    repo.fetchActiveSocialConnectionsBulk(sb, ids),
    repo.fetchMembersWithEnabledCalendar(sb, ids),
    repo.fetchMembersWithAnyContact(sb, ids),
    repo.fetchMembersWithActiveDeviceToken(sb, ids),
    repo.fetchEnrichmentDismissalsBulk(sb, ids),
  ]);

  if (profiles.status === 'fulfilled') {
    for (const r of profiles.value) {
      const f = facts.get(r.user_id);
      if (f) f.profile = {
        avatar_url: r.avatar_url, bio: r.bio, location: r.location,
        cover_url: r.cover_url, universal_intent_cover_url: r.universal_intent_cover_url, interests: r.interests,
      };
    }
  } else unavailable.push('enrichment_profiles');

  if (posts.status === 'fulfilled') {
    for (const r of posts.value) { const f = facts.get(r.user_id); if (f) f.hasPost = true; }
  } else unavailable.push('enrichment_posts');

  if (social.status === 'fulfilled') {
    for (const r of social.value) { const f = facts.get(r.user_id); if (f) f.activeSocialProviders.push(r.provider); }
  } else unavailable.push('enrichment_social');

  if (calendar.status === 'fulfilled') {
    for (const r of calendar.value) { const f = facts.get(r.user_id); if (f) f.hasEnabledCalendar = true; }
  } else unavailable.push('enrichment_calendar');

  if (contacts.status === 'fulfilled') {
    for (const r of contacts.value) { const f = facts.get(r.user_id); if (f) f.hasContact = true; }
  } else unavailable.push('enrichment_contacts');

  if (tokens.status === 'fulfilled') {
    for (const r of tokens.value) { const f = facts.get(r.user_id); if (f) f.hasActiveDeviceToken = true; }
  } else unavailable.push('enrichment_device_tokens');

  if (dismissRows.status === 'fulfilled') {
    for (const r of dismissRows.value) {
      dismissals.get(r.user_id)?.push({ card_type: r.card_type, dismissed_at: r.dismissed_at, cooldown_days: r.cooldown_days });
    }
  } else unavailable.push('enrichment_dismissals');

  // R2-F2: a failed source means we do NOT know what the member has done (or
  // dismissed). Offering a card on unknown state could tell a member to add a
  // photo they already have, so on ANY failure no member gets enrichment state
  // this tick: empty maps → eligibleEnrichmentCards (=== false) offers nothing,
  // the tick continues with the other moments, and the sources are reported.
  if (unavailable.length > 0) {
    return { completions: new Map(), dismissals: new Map(), unavailable };
  }

  const completions = new Map<string, Map<EnrichmentCardType, boolean>>();
  for (const id of ids) {
    const f = facts.get(id);
    completions.set(id, f ? computeCompletions(f) : allIncomplete());
  }

  return { completions, dismissals, unavailable };
};

/** The MemberContext fields a member's raw signals and ledger rows give the moments. */
export function memberSignals(
  raw: RawMemberSignals | undefined,
  ledgerRows: repo.LedgerRow[],
  localDate: string,
): Pick<MemberContext, 'journey' | 'diaryLastEntryDate' | 'activeDays' | 'recentFeatureTips'> {
  let journey: JourneySignal | null | undefined;
  if (raw?.journey) {
    const j = raw.journey;
    const listen = j.metadata?.daily_listen as { date?: unknown; sessions?: unknown } | undefined;
    const doneToday = listen?.date === localDate && Array.isArray(listen.sessions) && listen.sessions.length > 0;
    journey = {
      mode: j.mode,
      onboardingStatus: j.onboarding_status,
      currentSession: Number(j.current_session),
      doneToday,
      lastOpenedTopicId: j.last_opened_topic_id ?? null,
      completedPracticeCount: Number(j.completed_practice_count ?? 0),
      qualificationThreshold: Number(j.qualification_threshold ?? 0),
    };
  } else if (raw && raw.journey === null) {
    journey = null;
  }

  const recentFeatureTips = ledgerRows
    .filter((r) => r.moment_key === 'feature_tip' && typeof r.facts?.tip_key === 'string')
    .sort((a, b) => (a.local_date < b.local_date ? 1 : a.local_date > b.local_date ? -1 : 0))
    .map((r) => r.facts!.tip_key as string)
    .slice(0, FEATURE_TIP_ANTI_REPEAT);

  return {
    journey,
    diaryLastEntryDate: raw?.lastDiaryDate,
    activeDays: raw?.activeDays,
    recentFeatureTips,
  };
}
