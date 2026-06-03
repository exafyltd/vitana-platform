/**
 * R7 (BOOTSTRAP-ORB-R6R7-PROVIDERS) — Goal-completion-inquiry provider.
 *
 * Fires when the user's ACTIVE Life Compass goal has reached its target
 * date (`life_compass.target_date` in the past). Wins priority 92 — above
 * new-day-return (90), Teacher (85) and voice-wake-brief (80), below the
 * first-time-welcome (95). When it fires, Vitana celebrates the user
 * hitting their target and invites the next goal (or a pause).
 *
 * Trigger contract (plan §2.2 — "plan_phase=goal_completed", R7):
 *   active life_compass row exists AND target_date is in the past
 *   (compared at END-OF-DAY UTC so a same-day deadline isn't prematurely
 *   declared "missed" earlier that day).
 *
 * One-time per goal: after firing, the candidate carries a dedupeKey keyed
 * on the life_compass row id, and the side-effect path (R7) moves the old
 * goal to is_active=false / activates a new one through the existing Life
 * Compass setup flow ON CONFIRMATION. This provider does NOT mutate the
 * goal itself — selection stays a pure read + the deactivation happens on
 * the confirmed handoff (controller wiring, see TODO below) so an
 * unanswered inquiry doesn't silently retire the user's goal.
 *
 * NOT triggered:
 *   - No active goal / no target_date / target_date still in the future.
 *   - Anonymous sessions (no user_id).
 *   - Sessions with no supabase client.
 *
 * Autopilot goal-met signal: the plan also allows an Autopilot rule to
 * signal goal-met independent of the date. That branch is deferred — this
 * slice implements the deterministic past-target-date path only; the
 * Autopilot signal will OR in once its rule surface lands.
 *
 * Past-date check: implemented inline as an end-of-day-UTC comparison.
 * TODO(R6/R7 wiring): replace `isTargetDateInPastEndOfDayUtc` with the
 * canonical `resolveJourneyPlanPhase` / `isTargetDateInPast` from
 * `awareness-unified-context.ts` once that lands on main — keep the
 * semantics identical (end-of-day UTC) so behavior does not drift.
 *
 * Transport-agnostic: the ranker is shared by Vertex
 * (live-session-controller) and LiveKit (orb-livekit), so both transports
 * get the inquiry once registered. No transport-specific code here.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ContinuationDecisionContext,
  ContinuationProvider,
  ProviderResult,
  AssistantContinuation,
} from '../../types';
import { renderGoalCompletionLine } from './content';

export const GOAL_COMPLETION_PROVIDER_KEY = 'goal_completion_inquiry' as const;
export const GOAL_COMPLETION_EXTRA_KEY = 'goalCompletionInquiry' as const;

/** Above new-day-return (90), below first-time-welcome (95). A goal that
 *  just completed is a bigger turn-1 moment than the routine daily
 *  catch-up, but never out-ranks a brand-new user's onboarding. */
export const GOAL_COMPLETION_PRIORITY = 92;

export interface GoalCompletionInputs {
  supabase: SupabaseClient;
  userId: string;
  tenantId: string;
  lang: string;
  firstName: string | null;
}

export interface GoalCompletionProviderOptions {
  newId?: () => string;
  now?: () => number;
  priority?: number;
}

interface LifeCompassRow {
  id: string;
  primary_goal: string | null;
  target_date: string | null;
  is_active: boolean;
}

/**
 * End-of-day-UTC past check. A target_date is "in the past" only once the
 * ENTIRE calendar day (UTC) of that date has elapsed — so a goal due today
 * is not prematurely declared complete at 00:01.
 *
 * Accepts a YYYY-MM-DD date string OR a full ISO timestamp; both are
 * normalized to the end of their UTC calendar day (23:59:59.999Z).
 * Returns false for null / unparseable input (fail-closed: no inquiry).
 *
 * TODO(R6/R7 wiring): swap for the canonical `isTargetDateInPast` from
 * awareness-unified-context.ts once it lands — identical end-of-day-UTC
 * semantics.
 */
export function isTargetDateInPastEndOfDayUtc(
  targetDate: string | null,
  now: Date,
): boolean {
  if (!targetDate) return false;
  // Take the date portion (YYYY-MM-DD) regardless of whether a time was
  // supplied, then anchor to the very end of that UTC day.
  const datePart = targetDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return false;
  const endOfDayUtcMs = Date.parse(`${datePart}T23:59:59.999Z`);
  if (!Number.isFinite(endOfDayUtcMs)) return false;
  return now.getTime() > endOfDayUtcMs;
}

