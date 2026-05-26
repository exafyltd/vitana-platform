/**
 * VTID-03152 — Vitana-prescribed goal plan (Slice E).
 *
 * Turns a user's stated goal (life_compass row with a target_date) into a
 * structured plan via the LLM planner stage: milestones + weekly checkpoints +
 * recurring daily habits. Persists to goal_plans / goal_plan_steps and mirrors
 * scheduled steps onto the calendar. The My Journey screen reads the plan for
 * the day-by-day view and today's steps.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { callViaRouter } from '../llm-router';
import { bulkCreateCalendarEvents } from '../calendar-service';
import type { CreateCalendarEventInput } from '../../types/calendar';

const LOG = '[VTID-03152 goal-planner]';

export type GoalStepKind = 'milestone' | 'checkpoint' | 'habit';

export interface GoalStepDraft {
  kind: GoalStepKind;
  title: string;
  description: string | null;
  day_offset: number | null;
  scheduled_date: string | null; // YYYY-MM-DD
  sort_order: number;
}

export interface LLMPlan {
  plan_summary: string;
  milestones: Array<{ day_offset: number; title: string; description?: string }>;
  weekly_checkpoints?: Array<{ day_offset: number; title: string; description?: string }>;
  daily_habits: Array<{ title: string; description?: string }>;
}

interface ActiveGoal {
  id: string;
  primary_goal: string;
  category: string | null;
  target_date: string; // YYYY-MM-DD
  target_value: number | null;
  target_unit: string | null;
  set_at: string; // ISO
  tenant_id?: string | null;
}

/** YYYY-MM-DD for the calendar date `n` days after an ISO date string (UTC). */
export function addDaysIso(startIso: string, n: number): string {
  const d = new Date(startIso);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

/** Whole calendar days between two ISO dates (b - a), UTC-midnight normalized. */
export function calendarDaysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso);
  const b = new Date(bIso);
  const am = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bm = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((bm - am) / 86_400_000);
}

/**
 * Pure: map a validated LLM plan to persistable step drafts. Milestones and
 * checkpoints get a clamped day_offset (0..totalDays) and a concrete date;
 * habits are dateless (they recur every day). Deterministic ordering.
 */
export function mapPlanToSteps(plan: LLMPlan, startDateIso: string, totalDays: number): GoalStepDraft[] {
  const steps: GoalStepDraft[] = [];
  let order = 0;

  const dated = (
    items: Array<{ day_offset: number; title: string; description?: string }> | undefined,
    kind: 'milestone' | 'checkpoint',
  ) => {
    for (const it of items ?? []) {
      if (!it.title) continue;
      const offset = Math.max(0, Math.min(totalDays, Math.round(Number(it.day_offset) || 0)));
      steps.push({
        kind,
        title: it.title,
        description: it.description ?? null,
        day_offset: offset,
        scheduled_date: addDaysIso(startDateIso, offset),
        sort_order: order++,
      });
    }
  };

  dated(plan.milestones, 'milestone');
  dated(plan.weekly_checkpoints, 'checkpoint');

  for (const h of plan.daily_habits ?? []) {
    if (!h.title) continue;
    steps.push({
      kind: 'habit',
      title: h.title,
      description: h.description ?? null,
      day_offset: null,
      scheduled_date: null,
      sort_order: order++,
    });
  }

  // Dated steps sorted by date so the day-by-day view is chronological.
  steps.sort((a, b) => {
    if (a.scheduled_date && b.scheduled_date) return a.scheduled_date.localeCompare(b.scheduled_date);
    if (a.scheduled_date) return -1;
    if (b.scheduled_date) return 1;
    return a.sort_order - b.sort_order;
  });
  return steps.map((s, i) => ({ ...s, sort_order: i }));
}

