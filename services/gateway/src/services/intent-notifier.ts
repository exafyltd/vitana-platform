/**
 * VTID-01975: Intent notifier — real fan-out (P2-B).
 *
 * Replaces the P2-A audit-only stub. Every match insert with score >= 0.7
 * fans out to:
 *   - the dictator (intent_a owner) via `intent_match_found_for_dictator`
 *   - the counterparty (intent_b owner) via `intent_lead_for_counterparty`
 *
 * Per-recipient cap: 3 marketplace-style intent notifications per kind
 * per rolling 24h. Buckets are PER KIND so a noisy commercial day cannot
 * squelch a partner reciprocal-reveal. P2-B uses an in-memory sliding
 * counter; P2-C swaps to Redis once the engine scales horizontally.
 *
 * Mutual-interest and reciprocal-reveal events are NOT counted against
 * the cap — they are bilateral high-priority transitions.
 */

import { emitOasisEvent } from './oasis-event-service';
import { notifyUserAsync } from './notification-service';
import { createClient } from '@supabase/supabase-js';
import type { MatchRow } from './intent-matcher';
import type { IntentKind } from './intent-classifier';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

// In-memory per-kind sliding window: key = `${user_id}::${intent_kind}`,
// value = list of timestamps (ms). Trimmed lazily.
const PER_KIND_CAP = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const counterMap = new Map<string, number[]>();

function counterKey(userId: string, kind: string): string {
  return `${userId}::${kind}`;
}

/**
 * FCM data payloads are Record<string, string>. Coerce all values to
 * strings, drop null/undefined entries.
 */
function dataToStringMap(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

function shiftWindow(key: string): number[] {
  const now = Date.now();
  const list = counterMap.get(key) ?? [];
  const trimmed = list.filter((t) => now - t < WINDOW_MS);
  counterMap.set(key, trimmed);
  return trimmed;
}

function recordHit(userId: string, kind: string): { allowed: boolean; remaining: number } {
  const key = counterKey(userId, kind);
  const trimmed = shiftWindow(key);
  if (trimmed.length >= PER_KIND_CAP) {
    return { allowed: false, remaining: 0 };
  }
  trimmed.push(Date.now());
  counterMap.set(key, trimmed);
  return { allowed: true, remaining: PER_KIND_CAP - trimmed.length };
}

interface NotifyArgs {
  match: MatchRow;
  kind: IntentKind;
}

interface IntentSummary {
  intent_id: string;
  user_id: string;
  vitana_id: string | null;
  tenant_id: string;
  category: string | null;
  title: string;
  intent_kind: IntentKind;
}

async function readIntent(intentId: string): Promise<IntentSummary | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('user_intents')
    .select('intent_id, requester_user_id, requester_vitana_id, tenant_id, category, title, intent_kind')
    .eq('intent_id', intentId)
    .maybeSingle();
  if (!data) return null;
  const d = data as any;
  return {
    intent_id: d.intent_id,
    user_id: d.requester_user_id,
    vitana_id: d.requester_vitana_id,
    tenant_id: d.tenant_id,
    category: d.category,
    title: d.title,
    intent_kind: d.intent_kind,
  };
}

const MUTUAL_REVEAL_KINDS = new Set<IntentKind>(['partner_seek']);

/**
 * Fire the two surfacing notifications for a freshly-created match.
 * Caller (intents.ts after computeForIntent) iterates over the top
 * matches and invokes this once per row.
 */
export async function notifyMatchSurfaced(args: NotifyArgs): Promise<void> {
  const { match, kind } = args;

  // Score gate: don't push low-confidence matches.
  if (match.score < 0.7) {
    await emitAudit(match, 'low_score_skipped', { score: match.score });
    return;
  }

  const dictator = await readIntent(match.intent_a_id);
  const counterparty = match.intent_b_id ? await readIntent(match.intent_b_id) : null;

  // Notify dictator.
  if (dictator) {
    const cap = recordHit(dictator.user_id, kind);
    if (!cap.allowed) {
      await sendThrottledNotice(dictator, kind);
    } else {
      const counterpartyVid = MUTUAL_REVEAL_KINDS.has(kind) ? null : match.vitana_id_b;
      await notifyUserAsync(
        dictator.user_id,
        dictator.tenant_id,
        'intent_match_found_for_dictator',
        {
          title: counterpartyVid
            ? `New match: @${counterpartyVid}`
            : `New match for your ${kind} intent`,
          body: `${match.kind_pairing} · score ${Math.round(match.score * 100)}%${match.compass_aligned ? ' · compass-aligned' : ''}`,
          data: dataToStringMap({
            type: 'intent_match_found_for_dictator',
            match_id: match.match_id,
            intent_id: dictator.intent_id,
            intent_kind: kind,
            counterparty_vitana_id: counterpartyVid,
            score: match.score,
            url: `/intents/match/${match.match_id}`,
          }),
        },
        getSupabase(),
      );
    }
  }

  // Notify counterparty (only for internal pairings, not external products).
  if (counterparty) {
    const counterpartyKind = match.kind_pairing.split('::')[1] as IntentKind;
    const cap = recordHit(counterparty.user_id, counterpartyKind);
    if (!cap.allowed) {
      await sendThrottledNotice(counterparty, counterpartyKind);
    } else {
      const dictatorVid = MUTUAL_REVEAL_KINDS.has(counterpartyKind) ? null : match.vitana_id_a;
      await notifyUserAsync(
        counterparty.user_id,
        counterparty.tenant_id,
        'intent_lead_for_counterparty',
        {
          title: dictatorVid
            ? `Lead for you: @${dictatorVid} ${kind === 'commercial_buy' ? 'is hiring' : 'is interested'}`
            : `New lead matching your ${counterpartyKind} listing`,
          body: `${dictator?.title ?? 'Someone'} · ${match.kind_pairing} · ${Math.round(match.score * 100)}% match`,
          data: dataToStringMap({
            type: 'intent_lead_for_counterparty',
            match_id: match.match_id,
            intent_id: counterparty.intent_id,
            intent_kind: counterpartyKind,
            dictator_vitana_id: dictatorVid,
            score: match.score,
            url: counterpartyKind === 'commercial_sell'
              ? `/business/opportunities?match=${match.match_id}`
              : `/intents/match/${match.match_id}`,
          }),
        },
        getSupabase(),
      );
    }
  }

  await emitAudit(match, 'surfaced', {
    dictator_notified: !!dictator,
    counterparty_notified: !!counterparty,
  });
}

