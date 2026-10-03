/**
 * Two rules for the voice model's remember_fact calls that only the live
 * session can enforce, because only it knows when the member spoke.
 *
 * VTID-04862 — a replace waits for the member's answer.
 *   Live B-CONF-01 (staging e36e486, session live-49485c50): Paul's birthday
 *   was stored as 5 May; "merk dir, Paul hat am siebten Mai Geburtstag".
 *   Nova called remember_fact(7. Mai, confirm_replace=true), got
 *   STATUS: conflict, and 240 ms later called it again with
 *   confirm_replace=true — which the tool honoured, because a conflict was
 *   now pending. 7 May was written while Vitana was still asking "which one
 *   is right?". The tool's own pending-conflict check cannot tell the model's
 *   retry from the member's answer; the session can. confirm_replace counts
 *   only when the member has spoken since the conflict was put to them;
 *   otherwise it is dropped and the call is an ordinary one (STATUS:
 *   conflict again — Vitana asks).
 *
 * VTID-04863 — an "already known" the member never said is not played yet.
 *   Live B-CONF-06 (sessions live-afce4968, live-b3063b00): 1997-11-04
 *   stored, the member said 1999. Nova called remember_fact with the STORED
 *   value, got already_known, and the member heard "Ich weiß bereits …"
 *   before the turn_complete re-check found the conflict. When the stored
 *   value is not in the member's own words, the reply to already_known is
 *   held (the VTID-04702 hold) until that re-check: it answers (conflict) →
 *   the held reply is dropped; it finds nothing new → the held reply plays.
 */

import { armReplyHold, isRememberHoldEnabled, type RememberHoldCtx } from './remember-hold';
import { normalizeDate } from '../../../services/memory/remember-fact-tool';

type EmitDiag = (session: any, stage: string, payload?: Record<string, unknown>) => void;

/** Member speech arrived (not the gateway's own note). */
export function noteMemberSpoke(session: any, at = Date.now()): void {
  if (session) session.memberSpokeAt = at;
}

/** A conflict question was put to the member (by the tool's result or the backstop's note). */
export function noteConflictAsked(session: any, at = Date.now()): void {
  if (session) session.rememberConflictAskedAt = at;
}

function confirmRequested(args: Record<string, unknown>): boolean {
  return args?.confirm_replace === true || args?.confirm_replace === 'true';
}

/** The args to run remember_fact with: confirm_replace only after the member answered. */
export function gateConfirmReplace(
  session: any,
  args: Record<string, unknown>,
  emitDiag?: EmitDiag,
): Record<string, unknown> {
  if (!confirmRequested(args)) return args;
  const askedAt = Number(session?.rememberConflictAskedAt || 0);
  const spokeAt = Number(session?.memberSpokeAt || 0);
  if (askedAt > 0 && spokeAt > askedAt) return args;
  emitDiag?.(session, 'remember_confirm_replace_dropped', {
    fact_key: String(args?.fact_key ?? ''),
    conflict_asked: askedAt > 0,
  });
  return { ...args, confirm_replace: false };
}

/** A remember_fact result told the model to ask which value is right. */
export function isConflictResult(resultText: string): boolean {
  return /^STATUS: conflict\b/.test(String(resultText || ''));
}

const ALREADY_KNOWN = /^STATUS: already_known\b[^"]*"([^"]*)"/;

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** True when the member's words carry the stored value (so "already known" is true). */
export function memberSaidValue(said: string, value: string): boolean {
  const v = norm(value);
  if (!v) return false;
  // A date is checked by meaning only when the member's words carry digits;
  // spoken numbers ("neunzehnhundertneunundneunzig") cannot be compared here.
  if (normalizeDate(value)) {
    const digits = String(said || '').match(/\d+/g) ?? [];
    const d = normalizeDate(value)!;
    const parts = d.replace(/^--/, '').split('-').map((p) => String(Number(p)));
    return parts.every((p) => digits.some((x) => String(Number(x)) === p));
  }
  return ` ${norm(said)} `.includes(` ${v} `);
}

/**
 * After a remember_fact result: hold the reply to an already_known whose
 * value the member did not say, until the turn_complete re-check.
 */
export function maybeHoldAlreadyKnownReply(ctx: RememberHoldCtx, resultText: string): boolean {
  const { session } = ctx;
  const m = String(resultText || '').match(ALREADY_KNOWN);
  if (!m) return false;
  if (!isRememberHoldEnabled() || session?.upstreamProvider !== 'nova_sonic') return false;
  if (memberSaidValue(String(session.inputTranscriptBuffer || ''), m[1])) return false;
  const hold = armReplyHold(ctx, 'already_known_check');
  return Boolean(hold);
}
