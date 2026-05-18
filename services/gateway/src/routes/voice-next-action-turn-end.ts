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

import { Router, Response } from 'express';
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

      const sb = getSupabase();
      if (!sb) {
        return res
          .status(503)
          .json({ ok: false, error: 'DB_UNAVAILABLE', vtid: VTID });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const lang =
        typeof body.lang === 'string' && body.lang
          ? body.lang.toLowerCase().slice(0, 5)
          : 'en';
      const decisionContext =
        body.decisionContext && typeof body.decisionContext === 'object'
          ? body.decisionContext
          : null;

      // Run the framework decision on the turn_end surface. We only
      // populate ctx.extra.nextAction — voice-wake-brief lacks turn-end
      // inputs and returns `skipped` here. The contextual_next_action
      // provider serves both surfaces (orb_wake + orb_turn_end).
      const decision = await decideContinuation({
        surface: 'orb_turn_end',
        context: {
          sessionId: undefined,
          userId,
          tenantId,
          extra: {
            [NEXT_ACTION_EXTRA_KEY]: {
              supabase: sb,
              decisionContext,
            },
          },
        },
      });

      // Fire-and-forget OASIS emit (suggested / suppressed). Mirrors
      // the wake-brief auto-emit so the Inspector sees turn-end events.
      emitNextActionDecisionTelemetry({
        decision,
        userId,
        tenantId,
        surface: 'orb_turn_end',
      });

      const chosen = decision.selectedContinuation;
      const continuation = chosen
        ? {
            user_facing_line: chosen.userFacingLine,
            kind: chosen.kind,
            dedupe_key: chosen.dedupeKey,
            priority: chosen.priority,
            cta: chosen.cta,
            evidence: chosen.evidence,
            privacy_mode: chosen.privacyMode,
          }
        : null;

      return res.status(200).json({
        ok: true,
        vtid: VTID,
        surface: 'orb_turn_end',
        decision: {
          decision_id: decision.decisionId,
          selected_kind: chosen?.kind ?? 'none_with_reason',
          suppress_reason: decision.suppressionReason ?? null,
          decision_started_at: decision.decisionStartedAt,
          decision_finished_at: decision.decisionFinishedAt,
        },
        continuation,
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
