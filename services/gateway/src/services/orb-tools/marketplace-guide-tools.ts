/**
 * A17–A19 Marketplace Voice Assistant — guide orchestrators, shopping intent
 * & preferences, personalization context (expansion v3, Wave MVA-1).
 *
 * The Discover Assistant layer: understand the need → clarify → recommend a
 * path → keep concise picks with recorded rationales → confirmed selection
 * into the basket. Atomic discovery/compare/cart tools live in
 * marketplace-journey-tools.ts; shared state/pref/cart helpers in
 * marketplace-va-shared.ts (which documents the real backings).
 *
 * Real backings:
 *   - Guide state → `memory_items` (content_json.type='marketplace_guide_state').
 *   - Preferences → `memory_facts` `marketplace_pref_*` via writeFact()
 *     (memory-facts-service.ts: identity-lock + OASIS events + supersession).
 *     Reset writes EMPTY values through the same supersession path — the
 *     append-only fact history is preserved, nothing is deleted.
 *   - Picks → shopping-agent runPropose() (services/shopping-agent/agent-core.ts)
 *     with a COLLECT-ONLY insertPick (nothing is staged into the cart at
 *     recommendation time — staging happens only in the confirmed
 *     complete_marketplace_selection step), falling back to a deterministic
 *     `products` search when no LLM provider is reachable.
 *   - Dismissals → `user_offers_memory` (VTID-01092) state='dismissed'.
 *   - Cart staging → stageProductInCart() (universal cart + emitCartEvent),
 *     two-step confirm, NEVER payment (screen handoff to /cart).
 *
 * Health boundary: recommendations never diagnose, never promise outcomes,
 * and health-adjacent answers carry HEALTH_BOUNDARY_NOTE.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { writeFact } from '../memory-facts-service';
import { getUserHealthContext } from '../user-health-context';
import { getMonthlySpend } from '../budget/spend-service';
import { runPropose, type AnnotatedPick, type InsertPickFn } from '../shopping-agent/agent-core';
import {
  authGate,
  resolveTenantId,
  navDirective,
  clampInt,
  fmtPrice,
  toList,
  UUID_RE,
  DEFAULT_CURRENCY,
  type ProductRow,
  PRODUCT_COLS,
  resolveProduct,
  type ServiceRow,
  SERVICE_COLS,
  loadMarketplacePrefs,
  describePrefs,
  applyPrefExclusions,
  type MarketplacePrefs,
  type GuidePick,
  type GuideState,
  emptyGuideState,
  loadGuideState,
  saveGuideState,
  stageProductInCart,
  HEALTH_BOUNDARY_NOTE,
} from './marketplace-va-shared';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// Intent classification (deterministic keyword heuristic — no invented data;
// it only routes to categories the marketplace actually has).
// ---------------------------------------------------------------------------

const DIAGNOSTIC_TERMS = [
  'test', 'panel', 'blood', 'blut', 'lab', 'labor', 'biomarker', 'metabolom', 'microbiome', 'mikrobiom',
  'genom', 'genetic', 'dna', 'hormone', 'hormon', 'screening', 'diagnos', 'messen', 'measure',
];
const PRACTITIONER_TERMS = [
  'doctor', 'arzt', 'coach', 'therapist', 'therapeut', 'nutritionist', 'ernährungsberat', 'practitioner',
  'specialist', 'spezialist', 'consultation', 'beratung',
];
const SERVICE_TERMS = [
  'service', 'massage', 'course', 'kurs', 'class', 'session', 'training', 'program', 'programm',
  'treatment', 'behandlung', 'appointment', 'termin',
];

export function classifyIntent(need: string): { intent: string; reasons: string[] } {
  const lc = need.toLowerCase();
  const hits = (terms: string[]) => terms.filter((t) => lc.includes(t));
  const diag = hits(DIAGNOSTIC_TERMS);
  const pract = hits(PRACTITIONER_TERMS);
  const svc = hits(SERVICE_TERMS);
  const reasons: string[] = [];
  if (diag.length) reasons.push(`diagnostic terms: ${diag.slice(0, 3).join(', ')}`);
  if (pract.length) reasons.push(`practitioner terms: ${pract.slice(0, 3).join(', ')}`);
  if (svc.length) reasons.push(`service terms: ${svc.slice(0, 3).join(', ')}`);

  if (diag.length && (pract.length || svc.length)) return { intent: 'combination', reasons };
  if (diag.length) return { intent: 'diagnostic_test', reasons };
  if (pract.length) return { intent: 'practitioner', reasons };
  if (svc.length) return { intent: 'service', reasons };
  reasons.push('no service/diagnostic/practitioner terms — defaulting to product search');
  return { intent: 'product', reasons };
}

// ---------------------------------------------------------------------------
// Deterministic product search used by the guide when the shopping-agent LLM
// is unreachable (and by refine). Token search + saved-preference exclusions.
// ---------------------------------------------------------------------------

async function searchProductsForGoal(
  sb: SupabaseClient,
  goal: string,
  prefs: MarketplacePrefs,
  budgetMaxCents: number | null,
  limit: number,
): Promise<{ items: ProductRow[]; dropped: Array<{ title: string; reason: string }> }> {
  let query = sb.from('products').select(PRODUCT_COLS).eq('is_active', true);
  const sanitized = goal.replace(/[&|!<>()]/g, ' ').trim();
  if (sanitized) query = query.textSearch('search_text', sanitized, { config: 'simple', type: 'websearch' });
  if (budgetMaxCents != null) query = query.lte('price_cents', budgetMaxCents);
  query = query.order('rating', { ascending: false, nullsFirst: false }).limit(Math.max(limit * 3, 12));

  let rows: ProductRow[] = [];
  const first = await query;
  if (!first.error) rows = (first.data as unknown as ProductRow[]) ?? [];

  // Websearch too strict (multi-word goals often miss) → ilike fallback on
  // the longest token, same degradation the A1 tools use.
  if (rows.length === 0 && sanitized) {
    const token = sanitized.split(/\s+/).sort((a, b) => b.length - a.length)[0];
    if (token && token.length >= 3) {
      let fb = sb.from('products').select(PRODUCT_COLS).eq('is_active', true).ilike('search_text', `%${token}%`);
      if (budgetMaxCents != null) fb = fb.lte('price_cents', budgetMaxCents);
      const second = await fb.order('rating', { ascending: false, nullsFirst: false }).limit(Math.max(limit * 3, 12));
      if (!second.error) rows = (second.data as unknown as ProductRow[]) ?? [];
    }
  }

  const { kept, dropped } = applyPrefExclusions(rows, prefs);
  return { items: kept.slice(0, limit), dropped };
}

async function searchServicesForGoal(
  sb: SupabaseClient,
  tenantId: string,
  goal: string,
  limit: number,
): Promise<ServiceRow[]> {
  const token = goal
    .replace(/[%,()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length)[0];
  let query = sb.from('services_catalog').select(SERVICE_COLS).eq('tenant_id', tenantId);
  if (token) query = query.or(`name.ilike.%${token}%,provider_name.ilike.%${token}%`);
  const { data, error } = await query.limit(limit);
  if (error) return [];
  return (data as ServiceRow[]) ?? [];
}

function productPick(p: ProductRow, rationale: string): GuidePick {
  return { kind: 'product', id: p.id, title: p.title, price_cents: p.price_cents, currency: p.currency, rationale };
}

function speakPicks(picks: GuidePick[]): string {
  return picks
    .map((p, i) => `${i + 1}. ${p.kind === 'service' ? '[service] ' : ''}"${p.title}" (${fmtPrice(p.price_cents, p.currency)}) — ${p.rationale}`)
    .join('; ');
}

/** Find a pick in the current guide state by id, spoken title, or 1-based position. */
function matchPick(picks: GuidePick[], args: OrbToolArgs): GuidePick | null {
  const ref = String(args.product_id ?? args.item_id ?? '').trim();
  if (ref && UUID_RE.test(ref)) return picks.find((p) => p.id === ref) ?? null;
  const idx = Number(args.position ?? args.index);
  if (Number.isFinite(idx) && idx >= 1 && idx <= picks.length) return picks[Math.floor(idx) - 1];
  const title = String(args.title ?? args.query ?? args.reference ?? '').trim().toLowerCase();
  if (title) {
    return (
      picks.find((p) => p.title.toLowerCase() === title) ??
      picks.find((p) => p.title.toLowerCase().includes(title)) ??
      null
    );
  }
  return picks.length === 1 ? picks[0] : null;
}

