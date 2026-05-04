import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware to all project routes
router.use(limitPathParams());

router.get('/:projectId', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  // Implementation stub for project retrieval
  return res.json({ 
    ok: true, 
    data: { project_id: req.params.projectId } 
  });
});

export default router;