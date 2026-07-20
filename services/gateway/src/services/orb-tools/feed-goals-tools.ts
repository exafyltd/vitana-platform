/**
 * Community voice tools — Feed/Content extras (A9, partial) + Goals &
 * Journey (A12), Wave 4 of docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * A9: only list_open_asks, edit_my_post, delete_my_post have real backing.
 * share_post/post_open_ask/answer_open_ask would duplicate already-shipped
 * tools (share_intent_post/post_intent/respond_to_match in
 * orb-tools-shared.ts) under new names — not re-implemented here to avoid
 * duplicate logic. bookmark_post/list_my_bookmarks/comment_on_short/
 * join_challenge/get_challenge_progress have no backing table at all and
 * stay `status: planned`.
 *
 * A12: set_goal/update_goal both map to the same journey-foundation answer
 * endpoint (life_compass is a single active-goal model, not multiple
 * concurrent goals). get_daily_priority has no backend and is not
 * implemented here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function authHeaders(id: OrbToolIdentity): Record<string, string> {
  return id.user_jwt ? { Authorization: `Bearer ${id.user_jwt}` } : {};
}

const NO_SESSION: OrbToolResult = {
  ok: true,
  result: { reason: 'no_session' },
  text: "I need your signed-in session to do that — I don't have one for this voice session.",
};

// ---------------------------------------------------------------------------
// 1. list_open_asks — GET /api/v1/community/open-asks
// ---------------------------------------------------------------------------

export const list_open_asks: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'list_open_asks requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const qs = new URLSearchParams();
  if (typeof args.kind === 'string' && args.kind) qs.set('kind', args.kind);
  if (typeof args.category_prefix === 'string' && args.category_prefix) qs.set('category_prefix', args.category_prefix);
  if (typeof args.limit === 'number') qs.set('limit', String(args.limit));
  const { ok, status, body } = await gatewayApiCall(`/api/v1/community/open-asks?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `list_open_asks failed (${status}): ${String(body.error ?? 'unknown')}` };
  const items = (Array.isArray((body as Record<string, unknown>).items) ? (body as Record<string, unknown>).items : []) as Array<{ title?: string; category?: string }>;
  if (items.length === 0) return { ok: true, result: { items: [] }, text: 'No open asks right now.' };
  return { ok: true, result: { items }, text: `${items.length} open asks: ${items.slice(0, 8).map((i) => i.title ?? i.category).join(', ')}.` };
};

// ---------------------------------------------------------------------------
// 2/3. edit_my_post / delete_my_post — direct Supabase writes on profile_posts,
// scoped by ownership (no dedicated Express route exists for either).
// ---------------------------------------------------------------------------

export const edit_my_post: Handler = async (args, id, sb) => {
  if (!id.user_id) return { ok: false, error: 'edit_my_post requires an authenticated user.' };
  const postId = String(args.post_id ?? '').trim();
  const content = String(args.content ?? '').trim();
  if (!postId || !content) return { ok: false, error: 'edit_my_post requires post_id and new content.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, post_id: postId, content },
      text: `About to change your post to: "${content}". Confirm, then call again with confirm=true.`,
    };
  }
  const { data, error } = await sb
    .from('profile_posts')
    .update({ content })
    .eq('id', postId)
    .eq('user_id', id.user_id)
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, error: `edit_my_post failed: ${error.message}` };
  if (!data) return { ok: true, result: { updated: false }, text: `I couldn't find that post of yours to edit.` };
  return { ok: true, result: { updated: true }, text: `Post updated.` };
};

export const delete_my_post: Handler = async (args, id, sb) => {
  if (!id.user_id) return { ok: false, error: 'delete_my_post requires an authenticated user.' };
  const postId = String(args.post_id ?? '').trim();
  if (!postId) return { ok: false, error: 'delete_my_post requires post_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, post_id: postId },
      text: `About to permanently delete this post. Confirm, then call again with confirm=true.`,
    };
  }
  const { data, error } = await sb
    .from('profile_posts')
    .delete()
    .eq('id', postId)
    .eq('user_id', id.user_id)
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, error: `delete_my_post failed: ${error.message}` };
  if (!data) return { ok: true, result: { deleted: false }, text: `I couldn't find that post of yours to delete.` };
  return { ok: true, result: { deleted: true }, text: `Post deleted.` };
};

// ---------------------------------------------------------------------------
// 4/6. set_goal / update_goal — both POST /api/v1/journey-foundation/answer
// (life_compass is a single active-goal model)
// ---------------------------------------------------------------------------

async function writeGoal(args: OrbToolArgs, id: OrbToolIdentity): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'This requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const value = String(args.goal ?? args.value ?? '').trim();
  if (!value) return { ok: false, error: 'A non-empty goal statement is required — re-state the full goal even when only changing the date/target.' };
  const { ok, status, body } = await gatewayApiCall('/api/v1/journey-foundation/answer', {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      step: 'life_compass',
      value,
      category: typeof args.category === 'string' ? args.category : undefined,
      target_value: typeof args.target_value === 'number' ? args.target_value : undefined,
      target_unit: typeof args.target_unit === 'string' ? args.target_unit : undefined,
      target_date: typeof args.target_date === 'string' ? args.target_date : undefined,
      starting_value: typeof args.starting_value === 'number' ? args.starting_value : undefined,
    },
  });
  if (!ok) return { ok: true, result: { saved: false, status, detail: body }, text: `Could not save your goal: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { saved: true, detail: body }, text: `Goal saved: "${value}".` };
}

export const set_goal: Handler = async (args, id) => writeGoal(args, id);
export const update_goal: Handler = async (args, id) => writeGoal(args, id);

// ---------------------------------------------------------------------------
// 5/7. list_my_goals / get_goal_progress — GET /api/v1/my-journey
// (single active goal model — no multi-goal list exists)
// ---------------------------------------------------------------------------

async function fetchJourney(id: OrbToolIdentity): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  return gatewayApiCall('/api/v1/my-journey', { headers: authHeaders(id) });
}

export const list_my_goals: Handler = async (_args, id) => {
  if (!id.user_id) return { ok: false, error: 'list_my_goals requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await fetchJourney(id);
  if (!ok) return { ok: false, error: `list_my_goals failed (${status}): ${String(body.error ?? 'unknown')}` };
  const goal = (body.life_compass ?? body.goal ?? null) as Record<string, unknown> | null;
  if (!goal || !goal.primary_goal) {
    return { ok: true, result: { goal: null }, text: 'You don\'t have an active goal set yet — you only have one active goal at a time (not a list).' };
  }
  return { ok: true, result: { goal }, text: `Your goal: ${String(goal.primary_goal)}.` };
};

export const get_goal_progress: Handler = async (_args, id) => {
  if (!id.user_id) return { ok: false, error: 'get_goal_progress requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await fetchJourney(id);
  if (!ok) return { ok: false, error: `get_goal_progress failed (${status}): ${String(body.error ?? 'unknown')}` };
  const goal = (body.life_compass ?? body.goal ?? {}) as Record<string, unknown>;
  if (!goal.primary_goal) return { ok: true, result: { has_goal: false }, text: 'No active goal to report progress on.' };
  const pct = goal.goal_progress_pct;
  return {
    ok: true,
    result: goal,
    text: `Day ${String(goal.goal_day ?? '?')} of ${String(goal.goal_total_days ?? '?')}${typeof pct === 'number' ? ` (${pct}%)` : ''}${goal.days_to_deadline ? `, ${goal.days_to_deadline} days to your deadline` : ''}.`,
  };
};

// ---------------------------------------------------------------------------
// 8. get_journey_checkpoints — GET /api/v1/goal-plan (.checkpoints)
// ---------------------------------------------------------------------------

export const get_journey_checkpoints: Handler = async (_args, id) => {
  if (!id.user_id) return { ok: false, error: 'get_journey_checkpoints requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/goal-plan', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `get_journey_checkpoints failed (${status}): ${String(body.error ?? 'unknown')}` };
  const plan = (body.plan ?? body) as Record<string, unknown>;
  const checkpoints = (Array.isArray(plan.checkpoints) ? plan.checkpoints : []) as Array<{ title?: string; status?: string }>;
  if (checkpoints.length === 0) return { ok: true, result: { checkpoints: [] }, text: 'No checkpoints in your goal plan yet.' };
  return { ok: true, result: { checkpoints }, text: `${checkpoints.length} checkpoints: ${checkpoints.slice(0, 8).map((c) => `${c.title} (${c.status})`).join(', ')}.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const FEED_GOALS_TOOL_HANDLERS: Record<string, Handler> = {
  list_open_asks,
  edit_my_post,
  delete_my_post,
  set_goal,
  list_my_goals,
  update_goal,
  get_goal_progress,
  get_journey_checkpoints,
};

export const FEED_GOALS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'list_open_asks', description: 'Browse open community asks.', parameters: { type: 'object', properties: { kind: { type: 'string' }, category_prefix: { type: 'string' }, limit: { type: 'integer' } } } },
  {
    name: 'edit_my_post',
    description: 'Edit the content of your own post. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { post_id: { type: 'string', description: 'Required.' }, content: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['post_id', 'content'] },
  },
  {
    name: 'delete_my_post',
    description: 'Permanently delete your own post. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { post_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['post_id'] },
  },
  {
    name: 'set_goal',
    description: 'Set your goal / north star. You have one active goal at a time.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal statement. Required.' },
        category: { type: 'string' }, target_value: { type: 'number' }, target_unit: { type: 'string' },
        target_date: { type: 'string' }, starting_value: { type: 'number' },
      },
      required: ['goal'],
    },
  },
  { name: 'list_my_goals', description: 'Your active goal (single-goal model, not a list).', parameters: { type: 'object', properties: {} } },
  {
    name: 'update_goal',
    description: 'Adjust your goal — re-state the full goal text even when only changing the date/target.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The full, updated goal statement. Required.' },
        category: { type: 'string' }, target_value: { type: 'number' }, target_unit: { type: 'string' }, target_date: { type: 'string' },
      },
      required: ['goal'],
    },
  },
  { name: 'get_goal_progress', description: 'Progress readout on your active goal.', parameters: { type: 'object', properties: {} } },
  { name: 'get_journey_checkpoints', description: 'Checkpoints in your goal plan.', parameters: { type: 'object', properties: {} } },
];
