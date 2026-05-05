import { Router, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router();

// Apply middleware to mitigate path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  return res.json({ ok: true, data: { projectId: req.params.projectId } });
});

export default router;