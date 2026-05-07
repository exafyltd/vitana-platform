/**
 * E6 — Match enrichment with counterparty profile fields.
 *
 * Given a list of matches (after `redactMatchForReader`), batch-lookup the
 * counterparty's display_name, avatar_url, gender from `profiles` and
 * populate `partner_display_name`, `partner_avatar_url`, `partner_gender`
 * on each match.
 *
 * Defense-in-depth:
 *   - Redacted matches stay redacted; partner fields stay null.
 *   - Counterparties whose `global_community_profiles.is_visible = false`
 *     get null partner fields (matches still surface; identity stays hidden).
 *   - `partner_gender` is normalized to 'male' | 'female' | null. Anything
 *     else (empty, 'other', 'private', 'non-binary', etc.) collapses to null.
 */

import { createClient } from '@supabase/supabase-js';
import { redactMatchForReader, type RedactedMatch } from './intent-mutual-reveal';
import type { MatchRow } from './intent-matcher';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

function normalizeGender(raw: unknown): 'male' | 'female' | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'male' || v === 'm') return 'male';
  if (v === 'female' || v === 'f') return 'female';
  return null;
}

function pickCounterpartyVid(
  match: RedactedMatch,
  readerOwnsA: boolean,
): string | null {
  return readerOwnsA ? match.vitana_id_b : match.vitana_id_a;
}

function pickCounterpartyIntentId(
  match: RedactedMatch,
  readerOwnsA: boolean,
): string | null {
  return readerOwnsA ? match.intent_b_id : match.intent_a_id;
}

const EMPTY_COUNTERPARTY_INTENT_FIELDS = {
  partner_match_cover_url: null,
  partner_intent_title: null,
  partner_intent_scope: null,
  partner_intent_kind: null,
  partner_intent_status: null,
} as const;

