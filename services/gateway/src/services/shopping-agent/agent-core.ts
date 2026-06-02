/**
 * VTID-03260 — Propose-then-approve shopping agent (Phase 1) core logic.
 *
 * The brain of `POST /api/v1/shopping-agent/propose`. Pure-ish, unit-testable:
 * the route handler resolves identity + auth and hands a UserHealthContext +
 * the inserted-item writer down here; everything else (LLM planning turn,
 * candidate search through the limitations-filtered path, annotation) lives in
 * this module with NO Express / no HTTP coupling.
 *
 * Hard invariant (by construction):
 *   The agent NEVER selects a candidate except through `searchCandidates()`,
 *   which runs the same hard-filter substrate `applyUserLimitations()` that
 *   discover-search uses (allergens, contraindicated conditions, medication
 *   interactions, excluded regions, geo). A hard-blocked product is removed
 *   before the agent can ever see it, so it can NEVER end up in a proposal.
 *   `safety_flags` only ever carry SOFT overlaps (ingredient sensitivities,
 *   pregnancy-relevant notes, over-per-product-budget) and product safety_notes.
 *
 * Money invariant:
 *   This module reads products and WRITES universal_cart_items (proposals). It
 *   has NO checkout / Stripe / wallet / order path. Budget cap is ADVISORY only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserHealthContext } from '../user-health-context';
import { inferPrimaryCondition } from '../user-health-context';
import { applyUserLimitations, type FilterableProduct } from '../limitations-filter';
import { callViaRouter, type LLMRouterTool } from '../llm-router';
import { getConditionMapping } from '../condition-matcher';

export const VTID = 'VTID-03260';

// =============================================================================
// Types
// =============================================================================

/** Structured search intent the planning LLM emits — a subset of discover-search filters. */
export interface AgentSearchIntent {
  q?: string;
  category?: string;
  health_goals?: string[];
  dietary_tags?: string[];
  ingredients_any?: string[];
  brand?: string[];
  price_max_cents?: number;
  /** The user goal this intent serves — used to build per-pick rationale. */
  serves_goal?: string;
}

/** Candidate product row (post-filter) carried through annotation. */
export interface AgentCandidate extends FilterableProduct {
  id: string;
  title: string;
  category: string | null;
  price_cents: number | null;
  currency: string | null;
  rating: number | null;
  review_count: number | null;
  origin_country: string | null;
  ingredients_primary: string[];
  health_goals: string[];
  dietary_tags: string[];
  safety_notes: string | null;
  availability: string;
  /** Match reasons attached during search (condition/rating/origin/goal). */
  match_reasons: Array<{ kind: string; text: string }>;
  /** The intent's serves_goal that produced this candidate (for rationale). */
  _serves_goal?: string;
}

/** One annotated proposal, pre-insert. */
export interface AnnotatedPick {
  product_id: string;
  title: string;
  rationale: string;
  safety_flags: string[];
  confidence: number;
  /** item_type derived from product category, for the cart insert. */
  item_type: 'supplement' | 'partner_product';
  unit_price_cents_snapshot: number | null;
  currency_snapshot: string | null;
}

export interface ProposeResult {
  ok: boolean;
  error?: string;
  run_id?: string;
  proposed?: Array<{
    item_id: string;
    product_id: string;
    title: string;
    rationale: string;
    safety_flags: string[];
    confidence: number;
  }>;
  advisory?: string[];
}

/** Writer the route provides: insert one annotated pick into the caller's active cart. */
export type InsertPickFn = (pick: AnnotatedPick, runId: string, proposedAt: string) => Promise<
  { ok: true; item_id: string } | { ok: false; error: string }
>;

export interface RunProposeArgs {
  prompt: string;
  maxItems: number;
  ctx: UserHealthContext;
  /** Service-role (or user-scoped) client for the read-only product search. */
  supabase: SupabaseClient | null;
  /** Persists one pick into the active universal cart. */
  insertPick: InsertPickFn;
  /** Stable run id (uuid) tying every proposed item together. */
  runId: string;
  /**
   * Phase 2 — standing month-to-date CONVERTED spend (in ctx.currency), used to
   * compute the near/over monthly-cap advisories against (spend + proposed
   * subtotal). ADVISORY ONLY; defaults to 0 for back-compatibility.
   */
  monthly_spend_cents?: number;
}

// =============================================================================
// 1. Planning turn (LLM) — emit structured search intents
// =============================================================================