async function fetchActiveGoal(client: SupabaseClient, userId: string): Promise<ActiveGoal | null> {
  const { data, error } = await client
    .from('life_compass')
    .select('id, primary_goal, category, target_date, target_value, target_unit, created_at, tenant_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const row = data[0] as any;
  if (!row.target_date) return null; // a plan needs a deadline
  return {
    id: row.id,
    primary_goal: row.primary_goal,
    category: row.category ?? null,
    target_date: row.target_date,
    target_value: row.target_value ?? null,
    target_unit: row.target_unit ?? null,
    set_at: row.created_at,
    tenant_id: row.tenant_id ?? null,
  };
}

function buildPrompt(goal: ActiveGoal, startDateIso: string, totalDays: number): { system: string; user: string } {
  const target =
    goal.target_value != null && goal.target_unit
      ? `${goal.target_value} ${goal.target_unit}`
      : 'the stated outcome';
  const system =
    'You are Vitana, a warm, expert longevity and wellness coach. Given a user goal and a ' +
    'timeframe, design a realistic, encouraging plan to reach it. Prefer a small number of ' +
    'meaningful milestones, a weekly checkpoint cadence, and 3-5 sustainable daily habits — ' +
    'never a rote action for every single day. Keep titles short and motivating; keep ' +
    'descriptions to one sentence. day_offset is the number of days after the start (0 = today). ' +
    'Spread milestones and checkpoints across the whole timeframe up to the final day.';
  const user =
    `Goal: "${goal.primary_goal}"\n` +
    `Quantified target: ${target}\n` +
    `Start day offset: 0 (${startDateIso})\n` +
    `Final day offset: ${totalDays} (deadline ${goal.target_date})\n` +
    `Total days: ${totalDays}\n\n` +
    'Produce the plan via the prescribe_plan tool. Ensure the last milestone lands on or near ' +
    `day_offset ${totalDays}. Weekly checkpoints roughly every 7 days.`;
  return { system, user };
}

const PLAN_TOOL = {
  name: 'prescribe_plan',
  description: 'Return a structured plan to reach the goal by the deadline.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_summary: { type: 'string', description: 'Two warm sentences summarizing the approach.' },
      milestones: {
        type: 'array',
        description: 'Key dated achievements across the timeframe.',
        items: {
          type: 'object',
          properties: {
            day_offset: { type: 'integer' },
            title: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['day_offset', 'title'],
        },
      },
      weekly_checkpoints: {
        type: 'array',
        description: 'Roughly weekly review points.',
        items: {
          type: 'object',
          properties: {
            day_offset: { type: 'integer' },
            title: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['day_offset', 'title'],
        },
      },
      daily_habits: {
        type: 'array',
        description: '3-5 sustainable daily habits.',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, description: { type: 'string' } },
          required: ['title'],
        },
      },
    },
    required: ['plan_summary', 'milestones', 'daily_habits'],
  },
} as const;

function validatePlan(raw: unknown): LLMPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as any;
  if (typeof r.plan_summary !== 'string') return null;
  if (!Array.isArray(r.milestones) || !Array.isArray(r.daily_habits)) return null;
  return {
    plan_summary: r.plan_summary,
    milestones: r.milestones,
    weekly_checkpoints: Array.isArray(r.weekly_checkpoints) ? r.weekly_checkpoints : [],
    daily_habits: r.daily_habits,
  };
}

/**
 * Generate (or regenerate) the active goal plan for a user. Supersedes any prior
 * active plan. Returns the new plan id, or null when there's no goal/deadline or
 * the LLM call fails (caller decides how to surface).
 */
export async function generateGoalPlan(
  client: SupabaseClient,
  userId: string,
): Promise<{ plan_id: string; step_count: number } | null> {
  const goal = await fetchActiveGoal(client, userId);
  if (!goal) {
    console.warn(`${LOG} no active goal with a deadline for user ${userId}`);
    return null;
  }

  const startIso = goal.set_at;
  const startDate = startIso.slice(0, 10);
  const totalDays = Math.max(1, calendarDaysBetween(startIso, goal.target_date));

  const { system, user } = buildPrompt(goal, startDate, totalDays);
  const result = await callViaRouter('planner', user, {
    service: 'goal-planner',
    systemPrompt: system,
    maxTokens: 2500,
    tools: [PLAN_TOOL as any],
    forceTool: 0,
  });
  if (!result.ok || !result.toolCall) {
    console.error(`${LOG} LLM plan generation failed: ${result.error ?? 'no tool call'}`);
    return null;
  }
  const plan = validatePlan(result.toolCall.arguments);
  if (!plan) {
    console.error(`${LOG} LLM plan failed validation`);
    return null;
  }

  const drafts = mapPlanToSteps(plan, startIso, totalDays);

  // Supersede prior active plans before inserting the new one.
  await client.from('goal_plans').update({ status: 'superseded' }).eq('user_id', userId).eq('status', 'active');

  const { data: planRows, error: planErr } = await client
    .from('goal_plans')
    .insert({
      user_id: userId,
      tenant_id: goal.tenant_id ?? null,
      life_compass_id: goal.id,
      goal_text: goal.primary_goal,
      plan_summary: plan.plan_summary,
      start_date: startDate,
      target_date: goal.target_date,
      total_days: totalDays,
      status: 'active',
      model: result.model ?? null,
    })
    .select('id')
    .single();
  if (planErr || !planRows) {
    console.error(`${LOG} insert goal_plans failed: ${planErr?.message}`);
    return null;
  }
  const planId = (planRows as any).id as string;

  const { data: stepRows, error: stepErr } = await client
    .from('goal_plan_steps')
    .insert(
      drafts.map((s) => ({
        plan_id: planId,
        user_id: userId,
        kind: s.kind,
        title: s.title,
        description: s.description,
        day_offset: s.day_offset,
        scheduled_date: s.scheduled_date,
        sort_order: s.sort_order,
        status: 'pending',
      })),
    )
    .select('id, kind, title, description, scheduled_date');
  if (stepErr) {
    console.error(`${LOG} insert goal_plan_steps failed: ${stepErr.message}`);
    return null;
  }

  await mirrorStepsToCalendar(userId, planId, goal, startDate, (stepRows as any[]) ?? []);

  return { plan_id: planId, step_count: drafts.length };
}