function readInputs(ctx: ContinuationDecisionContext): GoalCompletionInputs | null {
  const extra = ctx.extra;
  if (!extra || typeof extra !== 'object') return null;
  const raw = (extra as Record<string, unknown>)[GOAL_COMPLETION_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.userId !== 'string' || o.userId.length === 0) return null;
  if (typeof o.tenantId !== 'string' || o.tenantId.length === 0) return null;
  if (!o.supabase) return null;
  return {
    supabase: o.supabase as SupabaseClient,
    userId: o.userId,
    tenantId: o.tenantId,
    lang: typeof o.lang === 'string' && o.lang.length > 0 ? o.lang : 'en',
    firstName:
      typeof o.firstName === 'string' && o.firstName.length > 0 ? o.firstName : null,
  };
}

export function makeGoalCompletionInquiryProvider(
  opts: GoalCompletionProviderOptions = {},
): ContinuationProvider {
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? GOAL_COMPLETION_PRIORITY;

  return {
    key: GOAL_COMPLETION_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = now();
      const inputs = readInputs(ctx);
      if (!inputs) {
        return {
          providerKey: GOAL_COMPLETION_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_goal_completion_inputs',
        };
      }

      // ---- DB fetch: active life_compass row ----
      let row: LifeCompassRow | null = null;
      try {
        const { data, error } = await inputs.supabase
          .from('life_compass')
          .select('id, primary_goal, target_date, is_active')
          .eq('user_id', inputs.userId)
          .eq('is_active', true)
          .maybeSingle();
        if (error) {
          return {
            providerKey: GOAL_COMPLETION_PROVIDER_KEY,
            status: 'errored',
            latencyMs: Math.max(0, now() - t0),
            reason: `life_compass_fetch_failed: ${error.message}`,
          };
        }
        row = (data ?? null) as LifeCompassRow | null;
      } catch (err) {
        return {
          providerKey: GOAL_COMPLETION_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      // No active goal → nothing to celebrate. Let other providers win.
      if (!row) {
        return {
          providerKey: GOAL_COMPLETION_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_active_life_compass',
        };
      }

      // No target_date → can't determine completion by date. Suppress.
      if (!row.target_date) {
        return {
          providerKey: GOAL_COMPLETION_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_target_date',
        };
      }

      // Target date still in the future (or today, not yet elapsed). The
      // goal isn't complete yet — let new-day-return anchor on it instead.
      const nowDate = new Date(now());
      if (!isTargetDateInPastEndOfDayUtc(row.target_date, nowDate)) {
        return {
          providerKey: GOAL_COMPLETION_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: `target_date_not_past_${row.target_date}`,
        };
      }

      const line = renderGoalCompletionLine({
        lang: inputs.lang,
        firstName: inputs.firstName,
        goalText: row.primary_goal,
      });
      if (!line || line.trim().length === 0) {
        return {
          providerKey: GOAL_COMPLETION_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: 'renderer_produced_empty_line',
        };
      }

      const candidate: AssistantContinuation = {
        id: `goal-completion-inquiry-${newId()}`,
        surface: 'orb_wake',
        kind: 'check_in',
        priority,
        userFacingLine: line,
        // On confirmation ("yes, let's set the next one") the assistant
        // routes through the existing Life Compass setup flow, where the
        // old goal moves to is_active=false and the new goal becomes
        // active. We do NOT deactivate here — an unanswered inquiry must
        // not silently retire the user's goal.
        // TODO(R6/R7 wiring): the controller should, on confirmed handoff,
        // call the Life Compass setup flow + deactivate row.id.
        cta: {
          type: 'navigate',
          route: '/life-compass',
          payload: { intent: 'next_goal', completed_life_compass_id: row.id },
        },
        evidence: [
          { kind: 'goal_completed', detail: `life_compass_id=${row.id}` },
          { kind: 'target_date_past', detail: row.target_date },
        ],
        // One inquiry per completed goal. Keyed on the row id so a NEW
        // active goal (different id) can fire its own inquiry later.
        dedupeKey: `goal-completion-inquiry:${row.id}`,
        privacyMode: 'safe_to_speak',
      };

      return {
        providerKey: GOAL_COMPLETION_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}
