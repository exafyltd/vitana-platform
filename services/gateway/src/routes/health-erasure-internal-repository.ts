// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers);
// every call site is exercised, mocked, by test/health-erasure-internal.test.ts.
/**
 * VTID-05174 (Health Hub Phase 0 / D5 remainder, PLAT-D5R) — data-access seam
 * for routes/health-erasure-internal.ts, same convention as
 * connector-webhooks-repository.ts: every `.from(...)` call of the router
 * lives here, client-agnostic (takes `sb`), no request-handling logic.
 *
 * Tables: user_connections (vendor links + sealed tokens),
 * connector_webhooks_log (raw webhook audit log), partner_health_result_inbox
 * (service-role-only quarantine inbox). Nothing here reads or returns
 * raw_payload or a token to the caller beyond the router.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------- user_connections

/** Every connection row of the member, with what revokeAtVendor needs (part a + provider ids for part b). */
export async function fetchMemberConnections(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_connections')
    .select('id, connector_id, access_token, refresh_token, provider_user_id, provider_username')
    .eq('user_id', userId);
}

/** Same update as wearables-repository disconnectUserConnection, for every connector of the member. */
export async function wipeMemberConnectionTokens(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_connections')
    .update({
      is_active: false,
      disconnected_at: new Date().toISOString(),
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
    })
    .eq('user_id', userId);
}

// ---------------------------------------------------------------- connector_webhooks_log

/**
 * Rows that name the member by OUR user id: the logged user_id (VTID-05174
 * Change 6), Terra's payload.user.reference_id and Vital's
 * payload.client_user_id. `userId` is validated as a uuid by the router, so
 * it is safe inside the PostgREST `or` expression.
 */
export function memberWebhookLogFilter(userId: string): string {
  return [
    `user_id.eq.${userId}`,
    `payload->user->>reference_id.eq.${userId}`,
    `payload->>client_user_id.eq.${userId}`,
  ].join(',');
}

/** Provider-side member ids per connector: Terra puts its id at payload.user.user_id, Vital at payload.user_id. */
export const PROVIDER_ID_PATHS: Record<string, string> = {
  terra: 'payload->user->>user_id',
  vital: 'payload->>user_id',
};

export async function deleteWebhookLogByMember(sb: SupabaseClient, userId: string) {
  return sb.from('connector_webhooks_log').delete({ count: 'exact' }).or(memberWebhookLogFilter(userId));
}

export async function countWebhookLogByMember(sb: SupabaseClient, userId: string) {
  return sb
    .from('connector_webhooks_log')
    .select('id', { count: 'exact', head: true })
    .or(memberWebhookLogFilter(userId));
}

export async function deleteWebhookLogByProviderIds(sb: SupabaseClient, connectorId: string, ids: string[]) {
  return sb
    .from('connector_webhooks_log')
    .delete({ count: 'exact' })
    .eq('connector_id', connectorId)
    .in(PROVIDER_ID_PATHS[connectorId], ids);
}

export async function countWebhookLogByProviderIds(sb: SupabaseClient, connectorId: string, ids: string[]) {
  return sb
    .from('connector_webhooks_log')
    .select('id', { count: 'exact', head: true })
    .eq('connector_id', connectorId)
    .in(PROVIDER_ID_PATHS[connectorId], ids);
}

// ---------------------------------------------------------------- partner_health_result_inbox

/** Rows the member confirmed: they hold this member's result in raw_payload. */
export async function deleteConfirmedInboxRows(sb: SupabaseClient, userId: string) {
  return sb
    .from('partner_health_result_inbox')
    .delete()
    .eq('member_link_status', 'confirmed')
    .eq('proposed_user_id', userId)
    .select('id');
}

/** Pending/declined proposals for the member: keep the row (it is the partner's), clear the proposal. */
export async function clearInboxProposals(sb: SupabaseClient, userId: string) {
  return sb
    .from('partner_health_result_inbox')
    .update({
      proposed_user_id: null,
      proposed_tenant_id: null,
      proposed_test_name: null,
      proposed_external_order_ref: null,
      proposed_by_admin_id: null,
      proposed_at: null,
      member_link_status: null,
      member_decided_at: null,
    })
    .eq('proposed_user_id', userId)
    .in('member_link_status', ['pending_member', 'declined'])
    .select('id');
}

export function inboxArrayFilter(userId: string): string {
  return `candidate_user_ids.cs.{${userId}},member_declined_user_ids.cs.{${userId}}`;
}

export async function fetchInboxRowsWithMemberInArrays(sb: SupabaseClient, userId: string) {
  return sb
    .from('partner_health_result_inbox')
    .select('id, candidate_user_ids, member_declined_user_ids')
    .or(inboxArrayFilter(userId));
}

export async function updateInboxArrays(
  sb: SupabaseClient,
  id: string,
  arrays: { candidate_user_ids: string[]; member_declined_user_ids: string[] },
) {
  return sb.from('partner_health_result_inbox').update(arrays).eq('id', id);
}

export async function countInboxResidual(sb: SupabaseClient, userId: string) {
  return sb
    .from('partner_health_result_inbox')
    .select('id', { count: 'exact', head: true })
    .or(`proposed_user_id.eq.${userId},${inboxArrayFilter(userId)}`);
}
