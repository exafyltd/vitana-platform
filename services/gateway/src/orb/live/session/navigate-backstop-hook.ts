/**
 * VTID-04619 — where the navigate backstop meets the live session.
 *
 * At turn_complete: if Vitana's reply this turn announced that she is opening
 * a page ("Ich öffne jetzt die Seite mit …") and no navigate /
 * navigate_to_screen call happened in the turn and nothing is already
 * navigating, the gateway runs the navigate tool itself with her words plus
 * the member's. The navigate tool does the rest exactly as if the model had
 * called it: registry match, every gate, the orb_directive to the app.
 *
 * Why: production 2026-09-26 09:17 (session live-07f808a6, Nova Sonic) — three
 * turns of "ich öffne jetzt die Seite", zero tool calls; the repeats were
 * muted as duplicate turns and the member saw a silent Listening loop.
 *
 * Once per turn. Never throws. `ORB_NAVIGATE_BACKSTOP_ENABLED=false` turns it
 * off.
 */

import {
  NAVIGATE_TOOL_NAMES,
  buildBackstopNavigateQuestion,
  detectNavigationPromise,
  isNavigateBackstopEnabled,
} from './navigation-promise-intent';
import { navigationDispatchedThisTurn } from './navigation-turn-scope';

type EmitDiag = (session: any, stage: string, extra?: Record<string, unknown>) => void;

export interface NavigateBackstopSession {
  sessionId?: string;
  active?: boolean;
  identity?: { user_id?: string | null; tenant_id?: string | null } | null;
  pendingNavigation?: unknown;
  navigationDispatched?: boolean;
  navigationDispatchedTurn?: number;
  turn_count?: number;
  navigateToolCalledThisTurn?: boolean;
}

/** Called for every tool call: remembers that the model navigated itself. */
export function noteNavigateToolCall(sessionIn: unknown, toolName: string): void {
  if (NAVIGATE_TOOL_NAMES.has(toolName)) {
    (sessionIn as NavigateBackstopSession).navigateToolCalledThisTurn = true;
  }
}

/**
 * Decide and run. Returns the promise (tests await it); the handler never
 * does. Resets the per-turn tool marker either way.
 */
export function maybeRunNavigateBackstop(
  ctx: { deps: { emitDiag: EmitDiag; executeLiveApiTool: (...args: any[]) => Promise<any> } },
  sessionIn: unknown,
  userText: string,
  assistantText: string,
): Promise<boolean> | null {
  const session = sessionIn as NavigateBackstopSession;
  const toolCalled = session.navigateToolCalledThisTurn === true;
  session.navigateToolCalledThisTurn = false;

  if (!isNavigateBackstopEnabled()) return null;
  if (toolCalled || !session.active) return null;
  if (!session.identity?.user_id) return null;
  // A navigation is already under way. turn_count was incremented at the top
  // of turn_complete, before this runs, so a dispatch made during the turn
  // that just ended carries turn_count - 1; the session latch covers a
  // navigate whose confirmation arrives in a later turn.
  if (session.pendingNavigation || session.navigationDispatched) return null;
  if (navigationDispatchedThisTurn(session as any)) return null;
  if (
    typeof session.navigationDispatchedTurn === 'number' &&
    session.navigationDispatchedTurn === (session.turn_count ?? 0) - 1
  ) return null;
  if (!detectNavigationPromise(assistantText)) return null;

  const question = buildBackstopNavigateQuestion(assistantText, userText);
  const run = (async () => {
    const result = await ctx.deps.executeLiveApiTool(session, 'navigate', { question, intent: 'open' });
    const ok = !!result?.success;
    ctx.deps.emitDiag(session, 'navigate_backstop', {
      ok,
      question: question.slice(0, 200),
      result: String(result?.result ?? result?.error ?? '').slice(0, 200),
    });
    console.log(`[VTID-04619] navigate backstop ${session.sessionId}: ok=${ok} question="${question.slice(0, 120)}"`);
    return ok;
  })().catch((err: any) => {
    console.warn(`[VTID-04619] navigate backstop failed (non-blocking): ${err?.message ?? err}`);
    return false;
  });
  return run;
}
