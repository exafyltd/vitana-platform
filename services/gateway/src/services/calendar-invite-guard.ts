/**
 * VTID-05104 — guards for sending a calendar invite through the messenger
 * (Calendar invites, phase 1).
 *
 * One entry point, `checkInviteSend`, used by the app DM route, the group
 * route and the voice tool. Rules, in order:
 *   1. Neither sender nor receiver is a test/service account
 *      (`service_bot_accounts` + `notification_test_actors`, Part 1 rules
 *      43-45). Strict, fail-closed lookup.
 *   2. Same tenant (DM only).
 *   3. A relationship exists (DM only): a prior non-invite direct message in
 *      either direction, a shared chat group, or a follow in either direction.
 *   4. Quotas, counted from existing chat_messages rows (no new table):
 *      per sender per rolling 24h, per sender->recipient pair per rolling 7d.
 *   5. Group invites: the sender is a member and the group is not larger than
 *      the cap; counts as one against the daily quota.
 *
 * Every lookup fails CLOSED, and every refusal answers with the same single
 * code so a caller can never learn which rule failed (no member enumeration).
 * The reason is logged server-side only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchExcludedTestServiceAccountIdsStrict } from '../lib/excluded-test-service-accounts';
import { isVitanaBot } from '../lib/vitana-bot';

const LOG_PREFIX = '[CalendarInviteGuard]';

export const CALENDAR_INVITE_MESSAGE_TYPE = 'calendar_invite';

/** The one outward-facing refusal, whatever rule failed. */
export const INVITE_REFUSED_CODE = 'invite_not_allowed';
export const INVITE_REFUSED_STATUS = 403;
export const inviteRefusedBody = () => ({ ok: false as const, error: INVITE_REFUSED_CODE });

export const DEFAULT_MAX_PER_DAY = 30;
export const DEFAULT_MAX_PER_PAIR_WEEK = 5;
export const DEFAULT_MAX_GROUP_MEMBERS = 20;

const DAY_MS = 24 * 3_600_000;
const WEEK_MS = 7 * DAY_MS;
const ROW_LIMIT = 1000;

export interface InviteLimits {
  maxPerDay: number;
  maxPerPairWeek: number;
  maxGroupMembers: number;
}

export type InviteCheckResult = { ok: true } | { ok: false; code: typeof INVITE_REFUSED_CODE };

export interface InviteCheckInput {
  sb: SupabaseClient;
  senderId: string;
  tenantId: string | null | undefined;
  receiverId?: string | null;
  groupId?: string | null;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function inviteLimits(env: NodeJS.ProcessEnv = process.env): InviteLimits {
  return {
    maxPerDay: positiveInt(env.CALENDAR_INVITE_MAX_PER_DAY, DEFAULT_MAX_PER_DAY),
    maxPerPairWeek: positiveInt(env.CALENDAR_INVITE_MAX_PER_PAIR_WEEK, DEFAULT_MAX_PER_PAIR_WEEK),
    maxGroupMembers: positiveInt(env.CALENDAR_INVITE_MAX_GROUP_MEMBERS, DEFAULT_MAX_GROUP_MEMBERS),
  };
}

/** True when any of the given user ids is on the test/service allowlist. */
export function involvesExcludedAccount(excluded: ReadonlySet<string>, ...userIds: Array<string | null | undefined>): boolean {
  return userIds.some((id) => !!id && excluded.has(String(id)));
}

export interface SentInviteRow {
  receiver_id: string | null;
  created_at: string;
}

/** Quota verdict for one more invite, from the sender's recent invite rows. */
export function evaluateInviteQuota(
  rows: ReadonlyArray<SentInviteRow>,
  receiverId: string | null,
  now: Date,
  limits: InviteLimits,
): { allowed: boolean; reason?: 'daily_limit' | 'pair_week_limit' } {
  const nowMs = now.getTime();
  let day = 0;
  let pairWeek = 0;
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t)) continue;
    const age = nowMs - t;
    if (age < 0 || age > WEEK_MS) continue;
    if (age <= DAY_MS) day += 1;
    if (receiverId && r.receiver_id === receiverId) pairWeek += 1;
  }
  if (day >= limits.maxPerDay) return { allowed: false, reason: 'daily_limit' };
  if (receiverId && pairWeek >= limits.maxPerPairWeek) return { allowed: false, reason: 'pair_week_limit' };
  return { allowed: true };
}

/** A group may take an invite when the sender is in it and it is not larger than the cap. */
export function groupAllowsInvite(memberIds: ReadonlyArray<string>, senderId: string, maxMembers: number): boolean {
  return memberIds.length <= maxMembers && memberIds.includes(senderId);
}

// ---------------------------------------------------------------------------
// Lookups (all throw on a database error; the caller fails closed)
// ---------------------------------------------------------------------------

async function rows<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(`${what}: ${error.message}`);
  return ((data as T[] | null) ?? []) as T[];
}

