/**
 * VTID-03255 — verify-live.
 *
 * The source of truth for whether a foundation step is done is each feature's
 * OWN table, queried live on every request — never the completed_steps_cache.
 * This is the deliberate guard against the schema-drift / stale-flag hazard:
 * the journey can't claim "Diary done" unless a real memory_diary_entries row
 * exists right now.
 *
 * Teacher moments (type: 'teacher') have no feature table — they advance by
 * acknowledgment, recorded in user_journey_foundation.metadata.teacher_ack
 * (written in P3). Until acknowledged they read 'open'.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FoundationStepStatus, JourneyFoundationRow } from './types';
import { FOUNDATION_STEPS } from './foundation-steps';

const CONCRETE_ECONOMIC_INTENTS = new Set([
  'build_business',
  'passive_income',
  'earn_recommendations',
]);

/** Live facts gathered once per request, then mapped to step statuses. */
interface VerificationFacts {
  goalExists: boolean;
  economicIntentSet: boolean;
  economicIntentConcrete: boolean;
  focusPillarSet: boolean;
  reminderRunning: boolean;
  reminderExists: boolean;
  diaryExists: boolean;
  indexBaselineDone: boolean;
  profileComplete: boolean;
  calendarUserEvent: boolean;
  autopilotActivated: boolean;
  connectionActive: boolean;
  teacherAck: Set<string>;
}

async function exists(
  client: SupabaseClient,
  table: string,
  build: (q: any) => any,
): Promise<boolean> {
  try {
    let q = client.from(table).select('user_id', { count: 'exact', head: true });
    q = build(q);
    const { count, error } = await q;
    if (error) return false;
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}

async function gatherFacts(
  client: SupabaseClient,
  userId: string,
  row: JourneyFoundationRow | null,
): Promise<VerificationFacts> {
  const economicIntent = row?.economic_intent ?? null;
  const teacherAckRaw = (row?.metadata?.teacher_ack as unknown) ?? [];
  const teacherAck = new Set<string>(Array.isArray(teacherAckRaw) ? teacherAckRaw : []);

  const [
    goalRow,
    reminderRows,
    diaryExists,
    baselineRow,
    profileRow,
    calendarUserEvent,
    autopilotActivated,
    connectionActive,
  ] = await Promise.all([
    // Active life_compass goal with non-empty text.
    client
      .from('life_compass')
      .select('primary_goal')
      .eq('user_id', userId)
      .eq('is_active', true)
      .not('primary_goal', 'is', null)
      .limit(1)
      .maybeSingle()
      .then((r: any) => r.data ?? null, () => null),
    // Reminders: distinguish "running" from merely "existed".
    client
      .from('reminders')
      .select('status')
      .eq('user_id', userId)
      .limit(50)
      .then(
        (r: any) => (r.data as Array<{ status: string }>) ?? [],
        () => [] as Array<{ status: string }>,
      ),
    exists(client, 'memory_diary_entries', (q) => q.eq('user_id', userId)),
    // Baseline survey complete.
    client
      .from('vitana_index_baseline_survey')
      .select('completed_at')
      .eq('user_id', userId)
      .not('completed_at', 'is', null)
      .limit(1)
      .maybeSingle()
      .then((r: any) => r.data ?? null, () => null),
    // Profile basics.
    client
      .from('profiles')
      .select('full_name, display_name, date_of_birth')
      .eq('user_id', userId)
      .maybeSingle()
      .then((r: any) => r.data ?? null, () => null),
    // A calendar event the user actually created — NOT the 'journey' auto-seed.
    exists(client, 'calendar_events', (q) =>
      q.eq('user_id', userId).neq('source_type', 'journey'),
    ),
    exists(client, 'autopilot_recommendations', (q) =>
      q.eq('user_id', userId).eq('status', 'activated'),
    ),
    exists(client, 'user_connections', (q) =>
      q.eq('user_id', userId).eq('is_active', true),
    ),
  ]);

  const reminderStatuses = (reminderRows as Array<{ status: string }>).map((r) => r.status);
  const profileComplete = Boolean(
    profileRow &&
      (profileRow.full_name || profileRow.display_name) &&
      profileRow.date_of_birth,
  );

  return {
    goalExists: Boolean(goalRow?.primary_goal),
    economicIntentSet: economicIntent != null,
    economicIntentConcrete: economicIntent != null && CONCRETE_ECONOMIC_INTENTS.has(economicIntent),
    focusPillarSet: Boolean(row?.focus_pillar),
    reminderRunning: reminderStatuses.some((s) =>
      ['pending', 'dispatching', 'fired'].includes(s),
    ),
    reminderExists: reminderStatuses.length > 0,
    diaryExists,
    indexBaselineDone: Boolean(baselineRow),
    profileComplete,
    calendarUserEvent,
    autopilotActivated,
    connectionActive,
    teacherAck,
  };
}

function statusFor(key: string, f: VerificationFacts): FoundationStepStatus {
  switch (key) {
    case 'life_compass':
      // The dual-axis gate: BOTH a health goal AND an economic stance.
      return f.goalExists && f.economicIntentSet ? 'done' : 'open';
    case 'weakest_habit':
      return f.focusPillarSet || f.indexBaselineDone ? 'done' : 'open';
    case 'reminder':
      if (f.reminderRunning) return 'active';
      return f.reminderExists ? 'done' : 'open';
    case 'understand_economy':
      return f.teacherAck.has('understand_economy') ? 'done' : 'open';
    case 'profile':
      return f.profileComplete ? 'done' : 'open';
    case 'diary':
      return f.diaryExists ? 'done' : 'open';
    case 'vitana_index':
      return f.indexBaselineDone ? 'done' : 'open';
    case 'economic_aspiration':
      return f.economicIntentConcrete ? 'done' : 'open';
    case 'calendar':
      return f.calendarUserEvent ? 'done' : 'open';
    case 'autopilot':
      if (f.autopilotActivated) return 'active';
      return f.teacherAck.has('autopilot') ? 'done' : 'open';
    case 'connect':
      return f.connectionActive ? 'done' : 'open';
    case 'events':
      // TODO(P4): wire to event participation once the surface lands. Non-required.
      return 'open';
    case 'marketplace':
      // TODO(P4): wire to wallet/marketplace ledger. Non-required.
      return 'open';
    case 'business_live_media':
      return f.teacherAck.has('business_live_media') ? 'done' : 'open';
    default:
      return 'open';
  }
}

/** Verify every step at once → Map<stepKey, status>. */
export async function verifyAllSteps(
  client: SupabaseClient,
  userId: string,
  row: JourneyFoundationRow | null,
): Promise<Map<string, FoundationStepStatus>> {
  const facts = await gatherFacts(client, userId, row);
  const out = new Map<string, FoundationStepStatus>();
  for (const step of FOUNDATION_STEPS) {
    out.set(step.key, statusFor(step.key, facts));
  }
  return out;
}

/** Verify a single step (used by the delta path in P2). */
export async function verifyStep(
  client: SupabaseClient,
  userId: string,
  stepKey: string,
  row: JourneyFoundationRow | null,
): Promise<FoundationStepStatus> {
  const facts = await gatherFacts(client, userId, row);
  return statusFor(stepKey, facts);
}