/** Criteria still missing before recommendations can be well-grounded. */
function missingCriteria(state: GuideState, prefs: MarketplacePrefs): string[] {
  const missing: string[] = [];
  if (state.criteria.budget_max_cents == null && prefs.budget_monthly_cents == null) missing.push('budget');
  if (!state.criteria.formats?.length && !prefs.format.length) missing.push('format (home delivery, online, or in person)');
  if (!state.criteria.exclusions?.length && !prefs.exclusions.length) missing.push('anything to avoid (e.g. no pills)');
  if (!state.criteria.urgency) missing.push('urgency');
  return missing;
}

function parseCriteriaArgs(args: OrbToolArgs): Partial<GuideState['criteria']> {
  const out: Partial<GuideState['criteria']> = {};
  if (args.budget_max_amount !== undefined || args.budget_max_cents !== undefined) {
    const n =
      args.budget_max_cents !== undefined ? Number(args.budget_max_cents) : Number(args.budget_max_amount) * 100;
    if (Number.isFinite(n) && n >= 0) out.budget_max_cents = Math.round(n);
  }
  const formats = toList(args.formats ?? args.format);
  if (formats.length) out.formats = formats;
  const exclusions = toList(args.exclusions ?? args.exclude);
  if (exclusions.length) out.exclusions = exclusions;
  const priorities = toList(args.priorities);
  if (priorities.length) out.priorities = priorities;
  const urgency = String(args.urgency ?? '').trim();
  if (urgency) out.urgency = urgency;
  const location = String(args.location ?? '').trim();
  if (location) out.location = location;
  return out;
}

// ---------------------------------------------------------------------------
// A17.1 start_marketplace_discover_assistant
// ---------------------------------------------------------------------------

export async function tool_start_marketplace_discover_assistant(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('start_marketplace_discover_assistant', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'start_marketplace_discover_assistant requires a known tenant context.' };
  const goal = String(args.goal ?? args.need ?? '').trim();

  try {
    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const state = emptyGuideState(goal);
    if (goal) {
      const { intent } = classifyIntent(goal);
      state.intent = intent;
    }
    state.criteria = { ...state.criteria, ...parseCriteriaArgs(args) };
    const saved = await saveGuideState(sb, tenantId, id.user_id, state);
    if (!saved.ok) return { ok: false, error: saved.error };

    const missing = missingCriteria(state, prefs);
    const nextStep = goal
      ? missing.length
        ? `Ask ONE short question to learn the most important missing detail (${missing[0]}), then call build_personalized_shopping_guide.`
        : 'Call build_personalized_shopping_guide now.'
      : 'Ask what the user wants to achieve, solve, explore or purchase, then call capture_shopping_goal.';

    return {
      ok: true,
      result: {
        started: true,
        goal: goal || null,
        intent: state.intent,
        saved_preferences: describePrefs(prefs),
        missing_criteria: missing,
      },
      text:
        `Marketplace guide started${goal ? ` for: "${goal}"` : ''}. ` +
        `Saved preferences: ${describePrefs(prefs)}. ${nextStep} ` +
        'Keep answers short — never read long product specifications aloud.',
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'start_marketplace_discover_assistant failed' };
  }
}

