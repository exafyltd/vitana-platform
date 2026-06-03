/**
 * VTID-03255 — the write + delta path.
 *
 * After every user answer, the voice layer calls applyJourneyAnswer(). It:
 *   1. writes the journey-owned fact to its REAL home (life_compass for the
 *      goal; user_journey_foundation for the economy stance / focus pillar /
 *      teacher acknowledgments),
 *   2. passes the dual-axis gate when both a goal and an economic stance exist,
 *   3. re-verifies live,
 *   4. returns a JourneyFoundationDelta so the voice continues with the next
 *      proactive sentence and the screen highlights what changed.
 *
 * Steps that own their own write tools (diary, reminder, calendar, connect,
 * profile, vitana_index) are NOT written here — the model uses the existing
 * tools (save_diary_entry, add_to_calendar, …) and this path simply re-verifies
 * and advances. orb-live.ts owns none of this.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  EconomicIntent,
  FoundationStepStatus,
  JourneyFoundationDelta,
  JourneyFoundationRow,
} from './types';
import { getStepDef } from './foundation-steps';
import { verifyAllSteps } from './journey-foundation-verifier';
import {
  buildStepViews,
  computeNextStep,
  nextStepPrompt,
} from './journey-foundation-next-step';

const TEACHER_STEPS = new Set(['understand_economy', 'autopilot', 'business_live_media']);

export interface JourneyAnswerInput {
  /** Foundation step key being answered, or the synthetic 'economic_intent'. */
  step: string;
  /** Free-text answer (goal sentence, pillar name, intent phrase, …). */
  value?: string;
  /** Optional structured goal fields (life_compass). */
  category?: string | null;
  target_value?: number | null;
  target_unit?: string | null;
  target_date?: string | null; // YYYY-MM-DD
  starting_value?: number | null;
  /** Teacher-moment acknowledgment. */
  acknowledged?: boolean;
}

// ── normalizers ──────────────────────────────────────────────────────────────
function normalizePillar(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/(food|eat|nutrition|diet|essen|ernähr)/.test(s)) return 'nutrition';
  if (/(water|hydrat|drink|wasser|trink)/.test(s)) return 'hydration';
  if (/(exercise|move|movement|workout|sport|bewegung|training)/.test(s)) return 'exercise';
  if (/(sleep|schlaf|rest)/.test(s)) return 'sleep';
  if (/(stress|mental|mind|anxiety|mood|geist|psych)/.test(s)) return 'mental';
  if (/(prosper|money|finance|wealth|income|geld|wohlstand)/.test(s)) return 'prosperity';
  return s.slice(0, 40); // store whatever they said, capped
}

function normalizeEconomicIntent(raw: string | undefined | null): EconomicIntent | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/(business|company|startup|found|gründ|unternehm)/.test(s)) return 'build_business';
  if (/(passive|investment|rente|passiv)/.test(s)) return 'passive_income';
  if (/(recommend|affiliate|referr|empfehl|provision)/.test(s)) return 'earn_recommendations';
  if (/(curious|maybe|not sure|later|neugierig|vielleicht|just looking)/.test(s)) return 'curious';
  return 'curious'; // any acknowledged-but-unclear stance still satisfies the gate
}

// ── row helpers ──────────────────────────────────────────────────────────────
async function ensureRow(
  client: SupabaseClient,
  userId: string,
): Promise<JourneyFoundationRow> {
  const { data } = await client
    .from('user_journey_foundation')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (data) return data as JourneyFoundationRow;
  const { data: inserted } = await client
    .from('user_journey_foundation')
    .insert({ user_id: userId })
    .select('*')
    .maybeSingle();
  return (
    (inserted as JourneyFoundationRow) ?? {
      user_id: userId,
      journey_started_at: null,
      current_next_step: null,
      economic_intent: null,
      focus_pillar: null,
      completed_steps_cache: [],
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  );
}

async function patchRow(
  client: SupabaseClient,
  userId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await client
    .from('user_journey_foundation')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
}

async function writeGoal(
  client: SupabaseClient,
  userId: string,
  input: JourneyAnswerInput,
): Promise<void> {
  const text = (input.value ?? '').trim();
  if (!text) return;
  const payload: Record<string, unknown> = {
    primary_goal: text,
    is_active: true,
  };
  if (input.category) payload.category = input.category;
  if (input.target_value != null) payload.target_value = input.target_value;
  if (input.target_unit) payload.target_unit = input.target_unit;
  if (input.target_date) payload.target_date = input.target_date;
  if (input.starting_value != null) payload.starting_value = input.starting_value;

  // One active row per user: update the active one if present, else insert.
  const { data: existing } = await client
    .from('life_compass')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    await client.from('life_compass').update(payload).eq('id', existing.id);
  } else {
    await client.from('life_compass').insert({ user_id: userId, category: 'general', ...payload });
  }
}

