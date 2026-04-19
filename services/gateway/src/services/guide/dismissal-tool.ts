/**
 * Proactive Guide — Dismissal Tool
 *
 * Tool the LLM calls when it detects the user wants to back off:
 *   - "skip it"          → dismiss the current candidate (silence 24h)
 *   - "not today"        → pause all proactive until tomorrow 06:00
 *   - "give me space"    → pause all 48h
 *   - "not this week"    → pause all 7d
 *   - "don't mention X"  → mute category permanently-ish (90d)
 *   - "you can talk again" → clear all active pauses
 *
 * The LLM is responsible for detecting the intent — its language understanding
 * is more flexible than any regex. The system prompt (Proactive Opener Rules
 * + Silent Honor Rules) tells it when to call this tool and how to respond
 * after calling (briefly, no apology, no "I'll stop now" speech).
 */

import { getSupabase } from '../../lib/supabase';
import { ProactivePauseScope } from './types';
import { emitGuideTelemetry } from './guide-telemetry';

const LOG_PREFIX = '[Guide:dismissal-tool]';

export const PAUSE_PROACTIVE_GUIDANCE_TOOL = {
  name: 'pause_proactive_guidance',
  description:
    'Honor a user request to back off from proactive suggestions. ' +
    'Call this when the user says "skip it", "not today", "give me space", ' +
    '"not this week", "don\'t mention X again", "stop being proactive", ' +
    'or any equivalent. Choose scope + duration that matches what they asked. ' +
    'After calling, respond briefly (max one short acknowledgement like "got it") ' +
    'and pivot naturally — do NOT apologize or make a thing of it.',
  parameters: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['all', 'category', 'nudge_key', 'channel'],
        description:
          '"all" = pause all proactive openers. ' +
          '"category" = mute a domain (use scope_value, e.g., "business_hub", "calendar"). ' +
          '"nudge_key" = dismiss the specific candidate just surfaced (use scope_value with the candidate\'s nudge_key). ' +
          '"channel" = mute on a specific channel (scope_value="voice" or "text"). ' +
          'Default: "all" if unsure.',
      },
      scope_value: {
        type: 'string',
        description:
          'Required when scope is category, nudge_key, or channel. Omit for scope=all.',
      },
      duration_minutes: {
        type: 'integer',
        description:
          'Pause duration in minutes. Examples: ' +
          '"not today" → minutes until 06:00 next day (compute from now), ' +
          '"give me space" → 2880 (48h), ' +
          '"not this week" → 10080 (7d), ' +
          '"don\'t mention X again" → 129600 (90d). ' +
          'Default 1440 (24h) when uncertain.',
      },
      reason: {
        type: 'string',
        description: 'Short paraphrase of what the user said. Stored for transparency. Optional.',
      },
    },
    required: ['scope'],
  },
};

export const CLEAR_PROACTIVE_PAUSES_TOOL = {
  name: 'clear_proactive_pauses',
  description:
    'Clear all active proactive pauses for the user. Call this when the user ' +
    'explicitly invites you to be proactive again — "you can talk again", ' +
    '"go ahead and suggest things", "ok resume". After calling, you may resume ' +
    'normal proactive behavior, but do not immediately surface a backlog of suggestions.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export interface PauseToolInput {
  scope: ProactivePauseScope;
  scope_value?: string;
  duration_minutes?: number;
  reason?: string;
}

export interface PauseToolResult {
  success: boolean;
  paused_until?: string;
  scope?: ProactivePauseScope;
  scope_value?: string | null;
  error?: string;
}

/**
 * Execute the pause_proactive_guidance tool. Writes user_proactive_pause row.
 */
export async function executePauseProactiveGuidance(
  args: PauseToolInput,
  context: { user_id: string; channel: 'voice' | 'text' },
): Promise<PauseToolResult> {
  const supabase = getSupabase();
  if (!supabase) {
    return { success: false, error: 'storage_unavailable' };
  }

  if (args.scope !== 'all' && !args.scope_value) {
    return { success: false, error: 'scope_value_required' };
  }

  const durationMinutes = clampDuration(args.duration_minutes ?? 1440);
  const pausedUntil = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('user_proactive_pause')
    .insert({
      user_id: context.user_id,
      scope: args.scope,
      scope_value: args.scope === 'all' ? null : (args.scope_value ?? null),
      paused_from: new Date().toISOString(),
      paused_until: pausedUntil,
      reason: args.reason ?? null,
      created_via: context.channel === 'voice' ? 'voice' : 'text',
    })
    .select()
    .single();

  if (error) {
    console.error(`${LOG_PREFIX} insert failed:`, error.message);
    return { success: false, error: error.message };
  }

  // Also write to user_nudge_state if scope=nudge_key so opener-mvp's
  // silenced_until check honors it on next pickOpenerCandidate.
  if (args.scope === 'nudge_key' && args.scope_value) {
    await supabase
      .from('user_nudge_state')
      .upsert(
        {
          user_id: context.user_id,
          nudge_key: args.scope_value,
          dismissed_at: new Date().toISOString(),
          silenced_until: pausedUntil,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,nudge_key' },
      );
  }

  await emitGuideTelemetry('guide.dismissal.pause_created', {
    user_id: context.user_id,
    scope: args.scope,
    scope_value: args.scope_value ?? null,
    duration_minutes: durationMinutes,
    paused_until: pausedUntil,
    via: context.channel,
  });

  console.log(
    `${LOG_PREFIX} pause created: scope=${args.scope} value=${args.scope_value ?? '-'} ` +
    `until=${pausedUntil} for user=${context.user_id}`,
  );

  return {
    success: true,
    paused_until: pausedUntil,
    scope: args.scope,
    scope_value: data?.scope_value ?? null,
  };
}

/**
 * Execute the clear_proactive_pauses tool. Deletes all currently-active pauses
 * for the user (does not touch already-expired rows — they stay as history).
 */
export async function executeClearProactivePauses(
  context: { user_id: string },
): Promise<{ success: boolean; cleared_count: number; error?: string }> {
  const supabase = getSupabase();
  if (!supabase) {
    return { success: false, cleared_count: 0, error: 'storage_unavailable' };
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('user_proactive_pause')
    .update({ paused_until: nowIso })
    .eq('user_id', context.user_id)
    .gt('paused_until', nowIso)
    .select('id');

  if (error) {
    console.error(`${LOG_PREFIX} clear failed:`, error.message);
    return { success: false, cleared_count: 0, error: error.message };
  }

  const count = data?.length ?? 0;

  await emitGuideTelemetry('guide.dismissal.pause_cleared', {
    user_id: context.user_id,
    cleared_count: count,
  });

  console.log(`${LOG_PREFIX} cleared ${count} active pauses for user=${context.user_id}`);

  return { success: true, cleared_count: count };
}

function clampDuration(minutes: number): number {
  // Floor 1 minute, ceiling 1 year (don't let users accidentally lock proactive
  // forever — settings UI in Phase 7 handles permanent disable explicitly).
  return Math.max(1, Math.min(525_600, Math.floor(minutes)));
}
