/**
 * VTID-03064 (B0d-real slice Xg): turn-end next-action endpoint.
 *
 *   POST /api/v1/voice/next-action/turn-end
 *
 * Called by the LiveKit agent (orb-agent/session.py) at the end of each
 * generated assistant reply. Returns ONE next-best action the agent
 * should speak as a closing doorway — or an empty result when the
 * composer suppressed.
 *
 * Body:
 *   {
 *     decisionContext?: object,   // optional spine signals if cached agent-side
 *     lang?: string,              // ISO 639-1; defaults to req.identity.lang
 *     dedupeKeyHistory?: string[] // recent decisions in this session (Xg-future)
 *   }
 *
 * Auth: requireAuthWithTenant. Tenant + user from JWT only.
 *
 * Response:
 *   {
 *     ok: true,
 *     vtid: 'VTID-03064',
 *     surface: 'orb_turn_end',
 *     decision: { decision_id, selected_kind, suppress_reason, ... },
 *     continuation: { user_facing_line, kind, dedupe_key, ... } | null
 *   }
 *
 * Best-effort: framework errors degrade to `continuation: null` + a
 * suppress_reason. The agent NEVER blocks the user's turn on this call.
 */

import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
import { NEXT_ACTION_SUPPRESSED } from '../services/assistant-continuation/telemetry';
import {
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { decideContinuation } from '../services/assistant-continuation/decide-continuation';
import {
  NEXT_ACTION_EXTRA_KEY,
} from '../services/assistant-continuation/providers/next-action';
import {
  makeNextActionProvider,
  NEXT_ACTION_PROVIDER_KEY,
} from '../services/assistant-continuation/providers/next-action';
import { defaultProviderRegistry } from '../services/assistant-continuation/provider-registry';
// Side-effect import: ensure the 8 default sources are registered with
// the module-level composer before the endpoint serves its first call.
import '../services/assistant-continuation/providers/next-action/register-default-sources';
import { emitNextActionDecisionTelemetry } from '../services/assistant-continuation/providers/next-action/emit-telemetry';

const router = Router();
const VTID = 'VTID-03064';

// Idempotent provider registration. The wake-brief wiring registers the
// next-action provider on import too — this is belt-and-braces in case
// the turn-end route is invoked first.
let _registered = false;
function ensureNextActionProviderRegistered(): void {
  if (_registered) return;
  if (!defaultProviderRegistry.get(NEXT_ACTION_PROVIDER_KEY)) {
    defaultProviderRegistry.register(makeNextActionProvider());
  }
  _registered = true;
}
ensureNextActionProviderRegistered();

router.post(
  '/voice/next-action/turn-end',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = req.identity?.tenant_id;
      const userId = req.identity?.user_id;
      if (!tenantId || !userId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHENTICATED',
          message: 'Authenticated session with active tenant required',
          vtid: VTID,
        });
      }

      // VTID-03075 (B0d-real P0 mitigation): turn-end next-actions are
      // PAUSED. Live German testing showed the agent interrupting
      // active support flows with proactive turn-end nudges that the
      // LLM had no memory of (spoken with add_to_chat_ctx=False in
      // orb-agent/session.py) — so when the user said "ja" the agent
      // answered nonsense. We return a typed suppression here so the
      // Inspector still sees the request and the lifecycle stays
      // intact; no candidate is computed and no line is spoken.
      //
      // Re-enable ONLY after:
      //   1. activeContinuation state lands in the LiveKit agent so
      //      spoken proactive lines join chat context and short-reply
      //      acceptance ("ja" / "yes" / "okay") is intercepted.
      //   2. Turn-end suppression rules land (support flow, awaiting
      //      question, topic mismatch, lang mismatch).
      //   3. Match-source copy is tightened to suppress on thin
      //      context instead of firing a generic "frisches Match".
      const nowIso = new Date().toISOString();
      const pausedDecisionId = randomUUID();
      // Emit the suppression to OASIS so the Inspector still sees
      // turn-end requests during the mitigation window. Fire-and-
      // forget — mitigation MUST NOT fail because telemetry hiccups.
      void emitOasisEvent({
        vtid: VTID,
        type: NEXT_ACTION_SUPPRESSED as never,
        source: 'b0d-real-next-action-turn-end',
        status: 'info',
        message: 'turn_end_paused_pending_p0',
        payload: {
          tenant_id: tenantId,
          user_id: userId,
          decision_id: pausedDecisionId,
          surface: 'orb_turn_end',
          suppress_reason: 'turn_end_paused_pending_p0',
        },
        actor_id: userId,
        actor_role: 'user',
        surface: 'orb',
      }).catch(() => {
        // swallow — mitigation is the contract; telemetry is best-effort.
      });
      return res.status(200).json({
        ok: true,
        vtid: VTID,
        surface: 'orb_turn_end',
        decision: {
          decision_id: pausedDecisionId,
          selected_kind: 'none_with_reason',
          suppress_reason: 'turn_end_paused_pending_p0',
          decision_started_at: nowIso,
          decision_finished_at: nowIso,
        },
        continuation: null,
      });
    } catch (err) {
      console.error(`[${VTID}] turn-end route error: ${(err as Error).message}`);
      return res.status(500).json({
        ok: false,
        error: 'internal_error',
        message: (err as Error).message,
        vtid: VTID,
      });
    }
  },
);

export default router;
