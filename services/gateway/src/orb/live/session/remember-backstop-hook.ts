/**
 * VTID-04591 — where the remember backstop meets the live session.
 *
 * Called at turn_complete with the member's utterance. It returns at once and
 * does the work in the background:
 *   - a remember request ("merk dir …", "remember …") with no remember_fact
 *     call in the turn → the gateway runs remember_fact's rules itself;
 *   - the member's answer to a conflict question the gateway asked earlier in
 *     this session, again with no remember_fact call → that answer is applied.
 * The model then receives the STATUS lines as a system note (Nova text turn)
 * and says the real outcome.
 *
 * Nova only: the Vertex bridge treats injected client_content as a second
 * user turn and answers twice (see the note in upstream-message-handler.ts).
 * `ORB_REMEMBER_BACKSTOP_ENABLED=false` turns it off.
 */

import {
  REMEMBER_BACKSTOP_MARKER,
  buildRememberBackstopNote,
  detectRememberClaim,
  detectRememberIntent,
  openConflictsFrom,
  runConflictAnswerBackstop,
  runRememberBackstop,
  type OpenConflict,
  type RememberBackstopDeps,
} from '../../../services/memory/remember-backstop';
import type { RememberFactToolResult } from '../../../services/memory/remember-fact-tool';

export { REMEMBER_BACKSTOP_MARKER };

export interface RememberBackstopSession {
  sessionId?: string;
  active?: boolean;
  upstreamProvider?: string;
  identity?: { user_id?: string | null; tenant_id?: string | null } | null;
  upstreamClient?: { sendTextTurn(text: string, turnComplete?: boolean): boolean } | null;
  rememberFactCalledThisTurn?: boolean;
  /** VTID-04690: a remember_fact call this turn answered STATUS: already_known. */
  rememberFactAlreadyKnownThisTurn?: boolean;
  openRememberConflicts?: OpenConflict[];
}

type EmitDiag = (session: any, stage: string, extra?: Record<string, unknown>) => void;

export function isRememberBackstopEnabled(): boolean {
  return (process.env.ORB_REMEMBER_BACKSTOP_ENABLED ?? 'true') !== 'false';
}

async function defaultDeps(): Promise<RememberBackstopDeps | null> {
  const { getSupabase } = await import('../../../lib/supabase');
  const sb = getSupabase();
  if (!sb) return null;
  const { buildRememberFactDeps } = await import('../../../services/orb-tools-shared');
  const { callLlmForExtraction } = await import('../../../services/inline-fact-extractor');
  const base = await buildRememberFactDeps(sb);
  return { ...base, extract: (text: string) => callLlmForExtraction(text) };
}

/**
 * Decide and run. Returns the promise so tests can await it; the handler
 * never does.
 */
