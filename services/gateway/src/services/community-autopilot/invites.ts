/**
 * VTID-04508 (Community Autopilot CA-7): attributed invites and the inviter's
 * wallet credit (owner decision 5).
 *
 * Before this the pieces existed but were not joined: links were minted per
 * click to a `/s/<code>` URL nothing resolved, no signup was ever attributed,
 * and the reward automation's payload never matched what was dispatched.
 *
 *   getOrCreateInviteLink  one reusable personal link per member (`/i/<code>`).
 *   lookupInvite           public: who invited you (first name only).
 *   claimInvite            the new member's app claims the code after sign-in.
 *
 * Anti-abuse (all enforced here, before anything is written):
 *   - the code exists and is a member invite; the inviter is not the claimant;
 *   - neither side is a test/service account (CLAUDE.md rules 43-45);
 *   - the claimant belongs to the inviter's tenant;
 *   - the claimant's account is new (≤ 14 days) and its email is confirmed;
 *   - one referral per claimant ever (unique index, migration 20260924200000);
 *   - at most INVITE_REWARD_MONTHLY_CAP rewarded invites per inviter / 30 days.
 * The credit runs once: the referral must move signed_up → rewarded first.
 * The reward is off unless COMMUNITY_INVITE_REWARD_ENABLED is exactly 'true';
 * attribution is recorded either way. Vitanaland never contacts the invited
 * person — the member shares the link through their own channel.
 */
import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export const INVITE_TARGET_TYPE = 'member_invite';
export const INVITE_MAX_ACCOUNT_AGE_DAYS = 14;
export const INVITE_REWARD_MONTHLY_CAP = 10;
/** REWARD_TABLE.referral_completed (types/automations.ts). */
export const DEFAULT_INVITE_REWARD_CREDITS = 200;

export function isInviteRewardEnabled(): boolean {
  return process.env.COMMUNITY_INVITE_REWARD_ENABLED === 'true';
}

export function inviteRewardCredits(): number {
  const n = Number(process.env.COMMUNITY_INVITE_REWARD_CREDITS);
  return Number.isFinite(n) && n > 0 && n <= 10_000 ? Math.floor(n) : DEFAULT_INVITE_REWARD_CREDITS;
}

export function inviteBaseUrl(): string {
  return (process.env.PUBLIC_APP_URL || 'https://vitanaland.com').replace(/\/+$/, '');
}

/** 8 characters, no look-alikes (0/O, 1/l/I). */
export function newInviteCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const INVITE_CODE_RE = /^[a-z0-9]{6,16}$/;

export interface InviteLink { code: string; url: string }

export async function getOrCreateInviteLink(sb: SupabaseClient, userId: string, tenantId: string): Promise<InviteLink | null> {
  const found = await sb.from('sharing_links').select('short_code').eq('user_id', userId).eq('target_type', INVITE_TARGET_TYPE).limit(1);
  const existing = (found.data as Array<{ short_code: string }> | null)?.[0]?.short_code;
  if (existing) return { code: existing, url: `${inviteBaseUrl()}/i/${existing}` };
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newInviteCode();
    const { error } = await sb.from('sharing_links').insert({
      tenant_id: tenantId,
      user_id: userId,
      target_type: INVITE_TARGET_TYPE,
      target_id: userId,
      short_code: code,
      utm_source: 'member_invite',
      utm_campaign: 'community_autopilot',
      metadata: { source: 'community_autopilot' },
    });
    if (!error) return { code, url: `${inviteBaseUrl()}/i/${code}` };
    // A concurrent request created the member's link: read it back.
    const again = await sb.from('sharing_links').select('short_code').eq('user_id', userId).eq('target_type', INVITE_TARGET_TYPE).limit(1);
    const code2 = (again.data as Array<{ short_code: string }> | null)?.[0]?.short_code;
    if (code2) return { code: code2, url: `${inviteBaseUrl()}/i/${code2}` };
  }
  return null;
}

interface LinkRow { id: string; user_id: string; tenant_id: string; target_type: string }

async function findLink(sb: SupabaseClient, code: string): Promise<LinkRow | null> {
  if (!INVITE_CODE_RE.test(code)) return null;
  const { data } = await sb.from('sharing_links').select('id,user_id,tenant_id,target_type').eq('short_code', code).limit(1);
  const row = (data as LinkRow[] | null)?.[0];
  return row && row.target_type === INVITE_TARGET_TYPE ? row : null;
}

export async function lookupInvite(sb: SupabaseClient, code: string): Promise<{ ok: boolean; inviter_first_name?: string | null }> {
  const link = await findLink(sb, code);
  if (!link) return { ok: false };
  const { fetchExcludedTestServiceAccountIds } = await import('../../lib/excluded-test-service-accounts');
  if ((await fetchExcludedTestServiceAccountIds(sb)).has(link.user_id)) return { ok: false };
  const { data } = await sb.from('profiles').select('first_name,display_name').eq('user_id', link.user_id).limit(1);
  const p = (data as Array<{ first_name: string | null; display_name: string | null }> | null)?.[0];
  return { ok: true, inviter_first_name: (p?.first_name || p?.display_name || null) };
}

