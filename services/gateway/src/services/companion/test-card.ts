/**
 * VTID-05588 (companion-test-card/gateway-test-card) — an exafy admin sends one
 * Vitana companion card to themselves, now (POST /api/v1/companion/test-card).
 *
 * It builds the caller's MemberContext the way the tick does for one member,
 * runs the moment's own build(), composes through composeCompanionMessage
 * (Bedrock-only by construction, composer.ts) and writes exactly one Vitana-bot
 * DM with the same metadata a tick message carries plus `test: true`.
 *
 * It deliberately does NOT claim or finish a ledger row, record a pacer touch,
 * send a push or emit companion.message.sent: a test card never costs the
 * admin's real morning message and never shows in member metrics. The audit
 * trail is one companion.test_card.sent OASIS event.
 *
 * Only `vitana_index` is offered. The context built here leaves the optional
 * signal and enrichment fields unset, which is correct because
 * vitanaIndex.build() reads only ctx.vitanaIndex; another moment must populate
 * the fields it reads before it is added.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { VITANA_BOT_USER_ID } from '../../lib/vitana-bot';
import { getUserLocale } from '../../i18n/server-locale';
import { emitOasisEvent } from '../oasis-event-service';
import { fetchVitanaIndexForProfiler, type VitanaIndexSnapshot } from '../user-context-profiler';
import * as repo from './companion-repository';
import { composeCompanionMessage, type ComposeResult } from './composer';
import { isSendMode, type CompanionConfig } from './config';
import { buildCompanionMetadata } from './delivery';
import { localTime } from './local-time';
import { vitanaIndex, type MemberContext, type Moment, type MomentCandidate } from './moments';

export const TEST_CARD_VTID = 'VTID-05588';

/** The moments an admin may send to themselves (each must be buildable from the context below). */
export const TEST_CARD_MOMENTS: Readonly<Record<string, Moment>> = { vitana_index: vitanaIndex };
export type TestCardMomentKey = 'vitana_index';

export interface TestCardDeps {
  /** Service-role client: the row's sender is the Vitana bot, not the caller. */
  sb: SupabaseClient;
  config: CompanionConfig;
  now?: Date;
  fetchIndex?: (sb: SupabaseClient, userId: string) => Promise<VitanaIndexSnapshot | null>;
  compose?: (ctx: MemberContext, moment: MomentCandidate, config: CompanionConfig) => Promise<ComposeResult>;
  locale?: (sb: SupabaseClient, userId: string) => Promise<string>;
  emit?: typeof emitOasisEvent;
}

export interface TestCardInput {
  userId: string;
  /** Tenant from the verified token; used only when the caller has no primary membership row. */
  tokenTenantId?: string | null;
  momentKey: TestCardMomentKey;
}

export type TestCardResult =
  | { ok: true; chat_message_id: string | null; moment_key: string; card_type: string | null; text: string }
  | { ok: false; status: number; error: string; mode?: string; detail?: string };

async function primaryTenant(sb: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await sb
    .from('user_tenants')
    .select('user_id, tenant_id')
    .eq('user_id', userId)
    .eq('is_primary', true)
    .maybeSingle();
  if (error) throw new Error(`user_tenants: ${error.message}`);
  return ((data as { tenant_id?: string } | null)?.tenant_id) ?? null;
}

async function profile(sb: SupabaseClient, userId: string): Promise<{ first_name: string | null; timezone: string | null }> {
  const { data, error } = await sb
    .from('profiles')
    .select('user_id, first_name, timezone')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`profiles: ${error.message}`);
  const p = (data as { first_name?: string | null; timezone?: string | null } | null) ?? {};
  return { first_name: p.first_name ?? null, timezone: p.timezone ?? null };
}

export async function sendCompanionTestCard(deps: TestCardDeps, input: TestCardInput): Promise<TestCardResult> {
  const { sb, config } = deps;
  if (config.mode === 'disabled-on-staging') {
    return { ok: false, status: 409, error: 'STAGING_DISABLED', mode: config.mode };
  }
  if (!isSendMode(config.mode)) {
    return { ok: false, status: 409, error: 'SEND_NOT_AVAILABLE', mode: config.mode };
  }

  const moment = TEST_CARD_MOMENTS[input.momentKey];
  if (!moment) return { ok: false, status: 400, error: 'VALIDATION' };

  const now = deps.now ?? new Date();
  const fetchIndex = deps.fetchIndex ?? fetchVitanaIndexForProfiler;
  const compose = deps.compose ?? composeCompanionMessage;
  const locale = deps.locale ?? ((c: SupabaseClient, id: string) => getUserLocale(c, id));
  const emit = deps.emit ?? emitOasisEvent;

  const [tenantRow, p] = await Promise.all([primaryTenant(sb, input.userId), profile(sb, input.userId)]);
  const tenantId = tenantRow ?? input.tokenTenantId ?? null;
  if (!tenantId) return { ok: false, status: 422, error: 'NO_TENANT' };

  let index: VitanaIndexSnapshot | null = null;
  try { index = await fetchIndex(sb, input.userId); } catch { index = null; }

  const ctx: MemberContext = {
    userId: input.userId,
    tenantId,
    firstName: p.first_name,
    locale: (await locale(sb, input.userId)) ?? 'de',
    localDate: localTime(now, p.timezone).date,
    topics: { health: true, community: true, business: false },
    vitanaIndex: index,
    lastUsed: {},
  };

  const candidate = moment.build(ctx);
  if (!candidate) return { ok: false, status: 422, error: 'NO_VITANA_INDEX' };

  const composed = await compose(ctx, candidate, config);
  if (!composed.ok) return { ok: false, status: 502, error: 'COMPOSE_FAILED', detail: composed.error };

  const metadata = {
    ...buildCompanionMetadata({ momentKey: candidate.momentKey, cardType: candidate.cardType, facts: candidate.facts }),
    test: true,
  };
  const inserted = await repo.insertCompanionChatMessage(sb, {
    tenant_id: tenantId,
    sender_id: VITANA_BOT_USER_ID,
    receiver_id: input.userId,
    content: composed.text,
    message_type: 'text',
    metadata,
  });
  if (inserted.error) return { ok: false, status: 502, error: 'INSERT_FAILED', detail: inserted.error };

  await emit({
    vtid: TEST_CARD_VTID, type: 'companion.test_card.sent', source: 'companion-messages', status: 'success',
    message: `companion test card sent to the requesting admin (${candidate.momentKey})`,
    payload: {
      actor_user_id: input.userId, moment_key: candidate.momentKey, card_type: candidate.cardType,
      chat_message_id: inserted.id, mode: config.mode, model: composed.model,
    },
    actor_id: input.userId, actor_role: 'admin', surface: 'api',
  }).catch(() => undefined);

  return {
    ok: true, chat_message_id: inserted.id, moment_key: candidate.momentKey, card_type: candidate.cardType,
    text: composed.text,
  };
}