// ---------------------------------------------------------------------------
// A18.1 capture_shopping_goal
// ---------------------------------------------------------------------------

export async function tool_capture_shopping_goal(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('capture_shopping_goal', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'capture_shopping_goal requires a known tenant context.' };
  const goal = String(args.goal ?? '').trim();
  if (!goal) return { ok: false, error: 'capture_shopping_goal requires the goal the user stated.' };

  try {
    const existing = await loadGuideState(sb, tenantId, id.user_id);
    const state = existing?.state ?? emptyGuideState(goal);
    state.goal = goal;
    state.intent = classifyIntent(goal).intent;
    state.criteria = { ...state.criteria, ...parseCriteriaArgs(args) };
    // A new goal invalidates picks made for the old one.
    state.picks = [];
    state.selected = null;
    const saved = await saveGuideState(sb, tenantId, id.user_id, state);
    if (!saved.ok) return { ok: false, error: saved.error };

    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const missing = missingCriteria(state, prefs);
    return {
      ok: true,
      result: { goal, intent: state.intent, criteria: state.criteria, missing_criteria: missing },
      text:
        `Goal recorded: "${goal}" (likely a ${state.intent} need). ` +
        (missing.length
          ? `Ask ONE short question about: ${missing[0]}. Then call build_personalized_shopping_guide.`
          : 'Enough context — call build_personalized_shopping_guide now.'),
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'capture_shopping_goal failed' };
  }
}

// ---------------------------------------------------------------------------
// A18.2 clarify_shopping_need
// ---------------------------------------------------------------------------

export async function tool_clarify_shopping_need(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('clarify_shopping_need', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'clarify_shopping_need requires a known tenant context.' };

  try {
    const existing = await loadGuideState(sb, tenantId, id.user_id);
    if (!existing || !existing.state.goal) {
      return {
        ok: true,
        result: { has_goal: false, missing_criteria: ['goal'] },
        text: 'No shopping goal recorded yet — ask what the user wants to achieve, then call capture_shopping_goal.',
      };
    }
    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const missing = missingCriteria(existing.state, prefs);
    return {
      ok: true,
      result: { has_goal: true, goal: existing.state.goal, criteria: existing.state.criteria, missing_criteria: missing },
      text: missing.length
        ? `Still missing: ${missing.join('; ')}. Ask ONLY about the first one (${missing[0]}) — one short question, not a questionnaire.`
        : 'Nothing important is missing — proceed to build_personalized_shopping_guide.',
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'clarify_shopping_need failed' };
  }
}

// ---------------------------------------------------------------------------
// A18.3 classify_marketplace_intent
// ---------------------------------------------------------------------------

