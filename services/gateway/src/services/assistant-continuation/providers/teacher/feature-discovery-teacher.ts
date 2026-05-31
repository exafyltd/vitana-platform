/**
 * VTID-03093 (Teacher PR 3) — Feature Discovery Coach ("the Teacher").
 *
 * The Teacher is a separate role from the Guide (next-action composer).
 *
 *   Guide  → picks the user's ONE most-actionable next move (reminder,
 *            calendar, autopilot, match, ...). Wins when there is real
 *            actionable data.
 *
 *   Teacher → picks ONE unexplored Vitanaland / Maxina capability and
 *            asks permission to introduce it. Wins when the Guide has
 *            nothing concrete AND the user has unexplored capabilities
 *            AND cadence allows.
 *
 *   Default → silence (when both above suppress).
 *
 * The Teacher renders its spoken first turn as TWO clauses concatenated:
 *
 *   [greeting clause]  +  [invitation clause]
 *
 * The greeting clause is name-aware ("Schön, dich wieder zu hören,
 * Dragan."). The invitation clause asks permission ("Darf ich dir den
 * Life Compass vorstellen?"). Both clauses are picked from pure pools
 * in `teacher-greeting-pool.ts` + `teacher-invitation-pool.ts`.
 *
 * Hard rules (carried forward from the user's spec):
 *   - NEVER list features. ONE capability at a time.
 *   - NEVER hardcode "How can I help you?" / "Wie kann ich dir helfen?".
 *   - NEVER paste manual content into the prompt. The intro line is in
 *     the catalog; the agent navigates the user to `manual_path` on
 *     accept.
 *   - Suppress when greetingPolicy === 'skip' (B1 cadence wins).
 *   - Suppress when there are no unexplored capabilities left
 *     (all_capabilities_mastered).
 *   - Selection is READ-ONLY. State advancement (introduced / dismissed)
 *     lives in PR 4 via `advance_capability_awareness` RPC.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AssistantContinuation,
  ContinuationProvider,
  ContinuationDecisionContext,
  ProviderResult,
} from '../../types';
import type { GreetingPolicy } from '../../../../orb/live/instruction/greeting-policy';
// VTID-03218 (R3): bundled Teacher Mode content type. Type-only import —
// erased at compile, so it does NOT create a runtime cycle with the
// resolver (which imports pickCapability from this file at runtime). The
// resolver itself is dynamically imported inside produce() for the same
// reason.
import type { TeacherModeContent } from '../../../../orb/teacher/teacher-content-resolver';

/**
 * VTID-03218: a Teacher candidate carries its resolved Teacher Mode content
 * inline. The base AssistantContinuation stays teacher-agnostic; only the
 * teacher provider + its consumers know about this field (read via cast).
 */
export type TeacherContinuation = AssistantContinuation & {
  teacherMode: TeacherModeContent;
};
import {
  pickTeacherGreeting,
  pickTeacherGreetingMeta,
  listTeacherGreetings,
} from './teacher-greeting-pool';
import {
  pickTeacherInvitation,
  pickTeacherInvitationMeta,
  listTeacherInvitations,
} from './teacher-invitation-pool';

// ---------------------------------------------------------------------------
// Inputs — caller forwards via ctx.extra.teacher
// ---------------------------------------------------------------------------

export const TEACHER_EXTRA_KEY = 'teacher' as const;
export const TEACHER_PROVIDER_KEY = 'feature_discovery_teacher' as const;

// VTID-03096 (Teacher priority bump): Teacher → 85, voice_wake_brief
// stays at 80. The Teacher OWNS the spoken first turn whenever there
// is an unexplored capability for this user. voice_wake_brief becomes
// the pure fallback for the all-mastered / catalog-empty / suppressed
// case.
//
// Lower than the urgent next-action bands (95+ reminder) so a
// time-sensitive reminder still pre-empts the Teacher. Above the
// generic wake-brief greeting because the user's product philosophy
// is: teach first, greet-only when there is nothing to teach.
const DEFAULT_PRIORITY = 85;

const DEFAULT_LOOKBACK_INTRODUCED_DAYS = 7;
const MAX_DISMISS_BEFORE_PERMANENT = 3;

