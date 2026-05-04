import { Router, Request, Response } from 'express';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limit middleware to mitigate ReDoS CVE
router.use(limitPathParams());

router.get('/:projectId', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  return res.json({ 
    ok: true, 
    data: { 
      project_id: req.params.projectId 
    } 
  });
});

export default router;