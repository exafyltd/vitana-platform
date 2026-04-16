/**
 * VTID-02000: User Health Context primitive
 *
 * Single source of truth for "who is this user right now, what conditions,
 * restrictions, signals, and preferences apply, and what constraints must
 * any product suggestion respect?"
 *
 * Consumed by:
 *   - search_marketplace_products assistant tool (auto-enriches filters)
 *   - open_discover_feed assistant tool
 *   - marketplace-analyzer.ts (feeds ranking)
 *   - limitations-filter.ts (hard-filter source)
 *   - context-pack-builder.ts (injects marketplace_context into every turn)
 *   - Future unified Vitana Brain (contract already aligns)
 *
 * Sources (Phase 0):
 *   - memory_facts (health, dietary, medication keys)
 *   - user_limitations (safety-critical constraints)
 *   - user_topic_profile (affinity signals, optional)
 *   - app_users (geo + lifecycle + scope preference + currency)
 *   - product_orders (past purchases — exclude re-recommendation)
 *   - calendar_events (upcoming relevant events)
 *
 * Sources (Phase 1+):
 *   - wearable_daily_metrics (sleep/HRV/activity rollup)
 *
 * Caches per-user for 60 seconds; cache-busted on explicit invalidation.
 */

import { getSupabase } from '../lib/supabase';
import type {
  ProductScopePreference,
  LifecycleStage,
} from '../types/catalog-ingest';

// ==================== Types ====================

export interface UserHealthContextActiveCondition {
  key: string;
  since?: string;
  source: 'user_stated' | 'assistant_inferred' | 'limitations_table';
}

export interface UserHealthContextActiveGoal {
  key: string;
  since?: string;
}

export interface UserHealthContextWearableSummary7d {
  sleep_avg_minutes?: number | null;
  sleep_deep_pct?: number | null;
  hrv_avg_ms?: number | null;
  resting_hr?: number | null;
  activity_minutes?: number | null;
  workout_count?: number | null;
}

export interface UserHealthContextPastPurchase {
  product_id: string;
  purchased_at: string;
  reordered: boolean;
  outcome_rating?: number | null;
}

export interface UserHealthContextUpcomingEvent {
  start: string;
  event_type: string;
  shifts_recommendations: string[]; // derived hints: 'sleep-critical', 'travel', 'menstrual-window', ...
  title?: string;
}

export interface UserHealthContext {
  user_id: string;
  tenant_id: string | null;

  // Conditions & goals
  active_conditions: UserHealthContextActiveCondition[];
  active_goals: UserHealthContextActiveGoal[];

  // Hard constraints (never overridable)
  dietary_restrictions: string[];
  allergies: string[];
  contraindications: string[];
  current_medications: string[];
  pregnancy_status: string | null;
  age_bracket: string | null;
  religious_restrictions: string[];
  ingredient_sensitivities: string[];

  // Budget
  budget_max_per_product_cents: number | null;
  budget_monthly_cap_cents: number | null;
  budget_preferred_band: string | null;

  // Signals (Phase 1+ for wearable)
  wearable_summary_7d: UserHealthContextWearableSummary7d | null;
  vitana_index_snapshot: Record<string, number> | null;

  // Calendar context
  upcoming_events: UserHealthContextUpcomingEvent[];

  // Past behavior
  past_purchases: UserHealthContextPastPurchase[];
  recent_recommendations_dismissed: string[]; // product_ids
  topic_affinity: Record<string, number>;

  // Regional
  country_code: string | null;
  region_group: string | null;
  scope_preference: ProductScopePreference;
  currency: string | null;
  lifecycle_stage: LifecycleStage | null;

  // Audit
  retrieved_at: string;
  sources_queried: string[];
  stale: boolean; // true if any source failed — caller should treat with caution
}

// ==================== Cache ====================