export type ClaimOutcome =
  | { status: 'invalid_code' }
  | { status: 'rejected'; reason: string }
  | { status: 'already_attributed' }
  | { status: 'attributed'; referral_id: string; rewarded: boolean; reward_reason?: string; credits?: number };

export interface ClaimDeps {
  /** auth.users facts for the claimant (created_at, email_confirmed_at). */
  getAuthUser: (userId: string) => Promise<{ created_at: string | null; email_confirmed_at: string | null } | null>;
  now?: () => Date;
}

/** Pure: may this claimant be attributed? null = yes, else the reason. */
export function checkClaimEligibility(a: {
  inviterId: string;
  claimantId: string;
  excluded: Set<string>;
  inviterTenantId: string;
  claimantTenantIds: string[];
  authUser: { created_at: string | null; email_confirmed_at: string | null } | null;
  now: Date;
}): string | null {
  if (a.inviterId === a.claimantId) return 'self_invite';
  if (a.excluded.has(a.inviterId) || a.excluded.has(a.claimantId)) return 'test_or_service_account';
  if (!a.claimantTenantIds.includes(a.inviterTenantId)) return 'different_community';
  if (!a.authUser?.created_at) return 'account_unknown';
  const ageDays = (a.now.getTime() - Date.parse(a.authUser.created_at)) / 86_400_000;
  if (!(ageDays <= INVITE_MAX_ACCOUNT_AGE_DAYS)) return 'account_not_new';
  if (!a.authUser.email_confirmed_at) return 'email_not_confirmed';
  return null;
}

export async function claimInvite(sb: SupabaseClient, claimantId: string, code: string, deps: ClaimDeps): Promise<ClaimOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const link = await findLink(sb, code);
  if (!link) return { status: 'invalid_code' };

  const { data: prior } = await sb.from('referrals').select('id').eq('referred_id', claimantId).limit(1);
  if ((prior as unknown[] | null)?.length) return { status: 'already_attributed' };

  const [{ fetchExcludedTestServiceAccountIds }, tenants, authUser] = await Promise.all([
    import('../../lib/excluded-test-service-accounts'),
    sb.from('user_tenants').select('tenant_id').eq('user_id', claimantId),
    deps.getAuthUser(claimantId),
  ]);
  const excluded = await fetchExcludedTestServiceAccountIds(sb);
  const reason = checkClaimEligibility({
    inviterId: link.user_id,
    claimantId,
    excluded,
    inviterTenantId: link.tenant_id,
    claimantTenantIds: ((tenants.data as Array<{ tenant_id: string }> | null) ?? []).map((t) => t.tenant_id),
    authUser,
    now,
  });
  if (reason) return { status: 'rejected', reason };

  const { data: inserted, error } = await sb.from('referrals').insert({
    tenant_id: link.tenant_id,
    referrer_id: link.user_id,
    referred_id: claimantId,
    source: 'member_invite',
    utm_source: 'member_invite',
    utm_campaign: 'community_autopilot',
    sharing_link_id: link.id,
    status: 'signed_up',
    activated_at: now.toISOString(),
  }).select('id');
  if (error) {
    // The unique index: a concurrent claim won.
    if (/duplicate|unique|23505/i.test(`${(error as any).code ?? ''} ${error.message ?? ''}`)) return { status: 'already_attributed' };
    return { status: 'rejected', reason: 'store_failed' };
  }
  const referralId = (inserted as Array<{ id: string }> | null)?.[0]?.id ?? '';

  const reward = await maybeRewardInviter(sb, referralId, link.user_id, now);
  return { status: 'attributed', referral_id: referralId, rewarded: reward.rewarded, reward_reason: reward.reason, credits: reward.credits };
}

async function maybeRewardInviter(sb: SupabaseClient, referralId: string, inviterId: string, now: Date): Promise<{ rewarded: boolean; reason?: string; credits?: number }> {
  if (!referralId) return { rewarded: false, reason: 'no_referral_row' };
  if (!isInviteRewardEnabled()) return { rewarded: false, reason: 'reward_disabled' };
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const { data: recent } = await sb.from('referrals').select('id').eq('referrer_id', inviterId).eq('status', 'rewarded').gte('rewarded_at', since);
  if (((recent as unknown[] | null)?.length ?? 0) >= INVITE_REWARD_MONTHLY_CAP) return { rewarded: false, reason: 'monthly_cap' };

  const credits = inviteRewardCredits();
  // Exactly once: only the call that moves signed_up → rewarded may credit.
  const { data: moved } = await sb.from('referrals')
    .update({ status: 'rewarded', rewarded_at: now.toISOString(), reward_amount: credits })
    .eq('id', referralId).eq('status', 'signed_up').select('id');
  if (!(moved as unknown[] | null)?.length) return { rewarded: false, reason: 'already_rewarded' };

  const { error } = await sb.rpc('increment_wallet_balance', { p_user_id: inviterId, p_currency_type: 'CREDITS', p_amount: credits });
  if (error) {
    await sb.from('referrals').update({ status: 'signed_up', rewarded_at: null, reward_amount: null }).eq('id', referralId).eq('status', 'rewarded');
    return { rewarded: false, reason: 'credit_failed' };
  }
  return { rewarded: true, credits };
}
