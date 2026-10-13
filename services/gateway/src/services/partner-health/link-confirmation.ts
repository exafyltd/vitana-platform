/**
 * VTID-05055 — Health Hub Phase 0 / D8: the member confirms a partner link.
 *
 * Staff no longer create a partner_customer_links row + a
 * partner_health_test_orders row for a member they picked by hand (see
 * routes/admin-partner-health.ts confirm-match, now a PROPOSAL). The link and
 * the order are created here, and only here, after the proposed member says
 * "yes, this is my test" in the app.
 *
 * The write itself is ONE Postgres function,
 * fn_confirm_partner_link_request(p_inbox_id, p_user_id) (migration
 * 20261010190000_vtid_05055_…): it locks the inbox row, re-checks that the
 * member belongs to the stored proposed tenant, inserts the link and the
 * order with exactly the values confirm-match used to write, and resolves the
 * row — all in one transaction. A failure leaves the row 'pending_member', so
 * the member can simply retry.
 *
 * Tolerates the migration not being applied yet (staging shares the
 * production database and the migration lands only after Gate 2): a missing
 * column or function answers 503 — never a fallback to the old direct link.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from '../oasis-event-service';

const VTID = 'VTID-05055';

/** PostgREST / Postgres error shape, as far as we read it. */
interface DbError {
  code?: string;
  message?: string;
}

/**
 * True when an error means "the VTID-05055 migration is not applied here":
 * an unknown column (42703 / PGRST204), an unknown function (42883 /
 * PGRST202) or PostgREST's schema-cache wording for either.
 */
export function isMissingSchemaError(err: DbError | null | undefined): boolean {
  if (!err) return false;
  if (err.code && ['42703', '42883', 'PGRST202', 'PGRST204'].includes(err.code)) return true;
  const msg = String(err.message ?? '');
  return /column .* does not exist|could not find the .* (column|function)|schema cache|function .* does not exist/i.test(msg);
}

export type LinkDecisionOutcome<T extends object = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; status: 404 | 409 | 500 | 503; error: string };

export interface PendingLinkRow {
  id: string;
  proposed_user_id: string;
}

/**
 * Create the link + order for a proposal the member confirmed.
 * `row` must already be known to belong to `row.proposed_user_id` (the
 * caller's identity); the function re-checks that inside the transaction.
 */
export async function materializeMemberConfirmedLink(
  sb: SupabaseClient,
  row: PendingLinkRow
): Promise<LinkDecisionOutcome<{ order_id: string; link_id: string }>> {
  const { data, error } = await sb.rpc('fn_confirm_partner_link_request', {
    p_inbox_id: row.id,
    p_user_id: row.proposed_user_id,
  });

  if (error) {
    if (isMissingSchemaError(error)) {
      console.warn('[VTID-05055] fn_confirm_partner_link_request missing — migration not applied; refusing (no fallback to a direct link).');
      return { ok: false, status: 503, error: 'MEMBER_CONFIRMATION_UNAVAILABLE' };
    }
    // Rolled back by Postgres: the row is still 'pending_member'.
    console.error(`[VTID-05055] member confirm failed for inbox ${row.id}: ${error.message}`);
    return { ok: false, status: 500, error: 'CONFIRM_FAILED' };
  }

  const result = (data ?? {}) as { ok?: boolean; code?: string; order_id?: string; link_id?: string };
  if (!result.ok) {
    if (result.code === 'not_in_tenant') return { ok: false, status: 409, error: 'NOT_IN_TENANT' };
    return { ok: false, status: 409, error: 'NOT_PENDING' };
  }
  if (!result.order_id || !result.link_id) {
    return { ok: false, status: 500, error: 'CONFIRM_FAILED' };
  }

  const emitted = await emitOasisEvent({
    vtid: VTID,
    type: 'health_test.order_created',
    source: 'partner-health/link-confirmation',
    status: 'success',
    message: `Member confirmed the partner link for inbox row ${row.id}, creating order ${result.order_id}.`,
    payload: { inbox_id: row.id, order_id: result.order_id, link_id: result.link_id, confirmed_by: 'member' },
    actor_id: row.proposed_user_id,
    actor_role: 'user',
  }).catch((err: unknown) => ({ ok: false, error: String(err) }));
  if (!emitted.ok) {
    // The order exists (committed); the audit gap is logged loudly, never hidden.
    console.error(`[VTID-05055] health_test.order_created emit failed for inbox ${row.id}: ${(emitted as { error?: string }).error ?? 'unknown'}`);
  }

  return { ok: true, order_id: result.order_id, link_id: result.link_id };
}

/**
 * The member says "not me". Compare-and-set pending_member → declined,
 * remembers the member in member_declined_user_ids (staff cannot propose the
 * same member again) and leaves the row unresolved so it stays in the staff
 * inbox. The caller emits health_test.link_declined.
 */
export async function declineMemberLink(
  sb: SupabaseClient,
  input: { inbox_id: string; user_id: string }
): Promise<LinkDecisionOutcome> {
  const { data: row, error: readErr } = await sb
    .from('partner_health_result_inbox')
    .select('id, member_link_status, member_declined_user_ids, resolved')
    .eq('id', input.inbox_id)
    .eq('proposed_user_id', input.user_id)
    .maybeSingle();
  if (readErr) {
    if (isMissingSchemaError(readErr)) return { ok: false, status: 503, error: 'MEMBER_CONFIRMATION_UNAVAILABLE' };
    return { ok: false, status: 500, error: 'DECLINE_FAILED' };
  }
  if (!row) return { ok: false, status: 404, error: 'NOT_FOUND' };
  const current = row as { member_link_status: string | null; member_declined_user_ids: string[] | null; resolved: boolean };
  if (current.member_link_status !== 'pending_member' || current.resolved) {
    return { ok: false, status: 409, error: 'NOT_PENDING' };
  }

  const declined = Array.from(new Set([...(current.member_declined_user_ids ?? []), input.user_id]));
  const { data: updated, error: updErr } = await sb
    .from('partner_health_result_inbox')
    .update({
      member_link_status: 'declined',
      member_declined_user_ids: declined,
      member_decided_at: new Date().toISOString(),
    })
    .eq('id', input.inbox_id)
    .eq('proposed_user_id', input.user_id)
    .eq('member_link_status', 'pending_member')
    .eq('resolved', false)
    .select('id');
  if (updErr) {
    if (isMissingSchemaError(updErr)) return { ok: false, status: 503, error: 'MEMBER_CONFIRMATION_UNAVAILABLE' };
    return { ok: false, status: 500, error: 'DECLINE_FAILED' };
  }
  if (!Array.isArray(updated) || updated.length === 0) {
    // Someone else (a parallel confirm) changed the row first.
    return { ok: false, status: 409, error: 'NOT_PENDING' };
  }
  return { ok: true };
}
