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
