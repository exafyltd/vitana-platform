/**
 * VTID-03255 — next-step + gate logic.
 *
 * Turns the verified per-step statuses into:
 *   - the ordered step views the screen renders ("Mein Weg"),
 *   - the single current next move Vitana drives toward ("Nächster Schritt"),
 *   - the graduation verdict.
 *
 * The gate is hard: until life_compass is done (health goal AND economic
 * intent), the next step is ALWAYS the gate — there is no space to diverge.
 * Required steps are driven before the economy ACTIVATION steps, but the
 * activation steps are still offered (inspire-always) once required work is
 * done — they simply never block graduation.
 */

import type {
  FoundationStepStatus,
  FoundationStepView,
} from './types';
import { FOUNDATION_STEPS, type FoundationStepDef } from './foundation-steps';

const GATE_KEY = 'life_compass';

/** Merge each registry def with its verified status, preserving registry order. */
export function buildStepViews(
  statuses: Map<string, FoundationStepStatus>,
): FoundationStepView[] {
  return FOUNDATION_STEPS.map((def: FoundationStepDef) => ({
    key: def.key,
    title: def.title,
    strand: def.strand,
    type: def.type,
    tier: def.tier,
    status: statuses.get(def.key) ?? 'open',
    required_for_graduation: def.required_for_graduation,
    navigation_route: def.navigation_route,
    benefit: def.benefit,
  }));
}

function isSatisfied(status: FoundationStepStatus): boolean {
  return status === 'done' || status === 'active';
}

/**
 * The single next move. Gate first; then the first unfinished required step;
 * then — only once all required work is done — the first unfinished economy
 * activation step (still inspired, never blocking).
 */
export function computeNextStep(
  views: FoundationStepView[],
): FoundationStepView | null {
  const gate = views.find((v) => v.key === GATE_KEY);
  if (gate && !isSatisfied(gate.status)) return gate;

  const requiredOpen = views.find(
    (v) => v.required_for_graduation && !isSatisfied(v.status),
  );
  if (requiredOpen) return requiredOpen;

  const activationOpen = views.find((v) => !isSatisfied(v.status));
  return activationOpen ?? null;
}

/** Foundation complete = every required step satisfied. */
export function isGraduated(views: FoundationStepView[]): boolean {
  return views
    .filter((v) => v.required_for_graduation)
    .every((v) => isSatisfied(v.status));
}

/**
 * The line Vitana speaks for the next step. `teachMode` flips execute → teach
 * when the user signals they don't want to work the checklist right now.
 *
 * Gate nuance: when the health goal is set but the economic stance is still
 * missing, the gate is satisfied on beat A and we drive beat B explicitly.
 */
export function nextStepPrompt(
  step: FoundationStepView | null,
  opts: { teachMode?: boolean; goalSet?: boolean; economicIntentSet?: boolean } = {},
): string | null {
  if (!step) return null;
  const def = FOUNDATION_STEPS.find((s) => s.key === step.key);
  if (!def) return null;

  if (step.key === GATE_KEY && opts.goalSet && !opts.economicIntentSet) {
    // Beat B of the dual-axis gate — goal exists, economy stance still needed.
    return "One more thing before we begin: here you also earn. Do you want to build a business, earn passive income, just earn from recommendations — or are you only curious for now? Any answer is fine — I just need your direction.";
  }

  return opts.teachMode ? def.teach_prompt : def.execute_prompt;
}
