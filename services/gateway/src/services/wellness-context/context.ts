/**
 * VTID-05165 (Health Hub Phase 1 / C2) — buildWellnessContext: the ONLY
 * sanctioned path for Health Hub data into AI (program §3.5).
 *
 *   buildWellnessContext(sb, identity, { purpose })
 *     -> { status: 'disabled'|'consent_required'|'empty'|'ok', locale, facts[] }
 *
 * Order (nothing is cached, so a withdrawn consent is honoured at the next call):
 *   1. dark gate: WELLNESS_CONTEXT_ENABLED === 'true' and VITANA_ENV !== 'staging'
 *      (staging shares the production database) -> otherwise 'disabled';
 *      a purpose outside the closed union (there is no commerce purpose) or a
 *      missing identity is 'disabled' too. Nothing is read.
 *   2. `ai_health_analysis` through hasHealthConsent, fail closed ->
 *      'consent_required'; A's read port is not called.
 *   3. per fact: the matching `sync_<category>` consent on at least one Health
 *      Sync source (HEALTH_SYNC_SOURCE_KINDS), fail closed. A category without
 *      it is not read at all.
 *   4. one read through A's S4 port readDailyObservations with
 *      purpose:'ai_context' (A re-checks ai_health_analysis, I5). Until A's
 *      store is live the port answers STORE_DISABLED / STORE_PENDING or empty
 *      rows -> 'empty', never a throw.
 *   5. the implemented comparisons (comparisons.ts) -> facts. No fact -> 'empty'.
 *
 * The locale comes from getUserLocale (F12) and is carried on the result so
 * buildWellnessSystemPrompt can always wrap the prompt with it.
 *
 * Never throws. No model call, no consumer is wired in C2 (Phase 4 consumers
 * call Claude through the Bedrock router only). Commerce modules may not
 * import this module (vtid-05025 + wellness-context-boundary tests).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { GATEWAY_DEFAULT_LOCALE, type GatewayLocale } from '../../i18n/catalog';
import { getUserLocale } from '../../i18n/server-locale';
import { hasHealthConsent, HEALTH_SYNC_SOURCE_KINDS, type HealthConsentCategoryKey } from '../consent/health-consent';
import { readDailyObservations, type ReadDailyObservationsOptions, type ReadDailyObservationsResult } from '../health-store/reader';
import { activityVolume, BASELINE_WINDOW_DAYS, shiftDate, sleepDurationVsBaseline, ACTIVITY_VOLUME_CODE, SLEEP_DURATION_CODE, type DailyValueRow } from './comparisons';
import {
  IMPLEMENTED_FACT_KINDS,
  isWellnessPurpose,
  WELLNESS_FACT_CONSENT,
  type WellnessContext,
  type WellnessFact,
  type WellnessFactKind,
  type WellnessPurpose,
} from './types';

export interface WellnessIdentity {
  tenant_id: string;
  user_id: string;
}

export interface WellnessContextDeps {
  enabled: () => boolean;
  hasConsent: (identity: WellnessIdentity, key: HealthConsentCategoryKey, resourceId?: string | null) => Promise<boolean>;
  readDailyObservations: (identity: WellnessIdentity, opts: ReadDailyObservationsOptions) => Promise<ReadDailyObservationsResult>;
  getLocale: (userId: string) => Promise<GatewayLocale>;
  now: () => Date;
}

/** Dark by default; always off on staging, whatever the flag says. */
export function isWellnessContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WELLNESS_CONTEXT_ENABLED === 'true' && env.VITANA_ENV !== 'staging';
}

/** The code each implemented fact reads and the function computing it. */
const IMPLEMENTED: Readonly<Partial<Record<WellnessFactKind, { code: string; compute: (rows: DailyValueRow[], asOf: string) => WellnessFact | null }>>> =
  Object.freeze({
    sleep_duration_vs_baseline: { code: SLEEP_DURATION_CODE, compute: sleepDurationVsBaseline },
    activity_volume: { code: ACTIVITY_VOLUME_CODE, compute: activityVolume },
  });

function validIdentity(i: WellnessIdentity | null | undefined): i is WellnessIdentity {
  return !!i && typeof i.tenant_id === 'string' && i.tenant_id.length > 0 && typeof i.user_id === 'string' && i.user_id.length > 0;
}

