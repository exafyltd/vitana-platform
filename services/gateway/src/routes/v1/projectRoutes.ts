import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router({ mergeParams: true });

router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ project: req.params.projectId });
});

export default router;