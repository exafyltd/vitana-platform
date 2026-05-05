import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to prevent ReDoS via path-to-regexp
router.use(limitPathParams(5, 200));

router.get('/:projectId', requireAuth, async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { project_id: req.params.projectId } });
});

export default router;