/**
 * VTID-04892 — the onboarding coach tick (slice 1: SHADOW ONLY).
 *
 * For every cohort member it decides the single next best step and whether
 * Vitana would reach out today, and records that in onboarding_coach_state
 * and onboarding_coach_decisions. It sends nothing: no push, no in-app
 * notification, no chat message, no post, no pacer touch, no milestone.
 *
 * Guards (plan v3 §4.2): never on staging; feature flag + rollout date;
 * test/service accounts are excluded with the STRICT lookup — if that lookup
 * fails the whole tick is skipped ("could not tell" never means "not excluded").
 */
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchExcludedTestServiceAccountIdsStrict } from '../../lib/excluded-test-service-accounts';
import { emitOasisEvent } from '../oasis-event-service';
import * as repo from './coach-repository';
import { resolveCoachConfig, type CoachConfig } from './config';
import { decide, inCohort, localDate, type CoachStage, type Decision } from './ladder';

const VTID = 'VTID-04892';
const DAY_MS = 86_400_000;

export interface TickResult {
  ok: boolean;
  mode: CoachConfig['mode'];
  reason: string;
  tick_id?: string;
  cohort?: number;
  excluded?: number;
  would_touch?: number;
  skipped?: Record<string, number>;
  stage_changes?: number;
  error?: string;
}

export interface TickDeps {
  sb: SupabaseClient;
  now?: Date;
  config?: CoachConfig;
  emit?: typeof emitOasisEvent;
}

export async function runCoachTick(deps: TickDeps): Promise<TickResult> {
  const config = deps.config ?? resolveCoachConfig();
  if (config.mode !== 'shadow' || !config.rolloutDate) {
    return { ok: true, mode: config.mode, reason: config.reason };
  }
  const now = deps.now ?? new Date();
  const emit = deps.emit ?? emitOasisEvent;
  const sb = deps.sb;

  const excluded = await fetchExcludedTestServiceAccountIdsStrict(sb);
  if (!excluded.ok) {
    return { ok: false, mode: config.mode, reason: 'exclusion_unavailable', error: excluded.error };
  }

  // Cohort: joined on/after rollout − 30 days, still inside 90 days.
  const since = new Date(Math.max(config.rolloutDate.getTime() - 30 * DAY_MS, now.getTime() - 90 * DAY_MS));
  const candidates = await repo.fetchCohortCandidates(sb, since.toISOString());
  const members = candidates.filter((c) =>
    !excluded.ids.has(c.user_id) && inCohort(new Date(c.created_at), config.rolloutDate as Date, now));
  const excludedCount = candidates.length - members.length;

  const tickId = randomUUID();
  const ids = members.map((m) => m.user_id);
  const skipped: Record<string, number> = {};
  let wouldTouch = 0;
  let stageChanges = 0;

  if (ids.length > 0) {
    const [zones, milestones, journeys, states] = await Promise.all([
      repo.fetchTimezones(sb, ids),
      repo.fetchAchievedMilestones(sb, ids),
      repo.fetchJourneyStates(sb, ids),
      repo.fetchCoachStates(sb, ids),
    ]);
    const tzBy = new Map(zones.map((z) => [z.user_id, z.timezone]));
    const achievedBy = new Map<string, Set<string>>();
    for (const m of milestones) {
      if (!achievedBy.has(m.user_id)) achievedBy.set(m.user_id, new Set());
      achievedBy.get(m.user_id)!.add(m.source_ref);
    }
    const journeyBy = new Map(journeys.map((j) => [j.user_id, j.metadata ?? {}]));
    const stateBy = new Map(states.map((s) => [s.user_id, s]));

    const localDayBy = new Map(ids.map((id) => [id, localDate(now, tzBy.get(id))]));
    const earliestDay = [...localDayBy.values()].sort()[0];
    const touches = await repo.fetchRecentTouches(sb, ids, earliestDay);
    const touched = new Set(touches.map((t) => `${t.user_id}|${t.local_day}`));

    const stateRows: Parameters<typeof repo.upsertCoachStates>[1] = [];
    const decisionRows: repo.DecisionRow[] = [];
    const changes: Array<{ user_id: string; from: CoachStage; to: CoachStage }> = [];

    for (const m of members) {
      const day = localDayBy.get(m.user_id) as string;
      const meta = journeyBy.get(m.user_id) ?? {};
      const reminder = meta.audiobook_reminder;
      const listen = meta.daily_listen;
      const state = stateBy.get(m.user_id);

      const d: Decision = decide({
        joinedAt: new Date(m.created_at),
        localDay: day,
        stageOverride: state?.pilot_stage_override ?? null,
        optedOutAt: state?.opted_out_at ? new Date(state.opted_out_at) : null,
        snoozedUntil: state?.snoozed_until ? new Date(state.snoozed_until) : null,
        ignoredStreak: state?.ignored_streak ?? 0,
        lastTouchAt: state?.last_touch_at ? new Date(state.last_touch_at) : null,
        achieved: achievedBy.get(m.user_id) ?? new Set(),
        audiobook: {
          reminderSet: !!reminder && typeof reminder === 'object',
          reminderLastSentLocalDate: reminder?.last_sent_local_date ?? null,
          listenedToday: listen?.date === day,
          everListened: !!listen?.date,
        },
        touchedToday: touched.has(`${m.user_id}|${day}`),
      }, now);

      if (d.decision === 'would_touch') wouldTouch++;
      else skipped[d.reason] = (skipped[d.reason] ?? 0) + 1;
      if (state && state.stage !== d.stage) changes.push({ user_id: m.user_id, from: state.stage, to: d.stage });

      stateRows.push({
        user_id: m.user_id, tenant_id: m.tenant_id, joined_at: m.created_at,
        stage: d.stage, next_action_key: d.actionKey,
      });
      decisionRows.push({
        user_id: m.user_id, tenant_id: m.tenant_id, local_day: day, mode: 'shadow',
        stage: d.stage, action_key: d.actionKey, decision: d.decision, reason: d.reason, tick_id: tickId,
      });
    }

    await repo.upsertCoachStates(sb, stateRows);
    await repo.upsertDecisions(sb, decisionRows);

    // A member's real stage change is a state transition (OASIS rule); the
    // first time a member is seen is not a change.
    stageChanges = changes.length;
    for (const c of changes) {
      await emit({
        vtid: VTID, type: 'onboarding.coach.stage_changed', source: 'onboarding-coach', status: 'info',
        message: `onboarding stage ${c.from} → ${c.to}`,
        payload: { user_id: c.user_id, from: c.from, to: c.to, mode: 'shadow', tick_id: tickId },
        actor_role: 'system', surface: 'system',
      }).catch(() => undefined);
    }
  }

  const result: TickResult = {
    ok: true, mode: config.mode, reason: config.reason, tick_id: tickId,
    cohort: members.length, excluded: excludedCount, would_touch: wouldTouch, skipped, stage_changes: stageChanges,
  };
  // One aggregate event per tick (plan §4.8, sparring N6) — never one per member.
  await emit({
    vtid: VTID, type: 'onboarding.coach.tick_completed', source: 'onboarding-coach', status: 'success',
    message: `onboarding coach (${config.mode}): ${members.length} members, ${wouldTouch} would be touched`,
    payload: { ...result },
    actor_role: 'system', surface: 'system',
  }).catch(() => undefined);
  return result;
}