export function maybeRunRememberBackstop(
  ctx: { deps: { emitDiag: EmitDiag } },
  sessionIn: unknown,
  userText: string,
  depsOverride?: RememberBackstopDeps,
  replyText = '',
): Promise<RememberFactToolResult[]> | null {
  const session = sessionIn as RememberBackstopSession;
  const toolCalled = session.rememberFactCalledThisTurn === true;
  const toolAlreadyKnown = session.rememberFactAlreadyKnownThisTurn === true;
  session.rememberFactCalledThisTurn = false;
  session.rememberFactAlreadyKnownThisTurn = false;
  // VTID-04690: live B-CONF-03 — the member said "Paul hat am siebten Mai
  // Geburtstag", Nova called remember_fact with the STORED "May 5", got
  // already_known, and the new date was never saved or asked about. When the
  // tool answered already_known, the member's own words are checked too.
  const recheck = toolCalled && toolAlreadyKnown && Boolean(userText) && !userText.startsWith(REMEMBER_BACKSTOP_MARKER);
  if (toolCalled && !recheck) {
    // The model handled it; any conflict the gateway asked about is now the tool's.
    session.openRememberConflicts = [];
    return null;
  }
  if (!isRememberBackstopEnabled() || session.upstreamProvider !== 'nova_sonic') return null;
  const userId = session.identity?.user_id;
  const tenantId = session.identity?.tenant_id;
  if (!userId || !tenantId || !session.upstreamClient) return null;

  const openConflict = recheck ? undefined : session.openRememberConflicts?.[0];
  // VTID-04697: a plain statement ("Paul hat am siebten Mai Geburtstag") that
  // the reply claims to have remembered, with no tool call, is run too.
  const claimed =
    !recheck &&
    !toolCalled &&
    !detectRememberIntent(userText) &&
    Boolean(userText) &&
    !userText.startsWith(REMEMBER_BACKSTOP_MARKER) &&
    detectRememberClaim(replyText);
  const isRequest = recheck || claimed || detectRememberIntent(userText);
  if (!openConflict && !isRequest) return null;
  // One try per asked conflict: the member's next turn answers it or moves on.
  if (openConflict) session.openRememberConflicts = session.openRememberConflicts!.slice(1);

  const input = { utterance: userText, tenant_id: tenantId, user_id: userId, thread_id: null };
  const run = (async () => {
    const deps = depsOverride ?? (await defaultDeps());
    if (!deps) return [];
    let results: RememberFactToolResult[] = [];
    if (openConflict) results = await runConflictAnswerBackstop({ ...input, conflict: openConflict }, deps);
    if (results.length === 0 && isRequest) {
      const facts = await deps.extract(userText).catch(() => []);
      results = await runRememberBackstop(input, { ...deps, extract: async () => facts });
      const abouts = facts.map((f) => (f.entity === 'self' || !f.entity ? 'self' : 'other') as 'self' | 'other');
      const conflicts = openConflictsFrom(results, abouts);
      if (conflicts.length) session.openRememberConflicts = [...(session.openRememberConflicts ?? []), ...conflicts];
    }
    const note = buildRememberBackstopNote(
      results,
      recheck ? 'stored_value_echoed' : claimed && !openConflict ? 'claimed_without_call' : 'no_call',
      (session as any).rememberReplyHeld === true,
    );
    ctx.deps.emitDiag(session, 'remember_backstop', {
      trigger: openConflict ? 'conflict_answer' : recheck ? 'stored_value_echoed' : claimed ? 'claimed_without_call' : 'remember_request',
      statuses: results.map((r) => `${r.fact_key}:${r.status}`),
      injected: Boolean(note && session.active),
    });
    console.log(
      `[VTID-04591] remember backstop ${session.sessionId}: ${results.map((r) => `${r.fact_key}->${r.status}`).join(', ') || 'no fact extracted'}`,
    );
    if (note && session.active && session.upstreamClient) {
      session.upstreamClient.sendTextTurn(note, true);
      // VTID-04702: the held reply is replaced only when Nova was told the result.
      (session as any).rememberNoteSentAt = Date.now();
    }
    return results;
  })().catch((err: any) => {
    console.warn(`[VTID-04591] remember backstop failed (non-blocking): ${err?.message ?? err}`);
    return [] as RememberFactToolResult[];
  });
  return run;
}

// ---------------------------------------------------------------- VTID-04684: forget

export interface ForgetBackstopSession extends RememberBackstopSession {
  forgetFactCalledThisTurn?: boolean;
}

/** Marks the injected forget note; the input-transcript path never records it as member speech. */
export const FORGET_BACKSTOP_MARKER = REMEMBER_BACKSTOP_MARKER;

/**
 * A forget request ("vergiss bitte, dass …") the model answered without
 * calling forget_fact or forget_memory: the gateway forgets the matching fact
 * and tells the model the real outcome. Live suite B-FORG-01: Nova said the
 * dog's name was deleted, called nothing, and the fact stayed.
 */
export function maybeRunForgetBackstop(
  ctx: { deps: { emitDiag: EmitDiag } },
  sessionIn: unknown,
  userText: string,
  depsOverride?: import('../../../services/memory/forget-fact').ForgetFactDeps,
): Promise<import('../../../services/memory/forget-fact').ForgetFactResult | null> | null {
  const session = sessionIn as ForgetBackstopSession;
  const toolCalled = session.forgetFactCalledThisTurn === true;
  session.forgetFactCalledThisTurn = false;
  if (toolCalled) return null;
  if (!isRememberBackstopEnabled() || session.upstreamProvider !== 'nova_sonic') return null;
  const userId = session.identity?.user_id;
  const tenantId = session.identity?.tenant_id;
  if (!userId || !tenantId || !session.upstreamClient) return null;
  if (!userText || userText.startsWith(REMEMBER_BACKSTOP_MARKER)) return null;

  const run = (async () => {
    const { detectForgetIntent } = await import('../../../services/memory/memory-intent');
    if (!detectForgetIntent(userText)) return null;
    const { runForgetFact, formatForgetFactResult } = await import('../../../services/memory/forget-fact');
    let deps = depsOverride;
    if (!deps) {
      const { getSupabase } = await import('../../../lib/supabase');
      const sb = getSupabase();
      if (!sb) return null;
      const { buildForgetFactDeps } = await import('../../../services/orb-tools-shared');
      deps = await buildForgetFactDeps(sb);
    }
    const result = await runForgetFact({ tenant_id: tenantId, user_id: userId, request: userText }, deps);
    ctx.deps.emitDiag(session, 'forget_backstop', {
      status: result.status,
      keys: result.forgotten.map((f) => f.fact_key),
      transcript_lines_removed: result.transcript_lines_removed ?? 0,
      injected: Boolean(session.active),
    });
    console.log(`[VTID-04684] forget backstop ${session.sessionId}: ${result.status} ${result.forgotten.map((f) => f.fact_key).join(',')}`);
    if (session.active && session.upstreamClient) {
      session.upstreamClient.sendTextTurn(
        [
          `${REMEMBER_BACKSTOP_MARKER} System result, not said by the member: the member asked you to forget something and you answered without calling forget_fact. The gateway ran it:`,
          `- ${formatForgetFactResult(result)}`,
          'Now tell the member the real outcome in one short sentence, in their language. If your previous answer said something different, correct it plainly. Do not call forget_fact for this again.',
        ].join('\n'),
        true,
      );
    }
    return result;
  })().catch((err: any) => {
    console.warn(`[VTID-04684] forget backstop failed (non-blocking): ${err?.message ?? err}`);
    return null;
  });
  return run;
}

