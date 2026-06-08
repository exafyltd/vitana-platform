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
import { getUserLocale } from '../../i18n/server-locale';
import { seedGoalPlanSourceCache } from './goal-plan-i18n';
import type { CreateCalendarEventInput } from '../../types/calendar';

const LOG = '[VTID-03152 goal-planner]';

// Localized question generation — broad goals ask the user to clarify in their
// own language so a German user never sees English questions.
const LANGUAGE_NAMES: Record<string, string> = {
  de: 'German',
  en: 'English',
  es: 'Spanish',
  sr: 'Serbian',
};

// Intent gloss for the canonical Life Compass preset categories. The presets
// store only a short title + category (the rich description lives in the
// frontend), so we restate each domain's intent here to ground the planner and
// clarifying questions across all suggested goals.
const CATEGORY_INTENT: Record<string, string> = {
  relationship: 'building meaningful romantic relationships and finding a life partner',
  health: 'achieving optimal physical and mental wellness',
  career: 'building a fulfilling and successful career',
  learning: 'learning and growing through new skills and knowledge',
  spiritual: 'deepening purpose, presence, and inner peace',
  longevity: 'healthspan, energy, and longevity',
  wealth: 'building financial freedom and security',
};

function goalDomain(goal: ActiveGoal): string | null {
  if (!goal.category) return null;
  return CATEGORY_INTENT[goal.category.trim().toLowerCase()] ?? goal.category;
}

export interface ClarificationAnswer {
  question: string;
  answer: string;
}

export interface ClarifyResult {
  hasGoal: boolean;
  specific: boolean;
  questions: string[];
}

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
    .select('id, primary_goal, category, target_date, target_value, target_unit, created_at')
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
    tenant_id: null, // life_compass has no tenant_id column
  };
}

function buildPrompt(
  goal: ActiveGoal,
  startDateIso: string,
  totalDays: number,
  answers?: ClarificationAnswer[],
  language: string = 'English',
): { system: string; user: string } {
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
  const clarifications =
    answers && answers.length
      ? '\nThe user answered these clarifying questions — use them to make the plan concrete and personal:\n' +
        answers
          .map((a) => `Q: ${a.question}\nA: ${a.answer?.trim() ? a.answer.trim() : '(no answer — make a sensible assumption)'}`)
          .join('\n') +
        '\n'
      : '';
  const user =
    `Goal: "${goal.primary_goal}"\n` +
    (goalDomain(goal) ? `Life domain: ${goalDomain(goal)}\n` : '') +
    `Quantified target: ${target}\n` +
    `Start day offset: 0 (${startDateIso})\n` +
    `Final day offset: ${totalDays} (deadline ${goal.target_date})\n` +
    `Total days: ${totalDays}\n` +
    clarifications +
    '\nRespond with ONLY a JSON object — no markdown fences, no commentary — of exactly this shape:\n' +
    '{"plan_summary": string, ' +
    '"milestones": [{"day_offset": number, "title": string, "description": string}], ' +
    '"weekly_checkpoints": [{"day_offset": number, "title": string, "description": string}], ' +
    '"daily_habits": [{"title": string, "description": string}]}\n' +
    `Write ALL content in ${language}: every plan_summary, title, and description must be in ${language}. ` +
    'Keep the JSON field names (plan_summary, milestones, weekly_checkpoints, daily_habits, day_offset, title, description) in English.\n' +
    `Include 5-8 milestones spread from day 0 to day ${totalDays} (the last on or near day ${totalDays}), ` +
    'a roughly weekly checkpoint cadence, and 3-5 sustainable daily habits.';
  return { system, user };
}

function parseQuestions(raw: unknown): ClarifyResult['questions'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as any;
  if (typeof r.specific !== 'boolean') return null;
  if (r.specific) return [];
  if (!Array.isArray(r.questions)) return [];
  return r.questions
    .filter((q: unknown) => typeof q === 'string' && q.trim())
    .map((q: string) => q.trim())
    .slice(0, 3);
}

/**
 * Ask the planner whether the goal is specific enough to build a concrete plan.
 * Broad goals (e.g. "Master new skills", "Advance career") return 2-3 short
 * clarifying questions, written in the user's language, so the plan can be
 * personalized. Fails open (treats the goal as specific) on any LLM error so a
 * hiccup never blocks plan generation.
 */
export async function clarifyGoalIfNeeded(client: SupabaseClient, userId: string): Promise<ClarifyResult> {
  const goal = await fetchActiveGoal(client, userId);
  if (!goal) return { hasGoal: false, specific: true, questions: [] };

  const locale = await getUserLocale(client, userId).catch(() => 'en');
  const language = LANGUAGE_NAMES[locale] ?? 'English';
  const target =
    goal.target_value != null && goal.target_unit ? `${goal.target_value} ${goal.target_unit}` : 'unspecified';

  const system =
    'You are Vitana, a warm longevity and wellness coach. Decide whether a user goal is specific ' +
    'enough to design a concrete, personalized day-by-day plan. A goal is NOT specific enough when ' +
    'key details are missing — e.g. which skill, what kind of career move, what target, or important ' +
    'constraints (time, budget, starting point). Ask only what genuinely changes the plan.';
  const domain = goalDomain(goal);
  const user =
    `Goal: "${goal.primary_goal}"\nQuantified target: ${target}\n` +
    (domain ? `Life domain: ${domain}\n` : `Category: ${goal.category ?? 'none'}\n`) +
    '\n' +
    'If the goal is specific enough, respond {"specific": true, "questions": []}. ' +
    'If not, respond {"specific": false, "questions": [...]} with 2-3 short, friendly questions — ' +
    `each one sentence, easy to answer — that would make the plan concrete. Write the questions in ${language}. ` +
    'Respond with ONLY the JSON object, no markdown fences, no commentary.';

  const result = await callViaRouter('planner', user, {
    service: 'goal-planner-clarify',
    systemPrompt: system,
    maxTokens: 6000,
  });
  if (!result.ok) {
    console.warn(`${LOG} clarify check failed (${result.error ?? 'unknown'}) — treating goal as specific`);
    return { hasGoal: true, specific: true, questions: [] };
  }
  const parsed = result.text ? parseQuestions(parseLooseJson(result.text)) : null;
  if (parsed === null) {
    console.warn(`${LOG} clarify check unparseable — treating goal as specific`);
    return { hasGoal: true, specific: true, questions: [] };
  }
  const specific = parsed.length === 0;
  console.log(`${LOG} clarify user=${userId} specific=${specific} questions=${parsed.length}`);
  return { hasGoal: true, specific, questions: parsed };
}

