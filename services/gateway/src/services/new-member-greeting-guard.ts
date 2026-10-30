/**
 * VTID-05207 — server-side guard for a "Say Hello 👋" greeting DM.
 *
 * Plan `.kiro/specs/new-member-welcome/plan-sparring.md` Part B, round-3
 * finding F10, round-4 finding F13 (owner decision D2 = b: the greeting is a
 * private DM sent on the member's explicit Send, never a public comment and
 * never auto-sent).
 *
 * `POST /api/v1/chat/send` lets any member send a plain text DM today with no
 * block/mute/rate check (the VTID-05104 `checkInviteSend` guard covers only
 * calendar invites). That plain-DM path is unchanged and out of scope here.
 * A DM tagged `metadata.source = 'new_member_greeting'` is, by the card, a
 * greeting to a newcomer — so this guard adds restrictions ON TOP of the
 * ordinary DM path for that tag only. Omitting the tag only makes it an
 * ordinary DM (exactly what any member can send today), so the tag can never
 * be used to BYPASS a restriction, only to opt into these extra ones.
 *
 * Modelled on `calendar-invite-guard.ts`: every lookup fails CLOSED and every
 * refusal answers with ONE generic code, so a caller cannot learn which rule
 * failed (no member enumeration). The real reason is logged server-side only.
 *
 * Rules, all of which must hold for a greeting to be allowed:
 *   (a) the receiver has NOT blocked or muted the sender
 *       (`user_blocked_authors` / `user_muted_authors`);
 *   (b) the receiver has `community_intro_opt_in = true` AND joined within the
 *       7-day card window (`global_community_profiles.created_at`);
 *   (c) neither party is a test/service/automation account
 *       (`service_bot_accounts` ∪ `notification_test_actors`, strict/fail-closed);
 *   (d) no earlier greeting DM from THIS sender to THIS receiver exists — the
 *       SELECT is bounded by sender_id + receiver_id + the 7-day window FIRST,
 *       then the `metadata.source` tag is tested, so it rides the existing
 *       (sender_id, receiver_id, created_at) index range and never does an
 *       unindexed `metadata->>'source'` scan (finding F13);
 *   (e) the sender is under a per-sender hourly greeting cap.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchExcludedTestServiceAccountIdsStrict } from '../lib/excluded-test-service-accounts';
import { isVitanaBot } from '../lib/vitana-bot';

const LOG_PREFIX = '[NewMemberGreetingGuard]';

/** The metadata.source value a greeting DM carries. */
export const NEW_MEMBER_GREETING_SOURCE = 'new_member_greeting';

/** The one outward-facing refusal, whatever rule failed. */
export const GREETING_REFUSED_CODE = 'greeting_not_allowed';
export const GREETING_REFUSED_STATUS = 403;
export const greetingRefusedBody = () => ({ ok: false as const, error: GREETING_REFUSED_CODE });

/** 7-day card window — a newcomer is greetable only while their card shows. */
export const GREETING_CARD_WINDOW_MS = 7 * 24 * 3_600_000;
export const DEFAULT_MAX_PER_SENDER_HOUR = 20;
const HOUR_MS = 3_600_000;
const ROW_LIMIT = 1000;

export type GreetingCheckResult = { ok: true } | { ok: false; code: typeof GREETING_REFUSED_CODE };

export interface GreetingCheckInput {
  sb: SupabaseClient;
  senderId: string;
  receiverId: string | null | undefined;
  tenantId: string | null | undefined;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a database)
// ---------------------------------------------------------------------------

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function greetingMaxPerSenderHour(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.NEW_MEMBER_GREETING_MAX_PER_SENDER_HOUR, DEFAULT_MAX_PER_SENDER_HOUR);
}

export interface NewMemberProfileRow {
  community_intro_opt_in: boolean | null;
  created_at: string | null;
}

/**
 * (b) the receiver is an opted-in newcomer still inside the 7-day card window.
 */
export function receiverIsGreetableNewcomer(
  row: NewMemberProfileRow | null | undefined,
  now: Date,
): boolean {
  if (!row || row.community_intro_opt_in !== true) return false;
  const joined = row.created_at ? Date.parse(row.created_at) : NaN;
  if (!Number.isFinite(joined)) return false;
  const age = now.getTime() - joined;
  return age >= 0 && age <= GREETING_CARD_WINDOW_MS;
}

export interface SentGreetingRow {
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/** True when a row is a greeting (tag tested AFTER the bounded fetch, F13). */
export function isGreetingRow(row: SentGreetingRow): boolean {
  return !!row.metadata && row.metadata.source === NEW_MEMBER_GREETING_SOURCE;
}

/**
 * (d) + (e) over the sender's recent DMs to this receiver (already bounded by
 * sender_id + receiver_id + the 7-day window). `pairGreetingExists` enforces
 * one greeting per pair; `hourlyCount` feeds the per-sender cap.
 */
export function evaluateGreetingHistory(
  pairRows: ReadonlyArray<SentGreetingRow>,
  senderHourRows: ReadonlyArray<SentGreetingRow>,
  now: Date,
  maxPerHour: number,
): { allowed: boolean; reason?: 'already_greeted' | 'hourly_cap' } {
  const nowMs = now.getTime();

  // (d) one greeting per sender→receiver pair.
  for (const r of pairRows) {
    if (isGreetingRow(r)) return { allowed: false, reason: 'already_greeted' };
  }

  // (e) per-sender hourly cap, counting only greeting rows in the last hour.
  let inHour = 0;
  for (const r of senderHourRows) {
    if (!isGreetingRow(r)) continue;
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t)) continue;
    const age = nowMs - t;
    if (age >= 0 && age <= HOUR_MS) inHour += 1;
  }
  if (inHour >= maxPerHour) return { allowed: false, reason: 'hourly_cap' };

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Lookups (all throw on a database error; the caller fails closed)
// ---------------------------------------------------------------------------

