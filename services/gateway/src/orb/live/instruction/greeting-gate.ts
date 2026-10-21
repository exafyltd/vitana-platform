/**
 * BOOTSTRAP-ORB-GREETING-LANG-FIRSTTIME — greeting-gate decisions.
 *
 * Small, pure helpers that encapsulate two session-start greeting decisions so
 * they can be unit-pinned independently of the large live-session controller /
 * orb-live handler that consume them:
 *
 *   1. deriveHasPriorSession  — has this user talked to Vitana before?
 *   2. shouldFireFirstTimeWelcome — does the FULL one-time first-session welcome
 *      fire, or should the user fall through to the returning-user register?
 *   3. resolveGreetingLang    — which language does the spoken greeting use?
 *
 * Why these exist as a unit: the first-time welcome previously fired on the
 * "needs onboarding" signal alone (0 completed guided-journey topics + not
 * opted out), so a user who simply never finished onboarding was re-introduced
 * from scratch on EVERY session — the robotic "first-time user every time" bug.
 * Gating on `hasPriorSession` fixes it; pinning that here keeps it from
 * regressing.
 */

/** The persisted user_journey fields that prove prior interaction. */
export interface PriorSessionRow {
  last_session_date?: string | null;
  is_first_session?: boolean | null;
}

/**
 * A user "has a prior session" once they have a recorded `last_session_date` OR
 * their `is_first_session` flag has already been cleared. Either proves they
 * have talked to Vitana before. No row at all → no prior session.
 */
export function deriveHasPriorSession(row: PriorSessionRow | null | undefined): boolean {
  if (!row) return false;
  return row.last_session_date != null || row.is_first_session === false;
}

export interface FirstTimeWelcomeGateInput {
  /** The user has talked to Vitana before (see deriveHasPriorSession). */
  hasPriorSession: boolean;
  /** 0 completed guided-journey topics AND not opted out of onboarding. */
  needsOnboarding: boolean;
  /** user_journey.is_first_session — true only on the genuine first session. */
  isFirstSession: boolean;
}

/**
 * The full one-time first-session welcome fires ONLY when there is no prior
 * session on record. A returning user who simply never completed guided
 * onboarding (`needsOnboarding === true`) must NOT be re-introduced from
 * scratch — they fall through to the returning-user resume register.
 */
export function shouldFireFirstTimeWelcome(input: FirstTimeWelcomeGateInput): boolean {
  if (input.hasPriorSession) return false;
  return input.needsOnboarding === true || input.isFirstSession === true;
}

/**
 * Resolve the language the spoken greeting should use. Prefer the session
 * language (resolved from the user's stored preference during the greeting-facts
 * pre-fetch) and fall back to the value captured at session start. This keeps
 * turn 1 (the greeting) in the SAME language as the rest of the conversation,
 * which reads `session.lang` — otherwise the greeting speaks the default and the
 * conversation flips to the stored preference on turn 2.
 */
export function resolveGreetingLang(sessionLang: unknown, fallback: string): string {
  return typeof sessionLang === 'string' && sessionLang.length > 0 ? sessionLang : fallback;
}