export async function tool_classify_marketplace_intent(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('classify_marketplace_intent', id);
  if (gate) return gate;
  let need = String(args.need ?? args.goal ?? args.query ?? '').trim();

  try {
    if (!need) {
      const tenantId = await resolveTenantId(id, sb);
      if (tenantId) {
        const existing = await loadGuideState(sb, tenantId, id.user_id);
        need = existing?.state.goal ?? '';
      }
    }
    if (!need) return { ok: false, error: 'classify_marketplace_intent requires the stated need (or a recorded goal).' };
    const { intent, reasons } = classifyIntent(need);
    const nextTool =
      intent === 'diagnostic_test'
        ? 'browse_wellness_services (labs) — note the dedicated diagnostic-test catalog is not built yet'
        : intent === 'practitioner'
          ? 'browse_doctors_coaches or find_perfect_practitioner'
          : intent === 'service'
            ? 'search_services_by_need'
            : intent === 'combination'
              ? 'recommend_marketplace_path'
              : 'search_products_by_need';
    return {
      ok: true,
      result: { need, intent, reasons, suggested_next_tool: nextTool },
      text: `This sounds like a ${intent.replace(/_/g, ' ')} need (${reasons[0] ?? 'default'}). Suggested next step: ${nextTool}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'classify_marketplace_intent failed' };
  }
}

// ---------------------------------------------------------------------------
// A17.2 build_personalized_shopping_guide
// ---------------------------------------------------------------------------

export async function tool_build_personalized_shopping_guide(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('build_personalized_shopping_guide', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'build_personalized_shopping_guide requires a known tenant context.' };

  try {
    const existing = await loadGuideState(sb, tenantId, id.user_id);
    const goal = String(args.goal ?? '').trim() || existing?.state.goal || '';
    if (!goal) {
      return { ok: false, error: 'build_personalized_shopping_guide needs a goal — call capture_shopping_goal first.' };
    }
    const state = existing?.state ?? emptyGuideState(goal);
    state.goal = goal;
    const { intent } = classifyIntent(goal);
    state.intent = intent;
    state.criteria = { ...state.criteria, ...parseCriteriaArgs(args) };

    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const budgetMax = state.criteria.budget_max_cents ?? prefs.budget_monthly_cents ?? null;
    const maxPicks = clampInt(args.max_items, 1, 3, 3);

    // 1. Product picks — shopping agent first (LLM planning + limitations
    //    filter), collect-only so NOTHING is staged into the cart here.
    let productPicks: GuidePick[] = [];
    let advisory: string[] = [];
    try {
      const collected: AnnotatedPick[] = [];
      const collectOnly: InsertPickFn = async (pick) => {
        collected.push(pick);
        // Not a cart write — synthetic id marks the pick as proposal-only.
        return { ok: true, item_id: `proposal-${collected.length}` };
      };
      const ctx = await getUserHealthContext(id.user_id);
      const monthlySpendCents = await getMonthlySpend(sb, id.user_id, ctx.currency ?? DEFAULT_CURRENCY);
      const proposeRes = await runPropose({
        prompt: goal,
        maxItems: maxPicks,
        ctx,
        supabase: sb,
        insertPick: collectOnly,
        runId: randomUUID(),
        monthly_spend_cents: monthlySpendCents,
      });
      if (proposeRes.ok) {
        advisory = proposeRes.advisory ?? [];
        productPicks = collected.map((p) => ({
          kind: 'product' as const,
          id: p.product_id,
          title: p.title,
          price_cents: p.unit_price_cents_snapshot,
          currency: p.currency_snapshot,
          rationale: p.rationale,
          safety_flags: p.safety_flags,
        }));
      }
    } catch {
      /* degrade to the deterministic search below */
    }

    // 2. Deterministic fallback / top-up when the agent found nothing.
    let droppedNote = '';
    if (productPicks.length === 0) {
      const { items, dropped } = await searchProductsForGoal(sb, goal, prefs, budgetMax, maxPicks);
      productPicks = items.map((p) =>
        productPick(p, `matches "${goal}"${budgetMax != null ? ' within budget' : ''}${p.rating != null ? `, rated ${p.rating.toFixed(1)}/5` : ''}`),
      );
      if (dropped.length) {
        droppedNote = ` I filtered out ${dropped.length} option${dropped.length === 1 ? '' : 's'} against saved preferences (${dropped[0].reason}${dropped.length > 1 ? ', …' : ''}).`;
      }
    }

    // 3. Service options for non-pure-product intents.
    let servicePicks: GuidePick[] = [];
    if (intent !== 'product') {
      const services = await searchServicesForGoal(sb, tenantId, goal, 2);
      servicePicks = services.map((s) => ({
        kind: 'service' as const,
        id: s.id,
        title: s.name,
        price_cents: null,
        currency: null,
        rationale: `${s.service_type} service${s.provider_name ? ` with ${s.provider_name}` : ''} relevant to "${goal}"`,
      }));
    }

    state.picks = [...productPicks, ...servicePicks].slice(0, 4);
    state.selected = null;
    const saved = await saveGuideState(sb, tenantId, id.user_id, state);
    if (!saved.ok) return { ok: false, error: saved.error };

    if (state.picks.length === 0) {
      return {
        ok: true,
        result: { goal, intent, picks: [], advisory },
        text:
          `I couldn't find suitable marketplace options for "${goal}" right now. ` +
          'Tell the user honestly and offer to widen the search or change the criteria — do not invent options.',
      };
    }

    const pathNote =
      intent === 'diagnostic_test' || intent === 'combination'
        ? ` Since this is about understanding a health question first, suggest starting with a service/assessment rather than a product. ${HEALTH_BOUNDARY_NOTE}`
        : '';
    return {
      ok: true,
      result: { goal, intent, picks: state.picks, advisory },
      text:
        `Guide for "${goal}" — ${state.picks.length} option${state.picks.length === 1 ? '' : 's'}: ${speakPicks(state.picks)}.${droppedNote}${pathNote} ` +
        'Present at most 3, each in one sentence (what it is + why it fits). Then offer: compare, explain one, refine, or add one to the basket.',
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'build_personalized_shopping_guide failed' };
  }
}

// ---------------------------------------------------------------------------
// A17.3 refine_marketplace_recommendations
// ---------------------------------------------------------------------------

