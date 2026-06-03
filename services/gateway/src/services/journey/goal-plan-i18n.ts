/**
 * VTID-03152b — Goal plan view-time localization (translate-on-view + cache).
 *
 * A goal plan is generated once in the user's active language; its step text is
 * stored as a single fixed string. To make the plan follow the app language
 * toggle (the rest of the UI re-renders from the i18n catalog, but plan body
 * text is LLM-authored free text and can't live in the static catalog), we
 * translate the stored text into the requested locale on first view and cache
 * the result in goal_plan_i18n / goal_plan_step_i18n. Subsequent toggles read
 * straight from cache, so switching DE↔EN is instant.
 *
 * The plan itself — steps, ordering, dates, progress — is never touched. Only
 * the displayed wording (plan_summary, step title/description) is localized.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { callViaRouter } from '../llm-router';
import { normalizeLocale, type GatewayLocale } from '../../i18n/catalog';
import type { GoalPlanView, GoalPlanStep } from './goal-planner-service';

const LOG = '[VTID-03152b goal-plan-i18n]';

const LANGUAGE_NAMES: Record<GatewayLocale, string> = {
  de: 'German',
  en: 'English',
  es: 'Spanish',
  sr: 'Serbian',
};

// du-form for German, informal address generally — keep the brand voice the
// rest of the catalog uses (DE never Sie/Ihr/Ihnen).
const REGISTER_HINT: Partial<Record<GatewayLocale, string>> = {
  de: ' Use the informal du-form (never Sie/Ihr/Ihnen).',
  sr: ' Use the informal ti-form.',
  es: ' Use the informal tú-form.',
};

interface TranslatableStep {
  id: string;
  title: string;
  description: string | null;
}

/** All steps across the three kinds, flattened, preserving their ids. */
function flattenSteps(plan: GoalPlanView): GoalPlanStep[] {
  return [...plan.milestones, ...plan.checkpoints, ...plan.habits];
}

// Robust JSON extraction — the worker model occasionally wraps the object in a
// markdown fence or a line of prose. Pull the first balanced {...} object.
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
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
  return null;
}

