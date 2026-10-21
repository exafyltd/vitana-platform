/**
 * VTID-05205 — the welcome-team tick: three private welcome DMs for each new
 * member, from Mariia (day 0), Jovana (day 1) and Alex Blue (day 2).
 * Plan: .kiro/specs/new-member-welcome/plan-sparring.md, Part A.
 *
 * One tick, in order:
 *   1. mode gate (config.ts): only shadow and live do anything; staging never.
 *   2. strict exclusion (service_bot_accounts ∪ notification_test_actors). A
 *      failed lookup skips the whole tick before any write — "could not tell"
 *      never means "not excluded" (CLAUDE.md rules 43–45).
 *   3. recipients: pilot allowlist (default) or the cohort (joined at/after
 *      WELCOME_ROLLOUT_AT). A sender never gets their own welcome.
 *   4. per member, at most ONE welcome per tick: the first sender (by stagger
 *      offset) whose welcome is due, has no claim yet (or one failed attempt),
 *      and is at least minGapHours after the member's previous welcome.
 *   5. live only: claim_welcome_message → the DM (chat_messages, authored by the
 *      sender's own account, so a reply lands in that sender's inbox) → one
 *      push like any DM → finish_welcome_message. Shadow writes nothing.
 *
 * Texts are tt() catalog entries (S1): written messages from named people,
 * not spoken lines, so CLAUDE.md rule 41 does not apply; the catalog rule does.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { fetchExcludedTestServiceAccountIdsStrict } from '../../lib/excluded-test-service-accounts';
import { tt, type GatewayI18nKey } from '../../i18n/catalog';
import { getUserLocale } from '../../i18n/server-locale';
import { notifyUser } from '../notification-service';
import { emitOasisEvent } from '../oasis-event-service';
import { resolveWelcomeTeamConfig, type WelcomeSender, type WelcomeSenderSlug, type WelcomeTeamConfig } from './config';
import * as repo from './welcome-team-repository';

export const WELCOME_TEAM_VTID = 'VTID-05205';
export const WELCOME_TEAM_SOURCE = 'welcome_team';
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ── Pure decision ─────────────────────────────────────────────────────────────

export interface MemberClaims {
  /** Claim per sender for this member. */
  bySender: Partial<Record<WelcomeSenderSlug, Pick<repo.ClaimRow, 'status' | 'attempts' | 'sent_at' | 'updated_at'>>>;
}

export type WelcomeDecision =
  | { send: true; sender: WelcomeSender }
  | { send: false; reason: string };

/**
 * Which welcome (if any) this member gets now. `baseline` is the moment the
 * member counts as registered for the stagger (their join time, or the rollout
 * time for a pilot member who joined before it).
 */
export function decideWelcome(input: {
  now: Date;
  baseline: Date;
  memberId: string;
  senders: WelcomeSender[];
  claims: MemberClaims;
  minGapHours: number;
  unavailableSenders: Set<WelcomeSenderSlug>;
}): WelcomeDecision {
  const { now, baseline, memberId, claims, minGapHours } = input;
  const ordered = [...input.senders].sort((a, b) => a.staggerDays - b.staggerDays);

  // The member's previous welcome: a sent one, or an attempt still in flight.
  let lastTouch = 0;
  for (const c of Object.values(claims.bySender)) {
    if (!c) continue;
    if (c.status === 'sent' && c.sent_at) lastTouch = Math.max(lastTouch, new Date(c.sent_at).getTime());
    if (c.status === 'pending') lastTouch = Math.max(lastTouch, new Date(c.updated_at).getTime());
  }

  let firstReason = 'all_sent';
  for (const s of ordered) {
    const c = claims.bySender[s.slug];
    if (c && (c.status === 'sent' || c.status === 'pending')) continue;
    if (c && c.status === 'failed' && c.attempts >= 2) continue; // retry spent
    if (s.userId === memberId) continue; // a sender never welcomes themselves
    if (input.unavailableSenders.has(s.slug)) { firstReason = 'sender_unavailable'; continue; }
    if (now.getTime() < baseline.getTime() + s.staggerDays * DAY) return { send: false, reason: 'not_due' };
    if (lastTouch > 0 && now.getTime() - lastTouch < minGapHours * HOUR) return { send: false, reason: 'min_gap' };
    return { send: true, sender: s };
  }
  return { send: false, reason: firstReason };
}

/** First name for {name}; null when the profile gives nothing usable. */
export function firstName(displayName: string | null | undefined): string | null {
  const first = (displayName ?? '').trim().replace(/^@+/, '').split(/\s+/)[0] ?? '';
  if (!first) return null;
  return first.length > 40 ? first.slice(0, 40) : first;
}

export function welcomeTextKey(slug: WelcomeSenderSlug, hasName: boolean): GatewayI18nKey {
  return (hasName ? `welcome_team.${slug}.body` : `welcome_team.${slug}.body_noname`) as GatewayI18nKey;
}

