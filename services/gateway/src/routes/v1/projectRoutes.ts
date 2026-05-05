import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams(5, 200));

router.get('/:projectId', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  // Application logic would typically live here
  return res.json({ 
    ok: true, 
    data: { 
      project_id: req.params.projectId 
    } 
  });
});

export default router;