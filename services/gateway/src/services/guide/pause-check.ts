/**
 * Proactive Guide — Pause Check
 *
 * Single authoritative function the opener pipeline calls before producing
 * any proactive output. If any active row in user_proactive_pause covers
 * the requested scope, the opener yields silently.
 *
 * The opener MUST call isPaused() before doing any LLM-bound work.
 */

import { getSupabase } from '../../lib/supabase';
import { ProactivePause, ProactivePauseScope } from './types';

const LOG_PREFIX = '[Guide:pause-check]';

export interface PauseCheckInput {
  user_id: string;
  /** Channel the opener would render on. Used to honor channel-scoped pauses. */
  channel?: 'voice' | 'text';
  /** Category of the candidate — used to honor category-scoped pauses. */
  category?: string;
  /** Specific nudge_key — used to honor per-candidate dismissals. */
  nudge_key?: string;
}

export interface PauseCheckResult {
  paused: boolean;
  pause?: ProactivePause;
}

/**
 * Returns the first active pause that covers the requested scope, or null.
 * "Active" = paused_until > now().
 *
 * Order of precedence (most specific first):
 *   1. nudge_key match  (this exact candidate is dismissed)
 *   2. category match   (this category is muted)
 *   3. channel match    (this channel is muted)
 *   4. all              (blanket pause)
 */
export async function isPaused(input: PauseCheckInput): Promise<PauseCheckResult> {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn(`${LOG_PREFIX} no supabase client — failing OPEN (no pause)`);
    return { paused: false };
  }

  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from('user_proactive_pause')
    .select('*')
    .eq('user_id', input.user_id)
    .gt('paused_until', nowIso)
    .order('created_at', { ascending: false });

  if (error) {
    console.error(`${LOG_PREFIX} query failed:`, error.message);
    return { paused: false };
  }

  if (!data || data.length === 0) {
    return { paused: false };
  }

  const matchScopes: Array<{ scope: ProactivePauseScope; value: string | null }> = [];
  if (input.nudge_key) matchScopes.push({ scope: 'nudge_key', value: input.nudge_key });
  if (input.category)  matchScopes.push({ scope: 'category', value: input.category });
  if (input.channel)   matchScopes.push({ scope: 'channel', value: input.channel });
  matchScopes.push({ scope: 'all', value: null });

  for (const target of matchScopes) {
    const hit = data.find((row: ProactivePause) => {
      if (row.scope !== target.scope) return false;
      if (target.scope === 'all') return true;
      return row.scope_value === target.value;
    });
    if (hit) {
      return { paused: true, pause: hit as ProactivePause };
    }
  }

  return { paused: false };
}