export async function tool_refine_marketplace_recommendations(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('refine_marketplace_recommendations', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'refine_marketplace_recommendations requires a known tenant context.' };

  try {
    const existing = await loadGuideState(sb, tenantId, id.user_id);
    if (!existing || !existing.state.goal) {
      return { ok: false, error: 'No active shopping guide to refine — call capture_shopping_goal first.' };
    }
    const state = existing.state;
    const updates = parseCriteriaArgs(args);
    const extraExclusions = toList(args.exclude ?? args.exclusions);
    state.criteria = {
      ...state.criteria,
      ...updates,
      exclusions: Array.from(new Set([...(state.criteria.exclusions ?? []), ...extraExclusions])),
    };
    const preferTerm = String(args.prefer ?? '').trim();
    const searchGoal = preferTerm ? `${state.goal} ${preferTerm}` : state.goal;

    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    // Session-level exclusions stack on top of the saved ones for this search.
    const effectivePrefs: MarketplacePrefs = {
      ...prefs,
      exclusions: Array.from(new Set([...prefs.exclusions, ...(state.criteria.exclusions ?? [])])),
    };
    const budgetMax = state.criteria.budget_max_cents ?? prefs.budget_monthly_cents ?? null;

    const { items, dropped } = await searchProductsForGoal(sb, searchGoal, effectivePrefs, budgetMax, 3);
    state.picks = items.map((p) =>
      productPick(
        p,
        `matches "${state.goal}"${preferTerm ? ` with preference "${preferTerm}"` : ''}${budgetMax != null ? ' within budget' : ''}`,
      ),
    );
    state.selected = null;
    const saved = await saveGuideState(sb, tenantId, id.user_id, state);
    if (!saved.ok) return { ok: false, error: saved.error };

    if (state.picks.length === 0) {
      return {
        ok: true,
        result: { picks: [], dropped },
        text:
          'After applying that feedback, nothing suitable is left. Say so honestly and ask whether to relax the budget or one exclusion.',
      };
    }
    return {
      ok: true,
      result: { picks: state.picks, dropped },
      text: `Updated options: ${speakPicks(state.picks)}. Offer: compare, explain, refine again, or add one to the basket.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'refine_marketplace_recommendations failed' };
  }
}

// ---------------------------------------------------------------------------
// A17.4 explain_marketplace_recommendation
// ---------------------------------------------------------------------------

export async function tool_explain_marketplace_recommendation(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('explain_marketplace_recommendation', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'explain_marketplace_recommendation requires a known tenant context.' };

  try {
    const existing = await loadGuideState(sb, tenantId, id.user_id);
    if (!existing || existing.state.picks.length === 0) {
      return { ok: false, error: 'No current recommendations to explain — build the shopping guide first.' };
    }
    const pick = matchPick(existing.state.picks, args);
    if (!pick) {
      return {
        ok: true,
        result: { found: false, picks: existing.state.picks.map((p) => p.title) },
        text: `Which option? Current picks: ${existing.state.picks.map((p, i) => `${i + 1}. "${p.title}"`).join('; ')}.`,
      };
    }

    let limits = '';
    let usage = '';
    if (pick.kind === 'product') {
      const res = await resolveProduct(sb, pick.id, '');
      if (res.ok && res.product) {
        if (res.product.safety_notes) limits = ` Relevant limitation: ${res.product.safety_notes}.`;
        if (res.product.dosage || res.product.serving_size) {
          usage = ` Practical use: ${[res.product.dosage, res.product.serving_size].filter(Boolean).join(', ')}.`;
        }
      }
    }
    const flags = pick.safety_flags?.length ? ` Safety notes for this user: ${pick.safety_flags.join(', ')}.` : '';
    return {
      ok: true,
      result: { pick, limits: limits || null },
      text:
        `"${pick.title}" (${fmtPrice(pick.price_cents, pick.currency)}): ${pick.rationale}.${usage}${limits}${flags} ` +
        `Keep it to what/why/why-for-them — no spec dump. ${HEALTH_BOUNDARY_NOTE}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'explain_marketplace_recommendation failed' };
  }
}

// ---------------------------------------------------------------------------
// A17.5 complete_marketplace_selection (⚠️ two-step confirm)
// ---------------------------------------------------------------------------

export async function tool_complete_marketplace_selection(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('complete_marketplace_selection', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'complete_marketplace_selection requires a known tenant context.' };

  try {
    const existing = await loadGuideState(sb, tenantId, id.user_id);
    const state = existing?.state ?? null;
    const pick = state ? matchPick(state.picks, args) ?? state.selected : null;
    if (!pick) {
      return { ok: false, error: 'No selected option found — name one of the current picks (or build the guide first).' };
    }
    if (pick.kind === 'service') {
      return {
        ok: true,
        result: { kind: 'service', service_id: pick.id, title: pick.title },
        text:
          `"${pick.title}" is a service — service booking by voice is not available yet. ` +
          'Offer to open the provider profile on screen instead (get_provider_profile).',
      };
    }

    const res = await resolveProduct(sb, pick.id, '');
    if (!res.ok) return { ok: false, error: res.error };
    if (!res.product) return { ok: false, error: 'That product is no longer available in the marketplace.' };
    const product = res.product;

    if (args.confirm !== true) {
      if (state) {
        state.selected = pick;
        await saveGuideState(sb, tenantId, id.user_id, state);
      }
      return {
        ok: true,
        result: {
          needs_confirmation: true,
          product_id: product.id,
          title: product.title,
          price_cents: product.price_cents,
          currency: product.currency,
          availability: product.availability,
        },
        text:
          `Confirm with the user: add "${product.title}" (${fmtPrice(product.price_cents, product.currency)}${
            product.availability !== 'in_stock' ? `, availability: ${product.availability}` : ''
          }) to the basket? When they say yes, call complete_marketplace_selection again with confirm:true. Payment stays on screen.`,
      };
    }

    const staged = await stageProductInCart(sb, id, product, 'discover_assistant', pick.rationale);
    if (!staged.ok) return { ok: false, error: staged.error };
    if (state) {
      state.selected = pick;
      await saveGuideState(sb, tenantId, id.user_id, state);
    }
    const route = '/cart';
    return {
      ok: true,
      result: {
        added: true,
        item_id: staged.itemId,
        product_id: product.id,
        title: product.title,
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.CART', route, 'Shopping Cart', 'complete_marketplace_selection added'),
        redirect: { route },
      },
      text: `Done — "${product.title}" is in the basket. Review and confirm payment on the screen; nothing has been charged.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'complete_marketplace_selection failed' };
  }
}

// ---------------------------------------------------------------------------
// A18.5–7 preferences (memory_facts marketplace_pref_* via writeFact)
// ---------------------------------------------------------------------------

export async function tool_save_marketplace_preferences(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('save_marketplace_preferences', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'save_marketplace_preferences requires a known tenant context.' };

  try {
    const writes: Array<{ key: string; value: string; spoken: string }> = [];
    if (args.budget_monthly_amount !== undefined || args.budget_monthly_cents !== undefined) {
      const n =
        args.budget_monthly_cents !== undefined
          ? Number(args.budget_monthly_cents)
          : Number(args.budget_monthly_amount) * 100;
      if (Number.isFinite(n) && n >= 0) {
        const cents = Math.round(n);
        writes.push({
          key: 'marketplace_pref_budget_monthly_cents',
          value: String(cents),
          spoken: `monthly budget ${fmtPrice(cents, null)}`,
        });
      }
    }
    const listFields: Array<{ arg: string; key: string; label: string }> = [
      { arg: 'dietary', key: 'marketplace_pref_dietary', label: 'dietary' },
      { arg: 'values', key: 'marketplace_pref_values', label: 'values' },
      { arg: 'exclusions', key: 'marketplace_pref_exclusions', label: 'avoids' },
      { arg: 'excluded_brands', key: 'marketplace_pref_excluded_brands', label: 'excluded brands' },
      { arg: 'excluded_categories', key: 'marketplace_pref_excluded_categories', label: 'excluded categories' },
      { arg: 'format', key: 'marketplace_pref_format', label: 'preferred format' },
    ];
    for (const f of listFields) {
      if (args[f.arg] === undefined) continue;
      const list = toList(args[f.arg]);
      writes.push({ key: f.key, value: list.join(', '), spoken: `${f.label}: ${list.join(', ') || 'cleared'}` });
    }
    if (writes.length === 0) {
      return {
        ok: false,
        error:
          'save_marketplace_preferences needs at least one preference: budget_monthly_amount, dietary, values, exclusions, excluded_brands, excluded_categories, or format.',
      };
    }

    for (const w of writes) {
      const res = await writeFact({
        tenant_id: tenantId,
        user_id: id.user_id,
        fact_key: w.key,
        fact_value: w.value,
        entity: 'self',
        fact_value_type: 'text',
        provenance_source: 'user_stated',
        provenance_confidence: 0.95,
      });
      if (!res.ok) return { ok: false, error: res.error ?? `could not save ${w.key}` };
    }

    return {
      ok: true,
      result: { saved: writes.map((w) => w.key) },
      text: `Saved: ${writes.map((w) => w.spoken).join('; ')}. These now shape future marketplace recommendations.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'save_marketplace_preferences failed' };
  }
}