export interface TeacherInputs {
  /** Supabase service-role client. Required — DB-backed selection. */
  supabase: SupabaseClient;
  /** Tenant + user identity. Anonymous sessions can't run the Teacher. */
  tenantId: string;
  userId: string;
  /** Resolved language for the spoken line. Falls back to 'en'. */
  lang: string;
  /** User's first name when known (from identity facts). */
  firstName?: string | null;
  /** B1 greeting policy. Used (with `skipReason`) only to detect the
   *  isReconnect-class forced skips; cadence-class skips no longer
   *  suppress the Teacher (VTID-03108 Item 2). */
  greetingPolicy: GreetingPolicy;
  /**
   * VTID-03108: the explicit reason emitted by `decideGreetingPolicy*`
   * when `greetingPolicy === 'skip'`. Forwarded from
   * `decideGreetingPolicyWithEvidence().reason` via the wake-brief
   * wiring. Used to distinguish "user is mid-reconnect, do nothing"
   * (forced skip) from "user just greeted within the 15-min window"
   * (cadence skip — Teacher should still fire on a *different*
   * capability). Optional + undefined when policy is non-skip.
   */
  skipReason?: string | null;
  /** ISO 8601 server-side now. Used for the introduced-within-N-days
   *  filter so a candidate isn't re-introduced too soon. */
  nowIso?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export interface CapabilityCatalogRow {
  capability_key: string;
  display_name: string;
  description: string;
  manual_path: string | null;
  enabled: boolean;
  // VTID-03108 (Item 3): pedagogical order from `system_capabilities`.
  // Lower = earlier in the Teacher curriculum (Five Pillars before
  // marketplace). NULL means "no preference; alphabetical tie-break".
  // Read straight from the DB column — no hardcoded sequence in TS.
  pedagogical_order?: number | null;
}

export interface AwarenessLedgerRow {
  capability_key: string;
  awareness_state: string;
  dismiss_count: number;
  last_introduced_at: string | null;
}

export interface PickedCapability {
  row: CapabilityCatalogRow;
  /** Current awareness state from the ledger, or 'unknown' when no row exists. */
  awarenessState: string;
}

/**
 * Filter + rank rule (deterministic, pure):
 *   1. Drop disabled rows.
 *   2. Drop rows whose ledger state ∈ {tried, completed, mastered, dismissed}
 *      UNLESS the dismiss_count is exactly 1 AND the row hasn't been
 *      reintroduced in 30 days (gentle re-offer after long absence).
 *   3. Drop rows that have been introduced within the last
 *      DEFAULT_LOOKBACK_INTRODUCED_DAYS days (avoid back-to-back
 *      repetition).
 *   4. Drop rows with dismiss_count >= MAX_DISMISS_BEFORE_PERMANENT
 *      (3 strikes — permanent for this user).
 *   5. Sort eligibles by:
 *      a) Never-introduced first (awareness_state === 'unknown')
 *      b) Then oldest last_introduced_at first
 *      c) Then dismiss_count ascending (lower is preferred)
 *      d) Then capability_key alphabetical (deterministic tie-break)
 *   6. Pick top 1.
 */
export function pickCapability(
  catalog: CapabilityCatalogRow[],
  ledger: AwarenessLedgerRow[],
  nowIso: string,
): PickedCapability | null {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return null;
  const lookbackMs = nowMs - DEFAULT_LOOKBACK_INTRODUCED_DAYS * 24 * 60 * 60 * 1000;
  const reintroduceAfterMs = nowMs - 30 * 24 * 60 * 60 * 1000;

  const ledgerByKey = new Map<string, AwarenessLedgerRow>();
  for (const row of ledger) ledgerByKey.set(row.capability_key, row);

  const eligible: PickedCapability[] = [];
  for (const cap of catalog) {
    if (!cap.enabled) continue;
    const lr = ledgerByKey.get(cap.capability_key);
    const state = lr?.awareness_state ?? 'unknown';
    const dismissCount = lr?.dismiss_count ?? 0;
    const lastIntroducedAt = lr?.last_introduced_at
      ? Date.parse(lr.last_introduced_at)
      : null;

    // 4. Permanent strike-out
    if (dismissCount >= MAX_DISMISS_BEFORE_PERMANENT) continue;

    // 2. Terminal / progressed states
    if (state === 'tried' || state === 'completed' || state === 'mastered') {
      continue;
    }
    if (state === 'dismissed') {
      // Gentle re-offer after 30 days iff this is the only dismissal
      if (dismissCount !== 1) continue;
      if (lastIntroducedAt === null) continue;
      if (lastIntroducedAt > reintroduceAfterMs) continue;
    }

    // 3. Recent-introduction guard
    if (
      lastIntroducedAt !== null &&
      Number.isFinite(lastIntroducedAt) &&
      lastIntroducedAt > lookbackMs
    ) {
      continue;
    }

    eligible.push({ row: cap, awarenessState: state });
  }

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    // 5a. Never-introduced first
    const aNever = a.awarenessState === 'unknown' ? 0 : 1;
    const bNever = b.awarenessState === 'unknown' ? 0 : 1;
    if (aNever !== bNever) return aNever - bNever;

    // VTID-03108 (Item 3) — 5b. Pedagogical order from system_capabilities.
    // NULL sorts LAST (treated as +Infinity) so a capability without an
    // explicit order doesn't outrank a curriculum-ranked one. Drives the
    // first-time-user curriculum: foundations (Five Pillars, Vitana ID,
    // Daily Loop) before community (matches, marketplace, autopilot).
    // The order lives in the DB column — operators tune live without
    // a code deploy. No hardcoded sequence in TS.
    const aOrder = typeof a.row.pedagogical_order === 'number' ? a.row.pedagogical_order : Number.POSITIVE_INFINITY;
    const bOrder = typeof b.row.pedagogical_order === 'number' ? b.row.pedagogical_order : Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) return aOrder - bOrder;

