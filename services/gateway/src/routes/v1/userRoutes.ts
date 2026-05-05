import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply ReDoS mitigation middleware limiting path parameters
router.use(limitPathParams(5, 200));

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { id: req.params.id } 
  });
});

export default router;