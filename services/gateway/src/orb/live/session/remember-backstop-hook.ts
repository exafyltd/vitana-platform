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
  openRememberConflicts?: OpenConflict[];
}

type EmitDiag = (session: any, stage: string, extra?: Record<string, unknown>) => void;

export function isRememberBackstopEnabled(): boolean {
  return process.env.ORB_REMEMBER_BACKSTOP_ENABLED !== 'false';
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
): Promise<RememberFactToolResult[]> | null {
  const session = sessionIn as RememberBackstopSession;
  const toolCalled = session.rememberFactCalledThisTurn === true;
  session.rememberFactCalledThisTurn = false;
  if (toolCalled) {
    // The model handled it; any conflict the gateway asked about is now the tool's.
    session.openRememberConflicts = [];
    return null;
  }
  if (!isRememberBackstopEnabled() || session.upstreamProvider !== 'nova_sonic') return null;
  const userId = session.identity?.user_id;
  const tenantId = session.identity?.tenant_id;
  if (!userId || !tenantId || !session.upstreamClient) return null;

  const openConflict = session.openRememberConflicts?.[0];
  const isRequest = detectRememberIntent(userText);
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
    const note = buildRememberBackstopNote(results);
    ctx.deps.emitDiag(session, 'remember_backstop', {
      trigger: openConflict ? 'conflict_answer' : 'remember_request',
      statuses: results.map((r) => `${r.fact_key}:${r.status}`),
      injected: Boolean(note && session.active),
    });
    console.log(
      `[VTID-04591] remember backstop ${session.sessionId}: ${results.map((r) => `${r.fact_key}->${r.status}`).join(', ') || 'no fact extracted'}`,
    );
    if (note && session.active && session.upstreamClient) session.upstreamClient.sendTextTurn(note, true);
    return results;
  })().catch((err: any) => {
    console.warn(`[VTID-04591] remember backstop failed (non-blocking): ${err?.message ?? err}`);
    return [] as RememberFactToolResult[];
  });
  return run;
}
