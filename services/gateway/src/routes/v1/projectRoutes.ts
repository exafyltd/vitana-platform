import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Mitigate Express path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:projectId', requireAuth, (req: Request, res: Response) => {
  res.json({ ok: true, data: { projectId: req.params.projectId } });
});

export default router;