/**
 * VTID-05003: does a user's Kiro Power seat still have credits?
 *
 * Kiro always offers at least one model; an empty model list on a new session
 * means the seat's credits are used up (owner, 2026-10-08). A credit or quota
 * error from Kiro on a turn means the same. This map only chooses which engine
 * a NEW Operator thread starts with — every Kiro turn still checks the model
 * list itself when its session opens, so a stale entry never answers a turn.
 *
 * In memory, per gateway task, 1 h TTL. Accepted limitation: with several
 * gateway tasks each keeps its own map (the session-open check stays authoritative).
 */
export type KiroCredits = 'ok' | 'exhausted' | 'unknown';

const TTL_MS = 60 * 60_000;
const state = new Map<string, { credits: Exclude<KiroCredits, 'unknown'>; at: number }>();

/** Kiro's own wording for a used-up seat. */
const CREDIT_ERROR = /credit|quota|limit reached|insufficient/i;

export function isKiroCreditError(message: string | null | undefined): boolean {
  return !!message && CREDIT_ERROR.test(message);
}

export function getKiroCredits(userId: string | null, now: number = Date.now()): KiroCredits {
  if (!userId) return 'unknown';
  const e = state.get(userId);
  if (!e) return 'unknown';
  if (now - e.at > TTL_MS) { state.delete(userId); return 'unknown'; }
  return e.credits;
}

/** Record the credit state; returns true when it changed (so the caller logs the transition once). */
export function setKiroCredits(userId: string | null, credits: Exclude<KiroCredits, 'unknown'>, now: number = Date.now()): boolean {
  if (!userId) return false;
  const before = getKiroCredits(userId, now);
  state.set(userId, { credits, at: now });
  return before !== credits;
}

export function resetKiroCredits(): void { state.clear(); }

/**
 * VTID-05003: which engine a NEW Operator thread starts with for this user.
 * Kiro only when it can serve them: engine on, runner configured, their own key
 * linked, and their credits not known to be used up. Anything unknown => Operator.
 */
export function kiroDefaultEngine(a: { enabled: boolean; runnerConfigured: boolean; keyLinked: boolean | 'unknown'; credits: KiroCredits }): 'kiro' | 'llm' {
  return a.enabled && a.runnerConfigured && a.keyLinked === true && a.credits !== 'exhausted' ? 'kiro' : 'llm';
}
