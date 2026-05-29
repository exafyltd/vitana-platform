/**
 * VTID-01270: Proactive Match Messenger
 *
 * Sends proactive chat messages from Vitana Bot to users after daily match
 * recompute, surfacing their top matches with deep links.
 *
 * Features:
 * - Dedup: Max 1 proactive match message per user per day
 * - Privacy: Respects reveal_identity_mode for person matches
 * - Template-based: Fast, deterministic message generation (no LLM)
 * - Deep links: https://e.vitanaland.com/matches/{match_id} for each match
 * - Push notification via orb_proactive_message (P1 push+inapp)
 * - OASIS event tracking
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { VITANA_BOT_USER_ID } from '../lib/vitana-bot';
import { notifyUserAsync } from './notification-service';
import { emitOasisEvent } from './oasis-event-service';

const VTID = 'VTID-01270';
const MATCH_SHARE_BASE = 'https://e.vitanaland.com/matches';
const DISCOVER_URL = 'https://vitanaland.com/discover';

// =============================================================================
// Types
// =============================================================================

export interface ProactiveMatchParams {
  user_id: string;
  tenant_id: string;
  date: string;
  max_matches?: number;   // default 3
  min_score?: number;     // default 60
}

export interface ProactiveMatchResult {
  ok: boolean;
  user_id: string;
  messages_sent: number;
  matches_surfaced: string[];
  skipped_reason?: string;
  error?: string;
}

interface MatchRow {
  id: string;
  match_type: string;
  target_id: string;
  score: number;
  reasons: any;
}

interface MatchTargetRow {
  id: string;
  display_name: string | null;
  topic_keys: string[] | null;
  tags: string[] | null;
  metadata: any;
  target_type: string | null;
}

// =============================================================================
// Message Templates
// =============================================================================

const TYPE_LABELS: Record<string, string> = {
  person: 'Person',
  group: 'Group',
  event: 'Event',
  service: 'Service',
  product: 'Product',
  location: 'Location',
  live_room: 'Live Room',
};

function buildProactiveMessage(
  matches: Array<{ display_name: string; match_type: string; score: number; shared_topics: string[]; deep_link: string }>,
  totalAvailable: number
): string {
  const lines: string[] = [];

  lines.push('I found some great matches for you today!');
  lines.push('');

  // Top match — highlighted
  const top = matches[0];
  const topTopics = top.shared_topics.length > 0
    ? top.shared_topics.slice(0, 3).join(', ')
    : 'your interests';
  const topLabel = TYPE_LABELS[top.match_type] || top.match_type;

  lines.push(`Your top match: ${top.display_name} [${topLabel}]`);
  lines.push(`You both share interest in ${topTopics}. Score: ${top.score}/100`);
  lines.push(top.deep_link);

  // Additional matches
  if (matches.length > 1) {
    lines.push('');
    lines.push(`I also found ${matches.length - 1} more match${matches.length - 1 > 1 ? 'es' : ''} you might like.`);
  }

  // Discover all CTA
  if (totalAvailable > matches.length) {
    lines.push(`See all ${totalAvailable} matches:`);
    lines.push(DISCOVER_URL);
  } else {
    lines.push('See all your matches:');
    lines.push(DISCOVER_URL);
  }

  return lines.join('\n');
}

// =============================================================================
// Core Service
// =============================================================================

function getServiceSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * Send proactive match messages for a single user.
 * Idempotent per user+date via dedup check.
 */