const PLAN_TOOL: LLMRouterTool = {
  name: 'emit_search_intents',
  description:
    'Emit 1-3 product search intents that together satisfy the shopper request, ' +
    'each compatible with the Vitana marketplace search filters.',
  inputSchema: {
    type: 'object',
    properties: {
      intents: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Free-text search query' },
            category: { type: 'string' },
            health_goals: { type: 'array', items: { type: 'string' } },
            dietary_tags: { type: 'array', items: { type: 'string' } },
            ingredients_any: { type: 'array', items: { type: 'string' } },
            brand: { type: 'array', items: { type: 'string' } },
            price_max_cents: { type: 'integer' },
            serves_goal: { type: 'string', description: 'The user goal this intent serves' },
          },
        },
      },
    },
    required: ['intents'],
  },
};

/** Build the system prompt that seeds the planner from the health context. */
export function buildPlannerSystemPrompt(ctx: UserHealthContext): string {
  const lines: string[] = [];
  lines.push(
    'You are the Vitana shopping agent. You PROPOSE products for the shopper to review later; ' +
      'you never purchase anything. Translate the request into 1-3 marketplace search intents.'
  );

  // HARD constraints — present prominently. These are also enforced by a
  // downstream filter, but telling the model keeps proposals on-target.
  const hard: string[] = [];
  if (ctx.allergies.length) hard.push(`allergies: ${ctx.allergies.join(', ')}`);
  if (ctx.contraindications.length) hard.push(`medical contraindications: ${ctx.contraindications.join(', ')}`);
  if (ctx.current_medications.length) hard.push(`current medications (avoid interactions): ${ctx.current_medications.join(', ')}`);
  if (ctx.pregnancy_status) hard.push(`pregnancy status: ${ctx.pregnancy_status}`);
  if (hard.length) {
    lines.push(`HARD SAFETY CONSTRAINTS — never propose anything conflicting with: ${hard.join('; ')}.`);
  }

  // Soft preferences / signals.
  if (ctx.active_goals.length) lines.push(`User goals: ${ctx.active_goals.map((g) => g.key).join(', ')}.`);
  if (ctx.active_conditions.length) lines.push(`Active conditions: ${ctx.active_conditions.map((c) => c.key).join(', ')}.`);
  if (ctx.dietary_restrictions.length) lines.push(`Dietary preferences: ${ctx.dietary_restrictions.join(', ')}.`);
  if (ctx.ingredient_sensitivities.length) lines.push(`Ingredient sensitivities (avoid where possible): ${ctx.ingredient_sensitivities.join(', ')}.`);
  if (ctx.budget_max_per_product_cents) {
    lines.push(`Budget band: keep per-product price at or below ${Math.floor(ctx.budget_max_per_product_cents / 100)} ${ctx.currency ?? ''}.`.trim());
  }
  if (ctx.country_code) lines.push(`Ships to: ${ctx.country_code}.`);

  lines.push('Call emit_search_intents with the structured intents. Do not write prose.');
  return lines.join('\n');
}

/**
 * Run the single planning turn. Returns the structured intents, or an error
 * marker the route maps to HTTP 502 `llm_unavailable`. ONE turn for MVP —
 * no agentic loop.
 */
export async function planSearchIntents(
  prompt: string,
  ctx: UserHealthContext
): Promise<{ ok: true; intents: AgentSearchIntent[] } | { ok: false; error: 'llm_unavailable' }> {
  const systemPrompt = buildPlannerSystemPrompt(ctx);
  const result = await callViaRouter('planner', prompt, {
    service: 'shopping-agent',
    vtid: VTID,
    systemPrompt,
    maxTokens: 1500,
    tools: [PLAN_TOOL],
    forceTool: 0,
  });

  if (!result.ok) {
    // No provider configured / both providers failed → fail loud. NEVER fabricate picks.
    return { ok: false, error: 'llm_unavailable' };
  }

  const intents = parseIntents(result.toolCall?.arguments, result.text);
  // A reachable provider that returned no usable structure is still "available";
  // an empty intent list flows downstream to a graceful proposed:[] outcome.
  return { ok: true, intents };
}

