/**
 * VTID-04892 — onboarding coach data access. Reads member signals
 * (memberships, time zones, milestones, Audiobook state, today's touches) and
 * writes ONLY the coach-owned tables: onboarding_coach_state and
 * onboarding_coach_decisions. Nothing here sends or touches another member.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CoachStage } from './ladder';

const CHUNK = 200;

export interface CohortRow {
  user_id: string;
  tenant_id: string;
  created_at: string;
}

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Primary memberships created at or after `sinceIso`, paged (REST caps a select at ~1000). */
export async function fetchCohortCandidates(sb: SupabaseClient, sinceIso: string): Promise<CohortRow[]> {
  const out: CohortRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('user_tenants')
      .select('user_id, tenant_id, created_at')
      .eq('is_primary', true)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`user_tenants: ${error.message}`);
    out.push(...((data ?? []) as CohortRow[]));
    if (!data || data.length < 1000) return out;
  }
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

export function fetchTimezones(sb: SupabaseClient, ids: string[]) {
  return inChunks<{ user_id: string; timezone: string | null }>(
    ids, (p) => sb.from('profiles').select('user_id, timezone').in('user_id', p), 'profiles');
}

export function fetchAchievedMilestones(sb: SupabaseClient, ids: string[]) {
  return inChunks<{ user_id: string; source_ref: string }>(
    ids,
    (p) => sb.from('autopilot_recommendations').select('user_id, source_ref')
      .eq('source_type', 'milestone').eq('status', 'completed').in('user_id', p),
    'milestones');
}

export function fetchJourneyStates(sb: SupabaseClient, ids: string[]) {
  return inChunks<{ user_id: string; metadata: Record<string, any> | null }>(
    ids, (p) => sb.from('user_guided_journey_state').select('user_id, metadata').in('user_id', p), 'journey_state');
}

export interface CoachStateRow {
  user_id: string;
  tenant_id: string;
  joined_at: string;
  stage: CoachStage;
  pilot_stage_override: CoachStage | null;
  next_action_key: string | null;
  last_touch_at: string | null;
  snoozed_until: string | null;
  ignored_streak: number;
  opted_out_at: string | null;
}

export function fetchCoachStates(sb: SupabaseClient, ids: string[]) {
  return inChunks<CoachStateRow>(
    ids,
    (p) => sb.from('onboarding_coach_state')
      .select('user_id, tenant_id, joined_at, stage, pilot_stage_override, next_action_key, last_touch_at, snoozed_until, ignored_streak, opted_out_at')
      .in('user_id', p),
    'coach_state');
}

export function fetchRecentTouches(sb: SupabaseClient, ids: string[], sinceDay: string) {
  return inChunks<{ user_id: string; local_day: string }>(
    ids,
    (p) => sb.from('onboarding_touch_ledger').select('user_id, local_day').gte('local_day', sinceDay).in('user_id', p),
    'touch_ledger');
}

export async function upsertCoachStates(
  sb: SupabaseClient,
  rows: Array<Pick<CoachStateRow, 'user_id' | 'tenant_id' | 'joined_at' | 'stage' | 'next_action_key'>>,
): Promise<void> {
  for (const part of chunks(rows)) {
    const { error } = await sb.from('onboarding_coach_state')
      .upsert(part.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: 'user_id' });
    if (error) throw new Error(`coach_state upsert: ${error.message}`);
  }
}

export interface DecisionRow {
  user_id: string;
  tenant_id: string;
  local_day: string;
  mode: 'shadow';
  stage: CoachStage;
  action_key: string | null;
  decision: 'would_touch' | 'skip';
  reason: string;
  tick_id: string;
}

/** One row per member per local day per mode — a later tick the same day overwrites it. */
export async function upsertDecisions(sb: SupabaseClient, rows: DecisionRow[]): Promise<void> {
  for (const part of chunks(rows)) {
    const { error } = await sb.from('onboarding_coach_decisions')
      .upsert(part.map((r) => ({ ...r, decided_at: new Date().toISOString() })), { onConflict: 'user_id,local_day,mode' });
    if (error) throw new Error(`decisions upsert: ${error.message}`);
  }
}