async function sameTenant(sb: SupabaseClient, tenantId: string, senderId: string, receiverId: string): Promise<boolean> {
  const found = await rows<{ user_id: string; tenant_id: string | null }>(
    sb.from('app_users').select('user_id, tenant_id').in('user_id', [senderId, receiverId]),
    'app_users',
  );
  const tenantOf = (id: string) => found.find((r) => r.user_id === id)?.tenant_id ?? null;
  return tenantOf(senderId) === tenantId && tenantOf(receiverId) === tenantId;
}

/** (a) a prior non-invite direct message between the two, in either direction. */
export async function hasPriorDirectMessage(sb: SupabaseClient, tenantId: string, a: string, b: string): Promise<boolean> {
  for (const [from, to] of [[a, b], [b, a]]) {
    const hit = await rows<{ id: string }>(
      sb.from('chat_messages').select('id').eq('tenant_id', tenantId).eq('sender_id', from).eq('receiver_id', to)
        .neq('message_type', CALENDAR_INVITE_MESSAGE_TYPE).limit(1),
      'chat_messages(dm)',
    );
    if (hit.length > 0) return true;
  }
  return false;
}

/** (b) the two share a chat group (chat_group_members has no inactive state). */
export async function shareChatGroup(sb: SupabaseClient, a: string, b: string): Promise<boolean> {
  const mine = await rows<{ group_id: string }>(
    sb.from('chat_group_members').select('group_id').eq('user_id', a).limit(ROW_LIMIT),
    'chat_group_members(mine)',
  );
  const groupIds = mine.map((r) => r.group_id).filter(Boolean);
  if (groupIds.length === 0) return false;
  const common = await rows<{ group_id: string }>(
    sb.from('chat_group_members').select('group_id').eq('user_id', b).in('group_id', groupIds).limit(1),
    'chat_group_members(common)',
  );
  return common.length > 0;
}

/** (c) a follow relation in either direction. */
export async function followsEitherWay(sb: SupabaseClient, a: string, b: string): Promise<boolean> {
  for (const [follower, following] of [[a, b], [b, a]]) {
    const hit = await rows<{ id: string }>(
      sb.from('user_follows').select('id').eq('follower_id', follower).eq('following_id', following).limit(1),
      'user_follows',
    );
    if (hit.length > 0) return true;
  }
  return false;
}

async function recentInvites(sb: SupabaseClient, tenantId: string, senderId: string, now: Date): Promise<SentInviteRow[]> {
  // tenant_id + sender_id + a bounded created_at window ride the existing
  // (tenant_id, sender_id, created_at DESC) index; message_type is filtered
  // inside that small, sender-bounded range.
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  return rows<SentInviteRow>(
    sb.from('chat_messages').select('receiver_id, created_at').eq('tenant_id', tenantId).eq('sender_id', senderId)
      .gte('created_at', since).eq('message_type', CALENDAR_INVITE_MESSAGE_TYPE).limit(ROW_LIMIT),
    'chat_messages(invites)',
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function checkInviteSend(input: InviteCheckInput): Promise<InviteCheckResult> {
  const refuse = (reason: string): InviteCheckResult => {
    // The reason stays on the server; the caller only ever sees the generic code.
    console.warn(`${LOG_PREFIX} refused (${reason}) sender=${input.senderId}`);
    return { ok: false, code: INVITE_REFUSED_CODE };
  };
  try {
    const { sb, senderId, receiverId, groupId } = input;
    const tenantId = input.tenantId;
    const now = input.now ?? new Date();
    const limits = inviteLimits(input.env);
    if (!sb || !senderId || !tenantId) return refuse('missing_context');
    if ((!receiverId && !groupId) || (receiverId && groupId)) return refuse('bad_target');
    if (receiverId && (receiverId === senderId || isVitanaBot(receiverId))) return refuse('bad_receiver');

    // 1. test / service accounts, strict.
    const excluded = await fetchExcludedTestServiceAccountIdsStrict(sb);
    if (!excluded.ok) return refuse('allowlist_lookup_failed');
    if (involvesExcludedAccount(excluded.ids, senderId, receiverId)) return refuse('test_account');

    if (receiverId) {
      // 2. same tenant.
      if (!(await sameTenant(sb, tenantId, senderId, receiverId))) return refuse('tenant');
      // 3. relationship.
      const related =
        (await hasPriorDirectMessage(sb, tenantId, senderId, receiverId)) ||
        (await shareChatGroup(sb, senderId, receiverId)) ||
        (await followsEitherWay(sb, senderId, receiverId));
      if (!related) return refuse('no_relationship');
    } else {
      // 5. group: sender is a member and the group is small enough.
      const members = await rows<{ user_id: string }>(
        sb.from('chat_group_members').select('user_id').eq('group_id', groupId as string).limit(limits.maxGroupMembers + 1),
        'chat_group_members(group)',
      );
      if (!groupAllowsInvite(members.map((m) => m.user_id), senderId, limits.maxGroupMembers)) return refuse('group');
    }

    // 4. quotas.
    const quota = evaluateInviteQuota(await recentInvites(sb, tenantId, senderId, now), receiverId ?? null, now, limits);
    if (!quota.allowed) return refuse(quota.reason ?? 'quota');

    return { ok: true };
  } catch (err) {
    return refuse(`lookup_error:${err instanceof Error ? err.message : 'unknown'}`);
  }
}
