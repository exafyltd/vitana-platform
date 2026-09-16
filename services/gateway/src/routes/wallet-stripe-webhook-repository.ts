// Genuinely tested via test/wallet-stripe-webhook.test.ts, which drives
// a functional Supabase mock (from() returns table-scoped insert/
// update/select().eq() spies wired to configurable resolved values) —
// not a wholesale module mock.
/**
 * routes/wallet-stripe-webhook.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in wallet-stripe-webhook.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * Money-adjacent: this webhook credits/debits real wallet balances via
 * finalizeDeposit()/markDepositTerminal() (services/wallet/deposit-service.ts,
 * untouched by this extraction). This file only wraps the idempotency-
 * ledger (stripe_webhook_events) and deposit-lookup (wallet_deposits)
 * reads/writes around that logic — no money-moving logic itself.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertStripeWebhookEvent(
  sb: SupabaseClient,
  row: { stripe_event_id: string; event_type: string; source: string; payload: Record<string, unknown> },
) {
  return sb.from('stripe_webhook_events').insert(row);
}

export async function fetchWalletDepositByPaymentIntentId(sb: SupabaseClient, paymentIntentId: string) {
  return sb.from('wallet_deposits').select('id').eq('stripe_payment_intent_id', paymentIntentId).maybeSingle();
}

export async function updateStripeWebhookEventProcessed(
  sb: SupabaseClient,
  stripeEventId: string,
  processedAtIso: string,
  processingError: string | null,
) {
  return sb
    .from('stripe_webhook_events')
    .update({ processed_at: processedAtIso, processing_error: processingError })
    .eq('stripe_event_id', stripeEventId);
}