async function rows<T>(
  q: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  what: string,
): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(`${what}: ${error.message}`);
  return ((data as T[] | null) ?? []) as T[];
}

async function maybeRow<T>(
  q: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  what: string,
): Promise<T | null> {
  const { data, error } = await q;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data as T | null) ?? null;
}

/** (a) the receiver has blocked the sender. */
export async function receiverBlockedSender(sb: SupabaseClient, receiverId: string, senderId: string): Promise<boolean> {
  const hit = await rows<{ author_id: string }>(
    sb.from('user_blocked_authors').select('author_id').eq('user_id', receiverId).eq('author_id', senderId).limit(1),
    'user_blocked_authors',
  );
  return hit.length > 0;
}

/** (a) the receiver has muted the sender. */
export async function receiverMutedSender(sb: SupabaseClient, receiverId: string, senderId: string): Promise<boolean> {
  const hit = await rows<{ author_id: string }>(
    sb.from('user_muted_authors').select('author_id').eq('user_id', receiverId).eq('author_id', senderId).limit(1),
    'user_muted_authors',
  );
  return hit.length > 0;
}

/** (b) the receiver's opt-in + join time from global_community_profiles. */
export async function fetchNewMemberProfile(sb: SupabaseClient, receiverId: string): Promise<NewMemberProfileRow | null> {
  return maybeRow<NewMemberProfileRow>(
    sb.from('global_community_profiles').select('community_intro_opt_in, created_at').eq('user_id', receiverId).maybeSingle(),
    'global_community_profiles',
  );
}

/**
 * (d) the sender's DMs to this receiver inside the 7-day window, bounded by
 * sender_id + receiver_id + created_at BEFORE the tag is tested (F13). The
 * window matches the card window, so an earlier greeting to a still-greetable
 * newcomer is always in range.
 *
 * Newest first so the bounded read is deterministic. The per-pair check is
 * best-effort under concurrency (read-then-send, not atomic): two simultaneous
 * sends could both pass. That is acceptable because the hourly per-sender cap
 * and the push grouping bound the effect.
 */
export async function fetchPairDms(sb: SupabaseClient, senderId: string, receiverId: string, now: Date): Promise<SentGreetingRow[]> {
  const since = new Date(now.getTime() - GREETING_CARD_WINDOW_MS).toISOString();
  return rows<SentGreetingRow>(
    sb.from('chat_messages').select('created_at, metadata')
      .eq('sender_id', senderId).eq('receiver_id', receiverId).gte('created_at', since).order('created_at', { ascending: false }).limit(ROW_LIMIT),
    'chat_messages(pair)',
  );
}

/**
 * (e) the sender's DMs in the last hour (any receiver), bounded by sender_id +
 * created_at; the tag is tested in the pure helper.
 */
export async function fetchSenderHourDms(sb: SupabaseClient, senderId: string, now: Date): Promise<SentGreetingRow[]> {
  const since = new Date(now.getTime() - HOUR_MS).toISOString();
  return rows<SentGreetingRow>(
    sb.from('chat_messages').select('created_at, metadata')
      .eq('sender_id', senderId).gte('created_at', since).order('created_at', { ascending: false }).limit(ROW_LIMIT),
    'chat_messages(sender_hour)',
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function checkGreetingSend(input: GreetingCheckInput): Promise<GreetingCheckResult> {
  const refuse = (reason: string): GreetingCheckResult => {
    // The reason stays on the server; the caller only ever sees the generic code.
    console.warn(`${LOG_PREFIX} refused (${reason}) sender=${input.senderId}`);
    return { ok: false, code: GREETING_REFUSED_CODE };
  };
  try {
    const { sb, senderId, receiverId } = input;
    const now = input.now ?? new Date();
    const maxPerHour = greetingMaxPerSenderHour(input.env);
    if (!sb || !senderId || !receiverId) return refuse('missing_context');
    if (receiverId === senderId || isVitanaBot(receiverId)) return refuse('bad_receiver');

    // (c) test / service / automation accounts, strict/fail-closed.
    const excluded = await fetchExcludedTestServiceAccountIdsStrict(sb);
    if (!excluded.ok) return refuse('allowlist_lookup_failed');
    if (excluded.ids.has(senderId) || excluded.ids.has(receiverId)) return refuse('test_account');

    // (a) block / mute.
    if (await receiverBlockedSender(sb, receiverId, senderId)) return refuse('blocked');
    if (await receiverMutedSender(sb, receiverId, senderId)) return refuse('muted');

    // (b) opted-in newcomer still inside the 7-day card window.
    const profile = await fetchNewMemberProfile(sb, receiverId);
    if (!receiverIsGreetableNewcomer(profile, now)) return refuse('not_greetable_newcomer');

    // (d) one greeting per pair + (e) per-sender hourly cap.
    const [pairRows, senderHourRows] = await Promise.all([
      fetchPairDms(sb, senderId, receiverId, now),
      fetchSenderHourDms(sb, senderId, now),
    ]);
    const history = evaluateGreetingHistory(pairRows, senderHourRows, now, maxPerHour);
    if (!history.allowed) return refuse(history.reason ?? 'history');

    return { ok: true };
  } catch (err) {
    return refuse(`lookup_error:${err instanceof Error ? err.message : 'unknown'}`);
  }
}