/** Extract intents from a forced tool call, falling back to JSON-in-text. */
export function parseIntents(
  toolArgs: Record<string, unknown> | undefined,
  text: string | undefined
): AgentSearchIntent[] {
  const fromArgs = coerceIntentArray(toolArgs?.intents);
  if (fromArgs.length) return fromArgs;

  if (text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as Record<string, unknown>;
        return coerceIntentArray(parsed.intents);
      } catch {
        // not JSON — fall through
      }
    }
  }
  return [];
}

function coerceIntentArray(raw: unknown): AgentSearchIntent[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentSearchIntent[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const intent: AgentSearchIntent = {};
    if (typeof o.q === 'string') intent.q = o.q.slice(0, 512);
    if (typeof o.category === 'string') intent.category = o.category.slice(0, 64);
    if (Array.isArray(o.health_goals)) intent.health_goals = stringArray(o.health_goals);
    if (Array.isArray(o.dietary_tags)) intent.dietary_tags = stringArray(o.dietary_tags);
    if (Array.isArray(o.ingredients_any)) intent.ingredients_any = stringArray(o.ingredients_any);
    if (Array.isArray(o.brand)) intent.brand = stringArray(o.brand);
    if (typeof o.price_max_cents === 'number' && Number.isFinite(o.price_max_cents)) {
      intent.price_max_cents = Math.max(0, Math.floor(o.price_max_cents));
    }
    if (typeof o.serves_goal === 'string') intent.serves_goal = o.serves_goal.slice(0, 200);
    out.push(intent);
  }
  return out;
}

function stringArray(raw: unknown[]): string[] {
  return raw.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 64));
}

// =============================================================================
// 2. Candidate search — the ONLY product-selection path (limitations pre-applied)
// =============================================================================

const CANDIDATE_COLUMNS =
  'id, title, brand, category, price_cents, currency, availability, rating, review_count, ' +
  'origin_country, origin_region, ingredients_primary, health_goals, dietary_tags, safety_notes, ' +
  'contains_allergens, contraindicated_with_conditions, contraindicated_with_medications, ' +
  'ships_to_countries, ships_to_regions, excluded_from_regions';

/**
 * Run one intent through the marketplace, then HARD-FILTER with
 * applyUserLimitations(). Mirrors the in-process discover-search invocation in
 * gemini-operator.ts (executeSearchMarketplaceProducts). Always forces
 * availability='in_stock' so price-locked proposals are purchasable later.
 *
 * The returned candidates have already had allergen / contraindication /
 * medication / region / geo conflicts removed — the agent cannot see them.
 */
export async function searchCandidates(
  supabase: SupabaseClient,
  intent: AgentSearchIntent,
  ctx: UserHealthContext,
  overFetch: number
): Promise<AgentCandidate[]> {
  // Condition-driven expansion (mirrors discover-search): only when the intent
  // didn't already specify ingredients/goals.
  const conditionKey = inferPrimaryCondition(ctx);
  const mapping = conditionKey ? await getConditionMapping(conditionKey) : null;

  let healthGoals = intent.health_goals;
  let ingredientsAny = intent.ingredients_any;
  if (mapping) {
    if (!ingredientsAny?.length && mapping.recommended_ingredients.length) ingredientsAny = mapping.recommended_ingredients;
    if (!healthGoals?.length && mapping.recommended_health_goals.length) healthGoals = mapping.recommended_health_goals;
  }

  let query = supabase
    .from('products')
    .select(CANDIDATE_COLUMNS)
    .eq('is_active', true)
    .eq('availability', 'in_stock');

  if (intent.q) {
    const sanitizedQ = intent.q.replace(/[&|!<>()]/g, ' ').trim();
    if (sanitizedQ) query = query.textSearch('search_text', sanitizedQ, { config: 'simple', type: 'websearch' });
  }
  if (intent.category) query = query.eq('category', intent.category);
  if (healthGoals?.length) query = query.overlaps('health_goals', healthGoals);
  if (ingredientsAny?.length) query = query.overlaps('ingredients_primary', ingredientsAny);
  if (intent.dietary_tags?.length) query = query.contains('dietary_tags', intent.dietary_tags);
  if (intent.brand?.length) query = query.in('brand', intent.brand);
  if (intent.price_max_cents !== undefined) query = query.lte('price_cents', intent.price_max_cents);

  query = query.order('rating', { ascending: false, nullsFirst: false }).limit(overFetch);

  const { data: rows, error } = await query;
  if (error) {
    console.error(`[${VTID}] candidate search failed:`, error.message);
    return [];
  }

  const fetched = (rows ?? []) as unknown as AgentCandidate[];

  // HARD + soft limitation filter — the safety substrate. No bypasses here:
  // the agent must never propose anything the user could not be shown.
  const { allowed } = applyUserLimitations(fetched, ctx, { surface: 'shopping_agent' });

  // Exclude past purchases (ctx already carries them).
  const pastIds = new Set(ctx.past_purchases.map((p) => p.product_id));
  const withoutPast = allowed.filter((p) => !pastIds.has(p.id));

  // Build match_reasons (condition/rating/origin) + carry the goal this intent serves.
  for (const p of withoutPast) {
    const reasons: Array<{ kind: string; text: string }> = [];
    if (mapping?.recommended_ingredients_ranked.length && p.ingredients_primary?.length) {
      const pIngs = new Set(p.ingredients_primary.map((x) => x.toLowerCase()));
      for (const rec of mapping.recommended_ingredients_ranked) {
        if (pIngs.has(rec.ingredient.toLowerCase())) {
          reasons.push({ kind: 'condition', text: `Contains ${rec.ingredient} (${rec.evidence} evidence for ${mapping.display_label})` });
          break;
        }
      }
    }
    if (p.rating !== null && p.rating >= 4.5) {
      reasons.push({ kind: 'rating', text: `Rated ${p.rating.toFixed(1)}/5${p.review_count ? ` by ${p.review_count} users` : ''}` });
    }
    if (p.origin_country) reasons.push({ kind: 'origin', text: `Ships from ${p.origin_country}` });
    p.match_reasons = reasons;
    p._serves_goal = intent.serves_goal;
  }

  return withoutPast;
}

