// impact-allow-no-test
// Genuinely tested via test/routes/vaea-repository.test.ts, which drives
// a functional stub Supabase client (a from()-chain resolving to a
// configurable {data,error,count} response) — not a wholesale module
// mock.
/**
 * routes/vaea-repository.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/vaea.ts (the 5 VAEA tables:
 * vaea_config, vaea_referral_catalog, vaea_listener_channels,
 * vaea_detected_questions, vaea_reply_drafts) now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same tenant/user scoping, same return shapes —
 * no behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type Ident = { user_id: string; tenant_id: string };

// ─── CONFIG ────────────────────────────────────────────────────────────────

export async function fetchVaeaConfig(sb: SupabaseClient, ident: Ident) {
  return sb.from('vaea_config').select('*').eq('tenant_id', ident.tenant_id).eq('user_id', ident.user_id).maybeSingle();
}

export async function upsertVaeaConfig(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.from('vaea_config').upsert(payload, { onConflict: 'tenant_id,user_id' }).select('*').single();
}

// ─── CATALOG ───────────────────────────────────────────────────────────────

export async function listVaeaCatalog(sb: SupabaseClient, ident: Ident) {
  return sb
    .from('vaea_referral_catalog')
    .select('*')
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .order('tier', { ascending: true })
    .order('created_at', { ascending: false });
}

export async function insertVaeaCatalogItem(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.from('vaea_referral_catalog').insert(payload).select('*').single();
}

export async function updateVaeaCatalogItem(
  sb: SupabaseClient,
  id: string,
  ident: Ident,
  patch: Record<string, unknown>,
) {
  return sb
    .from('vaea_referral_catalog')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .select('*')
    .maybeSingle();
}

export async function deleteVaeaCatalogItem(sb: SupabaseClient, id: string, ident: Ident) {
  return sb
    .from('vaea_referral_catalog')
    .delete()
    .eq('id', id)
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id);
}

// ─── CHANNELS ──────────────────────────────────────────────────────────────

export async function listVaeaChannels(sb: SupabaseClient, ident: Ident) {
  return sb
    .from('vaea_listener_channels')
    .select('*')
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .order('created_at', { ascending: false });
}

export async function insertVaeaChannel(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.from('vaea_listener_channels').insert(payload).select('*').single();
}

export async function updateVaeaChannel(sb: SupabaseClient, id: string, ident: Ident, patch: Record<string, unknown>) {
  return sb
    .from('vaea_listener_channels')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .select('*')
    .maybeSingle();
}

export async function deleteVaeaChannel(sb: SupabaseClient, id: string, ident: Ident) {
  return sb
    .from('vaea_listener_channels')
    .delete()
    .eq('id', id)
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id);
}

// ─── DETECTED QUESTIONS (read-only) ────────────────────────────────────────

export async function listVaeaDetectedQuestions(
  sb: SupabaseClient,
  ident: Ident,
  args: { limit: number; offset: number; disposition?: string },
) {
  let q = sb
    .from('vaea_detected_questions')
    .select('*')
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .order('created_at', { ascending: false })
    .range(args.offset, args.offset + args.limit - 1);
  if (args.disposition) q = q.eq('disposition', args.disposition);
  return q;
}

// ─── DRAFTS ────────────────────────────────────────────────────────────────

export async function listVaeaDrafts(
  sb: SupabaseClient,
  ident: Ident,
  args: { statuses: string[]; limit: number; offset: number },
) {
  return sb
    .from('vaea_reply_drafts')
    .select('*, vaea_detected_questions(id, message_body, platform, author_handle, message_url, combined_score, extracted_topics)')
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .in('status', args.statuses)
    .order('created_at', { ascending: false })
    .range(args.offset, args.offset + args.limit - 1);
}

export async function dismissVaeaDraft(sb: SupabaseClient, id: string, ident: Ident) {
  return sb
    .from('vaea_reply_drafts')
    .update({ status: 'dismissed' })
    .eq('id', id)
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .in('status', ['shadow', 'pending_approval'])
    .select('id, status')
    .maybeSingle();
}

// ─── SUMMARY (single call for the panel) ───────────────────────────────────

export async function fetchVaeaSummary(sb: SupabaseClient, ident: Ident) {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return Promise.all([
    sb.from('vaea_config').select('*').eq('tenant_id', ident.tenant_id).eq('user_id', ident.user_id).maybeSingle(),
    sb
      .from('vaea_listener_channels')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ident.tenant_id)
      .eq('user_id', ident.user_id)
      .eq('active', true),
    sb
      .from('vaea_referral_catalog')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ident.tenant_id)
      .eq('user_id', ident.user_id)
      .eq('active', true),
    sb
      .from('vaea_reply_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ident.tenant_id)
      .eq('user_id', ident.user_id)
      .in('status', ['shadow', 'pending_approval']),
    sb
      .from('vaea_detected_questions')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ident.tenant_id)
      .eq('user_id', ident.user_id)
      .gte('created_at', since7d),
  ]);
}