export async function enrichMatchesWithCounterpartyProfiles(
  matches: MatchRow[],
  readerUserId: string,
): Promise<RedactedMatch[]> {
  if (matches.length === 0) return [];

  const supabase = getSupabase();

  // 1. Apply redaction first (per-match async — keeps existing semantics).
  const redactedAll = await Promise.all(
    matches.map((m) => redactMatchForReader(m, readerUserId)),
  );

  // 2. Determine which intents the reader owns (for counterparty side selection).
  //    `redactMatchForReader` already does this lookup internally for partner_seek;
  //    we re-do it here in batch for the non-redacted case so we don't N+1.
  const intentIds = Array.from(
    new Set(redactedAll.flatMap((m) => [m.intent_a_id, m.intent_b_id].filter(Boolean) as string[])),
  );
  const ownerByIntent = new Map<string, string>(); // intent_id → requester_user_id
  if (intentIds.length > 0) {
    const { data: owners } = await supabase
      .from('user_intents')
      .select('intent_id, requester_user_id')
      .in('intent_id', intentIds);
    for (const row of (owners ?? []) as { intent_id: string; requester_user_id: string }[]) {
      ownerByIntent.set(row.intent_id, row.requester_user_id);
    }
  }

  // 3. Collect counterparty vitana_ids for non-redacted matches.
  const counterpartyVids = new Set<string>();
  for (const m of redactedAll) {
    if (m.redacted) continue;
    const readerOwnsA = ownerByIntent.get(m.intent_a_id) === readerUserId;
    const cpVid = pickCounterpartyVid(m, readerOwnsA);
    if (cpVid) counterpartyVids.add(cpVid);
  }

  // 3b. Collect counterparty intent_ids for non-redacted matches and
  //     batch-load the intent fields the Find-a-Match card body renders.
  const counterpartyIntentIds = new Set<string>();
  for (const m of redactedAll) {
    if (m.redacted) continue;
    const readerOwnsA = ownerByIntent.get(m.intent_a_id) === readerUserId;
    const cpIntent = pickCounterpartyIntentId(m, readerOwnsA);
    if (cpIntent) counterpartyIntentIds.add(cpIntent);
  }
  type CpIntentRow = {
    intent_id: string;
    title: string | null;
    scope: string | null;
    intent_kind: string | null;
    status: string | null;
    cover_url: string | null;
  };
  const cpIntentByIntentId = new Map<string, CpIntentRow>();
  if (counterpartyIntentIds.size > 0) {
    const { data: cpIntents } = await supabase
      .from('user_intents')
      .select('intent_id, title, scope, intent_kind, status, cover_url')
      .in('intent_id', Array.from(counterpartyIntentIds));
    for (const row of (cpIntents ?? []) as CpIntentRow[]) {
      cpIntentByIntentId.set(row.intent_id, row);
    }
  }

  // 4. Batch-load profile rows for all counterparties.
  type ProfileRow = {
    user_id: string;
    vitana_id: string | null;
    display_name: string | null;
    full_name: string | null;
    avatar_url: string | null;
    gender: string | null;
  };
  const profileByVid = new Map<string, ProfileRow>();
  if (counterpartyVids.size > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, vitana_id, display_name, full_name, avatar_url, gender')
      .in('vitana_id', Array.from(counterpartyVids));
    for (const p of (profiles ?? []) as ProfileRow[]) {
      if (p.vitana_id) profileByVid.set(p.vitana_id, p);
    }
  }

  // 5. Batch-load is_visible flags. Default to true when row is missing
  //    (matches the behaviour of `community-members.ts`).
  const visibleByUserId = new Map<string, boolean>();
  const userIds = Array.from(profileByVid.values()).map((p) => p.user_id);
  if (userIds.length > 0) {
    const { data: gcps } = await supabase
      .from('global_community_profiles')
      .select('user_id, is_visible')
      .in('user_id', userIds);
    for (const row of (gcps ?? []) as { user_id: string; is_visible: boolean | null }[]) {
      visibleByUserId.set(row.user_id, row.is_visible !== false);
    }
  }

  // 6. Assemble enriched results.
  return redactedAll.map((m) => {
    if (m.redacted) {
      // Redacted (partner_seek pre-reveal) — leak nothing about the counterparty.
      return {
        ...m,
        partner_display_name: null,
        partner_avatar_url: null,
        partner_gender: null,
        ...EMPTY_COUNTERPARTY_INTENT_FIELDS,
      };
    }
    const readerOwnsA = ownerByIntent.get(m.intent_a_id) === readerUserId;
    const cpVid = pickCounterpartyVid(m, readerOwnsA);
    const cpIntentId = pickCounterpartyIntentId(m, readerOwnsA);
    const cpIntent = cpIntentId ? cpIntentByIntentId.get(cpIntentId) : undefined;
    const intentFields = cpIntent
      ? {
          partner_match_cover_url: cpIntent.cover_url,
          partner_intent_title: cpIntent.title,
          partner_intent_scope: cpIntent.scope,
          partner_intent_kind: cpIntent.intent_kind,
          partner_intent_status: cpIntent.status,
        }
      : EMPTY_COUNTERPARTY_INTENT_FIELDS;

    if (!cpVid) {
      return {
        ...m,
        partner_display_name: null,
        partner_avatar_url: null,
        partner_gender: null,
        ...intentFields,
      };
    }
    const profile = profileByVid.get(cpVid);
    if (!profile) {
      return {
        ...m,
        partner_display_name: null,
        partner_avatar_url: null,
        partner_gender: null,
        ...intentFields,
      };
    }
    const visible = visibleByUserId.get(profile.user_id);
    if (visible === false) {
      // Hidden user → suppress profile fields, but the counterparty intent's
      // public-ish title / scope / cover stay visible (they're board content).
      return {
        ...m,
        partner_display_name: null,
        partner_avatar_url: null,
        partner_gender: null,
        ...intentFields,
      };
    }
    return {
      ...m,
      partner_display_name: profile.display_name ?? profile.full_name ?? null,
      partner_avatar_url: profile.avatar_url ?? null,
      partner_gender: normalizeGender(profile.gender),
      ...intentFields,
    };
  });
}