// =============================================================================
// 3. Annotation — rationale + SOFT safety flags + confidence
// =============================================================================

/** Map a product category to the cart item_type enum (supplement | partner_product). */
export function deriveItemType(category: string | null): 'supplement' | 'partner_product' {
  const c = (category ?? '').toLowerCase();
  // Supplements (vitamins, minerals, herbals) are first-party 'supplement';
  // everything else (devices, foods, partner SKUs) is 'partner_product'.
  return c === 'supplement' || c === 'supplements' || c === 'vitamin' || c === 'vitamins'
    ? 'supplement'
    : 'partner_product';
}

/**
 * Build the per-pick rationale + SOFT safety flags + confidence. Hard conflicts
 * are ALREADY filtered out upstream — never re-added here.
 */
export function annotatePick(p: AgentCandidate, ctx: UserHealthContext): AnnotatedPick {
  // Rationale: prefer the strongest match reason, append the goal it serves.
  const reasonText = p.match_reasons.map((r) => r.text);
  const goal = p._serves_goal || (ctx.active_goals[0]?.key ?? null);
  const rationaleParts: string[] = [];
  if (reasonText.length) rationaleParts.push(reasonText[0]);
  if (goal) rationaleParts.push(`supports your goal: ${goal}`);
  if (!rationaleParts.length) rationaleParts.push(`Matches your request`);
  const rationale = rationaleParts.join(' — ');

  // SOFT safety flags only (hard conflicts are impossible here by construction).
  const flags: string[] = [];

  // Product-declared safety notes.
  if (p.safety_notes && p.safety_notes.trim()) flags.push('has_safety_notes');

  // Ingredient sensitivities (soft overlap — surfaced, not blocked).
  if (ctx.ingredient_sensitivities.length && p.ingredients_primary?.length) {
    const sens = new Set(ctx.ingredient_sensitivities.map((s) => s.toLowerCase()));
    if (p.ingredients_primary.some((i) => sens.has(i.toLowerCase()))) {
      flags.push('ingredient_sensitivity_overlap');
    }
  }

  // Pregnancy-relevant: if the user is pregnant and the product carries safety
  // notes, surface a review-with-clinician flag (advisory, not a block).
  if (ctx.pregnancy_status && p.safety_notes && p.safety_notes.trim()) {
    flags.push('pregnancy_review_recommended');
  }

  // Price above the per-product budget ceiling (soft — surfaced for review).
  if (
    ctx.budget_max_per_product_cents !== null &&
    p.price_cents !== null &&
    p.price_cents !== undefined &&
    p.price_cents > ctx.budget_max_per_product_cents
  ) {
    flags.push('over_per_product_budget');
  }

  // Confidence: base on rating + reason richness, lightly penalized by flags.
  let confidence = 0.55;
  if (p.match_reasons.some((r) => r.kind === 'condition')) confidence += 0.2;
  if (p.rating !== null && p.rating >= 4.5) confidence += 0.1;
  if (p.review_count && p.review_count >= 50) confidence += 0.05;
  confidence -= flags.length * 0.05;
  confidence = Math.max(0.2, Math.min(0.95, confidence));

  return {
    product_id: p.id,
    title: p.title,
    rationale,
    safety_flags: flags,
    confidence: Math.round(confidence * 100) / 100,
    item_type: deriveItemType(p.category),
    unit_price_cents_snapshot: p.price_cents ?? null,
    currency_snapshot: p.currency ?? null,
  };
}

