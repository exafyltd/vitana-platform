/**
 * Community Autopilot — On-Demand Regeneration (VTID-03301)
 *
 * Guarded, reusable service that refills a community user's Autopilot queue the
 * moment it empties (after complete/reject), plus an explicit force path for the
 * frontend / testing (POST /generate?role=community). It wraps
 * generatePersonalRecommendations with the guards that make "immediate"
 * regeneration safe instead of a runaway complete→generate→complete loop:
 *
 *   enabled → consent → per-user lock → cooldown → daily cap → generate
 *
 * Product decisions (locked):
 *   1. Honor the daily cap. When hit, return generated:0 + reason:'daily_cap'
 *      so the UI can show "all caught up for today" instead of looping forever.
 *   2. Trigger BOTH automatically on queue-empty AND via the explicit endpoint;
 *      the cooldown makes a double-tap idempotent.
 *
 * i18n note (CLAUDE.md §13b): the community generation path is template-based —
 * it runs the community / Life Compass / index-gap analyzers and does NOT call
 * an LLM — so the llm-locale injection rule does not apply here. If a future
 * LLM analyzer is added to this path, inject getUserLocale +
 * buildLocalizedSystemPrompt at that call site so DE users don't get English.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { generatePersonalRecommendations, type GenerationConfig } from './recommendation-generator';

const LOG_PREFIX = '[VTID-03301]';

/** Why a regeneration produced no new recommendations. */
export type RegenerationReason = 'daily_cap' | 'disabled' | 'cooldown' | 'no_signals' | 'not_empty';

export interface CommunityRegenResult {
  ok: boolean;
  generated: number;
  reason?: RegenerationReason;
  run_id?: string;
  error?: string;
}

export interface RegenerateOpts {
  /**
   * Auto-trigger sets this true: only regenerate when the user's active
   * (new + activated) queue has actually hit 0. The explicit /generate endpoint
   * leaves it false (force-refresh), relying on the cooldown for idempotency.
   */
  requireEmptyQueue?: boolean;
  /** Pre-resolved primary tenant id — saves a lookup when the caller has it. */
  tenantId?: string;
  /** Provenance recorded on the generation run. */
  trigger_type?: GenerationConfig['trigger_type'];
}

/**
 * Cooldown/debounce window. A batch created within this window suppresses a
 * fresh generation, so back-to-back completes (or a double-tapped force button)
 * can't double-generate. Overridable via env for testing.
 */
const COOLDOWN_MS = Number(process.env.AUTOPILOT_REGEN_COOLDOWN_MS) || 3 * 60 * 1000;

/**
 * Per-instance lock: serializes concurrent regenerations for the same user so
 * two completes landing in the same process don't both generate. The DB-level
 * cooldown above is the cross-instance backstop.
 */
const inFlight = new Set<string>();

/**
 * Best-effort per-user AI-data consent check. There is no dedicated Autopilot
 * consent store today (ai_consent_log is for external AI providers), so the
 * tenant `enabled` flag is the authoritative enable gate. This adds a
 * forward-compatible per-user opt-out: a memory_facts row with
 * fact_key='autopilot_opt_out' whose value is truthy suppresses regeneration.
 * Defaults to allowed (returns false) when no opt-out is recorded or on error.
 */
async function hasAutopilotOptOut(supa: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data } = await supa
      .from('memory_facts')
      .select('fact_value')
      .eq('user_id', userId)
      .eq('fact_key', 'autopilot_opt_out')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const v = (data as { fact_value?: string | null } | null)?.fact_value;
    return typeof v === 'string' && ['true', '1', 'yes'].includes(v.trim().toLowerCase());
  } catch {
    // Never block regeneration on a consent-store read error.
    return false;
  }
}

/**
 * Guarded on-demand regeneration for a community user. Never throws — returns a
 * structured result the route maps to HTTP and the auto-trigger fires-and-forgets.
 */
