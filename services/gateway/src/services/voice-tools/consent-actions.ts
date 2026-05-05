/**
 * VTID-02776 — Voice Tool Expansion P1n: Consent / Permissions.
 *
 * Backs voice tools that surface and manage the user's consent gate
 * (pending actions awaiting approval, granted permissions, revocations).
 */

import { SupabaseClient } from '@supabase/supabase-js';

export async function listPendingConsents(
  sb: SupabaseClient,
  userId: string,
  args: { limit?: number },
): Promise<{ ok: true; actions: any[]; count: number } | { ok: false; error: string }> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  const { data, error } = await sb
    .from('action_ledger')
    .select('id, action_type, action_summary, requested_at, status')
    .eq('user_id', userId)
    .eq('status', 'pending_consent')
    .order('requested_at', { ascending: false })
    .limit(limit);
  if (error) return { ok: false, error: `pending_query_failed: ${error.message}` };
  return { ok: true, actions: data || [], count: (data || []).length };
}

export async function approveConsent(
  sb: SupabaseClient,
  userId: string,
  args: { action_id: string },
): Promise<{ ok: true; action_id: string } | { ok: false; error: string }> {
  if (!args.action_id) return { ok: false, error: 'action_id_required' };
  const { error } = await sb
    .from('action_ledger')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', args.action_id)
    .eq('user_id', userId);
  if (error) return { ok: false, error: `approve_failed: ${error.message}` };
  return { ok: true, action_id: args.action_id };
}

export async function denyConsent(
  sb: SupabaseClient,
  userId: string,
  args: { action_id: string },
): Promise<{ ok: true; action_id: string } | { ok: false; error: string }> {
  if (!args.action_id) return { ok: false, error: 'action_id_required' };
  const { error } = await sb
    .from('action_ledger')
    .update({ status: 'denied', denied_at: new Date().toISOString() })
    .eq('id', args.action_id)
    .eq('user_id', userId);
  if (error) return { ok: false, error: `deny_failed: ${error.message}` };
  return { ok: true, action_id: args.action_id };
}

export async function listMyPermissions(
  sb: SupabaseClient,
  userId: string,
): Promise<{ ok: true; permissions: any[]; count: number } | { ok: false; error: string }> {
  const { data, error } = await sb
    .from('user_action_permissions')
    .select('action_type, granted, granted_at, revoked_at')
    .eq('user_id', userId)
    .order('granted_at', { ascending: false });
  if (error) return { ok: false, error: `permissions_query_failed: ${error.message}` };
  return { ok: true, permissions: data || [], count: (data || []).length };
}

export async function revokePermission(
  sb: SupabaseClient,
  userId: string,
  args: { action_type: string },
): Promise<{ ok: true; action_type: string } | { ok: false; error: string }> {
  if (!args.action_type) return { ok: false, error: 'action_type_required' };
  const { error } = await sb
    .from('user_action_permissions')
    .update({ granted: false, revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('action_type', args.action_type);
  if (error) return { ok: false, error: `revoke_failed: ${error.message}` };
  return { ok: true, action_type: args.action_type };
}
