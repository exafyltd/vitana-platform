/**
 * VTID-04427 (Plan v1 WS-3.2) — where the live advisor meets the session.
 *
 * `triggerLiveAdvisor` is called when a user turn is recorded (turn
 * complete). It returns immediately — and does nothing at all while the
 * advisor is inactive (no approved `advisor` stage, or the flag off). When
 * active it runs the advisor in the background; the note it writes serves
 * `get_guidance` on the following turns (fresh for 2 turns).
 *
 * `answerGetGuidance` is the `get_guidance` tool: an in-memory read.
 */

import {
  isLiveAdvisorActive,
  newAdvisorState,
  readGuidance,
  runLiveAdvisor,
  type AdvisorModelCall,
  type AdvisorState,
} from '../../../services/conversation/live-advisor';

/** Leads lookup is bounded so a slow read never delays the advisor call. */
const LEADS_TIMEOUT_MS = 300;

export interface AdvisorSessionLike {
  sessionId?: string;
  isAnonymous?: boolean;
  identity?: { user_id?: string | null } | null;
  transcriptTurns?: Array<{ role: 'user' | 'assistant'; text: string }>;
  current_route?: string | null;
  screenContext?: { screen_title?: string | null } | null;
  declaredToolNames?: Set<string>;
  lang?: string | null;
  turn_count?: number;
  advisorState?: AdvisorState;
}

type EmitDiag = (session: any, stage: string, extra?: Record<string, unknown>) => void;

async function defaultCallModel(): Promise<AdvisorModelCall> {
  const { callViaRouter } = await import('../../../services/llm-router');
  const { turnUsageFields } = await import('../../../services/operator-turn-cost');
  return async ({ stage, systemPrompt, prompt, maxTokens }) => {
    const r = await callViaRouter(stage, prompt, { service: 'live-advisor', systemPrompt, maxTokens, allowFallback: true });
    const cost = turnUsageFields(r.model, r.usage);
    return {
      ok: !!r.ok && !!r.text,
      text: r.text,
      cost_usd: cost.cost_usd ?? 0,
      tokens_in: cost.usage?.input_tokens,
      tokens_out: cost.usage?.output_tokens,
      error: r.error,
    };
  };
}

async function defaultLeads(userId: string, route: string | null): Promise<string[]> {
  const { getSupabase } = await import('../../../lib/supabase');
  const sb = getSupabase();
  if (!sb) return [];
  const { readTurnCandidates } = await import('../../../services/conversation/turn-candidates');
  const r = await readTurnCandidates(sb, userId, { currentRoute: route });
  return r.ranked.map((c) => c.lead).filter((l): l is string => !!l);
}

export function triggerLiveAdvisor(
  session: AdvisorSessionLike,
  userText: string,
  emitDiag?: EmitDiag,
  deps: {
    active?: boolean;
    callModel?: AdvisorModelCall;
    leads?: (userId: string, route: string | null) => Promise<string[]>;
  } = {},
): Promise<void> | void {
  if (!(deps.active ?? isLiveAdvisorActive())) return;
  const userId = session.identity?.user_id;
  if (session.isAnonymous || !userId) return;
  const state = session.advisorState ?? (session.advisorState = newAdvisorState());
  const turn = session.turn_count ?? 0;
  return (async () => {
    try {
      const leads = await Promise.race([
        (deps.leads ?? defaultLeads)(userId, session.current_route ?? null).catch(() => [] as string[]),
        new Promise<string[]>((r) => setTimeout(() => r([]), LEADS_TIMEOUT_MS)),
      ]);
      await runLiveAdvisor(state, userText, turn, {
        turns: (session.transcriptTurns ?? []).map((t) => ({ role: t.role, text: t.text })),
        currentRoute: session.current_route ?? null,
        screenTitle: session.screenContext?.screen_title ?? null,
        leads,
        declaredTools: [...(session.declaredToolNames ?? [])],
        lang: session.lang ?? null,
      }, {
        active: true,
        callModel: deps.callModel ?? (await defaultCallModel()),
        emitDiag: (stage, extra) => emitDiag?.(session, stage, extra),
      });
    } catch {
      /* the advisor never affects the conversation */
    }
  })();
}

export function answerGetGuidance(session: AdvisorSessionLike, emitDiag?: EmitDiag): { success: boolean; result: string } {
  const r = readGuidance(session.advisorState, session.turn_count ?? 0);
  try {
    emitDiag?.(session, 'guidance_read', { fresh: r.fresh, age_turns: r.age_turns });
  } catch { /* diagnostic only */ }
  return { success: r.success, result: r.result };
}
