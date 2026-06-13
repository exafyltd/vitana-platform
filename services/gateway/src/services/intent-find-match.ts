/**
 * BOOTSTRAP-FIND-MATCH-VOICE — "find me a match" voice capability.
 *
 * The Intent Engine could only match an intent AFTER it was posted (the async
 * matchmaker compares stored user_intents rows). There was no way for the ORB
 * to answer "is there already someone for tennis?" without first creating a
 * post — so when nothing was precomputed, the assistant fell through to a
 * tool failure and the grace layer voiced "I'm not able to find matches".
 *
 * runFindMatch implements the search-first contract the user asked for:
 *   1. classify + extract + embed the spoken request,
 *   2. SEARCH the live catalog (search_intent_catalog RPC, read-only),
 *   3a. matches found  → recommend them AND post the request too, so the user
 *       is discoverable and mutual-reveal works (user's chosen behavior),
 *   3b. no match yet   → read the summary back and, on explicit confirmation,
 *       post the request (always-post; "you're the first").
 *
 * Design rule: this NEVER returns ok:false for a normal "no matches" outcome.
 * ok:false is reserved for genuine infra failures (no auth / no DB / insert
 * error). That keeps the voice tool-failure grace layer from turning an
 * ordinary empty result into an apologetic refusal.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { classifyIntentKind, type IntentKind } from './intent-classifier';
import { extractIntent, type ExtractedIntent } from './intent-extractor';
import { embedIntent } from './intent-embedding';
import { computeForIntent, surfaceTopMatches } from './intent-matcher';

const PARTNER_REVEAL_KINDS = new Set<IntentKind>(['partner_seek']);

export interface FindMatchIdentity {
  user_id: string;
  tenant_id: string | null;
  vitana_id?: string | null;
  session_id?: string | null;
}

export type FindMatchStage =
  | 'matched'
  | 'awaiting_confirmation'
  | 'posted'
  | 'needs_clarification'
  | 'incomplete';

export interface FindMatchResponse {
  ok: boolean;
  stage: FindMatchStage;
  /** Model-facing guidance / read-back instruction. */
  text: string;
  data: Record<string, unknown>;
  error?: string;
}

interface CatalogCandidate {
  cand_intent_id: string;
  cand_user_id: string;
  cand_vitana_id: string | null;
  cand_kind: string;
  cand_title: string | null;
  cand_scope: string | null;
  score: number;
  reasons: Record<string, unknown>;
}

/** Read-only catalog search. Returns ranked candidates; never throws. */
async function searchIntentCatalog(
  supabase: SupabaseClient,
  id: FindMatchIdentity,
  kind: IntentKind,
  category: string | null,
  payload: Record<string, unknown>,
  embedding: number[] | null,
  topN = 5,
): Promise<CatalogCandidate[]> {
  const { data, error } = await supabase.rpc('search_intent_catalog', {
    p_user_id: id.user_id,
    p_tenant_id: id.tenant_id,
    p_intent_kind: kind,
    p_category: category,
    p_kind_payload: payload ?? {},
    p_embedding: embedding && embedding.length ? `[${embedding.join(',')}]` : null,
    p_visibility: 'public',
    p_top_n: topN,
  });
  if (error) {
    console.warn(`[BOOTSTRAP-FIND-MATCH] search_intent_catalog failed: ${error.message}`);
    return [];
  }
  return (data || []) as CatalogCandidate[];
}

/**
 * Persist the intent (so the user becomes discoverable) and fire the same
 * best-effort side-effects post_intent does: embedding backfill, synchronous
 * match compute, async matchmaker kick, and memory facts. Returns the new
 * intent_id, or null if the insert itself failed.
 */
