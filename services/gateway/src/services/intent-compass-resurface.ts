/**
 * VTID-01976: Compass-change resurface job (P2-C).
 *
 * When a user changes their active Life Compass goal, sweep their last
 * 60 days of intent_matches for rows where compass_aligned=false and
 * recompute the alignment against the new goal. Newly-aligned matches
 * fire `intent_compass_change_resurface` notifications so the user can
 * naturally re-discover relevant intents.
 *
 * Trigger surface: this is exposed as a callable function. A future
 * iteration can subscribe to a `pg_notify('life_compass_changed')`
 * channel; for P2-C, the gateway PATCH /life-compass route (or
 * equivalent surface) calls resurfaceForUser() directly after flipping
 * is_active.
 */

import { createClient } from '@supabase/supabase-js';
import { notifyUserAsync } from './notification-service';
import { compassAlignmentBonus } from './intent-compass-lens';
import { emitOasisEvent } from './oasis-event-service';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

interface ResurfaceArgs {
  user_id: string;
  vitana_id: string | null;
  tenant_id: string;
  new_compass_category: string;
  lookback_days?: number;
}

/**
 * Sweep open matches for the user, find ones where their NEW compass
 * goal aligns with the kind_pairing, and emit a single summary
 * notification ("3 matches now fit your <new goal> focus"). The matches
 * stay in their existing state — no auto-state-transition.
 */
export async function resurfaceForUser(args: ResurfaceArgs): Promise<{ candidates: number }> {
  const supabase = getSupabase();
  const lookback = args.lookback_days ?? 60;
  const since = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000).toISOString();

  // Find the user's open intents that already have matches (we won't generate
  // new matches here — just resurface existing ones aligned with the new goal).
  const { data: myIntents } = await supabase
    .from('user_intents')
    .select('intent_id, intent_kind')
    .eq('requester_user_id', args.user_id)
    .in('status', ['open', 'matched', 'engaged'])
    .gte('created_at', since);

  const intents = (myIntents ?? []) as Array<{ intent_id: string; intent_kind: string }>;
  if (intents.length === 0) return { candidates: 0 };

  let candidates = 0;
  // For each intent, look at its matches; check if pairing now aligns under the new goal.
  for (const intent of intents) {
    const { data: matches } = await supabase
      .from('intent_matches')
      .select('match_id, kind_pairing, compass_aligned, state, vitana_id_b, intent_b_id')
      .eq('intent_a_id', intent.intent_id)
      .in('state', ['new', 'viewed_by_a', 'viewed_by_b'])
      .eq('compass_aligned', false);

    for (const m of (matches ?? []) as any[]) {
      // Look up counterparty's compass category if we have intent_b_id.
      let counterpartyCategory: string | null = null;
      if (m.intent_b_id) {
        const { data: cp } = await supabase
          .from('intent_compass_alignment')
          .select('active_compass_category')
          .eq('intent_id', m.intent_b_id)
          .maybeSingle();
        counterpartyCategory = (cp as any)?.active_compass_category ?? null;
      }

      const bonus = await compassAlignmentBonus(
        m.kind_pairing,
        args.new_compass_category,
        counterpartyCategory,
      );
      if (bonus > 0) {
        // Mark the row aligned now — useful for the next time the user
        // pulls /api/v1/intents/:id/matches.
        await supabase
          .from('intent_matches')
          .update({ compass_aligned: true })
          .eq('match_id', m.match_id);
        candidates += 1;
      }
    }
  }

  if (candidates > 0) {
    await notifyUserAsync(
      args.user_id,
      args.tenant_id,
      'intent_compass_change_resurface',
      {
        title: `${candidates} match${candidates === 1 ? '' : 'es'} now fit your ${args.new_compass_category} focus`,
        body: 'Open My Intents to see them with the new alignment chip.',
        data: {
          type: 'intent_compass_change_resurface',
          candidates: String(candidates),
          new_compass_category: args.new_compass_category,
          url: '/intents/mine',
        },
      },
      supabase,
    );
  }

  await emitOasisEvent({
    vtid: 'VTID-01976',
    type: 'voice.message.sent',
    source: 'intent-compass-resurface',
    status: 'info',
    message: 'intent.compass_change.resurface',
    payload: {
      user_id: args.user_id,
      new_compass_category: args.new_compass_category,
      candidates,
    },
    actor_id: args.user_id,
    surface: 'api',
    vitana_id: args.vitana_id ?? undefined,
  });

  return { candidates };
}
