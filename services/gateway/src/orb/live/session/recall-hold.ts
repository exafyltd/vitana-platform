/**
 * VTID-04753: the member never hears a refusal about their own people.
 *
 * Staging, 2026-09-30, "wie heißt meine Frau" with no spouse fact stored: even
 * with the prompt fixes of VTID-04729 in the live instruction, Nova's first
 * reply was a refusal in 3 of 4 runs ("Tut mir leid, aber ich kann diese
 * persönliche Information nicht teilen. Solche Details kannst du nur in deinem
 * Profil …"). The recall backstop (VTID-04692/04704) corrected it at
 * turn_complete, but the member heard the refusal first, then the correction.
 *
 * Same approach as the remember hold (VTID-04702), sharing its buffer:
 *
 *   - armed when the member asks about their own details (a recall question,
 *     not a question about the app) — the member's words reach the gateway
 *     before Nova's first audio;
 *   - the member's stored facts are read at once, while Nova is still
 *     thinking;
 *   - the reply's text runs ahead of its audio. Each text chunk is judged:
 *       · it names a stored value → released: the answer is right;
 *       · it refuses, defers, sends the member to their profile, or names a
 *         date no fact carries — i.e. the recall backstop will send Nova a
 *         note at turn_complete → held to turn_complete and dropped once the
 *         note is sent; the reply to the note is what the member hears;
 *       · its first sentence is complete and none of the above → released,
 *         so a plain answer is barely delayed;
 *   - a tool call in between (search_memory …) releases what was said before
 *     it ("let me check") and holds the answer to the result the same way;
 *   - never silent: the backstop did not answer, or the hold reached its
 *     maximum → the held reply is released.
 *
 * The judgement mirrors maybeRunRecallBackstop exactly: a reply is held only
 * when the backstop will replace it.
 *
 * Nova only. `ORB_RECALL_HOLD_ENABLED=false` turns it off (and it is off
 * whenever the remember hold or the recall backstop is off).
 */

import { getSupabase } from '../../../lib/supabase';
import { detectRememberIntent, REMEMBER_BACKSTOP_MARKER } from '../../../services/memory/remember-backstop';
import {
  asksAboutApp,
  asksForDate,
  detectAboutMeQuestion,
  detectRecallQuestion,
  extractDayMonths,
  replyCitesPrivacy,
  replyContainsStoredValue,
  replyDeflectsToProfile,
  replyDeniesOrDefers,
  replyNamesUnstoredDate,
  usableRecallFacts,
  type RecallFact,
} from '../../../services/memory/recall-backstop';
import { isRecallBackstopEnabled } from './remember-backstop-hook';
import { armReplyHold, isRememberHoldEnabled, releaseRememberHold, type RememberHold, type RememberHoldCtx } from './remember-hold';

export type RecallFactsLoader = (tenantId: string, userId: string) => Promise<RecallFact[]>;

export function isRecallHoldEnabled(): boolean {
  return (process.env.ORB_RECALL_HOLD_ENABLED ?? 'true') !== 'false' && isRememberHoldEnabled() && isRecallBackstopEnabled();
}

async function defaultFactsLoader(tenantId: string, userId: string): Promise<RecallFact[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { buildRememberFactDeps } = await import('../../../services/orb-tools-shared');
  const deps = await buildRememberFactDeps(sb);
  if (!deps.listCurrentFacts) return [];
  return (await deps.listCurrentFacts(tenantId, userId)) as RecallFact[];
}

let factsLoader: RecallFactsLoader = defaultFactsLoader;

/** Tests: replace the facts read (null restores the default). */
export function setRecallHoldFactsLoader(loader: RecallFactsLoader | null): void {
  factsLoader = loader ?? defaultFactsLoader;
}

/** A question the recall backstop answers (not "what do you know about me", not about the app). */
export function isHeldRecallQuestion(said: string): boolean {
  if (!said || said.trimStart().startsWith(REMEMBER_BACKSTOP_MARKER)) return false;
  if (detectRememberIntent(said)) return false;
  // "Was weißt du über mich?" is answered at length and judged as a whole.
  if (detectAboutMeQuestion(said)) return false;
  return detectRecallQuestion(said) && !asksAboutApp(said);
}