export async function tool_get_marketplace_preferences(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_marketplace_preferences', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'get_marketplace_preferences requires a known tenant context.' };
  try {
    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    return {
      ok: true,
      result: { preferences: prefs },
      text: `Saved marketplace preferences: ${describePrefs(prefs)}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_marketplace_preferences failed' };
  }
}

export async function tool_reset_marketplace_preferences(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('reset_marketplace_preferences', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'reset_marketplace_preferences requires a known tenant context.' };

  try {
    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const current = describePrefs(prefs);
    if (current === 'no saved marketplace preferences') {
      return { ok: true, result: { reset: false }, text: 'There are no saved marketplace preferences to reset.' };
    }
    if (args.confirm !== true) {
      return {
        ok: true,
        result: { needs_confirmation: true, current_preferences: current },
        text:
          `Confirm with the user: clear all saved marketplace preferences (${current})? ` +
          'When they say yes, call reset_marketplace_preferences again with confirm:true.',
      };
    }
    // Clear via the same supersession path as writing — the fact history
    // stays intact (append-only), the current value just becomes empty.
    const populated: Array<{ key: string; has: boolean }> = [
      { key: 'marketplace_pref_budget_monthly_cents', has: prefs.budget_monthly_cents != null },
      { key: 'marketplace_pref_dietary', has: prefs.dietary.length > 0 },
      { key: 'marketplace_pref_values', has: prefs.values.length > 0 },
      { key: 'marketplace_pref_exclusions', has: prefs.exclusions.length > 0 },
      { key: 'marketplace_pref_excluded_brands', has: prefs.excluded_brands.length > 0 },
      { key: 'marketplace_pref_excluded_categories', has: prefs.excluded_categories.length > 0 },
      { key: 'marketplace_pref_format', has: prefs.format.length > 0 },
    ];
    for (const p of populated.filter((x) => x.has)) {
      const res = await writeFact({
        tenant_id: tenantId,
        user_id: id.user_id,
        fact_key: p.key,
        fact_value: '',
        entity: 'self',
        fact_value_type: 'text',
        provenance_source: 'user_stated',
        provenance_confidence: 0.95,
      });
      if (!res.ok) return { ok: false, error: res.error ?? `could not reset ${p.key}` };
    }
    return { ok: true, result: { reset: true }, text: 'Done — all saved marketplace preferences are cleared.' };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'reset_marketplace_preferences failed' };
  }
}

// ---------------------------------------------------------------------------
// A19.1 get_marketplace_context
// ---------------------------------------------------------------------------

export async function tool_get_marketplace_context(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_marketplace_context', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'get_marketplace_context requires a known tenant context.' };

  try {
    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);

    let budgetCapCents: number | null = null;
    try {
      const { data } = await sb
        .from('user_limitations')
        .select('budget_monthly_cap_cents')
        .eq('user_id', id.user_id)
        .maybeSingle();
      budgetCapCents = (data as { budget_monthly_cap_cents?: number | null } | null)?.budget_monthly_cap_cents ?? null;
    } catch {
      /* budget cap is optional context */
    }
    let monthlySpendCents = 0;
    try {
      monthlySpendCents = await getMonthlySpend(sb, id.user_id, DEFAULT_CURRENCY);
    } catch {
      /* spend is optional context */
    }

    const { data: orderRows } = await sb
      .from('product_orders')
      .select('product_id, state, amount_cents, currency, created_at')
      .eq('user_id', id.user_id)
      .order('created_at', { ascending: false })
      .limit(3);
    const orders = (orderRows as Array<{ product_id: string | null; state: string; amount_cents: number | null; currency: string | null }>) ?? [];

    const existing = await loadGuideState(sb, tenantId, id.user_id);
    return {
      ok: true,
      result: {
        preferences: prefs,
        budget_monthly_cap_cents: budgetCapCents,
        monthly_spend_cents: monthlySpendCents,
        recent_order_count: orders.length,
        active_goal: existing?.state.goal ?? null,
      },
      text:
        `Marketplace context — preferences: ${describePrefs(prefs)}. ` +
        `Shopping budget: ${budgetCapCents != null ? `${fmtPrice(budgetCapCents, null)}/month, ${fmtPrice(monthlySpendCents, null)} spent this month` : 'none set'}. ` +
        `Recent orders: ${orders.length}. ${existing?.state.goal ? `Active shopping goal: "${existing.state.goal}".` : 'No active shopping goal.'} ` +
        'Use only what is relevant; if the user asks why a recommendation was made, cite these stated preferences — never an opaque score.',
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_marketplace_context failed' };
  }
}

// ---------------------------------------------------------------------------
// A19.3 dismiss_marketplace_recommendation
// ---------------------------------------------------------------------------

export async function tool_dismiss_marketplace_recommendation(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('dismiss_marketplace_recommendation', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'dismiss_marketplace_recommendation requires a known tenant context.' };

  try {
    const existing = await loadGuideState(sb, tenantId, id.user_id);
    let target: { type: 'product' | 'service'; targetId: string; title: string } | null = null;

    const fromPicks = existing ? matchPick(existing.state.picks, args) : null;
    if (fromPicks) {
      target = { type: fromPicks.kind, targetId: fromPicks.id, title: fromPicks.title };
    } else {
      const res = await resolveProduct(sb, String(args.product_id ?? '').trim(), String(args.title ?? args.query ?? '').trim());
      if (!res.ok) return { ok: false, error: res.error };
      if (res.product) target = { type: 'product', targetId: res.product.id, title: res.product.title };
    }
    if (!target) {
      return { ok: false, error: 'Could not resolve which recommendation to dismiss — name the product.' };
    }

    const { error } = await sb.from('user_offers_memory').upsert(
      {
        tenant_id: tenantId,
        user_id: id.user_id,
        target_type: target.type,
        target_id: target.targetId,
        state: 'dismissed',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tenant_id,user_id,target_type,target_id' },
    );
    if (error) return { ok: false, error: error.message };

    if (existing && fromPicks) {
      existing.state.picks = existing.state.picks.filter((p) => p.id !== fromPicks.id);
      if (existing.state.selected?.id === fromPicks.id) existing.state.selected = null;
      await saveGuideState(sb, tenantId, id.user_id, existing.state);
    }
    return {
      ok: true,
      result: { dismissed: true, title: target.title },
      text: `Understood — "${target.title}" is dismissed and won't be recommended again.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'dismiss_marketplace_recommendation failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const MARKETPLACE_GUIDE_TOOL_HANDLERS: Record<string, Handler> = {
  start_marketplace_discover_assistant: tool_start_marketplace_discover_assistant,
  build_personalized_shopping_guide: tool_build_personalized_shopping_guide,
  refine_marketplace_recommendations: tool_refine_marketplace_recommendations,
  explain_marketplace_recommendation: tool_explain_marketplace_recommendation,
  complete_marketplace_selection: tool_complete_marketplace_selection,
  capture_shopping_goal: tool_capture_shopping_goal,
  clarify_shopping_need: tool_clarify_shopping_need,
  classify_marketplace_intent: tool_classify_marketplace_intent,
  save_marketplace_preferences: tool_save_marketplace_preferences,
  get_marketplace_preferences: tool_get_marketplace_preferences,
  reset_marketplace_preferences: tool_reset_marketplace_preferences,
  get_marketplace_context: tool_get_marketplace_context,
  dismiss_marketplace_recommendation: tool_dismiss_marketplace_recommendation,
};

export const MARKETPLACE_GUIDE_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'start_marketplace_discover_assistant',
    description: [
      'Start a guided marketplace conversation for a product, service,',
      'practitioner or diagnostic need. CALL WHEN the user asks for shopping',
      'guidance rather than a specific item: "I want a full shopping guide",',
      '"help me find something for my energy", "ich brauche eine Einkaufsberatung".',
      'Then follow the returned next step. Never read long specifications aloud.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The stated goal/need, if the user already said it.' },
        budget_max_amount: { type: 'number', description: 'Budget ceiling in whole currency units (e.g. 150).' },
        exclusions: { type: 'string', description: 'Comma-separated things to avoid (e.g. "pills").' },
      },
      required: [],
    },
  },
  {
    name: 'build_personalized_shopping_guide',
    description: [
      'Build a concise personalized recommendation set (max 3 options with',
      'short rationales) for the recorded shopping goal, across products and',
      'services. Nothing is added to the cart. CALL WHEN the goal (and the most',
      'important criteria) are known. Present each option in ONE sentence.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Override goal (otherwise the recorded one is used).' },
        budget_max_amount: { type: 'number', description: 'Budget ceiling in whole currency units.' },
        max_items: { type: 'number', description: 'Max options (default 3).' },
      },
      required: [],
    },
  },
  {
    name: 'refine_marketplace_recommendations',
    description: [
      'Update the current recommendations from conversational feedback.',
      'CALL WHEN the user reacts to picks: "cheaper", "nothing with pills",',
      '"I prefer something for home", "etwas Günstigeres bitte".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        exclude: { type: 'string', description: 'Comma-separated new exclusions from the feedback.' },
        prefer: { type: 'string', description: 'What the user now prefers (e.g. "tea", "home test").' },
        budget_max_amount: { type: 'number', description: 'New budget ceiling in whole currency units.' },
      },
      required: [],
    },
  },
  {
    name: 'explain_marketplace_recommendation',
    description: [
      'Explain one current pick: what it is, why it was chosen for this user,',
      'practical use, and relevant limitations. CALL WHEN the user asks "why',
      'this one?", "tell me more about the second option", "warum empfiehlst du',
      'mir das?". Answer concisely — what/why/limits, never the full spec.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        position: { type: 'number', description: '1-based position of the pick ("the second one" → 2).' },
        title: { type: 'string', description: 'Spoken name of the pick.' },
        product_id: { type: 'string', description: 'Exact product UUID when known.' },
      },
      required: [],
    },
  },
  {
    name: 'complete_marketplace_selection',
    description: [
      'Confirm the chosen option and stage it into the basket (NEVER charges;',
      'payment stays on screen). ALWAYS call once WITHOUT confirm first — it',
      'returns a read-back of name and price; after the user says yes, call',
      'again with confirm:true. CALL WHEN the user picks an option: "take the',
      'second one", "add it to my basket", "nimm das erste".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        position: { type: 'number', description: '1-based position of the chosen pick.' },
        title: { type: 'string', description: 'Spoken name of the chosen pick.' },
        product_id: { type: 'string', description: 'Exact product UUID when known.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the read-back.' },
      },
      required: [],
    },
  },
  {
    name: 'capture_shopping_goal',
    description: [
      'Record what the user wants to achieve, solve, explore or purchase.',
      'CALL WHEN the user states a shopping goal in a guided conversation:',
      '"I want to improve my sleep", "ich will meine Energie verbessern".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal in the user\'s words.' },
        budget_max_amount: { type: 'number', description: 'Budget ceiling if stated.' },
        exclusions: { type: 'string', description: 'Comma-separated exclusions if stated (e.g. "pills").' },
        urgency: { type: 'string', description: 'Urgency if stated (e.g. "this week").' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'clarify_shopping_need',
    description: [
      'Get the smallest set of still-missing criteria (budget, format,',
      'exclusions, urgency) for the recorded goal so you ask only the most',
      'important follow-up question. CALL BEFORE building the guide when the',
      'request was vague. Ask ONE question at a time, never a questionnaire.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'classify_marketplace_intent',
    description: [
      'Determine whether a need maps to a product, service, diagnostic test,',
      'practitioner or combination, with the suggested next tool. CALL WHEN',
      'unsure which direction a marketplace request should take.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { need: { type: 'string', description: 'The stated need (defaults to the recorded goal).' } },
      required: [],
    },
  },
  {
    name: 'save_marketplace_preferences',
    description: [
      'Save reusable shopping preferences the user explicitly stated: budget,',
      'dietary needs, values, exclusions, excluded brands/categories, preferred',
      'format. CALL ONLY after the user stated the preference or agreed to save',
      'it: "remember that I\'m vegan", "merk dir, dass ich keine Kapseln will".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        budget_monthly_amount: { type: 'number', description: 'Monthly budget in whole currency units.' },
        dietary: { type: 'string', description: 'Comma-separated dietary needs (e.g. "vegan, gluten-free").' },
        values: { type: 'string', description: 'Comma-separated values (e.g. "sustainable, local").' },
        exclusions: { type: 'string', description: 'Comma-separated things to avoid (e.g. "pills").' },
        excluded_brands: { type: 'string', description: 'Comma-separated brands to exclude.' },
        excluded_categories: { type: 'string', description: 'Comma-separated categories to exclude.' },
        format: { type: 'string', description: 'Preferred formats (e.g. "home, online").' },
      },
      required: [],
    },
  },
  {
    name: 'get_marketplace_preferences',
    description: [
      'Read the user\'s saved marketplace preferences. CALL WHEN the user asks',
      '"what do you know about my shopping preferences?" or before explaining',
      'why a recommendation was personalized.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'reset_marketplace_preferences',
    description: [
      'Clear all saved marketplace preferences. ALWAYS call once WITHOUT',
      'confirm first — it reads back what would be cleared; after the user says',
      'yes, call again with confirm:true. CALL WHEN the user asks to forget or',
      'reset their shopping preferences.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed.' } },
      required: [],
    },
  },
  {
    name: 'get_marketplace_context',
    description: [
      'Get the minimum relevant context for a shopping request: saved',
      'preferences, shopping budget and spend, recent orders, active goal.',
      'CALL at the start of a guided shopping conversation, or when the user',
      'asks "why are you recommending this to me?" — then answer citing their',
      'stated preferences in plain language, never an algorithm score.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dismiss_marketplace_recommendation',
    description: [
      'Dismiss a recommended product so it is not proposed again. CALL WHEN',
      'the user rejects a recommendation: "not that one", "don\'t show me this',
      'again", "das interessiert mich nicht".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        position: { type: 'number', description: '1-based position of the pick to dismiss.' },
        title: { type: 'string', description: 'Spoken name of the item to dismiss.' },
        product_id: { type: 'string', description: 'Exact product UUID when known.' },
      },
      required: [],
    },
  },
];
