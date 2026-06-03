/**
 * VTID-03248 (R1, slice 1) — unified awareness context: foundation.
 *
 * The 2026-05-31 audit found ORB user-state is SCATTERED: a single session
 * fans out into 4+ independent fetches (firstName, decision spine, journey
 * greeting w/ its own app_users read, bootstrap pack), and the SAME field is
 * resolved multiple times with DIVERGENT precedence — most visibly the user's
 * first name (resolved 3-4× across Vertex + LiveKit with different source
 * order), so different prompt blocks of one session can use different names.
 *
 * R1's endpoint is ONE `buildAwarenessContext(...)` that every provider +
 * prompt assembler reads from. This file is the foundation. Slice 1 lands the
 * type + the single CANONICAL first-name resolver and migrates the two
 * already-aligned "spoken name" call sites to it (zero/▲tiny behavior change);
 * later slices fold in journey / life_compass / vitana_index / cadence and
 * migrate the remaining consumers, collapsing the duplicate fetches.
 *
 * Pure functions only here — no IO — so each transport keeps doing its own
 * fetch (for now) and passes the raw values in; the PRECEDENCE (the actual
 * drift) is unified in one tested place.
 */

/** Which source resolved the first name. Canonical precedence order below. */
export type FirstNameSource = 'memory_facts' | 'app_users' | 'email' | 'none';

export interface ResolveSpokenFirstNameInput {
  /** memory_facts.user_name — the name the user told the assistant (Cognee). */
  memoryFactUserName?: string | null;
  /** app_users.display_name — provisioned at signup. */
  displayName?: string | null;
  /** JWT email — deterministic last resort. */
  email?: string | null;
}

export interface ResolvedFirstName {
  firstName: string | null;
  source: FirstNameSource;
}

/**
 * The ONE canonical spoken-first-name resolver. Precedence:
 *   1. memory_facts.user_name  (what the user told us)
 *   2. app_users.display_name  (signup)
 *   3. email local-part        (digits/underscores stripped, capitalized)
 *
 * Reproduces the existing Vertex (live-session-controller) logic exactly so
 * migrating that call site is a no-op; LiveKit's spoken-name site gains the
 * email last-resort it lacked (a deliberate, minor improvement toward parity).
 * Pure — safe to unit-test exhaustively.
 */
