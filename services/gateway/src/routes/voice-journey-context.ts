/**
 * VTID-02909 (B0c): Journey Context inspection endpoints.
 *
 *   GET /api/v1/voice/journey-context/preview?userId=…&tenantId=…
 *       Returns { compiled, decision, diagnostics } from the B0b
 *       context-compiler. Read-only; no DB writes. Used by the Command
 *       Hub Journey Context screen + the Match Journey panel.
 *
 *   GET /api/v1/voice/journey-context/state?userId=…&tenantId=…
 *       Returns rows from `user_assistant_state` for the given user.
 *       Strictly durable signals (no ephemeral route/surface state).
 *
 * Auth: exafy_admin required. Both endpoints expose sensitive inferred
 * context across tenants.
 *
 * B0c hard rule: this route is read-only inspection. It does NOT mutate
 * `user_assistant_state` or compile anything that touches the LLM prompt.
 */

import { Router, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import {
  requireAuthWithTenant,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { compileContext } from '../orb/context/context-compiler';
import {
  parseClientContextEnvelope,
  type ClientContextEnvelope,
} from '../orb/context/client-context-envelope';

const router = Router();
const VTID = 'VTID-02909';

// ---------------------------------------------------------------------------
// GET /api/v1/voice/journey-context/preview
//
// Query params:
//   userId    UUID (required)
//   tenantId  UUID (required)
//   envelope  optional JSON-stringified ClientContextEnvelope. When absent
//             we compile against `null` — that's the "no envelope yet"
//             state which is itself a valid B0c inspection scenario.
// ---------------------------------------------------------------------------
router.get(
  '/voice/journey-context/preview',
  requireAuthWithTenant,
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
      if (!userId || !tenantId) {
        return res.status(400).json({
          ok: false,
          error: 'userId and tenantId are required',
          vtid: VTID,
        });
      }

      let envelope: ClientContextEnvelope | null = null;
      if (typeof req.query.envelope === 'string' && req.query.envelope.length > 0) {
        try {
          const parsedJson = JSON.parse(req.query.envelope);
          const guard = parseClientContextEnvelope(parsedJson);
          if (guard.ok) envelope = guard.envelope;
        } catch {
          // Invalid envelope JSON → compile as if absent.
        }
      }

      const result = await compileContext({
        userId,
        tenantId,
        envelope,
      });

      return res.json({
        ok: true,
        vtid: VTID,
        compiled: result.compiled,
        decision: result.decision,
        diagnostics: result.diagnostics,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: (e as Error).message,
        vtid: VTID,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/voice/journey-context/state
//
// Lists the durable assistant-state rows for one user. Ephemeral signals
// (current_route, journey_surface, match_id, …) are NOT stored here —
// the migration's CHECK is "durable signals only".
// ---------------------------------------------------------------------------
router.get(
  '/voice/journey-context/state',
  requireAuthWithTenant,
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
      if (!userId || !tenantId) {
        return res.status(400).json({
          ok: false,
          error: 'userId and tenantId are required',
          vtid: VTID,
        });
      }

      const sb = getSupabase();
      if (!sb) {
        // B0c can ship without a live DB connection — the screen
        // renders the empty state. Source-health surfaces the gap.
        return res.json({
          ok: true,
          vtid: VTID,
          rows: [],
          source_health: {
            user_assistant_state: { available: false, reason: 'supabase_unconfigured' },
          },
        });
      }

      const { data, error } = await sb
        .from('user_assistant_state')
        .select('signal_name, value, count, confidence, source, expires_at, last_seen_at, created_at, updated_at')
        .eq('tenant_id', tenantId)
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });

      if (error) {
        return res.status(500).json({
          ok: false,
          error: error.message,
          vtid: VTID,
        });
      }

      return res.json({
        ok: true,
        vtid: VTID,
        rows: data ?? [],
        source_health: {
          user_assistant_state: { available: true },
        },
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: (e as Error).message,
        vtid: VTID,
      });
    }
  },
);

export default router;