export async function regenerateCommunityRecommendations(
  userId: string,
  opts: RegenerateOpts = {},
): Promise<CommunityRegenResult> {
  if (!userId) return { ok: false, generated: 0, error: 'userId required' };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return { ok: false, generated: 0, error: 'Supabase not configured' };

  // Per-instance lock: a concurrent complete/reject for the same user is
  // already generating — treat as cooldown so we never double-generate.
  if (inFlight.has(userId)) {
    console.log(`${LOG_PREFIX} regen skipped (in-flight lock) for ${userId.slice(0, 8)}`);
    return { ok: true, generated: 0, reason: 'cooldown' };
  }
  inFlight.add(userId);

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supa = createClient(url, key);

    // Resolve primary tenant.
    let tenantId = opts.tenantId;
    if (!tenantId) {
      const { data: tenantRow } = await supa
        .from('user_tenants')
        .select('tenant_id')
        .eq('user_id', userId)
        .eq('is_primary', true)
        .maybeSingle();
      tenantId = (tenantRow as { tenant_id?: string } | null)?.tenant_id || undefined;
    }
    if (!tenantId) {
      console.warn(`${LOG_PREFIX} no primary tenant for ${userId.slice(0, 8)} — skipping regen`);
      return { ok: true, generated: 0, reason: 'disabled' };
    }

    // Guard: tenant Autopilot enabled (this is also the AI-data enable gate).
    const { data: settings } = await supa
      .from('tenant_autopilot_settings')
      .select('enabled, max_recommendations_per_day')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (settings && (settings as { enabled?: boolean }).enabled === false) {
      console.log(`${LOG_PREFIX} Autopilot disabled for tenant ${tenantId} — skipping regen`);
      return { ok: true, generated: 0, reason: 'disabled' };
    }
    const dailyCap = (settings as { max_recommendations_per_day?: number } | null)?.max_recommendations_per_day ?? 20;

    // Guard: per-user AI-data consent.
    if (await hasAutopilotOptOut(supa, userId)) {
      console.log(`${LOG_PREFIX} user ${userId.slice(0, 8)} opted out of Autopilot — skipping regen`);
      return { ok: true, generated: 0, reason: 'disabled' };
    }

    // Guard: queue must be empty for the auto-trigger (new + activated == 0).
    if (opts.requireEmptyQueue) {
      const { count: activeCount } = await supa
        .from('autopilot_recommendations')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .in('status', ['new', 'activated']);
      if ((activeCount ?? 0) > 0) {
        return { ok: true, generated: 0, reason: 'not_empty' };
      }
    }

    // Guard: cooldown/debounce — skip if a batch was created very recently.
    const since = new Date(Date.now() - COOLDOWN_MS).toISOString();
    const { count: recentCount } = await supa
      .from('autopilot_recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', since);
    if ((recentCount ?? 0) > 0) {
      console.log(
        `${LOG_PREFIX} cooldown active for ${userId.slice(0, 8)} ` +
        `(${recentCount} rec(s) in last ${Math.round(COOLDOWN_MS / 1000)}s)`,
      );
      return { ok: true, generated: 0, reason: 'cooldown' };
    }

    // Guard: daily cap — honor max_recommendations_per_day. Locked decision:
    // show "all caught up for today" rather than regenerate past the cap.
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const { count: todayCount } = await supa
      .from('autopilot_recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', startOfDay.toISOString());
    if ((todayCount ?? 0) >= dailyCap) {
      console.log(`${LOG_PREFIX} daily cap reached for ${userId.slice(0, 8)} (${todayCount}/${dailyCap})`);
      return { ok: true, generated: 0, reason: 'daily_cap' };
    }

    // All guards passed → generate.
    const result = await generatePersonalRecommendations(userId, tenantId, {
      trigger_type: opts.trigger_type || 'auto_replenish',
    });
    if (!result.ok) {
      return {
        ok: false,
        generated: 0,
        run_id: result.run_id,
        error: result.errors[0]?.error || 'generation failed',
      };
    }
    if (result.generated === 0) {
      // Generation ran but every candidate was a live duplicate / no fresh signals.
      return { ok: true, generated: 0, run_id: result.run_id, reason: 'no_signals' };
    }
    console.log(`${LOG_PREFIX} regenerated ${result.generated} rec(s) for ${userId.slice(0, 8)}`);
    return { ok: true, generated: result.generated, run_id: result.run_id };
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} regen failed (non-fatal) for ${userId.slice(0, 8)}: ${err?.message}`);
    return { ok: false, generated: 0, error: err?.message || String(err) };
  } finally {
    inFlight.delete(userId);
  }
}
