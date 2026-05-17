/**
 * VTID-03057 (B0d-real slice Xb) — Autopilot-recommendation NextActionSource.
 *
 * Reads from `autopilot_recommendations` (the canonical table the
 * milestone service + dev-autopilot synthesis + voice-improvement
 * aggregator all write to). Picks the user's most-relevant `new`
 * recommendation as the next-action candidate.
 *
 * Source priority bands:
 *   - confidence='high'   → 88
 *   - confidence='medium' → 78
 *   - confidence='low'    → 60
 *   - confidence missing  → 55 (still above CROSS_SOURCE_THRESHOLD=50)
 *
 * Recency boost: +3 if last_seen_at within 24 hours. Caps at the band ceiling.
 *
 * Acceptance #1 (strong Autopilot recommendation can win): with band
 * 88 + recency boost up to 91, this source beats a 75-priority reminder
 * 30-60min out, but loses to a sub-10min "urgent" reminder. That's the
 * intended ranking — a fire-imminent reminder beats a coaching nudge.
 */

import type {
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceResult,
  ScoredCandidate,
  NextActionConfidence,
} from '../types';

const KEY = 'autopilot_recommendation' as const;

export function makeAutopilotRecommendationSource(): NextActionSource {
  return {
    key: KEY,
    serves: () => true, // Both orb_wake AND orb_turn_end.
    produce: produceAutopilotRecommendation,
  };
}

export async function produceAutopilotRecommendation(
  ctx: NextActionSourceContext,
): Promise<NextActionSourceResult> {
  let row: AutopilotRecLike | null = null;
  try {
    // Order: high confidence first, then most recent. The composer
    // breaks ties; this source just supplies one candidate.
    const { data, error } = await ctx.supabase
      .from('autopilot_recommendations')
      .select('id, title, summary, confidence, last_seen_at, created_at, domain')
      .eq('user_id', ctx.userId)
      .eq('status', 'new')
      // Drop milestone celebrations — those have their own surface.
      .neq('source_type', 'milestone')
      .order('confidence', { ascending: false, nullsFirst: false })
      .order('last_seen_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      return { source: KEY, candidate: null, skippedReason: 'source_unavailable' };
    }
    row = (data && data[0]) ? (data[0] as AutopilotRecLike) : null;
  } catch {
    return { source: KEY, candidate: null, skippedReason: 'errored' };
  }

  if (!row) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const title = (row.title || '').trim();
  if (!title) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const confidence = normalizeConfidence(row.confidence);
  let priority = priorityForConfidence(confidence);
  const recencyBoost = recencyBoostForLastSeen(row.last_seen_at, ctx.nowIso);
  priority = Math.min(95, priority + recencyBoost);

  const userFacingLine = renderLine(title, row.summary, ctx.lang);

  const reasons: ScoredCandidate['reasons'] = [
    {
      kind: 'autopilot_rec_new',
      detail: `confidence=${confidence}${row.domain ? ` domain=${row.domain}` : ''}`,
    },
  ];
  if (recencyBoost > 0) {
    reasons.push({
      kind: 'autopilot_rec_recent',
      detail: `seen within 24h (boost=${recencyBoost})`,
    });
  }

  const candidate: ScoredCandidate = {
    source: KEY,
    priority,
    confidence,
    userFacingLine,
    reasons,
    dedupeKey: `autopilot_recommendation:${row.id}`,
    cta: {
      type: 'ask_permission',
      payload: { recommendation_id: row.id, domain: row.domain ?? null },
    },
  };
  return { source: KEY, candidate };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

interface AutopilotRecLike {
  id: string;
  title: string | null;
  summary: string | null;
  confidence: string | number | null;
  last_seen_at: string | null;
  created_at: string;
  domain: string | null;
}

export function normalizeConfidence(raw: unknown): NextActionConfidence {
  if (typeof raw === 'string') {
    const s = raw.toLowerCase();
    if (s === 'high' || s === 'medium' || s === 'low') return s;
  }
  if (typeof raw === 'number') {
    if (raw >= 0.8) return 'high';
    if (raw >= 0.5) return 'medium';
    return 'low';
  }
  // Unknown shape — treat as low so this source doesn't outscore a
  // typed source on a malformed row.
  return 'low';
}

export function priorityForConfidence(confidence: NextActionConfidence): number {
  if (confidence === 'high') return 88;
  if (confidence === 'medium') return 78;
  return 60;
}

export function recencyBoostForLastSeen(
  lastSeenAt: string | null | undefined,
  nowIso: string,
): number {
  if (!lastSeenAt) return 0;
  const seen = Date.parse(lastSeenAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(seen) || !Number.isFinite(now)) return 0;
  const hoursAgo = (now - seen) / 3_600_000;
  if (hoursAgo >= 0 && hoursAgo <= 24) return 3;
  return 0;
}

export function renderLine(
  title: string,
  summary: string | null,
  lang: string,
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  const cleanSummary = (summary || '').trim();
  if (isDe) {
    if (cleanSummary) {
      return `Eine Empfehlung von mir: ${title}. ${cleanSummary} Sollen wir das jetzt angehen?`;
    }
    return `Eine Empfehlung von mir: ${title}. Wollen wir das anschauen?`;
  }
  if (cleanSummary) {
    return `One thing I want to flag: ${title}. ${cleanSummary} Want to work on it now?`;
  }
  return `One thing I want to flag: ${title}. Want to take a look?`;
}
