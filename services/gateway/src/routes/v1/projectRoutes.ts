import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation to all routes in this router
router.use(limitPathParams(5, 200));

router.get('/:projectId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  return res.json({ ok: true, data: { project_id: req.params.projectId } });
});

export default router;