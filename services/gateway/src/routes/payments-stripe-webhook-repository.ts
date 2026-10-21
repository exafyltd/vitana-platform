// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/payments-stripe-webhook.ts — zero
// coverage today.
/**
 * routes/payments-stripe-webhook.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in payments-stripe-webhook.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same update payload, same
 * return shapes — no behavior change today. Client-agnostic (takes
 * `sb` as a param). Money-adjacent: this seam does not alter the
 * state-machine logic (STATE_BY_EVENT mapping) at all, only moves the
 * raw row fetch/update.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchServicePaymentByStripePiId(sb: SupabaseClient, stripePiId: string) {
  return sb
    .from('service_payments')
    .select('payment_id, payer_vitana_id, payee_vitana_id, state')
    .eq('stripe_pi_id', stripePiId)
    .maybeSingle();
}

export async function updateServicePaymentState(sb: SupabaseClient, paymentId: string, nextState: string) {
  return sb
    .from('service_payments')
    .update({ state: nextState, updated_at: new Date().toISOString() })
    .eq('payment_id', paymentId);
}
