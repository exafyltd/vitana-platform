import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply ReDoS mitigation middleware to limit pathological parameter nesting
router.use(limitPathParams());

router.get('/:projectId/users/:userId', requireAuth, async (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { 
      project_id: req.params.projectId, 
      user_id: req.params.userId 
    } 
  });
});

export default router;