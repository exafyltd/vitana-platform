/**
 * A6.2 (orb-live-refactor): first navigator-domain handler extraction.
 *
 * Lifts `handleGetCurrentScreen` out of `orb-live.ts` into the typed
 * handler pattern that every future tool-domain handler will follow:
 *
 *   - **Input:** `SessionContext` (read-only, frozen) + `SessionMutator`
 *     (the only write surface) + the tool's args.
 *   - **Output:** the standard `{ success, result, error? }` envelope.
 *   - **Never imports `GeminiLiveSession`.** The handler doesn't see
 *     the live session map — only the typed views.
 *
 * Per the approved plan + the user's late-2026-05-11 design note:
 *   "SessionContext = read-only state.
 *    SessionMutator = only write surface.
 *    Handlers never see GeminiLiveSession directly."
 *
 * Behavior preservation: this lifted handler produces byte-identical
 * output to the pre-extraction `handleGetCurrentScreen` for the same
 * inputs. The orb-live.ts compat shim builds the SessionContext +
 * SessionMutator from the live session and forwards.
 *
 * `handleGetCurrentScreen` happens to be a pure READ (no session
 * mutation), so it doesn't consume the mutator. Future A6.3 / A6.4
 * lifts (handleNavigate, handleNavigateToScreen) WILL use the mutator
 * for `appendRecentRoute` after navigation succeeds.
 */

import type { SessionContext } from '../../session/session-context';
import type { SessionMutator } from '../../session/session-mutator';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../../lib/supabase';

/**
 * Standard handler return shape — identical to today's tool-dispatch
 * envelope used by `executeLiveApiToolInner`.
 */
export interface HandlerResult {
  success: boolean;
  result: string;
  error?: string;
}

/**
 * The typed handler signature every A6.x extraction adopts.
 *
 * `args` is the tool's argument payload from Gemini Live. `ctx` is the
 * read-only session view. `mutator` is the only legitimate write
 * surface; handlers that don't mutate (like `getCurrentScreenHandler`)
 * still receive it for uniformity.
 */
export type NavigatorHandler = (
  args: Record<string, unknown>,
  ctx: SessionContext,
  mutator: SessionMutator,
) => Promise<HandlerResult>;

/**
 * Lifted `handleGetCurrentScreen` — first A6.2 extraction.
 *
 * Behavior: returns the user's current screen + recent trail via the
 * shared orb-tools dispatcher. Pure read — no mutation, no state
 * change to the session. Identical output to the pre-A6.2 inline
 * `handleGetCurrentScreen` in orb-live.ts.
 *
 * Anonymous-safe: when Supabase isn't configured (test/dev sandbox),
 * degrades to an "unknown screen" payload rather than failing the
 * tool call.
 */
export async function getCurrentScreenHandler(
  _args: Record<string, unknown>,
  ctx: SessionContext,
  _mutator: SessionMutator,
): Promise<HandlerResult> {
  const sb: SupabaseClient | null = getSupabase();
  if (!sb) {
    // Fallback — same shape as the pre-A6.2 fallback in orb-live.ts.
    // tool_get_current_screen is anonymous-safe and doesn't read sb.
    return {
      success: true,
      result: JSON.stringify({
        title: 'Unknown screen',
        description: 'The user is on a route that is not in the navigation catalog.',
        route: ctx.currentRoute,
        recent_screens: [],
      }),
    };
  }

  const { dispatchOrbToolForVertex } = await import('../../../../services/orb-tools-shared');
  return await dispatchOrbToolForVertex(
    'get_current_screen',
    {
      current_route: ctx.currentRoute,
      recent_routes: [...ctx.recentRoutes],
    },
    {
      user_id: ctx.identity?.user_id ?? '',
      tenant_id: ctx.identity?.tenant_id ?? null,
      role: ctx.activeRole,
      vitana_id: ctx.vitanaId,
      lang: ctx.lang,
    },
    sb,
  );
}