    // 5c. Oldest last_introduced_at first (kicks in for reintroduction
    // candidates, since unknown rows have null last_introduced_at).
    const al = ledgerByKey.get(a.row.capability_key)?.last_introduced_at ?? null;
    const bl = ledgerByKey.get(b.row.capability_key)?.last_introduced_at ?? null;
    const aMs = al ? Date.parse(al) : -Infinity;
    const bMs = bl ? Date.parse(bl) : -Infinity;
    if (aMs !== bMs) return aMs - bMs;

    // 5d. Lower dismiss_count
    const ad = ledgerByKey.get(a.row.capability_key)?.dismiss_count ?? 0;
    const bd = ledgerByKey.get(b.row.capability_key)?.dismiss_count ?? 0;
    if (ad !== bd) return ad - bd;

    // 5e. Alphabetical tie-break (deterministic last resort).
    return a.row.capability_key.localeCompare(b.row.capability_key);
  });

  return eligible[0];
}

/**
 * Render the full two-clause first utterance from a picked capability.
 * Pure function — caller supplies RNG so tests can pin the output.
 */
export function renderTeacherLine(args: {
  greeting: string;
  invitation: string;
}): string {
  // VTID-03123: greeting may be empty (cadence-class skip — rapid re-tap).
  // In that case the rendered line is just the invitation, no leading
  // space or stale "Welcome back".
  const g = args.greeting.trim();
  const inv = args.invitation.trim();
  return g.length > 0 ? `${g} ${inv}` : inv;
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export interface TeacherProviderOptions {
  /** Override priority. Default 75. */
  priority?: number;
  /** Deterministic id generator for tests. */
  newId?: () => string;
  /** Deterministic clock for tests. */
  now?: () => number;
  /** Deterministic RNG for pool picks (greeting + invitation). */
  rng?: () => number;
}

/**
 * Build the Teacher provider. Factory pattern matches voice-wake-brief
 * for consistency: production wiring registers ONE instance; tests
 * build their own with deterministic deps.
 */
export function makeFeatureDiscoveryTeacherProvider(
  opts: TeacherProviderOptions = {},
): ContinuationProvider {
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? DEFAULT_PRIORITY;
  const rng = opts.rng ?? Math.random;

  return {
    key: TEACHER_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = now();
      const inputs = readInputs(ctx);
      if (!inputs) {
        return {
          providerKey: TEACHER_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_teacher_inputs',
        };
      }

      // VTID-03108 (Item 2): Teacher is no longer B1-cadence-gated.
      // The Teacher is the predominant first-utterance authority for the
      // community education phase — its job is to introduce ONE capability,
      // not to greet. B1 cadence is a *greeting* policy and only applies
      // to the bare voice-wake-brief fallback. The Teacher's own 4h
      // per-capability cross-session dedupe (via `dedupeKey =
      // teacher:<capability_key>`) is the cadence brake that prevents
      // re-offering the same capability twice; that gate is intact and
      // applies regardless of greetingPolicy. So a re-tap during a B1
      // skip window now still gets a teaching offer — just for a
      // *different* capability than the previous one (or none, when the
      // user has exhausted the eligible catalog).
      //
      // The only forced skips that remain valid are isReconnect-class
      // forced skips (transparent reconnect, bucket=reconnect): those
      // mean "the previous turn is technically still alive, do not
      // produce a new opener". Keep that one branch.
      if (
        inputs.greetingPolicy === 'skip'
        && (inputs.skipReason === 'isReconnect_forces_skip'
          || inputs.skipReason === 'transparent_reconnect_forces_skip'
          || inputs.skipReason === 'bucket_reconnect_forces_skip')
      ) {
        return {
          providerKey: TEACHER_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: `forced_skip_${inputs.skipReason}`,
        };
      }

      // ---- DB fetch: catalog + ledger ----
      let catalog: CapabilityCatalogRow[];
      let ledger: AwarenessLedgerRow[];
      try {
        const cap = await inputs.supabase
          .from('system_capabilities')
          .select('capability_key, display_name, description, manual_path, enabled, pedagogical_order')
          .eq('enabled', true);
        if (cap.error) {
          return {
            providerKey: TEACHER_PROVIDER_KEY,
            status: 'errored',
            latencyMs: Math.max(0, now() - t0),
            reason: `catalog_fetch_failed: ${cap.error.message}`,
          };
        }
        catalog = (cap.data || []) as CapabilityCatalogRow[];

        const led = await inputs.supabase
          .from('user_capability_awareness')
          .select('capability_key, awareness_state, dismiss_count, last_introduced_at')
          .eq('tenant_id', inputs.tenantId)
          .eq('user_id', inputs.userId);
        if (led.error) {
          // Ledger fetch failures degrade to empty ledger — every capability
          // is treated as 'unknown'. Better than silencing the Teacher.
          ledger = [];
        } else {
          ledger = (led.data || []) as AwarenessLedgerRow[];
        }
      } catch (err) {
        return {
          providerKey: TEACHER_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      if (catalog.length === 0) {
        // Catalog empty — migrations not applied, or every row disabled.
        // Treat as "nothing to teach right now"; Guide / wake-brief decide.
        return {
          providerKey: TEACHER_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'empty_catalog',
        };
      }

      const nowIso = inputs.nowIso ?? new Date().toISOString();
      const picked = pickCapability(catalog, ledger, nowIso);
      if (!picked) {
        return {
          providerKey: TEACHER_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'all_capabilities_known_or_dismissed',
        };
      }

      // ---- Render the two-clause line ----
      // VTID-03123: pass the B1 greetingPolicy so the greeting clause is
      // SUPPRESSED on cadence-class skips (rapid re-tap, greet-once
      // window). The invitation always fires — the Teacher's offer is
      // its purpose — but a 5-second re-tap should not produce
      // "Welcome back, Dragan."
      const greetingPick = pickTeacherGreetingMeta({
        lang: inputs.lang,
        firstName: inputs.firstName ?? null,
        rng,
        greetingPolicy: inputs.greetingPolicy,
      });
      // For the FIRST introduction we keep the invitation abstract
      // (no featureLabel) — Vitana asks "may I show you something?"
      // and only names the capability AFTER the user accepts. This
      // matches the user's spec ("Darf ich dir kurz etwas zeigen?").
      // A future tuning slice can flip this rule per-capability.
      const invitationPick = pickTeacherInvitationMeta({
        lang: inputs.lang,
        featureLabel: null,
        rng,
      });
      const userFacingLine = renderTeacherLine({
        greeting: greetingPick.text,
        invitation: invitationPick.text,
      });

      // VTID-03105: per-pick diagnostic log. Production grep on this
      // prefix lets us confirm whether Math.random IS actually rotating
      // across sessions, or whether the picker pins to one entry. Each
      // line carries: rendered text + idx within (post-filter) pool +
      // pool size + capability_key + lang. NO PII — first name is logged
      // as length only.
      console.log(
        `[VTID-03105 TEACHER-PICK] tenant=${inputs.tenantId} user=${inputs.userId.slice(0, 8)} lang=${inputs.lang} `
        + `capability=${picked.row.capability_key} `
        + `greeting_idx=${greetingPick.idx}/${greetingPick.poolSize} `
        + `invitation_idx=${invitationPick.idx}/${invitationPick.poolSize} `
        + `firstname_len=${(inputs.firstName ?? '').trim().length} `
        + `greeting_raw="${greetingPick.rawTemplate.replace(/"/g, '\\"')}" `
        + `invitation_raw="${invitationPick.rawTemplate.replace(/"/g, '\\"')}" `
        + `rendered="${userFacingLine.replace(/"/g, '\\"').slice(0, 240)}"`,
      );

      // VTID-03218 (R3): resolve Teacher Mode content ATOMICALLY here so the
      // candidate carries BOTH the permission line AND the turn-2+ content as
      // one unit. Previously the controller resolved content in a separate
      // post-win fetch; if that failed, the permission line still fired with
      // no content and the LLM closed the overlay the moment the user said
      // yes. Now: if content can't be resolved, the provider returns
      // 'errored' and the ranker falls through to voice_wake_brief — the
      // Teacher never fires without content. Dynamic import avoids the
      // runtime cycle (resolver imports pickCapability from this file).
      let teacherMode: TeacherModeContent | null = null;
      try {
        const { resolveTeacherModeContent } = await import(
          '../../../../orb/teacher/teacher-content-resolver'
        );
        teacherMode = await resolveTeacherModeContent({
          supabase: inputs.supabase,
          tenantId: inputs.tenantId,
          userId: inputs.userId,
          activeCapabilityKey: picked.row.capability_key,
          lang: inputs.lang,
          nowIso: inputs.nowIso ?? undefined,
        });
      } catch (err) {
        return {
          providerKey: TEACHER_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: `teacher_content_resolution_failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      if (!teacherMode || !teacherMode.active_capability_key) {
        return {
          providerKey: TEACHER_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: 'teacher_content_resolution_failed',
        };
      }

      const candidate: TeacherContinuation = {
        id: `teacher-${newId()}`,
        surface: 'orb_wake',
        kind: 'feature_discovery',
        priority,
        userFacingLine,
        // VTID-03218: bundled content — the controller reads this off the
        // winning candidate instead of doing its own resolver call.
        teacherMode,
        cta: {
          type: 'offer_demo',
          payload: {
            capability_key: picked.row.capability_key,
            manual_path: picked.row.manual_path ?? null,
            display_name: picked.row.display_name,
          },
        },
        evidence: [
          {
            kind: 'capability:eligible',
            detail: picked.row.capability_key,
          },
          {
            kind: 'awareness_state',
            detail: picked.awarenessState,
          },
          {
            kind: 'catalog_size',
            detail: String(catalog.length),
          },
        ],
        dedupeKey: `teacher:${picked.row.capability_key}`,
        privacyMode: 'safe_to_speak',
      };

      return {
        providerKey: TEACHER_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}

function readInputs(ctx: ContinuationDecisionContext): TeacherInputs | null {
  const extra = ctx.extra;
  if (!extra || typeof extra !== 'object') return null;
  const raw = (extra as Record<string, unknown>)[TEACHER_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const supabase = obj.supabase;
  if (
    !supabase ||
    typeof supabase !== 'object' ||
    typeof (supabase as Record<string, unknown>).from !== 'function'
  ) {
    return null;
  }
  if (typeof obj.tenantId !== 'string' || !obj.tenantId) return null;
  if (typeof obj.userId !== 'string' || !obj.userId) return null;
  const gp = obj.greetingPolicy;
  if (
    gp !== 'skip' &&
    gp !== 'brief_resume' &&
    gp !== 'warm_return' &&
    gp !== 'fresh_intro'
  ) {
    return null;
  }
  return {
    supabase: supabase as SupabaseClient,
    tenantId: obj.tenantId,
    userId: obj.userId,
    lang: typeof obj.lang === 'string' && obj.lang ? obj.lang : 'en',
    firstName:
      typeof obj.firstName === 'string' && obj.firstName.trim().length > 0
        ? obj.firstName
        : null,
    greetingPolicy: gp,
    skipReason:
      typeof obj.skipReason === 'string' && obj.skipReason.length > 0
        ? obj.skipReason
        : null,
    nowIso: typeof obj.nowIso === 'string' && obj.nowIso ? obj.nowIso : undefined,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for the Command Hub "Teach Vitanaland" panel (PR 5)
// ---------------------------------------------------------------------------
export {
  listTeacherGreetings,
  listTeacherInvitations,
  pickTeacherGreeting,
  pickTeacherInvitation,
};
