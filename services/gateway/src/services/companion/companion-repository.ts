/**
 * VTID-05099 — companion messages data access. Reads member signals
 * (memberships, profiles, preferences, the ledger, today's onboarding touch)
 * and writes ONLY through claim_companion_message / finish_companion_message.
 * Nothing here sends anything.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const CHUNK = 200;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function inChunks<R>(
  ids: string[],
  run: (part: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<R[]> {
  const out: R[] = [];
  for (const part of chunks(ids)) {
    const { data, error } = await run(part);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...((data ?? []) as R[]));
  }
  return out;
}

export interface MemberRow { user_id: string; tenant_id: string }

/** Every primary membership, paged (REST caps a select at ~1000). */
export async function fetchMembers(sb: SupabaseClient): Promise<MemberRow[]> {
  const out: MemberRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('user_tenants')
      .select('user_id, tenant_id')
      .eq('is_primary', true)
      .order('user_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`user_tenants: ${error.message}`);
    out.push(...((data ?? []) as MemberRow[]));
    if (!data || data.length < 1000) return out;
  }
}

export interface ProfileRow { user_id: string; first_name: string | null; timezone: string | null }

export function fetchProfiles(sb: SupabaseClient, ids: string[]) {
  return inChunks<ProfileRow>(
    ids, (p) => sb.from('profiles').select('user_id, first_name, timezone').in('user_id', p), 'profiles');
}

export interface PreferenceRow {
  user_id: string;
  enabled: boolean;
  topic_health: boolean;
  topic_community: boolean;
  topic_business: boolean;
}

export function fetchPreferences(sb: SupabaseClient, ids: string[]) {
  return inChunks<PreferenceRow>(
    ids,
    (p) => sb.from('companion_preferences')
      .select('user_id, enabled, topic_health, topic_community, topic_business').in('user_id', p),
    'companion_preferences');
}

export interface LedgerRow { user_id: string; local_date: string; mode: string; moment_key: string }

export function fetchRecentLedger(sb: SupabaseClient, ids: string[], sinceDate: string) {
  return inChunks<LedgerRow>(
    ids,
    (p) => sb.from('companion_messages_ledger')
      .select('user_id, local_date, mode, moment_key').gte('local_date', sinceDate).in('user_id', p),
    'companion_ledger');
}

/** Onboarding coach touches already SENT (VTID-04892) — one Vitana touch a day, whoever sends it. */
export function fetchOnboardingTouches(sb: SupabaseClient, ids: string[], sinceDate: string) {
  return inChunks<{ user_id: string; local_day: string }>(
    ids,
    (p) => sb.from('onboarding_touch_ledger')
      .select('user_id, local_day').eq('status', 'sent').gte('local_day', sinceDate).in('user_id', p),
    'onboarding_touch_ledger');
}

/** Full compositions already spent today (UTC day) by shadow mode (sparring F5 cap). */
export async function countShadowComposedSince(sb: SupabaseClient, sinceIso: string): Promise<number> {
  const { count, error } = await sb
    .from('companion_messages_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('mode', 'shadow')
    .not('composed_text', 'is', null)
    .gte('created_at', sinceIso);
  if (error) throw new Error(`companion_ledger count: ${error.message}`);
  return count ?? 0;
}

export interface ClaimArgs {
  user_id: string;
  tenant_id: string;
  local_date: string;
  mode: 'shadow' | 'staff' | 'live';
  sender: 'companion' | 'proactive_match';
  moment_key: string;
  card_type: string | null;
  facts: Record<string, unknown>;
}

export type ClaimResult =
  | { ok: true; claimed: true; id: number }
  | { ok: true; claimed: false; reason: string }
  | { ok: false; error: string };

export async function claimMessage(sb: SupabaseClient, a: ClaimArgs): Promise<ClaimResult> {
  const { data, error } = await sb.rpc('claim_companion_message', {
    p_user_id: a.user_id,
    p_tenant_id: a.tenant_id,
    p_local_date: a.local_date,
    p_mode: a.mode,
    p_sender: a.sender,
    p_moment_key: a.moment_key,
    p_card_type: a.card_type,
    p_facts: a.facts,
  });
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: 'empty_rpc_result' }) as ClaimResult;
}

export async function finishMessage(
  sb: SupabaseClient,
  id: number,
  status: 'sent' | 'failed' | 'shadow',
  composedText: string | null,
  composedByModel: string | null,
  chatMessageId: string | null = null,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await sb.rpc('finish_companion_message', {
    p_id: id,
    p_status: status,
    p_composed_text: composedText,
    p_composed_by_model: composedByModel,
    p_chat_message_id: chatMessageId,
  });
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: 'empty_rpc_result' }) as { ok: boolean; error?: string };
}
