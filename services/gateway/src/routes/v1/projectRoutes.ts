import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply middleware to mitigate path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  // Implementation stub for project retrieval
  return res.json({ ok: true, data: { project_id: req.params.projectId } });
});

export default router;