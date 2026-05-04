import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId });
});

router.get('/:projectId/settings', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, settings: {} });
});

export default router;