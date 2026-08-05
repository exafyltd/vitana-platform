/**
 * VTID-03498 (Aurora migration B1) — data-access seam for the customer
 * feedback / ticket-lifecycle domain.
 *
 * Third repository in the B1 sequence, after `specialists-repository.ts`
 * (platform personas) and `tenant-specialists-repository.ts` (tenant config).
 * All three are consumed by route files that will not change again when the
 * Supabase→Aurora swap happens (VTID-03494, Option B).
 *
 * This domain lives in `routes/tenant-specialists.ts` for historical reasons
 * but is a genuinely separate bounded context: tickets, handoff events, and the
 * dev-autopilot executions a ticket dispatches. It is deliberately NOT merged
 * into the tenant-config repository.
 *
 * THE SECURITY GATE
 * -----------------
 * `loadTicketIfTenantOwned` is the check that stops a tenant admin acting on
 * another tenant's ticket. It is a three-step chain — ticket → ticket.user_id →
 * user_tenants membership — and it is moved into this file *whole* rather than
 * split into callable parts, precisely so no caller can perform step one and
 * forget steps two and three. There is no exported "get ticket by id" that
 * skips the tenant check; if you need a ticket, you go through the gate.
 *
 * The gate returns `null` for all three failure modes (no ticket / no owner /
 * owner not in tenant) so callers cannot accidentally leak *which* one applied
 * — the route answers a single NOT_FOUND_OR_NOT_IN_TENANT either way.
 *
 * Error contract matches its siblings: database errors throw RepositoryError,
 * genuinely-absent rows return null/[].
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { RepositoryError } from '../specialists/specialists-repository';

export { RepositoryError };

export type TicketRow = Record<string, any>;
export type HandoffRow = Record<string, any>;

export interface ExecutionRow {
  id: string;
  status: string;
  pr_url: string | null;
  pr_number: number | null;
  branch?: string | null;
  failure_stage?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string;
  completed_at?: string | null;
}

/** Column list the ticket drawer's execution progress bar needs. */
export const EXECUTION_DRAWER_COLUMNS =
  'id, status, pr_url, pr_number, branch, failure_stage, created_at, updated_at, completed_at';

let client: SupabaseClient | null = null;