/** Best-effort: write dated steps as calendar events and habits as one recurring event. */
async function mirrorStepsToCalendar(
  userId: string,
  planId: string,
  goal: ActiveGoal,
  startDate: string,
  steps: Array<{ id: string; kind: string; title: string; description: string | null; scheduled_date: string | null }>,
): Promise<void> {
  try {
    const events: CreateCalendarEventInput[] = [];
    for (const s of steps) {
      if ((s.kind === 'milestone' || s.kind === 'checkpoint') && s.scheduled_date) {
        events.push({
          title: s.title,
          description: s.description,
          start_time: `${s.scheduled_date}T09:00:00.000Z`,
          end_time: null,
          event_type: 'journey_milestone',
          status: 'pending',
          priority: 'medium',
          role_context: 'community',
          source_type: 'journey',
          source_ref_id: s.id,
          source_ref_type: `goal_${s.kind}`,
          priority_score: 60,
          wellness_tags: [],
          metadata: { goal_plan_id: planId, life_compass_id: goal.id, goal_text: goal.primary_goal },
          is_recurring: false,
        } as CreateCalendarEventInput);
      } else if (s.kind === 'habit') {
        events.push({
          title: s.title,
          description: s.description,
          start_time: `${startDate}T08:00:00.000Z`,
          end_time: null,
          event_type: 'wellness_nudge',
          status: 'pending',
          priority: 'medium',
          role_context: 'community',
          source_type: 'journey',
          source_ref_id: s.id,
          source_ref_type: 'goal_habit',
          priority_score: 50,
          wellness_tags: [],
          metadata: { goal_plan_id: planId, life_compass_id: goal.id },
          is_recurring: true,
          recurring_pattern: { freq: 'daily', until: goal.target_date },
        } as CreateCalendarEventInput);
      }
    }
    if (events.length > 0) {
      const created = await bulkCreateCalendarEvents(userId, events);
      console.log(`${LOG} mirrored ${created.length}/${events.length} steps to calendar`);
    }
  } catch (e: any) {
    console.error(`${LOG} calendar mirror failed (non-fatal): ${e?.message}`);
  }
}

export interface GoalPlanStep {
  id: string;
  kind: GoalStepKind;
  title: string;
  description: string | null;
  day_offset: number | null;
  scheduled_date: string | null;
  status: string;
  sort_order: number;
}

export interface GoalPlanView {
  id: string;
  goal_text: string;
  plan_summary: string | null;
  start_date: string;
  target_date: string;
  total_days: number;
  day: number;       // current day offset (clamped 0..total_days)
  days_left: number; // calendar days until target_date (>=0)
  status: string;
  milestones: GoalPlanStep[];
  checkpoints: GoalPlanStep[];
  habits: GoalPlanStep[];
}

/** Read the active plan + steps and compute live day/days-left. Null when none. */
export async function getGoalPlan(client: SupabaseClient, userId: string): Promise<GoalPlanView | null> {
  const { data: planRows, error: planErr } = await client
    .from('goal_plans')
    .select('id, goal_text, plan_summary, start_date, target_date, total_days, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('generated_at', { ascending: false })
    .limit(1);
  if (planErr || !planRows || planRows.length === 0) return null;
  const plan = planRows[0] as any;

  const { data: steps } = await client
    .from('goal_plan_steps')
    .select('id, kind, title, description, day_offset, scheduled_date, status, sort_order')
    .eq('plan_id', plan.id)
    .order('sort_order', { ascending: true });

  const all = (steps as GoalPlanStep[]) ?? [];
  const nowIso = new Date().toISOString();
  const day = Math.max(0, Math.min(plan.total_days, calendarDaysBetween(plan.start_date, nowIso)));
  const daysLeft = Math.max(0, calendarDaysBetween(nowIso, plan.target_date));

  return {
    id: plan.id,
    goal_text: plan.goal_text,
    plan_summary: plan.plan_summary ?? null,
    start_date: plan.start_date,
    target_date: plan.target_date,
    total_days: plan.total_days,
    day,
    days_left: daysLeft,
    status: plan.status,
    milestones: all.filter((s) => s.kind === 'milestone'),
    checkpoints: all.filter((s) => s.kind === 'checkpoint'),
    habits: all.filter((s) => s.kind === 'habit'),
  };
}

/** Mark a plan step done/pending. Scoped to the user. */
export async function setStepStatus(
  client: SupabaseClient,
  userId: string,
  stepId: string,
  status: 'done' | 'pending',
): Promise<boolean> {
  const { error } = await client
    .from('goal_plan_steps')
    .update({ status, completed_at: status === 'done' ? new Date().toISOString() : null })
    .eq('id', stepId)
    .eq('user_id', userId);
  if (error) {
    console.error(`${LOG} setStepStatus failed: ${error.message}`);
    return false;
  }
  return true;
}
