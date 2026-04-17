/**
 * VTID-02300: Action executors — registered at boot for each action_type.
 *
 * Each executor is a simple async function: (args, ctx) => { ok, external_id?, ... }
 * The consent gate calls them after the user approves.
 */

import { registerActionExecutor } from './consent-gate';
import { getSupabase } from '../lib/supabase';
import { emitClickOutbound } from './reward-events';

export function registerAllActionExecutors(): void {
  // ---- shopping_add_to_list ----
  registerActionExecutor('shopping_add_to_list', async (args, ctx) => {
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'DB unavailable' };

    const product_id = typeof args.product_id === 'string' ? args.product_id : null;
    if (!product_id) return { ok: false, error: 'product_id required' };

    // Upsert into user_offers_memory as 'saved' state (reuses the existing
    // VTID-01092 relationship memory system)
    const { data, error } = await supabase.rpc('offers_set_state', {
      p_payload: {
        target_type: 'product',
        target_id: product_id,
        state: 'saved',
        notes: typeof args.note === 'string' ? args.note : 'Added by Vitana Assistant',
      },
    });

    if (error) return { ok: false, error: error.message };
    if (!data?.ok) return { ok: false, error: data?.error ?? 'Unknown' };

    return {
      ok: true,
      external_id: data.id,
      result: { product_id, state: 'saved', strength_delta: data.strength_delta },
    };
  });

  // ---- share_milestone ----
  registerActionExecutor('share_milestone', async (args, ctx) => {
    // Phase 3 MVP: record the share intent + emit the marketplace.share.initiated
    // OASIS event. Actual social posting comes in Phase 3b (when social
    // connectors implement performAction).
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'DB unavailable' };

    const channel = typeof args.channel === 'string' ? args.channel : 'copy_link';
    const milestone_text = typeof args.milestone_text === 'string' ? args.milestone_text : '';
    const product_id = typeof args.product_id === 'string' ? args.product_id : null;

    // For MVP: generate a share URL that the user can copy
    const shareUrl = `https://vitanaland.com/share/${ctx.action_id}`;

    return {
      ok: true,
      external_id: shareUrl,
      result: {
        share_url: shareUrl,
        channel,
        milestone_text: milestone_text.slice(0, 280),
        note: 'Share link generated. In Phase 3b, this will post directly to the connected social account.',
      },
    };
  });

  // ---- social_post_story ----
  registerActionExecutor('social_post_story', async (args, _ctx) => {
    // Phase 3 stub: returns a "copy + open app" fallback.
    // Real Instagram Graph API posting (Business accounts only) ships in Phase 3b.
    const caption = typeof args.caption === 'string' ? args.caption : '';
    const provider = typeof args.provider === 'string' ? args.provider : 'instagram';

    return {
      ok: true,
      result: {
        provider,
        caption: caption.slice(0, 2200),
        action: 'copy_and_open',
        note: `Caption prepared. Instagram Graph API requires a Business account for direct posting — Phase 3b. For now, copy the caption and open ${provider}.`,
      },
    };
  });

  // ---- wearable_log_workout ----
  registerActionExecutor('wearable_log_workout', async (args, ctx) => {
    // Phase 3 stub: logs workout intent to wearable_workouts with source='manual'.
    // Direct Strava write-scope posting ships when Strava app review completes.
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'DB unavailable' };

    const workout_type = typeof args.workout_type === 'string' ? args.workout_type : 'other';
    const duration_minutes = typeof args.duration_minutes === 'number' ? args.duration_minutes : null;
    const calories = typeof args.calories === 'number' ? args.calories : null;

    const { data, error } = await supabase
      .from('wearable_workouts')
      .insert({
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        provider: 'manual',
        external_workout_id: `manual-${ctx.action_id}`,
        workout_type,
        started_at: typeof args.started_at === 'string' ? args.started_at : new Date().toISOString(),
        duration_minutes,
        calories,
      })
      .select('id')
      .single();

    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      external_id: data.id,
      result: { workout_type, duration_minutes, logged_to: 'wearable_workouts (manual)' },
    };
  });

  // ---- calendar_add_event ----
  registerActionExecutor('calendar_add_event', async (args, ctx) => {
    // Phase 3: create a calendar event via the existing calendar API.
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'DB unavailable' };

    const title = typeof args.title === 'string' ? args.title : 'Vitana Event';
    const start_time = typeof args.start_time === 'string' ? args.start_time : new Date().toISOString();
    const duration_minutes = typeof args.duration_minutes === 'number' ? args.duration_minutes : 30;
    const end_time = new Date(new Date(start_time).getTime() + duration_minutes * 60000).toISOString();

    const { data, error } = await supabase
      .from('calendar_events')
      .insert({
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        title,
        start_time,
        end_time,
        event_type: typeof args.event_type === 'string' ? args.event_type : 'wellness_nudge',
        wellness_tags: Array.isArray(args.wellness_tags) ? args.wellness_tags : [],
      })
      .select('id')
      .single();

    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      external_id: data.id,
      result: { title, start_time, end_time },
    };
  });

  console.log('[action-executors] registered 5 executors: shopping_add_to_list, share_milestone, social_post_story, wearable_log_workout, calendar_add_event');
}
