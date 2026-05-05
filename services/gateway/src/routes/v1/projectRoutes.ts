import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply ReDoS mitigation middleware limiting path parameters
router.use(limitPathParams());

router.get('/:projectId', requireAuth, async (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { projectId: req.params.projectId } 
  });
});

export default router;