/**
 * Bilateral mutual-interest event — both sides get push regardless of
 * per-kind cap because this is a high-stakes transition. Auto-creates a
 * chat_messages thread (Part 1 plumbing) seeded with a system message.
 */
export async function notifyMutualInterest(matchId: string): Promise<void> {
  const supabase = getSupabase();
  const { data: m } = await supabase
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, vitana_id_a, vitana_id_b, kind_pairing, score, compass_aligned')
    .eq('match_id', matchId)
    .maybeSingle();
  if (!m) return;
  const match = m as any as MatchRow;

  const dictator = await readIntent(match.intent_a_id);
  const counterparty = match.intent_b_id ? await readIntent(match.intent_b_id) : null;
  if (!dictator || !counterparty) return;

  const partnerSeek = MUTUAL_REVEAL_KINDS.has(dictator.intent_kind);

  const pushType = partnerSeek ? 'intent_partner_reciprocal_revealed' : 'intent_mutual_interest';
  const titleFor = (otherVid: string | null) =>
    partnerSeek
      ? `🎉 Reciprocal interest revealed${otherVid ? `: @${otherVid}` : ''}`
      : `Mutual interest${otherVid ? `: @${otherVid}` : ''}`;

  await notifyUserAsync(
    dictator.user_id,
    dictator.tenant_id,
    pushType,
    {
      title: titleFor(match.vitana_id_b),
      body: `${match.kind_pairing} · open the conversation now`,
      data: dataToStringMap({
        type: pushType,
        match_id: matchId,
        intent_id: dictator.intent_id,
        counterparty_vitana_id: match.vitana_id_b,
        url: `/inbox?thread=${counterparty.user_id}`,
      }),
    },
    supabase,
  );

  await notifyUserAsync(
    counterparty.user_id,
    counterparty.tenant_id,
    pushType,
    {
      title: titleFor(match.vitana_id_a),
      body: `${match.kind_pairing} · open the conversation now`,
      data: dataToStringMap({
        type: pushType,
        match_id: matchId,
        intent_id: counterparty.intent_id,
        counterparty_vitana_id: match.vitana_id_a,
        url: `/inbox?thread=${dictator.user_id}`,
      }),
    },
    supabase,
  );

  // Auto-create a chat_messages thread between the two parties so the next
  // step is one tap. Reuses Part 1 chat plumbing.
  try {
    const seed = partnerSeek
      ? `🎉 Reciprocal interest revealed on a partner-seek match. Reply to start the conversation.`
      : `Mutual interest on a ${match.kind_pairing.split('::')[0]} intent. Reply to start the conversation.`;
    await supabase.from('chat_messages').insert({
      tenant_id: dictator.tenant_id,
      sender_id: dictator.user_id,
      receiver_id: counterparty.user_id,
      content: seed,
      sender_vitana_id: match.vitana_id_a,
      receiver_vitana_id: match.vitana_id_b,
      metadata: {
        source: 'intent_engine_mutual_interest',
        match_id: matchId,
        kind_pairing: match.kind_pairing,
      },
    });
  } catch (err: any) {
    console.warn(`[VTID-01975] mutual-interest chat seed failed: ${err.message}`);
  }

  await emitAudit(match, partnerSeek ? 'reciprocal_revealed' : 'mutual_interest', {});
}

async function sendThrottledNotice(intent: IntentSummary, kind: IntentKind): Promise<void> {
  await notifyUserAsync(
    intent.user_id,
    intent.tenant_id,
    'intent_throttled',
    {
      title: `Quiet hours: ${kind} matches paused`,
      body: `You've hit the daily ${kind} match cap. Open the app any time to see all leads.`,
      data: dataToStringMap({ type: 'intent_throttled', intent_kind: kind }),
    },
    getSupabase(),
  );
}

async function emitAudit(match: MatchRow, outcome: string, extra: Record<string, unknown>): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01975',
    type: 'voice.message.sent',
    source: 'intent-notifier',
    status: outcome === 'surfaced' ? 'success' : 'info',
    message: `intent.notification.${outcome}`,
    payload: {
      match_id: match.match_id,
      intent_a_id: match.intent_a_id,
      intent_b_id: match.intent_b_id,
      kind_pairing: match.kind_pairing,
      score: match.score,
      compass_aligned: match.compass_aligned,
      ...extra,
    },
    surface: 'api',
    vitana_id: match.vitana_id_a ?? undefined,
  });
}