export function resolveSpokenFirstName(
  input: ResolveSpokenFirstNameInput,
): ResolvedFirstName {
  let fullName = '';
  let fullNameSource: FirstNameSource = 'none';

  const fact = typeof input.memoryFactUserName === 'string' ? input.memoryFactUserName.trim() : '';
  if (fact.length > 0) {
    fullName = fact;
    fullNameSource = 'memory_facts';
  }

  if (!fullName) {
    const dn = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (dn.length > 0) {
      fullName = dn;
      fullNameSource = 'app_users';
    }
  }

  if (fullName) {
    const firstName = fullName.split(/\s+/)[0] || null;
    return { firstName, source: firstName ? fullNameSource : 'none' };
  }

  const email = typeof input.email === 'string' ? input.email : '';
  if (email && email.includes('@')) {
    const local = email.split('@')[0] || '';
    const stripped = local.replace(/[0-9_.+\-]+/g, '').trim();
    if (stripped.length >= 2) {
      return { firstName: stripped[0].toUpperCase() + stripped.slice(1), source: 'email' };
    }
  }

  return { firstName: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// VTID-03250 — session timezone resolution (location/time integrity).
//
// The ENVIRONMENT block (city + local time the assistant reads) used to derive
// the timezone ONLY from geo-IP. geo-IP rate-limits (ipapi.co HTTP 429) and
// then returns no timezone → the assistant lost the user's local time and
// hallucinated (e.g. "Berlin, 8:30 PM" when the user was in Cologne at 15:44).
// The browser KNOWS its IANA timezone reliably (Intl) — prefer it; geo-IP is
// only the fallback. This makes the spoken local time correct even when the
// geo provider is unavailable.
// ---------------------------------------------------------------------------

/** True iff `tz` is a usable IANA timezone (Intl validates it). */
export function isValidIanaTimezone(tz: string | null | undefined): boolean {
  if (typeof tz !== 'string' || tz.trim().length === 0) return false;
  try {
    // Throws RangeError on an unknown zone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export interface ResolveSessionTimezoneInput {
  /** The browser's own IANA zone (Intl), sent in the session-start body. */
  clientTimezone?: string | null;
  /** The geo-IP-derived zone (rate-limit-prone). */
  geoTimezone?: string | null;
}

/**
 * Canonical session timezone: prefer the client/browser zone, fall back to
 * geo-IP, else null. Invalid client zones fall through to geo. Pure.
 */
export function resolveSessionTimezone(input: ResolveSessionTimezoneInput): string | null {
  const client = typeof input.clientTimezone === 'string' ? input.clientTimezone.trim() : '';
  if (client && isValidIanaTimezone(client)) return client;
  const geo = typeof input.geoTimezone === 'string' ? input.geoTimezone.trim() : '';
  if (geo && isValidIanaTimezone(geo)) return geo;
  if (geo) return geo; // tolerate a geo zone Intl can't validate in this runtime
  return null;
}

// ---------------------------------------------------------------------------
// R1 slice 2 — life_compass state + journey plan_phase resolvers.
//
// ADDITIVE to slice 1: nothing above this line changes. Two more pieces of
// the divergent-precedence problem get unified into pure, tested resolvers:
//
//   1. life_compass state ('set' | 'not_set') — today every caller decides
//      "is there a goal?" ad-hoc (truthy primary_goal? non-null set_at? an
//      is_active row?). We collapse that to ONE rule.
//
//   2. journey plan_phase — the §1.4 canon (spec line 86) is a 4-way
//      discriminator with a strict PRECEDENCE that the live derivation in
//      new-day-overview-payload.ts only implements as 3 ways (it folds the
//      4th, `goal_completed`, into `on_personalized_goal` and tracks the
//      past-deadline separately as `days_past_deadline`). This resolver lands
//      the full canonical 4-way precedence so later slices can migrate the
//      ad-hoc sites onto it. Because adding `goal_completed` is a *behavior
//      change* for any site that previously emitted `on_personalized_goal`
//      for a past-target goal, migrating such a site is NOT a no-op and is
//      deferred (see the TODO in new-day-overview-payload.ts).
//
// Pure functions only — callers pass raw values in; precedence lives here.
// ---------------------------------------------------------------------------

/** Whether the user has an active Life Compass goal set. */
export type LifeCompassState = 'set' | 'not_set';

export interface ResolveLifeCompassStateInput {
  /** The active life_compass row's primary goal text, if any. */
  primaryGoal?: string | null;
  /** When the active Life Compass was set (ISO); presence is a strong signal. */
  setAt?: string | null;
  /**
   * Explicit "an active row exists" flag, when the caller already knows it
   * (e.g. it queried `is_active=true`). When provided as `false` it forces
   * 'not_set' regardless of the other fields (no active row → no goal).
   */
  hasActiveRow?: boolean | null;
}

/**
 * The ONE canonical Life Compass state resolver.
 *
 * Rule (strictest-wins, mirrors §1.4 `life_compass.state`):
 *   - If `hasActiveRow === false` → 'not_set' (an explicit "no active row"
 *     beats any stale goal text the caller may still be carrying).
 *   - Else 'set' iff there is a non-empty primary goal OR a parseable set_at
 *     OR `hasActiveRow === true`; otherwise 'not_set'.
 *
 * Pure — no IO. Trims/validates inputs so callers don't each re-implement the
 * "is this goal real?" check with divergent truthiness.
 */
export function resolveLifeCompassState(
  input: ResolveLifeCompassStateInput,
): LifeCompassState {
  if (input.hasActiveRow === false) return 'not_set';

  const goal = typeof input.primaryGoal === 'string' ? input.primaryGoal.trim() : '';
  if (goal.length > 0) return 'set';

  const setAt = typeof input.setAt === 'string' ? input.setAt.trim() : '';
  if (setAt.length > 0 && Number.isFinite(Date.parse(setAt))) return 'set';

  if (input.hasActiveRow === true) return 'set';

  return 'not_set';
}

/**
 * The canonical journey plan_phase discriminator (§1.4, spec line 86).
 *
 * default_active            → day_in_journey <= total_days, no Life Compass goal.
 * default_finished_no_goal  → day_in_journey >  total_days, no Life Compass goal.
 * on_personalized_goal      → Life Compass goal set, target_date NOT in the past.
 * goal_completed            → Life Compass goal set, target_date IS in the past.
 *                             (Phase 2 / R7 surface; the live 3-way derivation
 *                              folds this into on_personalized_goal today.)
 */
export type JourneyPlanPhase =
  | 'default_active'
  | 'default_finished_no_goal'
  | 'on_personalized_goal'
  | 'goal_completed';

export interface ResolveJourneyPlanPhaseInput {
  /** Monotonic day since the journey started (never resets). */
  dayInJourney: number;
  /** Length of the default scaffolding plan (e.g. 90). */
  totalDays: number;
  /** Canonical Life Compass state — pass the result of resolveLifeCompassState. */
  lifeCompassState: LifeCompassState;
  /**
   * Active goal target date (ISO date `YYYY-MM-DD` or full ISO). Only consulted
   * when the goal is set; a past target_date promotes to `goal_completed`.
   */
  targetDate?: string | null;
  /** Reference instant for the past/future target_date comparison. */
  now: Date;
}

export interface ResolvedJourneyPlanPhase {
  plan_phase: JourneyPlanPhase;
  /** True when target_date parsed and is strictly before `now` (end-of-day). */
  target_date_in_past: boolean;
}

/**
 * The ONE canonical plan_phase resolver. PRECEDENCE (strictest-first):
 *
 *   1. life_compass set + target_date in the past   → 'goal_completed'
 *   2. life_compass set (no / future target_date)    → 'on_personalized_goal'
 *   3. not_set + day_in_journey >  total_days        → 'default_finished_no_goal'
 *   4. not_set + day_in_journey <= total_days        → 'default_active'
 *
 * Boundary: `day_in_journey === total_days` is still `default_active` (the
 * user is ON the last day of the plan, not past it) — matches the live
 * `day > total_days` cutoff exactly.
 *
 * target_date "in the past" uses end-of-day UTC (`T23:59:59Z`) so a goal due
 * *today* is NOT yet completed — identical to the live `days_past_deadline`
 * cutoff in new-day-overview-payload.ts.
 *
 * Pure — no IO. Exhaustively unit-tested.
 */
export function resolveJourneyPlanPhase(
  input: ResolveJourneyPlanPhaseInput,
): ResolvedJourneyPlanPhase {
  const targetDateInPast = isTargetDateInPast(input.targetDate, input.now);

  if (input.lifeCompassState === 'set') {
    return {
      plan_phase: targetDateInPast ? 'goal_completed' : 'on_personalized_goal',
      target_date_in_past: targetDateInPast,
    };
  }

  if (input.dayInJourney > input.totalDays) {
    return { plan_phase: 'default_finished_no_goal', target_date_in_past: targetDateInPast };
  }

  return { plan_phase: 'default_active', target_date_in_past: targetDateInPast };
}

/**
 * Whether a goal `target_date` is strictly before `now`, using end-of-day UTC.
 * Accepts a bare `YYYY-MM-DD` (anchored to `T23:59:59Z`) or any Date.parse-able
 * ISO string. Unparseable or null → false (not in the past). Exported so
 * downstream slices/tests can reuse the exact deadline semantics.
 */
export function isTargetDateInPast(targetDate: string | null | undefined, now: Date): boolean {
  if (typeof targetDate !== 'string') return false;
  const raw = targetDate.trim();
  if (raw.length === 0) return false;

  // Date-only → anchor to end-of-day UTC (a goal due "today" is not yet past).
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59Z` : raw;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;

  return ms < now.getTime();
}

/**
 * Target shape for the unified awareness context (populated incrementally by
 * later R1 slices). Documented now so consumers + reviewers see the endpoint;
 * slice 1 only exercises the identity.first_name path via resolveSpokenFirstName.
 */
export interface UnifiedAwarenessContext {
  identity: {
    user_id: string | null;
    tenant_id: string | null;
    first_name: string | null;
    first_name_source: FirstNameSource;
    display_name: string | null;
    vitana_id: string | null;
  };
  // R1 later slices: surface, locale, time, journey, life_compass,
  // vitana_index, pillar_momentum, cadence, signals, teacher, bootstrap_pack.
}