async function safeConsent(deps: WellnessContextDeps, identity: WellnessIdentity, key: HealthConsentCategoryKey, resource?: string): Promise<boolean> {
  try {
    return (await deps.hasConsent(identity, key, resource)) === true;
  } catch {
    return false;
  }
}

/** True when the member holds `key` on at least one Health Sync source. */
async function consentOnAnySource(deps: WellnessContextDeps, identity: WellnessIdentity, key: HealthConsentCategoryKey): Promise<boolean> {
  for (const source of HEALTH_SYNC_SOURCE_KINDS) {
    if (await safeConsent(deps, identity, key, source)) return true;
  }
  return false;
}

async function safeLocale(deps: WellnessContextDeps, userId: string): Promise<GatewayLocale> {
  try {
    return (await deps.getLocale(userId)) || GATEWAY_DEFAULT_LOCALE;
  } catch {
    return GATEWAY_DEFAULT_LOCALE;
  }
}

/** The last complete UTC day before `now`. */
function referenceDate(now: Date): string {
  return shiftDate(now.toISOString().slice(0, 10), -1);
}

export async function buildWellnessContextWith(
  deps: WellnessContextDeps,
  identity: WellnessIdentity,
  opts: { purpose: WellnessPurpose },
): Promise<WellnessContext> {
  const disabled: WellnessContext = { status: 'disabled', locale: GATEWAY_DEFAULT_LOCALE, facts: [] };
  try {
    if (!deps.enabled()) return disabled;
    if (!isWellnessPurpose(opts?.purpose)) return disabled;
    if (!validIdentity(identity)) return disabled;

    const locale = await safeLocale(deps, identity.user_id);
    if (!(await safeConsent(deps, identity, 'ai_health_analysis'))) return { status: 'consent_required', locale, facts: [] };

    // Per fact: the matching category consent on at least one source; one check per key.
    const grantedByKey = new Map<HealthConsentCategoryKey, boolean>();
    const kinds: WellnessFactKind[] = [];
    for (const kind of IMPLEMENTED_FACT_KINDS) {
      const { key } = WELLNESS_FACT_CONSENT[kind];
      if (!grantedByKey.has(key)) grantedByKey.set(key, await consentOnAnySource(deps, identity, key));
      if (grantedByKey.get(key) && IMPLEMENTED[kind]) kinds.push(kind);
    }
    if (kinds.length === 0) return { status: 'empty', locale, facts: [] };

    const asOf = referenceDate(deps.now());
    const codes = [...new Set(kinds.map((k) => IMPLEMENTED[k]!.code))];
    const read = await deps.readDailyObservations(identity, {
      codes,
      from: shiftDate(asOf, -(BASELINE_WINDOW_DAYS - 1)),
      to: asOf,
      purpose: 'ai_context',
    });
    if (!read || read.ok !== true) {
      return { status: read && read.ok === false && read.code === 'consent_required' ? 'consent_required' : 'empty', locale, facts: [] };
    }
    const rows: DailyValueRow[] = Array.isArray(read.rows) ? read.rows : [];
    const facts: WellnessFact[] = [];
    for (const kind of kinds) {
      const fact = IMPLEMENTED[kind]!.compute(rows, asOf);
      if (fact) facts.push(fact);
    }
    return { status: facts.length > 0 ? 'ok' : 'empty', locale, facts };
  } catch {
    return { status: 'empty', locale: GATEWAY_DEFAULT_LOCALE, facts: [] };
  }
}

export function defaultWellnessContextDeps(sb: SupabaseClient): WellnessContextDeps {
  return {
    enabled: () => isWellnessContextEnabled(),
    hasConsent: (identity, key, resourceId) => hasHealthConsent(sb, identity, key, resourceId),
    readDailyObservations: (identity, o) => readDailyObservations(sb, identity, o),
    getLocale: (userId) => getUserLocale(sb, userId),
    now: () => new Date(),
  };
}

export function buildWellnessContext(sb: SupabaseClient, identity: WellnessIdentity, opts: { purpose: WellnessPurpose }): Promise<WellnessContext> {
  return buildWellnessContextWith(defaultWellnessContextDeps(sb), identity, opts);
}
