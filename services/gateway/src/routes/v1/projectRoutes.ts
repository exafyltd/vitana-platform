import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router();

// Apply the parameter limiting middleware to mitigate ReDoS in all project routes
router.use(limitPathParams());

router.get('/:projectId', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  return res.json({ 
    ok: true, 
    data: { 
      projectId: req.params.projectId, 
      type: 'project' 
    } 
  });
});

export default router;