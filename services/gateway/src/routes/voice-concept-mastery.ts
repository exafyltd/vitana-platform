/**
 * VTID-02936 (B3) — Concept Mastery preview API.
 *
 *   GET /api/v1/voice/concept-mastery/preview?userId=…&tenantId=…
 *
 * Returns the compiled ConceptMasteryContext + the raw concept rows
 * the assistant decision layer would see. Read-only.
 *
 * Auth: requireExafyAdmin (same as B0c/B0d/B0e/R0/B1/B2 inspection
 * surfaces).
 *
 * Wall: zero mutation paths. Selection is read-only; state
 * advancement (incrementing concept_explained_count, marking
 * mastery, recording dyk_card_seen) is a follow-up slice with its
 * own dedicated event endpoint.
 */

import { Router, Response } from 'express';
import {
  requireAuthWithTenant,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { defaultConceptMasteryFetcher } from '../services/concept-mastery/concept-mastery-fetcher';
import { compileConceptMasteryContext } from '../services/concept-mastery/compile-concept-mastery-context';

const router = Router();
const VTID = 'VTID-02936';

router.get(
  '/voice/concept-mastery/preview',
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

      const fetchResult = await defaultConceptMasteryFetcher.listConceptState({
        tenantId,
        userId,
        limit: 500,
      });

      const context = compileConceptMasteryContext({ fetchResult });

      return res.json({
        ok: true,
        vtid: VTID,
        concepts_explained: fetchResult.concepts_explained,
        concepts_mastered: fetchResult.concepts_mastered,
        dyk_cards_seen: fetchResult.dyk_cards_seen,
        context,
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
