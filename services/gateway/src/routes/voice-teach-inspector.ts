/**
 * VTID-03095 (Teacher PR 5) — Command Hub "Teach Vitanaland" inspector route.
 *
 *   GET /api/v1/voice/teach-vitanaland/state?user_id=<uuid>
 *
 * Admin-only. Returns the inputs the Command Hub panel renders:
 *   - catalog: every system_capabilities row (the global feature list)
 *   - ledger: per-user user_capability_awareness rows
 *   - phrasePools: read-only view of greeting + invitation pools per
 *     supported language (DE + EN) so operators can sanity-check copy
 *     without grepping source.
 *
 * Read-only. The panel mutates state via the existing
 * /api/v1/voice/teacher/event endpoint (PR 4) when an admin wants to
 * force-mark a capability for testing.
 */

import { Router, Response } from 'express';
import {
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import {
  listTeacherGreetings,
  listTeacherInvitations,
} from '../services/assistant-continuation/providers/teacher/feature-discovery-teacher';

const router = Router();
const VTID = 'VTID-03095';

const SUPPORTED_LANGS = ['en', 'de'] as const;

router.get(
  '/voice/teach-vitanaland/state',
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = typeof req.query.user_id === 'string' ? req.query.user_id.trim() : '';
      const sb = getSupabase();
      if (!sb) {
        return res
          .status(503)
          .json({ ok: false, error: 'DB_UNAVAILABLE', vtid: VTID });
      }

      // ---- Catalog (global) ----
      const { data: catalogRows, error: catalogErr } = await sb
        .from('system_capabilities')
        .select(
          'capability_key, display_name, description, manual_path, required_role, required_integrations, helpful_for_intents, enabled, surfaced_at, updated_at',
        )
        .order('capability_key', { ascending: true });
      if (catalogErr) {
        return res.status(502).json({
          ok: false,
          error: 'catalog_fetch_failed',
          message: catalogErr.message,
          vtid: VTID,
        });
      }

      // ---- Ledger (per-user, optional) ----
      let ledgerRows: unknown[] = [];
      if (userId) {
        const { data, error: ledErr } = await sb
          .from('user_capability_awareness')
          .select(
            'capability_key, awareness_state, first_introduced_at, last_introduced_at, first_used_at, last_used_at, use_count, dismiss_count, mastery_confidence, last_surface, updated_at',
          )
          .eq('user_id', userId);
        if (!ledErr && Array.isArray(data)) {
          ledgerRows = data;
        }
      }

      // ---- Phrase pools (read-only) ----
      const phrasePools: Record<string, { greetings: string[]; invitations: string[] }> = {};
      for (const lang of SUPPORTED_LANGS) {
        phrasePools[lang] = {
          greetings: listTeacherGreetings(lang),
          invitations: listTeacherInvitations(lang),
        };
      }

      return res.status(200).json({
        ok: true,
        vtid: VTID,
        user_id: userId || null,
        catalog: catalogRows || [],
        ledger: ledgerRows,
        phrase_pools: phrasePools,
      });
    } catch (err) {
      console.error(`[${VTID}] route error: ${(err as Error).message}`);
      return res
        .status(500)
        .json({ ok: false, error: 'internal_error', vtid: VTID });
    }
  },
);

export default router;
