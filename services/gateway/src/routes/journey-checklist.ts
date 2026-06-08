/**
 * VTID-03277 — Guided Journey checklist PUBLIC read (P2).
 *
 *   GET /api/v1/journey-checklist  → the published curriculum My Journey renders.
 *
 * Returns the current published snapshot; falls back to the enabled working
 * draft when nothing is published yet (early-phase bootstrap). User-facing
 * fields only — internal admin fields are stripped by toPublicTopic.
 */

import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { getPublishedChecklist } from '../services/guided-journey/checklist-service';

const router = Router();
const VTID = 'VTID-03277';

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.identity?.user_id) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }
  const c = getSupabase();
  if (!c) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }
  try {
    const curriculumVersion = (req.query.curriculumVersion as string) || 'v2';
    const result = await getPublishedChecklist(c, curriculumVersion);
    return res.json({
      ok: true,
      source: result.source,
      versionLabel: result.versionLabel,
      topics: result.topics,
      count: result.topics.length,
      vtid: VTID,
    });
  } catch (err: any) {
    console.error(`[${VTID}] published checklist read failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'read_failed', vtid: VTID });
  }
});

export default router;