// Extract the first balanced JSON object, anchored on the plan_summary key when
// present. Robust to a thinking model wrapping the JSON in prose (or stray
// braces in that prose), which the naive first-{/last-} slice mishandled.
function extractJsonObject(text: string): string | null {
  const keyAt = text.indexOf('"plan_summary"');
  let start = keyAt >= 0 ? text.lastIndexOf('{', keyAt) : text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced → truncated output
}

function parseLooseJson(text: string): unknown {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const obj = extractJsonObject(t);
  if (!obj) return null;
  const cleaned = obj.replace(/,\s*([}\]])/g, '$1'); // tolerate trailing commas
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function validatePlan(raw: unknown): LLMPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as any;
  if (typeof r.plan_summary !== 'string' || !r.plan_summary.trim()) return null;
  return {
    plan_summary: r.plan_summary,
    milestones: Array.isArray(r.milestones) ? r.milestones : [],
    weekly_checkpoints: Array.isArray(r.weekly_checkpoints) ? r.weekly_checkpoints : [],
    daily_habits: Array.isArray(r.daily_habits) ? r.daily_habits : [],
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
  answers?: ClarificationAnswer[],
): Promise<{ plan_id: string; step_count: number } | null> {
  const goal = await fetchActiveGoal(client, userId);
  if (!goal) {
    console.warn(`${LOG} no active goal with a deadline for user ${userId}`);
    return null;
  }

  const locale = await getUserLocale(client, userId).catch(() => 'en');
  const language = LANGUAGE_NAMES[locale] ?? 'English';

  console.log(
    `${LOG} generate requested user=${userId} goal="${goal.primary_goal}" deadline=${goal.target_date} answers=${answers?.length ?? 0} locale=${locale}`,
  );

  const startIso = goal.set_at;
  const startDate = startIso.slice(0, 10);
  const totalDays = Math.max(1, calendarDaysBetween(startIso, goal.target_date));

  const { system, user } = buildPrompt(goal, startDate, totalDays, answers, language);
  // Ask for plain JSON instead of forcing a tool call: Vertex/Gemini returns an
  // empty response under forced function-calling here, so we parse JSON from text.
  // High token budget — the planner model is a "thinking" model whose reasoning
  // tokens count against the output budget, so a low cap can be fully consumed
  // by reasoning and leave nothing for the JSON (empty text, finishReason
  // MAX_TOKENS). Some goal phrasings reason longer than others, so give ample
  // headroom for thinking + the full JSON object.
  const result = await callViaRouter('planner', user, {
    service: 'goal-planner',
    systemPrompt: system,
    maxTokens: 16000,
  });
  console.log(
    `${LOG} llm result ok=${result.ok} provider=${result.provider} model=${result.model} ` +
      `toolCall=${!!result.toolCall} textLen=${(result.text ?? '').length} err=${result.error ?? ''}`,
  );
  if (!result.ok) {
    console.error(`${LOG} LLM call failed: ${result.error ?? 'unknown'}`);
    return null;
  }
  // Prefer the structured tool call; fall back to JSON embedded in free text
  // (some providers/models return the plan as text instead of a tool call).
  let raw: unknown = result.toolCall?.arguments ?? null;
  if (!raw && result.text) {
    raw = parseLooseJson(result.text);
    if (raw) console.log(`${LOG} parsed plan from text (no tool call)`);
  }
  const plan = raw ? validatePlan(raw) : null;
  if (!plan) {
    console.error(
      `${LOG} no usable plan parsed=${raw !== null} ` +
        `text=${(result.text ?? '').replace(/\s+/g, ' ').slice(0, 800)}`,
    );
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
      // Language the stored title/description/plan_summary are authored in, so
      // view-time localization (goal-plan-i18n) can skip translating when the
      // requested locale already matches the source. (VTID-03152b)
      source_lang: locale,
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

  // Seed the source-locale cache so a same-language view is an instant cache hit
  // and freshly authored copy is never re-translated. (VTID-03152b)
  await seedGoalPlanSourceCache(
    client,
    planId,
    locale,
    goal.primary_goal,
    plan.plan_summary,
    ((stepRows as any[]) ?? []).map((s) => ({ id: s.id, title: s.title, description: s.description ?? null })),
  );

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
  source_lang: string | null; // language the stored text is authored in (VTID-03152b)
  milestones: GoalPlanStep[];
  checkpoints: GoalPlanStep[];
  habits: GoalPlanStep[];
}

/** Read the active plan + steps and compute live day/days-left. Null when none. */
export async function getGoalPlan(client: SupabaseClient, userId: string): Promise<GoalPlanView | null> {
  const { data: planRows, error: planErr } = await client
    .from('goal_plans')
    .select('id, goal_text, plan_summary, start_date, target_date, total_days, status, source_lang')
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
    source_lang: plan.source_lang ?? null,
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