/** The member's locale if its welcome texts passed review, else English (S1 locale gate). */
export function welcomeLocale(memberLocale: string, ready: Set<string>): string {
  const lc = (memberLocale || '').toLowerCase().slice(0, 2);
  return ready.has(lc) ? lc : 'en';
}

export function composeWelcome(slug: WelcomeSenderSlug, locale: string, displayName: string | null): string {
  const name = firstName(displayName);
  return tt(welcomeTextKey(slug, !!name), locale, name ? { name } : undefined);
}

// ── The tick ─────────────────────────────────────────────────────────────────

export interface WelcomeTickResult {
  ok: boolean;
  mode: WelcomeTeamConfig['mode'];
  reason: string;
  tick_id?: string;
  candidates?: number;
  excluded?: number;
  would_send?: Record<WelcomeSenderSlug, number>;
  sent?: Record<WelcomeSenderSlug, number>;
  failed?: number;
  skipped?: Record<string, number>;
  capped?: boolean;
  error?: string;
}

export interface WelcomeTickDeps {
  sb: SupabaseClient;
  now?: Date;
  config?: WelcomeTeamConfig;
  emit?: typeof emitOasisEvent;
  notify?: typeof notifyUser;
  locale?: (sb: SupabaseClient, userId: string) => Promise<string>;
}

const zeroBySender = (): Record<WelcomeSenderSlug, number> => ({ mariia: 0, jovana: 0, alex: 0 });

export async function runWelcomeTeamTick(deps: WelcomeTickDeps): Promise<WelcomeTickResult> {
  const { sb } = deps;
  const now = deps.now ?? new Date();
  const config = deps.config ?? resolveWelcomeTeamConfig();
  const emit = deps.emit ?? emitOasisEvent;
  const notify = deps.notify ?? notifyUser;
  const locale = deps.locale ?? ((c: SupabaseClient, id: string) => getUserLocale(c, id));

  if ((config.mode !== 'shadow' && config.mode !== 'live') || !config.rolloutAt) {
    return { ok: true, mode: config.mode, reason: config.reason };
  }
  const rolloutAt = config.rolloutAt;

  const excluded = await fetchExcludedTestServiceAccountIdsStrict(sb);
  if (!excluded.ok) return { ok: false, mode: config.mode, reason: 'exclusion_unavailable', error: excluded.error };

  // Recipients. Pilot (default): only allowlisted members, each counted as
  // registered no earlier than the rollout. All: the post-rollout cohort.
  let memberships: repo.MembershipRow[];
  if (config.audience === 'pilot') {
    memberships = await repo.fetchMembershipsFor(sb, config.tenantId, [...config.pilotUserIds]);
  } else {
    memberships = await repo.fetchCohortMembers(sb, config.tenantId, rolloutAt.toISOString());
  }
  const members = memberships.filter((m) => !excluded.ids.has(m.user_id));

  const tickId = randomUUID();
  const skipped: Record<string, number> = {};
  const skip = (r: string) => { skipped[r] = (skipped[r] ?? 0) + 1; };
  const wouldSend = zeroBySender();
  const sent = zeroBySender();
  let failed = 0;
  let capped = false;

  const senderIds = config.senders.map((s) => s.userId);
  const [claimRows, appUsers] = await Promise.all([
    repo.fetchClaims(sb, members.map((m) => m.user_id)),
    repo.fetchAppUsers(sb, [...new Set([...members.map((m) => m.user_id), ...senderIds])]),
  ]);
  const appUserBy = new Map(appUsers.map((u) => [u.user_id, u]));

  // A sender is usable only if their account exists and is not a test/service account.
  const unavailable = new Set<WelcomeSenderSlug>();
  for (const s of config.senders) {
    if (excluded.ids.has(s.userId) || !appUserBy.has(s.userId)) unavailable.add(s.slug);
  }

  const claimsBy = new Map<string, MemberClaims>();
  for (const c of claimRows) {
    const mc = claimsBy.get(c.user_id) ?? { bySender: {} };
    mc.bySender[c.sender_slug] = c;
    claimsBy.set(c.user_id, mc);
  }

  for (const m of [...members].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const profile = appUserBy.get(m.user_id);
    if (!profile) { skip('registration_incomplete'); continue; }
    const joined = new Date(m.created_at);
    const baseline = config.audience === 'pilot' && joined < rolloutAt ? rolloutAt : joined;
    const d = decideWelcome({
      now, baseline, memberId: m.user_id, senders: config.senders,
      claims: claimsBy.get(m.user_id) ?? { bySender: {} },
      minGapHours: config.minGapHours, unavailableSenders: unavailable,
    });
    if (!d.send) { skip(d.reason); continue; }
    wouldSend[d.sender.slug] += 1;
    if (config.mode !== 'live') continue;

    if (sent.mariia + sent.jovana + sent.alex + failed >= config.maxSendsPerTick) { capped = true; skip('tick_cap'); continue; }

    const claim = await repo.claimWelcome(sb, m.user_id, m.tenant_id, d.sender.slug);
    if (!claim.ok) { skip('claim_error'); continue; }
    if (!claim.claimed) { skip(claim.reason); continue; }

    const ok = await deliverWelcome({
      sb, now, member: m, profile, sender: d.sender, senderProfile: appUserBy.get(d.sender.userId)!,
      config, notify, locale, emit,
    });
    if (ok) sent[d.sender.slug] += 1; else failed += 1;
  }

  const decided = wouldSend.mariia + wouldSend.jovana + wouldSend.alex;
  if (decided > 0 || failed > 0) {
    await emit({
      vtid: WELCOME_TEAM_VTID, type: 'welcome_team.tick.completed', source: 'welcome-team', status: failed > 0 ? 'warning' : 'success',
      message: `welcome-team tick (${config.mode}): ${decided} due, ${sent.mariia + sent.jovana + sent.alex} sent, ${failed} failed`,
      payload: { tick_id: tickId, mode: config.mode, audience: config.audience, would_send: wouldSend, sent, failed, skipped, capped },
      actor_role: 'system', surface: 'system',
    }).catch(() => undefined);
  }

  return {
    ok: true, mode: config.mode, reason: config.reason, tick_id: tickId,
    candidates: memberships.length, excluded: memberships.length - members.length,
    would_send: wouldSend, sent, failed, skipped, capped,
  };
}

