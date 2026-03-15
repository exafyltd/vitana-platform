/**
 * VTID-01270: Match Tool Handler
 *
 * Executes the `get_user_matches` tool registered in the tool registry.
 * Queries matches_daily + match_targets via service-role Supabase and
 * returns privacy-safe match previews with deep links.
 *
 * Called from the Gemini operator when the LLM invokes get_user_matches.
 */

import { createClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';

const VTID = 'VTID-01270';
const MATCH_SHARE_BASE = 'https://e.vitanaland.com/matches';
const DISCOVER_URL = 'https://vitanaland.com/discover';

interface MatchToolArgs {
  date?: string;
  match_type?: string;
  topic_filter?: string;
  min_score?: number;
  limit?: number;
}

interface MatchPreview {
  match_id: string;
  match_type: string;
  target_id: string;
  display_name: string;
  score: number;
  shared_topics: string[];
  reasons_summary: string;
  deep_link: string;
}

interface MatchToolResult {
  ok: boolean;
  matches: MatchPreview[];
  total_available: number;
  date: string;
  discover_all_link: string;
  error?: string;
}

function getServiceSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key);
}

function getCurrentDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Execute the get_user_matches tool.
 *
 * Queries matches_daily joined with match_targets for the given user,
 * applies filters, respects privacy settings, and returns deep-link-ready previews.
 */
export async function executeGetUserMatches(
  userId: string,
  tenantId: string,
  args: MatchToolArgs
): Promise<MatchToolResult> {
  const startTime = Date.now();
  const date = args.date || getCurrentDate();
  const limit = Math.min(args.limit || 5, 20);
  const minScore = args.min_score || 0;

  const supabase = getServiceSupabase();
  if (!supabase) {
    return {
      ok: false,
      matches: [],
      total_available: 0,
      date,
      discover_all_link: DISCOVER_URL,
      error: 'Database not configured',
    };
  }

  try {
    // Build query: matches_daily for this user + date + state=suggested
    let query = supabase
      .from('matches_daily')
      .select(`
        id,
        match_type,
        target_id,
        score,
        reasons,
        state,
        match_targets!inner (
          display_name,
          topic_keys,
          tags,
          metadata,
          target_type
        )
      `)
      .eq('user_id', userId)
      .eq('match_date', date)
      .eq('state', 'suggested')
      .gte('score', minScore)
      .order('score', { ascending: false });

    // Apply match_type filter
    if (args.match_type) {
      query = query.eq('match_type', args.match_type);
    }

    // Apply topic filter via match_targets.topic_keys array contains
    if (args.topic_filter) {
      query = query.contains('match_targets.topic_keys', [args.topic_filter]);
    }

    const { data: matches, error, count } = await query.limit(limit);

    if (error) {
      console.error(`[${VTID}] get_user_matches query error:`, error.message);

      // If table doesn't exist yet (migration not deployed), return gracefully
      if (error.message.includes('does not exist') || error.message.includes('relation')) {
        return {
          ok: true,
          matches: [],
          total_available: 0,
          date,
          discover_all_link: DISCOVER_URL,
        };
      }

      return {
        ok: false,
        matches: [],
        total_available: 0,
        date,
        discover_all_link: DISCOVER_URL,
        error: error.message,
      };
    }

    // Get total count of suggested matches for context
    const { count: totalCount } = await supabase
      .from('matches_daily')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('match_date', date)
      .eq('state', 'suggested');

    // Check user's privacy preferences for person matches
    let revealMode = 'first_name'; // default
    const { data: prefs } = await supabase
      .from('user_match_preferences')
      .select('reveal_identity_mode')
      .eq('user_id', userId)
      .single();

    if (prefs?.reveal_identity_mode) {
      revealMode = prefs.reveal_identity_mode;
    }

    // Build privacy-safe previews
    const previews: MatchPreview[] = (matches || []).map((m: any) => {
      const target = m.match_targets;
      let displayName = target?.display_name || 'Unknown';

      // Privacy gate for person matches
      if (m.match_type === 'person' && revealMode === 'anonymous') {
        displayName = `Member #${m.target_id.substring(0, 8)}`;
      }

      // Extract shared topics (up to 5)
      const sharedTopics: string[] = (target?.topic_keys || []).slice(0, 5);

      // Build reasons summary from the reasons JSONB
      let reasonsSummary = '';
      if (m.reasons?.components) {
        const topReasons = m.reasons.components
          .filter((c: any) => c.score > 0)
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, 2)
          .map((c: any) => c.component?.replace(/_/g, ' '))
          .join(', ');
        reasonsSummary = topReasons || 'overall compatibility';
      } else {
        reasonsSummary = 'shared interests';
      }

      return {
        match_id: m.id,
        match_type: m.match_type,
        target_id: m.target_id,
        display_name: displayName,
        score: m.score,
        shared_topics: sharedTopics,
        reasons_summary: reasonsSummary,
        deep_link: `${MATCH_SHARE_BASE}/${m.id}`,
      };
    });

    const duration = Date.now() - startTime;

    // Emit OASIS event
    emitOasisEvent({
      vtid: VTID,
      type: 'conversation.tool.called' as any,
      source: 'match-tool-handler',
      status: 'success',
      message: `get_user_matches returned ${previews.length} matches`,
      payload: {
        user_id: userId,
        tenant_id: tenantId,
        date,
        match_count: previews.length,
        total_available: totalCount || 0,
        filters: {
          match_type: args.match_type || 'all',
          topic_filter: args.topic_filter || null,
          min_score: minScore,
        },
        duration_ms: duration,
      },
    }).catch(() => {});

    console.log(`[${VTID}] get_user_matches: ${previews.length}/${totalCount || 0} matches in ${duration}ms`);

    return {
      ok: true,
      matches: previews,
      total_available: totalCount || 0,
      date,
      discover_all_link: DISCOVER_URL,
    };
  } catch (err: any) {
    console.error(`[${VTID}] get_user_matches error:`, err.message);
    return {
      ok: false,
      matches: [],
      total_available: 0,
      date,
      discover_all_link: DISCOVER_URL,
      error: err.message,
    };
  }
}
