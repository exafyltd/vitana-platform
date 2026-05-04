import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation at the router level.
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ ok: true, data: { project_id: req.params.projectId } });
});

export default router;