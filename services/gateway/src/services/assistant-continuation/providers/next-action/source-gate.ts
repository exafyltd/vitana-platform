/**
 * VTID-03067 (B0d-real Xj) — per-source flag gates.
 *
 * Each NextActionSource reads its own `voice.next_action.<key>.enabled`
 * flag from `system_controls` before producing a candidate. When the
 * flag is explicitly disabled, the source returns
 * `skippedReason: 'feature_disabled'` and the composer skips it
 * entirely. Default behavior (flag absent OR flag enabled=true) keeps
 * the source live.
 *
 * Operators can disable any source at runtime by inserting/updating
 * the `system_controls` row — no redeploy needed, takes effect within
 * the 60s cache TTL of `system-controls-service`.
 *
 * Examples (canonical keys for the 10-source registry):
 *
 *   voice.next_action.reminder_due.enabled
 *   voice.next_action.calendar_upcoming.enabled
 *   voice.next_action.autopilot_recommendation.enabled
 *   voice.next_action.continuity_promise_owed.enabled
 *   voice.next_action.diary_missing_relevant.enabled
 *   voice.next_action.continuity_pending_thread.enabled
 *   voice.next_action.life_compass_alignment.enabled
 *   voice.next_action.vitana_index_pillar.enabled
 *   voice.next_action.journey_stage_nudge.enabled    (reserved)
 *   voice.next_action.match_activity_plan.enabled     (reserved — Xj does not
 *                                                       ship this source; key
 *                                                       reserved for parity)
 *
 * The helper NEVER throws — DB failures default to enabled=true so a
 * Supabase outage can't accidentally silence every source.
 */

import { getSystemControl } from '../../../system-controls-service';
import type {
  NextActionSource,
  NextActionSourceKey,
  NextActionSourceResult,
} from './types';

/**
 * Build the canonical flag key for a given source.
 */
export function buildSourceFlagKey(source: NextActionSourceKey): string {
  return `voice.next_action.${source}.enabled`;
}

/**
 * Is this source enabled? Reads the flag from system_controls.
 * Defaults to `true` when:
 *   - the row doesn't exist
 *   - the system-controls service errors
 *   - any other unexpected shape arrives
 *
 * Operators DISABLE a source by inserting a `system_controls` row with
 * `enabled = false`. There is no "kill switch by default" mode —
 * sources are live unless someone explicitly turns them off.
 */
export async function isNextActionSourceEnabled(
  source: NextActionSourceKey,
): Promise<boolean> {
  try {
    const control = await getSystemControl(buildSourceFlagKey(source));
    if (!control) return true; // absent → enabled
    // applyExpiryCheck in system-controls-service handles expires_at
    // by force-flipping enabled=false. We just read the resulting
    // boolean.
    return control.enabled !== false;
  } catch {
    return true; // never silence by default
  }
}

/**
 * Wrap a NextActionSource so its produce() runs only when the flag
 * gate is enabled. When disabled, returns
 * `{ candidate: null, skippedReason: 'feature_disabled' }` immediately.
 *
 * Use in source factories:
 *   export function makeReminderDueSource(): NextActionSource {
 *     return withFlagGate({ key: 'reminder_due', serves: …, produce: … });
 *   }
 *
 * This keeps the gate uniform across sources — every source gets the
 * same opt-out without duplicating the call site.
 */
export function withFlagGate(source: NextActionSource): NextActionSource {
  return {
    key: source.key,
    serves: source.serves,
    async produce(ctx): Promise<NextActionSourceResult> {
      const enabled = await isNextActionSourceEnabled(source.key);
      if (!enabled) {
        return {
          source: source.key,
          candidate: null,
          skippedReason: 'feature_disabled',
        };
      }
      return source.produce(ctx);
    },
  };
}
