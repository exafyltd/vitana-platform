// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/vcaop.ts — zero coverage today.
// MONEY-CRITICAL: this file touches cart_order, commission_event, and
// rewards_ledger — every filter/onConflict target/payload shape below is
// preserved byte-for-byte from the original inline calls.
/**
 * routes/vcaop.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function insertOasisEvent(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: unknown }> {
  return sb.from('oasis_events').insert(row);
}

// ===== Catalog =====

export async function fetchProviders(sb: SupabaseClient, category: string | undefined) {
  let q = sb.from('provider').select('id,name,category,connector_mode,kyb_required').order('category');
  if (category) q = q.eq('category', category);
  return q;
}

export async function fetchAffiliatePrograms(sb: SupabaseClient) {
  return sb.from('affiliate_program').select('id,network,merchant,source,affiliate_cashback_allowed').order('id');
}

// ===== Shop → route → earn =====

export function insertCartOrder(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: unknown }> {
  return sb.from('cart_order').insert(row);
}

export function insertDisclosure(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: unknown }> {
  return sb.from('disclosure').insert(row);
}

export function insertMerchantRouteRows(sb: SupabaseClient, rows: Record<string, unknown>[]): PromiseLike<{ error: unknown }> {
  return sb.from('merchant_route').insert(rows);
}

export function insertCommissionEventRows(sb: SupabaseClient, rows: Record<string, unknown>[]): PromiseLike<{ error: unknown }> {
  return sb.from('commission_event').insert(rows);
}

export function insertRewardsLedgerRows(sb: SupabaseClient, rows: Record<string, unknown>[]): PromiseLike<{ error: unknown }> {
  return sb.from('rewards_ledger').insert(rows);
}

export function updateCartOrderRouted(sb: SupabaseClient, cartId: string, totalAmount: number, updatedAt: string): PromiseLike<{ error: unknown }> {
  return sb.from('cart_order').update({ status: 'routed', total_amount: totalAmount, updated_at: updatedAt }).eq('id', cartId);
}

// ===== Per-user affiliate deeplink =====

export async function fetchAffiliateProgramById(sb: SupabaseClient, programId: string) {
  return sb.from('affiliate_program').select('id,network,policy,affiliate_cashback_allowed').eq('id', programId).maybeSingle();
}

export function upsertSubidMap(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: unknown }> {
  return sb.from('subid_map').upsert(row, { onConflict: 'sub_id' });
}

// ===== Wallet =====

export async function fetchWalletLedgerEntries(sb: SupabaseClient, userId: string) {
  return sb.from('rewards_ledger').select('id,amount,state,currency').eq('user_id', userId);
}

// ===== Commissions queue (admin) =====

export async function fetchCommissionsQueue(sb: SupabaseClient, status: string | undefined) {
  let q = sb
    .from('commission_event')
    .select('id,merchant,user_id,sub_id,gross_commission,currency,status,postback_ref,created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (status) q = q.eq('status', status);
  return q;
}

export async function fetchCommissionEventById(sb: SupabaseClient, id: string) {
  return sb.from('commission_event').select('id,status').eq('id', id).maybeSingle();
}

export function updateCommissionEventConfirmed(sb: SupabaseClient, id: string, postbackRef: string, updatedAt: string): PromiseLike<{ error: unknown }> {
  return sb.from('commission_event').update({ status: 'confirmed', postback_ref: postbackRef, updated_at: updatedAt }).eq('id', id);
}

export function updateRewardsLedgerConfirmedByCommission(sb: SupabaseClient, commissionEventId: string, updatedAt: string): PromiseLike<{ error: unknown }> {
  return sb.from('rewards_ledger').update({ state: 'confirmed', updated_at: updatedAt }).eq('commission_event_id', commissionEventId);
}

export function updateCommissionEventReversed(sb: SupabaseClient, id: string, updatedAt: string): PromiseLike<{ error: unknown }> {
  return sb.from('commission_event').update({ status: 'reversed', updated_at: updatedAt }).eq('id', id);
}

export function updateRewardsLedgerReversedByCommission(sb: SupabaseClient, commissionEventId: string, updatedAt: string): PromiseLike<{ error: unknown }> {
  return sb.from('rewards_ledger').update({ state: 'reversed', updated_at: updatedAt }).eq('commission_event_id', commissionEventId);
}

// ===== Onboarding (admin) =====

export async function fetchOpenHumanTasks(sb: SupabaseClient) {
  return sb
    .from('human_task')
    .select('id,type,status,provider_id,job_id,payload,created_at')
    .in('status', ['open', 'in_progress'])
    .order('created_at', { ascending: false });
}

export async function fetchProvidersForOnboarding(sb: SupabaseClient, ids: string[]) {
  let q = sb.from('provider').select('id,connector_mode,kyb_required');
  if (ids.length > 0) q = q.in('id', ids);
  return q;
}

export function insertProviderAccountRows(sb: SupabaseClient, rows: Record<string, unknown>[]): PromiseLike<{ error: unknown }> {
  return sb.from('provider_account').insert(rows);
}

export function insertProvisioningJobRows(sb: SupabaseClient, rows: Record<string, unknown>[]): PromiseLike<{ error: unknown }> {
  return sb.from('provisioning_job').insert(rows);
}

export function insertHumanTaskRows(sb: SupabaseClient, rows: Record<string, unknown>[]): PromiseLike<{ error: unknown }> {
  return sb.from('human_task').insert(rows);
}

export async function fetchHumanTaskById(sb: SupabaseClient, id: string) {
  return sb.from('human_task').select('id,type,job_id').eq('id', id).maybeSingle();
}

export function updateHumanTaskCompleted(sb: SupabaseClient, id: string, updatedAt: string): PromiseLike<{ error: unknown }> {
  return sb.from('human_task').update({ status: 'completed', updated_at: updatedAt }).eq('id', id);
}

export function updateProvisioningJobRunning(sb: SupabaseClient, jobId: string, updatedAt: string): PromiseLike<{ error: unknown }> {
  return sb.from('provisioning_job').update({ status: 'running', updated_at: updatedAt }).eq('id', jobId);
}