interface CacheEntry {
  ctx: UserHealthContext;
  expiresAt: number;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export function invalidateUserHealthContext(user_id: string): void {
  CACHE.delete(user_id);
}

// ==================== Main primitive ====================

export interface GetUserHealthContextOpts {
  include_wearable?: boolean;   // Phase 1+ — if false (default), skip wearable source
  include_calendar?: boolean;   // default true
  include_past_purchases?: boolean; // default true
  bypass_cache?: boolean;
}

export async function getUserHealthContext(
  user_id: string,
  opts: GetUserHealthContextOpts = {}
): Promise<UserHealthContext> {
  if (!opts.bypass_cache) {
    const cached = CACHE.get(user_id);
    if (cached && cached.expiresAt > Date.now()) return cached.ctx;
  }

  const supabase = getSupabase();
  const sources_queried: string[] = [];
  let stale = false;

  // --- Identity + geo + lifecycle + scope from app_users ---
  let country_code: string | null = null;
  let region_group: string | null = null;
  let scope_preference: ProductScopePreference = 'friendly';
  let currency: string | null = null;
  let lifecycle_stage: LifecycleStage | null = null;
  let tenant_id: string | null = null;

  if (supabase) {
    const { data: userRow, error: userErr } = await supabase
      .from('app_users')
      .select(
        'country_code, delivery_country_code, region_group, currency_preference, product_scope_preference, lifecycle_stage'
      )
      .eq('user_id', user_id)
      .maybeSingle();
    if (!userErr && userRow) {
      country_code = userRow.delivery_country_code ?? userRow.country_code ?? null;
      region_group = userRow.region_group ?? null;
      currency = userRow.currency_preference ?? null;
      scope_preference = (userRow.product_scope_preference as ProductScopePreference) ?? 'friendly';
      lifecycle_stage = (userRow.lifecycle_stage as LifecycleStage) ?? null;
      sources_queried.push('app_users');
    } else {
      stale = true;
    }

    // Resolve tenant_id from user_tenants if available
    const { data: userTenant } = await supabase
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', user_id)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (userTenant) tenant_id = userTenant.tenant_id;
  } else {
    stale = true;
  }

  // --- Limitations table ---
  const ctx: UserHealthContext = {
    user_id,
    tenant_id,
    active_conditions: [],
    active_goals: [],
    dietary_restrictions: [],
    allergies: [],
    contraindications: [],
    current_medications: [],
    pregnancy_status: null,
    age_bracket: null,
    religious_restrictions: [],
    ingredient_sensitivities: [],
    budget_max_per_product_cents: null,
    budget_monthly_cap_cents: null,
    budget_preferred_band: null,
    wearable_summary_7d: null,
    vitana_index_snapshot: null,
    upcoming_events: [],
    past_purchases: [],
    recent_recommendations_dismissed: [],
    topic_affinity: {},
    country_code,
    region_group,
    scope_preference,
    currency,
    lifecycle_stage,
    retrieved_at: new Date().toISOString(),
    sources_queried,
    stale,
  };

  if (supabase) {
    // user_limitations (primary source of truth for hard filters)
    try {
      const { data: lim } = await supabase
        .from('user_limitations')
        .select(
          'allergies, dietary_restrictions, contraindications, current_medications, pregnancy_status, age_bracket, religious_restrictions, ingredient_sensitivities, budget_max_per_product_cents, budget_monthly_cap_cents, budget_preferred_band'
        )
        .eq('user_id', user_id)
        .maybeSingle();
      if (lim) {
        ctx.allergies = lim.allergies ?? [];
        ctx.dietary_restrictions = lim.dietary_restrictions ?? [];
        ctx.contraindications = lim.contraindications ?? [];
        ctx.current_medications = lim.current_medications ?? [];
        ctx.pregnancy_status = lim.pregnancy_status ?? null;
        ctx.age_bracket = lim.age_bracket ?? null;
        ctx.religious_restrictions = lim.religious_restrictions ?? [];
        ctx.ingredient_sensitivities = lim.ingredient_sensitivities ?? [];
        ctx.budget_max_per_product_cents = lim.budget_max_per_product_cents ?? null;
        ctx.budget_monthly_cap_cents = lim.budget_monthly_cap_cents ?? null;
        ctx.budget_preferred_band = lim.budget_preferred_band ?? null;
        sources_queried.push('user_limitations');

        for (const c of ctx.contraindications) {
          ctx.active_conditions.push({ key: c, source: 'limitations_table' });
        }
      }
    } catch {
      stale = true;
    }

    // memory_facts — health/dietary/medication/goal facts
    try {
      const healthKeys = [
        'user_allergy',
        'user_medication',
        'user_health_condition',
        'user_pregnancy_status',
        'user_ingredient_sensitivity',
        'user_dietary_preference',
        'user_religious_restriction',
        'user_goal',
      ];
      const { data: facts } = await supabase
        .from('memory_facts')
        .select('fact_key, fact_value, extracted_at, provenance_source')
        .eq('user_id', user_id)
        .in('fact_key', healthKeys)
        .is('superseded_by', null);

      if (facts) {
        for (const f of facts) {
          const val = (f.fact_value ?? '').toString().trim();
          if (!val) continue;

          if (f.fact_key === 'user_health_condition') {
            if (!ctx.active_conditions.some((c) => c.key === val)) {
              ctx.active_conditions.push({
                key: val,
                since: f.extracted_at ?? undefined,
                source: f.provenance_source === 'user_stated' ? 'user_stated' : 'assistant_inferred',
              });
            }
          } else if (f.fact_key === 'user_goal') {
            ctx.active_goals.push({ key: val, since: f.extracted_at ?? undefined });
          }
        }
        sources_queried.push('memory_facts');
      }
    } catch {
      stale = true;
    }

    // user_topic_profile — affinity signals (optional source)
    try {
      const { data: topics } = await supabase
        .from('user_topic_profile')
        .select('topic_key, score')
        .eq('user_id', user_id);
      if (topics) {
        for (const t of topics) {
          if (t.topic_key && typeof t.score === 'number') {
            ctx.topic_affinity[t.topic_key] = t.score;
          }
        }
        sources_queried.push('user_topic_profile');
      }
    } catch {
      // This table may not exist in all environments — non-fatal.
    }

    // past_purchases (exclude re-recommendation)
    if (opts.include_past_purchases !== false) {
      try {
        const { data: orders } = await supabase
          .from('product_orders')
          .select('product_id, purchased_at, state')
          .eq('user_id', user_id)
          .eq('state', 'converted')
          .order('purchased_at', { ascending: false })
          .limit(50);
        if (orders) {
          const seen = new Set<string>();
          for (const o of orders) {
            if (!o.product_id) continue;
            const reordered = seen.has(o.product_id);
            seen.add(o.product_id);
            ctx.past_purchases.push({
              product_id: o.product_id,
              purchased_at: o.purchased_at,
              reordered,
            });
          }
          sources_queried.push('product_orders');
        }
      } catch {
        // non-fatal
      }
    }

    // VTID-02100: wearable 7-day rollup
    if (opts.include_wearable !== false) {
      try {
        const { data: rollup } = await supabase
          .from('wearable_rollup_7d')
          .select('sleep_avg_minutes, sleep_deep_pct, hrv_avg_ms, resting_hr, activity_minutes, workout_count, days_with_data, latest_date')
          .eq('user_id', user_id)
          .maybeSingle();
        if (rollup && rollup.days_with_data && rollup.days_with_data > 0) {
          ctx.wearable_summary_7d = {
            sleep_avg_minutes: rollup.sleep_avg_minutes,
            sleep_deep_pct: rollup.sleep_deep_pct,
            hrv_avg_ms: rollup.hrv_avg_ms,
            resting_hr: rollup.resting_hr,
            activity_minutes: rollup.activity_minutes,
            workout_count: rollup.workout_count,
          };
          sources_queried.push('wearable_rollup_7d');
        }
      } catch {
        // non-fatal
      }
    }

    // calendar — upcoming relevant events (next 21 days)
    if (opts.include_calendar !== false) {
      try {
        const nowIso = new Date().toISOString();
        const horizonIso = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString();
        const { data: events } = await supabase
          .from('calendar_events')
          .select('title, start_time, event_type, wellness_tags')
          .eq('user_id', user_id)
          .gte('start_time', nowIso)
          .lte('start_time', horizonIso)
          .order('start_time', { ascending: true })
          .limit(10);
        if (events) {
          for (const e of events) {
            ctx.upcoming_events.push({
              start: e.start_time,
              event_type: e.event_type ?? 'personal',
              shifts_recommendations: Array.isArray(e.wellness_tags) ? e.wellness_tags : [],
              title: e.title,
            });
          }
          sources_queried.push('calendar_events');
        }
      } catch {
        // calendar may not exist in all envs — non-fatal
      }
    }
  }

  ctx.sources_queried = sources_queried;
  ctx.stale = stale;

  CACHE.set(user_id, { ctx, expiresAt: Date.now() + CACHE_TTL_MS });
  return ctx;
}

// ==================== Condition inference helper ====================

/**
 * When the assistant doesn't explicitly specify a user_condition, infer the
 * single most relevant one from the context. Used by the marketplace-analyzer
 * and search endpoint.
 *
 * Priority:
 *   1. Most recent user_stated condition with source='user_stated'.
 *   2. Any condition present in active_conditions.
 *   3. Signal-derived (wearable) — e.g. low sleep average -> 'insomnia'.
 *   4. Null if nothing pops out.
 */
export function inferPrimaryCondition(ctx: UserHealthContext): string | null {
  // Prefer user-stated condition
  const userStated = ctx.active_conditions.find((c) => c.source === 'user_stated');
  if (userStated) return userStated.key;

  // Any active condition
  if (ctx.active_conditions.length > 0) return ctx.active_conditions[0].key;

  // Wearable-derived (Phase 1+)
  const w = ctx.wearable_summary_7d;
  if (w?.sleep_avg_minutes !== undefined && w.sleep_avg_minutes !== null && w.sleep_avg_minutes < 360) {
    return 'insomnia';
  }
  if (w?.hrv_avg_ms !== undefined && w.hrv_avg_ms !== null && w.hrv_avg_ms < 40) {
    return 'low-hrv';
  }

  // Upcoming travel -> jet-lag
  const travelSoon = ctx.upcoming_events.find((e) =>
    e.shifts_recommendations.some((t) => t === 'travel' || t === 'jet-lag')
  );
  if (travelSoon) return 'jet-lag';

  return null;
}
