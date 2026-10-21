/**
 * VTID-02019: User-timezone helpers.
 *
 * Vitana renders timestamps to humans, not to the gateway's runtime. Whenever
 * we put a clock value (HH:MM, "this morning", "yesterday afternoon") in
 * front of the user, it must be in their local timezone — not the Cloud Run
 * region's tz, not UTC.
 *
 * The 10k+ users we expect on launch are in Central European Time. So when a
 * surface doesn't explicitly tell us the user's tz (or tells us 'UTC' as a
 * gateway-internal fallback), we resolve to Europe/Berlin instead of UTC.
 *
 * Set DEFAULT_USER_TIMEZONE env var to override the system default for a
 * different launch market.
 */

export const DEFAULT_USER_TIMEZONE: string =
  process.env.DEFAULT_USER_TIMEZONE && process.env.DEFAULT_USER_TIMEZONE.trim().length > 0
    ? process.env.DEFAULT_USER_TIMEZONE
    : 'Europe/Berlin';

/**
 * Normalize a user-supplied timezone for human-facing rendering.
 *
 * Rules:
 *   - Valid IANA tz (e.g. "Europe/Berlin", "America/New_York") → use it.
 *   - 'UTC' / null / undefined / empty → treat as "unknown" and use the
 *     system default (Europe/Berlin). UTC is what the gateway falls back to
 *     when a surface doesn't pass a real timezone, so we re-route it.
 */
export function resolveUserTimezone(provided: string | null | undefined): string {
  if (!provided) return DEFAULT_USER_TIMEZONE;
  const trimmed = provided.trim();
  if (trimmed.length === 0) return DEFAULT_USER_TIMEZONE;
  if (trimmed.toUpperCase() === 'UTC') return DEFAULT_USER_TIMEZONE;
  return trimmed;
}

/**
 * Render an ISO instant as "HH:MM" in the user's local timezone (24-hour).
 * Falls back to a UTC slice if Intl rejects the tz.
 */
export function formatLocalHHMM(iso: string, userTz?: string | null): string {
  const tz = resolveUserTimezone(userTz);
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(11, 16);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return iso.slice(11, 16);
  }
}

/**
 * Render an ISO instant as "YYYY-MM-DD" in the user's local timezone.
 */
export function formatLocalDate(iso: string, userTz?: string | null): string {
  const tz = resolveUserTimezone(userTz);
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(0, 10);
    // en-CA gives YYYY-MM-DD with - separators
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}