// =============================================================================
// 4. Orchestration — plan → select → annotate → write (NEVER checkout)
// =============================================================================

/** Advisory: proposed subtotal within 15% of the monthly cap → near_monthly_cap. */
const NEAR_CAP_RATIO = 0.85;

export async function runPropose(args: RunProposeArgs): Promise<ProposeResult> {
  const { prompt, maxItems, ctx, supabase, insertPick, runId } = args;
  const monthlySpendCents = args.monthly_spend_cents ?? 0;
  const advisory: string[] = [];

  // Brain empty / stale → advisory (still degrade gracefully).
  const brainEmpty =
    ctx.stale ||
    (ctx.active_goals.length === 0 &&
      ctx.active_conditions.length === 0 &&
      ctx.allergies.length === 0 &&
      ctx.dietary_restrictions.length === 0 &&
      ctx.current_medications.length === 0);
  if (brainEmpty) advisory.push('no_health_profile');

  // 1. Planning turn. No provider → fail loud (502 upstream).
  const plan = await planSearchIntents(prompt, ctx);
  if (!plan.ok) {
    return { ok: false, error: 'llm_unavailable' };
  }

  // 2. Run intents through the limitations-filtered search path.
  if (!supabase) {
    // No DB → no candidates can be safely sourced. Degrade to empty proposals.
    advisory.push('catalog_unavailable');
    return { ok: true, run_id: runId, proposed: [], advisory };
  }

  const overFetch = Math.min(Math.max(maxItems * 3, 6), 60);
  const seen = new Set<string>();
  const candidates: AgentCandidate[] = [];
  for (const intent of plan.intents) {
    const found = await searchCandidates(supabase, intent, ctx, overFetch);
    for (const c of found) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      candidates.push(c);
    }
    if (candidates.length >= maxItems * 3) break;
  }

  if (candidates.length === 0) {
    advisory.push(plan.intents.length === 0 ? 'no_search_intent' : 'no_candidates_passed_filters');
    return { ok: true, run_id: runId, proposed: [], advisory };
  }

  // 3. Top-N picks, annotate.
  const top = candidates.slice(0, maxItems);
  const annotated = top.map((p) => annotatePick(p, ctx));

  // Advisory: monthly-cap proximity (ADVISORY ONLY — never enforced in the money
  // path). Phase 2: compare standing month-to-date spend PLUS this run's proposed
  // subtotal against the cap, so the advisory reflects total projected spend.
  if (ctx.budget_monthly_cap_cents && ctx.budget_monthly_cap_cents > 0) {
    const subtotal = annotated.reduce((sum, a) => sum + (a.unit_price_cents_snapshot ?? 0), 0);
    const projected = monthlySpendCents + subtotal;
    if (projected > ctx.budget_monthly_cap_cents) {
      advisory.push('over_monthly_cap');
    } else if (projected >= ctx.budget_monthly_cap_cents * NEAR_CAP_RATIO) {
      advisory.push('near_monthly_cap');
    }
  }

  // 4. Insert each pick into the active cart (the route owns the insert path).
  const proposedAt = new Date().toISOString();
  const proposed: NonNullable<ProposeResult['proposed']> = [];
  for (const pick of annotated) {
    const res = await insertPick(pick, runId, proposedAt);
    if (!res.ok) {
      console.error(`[${VTID}] insert pick failed for product ${pick.product_id}: ${res.error}`);
      continue; // best-effort: a single failed insert must not sink the whole run
    }
    proposed.push({
      item_id: res.item_id,
      product_id: pick.product_id,
      title: pick.title,
      rationale: pick.rationale,
      safety_flags: pick.safety_flags,
      confidence: pick.confidence,
    });
  }

  return { ok: true, run_id: runId, proposed, advisory };
}
