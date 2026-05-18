/**
 * VTID-03070 (B0d-real slice Xm) — Match / activity-plan NextActionSource.
 *
 * Closes acceptance #3 from the B0d-real spec ("match/activity plan
 * opportunity can win"). Surfaces the user's most-actionable
 * intent_matches row as a next-action candidate so the orb can offer:
 *
 *   - "Someone matched you on <kind>. Want to open the conversation?"
 *     when state === 'mutual_interest' (both sides engaged).
 *   - "Your match on <kind> is waiting for your response."
 *     when the other side has responded and this user has not.
 *   - "You have a fresh match on <kind>. Want me to walk you through it?"
 *     when state === 'new'.
 *
 * Priority bands (mapped from state, parallel to other sources):
 *   - pending_user_decision (other side responded, our turn) → 85
 *   - mutual_interest                                        → 78
 *   - new (fresh, not yet acted on)                          → 65
 *
 * Confidence:
 *   - pending_user_decision / mutual_interest → high
 *   - new                                     → medium
 *
 * Privacy contract (B0d-real Xm — hard rules):
 *   - NEVER include raw chat text, profile payloads, intent titles, or
 *     match-row JSON. Only kind_pairing (a category enum) + state +
 *     match_id leave this file.
 *   - Counterparty vitana_id is NOT exposed in the spoken line — the
 *     redact-on-pre-reveal logic in intent-mutual-reveal.ts is the
 *     authoritative gate; the wake-brief surface stays vitana-id-free.
 *   - If the table is missing or the read fails, suppress with
 *     skippedReason: 'source_unavailable' so a DB outage cannot leak.
 *
 * Schema contract this source assumes (from intent-matcher.ts +
 * intent-mutual-reveal.ts):
 *   intent_matches(match_id, intent_a_id, intent_b_id, kind_pairing,
 *                  state, mutual_reveal_unlocked_at, score, ...)
 *   user_intents(intent_id, requester_user_id)
 *
 * State enum used in this source (mirroring orb-tools-shared.ts
 * respond_to_match):
 *   'new' | 'responded_by_a' | 'responded_by_b' | 'mutual_interest' |
 *   'declined'
 */

import type {
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceResult,
  ScoredCandidate,
} from '../types';

const KEY = 'match_activity_plan' as const;

/** Max user_intents to fan out across when discovering matches. The
 *  orb only ever surfaces one candidate; this cap exists so a user
 *  with a long intent history doesn't pull a giant batch. */
const MAX_INTENTS_PER_USER = 20;

/** Max intent_matches rows to consider once we have intent ids. The
 *  ranker only picks the top stage; we never read more than this. */
const MAX_MATCHES_PER_SOURCE = 20;

/** State buckets in priority order. 'mutual_interest' beats fresh, but
 *  is itself beaten by "pending response from this user" — because a
 *  decision waiting on the user is more time-sensitive than an open
 *  conversation. */
type MatchStage = 'pending_user_decision' | 'mutual_interest' | 'new';

export function makeMatchActivityPlanSource(): NextActionSource {
  return {
    key: KEY,
    serves: () => true,
    produce: produceMatchActivityPlan,
  };
}

