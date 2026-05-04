import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ project: req.params.projectId });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
  res.status(200).json({ project: req.params.projectId, task: req.params.taskId });
});

export default router;