async function persistIntent(
  supabase: SupabaseClient,
  id: FindMatchIdentity,
  kind: IntentKind,
  extract: ExtractedIntent,
): Promise<{ intent_id: string; vitana_id: string | null } | null> {
  const { data: inserted, error } = await supabase
    .from('user_intents')
    .insert({
      requester_user_id: id.user_id,
      tenant_id: id.tenant_id,
      intent_kind: kind,
      category: extract.category,
      title: extract.title,
      scope: extract.scope,
      kind_payload: extract.kind_payload,
      status: 'open',
    })
    .select('intent_id, requester_vitana_id')
    .single();

  if (error || !inserted) {
    console.error(`[BOOTSTRAP-FIND-MATCH] user_intents insert failed: ${error?.message ?? 'no row'}`);
    return null;
  }

  const intentId = (inserted as { intent_id: string }).intent_id;
  const vid = (inserted as { requester_vitana_id: string | null }).requester_vitana_id ?? null;

  // Embedding backfill (best-effort).
  try {
    const emb = await embedIntent({
      intent_kind: kind,
      category: extract.category,
      title: extract.title ?? '',
      scope: extract.scope ?? '',
      kind_payload: extract.kind_payload,
    });
    if (emb) {
      await supabase.from('user_intents').update({ embedding: emb as unknown as string }).eq('intent_id', intentId);
    }
  } catch (err) {
    console.warn(`[BOOTSTRAP-FIND-MATCH] embedding backfill non-fatal: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // Persist matches now + kick the async matchmaker (parity with post_intent).
  try {
    await computeForIntent(intentId);
  } catch (err) {
    console.warn(`[BOOTSTRAP-FIND-MATCH] computeForIntent non-fatal: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  try {
    const { runMatchmakerAsync } = await import('./matchmaker-agent');
    runMatchmakerAsync(intentId);
  } catch (err) {
    console.warn(`[BOOTSTRAP-FIND-MATCH] matchmaker kick non-fatal: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  if (id.tenant_id) {
    try {
      const { writeIntentFacts } = await import('./intent-memory-hooks');
      writeIntentFacts({
        user_id: id.user_id,
        tenant_id: id.tenant_id,
        intent_kind: kind,
        category: extract.category,
        title: extract.title ?? '',
        scope: extract.scope ?? '',
        kind_payload: extract.kind_payload,
      }).catch(() => {});
    } catch {
      /* non-fatal */
    }
  }

  return { intent_id: intentId, vitana_id: vid };
}

/**
 * Search-first "find me a match" orchestration. See file header for the
 * contract. Pure of transport concerns — both the Vertex (orb-live.ts) and
 * LiveKit (orb-tools-shared registry) paths call this.
 */
export async function runFindMatch(
  args: { utterance?: unknown; kind_hint?: unknown; confirmed?: unknown },
  id: FindMatchIdentity,
): Promise<FindMatchResponse> {
  const utterance = String(args.utterance ?? '').trim();
  const kindHint = args.kind_hint ? (String(args.kind_hint) as IntentKind) : undefined;
  const confirmed = args.confirmed === true;

  if (!id?.user_id) {
    return { ok: false, stage: 'incomplete', text: '', data: {}, error: 'authentication required' };
  }
  if (!utterance) {
    return { ok: false, stage: 'incomplete', text: '', data: {}, error: 'utterance is required' };
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    return { ok: false, stage: 'incomplete', text: '', data: {}, error: 'supabase_not_configured' };
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  // 1. Classify (or trust an explicit kind_hint).
  let kind: IntentKind | undefined = kindHint;
  if (!kind) {
    const cls = await classifyIntentKind(utterance);
    if (!cls.intent_kind || cls.confidence < 0.7) {
      return {
        ok: true,
        stage: 'needs_clarification',
        text: 'Ask ONE short question to clarify what they want — an activity partner, something to buy or sell, a teacher, a life partner, or help borrowing/lending something.',
        data: { ok: false, reason: 'classify_low_confidence', classifier_confidence: cls.confidence },
      };
    }
    kind = cls.intent_kind;
  }

  // 2. Extract structured fields + 3. embed (best-effort).
  const extract = await extractIntent(utterance, kind);
  const summary = {
    intent_kind: kind,
    category: extract.category,
    title: extract.title,
    scope: extract.scope,
    kind_payload: extract.kind_payload,
    confidence: extract.confidence,
    missing_critical: extract.missing_critical,
  };

  let embedding: number[] | null = null;
  try {
    embedding = await embedIntent({
      intent_kind: kind,
      category: extract.category,
      title: extract.title ?? '',
      scope: extract.scope ?? '',
      kind_payload: extract.kind_payload,
    });
  } catch {
    embedding = null;
  }

  const isPartner = PARTNER_REVEAL_KINDS.has(kind);
  const complete = extract.missing_critical.length === 0 && extract.confidence >= 0.6;

  // 4. SEARCH the live catalog.
  const candidates = await searchIntentCatalog(
    supabase,
    id,
    kind,
    extract.category,
    extract.kind_payload,
    embedding,
    5,
  );

  // 5a. Matches found → recommend + also post (when complete enough).
  if (candidates.length > 0) {
    let postedIntentId: string | null = null;
    if (complete) {
      const persisted = await persistIntent(supabase, id, kind, extract);
      if (persisted) postedIntentId = persisted.intent_id;
    }

    const recommendations = candidates.map((c) => ({
      intent_id: c.cand_intent_id,
      vitana_id: isPartner ? null : c.cand_vitana_id,
      display: isPartner ? '(a member — revealed once you both say yes)' : c.cand_vitana_id || 'a member',
      title: c.cand_title,
      score: Number(c.score),
      kind: c.cand_kind,
    }));

    const tail = postedIntentId
      ? 'Also tell them you posted their request so the other person can reach them too.'
      : `Ask for the missing detail (${extract.missing_critical.join(', ') || 'a little more info'}) so you can also post their request.`;

    return {
      ok: true,
      stage: 'matched',
      text:
        `Found ${recommendations.length} potential ${recommendations.length === 1 ? 'match' : 'matches'} in the community. ` +
        `Read them back warmly and offer to open or connect. ${tail}` +
        (isPartner ? ' For partner matches, explain identities are revealed only after both people say yes.' : ''),
      data: {
        ok: true,
        found: true,
        posted: !!postedIntentId,
        intent_id: postedIntentId,
        matches: recommendations,
        match_count: recommendations.length,
        partner_seek_redacted: isPartner,
      },
    };
  }

  // 5b. No catalog match. If the request is too thin to post, ask for detail.
  if (!complete) {
    return {
      ok: true,
      stage: 'incomplete',
      text: `No one in the catalog matches yet. Ask the user for: ${extract.missing_critical.join(', ') || 'a bit more detail'} so you can post their request.`,
      data: { ok: false, found: false, reason: 'extract_incomplete', summary },
    };
  }

  // Confirm-first before the always-post fallback (user's chosen behavior).
  if (!confirmed) {
    return {
      ok: true,
      stage: 'awaiting_confirmation',
      text:
        'No match in the catalog yet. Read the summary back — e.g. "I didn\'t find anyone yet. Shall I post this so I can let you know the moment someone matches?" — then call find_match again with confirmed=true once they say yes / post / ja.',
      data: { ok: true, found: false, stage: 'awaiting_confirmation', summary },
    };
  }

  // confirmed === true → post (always-post).
  const persisted = await persistIntent(supabase, id, kind, extract);
  if (!persisted) {
    return { ok: false, stage: 'incomplete', text: '', data: {}, error: 'insert_failed' };
  }

  let postedMatches: Array<Record<string, unknown>> = [];
  try {
    const rows = await surfaceTopMatches(persisted.intent_id, 3);
    postedMatches = rows.map((m) => ({
      match_id: m.match_id,
      vitana_id_b: isPartner ? null : m.vitana_id_b,
      score: m.score,
      kind_pairing: m.kind_pairing,
    }));
  } catch {
    postedMatches = [];
  }

  return {
    ok: true,
    stage: 'posted',
    text:
      postedMatches.length > 0
        ? `Posted, and there ${postedMatches.length === 1 ? 'is' : 'are'} ${postedMatches.length} potential match${postedMatches.length === 1 ? '' : 'es'}. Confirm the post is live and read the matches back.`
        : "Posted. Tell the user warmly: \"You're the first one looking for this right now — I'll let you know the moment someone matches, and your post is visible on the board.\" Never imply this failed.",
    data: {
      ok: true,
      found: false,
      stage: 'posted',
      intent_id: persisted.intent_id,
      vitana_id: persisted.vitana_id,
      match_count: postedMatches.length,
      top_matches: postedMatches,
      cold_start: postedMatches.length === 0,
    },
  };
}