export async function produceMatchActivityPlan(
  ctx: NextActionSourceContext,
): Promise<NextActionSourceResult> {
  let userIntentIds: string[];
  try {
    const { data, error } = await ctx.supabase
      .from('user_intents')
      .select('intent_id')
      .eq('requester_user_id', ctx.userId)
      .order('created_at', { ascending: false })
      .limit(MAX_INTENTS_PER_USER);
    if (error) {
      return { source: KEY, candidate: null, skippedReason: 'source_unavailable' };
    }
    userIntentIds = (data || [])
      .map((r) => (r as { intent_id: string }).intent_id)
      .filter(Boolean);
  } catch {
    return { source: KEY, candidate: null, skippedReason: 'errored' };
  }

  if (userIntentIds.length === 0) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  let matches: MatchRow[];
  try {
    // We have to query "intent_a_id in (ids) OR intent_b_id in (ids)".
    // Supabase REST does that via .or('intent_a_id.in.(...),intent_b_id.in.(...)').
    const idList = userIntentIds.map((s) => `"${s}"`).join(',');
    const { data, error } = await ctx.supabase
      .from('intent_matches')
      .select('match_id, intent_a_id, intent_b_id, kind_pairing, state, mutual_reveal_unlocked_at')
      .or(`intent_a_id.in.(${idList}),intent_b_id.in.(${idList})`)
      .in('state', ['new', 'responded_by_a', 'responded_by_b', 'mutual_interest'])
      .order('match_id', { ascending: true })
      .limit(MAX_MATCHES_PER_SOURCE);
    if (error) {
      return { source: KEY, candidate: null, skippedReason: 'source_unavailable' };
    }
    matches = (data || []) as MatchRow[];
  } catch {
    return { source: KEY, candidate: null, skippedReason: 'errored' };
  }

  if (matches.length === 0) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const intentIdSet = new Set(userIntentIds);
  const ranked = rankMatches(matches, intentIdSet);
  const top = ranked[0];
  if (!top) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const { priority, confidence } = bandForStage(top.stage);
  const kindLabel = renderKindLabel(top.row.kind_pairing);
  const userFacingLine = renderLine(top.stage, kindLabel, ctx.lang);

  const candidate: ScoredCandidate = {
    source: KEY,
    priority,
    confidence,
    userFacingLine,
    reasons: [
      {
        kind: reasonKindFor(top.stage),
        detail: `match=${top.row.match_id} kind=${top.row.kind_pairing} state=${top.row.state}`,
      },
    ],
    dedupeKey: `match_activity_plan:${top.row.match_id}:${top.stage}`,
    cta: {
      type: 'ask_permission',
      payload: { match_id: top.row.match_id, stage: top.stage },
    },
  };
  return { source: KEY, candidate };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export interface MatchRow {
  match_id: string;
  intent_a_id: string;
  intent_b_id: string | null;
  kind_pairing: string | null;
  state: string;
  mutual_reveal_unlocked_at: string | null;
}

interface RankedMatch {
  row: MatchRow;
  stage: MatchStage;
}

export function rankMatches(
  rows: MatchRow[],
  userIntentIdSet: Set<string>,
): RankedMatch[] {
  const stages: RankedMatch[] = [];
  for (const row of rows) {
    const stage = classifyStage(row, userIntentIdSet);
    if (stage) stages.push({ row, stage });
  }
  // Sort by stage priority (pending > mutual > new) then by match_id for
  // deterministic tie-break.
  stages.sort((a, b) => {
    const pa = stageRank(a.stage);
    const pb = stageRank(b.stage);
    if (pa !== pb) return pb - pa;
    return a.row.match_id.localeCompare(b.row.match_id);
  });
  return stages;
}

export function classifyStage(
  row: MatchRow,
  userIntentIdSet: Set<string>,
): MatchStage | null {
  if (row.state === 'mutual_interest') return 'mutual_interest';
  if (row.state === 'new') return 'new';
  const userOwnsA = userIntentIdSet.has(row.intent_a_id);
  const userOwnsB = row.intent_b_id ? userIntentIdSet.has(row.intent_b_id) : false;
  // The other side responded. If the user owns A and B responded, the
  // user (A) owes the decision. Same mirrored for the B side.
  if (row.state === 'responded_by_b' && userOwnsA) return 'pending_user_decision';
  if (row.state === 'responded_by_a' && userOwnsB) return 'pending_user_decision';
  return null;
}

function stageRank(stage: MatchStage): number {
  switch (stage) {
    case 'pending_user_decision':
      return 3;
    case 'mutual_interest':
      return 2;
    case 'new':
      return 1;
  }
}

export function bandForStage(
  stage: MatchStage,
): { priority: number; confidence: ScoredCandidate['confidence'] } {
  switch (stage) {
    case 'pending_user_decision':
      return { priority: 85, confidence: 'high' };
    case 'mutual_interest':
      return { priority: 78, confidence: 'high' };
    case 'new':
      return { priority: 65, confidence: 'medium' };
  }
}

function reasonKindFor(stage: MatchStage): string {
  switch (stage) {
    case 'pending_user_decision':
      return 'match_awaiting_user_response';
    case 'mutual_interest':
      return 'match_mutual_interest_open_conversation';
    case 'new':
      return 'match_new_unseen';
  }
}

/**
 * Map a kind_pairing string ("buddy_seek::buddy_seek", "hike::hike",
 * "commercial_buy::product") to a short user-facing label, or null when
 * the kind is unknown / absent. NULL signals "no friendly label" — the
 * renderer then picks a generic sentence template instead of trying to
 * inject the word "match" into a sentence that already contains
 * "match" (the original Xm bug: "You have a fresh match match.").
 */
export function renderKindLabel(kindPairing: string | null): string | null {
  if (!kindPairing) return null;
  const left = String(kindPairing).split('::')[0] || '';
  const known: Record<string, string> = {
    hike: 'hike',
    run: 'run',
    chess: 'chess',
    language_exchange: 'language exchange',
    coffee: 'coffee',
    buddy_seek: 'buddy',
    partner_seek: 'partner',
    activity_seek: 'activity',
    commercial_buy: 'purchase',
    commercial_sell: 'offer',
  };
  return known[left] ?? null;
}

export function renderLine(
  stage: MatchStage,
  kindLabel: string | null,
  lang: string,
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  if (stage === 'pending_user_decision') {
    if (kindLabel) {
      return isDe
        ? `Es gibt eine Antwort auf deine ${kindLabel}-Anfrage. Willst du entscheiden, wie es weitergeht?`
        : `Someone has responded to your ${kindLabel} request. Want to decide what's next?`;
    }
    return isDe
      ? `Jemand hat auf deine Anfrage geantwortet. Willst du entscheiden, wie es weitergeht?`
      : `Someone has responded to your request. Want to decide what's next?`;
  }
  if (stage === 'mutual_interest') {
    if (kindLabel) {
      return isDe
        ? `Du hast ein neues gegenseitiges Match auf ${kindLabel}. Sollen wir das Gespräch eröffnen?`
        : `You have a new mutual ${kindLabel} match. Want to open the conversation?`;
    }
    return isDe
      ? `Du hast ein neues gegenseitiges Match. Sollen wir das Gespräch eröffnen?`
      : `You have a new mutual match. Want to open the conversation?`;
  }
  // stage === 'new'
  if (kindLabel) {
    return isDe
      ? `Es gibt ein frisches ${kindLabel}-Match für dich. Soll ich es dir vorstellen?`
      : `You have a fresh ${kindLabel} match. Want me to walk you through it?`;
  }
  return isDe
    ? `Es gibt ein frisches Match für dich. Soll ich es dir vorstellen?`
    : `You have a fresh match. Want me to walk you through it?`;
}