// ---------------------------------------------------------------- VTID-04692: recall

export interface RecallBackstopSession extends RememberBackstopSession {
  /** remember_fact / forget_fact / forget_memory ran this turn — a write, not a question. A search that found nothing does NOT stand the backstop down: live smoke run 2 searched, missed, and said "nicht finden". */
  memoryWriteToolCalledThisTurn?: boolean;
}

export interface RecallBackstopDeps {
  listCurrentFacts(tenantId: string, userId: string): Promise<Array<{ fact_key: string; fact_value: string }>>;
}

/**
 * A question about the member's own details ("Wie heißt mein Hund?") the
 * model answered with "not stored" / "one moment", calling no memory tool:
 * the gateway gives it the member's current facts and it answers again.
 * Live suite B-REC-01 / B-REC-03, see services/memory/recall-backstop.ts.
 */
export function maybeRunRecallBackstop(
  ctx: { deps: { emitDiag: EmitDiag } },
  sessionIn: unknown,
  userText: string,
  replyText: string,
  depsOverride?: RecallBackstopDeps,
): Promise<number> | null {
  const session = sessionIn as RecallBackstopSession;
  const toolCalled = session.memoryWriteToolCalledThisTurn === true;
  session.memoryWriteToolCalledThisTurn = false;
  if (toolCalled) return null;
  if (!isRecallBackstopEnabled() || session.upstreamProvider !== 'nova_sonic') return null;
  const userId = session.identity?.user_id;
  const tenantId = session.identity?.tenant_id;
  if (!userId || !tenantId || !session.upstreamClient) return null;
  if (!userText || userText.startsWith(REMEMBER_BACKSTOP_MARKER)) return null;
  // A remember request belongs to the remember backstop, never both.
  if (detectRememberIntent(userText)) return null;

  const run = (async () => {
    const { detectRecallQuestion, detectAboutMeQuestion, replyDeniesOrDefers, replyContainsStoredValue, buildRecallBackstopNote, memberStatedFacts } =
      await import('../../../services/memory/recall-backstop');
    // "Was weißt du über mich?" answered without naming a single stored fact
    // (live B-REC-06), or a specific question answered with "not stored".
    const aboutMe = detectAboutMeQuestion(userText);
    if (!aboutMe && !(detectRecallQuestion(userText) && replyDeniesOrDefers(replyText))) return 0;
    let deps = depsOverride;
    if (!deps) {
      const { getSupabase } = await import('../../../lib/supabase');
      const sb = getSupabase();
      if (!sb) return 0;
      const { buildRememberFactDeps } = await import('../../../services/orb-tools-shared');
      const base = await buildRememberFactDeps(sb);
      if (!base.listCurrentFacts) return 0;
      deps = { listCurrentFacts: base.listCurrentFacts.bind(base) };
    }
    const all = await deps.listCurrentFacts(tenantId, userId).catch(() => []);
    // VTID-04707: "what do you know about me" is answered when the reply names
    // something the member told Vitana — not the profile name or context data.
    // Those facts go first in the note.
    const stated = aboutMe ? memberStatedFacts(all) : [];
    const facts = stated.length ? [...stated, ...all.filter((f) => !stated.includes(f))] : all;
    if (replyContainsStoredValue(replyText, stated.length ? stated : all)) return 0;
    const note = buildRecallBackstopNote(facts, userText, aboutMe ? 'about_me_vague' : 'denied');
    ctx.deps.emitDiag(session, 'recall_backstop', {
      trigger: aboutMe ? 'about_me_vague' : 'denied',
      facts_offered: note ? facts.length : 0,
      injected: Boolean(note && session.active),
    });
    console.log(`[VTID-04692] recall backstop ${session.sessionId}: ${note ? `${facts.length} facts offered` : 'nothing stored'}`);
    if (note && session.active && session.upstreamClient) session.upstreamClient.sendTextTurn(note, true);
    return note ? facts.length : 0;
  })().catch((err: any) => {
    console.warn(`[VTID-04692] recall backstop failed (non-blocking): ${err?.message ?? err}`);
    return 0;
  });
  return run;
}

export function isRecallBackstopEnabled(): boolean {
  return (process.env.ORB_RECALL_BACKSTOP_ENABLED ?? 'true') !== 'false';
}
