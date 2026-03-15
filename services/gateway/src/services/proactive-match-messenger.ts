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
  match_targets: {
    display_name: string;
    topic_keys: string[];
    tags: string[];
    metadata: any;
    target_type: string;
  };
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

    // Step 2: Fetch top matches
    const { data: matches, error: matchError } = await supabase
      .from('matches_daily')
      .select(`
        id,
        match_type,
        target_id,
        score,
        reasons,
        match_targets!inner (
          display_name,
          topic_keys,
          tags,
          metadata,
          target_type
        )
      `)
      .eq('user_id', user_id)
      .eq('match_date', date)
      .eq('state', 'suggested')
      .gte('score', min_score)
      .order('score', { ascending: false })
      .limit(max_matches);

    if (matchError) {
      // Graceful fallback if migration not deployed
      if (matchError.message.includes('does not exist') || matchError.message.includes('relation')) {
        console.warn(`[${VTID}] matches_daily table not available, skipping`);
        return {
          ok: true,
          user_id,
          messages_sent: 0,
          matches_surfaced: [],
          skipped_reason: 'table_not_available',
        };
      }

      throw new Error(`Match query failed: ${matchError.message}`);
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
    const matchPreviews = (matches as unknown as MatchRow[]).map((m) => {
      const target = m.match_targets;
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
