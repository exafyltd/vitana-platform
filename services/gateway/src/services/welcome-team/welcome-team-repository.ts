/**
 * VTID-05205 — reads and writes of the welcome-team tick. Service-role client
 * only; nothing here is reachable from a member request.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WelcomeSenderSlug } from './config';

const CHUNK = 200;

async function inChunks<T>(
  ids: string[],
  run: (part: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await run(ids.slice(i, i + CHUNK));
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(((data as T[] | null) ?? [])));
  }
  return out;
}

export interface MembershipRow {
  user_id: string;
  tenant_id: string;
  created_at: string;
}

/** Primary members of the tenant who joined at or after `sinceIso` (the cohort). */
export async function fetchCohortMembers(sb: SupabaseClient, tenantId: string, sinceIso: string): Promise<MembershipRow[]> {
  const out: MembershipRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('user_tenants')
      .select('user_id, tenant_id, created_at')
      .eq('is_primary', true)
      .eq('tenant_id', tenantId)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`user_tenants: ${error.message}`);
    const rows = (data as MembershipRow[] | null) ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/** Primary memberships of named members in the tenant (the pilot allowlist). */
export async function fetchMembershipsFor(sb: SupabaseClient, tenantId: string, userIds: string[]): Promise<MembershipRow[]> {
  if (userIds.length === 0) return [];
  return inChunks<MembershipRow>(
    userIds,
    (p) => sb.from('user_tenants').select('user_id, tenant_id, created_at').eq('is_primary', true).eq('tenant_id', tenantId).in('user_id', p),
    'user_tenants',
  );
}

export interface AppUserRow {
  user_id: string;
  display_name: string | null;
  vitana_id: string | null;
}

export async function fetchAppUsers(sb: SupabaseClient, userIds: string[]): Promise<AppUserRow[]> {
  if (userIds.length === 0) return [];
  return inChunks<AppUserRow>(
    userIds,
    (p) => sb.from('app_users').select('user_id, display_name, vitana_id').in('user_id', p),
    'app_users',
  );
}

export interface ClaimRow {
  user_id: string;
  sender_slug: WelcomeSenderSlug;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  sent_at: string | null;
  updated_at: string;
}

export async function fetchClaims(sb: SupabaseClient, userIds: string[]): Promise<ClaimRow[]> {
  if (userIds.length === 0) return [];
  return inChunks<ClaimRow>(
    userIds,
    (p) => sb.from('welcome_team_claims').select('user_id, sender_slug, status, attempts, sent_at, updated_at').in('user_id', p),
    'welcome_team_claims',
  );
}

export type ClaimResult =
  | { ok: true; claimed: true; attempt: number }
  | { ok: true; claimed: false; reason: string }
  | { ok: false; error: string };

export async function claimWelcome(
  sb: SupabaseClient,
  userId: string,
  tenantId: string,
  slug: WelcomeSenderSlug,
): Promise<ClaimResult> {
  const { data, error } = await sb.rpc('claim_welcome_message', {
    p_user_id: userId,
    p_tenant_id: tenantId,
    p_sender_slug: slug,
  });
  if (error) return { ok: false, error: error.message };
  const r = data as { ok?: boolean; claimed?: boolean; attempt?: number; reason?: string; error?: string } | null;
  if (!r || r.ok !== true) return { ok: false, error: r?.error ?? 'empty_rpc_result' };
  if (r.claimed === true) return { ok: true, claimed: true, attempt: r.attempt ?? 1 };
  return { ok: true, claimed: false, reason: r.reason ?? 'not_claimed' };
}

export async function finishWelcome(
  sb: SupabaseClient,
  userId: string,
  slug: WelcomeSenderSlug,
  status: 'sent' | 'failed',
  chatMessageId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await sb.rpc('finish_welcome_message', {
    p_user_id: userId,
    p_sender_slug: slug,
    p_status: status,
    p_chat_message_id: chatMessageId,
  });
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: 'empty_rpc_result' }) as { ok: boolean; error?: string };
}

export interface WelcomeChatMessageRow {
  tenant_id: string;
  sender_id: string;
  receiver_id: string;
  content: string;
  message_type: 'text';
  metadata: Record<string, unknown>;
  sender_vitana_id?: string;
  receiver_vitana_id?: string;
}

export async function insertWelcomeChatMessage(
  sb: SupabaseClient,
  row: WelcomeChatMessageRow,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await sb.from('chat_messages').insert(row).select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: ((data as { id?: string } | null)?.id) ?? null, error: null };
}
