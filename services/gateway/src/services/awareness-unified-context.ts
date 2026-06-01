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