function db(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Test seam: inject a stub client. */
export function __setClientForTest(c: SupabaseClient | null): void {
  client = c;
}

function fail(operation: string, error: { message?: string } | null): never {
  throw new RepositoryError(error?.message ?? 'unknown database error', operation);
}

// ---------------------------------------------------------------------------
// THE TENANT GATE
// ---------------------------------------------------------------------------

/**
 * Load a ticket ONLY if its owner is a member of the given tenant.
 *
 * Returns null when the ticket does not exist, has no owner, or the owner is
 * outside the tenant — the caller cannot distinguish these, by design.
 *
 * Do not add an exported variant that skips the membership check.
 */
export async function loadTicketIfTenantOwned(
  tenantId: string,
  ticketId: string,
): Promise<null | { ticket: TicketRow; handoffs: HandoffRow[] }> {
  const { data: ticket, error: tErr } = await db()
    .from('feedback_tickets')
    .select('*')
    .eq('id', ticketId)
    .maybeSingle();
  if (tErr) fail('loadTicketIfTenantOwned.ticket', tErr);
  if (!ticket) return null;
  if (!(ticket as TicketRow).user_id) return null;

  const { data: membership, error: mErr } = await db()
    .from('user_tenants')
    .select('user_id')
    .eq('user_id', (ticket as TicketRow).user_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (mErr) fail('loadTicketIfTenantOwned.membership', mErr);
  if (!membership) return null;

  const { data: handoffs, error: hErr } = await db()
    .from('feedback_handoff_events')
    .select('id, from_agent, to_agent, reason, detected_intent, matched_keyword, confidence, ts')
    .eq('ticket_id', ticketId)
    .order('ts', { ascending: true });
  if (hErr) fail('loadTicketIfTenantOwned.handoffs', hErr);

  return { ticket: ticket as TicketRow, handoffs: (handoffs ?? []) as HandoffRow[] };
}

/**
 * Resolve a vitana_id to a user_id and confirm tenant membership in one step.
 *
 * Returns a discriminated result rather than null so the bulk-approve route can
 * keep its two distinct 404s (CUSTOMER_NOT_FOUND vs CUSTOMER_NOT_IN_TENANT),
 * which are operator-facing and genuinely different problems. Unlike the ticket
 * gate, neither answer leaks another tenant's data.
 */
export async function resolveTenantCustomer(
  tenantId: string,
  vitanaId: string,
): Promise<{ status: 'ok'; userId: string } | { status: 'not_found' } | { status: 'not_in_tenant' }> {
  const { data: appUser, error: aErr } = await db()
    .from('app_users')
    .select('user_id')
    .eq('vitana_id', vitanaId)
    .maybeSingle();
  if (aErr) fail('resolveTenantCustomer.appUser', aErr);
  if (!appUser) return { status: 'not_found' };

  const userId = (appUser as { user_id: string }).user_id;

  const { data: membership, error: mErr } = await db()
    .from('user_tenants')
    .select('user_id')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (mErr) fail('resolveTenantCustomer.membership', mErr);
  if (!membership) return { status: 'not_in_tenant' };

  return { status: 'ok', userId };
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export async function listActionableTicketsForUser(userId: string): Promise<TicketRow[]> {
  const { data, error } = await db()
    .from('feedback_tickets')
    .select('id, ticket_number, kind, status, vitana_id, resolver_agent')
    .eq('user_id', userId)
    .in('status', ['spec_ready', 'answer_ready']);
  if (error) fail('listActionableTicketsForUser', error);
  return (data ?? []) as TicketRow[];
}

/**
 * Status transition guarded by an optimistic lock on the expected current
 * status. Returns null when the row did not move — either because someone else
 * changed it first, or because the write failed. The caller treats both as
 * "skipped", which is the existing bulk-approve behaviour.
 *
 * NOTE: this returns null rather than throwing on error, unlike most reads
 * here. That is deliberate and matches the bulk path's semantics — one
 * contended ticket must not abort the whole batch.
 */
export async function transitionTicketStatus(
  ticketId: string,
  expectedStatus: string,
  patch: Record<string, unknown>,
  returningColumns: string,
): Promise<TicketRow | null> {
  const { data, error } = await db()
    .from('feedback_tickets')
    .update(patch)
    .eq('id', ticketId)
    .eq('status', expectedStatus)
    .select(returningColumns)
    .single();
  if (error || !data) return null;
  return data as unknown as TicketRow;
}

/** Unconditional update returning selected columns. Throws on failure. */
export async function updateTicketReturning(
  ticketId: string,
  patch: Record<string, unknown>,
  returningColumns: string,
): Promise<TicketRow> {
  const { data, error } = await db()
    .from('feedback_tickets')
    .update(patch)
    .eq('id', ticketId)
    .select(returningColumns)
    .single();
  if (error || !data) fail('updateTicketReturning', error);
  return data as unknown as TicketRow;
}

/** Unconditional update with no projection. Throws on failure. */
export async function updateTicket(
  ticketId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db().from('feedback_tickets').update(patch).eq('id', ticketId);
  if (error) fail('updateTicket', error);
}

// ---------------------------------------------------------------------------
// Dev-autopilot executions
// ---------------------------------------------------------------------------

/** Latest execution for a finding, whatever its status — drives the drawer. */
export async function latestExecutionForFinding(
  findingId: string,
): Promise<ExecutionRow | null> {
  const { data, error } = await db()
    .from('dev_autopilot_executions')
    .select(EXECUTION_DRAWER_COLUMNS)
    .eq('finding_id', findingId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail('latestExecutionForFinding', error);
  return (data as unknown as ExecutionRow) ?? null;
}

/** Latest COMPLETED execution — the rollback path needs its merge SHA. */
export async function latestCompletedExecutionForFinding(
  findingId: string,
): Promise<ExecutionRow | null> {
  const { data, error } = await db()
    .from('dev_autopilot_executions')
    .select('id, status, pr_url, pr_number, metadata')
    .eq('finding_id', findingId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail('latestCompletedExecutionForFinding', error);
  return (data as unknown as ExecutionRow) ?? null;
}
