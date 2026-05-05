import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to mitigate ReDoS
router.use(limitPathParams());

router.get('/:projectId', requireAuth, async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { projectId: req.params.projectId } });
});

export default router;