async function deliverWelcome(input: {
  sb: SupabaseClient;
  now: Date;
  member: repo.MembershipRow;
  profile: repo.AppUserRow;
  sender: WelcomeSender;
  senderProfile: repo.AppUserRow;
  config: WelcomeTeamConfig;
  notify: typeof notifyUser;
  locale: (sb: SupabaseClient, userId: string) => Promise<string>;
  emit: typeof emitOasisEvent;
}): Promise<boolean> {
  const { sb, member, profile, sender, senderProfile, emit } = input;
  let lc = 'en';
  try { lc = welcomeLocale(await input.locale(sb, member.user_id), input.config.readyLocales); } catch { lc = 'en'; }
  const text = composeWelcome(sender.slug, lc, profile.display_name);

  let inserted: { id: string | null; error: string | null };
  try {
    inserted = await repo.insertWelcomeChatMessage(sb, {
      tenant_id: member.tenant_id,
      sender_id: sender.userId,
      receiver_id: member.user_id,
      content: text,
      message_type: 'text',
      metadata: { source: WELCOME_TEAM_SOURCE, sender_slug: sender.slug, vtid: WELCOME_TEAM_VTID, automated: true, done_by_vitana: false, locale: lc },
      ...(senderProfile.vitana_id ? { sender_vitana_id: senderProfile.vitana_id } : {}),
      ...(profile.vitana_id ? { receiver_vitana_id: profile.vitana_id } : {}),
    });
  } catch (err: any) {
    inserted = { id: null, error: err?.message ?? String(err) };
  }
  if (inserted.error) {
    await repo.finishWelcome(sb, member.user_id, sender.slug, 'failed', null).catch(() => undefined);
    await emit({
      vtid: WELCOME_TEAM_VTID, type: 'welcome_team.message.failed', source: 'welcome-team', status: 'error',
      message: `welcome DM insert failed (${sender.slug}): ${inserted.error}`,
      payload: { user_id: member.user_id, sender_slug: sender.slug, stage: 'insert' },
      actor_role: 'system', surface: 'system',
    }).catch(() => undefined);
    return false;
  }

  // One push, shaped like any DM from that person (chat.ts /send). A failed or
  // held push never undoes the DM — it is in the inbox either way.
  let pushed = false;
  try {
    const senderName = senderProfile.display_name?.trim() || 'MAXINA';
    const r = await input.notify(member.user_id, member.tenant_id, 'new_chat_message', {
      title: senderName,
      body: text.length > 100 ? `${text.slice(0, 97)}...` : text,
      data: {
        type: 'new_chat_message',
        sender_id: sender.userId,
        sender_name: senderName,
        thread_id: sender.userId,
        url: `/inbox/u/${sender.userId}`,
        ...(inserted.id ? { message_id: inserted.id } : {}),
      },
    }, sb);
    pushed = !!r && (r.pushed > 0 || r.inapp);
  } catch (err: any) {
    console.warn(`[welcome-team] push failed for ${member.user_id.slice(0, 8)}… (DM delivered): ${err?.message ?? err}`);
  }

  const fin = await repo.finishWelcome(sb, member.user_id, sender.slug, 'sent', inserted.id)
    .catch((err: any) => ({ ok: false, error: err?.message ?? String(err) }));
  if (!fin.ok) console.warn(`[welcome-team] finish(sent) failed for ${member.user_id.slice(0, 8)}…/${sender.slug}: ${fin.error}`);

  await emit({
    vtid: WELCOME_TEAM_VTID, type: 'welcome_team.message.sent', source: 'welcome-team', status: 'success',
    message: `welcome DM sent (${sender.slug})`,
    payload: { user_id: member.user_id, sender_slug: sender.slug, chat_message_id: inserted.id, locale: lc, pushed },
    actor_role: 'system', surface: 'system',
  }).catch(() => undefined);
  return true;
}
