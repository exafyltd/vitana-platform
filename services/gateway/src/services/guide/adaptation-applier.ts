/**
 * Companion Phase E — D43 Adaptation Plan Applier (VTID-01935)
 *
 * Reads APPROVED rows from `adaptation_plans` (written by the existing
 * D43 longitudinal-adaptation-engine when it detects user-state drift)
 * and translates them into per-user `user_journey_overrides` rows that
 * journey-calendar-mapper consumes on next recompute.
 *
 * STATUS — DATA DEPENDENCY:
 * The existing d43-longitudinal-adaptation-engine.ts detects drift and is
 * intended to write `adaptation_plans` for human approval, but no
 * `adaptation_plans` table currently exists in supabase/migrations and
 * grep finds no INSERT into such a table from D43. This applier is the
 * receiving half of a loop whose sender hasn't been wired up yet.
 *
 * What this module ships:
 *   - applyApprovedPlans(userId): reads adaptation_plans (gracefully returns
 *     {applied: 0, reason: 'no_plans_table'} if missing) and writes
 *     user_journey_overrides rows
 *   - getAdaptationStatus(userId): for awareness — returns { pending, applied }
 *
 * When D43 starts persisting plans (separate VTID), this module is already
 * wired and just needs the table to exist. Until then, awareness.adaptation_plans
 * stays null and the brain has nothing to reference.
 */

import { getSupabase } from '../../lib/supabase';
import { emitGuideTelemetry } from './guide-telemetry';

const LOG_PREFIX = '[Guide:adaptation-applier]';

export interface AdaptationStatus {
  pending_plans: number;
  applied_plans: number;
  last_applied_at: string | null;
}

export interface ApplyResult {
  applied: number;
  reason?: 'success' | 'no_plans_table' | 'no_pending_plans' | 'storage_unavailable' | string;
  details?: string[];
}

/**
 * Read approved (or auto-applicable) D43 adaptation plans and translate each
 * into a user_journey_overrides row. Idempotent — re-running on the same
 * approved plan does not double-apply.
 *
 * Returns a structured result so a caller can decide whether to surface the
 * applied changes to the user ("I noticed you haven't been doing X — I've
 * shifted your journey to favor Y instead").
 */
export async function applyApprovedPlans(userId: string): Promise<ApplyResult> {
  const supabase = getSupabase();
  if (!supabase) return { applied: 0, reason: 'storage_unavailable' };

  // Try to read approved plans. If the table doesn't exist, supabase returns
  // an error like "relation 'adaptation_plans' does not exist" — handle gracefully.
  const { data: plans, error } = await supabase
    .from('adaptation_plans')
    .select('id, user_id, plan_type, plan_payload, approved_at, applied_at')
    .eq('user_id', userId)
    .not('approved_at', 'is', null)
    .is('applied_at', null)
    .limit(20);

  if (error) {
    if (
      String(error.message || '').toLowerCase().includes('relation') &&
      String(error.message || '').toLowerCase().includes('does not exist')
    ) {
      return { applied: 0, reason: 'no_plans_table' };
    }
    console.warn(`${LOG_PREFIX} read adaptation_plans failed:`, error.message);
    return { applied: 0, reason: error.message };
  }

  if (!plans || plans.length === 0) {
    return { applied: 0, reason: 'no_pending_plans' };
  }

  let appliedCount = 0;
  const detailLines: string[] = [];
  for (const plan of plans as Array<{
    id: string;
    user_id: string;
    plan_type: string;
    plan_payload: any;
    approved_at: string;
    applied_at: string | null;
  }>) {
    try {
      // Translate plan_payload into journey_overrides shape. Plan shape isn't
      // fully nailed down (D43 doesn't write yet), so we accept any jsonb and
      // pass it through under an 'adaptation' key. journey-calendar-mapper
      // will need to interpret it (out of scope here).
      const waveId = plan.plan_payload?.wave_id || `adaptation_${plan.plan_type}`;

      const { error: upsertErr } = await supabase.from('user_journey_overrides').upsert(
        {
          user_id: plan.user_id,
          wave_id: waveId,
          overrides: { adaptation: plan.plan_payload, plan_id: plan.id },
          source: 'd43_adaptation',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,wave_id' },
      );

      if (upsertErr) {
        console.warn(`${LOG_PREFIX} override upsert failed for plan ${plan.id}:`, upsertErr.message);
        continue;
      }

      // Mark plan as applied
      await supabase
        .from('adaptation_plans')
        .update({ applied_at: new Date().toISOString() })
        .eq('id', plan.id);

      appliedCount += 1;
      detailLines.push(`applied plan_type=${plan.plan_type} → wave_id=${waveId}`);
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} apply error:`, err?.message);
    }
  }

  if (appliedCount > 0) {
    emitGuideTelemetry('guide.adaptation.applied', {
      user_id: userId,
      applied_count: appliedCount,
      details: detailLines.slice(0, 5),
    }).catch(() => {});
    console.log(`${LOG_PREFIX} applied ${appliedCount} plans for user ${userId.substring(0, 8)}`);
  }

  return { applied: appliedCount, reason: 'success', details: detailLines };
}

/**
 * Best-effort awareness signal — counts pending vs applied D43 plans.
 * Returns null counts when the table doesn't exist (no D43 plan-writer wired yet).
 */
export async function getAdaptationStatus(userId: string): Promise<AdaptationStatus | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  // Pending (approved but not applied)
  const pendingRes = await supabase
    .from('adaptation_plans')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .not('approved_at', 'is', null)
    .is('applied_at', null);

  if (pendingRes.error) {
    if (
      String(pendingRes.error.message || '').toLowerCase().includes('relation') &&
      String(pendingRes.error.message || '').toLowerCase().includes('does not exist')
    ) {
      return null;
    }
  }

  // Applied (most recent)
  const appliedRes = await supabase
    .from('adaptation_plans')
    .select('id, applied_at', { count: 'exact' })
    .eq('user_id', userId)
    .not('applied_at', 'is', null)
    .order('applied_at', { ascending: false })
    .limit(1);

  return {
    pending_plans: pendingRes.count ?? 0,
    applied_plans: appliedRes.count ?? 0,
    last_applied_at: appliedRes.data?.[0]?.applied_at ?? null,
  };
}
