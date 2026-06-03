/**
 * VTID-03255 — the snapshot builder.
 *
 * Assembles the one shared JourneyFoundationSnapshot from the thin journey
 * row + live verification + the existing feature tables (life_compass for the
 * goal, profiles for the registration date, journey_session_updates for the
 * "since we last spoke" line). This is what GET /api/v1/journey-foundation
 * returns and what voice/mobile/desktop all consume.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  EconomicIntent,
  JourneyFoundationRow,
  JourneyFoundationSnapshot,
  JourneyGoalView,
  JourneySessionUpdateView,
} from './types';
import { verifyAllSteps } from './journey-foundation-verifier';
import {
  buildStepViews,
  computeNextStep,
  isGraduated,
} from './journey-foundation-next-step';

const DAY_MS = 24 * 60 * 60 * 1000;

const ECONOMY_NORTH_STAR: Record<EconomicIntent, string> = {
  build_business: 'Build a business in the longevity community',
  passive_income: 'Earn passive income here',
  earn_recommendations: 'Earn from recommendations',
  curious: 'Exploring how to earn here',
};

function daysLeftFrom(targetDate: string | null): number | null {
  if (!targetDate) return null;
  const t = new Date(targetDate).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - Date.now()) / DAY_MS));
}

function goalDayFrom(journeyStartedAt: string | null): number | null {
  if (!journeyStartedAt) return null;
  const start = new Date(journeyStartedAt).getTime();
  if (Number.isNaN(start)) return null;
  // The start day is "Tag 1".
  return Math.max(1, Math.floor((Date.now() - start) / DAY_MS) + 1);
}

async function loadRow(
  client: SupabaseClient,
  userId: string,
): Promise<JourneyFoundationRow | null> {
  try {
    const { data } = await client
      .from('user_journey_foundation')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    return (data as JourneyFoundationRow | null) ?? null;
  } catch {
    return null;
  }
}

async function loadGoal(
  client: SupabaseClient,
  userId: string,
): Promise<JourneyGoalView | null> {
  try {
    const { data } = await client
      .from('life_compass')
      .select('primary_goal, category, target_value, target_unit, target_date, starting_value')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    return {
      primary_goal: data.primary_goal ?? null,
      category: data.category ?? null,
      target_value: data.target_value ?? null,
      target_unit: data.target_unit ?? null,
      target_date: data.target_date ?? null,
      starting_value: data.starting_value ?? null,
    };
  } catch {
    return null;
  }
}

async function loadRegistrationDate(
  client: SupabaseClient,
  userId: string,
): Promise<string | null> {
  try {
    const { data } = await client
      .from('profiles')
      .select('created_at')
      .eq('user_id', userId)
      .maybeSingle();
    return (data?.created_at as string | undefined) ?? null;
  } catch {
    return null;
  }
}

async function loadRecentSessionUpdates(
  client: SupabaseClient,
  userId: string,
): Promise<JourneySessionUpdateView[]> {
  try {
    const { data } = await client
      .from('journey_session_updates')
      .select('session_id, completed_steps, next_step, summary, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(3);
    return ((data as JourneySessionUpdateView[] | null) ?? []).map((r) => ({
      session_id: r.session_id ?? null,
      completed_steps: r.completed_steps ?? [],
      next_step: r.next_step ?? null,
      summary: r.summary ?? null,
      created_at: r.created_at,
    }));
  } catch {
    return [];
  }
}

export async function buildJourneyFoundationSnapshot(
  client: SupabaseClient,
  userId: string,
): Promise<JourneyFoundationSnapshot> {
  const row = await loadRow(client, userId);

  const [statuses, goal, registrationDate, recentSessionUpdates] = await Promise.all([
    verifyAllSteps(client, userId, row),
    loadGoal(client, userId),
    loadRegistrationDate(client, userId),
    loadRecentSessionUpdates(client, userId),
  ]);

  const views = buildStepViews(statuses);
  const nextStep = computeNextStep(views);
  const graduated = isGraduated(views);

  // The dual-axis gate: journey "starts" only when a health goal AND an
  // economic stance both exist. journey_started_at is the durable marker, but
  // we also derive it live so the snapshot is correct even before P2 writes it.
  const gateView = views.find((v) => v.key === 'life_compass');
  const journeyStarted =
    Boolean(row?.journey_started_at) ||
    (gateView?.status === 'done' && row?.economic_intent != null);

  // Prefer the durable start marker; fall back to registration date once the
  // gate is passed so the day counter is sensible even pre-P2.
  const effectiveStart = row?.journey_started_at ?? (journeyStarted ? registrationDate : null);

  const economicIntent = row?.economic_intent ?? null;

  return {
    journey_started: journeyStarted,
    goal_day: goalDayFrom(effectiveStart),
    days_left: daysLeftFrom(goal?.target_date ?? null),
    active_goal: goal,
    economic_intent: economicIntent,
    weakest_habit: row?.focus_pillar ?? null,
    foundation_steps: views,
    current_next_step: nextStep,
    suggested_navigation: nextStep?.navigation_route ?? null,
    recent_session_updates: recentSessionUpdates,
    north_stars: {
      health: goal?.primary_goal ?? null,
      economy: economicIntent ? ECONOMY_NORTH_STAR[economicIntent] : null,
    },
    graduated,
  };
}
