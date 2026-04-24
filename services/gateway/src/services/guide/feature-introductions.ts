/**
 * Companion Phase G — Feature-Introduction Tracking (VTID-01932)
 *
 * Records which platform features Vitana has already explained to each user.
 * Brain reads from getFeatureIntroductions() and instructs the LLM not to
 * re-introduce features in the list. The LLM calls record_feature_introduction
 * (Gemini tool) after explaining a feature, which writes a row.
 *
 * This stops Vitana from explaining "Life Compass" or "Vitana Index" every
 * single session to a Day-30+ user who has heard the explanation already.
 */

import { getSupabase } from '../../lib/supabase';
import { emitGuideTelemetry } from './guide-telemetry';

const LOG_PREFIX = '[Guide:feature-introductions]';

/**
 * Canonical feature keys. The LLM is told which ones it can record.
 * Adding a new key here makes it admin-discoverable but also requires
 * the LLM to know about it (system prompt updated by Phase B config).
 */
export const KNOWN_FEATURE_KEYS = [
  'life_compass',
  'vitana_index',
  'autopilot',
  'memory_garden',
  'calendar',
  'business_hub',
  'marketplace',
  'journey_90day',
  'voice_chat_basics',
  'dismissal_phrases',
  'goal_changing',
  'navigator',
  'community',
  // BOOTSTRAP-DYK-TOUR: Index-centric Did-You-Know tour additions
  'vitana_index_detail',
  'health_section',
  'my_journey',
  'autopilot_index_impact',
  'calendar_index_impact',
] as const;

export type FeatureKey = (typeof KNOWN_FEATURE_KEYS)[number] | string;

export interface FeatureIntroduction {
  feature_key: string;
  introduced_at: string;
  channel: 'voice' | 'text' | 'system';
}

/**
 * Read all features Vitana has already introduced to this user.
 * Returns empty array on any error (safe fallback — worst case Vitana
 * re-introduces a feature, which is better than crashing).
 */
export async function getFeatureIntroductions(userId: string): Promise<FeatureIntroduction[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('user_feature_introductions')
    .select('feature_key, introduced_at, channel')
    .eq('user_id', userId)
    .order('introduced_at', { ascending: false })
    .limit(50);

  if (error) {
    console.warn(`${LOG_PREFIX} read failed:`, error.message);
    return [];
  }
  return (data || []) as FeatureIntroduction[];
}

/**
 * Record that Vitana has now explained a feature to this user.
 * Idempotent — re-recording the same feature updates introduced_at.
 */
export async function recordFeatureIntroduction(
  userId: string,
  featureKey: string,
  channel: 'voice' | 'text' | 'system' = 'voice',
  context: Record<string, unknown> = {},
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabase();
  if (!supabase) return { success: false, error: 'storage_unavailable' };

  const { error } = await supabase.from('user_feature_introductions').upsert(
    {
      user_id: userId,
      feature_key: featureKey,
      introduced_at: new Date().toISOString(),
      channel,
      context,
    },
    { onConflict: 'user_id,feature_key' },
  );

  if (error) {
    console.warn(`${LOG_PREFIX} write failed for ${featureKey}:`, error.message);
    return { success: false, error: error.message };
  }

  emitGuideTelemetry('guide.feature_introduction.recorded', {
    user_id: userId,
    feature_key: featureKey,
    channel,
  }).catch(() => {});

  console.log(`${LOG_PREFIX} recorded ${featureKey} for user=${userId.substring(0, 8)}`);
  return { success: true };
}

/**
 * Gemini tool definition — the LLM calls this after explaining a feature.
 * Brain registers this in buildBrainToolDefinitions and dispatches in
 * executeBrainTool.
 */
export const RECORD_FEATURE_INTRODUCTION_TOOL = {
  name: 'record_feature_introduction',
  description:
    'Record that you have just explained a platform feature to the user. ' +
    'Call this immediately AFTER you finish explaining a feature so you do not ' +
    'explain it again in future sessions. Only call when you have actually ' +
    'covered what the feature does, not for passing mentions.',
  parameters: {
    type: 'object',
    properties: {
      feature_key: {
        type: 'string',
        enum: KNOWN_FEATURE_KEYS as unknown as string[],
        description:
          'The feature you just explained. Must be one of the canonical keys.',
      },
    },
    required: ['feature_key'],
  },
};
