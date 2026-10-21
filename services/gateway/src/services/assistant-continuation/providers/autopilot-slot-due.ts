/**
 * VTID-04506 (Community Autopilot CA-6): autopilot-slot-due continuation
 * provider.
 *
 * When one of the member's Autopilot calendar slots is due (30 min ago … 15 min
 * ahead), the next ORB wake leads with it and OFFERS to start it. The offer is
 * an ask_permission CTA, so wake-brief-wiring records it as the pending offer
 * and a spoken "yes" runs `start_autopilot_slot` through confirm_pending_action
 * — the model never has to carry the event id across turns.
 *
 * The lead is facts only (the slot's own title and time); the override_v2
 * contract composes the actual words in the member's language (NEVER-rule 41).
 * Priority 93: below unread messages (93.5) and a result that just arrived,
 * above the generic openers.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssistantContinuation, ContinuationDecisionContext, ContinuationProvider, ProviderResult } from '../types';
import { findDueAutopilotSlot } from '../../community-autopilot/slot-due';

export const AUTOPILOT_SLOT_DUE_PROVIDER_KEY = 'autopilot_slot_due' as const;
export const AUTOPILOT_SLOT_DUE_EXTRA_KEY = 'autopilotSlotDue' as const;
export const AUTOPILOT_SLOT_DUE_PRIORITY = 93;

interface Inputs { supabase: SupabaseClient; userId: string }

function readInputs(ctx: ContinuationDecisionContext): Inputs | null {
  const raw = (ctx.extra as Record<string, unknown> | undefined)?.[AUTOPILOT_SLOT_DUE_EXTRA_KEY] as Record<string, unknown> | undefined;
  if (!raw || typeof raw.userId !== 'string' || !raw.userId || !raw.supabase) return null;
  return { supabase: raw.supabase as SupabaseClient, userId: raw.userId };
}

/** Pure: the lead handed to the opener — facts, never a finished sentence to repeat. */
export function renderAutopilotSlotLead(title: string, startIso: string): string {
  const hhmm = new Date(startIso).toISOString().slice(11, 16);
  return `Autopilot slot due (${hhmm} UTC): ${title}. Offer to start it now.`;
}

export function makeAutopilotSlotDueProvider(opts: { now?: () => Date; priority?: number } = {}): ContinuationProvider {
  const now = opts.now ?? (() => new Date());
  const priority = opts.priority ?? AUTOPILOT_SLOT_DUE_PRIORITY;
  return {
    key: AUTOPILOT_SLOT_DUE_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = Date.now();
      const inputs = readInputs(ctx);
      if (!inputs) {
        return { providerKey: AUTOPILOT_SLOT_DUE_PROVIDER_KEY, status: 'skipped', latencyMs: Date.now() - t0, reason: 'no_inputs' };
      }
      let slot;
      try {
        slot = await findDueAutopilotSlot(inputs.supabase, inputs.userId, now());
      } catch (err) {
        return { providerKey: AUTOPILOT_SLOT_DUE_PROVIDER_KEY, status: 'errored', latencyMs: Date.now() - t0, reason: (err as Error).message };
      }
      if (!slot) {
        return { providerKey: AUTOPILOT_SLOT_DUE_PROVIDER_KEY, status: 'suppressed', latencyMs: Date.now() - t0, reason: 'no_due_slot' };
      }
      const candidate: AssistantContinuation = {
        id: `autopilot-slot-due-${slot.eventId}`,
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority,
        userFacingLine: renderAutopilotSlotLead(slot.recommendationTitle || slot.title, slot.startTime),
        cta: {
          type: 'ask_permission',
          onYesTool: 'start_autopilot_slot',
          payload: { event_id: slot.eventId },
        },
        evidence: [{ kind: 'autopilot_slot_due', detail: `event_id=${slot.eventId} recommendation_id=${slot.recommendationId}` }],
        dedupeKey: `autopilot-slot-due:${slot.eventId}`,
        privacyMode: 'safe_to_speak',
      };
      return { providerKey: AUTOPILOT_SLOT_DUE_PROVIDER_KEY, status: 'returned', latencyMs: Date.now() - t0, candidate };
    },
  };
}