function parseLooseJson(text: string): any | null {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const obj = extractJsonObject(t);
  if (!obj) return null;
  try {
    return JSON.parse(obj.replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/**
 * Translate a plan_summary + a batch of steps into `language` in a single LLM
 * call. Returns null on any failure (caller keeps the source text — a hiccup
 * must never blank out the plan). Step ids are echoed back so we can map the
 * translations onto the right rows.
 */
async function translateBatch(
  language: string,
  registerHint: string,
  planSummary: string | null,
  steps: TranslatableStep[],
): Promise<{ plan_summary: string | null; steps: Record<string, { title: string; description: string | null }> } | null> {
  const payload = {
    plan_summary: planSummary ?? '',
    steps: steps.map((s) => ({ id: s.id, title: s.title, description: s.description ?? '' })),
  };
  const system =
    `You are a professional translator for a longevity & wellness coaching app. ` +
    `Translate every user-visible string into ${language}, preserving tone: warm, ` +
    `short, motivating.${registerHint} Keep any numbers, units and proper nouns intact. ` +
    `If a string is already in ${language}, return it unchanged. Do NOT translate, add, ` +
    `remove or reorder the "id" values — echo them back exactly.`;
  const user =
    `Translate the "plan_summary" and each step's "title" and "description" into ${language}. ` +
    `Respond with ONLY a JSON object — no markdown fences, no commentary — of exactly this shape:\n` +
    `{"plan_summary": string, "steps": [{"id": string, "title": string, "description": string}]}\n` +
    `Keep the JSON field names (plan_summary, steps, id, title, description) in English.\n\n` +
    `Source JSON:\n${JSON.stringify(payload)}`;

  const result = await callViaRouter('worker', user, {
    service: 'goal-plan-i18n',
    systemPrompt: system,
    maxTokens: 12000,
  });
  if (!result.ok || !result.text) {
    console.warn(`${LOG} translate call failed: ${result.error ?? 'no text'}`);
    return null;
  }
  const parsed = parseLooseJson(result.text);
  if (!parsed || !Array.isArray(parsed.steps)) {
    console.warn(`${LOG} translate output unparseable (textLen=${result.text.length})`);
    return null;
  }
  const byId: Record<string, { title: string; description: string | null }> = {};
  for (const s of parsed.steps) {
    if (s && typeof s.id === 'string' && typeof s.title === 'string') {
      byId[s.id] = {
        title: s.title,
        description: typeof s.description === 'string' && s.description.trim() ? s.description : null,
      };
    }
  }
  const summary = typeof parsed.plan_summary === 'string' && parsed.plan_summary.trim() ? parsed.plan_summary : null;
  return { plan_summary: summary, steps: byId };
}

/**
 * Localize a plan into `targetLocaleRaw`, using the cache and filling misses via
 * one LLM call. Falls back to the source text on any failure. Pure-ish: returns
 * a new GoalPlanView with localized strings; ids/dates/status/progress unchanged.
 *
 * `sourceLang` is goal_plans.source_lang — when it already equals the requested
 * locale we short-circuit (no DB read, no LLM). NULL source (pre-existing plans,
 * language unknown) always goes through the translate-and-cache path.
 */
export async function localizeGoalPlan(
  client: SupabaseClient,
  plan: GoalPlanView,
  sourceLang: string | null,
  targetLocaleRaw: string,
): Promise<GoalPlanView> {
  const target = normalizeLocale(targetLocaleRaw);
  const source = sourceLang ? normalizeLocale(sourceLang) : null;

  // Fast path: stored text is already in the requested language.
  if (source && source === target) return plan;

  const language = LANGUAGE_NAMES[target] ?? 'English';
  const steps = flattenSteps(plan);
  const stepIds = steps.map((s) => s.id);

  // 1. Read whatever is already cached for this locale.
  const cachedSteps = new Map<string, { title: string; description: string | null }>();
  let cachedSummary: string | null | undefined;
  try {
    const [{ data: stepRows }, { data: planRows }] = await Promise.all([
      stepIds.length
        ? client.from('goal_plan_step_i18n').select('step_id, title, description').eq('locale', target).in('step_id', stepIds)
        : Promise.resolve({ data: [] as any[] }),
      client.from('goal_plan_i18n').select('plan_summary').eq('locale', target).eq('plan_id', plan.id).maybeSingle(),
    ]);
    for (const r of (stepRows as any[]) ?? []) {
      cachedSteps.set(r.step_id, { title: r.title, description: r.description ?? null });
    }
    if (planRows) cachedSummary = (planRows as any).plan_summary ?? null;
  } catch (e: any) {
    console.warn(`${LOG} cache read failed (continuing): ${e?.message}`);
  }

  // 2. Determine what's missing and translate it in one shot.
  const missingSteps = steps.filter((s) => !cachedSteps.has(s.id));
  const summaryMissing = cachedSummary === undefined && plan.plan_summary != null;
  if (missingSteps.length > 0 || summaryMissing) {
    const translated = await translateBatch(
      language,
      REGISTER_HINT[target] ?? '',
      summaryMissing ? plan.plan_summary : null,
      missingSteps.map((s) => ({ id: s.id, title: s.title, description: s.description })),
    );
    if (translated) {
      // Persist new translations to the cache (best-effort; never blocks the response).
      try {
        if (summaryMissing) {
          cachedSummary = translated.plan_summary ?? plan.plan_summary;
          await client
            .from('goal_plan_i18n')
            .upsert({ plan_id: plan.id, locale: target, plan_summary: cachedSummary }, { onConflict: 'plan_id,locale' });
        }
        const rows = missingSteps.map((s) => {
          const tr = translated.steps[s.id];
          const title = tr?.title ?? s.title;
          const description = tr ? tr.description : s.description;
          cachedSteps.set(s.id, { title, description });
          return { step_id: s.id, locale: target, title, description };
        });
        if (rows.length > 0) {
          await client.from('goal_plan_step_i18n').upsert(rows, { onConflict: 'step_id,locale' });
        }
      } catch (e: any) {
        console.warn(`${LOG} cache write failed (non-fatal): ${e?.message}`);
        // Still apply in-memory translations below even if caching failed.
        if (summaryMissing && cachedSummary === undefined) cachedSummary = translated.plan_summary ?? plan.plan_summary;
        for (const s of missingSteps) {
          if (!cachedSteps.has(s.id)) {
            const tr = translated.steps[s.id];
            cachedSteps.set(s.id, { title: tr?.title ?? s.title, description: tr ? tr.description : s.description });
          }
        }
      }
    }
  }

  // 3. Apply translations onto a fresh view (fall back to source per-field).
  const applyKind = (arr: GoalPlanStep[]): GoalPlanStep[] =>
    arr.map((s) => {
      const tr = cachedSteps.get(s.id);
      return tr ? { ...s, title: tr.title, description: tr.description } : s;
    });

  return {
    ...plan,
    plan_summary: cachedSummary ?? plan.plan_summary,
    milestones: applyKind(plan.milestones),
    checkpoints: applyKind(plan.checkpoints),
    habits: applyKind(plan.habits),
  };
}
