import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for path-to-regexp ReDoS
router.use(limitPathParams(5, 200));

router.get('/:projectId', (req: Request, res: Response) => {
  return res.json({ ok: true, data: { project_id: req.params.projectId } });
});

export default router;