export async function sendProactiveMatchMessages(
  params: ProactiveMatchParams
): Promise<ProactiveMatchResult> {
  const { user_id, tenant_id, date, max_matches = 3, min_score = 60 } = params;
  const startTime = Date.now();

  const supabase = getServiceSupabase();
  if (!supabase) {
    return {
      ok: false,
      user_id,
      messages_sent: 0,
      matches_surfaced: [],
      error: 'Database not configured',
    };
  }

  try {
    // Step 1: Dedup — check for existing proactive message today
    const { data: existing } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('sender_id', VITANA_BOT_USER_ID)
      .eq('receiver_id', user_id)
      .eq('tenant_id', tenant_id)
      .contains('metadata', { proactive_match_date: date })
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`[${VTID}] Proactive message already sent to ${user_id} for ${date}, skipping`);

      emitOasisEvent({
        vtid: VTID,
        type: 'match.proactive.skipped' as any,
        source: 'proactive-match-messenger',
        status: 'info',
        message: 'Proactive match skipped: already sent today',
        payload: { user_id, tenant_id, date, reason: 'dedup' },
      }).catch(() => {});

      return {
        ok: true,
        user_id,
        messages_sent: 0,
        matches_surfaced: [],
        skipped_reason: 'already_sent_today',
      };
    }

    // Step 2: Fetch top matches.
    // NOTE: We deliberately do NOT use a PostgREST embed (match_targets!inner)
    // here. The embed relies on PostgREST discovering the matches_daily ->
    // match_targets FK in its schema cache. Production schema drift (FK absent
    // on the deployed table) made that lookup fail with a PGRST200
    // "Could not find a relationship ... in the schema cache" error, which
    // bypassed the table-not-deployed fallback below and threw, spamming
    // match.proactive.error. Fetching match_targets in a separate query (Step
    // 2b) removes that dependency entirely and matches how matches_daily is
    // read elsewhere in the gateway.
    const { data: matches, error: matchError } = await supabase
      .from('matches_daily')
      .select('id, match_type, target_id, score, reasons')
      .eq('user_id', user_id)
      .eq('match_date', date)
      .eq('state', 'suggested')
      .gte('score', min_score)
      .order('score', { ascending: false })
      .limit(max_matches);

    if (matchError) {
      // Graceful fallback if migration not deployed or schema drift on the
      // matches_daily table (missing table/column/relationship). These are
      // operational/data issues, not code faults — skip quietly instead of
      // emitting a P0 error event.
      const m = matchError.message || '';
      if (
        m.includes('does not exist') ||
        m.includes('relation') ||
        m.includes('Could not find') ||
        m.includes('schema cache')
      ) {
        console.warn(`[${VTID}] matches_daily unavailable (schema drift?), skipping: ${m}`);
        return {
          ok: true,
          user_id,
          messages_sent: 0,
          matches_surfaced: [],
          skipped_reason: 'table_not_available',
        };
      }

      throw new Error(`Match query failed: ${m}`);
    }

    if (!matches || matches.length === 0) {
      console.log(`[${VTID}] No qualifying matches for ${user_id} on ${date}`);

      emitOasisEvent({
        vtid: VTID,
        type: 'match.proactive.skipped' as any,
        source: 'proactive-match-messenger',
        status: 'info',
        message: 'Proactive match skipped: no qualifying matches',
        payload: { user_id, tenant_id, date, reason: 'no_matches', min_score },
      }).catch(() => {});

      return {
        ok: true,
        user_id,
        messages_sent: 0,
        matches_surfaced: [],
        skipped_reason: 'no_qualifying_matches',
      };
    }

    // Step 2b: Fetch match target details in a separate query (no embed).
    // Resilient to a missing/drifted matches_daily -> match_targets FK.
    const typedMatches = matches as unknown as MatchRow[];
    const targetIds = [...new Set(typedMatches.map((m) => m.target_id).filter(Boolean))];
    const targetMap = new Map<string, MatchTargetRow>();
    if (targetIds.length > 0) {
      const { data: targets, error: targetError } = await supabase
        .from('match_targets')
        .select('id, display_name, topic_keys, tags, metadata, target_type')
        .in('id', targetIds);

      if (targetError) {
        // Non-fatal: degrade to display_name fallbacks rather than dropping
        // the whole proactive message. Only surface as an error if it is not a
        // known schema-availability issue.
        const tm = targetError.message || '';
        if (
          !tm.includes('does not exist') &&
          !tm.includes('relation') &&
          !tm.includes('Could not find') &&
          !tm.includes('schema cache')
        ) {
          console.warn(`[${VTID}] match_targets lookup failed, using fallbacks: ${tm}`);
        }
      }

      for (const t of (targets || []) as MatchTargetRow[]) {
        targetMap.set(t.id, t);
      }
    }

    // Step 3: Get total count for context
    const { count: totalCount } = await supabase
      .from('matches_daily')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .eq('match_date', date)
      .eq('state', 'suggested');

    // Step 4: Privacy gate for person matches
    let revealMode = 'first_name';
    const { data: prefs } = await supabase
      .from('user_match_preferences')
      .select('reveal_identity_mode')
      .eq('user_id', user_id)
      .single();

    if (prefs?.reveal_identity_mode) {
      revealMode = prefs.reveal_identity_mode;
    }

    // Step 5: Build match previews
    const matchPreviews = typedMatches.map((m) => {
      const target = targetMap.get(m.target_id);
      let displayName = target?.display_name || 'Unknown';

      if (m.match_type === 'person' && revealMode === 'anonymous') {
        displayName = `Someone who shares your interests`;
      }

      const sharedTopics = (target?.topic_keys || []).slice(0, 5);

      return {
        match_id: m.id,
        match_type: m.match_type,
        target_id: m.target_id,
        display_name: displayName,
        score: m.score,
        shared_topics: sharedTopics,
        deep_link: `${MATCH_SHARE_BASE}/${m.id}`,
      };
    });

    // Step 6: Build message
    const messageContent = buildProactiveMessage(matchPreviews, totalCount || matches.length);

    // Step 7: Build metadata for frontend rich rendering
    const metadata = {
      source: 'proactive_match',
      proactive_match_date: date,
      vtid: VTID,
      matches: matchPreviews,
      discover_link: DISCOVER_URL,
      total_matches_today: totalCount || matches.length,
    };

    // Step 8: Insert chat message
    const { error: insertError } = await supabase
      .from('chat_messages')
      .insert({
        tenant_id,
        sender_id: VITANA_BOT_USER_ID,
        receiver_id: user_id,
        content: messageContent,
        message_type: 'text',
        metadata,
      });

    if (insertError) {
      throw new Error(`Chat message insert failed: ${insertError.message}`);
    }

    // Step 9: Push notification
    const topMatch = matchPreviews[0];
    notifyUserAsync(
      user_id,
      tenant_id,
      'orb_proactive_message',
      {
        title: 'New matches for you!',
        body: `${matchPreviews.length} match${matchPreviews.length > 1 ? 'es' : ''} found — your top: ${topMatch.display_name}`,
        data: {
          type: 'proactive_match',
          url: topMatch.deep_link,
          match_count: String(matchPreviews.length),
          sender_id: VITANA_BOT_USER_ID,
        },
      },
      supabase,
    );

    // Step 10: OASIS event
    const duration = Date.now() - startTime;
    emitOasisEvent({
      vtid: VTID,
      type: 'match.proactive.sent' as any,
      source: 'proactive-match-messenger',
      status: 'success',
      message: `Proactive match message sent: ${matchPreviews.length} matches`,
      payload: {
        user_id,
        tenant_id,
        date,
        match_count: matchPreviews.length,
        match_ids: matchPreviews.map(m => m.match_id),
        top_score: topMatch.score,
        total_available: totalCount || 0,
        duration_ms: duration,
      },
    }).catch(() => {});

    console.log(`[${VTID}] Proactive message sent to ${user_id}: ${matchPreviews.length} matches in ${duration}ms`);

    return {
      ok: true,
      user_id,
      messages_sent: 1,
      matches_surfaced: matchPreviews.map(m => m.match_id),
    };
  } catch (err: any) {
    console.error(`[${VTID}] Proactive match error for ${user_id}:`, err.message);

    emitOasisEvent({
      vtid: VTID,
      type: 'match.proactive.error' as any,
      source: 'proactive-match-messenger',
      status: 'error',
      message: `Proactive match error: ${err.message}`,
      payload: { user_id, tenant_id, date, error: err.message },
    }).catch(() => {});

    return {
      ok: false,
      user_id,
      messages_sent: 0,
      matches_surfaced: [],
      error: err.message,
    };
  }
}
