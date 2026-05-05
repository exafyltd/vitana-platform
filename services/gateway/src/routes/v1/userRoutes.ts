import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply parameter limits to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { id: req.params.id } 
  });
});

export default router;