import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  return res.json({ ok: true, data: { projectId: req.params.projectId } });
});

export default router;