// ── main entry ───────────────────────────────────────────────────────────────
export async function applyJourneyAnswer(
  client: SupabaseClient,
  userId: string,
  input: JourneyAnswerInput,
): Promise<JourneyFoundationDelta> {
  const row = await ensureRow(client, userId);
  const changed: string[] = [];

  // 1. Write the journey-owned fact to its real home.
  if (input.step === 'life_compass' || input.step === 'goal') {
    await writeGoal(client, userId, input);
    changed.push('life_compass.primary_goal');
  } else if (input.step === 'economic_intent' || input.step === 'economic_aspiration') {
    const intent = normalizeEconomicIntent(input.value);
    if (intent) {
      await patchRow(client, userId, { economic_intent: intent });
      changed.push('economic_intent');
    }
  } else if (input.step === 'weakest_habit') {
    const pillar = normalizePillar(input.value);
    if (pillar) {
      await patchRow(client, userId, { focus_pillar: pillar });
      changed.push('focus_pillar');
    }
  } else if (TEACHER_STEPS.has(input.step) && input.acknowledged !== false) {
    const ack = new Set<string>(
      Array.isArray(row.metadata?.teacher_ack) ? (row.metadata.teacher_ack as string[]) : [],
    );
    ack.add(input.step);
    await patchRow(client, userId, { metadata: { ...row.metadata, teacher_ack: [...ack] } });
    changed.push(`teacher_ack.${input.step}`);
  }
  // Other steps (diary/reminder/calendar/connect/profile/vitana_index/events/
  // marketplace) are completed by their own tools; we just re-verify below.

  // 2. Re-load and pass the dual-axis gate if both beats now exist.
  const fresh = await ensureRow(client, userId);
  const statuses = await verifyAllSteps(client, userId, fresh);
  const gateStatus = statuses.get('life_compass');
  if (gateStatus === 'done' && !fresh.journey_started_at) {
    await patchRow(client, userId, { journey_started_at: new Date().toISOString() });
    changed.push('journey_started_at');
  }

  // 3. Compute the verified status of the answered step + the next move.
  const views = buildStepViews(statuses);
  const completedStep = getStepDef(input.step) ? input.step : null;
  const verifiedStatus: FoundationStepStatus =
    (completedStep && statuses.get(completedStep)) || 'open';
  const nextStep = computeNextStep(views);

  // Persist the cursor hint so the screen can render instantly.
  await patchRow(client, userId, { current_next_step: nextStep?.key ?? null });

  return {
    changed_fields: changed,
    completed_step: completedStep,
    verified_status: verifiedStatus,
    next_step: nextStep,
    navigation_directive: nextStep?.navigation_route ?? null,
    screen_message: buildScreenMessage(input, verifiedStatus, changed),
  };
}

function buildScreenMessage(
  input: JourneyAnswerInput,
  status: FoundationStepStatus,
  changed: string[],
): string | null {
  if (changed.includes('life_compass.primary_goal') && input.value) {
    return `Goal saved: ${input.value.trim()}`;
  }
  if (changed.includes('economic_intent')) return 'Economy stance saved.';
  if (changed.includes('focus_pillar')) return 'Focus saved.';
  if (changed.some((c) => c.startsWith('teacher_ack.'))) return 'Got it — noted.';
  if (status === 'done') return 'This part is complete.';
  if (status === 'active') return 'This is now running for you.';
  return null;
}

/** Convenience for the voice tool: the delta plus the line Vitana should speak next. */
export async function applyJourneyAnswerWithVoice(
  client: SupabaseClient,
  userId: string,
  input: JourneyAnswerInput,
  opts: { teachMode?: boolean } = {},
): Promise<JourneyFoundationDelta & { next_line: string | null }> {
  const delta = await applyJourneyAnswer(client, userId, input);
  const next_line = nextStepPrompt(delta.next_step, { teachMode: opts.teachMode });
  return { ...delta, next_line };
}