const SENTENCE_END = /[.!?](\s|$)/g;
// An answer that opens with an apology is almost always a refusal or a "not
// stored"; its first sentence alone is not enough to let it through.
const APOLOGY_OPENER = /^\s*(tut mir leid|leider|entschuldig|sorry|i'?m sorry|unfortunately|lo siento|desafortunadamente|nažalost|izvini)/i;

/**
 * What the recall backstop will make of this reply so far: `suspect` (it will
 * send Nova a note — hold the reply until then), `clean` (it will not — let
 * the reply play) or `wait` (too early to say).
 */
export function judgeRecallReply(question: string, reply: string, facts: RecallFact[] | null): 'suspect' | 'clean' | 'wait' {
  const r = String(reply || '');
  if (!r.trim()) return 'wait';
  if (facts && replyContainsStoredValue(r, facts)) return 'clean';
  const privacy = replyCitesPrivacy(r);
  const deflected = replyDeflectsToProfile(r);
  if (replyDeniesOrDefers(r) || deflected) {
    // A refusal or a profile detour is corrected whatever is stored.
    if (privacy || deflected) return 'suspect';
    if (!facts) return 'wait';
    // An honest "not stored yet" with nothing stored to offer stands.
    return usableRecallFacts(facts).length > 0 ? 'suspect' : 'clean';
  }
  const isDateQuestion = asksForDate(question);
  if (isDateQuestion && extractDayMonths(r).size > 0) {
    if (!facts) return 'wait';
    return replyNamesUnstoredDate(r, facts) ? 'suspect' : 'clean';
  }
  const ends = (r.match(SENTENCE_END) || []).length;
  // A date question's date often comes in the second sentence ("Natürlich!
  // Sie hat am … Geburtstag.").
  if (isDateQuestion || APOLOGY_OPENER.test(r)) return ends >= 2 || r.length >= 160 ? 'clean' : 'wait';
  return (ends >= 1 && r.trim().length >= 20) || r.length >= 140 ? 'clean' : 'wait';
}

function currentRecallHold(session: any): RememberHold | undefined {
  const hold = session?.rememberHold as RememberHold | undefined;
  return hold?.reason === 'recall_question' ? hold : undefined;
}

function eligible(session: any): boolean {
  return (
    isRecallHoldEnabled() &&
    session?.upstreamProvider === 'nova_sonic' &&
    Boolean(session?.identity?.user_id && session?.identity?.tenant_id) &&
    session.memoryWriteToolCalledThisTurn !== true
  );
}

function arm(ctx: RememberHoldCtx, question: string, facts: RecallFact[] | null): RememberHold | undefined {
  const { session } = ctx;
  const hold = armReplyHold(ctx, 'recall_question');
  if (!hold) return undefined;
  hold.question = question;
  hold.facts = facts;
  hold.replyOffset = String(session.outputTranscriptBuffer || '').length;
  session.recallHoldQuestion = question;
  if (facts) return hold;
  const tenantId = String(session.identity.tenant_id);
  const userId = String(session.identity.user_id);
  void factsLoader(tenantId, userId)
    .catch(() => [] as RecallFact[])
    .then((loaded) => {
      hold.facts = Array.isArray(loaded) ? loaded : [];
      if (session.recallHoldQuestion === question) session.recallHoldFacts = hold.facts;
      if (session.rememberHold === hold) evaluateRecallHold(ctx);
    });
  return hold;
}

/** Member speech arrived: hold the reply of a question about the member's own details. */
export function maybeArmRecallHold(ctx: RememberHoldCtx): void {
  const { session } = ctx;
  const said = String(session.inputTranscriptBuffer || '');
  const current = currentRecallHold(session);
  if (current) {
    // The question may arrive in pieces ("wie heißt" … "meine Frau").
    current.question = said;
    session.recallHoldQuestion = said;
    return;
  }
  if (session.rememberHold || !eligible(session)) return;
  if (!isHeldRecallQuestion(said)) return;
  arm(ctx, said, null);
}

/** Reply text arrived: release the hold once the reply is plainly fine. */
export function evaluateRecallHold(ctx: RememberHoldCtx): void {
  const { session } = ctx;
  const hold = currentRecallHold(session);
  if (!hold) return;
  const reply = String(session.outputTranscriptBuffer || '').slice(hold.replyOffset ?? 0);
  const verdict = judgeRecallReply(hold.question || '', reply, hold.facts ?? null);
  if (verdict === 'clean') {
    releaseRememberHold(ctx, hold.suspect ? 'reply_answered' : 'reply_clean');
    return;
  }
  if (verdict === 'suspect' && !hold.suspect) {
    hold.suspect = true;
    ctx.deps.emitDiag(session, 'recall_hold_suspect', {
      reply_chars: reply.length,
      facts_loaded: Array.isArray(hold.facts),
      held_ms: Date.now() - hold.armedAt,
    });
  }
}

/**
 * A tool result went back to Nova during a recall turn: what it said before
 * ("let me check") is released, and its answer to the result is held and
 * judged like the first reply.
 */
export function rearmRecallHoldAfterTool(ctx: RememberHoldCtx): void {
  const { session } = ctx;
  const question = session.recallHoldQuestion as string | undefined;
  if (!question || !eligible(session)) return;
  const previous = currentRecallHold(session);
  if (session.rememberHold && !previous) return; // a remember hold owns the turn
  const facts = previous?.facts ?? (session.recallHoldFacts as RecallFact[] | undefined) ?? null;
  if (previous) releaseRememberHold(ctx, 'tool_result_sent');
  arm(ctx, question, facts);
}

/** turn_complete / interruption: the recall turn is over. */
export function endRecallTurn(session: any): void {
  if (!session) return;
  session.recallHoldQuestion = undefined;
  session.recallHoldFacts = undefined;
}
