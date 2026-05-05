import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { getSupabase } from '../../lib/supabase';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply mitigation globally to this sub-router
router.use(limitPathParams());

router.get('/:projectId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });
  
  return res.json({ ok: true, data: { projectId: req.params.projectId } });
});

export default router;