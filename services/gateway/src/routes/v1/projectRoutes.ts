import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:projectId', limitPathParams(), (req: Request, res: Response) => {
  res.json({ ok: true, data: { project_id: req.params.projectId } });
});

export default router;