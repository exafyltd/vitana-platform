/**
 * VTID-04552 (ORB latency J) — mobile playback lead on the first burst only.
 *
 * The widget schedules phone audio 300 ms ahead of "now" so the greeting's
 * first burst never underruns on a cold audio pipeline. It applied that lead
 * to EVERY burst, which is 300 ms added to every reply. When the server
 * declares `playback_lead_first_only: true`, the widget keeps the 300 ms lead
 * for the session's first burst only and uses 50 ms afterwards.
 *
 * The server is the switch (exact string 'true', default off). With the flag
 * off the field is omitted entirely, so every handshake payload is
 * byte-identical to before and the widget behaves exactly as today.
 */
export const MOBILE_LEAD_FIRST_ONLY_ENV = 'ORB_MOBILE_LEAD_FIRST_ONLY_ENABLED';

export function isMobileLeadFirstOnlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MOBILE_LEAD_FIRST_ONLY_ENV] === 'true';
}

/** Spread into a handshake payload: `{ playback_lead_first_only: true }` when on, `{}` when off. */
export function playbackLeadHandshakeFields(env: NodeJS.ProcessEnv = process.env): { playback_lead_first_only?: true } {
  return isMobileLeadFirstOnlyEnabled(env) ? { playback_lead_first_only: true } : {};
}
