/**
 * VTID-04423 (Plan v1 WS-2.3) — next-step decisions during the conversation.
 *
 * At session start the continuation providers produce candidates and one of
 * them may open the conversation (WS-2.1). The rest used to be thrown away. Now
 * the brain keeps them per user (`orb_session_state` key `brain_candidates`,
 * 90-minute TTL) and `decideTurnCandidates` re-ranks them mid-conversation with
 * the WS-2.2 relevance score: the screen the user is on now, what they
 * accepted before, and what they have already heard.
 *
 * They are exposed ONLY through the `get_next_best_action` tool — the model
 * asks, the brain answers with leads. Nothing is pushed into the conversation
 * unprompted: unsolicited turn-end nudges were paused in VTID-03075 because
 * they interrupted support flows, and that pause stands.
 *
 * Kill switch: `BRAIN_TURN_CANDIDATES=false` (anything else = on).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssistantContinuationDecision } from '../assistant-continuation/types';
import {
  loadScoringWeights,
  loadUserOutcomes,
  partOfDayForHour,
  localHourIn,
  scoreCandidate,
  type ScorableCandidate,
  type ScoringContext,
  type ScoringWeights,
} from './candidate-scoring';

export const BRAIN_CANDIDATES_TTL_MIN = 90;
export const BRAIN_CANDIDATES_MAX_STORED = 8;
export const TURN_CANDIDATES_LIMIT = 3;
const LEAD_MAX_CHARS = 220;
const RECENT_WINDOW = 5;

export interface StoredTurnCandidate extends ScorableCandidate {
  /** The provider's line, kept as a LEAD for the model — never spoken verbatim. */
  lead: string | null;
  /** The tool the candidate's action runs, when it has one. */
  tool: string | null;
}

export interface StoredTurnCandidates {
  decision_id: string;
  stored_at: string;
  candidates: StoredTurnCandidate[];
}

export interface RankedTurnCandidate extends StoredTurnCandidate {
  score: number;
}

export function isTurnCandidatesEnabled(raw: string | undefined = process.env.BRAIN_TURN_CANDIDATES): boolean {
  return raw !== 'false';
}

/** The returned candidates of one opening decision, in stored form. */
export function toStoredTurnCandidates(decision: AssistantContinuationDecision): StoredTurnCandidate[] {
  return decision.sourceProviderResults
    // Only lines a provider marked safe to say aloud can become leads; a
    // `use_silently` / `suppress_sensitive` candidate stays out of the tool.
    .filter((r) => r.status === 'returned' && r.candidate && r.candidate.kind !== 'none_with_reason'
      && (r.candidate.privacyMode ?? 'safe_to_speak') === 'safe_to_speak')
    .map((r) => {
      const c = r.candidate!;
      const cta = c.cta as { type?: string; route?: string; onYesTool?: string; toolName?: string } | undefined;
      const lead = typeof c.userFacingLine === 'string' && c.userFacingLine.trim()
        ? c.userFacingLine.trim().slice(0, LEAD_MAX_CHARS)
        : null;
      return {
        provider: r.providerKey,
        kind: c.kind,
        dedupeKey: c.dedupeKey ?? null,
        priority: typeof c.priority === 'number' ? c.priority : 0,
        ctaRoute: cta?.type === 'navigate' && typeof cta.route === 'string' ? cta.route : null,
        lead,
        tool: cta?.type === 'ask_permission' && typeof cta.onYesTool === 'string'
          ? cta.onYesTool
          : cta?.type === 'run_tool' && typeof cta.toolName === 'string'
            ? cta.toolName
            : null,
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, BRAIN_CANDIDATES_MAX_STORED);
}

/**
 * THE mid-conversation decision: re-rank the stored candidates for this
 * moment. Candidates without a lead cannot be proposed and are dropped.
 */
export function decideTurnCandidates(
  stored: StoredTurnCandidate[],
  ctx: ScoringContext,
  weights: ScoringWeights,
  limit: number = TURN_CANDIDATES_LIMIT,
): RankedTurnCandidate[] {
  return stored
    .filter((c) => !!c.lead)
    .map((c, i) => ({ c, i, s: scoreCandidate(c, ctx, weights).score }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .slice(0, Math.max(0, limit))
    .map(({ c, s }) => ({ ...c, score: s }));
}

/**
 * The tool text for the model. Leads, not lines (NEVER-rule 41): the model
 * composes its own words and proposes at most one.
 */
export function renderTurnCandidatesText(ranked: RankedTurnCandidate[]): string {
  if (!ranked.length) return '';
  const items = ranked.map((c, i) => `${i + 1}) ${c.lead}${c.tool ? ` [action: ${c.tool}]` : ''} (source: ${c.provider})`);
  return (
    'Other next steps the conversation brain has for this person, best first. These are leads for you, not lines to read: ' +
    'if one fits what they just asked, propose that one in your own words and wait for their answer. ' +
    items.join(' ')
  );
}

/** Read, re-rank and render for one user. Never throws; '' when nothing applies. */
export async function readTurnCandidates(
  sb: SupabaseClient,
  userId: string,
  opts: { currentRoute?: string | null; timezone?: string | null } = {},
): Promise<{ ranked: RankedTurnCandidate[]; text: string }> {
  if (!isTurnCandidatesEnabled() || !userId) return { ranked: [], text: '' };
  try {
    const { readOrbSessionState } = await import('../orb/orb-session-state');
    const rec = await readOrbSessionState<StoredTurnCandidates>(sb, userId, 'brain_candidates');
    const stored = Array.isArray(rec?.value?.candidates) ? rec!.value.candidates : [];
    if (!stored.length) return { ranked: [], text: '' };
    const recent = await readOrbSessionState<string[]>(sb, userId, 'recent_openers').catch(() => null);
    const [weights, outcomes] = await Promise.all([
      loadScoringWeights(sb),
      loadUserOutcomes(sb, userId).catch(() => ({})),
    ]);
    const ranked = decideTurnCandidates(stored, {
      recentlyServed: Array.isArray(recent?.value) ? recent!.value.filter((k) => typeof k === 'string') : [],
      recentWindow: RECENT_WINDOW,
      currentRoute: opts.currentRoute ?? null,
      partOfDay: partOfDayForHour(localHourIn(opts.timezone ?? null)),
      outcomes,
    }, weights);
    return { ranked, text: renderTurnCandidatesText(ranked) };
  } catch {
    return { ranked: [], text: '' };
  }
}
