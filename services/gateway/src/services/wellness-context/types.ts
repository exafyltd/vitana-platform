/**
 * VTID-05165 (Health Hub Phase 1 / C2) — the wellness AI context: types.
 *
 * The wellness context is the ONLY sanctioned path for Health Hub data into
 * AI (program §3.5). Its purposes are a closed union with no commerce member,
 * and its facts are a closed union taken 1:1 from the program §2 pattern
 * catalogue. Nothing outside this union can ever reach a prompt through it.
 */

import type { HealthConsentCategoryKey } from '../consent/health-consent';
import type { GatewayLocale } from '../../i18n/catalog';

export const WELLNESS_CONTEXT_VTID = 'VTID-05165';

/** Closed: there is deliberately no commerce, marketplace or ranking purpose. */
export const WELLNESS_PURPOSES = ['wellness_chat', 'wellness_recommendation'] as const;
export type WellnessPurpose = (typeof WELLNESS_PURPOSES)[number];

export function isWellnessPurpose(value: unknown): value is WellnessPurpose {
  return typeof value === 'string' && (WELLNESS_PURPOSES as readonly string[]).includes(value);
}

/** Closed, 1:1 with the program §2 pattern catalogue. */
export const WELLNESS_FACT_KINDS = [
  'sleep_duration_vs_baseline',
  'sleep_regularity',
  'activity_volume',
  'activity_streak',
  'recovery_trend',
  'weight_trend',
  'logged_habit',
] as const;
export type WellnessFactKind = (typeof WELLNESS_FACT_KINDS)[number];

export function isWellnessFactKind(value: unknown): value is WellnessFactKind {
  return typeof value === 'string' && (WELLNESS_FACT_KINDS as readonly string[]).includes(value);
}

export type WellnessFactCategory = 'sleep' | 'activity' | 'heart' | 'body' | 'habits';

/**
 * The data category of each fact kind and the D10 consent key the fact needs
 * on at least one source (S7). The four Health Sync categories use their
 * `sync_<category>` key; self-logged habits use `self_logged_health`.
 */
export const WELLNESS_FACT_CONSENT: Readonly<Record<WellnessFactKind, { category: WellnessFactCategory; key: HealthConsentCategoryKey }>> =
  Object.freeze({
    sleep_duration_vs_baseline: { category: 'sleep', key: 'sync_sleep' },
    sleep_regularity: { category: 'sleep', key: 'sync_sleep' },
    activity_volume: { category: 'activity', key: 'sync_activity' },
    activity_streak: { category: 'activity', key: 'sync_activity' },
    recovery_trend: { category: 'heart', key: 'sync_heart' },
    weight_trend: { category: 'body', key: 'sync_body' },
    logged_habit: { category: 'habits', key: 'self_logged_health' },
  });

/**
 * The fact kinds C2 computes. The others are typed and return nothing until
 * the Phase 1 feature layer and Phase 4 implement them.
 */
export const IMPLEMENTED_FACT_KINDS: readonly WellnessFactKind[] = Object.freeze(['sleep_duration_vs_baseline', 'activity_volume']);

export type WellnessDirection = 'higher' | 'lower' | 'stable';

/** One pattern fact: the member's recent window compared with their OWN baseline. No condition, no risk, no alert. */
export interface WellnessFact {
  kind: WellnessFactKind;
  category: WellnessFactCategory;
  /** Catalogue code (S2) the fact was computed from. */
  code: string;
  unit: string;
  direction: WellnessDirection;
  recent_mean: number;
  baseline_mean: number;
  /** (recent - baseline) / baseline, rounded to whole percent. */
  change_pct: number;
  recent_days: number;
  baseline_days: number;
  /** Local dates (inclusive) of the recent window and the baseline window. */
  recent_window: { from: string; to: string };
  baseline_window: { from: string; to: string };
}

export type WellnessContextStatus = 'disabled' | 'consent_required' | 'empty' | 'ok';

export interface WellnessContext {
  status: WellnessContextStatus;
  locale: GatewayLocale;
  facts: WellnessFact[];
}
